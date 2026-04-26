# Prompt Stack Contract

This file defines who owns what across the extension, preset, and lorebook.

## Ownership Map

| Concern | Owner | Main File | Notes |
|---|---|---|---|
| Runtime state and canonical truth | Extension | `index.js`, `state-compute.js`, `state-view.js` | Lives in chat metadata and derived state |
| Ledger parsing and validation | Extension | `regex-intercept.js`, `consistency.js`, `ledger-store.js` | Format validation only |
| Prompt injection packets and mode flags | Extension | `index.js` | Includes `_state`, `_readme`, `_nudge`, `_challenge`, and other slots |
| Hidden reasoning wrapper | Preset | `gravity_v14.json` | `| Gravity CoT` owns the `<think>...</think>` contract |
| Always-on prose floor and voice | Preset | `gravity_v14.json` | Prose kernel, style layer, character voice, dossier-driven prose |
| Mode-specific prose modulation | Lorebook | `Gravity World Info.json` | `gravity_prose_*` entries |
| Mode-specific gameplay playbooks | Lorebook | `Gravity World Info.json` | `gravity_mode_*` entries |
| Lorebook trigger routing | Extension | `index.js` | Extension decides which keys fire on each turn |

## Per-Turn Contract

1. The extension assembles runtime state and command guidance.
2. The extension injects the active reasoning mode and visible-output ordering.
3. The preset opens hidden reasoning and selects the matching mode protocol.
4. The extension's fired keywords activate the matching lorebook entries.
5. Visible prose follows the preset's always-on voice plus the active lorebook mode layer.
6. Runtime state changes are committed only through the extension path.

## Keep These Boundaries Clean

- Do not move canonical runtime state into lorebook entries.
- Do not make the extension own the hidden reasoning wrapper again unless there is a deliberate architecture shift.
- Do not duplicate mode-specific prose length guidance in both preset and lorebook.
- If a prompt rule has to exist in more than one layer, document why that duplication is intentional.

## Required Sync Points

| Change | Also Review |
|---|---|
| `_nudge` or runtime reason mode flags | `Documentation/Preset/reasoning_and_prose.md` |
| Lorebook trigger keys in `index.js` | `Documentation/Lorebook/mode_keys_and_entries.md` |
| Preset reasoning wrapper | `Documentation/Preset/deduction_cot_architecture.md` |
| Prose ownership split | `Documentation/Preset/v14_prose_architecture_handoff.md` and `Documentation/Lorebook/README.md` |

## Update Rule

If you change the prompt-stack boundary, update this file in the same change.
