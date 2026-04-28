# Gravity Ledger — Marinara Setup Turn Design

Date: 2026-04-28
Status: Selected direction
Related: `2026-04-26-gravity-marinara-embedded-design.md` §7 (this spec fills that gap)

> **Context.** The embedded port spec called out setup/initialization as a known gap (`2026-04-26-gravity-marinara-embedded-design.md` §7) with two stub options and the note "still needs a sub-spec." This is that sub-spec. It defines how a fresh chat gets its initial Gravity ledger committed before any prose generation runs, mirroring the player experience of ST's `setup-wizard.js` button-driven flow but adapted to Marinara's split-responsibility pipeline.

## 1. Player-facing flow

The setup turn replicates the ST experience with one architectural change: in ST, a single LLM call (the prose model) emits both the opening `---LEDGER---` block and the opening scene; in the Marinara port, those are split across two LLM cycles because the director and the prose model are different agents.

```
1. Fresh chat. User opens the Gravity drawer.
2. "New Game Setup" button is visible in the drawer header. Clicking opens
   <GravitySetupModal/>.
3. Modal form fields (identical to ST setup-wizard.js):
     - Opening Situation (text)
     - Power Scale (textarea)
     - Power Ceiling (number)
     - Power Notes (textarea)
     - PC Base Power (number)
     - PC Power Basis (textarea)
     - PC Combat Abilities (textarea, one per line)
   All fields optional. Blank fields are auto-derived from the character card,
   persona, scenario, and genre.
4. Submit → POST /api/gravity/setup → director runs in setup mode →
   opening ledger committed (all transactions; accepted=1 immediately).
5. On success, frontend programmatically sends a synthetic user message:
   "OOC: Begin the opening scene."
6. Marinara's standard generation pipeline runs:
     - inject (gravity-ledger-inject) reads the seeded state-cache,
       returns a full state view to the prose model
     - prose model writes the opening scene, anchored on seeded state
     - editor runs (if enabled)
     - director runs post-processing as usual
7. From turn 2 onward the chat is a normal Gravity chat. Setup never re-fires
   for this chat unless the user starts a new chat.
```

The Setup button stays visible after setup completes. Re-running setup on a chat that already has state would clobber it. The setup endpoint returns a 409 in that case; the modal surfaces a clear error ("This chat already has a Gravity ledger. Start a new chat to run setup again.").

No reset-and-retry endpoint in phase 1. Failure recovery is "start a new chat" — accepted because the typical setup failure mode is the LLM call itself, not partial commits, and a fresh chat is one click away in Marinara.

## 2. Architecture choice (recap)

Three options were considered and the architecturally cleanest one was chosen:

| Option | Description | Decision |
|---|---|---|
| A. Director-only seeding | Director emits opening ledger from form answers; no prose. Then synthetic message + normal first turn produces opening scene with seeded state. Two LLM cycles. | **Selected.** |
| B. Setup-flavored director on turn 1 | Inject delivers form answers to prose model; prose writes opening scene; director runs post-processing with a setup-mode prompt that builds initial state from prose. One cycle. | Rejected — director on a normal turn reads prose, but on setup the prose is empty/synthetic, so the director has nothing to extract from. Form answers are not enough by themselves at that point. |
| C. Deterministic seeding | Engine builds initial transactions mechanically from form fields. No LLM. | Rejected — loses the rich auto-fill the ST setup prompt achieves (factions with opposing agendas, 3-4 constraints, knowledge_asymmetry, pressure points seeded from card/persona/scenario). |

**Why A wins:** the director already has the right model (user-configured per agent settings), the right system-prompt format (JSON ledger transactions), and the right validation pipeline. The only difference for setup is the system prompt body and the input shape — everything downstream (consistency check, state-machine validation, staging, state-cache rendering) is shared with the regular post-processing director. The setup turn is invoked from a route, not from `generate.routes.ts`, which keeps the special-case dispatch in `generate.routes.ts` untouched.

## 3. Sequence diagram

```
Browser                 /api/gravity/setup           director (LLM)        DB
   │                          │                            │                │
   │  POST { chatId,          │                            │                │
   │         answers }        │                            │                │
   │ ───────────────────────► │                            │                │
   │                          │ 1. Guard: chat already     │                │
   │                          │    has accepted state?     │                │
   │                          │                            │                │
   │                          │ ──── SELECT 1 FROM ───────────────────────► │
   │                          │ ◄───── (null/row) ────────────────────────  │
   │                          │                            │                │
   │                          │ 2. Build setup payload     │                │
   │                          │    (form + card + persona) │                │
   │                          │                            │                │
   │                          │ 3. callSetupDirector(      │                │
   │                          │    {systemPrompt,          │                │
   │                          │     userPrompt, signal})   │                │
   │                          │ ─────────────────────────► │                │
   │                          │ ◄───  { transactions } ─── │                │
   │                          │                            │                │
   │                          │ 4. validateAndStage        │                │
   │                          │   (single SQL transaction) │                │
   │                          │                            │                │
   │                          │ ──── BEGIN ───────────────────────────────► │
   │                          │ ──── INSERT gravity_transactions          │ │
   │                          │      (accepted=1, messageId='__setup__') ───┤
   │                          │ ──── engineTick (no-op for integration) ──► │
   │                          │ ──── UPSERT gravity_state_cache ──────────► │
   │                          │ ──── UPSERT gravity_chat_state              │
   │                          │      (mode='regular',                       │
   │                          │       acceptedMessageId='__setup__',        │
   │                          │       acceptedSwipeIndex=0,                 │
   │                          │       userTurnsSinceLastDirector=0) ──────► │
   │                          │ ──── COMMIT ──────────────────────────────► │
   │                          │                            │                │
   │ ◄── 200 { committed,     │                            │                │
   │         rejected,        │                            │                │
   │         errors,          │                            │                │
   │         durationMs,      │                            │                │
   │         model }          │                            │                │
   │                          │                            │                │
   │  send "OOC: Begin the    │                            │                │
   │  opening scene." through │                            │                │
   │  normal chat send hook   │                            │                │
   │ ───────────────────────────────────────────────────► (normal generation pipeline)
```

## 4. Coupling surface

The setup turn touches a small, mostly-additive surface. Listed in dependency order.

### 4.1 New files

```
packages/server/src/services/gravity/agents/setup-agent.ts
  — runGravitySetup({ chatId, answers, agentConfig, setupContext, signal })
  — orchestrates: guard, payload build, director call, stage, cache, chat-state upsert
  — single SQL transaction for steps 4-7 of the sequence diagram
  — returns { success, committed, rejected, errors, durationMs, model }
  — setupContext is the assembled context (see §4.3); the route assembles it
    before calling runGravitySetup so this function stays storage-free

packages/server/src/services/gravity/director/setup-input.ts
  — buildSetupPayload(answers, setupContext): { systemPrompt, userPrompt }
  — exports SetupAnswers type (mirrors ST setup-wizard form fields)
  — exports SetupContext type: { user: PersonaSnapshot,
                                 principal: CharacterSnapshot,
                                 scenario: string | null,
                                 activatedLorebookEntries: LorebookEntrySnapshot[] }
  — renders the setup user prompt with form answers + context, returns it ready
    for callSetupDirector

packages/client/src/components/chat/GravitySetupModal.tsx
  — Marinara-styled modal (Tailwind; mirrors ChatGalleryDrawer's existing modal pattern)
  — same seven form fields as ST setup-wizard.js
  — Cancel / Start Game buttons
  — error display for 409 (chat already has state) and 422 (validation errors)

packages/client/src/hooks/use-gravity-setup.ts
  — TanStack mutation hook: POST /api/gravity/setup
  — on success: two-step "send and generate" sequence (see §4.4)
  — on 409/422/5xx: surface error in modal, preserve form state for retry
```

### 4.2 Modified files

```
packages/shared/src/constants/agent-prompts.ts
  — add "gravity-ledger-director-setup" template (see §5 for body)
  — getDefaultAgentPrompt registry entry

packages/server/src/routes/gravity.routes.ts
  — add POST /api/gravity/setup
  — request: { chatId, answers }
  — response: { success, committed, rejected, errors, durationMs, model }
  — status codes: 200 success, 400 bad input, 409 chat already has state,
    422 validator rejected all transactions, 502 LLM call failed

packages/server/src/services/gravity/engine/ledger-store.ts
  — stageTransactions(): accept an optional acceptedImmediately flag (default false)
  — when true, INSERT rows with accepted=1; that is the only behavior change
  — the existing nextTxSeq upsert on gravity_chat_state stays unchanged
  — only setup-agent.ts uses acceptedImmediately=true; regular director continues
    to insert accepted=0

packages/server/src/services/gravity/director/client.ts
  — add callSetupDirector({ systemPrompt, userPrompt, provider, model, signal })
  — builds its own messages array (system + single user); does NOT use
    DirectorInput / renderDirectorUserPrompt
  — reuses the existing tolerant JSON extractor and thinking-block stripping
    from callDirector (factor those into shared helpers if not already)
  — returns { transactions: RawTransaction[], model, durationMs }

packages/server/src/services/gravity/engine/state-cache.ts
  — cache key tolerates "__setup__" sentinel for messageId
  — upsertForSwipe is called with mode='regular' on setup commit; buildNudge
    on a fresh state will return its empty/default; harmless
  — no schema change; the column is text and accepts any string

packages/client/src/components/chat/GravityLedgerDrawer.tsx
  — add "New Game Setup" button in drawer header (always visible)
  — mount <GravitySetupModal/> inside the drawer, modal-open state lifted to
    drawer (or further up if multiple consumers need it)

packages/client/src/hooks/use-generate.ts (or the existing send hook)
  — expose a programmatic send entrypoint so use-gravity-setup can insert the
    synthetic "OOC: Begin the opening scene." message after a successful setup
  — no behavior change for normal sends
```

### 4.3 Server-side context assembly (where AgentContext fields come from)

The setup route runs out-of-band; the generate pipeline never assembled an `AgentContext` for this request. The route assembles a minimal `SetupContext` itself using the same storage helpers `generate.routes.ts` uses:

```ts
// In gravity.routes.ts POST /api/gravity/setup handler:
const chats = createChatsStorage(db);
const characters = createCharactersStorage(db);
const personas = createPersonasStorage(db);
const lorebooks = createLorebooksStorage(db);

const chat = await chats.getById(chatId);
if (!chat) return reply.code(404).send(...);

const principalCard = await characters.getById(chat.characterId);
const userPersona = chat.personaId ? await personas.getById(chat.personaId) : defaultPersona;

// Greeting-time lorebook activation: run with empty chat history,
// just the character card and persona; surface any constant or first-message-keyed entries.
const activatedLorebookEntries = await processLorebooks({
  chatId, character: principalCard, persona: userPersona, recentMessages: [],
});

const setupContext: SetupContext = {
  user: { name: userPersona.name, description: userPersona.description },
  principal: {
    name: principalCard.name,
    description: principalCard.description,
    scenario: principalCard.scenario,
    personality: principalCard.personality,
  },
  scenario: chat.scenario ?? principalCard.scenario,
  activatedLorebookEntries: activatedLorebookEntries.map(toSnapshot),
};
```

The exact storage builder names and `processLorebooks` signature follow Marinara's existing pattern; the implementation plan verifies them against the live source. The contract here is: **the route, not `setup-agent`, owns context assembly**, so `setup-agent` stays free of `db`-storage imports and is testable with synthetic `SetupContext`.

### 4.4 Client-side programmatic send sequence

After a successful POST to `/api/gravity/setup`, `use-gravity-setup` fires the synthetic opening turn through the existing two-step API:

```ts
// inside use-gravity-setup.ts onSuccess
const userMsg = await createMessage.mutateAsync({
  chatId,
  role: "user",
  content: "OOC: Begin the opening scene.",
});
await generate({ chatId, userMessageId: userMsg.id });
```

This mirrors what `ChatInput.tsx` does on submit. The hook depends on the existing `useCreateMessage` and `useGenerate` (or whatever the current generate hook is named) — no new "send and generate" abstraction is required for phase 1. If `ChatInput.tsx` later extracts a reusable `useSendAndGenerate` helper, the setup hook should switch to that to stay aligned.

### 4.5 Files NOT modified

- `packages/server/src/routes/generate.routes.ts` — setup runs through its own route, never touches the generation pipeline. The four edits described in the embedded spec §3.2 (acceptance hook, filter, inject, director) remain the only edits there.
- `packages/server/src/services/agents/agent-executor.ts` — setup is not an `executeAgent`-style call; it's invoked directly from the route, the same way the regular director is.
- All four Gravity schema files — no migration. Sentinel `messageId='__setup__'` is a reserved string in existing `text` columns.
- `commitAcceptedGravityTurn` (`acceptance.ts`) — setup commits with `accepted=1` directly and never goes through the acceptance hook.

## 5. Setup director system prompt

Stored at `packages/shared/src/constants/agent-prompts.ts` under key `gravity-ledger-director-setup`. User can override per-agent like any other prompt template.

The prompt is a port of `ST/setup-wizard.js:buildSetupPrompt` adapted for the director (JSON output, no prose), with the structural skeleton kept verbatim:

```
[GRAVITY SETUP — director only. Build the complete opening ledger as a JSON
transactions array. Emit zero prose, zero commentary. Output only:
{ "transactions": [ ... ] }

PLAYER PROVIDED:
  {{filledAnswers}}

AUTO-FILL (derive from character card, persona, and scenario; defaults below):
  {{blankAnswers}}

CHARACTER CARD:
  Name: {{principal.name}}
  Description: {{principal.description}}
  Scenario: {{principal.scenario}}
  Personality: {{principal.personality}}

PERSONA (the player character — PC = {{user.name}}):
  Name: {{user.name}}
  Description: {{user.description}}

ACTIVATED LOREBOOK CONTEXT:
  {{activatedLorebookEntries}}

EMIT ALL OF THE FOLLOWING in the transactions array:

1. PC entity (op=S/A on entity 'pc'):
   - name = persona name
   - demonstrated_traits: 2-4 APPEND ops extracted from persona description
   - if PC base power provided: power_base, power, power_basis, abilities
2. PRINCIPAL char (op=CR with tier=PRINCIPAL):
   - agenda (narrative compass — what they're working toward)
   - location (place id)
   - knowledge_asymmetry: knows_, unknown_, hiding_, misreading_ entries
     (4 MS ops)
   - if combat-capable: power_base, power, power_basis, abilities
   - 3-4 constraints (CREATE constraint:slug)
3. WORLD entity (op=S):
   - power_scale, power_ceiling, power_notes (if provided)
   - world_state (macro reality)
   - timeskip_scale = "HOURS"
4. FACTIONS (CR + S/A/MS): at least 2 with opposing agendas;
   each with knowledge_asymmetry (4 keys), members, territory.
5. COLLISIONS (CR): at least 1 ACTIVE; each with name, distance_category,
   forces, involved_chars, location.
6. PLACES (CR): at least 1 for the opening scene.
7. PRESSURE POINTS (CR): 2-3 seams; capped at 5 FIFO.
8. KNOWN NPCs (CR): any scenario NPCs as tier=KNOWN.

POWER AUTHORING RULES:
- No naked numbers. Every meaningful combat rating needs basis + abilities.
- power_base = earned combat level when healthy.
- power = current effective combat level.
- power = power_base unless setup establishes wound, impairment, or boost.

PC vs PRINCIPAL: never merge. PC is the player's persona; PRINCIPAL is the
character card NPC. They are separate entities.

OUTPUT CONTRACT: a JSON object { "transactions": [ ... ] } where each
transaction matches the standard director schema (op, e, id, d, r). No
SNAP/ROLL/AMEND ops; those are engine-only. No prose, no markdown fences,
no trailing commentary.]
```

Tolerant JSON parser handles markdown fences and leading prose if the model includes them anyway. `responseFormat: { type: "json_object" }` is set as an optimization; not depended on.

## 6. Failure handling

| Failure | HTTP | Frontend behavior |
|---|---|---|
| Bad input (missing chatId, malformed answers) | 400 | Modal shows inline validation errors; form preserved |
| Chat already has accepted state | 409 | Modal shows: "This chat already has a Gravity ledger. Start a new chat to run setup again." Cancel button only |
| LLM call failed (network, provider error, abort) | 502 | Toast: "Setup failed: <reason>". Modal stays open, form preserved, retry button enabled |
| Validator rejected ALL transactions | 422 | Modal shows the validator errors inline; retry button enabled. No partial state was committed (all-or-nothing on rejection means nothing landed) |
| Validator rejected SOME transactions | 200 | Returns `success: true` with `rejected > 0` and `errors[]`. Modal closes, opening-scene message is sent. The drawer's Turns tab will show the rejections so the user can see what didn't land. (This matches the regular director's tolerant behavior.) |
| LLM produced zero transactions | 422 | Treat as full failure; same as "rejected all" |

The 200-with-partial-rejection case is intentional: the regular director already commits valid transactions and surfaces rejections; setup follows the same convention so the drawer's Turns tab works uniformly. The user can inspect the rejections in the Turns tab and decide whether to start a new chat or proceed.

No correction loop on setup. Corrections are a regular-turn ergonomic where the next director call retries; for a one-shot opening, retrying the whole setup is simpler and clearer.

## 6.1 Acceptance-hook behavior post-setup

The acceptance hook needs no sentinel-specific logic. Its `UPDATE gravity_transactions SET accepted=1` filters by the *new* assistant `messageId` being committed (the just-accepted message), not by the prior `acceptedMessageId` from `gravity_chat_state`. The setup-sentinel rows (`messageId='__setup__'`) are never matched by that UPDATE because the new assistant message has a different id.

Concretely:
- After setup: `acceptedMessageId='__setup__'`, sentinel rows already at `accepted=1`, `userTurnsSinceLastDirector=0`.
- Synthetic user message → standard generation runs → assistant produces opening scene → post-processing director stages new transactions at `(messageId=<asst1>, swipeIndex=<chosen>)` with `accepted=0`.
- On user turn 2: acceptance hook fires, UPDATEs the `<asst1>` rows to `accepted=1` (sentinel rows untouched), overwrites the pointer to `(<asst1>, <chosen>)`, increments `userTurnsSinceLastDirector` to 1.

The sentinel rows persist in `gravity_transactions` and contribute to state replay normally — `state-compute` orders by `seq`, and the setup batch has the lowest seq values for the chat, so it replays first.

## 7. Concurrency

Two parallel POST `/api/gravity/setup` requests for the same chat (e.g., user double-clicks Start Game with a slow network) could both pass the §3 step 1 guard before either commits.

Mitigation in phase 1: the SQL transaction at step 4-7 is serializable per SQLite default. The second request's `INSERT gravity_chat_state` upsert wins or loses depending on order, but the first request's transactions are already written with `accepted=1` and the chat-state row is set. The second request's writes either land on top (idempotent if the director produced the same output, which it won't) or overwrite the first.

To prevent this cleanly, the route disables the modal's Start Game button on submit (no double-click possible) and the route itself adds a per-`chatId` in-memory lock for the duration of the request. The lock is process-local; in a multi-instance Marinara deployment the user would need to be load-balanced consistently. Phase 1 doesn't ship multi-instance.

No schema change for concurrency in phase 1. (An earlier draft proposed a `UNIQUE (chat_id, seq)` index on `gravity_transactions` as belt-and-suspenders against lock bypass; that's a Drizzle migration this spec doesn't otherwise need. If the lock turns out to be insufficient, the unique index can be added as a follow-up.)

## 8. Setup-mode flag (deferred)

ST has an `_active` flag on `setup-wizard.js` that flips the extension into "integration" mode (suppresses advance-tick, changes state-view formatting). The Marinara port doesn't need this in phase 1: setup runs as its own out-of-band route, not as a turn in the chat. The synthetic "OOC: Begin the opening scene." turn is a regular turn under `mode='regular'` from the ledger's perspective.

If later behaviors emerge that need a transient "we just set up, this is turn 1" signal (e.g., the regular director should be more lenient on turn 1, or the prose model should get an extra "this is the opening scene" hint), `gravity_chat_state.mode = 'integration'` is the existing column to use; setup-agent would set it, and the regular director would clear it after the first commit. Not implemented in phase 1.

## 9. Testing

No automated test suite per Marinara CLAUDE.md. Manual smoke at three checkpoints:

1. **Setup ledger commit**: fresh chat → click Setup → fill all fields → Start Game → drawer State tab shows PC, principal, ≥2 factions, ≥1 ACTIVE collision, ≥1 place, 2-3 pressure points. `gravity_transactions` rows visible in `db:studio` with `accepted=1` and `message_id='__setup__'`.
2. **Opening scene generation**: same chat, after step 1 → assistant message appears with opening scene anchored on seeded state (mentions PC by name, principal by name, opening situation matches form input). State-cache row updated with messageId of the assistant message.
3. **Re-setup blocked**: same chat, click Setup again → modal shows 409 message. Click Cancel. State unchanged.

Edge cases worth checking manually:
- All form fields blank → director auto-fills from card/persona/scenario.
- Card has minimal description → director still produces ≥2 factions, ≥1 collision (validator gate forces this).
- LLM connection misconfigured → 502, modal stays open, retry button works.

## 10. Migration sequence

Slots into the embedded spec's task ordering at task 10 (currently "Setup wizard"):

1. Add `gravity-ledger-director-setup` prompt template (`agent-prompts.ts`).
2. Add `setup-input.ts` payload builder.
3. Add `setup-agent.ts` orchestration (single SQL transaction; reuses ledger-store, engine-tick, state-cache).
4. Extend `ledger-store.ts` with `acceptedImmediately` flag.
5. Add POST `/api/gravity/setup` route in `gravity.routes.ts`.
6. End-to-end smoke test 1 (server-only, via curl).
7. Add `<GravitySetupModal/>` component.
8. Add `use-gravity-setup` hook (mutation + programmatic send).
9. Wire button into `GravityLedgerDrawer`.
10. End-to-end smoke tests 2-3 (full UI).
11. Verify the per-`chatId` in-memory lock prevents double-submission under artificial latency.

## 11. References

- `2026-04-26-gravity-marinara-embedded-design.md` §7 — the gap this spec fills
- `ST/setup-wizard.js` — original setup flow (button, popup, single-shot prompt)
- `ST/index.js:2334-2350` — `handleSetupButton` flow
- `ST/index.js:1209-1210` — `_setup` slot injection
- `docs/superpowers/plans/2026-04-28-gravity-ledger-panel-ui.md` — drawer UI plan; this spec adds the Setup button to that drawer
- Marinara: `packages/shared/src/constants/agent-prompts.ts` — prompt template registry
- Marinara: `packages/server/src/services/gravity/agents/director-agent.ts` — pattern setup-agent mirrors
- Marinara: `packages/server/src/routes/gravity.routes.ts` — route file the new endpoint lives in
