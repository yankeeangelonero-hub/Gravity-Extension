# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

There is no linter and no CI. The relationship module has a test harness at `scripts/test-relationship.js` — run with `node scripts/test-relationship.js` when touching relationship code. For all other files, validate with `node -c`.

## Project Docs

- Use `Documentation/system_architecture_reference.md` as the canonical code map and update/review checklist.
- Use `Documentation/project_memory.md` as the durable session handoff file.
- Current active docs live at the top of `Documentation/`.
- Historical handoffs, plans, audits, and superseded references live under `Deprecated/`.

## Architecture

### Three-Layer Design

1. **Data Layer** - `ledger-store.js` stores append-only transactions in `chatMetadata['gravity_ledger']`. `snapshot-mgr.js` handles snapshots/rollback. Transactions are never deleted or overwritten.
2. **Compute Layer** - `state-compute.js` replays all transactions to derive `_currentState`. `state-machine.js` defines valid transitions and exposes `validateTransition()`, which `index.js` calls at commit time. `consistency.js` validates transaction shape only.
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
- **`_nudge`** - Active deduction-mode flag (regular/combat/advance/intimacy)
- **`_nudge_maintenance`** - Array-size hygiene warnings (pressure/collision/etc. over cap)
- **`_setup`** - Setup wizard phase prompts (when active)
- **`_ooc`** - OOC command injection (from buttons)
- **`_arrival`** - Collision arrival sanity-check (ON-SCREEN / OFF-SCREEN / IMPLODE — §3.5)
- **`_dist_warn`** - Distance-increase error corrections
- **`_foreshadow`** - Approaching/imminent/converging collision foreshadow nudge
- **`_intimacy`** - (Phase 2: retained slot, now unused — cleared every turn; boundary lives in prose + knowledge_asymmetry)
- **`_challenge`** - Challenge-session mechanics + task block (when a challenge is locked)
- **`_combat`** - Legacy combat-mode injection
- **`_faction`** - Faction heartbeat (every 10 regular turns)
- **`_dormant`** - Dormant character nudge (every 15 regular turns)
- **`_exemplars`** - Last 5 good prose paragraphs for style reference

Turn modes: `regular` (player prose), `advance` (world moves), `integration` (setup, timeskip).

### Deduction Templates

The extension injects turn-specific deduction templates via the `_nudge` slot:
- **`regular`** - Full 11-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, contest, scene, plan, updates)
- **`combat`** - Power assessment, advantages, enemy logic, wounds, distance
- **`advance`** - Focus, what moves, divination, collision tracking
- **`intimacy`** - Stance, constraint, partner wants, history, divination

### Scope

Gravity is a **collision engine + character ledger**. It does NOT track narrative summary or story recap — those are the responsibility of a companion SillyTavern memory extension (Summarize, Vectors, or similar). Users running Gravity without a memory extension will lose narrative continuity beyond the ~3-5 messages of chat context.

The ledger tracks: collisions, constraints, factions, places, pressure points, PC state, and per-character dossiers (knowledge_asymmetry, key_moments, intimate_history, demonstrated_traits). It does not track: story summaries, scene-by-scene timelines, or cross-chapter narrative arcs.

## Key Conventions

- **Operations**: `CR` (create), `S` (set), `TR` (transition/move), `A` (append), `R` (remove), `MS` (map_set/read), `MR` (map_del), `D` (destroy), `SNAP`, `ROLL`, `AMEND`
- **Entity types**: `char`, `constraint`, `collision`, `combat`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`
- **State machines** (char tiers, constraint integrity, collision status, combat status) are documented in `state-machine.js`. `validateTransition()` (state-machine.js:79) is called from `index.js:1514` at commit time to reject invalid TRs.
- **Collision status**: `ACTIVE -> RESOLVED` or `ACTIVE -> CRASHED` (Phase 2 simplified state machine — §3.4)
- **Arrival decision gate**: When a collision hits distance 0 (category IMMEDIATE arrives on creation; others on engine tick-down), the extension injects a single-turn sanity-check block asking the LLM to commit ON-SCREEN, OFF-SCREEN (REFRAME or DISSOLVE), or IMPLODE — all resolutions complete that turn. Tracked via `_firedCollisionArrivals` Set in `index.js`.
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
- `index.js` is the central coordinator (~2,250 lines). It wires all modules together and handles the turn lifecycle.
- `gravity-system-prompt.md` is a legacy reference for the ledger command format. The current preset is `gravity_v15.json`; mode-specific playbooks can be imported from `Gravity World Info.json`. The extension injects runtime state, readmes, nudges, and mode triggers via `setExtensionPrompt()`.
- `Documentation/system_architecture_reference.md` is the canonical maintenance map for cross-system updates and reviews.
- `Documentation/project_memory.md` is the active durable memory file.
- Historical prose, handoff, planning, and audit docs live under `Deprecated/`.
- Divination uses two random tables (Arcana/Classic) defined in `index.js`. Yi Jing (I Ching) has been removed.
