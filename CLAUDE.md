# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Gravity Ledger is a SillyTavern extension (pure JS, no build step) that implements a narrative state machine via an append-only ledger. It tracks characters, constraints, collisions, chapters, factions, and world state through immutable transactions that the LLM outputs inside `---LEDGER---` blocks, which the extension parses, validates, and commits.

## Development

No build system, bundler, or package manager. The extension runs in SillyTavern's browser context.

**Syntax check** (the only validation available):
```bash
node -c index.js
node -c ledger-store.js
# etc. for any changed file
```

There are no tests, no linter, and no CI. Validate changes by syntax-checking modified files.

## Architecture

### Three-Layer Design

1. **Data Layer** - `ledger-store.js` stores append-only transactions in `chatMetadata['gravity_ledger']`. `snapshot-mgr.js` handles snapshots/rollback. Transactions are never deleted or overwritten.
2. **Compute Layer** - `state-compute.js` replays all transactions to derive `_currentState`. `state-machine.js` defines valid transitions (documented, not enforced). `consistency.js` validates transaction format only.
3. **Presentation Layer** - `state-view.js` formats state for prompt injection. `ui-panel.js` renders the floating DOM panel. `regex-intercept.js` extracts ledger blocks from LLM output.

### Data Flow (per turn)

```
LLM response -> regex-intercept extracts ---LEDGER--- block
  -> consistency validates format
  -> ledger-store appends transactions
  -> state-compute replays -> _currentState
  -> state-view formats for next injection
  -> ui-panel renders updated entities
```

### Self-Correcting Feedback Loop

Failed ledger lines are queued as corrections -> injected into next prompt so LLM can fix them -> cleared when matched -> dropped after `MAX_CORRECTION_ATTEMPTS` (3).

### Injection Modes

All injections use `setExtensionPrompt()` at depth 0 (in-chat, before user message). Injection slots:
- **`_state`** - Entity registry + dossiers (full state view every turn)
- **`_readme`** - Command format reference (core on regular/advance, full on integration)
- **`_inject`** - Corrections + reinforcement prompts
- **`_nudge`** - Turn format with deduction template (regular/combat/advance/intimacy)
- **`_setup`** - Setup wizard phase prompts (when active)
- **`_ooc`** - OOC command injection (from buttons)
- **`_arrival`** - Oracle-driven collision resolution (arrival, escalation, crash - all phases)
- **`_dist_warn`** - Distance-increase error corrections
- **`_intimacy`** - Intimacy stance boundary enforcement
- **`_faction`** - Faction heartbeat (every 10 regular turns)
- **`_dormant`** - Dormant character nudge (every 15 regular turns)
- **`_exemplars`** - Last 5 good prose paragraphs for style reference

Turn modes: `regular` (player prose), `advance` (world moves), `integration` (setup, chapter close, timeskip).

### Deduction Templates

The extension injects turn-specific deduction templates via the `_nudge` slot:
- **`regular`** - Full 13-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, tone, contest, scene, plan, updates, chapter)
- **`combat`** - Power assessment, advantages, enemy logic, wounds, distance
- **`advance`** - Focus, what moves, divination, collision tracking
- **`intimacy`** - Stance, constraint, partner wants, history, divination

### Memory Tiering

`memory-tier.js` rotates hot arrays (`story_summary`, `pc.timeline`, `pc.demonstrated_traits`) to cold storage in `chatMetadata['gravity_cold']` when caps are exceeded. Consolidated batch summaries are injected alongside hot entries.

## Key Conventions

- **Operations**: `CR` (create), `S` (set), `TR` (transition/move), `A` (append), `R` (remove), `MS` (map_set/read), `MR` (map_del), `D` (destroy), `SNAP`, `ROLL`, `AMEND`
- **Entity types**: `char`, `constraint`, `collision`, `chapter`, `faction`, `world`, `pc`, `divination`, `summary`
- **State machines** (char tiers, constraint integrity, collision status, chapter status) are documented in `state-machine.js` and the v11 preset but not enforced by code - the LLM follows and self-audits via `OOC: eval`
- **Collision status**: `SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED` or `-> CRASHED` (player ignored it, gravity resolved it - worst outcome)
- **Oracle-driven resolution**: When a collision hits distance 0, the extension starts a resolution clock with divination draws at each phase: atmosphere (turns 1-2), direct intrusion with fresh draw (turns 3-4), crash with final draw (turn 5+). Tracked via `_resolutionTracker` Map in `index.js`.
- **Format validation only**: `consistency.js` checks structure, not gameplay rules
- **OOC commands** in `ooc-handler.js`: `power review`, `snapshot`, `rollback`, `eval`, `history`, `consolidate`, etc. - these inject contextual prompts, they don't modify state directly
- **Storage**: All canonical state lives in `chatMetadata` (persisted per chat by SillyTavern). Optional mode playbooks may live in importable World Info files such as `Gravity World Info.json`, but those entries are prompt guidance only; the extension remains the source of truth for state.

## Branch Context

- `combat` - Combat system features (power, power_base, power_basis, abilities, wounds, combat collisions)
- `prose` - Prose/narrative quality features
- `main` - Stable releases
- `preset-migration` - Three-layer injection architecture work

## Important Patterns

- The extension imports SillyTavern globals (e.g., `getContext`, `setExtensionPrompt`, `saveMetadataDebounced`) from the ST environment - these are not local dependencies.
- `index.js` is the central coordinator (~1,500 lines). It wires all modules together and handles the turn lifecycle.
- `gravity-system-prompt.md` is a legacy reference for the ledger command format. Current presets live in `gravity_v13_c.json` and `gravity_v14.json`, while mode-specific playbooks can be imported from `Gravity World Info.json`. The extension injects runtime state, readmes, nudges, and mode triggers via `setExtensionPrompt()`.
- Divination uses random tables (Arcana/Classic/I-Ching) defined in `index.js`.
