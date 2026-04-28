# ST → Marinara Parity Gaps

Date: 2026-04-28
Status: Tracking doc — captures outstanding ST features not yet ported to the Marinara fork.
Related: `2026-04-26-gravity-marinara-embedded-design.md` (the architectural spec; this doc lists what that spec deferred or didn't enumerate)

> **Context.** The Marinara port focused on the core injection/director split (setup turn shipped 2026-04-28). This doc enumerates ST features that still need to be ported and ranks them by user-visible impact. Each item is a candidate for its own design spec + plan; this doc is *not* itself a plan.

## 1. Ledger maintenance system

**What ST does:**
- **Rotating maintenance schedule** — the inject agent picks one consolidation check per regular turn based on `turn_number % N`. Spreads cleanup across turns so no dedicated "maintenance turn" is needed and each turn stays lightweight.
- **Pressure-point FIFO cap at 5** — when a 6th `pressure` is created, oldest drops automatically.
- **`demonstrated_traits` cap at ~8 per char** — when exceeded, the inject agent fires a maintenance nudge telling the director to consolidate redundant traits and `R` (remove) before `A` (append).
- **Knowledge-asymmetry pruning** — when a `knows_X` on char A and `unknown_X` on char B both witness X together, the entries should clear (became mutual knowledge).
- **State-view filtering of resolved collisions** — `RESOLVED` and `CRASHED` collisions stay in history for replay but are filtered out of the active state-view so they don't bloat the prompt.
- **Constraint integrity ladder** — `STABLE → STRESSED → CRITICAL → BREACHED` is enforced via `validateTransition()`. Breached constraints are deprioritized in the view.
- **OOC commands** — `consolidate`, `power review`, `history` for manual cleanup passes.

**What Marinara has:**
- `validateTransitions` (constraint integrity ladder ✓)
- `gravity_chat_state` schema with mode column (basis for nudges) ✓
- Inject agent slot architecture (extension point for maintenance nudges) ✓
- Engine tick (advance-mode distance ticks) ✓

**What's missing:**
- The rotating-schedule pick-a-check-this-turn logic in inject
- FIFO cap on pressures
- `demonstrated_traits` cap + maintenance nudge
- Knowledge-asymmetry auto-prune
- State-view filter for resolved/crashed collisions
- OOC commands

**User-visible impact:** Over a long chat the state grows monotonically. demonstrated_traits balloons to 30+ per char. Resolved collisions still appear in the prompt. Eventually the prompt becomes prohibitively expensive and the director's signal-to-noise drops.

**Estimated scope:** Substantial — engine helpers, state-view changes, inject-agent rewrite, director-prompt updates. Probably 3-4 weeks of focused work or a series of smaller specs (e.g., "FIFO + state-view filter" first, then "rotating schedule + nudges").

## 2. Director over-emission guardrails (precondition for #1)

**The gap:** The current `gravity-ledger-director` prompt has only one rule about emission discipline ("Emit only what changed in this turn's prose"). The bundle from the 2026-04-28 setup smoke showed:
- Director self-issues "schema drift fix" patch transactions on its own initiative
- Director re-creates an existing principal as a TRACKED duplicate when prose mentions the name (because slug derivation differs from setup's slug)
- Director appends 2-3 `demonstrated_traits` per turn without consolidation

**What's needed in the regular director prompt:**
- "If a character mentioned in the prose already exists in the state view (by name match), use S/MS/A on the existing id; never CR a duplicate."
- "Cap `demonstrated_traits` at ~8 per char; if exceeding, R the oldest before A the new one."
- "Do NOT emit S/A/MS ops to patch transactions emitted in earlier turns. The ledger is append-only and earlier emissions are final."
- "Reserve CR for entities you can verify do not exist."

**User-visible impact:** Same as #1 — over-bloat and inconsistency.

**Estimated scope:** Small — additive prompt edit to `gravity-ledger-director` template. Could ship as a single commit. Useful as a quick win even if #1 is deferred.

**Note:** First-name-lowercase slug convention added to setup prompt in 2026-04-28-gravity-marinara-setup-design.md should reduce duplicate creation likelihood; this prompt rule is the second layer of defense.

## 3. Mode controls (advance / combat / intimacy / integration buttons)

**What ST does:**
- UI buttons in the panel header to switch the chat into `advance` / `combat` / `intimacy` / `integration` mode for one turn
- Each mode has its own **deduction template** injected into the prose model's prompt:
  - `regular` — full 11-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, contest, scene, plan, updates)
  - `combat` — power assessment, advantages, enemy logic, wounds, distance
  - `advance` — focus, what moves, divination, collision tracking
  - `intimacy` — stance, constraint, partner wants, history, divination
- After the mode-specific turn, returns to `regular` automatically (`integration` and one-shot modes specifically)

**What Marinara has:**
- `gravity_chat_state.mode` column in the schema ✓
- Engine-tick already reads `mode` and only runs advance-mode body when `mode === "advance"` ✓
- Mode is set to `"regular"` by setup-agent

**What's missing:**
- UI buttons for the user to set mode for the next turn
- Deduction template injection (the inject agent currently doesn't render a per-mode nudge)
- Auto-revert to `regular` after one-shot modes complete
- Combat-specific entity types (`combat`, possibly `wound` with structure)

**User-visible impact:** Players can't initiate combat sessions, advance turns, or intimacy sessions. The whole "engine of escalation" loop that Gravity is built around is half-disabled.

**Estimated scope:** Medium — UI work + per-mode deduction template port from ST + inject-agent nudge wiring + state-machine update if combat session has its own status ladder. ~1-2 weeks.

## 4. Divination systems

**What ST does:**
- Two random tables: **Arcana** (tarot-flavor) and **Classic** (mundane). I Ching was removed.
- Per turn (or per `advance`/`intimacy` mode), the director rolls a card and injects it as a divination prompt for the prose model — adds controlled randomness/inspiration.
- User can switch between systems or disable via OOC command.
- State stored in `_currentState.divination`.

**What Marinara has:**
- Nothing yet.

**What's missing:**
- Random-table data (Arcana cards, Classic cards) — port from `index.js`
- Divination state on `gravity_chat_state` (active system, last rolled card, history)
- Inject-agent rendering of the divination card per applicable mode
- UI toggle (settings panel or OOC) for system selection

**User-visible impact:** Players who relied on divination for plot direction lose that creative input source. ST users porting their playstyle hit a feature gap.

**Estimated scope:** Small-to-medium. Pure additive. ~1 week or a single sprint of work.

## 5. Setup should use the main chat connection, not the director (agent) connection

**The gap:** `gravity.routes.ts` POST `/setup/:chatId` currently resolves the LLM provider via the gravity-ledger-director agent's connection chain (per-agent connectionId → default-for-agents → chat.connectionId). In practice users configure agent connections to **cheaper/faster** models (Haiku, GPT-4o-mini, Flash) because agents fire on every turn; the **chat connection** is typically a stronger model (Opus, GPT-4, Sonnet) reserved for prose generation. Setup needs to seed the entire opening ledger in one shot — that's a high-stakes, complex-reasoning operation more like prose generation than per-turn agent extraction.

**Why this matters:** Setup runs once per chat. Cost isn't the constraint; quality is. The 2026-04-28 smoke confirmed: with a weaker agent model, the director skipped PC initialization, used the wrong field name on constraints (`character` vs `owner_id`), missed knowledge_asymmetry MS ops entirely, and generated full-name slugs instead of first-name slugs. A stronger model is more likely to follow the now-rewritten prompt's structural requirements first time.

**What to change:**
- `gravity.routes.ts` setup route: invert the resolution chain. Try `chat.connectionId` first; fall back to per-agent connectionId only if the chat has none configured.
- Or: take the chat connection unconditionally for setup (simplest; matches the user's stated intent).
- The director agent config's `promptTemplate` override should still be honored — only the connection/model resolution changes.

**Scope:** Tiny — ~10 lines in the route's connection-resolution block, one commit. Could ship alongside or before the regular-director guardrails (#2).

**Related:** `2026-04-28-gravity-marinara-setup-design.md` §4.3 doesn't pin down the connection source; this clarifies that decision.

## 6. Other deferred items (already known)

These were called out in `2026-04-26-gravity-marinara-embedded-design.md` and aren't included above to avoid duplication:

- **Lorebook activation in setup** (§4.3 of setup spec) — phase-1 setup-agent passes `activatedLorebookEntries: []` and lets the director derive context from the card alone.
- **Branching integration** (§6 of embedded spec, options B/C) — Marinara's chat branching doesn't carry Gravity rows under the new chat_id; the embedded spec deferred this.
- **Phase-2 chat-export integration** (§8) — Phase 1 ships a separate `/api/gravity/export/:chatId`; chat-export integration is phase 2.
- **Garbage collection of pending (unaccepted) transactions** (§6.1 of embedded spec) — phase-1 ships none; manual or scheduled GC is a phase-2/3 concern.

## Suggested ordering

If forced to pick a sequence:

1. **Setup uses main connection (#5)** first — tiny route change, materially improves setup quality immediately, no design work required.
2. **Director over-emission guardrails (#2)** next — small additive prompt commit; reduces bundle bloat going forward.
3. **Mode controls (#3)** — unlocks the gameplay loop (advance/combat/intimacy turns); higher impact than #1 or #4 once the user actually plays.
4. **Ledger maintenance (#1)** — once the user is putting more turns through the system, the bloat becomes acute and maintenance is the obvious next investment.
5. **Divination (#4)** — discrete creative-tool addition whenever it's wanted; doesn't block other work.

Each of #1-#4 is its own spec → plan → implementation cycle, like the setup turn was. #5 is a single-commit fix.
