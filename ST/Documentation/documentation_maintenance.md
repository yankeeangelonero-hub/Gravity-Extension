# Documentation Maintenance

This file defines how Gravity docs stay modular, low-drift, and easy for future LLM sessions to navigate.

For the quick operational guide on how to read, update, and expand the docs, start with `Documentation/README.md`.

## Documentation Types

| Type | Path | Purpose | Lifetime |
|---|---|---|---|
| Durable memory | `Documentation/project_memory.md` | What changed and what matters now | Long-lived |
| Session start | `Documentation/session_start.md` | Fast onboarding for a new session | Long-lived |
| Component hubs | `Documentation/Extension/`, `Documentation/Preset/`, `Documentation/Lorebook/`, `Documentation/Shared/` | Stable ownership maps and current contracts | Long-lived |
| Topical references | Component subdirectory reference docs | Deeper explanations of live systems | Medium-to-long-lived |
| Handoffs | `Documentation/Handoffs/` | Rollout notes, investigations, live-test findings | Short-to-medium-lived |
| Templates | `Documentation/Templates/` | Reusable writing structures | Long-lived |
| Archive | `Documentation/Old/` | Superseded material | Historical only |

## Update Matrix

| If you change... | Update these docs |
|---|---|
| Extension runtime flow, injection slots, state/view contract, OOC behavior, combat/challenge runtime | `Documentation/project_memory.md`, `Documentation/Extension/README.md`, `Documentation/Extension/runtime_map.md`, `Documentation/Shared/prompt_stack.md` |
| Preset reasoning wrapper, prompt order, prose kernel, style layers, voice layers | `Documentation/project_memory.md`, `Documentation/Preset/README.md`, `Documentation/Preset/reasoning_and_prose.md`, `Documentation/Shared/prompt_stack.md` |
| Lorebook keys, mode playbooks, prose WI entries, entry ordering | `Documentation/project_memory.md`, `Documentation/Lorebook/README.md`, `Documentation/Lorebook/mode_keys_and_entries.md`, `Documentation/Shared/prompt_stack.md` |
| Cross-component ownership boundaries | `Documentation/project_memory.md`, `Documentation/Shared/README.md`, `Documentation/Shared/prompt_stack.md` |
| A one-off investigation or rollout | Add or update a file in `Documentation/Handoffs/`, then fold lasting conclusions into the stable docs |
| Reusable authoring guidance | Add or update a file in `Documentation/Templates/` and link it from the relevant component hub |

## Naming Rules

- Keep stable docs on predictable names such as `README.md`, `runtime_map.md`, or `reasoning_and_prose.md`.
- Use handoff names like `handoff_YYYY-MM-DD_HHMMSS_TZ_topic.md` when creating new ones.
- Avoid adding new free-floating docs in `Documentation/` root unless they are stable entry points used by every session.

## Writing Rules

- Record accepted, current behavior in component hubs and `project_memory.md`.
- Record experiments, rollout notes, and unresolved questions in handoffs or `Plan/`.
- Prefer one owner doc per topic. Add links to deeper references instead of cloning the same content into multiple places.
- If a handoff's decisions are still important after the feature stabilizes, summarize them into the stable docs and then archive or de-emphasize the handoff.

## New Session Goal

A future coding session should be able to answer three questions quickly:

1. What is live right now?
2. Which component owns this behavior?
3. Which file and doc should I update if I change it?
