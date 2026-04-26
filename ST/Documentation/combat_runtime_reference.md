# Combat Runtime Reference

Updated: 2026-04-03

This document describes the live combat runtime after the challenge-engine migration.

## Purpose

Combat now runs on the generic challenge engine.

The extension owns:
- combat lock state
- setup/opening state
- input parsing
- stored options
- success thresholds
- `d20` rolls
- draw payloads
- fixed result labels
- post-turn validation
- cleanup grace

The model owns:
- encounter judgment
- option writing
- tactical narration
- consequence writing
- ledger/state updates

## Runtime Shape

The live runtime is stored in:

```text
chatMetadata['gravity_challenge_runtime']
```

Combat still uses a durable `combat:*` entity as the tactical container.

Important fields:
- `locked`
- `kind = combat`
- `entity_type = combat`
- `entity_id`
- `phase`
- `exchange`
- `scene_draw`
- `scene_draw_active`
- `options`
- `option_table_version`
- `pending_action`
- `pending_roll`
- `last_input`
- `last_resolution`

## Player Input

The player-facing flow is still `combat:`.

Supported input:
- `combat:`
  Starts combat if none is active, or re-enters the active combat lock.
- `combat:2`
  Picks stored option 2.
- `2`
  Also picks stored option 2 while combat is locked.
- `combat: hold center ground DC Average`
  Declares a categorized custom action.
- `combat: hold center ground`
  Declares an uncategorized action. This becomes assessment-first, not immediate resolution.
- plain freeform text while combat is locked
  Also routes as combat input, even without the prefix.

Important fallback rule:
- no declared category means assess-first, not resolve-first
- the model should judge the move and turn it into options
- option 1 should capture the player's intended action with the model's assessed category
- the extension should only roll once the action is categorized and chosen

## Packets

Combat now uses the generic challenge packets:
- `[CHALLENGE_INPUT]`
- `[CHALLENGE_MECHANICS]`
- `[CHALLENGE_TASK]`

These are the canonical extension-owned facts.

Important packet behavior:
- the model should trust `CHALLENGE_INPUT` instead of reparsing the raw player message
- the model should trust `RESULT` when `SUCCESS_DECIDED_BY_EXTENSION` or `RESOLUTION_LOCKED` is true
- the model should obey `MUST_*` task flags instead of improvising around prose

## Entity Seeding

The extension auto-seeds the active `combat:*` container.

That means:
- the model should not `create combat:<active-id>` again
- setup turns should fill or update the seeded entity
- if the model tries to recreate the active combat container anyway, the extension now rewrites that duplicate `create` into field updates before commit

Recommended combat container style:
- short `participants`
- short `hostiles`
- short `primary_enemy`
- short `terrain`
- short `situation`
- short `threat`

Identity, power doctrine, and richer capability detail belong on `pc` and `char:*`, not duplicated into the combat container every turn.

## Phases

Combat now uses these phases:
- `setup_opening`
- `setup_buffered`
- `awaiting_choice`
- `awaiting_resolution`
- `awaiting_reassessment`
- `cleanup_grace`

### `setup_opening`

- the entity already exists
- the model establishes the opening
- the model outputs 3-4 options
- no exchange resolves yet

### `setup_buffered`

- the player acted before setup fully finished
- the entity already exists
- the model finishes setup and then:
  - assesses the buffered move into options, or
  - resolves the buffered move immediately if the extension already fixed the roll

### `awaiting_choice`

- the engine is waiting for an option pick or custom action

### `awaiting_resolution`

- the engine already has a fully parsed action
- if applicable, the engine already fixed the roll and result

### `awaiting_reassessment`

- the player declared a category that was too generous
- the stored roll is preserved
- the model must challenge the category before resolution continues

### `cleanup_grace`

- combat resolved
- the model gets one committed turn to finish fallout and destroy the combat entity
- the runtime then clears even if the entity still remains in state

## Difficulty and Thresholds

Combat thresholds are extension-owned.

Modes:
- `Cinematic`
- `Gritty`
- `Heroic`
- `Survival`
- `Custom`

Default thresholds:
- `Cinematic`: `Highly likely 3+`, `Average 7+`, `Highly unlikely 12+`
- `Gritty`: `Highly likely 8+`, `Average 12+`, `Highly unlikely 16+`
- `Heroic`: `Highly likely 2+`, `Average 5+`, `Highly unlikely 10+`
- `Survival`: `Highly likely 10+`, `Average 14+`, `Highly unlikely 18+`

Custom thresholds now work through challenge settings instead of silently falling back to the default table.

## Baseline Logic

Combat baseline uses current effective `power`, not narrative `tier`.

Rules:
- `+2 or more` gap: `Absolute`
- `+1` gap: `Highly likely`
- `0` gap: `Average`
- `-1` gap: `Highly unlikely`
- `-2 or less` gap: `Impossible`

Baseline uses:
- `power`

Not:
- `power_base`
- cast-tracking `tier`

## Option Storage

Stored options now carry stable ids plus a table version.

Internal shape:

```js
{ id, index, category, intent, label, table_version }
```

Recommended id format:

```text
opt-e{exchange}-v{option_table_version}-{index}
```

Numbers are still the user-facing UX, but the runtime now has a stronger internal handle for the option table.

## Roll Contract

Only the extension decides the mechanical result.

For rolled actions, the extension injects:
- effective category
- threshold
- `d20`
- draw
- fixed result

Current result labels:
- `SUCCESS`
- `TRANSFORM`
- `CRITICAL_SUCCESS`
- `CRITICAL_TRANSFORM`

Rules:
- `Absolute` is auto-success
- `Impossible` is auto-fail
- only the middle three categories roll
- only the `d20` is compared to the threshold
- the draw is interpretive only

## Draw Semantics

### Scene draw

The scene draw is setup-only.

Use it for:
- encounter circumstance
- leverage
- spacing
- visibility
- exposure
- terrain truth
- why the opening options sit at their categories

Do not use it for:
- later exchanges after setup ends
- forced surprise twists
- replacing combat math

The engine now keeps `scene_draw_active = true` only through setup and expires it when setup successfully exits into live exchange play.

### Result draw

The result draw colors the already-fixed exchange result.

Interpretation:
- `SUCCESS`: colors how success lands
- `TRANSFORM`: defines the changed reality created by the missed threshold
- `CRITICAL_SUCCESS`: amplifies the gain
- `CRITICAL_TRANSFORM`: defines the catastrophic transformation

## Failure Handling

The runtime now validates combat turns more aggressively.

Important safety rails:
- if locked input cannot be resolved to a stored option, the runtime records the failed input instead of leaving stale `CHALLENGE_INPUT`
- if setup output contains options but the entity is still missing, those options are preserved instead of being dropped
- if a required rolled setup action was not actually consumed, the runtime keeps it pending and reinjects a correction
- duplicate `create combat:<active-id>` lines are rewritten before commit so the seeded entity is not overwritten

## Cleanup

Preferred path:
- write persistent fallout to `pc` / `char:*`
- destroy temporary combat-only enemies if needed
- `D combat:*`

If the model resolves combat without destroying the entity:
- runtime enters `cleanup_grace`
- the model gets one more committed turn to finish cleanup
- runtime then clears even if the combat entity remains

This means orphaned `combat:*` entities are still possible, but they no longer keep the user trapped in combat mode.

## UI Notes

The panel now shows combat state in two places:
- top command bar
  combat difficulty selector plus live threshold summary
- Combat section
  active runtime details, baseline, pending action, roll state, and thresholds

## Related Files

- [challenge-state.js](/D:/claude/Gravity%20Preset/Gravity-Extension/challenge-state.js)
- [challenge-profile-combat.js](/D:/claude/Gravity%20Preset/Gravity-Extension/challenge-profile-combat.js)
- [combat-state.js](/D:/claude/Gravity%20Preset/Gravity-Extension/combat-state.js)
- [index.js](/D:/claude/Gravity%20Preset/Gravity-Extension/index.js)
- [ui-panel.js](/D:/claude/Gravity%20Preset/Gravity-Extension/ui-panel.js)
- [gravity_v14.json](/D:/claude/Gravity%20Preset/Gravity-Extension/gravity_v14.json)
- [Gravity World Info.json](/D:/claude/Gravity%20Preset/Gravity-Extension/Gravity%20World%20Info.json)
- [combat-system-handoff.md](/D:/claude/Gravity%20Preset/Gravity-Extension/Plan/combat-system-handoff.md)
- [challenge-engine-implementation-spec.md](/D:/claude/Gravity%20Preset/Gravity-Extension/Plan/challenge-engine-implementation-spec.md)
