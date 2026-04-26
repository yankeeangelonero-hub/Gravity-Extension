# New Session Start

Use this file when you need the fastest safe orientation to Gravity.

Read `Documentation/README.md` first at the beginning of every new session. This file is the second step and routes you from the hub into the right component docs.

## Minimal Read Order

1. Read `Documentation/README.md`.
2. Read `AGENTS.md`.
3. Read `Documentation/project_memory.md`.
4. Read the relevant component hub:
   - extension/runtime work -> `Documentation/Extension/README.md`
   - preset/reasoning/prose work -> `Documentation/Preset/README.md`
   - lorebook / World Info work -> `Documentation/Lorebook/README.md`
   - cross-boundary prompt work -> `Documentation/Shared/README.md`
5. Read the owning source files.
6. Read handoffs only if the stable docs do not answer the question.

## Task-Based Routing

| If the task is about... | Read next | Then inspect |
|---|---|---|
| Ledger parsing, state replay, prompt injection, UI, chat metadata | `Documentation/Extension/README.md` | `index.js`, `state-view.js`, `state-compute.js`, related JS modules |
| Hidden reasoning, prompt order, prose layers, preset voice | `Documentation/Preset/README.md` | `gravity_v14.json` |
| Mode playbooks, prose WI entries, trigger keys, entry order | `Documentation/Lorebook/README.md` | `Gravity World Info.json` |
| Ownership boundaries between extension, preset, and lorebook | `Documentation/Shared/prompt_stack.md` | `index.js`, `gravity_v14.json`, `Gravity World Info.json` together |
| Historical rollout context or a recent investigation | `Documentation/Handoffs/README.md` | The relevant handoff file |

## Source-of-Truth Rule

When there is tension between docs, trust them in this order:

1. Active code and active JSON assets
2. `Documentation/project_memory.md`
3. Stable component docs
4. Handoffs
5. Archive

## Update Expectation

If you change live behavior, update `Documentation/project_memory.md` and the relevant component doc in the same change.
