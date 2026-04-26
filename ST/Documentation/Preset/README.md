# Preset Docs

The preset owns hidden reasoning structure, prompt order, always-on prose guidance, style selection, character-voice framing, and dossier-driven prose behavior.

## Read This When

- You are editing `gravity_v14.json`.
- You are changing the CoT wrapper or reasoning protocol selection.
- You are changing always-on prose behavior, style layers, or voice layers.
- You need to know what belongs in the preset instead of the extension or lorebook.

## Primary Source Files

| File | Role |
|---|---|
| `gravity_v14.json` | Active preset |
| `gravity_v13_c.json` | Earlier preset generation, useful as a historical comparison |
| `gravity_v13_c_split.json` | Intermediate split preset artifact |
| `Gravity_v11.json` | Older reference for earlier state-machine expectations |
| `gravity-system-prompt.md` | Legacy ledger-format reference, not the active runtime source |

## Stable Docs In This Folder

- `reasoning_and_prose.md` - current ownership and active preset layers
- `deduction_cot_architecture.md` - detailed hidden-reasoning handoff
- `v14_prose_architecture_handoff.md` - prose modularization rollout notes

## Boundary Rules

- The preset owns the hidden reasoning wrapper and always-on prose layers.
- The extension only injects runtime state, command references, mode flags, and trigger keywords.
- The lorebook owns mode-specific playbooks and per-mode prose modulation.
- If a change crosses those boundaries, update `Documentation/Shared/prompt_stack.md`.

## Update When

- Prompt order changes.
- `| Gravity CoT` changes.
- A different prose style becomes the default.
- `| Character Voice`, `| Dossier-Driven Prose`, or the prose kernel changes meaning.
- Behavior moves between preset and lorebook or between preset and extension.
