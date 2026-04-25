# Gravity Director — Design

Date: 2026-04-25
Status: Draft (pending user review)
Supersedes (sequencing only): `2026-04-21-gravity-marinara-port-design.md` is parked as a frozen paper design until the director prototype produces results that may reshape it.

## 1. Goal and non-goals

**Goal.** Replace `---LEDGER---` parsing with a separate API call to a "director" model that proposes ledger transactions in JSON. Deterministic extension code remains the only thing allowed to commit. Prove or disprove the architecture inside the current SillyTavern extension before any port.

**Non-goals (this prototype).**
- No relay service — browser-side `fetch` only, single user.
- No port to Marinara — the Marinara design stays a frozen paper spec until director results land.
- No replacement of validators, replay, snapshots, or the operator UI.
- No shadow-mode evaluation phase — direct cutover.
- No swipe/regen idempotency fix — same gap as today, documented and out of scope.

## 2. Locked decisions

| # | Decision |
|---|---|
| 1 | Director-first. Marinara design parked. |
| 2 | Personal-use only. Browser-side `fetch` direct to provider. No relay, no auth proxy. |
| 3 | Director provider/model is configurable via extension settings (provider picker + model id + API key). Defaults: Anthropic / `claude-sonnet-4-6`. |
| 4 | Full cutover. Strip ledger-emit instructions from `gravity_v15.json` and remove the `_readme` prompt slot. Prose model writes prose only. |
| 5 | Director output is direct Gravity tx objects — same shape `consistency.js` validates today. No translation layer. |

## 3. Architecture

Three new/changed components in the existing extension repo.

### 3.1 `director-client.js` (new)

Provider abstraction (`anthropic` | `openai`). One async function:

```js
proposeTransactions(input) -> {
  ok: true,
  transactions: [...],   // Gravity tx objects
  notes: "...",          // free-text reasoning, logged only
  confidence: "high"|"medium"|"low",
  model: "...",
  durationMs: 1234
} | {
  ok: false,
  reason: "network" | "timeout" | "auth" | "ratelimit" | "invalid_json" | "schema_mismatch",
  raw: "..."             // raw response for debugging
}
```

Anthropic call uses `tool_use` with a strict input schema. OpenAI call uses `response_format: json_schema`. Both providers therefore guarantee parseable JSON; if parsing still fails, that's a `reason: "invalid_json"` failure (loud, not silent — see §7).

### 3.2 `director-prompt.js` (new)

System prompt + op vocabulary readme for the director call. Critically: this file inherits the **rules and field contracts** from the current `formatReadme()` in `state-view.js:755`, but **reissues every example as a JSON tx object**, not as `---STATE---` / `---LEDGER---` text blocks. The text-block syntax is dead under cutover; the director never reads or writes that format.

Contents:
- Role framing: "you are a state-delta operator, not a prose model"
- Op vocabulary (`CR`, `S`, `TR`, `A`, `R`, `MS`, `MR`, `D`, `SNAP`, `ROLL`, `AMEND`)
- Entity types (`char`, `constraint`, `collision`, `combat`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`)
- State-machine rules (char tier transitions, constraint integrity, collision status, combat status)
- Distance/category/cost rules for collisions
- Knowledge asymmetry key conventions
- Relationship update rules
- Cleanup-cap awareness (`R/MR/D` capped at 3 outside eval turns)
- Behavioral priorities (conservative mutation, earned change, structural integrity)
- One JSON example per op
- One full-turn example showing realistic combinations

This file is now a **doc-drift hotspot of the same class as `state-view.js`** — when schema or state-machine rules change, both this file and the architecture reference must update.

### 3.3 Commit seam swap in `index.js`

`onMessageReceived(messageId)` (index.js:1505) is the seam. Replace `extractUpdateBlock()` (line 1527) with `proposeTransactions()`. Downstream behavior is partly unchanged, partly reworked.

#### Retained downstream (truly unchanged)
- `validateBatch()` per-tx loop
- Travel/tier gates (index.js:1617+)
- Cleanup-op cap (`R/MR/D` ≤ 3 outside eval turns)
- `rewriteDuplicateActiveChallengeCreate()` (index.js:187) — explicitly retained as a post-director normalizer
- `processChallengeAssistantTurn()` calls — still run on the cleaned assistant message, on both success and failure paths
- `appendTransactions()` + replay + audit
- Snapshot/rollback, UI refresh
- `stripLedgerBlock()` (regex-intercept.js:683) — retained for cleaning legacy ledger blocks out of `recentTurns` input to the director (old chats may still contain them) and for display cleaning

#### Bypassed
- `compileStateEntries()` — only relevant to the legacy `---STATE---` format that no longer exists post-cutover
- `extractUpdateBlock()` — kept exported for one-off debugging / migration tools, but no longer wired into the main flow

#### Reworked
- **Correction pipeline.** `buildCorrectionInjection()` (regex-intercept.js:665) currently emits `"resubmit these lines fixed in your next ---STATE--- or ---LEDGER--- block"`. Under cutover that text is wrong on its face. New behavior:
  - `_pendingCorrections` is no longer rendered into the prose-side `_inject` slot.
  - `_pendingCorrections` is passed into the **next** director call as a structured `pendingCorrections` field.
  - The director system prompt teaches the model to consume corrections as: "your previous proposed txs were rejected for these reasons; reissue corrected txs this turn."
  - `buildCorrectionInjection()` is replaced (or renamed) by `buildDirectorCorrectionPayload()` returning a structured object suitable for the director input.
- **`_pendingReinforcement`.** Today it's parser-compliance scaffolding (e.g., `[STATE/LEDGER: OK]`, malformed-block reminders) injected at index.js:1234. Under cutover:
  - Drop parser-compliance reinforcement entirely. The director's structured-output guarantee makes "remind the model to emit a block" obsolete.
  - Add one new reinforcement category: **director-failure flag.** When the previous turn's director call failed, surface that fact in the next director call's input as `lastDirectorFailed: true`, so the director knows the previous turn produced no commits and may have unfinished business.
  - The `_inject` prompt slot becomes prose-only (or empty) in normal operation.

## 4. Data flow per turn

### Success path

```
LLM prose response arrives → onMessageReceived(messageId)
  → cleanedAssistantMessage = stripLedgerBlock(message.mes)   // legacy hygiene
  → director-client.proposeTransactions({mode, userMessage, assistantMessage,
                                          stateView, recentLedgerTail,
                                          pendingCorrections, recentTurns,
                                          lastDirectorFailed})
  → returns {ok: true, transactions, ...}
  → validateBatch loop (per tx)
  → cleanup-op cap
  → rewriteDuplicateActiveChallengeCreate
  → appendTransactions + replay + audit
  → processChallengeAssistantTurn(_currentState, committedTxns, cleanedAssistantMessage)
  → ui-panel + state-view refresh
  → _lastDirectorFailed = false
```

### Failure path

```
LLM prose response arrives → onMessageReceived(messageId)
  → cleanedAssistantMessage = stripLedgerBlock(message.mes)
  → director-client.proposeTransactions(...)
  → returns {ok: false, reason, raw}
  → console.error with prefix + reason + truncated raw
  → NO commits, NO append
  → still call processChallengeAssistantTurn(_currentState, [], cleanedAssistantMessage)
     (challenge progress is independent of director success)
  → set _lastDirectorFailed = true
  → ui-panel renders red "director failed last turn" badge
  → injectPrompt() runs as normal (no parser-compliance reinforcement,
     director-failed flag will surface in next director call instead)
```

## 5. Director input

Sent on every turn:

| Field | Source | Notes |
|---|---|---|
| `mode` | `_currentInjectMode` + active deduction submode | `regular` / `advance` / `integration`, plus `combat` / `intimacy` flags |
| `userMessage` | latest user message (raw) | |
| `assistantMessage` | `cleanedAssistantMessage` | Stripped of any legacy ledger blocks via `stripLedgerBlock()` |
| `stateView` | `formatStateView(_currentState, mode)` | Same view the prose preset sees |
| `recentLedgerTail` | last 20 committed txs from `ledger-store` | Compact JSON. Resolves the v1 mismatch where the director "owned" the ledger but never saw it. Window size configurable. |
| `pendingCorrections` | structured array `[{tx, errors, fix}]` | From prior turn's rejected txs |
| `recentTurns` | last 3 user/assistant pairs | Each assistant pair pre-cleaned via `stripLedgerBlock()` |
| `lastDirectorFailed` | boolean | True iff prior turn's director call returned `ok: false` |

No full transcript. No raw ledger history beyond the tail.

## 6. Director output schema

```json
{
  "transactions": [
    {
      "op": "TR",
      "e": "collision",
      "id": "bridge-confrontation",
      "d": { "f": "status", "from": "ACTIVE", "to": "RESOLVED" },
      "r": "PC forced the confrontation on-screen and the collision completed this turn."
    }
  ],
  "notes": "optional free-text reasoning, ignored by extension",
  "confidence": "high"
}
```

- Empty `transactions: []` is a first-class no-op outcome and commits cleanly.
- `notes` is logged to console only.
- `confidence` is logged but does not gate commit; validators are authoritative.

## 7. Failure handling

| Failure | Behavior |
|---|---|
| Network error, timeout, 429, auth error | No commit. Loud console log. `_lastDirectorFailed = true`. Panel shows red badge. No retry within turn. **No parser fallback.** |
| Director returns invalid JSON (despite structured output) | **Same as network failure** — loud log, no commit. Never silently treat as `transactions: []`; that would mask real structural updates being lost. |
| Director returns valid JSON, schema-mismatch (missing required fields, unknown op) | Loud log, no commit, no silent partial. |
| Director returns valid JSON, some txs fail `validateBatch` | Existing per-tx validation rejects them; rejected txs route to `_pendingCorrections` and surface as **director input** on the next turn (not as a prose-side reinforcement). |
| Director returns `transactions: []` | Commit nothing. Normal. No badge. |
| Cleanup-op cap fires | Same as today (`R/MR/D` capped at 3 outside eval turns). |
| User swipes / regenerates | Same gap as today. `onMessageReceived` doesn't fire on swipes; ledger goes stale; user must rollback manually via OOC. Out of scope; documented. |

## 8. Settings

### Persistence

`extension_settings[MODULE_NAME]` — global per-installation, not per-chat. API key, provider, model id, and recent-ledger-tail size all live there. Per-chat persistence is explicitly wrong for credentials.

### UI

No general settings form exists in this repo today (UI wiring at index.js:2557 is panel-action callbacks, not a settings panel). The director introduces a **new HTML settings drawer** registered via SillyTavern's standard extensions settings injection point.

Fields:
- Director provider — dropdown (`anthropic` | `openai` | `disabled`)
- Director model — text field (default `claude-sonnet-4-6`)
- Director API key — password field
- Recent-ledger-tail size — number, default 20
- "Test director call" button — sends a minimal smoke ping with a fixed payload, surfaces success/error inline

### Disabled mode

When provider is `disabled` (or no API key configured): **hard off with a visible banner** in the Gravity panel:

> *"Director not configured — Gravity is read-only this session. No structural updates are being committed."*

Prose still flows; the ledger freezes. No silent pretending the engine is alive. No fallback to the old parser path (preset has been stripped of ledger-emit instructions, so the parser would have nothing to find anyway).

## 9. Preset and prompt cleanup (full audit, not just example stripping)

This is bigger than v1 implied. Targets:

### `gravity_v15.json`
- **"| Gravity - Anchor"** (line 580 area, the rules-that-drift entry): rule 5 ("STATE BLOCK EVERY NORMAL TURN") and the "Turn Sequence" instructions explicitly mandate ledger emission. Rewrite the entry without those rules, or disable it.
- **"| L4 - Phase 2 Commands"** (line 593 area): this is a full `---LEDGER---` syntax tutorial baked into the preset. **Disable or remove this entry entirely** — the director-prompt now owns this content (in JSON form).
- Audit the rest of the preset for any other entries referencing `---STATE---`, `---LEDGER---`, or per-mode block-emission examples.

### `index.js`
- Remove `_setPrompt(`${MODULE_NAME}_readme`, readme)` (line 1206). Drop the `_readme` slot from the readme list at the top of the file. The readme content has migrated into the director system prompt.
- Remove `formatReadme` import.

### `state-view.js`
- Delete `formatReadme()`, `formatReadmeCore()`, `formatReadmeFull()` (line 755+). Migrate semantic content (rules, field contracts, state-machine specs) into `director-prompt.js`, **rewriting all examples as JSON tx objects.**
- `formatStateView()` (line 163) — untouched. Both prose preset and director consume its output.

### `regex-intercept.js`
- `buildCorrectionInjection()` (line 665) — replaced by `buildDirectorCorrectionPayload()` (or rewritten to return a structured object). The "resubmit ---STATE--- block" text is dead.
- `extractUpdateBlock()` — kept exported, no longer wired into main flow.
- `stripLedgerBlock()` (line 683) — retained, used by both director-input cleaning and display cleaning.

## 10. Files touched

| File | Action |
|---|---|
| `director-client.js` | NEW |
| `director-prompt.js` | NEW (absorbs `formatReadme()` semantic content, examples rewritten as JSON tx) |
| `index.js` | MODIFY — seam swap; corrections rewired; reinforcement gutted; `_readme` slot removed; settings drawer registered; failure-path challenge processing preserved |
| `gravity_v15.json` | MODIFY — full audit; remove/rewrite "Anchor" and "L4 - Phase 2 Commands" entries; audit other entries for ledger-emit references |
| `state-view.js` | MODIFY — delete `formatReadme*`; `formatStateView` untouched |
| `regex-intercept.js` | MODIFY — replace `buildCorrectionInjection` with director-input builder; keep `stripLedgerBlock`; keep `extractUpdateBlock` as debug-only export |
| `consistency.js` / `state-machine.js` / `state-compute.js` / `snapshot-mgr.js` / `ledger-store.js` | UNTOUCHED |
| `ui-panel.js` | MINOR — disabled-mode banner + director-failed badge |
| `Documentation/system_architecture_reference.md` | MODIFY — add director-prompt + director-client to maintenance checklist; flag director-prompt as a doc-drift hotspot |

## 11. Success criteria

### Baseline capture (one-time pre-prototype task)

Before cutover, on a curated set of N≥20 historical real-play turns:

- Re-run under instrumentation with the current parser path
- Per turn, record:
  - committed tx count
  - rejected tx count (validation errors)
  - "no block found" / malformed extraction count
  - subjective: were structural updates actually missed (your judgment, on the same turns)
- Aggregate per session: misses-per-session, rejects-per-session, latency-per-turn

### Director acceptance bar (post-cutover, comparable turn set)

| Metric | Bar |
|---|---|
| Missed structural updates per session | < parser baseline |
| Rejected txs per session | < parser baseline |
| Commit-safety regressions (corrupt state, illegal transitions slipping through) | Zero |
| Latency added per turn | < 5s p50 with Sonnet-class director |
| Cost per turn | Tracked in $/100 turns; threshold up to operator |

If 2+ of "missed updates / rejected / latency" regress relative to baseline, kill the experiment.

## 12. Pre-prototype tasks

These can run concurrently and gate the implementation plan:

1. **Baseline capture** (§11). Without it, the success criteria are hand-wavy.
2. **Browser-fetch feasibility spike.** "No relay" is locked, so CORS / browser-direct calls to Anthropic and OpenAI from the SillyTavern extension context are now a hard architectural dependency, not just an implementation detail. Spike: minimal smoke call from a SillyTavern extension page to both providers, confirm the required headers (`anthropic-dangerous-direct-browser-access` for Anthropic, plus standard `Authorization`), confirm streaming-vs-non-streaming behavior, confirm error surfaces. If this fails, the locked decisions are wrong and the spec needs to revisit a relay.
3. **Settings drawer scaffolding.** Separable from the director itself; can land first as a no-op drawer to de-risk the persistence path.

## 13. Out of scope (explicit)

- Swipe/retry idempotency fix
- Relay service / multi-user / shippable build
- Provider beyond Anthropic + OpenAI
- A/B shadow mode against the parser
- Marinara port
- Higher-level intent schema with a translator
- Local/sidecar models
- Streaming director responses (non-streaming JSON only for v1)
