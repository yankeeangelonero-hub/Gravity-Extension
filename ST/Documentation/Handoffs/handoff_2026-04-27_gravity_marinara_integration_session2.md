# Gravity Marinara Integration — Session 2 Handoff

## Date

`2026-04-27 — evening`

## Scope

This session completed the Gravity Ledger integration into Marinara Engine (Tasks 1–13 were all done in session 1; this session fixed post-integration bugs and added the UI widget). Changes live entirely in the Marinara fork at `Marinara Engine/Marinara-Engine/` on branch `gravity-integration`.

No changes to the ST extension or outer repo.

---

## What Was Done This Session

### 1. Gravity HUD Widget (UI)

Added a Network icon widget to the RoleplayHUD that shows Gravity Ledger state.

**New file:** `packages/client/src/stores/gravity.store.ts`
- Zustand slice tracking `lastDirectorResult`, `totalCommitted`, `archiveVersion`
- `setDirectorResult` accumulates `totalCommitted` across turns
- `reset()` for chat change

**Modified:** `packages/client/src/hooks/use-generate.ts`
- Populates gravity store from `agent_result` events for both `gravity-ledger-director` and `gravity-ledger-inject`
- Adds `gravity-ledger-director` case to `formatAgentBubble` — shows `⚖️ N committed · N rejected · ⚡ N arrivals` in the thought bubble

**Modified:** `packages/client/src/components/chat/RoleplayHUDPanels.tsx`
- Added `GravityLedgerPanel` — fetches `GET /gravity/state/:chatId` on open, shows mode/seq/committed stats + scrollable stateView text + refresh button

**Modified:** `packages/client/src/components/chat/RoleplayHUD.tsx`
- Added `GravityLedgerWidget` component: Network icon, amber pulse dot on arrivals, `totalCommitted` badge
- Widget appears in both mobile and desktop strips when either gravity agent is enabled

### 2. `GET /gravity/state/:chatId` endpoint

Added to `packages/server/src/routes/gravity.routes.ts`. Returns `initialized`, `mode`, `stateView`, `archiveVersion`, `nextTxSeq` for the widget panel.

### 3. Staged-cache fallback in `/state` endpoint

**Bug:** After turn 1 the widget showed empty state because the endpoint only read the *accepted* cache, and acceptance doesn't happen until the start of the next user turn (when `commitAcceptedGravityTurn` runs).

**Fix:** The endpoint now falls back to the most recently written cache row (`ORDER BY messageId DESC`) when `acceptedMessageId` is null. Widget shows state immediately after the first director run.

### 4. `retry-agents` inject agent crash fix

**Bug:** `use-generate.ts` was logging `Gravity Ledger (State Injection) failed: No prompt template configured`. The inject agent has no prompt template (it reads DB state, not LLM) but the `retry-agents-route.ts` was routing all agents through generic `executeAgent` which requires a template.

**Fix:** `packages/server/src/routes/generate/retry-agents-route.ts`
- Filter `gravity-ledger-inject` and `gravity-ledger-director` out of the generic `nonLorebookAgents` batch
- Added a gravity-director-specific retry block that calls `runGravityDirector` directly
- `gravity-ledger-inject` is silently skipped on retry (nothing to re-run post-generation)

### 5. Director slowness investigation and fixes

**Root causes found:**
- Director was running on every single turn (runInterval default: 1)
- `buildRecentTail` was serializing 20 transactions into the director input; reduced to 10
- `maxTokens: 4096` was appropriate, but was briefly reduced to 1500 (see below)

**Perf commit:**
- `maxTokens` 4096 → 1500 (later reverted — see below)
- `buildRecentTail` default 20 → 10 transactions
- `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS` for `gravity-ledger-director`: 1 → 3

**Thinking model fix:**
- Added `stripThinkingBlocks()` in `director/client.ts` — strips `<think>/<thinking>` blocks from raw response before JSON extraction. DeepSeek R1, Qwen, and other reasoning models emit these.
- Added INFO log: `[gravity-director] raw response: N chars total, N thinking, N json, Nms model=X` — use this to diagnose "is the model reasoning instead of answering?"

**maxTokens regression and fix:**
- The 1500 ceiling caused 0 commits when using DeepSeek V4 Flash. That model generates ~1000–1500 tokens of `<think>` content before the JSON; the ceiling was hit before the JSON started. Parse failed silently → 0 transactions.
- **Reverted to 4096.** Thinking models need the headroom. Non-thinking models rarely exceed 800 tokens of JSON so 4096 is headroom not a bill.

### 6. Architecture clarification: the director does NOT read `---LEDGER---` blocks

The prose model (via `gravity_v15.json` preset) outputs `---LEDGER---` blocks. The Marinara director **ignores these entirely**. It takes the full prose text (blocks included as raw context) and makes a separate LLM call using its own JSON system prompt to generate transactions.

This is the cause of the 23-second director runtime: the model is re-reading what the prose model already wrote in structured form and re-deriving it via reasoning.

The alternative is to port `ST/regex-intercept.js` to TypeScript and parse the ledger blocks directly — no LLM call, sub-millisecond. **The user explicitly declined this path tonight.** Reason: it goes back to the original ST system architecture. The director LLM approach is architecturally distinct and preferred.

---

## Current Branch State

Branch: `gravity-integration` in `Marinara Engine/Marinara-Engine/`

All commits since session 1:
```
779819d  fix(gravity): restore maxTokens to 4096 — thinking models need headroom
59487a8  fix(gravity): prevent inject agent from reaching executeAgent in retry path
a573a4a  fix(gravity): strip thinking blocks, log raw output for director diagnosis
5b11f3e  perf(gravity): reduce director latency — lower maxTokens, tail size, run interval
4bb0fce  fix(gravity): fall back to most-recent staged cache in /state endpoint
fc9b578  feat(gravity): add Gravity Ledger widget to HUD (Network icon, popover panel)
```

`pnpm check` passes clean on all commits.

---

## Known Issues / Open Questions

### Director slowness is inherent to the architecture

With a thinking model (DeepSeek V4 Flash, ~23s), the director adds 23 seconds per-turn or per every 3 turns (with runInterval=3). The only code fix is to switch the director's connection in the Agent Editor to a non-thinking model. Claude Haiku, GPT-4o-mini, and Gemini Flash all handle the director's JSON task in 1–3 seconds.

The director log line now tells you exactly what's happening:
```
[gravity-director] raw response: 4821 chars total, 4103 thinking, 718 json, 22972ms model=deepseek-v4-flash
```
If `thinking >> json` → switch to a non-thinking model.

### CURRENT STATE section of state view stays empty until bootstrap

After first turn, the entity registry (Characters, Places) fills in but `─── CURRENT STATE ───` stays empty because the director hasn't created `constraint`, `collision`, or `pressure` entities yet.

This is expected behavior on quiet first turns. The director creates these only when the scene has enough dramatic hooks.

To bootstrap: send an OOC message like:
```
[OOC] Bootstrap the Gravity ledger. Create constraints from the character card, create at least one collision from the active tension, initialize pc with my persona name, and set world_state to the current scene.
```

### State view is always one turn behind (by design)

The widget panel shows the **accepted** state (or staged fallback). The accepted state reflects the last committed turn, not the current staged state. This is correct: the current staged state hasn't been confirmed yet (user might swipe away from it).

### `gravity_v15.json` preset outputs `---LEDGER---` blocks that are ignored

The prose model writes structured ledger blocks. The director doesn't parse them. They appear as raw text in the director's `assistantMessage` input and may be used as loose context, but are not committed directly. This is a known architectural mismatch between the ST approach and the Marinara approach. Decision to keep it as-is (director LLM approach).

---

## Key Files

```
Marinara Engine/Marinara-Engine/
├── packages/client/src/
│   ├── stores/gravity.store.ts                         NEW — Zustand slice
│   ├── hooks/use-generate.ts                           MODIFIED — store hydration + bubble
│   └── components/chat/
│       ├── RoleplayHUD.tsx                             MODIFIED — GravityLedgerWidget
│       └── RoleplayHUDPanels.tsx                       MODIFIED — GravityLedgerPanel
├── packages/server/src/
│   ├── routes/
│   │   ├── gravity.routes.ts                           MODIFIED — /state/:chatId endpoint + staged fallback
│   │   └── generate/
│   │       └── retry-agents-route.ts                   MODIFIED — gravity inject/director special-casing
│   └── services/gravity/
│       ├── director/
│       │   └── client.ts                               MODIFIED — think-block stripping, output logging, maxTokens
│       └── engine/
│           └── state-view.ts                           MODIFIED — buildRecentTail default 20→10
└── packages/shared/src/types/agent.ts                  MODIFIED — runInterval default 1→3
```

---

## Follow-Up

### Immediate
- Verify director commits transactions with a non-thinking model (Haiku / 4o-mini / Gemini Flash)
- Send an OOC bootstrap message on a fresh chat to populate CURRENT STATE

### Medium Term
- Consider: option to use `runInterval=1` in Agent Editor if every-turn tracking is needed
- Consider: whether to expose a "manual bootstrap" button in the Gravity panel that sends the OOC template automatically

### Architecture Decision to Revisit
- The "director LLM vs direct parser" choice. The current LLM approach is slow by design. If the latency becomes unacceptable even with a fast model, the parser route is available and the ST code (`regex-intercept.js`) is complete. Porting it to TS is ~1 hour of work. The user explicitly declined tonight — revisit if director LLM proves unworkable.
