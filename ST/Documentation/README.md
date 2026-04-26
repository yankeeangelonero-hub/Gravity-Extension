# Gravity Documentation Hub

This directory is organized around stable entry points for future coding sessions.

Every new Codex session should open this file first before reading anything else in `Documentation/`.

## Start Here

Read in this order when you are new to the repo:

1. `README.md` (this file)
2. `session_start.md`
3. `project_memory.md`
4. One or more component hubs:
   - `Extension/README.md`
   - `Preset/README.md`
   - `Lorebook/README.md`
   - `Shared/README.md`

## How To Read The Docs

Use this route based on the task:

| If you need to... | Read first | Then read |
|---|---|---|
| Understand the repo quickly in a new session | `Documentation/session_start.md` | `Documentation/project_memory.md` |
| Change JS runtime behavior | `Documentation/Extension/README.md` | `Documentation/Extension/runtime_map.md` |
| Change hidden reasoning or always-on prose | `Documentation/Preset/README.md` | `Documentation/Preset/reasoning_and_prose.md` |
| Change World Info keys or mode playbooks | `Documentation/Lorebook/README.md` | `Documentation/Lorebook/mode_keys_and_entries.md` |
| Change ownership between extension, preset, and lorebook | `Documentation/Shared/README.md` | `Documentation/Shared/prompt_stack.md` |
| Understand an active rollout or investigation | `Documentation/Handoffs/README.md` | the relevant handoff file |

When in doubt, read:

1. `Documentation/session_start.md`
2. `Documentation/project_memory.md`
3. the owning component `README.md`
4. the live source files
5. handoffs only if the stable docs are not enough

## Source-of-Truth Order

Use this precedence when docs disagree:

1. Live code and active JSON assets
2. `Documentation/project_memory.md`
3. Stable component docs in this directory
4. Topical reference docs and handoffs
5. `Documentation/Old/`

## Directory Map

| Path | Purpose | Notes |
|---|---|---|
| `Documentation/session_start.md` | Fast onboarding path for a new coding session | Shortest safe read order |
| `Documentation/project_memory.md` | Durable session memory | Update when live behavior changes |
| `Documentation/documentation_maintenance.md` | Rules for keeping docs modular and current | Use before adding new docs |
| `Documentation/Extension/` | Runtime extension architecture, state, and injection docs | JS-side ownership |
| `Documentation/Preset/` | Active preset structure, reasoning, and prose docs | `gravity_v14.json` ownership |
| `Documentation/Lorebook/` | World Info / lorebook structure and key map | `Gravity World Info.json` ownership |
| `Documentation/Shared/` | Cross-component ownership and prompt-stack contracts | Use for extension/preset/lorebook boundary work |
| `Documentation/Handoffs/` | Time-bound investigations and rollout notes | Fold lasting decisions back into stable docs |
| `Documentation/Templates/` | Reusable authoring templates | Card and handoff templates live here |
| `Documentation/Old/` | Archived or superseded docs | Do not treat as current truth without verification |

## Working Rules

- Keep `Documentation/project_memory.md` as the durable memory anchor.
- Prefer updating an existing component hub over adding a new loose Markdown file.
- Put time-boxed investigations, experiments, or rollout notes in `Documentation/Handoffs/`.
- Put reusable formats in `Documentation/Templates/`.
- Treat any remaining free-floating topical docs in `Documentation/` root as older holdovers; new work should go into the structured folders.
- Move superseded docs to `Documentation/Old/` once their lasting decisions have been folded into stable docs.

## How To Update The Docs

When you change live behavior:

1. Update the code or active JSON asset first.
2. Update `Documentation/project_memory.md` in the same change if the behavior matters to future sessions.
3. Update the owning component doc:
   - extension change -> `Documentation/Extension/`
   - preset change -> `Documentation/Preset/`
   - lorebook change -> `Documentation/Lorebook/`
   - boundary/ownership change -> `Documentation/Shared/prompt_stack.md`
4. If the change is still provisional, add or update a handoff in `Documentation/Handoffs/`.
5. If the onboarding path changed, update `Documentation/session_start.md` and this file.

Use `Documentation/documentation_maintenance.md` as the detailed update matrix.

## How To Expand The Docs

Add new documentation by intent, not by convenience:

| If the new doc is... | Put it here | Why |
|---|---|---|
| Stable guidance for one component | the matching component folder | Keeps ownership clear |
| A cross-component contract | `Documentation/Shared/` | Prevents duplicated truth |
| A rollout note, experiment, or investigation | `Documentation/Handoffs/` | Keeps temporary notes out of the stable path |
| A reusable template | `Documentation/Templates/` | Makes repeatable formats easy to find |
| Superseded material | `Documentation/Old/` | Preserves history without polluting current truth |

Before creating a new file:

1. Check whether an existing component `README.md` or reference doc can absorb the change.
2. If you need a new stable topic, add it under the owning folder and link it from that folder's `README.md`.
3. Only add a new file at `Documentation/` root if it is a repo-wide entry point used by most future sessions.
4. If you introduce a new stable entry point, add it to `Documentation/session_start.md` and this file.

## LLM-Friendly Writing Rules

- Put the current truth near the top.
- State which component owns the behavior.
- Link to the exact source file or JSON asset.
- Use short sections, tables, and explicit update triggers.
- Avoid mixing stable contracts with temporary rollout notes in the same file.

## Current Living References

- Extension runtime map: `Documentation/Extension/runtime_map.md`
- Preset reasoning and prose: `Documentation/Preset/reasoning_and_prose.md`
- Lorebook mode keys and entries: `Documentation/Lorebook/mode_keys_and_entries.md`
- Cross-component ownership: `Documentation/Shared/prompt_stack.md`
