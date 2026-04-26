# Extension Docs

The extension owns runtime state, ledger parsing and commit flow, prompt injection, UI behavior, and chat-metadata persistence.

## Read This When

- You are changing JavaScript runtime behavior.
- You are changing any injection slot or prompt packet the extension emits.
- You are changing state replay, validation, snapshots, combat/challenge runtime, setup, or OOC behavior.
- You need to understand what the extension, not the preset or lorebook, is responsible for.

## Primary Source Files

| File | Role |
|---|---|
| `index.js` | Main runtime coordinator, turn flow, injections, buttons, audits, resolution clocks |
| `ledger-store.js` | Append-only transaction storage in chat metadata |
| `snapshot-mgr.js` | Snapshot and rollback support |
| `state-compute.js` | Replays ledger into current state |
| `state-view.js` | Formats prompt-facing state and readme output |
| `regex-intercept.js` | Extracts and cleans ledger/state blocks from assistant output |
| `consistency.js` | Format validation only |
| `ui-panel.js` | Floating panel and runtime controls |
| `setup-wizard.js` | Setup-authoring flow |
| `ooc-handler.js` | OOC command prompt injections |
| `memory-tier.js` | Hot/cold memory rotation |
| `challenge-state.js` and helpers | Generic challenge engine |
| `combat-state.js` | Combat facade and compatibility surface |

## Stable Docs In This Folder

- `runtime_map.md` - high-level runtime map, injection slots, and update surfaces
- `combat_runtime_reference.md` - current combat/challenge runtime behavior
- `knowledge_asymmetry_system_handoff.md` - current intel and asymmetry behavior

## Boundary Rules

- The extension owns runtime truth and prompt injections.
- The preset owns the hidden reasoning wrapper and always-on prose layers.
- The lorebook owns mode-specific World Info entries and prose modulation.
- If a change crosses those boundaries, update `Documentation/Shared/prompt_stack.md`.

## Update When

- A new injection slot is added or an existing slot changes meaning.
- State fields or prompt-facing state formatting change.
- Runtime ownership moves between extension and prompt assets.
- A live feature like combat, setup, memory tiering, or OOC flows changes behavior.
