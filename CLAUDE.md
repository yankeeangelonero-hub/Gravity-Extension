# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build tooling exists. This is a pure JavaScript SillyTavern extension — no npm, no webpack, no bundler.

**Syntax check a file:**
```bash
node -c index.js
node -c rules-engine.js
# etc.
```

**Validate a JSON fixture:**
```bash
node -e "JSON.parse(require('fs').readFileSync('test-import-ffvii.json','utf8')); console.log('OK')"
```

There is no test suite, linter, or formatter configured.

## Architecture

Gravity Ledger is a SillyTavern extension that enforces narrative consistency through an **append-only ledger + state machine** system. The LLM outputs prose alongside a `---LEDGER---` block of structured transactions; the extension parses, validates, and commits those transactions, then injects a formatted state view into every future prompt.

### Data flow

```
LLM response → regex-intercept.js (parse ledger block)
             → consistency.js     (validate structure)
             → ledger-store.js    (append transactions)
             → state-compute.js   (derive current state)
             → state-view.js      (format for injection)
             → index.js           (setExtensionPrompt @ depth 0)
```

If validation errors are found, `index.js` builds a correction injection that is added to the next prompt (self-correcting loop, max 3 attempts).

### Key modules

| File | Role |
|---|---|
| `index.js` | Orchestrator — lifecycle, turn loop, correction feedback, auto-snapshots |
| `ledger-store.js` | Persistence in `chatMetadata['gravity_ledger']`; append-only transaction log + snapshots |
| `state-compute.js` | Derives `ComputedState` from full transaction history; idempotent |
| `state-machine.js` | Defines valid state transitions (char tiers, constraint integrity, collision status) |
| `consistency.js` | Validates transaction structure only (op codes, required fields, entity types) — does **not** enforce gameplay rules |
| `state-view.js` | Formats computed state as text for depth-0 injection |
| `rules-engine.js` | Selects and builds turn-specific narrative rules (normal / advance / combat / intimacy) |
| `regex-intercept.js` | Parses `---LEDGER---` blocks from raw LLM output into JSON transactions |
| `ui-panel.js` | Floating dashboard — 5 tabs (Characters, Factions & World, Collisions, Arc & Chapters, Divination) + Settings |
| `ooc-handler.js` | Dispatches OOC commands (`eval`, `rollback`, `snapshot`, `history`, `divination`, etc.) |
| `setup-wizard.js` | One-shot initialization form; injects answers → LLM populates initial state |
| `memory-tier.js` | Hot/cold tiering for `story_summary` and `pc_traits`; cold entries compressed to summaries |
| `snapshot-mgr.js` | Creates/restores snapshots; rollback discards transactions after a snapshot's `lastTxId` |

### State machines

- **Character tier**: `UNKNOWN → KNOWN → TRACKED → PRINCIPAL`
- **Constraint integrity**: `STABLE → STRESSED → CRITICAL → BREACHED`
- **Collision status**: `SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED / CRASHED`
- **Chapter status**: `PLANNED → OPEN → CLOSING → CLOSED`

Transitions must be sequential (no skipping levels). `state-machine.js` defines valid transitions; `consistency.js` validates op structure; the LLM is responsible for semantic correctness during `ooc: eval`.

### Storage

Everything persists in `chatMetadata['gravity_ledger']` (SillyTavern's per-chat JSON metadata). No external database or lorebook — the chat file is the single source of truth.

### Prompt injection

State view + narrative rules are injected at **depth 0** (always visible to the LLM regardless of context window pressure) via SillyTavern's `setExtensionPrompt`. The rules variant is chosen per turn type; intimacy/combat/advance turns each have distinct rule sets.

### Transaction format

```js
{
  op: 'CR' | 'S' | 'TR' | 'A' | 'R' | 'MS' | 'MR' | 'D',
  e: 'char' | 'constraint' | 'collision' | 'chapter' | 'faction' | 'world' | 'pc' | 'divination' | 'summary',
  id: string,
  d: { /* op-specific payload */ },
  t: timestamp,
  r: reason   // optional
}
```

`regex-intercept.js` also accepts human-readable aliases (`CREATE`→`CR`, `SET`→`S`, `TRANSITION`→`TR`, etc.) and strips markdown formatting (`>`, `-`, `*`) before parsing.
