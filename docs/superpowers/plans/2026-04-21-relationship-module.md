# Relationship Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class relationship simulation to Gravity Ledger — tarot-archetyped bonds between PC and TRACKED+ characters/factions, with scene-management phonebook, per the spec at [`docs/superpowers/specs/2026-04-21-relationship-module-design.md`](../specs/2026-04-21-relationship-module-design.md).

**Architecture:** New `relationship` entity handled by existing CR/S transaction machinery. Engine-driven status transitions (dormant/active/archived) on tier movements and destruction. Lean phonebook via `pc.scene_cast` / `pc.current_place_id` gates prompt injection. Tags replace single-sentence descriptors for KNOWN characters. Validation layers stack: shape (`consistency.js`) → transitions (`state-machine.js`) → self-correcting loop (`index.js` correction queue).

**Tech Stack:** Pure JavaScript ESM (no build step). Node for local syntax checks and test harness runs. No external test framework — we build a lightweight script-based harness matching existing `scripts/replay-fixture.js` conventions.

**Testing approach:** This codebase has no unit-test framework per [`CLAUDE.md`](../../../CLAUDE.md). We create `scripts/test-relationship.js` — a bespoke node harness that constructs synthetic transaction arrays, runs them through `computeState()`, and asserts the resulting state shape. Every task that touches `state-compute.js`, `consistency.js`, or `state-machine.js` adds test cases here. Rendering tasks (state-view / ui-panel) are harder to unit-test and rely on syntax checks plus comparing rendered output to expected fixtures.

**Git workflow:** Work on current worktree branch `claude/sweet-tharp-ae8b83`. Fast-forward `main` at end. Commit after every task passes.

---

## File Structure

| File | Responsibility | Touched By |
|---|---|---|
| `scripts/test-relationship.js` | **NEW.** Unit-test harness for relationship module | Task 1 (create), every subsequent task adds cases |
| `state-compute.js` | New `relationship` entity handling; faction.tier; char.tags; pc.scene_cast + pc.current_place_id; engine-driven status transitions | Tasks 2, 3, 4, 5, 6 |
| `state-machine.js` | Relationship.status transitions; faction.tier transitions; PRINCIPAL uniqueness guard | Task 7 |
| `consistency.js` | Shape validation for all new fields and the relationship entity | Task 8 |
| `state-view.js` | Relationship dossier block; lean phonebook; KNOWN roll-up with tags; memorials | Tasks 9, 10, 11 |
| `ui-panel.js` | DOM relationship section in character dossier; memorial block | Task 12 |
| `index.js` | Cast auto-add on collision arrival; PRINCIPAL faction auto-cast on advance; correction queue for missing relationship ops | Task 13 |
| `scripts/replay-fixture.js` | New audit sections (relationship, pairing, tags, PRINCIPAL uniqueness, scene_cast) | Task 14 |
| `gravity_v15.json` | Preset grammar + examples for relationship ops, ignition_class=relational, char.tags, faction.tier | Task 15 |

---

## Task 1: Bootstrap Test Harness

**Files:**
- Create: `scripts/test-relationship.js`

- [ ] **Step 1: Create the harness file**

Create `scripts/test-relationship.js`:

```javascript
// scripts/test-relationship.js
// Unit tests for the relationship module. Constructs synthetic transaction
// arrays, runs through computeState(), and asserts resulting state shape.
//
// Usage: node scripts/test-relationship.js
// Exit code: 0 if all pass, 1 if any fail.

'use strict';

const { computeState } = require('../state-compute.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, err });
        console.log(`  ✗ ${name}`);
        console.log(`      ${err.message}`);
    }
}

function group(name, fn) {
    console.log(`\n${name}`);
    fn();
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${label || 'assertEqual'}: expected ${e}, got ${a}`);
    }
}

function assertDeep(actual, expected, label) {
    assertEqual(actual, expected, label);
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// (test groups added by subsequent tasks)

group('harness sanity', () => {
    test('computeState on empty tx array returns empty state', () => {
        const state = computeState(null, []);
        assert(state.characters !== undefined, 'characters collection missing');
        assert(state.collisions !== undefined, 'collisions collection missing');
    });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
        console.log(`  ${f.name}: ${f.err.message}`);
    }
    process.exit(1);
}
```

- [ ] **Step 2: Run the harness to confirm it works**

Run:
```
node scripts/test-relationship.js
```

Expected output includes `1 passed, 0 failed` and exits 0.

- [ ] **Step 3: Commit**

```
git add scripts/test-relationship.js
git commit -m "test: add relationship-module unit-test harness

Bootstrap scripts/test-relationship.js — a lightweight Node harness
that loads state-compute and asserts state shape after synthetic
transaction arrays. Matches the scripts/replay-fixture.js convention
(no external test framework per CLAUDE.md)."
```

---

## Task 2: Relationship Entity — Collection + CR/S Support

**Files:**
- Modify: `state-compute.js:268-284` (getCollectionName map)
- Modify: `state-compute.js:52-78` (createEmptyState)
- Test: `scripts/test-relationship.js` (add test group)

- [ ] **Step 1: Add failing tests**

Append to `scripts/test-relationship.js` (above the `// ─── Summary ───` line):

```javascript
group('relationship entity — CR + S', () => {
    test('CR relationship:pc-lacus creates entity at state.relationships', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool',
                orientation: 'upright',
                nuance: 'First impression.',
                status: 'active',
                last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rel = state.relationships?.['pc-lacus'];
        assert(rel !== undefined, 'relationship not in state.relationships');
        assertEqual(rel.card, 'the-fool', 'card');
        assertEqual(rel.orientation, 'upright', 'orientation');
        assertEqual(rel.status, 'active', 'status');
        assertEqual(rel.last_shift, null, 'last_shift null at birth');
    });

    test('S relationship field=card updates card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool', orientation: 'upright', nuance: 'x', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'relationship', id: 'pc-lacus', d: { f: 'card', v: 'the-hermit' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].card, 'the-hermit', 'card updated');
    });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run:
```
node scripts/test-relationship.js
```

Expected: The `CR relationship:pc-lacus creates entity` test fails because `state.relationships` is undefined.

- [ ] **Step 3: Add `relationship` to `getCollectionName` map**

Edit `state-compute.js` around line 270 (getCollectionName function). Add one entry to the map:

```javascript
function getCollectionName(entityType) {
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        combat: 'combats',
        faction: 'factions',
        place: 'places',
        pressure: 'pressures',
        relationship: 'relationships',   // ← ADD THIS LINE
        world: 'world',
        pc: 'pc',
        divination: 'divination',
    };
    return map[entityType] || entityType;
}
```

- [ ] **Step 4: Add `relationships: {}` to `createEmptyState`**

Edit `state-compute.js` around line 52. Add one line inside the returned object:

```javascript
function createEmptyState() {
    return {
        characters: {},
        constraints: {},
        collisions: {},
        combats: {},
        factions: {},
        places: {},
        pressures: {},
        relationships: {},   // ← ADD THIS LINE
        world: { /* ... */ },
        pc: { /* ... */ },
        divination: { /* ... */ },
        lastTxId: -1,
        _history: {},
    };
}
```

- [ ] **Step 5: Add defensive init in `computeState`**

Edit `state-compute.js` around line 690 (inside computeState, after the `if (!state._history)` and `if (!state.factions)` block). Add:

```javascript
    if (!state.relationships) state.relationships = {};
```

Matches the existing pattern for optional collections.

- [ ] **Step 6: Also add `relationship` to `consistency.js` entity map**

Edit `consistency.js` — both `ENTITY_TO_COLLECTION` (line 20) and `VALID_ENTITIES` (line 44):

```javascript
const ENTITY_TO_COLLECTION = {
    char: 'characters',
    constraint: 'constraints',
    collision: 'collisions',
    combat: 'combats',
    faction: 'factions',
    place: 'places',
    pressure: 'pressures',
    relationship: 'relationships',   // ← ADD
    world: 'world',
    pc: 'pc',
    divination: 'divination',
};

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'relationship', 'world', 'pc', 'divination'];
//                                                                                                         ↑ ADD
```

- [ ] **Step 7: Run tests — expect pass**

Run:
```
node scripts/test-relationship.js
node -c state-compute.js
node -c consistency.js
```

Expected: both test cases pass. Syntax checks return cleanly.

- [ ] **Step 8: Commit**

```
git add state-compute.js consistency.js scripts/test-relationship.js
git commit -m "feat(relationship): add entity type, collection, and CR/S support

Registers 'relationship' in getCollectionName and createEmptyState.
Also registers in consistency.js entity maps so CR/S transactions
pass basic validation. No new validation logic yet — shape checks
land in a later task."
```

---

## Task 3: Faction Tier Field

**Files:**
- Modify: `state-compute.js` (default tier on faction CR — near pressure/place defaults around line 432)
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing test**

Append to `scripts/test-relationship.js`:

```javascript
group('faction.tier', () => {
    test('CR faction with tier=TRACKED stores tier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.zaft.tier, 'TRACKED', 'tier stored');
    });

    test('CR faction without tier defaults to KNOWN', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'shinra', d: { name: 'Shinra' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.shinra.tier, 'KNOWN', 'default tier');
    });

    test('S faction field=tier updates tier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'faction', id: 'zaft', d: { f: 'tier', v: 'PRINCIPAL' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.zaft.tier, 'PRINCIPAL', 'tier updated');
    });
});
```

- [ ] **Step 2: Run tests — expect `default tier` test to fail** (others may pass already since CR assigns fields directly)

Run:
```
node scripts/test-relationship.js
```

Expected: `CR faction without tier defaults to KNOWN` fails — tier is `undefined`.

- [ ] **Step 3: Add tier default in CR case**

Edit `state-compute.js`, inside the CR switch case (around line 427, right after the place defaults):

```javascript
                // Normalize place defaults
                if (tx.e === 'place') {
                    if (!data.reach) data.reach = 'LOCAL';
                    if (!data.state) data.state = 'unknown';
                }
                // Normalize faction defaults — new field in relationship module
                if (tx.e === 'faction') {
                    if (!data.tier) data.tier = 'KNOWN';
                }
```

- [ ] **Step 4: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-compute.js
```

- [ ] **Step 5: Commit**

```
git add state-compute.js scripts/test-relationship.js
git commit -m "feat(relationship): add faction.tier field with KNOWN default

Factions now carry a tier (KNOWN/TRACKED/PRINCIPAL) matching the
character tier convention. Missing tier on CR defaults to KNOWN.
S transactions on tier work via existing S machinery."
```

---

## Task 4: `char.tags` Field + Cap

**Files:**
- Modify: `state-compute.js` (tag cap enforcement)
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing tests**

Append to `scripts/test-relationship.js`:

```javascript
group('char.tags', () => {
    test('CR char with tags stores them', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['smuggler', 'archangel'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['smuggler', 'archangel'], 'tags stored');
    });

    test('CR char with >5 tags keeps only first 5', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN',
              tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['a', 'b', 'c', 'd', 'e'], 'tags capped at 5');
    });

    test('A char field=tags appends and respects cap', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['a', 'b', 'c', 'd'] } },
            { tx: 2, op: 'A', e: 'char', id: 'dak', d: { f: 'tags', v: 'e' } },
            { tx: 3, op: 'A', e: 'char', id: 'dak', d: { f: 'tags', v: 'f' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['a', 'b', 'c', 'd', 'e'], 'append respects cap');
    });
});
```

- [ ] **Step 2: Run tests — expect failures on cap**

Run `node scripts/test-relationship.js`. Expected: the `>5 tags` and `append respects cap` tests fail (no cap enforced).

- [ ] **Step 3: Add `CHARACTER_TAGS_MAX` constant near the top of `state-compute.js`**

Edit `state-compute.js` near line 10 (after `MAX_COLLISION_ARCHIVE`):

```javascript
const MAX_COLLISION_ARCHIVE = 20;
const CHARACTER_TAGS_MAX = 5;   // ← ADD
```

- [ ] **Step 4: Enforce tag cap in CR**

Edit `state-compute.js` inside the CR switch case, after the faction defaults:

```javascript
                if (tx.e === 'faction') {
                    if (!data.tier) data.tier = 'KNOWN';
                }
                // Enforce char.tags cap — new field in relationship module
                if (tx.e === 'char' && Array.isArray(data.tags)) {
                    if (data.tags.length > CHARACTER_TAGS_MAX) {
                        data.tags = data.tags.slice(0, CHARACTER_TAGS_MAX);
                    }
                }
```

- [ ] **Step 5: Enforce cap on A op**

Edit `state-compute.js` in the A (append) switch case, inside the `if (!isDuplicate)` block, after `target[tx.d.f].push(tx.d.v);`:

```javascript
                if (!isDuplicate) {
                    target[tx.d.f].push(tx.d.v);
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}[]`, undefined, tx.d.v, tx);
                    if (tx.e === 'world' && tx.d.f === 'collision_archive') {
                        const arr = state.world.collision_archive;
                        if (Array.isArray(arr) && arr.length > MAX_COLLISION_ARCHIVE) {
                            state.world.collision_archive = arr.slice(-MAX_COLLISION_ARCHIVE);
                        }
                    }
                    // Enforce char.tags cap on append — new field in relationship module
                    if (tx.e === 'char' && tx.d.f === 'tags' && Array.isArray(target.tags) && target.tags.length > CHARACTER_TAGS_MAX) {
                        target.tags = target.tags.slice(0, CHARACTER_TAGS_MAX);
                    }
                }
```

- [ ] **Step 6: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-compute.js
```

- [ ] **Step 7: Commit**

```
git add state-compute.js scripts/test-relationship.js
git commit -m "feat(relationship): add char.tags with 5-entry cap

Characters may carry up to 5 short tag strings for queryable
identification (role, faction-affiliation, location, notable
knowledge). Cap enforced on both CR and A operations; excess
entries dropped silently. Tags are additive metadata — existing
char behavior unchanged when tags unset."
```

---

## Task 5: `pc.scene_cast` + `pc.current_place_id`

**Files:**
- Modify: `state-compute.js:52-78` (createEmptyState — add to pc singleton)
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing tests**

Append to `scripts/test-relationship.js`:

```javascript
group('pc.scene_cast + pc.current_place_id', () => {
    test('empty state has pc.current_place_id and pc.scene_cast defaults', () => {
        const state = computeState(null, []);
        assertEqual(state.pc.current_place_id, '', 'current_place_id default');
        assertEqual(state.pc.scene_cast, [], 'scene_cast default');
    });

    test('S pc field=current_place_id sets it', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:medbay' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.current_place_id, 'place:medbay', 'place id set');
    });

    test('S pc field=scene_cast replaces array (advance-turn semantics)', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:a', 'char:b'] } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:c'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.scene_cast, ['char:c'], 'S replaced cast');
    });

    test('A pc field=scene_cast appends (regular-turn entry semantics)', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:a'] } },
            { tx: 2, op: 'A', e: 'pc', id: '', d: { f: 'scene_cast', v: 'char:b' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.scene_cast, ['char:a', 'char:b'], 'append extended cast');
    });
});
```

- [ ] **Step 2: Run tests — expect `default` test to fail** (`current_place_id` and `scene_cast` don't exist yet)

```
node scripts/test-relationship.js
```

- [ ] **Step 3: Add default fields to `pc` in `createEmptyState`**

Edit `state-compute.js` around line 65:

```javascript
        pc: {
            name: '',
            demonstrated_traits: [],
            current_scene: '',
            current_place_id: '',        // ← ADD
            scene_cast: [],              // ← ADD
        },
```

- [ ] **Step 4: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-compute.js
```

Expected: all pass. S/A on singleton pc already work via existing machinery.

- [ ] **Step 5: Commit**

```
git add state-compute.js scripts/test-relationship.js
git commit -m "feat(relationship): add pc.current_place_id and pc.scene_cast

Completes the location grammar (PC was missing a structured place ref)
and adds the scene_cast phonebook array. S semantics are replace
(advance-turn stage declaration); A semantics are append (regular-turn
character entry). No cast removals mid-stage — stages reset on the
next advance."
```

---

## Task 6: Engine-Driven Status Transitions

**Files:**
- Modify: `state-compute.js` — TR case for char/faction tier, D case
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing tests**

Append to `scripts/test-relationship.js`:

```javascript
function makeRel(id, card, orientation, status) {
    return {
        tx: 100, op: 'CR', e: 'relationship', id, d: {
            card, orientation, nuance: 'x', status: status || 'active', last_shift: null,
        }
    };
}

group('engine-driven relationship.status', () => {
    test('TR char tier TRACKED->KNOWN auto-dormants relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'char', id: 'lacus', d: { f: 'tier', from: 'TRACKED', to: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'dormant', 'auto-dormant on demotion');
    });

    test('TR char tier KNOWN->TRACKED auto-activates dormant relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', status: 'dormant', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'char', id: 'lacus', d: { f: 'tier', from: 'KNOWN', to: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'active', 'auto-active on re-promotion');
    });

    test('D char:id auto-archives relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'archived', 'auto-archive on death');
    });

    test('TR faction tier TRACKED->KNOWN auto-dormants faction relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-zaft', d: {
                card: 'the-chariot', orientation: 'reversed', nuance: 'x', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'faction', id: 'zaft', d: { f: 'tier', from: 'TRACKED', to: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-zaft'].status, 'dormant', 'faction auto-dormant');
    });
});
```

- [ ] **Step 2: Run tests — expect all 4 to fail** (no engine-driven status logic yet)

```
node scripts/test-relationship.js
```

- [ ] **Step 3: Add helper function for engine-driven status transitions**

Edit `state-compute.js`. Add this function near the top, right before `applyTransaction` (around line 395):

```javascript
/**
 * Engine-driven relationship.status adjustment on tier movement or death.
 * Called from TR (tier change) and D (destruction) handlers.
 */
function adjustRelationshipStatus(state, entityType, entityId, newStatus) {
    if (entityType !== 'char' && entityType !== 'faction') return;
    const relId = `pc-${entityId}`;
    const rel = state.relationships?.[relId];
    if (!rel) return;
    if (rel.status === newStatus) return;
    const oldVal = rel.status;
    rel.status = newStatus;
    // Note: no history entry here — engine-driven changes are deterministic
    // and not LLM-originated, so they don't need recordHistory provenance.
}
```

- [ ] **Step 4: Wire the helper into the TR case**

Edit `state-compute.js` inside the TR switch case, after the existing `recordHistory(...)` call (around line 488):

```javascript
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, toVal, tx);
                // Engine-driven relationship.status adjustments on tier movement
                if ((tx.e === 'char' || tx.e === 'faction') && tx.d.f === 'tier') {
                    const TIER_ORDER = ['UNKNOWN', 'KNOWN', 'TRACKED', 'PRINCIPAL'];
                    const fromIdx = TIER_ORDER.indexOf(String(oldVal || '').toUpperCase());
                    const toIdx = TIER_ORDER.indexOf(String(toVal || '').toUpperCase());
                    const trackedIdx = TIER_ORDER.indexOf('TRACKED');
                    if (fromIdx >= trackedIdx && toIdx < trackedIdx) {
                        // Demotion below TRACKED → dormant
                        adjustRelationshipStatus(state, tx.e, tx.id, 'dormant');
                    } else if (fromIdx < trackedIdx && toIdx >= trackedIdx) {
                        // Promotion to TRACKED+ → activate (if a dormant relationship exists)
                        adjustRelationshipStatus(state, tx.e, tx.id, 'active');
                    }
                }
```

Place this block AFTER the existing `Bug 2: on tier demotion, clear fields` block for chars, INSIDE the `if (tx.d.f)` guard.

- [ ] **Step 5: Wire the helper into the D case**

Edit `state-compute.js` inside the D switch case (around line 667):

```javascript
        case 'D': {
            if (!isSingleton) {
                // Engine-driven: archive paired relationship BEFORE deleting entity
                if (tx.e === 'char' || tx.e === 'faction') {
                    adjustRelationshipStatus(state, tx.e, tx.id, 'archived');
                }
                delete state[collection][tx.id];
            }
            break;
        }
```

- [ ] **Step 6: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-compute.js
```

- [ ] **Step 7: Commit**

```
git add state-compute.js scripts/test-relationship.js
git commit -m "feat(relationship): engine-driven status transitions

Tier demotion below TRACKED auto-sets relationship.status=dormant.
Re-promotion to TRACKED+ auto-sets status=active. D (destruction)
auto-sets status=archived BEFORE the entity is removed. These are
deterministic engine actions — LLM never writes relationship.status
directly. Applies to both char and faction pairs (relationship:pc-X)."
```

---

## Task 7: State-Machine Additions — `relationship.status` + PRINCIPAL Uniqueness

**Files:**
- Modify: `state-machine.js` (new transition table + uniqueness validator)
- Modify: `consistency.js` (wire into validateTransition call sites)
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing tests**

Append to `scripts/test-relationship.js`:

```javascript
const { validateTransition } = require('../state-machine.js');

group('state-machine: relationship.status transitions', () => {
    test('active -> dormant allowed', () => {
        const r = validateTransition('relationship', 'status', 'active', 'dormant');
        assertEqual(r.valid, true, 'active->dormant allowed');
    });
    test('dormant -> active allowed', () => {
        const r = validateTransition('relationship', 'status', 'dormant', 'active');
        assertEqual(r.valid, true, 'dormant->active allowed');
    });
    test('active -> archived allowed', () => {
        const r = validateTransition('relationship', 'status', 'active', 'archived');
        assertEqual(r.valid, true, 'active->archived allowed');
    });
    test('archived -> active REJECTED (terminal)', () => {
        const r = validateTransition('relationship', 'status', 'archived', 'active');
        assertEqual(r.valid, false, 'archived is terminal');
    });
});

group('state-machine: faction.tier transitions', () => {
    test('KNOWN -> TRACKED allowed', () => {
        const r = validateTransition('faction', 'tier', 'KNOWN', 'TRACKED');
        assertEqual(r.valid, true, 'promote allowed');
    });
    test('TRACKED -> PRINCIPAL allowed', () => {
        const r = validateTransition('faction', 'tier', 'TRACKED', 'PRINCIPAL');
        assertEqual(r.valid, true, 'promote allowed');
    });
    test('PRINCIPAL -> KNOWN allowed (demotion through TRACKED)', () => {
        // faction transitions are flexible (matches spec — LLM flexibility)
        const r = validateTransition('faction', 'tier', 'PRINCIPAL', 'KNOWN');
        assertEqual(r.valid, true, 'demote allowed');
    });
});
```

- [ ] **Step 2: Run tests — expect failures** (state-machine doesn't know about relationship or faction yet)

```
node scripts/test-relationship.js
```

- [ ] **Step 3: Add relationship.status transition table to state-machine.js**

Edit `state-machine.js`. Add after the COMBAT_TRANSITIONS block (around line 61):

```javascript
// ─── Relationship Status ───────────────────────────────────────────────────────
// active ↔ dormant (tier-driven). Any → archived (terminal, from D).

const RELATIONSHIP_STATUSES = ['active', 'dormant', 'archived'];

const RELATIONSHIP_TRANSITIONS = {
    active:   { dormant: 'dormant', archive: 'archived' },
    dormant:  { activate: 'active', archive: 'archived' },
    archived: {},  // terminal
};

// ─── Faction Tier ──────────────────────────────────────────────────────────────
// Flexible (LLM drives narrative promotion/demotion). PRINCIPAL uniqueness
// is enforced separately via checkPrincipalUniqueness() below.

const FACTION_TIERS = ['KNOWN', 'TRACKED', 'PRINCIPAL'];

const FACTION_TRANSITIONS = {
    KNOWN:     { promote: 'TRACKED', escalate: 'PRINCIPAL' },
    TRACKED:   { promote: 'PRINCIPAL', retire: 'KNOWN' },
    PRINCIPAL: { retire: 'TRACKED', demote: 'KNOWN' },
};
```

- [ ] **Step 4: Register new machines in `validateTransition`**

Edit the `machines` object inside `validateTransition` (around line 81):

```javascript
    const machines = {
        char:         { field: 'tier', transitions: CHARACTER_TRANSITIONS, states: CHARACTER_TIERS },
        constraint:   { field: 'integrity', transitions: CONSTRAINT_TRANSITIONS, states: CONSTRAINT_LEVELS },
        collision:    { field: 'status', transitions: COLLISION_TRANSITIONS, states: COLLISION_STATES },
        combat:       { field: 'status', transitions: COMBAT_TRANSITIONS, states: COMBAT_STATES },
        faction:      { field: 'tier', transitions: FACTION_TRANSITIONS, states: FACTION_TIERS },
        relationship: { field: 'status', transitions: RELATIONSHIP_TRANSITIONS, states: RELATIONSHIP_STATUSES },
    };
```

- [ ] **Step 5: Register new fields in `getStateMachineField`**

Edit around line 175:

```javascript
    const fields = {
        char: 'tier',
        constraint: 'integrity',
        collision: 'status',
        combat: 'status',
        faction: 'tier',
        relationship: 'status',
    };
```

- [ ] **Step 6: Add PRINCIPAL uniqueness validator**

Edit `state-machine.js`. Add a new exported function after `validateTransition` (around line 130):

```javascript
/**
 * PRINCIPAL uniqueness guard. Called on char/faction tier TRs and CRs.
 * Scans the current state and rejects a tier assignment that would
 * produce a second PRINCIPAL of the same entity type.
 *
 * @param {Object} state - the current computed state
 * @param {string} entityType - 'char' or 'faction'
 * @param {string} entityId - id of the entity being changed
 * @param {string} newTier - tier being assigned
 * @returns {ValidationResult}
 */
function checkPrincipalUniqueness(state, entityType, entityId, newTier) {
    if (newTier !== 'PRINCIPAL') return { valid: true };
    const collection = entityType === 'char' ? state.characters : state.factions;
    if (!collection) return { valid: true };
    for (const [id, ent] of Object.entries(collection)) {
        if (id === entityId) continue;  // self — not a conflict
        if (String(ent.tier || '').toUpperCase() === 'PRINCIPAL') {
            return {
                valid: false,
                error: `A PRINCIPAL ${entityType} already exists: "${id}". Max one PRINCIPAL per entity type.`,
                fix: `Demote ${id} to TRACKED first (TR ${entityType}:${id} field=tier from=PRINCIPAL to=TRACKED), then promote ${entityId}.`,
            };
        }
    }
    return { valid: true };
}
```

- [ ] **Step 7: Export the new function**

Edit the `export` block at the bottom of `state-machine.js`:

```javascript
export {
    CHARACTER_TIERS,
    CHARACTER_TRANSITIONS,
    CONSTRAINT_LEVELS,
    CONSTRAINT_TRANSITIONS,
    COLLISION_STATES,
    COLLISION_TRANSITIONS,
    COMBAT_STATES,
    COMBAT_TRANSITIONS,
    FACTION_TIERS,                   // ← ADD
    FACTION_TRANSITIONS,             // ← ADD
    RELATIONSHIP_STATUSES,           // ← ADD
    RELATIONSHIP_TRANSITIONS,        // ← ADD
    validateTransition,
    checkPrincipalUniqueness,        // ← ADD
    getStateMachineField,
};
```

- [ ] **Step 8: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-machine.js
```

All 7 new tests pass.

- [ ] **Step 9: Commit**

```
git add state-machine.js scripts/test-relationship.js
git commit -m "feat(relationship): state-machine transitions + PRINCIPAL uniqueness

Adds RELATIONSHIP_TRANSITIONS (active↔dormant, any→archived terminal)
and FACTION_TRANSITIONS (flexible tier movement). Registers both
with validateTransition and getStateMachineField. Exports a new
checkPrincipalUniqueness(state, type, id, tier) validator for use
at commit time — consistency.js wiring comes in the next task."
```

---

## Task 8: Consistency Shape Validation

**Files:**
- Modify: `consistency.js` — new per-entity validators
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Read current `consistency.js` validator structure**

Before editing, read lines 80–250 of `consistency.js` to understand the existing per-entity validator pattern. The pattern is typically: a single `validateTransaction(tx)` that switch-cases on entity type and returns `{ valid, violations: [] }`.

- [ ] **Step 2: Add failing tests using the validator entry point**

Find the exported entry point used by callers. Based on the header comment, it's `validateTransitions()`. Append to `scripts/test-relationship.js`:

```javascript
const consistency = require('../consistency.js');

group('consistency: relationship shape', () => {
    test('CR relationship with invalid card slug rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'made-up-card', orientation: 'upright', nuance: 'x', status: 'active', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'invalid card should reject');
    });

    test('CR relationship with invalid orientation rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-fool', orientation: 'sideways', nuance: 'x', status: 'active', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'invalid orientation should reject');
    });

    test('CR relationship with valid fields passes', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'reversed', nuance: 'x', status: 'active', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx);
        assert(result.valid, 'valid CR should pass');
    });

    test('CR relationship with bad id format rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'lacus-kira', d: {
            card: 'the-fool', orientation: 'upright', nuance: 'x', status: 'active', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'non-pc-prefixed id should reject');
    });

    test('S relationship last_shift with missing fields rejects', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: { tx: 5, collision_id: 'x' }  // missing from/to/reason
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'incomplete last_shift should reject');
    });

    test('S relationship last_shift=null passes (birth state)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: null
        }};
        const result = consistency.validateTransaction(tx);
        assert(result.valid, 'null last_shift should pass');
    });

    test('CR char with >5 tags rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'char', id: 'dak', d: {
            name: 'Dak', tier: 'KNOWN', tags: ['a','b','c','d','e','f']
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'too many tags should reject');
    });

    test('CR faction with invalid tier rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: {
            name: 'ZAFT', tier: 'SUPREME'
        }};
        const result = consistency.validateTransaction(tx);
        assert(!result.valid, 'invalid tier should reject');
    });
});
```

**Note:** If `consistency.js` does not currently export `validateTransaction`, this test setup needs to use whatever public entry point it does have. Read the file's exports first and adapt accordingly.

- [ ] **Step 3: Run tests — expect failures**

```
node scripts/test-relationship.js
```

- [ ] **Step 4: Add the whitelist and validators**

Edit `consistency.js`. Add near the top, after the existing `ENGINE_OWNED_FIELDS` block:

```javascript
// Major Arcana slugs — the 22-card tarot whitelist for relationship cards.
const MAJOR_ARCANA = new Set([
    'the-fool', 'the-magician', 'the-high-priestess', 'the-empress', 'the-emperor',
    'the-hierophant', 'the-lovers', 'the-chariot', 'strength', 'the-hermit',
    'wheel-of-fortune', 'justice', 'the-hanged-man', 'death', 'temperance',
    'the-devil', 'the-tower', 'the-star', 'the-moon', 'the-sun',
    'judgement', 'the-world',
]);

const RELATIONSHIP_ORIENTATIONS = new Set(['upright', 'reversed']);
const RELATIONSHIP_STATUSES_SET = new Set(['active', 'dormant', 'archived']);
const FACTION_TIERS_SET = new Set(['KNOWN', 'TRACKED', 'PRINCIPAL']);
const CHARACTER_TAGS_MAX = 5;
const CHARACTER_TAG_MAXLEN = 40;

/**
 * Validate the shape of a last_shift value. Null is allowed (birth state).
 * Non-null must be an object with all five fields present.
 */
function isValidLastShift(v) {
    if (v === null) return true;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    return (
        typeof v.tx === 'number' &&
        ('collision_id' in v) &&   // may be null only at initial forced-write; caller typically non-null
        ('from' in v) &&            // may be null or object
        ('to' in v) &&
        typeof v.reason === 'string'
    );
}

/**
 * Validate relationship-specific fields in a CR or S transaction.
 * Called from the main validator.
 */
function validateRelationshipTx(tx) {
    const violations = [];
    // ID format: must be "pc-<suffix>"
    if (tx.op === 'CR') {
        if (typeof tx.id !== 'string' || !tx.id.startsWith('pc-') || tx.id.length <= 3) {
            violations.push({
                field: 'id',
                message: `relationship id must be "pc-<other_id>", got "${tx.id}"`,
                fix: 'Use e.g. relationship:pc-lacus (PC is always first in the pair).',
            });
        }
        const d = tx.d || {};
        if (!MAJOR_ARCANA.has(d.card)) {
            violations.push({
                field: 'card',
                message: `invalid card slug "${d.card}"`,
                fix: `Must be one of the 22 Major Arcana slugs (the-fool, the-lovers, the-tower, ...).`,
            });
        }
        if (!RELATIONSHIP_ORIENTATIONS.has(d.orientation)) {
            violations.push({
                field: 'orientation',
                message: `invalid orientation "${d.orientation}"`,
                fix: 'Must be upright or reversed.',
            });
        }
        if (typeof d.nuance !== 'string' || d.nuance.trim() === '') {
            violations.push({
                field: 'nuance',
                message: 'nuance must be a non-empty string',
                fix: 'Describe the specific expression of the archetype for this pair.',
            });
        }
        if (d.status !== undefined && !RELATIONSHIP_STATUSES_SET.has(d.status)) {
            violations.push({
                field: 'status',
                message: `invalid status "${d.status}"`,
                fix: 'Must be active, dormant, or archived. Usually omit on CR — defaults to active.',
            });
        }
        if (d.last_shift !== undefined && !isValidLastShift(d.last_shift)) {
            violations.push({
                field: 'last_shift',
                message: 'last_shift must be null or {tx, collision_id, from, to, reason}',
                fix: 'Use null at birth; full object on subsequent collision-resolve updates.',
            });
        }
    } else if (tx.op === 'S') {
        const f = tx.d?.f;
        const v = tx.d?.v;
        if (f === 'card' && !MAJOR_ARCANA.has(v)) {
            violations.push({ field: 'card', message: `invalid card slug "${v}"`, fix: 'Major Arcana only.' });
        }
        if (f === 'orientation' && !RELATIONSHIP_ORIENTATIONS.has(v)) {
            violations.push({ field: 'orientation', message: `invalid orientation "${v}"`, fix: 'upright or reversed.' });
        }
        if (f === 'status' && !RELATIONSHIP_STATUSES_SET.has(v)) {
            violations.push({ field: 'status', message: `invalid status "${v}"`, fix: 'active, dormant, or archived.' });
        }
        if (f === 'last_shift' && !isValidLastShift(v)) {
            violations.push({
                field: 'last_shift',
                message: 'last_shift must be null or {tx, collision_id, from, to, reason}',
                fix: 'Null only at birth; afterward, full object.',
            });
        }
    }
    return violations;
}

/**
 * Validate char.tags shape on CR or A.
 */
function validateCharTagsTx(tx) {
    const violations = [];
    let tags = null;
    if (tx.op === 'CR' && Array.isArray(tx.d?.tags)) tags = tx.d.tags;
    if (!tags) return violations;
    if (tags.length > CHARACTER_TAGS_MAX) {
        violations.push({
            field: 'tags',
            message: `char.tags must be ≤ ${CHARACTER_TAGS_MAX} (got ${tags.length})`,
            fix: 'Trim to the most identity-defining tags.',
        });
    }
    for (const t of tags) {
        if (typeof t !== 'string') {
            violations.push({ field: 'tags', message: 'tags must be strings', fix: 'Remove non-string entries.' });
        } else if (t.length > CHARACTER_TAG_MAXLEN) {
            violations.push({ field: 'tags', message: `tag "${t.slice(0, 30)}..." exceeds ${CHARACTER_TAG_MAXLEN} chars`, fix: 'Tags should be 1-3 words.' });
        }
    }
    return violations;
}

/**
 * Validate faction.tier shape on CR or S.
 */
function validateFactionTierTx(tx) {
    const violations = [];
    let tier = null;
    if (tx.op === 'CR') tier = tx.d?.tier;
    else if (tx.op === 'S' && tx.d?.f === 'tier') tier = tx.d?.v;
    if (tier === undefined || tier === null) return violations;
    if (!FACTION_TIERS_SET.has(tier)) {
        violations.push({
            field: 'tier',
            message: `invalid faction.tier "${tier}"`,
            fix: 'Must be KNOWN, TRACKED, or PRINCIPAL.',
        });
    }
    return violations;
}
```

- [ ] **Step 5: Wire the new validators into the main validator**

Find the main per-tx validator function in `consistency.js` (likely named `validateTransaction` or `validateFormat` — read the file). Inside it, after existing per-entity validation, add:

```javascript
    // Relationship-specific shape validation
    if (tx.e === 'relationship' && (tx.op === 'CR' || tx.op === 'S')) {
        const relViolations = validateRelationshipTx(tx);
        violations.push(...relViolations);
    }
    // char.tags shape validation
    if (tx.e === 'char' && (tx.op === 'CR' || tx.op === 'A')) {
        violations.push(...validateCharTagsTx(tx));
    }
    // faction.tier shape validation
    if (tx.e === 'faction' && (tx.op === 'CR' || tx.op === 'S')) {
        violations.push(...validateFactionTierTx(tx));
    }
```

**Note:** if the existing function does not expose `validateTransaction` as a single-tx entry point, add a thin exported wrapper that applies these checks. Read the file's public API first and adapt.

- [ ] **Step 6: Export the new helpers**

At the bottom of `consistency.js`, extend the export block:

```javascript
export {
    // ...existing exports...
    MAJOR_ARCANA,
    validateRelationshipTx,
    validateCharTagsTx,
    validateFactionTierTx,
    validateTransaction,   // if not already exported
};
```

- [ ] **Step 7: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c consistency.js
```

- [ ] **Step 8: Commit**

```
git add consistency.js scripts/test-relationship.js
git commit -m "feat(relationship): consistency shape validation

Adds shape validators for:
- relationship CR/S (id format, card whitelist, orientation enum,
  nuance non-empty, status enum, last_shift null|complete-object)
- char.tags (array-of-strings, ≤5 entries, ≤40 chars each)
- faction.tier (KNOWN|TRACKED|PRINCIPAL enum)

Hard-rejects malformed transactions at commit time. PRINCIPAL
uniqueness guard lives in state-machine (checkPrincipalUniqueness)
and needs separate index.js wiring in the commit pipeline task."
```

---

## Task 9: State-View — Relationship Block in Dossier

**Files:**
- Modify: `state-view.js` — per-character dossier loop (around line 200-250)

- [ ] **Step 1: Read the current character-dossier rendering block**

Read `state-view.js` lines 150–280 to locate where per-character dossiers are rendered inside `formatStateView`. The existing render emits `CHARACTER: <name> [<tier>]` followed by `Location:`, `Agenda:`, `KA:`, constraints, etc.

- [ ] **Step 2: Add the relationship block renderer**

In `state-view.js`, locate the character loop (look for the existing `if (char.agenda)` line around line 220). Add BEFORE it:

```javascript
        // Render tags (if present)
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
        // Render relationship block (if a relationship entity exists for this char)
        const rel = state.relationships?.[`pc-${id}`];
        if (rel && rel.status === 'active') {
            const orientLabel = rel.orientation === 'reversed' ? 'reversed' : 'upright';
            lines.push(`    ♥ Bond (PC): ${formatCardName(rel.card)} · ${orientLabel}`);
            if (rel.nuance) lines.push(`      "${rel.nuance}"`);
        }
```

Add the `formatCardName` helper near the top of `state-view.js`, alongside other render helpers:

```javascript
/**
 * Convert a card slug like "the-hermit" into display form "The Hermit".
 */
function formatCardName(slug) {
    if (!slug || typeof slug !== 'string') return '';
    return slug.split('-').map(w => {
        if (w.length <= 2) return w;  // keep "of" lowercase
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
}
```

- [ ] **Step 3: Apply the same render to factions**

Find the faction dossier loop (around line 450-470 per the earlier grep). Add the same relationship render to each faction where `rel = state.relationships?.['pc-' + factionId]`.

- [ ] **Step 4: Syntax check**

```
node -c state-view.js
```

- [ ] **Step 5: Add a render smoke test**

Append to `scripts/test-relationship.js`:

```javascript
const { formatStateView } = require('../state-view.js');

group('state-view render — relationship block', () => {
    test('active relationship renders with ♥ line', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL', tags: ['idol'] } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'reversed', nuance: 'Hermit because...', status: 'active', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('Bond (PC): The Hermit · reversed'), 'relationship line present');
        assert(rendered.includes('Tags: [idol]'), 'tags line present');
    });

    test('dormant relationship does not render when off-stage', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'reversed', nuance: 'x', status: 'dormant', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(!rendered.includes('Bond (PC): The Hermit'), 'dormant should not render the bond line');
    });
});
```

- [ ] **Step 6: Run tests — expect pass**

```
node scripts/test-relationship.js
```

- [ ] **Step 7: Commit**

```
git add state-view.js scripts/test-relationship.js
git commit -m "feat(relationship): render bond block in char/faction dossiers

Adds the ♥ Bond (PC): <card> · <orientation> line below Agenda in
character and faction dossier renders. Only renders when the
relationship status is 'active'. Tags also render as a compact line
when present. Dormant/archived relationships skip the block at this
layer — the next task (lean phonebook) handles cast-gated rendering
and the on-stage-by-location exception."
```

---

## Task 10: State-View — Lean Phonebook (Cast-Gated Rendering)

**Files:**
- Modify: `state-view.js` — character rendering loop to respect `pc.scene_cast`

- [ ] **Step 1: Identify the existing character rendering loop**

The loop iterates `state.characters`. It currently renders ALL TRACKED+ characters in full dossier form. We need to split into in-cast vs off-stage branches.

- [ ] **Step 2: Add the cast-gating logic**

Wrap the character rendering block (around line 200) with:

```javascript
    const castSet = new Set(state.pc?.scene_cast || []);
    const currentPlace = state.pc?.current_place_id || '';

    // Split characters by on-stage vs off-stage
    const inCast = [];
    const offStagePrincipal = [];
    const offStageTracked = [];
    const dormantOnStageByLocation = [];
    const knownList = [];

    for (const [id, char] of Object.entries(state.characters)) {
        const fqId = `char:${id}`;
        const tier = String(char.tier || '').toUpperCase();
        const onStage = castSet.has(fqId);
        const rel = state.relationships?.[`pc-${id}`];
        const isDormantOnStage = (
            rel && rel.status === 'dormant' &&
            currentPlace && char.location === currentPlace
        );

        if (onStage && (tier === 'TRACKED' || tier === 'PRINCIPAL')) {
            inCast.push([id, char]);
        } else if (tier === 'PRINCIPAL') {
            offStagePrincipal.push([id, char]);
        } else if (tier === 'TRACKED') {
            offStageTracked.push([id, char]);
        } else if (isDormantOnStage) {
            dormantOnStageByLocation.push([id, char, rel]);
        } else if (tier === 'KNOWN') {
            knownList.push([id, char]);
        }
    }
```

- [ ] **Step 3: Render each category**

After the split, replace the existing single-loop rendering with category-specific rendering. Below shows the new structure; adapt by copying the existing in-cast full-dossier render into the `for (const [id, char] of inCast)` block.

```javascript
    // In-cast: full dossier (existing render — copy into this loop)
    for (const [id, char] of inCast) {
        lines.push(`CHARACTER: ${char.name || id} [${char.tier}]`);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
        if (char.agenda) lines.push(`    Agenda: ${normalizeText(char.agenda)}`);
        const rel = state.relationships?.[`pc-${id}`];
        if (rel && rel.status === 'active') {
            lines.push(`    ♥ Bond (PC): ${formatCardName(rel.card)} · ${rel.orientation}`);
            if (rel.nuance) lines.push(`      "${rel.nuance}"`);
        }
        // ...rest of existing dossier render (KA, constraints, key_moments, intimate_history)...
    }

    // Off-stage PRINCIPAL: one-liner with card
    for (const [id, char] of offStagePrincipal) {
        const rel = state.relationships?.[`pc-${id}`];
        const cardFrag = rel && rel.status === 'active'
            ? ` · ${formatCardName(rel.card)} ${rel.orientation}`
            : '';
        const loc = char.location ? ` — last seen ${char.location}` : '';
        lines.push(`PRINCIPAL (off-stage): ${char.name || id}${loc}${cardFrag}`);
    }

    // Off-stage TRACKED: compact line (no card, to save tokens)
    for (const [id, char] of offStageTracked) {
        const loc = char.location ? ` @ ${char.location}` : '';
        const last = char.last_seen_at ? ` · last seen ${char.last_seen_at}` : '';
        lines.push(`TRACKED (off-stage): ${char.name || id}${loc}${last}`);
    }

    // Dormant-on-stage-by-location: compact line WITH card (belt-and-suspenders)
    for (const [id, char, rel] of dormantOnStageByLocation) {
        lines.push(`DORMANT (on-stage): ${char.name || id} · ${formatCardName(rel.card)} ${rel.orientation}`);
        if (rel.nuance) lines.push(`    "${rel.nuance}"`);
    }

    // KNOWN — handled in the next task
```

Faction rendering gets the same treatment — split into in-cast full dossier vs off-stage compact line. PRINCIPAL faction should always render (auto-cast rule).

- [ ] **Step 4: Syntax check**

```
node -c state-view.js
```

- [ ] **Step 5: Add smoke tests**

Append to `scripts/test-relationship.js`:

```javascript
group('lean phonebook — cast gating', () => {
    test('TRACKED char in scene_cast renders full dossier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'n', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('CHARACTER: Lacus [TRACKED]'), 'full dossier for in-cast');
    });

    test('PRINCIPAL char off-stage renders one-liner', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'n', status: 'active', last_shift: null,
            }},
            // scene_cast does NOT include Lacus
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: [] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('PRINCIPAL (off-stage): Lacus'), 'principal off-stage one-liner');
        assert(!rendered.includes('CHARACTER: Lacus [PRINCIPAL]'), 'should NOT render full dossier');
    });

    test('TRACKED char off-stage renders compact line without card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'mu', d: { name: 'Mu', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-mu', d: {
                card: 'the-chariot', orientation: 'upright', nuance: 'n', status: 'active', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: [] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('TRACKED (off-stage): Mu'), 'tracked off-stage one-liner');
        assert(!rendered.includes('The Chariot'), 'should NOT show card for off-stage TRACKED');
    });

    test('dormant char on-stage by location re-injects with card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'flay', d: { name: 'Flay', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-flay', d: {
                card: 'five-of-cups', orientation: 'upright', nuance: 'g', status: 'dormant', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:bridge' } },
            { tx: 4, op: 'S', e: 'char', id: 'flay', d: { f: 'location', v: 'place:bridge' } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('DORMANT (on-stage): Flay'), 'dormant-on-stage re-injects');
    });
});
```

Note: The `five-of-cups` slug is Minor Arcana and will fail consistency validation. For this test, we're bypassing validation by going straight to computeState with a hand-built tx — change the test to use `death` upright as a Major Arcana alternative if needed.

- [ ] **Step 6: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-view.js
```

- [ ] **Step 7: Commit**

```
git add state-view.js scripts/test-relationship.js
git commit -m "feat(relationship): lean phonebook cast-gating in state-view

Split character rendering by scene presence:
- In-cast TRACKED+: full dossier (as before)
- Off-stage PRINCIPAL: one-liner with card (emotional anchor preserved)
- Off-stage TRACKED: compact line, no card (token savings)
- Dormant on-stage by location (char.location == pc.current_place_id):
  compact line WITH card (belt-and-suspenders — LLM might forget to
  append to scene_cast when a dormant char walks back on screen)

Net effect: on chats with 10+ characters, injection drops roughly 60%
vs. rendering every TRACKED+ dossier every turn."
```

---

## Task 11: State-View — KNOWN Roll-Up With Tags

**Files:**
- Modify: `state-view.js`

- [ ] **Step 1: Render KNOWN with top-15 + older roll-up**

In `state-view.js`, replace the `// KNOWN — handled in the next task` placeholder from Task 10 with:

```javascript
    // KNOWN — tag-driven roll-up, top 15 most-recently-active
    if (knownList.length > 0) {
        // Sort by the most recent tx that touched each char (approximate via _history)
        const activity = (id) => {
            const hist = state._history || {};
            let maxTx = 0;
            for (const key of Object.keys(hist)) {
                if (key.startsWith(`char:${id}:`)) {
                    const entries = hist[key];
                    for (const e of entries) if ((e.tx || 0) > maxTx) maxTx = e.tx;
                }
            }
            return maxTx;
        };
        const sorted = knownList.slice().sort(([aId], [bId]) => activity(bId) - activity(aId));
        const TOP_N = 15;
        const top = sorted.slice(0, TOP_N);
        const older = sorted.slice(TOP_N);

        lines.push('');
        lines.push(`KNOWN (${top.length} most-recently-active${older.length ? `; ${older.length} older below` : ''}):`);
        for (const [id, char] of top) {
            const tags = Array.isArray(char.tags) && char.tags.length > 0
                ? ` [${char.tags.join(', ')}]`
                : '';
            const fallback = !tags && char.agenda ? ` — "${normalizeText(char.agenda).slice(0, 80)}"` : '';
            const locFallback = !tags && !char.agenda && char.location ? ` @ ${char.location}` : '';
            lines.push(`  • ${char.name || id}${tags}${fallback}${locFallback}`);
        }
        if (older.length > 0) {
            const names = older.map(([, c]) => c.name || '<unnamed>').join(', ');
            lines.push(`Older KNOWN (${older.length} inactive): ${names}`);
        }
    }
```

- [ ] **Step 2: Syntax check**

```
node -c state-view.js
```

- [ ] **Step 3: Add tests**

Append to `scripts/test-relationship.js`:

```javascript
group('state-view — KNOWN roll-up', () => {
    test('KNOWN chars render with tags', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['smuggler', 'archangel'] } },
            { tx: 2, op: 'CR', e: 'char', id: 'finch', d: { name: 'Old Finch', tier: 'KNOWN', tags: ['engineer'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('• Dak [smuggler, archangel]'), 'Dak with tags');
        assert(rendered.includes('• Old Finch [engineer]'), 'Finch with tag');
    });

    test('KNOWN without tags falls back to agenda', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', agenda: 'Runs the night shift.' } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('• Dak — "Runs the night shift."'), 'agenda fallback');
    });

    test('KNOWN > 15 shows top-15 plus older-rollup', () => {
        const txs = [];
        for (let i = 0; i < 20; i++) {
            txs.push({ tx: i + 1, op: 'CR', e: 'char', id: `k${i}`, d: { name: `K${i}`, tier: 'KNOWN', tags: ['a'] } });
        }
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('Older KNOWN (5 inactive):'), 'older rollup present');
    });
});
```

- [ ] **Step 4: Run tests — expect pass**

```
node scripts/test-relationship.js
```

- [ ] **Step 5: Commit**

```
git add state-view.js scripts/test-relationship.js
git commit -m "feat(relationship): KNOWN roll-up with tags and 15-cap

KNOWN characters now render as a tag-driven list (top 15 most-
recently-active), with an older-than-15 name-only collapsed line.
Falls back to agenda as a descriptor if no tags set, or location
if neither. Keeps KNOWN characters callable by the LLM without
ballooning injection on long chats."
```

---

## Task 12: UI Panel — Relationship Section + Memorials

**Files:**
- Modify: `ui-panel.js` — extend character dossier render

- [ ] **Step 1: Find the dossier render in ui-panel.js**

Read `ui-panel.js` around line 740-800 (where `char.agenda` is currently rendered). The existing code builds DOM strings with classes like `gl-d-row`.

- [ ] **Step 2: Add the relationship render**

In the character dossier builder, right before the `agenda` line, add:

```javascript
    // Relationship block — rendered when relationship:pc-<id> exists and is active
    const rel = state.relationships?.[`pc-${id}`];
    if (rel && rel.status === 'active') {
        const orientClass = rel.orientation === 'reversed' ? 'gl-tarot-reversed' : 'gl-tarot-upright';
        parts.push(`<div class="gl-d-row gl-relationship ${orientClass}">♥ <b>${esc(formatCardName(rel.card))}</b> · ${esc(rel.orientation)}</div>`);
        if (rel.nuance) {
            parts.push(`<div class="gl-d-row gl-relationship-nuance">"${esc(rel.nuance)}"</div>`);
        }
    }
```

Ensure `formatCardName` is imported or defined in `ui-panel.js` (copy the helper from state-view.js or import it).

- [ ] **Step 3: Add memorial section**

At the end of the character-panel loop, add an `archived` memorial section:

```javascript
    // Memorials — archived relationships, collapsed by default
    const archived = Object.entries(state.relationships || {}).filter(([, r]) => r.status === 'archived');
    if (archived.length > 0) {
        parts.push(`<details class="gl-memorials"><summary>Memorials (${archived.length})</summary>`);
        for (const [relId, r] of archived) {
            const pair = relId.replace(/^pc-/, '');
            const finalShift = r.last_shift
                ? ` (tx ${r.last_shift.tx}: ${r.last_shift.reason})`
                : '';
            parts.push(`<div class="gl-memorial">${esc(pair)} · ${esc(formatCardName(r.card))} ${esc(r.orientation)}${esc(finalShift)}</div>`);
        }
        parts.push('</details>');
    }
```

- [ ] **Step 4: Add CSS for the new classes**

Edit `style.css`. Add:

```css
.gl-relationship { font-weight: 600; margin-top: 4px; }
.gl-tarot-upright { color: #c9a84e; }  /* muted gold */
.gl-tarot-reversed { color: #b85c5c; }  /* muted red */
.gl-relationship-nuance { font-style: italic; color: #aaa; margin-left: 1em; }
.gl-memorials { margin-top: 1em; font-size: 0.9em; color: #888; }
.gl-memorials summary { cursor: pointer; }
.gl-memorial { margin-left: 1em; }
```

- [ ] **Step 5: Syntax check**

```
node -c ui-panel.js
```

- [ ] **Step 6: Manual verification note**

The UI panel renders in a live SillyTavern browser session. Automated testing is not feasible for DOM output. Load the extension in SillyTavern with a test chat that has an active relationship and verify:
- The ♥ bond line appears in the character dossier
- Upright cards render in muted gold
- Reversed cards render in muted red
- Archived relationships appear at the bottom in a collapsed `<details>` block

- [ ] **Step 7: Commit**

```
git add ui-panel.js style.css
git commit -m "feat(relationship): UI panel dossier block + memorials

Adds a heart-glyph bond line in each character's dossier (only when
relationship is active), with muted-gold/red color coding for
orientation. Archived relationships collapse into a <details>
memorial section at the bottom of the panel. Requires manual
verification in a live ST session — no DOM test infrastructure."
```

---

## Task 13: Index.js — Auto-Cast Hooks

**Files:**
- Modify: `index.js` — hook into collision-arrival and advance-turn flows

- [ ] **Step 1: Find the collision-arrival hook site**

Search `index.js` for `_firedCollisionArrivals` (the existing Set that tracks arrivals) and the place where a collision reaches distance 0 on PC's stage. That's where the cast auto-append should land.

- [ ] **Step 2: Add cast auto-append on collision arrival**

At the collision-arrival hook site (after the arrival is detected but before the sanity-check injection), add:

```javascript
    // Auto-add involved_chars to pc.scene_cast when a collision arrives on stage
    if (collision.status === 'ACTIVE' && collision.distance === 0) {
        const involved = Array.isArray(collision.involved_chars) ? collision.involved_chars : [];
        const currentCast = Array.isArray(state.pc?.scene_cast) ? state.pc.scene_cast : [];
        const newEntries = involved.filter(id => id !== 'pc' && !currentCast.includes(id));
        if (newEntries.length > 0) {
            for (const id of newEntries) {
                // Emit an A tx on pc.scene_cast — committed through normal machinery
                const tx = {
                    tx: nextTxId(),  // use existing tx-id helper
                    t: currentTimestamp(),
                    _ts: new Date().toISOString(),
                    op: 'A',
                    e: 'pc',
                    id: '',
                    d: { f: 'scene_cast', v: id },
                    r: `Auto-added to cast: collision ${collision.id} arrived on stage`,
                };
                appendTransaction(tx);  // use existing commit helper
            }
        }
    }
```

(Adapt function names `nextTxId`, `currentTimestamp`, `appendTransaction` to whatever the existing `index.js` uses.)

- [ ] **Step 3: Add PRINCIPAL faction auto-cast on advance turns**

At the advance-turn handler in `index.js`, after state has been updated from the LLM's ledger block:

```javascript
    if (turnMode === 'advance') {
        // Ensure PRINCIPAL factions are always in scene_cast
        const principalFactions = Object.entries(state.factions || {})
            .filter(([, f]) => String(f.tier || '').toUpperCase() === 'PRINCIPAL')
            .map(([id]) => `faction:${id}`);
        const currentCast = Array.isArray(state.pc?.scene_cast) ? state.pc.scene_cast : [];
        const missing = principalFactions.filter(id => !currentCast.includes(id));
        for (const id of missing) {
            appendTransaction({
                tx: nextTxId(),
                t: currentTimestamp(),
                _ts: new Date().toISOString(),
                op: 'A',
                e: 'pc',
                id: '',
                d: { f: 'scene_cast', v: id },
                r: 'Auto-added: PRINCIPAL faction always in cast',
            });
        }
    }
```

- [ ] **Step 4: Add correction-queue entries for missing relationship updates**

Find the correction-queue mechanism in `index.js` (the `_inject` slot / `MAX_CORRECTION_ATTEMPTS` logic). After the post-commit state update, scan for:

1. TRACKED+ chars/factions without a paired `relationship:pc-<id>`
2. RESOLVED relational collisions whose relationship wasn't updated in the same tx group

For each, queue a correction prompt:

```javascript
    // Correction: missing relationship entity after tier promotion
    for (const [id, char] of Object.entries(state.characters)) {
        const tier = String(char.tier || '').toUpperCase();
        if ((tier === 'TRACKED' || tier === 'PRINCIPAL') && !state.relationships?.[`pc-${id}`]) {
            queueCorrection({
                kind: 'missing-relationship',
                entity: `char:${id}`,
                prompt: `You promoted char:${id} to ${tier}, but relationship:pc-${id} was not created. Draw the card now:\n  CR relationship:pc-${id} card="<slug>" orientation="upright|reversed" nuance="<1-sentence expression of the archetype for this pair>"`,
            });
        }
    }
    // (mirror for faction)

    // Correction: RESOLVED relational collision with no relationship update
    for (const [cid, col] of Object.entries(state.collisions)) {
        if (col.ignition_class !== 'relational') continue;
        if (col.status !== 'RESOLVED' && col.status !== 'CRASHED') continue;
        // Determine the paired relationship from involved_chars
        const other = (col.involved_chars || []).find(x => x !== 'pc');
        if (!other) continue;
        const relId = other.replace(/^(char|faction):/, 'pc-');
        const rel = state.relationships?.[relId];
        if (!rel) continue;
        // Check: did last_shift.collision_id match this collision?
        const lsCollision = rel.last_shift?.collision_id;
        if (lsCollision !== cid) {
            queueCorrection({
                kind: 'missing-relationship-update',
                entity: `collision:${cid}`,
                prompt: `collision:${cid} resolved but relationship:${relId} was not updated. Commit the card/orientation/nuance/last_shift now inside a LEDGER block.`,
            });
        }
    }
```

`queueCorrection` matches whatever the existing correction injector is called — read `index.js` to find the current naming.

- [ ] **Step 5: Syntax check**

```
node -c index.js
```

- [ ] **Step 6: Commit**

```
git add index.js
git commit -m "feat(relationship): index.js auto-cast + correction hooks

Three new hook behaviors:
1. Collision arrival at distance 0 auto-appends involved_chars to
   pc.scene_cast (fires only for chars not already in cast, dedupes).
2. Advance turns auto-add PRINCIPAL factions to scene_cast if missing
   (per spec: PRINCIPAL faction is always in cast).
3. Correction queue gains two new rules: TRACKED+ entities without
   paired relationships, and RESOLVED relational collisions whose
   last_shift.collision_id doesn't match the collision that resolved.

All hooks use existing tx-emission and correction-queue machinery —
no new injection slots or persistence paths introduced."
```

---

## Task 14: Replay Harness Audits

**Files:**
- Modify: `scripts/replay-fixture.js`

- [ ] **Step 1: Add the new audit sections**

Append to `scripts/replay-fixture.js` (before the existing exit logic at the bottom):

```javascript
// ─── Relationship audit ───────────────────────────────────────────────────────
console.log('\n--- Relationship audit ---');
let relProblems = false;
// TRACKED+ chars should have a relationship
for (const [id, char] of Object.entries(state.characters || {})) {
    const tier = String(char.tier || '').toUpperCase();
    if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
    const rel = state.relationships?.[`pc-${id}`];
    if (!rel) {
        console.log(`  MISSING: char:${id} [${tier}] has no relationship:pc-${id}`);
        relProblems = true;
    } else if (rel.status === 'archived') {
        console.log(`  STALE: char:${id} is ${tier} but relationship:pc-${id} is archived`);
        relProblems = true;
    }
}
// Orphan: relationship exists but target doesn't
for (const [relId, rel] of Object.entries(state.relationships || {})) {
    if (!relId.startsWith('pc-')) continue;
    const otherId = relId.slice('pc-'.length);
    const charExists = state.characters?.[otherId];
    const factionExists = state.factions?.[otherId];
    if (!charExists && !factionExists && rel.status !== 'archived') {
        console.log(`  ORPHAN: ${relId} exists but target ${otherId} does not`);
        relProblems = true;
    }
}
if (!relProblems) console.log('(none)');

// ─── Collision-relationship pairing audit ─────────────────────────────────────
console.log('\n--- Collision-relationship pairing audit ---');
let pairingProblems = false;
for (const [cid, col] of Object.entries(state.collisions || {})) {
    if (col.ignition_class !== 'relational') continue;
    if (col.status !== 'RESOLVED' && col.status !== 'CRASHED') continue;
    const other = (col.involved_chars || []).find(x => x !== 'pc');
    if (!other) {
        console.log(`  MALFORMED: collision:${cid} is relational but involved_chars has no non-pc party`);
        pairingProblems = true;
        continue;
    }
    const relId = other.replace(/^(char|faction):/, 'pc-');
    const rel = state.relationships?.[relId];
    if (!rel) {
        console.log(`  MISSING-REL: collision:${cid} resolved for ${relId} but relationship does not exist`);
        pairingProblems = true;
        continue;
    }
    if (rel.last_shift?.collision_id !== cid) {
        console.log(`  MISSING-UPDATE: collision:${cid} resolved but relationship:${relId}.last_shift.collision_id != "${cid}"`);
        pairingProblems = true;
    }
}
if (!pairingProblems) console.log('(none)');

// ─── Tag audit ─────────────────────────────────────────────────────────────────
console.log('\n--- Tag audit ---');
let tagProblems = false;
for (const [id, char] of Object.entries(state.characters || {})) {
    const tags = char.tags;
    if (!Array.isArray(tags)) continue;
    if (tags.length > 5) {
        console.log(`  ${id}: ${tags.length} tags (cap 5)`);
        tagProblems = true;
    }
    for (const t of tags) {
        if (typeof t !== 'string') {
            console.log(`  ${id}: non-string tag ${JSON.stringify(t)}`);
            tagProblems = true;
        } else if (t.length > 40) {
            console.log(`  ${id}: tag "${t.slice(0, 30)}..." exceeds 40 chars`);
            tagProblems = true;
        }
    }
}
if (!tagProblems) console.log('(none)');

// ─── PRINCIPAL uniqueness audit ───────────────────────────────────────────────
console.log('\n--- PRINCIPAL uniqueness audit ---');
const principalChars = Object.entries(state.characters || {}).filter(([, c]) => String(c.tier || '').toUpperCase() === 'PRINCIPAL');
const principalFactions = Object.entries(state.factions || {}).filter(([, f]) => String(f.tier || '').toUpperCase() === 'PRINCIPAL');
let uniqProblems = false;
if (principalChars.length > 1) {
    console.log(`  MULTIPLE PRINCIPAL chars: ${principalChars.map(([id]) => id).join(', ')}`);
    uniqProblems = true;
}
if (principalFactions.length > 1) {
    console.log(`  MULTIPLE PRINCIPAL factions: ${principalFactions.map(([id]) => id).join(', ')}`);
    uniqProblems = true;
}
if (!uniqProblems) console.log('(one or zero PRINCIPAL of each type)');

// ─── Scene cast audit ──────────────────────────────────────────────────────────
console.log('\n--- Scene cast audit ---');
const cast = state.pc?.scene_cast || [];
let castProblems = false;
for (const ref of cast) {
    if (typeof ref !== 'string' || !ref.includes(':')) {
        console.log(`  MALFORMED: "${ref}" is not a valid entity ref`);
        castProblems = true;
        continue;
    }
    const [type, id] = ref.split(':');
    const exists = (type === 'char' && state.characters?.[id]) ||
                   (type === 'faction' && state.factions?.[id]);
    if (!exists) {
        console.log(`  DANGLING: scene_cast has "${ref}" but entity does not exist`);
        castProblems = true;
    }
}
if (cast.length > 6) {
    console.log(`  OVERFULL: scene_cast has ${cast.length} members (soft cap 6)`);
    castProblems = true;
}
if (!castProblems) console.log('(none)');
```

- [ ] **Step 2: Run the harness against an existing fixture**

```
node scripts/replay-fixture.js "Tests/Lacus Clyne - 2026-04-20@19h50m41s772ms/Lacus Clyne - 2026-04-20@19h50m41s772ms.json"
```

Expected: the new audit sections print. Existing fixtures pre-date the relationship module, so:
- Relationship audit: MISSING entries for every TRACKED+ char (expected — fixture is pre-feature)
- Collision-relationship pairing audit: (none) (no relational collisions in old fixtures)
- Tag audit: (none)
- PRINCIPAL uniqueness audit: whatever the fixture has
- Scene cast audit: empty cast → (none)

These "MISSING" entries on old fixtures are expected and not failures — the spec says fresh chats only.

- [ ] **Step 3: Commit**

```
git add scripts/replay-fixture.js
git commit -m "test(relationship): extend replay harness with 5 new audits

New audit sections:
- Relationship audit (TRACKED+ entities paired with active relationships)
- Collision-relationship pairing (resolved relational collisions updated
  their relationships)
- Tag audit (≤5 per char, ≤40 chars each)
- PRINCIPAL uniqueness (≤1 char, ≤1 faction)
- Scene cast audit (no dangling refs, soft cap 6)

Old fixtures will show MISSING relationship entries — expected since
this module lands fresh. Fresh chats that exercise the module should
pass all sections with (none)."
```

---

## Task 15: Preset Updates — `gravity_v15.json`

**Files:**
- Modify: `gravity_v15.json` — add grammar + examples

- [ ] **Step 1: Identify the relevant preset sections**

The preset is a large JSON file. Read `gravity_v15.json` sections for: entity grammar reference, CREATE/SET/MOVE examples, collision syntax, faction syntax.

- [ ] **Step 2: Add relationship entity grammar**

In the entity-grammar section, add:

```
RELATIONSHIP — paired PC ↔ TRACKED+ char/faction bond. Tarot-archetyped.

  > CREATE relationship:pc-<other_id> card="<major-arcana-slug>" orientation="upright|reversed" nuance="<specific expression of this bond>" -- On tier promotion to TRACKED+

  > SET relationship:pc-<other_id> field=card value="<new-slug>" -- Only inside a resolving relational collision block
  > SET relationship:pc-<other_id> field=orientation value="upright|reversed" -- Same rule
  > SET relationship:pc-<other_id> field=nuance value="<updated expression>" -- Same rule
  > SET relationship:pc-<other_id> field=last_shift value={tx, collision_id, from:{card,orientation}, to:{card,orientation}, reason} -- Stamp what moved

  The 22 Major Arcana slugs:
    the-fool, the-magician, the-high-priestess, the-empress, the-emperor,
    the-hierophant, the-lovers, the-chariot, strength, the-hermit,
    wheel-of-fortune, justice, the-hanged-man, death, temperance,
    the-devil, the-tower, the-star, the-moon, the-sun, judgement, the-world

  RULE: every relationship content change (card, orientation, nuance)
  must happen inside the same ledger block as a resolving relational
  collision (ignition_class=relational, involved_chars=[pc, <other>]).

  RULE: status (active/dormant/archived) is engine-written on tier
  movement or D. LLM never writes status.

  RULE: at character/faction tier promotion to TRACKED+, the same
  ledger block MUST include CR relationship:pc-<id> with the drawn
  initial card. No collision required for birth.
```

- [ ] **Step 3: Add relational collision example**

In the collision examples section, add:

```
> CREATE collision:lacus-rupture name="The Conversation She Can't Avoid" distance_category=SHORT ignition_class=relational fires_when="PC confronts Lacus about the Manifold signal or Lacus names what she's been watching" forces="her growing clarity about what he is, his avoidance" cost="The bond shifts — Hermit reversed becomes Tower upright. Trust rebuilt on honest ground, or ruptured." involved_chars=[pc, char:lacus] location=place:archangel-medbay -- Relational seam
```

- [ ] **Step 4: Add faction.tier guidance**

In the faction section:

```
> CREATE faction:zaft name="ZAFT" territory=[place:plant-home] state="dominant" agenda="..." tier="PRINCIPAL" -- Max 1 PRINCIPAL faction

  tier values: KNOWN (exists, not active), TRACKED (exerts gravity; gets a
  relationship card), PRINCIPAL (defines the story arc; always in scene_cast;
  max one per chat).
```

- [ ] **Step 5: Add char.tags guidance**

In the char section:

```
> CREATE char:dak name="Dak" tier=KNOWN tags=[smuggler,archangel-contact,zaft-sympathizer] -- Max 5 tags, kebab-case

  Tags are queryable identity markers — role, faction-affiliation,
  location-association, notable-knowledge. KNOWN characters render from
  tags; TRACKED+ render full dossier + tags. 5 tag cap enforced.
```

- [ ] **Step 6: Add phonebook grammar**

In the pc section:

```
On advance turns, declare the stage:

> SET pc field=current_place_id value=place:archangel-medbay -- Where PC is now
> SET pc field=scene_cast value=[char:lacus, char:mu, faction:zaft] -- Active cast for this stage

On regular turns, append on entry:

> APPEND pc field=scene_cast value=char:athrun -- Character walks into the scene

Cast is constant across regular turns within a stage. Advance turns
replace; regular turns append only. No mid-stage removals.
```

- [ ] **Step 7: Syntax check the JSON**

```
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json', 'utf8')); console.log('OK')"
```

Expected: `OK`. JSON parsing succeeds.

- [ ] **Step 8: Commit**

```
git add gravity_v15.json
git commit -m "feat(relationship): preset grammar + examples in gravity_v15

Updates preset with:
- relationship entity grammar (CR/S with Major Arcana slugs)
- ignition_class=relational collision example
- faction.tier guidance (KNOWN/TRACKED/PRINCIPAL)
- char.tags guidance (5 cap, kebab-case)
- pc.scene_cast/current_place_id phonebook grammar

The LLM needs these in the preset to know when/how to write the new
entity types and fields. Without this update, the code supports the
module but the LLM won't produce the right transactions."
```

---

## Task 16: Fast-Forward Main and Push

**Files:** (none — git only)

- [ ] **Step 1: Verify all tests pass**

```
node scripts/test-relationship.js
node -c state-compute.js
node -c state-machine.js
node -c consistency.js
node -c state-view.js
node -c ui-panel.js
node -c index.js
```

All commands exit 0.

- [ ] **Step 2: Fast-forward main**

From the parent repo directory:

```
cd "D:/claude/Gravity Preset/Gravity-Extension"
git merge --ff-only claude/sweet-tharp-ae8b83
```

- [ ] **Step 3: Push (with user confirmation)**

```
git push origin main
```

Ask the user before pushing — this is a visible action and should not happen without explicit approval.

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| Entity schema (relationship) | Task 2 |
| pc.current_place_id + scene_cast | Task 5 |
| faction.tier | Task 3 |
| char.tags | Task 4 |
| Birth (same-block CR rule) | Task 13 (correction queue detects missing pair) |
| Change (every change is a collision) | Task 13 (correction queue detects missing last_shift.collision_id) |
| Dormancy (engine-driven) | Task 6 |
| Death (engine-driven archive) | Task 6 |
| Phonebook lifecycle | Task 5 (fields), Task 13 (PRINCIPAL faction auto-cast, collision arrival hook) |
| Cast-gated injection | Task 10 |
| KNOWN roll-up with tags | Task 11 |
| Relationship block rendering | Task 9 |
| Memorials | Task 12 (ui-panel) |
| Shape validation | Task 8 |
| Transitions (PRINCIPAL uniqueness, relationship.status) | Task 7 |
| Self-correcting loop | Task 13 |
| Replay harness audits | Task 14 |
| Preset grammar | Task 15 |

No gaps.

**Placeholder scan:** No TBDs, no "implement later". All code steps contain actual code. Some steps reference "existing helpers" (e.g., `nextTxId`, `appendTransaction` in index.js) that need to be matched to real function names when reading the file — this is unavoidable without reading index.js in full during plan writing.

**Type consistency check:** `formatCardName` is defined in state-view.js (Task 9) and referenced in ui-panel.js (Task 12). Task 12 notes: "Ensure formatCardName is imported or defined in ui-panel.js (copy the helper from state-view.js or import it)."

`adjustRelationshipStatus` is defined in state-compute.js (Task 6) and not referenced outside — good.

`validateRelationshipTx`, `validateCharTagsTx`, `validateFactionTierTx` are defined in consistency.js (Task 8) and wired into the main validator in the same task.

`checkPrincipalUniqueness` is defined in state-machine.js (Task 7) but not wired into the commit pipeline in a code step. This is a gap — the validator exists but isn't called. **Fixing inline:** add wiring in Task 8 Step 5 so consistency.js's main validator calls `checkPrincipalUniqueness(state, tx.e, tx.id, newTier)` on char/faction CR or tier-TR.

---

## Gap Fix: Wire PRINCIPAL Uniqueness Guard

**Files:**
- Modify: `consistency.js` — call `checkPrincipalUniqueness` in the main validator path

This is actually a subtle issue: `checkPrincipalUniqueness` needs access to the **current state**, which the shape validator doesn't typically have. It needs to be called at a different layer — the state-machine-transition check in the commit pipeline (wherever `validateTransition` is called from).

- [ ] **Step 1: Locate the `validateTransition` call site in index.js**

Per CLAUDE.md, `validateTransition()` is called from `index.js:1514`. Find that call.

- [ ] **Step 2: Add a PRINCIPAL uniqueness check right after**

```javascript
    // After validateTransition returns valid for a char/faction tier TR:
    if ((tx.e === 'char' || tx.e === 'faction') && tx.d?.f === 'tier') {
        const uniq = checkPrincipalUniqueness(_currentState, tx.e, tx.id, tx.d.to);
        if (!uniq.valid) {
            // Reject this tx
            rejectedTxs.push({ tx, reason: uniq.error, fix: uniq.fix });
            continue;
        }
    }
    // Also check on CR:
    if ((tx.e === 'char' || tx.e === 'faction') && tx.op === 'CR' && tx.d?.tier) {
        const uniq = checkPrincipalUniqueness(_currentState, tx.e, tx.id, tx.d.tier);
        if (!uniq.valid) {
            rejectedTxs.push({ tx, reason: uniq.error, fix: uniq.fix });
            continue;
        }
    }
```

Import `checkPrincipalUniqueness` at the top of `index.js`.

- [ ] **Step 3: Test**

Append to `scripts/test-relationship.js` — but this is tricky because the guard requires state + commit pipeline. We can test the pure function:

```javascript
const { checkPrincipalUniqueness } = require('../state-machine.js');

group('state-machine: checkPrincipalUniqueness', () => {
    test('second PRINCIPAL char rejects', () => {
        const state = {
            characters: {
                kira: { tier: 'PRINCIPAL' },
                lacus: { tier: 'TRACKED' },
            },
            factions: {},
        };
        const r = checkPrincipalUniqueness(state, 'char', 'lacus', 'PRINCIPAL');
        assertEqual(r.valid, false, 'second PRINCIPAL rejected');
    });

    test('same entity re-assigned to PRINCIPAL passes (self-check)', () => {
        const state = {
            characters: { kira: { tier: 'PRINCIPAL' } },
            factions: {},
        };
        const r = checkPrincipalUniqueness(state, 'char', 'kira', 'PRINCIPAL');
        assertEqual(r.valid, true, 'self-assignment allowed');
    });

    test('PRINCIPAL faction rejection is independent from chars', () => {
        const state = {
            characters: { kira: { tier: 'PRINCIPAL' } },
            factions: { zaft: { tier: 'PRINCIPAL' }, alliance: { tier: 'TRACKED' } },
        };
        const r = checkPrincipalUniqueness(state, 'faction', 'alliance', 'PRINCIPAL');
        assertEqual(r.valid, false, 'second PRINCIPAL faction rejected');
    });
});
```

- [ ] **Step 4: Run tests**

```
node scripts/test-relationship.js
node -c index.js
```

- [ ] **Step 5: Commit**

```
git add index.js scripts/test-relationship.js
git commit -m "feat(relationship): wire PRINCIPAL uniqueness guard into commit pipeline

Calls checkPrincipalUniqueness on char/faction tier TRs and CRs at
commit time. Second PRINCIPAL of the same entity type rejects the
offending tx while allowing the rest of the batch to commit
(matches the existing validateTransition failure-mode)."
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-relationship-module.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks 3–5 and 9–11 could partially parallelize and subagents keep the main context clean while processing large code diffs.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
