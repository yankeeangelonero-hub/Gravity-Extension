# Combat Runtime Handoff

Date: 2026-04-03 00:25:06 +08:00

## What Landed

This pass completed the combat runtime rework that had still been pending after the earlier power-doctrine migration.

## Addendum - Challenge Engine Follow-Up

The combat runtime described below has since been migrated onto the generic
challenge engine.

Current live interpretation:
- `combat-state.js` is now a compatibility facade over `challenge-state.js`
- prompt packets are now `CHALLENGE_INPUT`, `CHALLENGE_MECHANICS`, and `CHALLENGE_TASK`
- combat setup is now split into `setup_opening` and `setup_buffered`
- the extension auto-seeds the active `combat:*` entity and the model should not create it again
- stored combat options now carry ids plus `option_table_version`
- duplicate `create combat:<active-id>` lines are rewritten into updates before commit
- custom threshold mode now works through the generic challenge settings path

Use this handoff for the broad combat-loop history, but use
[combat_runtime_reference.md](/D:/claude/Gravity%20Preset/Gravity-Extension/Documentation/combat_runtime_reference.md)
for the current live runtime contract.

## Follow-Up Fixes Landed After This Handoff

Several important combat-runtime fixes landed after the initial runtime commit. Treat these as part of the current live behavior:

- Setup-phase combat actions are buffered correctly. If the player commits before the combat entity exists, `_combat` now says to finish setup and then resolve the buffered action instead of restarting setup.
- Low combat rolls are now framed as `TRANSFORM`, not plain failure. Natural 1 outcomes are now `CRITICAL_TRANSFORM`.
- Combat setup no longer inherits the generic divination `NARRATIVE_FORCING` block. The spawn draw is re-framed as encounter illumination: circumstance, leverage, visibility, spacing, terrain truth, and why the options sit at their assessed categories.
- Combat resolution now explicitly injects the mechanical result as a fixed line. The prompt says only the `d20` is compared to the live success threshold and the draw is interpretive only.
- Combat difficulty is now framed as extension-owned success thresholds rather than prompt-side bare DCs. `_combat` injects the live thresholds and the action threshold directly.
- `ui-panel.js` now exposes combat difficulty in two places:
  - the Combat section
  - the top command bar with a live threshold summary

Implemented:

- `combat` is now a first-class entity type in validation and replay.
- New runtime module: `combat-state.js`
- Dedicated `_combat` injection slot in `index.js`
- Runtime phases:
  - `setup`
  - `awaiting_choice`
  - `awaiting_resolution`
  - `awaiting_reassessment`
  - `cleanup_grace`
- Player combat input parsing:
  - `combat: ` starts or routes combat from the player input bar
  - `combat:<n>` picks a numbered option
  - `combat: <freeform action> DC <category>` declares a custom action with a chosen category
  - freeform `combat: <action>` without a category becomes assessment-only instead of resolving immediately
- Baseline math now uses current effective `power`, never narrative `tier`
- Middle categories roll `d20` plus a fresh draw in the extension
- `Absolute` / `Impossible` use explicit no-roll payloads
- Cleanup grace behavior after `RESOLVED` is implemented
- Combat panel section plus difficulty-mode controls are now live in `ui-panel.js`

## File Map

- `combat-state.js`
  Owns chat-metadata runtime state, option parsing, baseline/DC logic, roll payloads, prompt building, and post-assistant combat state transitions.
- `index.js`
  Imports the combat runtime, injects `_combat`, routes combat button behavior, parses combat user input before generic OOC handling, processes assistant combat turns, and clears combat runtime on new/import/revert paths.
- `ui-panel.js`
  Adds a dedicated Combat section and difficulty controls (`Cinematic`, `Gritty`, `Heroic`, `Survival`, `Custom`).
- `state-view.js`
  Surfaces `combat:*` entities in state injection and readme/reference docs.
- `state-machine.js`
  Adds the simple combat lifecycle machine `ACTIVE -> RESOLVED`.
- `Gravity World Info.json`
  Combat mode now explicitly teaches setup/resolution/reassessment/cleanup beats plus required option output.
- `gravity_v14.json`
  Combat CoT now checks phase, category, roll/no-roll state, options, and cleanup requirements.

## Runtime Behavior

### Start

- Pressing the combat button now inserts `combat: ` into the input box.
- The extension draws a spawn divination result and stores it in runtime state.
- The `_combat` prompt instructs the model to create `combat:<runtime id>` and stop on the opening situation with 3-4 clickable numbered combat options.

### Resolution Loop

- Clicked options and typed `combat:<n>` resolve immediately from the stored option list.
- Explicit custom actions written as `combat: <freeform action> DC <category>` resolve immediately unless the declared category is too generous versus baseline.
- Too-generous custom actions move to `awaiting_reassessment` and preserve the rolled `d20` and draw.
- Freeform uncategorized `combat: <action>` text is treated as an assessment-only action; the model must turn it into explicit options before resolution.

### Cleanup

- If the model writes `combat.status = RESOLVED` and destroys the combat entity the same turn, runtime clears immediately.
- If it resolves without `D combat:*`, runtime enters `cleanup_grace` for one committed turn.
- After that grace turn, runtime clears even if the combat entity still exists.
- Cleanup prompts tell the model to persist lasting wounds, timeline fallout, relationship changes, and any temp-enemy cleanup before destroying combat.

## Known Limits / Risks

- The runtime does not yet auto-detect newly created combats that originate entirely from collision or advance turns without using the combat button first. The handoff plan envisioned that auto-detection path; this pass implemented the active combat loop once runtime exists.
- The panel shows combat runtime and difficulty state, but there is still no dedicated manual cleanup tool for orphaned `combat:*` entities if the model leaves one behind after grace expiration.
- Hard-counter 2-step exceptions are still intentionally not mechanized. If the matchup truly changed, the model should express that through changed combat state and present the easier option honestly.
- This was syntax-checked and JSON-checked only. It was not live-tested in a real SillyTavern session yet.

## Validation Performed

- `node -c combat-state.js`
- `node -c index.js`
- `node -c ui-panel.js`
- `node -c state-view.js`
- `node -c state-machine.js`
- PowerShell JSON parse check for:
  - `Gravity World Info.json`
  - `gravity_v14.json`

## Recommended Next Live Test

1. Start a new combat from the Combat button and confirm setup creates `combat:*` plus 3-4 clickable numbered options.
2. Click an option and verify the next turn resolves one exchange and offers fresh options.
3. Type `combat: finish him DC Absolute` and `combat: jump the wall DC Impossible` to confirm no-roll paths.
4. Type an obviously too-generous custom category and confirm reassessment preserves the stored roll.
5. Resolve combat without `D combat:*` once and confirm `cleanup_grace` clears runtime on the following committed turn.
