# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build tooling. Pure JavaScript SillyTavern extension — no npm, no webpack.

**Syntax check:**
```bash
node -c index.js
node -c <any-module>.js
```

**Validate JSON fixture:**
```bash
node -e "JSON.parse(require('fs').readFileSync('test-import-ffvii.json','utf8')); console.log('OK')"
```

## Architecture

Gravity Ledger is a SillyTavern extension that enforces narrative consistency through an append-only ledger + state machine. The LLM outputs prose alongside a `---LEDGER---` block of transactions; the extension parses, validates, commits, then injects formatted state back into every future prompt.

### Data flow

```
LLM response → regex-intercept.js (parse ledger block)
             → consistency.js     (validate structure)
             → ledger-store.js    (append transactions)
             → state-compute.js   (derive current state)
             → state-view.js      (format for injection)
             → index.js           (setExtensionPrompt @ depth 0)
```

### Deduction / nudge system (this branch)

Unlike the `prose` branch (which uses `rules-engine.js`), this branch handles turn instructions entirely inside `index.js`. The key mechanism is a **nudge injection** fired before every turn:

- `DEDUCTION_TEMPLATES` (line ~476) — compact `---DEDUCTION---` checklists per turn type (regular, combat, advance, intimacy)
- `_pendingDeductionType` — set by UI buttons (Combat, Advance, Intimacy) to select the right template
- Nudge injected via `setExtensionPrompt(MODULE_NAME_nudge, nudgeText, PROMPT_IN_CHAT, 0)` — **chat-role injection at depth 0**, meaning it appears as a system message immediately before the LLM generates output
- Anti-reasoning instruction in nudge: model must not produce a separate reasoning block before the deduction

Turn-specific injections (intimacy scene context, combat setup, advance draw) are also injected via `PROMPT_IN_CHAT` at depth 0 so they appear close to generation.

### Key modules

| File | Role |
|---|---|
| `index.js` | Everything: orchestrator, turn loop, deduction nudge, all turn-specific injections, UI callbacks |
| `ledger-store.js` | Persistence in `chatMetadata['gravity_ledger']`; append-only log + snapshots |
| `state-compute.js` | Derives `ComputedState` from full transaction history; idempotent |
| `state-machine.js` | Valid state transitions (char tiers, constraint integrity, collision status) |
| `consistency.js` | Validates transaction structure only — op codes, required fields, entity types |
| `state-view.js` | Formats computed state as text for depth-0 injection |
| `regex-intercept.js` | Parses `---LEDGER---` blocks; accepts human-readable op aliases |
| `ui-panel.js` | Floating dashboard — Characters, Factions & World, Collisions, Arc & Chapters, Divination + Settings |
| `ooc-handler.js` | OOC commands: eval, rollback, snapshot, history, divination, archive |
| `setup-wizard.js` | One-shot initialization form |
| `memory-tier.js` | Hot/cold tiering for story_summary and pc_traits |
| `snapshot-mgr.js` | Snapshot/rollback; discards transactions after a snapshot's lastTxId |

### Injection positions

SillyTavern has two relevant positions:
- `PROMPT_IN_CHAT` (position 2) — injects as a chat-role message at a given depth; depth 0 = immediately before model output
- `PROMPT_BEFORE_SYSTEM` / `PROMPT_AFTER_SYSTEM` — prepends/appends to system prompt

The nudge uses `PROMPT_IN_CHAT` at depth 0. The state view and main rules use `setExtensionPrompt` at depth 0 of the system prompt. This split is intentional: rules are background context, the nudge is the immediate trigger.

### State machines

- **Character tier**: `UNKNOWN → KNOWN → TRACKED → PRINCIPAL`
- **Constraint integrity**: `STABLE → STRESSED → CRITICAL → BREACHED`
- **Collision status**: `SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED / CRASHED`
- **Chapter status**: `PLANNED → OPEN → CLOSING → CLOSED`

Sequential only — no skipping levels.

### Storage

Everything in `chatMetadata['gravity_ledger']`. No external database. The chat file is the source of truth.
