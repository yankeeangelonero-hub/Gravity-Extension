# Project Memory

Updated: 2026-04-19

Durable working memory for Codex sessions in this repository.

Start system-wide work with:

- `PHASE2-SPEC.md` for the behavior contract
- `Documentation/system_architecture_reference.md` for the code map plus update/review checklist
- `Documentation/project_memory.md` for durable handoff notes

Historical handoffs, roadmaps, plans, and Phase 2 audit/fix logs were moved into `Deprecated/` on 2026-04-19. Treat them as archaeology, not the live contract.

## Current Canonical Docs

- `PHASE2-SPEC.md` - current Phase 2 design contract
- `Documentation/system_architecture_reference.md` - canonical maintenance map and comprehensive review checklist
- `Documentation/project_memory.md` - durable notes for future sessions
- `Documentation/gravity_character_card_template.md` - optional authoring guide for card/scenario/lorebook splits
- `gravity_v15.json` and `Gravity World Info.json` - current preset and mode-playbook authority for prose/reasoning behavior

## Current Product Shape

- Gravity Ledger is still a pure-JS SillyTavern extension with no build step, tests, linting, or CI.
- Validation is still syntax-only. Run `node -c` on every modified `.js` file and parse-check modified JSON files.
- The extension uses an append-only ledger persisted in `chatMetadata`, then replays transactions into computed state each turn.
- `index.js` remains the central orchestrator for turn flow, prompt injection, corrections, arrivals, foreshadowing, nudge rotation, setup, and challenge wiring.
- Active entity families are `char`, `constraint`, `collision`, `combat`, `faction`, `place`, `pressure`, `world`, `pc`, and `divination`.
- Phase 2's live shape is engine-owned collision math, pressure-point economy, arrival sanity checks, flat `knowledge_asymmetry` keys, and a thin combat entity backed by the generic challenge runtime.

## Active Architecture Split

- Storage and history: `ledger-store.js`, `snapshot-mgr.js`
- Replay, normalization, migration: `state-compute.js`
- Parse and validation gate: `regex-intercept.js`, `consistency.js`, `state-machine.js`, `index.js`
- Prompt/state presentation: `state-view.js`, `gravity_v15.json`, `Gravity World Info.json`
- UI/operator surface: `ui-panel.js`
- OOC and setup: `ooc-handler.js`, `setup-wizard.js`
- Challenge runtime: `challenge-state.js`, `combat-state.js`, `challenge-profile-combat.js`, `challenge-input.js`, `challenge-mechanics.js`, `challenge-profiles.js`, `challenge-shared.js`

## Durable Notes

- Prompt/readme drift is a recurring failure mode. When schema or runtime rules change, update the code and the model-facing examples in `state-view.js`, plus any setup/OOC text that teaches the model how to write state.
- Comprehensive reviews should always check parser shape, replay normalization/migration, validation, prompt docs/examples, UI parity, OOC/setup parity, and challenge/runtime parity. The architecture reference now carries that checklist.
- Canonical state lives in `chatMetadata`. Preset and World Info assets are prompt guidance, not the source of truth.
- Yi Jing / I Ching is removed. Divination is Arcana plus Classic only.
- Historical docs now live under `Deprecated/`. Current docs should stay lean and operational.
- Timeskip mode and the timeskip button were removed on 2026-04-29. Advance is the only world-tick path. World Info entry `gravity_mode_timeskip_core` was deleted.
- Divination cards (`relationship.card`, `divination.last_draw`, `divination.card`, `divination.orientation`) are engine-owned. The engine rolls and commits; the LLM cannot author or update these fields directly.
- Per-turn rolling ledger compaction added 2026-04-29: cheap dedup runs every regular/combat/intimacy commit; deep compaction runs alongside the 15-turn auto-snapshot. Compaction is bounded by the oldest retained snapshot's lastTxId so rollback windows remain intact.
- AMEND caveat: AMEND cannot retcon a RESOLVED or CRASHED collision back to ACTIVE. If a resolution was committed in error, use rollback to the pre-resolution snapshot, then re-commit the correct outcome.
- Collision distance constants tuned 2026-04-30: `SHORT=3, MEDIUM=5, LONG=10` (was 10/20/50). Live in `state-compute.js::CATEGORY_DISTANCES`. The readme table in `gravity_v15.json` mirrors these values; keep them in sync.
- Foreshadow simplified to a single trigger per collision 2026-04-30: fires once when distance hits the per-category absolute threshold (`FORESHADOW_DISTANCES = { SHORT: 2, MEDIUM: 3, LONG: 7 }` in `index.js`). Replaces the earlier 3-level percentage system (APPROACHING/IMMINENT/CONVERGING). `_foreshadowedCollisions` is now a flat `Set<id>`.

## Open Constraints

- No repo-native test harness yet.
- Syntax-check modified JS with `node -c`.
- Changes that touch schema or lifecycle usually require synchronized updates in `PHASE2-SPEC.md`, `Documentation/system_architecture_reference.md`, prompt examples, and operator docs.
