# Project Memory

Durable working memory for Codex sessions in this repository. Update this file when system behavior, active design decisions, or important constraints change.

## Current State

- Gravity Ledger remains a pure-JS SillyTavern extension with no build step, tests, or CI.
- Validation is still syntax-only: run `node -c` on every modified `.js` file.
- `index.js` remains the central coordinator for injection, turn flow, collision resolution, pressure-point audit, and UI wiring.
- World-story framing now lives in `world.constants.story_kind`; prose voice/tone rules are preset-owned rather than state-view-owned.

## Collision System

- Collision live statuses are now `SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED`.
- `CRASHED`, `MERGED`, and `IMPLODED` are closure outcomes, not live statuses.
- Replay compatibility lives in `state-compute.js`: old collision `status: CRASHED` normalizes to `status: RESOLVED` with `outcome_type: CRASHED`.
- Live collisions are expected to carry narrative substance:
  - `forces`
  - `details`
  - `cost`
  - `target_constraint` when relevant
  - `last_manifestation` once the collision is active in-scene
- Runtime audits now warn on collisions that are missing those fields or whose `details` are too thin.
- Closure audits warn on missing `outcome_type`, `aftermath`, or successor linkage for `EVOLVED` / `MERGED`.
- Simultaneous arrivals use convergence framing with explicit `PARALLEL`, `CASCADE`, or `COMPOSITE` declaration.

## Pressure Point System

- Pressure points still live in `world.pressure_points` as short string seams. They are intentionally seeds, not full entities.
- Pressure points now have append/remove lifecycle history stored in `_history` as `pressure_points[]` events.
- Runtime pressure-point audit expects each seam to be classified as:
  - `KEEP`
  - `REMOVE`
  - `ESCALATE`
- Pressure points should be removed when they:
  - fired
  - became irrelevant
  - were already embodied by a live collision
- Pressure points should escalate into collisions when they have:
  - named actors
  - a concrete cost
  - a looming forced choice
- Prompt state and UI now surface pressure-point age in tx-count terms (`fresh`, `aging`, `stale`).
- Matching a pressure point to a collision is heuristic because pressure points are still plain strings.

## Prompt / UI Notes

- Prompt injection now includes a dedicated pressure-point audit slot in `index.js`.
- Regular-turn state injection now shows collision narrative thread information instead of only name/status/distance.
- Runtime state and setup now use `story_kind` for "what kind of story is this" framing instead of `voice` / `tone` / `tone_rules`.
- Sentence-level prose authority now lives in the preset and lorebook; runtime state stays style-neutral apart from `story_kind` context.
- Saved exemplars are now normalized with inferred category/strength metadata and injected by turn fit rather than simple recency.
- The world UI now shows pressure-point age, likely collision embodiment, last add reason, and append/remove history.
- Collision UI now shows thread, forces, cost, target, manifestation, aftermath, and lineage more clearly.

## Important Files

- `index.js` — runtime orchestration, injections, audits, button flows
- `state-compute.js` — replay logic plus field/array history
- `state-view.js` — prompt state/readme output
- `ui-panel.js` — world/collision inspection UI
- `ooc-handler.js` — eval/history/consolidate prompts
- `setup-wizard.js` — initialization guidance
- `Documentation/collision_pipeline_upgrade_plan.md` — collision design plan and status notes

## Known Limits

- No automated tests; syntax-checking is the only in-repo validation.
- Pressure-point embodiment is heuristic, not identity-based.
- A lot of gameplay discipline still depends on prompt quality and audit prompts rather than hard enforcement.

## Handoff

- Active branch: `codex-v13-state-delta`
- Recent completed work:
  - collision lifecycle normalized around `RESOLVED` + `outcome_type`
  - collision prompt/state/UI upgraded so live collisions carry richer narrative threads
  - pressure points now record append/remove lifecycle history
  - pressure-point audits now push `KEEP / REMOVE / ESCALATE`
  - world UI now shows pressure-point age, likely collision embodiment, and history
  - `AGENTS.md` now points here as the durable project memory file
  - prose ownership moved fully into preset/lorebook guidance while runtime state uses `story_kind`
  - exemplar selection now targets turn mode/technique instead of injecting the last liked passages blindly
  - preset and lorebook prose kernels now enforce camera/rhythm, stronger summary fuel, and mode-specific micro-guidance
- Suggested next focus:
  - improve debug/inspection UX further so users can see why a collision or pressure point exists
  - if more prose styles are added, build style-specific exemplar banks instead of relying on inference alone
  - add user-facing upgrade notes whenever state model changes land
- Reminder:
  - after major behavior changes, update this file in the same commit
  - validate modified JS files with `node -c`

## Update Rule

When major behavior changes land, update this file in the same change if the new behavior would matter to a future Codex session.
