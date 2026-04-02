# Combat Runtime Handoff

Date: 2026-04-03 00:25:06 +08:00

## What Landed

This pass completed the combat runtime rework that had still been pending after the earlier power-doctrine migration.

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
  - `combat: option | <index> | <category> | <intent>`
  - `option <n>`
  - `combat: custom | <category> | <intent>`
  - freeform combat prose during active combat becomes assessment-only instead of resolving immediately
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

- Pressing the combat button with no active combat now creates combat runtime state and inserts `*<pc> prepares to fight.*`
- The extension draws a spawn divination result and stores it in runtime state.
- The `_combat` prompt instructs the model to create `combat:<runtime id>` and stop on the opening situation with 3-4 clickable combat options.

### Resolution Loop

- Clicked options and typed `option N` resolve immediately from the stored option list.
- Explicit custom actions with categories resolve immediately unless the declared category is too generous versus baseline.
- Too-generous custom actions move to `awaiting_reassessment` and preserve the rolled `d20` and draw.
- Freeform uncategorized combat text is treated as an assessment-only action; the model must turn it into explicit options before resolution.

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

1. Start a new combat from the Combat button and confirm setup creates `combat:*` plus 3-4 clickable options.
2. Click an option and verify the next turn resolves one exchange and offers fresh options.
3. Type `combat: custom | Absolute | ...` and `combat: custom | Impossible | ...` to confirm no-roll paths.
4. Type an obviously too-generous custom category and confirm reassessment preserves the stored roll.
5. Resolve combat without `D combat:*` once and confirm `cleanup_grace` clears runtime on the following committed turn.
