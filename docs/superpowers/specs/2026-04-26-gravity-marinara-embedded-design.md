# Gravity Ledger — Marinara Embedded Integration Design

Date: 2026-04-26
Status: Selected direction (revised 2026-04-26 — second pass after deeper review)

> **Context.** This document describes the embedded architecture for porting Gravity Ledger into Marinara Engine. It supersedes — for the current planning round — the standalone-service alternative at `2026-04-21-gravity-marinara-port-design.md`. The key fork: this path makes Marinara Gravity's permanent home and builds against its internals. The service path treats Marinara as one of N hosts.

> **Revision notes.**
>
> **First pass (early 2026-04-26)** — Codebase audit replaced an "async-cascade" approach with the existing pre-step loader pattern, corrected memory access, added `responseFormat` portability stance.
>
> **Second pass (later 2026-04-26)** — Deeper review surfaced four blocking gaps:
> 1. **Special-case dispatch.** Gravity's executors had no call site. Standard `executeAgent` always issues `chatComplete` — wrong for inject (deterministic) and wrong-shaped for director (multi-step commit). Fixed: both agents are filtered out of the standard pipeline (alongside `editor`/`lorebook-keeper`) and dispatched explicitly in `generate.routes.ts`. **Registration vs. execution is now stated plainly:** built-in agent registration handles UI/config/result plumbing; execution is explicit special-case code.
> 2. **Per-`(messageId, swipeIndex)` staging.** Marinara's accepted-state model stages snapshots per swipe and only commits on next user turn (`generate.routes.ts:334`, `game_state_snapshots.committed`). Gravity's chat-id-only schema would have permanently advanced the ledger on every rejected swipe. Fixed: schema mirrors the per-swipe pattern with explicit acceptance.
> 3. **Shared persistent state.** `agent_memory` is per-`agentConfigId`+`chatId`; the two Gravity agents would have lived in separate namespaces. Fixed: a Gravity-owned `gravity_chat_state` table holds shared per-chat state (mode, corrections, acceptance pointer, tx sequence).
> 4. **Engine-tick phase.** Advance-mode requires a deterministic post-commit pass (tick distances, clear pressure, reset scale) — has no host in Marinara today. Fixed: `engine/engine-tick.ts` runs inside the director's special-case block, declarative on the ledger (`world.timeskip_scale` as a string token: `HOURS`/`DAYS`/`WEEKS`/`MONTHS`).
>
> Editor sequencing also fixed: director runs **after** the editor block (`:~6151`) so it sees the rewritten message, not pre-edit prose.

## 1. Core premise

Gravity is implemented inside the Marinara monorepo as **two built-in agents that Marinara registers but does not execute through its standard agent pipeline**:

- `gravity-ledger-inject` — `pre_generation` phase. Deterministic. Reads the last-accepted state-cache row, returns inject text. **No `chatComplete` call.**
- `gravity-ledger-director` — `post_processing` phase. Runs **after** the editor agent. Single LLM call to propose transactions, then deterministic validate-stage-tick-cache.

Both share:
- `packages/server/src/services/gravity/engine/` — TS-ported engine logic.
- Five new SQL tables (`gravity_transactions`, `gravity_state_cache`, `gravity_snapshots`, `gravity_chat_state`, plus migrations).
- Marinara's existing provider infrastructure for the director's LLM call (no bespoke HTTP client).

No standalone service. No second process. No HTTP boundary.

**Registration ≠ execution.** Marinara's built-in-agent registration (`BUILT_IN_AGENTS`, `BUILT_IN_AGENT_IDS`, default prompt entries, `category`, run intervals) gives Gravity UI placement, config storage in `agent_configs`, and `AgentResult` plumbing for the SSE stream. Execution is **explicit special-case dispatch** in `generate.routes.ts`, the same pattern Marinara uses for `editor` (rewrites saved message after the pipeline) and `lorebook-keeper` (custom acceptance flow). Gravity is not invoked via `executeAgent`/`executeAgentBatch` and never enters the JSON/text routing in `parseAgentResponse`.

## 2. What Marinara's pipeline provides for free

Reading `agent-executor.ts`, `agent-pipeline.ts`, and `generate.routes.ts`:

| Marinara feature | Gravity benefit |
|---|---|
| `AgentContext.mainResponse` (post-edit version, when called after editor) | Director receives the prose model's final visible text — no parsing |
| `AgentContext.characters` | Character cards available for bootstrapping `char` entities |
| `AgentContext.activatedLorebookEntries` | Director sees which lore was surfaced — signal Gravity's own state doesn't carry |
| `AgentContext.chatSummary` | Rolling summary available — reduces director's `recentTurns` need |
| `AgentContext.signal` | AbortSignal wired through to provider calls |
| Connection override per agent | `AgentConfig.connectionId` lets the user pick the director's model in the agent settings drawer |
| `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS` | Director honors run-interval (every N turns) via the same setting other built-ins use |
| Acceptance moment at `generate.routes.ts:324-337` | Marinara already iterates the last assistant message and commits its active-swipe game-state row exactly when a real new user turn arrives (skips impersonate, swipes, regens). Gravity hooks the same point |
| `agent_runs` persistence | Director's `AgentResult` recorded to `agent_runs` like every other agent — uniform UI |
| SSE `AgentResult` events | Gravity state panel subscribes to the same stream other agents emit on |

What Gravity does **not** use: `executeAgent`/`executeAgentBatch` LLM batching, `JSON_AGENTS`, `parseAgentResponse`, `buildAgentExtras` injection. All of those are bypassed by special-casing.

## 3. Exact coupling surface

This is what a fork actually touches. Coupling concentrates in two places: shared types/schemas (additive) and `generate.routes.ts` (real special-case logic).

### 3.1 `packages/shared/src/types/agent.ts` and `packages/shared/src/schemas/agent.schema.ts`

**Type addition** (`agent.ts:15-40` `AgentResultType` union):
```ts
| "gravity_state_update"
```

**Zod schema addition** (`packages/shared/src/schemas/agent.schema.ts` `agentResultTypeSchema`):
```ts
z.literal("gravity_state_update"),
```
Both paths must include the new type — the TS union is for compile-time, the Zod schema validates runtime data shapes (e.g., when reading `agent_runs.result`).

**`BUILT_IN_AGENT_IDS`** (`agent.ts:157`):
```ts
GRAVITY_LEDGER_INJECT: "gravity-ledger-inject",
GRAVITY_LEDGER_DIRECTOR: "gravity-ledger-director",
```

**Two `BUILT_IN_AGENTS[]` entries**:
```ts
{
  id: "gravity-ledger-inject",
  name: "Gravity Ledger (State Injection)",
  description: "Injects Gravity structural state — collisions, constraints, character dossiers, factions — into the prose model's prompt each turn. Deterministic; no LLM call.",
  phase: "pre_generation",
  enabledByDefault: false,
  defaultInjectAsSection: true,
  category: "tracker",
},
{
  id: "gravity-ledger-director",
  name: "Gravity Ledger (Director)",
  description: "After the prose response (and after the editor agent), interprets structural state changes and commits them to the Gravity ledger. Requires a separate model connection.",
  phase: "post_processing",
  enabledByDefault: false,
  category: "tracker",
},
```

`category: "tracker"` is established (`agent.ts:183`). Use the existing tracker registrations (`world-state`, `quest`, `character-tracker`, `custom-tracker`) as templates.

**`BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS`** (`agent.ts:468-472`):
```ts
"gravity-ledger-director": 1,  // every turn; user-adjustable
```

**Default prompt templates** at `packages/shared/src/constants/agent-prompts.ts`. Director prompt + op vocabulary; inject prompt is null/unused (deterministic).

**No edits required** to `JSON_AGENTS` (`agent-executor.ts:871`) or `parseAgentResponse` (`:897`) — Gravity is filtered from the standard pipeline before either gate is reached.

**Name-collision check.** `BUILT_IN_AGENT_IDS.DIRECTOR = "director"` already exists at `agent.ts:157` as "Narrative Director" (pre_generation event-injector, `category: "writer"`). Different responsibility; different id. No conflict — never reuse `"director"`.

### 3.2 Special-case dispatch in `packages/server/src/routes/generate.routes.ts`

Three additions in this file. All three model after Marinara's existing `editor` / `lorebook-keeper` / world-state-tracker patterns.

**(a) Acceptance hook at `:334` (immediately next to the existing `gameStateStore.commit(gs.id)`)**

The user just submitted a real new turn (`!input.impersonate && (input.userMessage || input.attachments)`). Marinara already commits the prior assistant message's active swipe of game-state here. Gravity does the same: marks all `gravity_transactions` for `(chat_id, lastAsstMsg.id, lastAsstMsg.activeSwipeIndex)` as `accepted = 1`, updates `gravity_chat_state.{acceptedMessageId, acceptedSwipeIndex}`.

**Shared helper** in `services/gravity/engine/acceptance.ts`:
```ts
export async function commitAcceptedGravityTurn(
  chatId: string,
  messageId: string,
  swipeIndex: number,
): Promise<void> {
  // single transaction:
  // 1. UPDATE gravity_transactions SET accepted=1 WHERE chat_id=? AND message_id=? AND swipe_index=?
  // 2. UPDATE gravity_chat_state SET acceptedMessageId=?, acceptedSwipeIndex=? WHERE chat_id=?
}
```
Called from `generate.routes.ts:~334`, right next to `gameStateStore.commit(gs.id)`. Real-new-turn semantics inherit automatically from the surrounding `if (!input.impersonate && (input.userMessage || input.attachments?.length))` guard.

**(b) Pre-generation: filter Gravity from the standard pipeline; inject deterministic context**

Filter at `:~3605` (where editor and lorebook-keeper are excluded today):
```ts
let pipelineAgents = resolvedAgents.filter(
  (a) =>
    a.type !== "editor" &&
    a.type !== "lorebook-keeper" &&
    a.type !== "gravity-ledger-inject" &&
    a.type !== "gravity-ledger-director",
);
```

Inject is rendered alongside the existing tracker-context construction (`:~3565`):
```ts
if (resolvedAgents.some((a) => a.type === "gravity-ledger-inject")) {
  const gravityInject = await loadGravityInjectForChat(input.chatId);
  if (gravityInject) trackerParts.push(gravityInject.text);
  // also fire the AgentResult so the SSE stream sees a context_injection event
  const result = makeInjectAgentResult(gravityInject);
  await agentsStore.saveRun({ agentConfigId: result.agentId, chatId: input.chatId, messageId: null, result });
  sendAgentEvent(result);
}
```

`loadGravityInjectForChat` lives in `services/gravity/agents/inject-agent.ts` and:
1. Reads `gravity_chat_state` for `chatId` → resolves `(acceptedMessageId, acceptedSwipeIndex)` and `mode`.
2. Reads `gravity_state_cache` for that triple → returns `{ stateView, recentTail }`.
3. Builds the mode-specific nudge (`buildNudge(mode, stateView)`).
4. Returns `{ text: stateView + "\n\n" + nudge, /* metadata */ }`.

If there's no accepted state yet (newly initialized chat), returns an empty/setup-prompt result.

**(c) Post-generation, post-editor: director special-case**

Editor block ends around `:~6151`. Director runs immediately after (no later than the SSE stream close):
```ts
if (resolvedAgents.some((a) => a.type === "gravity-ledger-director") && messageId && !abortController.signal.aborted) {
  const directorAgent = resolvedAgents.find((a) => a.type === "gravity-ledger-director")!;
  const finalAssistantText = await chats.getMessageActiveSwipeText(messageId);
  // ↑ resolves to the editor-rewritten content if editor ran, else original mainResponse
  const result = await runGravityDirector({
    chatId: input.chatId,
    messageId,
    swipeIndex: targetSwipeIndex,
    assistantMessage: finalAssistantText,
    agentConfig: directorAgent,
    context: agentContext,
    signal: abortController.signal,
  });
  await agentsStore.saveRun({ agentConfigId: result.agentId, chatId: input.chatId, messageId, result });
  sendAgentEvent(result);
}
```

`runGravityDirector` is the orchestration entrypoint exported from `services/gravity/agents/director-agent.ts`. See §4 for its internal sequence.

**Coupling impact summary for §3.2:**
- `:~334`: 2-3 lines (call `commitAcceptedGravityTurn`).
- `:~3605`: 2 lines (extend filter list).
- `:~3565`: ~10 lines (inject rendering + SSE).
- `:~6151+`: ~15 lines (director call + SSE).
- New shared helper file `services/gravity/engine/acceptance.ts`.

`buildAgentExtras` (`agent-executor.ts:681`) is **not** touched. The pre-step loader pattern from the first revision is dropped — Gravity's inject lives in the tracker-context block, not in `buildAgentExtras`.

### 3.3 `packages/server/src/db/schema/`

Four new files, each one table per Marinara convention:

```
packages/server/src/db/schema/gravity-transactions.ts
packages/server/src/db/schema/gravity-state-cache.ts
packages/server/src/db/schema/gravity-snapshots.ts
packages/server/src/db/schema/gravity-chat-state.ts
```

`packages/server/src/db/schema/index.ts` — add four exports (additive).

**`gravity_transactions`** — append-only, per-swipe, with acceptance flag:
```ts
export const gravityTransactions = sqliteTable("gravity_transactions", {
  id: text("id").primaryKey(),                            // UUID
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),                // FK to messages.id, app-level
  swipeIndex: integer("swipe_index").notNull().default(0),
  seq: integer("seq").notNull(),                          // monotonic per chat (see gravity_chat_state.nextTxSeq)
  op: text("op").notNull(),                               // CR / S / TR / A / R / MS / MR / D / SNAP / ROLL / AMEND
  payload: text("payload").notNull(),                     // JSON
  accepted: integer("accepted").notNull().default(0),     // flips to 1 at acceptance hook (§3.2(a))
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  byChatMsgSwipe: index("gravity_tx_chat_msg_swipe").on(t.chatId, t.messageId, t.swipeIndex),
  bySeq: index("gravity_tx_seq").on(t.chatId, t.seq),
  byAccepted: index("gravity_tx_accepted").on(t.chatId, t.accepted),
}));
```

**`gravity_state_cache`** — pre-rendered per-swipe snapshot:
```ts
export const gravityStateCache = sqliteTable("gravity_state_cache", {
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  swipeIndex: integer("swipe_index").notNull().default(0),
  stateView: text("state_view").notNull(),                // pre-formatted text for inject
  recentTail: text("recent_tail").notNull(),              // JSON array of last N tx for director
  archiveVersion: text("archive_version").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  pk: primaryKey({ columns: [t.chatId, t.messageId, t.swipeIndex] }),
}));
```

**`gravity_snapshots`** — explicit `SNAP`/`ROLL` checkpoints, anchored:
```ts
export const gravitySnapshots = sqliteTable("gravity_snapshots", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  messageId: text("message_id"),                          // null for chat-level baseline
  swipeIndex: integer("swipe_index"),
  label: text("label").notNull(),
  payload: text("payload").notNull(),                     // JSON serialized state
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (t) => ({
  byChat: index("gravity_snap_chat").on(t.chatId),
}));
```

**`gravity_chat_state`** — single row per chat for shared, persistent, cross-agent state:
```ts
export const gravityChatState = sqliteTable("gravity_chat_state", {
  chatId: text("chat_id").primaryKey().references(() => chats.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("regular"),        // regular | advance | combat | intimacy | integration
  pendingCorrections: text("pending_corrections"),        // JSON CorrectionsPayload | null
  acceptedMessageId: text("accepted_message_id"),         // null until first accepted turn
  acceptedSwipeIndex: integer("accepted_swipe_index"),
  nextTxSeq: integer("next_tx_seq").notNull().default(1), // monotonic per-chat sequence allocator for gravity_transactions.seq
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
```

**Notes:**
- `nextTxSeq` is the real monotonic per-chat sequence (allocated and incremented under transaction when staging tx rows). Replaces the first-revision's `lastCommittedTxId`, which implied an append-only counter that no longer fits the staged model.
- No `timeskip_scale_pending` column. The advance-mode tick scale is declared in the ledger as `world.timeskip_scale = "DAYS"` (string token), consumed and reset by engine-tick — single source of truth.
- `pendingCorrections` lives here (not in `agent_memory`) so both the inject agent (read for hint nudges) and the director agent (read+write) share the same row.

**Migration.** `pnpm db:push` regenerates SQL from the TS schema (per Marinara CLAUDE.md).

### 3.4 New directory `packages/server/src/services/gravity/`

```
packages/server/src/services/gravity/
  engine/
    consistency.ts        — tx shape validation (port of consistency.js)
    state-machine.ts      — transition rules (port of state-machine.js)
    state-compute.ts      — replay → state (port of state-compute.js)
    ledger-store.ts       — read/write gravity_transactions; allocates seq via gravity_chat_state.nextTxSeq
    snapshot-mgr.ts       — SNAP/ROLL ops on gravity_snapshots
    relationship.ts       — relationship logic
    state-view.ts         — formatting for inject
    state-cache.ts        — gravity_state_cache reader/writer; resolves last-accepted snapshot
    engine-tick.ts        — declarative deterministic post-commit phase (advance-mode ticks etc.)
    acceptance.ts         — commitAcceptedGravityTurn helper called from generate.routes.ts:~334
  director/
    client.ts             — LLM call via BaseLLMProvider; tolerant JSON parse
    prompt.ts             — director system prompt + op vocabulary
    input.ts              — payload builder; CorrectionsPayload type
  agents/
    inject-agent.ts       — loadGravityInjectForChat (deterministic; no LLM call)
    director-agent.ts     — runGravityDirector orchestration entry
```

**Logging convention.** All server-side files import the shared Pino logger:
```ts
import { logger } from "../../lib/logger.js";
```
Per Marinara CLAUDE.md: never `console.log/warn/error` in server code; use Pino format specifiers; errors as `logger.error(err, "message")`.

**Nothing else in Marinara is modified** beyond §3.1, §3.2, and §3.3.

## 4. Director runtime

The director executor is **not** a Marinara `executeAgent`-compatible function. It's invoked directly from `generate.routes.ts` (§3.2(c)) and runs the following sequence:

```
runGravityDirector(input)
├── load shared state from gravity_chat_state           (mode, pendingCorrections)
├── load last-accepted state-cache row                  (stateView, recentTail)
├── build director input
│   ├── mode
│   ├── editor-final assistant message                  (post text_rewrite if editor ran)
│   ├── stateView, recentTail
│   ├── pendingCorrections
│   ├── chatSummary, activatedLorebookEntries           (from AgentContext)
├── callDirector(input, provider, model, signal)        (one LLM call; json_object hint + tolerant parse)
├── validateAndStage(chatId, messageId, swipeIndex, txns)
│   ├── consistency.validateBatch
│   ├── state-machine.validateTransitions
│   ├── allocate gravity_chat_state.nextTxSeq under tx
│   └── INSERT gravity_transactions rows with accepted=0
├── engineTick(mode, stagedState)                       (declarative — see §4.1)
├── updateStateCacheForSwipe(chatId, messageId, swipeIndex)
├── upsert gravity_chat_state                           (mode if changed; pendingCorrections from validation errors)
└── return AgentResult { type: "gravity_state_update", data: { committed, rejected, errors, durationMs, model } }
```

**No reads from `agent_memory`.** All Gravity persistent state is in `gravity_chat_state`. The reasoning: persistent state needs to be shared between the inject and director agents (different `agentConfigId`s), and `agent_memory`'s composite key would split the namespaces.

**Editor compatibility.** The director receives the post-edit message text, not `context.mainResponse`. `chats.getMessageActiveSwipeText(messageId)` resolves to whatever the editor wrote (or original prose if editor didn't run / didn't rewrite).

**AbortSignal** flows through to the provider call; cancellation on swipe/regenerate cleanly aborts the LLM step. Already-staged rows for an aborted turn never get accepted (the next turn's acceptance hook only marks the user's chosen swipe).

### 4.1 Engine-tick (declarative, mode-gated, string-token scale)

`engine-tick.ts` runs after `validateAndStage` and before `updateStateCacheForSwipe`. It's the only place world-tick rules live. Direct port of the current `applyAdvanceTick` logic in `ST/index.js:2356-2400+`, with the same string-token scale shape.

**Scale tokens:**
```ts
const TICK: Record<string, number> = {
  HOURS: 1,
  DAYS: 24,
  WEEKS: 24 * 7,
  MONTHS: 24 * 30,
};
```

**Sequence inside engineTick:**
1. Read `world.timeskip_scale` (string) from the staged state. Default `HOURS`.
2. Map via `TICK` → `tickDelta`.
3. If `mode === "advance"`:
   - Tick non-IMMEDIATE ACTIVE collisions: `S collision.distance = max(0, dist - tickDelta)`.
   - On `WEEKS`/`MONTHS`: clear pressure entries marked expired-by-scale.
   - Detect new arrivals (distance hit 0 this tick) → add to arrival queue (consumed by §3.5 of the original ledger spec; same behavior).
4. Always: emit a tick-trailer transaction `S world.timeskip_scale = "HOURS"` to reset the scale token. (Same operation as today; lives in the ledger so the next turn sees a clean default.)
5. Append all engine-tick-generated transactions via the same `validateAndStage` path (so they share the turn's seq range and acceptance gate).

**Why declarative.** The director writes `S world.timeskip_scale = "DAYS"` as a normal transaction; engine-tick consumes it and writes `S world.timeskip_scale = "HOURS"` as another normal transaction. The ledger remains the single source of truth — no shadow column on `gravity_chat_state`, no out-of-band scale state. Replay-from-zero gives the same answer.

**Mode gating.** `engineTick` reads `mode` and only runs the world-tick pass when `mode === "advance"`. Other modes (`regular`, `combat`, `intimacy`, `integration`) skip the tick body. The scale-reset transaction is unconditional at end (cheap, idempotent, makes default sticky).

### 4.2 Response format and provider portability

`BaseLLMProvider.responseFormat` is forwarded verbatim to the underlying SDK. OpenAI honors `{ type: "json_object" }`; Anthropic/Google/local providers may ignore it.

**Stance:** the director uses `responseFormat: { type: "json_object" }` as an optimization but **never depends on it**. The tolerant JSON extractor (proven in the prototype — handles markdown fences, leading prose, trailing trailers) is the contract. Provider portability comes from this fallback.

### 4.3 `CorrectionsPayload` shape

Stored as JSON in `gravity_chat_state.pendingCorrections`. Defined in `services/gravity/director/input.ts`:

```ts
export type CorrectionEntry = {
  txId: string;             // the rejected staged transaction's id
  rejectedTx: unknown;      // serialized transaction
  reason: string;           // validator error message
  attempt: number;          // 1..MAX_CORRECTION_ATTEMPTS (3)
};

export type CorrectionsPayload = {
  entries: CorrectionEntry[];
  generatedAt: number;      // unix seconds
};
```

Cleared on successful re-commit; entries dropped after `MAX_CORRECTION_ATTEMPTS = 3`.

## 5. Inject runtime

`loadGravityInjectForChat(chatId)` (called from §3.2(b)):
1. Read `gravity_chat_state` for `chatId`. If row missing → return `null` (chat not initialized).
2. From the row: `(acceptedMessageId, acceptedSwipeIndex, mode)`.
3. If acceptance pointer is null (no accepted turn yet) → return null or a setup-prompt.
4. Read `gravity_state_cache` for `(chatId, acceptedMessageId, acceptedSwipeIndex)`. If missing → log warn, return null (state-cache rebuild needed).
5. Build mode-specific nudge from `mode`.
6. Return `{ text: stateView + "\n\n" + nudge, archiveVersion, mode }`.

The result is pushed onto `trackerParts` in `generate.routes.ts:~3565` and renders in the same wrap-format as other tracker context. An `AgentResult` of type `context_injection` is also fired so the SSE stream and `agent_runs` table see the inject as a normal agent event.

## 6. Storage and snapshots

Five Gravity-owned tables, all FK'd to `chats.id` with `onDelete: "cascade"`:
- `gravity_transactions` (per-swipe, with `accepted` gate)
- `gravity_state_cache` (per-swipe pre-rendered snapshot)
- `gravity_snapshots` (explicit SNAP/ROLL)
- `gravity_chat_state` (single row per chat; shared persistent state + acceptance pointer)

**Acceptance flow:** §3.2(a). On real new user turn, the helper marks the prior assistant message's active swipe's transactions as `accepted = 1` and updates `acceptedMessageId/acceptedSwipeIndex`. Other swipes' transactions stay `accepted = 0` — they're effectively dead but kept for forensic value (and trivially purged later if needed).

**Snapshot/rollback vs. Marinara branching:** Phase 1 keeps `snapshot-mgr` (Gravity-owned). Marinara's branching copies messages + metadata under a new `chat_id`; Gravity rows don't follow because they're keyed by chat_id. Three options later:
- A. Keep snapshot-mgr Gravity-internal (recommended, phase 1).
- B. Hook into branching: on branch creation, copy Gravity rows under the new chat_id. Marinara doesn't currently emit a branching event; would require a small storage-layer hook.
- C. Hybrid: branching auto-snapshots Gravity. Most coupled.

Defer B/C. `commitAcceptedGravityTurn` in §3.2(a) is the only acceptance integration in phase 1.

## 7. Setup / initialization

Marinara doesn't ship a Gravity-specific form UI. Two paths:

- **OOC command + modal (recommended).** Add `/gravity init`; opens a Marinara modal (modals exist for other features), collects answers, posts to `/api/gravity/init` (new route in `routes/gravity.routes.ts`). Engine creates initial transactions deterministically — no LLM call. Sets up `gravity_chat_state` row; first user turn triggers acceptance and the inject becomes live.
- **Inject-fallback prompt.** If `gravity_chat_state` is missing, inject returns a one-time setup prompt. Conflicts with director-owned ledger emission; only acceptable as a degraded path.

Recommended: OOC modal. **Still needs a sub-spec** — same judgment as the service path.

## 8. Export / import

Marinara's chat export (`chats.routes.ts:926-1010`) exports messages + character/user names + metadata only — no agent data, no tracker state.

Phase 1: ship a separate Gravity export endpoint `/api/gravity/export/:chatId` returning `{ transactions, stateCache, snapshots, chatState }` for the chat. Independent of chat export; no scope creep on the chat-export surface.

Phase 2: extend `chats.routes.ts:991` with a `gravity` field when both Gravity tables and chat-export are stable.

Same export-format question as the service spec — ship transactions / snapshot+tail / state-only; default snapshot+tail.

## 9. Coupling risk assessment

Updated for the second-pass architecture.

| Marinara change | Impact |
|---|---|
| `AgentResultType` (TS union + Zod schema) extended | Zero impact (we add to it; they can add more) |
| `AgentResultType` renamed/restructured | Two-line fix (TS + Zod) |
| `AgentContext.mainResponse` renamed/removed | Director uses `chats.getMessageActiveSwipeText(messageId)` instead of `context.mainResponse` directly — actually robust to that rename. AgentContext other fields used (chatSummary, activatedLorebookEntries, signal) — minor fixes if renamed |
| `generate.routes.ts:324` acceptance block restructured | **Medium** — Gravity hook lives next to `gameStateStore.commit`. If Marinara restructures the acceptance moment, Gravity follows. Has happened before for game-state; signal of architectural maturity |
| Pipeline filter list at `:~3605` restructured | Low — extending the filter is the same shape as `editor`/`lorebook-keeper` |
| Editor block placement at `:~6151` moved | Director special-case must move with it. Low — just placement |
| `chats.getMessageActiveSwipeText` not present (helper invented for spec) | Need to verify: does Marinara expose this, or do we read `messages.swipes[activeSwipeIndex].text` directly? If invented, the director-agent helper does the swipe-resolution itself |
| `BaseLLMProvider` interface changes | Must update `client.ts` — could be significant |
| Agent pipeline phases restructured | Low — Gravity isn't in the pipeline; but `phase` value on the registration may need to change |
| Drizzle version upgrade | Standard migration; affects all schema equally |
| `agent_runs` schema changed | Must update agent registration if shape changes |

**Highest actual risk:** `generate.routes.ts` is now a real coupling point with four code edits (acceptance hook, filter list, inject render, director call). Mitigated by the fact that all four mirror existing patterns in that file (`gameStateStore.commit`, the editor exclusion, the tracker-parts construction, the editor post-block). API-stability signal from `git log` of `generate.routes.ts`: medium — file has had structural refactors recently, but the four landmarks (acceptance, pipeline filter, tracker-parts, editor block) are stable.

**Lowest risk:** DB schema additions (purely additive), `AgentResultType` additions (purely additive), new files in `services/gravity/` (Marinara never touches them).

**Open spec gap to verify in implementation:** does `chats.getMessageActiveSwipeText(messageId)` already exist? If not, the director helper resolves the swipe text directly via `chats.getMessage(messageId)` + `swipes[activeSwipeIndex]`.

## 10. When this path is better than the service path

| Factor | Embedded wins | Service wins |
|---|---|---|
| Marinara is the long-term home | ✓ — no throwaway work | |
| Phase 3 is a fully independent frontend | | ✓ |
| SillyTavern needs to stay usable in parallel | | ✓ |
| User comfort: one process, one config | ✓ | |
| Director model in Marinara UI | ✓ | |
| Lorebook entries + chat summary available | ✓ | |
| Per-swipe staging matches host's existing accepted-state model | ✓ — uses Marinara's acceptance moment for free | (host doesn't exist) |
| No coupling at all to Marinara internals | | ✓ |
| Potential upstream PR | ✓ — if accepted | |
| Port to any future host without rework | | ✓ |
| Works without Marinara running | | ✓ |

## 11. Migration sequence (embedded path)

1. **Engine extraction** (in this repo first). Isolate JS engine modules into clean, host-agnostic form. Add node tests. Shared with the service path.
2. **Fork Marinara.** Working branch in a separate clone. Add §3.1 type/schema/registration entries. Add prompt-template entries.
3. **Port engine to TS.** Move modules into `services/gravity/engine/`. Add `state-cache.ts`, `engine-tick.ts`, `acceptance.ts`. Wire to DB.
4. **Add the four schema files + index exports.** `pnpm db:push`. Verify FKs, indices, primary keys.
5. **Implement `runGravityDirector` and `loadGravityInjectForChat`** (`services/gravity/agents/`). Use `BaseLLMProvider` and Pino throughout. Test with synthetic inputs.
6. **Wire the four `generate.routes.ts` edits** (§3.2 a/b/c — acceptance hook, filter, inject, director). Smallest possible change per landmark.
7. **Verify editor compatibility.** End-to-end test: enable editor + Gravity director; confirm director sees post-edit text.
8. **Verify per-swipe staging.** End-to-end test: generate, swipe, swipe again, accept third — only third's transactions become accepted.
9. **Verify advance-mode tick.** End-to-end test: director writes `world.timeskip_scale = "DAYS"`; engine-tick consumes, ticks distances, resets to `HOURS`.
10. **Setup wizard.** OOC modal path (§7).
11. **Export endpoint** (§8 phase 1: separate `/api/gravity/export/:chatId`).
12. **SillyTavern → Marinara import.** Build `POST /api/gravity/import`. Migrate active chats.
13. **Phase-2 hardening.** Extend chat-export (§8 option A). Optional: branching hook (§6 option B).

## 12. Summary comparison (both specs side by side)

|  | Embedded (this spec) | Standalone service (other spec) |
|---|---|---|
| Process count | 1 | 2 |
| Marinara fork required | Yes | No |
| Files changed in Marinara | ~5 (additive) + ~4 edits in `generate.routes.ts` | 0 |
| Engine module location | `packages/server/src/services/gravity/engine/` | `gravity-service/engine/` |
| Director model config | Marinara agent settings UI | Service env / settings file |
| AgentContext available | Yes | No |
| Per-swipe staging | Yes (matches Marinara's accepted-state model) | Service must invent its own |
| Editor compatibility | Director runs after editor; sees rewritten text | Service receives whatever the host sends |
| Chat branching integration | Possible (deferred) | Not applicable |
| SillyTavern parallel support | No | Yes |
| Phase 3 independent frontend | Rework | No rework |
| Upstream PR possibility | Yes | N/A |
| Coupling to Marinara internals | Real, bounded, focused on `generate.routes.ts` | Near-zero |
| Auth for director key | Marinara connection system | Service-internal |

## 13. References

- `2026-04-21-gravity-marinara-port-design.md` — standalone service design (the other option)
- `2026-04-25-gravity-director-design.md` — director prototype spec
- `2026-04-26-director-handoff.md` — prototype validation results
- Marinara: `packages/shared/src/types/agent.ts` — `AgentResultType`, `AgentContext`, `BUILT_IN_AGENTS`, `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS`
- Marinara: `packages/shared/src/schemas/agent.schema.ts` — `agentResultTypeSchema` (Zod)
- Marinara: `packages/shared/src/constants/agent-prompts.ts` — `getDefaultAgentPrompt` registry
- Marinara: `packages/server/src/routes/generate.routes.ts:324` — acceptance moment for game-state commit (Gravity hook lives here)
- Marinara: `packages/server/src/routes/generate.routes.ts:~3605` — pipeline filter (`editor`/`lorebook-keeper`/Gravity exclusion)
- Marinara: `packages/server/src/routes/generate.routes.ts:~3565` — tracker-parts construction (Gravity inject text appended here)
- Marinara: `packages/server/src/routes/generate.routes.ts:~6151` — editor block end (director special-case dispatched after this)
- Marinara: `packages/server/src/services/agents/agent-executor.ts` — pipeline + `parseAgentResponse` + `JSON_AGENTS`. **Not edited by Gravity.**
- Marinara: `packages/server/src/db/schema/game-state.ts` — `game_state_snapshots(chatId, messageId, swipeIndex, committed)`. Pattern Gravity follows.
- Marinara: `packages/server/src/services/storage/agents.storage.ts` — `agentsStore.saveRun` (Gravity uses for AgentResult persistence)
- Marinara: `CLAUDE.md` — Pino logging mandate, `pnpm check` / `pnpm db:push` workflow
- Current ST extension: `ST/index.js:2356` — `applyAdvanceTick`, the basis for `engine-tick.ts`. String-token scale (`HOURS`/`DAYS`/`WEEKS`/`MONTHS`) preserved.
