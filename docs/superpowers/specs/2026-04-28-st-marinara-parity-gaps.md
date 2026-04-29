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

> **Inject-agent baseline (verified against `inject-agent.ts` 2026-04-29):** the current inject renders exactly two things — `cache.stateView` and `buildNudge(mode, state)` — concatenated with a blank line between them. It does *not* render persona, character cards, lorebook entries, deduction templates, foreshadow nudges, or arrival sanity-checks. Several gaps below add slots to this rendering; sizing each gap should account for the fact that the inject pipeline is currently a two-line concatenation, not a slotted template.

**What's missing:**
- The rotating-schedule pick-a-check-this-turn logic in inject
- FIFO cap on pressures
- `demonstrated_traits` cap + maintenance nudge
- Knowledge-asymmetry auto-prune
- State-view filter for resolved/crashed collisions — **owned by #6d below**, not duplicated here
- OOC commands (note: ST's OOC surface spans more than maintenance — mode toggling overlaps #3, divination toggle overlaps #4, history dump is its own concern. Track OOC-command parity per owning gap, not exclusively under #1)

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

**Dependency on #5 — re-evaluate before finalizing:** the bug list above was captured on the 2026-04-28 smoke under the *weaker agent connection*. After #5 ships (chat connection → stronger model), re-run the setup smoke before writing this prompt edit. Some of these regressions (skipped PC init, wrong field name, full-name slugs, duplicate principals) may stop recurring without prompt-side guardrails, in which case the guardrails for them shouldn't be written at all. Finalize #2's prompt against the post-#5 failure set, not the pre-#5 one.

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

**Estimated scope:** Medium-large — four sub-streams:
- UI buttons + Marinara panel/store integration (no precedent in the work shipped so far; `gravity.store.ts` exists but panel-header button wiring hasn't been touched yet)
- Per-mode deduction template ports from ST `index.js`
- Inject-agent nudge wiring (extends the bare two-line render in #1's baseline note)
- Combat-mode state-machine extension (combat sessions, wounds, distance-in-combat)

Realistically 2-3 weeks of focused work, or split into sub-specs per stream so each can ship independently.

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
- `gravity.routes.ts` setup route (lines 159-166 today): use `chat.connectionId` *unconditionally* for setup, and hard-error if it's unset. Rationale: a chat without a connection can't generate prose either, so an unset chat connection is a misconfigured state, not a fallback case worth supporting. Simpler than a fallback chain and matches user intent that setup is prose-grade work.
- The director agent config's `promptTemplate` override should still be honored — only the connection/model resolution changes.

**Scope:** Tiny — ~10 lines in the route's connection-resolution block, one commit. Ship *before* #2 so the regular-director guardrails can be written against the post-#5 failure set (see #2's "Dependency on #5" note).

**Related:** `2026-04-28-gravity-marinara-setup-design.md` §4.3 doesn't pin down the connection source; this clarifies that decision. Cross-references the first-name-lowercase slug convention in #2's note — both are setup-quality levers and should be evaluated together when re-running the smoke.

## 6. Collision-system engine of escalation (the heart of Gravity)

> **Updated 2026-04-30:** §6b (arrival gate) and §6c (foreshadow) below are *superseded* by `2026-04-30-collision-surfacing-protocol.md`, which replaces single-turn arrival forcing with a four-phase advance-turn machine (conclude / tick / surface / foreshadow). §6d (state-view filter) ships as part of that protocol. §6a (tick never fires) and §6e (combat subtype) remain in this tracker — both depend on mode controls (#3) rather than the surfacing protocol. The text below is preserved for history; for current direction read the surfacing spec.

**The gap:** The schema for collisions is wired (entities, projection, state-machine transitions), and `engine-tick.ts` ports ST's tick logic — but **nothing drives it through the play loop**. A user setting up a chat gets collisions seeded into state and they sit there frozen. You can't sense the engine because the engine isn't running.

Sub-pieces:

- **6a. Tick never fires.** `engineTick` is gated on `mode === "advance"`. Setup sets `regular`. No UI to flip into `advance` (subset of #3 mode controls). Distances are frozen at director-set values forever.

- **6b. Arrival decision gate not consumed.** When tick fires and a collision hits distance 0, `engineTick` pushes the id into `newArrivalIds`. director-agent.ts forwards it on the AgentResult. **Nothing in inject-agent.ts reads it back to fire the ON-SCREEN / OFF-SCREEN (REFRAME or DISSOLVE) / IMPLODE single-turn sanity-check.** ST tracks fired arrivals in `_firedCollisionArrivals` Set and injects via `_arrival` slot. Not ported.

- **6c. Foreshadow nudge missing.** ST's `_foreshadow` slot ("approaching/imminent/converging collision foreshadow nudge") fires building-pressure cues as collisions close in. Not ported.

- **6d. Resolved/crashed collisions clutter state-view.** No filter in state-view.ts. (Subset of #1 maintenance.)

- **6e. Combat collisions are a distinct subtype.** Power assessments, advantages, wounds, distance-in-combat all missing. (Subset of #3 mode controls.)

**Why this matters:** Gravity is named for collisions. The pitch is "narrative state machine that tracks pressures and forces them to converge." Without the engine of escalation, the system stores collisions but never makes them happen — collisions become free-form prose tags, indistinguishable from any other tracker. The whole loop loses its teeth.

**What to build (consolidated):**
- Wire `newArrivalIds` from director-agent's AgentResult into a one-shot inject the next turn (mirrors ST's `_arrival` slot). Persist fired arrivals as a JSON-array `text` column on `gravity_chat_state` (e.g., `firedArrivalIds`, parsed/serialized at the engine boundary) so the gate fires once per arrival *and survives server restarts* — ST's in-memory `Set` is fine for a single-page session but Marinara is server-side, and a process restart mid-chat would otherwise re-fire arrivals.
- Port the foreshadow check (read distances from state, inject `_foreshadow` text **on band transition only** — i.e., when a collision crosses *into* SHORT or MEDIUM, not every turn while it's at that band). Track `lastForeshadowedDistance` (or `lastForeshadowedBand`) per collision to gate the trigger; without this discipline, foreshadow becomes spam every advance turn.
- State-view filter for `RESOLVED` and `CRASHED` collisions — keep them in transactions for replay; hide from prompt. (This is the canonical home for the filter; #1 references it but doesn't re-implement.)
- Mode controls (#3) so users can actually run advance turns.

**Estimated scope:** Medium-large. Arrival gate + foreshadow are 1 sub-spec; state-view filter overlaps with #1 maintenance; full combat-collision subtype is its own thing. Probably 2-3 weeks across the bits.

**Dependencies:** Mostly orthogonal to #1-#5. Arrival gate needs a `firedArrivalIds` field on `gravity_chat_state` (small migration) and inject-agent rewrite to consume `newArrivalIds`. Foreshadow is purely additive in the inject agent. Both can ship before #1 / #3 are complete.

## 7. Other deferred items (already known)

These were called out in `2026-04-26-gravity-marinara-embedded-design.md` and aren't included above to avoid duplication:

- **Lorebook activation in setup** (§4.3 of setup spec) — phase-1 setup-agent passes `activatedLorebookEntries: []` and lets the director derive context from the card alone.
- **Branching integration** (§6 of embedded spec, options B/C) — Marinara's chat branching doesn't carry Gravity rows under the new chat_id; the embedded spec deferred this.
- **Phase-2 chat-export integration** (§8) — Phase 1 ships a separate `/api/gravity/export/:chatId`; chat-export integration is phase 2.
- **Garbage collection of pending (unaccepted) transactions** (§6.1 of embedded spec) — phase-1 ships none; manual or scheduled GC is a phase-2/3 concern.
- **Cross-agent self-correction loop** — ST's inject agent emits corrective nudges in response to malformed director output (slug drift, schema-violation patches, etc.). Phase-1 Marinara ships only the maintenance-style nudges captured under #1; the broader pattern of inject *reading the prior turn's director result and recovering from it* is not a phase-1 commitment. Re-evaluate after #1 ships.

## Suggested ordering

If forced to pick a sequence (this resolves the #6 ↔ #3 entanglement by splitting #6 into a mode-independent slice and a tick-reachable slice):

1. **Setup uses main connection (#5)** — tiny route change, materially improves setup quality immediately, no design work required.
2. **Re-run setup smoke** — capture which #2 regressions persist under the stronger model. This step *belongs to #5's verification*, not a separate spec.
3. **Arrival gate + foreshadow (#6's mode-independent slice — #6b + #6c)** — these are inject-agent additions independent of mode UI. Highest narrative-impact-per-week ratio. Can be developed and shipped without #3.
4. **Director over-emission guardrails (#2, finalized post-smoke)** — write the prompt edit against the post-#5 failure set, not the pre-#5 one.
5. **Mode controls (#3)** — unlocks advance/combat/intimacy turns *and* makes the tick part of #6 reachable end-to-end.
6. **Tick-reachable behavior verification (#6's remaining slice — #6a, plus the resolved/crashed state-view filter #6d)** — confirm tick → arrival gate → foreshadow chain works in a real advance-mode session.
7. **Ledger maintenance (#1)** — once turn volume grows, the bloat becomes acute. References #6d's filter as already-shipped; doesn't re-implement.
8. **Combat-collision subtype (#6e)** — folds into #3's combat-mode work or ships as a follow-up sub-spec.
9. **Divination (#4)** — discrete creative-tool addition; orthogonal to all the above.

Each of #1-#4 and #6 is its own spec → plan → implementation cycle, like the setup turn was. #5 is a single-commit fix; the post-#5 smoke step is part of #5's verification, not a separate spec.

**Parallel-safe pairings** (can be developed concurrently on sibling branches off `gravity-integration`):
- #4 (divination) and #5 (setup connection) — disjoint code paths.
- #6's mode-independent slice (#6b + #6c) and #4 — both touch inject-agent but in non-overlapping places (arrival/foreshadow slots vs. divination slot); coordinate at merge.

**Must serialize:**
- #1 (maintenance) and #3 (mode controls) — both rewrite inject-agent's render path significantly.
- #2 must wait for #5's smoke re-run before its prompt is finalized.

## Validation pattern

Every gap above ships with: TS unit tests on the engine helpers it adds, placed under `packages/server/test/*.test.ts` (the existing `tsx --test` location used by tests like `lorebook-processing.test.ts`, `game-session-prompts.test.ts`, etc. — not co-located `*.test.ts` next to source); and a documented smoke-test scenario (chat configuration + expected director output) saved alongside the implementation, modeled on the 2026-04-28 setup-turn smoke. Re-run the relevant smoke before merging to `gravity-integration`. `pnpm check` is the baseline gate; `pnpm test` runs the unit suite; smokes are the feature-correctness gate.
