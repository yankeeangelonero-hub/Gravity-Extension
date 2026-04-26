# Shared Docs

These docs cover the contracts between the extension, the preset, and the lorebook.

## Start Here

- `prompt_stack.md` - the current ownership split and cross-component update map

## Read This When

- A change spans runtime injections and prompt assets.
- You are deciding whether a rule belongs in the extension, preset, or lorebook.
- You need to update more than one component without creating duplicated instructions.

## Update When

- Ownership of a feature moves between layers.
- A runtime flag, preset contract, or lorebook trigger changes meaning.
- A component starts duplicating responsibilities that should live somewhere else.
