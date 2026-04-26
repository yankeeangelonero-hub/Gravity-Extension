# Extension Runtime Map

## Core Layers

| Layer | Main Files | Responsibility |
|---|---|---|
| Data | `ledger-store.js`, `snapshot-mgr.js` | Append-only storage, snapshot, rollback |
| Compute | `state-compute.js`, `state-machine.js`, `consistency.js` | Replay, documented transitions, format checks |
| Presentation | `state-view.js`, `ui-panel.js`, `regex-intercept.js` | Prompt-facing state, UI, assistant-output interception |
| Runtime orchestration | `index.js`, `setup-wizard.js`, `ooc-handler.js` | Turn flow, injections, setup, buttons, audits |
| Specialized runtime | `memory-tier.js`, `challenge-state.js`, `combat-state.js` | Memory rotation, challenge runtime, combat facade |

## Turn Flow

1. Assistant output arrives.
2. `regex-intercept.js` extracts `---LEDGER---` and other debug/state blocks from a cleaned local copy.
3. `consistency.js` validates ledger line structure.
4. `ledger-store.js` appends accepted transactions to chat metadata.
5. `state-compute.js` replays the ledger into current state.
6. `state-view.js` formats the next `_state` and `_readme` injections.
7. `index.js` assembles runtime injections and trigger keywords.
8. `ui-panel.js` refreshes the visible runtime panel.

## Injection Slots

| Slot | Purpose |
|---|---|
| `_state` | Entity registry, dossiers, and prompt-facing runtime state |
| `_readme` | Command-format reference |
| `_inject` | Corrections and reinforcement prompts |
| `_nudge` | Runtime mode flags and visible-output ordering |
| `_setup` | Setup wizard prompts |
| `_ooc` | OOC command prompts and button-driven instructions |
| `_arrival` | Oracle-driven collision resolution phases |
| `_pressure` | Pressure-point audits |
| `_dist_warn` | Distance-increase corrections |
| `_intimacy` | Intimacy boundary enforcement |
| `_faction` | Periodic faction heartbeat |
| `_dormant` | Dormant-character nudges |
| `_exemplars` | Recent strong prose exemplars |
| `_challenge` | Generic challenge runtime packet, currently used by combat |

`_combat` is legacy-only now; `index.js` clears it when building prompts so old combat packets do not linger beside the generic challenge packet.

## High-Value Update Surfaces

- If `_state` or `_readme` changes, re-check `state-view.js` and update prompt-contract docs.
- If `_nudge` changes, also review preset reasoning docs because the preset depends on the runtime mode flag.
- If lorebook trigger keys change in `index.js`, also update lorebook docs and shared prompt-stack docs.
- If challenge/combat packets change, update the combat runtime reference.

## Use With Other Docs

- Cross-boundary ownership: `Documentation/Shared/prompt_stack.md`
- Preset reasoning handoff: `Documentation/Preset/reasoning_and_prose.md`
- Lorebook trigger map: `Documentation/Lorebook/mode_keys_and_entries.md`
