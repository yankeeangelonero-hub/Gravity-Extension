# Lorebook Docs

The lorebook owns World Info entries that the extension triggers at runtime. It is prompt guidance, not canonical state.

## Read This When

- You are editing `Gravity World Info.json`.
- You are adding or renaming mode keys.
- You are changing mode-specific prose guidance or optional examples.
- You are deciding whether behavior belongs in the lorebook or the preset.

## Primary Source File

| File | Role |
|---|---|
| `Gravity World Info.json` | Active World Info / lorebook file |

## Stable Docs In This Folder

- `mode_keys_and_entries.md` - live key map, grouping, and update rules

## Boundary Rules

- The lorebook owns mode-specific World Info entries and prose modulation.
- The lorebook does not own canonical state. Runtime truth still lives in extension-managed chat metadata.
- The preset owns always-on prose and hidden reasoning scaffolding.
- The extension owns trigger routing and decides which keys are fired on a given turn.

## Update When

- A World Info key changes.
- A new mode entry or optional example entry is added.
- Entry order changes in a way that matters to prompt assembly.
- Prose modulation moves between lorebook and preset.
