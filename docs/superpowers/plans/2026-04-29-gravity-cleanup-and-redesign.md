# Gravity Ledger Cleanup & Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five critical bugs, redesign divination so the engine is the only source of card values, add per-turn rolling ledger compaction, and remove dead code (including the timeskip button).

**Architecture:** No backward compatibility — schema changes apply forward only, no migrations. Phase 0 fixes ship-blocking bugs first. Phase 1 makes divination tamper-proof at the validation layer. Phase 2 introduces a single new primitive in `ledger-store.js` (`compactTransactions`) that runs cheap deduplications every turn and deeper consolidations alongside the 15-turn auto-snapshot, with a `diffStates` integrity check guarding correctness. Phase 3 deletes dead code and the timeskip surface entirely.

**Tech Stack:** Pure JavaScript ES modules, no build step, no bundler. Runs in SillyTavern's browser context. Tests run under Node 24 (which supports `require()` of ESM). Validation is `node -c <file>.js` for syntax and `node scripts/<name>.js` for unit tests.

**Reference docs:**
- `CLAUDE.md` — architecture overview
- `Documentation/system_architecture_reference.md` — code map
- `scripts/test-relationship.js` — model for new test scripts

---

## File Structure Overview

| File | Phase | Responsibility |
|---|---|---|
| `index.js` | 0, 1, 3 | Bug fixes, divination correction-time roll, auto-commit, cleanup |
| `consistency.js` | 1 | Add `relationship.card` and `divination.card`/`last_draw` to `ENGINE_OWNED_FIELDS`; AMEND payload validation |
| `state-compute.js` | 0, 2 | AMEND validation; nothing else changes |
| `ledger-store.js` | 2 | New `compactTransactions(compactFn)` primitive |
| `ledger-compactor.js` (new) | 2 | Pure compaction functions: dedup-S, dedup-MS, drop-destroyed, cancel-A-R, deep collision strip, SNAP/ROLL cull |
| `ooc-handler.js` | 2 | Extend `eval` output with op-type breakdown + compression ratio; rollback-target validation |
| `ui-panel.js` | 3 | Remove timeskip button, remove duplicate command bar buttons |
| `setup-wizard.js` | 3 | Delete `getPhasePrompt` stub |
| `state-view.js` | 1 | Replace `last_draw` readme example to mark engine-owned |
| `scripts/test-divination-slug.js` (new) | 1 | Tests for `cardSlug` derivation |
| `scripts/test-ledger-compactor.js` (new) | 2 | Tests for compactor purity + integrity |
| `scripts/test-correction-expiry.js` (new) | 0 | Tests for engine-correction `raw` keys + dedup |
| `CLAUDE.md` | 0, 3 | Update injection slot list (drop `_combat`, `_intimacy`); update timeskip removal |

---

# PHASE 0 — Critical Bug Fixes

Five independent bugs. Each gets its own commit. Fastest to ship; smallest blast radius.

---

### Task 0.1: Persist arrival/foreshadow state across reloads

**Problem:** `_firedCollisionArrivals` (`index.js:66`) and `_foreshadowedCollisions` (`index.js:67`) are module-level Sets/Maps that reset on every page reload. Already-resolved collisions can re-fire arrival prompts; past-threshold collisions re-fire foreshadow nudges.

**Fix strategy:** Reconstruct both from `_currentState` during `initialize()` rather than persisting. RESOLVED/CRASHED collisions go straight into `_firedCollisionArrivals`. ACTIVE collisions whose distance is at or below each foreshadow threshold get the corresponding levels populated in `_foreshadowedCollisions`.

**Files:**
- Modify: `index.js` (in `initialize()`, after `_currentState` is computed)

- [x] **Step 1: Read the current `initialize()` body**

Open `index.js` and find the function `initialize` (search for `async function initialize` or `function initialize(`). Read the section that builds `_currentState` and the lines that reset `_firedCollisionArrivals` / `_foreshadowedCollisions`.

- [x] **Step 2: Add reconstruction helper near the top-level Set declarations**

In `index.js`, immediately after the `let _foreshadowedCollisions = new Map();` line (~line 67), add:

```javascript
// Foreshadow distance thresholds — must match the constants used elsewhere in
// the foreshadow pipeline. If those constants change, update this table too.
const FORESHADOW_THRESHOLDS = {
    APPROACHING: 3,
    IMMINENT: 2,
    CONVERGING: 1,
};

function reconstructArrivalState(state) {
    const fired = new Set();
    const foreshadow = new Map();
    const collisions = state?.collisions || {};
    for (const [id, col] of Object.entries(collisions)) {
        if (!col) continue;
        if (col.status === 'RESOLVED' || col.status === 'CRASHED') {
            fired.add(id);
            continue;
        }
        if (col.status !== 'ACTIVE') continue;
        const dist = typeof col.distance === 'number' ? col.distance : null;
        if (dist === null) continue;
        // NOTE: do NOT pre-seed ACTIVE distance-0 collisions into `fired`. The
        // arrival pipeline catches them naturally on the next turn. Pre-seeding
        // here would silently suppress an arrival that never fired (e.g. user
        // closed the tab before the LLM responded to the tick-down).
        const levels = new Set();
        for (const [level, threshold] of Object.entries(FORESHADOW_THRESHOLDS)) {
            if (dist <= threshold) levels.add(level);
        }
        if (levels.size > 0) foreshadow.set(id, levels);
    }
    return { fired, foreshadow };
}
```

**Note:** Verify `FORESHADOW_THRESHOLDS` matches the actual constants used in the foreshadow pipeline before merging. Search `index.js` for "APPROACHING" and confirm the distance values.

- [x] **Step 3: Call the reconstruction helper from `initialize()`**

Find every place in `initialize()` (and `handleNewLedger`, `handleImportData`, `handleRevertTurn`) where `_firedCollisionArrivals = new Set()` and `_foreshadowedCollisions = new Map()` appear. Replace those two lines with:

```javascript
const _reconstructed = reconstructArrivalState(_currentState);
_firedCollisionArrivals = _reconstructed.fired;
_foreshadowedCollisions = _reconstructed.foreshadow;
```

`_currentState` must already be populated before this runs. If not, move these lines to after the `computeCurrentState()` / state-load call.

- [x] **Step 4: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output, exit 0.

- [x] **Step 5: Manual verification in SillyTavern**

1. Open a chat with at least one RESOLVED collision and one ACTIVE collision at distance ≤ APPROACHING threshold.
2. Reload the browser tab.
3. Trigger an `/advance` turn.
4. Open the SillyTavern console.
5. Inspect: there must be no arrival sanity-check injection for the RESOLVED collision, and no `APPROACHING`/`IMMINENT`/`CONVERGING` foreshadow injection for the active collision.

- [x] **Step 6: Commit**

```bash
git add index.js
git commit -m "fix(arrivals): reconstruct fired/foreshadow sets from state on init"
```

---

### Task 0.2: Engine-pushed corrections must expire

**Problem:** `index.js` has **four** direct `_pendingCorrections.push(...)` sites (~lines 1821, 1827, 1844, 1983) that push objects with shape `{ text: '...', attempts: 0 }`. These objects have:
- a `text` key instead of `error` (so they format differently when injected),
- `attempts: 0` with no incrementing path (so the `MAX_CORRECTION_ATTEMPTS` expiry never engages),
- no `raw` key (so `clearMatchedCorrections` cannot match them against committed transactions and never removes them from the array).

Combined effect: these corrections are immortal — they re-inject every turn for the rest of the chat session.

**Files:**
- Modify: `index.js` (correction push sites at ~1821, ~1827, ~1844, ~1983)

- [x] **Step 1: Read the engine push sites**

Search `index.js` for `_pendingCorrections.push(`. Confirm there are **four** sites, not three. Read each and note the trigger condition (missing `distance_category`, excess `created_at_tx`, agenda-on-promotion, and the fourth at ~1983 — note its trigger condition before refactoring).

- [x] **Step 2: Replace all four direct pushes with `queueCorrections` calls using deterministic raw keys**

For each direct `_pendingCorrections.push({ text, attempts: 0 })` site, replace with a call to `queueCorrections([...])` using a deterministic `raw` key and an `error` field. Examples for the first three sites; the fourth site's `error` text should match its trigger condition (read it during Step 1):

```javascript
queueCorrections([{
    raw: `[engine:collision:${tx.id}:missing-distance-category]`,
    error: 'Collision is missing distance_category — engine cannot tick distance. Please SET collision.distance_category to one of: IMMEDIATE, IMMINENT, NEAR, FAR.',
}]);
```

For the excess `created_at_tx` site:
```javascript
queueCorrections([{
    raw: `[engine:pressure:${tx.id}:excess-created-at-tx]`,
    error: 'Pressure entity carries created_at_tx, which is engine-owned. Drop that field on creation; the engine assigns it.',
}]);
```

For the agenda-on-promotion site (~1844):
```javascript
queueCorrections([{
    raw: `[engine:char:${charId}:missing-agenda-on-promotion]`,
    error: `Character ${charId} was promoted to TRACKED+ but has no agenda. SET char:${charId} field=agenda value="<short noun phrase>".`,
}]);
```

- [x] **Step 3: Add cleanup in `clearMatchedCorrections` for engine raws**

The `clearMatchedCorrections` function currently matches by `raw === err.raw`. Engine raw keys won't match LLM-emitted error strings. Instead, clear engine raws when their underlying condition is satisfied.

In `clearMatchedCorrections`, after the existing matching loop, add:

```javascript
// Engine corrections clear when their underlying condition is satisfied.
const stillNeeded = new Set();
for (const corr of _pendingCorrections) {
    if (!corr.raw || !corr.raw.startsWith('[engine:')) continue;
    const m = corr.raw.match(/^\[engine:(\w+):([^:]+):([^\]]+)\]$/);
    if (!m) continue;
    const [, entityType, entityId, condition] = m;
    if (engineConditionStillTrue(entityType, entityId, condition, _currentState)) {
        stillNeeded.add(corr.raw);
    }
}
_pendingCorrections = _pendingCorrections.filter(corr => {
    if (!corr.raw || !corr.raw.startsWith('[engine:')) return true;
    return stillNeeded.has(corr.raw);
});
```

- [x] **Step 4: Add the `engineConditionStillTrue` helper**

Add near the top of `index.js`, after the corrections module section:

```javascript
function engineConditionStillTrue(entityType, entityId, condition, state) {
    if (entityType === 'collision' && condition === 'missing-distance-category') {
        const c = state?.collisions?.[entityId];
        return !!c && !c.distance_category;
    }
    if (entityType === 'pressure' && condition === 'excess-created-at-tx') {
        // Once the engine has stamped created_at_tx, the warning is moot.
        return false;
    }
    if (entityType === 'char' && condition === 'missing-agenda-on-promotion') {
        const c = state?.characters?.[entityId];
        return !!c && (c.tier === 'TRACKED' || c.tier === 'PRINCIPAL') && !c.agenda;
    }
    return false;
}
```

- [x] **Step 5: Write a test for engine-correction expiry**

Create `scripts/test-correction-expiry.js`:

```javascript
'use strict';
// Targets only the matcher logic. The corrections array shape is mocked.

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// Reimplement the helper here for unit testing without ST globals.
function engineConditionStillTrue(entityType, entityId, condition, state) {
    if (entityType === 'collision' && condition === 'missing-distance-category') {
        const c = state?.collisions?.[entityId];
        return !!c && !c.distance_category;
    }
    if (entityType === 'pressure' && condition === 'excess-created-at-tx') return false;
    if (entityType === 'char' && condition === 'missing-agenda-on-promotion') {
        const c = state?.characters?.[entityId];
        return !!c && (c.tier === 'TRACKED' || c.tier === 'PRINCIPAL') && !c.agenda;
    }
    return false;
}

test('collision missing distance_category — true when missing', () => {
    const s = { collisions: { c1: { id: 'c1' } } };
    if (!engineConditionStillTrue('collision', 'c1', 'missing-distance-category', s))
        throw new Error('expected true');
});

test('collision missing distance_category — false when present', () => {
    const s = { collisions: { c1: { id: 'c1', distance_category: 'NEAR' } } };
    if (engineConditionStillTrue('collision', 'c1', 'missing-distance-category', s))
        throw new Error('expected false');
});

test('collision missing distance_category — false when entity destroyed', () => {
    const s = { collisions: {} };
    if (engineConditionStillTrue('collision', 'c1', 'missing-distance-category', s))
        throw new Error('expected false');
});

test('pressure excess created_at_tx — always false (one-shot warning)', () => {
    const s = { pressures: { p1: { id: 'p1', created_at_tx: 5 } } };
    if (engineConditionStillTrue('pressure', 'p1', 'excess-created-at-tx', s))
        throw new Error('expected false');
});

test('char missing-agenda-on-promotion — true for TRACKED without agenda', () => {
    const s = { characters: { c1: { id: 'c1', tier: 'TRACKED' } } };
    if (!engineConditionStillTrue('char', 'c1', 'missing-agenda-on-promotion', s))
        throw new Error('expected true');
});

test('char missing-agenda-on-promotion — false once agenda set', () => {
    const s = { characters: { c1: { id: 'c1', tier: 'TRACKED', agenda: 'find truth' } } };
    if (engineConditionStillTrue('char', 'c1', 'missing-agenda-on-promotion', s))
        throw new Error('expected false');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [x] **Step 6: Run the test and confirm pass**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-correction-expiry.js"`
Expected: `6 passed, 0 failed`, exit 0.

- [x] **Step 7: Syntax check `index.js`**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [x] **Step 8: Commit**

```bash
git add index.js scripts/test-correction-expiry.js
git commit -m "fix(corrections): give engine pushes deterministic raw keys + expiry"
```

---

### Task 0.3: handleRevertTurn must reset runtime Sets

**Problem:** `index.js:2451–2464` (`handleRevertTurn`) does not reset `_firedCollisionArrivals` / `_foreshadowedCollisions` / `_archiveCorrectionAttempts` / `_firedRelationshipCorrections`. Reverting a turn that resolved a collision leaves the collision id stuck in those Sets, and the arrival gate never re-fires.

**Files:**
- Modify: `index.js` (in `handleRevertTurn` and `initialize`)

- [x] **Step 1: Locate the handlers**

Search `index.js` for `handleRevertTurn`, `handleNewLedger`, `handleImportData`. The Set/Map clearing pattern in `handleNewLedger` and `handleImportData` (around lines 2501–2531; `_firedCollisionArrivals = new Set()` lives near 2547) is the canonical pattern. Use grep on the identifiers — line numbers may have shifted.

Confirm `_archiveCorrectionAttempts` and `_firedRelationshipCorrections` exist as module-level vars (declarations at ~lines 71 and 83). They do exist, so include them in the reset.

- [x] **Step 2: After Task 0.1 lands, reuse the reconstruction helper**

Inside `handleRevertTurn`, after `_currentState` is recomputed by the revert, append:

```javascript
const r = reconstructArrivalState(_currentState);
_firedCollisionArrivals = r.fired;
_foreshadowedCollisions = r.foreshadow;
_archiveCorrectionAttempts = new Map();
_firedRelationshipCorrections = new Set();
```

If `_archiveCorrectionAttempts` and `_firedRelationshipCorrections` aren't already declared module-level vars, leave them out — search for their declarations first to confirm.

- [x] **Step 3: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [x] **Step 4: Manual verification**

1. Resolve a collision in chat (commit a turn with `TR collision:X status to=RESOLVED`).
2. Use the OOC `rollback` command to revert that turn.
3. Confirm the collision is back to ACTIVE in the state panel.
4. Trigger an arrival event for it again. The arrival gate must fire.

- [x] **Step 5: Commit**

```bash
git add index.js
git commit -m "fix(rollback): reset arrival/foreshadow/correction sets on revert"
```

---

### Task 0.4: Validate AMEND payloads at replay

**Problem:** `state-compute.js:657–668` accepts `tx.d.correction` raw with no shape check. A malformed AMEND silently produces a no-op or broken state.

**Files:**
- Modify: `state-compute.js` (the AMEND collection pass in `computeState`)

- [x] **Step 1: Read the AMEND collection block**

Open `state-compute.js` and find the AMEND handling in `computeState`. Note how amendments are gathered into a `Map`.

- [x] **Step 2: Add a shape guard before adding to the map**

Replace the current AMEND collection logic with:

```javascript
function isValidAmendCorrection(c) {
    if (!c || typeof c !== 'object') return false;
    if (typeof c.op !== 'string') return false;
    const validOps = new Set(['CR', 'S', 'TR', 'A', 'R', 'MS', 'MR', 'D']);
    if (!validOps.has(c.op)) return false;
    if (typeof c.e !== 'string' || !c.e) return false;
    if (typeof c.id !== 'string' || !c.id) return false;
    if (c.d !== undefined && (typeof c.d !== 'object' || c.d === null)) return false;
    return true;
}

// In the AMEND collection loop:
if (tx.op === 'AMEND') {
    if (!isValidAmendCorrection(tx.d?.correction)) {
        console.warn(`[GravityLedger] Dropping malformed AMEND tx=${tx.tx} (target=${tx.d?.target_tx}) — correction shape invalid.`);
        continue;
    }
    amendments.set(tx.d.target_tx, tx.d.correction);
    continue;
}
```

- [x] **Step 3: Add a unit test for AMEND validation**

Append to `scripts/test-relationship.js` (it's already the catch-all unit test file) under a new `group(...)`:

```javascript
const { computeState } = require('../state-compute.js');

group('AMEND validation', () => {
    test('malformed AMEND (no op) is dropped silently', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
            { tx: 2, op: 'AMEND', d: { target_tx: 1, correction: { e: 'char', id: 'c1' } } },
        ];
        const state = computeState(null, txs);
        // Original CR survives because the AMEND was malformed and ignored.
        assert(state.characters && state.characters.c1, 'character c1 must exist');
        assertEqual(state.characters.c1.name, 'Alice', 'name must be original');
    });

    test('AMEND with invalid op is dropped', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
            { tx: 2, op: 'AMEND', d: { target_tx: 1, correction: { op: 'XYZ', e: 'char', id: 'c1', d: { name: 'Bob' } } } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.c1.name, 'Alice', 'malformed AMEND must not apply');
    });

    test('AMEND with valid correction applies', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
            { tx: 2, op: 'AMEND', d: { target_tx: 1, correction: { op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Bob' } } } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.c1.name, 'Bob', 'valid AMEND must overwrite');
    });
});
```

- [x] **Step 4: Run the test**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-relationship.js"`
Expected: all existing tests pass plus the three new AMEND tests pass.

- [x] **Step 5: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/state-compute.js"`
Expected: no output.

- [x] **Step 6: Commit**

```bash
git add state-compute.js scripts/test-relationship.js
git commit -m "fix(replay): validate AMEND correction shape before applying"
```

---

### Task 0.5: Guard combat button against double-trigger

**Problem:** `index.js:2319–2327` runs `insertChatMessage('combat: ')` unconditionally even when the challenge runtime is locked. Pressing Combat during an active combat sends a bare "combat: " message into chat.

**Files:**
- Modify: `index.js` (`handleCombatButton`)

- [x] **Step 1: Locate the function**

Search `index.js` for `function handleCombatButton`. Read its body.

- [x] **Step 2: Move `insertChatMessage` inside the existing guard**

Find the `if (!isChallengeSessionLocked())` block. Move the `insertChatMessage('combat: ')` line inside that block. Result:

```javascript
function handleCombatButton() {
    if (!isChallengeSessionLocked()) {
        startChallengeRuntime('combat', /* existing args */);
        _pendingDeductionType = 'combat';
        insertChatMessage('combat: ');
    }
}
```

(Preserve the actual surrounding code — only relocate the `insertChatMessage` line.)

- [x] **Step 3: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [x] **Step 4: Manual verification**

1. Start a combat (press Combat button).
2. Press Combat button again while combat is active.
3. Confirm no spurious "combat: " message appears in chat.

- [x] **Step 5: Commit**

```bash
git add index.js
git commit -m "fix(combat): suppress redundant combat-button trigger when locked"
```

---

# PHASE 1 — Divination redesign (engine is the only source of truth)

Make the engine the only source of card values. Block LLM writes to engine-owned card fields at the validation layer. Roll cards at correction-queue time so the LLM is told which card to commit, never asked to invent one.

---

### Task 1.1: Add `cardSlug` to `drawDivination()` return

**Files:**
- Modify: `index.js` (`drawDivination`, ~line 535)
- Create: `scripts/test-divination-slug.js`

- [x] **Step 1: Read `drawDivination()` and `ARCANA_TABLE`**

Search `index.js` for `function drawDivination` and `const ARCANA_TABLE`. The actual table format is `"<name> — <meaning>"` (e.g. `"The Fool — A leap into the unknown..."`). The card name is already extracted at ~line 561 via `ARCANA_TABLE[num].split(' — ')[0]` → `"The Fool"`. The slug is derived from that already-extracted `cardName`, NOT from the raw table entry.

- [x] **Step 2: Write the failing slug test**

Create `scripts/test-divination-slug.js`:

```javascript
'use strict';
// Tests the slug derivation logic in isolation.
// We extract the function from index.js by re-implementing the small helper here.
// If the helper changes shape in index.js, mirror the change here.

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assertEqual(a, b, label) {
    if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// Mirror of the slug helper. Takes a card NAME (already extracted from
// ARCANA_TABLE[num].split(' — ')[0]). Must stay byte-identical to the
// implementation in index.js drawDivination().
function nameToSlug(cardName) {
    return cardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

test('the-fool', () => assertEqual(nameToSlug('The Fool'), 'the-fool', 'slug'));
test('the-magician', () => assertEqual(nameToSlug('The Magician'), 'the-magician', 'slug'));
test('the-high-priestess', () => assertEqual(nameToSlug('The High Priestess'), 'the-high-priestess', 'slug'));
test('wheel-of-fortune', () => assertEqual(nameToSlug('Wheel of Fortune'), 'wheel-of-fortune', 'slug'));
test('the-hanged-man', () => assertEqual(nameToSlug('The Hanged Man'), 'the-hanged-man', 'slug'));
test('judgement', () => assertEqual(nameToSlug('Judgement'), 'judgement', 'slug'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [x] **Step 3: Run the test (should fail — module under test doesn't exist yet, but test self-contains the helper, so this passes immediately)**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-divination-slug.js"`
Expected: `6 passed, 0 failed`. (This test is self-contained and pins the contract; the index.js implementation must match.)

- [x] **Step 4: Modify `drawDivination()` in `index.js`**

Inside `drawDivination` after `cardName` is computed, before the return statement, add:

```javascript
const cardSlug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
```

Then add `cardSlug` to the returned object alongside `label`, `reading`, `html`, etc.

- [x] **Step 5: Verify the slug helper output matches `MAJOR_ARCANA` in `consistency.js`**

Open `consistency.js` and find the `MAJOR_ARCANA` Set (~line 45). Confirm every cardSlug produced by step 4 is a member. If any name diverges (e.g. consistency uses `the-hanged-man` but the table produces `hanged-man`), patch the slug helper or the table — they must agree.

- [x] **Step 6: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [x] **Step 7: Commit**

```bash
git add index.js scripts/test-divination-slug.js
git commit -m "feat(divination): add cardSlug to drawDivination return"
```

---

### Task 1.2: Roll cards at correction-queue time (the user-reported bug)

**Files:**
- Modify: `index.js` (relationship correction sites at ~2006–2050)

- [x] **Step 1: Read each of the four relationship correction sites**

Search `index.js` for the literal string `<major-arcana-slug>`. The audit identified four sites (lines ~2008, ~2018, ~2037, ~2049). Read each correction error template.

- [x] **Step 2: For each site, roll a card and embed the slug**

At each site, immediately before constructing the correction error string, add:

```javascript
const draw = drawDivination();
```

Then replace the literal placeholder `<major-arcana-slug>` in the error template with `${draw.cardSlug}`. For example:

```javascript
// Before:
queueCorrections([{
    raw: `[missing-relationship:char:${charId}]`,
    error: `Character ${charId} has no relationship with the PC. Draw the card: CREATE relationship:pc-${charId} card="<major-arcana-slug>" orientation="upright" distance="fresh" intensity="cold".`,
}]);

// After:
const draw = drawDivination();
queueCorrections([{
    raw: `[missing-relationship:char:${charId}]`,
    error: `Character ${charId} has no relationship with the PC. The engine drew: ${draw.label}. CREATE relationship:pc-${charId} card="${draw.cardSlug}" orientation="upright" distance="fresh" intensity="cold".`,
}]);
```

Apply the same transformation to all four sites. The error templates differ in operation (CR vs S) and entity type (char vs faction vs orphan-collision vs missing-rel-update) — preserve those differences. Replace only the `<major-arcana-slug>` placeholder with the rolled `${draw.cardSlug}`.

- [x] **Step 3: For the missing-rel-update site (~2049), drop the `card` field from the correction**

After Task 1.3 lands, `S relationship:* field=card` will be rejected by `validateTransitions`. The missing-rel-update correction currently asks the LLM to update card on resolution. That's no longer permitted. Remove the `SET relationship:${relId} field=card value="..."` line from the error template entirely. Other fields (`nuance`, `distance`, `intensity`, `last_shift`) remain. The card stays as originally drawn.

- [x] **Step 4: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [ ] **Step 5: Manual verification**

1. Add a new TRACKED character without a relationship to the PC.
2. Take a turn. The injected correction should now contain a concrete arcana slug like `the-fool`, not the literal text `<major-arcana-slug>`.
3. The LLM should commit the relationship with that exact slug. After Task 1.3 lands, any deviation will be rejected.

- [x] **Step 6: Commit**

```bash
git add index.js
git commit -m "fix(divination): roll card at correction-queue time, embed concrete slug"
```

---

### Task 1.3: Engine ownership of divination + auto-commit (atomic)

**Why combined:** Marking `divination.last_draw` engine-owned (validation rejects LLM `S` writes) and providing the engine-side commits (so the field stays populated) MUST land in a single commit. If validation locks down before engine commits exist, every advance/intimacy/arrival turn will produce a correction loop until the engine commits land.

**Prerequisite — confirm before starting:** Engine pushes go through `append()` in `ledger-store.js`, which does NOT call `validateTransitions`. Verify by reading `append()` in `ledger-store.js` and confirming it only normalizes and pushes — no validation. If this changes in the future, this task's safety argument breaks.

**Files:**
- Modify: `consistency.js` (`ENGINE_OWNED_FIELDS` ~line 38–41)
- Modify: `index.js` (every `drawDivination()` callsite in arrival/foreshadow/intimacy/advance flows)
- Modify: `state-view.js` (readme — remove LLM-facing `S divination last_draw` instruction)
- Modify: `Gravity World Info.json` and `gravity_v15.json` (any `last_draw` write instructions)
- Modify: `scripts/test-relationship.js` (add validation tests)

- [x] **Step 1: Add engine-side commits in `index.js`**

Search `index.js` for `drawDivination(` callsites in `buildAndInjectArrivals` (~886), foreshadow pipeline, intimacy turn handler (~2342), advance handler (~2418), and any other engine-driven divination paths. Immediately after each `drawDivination()` call, push via `append()`:

```javascript
await append([{
    op: 'S',
    e: 'divination',
    id: 'main',  // confirm canonical id from state-compute.js createEmptyState
    d: { f: 'last_draw', v: draw.label },
    t: getCurrentGameTimestamp(),
    r: 'engine: auto-commit on draw',
}]);
```

**Confirm the divination entity id:** open `state-compute.js`, find `createEmptyState`, and check the divination shape. If the readme writes `S divination field=last_draw` with no explicit id, the entity is implicit/singular — match that exact shape. Use `append()` from `ledger-store.js` directly; do not route through the validation pipeline.

- [x] **Step 2: Remove LLM-facing `last_draw` write instructions**

Search `state-view.js` for the readme example teaching `SET divination field=last_draw`. Replace with: "The engine commits divination draws automatically. Do NOT write `divination.last_draw`, `divination.card`, or `divination.orientation` yourself."

Search `Gravity World Info.json` and `gravity_v15.json` for similar instructions; replace with the same guidance.

- [x] **Step 3: Add the `ENGINE_OWNED_FIELDS` entries in `consistency.js`**

Open `consistency.js` and locate the `ENGINE_OWNED_FIELDS` constant. Replace with:

```javascript
const ENGINE_OWNED_FIELDS = {
    collision: new Set(['distance']),
    pressure: new Set(['created_at_tx']),
    relationship: new Set(['card']),
    divination: new Set(['last_draw', 'card', 'orientation']),
};
```

- [x] **Step 4: Verify `validateTransitions` only rejects `S` and `MS`, not `CR`**

Search `consistency.js` for the body of `validateTransitions`. Confirm the `ENGINE_OWNED_FIELDS` check fires only for `tx.op === 'S'` (or `MS`). `CR` must remain unblocked — relationship creation legitimately includes a `card` field (the engine pre-rolls it and embeds it in the correction). If the check covers `CR`, narrow it.

- [x] **Step 5: Add unit tests**

Append to `scripts/test-relationship.js` under a new group. Note: `validateTransitions` returns `{ valid, errors }`, NOT a plain array — destructure correctly.

```javascript
const consistency = require('../consistency.js');

group('ENGINE_OWNED_FIELDS — relationship.card and divination', () => {
    test('S relationship:r1 card="x" is rejected', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'r1', d: { f: 'card', v: 'the-tower' } };
        const { errors } = consistency.validateTransitions([tx], null);
        assert(errors.length > 0, 'expected validation error');
    });

    test('CR relationship:r1 with card field is allowed', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-c1', d: { card: 'the-fool', orientation: 'upright', distance: 'fresh', intensity: 'cold' } };
        const { errors } = consistency.validateTransitions([tx], null);
        assertEqual(errors.length, 0, 'CR must be allowed');
    });

    test('S divination last_draw="..." is rejected', () => {
        const tx = { tx: 1, op: 'S', e: 'divination', id: 'main', d: { f: 'last_draw', v: 'XIV — Temperance' } };
        const { errors } = consistency.validateTransitions([tx], null);
        assert(errors.length > 0, 'expected validation error');
    });
});
```

(Confirm `assert` and `assertEqual` are defined at module scope in `test-relationship.js` before appending — they should be from the existing harness.)

- [x] **Step 6: Run the test**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-relationship.js"`
Expected: all tests pass (existing + 3 new).

- [x] **Step 7: Syntax check**

Run:
```bash
node -c "G:/My Drive/AI RPG/Gravity 2/index.js"
node -c "G:/My Drive/AI RPG/Gravity 2/consistency.js"
node -c "G:/My Drive/AI RPG/Gravity 2/state-view.js"
```
Expected: no output for any.

- [x] **Step 8: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/Gravity World Info.json', 'utf8'))"
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/gravity_v15.json', 'utf8'))"
```
Expected: no output.

- [ ] **Step 9: Manual verification**

1. Trigger a collision arrival (set distance to 0 via OOC on an ACTIVE collision).
2. After the LLM responds, inspect the ledger — there must be exactly one engine-authored `S divination last_draw=...` transaction.
3. If the LLM also tries to write `S divination last_draw`, it will be rejected and a correction queued. Acceptable.
4. Verify the divination panel in the UI shows the engine's draw, not a hallucinated string.

- [x] **Step 10: Single atomic commit**

```bash
git add index.js consistency.js state-view.js scripts/test-relationship.js Gravity\ World\ Info.json gravity_v15.json
git commit -m "feat(divination): engine owns last_draw + auto-commits draws (atomic)"
```

---

### Task 1.4: Update CLAUDE.md to reflect divination ownership

**Files:**
- Modify: `CLAUDE.md`

- [x] **Step 1: Add a Divination section under "Important Patterns"**

After the existing line about divination tables, add:

```markdown
- **Divination ownership:** `divination.last_draw`, `divination.card`, `divination.orientation`, and `relationship.card` are engine-owned. The LLM must never `S` these fields — `consistency.js` rejects such writes. Cards are rolled by `drawDivination()` and committed by the engine on arrival, intimacy, advance, and challenge-action events. Relationship CR with a `card` field is allowed because the engine pre-rolls the card and embeds the slug in the correction message that prompted the CR.
```

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document divination engine-ownership"
```

---

# PHASE 2 — Per-turn rolling ledger compaction

Add a single new primitive in `ledger-store.js`. Implement six pure compaction functions in a new module. Run cheap ones every turn, deep ones every 15 turns. Guard with `diffStates` integrity check.

---

### Task 2.1: Add the `compactTransactions` primitive

**Files:**
- Modify: `ledger-store.js`

- [x] **Step 1: Add the function near `append`**

In `ledger-store.js`, after `append()`, add:

```javascript
/**
 * Apply a pure compaction function to the in-memory transaction array, then persist.
 * The compactFn must return an array (possibly shorter) of valid transaction objects.
 * It is the caller's responsibility to verify replay equivalence before calling persist.
 *
 * @param {(transactions: Array) => Array} compactFn
 * @returns {Promise<{before: number, after: number}>}
 */
async function compactTransactions(compactFn) {
    const before = _transactions.length;
    const result = compactFn(_transactions);
    if (!Array.isArray(result)) {
        throw new Error('compactFn must return an array');
    }
    if (result.length === before) {
        return { before, after: before };  // no-op, skip persist
    }
    _transactions = result;
    await persist();
    return { before, after: _transactions.length };
}
```

- [x] **Step 2: Add to the export list**

In the `export {` block at the bottom, add `compactTransactions,`.

- [x] **Step 3: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/ledger-store.js"`
Expected: no output.

- [x] **Step 4: Commit**

```bash
git add ledger-store.js
git commit -m "feat(ledger): add compactTransactions primitive"
```

---

### Task 2.2: Implement the cheap-compaction module (pure functions)

**Files:**
- Create: `ledger-compactor.js`
- Create: `scripts/test-ledger-compactor.js`

- [x] **Step 1: Write the failing test for `coalesceLastWriteWins` (S ops)**

Create `scripts/test-ledger-compactor.js`:

```javascript
'use strict';
const { coalesceLastWriteWins } = require('../ledger-compactor.js');
const { computeState } = require('../state-compute.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assertEqual(a, b, label) {
    const aj = JSON.stringify(a), bj = JSON.stringify(b);
    if (aj !== bj) throw new Error(`${label}: expected ${bj}, got ${aj}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Helper: produce the same _currentState from compacted vs uncompacted.
function replayEquivalent(uncompacted, compacted) {
    const a = computeState(null, uncompacted);
    const b = computeState(null, compacted);
    delete a._history; delete b._history;
    delete a._lastTxId; delete b._lastTxId;
    return JSON.stringify(a) === JSON.stringify(b);
}

test('coalesceLastWriteWins drops earlier S on same field', () => {
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
        { tx: 2, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'find sword' } },
        { tx: 3, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'find shield' } },
        { tx: 4, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'find armor' } },
    ];
    const out = coalesceLastWriteWins(txs);
    assertEqual(out.length, 2, 'should keep CR + last S');
    assertEqual(out[1].d.v, 'find armor', 'last write must win');
    assert(replayEquivalent(txs, out), 'replay must be equivalent');
});

test('coalesceLastWriteWins keeps S on different fields', () => {
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
        { tx: 2, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'a' } },
        { tx: 3, op: 'S', e: 'char', id: 'c1', d: { f: 'stance', v: 's' } },
    ];
    const out = coalesceLastWriteWins(txs);
    assertEqual(out.length, 3, 'no coalescing across fields');
});

test('coalesceLastWriteWins preserves relationship.last_shift history', () => {
    // last_shift writes must NEVER be coalesced — the runtime reads its history
    // to suppress duplicate resolution corrections.
    const txs = [
        { tx: 1, op: 'CR', e: 'relationship', id: 'pc-c1', d: { card: 'the-fool', distance: 'fresh', intensity: 'cold' } },
        { tx: 2, op: 'S', e: 'relationship', id: 'pc-c1', d: { f: 'last_shift', v: { card: 'the-fool', distance: 'forming' } } },
        { tx: 3, op: 'S', e: 'relationship', id: 'pc-c1', d: { f: 'last_shift', v: { card: 'the-fool', distance: 'established' } } },
    ];
    const out = coalesceLastWriteWins(txs);
    assertEqual(out.length, 3, 'last_shift writes must not be coalesced');
});

test('coalesceLastWriteWins keeps S on different entities', () => {
    const txs = [
        { tx: 1, op: 'S', e: 'char', id: 'a', d: { f: 'x', v: '1' } },
        { tx: 2, op: 'S', e: 'char', id: 'b', d: { f: 'x', v: '1' } },
    ];
    const out = coalesceLastWriteWins(txs);
    assertEqual(out.length, 2, 'no coalescing across entities');
});

test('coalesceMSLastWriteWins keeps last MS for same key', () => {
    const { coalesceMSLastWriteWins } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'A' } },
        { tx: 2, op: 'MS', e: 'char', id: 'c1', d: { f: 'knowledge_asymmetry', k: 'about-bob', v: 'nothing' } },
        { tx: 3, op: 'MS', e: 'char', id: 'c1', d: { f: 'knowledge_asymmetry', k: 'about-bob', v: 'a friend' } },
    ];
    const out = coalesceMSLastWriteWins(txs);
    assertEqual(out.length, 2, 'should keep CR + last MS');
    assertEqual(out[1].d.v, 'a friend', 'last MS wins');
});

test('dropDestroyedEntityTxs removes S/A/MS on destroyed entity', () => {
    const { dropDestroyedEntityTxs } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
        { tx: 2, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'x' } },
        { tx: 3, op: 'D', e: 'char', id: 'c1', d: {} },
        { tx: 4, op: 'CR', e: 'char', id: 'c2', d: { tier: 'KNOWN', name: 'Bob' } },
    ];
    const out = dropDestroyedEntityTxs(txs);
    // c1's CR + S are dropped, D is preserved (it has side effects on relationships/scene_cast).
    assertEqual(out.map(t => t.tx), [3, 4], 'only D and unrelated CR survive');
});

test('cancelAppendRemovePairs drops matched A/R', () => {
    const { cancelAppendRemovePairs } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
        { tx: 2, op: 'A', e: 'char', id: 'c1', d: { f: 'tags', v: 'brave' } },
        { tx: 3, op: 'A', e: 'char', id: 'c1', d: { f: 'tags', v: 'kind' } },
        { tx: 4, op: 'R', e: 'char', id: 'c1', d: { f: 'tags', v: 'brave' } },
    ];
    const out = cancelAppendRemovePairs(txs);
    assertEqual(out.length, 2, 'CR + remaining A=kind survive');
    assertEqual(out[1].d.v, 'kind', 'kind tag remains');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [x] **Step 2: Run the test (must fail — module doesn't exist yet)**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"`
Expected: error `Cannot find module '../ledger-compactor.js'`.

- [x] **Step 3: Create `ledger-compactor.js` with all four cheap compactors**

Write `G:/My Drive/AI RPG/Gravity 2/ledger-compactor.js`:

```javascript
/**
 * ledger-compactor.js — Pure compaction functions over the transaction array.
 *
 * All functions are pure: input array unchanged, return new array.
 * Replay equivalence: computeState(compacted) must equal computeState(original)
 * for the entity state slice (history may differ — see diffStates ignored keys).
 *
 * SAFETY CONSTRAINT: callers must only feed transactions older than the oldest
 * retained snapshot's lastTxId, so rollback windows remain intact.
 */

const TERMINAL_COLLISION_STATUSES = new Set(['RESOLVED', 'CRASHED']);

// (entity, field) pairs whose history must NOT be coalesced. The runtime reads
// `_history['relationship:<id>:last_shift']` (index.js:2044) to suppress
// duplicate resolution corrections — coalescing earlier writes truncates that
// history and re-fires the correction every turn after a relationship resolves.
const COALESCE_PRESERVE_HISTORY = new Set([
    'relationship::last_shift',
]);

function shouldPreserveHistory(entity, field) {
    return COALESCE_PRESERVE_HISTORY.has(`${entity}::${field}`);
}

/**
 * Coalesce consecutive S writes on the same (entity, id, field) — keep only the latest.
 * Preserves order of non-S transactions. Pure overwrite semantics make this safe.
 * Skips (entity, field) pairs listed in COALESCE_PRESERVE_HISTORY.
 */
function coalesceLastWriteWins(transactions) {
    // Walk back-to-front: first S we see for a (e, id, field) is the winner.
    const seen = new Set();
    const keep = new Array(transactions.length).fill(true);
    for (let i = transactions.length - 1; i >= 0; i--) {
        const tx = transactions[i];
        if (tx.op !== 'S') continue;
        const f = tx.d?.f;
        if (typeof f !== 'string') continue;
        if (shouldPreserveHistory(tx.e, f)) continue;  // history-sensitive — never coalesce
        const key = `${tx.e}::${tx.id}::${f}`;
        if (seen.has(key)) {
            keep[i] = false;
        } else {
            seen.add(key);
        }
    }
    return transactions.filter((_, i) => keep[i]);
}

/**
 * Coalesce consecutive MS writes on the same (entity, id, field, key).
 */
function coalesceMSLastWriteWins(transactions) {
    const seen = new Set();
    const keep = new Array(transactions.length).fill(true);
    for (let i = transactions.length - 1; i >= 0; i--) {
        const tx = transactions[i];
        if (tx.op !== 'MS') continue;
        const f = tx.d?.f, k = tx.d?.k;
        if (typeof f !== 'string' || typeof k !== 'string') continue;
        const key = `${tx.e}::${tx.id}::${f}::${k}`;
        if (seen.has(key)) {
            keep[i] = false;
        } else {
            seen.add(key);
        }
    }
    return transactions.filter((_, i) => keep[i]);
}

/**
 * Drop CR/S/A/MS/TR/R/MR transactions that touch entities later destroyed by D.
 * The D transaction itself is preserved (it has side-effects on relationships/scene_cast).
 */
function dropDestroyedEntityTxs(transactions) {
    const destroyed = new Map();  // (e, id) -> first D index
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op === 'D') {
            const key = `${tx.e}::${tx.id}`;
            if (!destroyed.has(key)) destroyed.set(key, i);
        }
    }
    return transactions.filter((tx, i) => {
        if (tx.op === 'D') return true;  // always keep D
        if (tx.op === 'SNAP' || tx.op === 'ROLL' || tx.op === 'AMEND') return true;
        const key = `${tx.e}::${tx.id}`;
        const dIdx = destroyed.get(key);
        if (dIdx === undefined) return true;
        // Keep only if this tx is AFTER the D (e.g. re-create with same id — rare).
        return i > dIdx;
    });
}

/**
 * Cancel A+R pairs on the same (entity, id, field, value) where R follows A
 * with no intervening S that rewrites the whole array.
 */
function cancelAppendRemovePairs(transactions) {
    const drop = new Set();
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op !== 'R') continue;
        const f = tx.d?.f, v = tx.d?.v;
        if (typeof f !== 'string') continue;
        // Walk back to find a matching A; abort if a S on (e,id,f) appears.
        for (let j = i - 1; j >= 0; j--) {
            if (drop.has(j)) continue;
            const prev = transactions[j];
            if (prev.e !== tx.e || prev.id !== tx.id) continue;
            if (prev.op === 'S' && prev.d?.f === f) break;  // wholesale rewrite
            if (prev.op === 'A' && prev.d?.f === f && JSON.stringify(prev.d?.v) === JSON.stringify(v)) {
                drop.add(j);
                drop.add(i);
                break;
            }
        }
    }
    return transactions.filter((_, i) => !drop.has(i));
}

export {
    coalesceLastWriteWins,
    coalesceMSLastWriteWins,
    dropDestroyedEntityTxs,
    cancelAppendRemovePairs,
};
```

**Note:** Use `export { ... }` syntax (NOT `module.exports`). `index.js` is loaded as an ES module by SillyTavern's browser context — it cannot statically `import` a CommonJS module. Test scripts use Node 24's require-of-ESM bridge to load this with `require()`, exactly as `scripts/test-relationship.js` already loads `state-compute.js`.

- [x] **Step 4: Run the test**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"`
Expected: `7 passed, 0 failed`.

- [x] **Step 5: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/ledger-compactor.js"`
Expected: no output.

- [x] **Step 6: Commit**

```bash
git add ledger-compactor.js scripts/test-ledger-compactor.js
git commit -m "feat(compactor): four cheap compactors with replay-equivalence tests"
```

---

### Task 2.3: Add the deep compactors (collision strip + SNAP/ROLL cull)

**Files:**
- Modify: `ledger-compactor.js`
- Modify: `scripts/test-ledger-compactor.js`

- [x] **Step 1: Add tests for the two deep compactors**

Append to `scripts/test-ledger-compactor.js`:

```javascript
test('stripResolvedCollisionIntermediates keeps only terminal TR + outcome S', () => {
    const { stripResolvedCollisionIntermediates } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'CR', e: 'collision', id: 'col1', d: { distance_category: 'NEAR', name: 'Test' } },
        { tx: 2, op: 'S', e: 'collision', id: 'col1', d: { f: 'distance', v: 2 } },
        { tx: 3, op: 'S', e: 'collision', id: 'col1', d: { f: 'name', v: 'Test v2' } },
        { tx: 4, op: 'S', e: 'collision', id: 'col1', d: { f: 'forces', v: 'a vs b' } },
        { tx: 5, op: 'TR', e: 'collision', id: 'col1', d: { f: 'status', from: 'ACTIVE', to: 'RESOLVED' } },
        { tx: 6, op: 'S', e: 'collision', id: 'col1', d: { f: 'outcome_type', v: 'on-screen' } },
    ];
    const out = stripResolvedCollisionIntermediates(txs);
    // Keep: CR (entity birth), TR (terminal), S outcome_type. Drop: distance/name/forces.
    const kept = out.map(t => t.tx);
    assert(kept.includes(1) && kept.includes(5) && kept.includes(6), 'CR/TR/outcome must survive');
    assert(!kept.includes(2) && !kept.includes(3) && !kept.includes(4), 'intermediates must be stripped');
});

test('stripResolvedCollisionIntermediates leaves ACTIVE collisions untouched', () => {
    const { stripResolvedCollisionIntermediates } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'CR', e: 'collision', id: 'col1', d: { distance_category: 'NEAR', name: 'Test' } },
        { tx: 2, op: 'S', e: 'collision', id: 'col1', d: { f: 'distance', v: 2 } },
    ];
    const out = stripResolvedCollisionIntermediates(txs);
    assertEqual(out.length, 2, 'ACTIVE collision intermediates must remain');
});

test('cullSnapAndRoll removes SNAP/ROLL beyond retained window', () => {
    const { cullSnapAndRoll } = require('../ledger-compactor.js');
    const txs = [
        { tx: 1, op: 'SNAP', e: 'system', id: 's1', d: {} },
        { tx: 2, op: 'CR', e: 'char', id: 'c1', d: { tier: 'KNOWN', name: 'A' } },
        { tx: 3, op: 'SNAP', e: 'system', id: 's2', d: {} },
        { tx: 4, op: 'CR', e: 'char', id: 'c2', d: { tier: 'KNOWN', name: 'B' } },
    ];
    // Earliest retained snapshot's lastTxId is 3 — anything earlier than 3 can drop SNAP/ROLL.
    const out = cullSnapAndRoll(txs, 3);
    assert(!out.some(t => t.tx === 1), 'old SNAP must be culled');
    assert(out.some(t => t.tx === 3), 'retained-window SNAP must survive');
});
```

- [x] **Step 2: Run the test (must fail — functions don't exist yet)**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"`
Expected: failures on the three new tests.

- [x] **Step 3: Implement the deep compactors**

Append to `ledger-compactor.js`:

```javascript
/**
 * For collisions whose terminal status is RESOLVED or CRASHED:
 * keep only CR, terminal TR, and S writes to outcome_type/aftermath.
 * Drop intermediate S/MS/TR on distance/name/forces/involved_chars/etc.
 *
 * Engine-rolled distance ticks are also dropped — they're useless once resolved.
 *
 * SEMANTIC CAVEAT: After this compaction runs, AMENDing a RESOLVED collision
 * back to ACTIVE will reset its distance to its CR-time value, not its last
 * pre-resolution value. The intermediate distance history is gone. Document
 * this in CLAUDE.md and surface it in any UI that exposes retcon AMENDs.
 */
function stripResolvedCollisionIntermediates(transactions) {
    // Pass 1: identify resolved collisions and their terminal TR tx index.
    const terminalIdx = new Map();  // collisionId -> terminal TR index
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op === 'TR' && tx.e === 'collision'
            && tx.d?.f === 'status'
            && TERMINAL_COLLISION_STATUSES.has(tx.d?.to)) {
            terminalIdx.set(tx.id, i);
        }
    }
    if (terminalIdx.size === 0) return transactions;

    // Pass 2: for each resolved collision, keep only CR + terminal TR + outcome/aftermath S.
    const KEEP_FIELDS = new Set(['outcome_type', 'aftermath']);
    return transactions.filter((tx, i) => {
        if (tx.e !== 'collision') return true;
        if (!terminalIdx.has(tx.id)) return true;  // not yet resolved
        if (tx.op === 'CR') return true;
        if (i === terminalIdx.get(tx.id)) return true;  // the terminal TR
        if (tx.op === 'S' && KEEP_FIELDS.has(tx.d?.f)) return true;
        return false;
    });
}

/**
 * Drop SNAP and ROLL transactions older than the earliest retained snapshot's lastTxId.
 * computeState already skips these in replay, but they bloat the array.
 */
function cullSnapAndRoll(transactions, oldestRetainedSnapshotLastTxId) {
    if (typeof oldestRetainedSnapshotLastTxId !== 'number') return transactions;
    return transactions.filter(tx => {
        if (tx.op !== 'SNAP' && tx.op !== 'ROLL') return true;
        return tx.tx >= oldestRetainedSnapshotLastTxId;
    });
}

// Add `stripResolvedCollisionIntermediates` and `cullSnapAndRoll` to the
// existing `export { ... }` block at the bottom of the file.
```

- [x] **Step 4: Run the test**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"`
Expected: all 9 tests pass.

- [x] **Step 5: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/ledger-compactor.js"`
Expected: no output.

- [x] **Step 6: Commit**

```bash
git add ledger-compactor.js scripts/test-ledger-compactor.js
git commit -m "feat(compactor): deep compactors for resolved collisions + SNAP/ROLL cull"
```

---

### Task 2.4: Add the integrity-check wrapper

**Files:**
- Modify: `ledger-compactor.js`

- [x] **Step 1: Add the wrapper**

Append to `ledger-compactor.js`:

```javascript
/**
 * Compose multiple compactors and verify replay equivalence.
 * Returns either the compacted array (if equivalent) or the original (if diverged).
 *
 * @param {Array} transactions
 * @param {Array<Function>} compactors - functions that take and return tx arrays
 * @param {Function} computeState - imported from state-compute
 * @param {Function} diffStates - imported from state-compute
 * @returns {{ result: Array, diverged: boolean, diff: Object|null }}
 */
const IGNORED_DIFF_KEYS = new Set(['_history', '_lastTxId']);

function filterDiff(diff) {
    // diffStates returns an object describing differences between two states.
    // We don't care about derived order-sensitive keys. Return only "real"
    // entity-level differences. The exact diff shape — array vs object —
    // is determined by reading state-compute.js:680. Adapt this filter to
    // match. The two cases below cover both common shapes.
    if (!diff) return null;
    if (Array.isArray(diff)) {
        const real = diff.filter(d => !IGNORED_DIFF_KEYS.has(d?.entity ?? d?.key ?? d?.path));
        return real.length > 0 ? real : null;
    }
    if (typeof diff === 'object') {
        const real = Object.entries(diff).filter(([k]) => !IGNORED_DIFF_KEYS.has(k));
        return real.length > 0 ? Object.fromEntries(real) : null;
    }
    return diff;
}

function compactWithIntegrityCheck(transactions, compactors, computeState, diffStates) {
    let working = transactions;
    for (const fn of compactors) {
        working = fn(working);
    }
    const before = computeState(null, transactions);
    const after = computeState(null, working);
    const rawDiff = diffStates(before, after);
    const realDiff = filterDiff(rawDiff);
    if (realDiff) {
        console.warn('[GravityCompactor] Diverged — reverting to uncompacted.', realDiff);
        return { result: transactions, diverged: true, diff: realDiff };
    }
    return { result: working, diverged: false, diff: null };
}

// Add `compactWithIntegrityCheck` to the existing `export { ... }` block.
```

**IMPORTANT:** `diffStates` in `state-compute.js:680` has signature `diffStates(before, after)` — only two arguments. Do NOT pass a third options argument; it is silently ignored and `_history`/`_lastTxId` differences will appear in the diff, causing every compaction to falsely report divergence and revert (the entire compaction system becomes a no-op). The `filterDiff` helper above strips those derived keys instead. Read the actual `diffStates` body before implementing — the `filterDiff` shape may need to be adjusted depending on whether `diffStates` returns an object map or an array of change records.

- [x] **Step 2: Add a test for divergence detection**

Append to `scripts/test-ledger-compactor.js`:

```javascript
test('compactWithIntegrityCheck reverts on divergence', () => {
    const { compactWithIntegrityCheck } = require('../ledger-compactor.js');
    const { computeState } = require('../state-compute.js');
    // Synthetic broken compactor that destroys data.
    const broken = (txs) => txs.filter(tx => tx.op !== 'CR');
    const txs = [
        { tx: 1, op: 'CR', e: 'char', id: 'c1', d: { tier: 'TRACKED', name: 'Alice' } },
        { tx: 2, op: 'S', e: 'char', id: 'c1', d: { f: 'agenda', v: 'x' } },
    ];
    // diffStates may not exist with ignore; pass a stub if needed.
    const stubDiff = (a, b) => {
        const d = {};
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) d[k] = true;
        }
        return d;
    };
    const { result, diverged } = compactWithIntegrityCheck(txs, [broken], computeState, stubDiff);
    assert(diverged, 'must detect divergence');
    assertEqual(result.length, 2, 'must return original');
});
```

- [x] **Step 3: Run the test**

Run: `node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"`
Expected: 10 passed.

- [x] **Step 4: Commit**

```bash
git add ledger-compactor.js scripts/test-ledger-compactor.js
git commit -m "feat(compactor): integrity-check wrapper with revert-on-divergence"
```

---

### Task 2.5: Wire the per-turn rolling compactor into the commit path

**Files:**
- Modify: `index.js`

- [x] **Step 1: Add the static imports**

`index.js` is an ES module (it uses `import` statements). Near the existing imports at the top of the file, add:

```javascript
import * as compactor from './ledger-compactor.js';
import { compactTransactions, getSnapshots } from './ledger-store.js';
// computeState and diffStates should already be imported from state-compute.js;
// confirm and add them to the existing import list if not already there.
```

Use STATIC imports only. Do not use `await import(...)` inside function bodies — `index.js` already statically imports from `ledger-store.js`, and adding dynamic imports inside the function body introduces module-load timing ambiguity in the browser context.

- [x] **Step 2: Add the per-turn compaction function**

Add near other turn-lifecycle helpers in `index.js`:

```javascript
async function runPerTurnCompaction() {
    const snapshots = getSnapshots();  // statically imported at top of file
    if (snapshots.length === 0) return;  // nothing to do until first snapshot exists
    const oldestRetained = Math.min(...snapshots.map(s => s.lastTxId || 0));
    if (!oldestRetained) return;

    const cheapCompactors = [
        compactor.coalesceLastWriteWins,
        compactor.coalesceMSLastWriteWins,
        compactor.dropDestroyedEntityTxs,
        compactor.cancelAppendRemovePairs,
    ];

    await compactTransactions((all) => {
        const safe = all.filter(tx => tx.tx < oldestRetained);
        const unsafe = all.filter(tx => tx.tx >= oldestRetained);
        const { result, diverged } = compactor.compactWithIntegrityCheck(
            safe, cheapCompactors, computeState, diffStates,
        );
        if (diverged) return all;  // abort cleanly
        return result.concat(unsafe);
    });
}
```

- [x] **Step 3: Call after every commit**

Find the commit-completion point in `index.js` (around the auto-snapshot call at ~line 1803). After the commit completes and before the prompt-injection refresh, add:

```javascript
if (mode === 'regular' || mode === 'combat' || mode === 'intimacy') {
    try { await runPerTurnCompaction(); }
    catch (e) { console.warn('[GravityLedger] Per-turn compaction failed:', e); }
}
```

(Skip on `advance` and `integration` to avoid double work alongside the engine's own writes.)

- [x] **Step 4: Add the deep compaction at the auto-snapshot point**

In the same commit-completion block, where the existing 15-turn auto-snapshot fires, add after the snapshot completes:

```javascript
async function runDeepCompaction() {
    const snapshots = getSnapshots();  // statically imported
    if (snapshots.length === 0) return;
    const oldestRetained = Math.min(...snapshots.map(s => s.lastTxId || 0));

    const deepCompactors = [
        compactor.stripResolvedCollisionIntermediates,
        (txs) => compactor.cullSnapAndRoll(txs, oldestRetained),
    ];

    await compactTransactions((all) => {
        const safe = all.filter(tx => tx.tx < oldestRetained);
        const unsafe = all.filter(tx => tx.tx >= oldestRetained);
        const { result, diverged } = compactor.compactWithIntegrityCheck(
            safe, deepCompactors, computeState, diffStates,
        );
        if (diverged) return all;
        return result.concat(unsafe);
    });
}
```

Then call `await runDeepCompaction()` immediately after `createSnapshot(...)` returns.

- [x] **Step 5: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [ ] **Step 6: Manual verification**

1. Open or create a chat with at least 30 turns of activity.
2. Note the transaction count via `OOC: history` or by inspecting `chatMetadata.gravity_ledger.transactions.length` in the browser console.
3. Take 5 more turns.
4. Confirm the transaction count grew by less than the number of `S`/`MS` writes you'd expect — duplicates were coalesced.
5. Take enough turns to cross a 15-turn boundary. Confirm an additional drop in count from deep compaction.
6. Open the state panel and verify entities look identical to before compaction (no missing characters, collisions, factions).

- [x] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(compactor): wire per-turn + deep compaction into commit path"
```

---

### Task 2.6: Extend `OOC: eval` with compactor measurement

**Files:**
- Modify: `ooc-handler.js`

- [x] **Step 1: Read the current `handleEval` body**

Open `ooc-handler.js` and find `handleEval` (or wherever `OOC: eval` is handled). Note the existing output format.

- [x] **Step 2: Add op-type breakdown**

Inside `handleEval`, after the existing output block, add:

```javascript
function summarizeOpTypes(transactions) {
    const counts = {};
    for (const tx of transactions) {
        counts[tx.op] = (counts[tx.op] || 0) + 1;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([op, n]) => `${op}=${n}`)
        .join(' ');
}

const allTxs = getAllTransactions();
const opSummary = summarizeOpTypes(allTxs);

const data = getLedgerData();
const lastCompacted = data.compactionMetrics?.lastSize ?? null;
const ratio = lastCompacted !== null
    ? `${Math.round((1 - allTxs.length / Math.max(lastCompacted, 1)) * 100)}%`
    : 'n/a';

const compactionLine = `Compaction: ${allTxs.length} txs (last pre-compact: ${lastCompacted ?? 'n/a'}, savings: ${ratio}). By op: ${opSummary}`;
```

Append `compactionLine` to the eval output.

- [x] **Step 3: Record `compactionMetrics.lastSize` in `compactTransactions`**

Back in `ledger-store.js`, modify `compactTransactions` to write the pre-compaction size into the chatMetadata:

```javascript
async function compactTransactions(compactFn) {
    const before = _transactions.length;
    const result = compactFn(_transactions);
    if (!Array.isArray(result)) throw new Error('compactFn must return an array');
    if (result.length === before) return { before, after: before };
    const data = getLedgerData();
    if (!data.compactionMetrics) data.compactionMetrics = {};
    data.compactionMetrics.lastSize = before;
    data.compactionMetrics.lastRunAt = new Date().toISOString();
    _transactions = result;
    await persist();
    return { before, after: _transactions.length };
}
```

- [x] **Step 4: Add rollback-target validation to `OOC: rollback to #N`**

After compaction lands, the rollback window is bounded by the oldest retained snapshot. If the user requests a snapshot ID that's been culled, the current `rollback()` in `snapshot-mgr.js` throws `Snapshot N not found` with no human-friendly explanation.

Find `handleRollbackConfirm` (or whatever function processes `OOC: rollback to #N`) in `ooc-handler.js`. Before calling `rollback()`, validate the target:

```javascript
function validateRollbackTarget(targetId) {
    const snapshots = getSnapshots();  // already imported from ledger-store
    if (snapshots.length === 0) {
        return { ok: false, message: 'No snapshots available — nothing to roll back to.' };
    }
    const found = snapshots.find(s => s.id === targetId || s.lastTxId === targetId);
    if (found) return { ok: true };
    const available = snapshots.map(s => `#${s.id ?? s.lastTxId}`).join(', ');
    return {
        ok: false,
        message: `Snapshot #${targetId} is no longer retained. Available snapshots: ${available}. Rollback window is bounded — older snapshots are pruned.`,
    };
}

// Usage at the top of handleRollbackConfirm:
const check = validateRollbackTarget(targetId);
if (!check.ok) {
    insertChatMessage(`[Gravity] ${check.message}`);
    return;
}
```

Match the actual snapshot ID field used in `snapshot-mgr.js` — it may be `id`, `lastTxId`, or `index`. Read the snapshot-creation code in `snapshot-mgr.js` to confirm.

- [x] **Step 5: Syntax check**

Run:
```bash
node -c "G:/My Drive/AI RPG/Gravity 2/ooc-handler.js"
node -c "G:/My Drive/AI RPG/Gravity 2/ledger-store.js"
```
Expected: no output for either.

- [ ] **Step 6: Manual verification**

1. After running for some turns, type `OOC: eval` in chat.
2. Confirm output includes the compaction line with op-type breakdown and savings ratio.
3. Type `OOC: rollback to #999` (an ID that doesn't exist). Confirm a friendly message lists available snapshot IDs instead of an error.

- [x] **Step 7: Commit**

```bash
git add ooc-handler.js ledger-store.js
git commit -m "feat(eval): show compaction metrics + op-type breakdown"
```

---

### Task 2.7: ~~Trim `_nudge_maintenance` slots~~ — KEEP destroyed_cleanup

**Decision:** This task is intentionally DROPPED. Earlier review caught that `dropDestroyedEntityTxs` cleans transaction history but does NOT clean live cross-references in entity arrays (`collision.involved_chars`, `faction.members`, etc.) that may still mention destroyed entity IDs. The `destroyed_cleanup` nudge tells the LLM to issue explicit `R` ops on those live arrays — that's narrative cleanup the engine cannot replace. All seven nudge slots remain.

No code changes for this task. Skip to Phase 3.

---

# PHASE 3 — Cleanup + timeskip removal

Delete all dead code. Remove the timeskip button entirely (per user direction).

---

### Task 3.1: Remove the timeskip button and handler

**Files:**
- Modify: `index.js` (`handleTimeskipButton` and `#gl-input-skip` button)
- Modify: `ui-panel.js` (timeskip button row)
- Modify: `state-view.js` (any readme mention of timeskip)
- Modify: `Gravity World Info.json` (`gravity_mode_timeskip_core` if present)
- Modify: `gravity_v15.json` (any timeskip mode references)

- [ ] **Step 1: Find every reference to timeskip**

Run a grep across the project root:

```bash
grep -rn "timeskip\|Timeskip\|TIMESKIP\|gl-input-skip" "G:/My Drive/AI RPG/Gravity 2/" --include="*.js" --include="*.json" --include="*.md" | grep -v Deprecated | grep -v node_modules
```

Note every match — there will likely be 15–25 sites including the handler, button DOM, mode-key entry, lorebook key, readme mention, etc.

- [ ] **Step 2: Delete `handleTimeskipButton` from `index.js`**

Search for `function handleTimeskipButton` and remove the entire function body (~lines 2404–2435 per audit).

- [ ] **Step 3: Delete the `#gl-input-skip` button creation in `createInputButtons`**

In `index.js` around line 2619, remove the timeskip button DOM creation. (The whole `createInputButtons` function will be deleted in Task 3.5 anyway, but for now remove just the timeskip line so the panel-side button removal is independent.)

- [ ] **Step 4: Delete the timeskip button row in `ui-panel.js`**

Find `data-cmd="timeskip"` (~line 251) and remove the button element.

- [ ] **Step 5: Delete the click handler in `ui-panel.js`**

Find any `_onTimeskip` or `case 'timeskip':` switch arm and remove it.

- [ ] **Step 6: Remove `MODE_LOREBOOK_KEYS.timeskipCore`**

In `index.js` around line 156, remove the `timeskipCore: 'gravity_mode_timeskip_core'` entry.

- [ ] **Step 7: Remove the timeskip lorebook entry from `Gravity World Info.json`**

Search for `gravity_mode_timeskip_core` in `Gravity World Info.json`. Remove that entry (and any associated examples).

- [ ] **Step 8: Update `state-view.js` and `CLAUDE.md` mentions**

In `state-view.js`, remove any readme paragraphs that teach the timeskip flow. In `CLAUDE.md`, remove `_timeskip` from the injection slot list if it's there. Update the turn-modes line: regular / advance / integration / intimacy / combat (drop timeskip).

- [ ] **Step 9: Syntax check**

Run:
```bash
node -c "G:/My Drive/AI RPG/Gravity 2/index.js"
node -c "G:/My Drive/AI RPG/Gravity 2/ui-panel.js"
node -c "G:/My Drive/AI RPG/Gravity 2/state-view.js"
```
Expected: no output for any.

- [ ] **Step 10: Validate JSON files**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/Gravity World Info.json', 'utf8'))"
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/gravity_v15.json', 'utf8'))"
```
Expected: no output.

- [ ] **Step 11: Manual verification**

1. Reload SillyTavern.
2. Open a Gravity-tracked chat.
3. Confirm no timeskip button appears in panel or input bar.
4. Confirm `Advance` still works.
5. Search the chat for any LLM output that mentions timeskip prompts — should be none.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: remove timeskip button and mode entirely (advance is canonical)"
```

---

### Task 3.2: Delete `getPhasePrompt` stub

**Files:**
- Modify: `setup-wizard.js` (~line 42–45)
- Modify: `index.js` (~line 1209–1210)

- [ ] **Step 1: Read the stub**

Open `setup-wizard.js` lines 42–45. The body is `return null;`.

- [ ] **Step 2: Delete the function**

Remove lines 42–45 entirely (the function declaration + body + closing brace).

- [ ] **Step 3: Remove the export entry**

If `getPhasePrompt` is in the `export {}` block at the bottom of `setup-wizard.js`, remove it.

- [ ] **Step 4: Update the caller in `index.js`**

Around line 1209–1210, the caller looks like:
```javascript
const setupPrompt = getPhasePrompt(...);
_setPrompt(`${MODULE_NAME}_setup`, setupPrompt || '');
```

Replace with:
```javascript
_setPrompt(`${MODULE_NAME}_setup`, '');
```

(Or just remove the line entirely if the slot doesn't need to be cleared every turn — verify by checking what other slots do.)

Remove the `getPhasePrompt` import from `index.js` if present.

- [ ] **Step 5: Syntax check**

Run:
```bash
node -c "G:/My Drive/AI RPG/Gravity 2/setup-wizard.js"
node -c "G:/My Drive/AI RPG/Gravity 2/index.js"
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add setup-wizard.js index.js
git commit -m "refactor: delete getPhasePrompt stub"
```

---

### Task 3.3: Delete the `_intimacy` slot clear

**Files:**
- Modify: `index.js` (~line 1368)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the unconditional clear**

Find `_setPrompt(\`${MODULE_NAME}_intimacy\`, '')` near line 1368. Delete the line.

- [ ] **Step 2: Remove `_intimacy` from CLAUDE.md slot list**

In `CLAUDE.md`, find the bullet listing injection slots. Remove `_intimacy`. Also remove `_combat` (also dead per the audit). Update the explanatory text.

- [ ] **Step 3: Verify nothing populates `_intimacy` elsewhere**

Run:
```bash
grep -n "_intimacy" "G:/My Drive/AI RPG/Gravity 2/index.js" "G:/My Drive/AI RPG/Gravity 2/state-view.js"
```
Expected: zero matches after removal.

- [ ] **Step 4: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add index.js CLAUDE.md
git commit -m "refactor: remove dead _intimacy slot clear and CLAUDE.md mentions"
```

---

### Task 3.4: Delete unused `MODE_LOREBOOK_KEYS` entries and duplicate combat keys

**Files:**
- Modify: `index.js` (`MODE_LOREBOOK_KEYS` ~line 148–161)

- [ ] **Step 1: Read the constant and confirm which keys are actually read**

Run:
```bash
grep -n "MODE_LOREBOOK_KEYS" "G:/My Drive/AI RPG/Gravity 2/index.js"
```

The audit identified these as unused: `combatCore`, `combatOptional`, `proseCombat`, `advanceCore`, `advanceOptional`, `proseAdvance`. Confirm by searching for each `MODE_LOREBOOK_KEYS.<key>` reference.

- [ ] **Step 2: Remove the unused entries**

Delete the six entries from `MODE_LOREBOOK_KEYS`. Final shape (after Task 3.1 also drops `timeskipCore`):

```javascript
const MODE_LOREBOOK_KEYS = {
    proseRegular: 'gravity_prose_regular',
    intimacyCore: 'gravity_mode_intimacy_core',
    intimacyOptional: 'gravity_mode_intimacy_optional_examples',
    proseIntimacy: 'gravity_prose_intimacy',
};
```

- [ ] **Step 3: Confirm combat lorebook keys live only in `challenge-profile-combat.js`**

Run:
```bash
grep -n "gravity_mode_combat\|gravity_prose_combat" "G:/My Drive/AI RPG/Gravity 2/" -r --include="*.js"
```
Expected: matches only in `challenge-profile-combat.js`.

- [ ] **Step 4: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "refactor: drop unused MODE_LOREBOOK_KEYS entries"
```

---

### Task 3.5: Delete the duplicate input-bar buttons

**Files:**
- Modify: `index.js` (`createInputButtons` ~line 2609–2629)

- [ ] **Step 1: Find `createInputButtons` and its callsite**

Search `index.js` for `function createInputButtons` and the line that calls it (~line 2600 per audit).

- [ ] **Step 2: Delete the function and the callsite**

Remove the entire `createInputButtons` body and the line that calls it.

- [ ] **Step 3: Remove the input-bar handler functions if they're no longer used**

Search for handlers wired to the deleted buttons (`#gl-input-advance`, `#gl-input-combat`, `#gl-input-intimacy`, `#gl-input-good`). Confirm the panel-side buttons in `ui-panel.js` use their own handlers (not these). Delete any handler functions that are now orphaned.

- [ ] **Step 4: Syntax check**

Run: `node -c "G:/My Drive/AI RPG/Gravity 2/index.js"`
Expected: no output.

- [ ] **Step 5: Manual verification**

1. Reload SillyTavern.
2. Confirm no button row appears above the chat input.
3. Confirm panel command bar buttons (Advance, Combat, Intimacy, Good Turn) still work.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "refactor: remove duplicate input-bar button surface; panel bar is canonical"
```

---

### Task 3.6: Final sweep — remove `Documentation/` archive references and stale lorebook entries

**Files:**
- Modify: `Documentation/system_architecture_reference.md`
- Modify: `Documentation/project_memory.md`

- [ ] **Step 1: Update `system_architecture_reference.md`**

Open the doc. Find the injection-slot list. Remove `_combat`, `_timeskip`, `_intimacy`. Find any "advance/timeskip" sections — replace with "advance" only. Find the entity-type table and confirm it doesn't reference deprecated fields.

- [ ] **Step 2: Update `project_memory.md`**

Add a new entry under `## Durable Notes`:

```markdown
- Timeskip mode and the timeskip button were removed on 2026-04-29. Advance is the only world-tick path. World Info entry `gravity_mode_timeskip_core` was deleted.
- Divination cards (`relationship.card`, `divination.last_draw`, `divination.card`, `divination.orientation`) are engine-owned. The engine rolls and commits; the LLM cannot author or update these fields directly.
- Per-turn rolling ledger compaction added 2026-04-29: cheap dedup runs every regular/combat/intimacy commit; deep compaction runs alongside the 15-turn auto-snapshot. Compaction is bounded by the oldest retained snapshot's lastTxId so rollback windows remain intact.
```

- [ ] **Step 3: Commit**

```bash
git add Documentation/
git commit -m "docs: update architecture reference + memory for cleanup landings"
```

---

### Task 3.7: Run the full validation matrix

- [ ] **Step 1: Syntax-check every JS file**

Run:
```bash
for f in "G:/My Drive/AI RPG/Gravity 2/"*.js; do
  node -c "$f" || echo "FAILED: $f"
done
```
Expected: no FAILED lines.

- [ ] **Step 2: Run all unit tests**

Run:
```bash
node "G:/My Drive/AI RPG/Gravity 2/scripts/test-relationship.js"
node "G:/My Drive/AI RPG/Gravity 2/scripts/test-divination-slug.js"
node "G:/My Drive/AI RPG/Gravity 2/scripts/test-correction-expiry.js"
node "G:/My Drive/AI RPG/Gravity 2/scripts/test-ledger-compactor.js"
```
Expected: all four exit 0 with all tests passing.

- [ ] **Step 3: Validate JSON assets**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/Gravity World Info.json', 'utf8'))"
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/gravity_v15.json', 'utf8'))"
node -e "JSON.parse(require('fs').readFileSync('G:/My Drive/AI RPG/Gravity 2/manifest.json', 'utf8'))"
```
Expected: no output.

- [ ] **Step 4: Manual smoke test in SillyTavern**

1. Open a Gravity-tracked chat (any campaign).
2. Take 5 regular turns. Confirm:
   - No injection errors in the console.
   - The state panel updates correctly each turn.
   - No spurious arrival/foreshadow prompts on previously-resolved collisions.
3. Trigger an advance. Confirm collisions tick down correctly.
4. Trigger a combat. Confirm the combat flow works.
5. Run `OOC: eval`. Confirm the compaction line shows reasonable numbers.
6. Run `OOC: rollback to #N` for some N. Confirm state restores correctly and arrival/foreshadow gates re-fire when expected.

- [ ] **Step 5: Final commit**

If any small fixups were needed during the smoke test, commit them:

```bash
git add -A
git commit -m "chore: smoke-test fixups across cleanup landing"
```

---

## Self-Review Notes

**Spec coverage check:**
- All 5 critical bugs → Phase 0 tasks 0.1–0.5 ✓
- Divination redesign (5 sub-items) → Phase 1 tasks 1.1–1.5 ✓
- Per-turn rolling compaction → Phase 2 tasks 2.1–2.7 ✓
- Dead-code sweep → Phase 3 tasks 3.1–3.6 ✓
- Timeskip removal (user request) → Task 3.1 (most aggressive removal in the plan) ✓

**Type/name consistency check:**
- `cardSlug` used identically across Tasks 1.1, 1.2, 1.3 ✓
- `compactTransactions` signature matches between Tasks 2.1, 2.5, 2.6 ✓
- `compactWithIntegrityCheck` signature matches Task 2.4 definition + Task 2.5 usage ✓
- `runPerTurnCompaction` / `runDeepCompaction` named consistently in Task 2.5 ✓

**Known soft spots that may need adjustment during execution:**
- Exact line numbers cited (e.g. `index.js:2008`, `consistency.js:38`) come from agent reports, not direct re-read at plan-write time. The executor should `grep` for the named identifiers rather than seek the literal line number.
- `diffStates` signature in Task 2.4 assumes an `ignore` parameter exists. If it doesn't, post-process the diff result instead — comment included in the task.
- `state-compute.js` uses ES `export {...}` while `ledger-compactor.js` uses CommonJS `module.exports`. Both work under Node 24's require/ESM bridge. Test scripts use `require()` for both. If browser bundling complains, switch the new module to `export {...}` to match.
- The advance-tick `applyAdvanceTick` ordering issue noted in the audit (issue 6) is correctness-safe today and was not given a task. If the unnecessary triple `computeCurrentState()` calls cause noticeable lag on long campaigns, file a separate optimization plan.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-29-gravity-cleanup-and-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
