# Marinara Integration Handoff

Updated: 2026-04-26

This handoff covers the design, planning, and partial execution work completed for porting Gravity Ledger into Marinara Engine. It is the continuation point for the next session picking up Task 2.

---

## Executive Summary

The embedded port direction was selected, specced, planned, and execution began. Task 1 (Node test harness for the three host-agnostic engine modules) is complete and reviewed. Tasks 2–13 are blocked on a Marinara fork that the user must create manually.

The core idea: Gravity becomes two built-in agents inside Marinara (`gravity-ledger-inject` pre_generation, `gravity-ledger-director` post_processing), sharing a TypeScript-ported engine and four new SQLite tables. Special-case dispatch mirrors the `editor`/`lorebook-keeper` pattern already in Marinara.

---

## Key Documents

| Document | Path | Status |
|---|---|---|
| Embedded spec | `docs/superpowers/specs/2026-04-26-gravity-marinara-embedded-design.md` | Final — selected direction |
| Implementation plan | `docs/superpowers/plans/2026-04-26-gravity-marinara-embedded.md` | 13 tasks, Task 1 complete |
| Rejected spec (standalone service) | `docs/superpowers/specs/2026-04-21-gravity-marinara-port-design.md` | Rejected |

The plan was updated once (commit `0b7d91d`) to fix 6 code review issues before execution began. Do not use the pre-fix version.

---

## Current Branch State

Branch: `mari-integration` (branched from `director-prototype` 2026-04-26)

Commits since branch:
```
a609fd0  fix(tests): lowercase test dir, accurate validateTransaction test names
4f21b49  test(engine): node test harness for state-machine, state-compute, consistency
0b7d91d  fix(plan): address 2 P1s and 4 P2s from code review
ea68b24  docs: Gravity Marinara embedded implementation plan
...
```

---

## Task 1 — Complete

**What was built:**
- `ST/tests/state-machine.test.js` — 9 tests: char tiers, constraint levels, collision states, relationship status
- `ST/tests/state-compute.test.js` — 5 tests: createEmptyState, applyTransaction CR/S, computeState, CATEGORY_DISTANCES
- `ST/tests/consistency.test.js` — 6 tests: VALID_OPS, validateTransaction (real semantic behavior), validateBatch
- `ST/package.json` — `{"type":"module"}` to enable ESM imports under Node

All 20 tests pass: `node --test ST/tests/*.test.js`

**API discoveries that affect the TS port (Tasks 4–5):**

| Module | Spec assumed | Real API |
|---|---|---|
| `state-compute.js` | `computeState(txns)` | `computeState(snapshot, txns)` — always two args; pass `null` for fresh replay |
| `consistency.js` | `validateTransaction()` returns `{ errors }` | Returns `{ valid, violations }` |
| `consistency.js` | `validateBatch()` returns `{ valid: Txn[], errors: Record<idx, err[]> }` | Returns `{ errors: FormatViolation[], valid: boolean }` |
| `consistency.js` | `validateTransaction` rejects bad op codes | Does not — format gating (op, entity type) is in `validateBatch`/`validateFormat` |

The TS port must match these real signatures, not the plan's assumed shapes. When porting `consistency.ts` (Task 5), implement `validateTransaction` as a semantic/shape validator only; put format checks in `validateBatch`.

---

## Architecture Decisions Locked

These were debated and decided — do not relitigate without reading the spec:

**Acceptance moment:** Staged transactions are accepted only when a real new user turn arrives. The gate is inside `generate.routes.ts` at the `!input.impersonate && (input.userMessage || input.attachments?.length)` guard (~line 324–337), next to `gameStateStore.commit()`. Swipe cycles and regenerations use staged data without accepting it.

**Per-(messageId, swipeIndex) staging:** Every director run stages transactions with `accepted=0` keyed to the swipe that produced them, mirroring the `game_state_snapshots` pattern. This prevents premature commitment on rejected swipes.

**`gravity_chat_state` table:** A single shared per-chat row (not per-agent, not per-message) holds cross-agent persistent state: `mode`, `pendingCorrections`, `acceptedMessageId`, `acceptedSwipeIndex`, `nextTxSeq`, `userTurnsSinceLastDirector`. Both inject and director agents read/write this row through a shared storage factory.

**No run-interval gating on the director:** The director always runs when enabled. A counter-based "every N turns" gate was considered and rejected — missed turns drop structural updates with no recovery path. This is a phase-1 design choice.

**Single SQL transaction for director commit:** Steps 6–9 of the director runtime (validateAndStage → engineTick → updateStateCacheForSwipe → upsert gravity_chat_state) must be atomic. Failure at any step rolls back the entire block.

**Engine-tick as declarative post-commit:** The `advance` mode tick is a separate module (`engine-tick.ts`) that reads `world.timeskip_scale` (token: `HOURS`/`DAYS`/`WEEKS`/`MONTHS`), maps via a TICK table, ticks ACTIVE non-IMMEDIATE collision distances, clears pressure on WEEKS+, and resets scale to `"HOURS"`. This runs inside the director's atomic SQL transaction.

**Inject agent skips `saveRun`:** At pre-generation time there is no `messageId` yet, so `agentsStore.saveRun()` cannot be called. The inject route only pushes its output into the tracker parts and fires `sendAgentEvent`. No run record is written.

**State cache tail:** `stateCacheStore.upsertForSwipe` must be called with `allStagedTxns` (accepted + newly validated from this director run), not just previously-accepted transactions. Using only accepted transactions produces a stale `recentTail` that causes the next director call to miss its own prior turn's output.

---

## Marinara Fork — Set Up

Decision (2026-04-26): the existing clone at `Marinara Engine/Marinara-Engine/` was repurposed as the active fork — no separate clone, no GitHub fork. Working locally on branch `gravity-integration` off main. Origin remains `Pasta-Devs/Marinara-Engine` (upstream). The directory is gitignored from the outer Gravity-Extension repo but has its own `.git/` and tracks its own commits.

Status:
- Branch `gravity-integration` created off main
- `pnpm install` completed (exit 0)
- **Known issue:** `better-sqlite3` native build failed at install time (no Visual Studio toolchain on this Windows machine). Does not block Task 2 (`pnpm check` only runs TS + ESLint). Will block any task that runs the server or hits SQLite — must be resolved before Tasks 3+ are exercised end-to-end. Fix options: install Visual Studio Build Tools (C++ workload), or use a `better-sqlite3` version with a prebuilt Windows binary that matches Node v24.

Working dir for Tasks 2–13: `D:\claude\Gravity Preset\Gravity-Extension\Marinara Engine\Marinara-Engine`. Run `pnpm check` there after every task before committing.

---

## Task 2 Next Steps (once fork is ready)

**Task 2: Register Gravity agents in shared types**

Files to modify in the fork:
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/schemas/agent.schema.ts`
- `packages/shared/src/constants/agent-prompts.ts`

Key changes (see plan Task 2 for exact code):
1. Add `"gravity_state_update"` to `AgentResultType` union (~line 40 in agent.ts)
2. Add `GRAVITY_LEDGER_INJECT` and `GRAVITY_LEDGER_DIRECTOR` to `BUILT_IN_AGENT_IDS`
3. Add two `BUILT_IN_AGENTS[]` entries (category: "tracker")
4. Add `"gravity-ledger-director": 1` to `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS`
5. Add placeholder prompts to `agent-prompts.ts`
6. Validate with `pnpm check`

Then Task 3 (DB schema), Task 4 (engine types + state-machine + state-compute), etc. The plan is self-contained with exact code for each step.

---

## Important Marinara Patterns

For new contributors reading this before touching the fork:

**Storage factory:** `export function createXxxStorage(db: DB) { return { async method() {...} }; }` — instantiated in route handlers via `const xxxStore = createXxxStorage(app.db)`.

**Logger:** `import { logger } from "../lib/logger.js"` — never `console.log` in server code.

**LLM calls:** `await provider.chatComplete(messages, { model, temperature, maxTokens, stream, signal })` via `BaseLLMProvider`.

**Pipeline filter** (generate.routes.ts ~line 3605): `resolvedAgents.filter((a) => a.type !== "editor" && a.type !== "lorebook-keeper")` — Gravity agents must be added to this exclusion so they don't run through the standard pipeline in addition to their special-case dispatch.

**Lorebook entry shape:** `activatedLorebookEntries` items use `e.name` (not `e.title`) for the lorebook entry name.

**Validation:** `pnpm check` runs TypeScript + ESLint. Run after every task before committing.
