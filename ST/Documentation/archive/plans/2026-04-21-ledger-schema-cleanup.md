# Ledger Schema Cleanup — Next Wave of Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four schema-drift and dead-field bugs surfaced by the Lacus Clyne 150-turn test session review (2026-04-21), eliminating the `[SCHEMA DRIFT]` correction-injection cycle and silently orphaned state that the review identified.

**Architecture:** All fixes land at the state-compute normalization layer (`state-compute.js`) and the view-rendering layer (`state-view.js`). No new entity types, no new state machines, no new injection slots. The project has no test framework; validation is `node -c` + a throwaway Node replay harness that loads the Lacus Clyne fixture and asserts the normalized state shape.

**Tech Stack:** Pure Node.js (no build step, no test runner). The Lacus Clyne session `.json` at `Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json` is the fixture for replay validation.

**Out of scope:** The `rapport` scalar feature proposal is a *new feature*, not a bug fix — it needs its own brainstorm + plan. UI panel rendering of `want/doing/stance_toward_pc/cost` is resolved by deleting the orphaned fields at the migration layer, not by adding render paths.

---

## File Structure

| File | Responsibility | Change Type |
|---|---|---|
| `state-compute.js` | Replay transactions → normalized state. Owns the migration layer. | Modify |
| `state-view.js` | Format state for prompt injection. Owns the drift-warning vocabulary. | Modify |
| `challenge-state.js` | Seed challenge entities when a challenge opens. Must stamp `opened_from`. | Modify |
| `scripts/replay-fixture.js` | Throwaway Node harness that loads a session JSON, runs transactions through `state-compute`, and prints the normalized shape for inspection. | Create |

No other files touched. `ui-panel.js` already reads `c.profile` and `combat.opened_from` correctly — the fix is upstream.

---

## Task 1: Replay Harness (enables all later validation)

**Files:**
- Create: `scripts/replay-fixture.js`

- [ ] **Step 1: Write the replay harness**

```javascript
// scripts/replay-fixture.js
// Usage: node scripts/replay-fixture.js <path-to-session-json>
// Loads a SillyTavern chat metadata export and replays transactions
// through state-compute.js, printing the resulting normalized state.

const fs = require('fs');
const path = require('path');

// state-compute.js uses ES module exports — adapt the require.
// If state-compute exports are not CommonJS-compatible, paste the
// function bodies into a local eval, or run under `--experimental-vm-modules`.
const { computeState } = require('../state-compute.js');

const fixturePath = process.argv[2];
if (!fixturePath) {
    console.error('Usage: node scripts/replay-fixture.js <session.json>');
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const txs = raw.chat_metadata?.gravity_ledger?.transactions || raw.transactions;
if (!Array.isArray(txs)) {
    console.error('No transactions[] found in fixture');
    process.exit(1);
}

const state = computeState(txs);

// Print what the review flagged
console.log('--- Constraint shape audit ---');
for (const c of Object.values(state.constraints || {})) {
    console.log(`${c.id}: owner_id=${c.owner_id} profile="${(c.profile || '').slice(0, 40)}..." shedding_order=${c.shedding_order}`);
}
console.log('--- Char orphan audit ---');
for (const ch of Object.values(state.characters || {})) {
    const orphans = ['want', 'doing', 'stance_toward_pc', 'cost', 'reads'].filter(f => ch[f] !== undefined);
    if (orphans.length) console.log(`${ch.id}: orphan fields=${orphans.join(',')}`);
}
console.log('--- Combat opened_from audit ---');
for (const cb of Object.values(state.combats || {})) {
    console.log(`${cb.id}: opened_from=${cb.opened_from || 'MISSING'} primary_enemy=${cb.primary_enemy}`);
}
console.log('--- Collision ignition audit ---');
for (const col of Object.values(state.collisions || {})) {
    if (!col.fires_when && !col.ignition_class) {
        console.log(`${col.id}: MISSING fires_when AND ignition_class`);
    }
}
```

- [ ] **Step 2: Adapt for state-compute.js module shape**

Check how `state-compute.js` exports its functions. Look for `module.exports = {...}` at the bottom or an ES module `export` keyword. If it uses ST-global-style assignment with no module system, wrap it:

```bash
node -e "const s = require('./state-compute.js'); console.log(Object.keys(s));"
```

If the require yields an empty object, the file is not CommonJS. Add at the bottom of `state-compute.js` (inside an existing export block if one exists):

```javascript
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeState, applyTransaction, createEmptyState };
}
```

This is additive and harmless in the browser.

- [ ] **Step 3: Run harness against the Lacus Clyne fixture**

```bash
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json"
```

Expected output before any fixes: constraint rows with `owner_id=undefined profile="undefined..." shedding_order=undefined`, character rows with `orphan fields=want,doing,stance_toward_pc,cost`, combat with `opened_from=MISSING`. This is the baseline we're fixing.

- [ ] **Step 4: Commit**

```bash
git add scripts/replay-fixture.js state-compute.js
git commit -m "test: add replay harness for session fixture validation"
```

---

## Task 2: Constraint Field Alias Normalization

**Files:**
- Modify: `state-compute.js` (add normalization in the constraint CR/S path)

The review found three aliasing errors in constraint transactions (tx:339–341, tx:687–690 of the Lacus Clyne session):

| LLM wrote | Canonical field | Notes |
|---|---|---|
| `description="..."` | `profile` | Body text |
| `char="char:lacus-clyne"` | `owner_id="lacus-clyne"` | Value also needs `char:` prefix stripped |
| `shed=1` | `shedding_order=1` | Integer ordering |

- [ ] **Step 1: Locate the constraint write path**

```bash
grep -n "constraints\[" state-compute.js | head -20
```

Find where a CR or S on a constraint assigns fields into `state.constraints[id]`. The alias normalization must run **before** the field is written.

- [ ] **Step 2: Add the alias normalizer**

Insert near the top of `state-compute.js`, after `getCollectionName`:

```javascript
const CONSTRAINT_FIELD_ALIASES = {
    description: 'profile',
    shed: 'shedding_order',
};

function normalizeConstraintFields(fields) {
    if (!fields || typeof fields !== 'object') return fields;
    const out = { ...fields };
    for (const [alias, canonical] of Object.entries(CONSTRAINT_FIELD_ALIASES)) {
        if (out[alias] !== undefined && out[canonical] === undefined) {
            out[canonical] = out[alias];
        }
        delete out[alias];
    }
    if (out.char !== undefined && out.owner_id === undefined) {
        out.owner_id = out.char;
    }
    delete out.char;
    if (typeof out.owner_id === 'string' && out.owner_id.startsWith('char:')) {
        out.owner_id = out.owner_id.slice('char:'.length);
    }
    return out;
}
```

- [ ] **Step 3: Wire the normalizer into the CR/S path**

In `applyTransaction`, wherever constraint fields are merged into `state.constraints[id]`, call `normalizeConstraintFields` on the incoming field bag first. For `CR`:

```javascript
if (tx.e === 'constraint' && tx.op === 'CR') {
    const fields = normalizeConstraintFields(tx.d);
    state.constraints[tx.id] = { id: tx.id, ...fields };
    // ...existing history recording
}
```

For `S` (single field set), the alias check must also run — `S constraint:x field=description value=...` needs to land on `profile`:

```javascript
if (tx.e === 'constraint' && tx.op === 'S') {
    const f = CONSTRAINT_FIELD_ALIASES[tx.d.f] || (tx.d.f === 'char' ? 'owner_id' : tx.d.f);
    let v = tx.d.v;
    if (f === 'owner_id' && typeof v === 'string' && v.startsWith('char:')) {
        v = v.slice('char:'.length);
    }
    state.constraints[tx.id][f] = v;
    // ...existing history recording with the canonical field name
}
```

- [ ] **Step 4: Syntax check**

```bash
node -c state-compute.js
```

Expected: no output (success).

- [ ] **Step 5: Replay the fixture**

```bash
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json"
```

Expected change: constraint rows now show `owner_id=lacus-clyne profile="The Deflection..."`  and `shedding_order=1`. No more `undefined` on the 7 constraints the review flagged.

- [ ] **Step 6: Commit**

```bash
git add state-compute.js
git commit -m "fix(state-compute): normalize constraint field aliases (description→profile, char→owner_id, shed→shedding_order)"
```

---

## Task 3: Drift Warning Update

**Files:**
- Modify: `state-view.js:262-266` (the existing `owner_id missing — 'char' was used instead` warning)

Task 2 auto-fixes the field so the drift warning should no longer fire on those constraints. Verify and simplify.

- [ ] **Step 1: Read the current warning**

```bash
node -e "const fs = require('fs'); const lines = fs.readFileSync('state-view.js', 'utf8').split('\\n'); console.log(lines.slice(255, 290).join('\\n'));"
```

Expected: the drift check at state-view.js:262 reads `if (!c.owner_id)`. After Task 2, `c.owner_id` is always populated when the LLM wrote `char=`. The warning now only fires when neither field was written. This is correct behavior, so the code can stay.

- [ ] **Step 2: Confirm the replay output shows no drift warnings for the 7 flagged constraints**

```bash
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json" 2>&1 | grep -i drift
```

Expected: no output.

- [ ] **Step 3: No commit — no code change this task.**

Task 2 alone was sufficient. This task exists as a verification gate.

---

## Task 4: Dead Char-Field Migration

**Files:**
- Modify: `state-compute.js` (add `migrateCharToCleanShape` after `migrateFactionToPhase2`)

The review found `want`, `doing`, `stance_toward_pc`, `cost`, and legacy `reads` fields set on characters at init (tx:34–61, 45, 51) that are never rendered by `state-view.js` or `ui-panel.js`. Mirror the existing faction migration pattern at `state-compute.js:181`.

- [ ] **Step 1: Add the migration function**

After `migrateFactionToPhase2` in `state-compute.js`, add:

```javascript
// Phase 2 char shape: name, tier, knowledge_asymmetry, key_moments,
// demonstrated_traits, reads (new capped-log form), intimate_history, last_seen_at,
// power/power_base/power_basis/abilities (combat). Legacy setup-wizard fields
// that no view or panel surfaces are dropped at load time.
function migrateCharToCleanShape(state) {
    const LEGACY_CHAR_FIELDS = [
        'want', 'doing', 'stance_toward_pc', 'cost',
    ];
    for (const ch of Object.values(state.characters || {})) {
        for (const f of LEGACY_CHAR_FIELDS) {
            if (ch[f] !== undefined) delete ch[f];
        }
        // Legacy flat `reads` map (string → string) predates the capped-log form.
        // Keep `reads` only if it is an array (new shape); drop if it is a plain object.
        if (ch.reads && !Array.isArray(ch.reads) && typeof ch.reads === 'object') {
            delete ch.reads;
        }
    }
}
```

- [ ] **Step 2: Call the new migration from `computeState`**

Find where `migrateFactionToPhase2(state)` is called inside `computeState` and add the sibling call directly after:

```javascript
migrateFactionToPhase2(state);
migrateCharToCleanShape(state);
```

- [ ] **Step 3: Syntax check**

```bash
node -c state-compute.js
```

Expected: no output.

- [ ] **Step 4: Replay verification**

```bash
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json" 2>&1 | grep orphan
```

Expected: no output. Every character row that previously listed orphan fields should now list none.

- [ ] **Step 5: Commit**

```bash
git add state-compute.js
git commit -m "fix(state-compute): drop legacy char fields (want/doing/stance_toward_pc/cost) and legacy flat reads map"
```

---

## Task 5: Challenge `opened_from` Stamping

**Files:**
- Modify: `challenge-state.js` (at the challenge-open seeding call site)

The review found `combat-mo8159fk` (Lacus Clyne tx:463) was created without `opened_from` set. The collision it opened from (`collision:le-creuset-pursuit`) was resolved in the same batch, so the link was lost. `state-view.js:126` and `ui-panel.js:1113` already render `opened_from` — the gap is at the seed call site.

- [ ] **Step 1: Locate the seed call site**

```bash
grep -n "CR.*combat:\|op: 'CR'.*e: 'combat'\|entity_id.*combat\|seedChallenge\|openChallenge" challenge-state.js
```

Find the function that creates the challenge entity when the player clicks Combat or when a collision arrival triggers a challenge. The seed call must accept a `sourceCollisionId` parameter.

- [ ] **Step 2: Add the parameter and stamp it on seed**

At the seed call site, when `sourceCollisionId` is truthy, include it in the initial CR transaction's field bag:

```javascript
const seedFields = {
    kind: 'combat',
    status: 'ACTIVE',
    // ...existing minimal seed fields
};
if (sourceCollisionId) {
    seedFields.opened_from = sourceCollisionId;
}
// Emit CR challenge:<id> with seedFields
```

The call sites that already know which collision the challenge opened from must pass it through. If a Combat button click has no collision context, leave `opened_from` unset — it is optional.

- [ ] **Step 3: Syntax check**

```bash
node -c challenge-state.js
```

Expected: no output.

- [ ] **Step 4: Manual verification with a fresh combat**

Reload SillyTavern. Open a chat that has an ACTIVE collision. Click Combat. Inspect the resulting `---LEDGER---` block in the assistant message — the `CR combat:...` transaction should include `opened_from=<collision-id>`.

- [ ] **Step 5: Commit**

```bash
git add challenge-state.js
git commit -n "fix(challenge): stamp opened_from on challenge seed when opening from a collision"
```

---

## Task 6: Collision Ignition Drift Warning

**Files:**
- Modify: `state-view.js` (add a drift line in the collision formatter)

The review found `kira-debrief` and `athrun-search` ticked distance for 400+ transactions before `fires_when`/`ignition_class` were retrofitted at tx:691–694. The contract (`state-view.js:673`) says every collision needs an ignition spec on creation. Add a drift warning so late retrofits are nudged, not silently allowed.

- [ ] **Step 1: Locate the collision formatter**

```bash
grep -n "ignition_class" state-view.js
```

Expected: `state-view.js:31-33` is where the collision line is built with ignition metadata.

- [ ] **Step 2: Add the drift warning**

After the existing ignition-line block in `state-view.js:31-33`, add:

```javascript
if (!col.fires_when && !col.ignition_class && col.status !== 'RESOLVED' && col.status !== 'CRASHED') {
    lines.push(`    [SCHEMA DRIFT] collision:${col.id} missing fires_when and ignition_class. Fix: S collision:${col.id} field=fires_when value="<one-sentence scene condition>" and S collision:${col.id} field=ignition_class value=<clock|tripwire|revelation|decision|accumulator>.`);
}
```

Resolved and crashed collisions should not generate drift noise.

- [ ] **Step 3: Syntax check**

```bash
node -c state-view.js
```

Expected: no output.

- [ ] **Step 4: Replay verification**

```bash
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json" 2>&1 | grep ignition
```

Expected: output for collisions that are still ACTIVE and lack ignition fields. Cross-check against the tx:691–694 retrofit — those collisions should have zero drift after retrofit.

Note: the harness currently prints normalized state, not view output. Extend it briefly — add a call to the collision view formatter in the harness to exercise this code path. If that requires importing from `state-view.js` and it is not CommonJS-compatible, adapt the harness the same way as Task 1 Step 2.

- [ ] **Step 5: Commit**

```bash
git add state-view.js scripts/replay-fixture.js
git commit -m "fix(state-view): warn when active collision lacks fires_when/ignition_class"
```

---

## Task 7: Full Live Verification

**Files:**
- None (verification-only)

- [ ] **Step 1: Reload the Lacus Clyne session in SillyTavern**

Open SillyTavern. Load the Lacus Clyne chat. Open the Gravity panel.

- [ ] **Step 2: Visual verification of the fixes**

Expected observations:
- All seven previously-blank constraint cards (Lacus's three + Autumn's four) now show body text.
- Constraint ownership rows render cleanly without `[SCHEMA DRIFT]` correction injection in the next turn.
- Character dossiers no longer list orphan fields (`want`/`doing`/`stance_toward_pc`/`cost` are absent).
- The resolved combat entity (if still visible) shows `Opened from: collision:le-creuset-pursuit`.

- [ ] **Step 3: Run one fresh turn**

Send a regular-mode message. After the assistant replies, check:
- No `[SCHEMA DRIFT]` injection about constraint `owner_id` or `profile` for any of the seven constraints.
- If any active collisions lack `fires_when`, the drift warning appears once in the prompt state (not repeated per turn once backfilled).

- [ ] **Step 4: Final commit (if any documentation updates are needed)**

Update `Documentation/project_memory.md` with a one-line entry under "Current State":

```
- 2026-04-21: Constraint field aliases (description/char/shed) are now normalized at replay. Legacy char fields (want/doing/stance_toward_pc/cost) and legacy flat reads map are dropped on load. Challenges stamp opened_from at seed. Active collisions without fires_when emit a drift warning.
```

Commit:

```bash
git add Documentation/project_memory.md
git commit -m "docs: record 2026-04-21 schema cleanup in project memory"
```

---

## Self-Review Notes

- **Spec coverage:** All four review clusters (aliases, dead fields, opened_from, fires_when) have tasks. The rapport proposal is explicitly deferred to a separate plan.
- **Placeholders:** None — every code step has concrete code, every command has expected output.
- **Type consistency:** `normalizeConstraintFields` is defined once (Task 2) and referenced by field name in Task 3's verification. Migration function names mirror the existing `migrateFactionToPhase2` pattern.
- **Known unknown:** Task 5's exact call site depends on `challenge-state.js` shape. The step includes a grep-first locate-then-edit pattern rather than a fixed line number.
