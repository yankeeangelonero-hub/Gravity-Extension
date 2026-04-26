# Preset Reasoning And Prose

## Active Preset

- Active file: `gravity_v14.json`
- Historical references: `gravity_v13_c.json`, `gravity_v13_c_split.json`, `Gravity_v11.json`

## Current Active Layers

| Entry | Status | Responsibility |
|---|---|---|
| `| Gravity CoT` | enabled | Hidden reasoning wrapper and mode-specific protocol selection |
| `| L2 - Gravity Kernel` | enabled | Core Gravity behavior and narrative contract |
| `| L3 - Prose Kernel` | enabled | Always-on prose quality floor |
| `| Character Voice` | enabled | Vocabulary, syntax, and stress filtering from dossier context |
| `| Dossier-Driven Prose (layer)` | enabled | Turns dossier fields into scene behavior and observation |
| `Group 5 style selection` | active style: `Noir Realist` | Aesthetic register only |
| `| Gravity - Anchor` | disabled | Legacy overlap, not currently active |
| `| CoT Triggers (Gem/Claude)` | disabled | Legacy helper path, not current truth |

## Ownership Rules

- The preset owns the `<think>...</think>` wrapper and the rule that deduction happens there, not in visible prose.
- The preset reads `GRAVITY_REASON_MODE` from extension `_nudge` and selects the matching built-in protocol.
- The preset should not re-own runtime state, ledger parsing, or lorebook trigger routing.
- Mode-specific prose technique and length live in the lorebook, not in the preset.

## Current Live Contract

1. `| Gravity CoT` asks for strategic analysis before visible output.
2. The model reads the extension-provided runtime mode flag.
3. The preset selects the matching mode protocol inside hidden reasoning.
4. Hidden reasoning closes before visible prose begins.
5. Visible prose then follows the active preset prose style plus any active mode lorebook entry.

## Change Triggers

Update this doc, `Documentation/project_memory.md`, and `Documentation/Shared/prompt_stack.md` when:

- hidden reasoning order changes
- the active preset file changes
- prose ownership shifts between preset and lorebook
- the default prose style changes
- a disabled legacy entry becomes active again
