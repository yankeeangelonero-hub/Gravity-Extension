# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

Gravity Ledger is a SillyTavern extension (pure JS, no build step) that implements a narrative state machine via an append-only ledger. It tracks characters, constraints, collisions, factions, places, pressure points, and world state through immutable transactions that the LLM outputs inside `---LEDGER---` blocks, which the extension parses, validates, and commits.

## Development

No build system, bundler, or package manager. The extension runs in SillyTavern's browser context.

**Syntax check** (the only validation available):
```bash
node -c index.js
node -c ledger-store.js
# etc. for any changed file
```

There are no tests, no linter, and no CI. Validate changes by syntax-checking modified files.

## Project Memory

Persistent project-state notes live in `Documentation/project_memory.md`.
Use it as the durable handoff file for "what changed and what matters now" between Codex sessions.
Archived notes and superseded plans live in `Documentation/Old/`.

## Architecture

### Three-Layer Design

1. **Data Layer** — `ledger-store.js` stores append-only transactions in `chatMetadata['gravity_ledger']`. `snapshot-mgr.js` handles snapshots/rollback. Transactions are never deleted or overwritten.
2. **Compute Layer** — `state-compute.js` replays all transactions to derive `_currentState`. `state-machine.js` defines valid transitions (documented, not enforced). `consistency.js` validates transaction format only.
3. **Presentation Layer** — `state-view.js` formats state for prompt injection. `ui-panel.js` renders the floating DOM panel. `regex-intercept.js` extracts ledger blocks from LLM output.

### Data Flow (per turn)

```
LLM response → regex-intercept extracts ---LEDGER--- block
  → consistency validates format
  → ledger-store appends transactions
  → state-compute replays → _currentState
  → state-view formats for next injection
  → ui-panel renders updated entities
```

### Self-Correcting Feedback Loop

Failed ledger lines are queued as corrections → injected into next prompt so LLM can fix them → cleared when matched → dropped after `MAX_CORRECTION_ATTEMPTS` (3).

### Injection Modes

All injections use `setExtensionPrompt()` at depth 0 (in-chat, before user message). Injection slots:
- **`_state`** — Entity registry + dossiers (full state view every turn)
- **`_readme`** — Command format reference (core on regular/advance, full on integration)
- **`_inject`** — Corrections + reinforcement prompts
- **`_nudge`** — Runtime flags for hidden reasoning mode plus post-thinking output order (regular/combat/advance/intimacy)
- **`_setup`** — Setup wizard phase prompts (when active)
- **`_ooc`** — OOC command injection (from buttons)
- **`_arrival`** — Collision arrival sanity-check injection (ON-SCREEN / OFF-SCREEN / IMPLODE — §3.5)
- **`_dist_warn`** — Distance-increase error corrections
- **`_intimacy`** — Intimacy stance boundary enforcement
- **`_faction`** — Faction heartbeat (every 10 regular turns)
- **`_dormant`** — Dormant character nudge (every 15 regular turns)
- **`_exemplars`** — Last 5 good prose paragraphs for style reference

Turn modes: `regular` (player prose), `advance` (world moves), `integration` (setup, timeskip).

### Deduction Templates

The preset owns the turn-specific deduction protocols inside its dedicated CoT entry. The extension only injects the active mode flag via `_nudge` so the preset can select the right protocol inside `<think>...</think>`, not in visible prose:
- **`regular`** — Full 11-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, contest, scene, plan, updates)
- **`combat`** — Power assessment, advantages, enemy logic, wounds, distance
- **`advance`** — Focus, what moves, divination, collision tracking
- **`intimacy`** — Stance, constraint, partner wants, history, divination

## Key Conventions

- **Operations**: `CR` (create), `S` (set), `TR` (transition/move), `A` (append), `R` (remove), `MS` (map_set/read), `MR` (map_del), `D` (destroy), `SNAP`, `ROLL`, `AMEND`
- **Entity types**: `char`, `constraint`, `collision`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`
- **State machines** (char tiers, constraint integrity, collision status) are documented in `state-machine.js` and enforced by `validateTransition()` at commit time in `consistency.js`
- **Collision status**: `ACTIVE → RESOLVED` or `ACTIVE → CRASHED`
- **Collision outcomes**: `DIRECT`, `EVOLVED`, `MERGED`, `IMPLODED`, `DISSOLVED`, `CRASHED`
- **Story framing**: sentence-level prose and story identity belong in preset files, lorebook entries, and the scenario/card context rather than runtime state
- **Active setup-authored world constants**: `world.constants.power_scale`, `world.constants.power_ceiling`, and optional `world.constants.power_notes` are the live setup-authored combat constants; older framing fields such as `story_kind`, `guidelines`, `motivation`, `objective`, `length`, and `knowledge_asymmetry` are deprecated
- **Knowledge asymmetry**: model it through `reads`, `noticed_details`, summaries, and collisions rather than `world.knowledge_asymmetry`; there is no universal `blindspots` field
- **Knowledge gaps**: `pc.knowledge_gaps` is referenced by `OOC: eval` guidance but is not a fully surfaced runtime feature yet
- **Arrival decision gate**: When a collision hits distance 0 (category IMMEDIATE arrives on creation; others on engine tick-down), the extension injects a single-turn sanity-check block asking the LLM to commit ON-SCREEN, OFF-SCREEN (REFRAME or DISSOLVE), or IMPLODE — all resolutions complete that turn. Tracked via `_firedCollisionArrivals` Set in `index.js`.
- **Pressure points**: first-class `pressure` entities (capped at 5, FIFO) — raw narrative seeds consumed by collision feeding. Create with `CR pressure:<id> name="..." source="..."`, destroy when consumed with `D pressure:<id>`. WEEKS/MONTHS timeskips auto-clear all pressure points.
- **Format validation only**: `consistency.js` checks structure, not gameplay rules
- **OOC commands** in `ooc-handler.js`: `power review`, `snapshot`, `rollback`, `eval`, `history`, `consolidate`, etc. — these inject contextual prompts, they don't modify state directly
- **Storage**: All canonical state lives in `chatMetadata` (persisted per chat by SillyTavern). Optional mode playbooks may live in importable World Info files such as `Gravity World Info.json`, but those entries are prompt guidance only; the extension remains the source of truth for state.

## Branch Context

- `combat` — Combat system features (power, power_base, power_basis, abilities, wounds, combat collisions)
- `prose` — Prose/narrative quality features
- `main` — Stable releases
- `preset-migration` — Three-layer injection architecture work

## Important Patterns

- The extension imports SillyTavern globals (e.g., `getContext`, `setExtensionPrompt`, `saveMetadataDebounced`) from the ST environment — these are not local dependencies.
- `index.js` is the central coordinator (~1,500 lines). It wires all modules together and handles the turn lifecycle.
- `gravity-system-prompt.md` is a legacy reference for the ledger command format. Current presets live in `gravity_v13_c.json` and `gravity_v14.json`, while mode-specific playbooks can be imported from `Gravity World Info.json`. The extension injects runtime state, readmes, nudges, and mode triggers via `setExtensionPrompt()`.
- `Documentation/project_memory.md` is the active durable memory file. Archived docs and older planning artifacts live in `Documentation/Old/`.
- `Documentation/v14_prose_architecture_handoff.md` captures the modular prose rollout that moved prose authority into `gravity_v14.json` plus `Gravity World Info.json`.
- Divination uses two random tables (Arcana/Classic) defined in `index.js`. Yi Jing (I Ching) has been removed.
