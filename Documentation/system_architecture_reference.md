# Gravity Ledger System Architecture Reference

Updated: 2026-04-19

This is the canonical maintenance map for Gravity Ledger.

Use it for:

- system-wide updates
- comprehensive implementation reviews
- audit prep against `PHASE2-SPEC.md`
- catching prompt/UI/docs drift when mechanics change

Read this alongside `PHASE2-SPEC.md`, not instead of it.

## Canonical Sources Of Truth

1. `PHASE2-SPEC.md`
   Behavioral contract and Phase 2 design intent.
2. `Documentation/system_architecture_reference.md`
   Code map, ownership map, and review checklist.
3. `Documentation/project_memory.md`
   Durable short-form handoff notes.
4. `gravity_v15.json` and `Gravity World Info.json`
   Active preset and mode-playbook prompt assets.

Historical handoffs, plans, and audit logs live under `Deprecated/`.

## Repo Map

### Runtime Core

- `index.js`
  Main orchestrator: turn lifecycle, prompt injection, arrival/foreshadow pipeline, corrections, nudge rotation, setup wiring, challenge integration, commit path.
- `ledger-store.js`
  Append-only ledger persistence in `chatMetadata['gravity_ledger']`.
- `snapshot-mgr.js`
  Snapshots, rollback, rollback listeners, computed-state reconstruction.

### Parsing And Validation

- `regex-intercept.js`
  Extracts `---LEDGER---` and `---STATE---`, parses lines, compiles compact state entries.
- `consistency.js`
  Transaction shape validation and transition validation gate.
- `state-machine.js`
  Allowed transitions for governed fields.

### Replay And State Model

- `state-compute.js`
  `createEmptyState()`, `applyTransaction()`, replay normalization, migrations, travel validation helpers, history tracking.

### Prompt And Presentation Layer

- `state-view.js`
  Prompt-facing state view, quick reference, full readme, archive rendering.
- `ui-panel.js`
  Extension operator panel, tab views, dossiers, collision display, challenge controls.
- `style.css`
  Panel styling.

### OOC And Setup

- `ooc-handler.js`
  `OOC:` command handling and eval/history/power-review injections.
- `setup-wizard.js`
  Guided setup prompts and authored opening state guidance.

### Challenge Runtime

- `challenge-state.js`
  Generic challenge runtime orchestrator.
- `combat-state.js`
  Backward-compatible combat facade over the generic challenge runtime.
- `challenge-profile-combat.js`
  Combat profile: prompt contract, validation, setup/resolution guidance.
- `challenge-input.js`
  Player challenge input parsing.
- `challenge-mechanics.js`
  Categories, threshold math, roll payload shaping.
- `challenge-profiles.js`
  Profile registry.
- `challenge-shared.js`
  Shared helper functions.

### Prompt Assets

- `gravity_v15.json`
  Active preset authority for prose kernel, reasoning wrapper, and style behavior.
- `Gravity World Info.json`
  Mode playbooks and prose entries fired by injected keys.

## End-To-End Runtime Shape

### Normal Turn

1. Player input sets mode in `index.js`.
2. Prompt slots are injected with state, readme, nudges, OOC/setup/challenge content.
3. Assistant responds with prose plus `---STATE---` or `---LEDGER---`.
4. `regex-intercept.js` extracts and parses the block.
5. `index.js` compiles compact state entries into transactions.
6. `consistency.js` validates format and governed transitions.
7. `ledger-store.js` appends valid transactions.
8. `state-compute.js` replays into fresh `_currentState`.
9. `index.js` runs post-commit audits, challenge updates, arrival triggers, nudge updates.
10. `state-view.js` and `ui-panel.js` render the updated state back into prompt/UI surfaces.

### Advance Turn

Advance turns follow the same parse/commit path, then:

1. `world.timeskip_scale` is read from committed state.
2. `index.js::applyAdvanceTick()` decrements collision clocks.
3. WEEKS/MONTHS pressure cleanup runs.
4. Arrivals, foreshadowing, archive handling, and collision-health nudges run.

### Challenge Turn

While a challenge is locked:

1. Input is routed through `challenge-input.js` and `challenge-state.js`.
2. Runtime state lives in chat metadata, not the ledger.
3. Durable outcomes still write through the normal ledger path.
4. Prompt surfaces are injected through `_challenge` and related state/readme slots.

## State Model

### Canonical Collections

| Entity type | State key | Primary files |
| --- | --- | --- |
| `char` | `state.characters` | `state-compute.js`, `state-view.js`, `ui-panel.js`, `setup-wizard.js`, `ooc-handler.js` |
| `constraint` | `state.constraints` | `state-compute.js`, `state-machine.js`, `state-view.js`, `ui-panel.js` |
| `collision` | `state.collisions` | `state-compute.js`, `state-machine.js`, `index.js`, `state-view.js`, `ui-panel.js`, `ooc-handler.js` |
| `combat` | `state.combats` | `state-compute.js`, `challenge-state.js`, `combat-state.js`, `challenge-profile-combat.js`, `state-view.js`, `ui-panel.js` |
| `faction` | `state.factions` | `state-compute.js`, `state-view.js`, `ui-panel.js`, `setup-wizard.js` |
| `place` | `state.places` | `state-compute.js`, `state-view.js`, `ui-panel.js`, `setup-wizard.js` |
| `pressure` | `state.pressures` | `state-compute.js`, `index.js`, `state-view.js`, `ui-panel.js`, `setup-wizard.js` |
| `world` | `state.world` | `state-compute.js`, `index.js`, `state-view.js`, `ooc-handler.js` |
| `pc` | `state.pc` | `state-compute.js`, `state-view.js`, `ui-panel.js`, `setup-wizard.js`, `ooc-handler.js` |
| `divination` | `state.divination` | `state-compute.js`, `index.js`, `state-view.js` |

## Prompt Injection Slots

All prompt slots are injected by `index.js` with `setExtensionPrompt()` at depth 0.

Primary slots to keep in sync when mechanics change:

- `_state`
- `_readme`
- `_inject`
- `_nudge`
- `_setup`
- `_ooc`
- `_arrival`
- `_foreshadow`
- `_challenge`
- `_combat`
- `_faction`
- `_dormant`
- `_exemplars`

Any change to lifecycle or schema should be checked for both runtime behavior and prompt wording in these surfaces.

## What To Update When You Change A Subsystem

### 1. Entity Schema Changes

If you add, remove, rename, or reshape an entity field, inspect all of:

- `PHASE2-SPEC.md`
- `state-compute.js`
  - `createEmptyState()`
  - `applyTransaction()`
  - replay normalization or migrations
- `regex-intercept.js`
  - scalar/array parsing
  - compact STATE path handling
- `consistency.js`
  - shape guards or engine-owned-field rejection
- `state-machine.js`
  - if the field is transition-governed
- `index.js`
  - compile/validation path
  - any post-commit audits
- `state-view.js`
  - registry/detail rendering
  - quick reference examples
  - full readme examples
- `ui-panel.js`
- `setup-wizard.js`
- `ooc-handler.js`
- `Documentation/project_memory.md`

### 2. Collision Mechanics Changes

Always inspect:

- `PHASE2-SPEC.md`
- `index.js`
  - advance tick
  - arrival builder
  - foreshadowing
  - collision-health/consolidation nudges
  - archive correction logic
- `state-compute.js`
  - collision defaults
  - engine-owned fields
- `state-machine.js`
- `state-view.js`
  - collision display
  - readme language
  - archive injection
- `ui-panel.js`
- `ooc-handler.js`

### 3. Knowledge-Asymmetry Changes

Always inspect:

- `PHASE2-SPEC.md`
- `state-compute.js`
  - normalization
  - migration
  - cap enforcement
- `regex-intercept.js`
  - dotted path handling versus flat-key handling
- `state-view.js`
  - examples and renderers
- `ui-panel.js`
- `setup-wizard.js`
- `ooc-handler.js`
- any challenge/profile prompt that teaches character perception or secrets

### 4. Prompt Contract Changes

If you change what the model is told to emit or how turns are framed, inspect:

- `state-view.js`
- `gravity_v15.json`
- `Gravity World Info.json`
- `index.js`
  - slot wiring
  - mode selection
- `setup-wizard.js`
- `ooc-handler.js`
- `challenge-profile-combat.js`

### 5. Challenge Or Combat Changes

Always inspect:

- `challenge-state.js`
- `combat-state.js`
- `challenge-profile-combat.js`
- `challenge-input.js`
- `challenge-mechanics.js`
- `state-compute.js`
- `state-view.js`
- `ui-panel.js`
- `ooc-handler.js`
- `PHASE2-SPEC.md`

### 6. Setup Or OOC Changes

Always inspect:

- `setup-wizard.js`
- `ooc-handler.js`
- `state-view.js`
- `index.js`
- `Documentation/project_memory.md`

### Relationship Distance & Intensity (2026-04-23)

Relationships now carry two type-neutral axes alongside card/orientation/nuance:
- **distance** (5 values): `fresh | forming | established | deep | core` — how developed the bond is
- **intensity** (4 values): `cold | simmering | active | electric` — how charged the current connection is

Both are required on CR. Both are captured in `last_shift.from` and `last_shift.to` (which now have shape `{card, orientation, distance, intensity}`). Legacy relationships missing these fields trigger a `[missing-stage:<relId>]` correction, which prompts the LLM to SET them on the next turn.

Files:
- `consistency.js` — `RELATIONSHIP_DISTANCES`, `RELATIONSHIP_INTENSITIES` enums; extended `isValidCardObj` and `validateRelationshipTx`
- `state-view.js` — `formatRelationshipStage` helper, appended to 3 bond-line sites
- `ui-panel.js` — `gl-relationship-stage` row in `renderCharDossier`
- `index.js` — missing-stage correction loop + expanded missing-relationship / missing-rel-update correction text

## Comprehensive Review Checklist

Use this when evaluating implementation against the spec.

### Parser And Compile Surface

- Does `regex-intercept.js` parse every shape the readme teaches?
- Are arrays, booleans, nulls, numbers, and flat keys compiled into the right transaction shapes?
- Does compact STATE syntax support every entity/path the readme advertises?
- Are forbidden forms truly rejected, not merely documented as rejected?

### Replay And Migration

- Does `state-compute.js` create the correct empty-state shape?
- Do legacy migrations still land in the current canonical schema?
- Are engine-owned defaults set during replay?
- Are caps and auto-trims enforced on replay as well as live commits?

### Validation And Engine Ownership

- Are governed fields blocked when written through the wrong operation?
- Are engine-owned fields rejected before commit, not corrected after mutation?
- Does travel validation see the right turn mode and working state?

### Prompt Surface

- Do quick-reference and full-readme examples match the real parser and schema?
- Do setup, OOC, nudge, and challenge prompts teach the same shapes as the readme?
- Are historical fields or retired mechanics still mentioned anywhere?

### UI Surface

- Does `ui-panel.js` render the same authoritative fields the prompt uses?
- Are terminal collisions shown consistently across registry/detail/eval views?
- Does the panel rely on legacy fields that should now be derived from newer ones?

### OOC And Operator Paths

- Does `OOC: eval` reflect current terminal states and maintenance rules?
- Do power review, wound handling, rollback, and history paths use current schema?

### Challenge Runtime

- Does the challenge profile enforce only the fields the spec still wants persisted?
- Does setup/resolution guidance match the thin combat contract?
- Are challenge runtime packets and validation in sync with prompt assets?

### Documentation Hygiene

- Does `PHASE2-SPEC.md` still describe the current live design?
- Does `Documentation/project_memory.md` still point to the right active docs?
- Were any historical one-off docs accidentally left in the active documentation set?

## Quick Audit Starting Set

For a full-system review, inspect at least:

- `PHASE2-SPEC.md`
- `index.js`
- `regex-intercept.js`
- `consistency.js`
- `state-machine.js`
- `state-compute.js`
- `state-view.js`
- `ui-panel.js`
- `ooc-handler.js`
- `setup-wizard.js`
- `challenge-state.js`
- `challenge-profile-combat.js`
- `gravity_v15.json`
- `Gravity World Info.json`
- `Documentation/project_memory.md`

## Validation Routine

There is no automated test suite yet.

Minimum validation after code changes:

```bash
node -c index.js
node -c state-compute.js
node -c state-view.js
node -c consistency.js
node -c regex-intercept.js
node -c ooc-handler.js
node -c setup-wizard.js
node -c challenge-state.js
node -c challenge-profile-combat.js
node -c ui-panel.js
```

Run the subset that matches the files you changed.
