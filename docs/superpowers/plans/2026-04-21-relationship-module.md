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
    test('CR relationship:pc-lacus creates entity with engine-defaulted status=active', () => {
        // LLM omits status on CR (forbidden by consistency validator); engine
        // defaults it to 'active' in the state-compute CR handler.
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool',
                orientation: 'upright',
                nuance: 'First impression.',
                last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rel = state.relationships?.['pc-lacus'];
        assert(rel !== undefined, 'relationship not in state.relationships');
        assertEqual(rel.card, 'the-fool', 'card');
        assertEqual(rel.orientation, 'upright', 'orientation');
        assertEqual(rel.status, 'active', 'status defaulted to active by engine');
        assertEqual(rel.last_shift, null, 'last_shift null at birth');
    });

    test('S relationship field=card updates card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool', orientation: 'upright', nuance: 'x', last_shift: null,
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

- [ ] **Step 5b: Default `last_shift: null` on relationship CR**

Edit `state-compute.js` inside the CR switch case, alongside place/faction/char defaults (the block added in later tasks):

```javascript
                // Default last_shift=null at birth for relationship entities.
                // Spec says last_shift is null until the first relational collision
                // resolves. LLMs may omit the field; make it explicit in state.
                if (tx.e === 'relationship') {
                    if (!('last_shift' in data)) data.last_shift = null;
                    if (!data.status) data.status = 'active';
                }
```

Add a test for this to the existing group:

```javascript
    test('CR relationship without last_shift defaults to null', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool', orientation: 'upright', nuance: 'x',
                // last_shift omitted intentionally
            }},
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].last_shift, null, 'last_shift defaulted to null');
        assertEqual(state.relationships['pc-lacus'].status, 'active', 'status defaulted to active');
    });
```

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

    test('CR char with duplicate tags dedupes BEFORE capping', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN',
              tags: ['smuggler', 'smuggler', 'smuggler', 'smuggler', 'smuggler', 'rebel'] } },
        ];
        const state = computeState(null, txs);
        // Dedup keeps unique "smuggler" + "rebel" — secondary trait NOT lost to duplicate flood
        assertEqual(state.characters.dak.tags, ['smuggler', 'rebel'], 'dedup preserves unique traits');
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
                // Dedupe + enforce char.tags cap — new field in relationship module.
                // Dedup BEFORE slicing: LLMs sometimes repeat tags ("smuggler, smuggler,
                // smuggler, smuggler, smuggler, rebel") — a naive slice would discard
                // the actual secondary trait. Order-preserving dedup via Set.
                if (tx.e === 'char' && Array.isArray(data.tags)) {
                    data.tags = Array.from(new Set(data.tags));
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
                    // Dedup + enforce char.tags cap on append — note: the A-op
                    // duplicate check above uses stringSimilarity > 0.8, which
                    // already catches exact repeats. This is belt-and-suspenders
                    // for deterministic cleanup.
                    if (tx.e === 'char' && tx.d.f === 'tags' && Array.isArray(target.tags)) {
                        target.tags = Array.from(new Set(target.tags));
                        if (target.tags.length > CHARACTER_TAGS_MAX) {
                            target.tags = target.tags.slice(0, CHARACTER_TAGS_MAX);
                        }
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
                card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
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
                card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'archived', 'auto-archive on death');
    });

    test('D char:id also scrubs pc.scene_cast reference', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus', 'char:kira'] } },
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assert(!state.pc.scene_cast.includes('char:lacus'), 'dead char scrubbed from scene_cast');
        assert(state.pc.scene_cast.includes('char:kira'), 'living cast member retained');
    });

    test('D faction:id scrubs pc.scene_cast reference', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['faction:zaft'] } },
            { tx: 3, op: 'D', e: 'faction', id: 'zaft' },
        ];
        const state = computeState(null, txs);
        assert(!state.pc.scene_cast.includes('faction:zaft'), 'dead faction scrubbed from scene_cast');
    });

    test('TR faction tier TRACKED->KNOWN auto-dormants faction relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-zaft', d: {
                card: 'the-chariot', orientation: 'reversed', nuance: 'x', last_shift: null,
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

- [ ] **Step 5: Wire the helper into the D case + scrub scene_cast**

Edit `state-compute.js` inside the D switch case (around line 667):

```javascript
        case 'D': {
            if (!isSingleton) {
                // Engine-driven: archive paired relationship BEFORE deleting entity
                if (tx.e === 'char' || tx.e === 'faction') {
                    adjustRelationshipStatus(state, tx.e, tx.id, 'archived');
                    // Scrub dangling scene_cast reference so the lean phonebook
                    // never points at a ghost. Audit in Task 14 would flag it otherwise.
                    const fqId = `${tx.e}:${tx.id}`;
                    if (state.pc && Array.isArray(state.pc.scene_cast)) {
                        state.pc.scene_cast = state.pc.scene_cast.filter(ref => ref !== fqId);
                    }
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
auto-sets status=archived BEFORE the entity is removed, AND scrubs
the fq-id from pc.scene_cast so the lean phonebook never carries a
dangling reference to a dead char/faction. These are deterministic
engine actions — LLM never writes relationship.status directly.
Applies to both char and faction pairs (relationship:pc-X)."
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
            card: 'made-up-card', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid card should reject');
    });

    test('CR relationship with invalid orientation rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-fool', orientation: 'sideways', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid orientation should reject');
    });

    test('CR relationship with valid fields passes', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'reversed', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid CR should pass');
    });

    test('CR relationship with bad id format rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'lacus-kira', d: {
            card: 'the-fool', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'non-pc-prefixed id should reject');
    });

    test('S relationship last_shift with missing fields rejects', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: { tx: 5, collision_id: 'x' }  // missing from/to/reason
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'incomplete last_shift should reject');
    });

    test('S relationship last_shift=null REJECTS (audit trail protection)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: null
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S last_shift=null would wipe audit trail — must reject');
    });

    test('CR relationship last_shift=null passes (birth state)', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'null last_shift at birth is legitimate');
    });

    test('S relationship status REJECTS unconditionally (engine-owned)', () => {
        // Spec: status is engine-written on tier movement or D. LLM never writes it.
        // Even a well-formed value must hard-reject.
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'status', v: 'active'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S status must reject regardless of value — engine-only field');
    });

    test('CR relationship with omitted status passes (defaults to active)', () => {
        // Engine is allowed to default status at birth via CR; only S is forbidden.
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'CR without status should pass (defaulted by engine)');
    });

    test('S relationship nuance="" rejects (empty nuance loophole)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: ''
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'empty string nuance must reject');
    });

    test('S relationship nuance=42 rejects (type coercion loophole)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: 42
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'non-string nuance must reject');
    });

    test('S relationship nuance with valid string passes', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: 'The hermit archetype deepens after the Jachin encounter.'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid nuance string passes');
    });

    test('S relationship missing pc- prefix rejects (id prefix bypass)', () => {
        // LLM forgets prefix: "SET relationship:lacus field=card ..."
        // Without S-branch id check, this would silently create state.relationships['lacus'].
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'lacus', d: {
            f: 'card', v: 'the-hermit'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'missing pc- prefix on S must reject');
    });

    test('CR orientation "Upright" (title-case) passes after normalization', () => {
        // LLMs frequently title-case tarot terms. Normalizing to lowercase before
        // checking RELATIONSHIP_ORIENTATIONS prevents relentless rejections.
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'Upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'title-cased orientation should pass after normalization');
    });

    test('S orientation "Reversed" (title-case) passes after normalization', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'orientation', v: 'Reversed'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'title-cased S orientation normalizes to reversed');
    });

    test('S last_shift with string from/to rejects (sub-object validation)', () => {
        // "from: 'good', to: 'bad'" passes the mere 'in v' key-presence check
        // but must fail because from/to must be {card, orientation} objects.
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: 'the-hermit-upright', to: 'the-tower-reversed',
                reason: 'betrayal',
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'string from/to must reject — must be {card, orientation} objects');
    });

    test('S last_shift with valid card-obj from/to passes', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: { card: 'the-hermit', orientation: 'upright' },
                to: { card: 'the-tower', orientation: 'reversed' },
                reason: 'betrayal at the hangar',
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid last_shift with card-obj from/to passes');
    });
});

group('consistency: scene_cast entity-ref validation', () => {
    test('S pc scene_cast with non-existent char rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:ghost'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'hallucinated char id in scene_cast must reject');
        assert(result.violations.some(v => v.field === 'scene_cast'), 'violation on scene_cast field');
    });

    test('A pc scene_cast with non-existent faction rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'A', e: 'pc', id: '', d: { f: 'scene_cast', v: 'faction:phantom' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'hallucinated faction id in scene_cast A must reject');
    });

    test('S pc scene_cast with unsupported type rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['collision:x'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'non-char/faction entity type in scene_cast must reject');
    });

    test('S pc scene_cast with existing char passes', () => {
        const state = { characters: { lacus: { tier: 'TRACKED' } }, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'existing char in scene_cast passes');
    });

    test('S pc scene_cast with existing faction passes', () => {
        const state = { characters: {}, factions: { zaft: { tier: 'PRINCIPAL' } }, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['faction:zaft'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'existing faction in scene_cast passes');
    });

    test('S pc scene_cast with malformed ref (no colon) rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['lacus'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'bare id without type prefix must reject');
    });

    test('CR char with >5 tags rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'char', id: 'dak', d: {
            name: 'Dak', tier: 'KNOWN', tags: ['a','b','c','d','e','f']
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'too many tags should reject');
    });

    test('CR faction with invalid tier rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: {
            name: 'ZAFT', tier: 'SUPREME'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid tier should reject');
    });

    test('second PRINCIPAL char rejects via central validator', () => {
        const state = {
            characters: { kira: { tier: 'PRINCIPAL' } },
            factions: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'second PRINCIPAL char rejected');
    });

    test('TR faction tier to PRINCIPAL when one already exists rejects', () => {
        const state = {
            characters: {},
            factions: { zaft: { tier: 'PRINCIPAL' }, alliance: { tier: 'TRACKED' } },
        };
        const tx = { tx: 1, op: 'TR', e: 'faction', id: 'alliance', d: { f: 'tier', from: 'TRACKED', to: 'PRINCIPAL' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'second PRINCIPAL faction via TR rejected');
    });

    test('same-block double-PRINCIPAL rejects via validateBlock (shadow-state walk)', () => {
        // Pre-block state is empty — neither CR would fail against frozen state
        // individually, so per-tx validation would pass both. validateBlock must
        // catch the conflict by progressively mutating a shadow state.
        const baseState = { characters: {}, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'char', id: 'ally', d: { name: 'Ally', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'char', id: 'enemy', d: { name: 'Enemy', tier: 'PRINCIPAL' } },
        ];
        const result = consistency.validateBlock(block, baseState);
        assert(!result.valid, 'same-block duplicate PRINCIPAL must reject');
        assert(result.violations.some(v => /PRINCIPAL/i.test(v.message)), 'reason cites PRINCIPAL');
    });

    test('same-block CR + TR pushing two PRINCIPALs rejects', () => {
        // CR ally TRACKED, CR enemy PRINCIPAL, TR ally TRACKED→PRINCIPAL:
        // tx-by-tx against frozen state would miss the final conflict.
        const baseState = { characters: {}, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'char', id: 'enemy', d: { name: 'Enemy', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'char', id: 'ally', d: { name: 'Ally', tier: 'TRACKED' } },
            { tx: 3, op: 'TR', e: 'char', id: 'ally', d: { f: 'tier', from: 'TRACKED', to: 'PRINCIPAL' } },
        ];
        const result = consistency.validateBlock(block, baseState);
        assert(!result.valid, 'CR + TR producing two PRINCIPALs must reject');
    });

    test('CR relationship for KNOWN-tier char rejects', () => {
        const state = {
            characters: { flay: { tier: 'KNOWN' } },
            factions: {},
            relationships: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-flay', d: {
            card: 'three-of-swords', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'CR relationship for KNOWN target must reject');
    });

    test('CR relationship for missing target rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-ghost', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'CR relationship for nonexistent target rejects');
    });

    test('CR relationship for TRACKED+ target passes', () => {
        const state = {
            characters: { lacus: { tier: 'PRINCIPAL' } },
            factions: {},
            relationships: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'TRACKED+ target should pass');
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
 * Validate a tarot card+orientation sub-object (used inside last_shift.from/to).
 * Both from and to record the relationship state before/after a relational
 * collision, so both must be fully-formed tarot references.
 */
function isValidCardObj(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    // Normalize orientation to lowercase before checking — LLMs frequently
    // title-case these values (the same normalization applied in the main
    // orientation validator). Card slugs should always be lowercase already,
    // but we normalize them too for robustness.
    const card = typeof obj.card === 'string' ? obj.card.toLowerCase() : '';
    const orientation = typeof obj.orientation === 'string' ? obj.orientation.toLowerCase() : '';
    return MAJOR_ARCANA.has(card) && RELATIONSHIP_ORIENTATIONS.has(orientation);
}

/**
 * Validate the shape of a last_shift value. Null is allowed (birth state).
 * Non-null must be an object with all five fields present AND valid from/to.
 */
function isValidLastShift(v) {
    if (v === null) return true;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    if (typeof v.tx !== 'number') return false;
    if (!('collision_id' in v)) return false;
    if (typeof v.reason !== 'string') return false;
    // from and to must be valid {card, orientation} objects — checking mere
    // presence allows "from: 'good', to: 'bad'" to corrupt the tarot audit trail.
    if (!isValidCardObj(v.from)) return false;
    if (!isValidCardObj(v.to)) return false;
    return true;
}

/**
 * Check the id prefix format used by both CR and S operations.
 * Must be "pc-<suffix>" (LLM sometimes omits the prefix, creating a
 * malformed key like state.relationships['lacus'] that never renders).
 */
function validateRelationshipId(id) {
    if (typeof id !== 'string' || !id.startsWith('pc-') || id.length <= 3) {
        return {
            field: 'id',
            message: `relationship id must be "pc-<other_id>", got "${id}"`,
            fix: 'Use e.g. relationship:pc-lacus (PC is always first in the pair).',
        };
    }
    return null;
}

/**
 * Validate relationship-specific fields in a CR or S transaction.
 * Called from the main validator.
 */
function validateRelationshipTx(tx) {
    const violations = [];

    // ID format check applies to both CR and S — a missing "pc-" prefix on S
    // would silently create a malformed relationship key in state.
    const idViolation = validateRelationshipId(tx.id);
    if (idViolation) violations.push(idViolation);

    if (tx.op === 'CR') {
        const d = tx.d || {};
        // Normalize card slug and orientation to lowercase before checking.
        // LLMs frequently title-case tarot terms ("The Hermit", "Upright").
        const card = typeof d.card === 'string' ? d.card.toLowerCase() : d.card;
        const orientation = typeof d.orientation === 'string' ? d.orientation.toLowerCase() : d.orientation;
        if (!MAJOR_ARCANA.has(card)) {
            violations.push({
                field: 'card',
                message: `invalid card slug "${d.card}"`,
                fix: `Must be one of the 22 Major Arcana slugs in lowercase-hyphen form (the-fool, the-lovers, the-tower, ...).`,
            });
        }
        if (!RELATIONSHIP_ORIENTATIONS.has(orientation)) {
            violations.push({
                field: 'orientation',
                message: `invalid orientation "${d.orientation}"`,
                fix: 'Must be "upright" or "reversed" (lowercase). Do not title-case.',
            });
        }
        if (typeof d.nuance !== 'string' || d.nuance.trim() === '') {
            violations.push({
                field: 'nuance',
                message: 'nuance must be a non-empty string',
                fix: 'Describe the specific expression of the archetype for this pair.',
            });
        }
        if (d.status !== undefined) {
            // CR: status is engine-defaulted to 'active' at birth. LLM-authored
            // status is forbidden — no legitimate use case; enables override loophole.
            violations.push({
                field: 'status',
                message: 'relationship.status is engine-owned — omit on CR (engine defaults to "active")',
                fix: 'Remove the status field from the CR line. Status follows tier automatically after birth.',
            });
        }
        if (d.last_shift !== undefined && !isValidLastShift(d.last_shift)) {
            violations.push({
                field: 'last_shift',
                message: 'last_shift must be null or {tx, collision_id, from: {card, orientation}, to: {card, orientation}, reason}',
                fix: 'Use null at birth; full object on subsequent collision-resolve updates.',
            });
        }
    } else if (tx.op === 'S') {
        const f = tx.d?.f;
        const v = tx.d?.v;
        if (f === 'card') {
            const card = typeof v === 'string' ? v.toLowerCase() : v;
            if (!MAJOR_ARCANA.has(card)) {
                violations.push({ field: 'card', message: `invalid card slug "${v}"`, fix: 'Major Arcana only, lowercase-hyphen (the-hermit, not "The Hermit").' });
            }
        }
        if (f === 'orientation') {
            // Normalize to lowercase — LLMs title-case "Upright"/"Reversed" frequently.
            const orientation = typeof v === 'string' ? v.toLowerCase() : v;
            if (!RELATIONSHIP_ORIENTATIONS.has(orientation)) {
                violations.push({ field: 'orientation', message: `invalid orientation "${v}"`, fix: '"upright" or "reversed" (lowercase).' });
            }
        }
        if (f === 'nuance') {
            // Nuance can be updated via S (e.g., nuance deepened mid-arc without a full
            // card shift). Must remain a non-empty string — empty or non-string corrupts
            // the prompt injection line that the LLM reads back.
            if (typeof v !== 'string' || v.trim() === '') {
                violations.push({
                    field: 'nuance',
                    message: `nuance must be a non-empty string, got ${JSON.stringify(v)}`,
                    fix: 'Nuance must be a non-empty prose string (max ~100 words). Use DELETE to remove it entirely rather than setting it to "".',
                });
            }
        }
        if (f === 'status') {
            // RULE: relationship.status is engine-owned. The LLM must never write it.
            violations.push({
                field: 'status',
                message: 'relationship.status is engine-owned and cannot be SET manually',
                fix: 'To change a relationship, write card/orientation/nuance/last_shift inside a collision resolution. Status follows tier automatically.',
            });
        }
        if (f === 'last_shift') {
            // On S, null is NOT allowed — would wipe the audit trail. Birth is CR-only.
            if (v === null) {
                violations.push({
                    field: 'last_shift',
                    message: 'S last_shift=null would wipe the audit trail',
                    fix: 'last_shift can only be null at birth (CR). Subsequent S ops require the full {tx, collision_id, from, to, reason} object.',
                });
            } else if (!isValidLastShift(v)) {
                violations.push({
                    field: 'last_shift',
                    message: 'last_shift must be {tx, collision_id, from: {card, orientation}, to: {card, orientation}, reason}',
                    fix: 'All five fields required. from/to must be {card, orientation} objects using valid Major Arcana slugs.',
                });
            }
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

**Add `validateSceneCastTx` below `validateFactionTierTx`:**

```javascript
/**
 * Validate scene_cast A (append) and S (replace) operations on the pc entity.
 * Checks: each entry is a "type:id" string AND the referenced entity actually
 * exists in state.characters or state.factions.
 *
 * This is a state-dependent validator (needs state) — it goes in the
 * main validateTransaction call which already accepts state.
 */
function validateSceneCastEntries(refs, state) {
    const violations = [];
    for (const ref of refs) {
        if (typeof ref !== 'string' || !ref.includes(':')) {
            violations.push({
                field: 'scene_cast',
                message: `invalid cast entry "${ref}" — must be "type:id" format (char:lacus, faction:zaft)`,
                fix: 'Use the fully-qualified entity id (e.g., char:lacus). The "char:" prefix is required.',
            });
            continue;
        }
        if (!state) continue;  // no state available — shape check only
        const [type, id] = ref.split(':');
        let exists = false;
        if (type === 'char') exists = Boolean(state.characters?.[id]);
        else if (type === 'faction') exists = Boolean(state.factions?.[id]);
        else {
            violations.push({
                field: 'scene_cast',
                message: `unsupported entity type "${type}" in cast ref "${ref}"`,
                fix: 'Only "char:" and "faction:" prefixes are allowed in scene_cast.',
            });
            continue;
        }
        if (!exists) {
            violations.push({
                field: 'scene_cast',
                message: `cast ref "${ref}" references a non-existent entity`,
                fix: `Create ${type}:${id} first, or correct the id. The LLM may have hallucinated the id.`,
            });
        }
    }
    return violations;
}
```

- [ ] **Step 5: Wire the new validators into the main validator (including PRINCIPAL uniqueness)**

Find the main per-tx validator function in `consistency.js`. Extend it to accept the current state as a second parameter (needed for state-dependent checks like PRINCIPAL uniqueness). Inside it, after existing per-entity validation, add:

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
    // pc.scene_cast A/S entity-ref validation (state-dependent)
    if (tx.e === 'pc') {
        let refs = null;
        if (tx.op === 'S' && tx.d?.f === 'scene_cast' && Array.isArray(tx.d.v)) refs = tx.d.v;
        if (tx.op === 'A' && tx.d?.f === 'scene_cast') refs = [tx.d.v];
        if (refs) violations.push(...validateSceneCastEntries(refs, state));
    }
    // PRINCIPAL uniqueness — state-dependent, lives in consistency for centralized hard-reject
    if (state && (tx.e === 'char' || tx.e === 'faction')) {
        let newTier = null;
        if (tx.op === 'CR' && tx.d?.tier) newTier = tx.d.tier;
        else if (tx.op === 'TR' && tx.d?.f === 'tier') newTier = tx.d?.to;
        else if (tx.op === 'S' && tx.d?.f === 'tier') newTier = tx.d?.v;
        if (newTier === 'PRINCIPAL') {
            const uniq = checkPrincipalUniqueness(state, tx.e, tx.id, newTier);
            if (!uniq.valid) {
                violations.push({ field: 'tier', message: uniq.error, fix: uniq.fix });
            }
        }
    }

    // Cross-entity check: CR relationship:pc-<id> requires target (char or faction)
    // to exist and be TRACKED+ tier. Prevents KNOWN-birth contraband (relationship
    // for a character who should not have one per spec).
    if (state && tx.e === 'relationship' && tx.op === 'CR') {
        const id = tx.id || '';
        if (id.startsWith('pc-') && id.length > 3) {
            const otherId = id.slice('pc-'.length);
            const char = state.characters?.[otherId];
            const faction = state.factions?.[otherId];
            const target = char || faction;
            if (!target) {
                violations.push({
                    field: 'id',
                    message: `relationship target "${otherId}" does not exist as char or faction`,
                    fix: `Create the char or faction at TRACKED+ tier first, or correct the id.`,
                });
            } else {
                const tier = String(target.tier || '').toUpperCase();
                if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') {
                    violations.push({
                        field: 'id',
                        message: `relationship:pc-${otherId} requires target tier ≥ TRACKED (current: "${tier}")`,
                        fix: `Promote the target to TRACKED first (TR ${char ? 'char' : 'faction'}:${otherId} field=tier from=${tier} to=TRACKED), THEN create the relationship in the same ledger block.`,
                    });
                }
            }
        }
    }
```

Also import `checkPrincipalUniqueness` at the top of `consistency.js`:

```javascript
import { validateTransition, checkPrincipalUniqueness, getStateMachineField } from './state-machine.js';
```

Update the main validator's signature from `validateTransaction(tx)` to `validateTransaction(tx, state)`. Callers in `index.js` that call this function will need to pass `_currentState` as the second arg — update the call site.

**Note:** if the existing function does not expose `validateTransaction` as a single-tx entry point, add a thin exported wrapper that applies these checks. Read the file's public API first and adapt.

- [ ] **Step 5b: Add `validateBlock` for block-scoped invariants**

Per-tx validation against `_currentState` (frozen pre-block state) misses intra-block invariant violations. Example: a block containing two `CR char … tier=PRINCIPAL` ops would see no pre-existing PRINCIPAL for either tx, so both pass individually — and both commit, breaking the one-PRINCIPAL invariant. Fix: walk the block through a shadow state, applying each tx as we go so later validations see earlier mutations.

Append to `consistency.js`:

```javascript
// Import applyTransaction lazily (inside the function) to avoid a module-load
// cycle between consistency.js and state-compute.js.
function validateBlock(txs, baseState) {
    // Minimal shadow copy: we only need the fields the validators read
    // (characters, factions, relationships). Deep-copying the whole state
    // every block would be wasteful; a shallow per-collection clone is enough
    // because applyTransaction will write new entity records, not mutate
    // baseState's existing ones.
    const shadow = {
        characters: { ...(baseState?.characters || {}) },
        factions:   { ...(baseState?.factions   || {}) },
        relationships: { ...(baseState?.relationships || {}) },
        pc: baseState?.pc ? { ...baseState.pc } : {},
    };
    // Re-clone any entity we're about to TR/S so we don't corrupt baseState.
    // CR creates new records; TR/S mutates existing ones.
    const violations = [];
    const { applyTransaction } = require('./state-compute.js');
    for (const tx of txs) {
        const perTx = validateTransaction(tx, shadow);
        if (!perTx.valid) {
            violations.push(...perTx.violations.map(v => ({ ...v, tx: tx.tx })));
            // Hard-fail on the first block-aware violation — don't try to apply
            // a tx that would poison later checks.
            return { valid: false, violations };
        }
        // Deep-clone the entity we're about to mutate so baseState stays clean.
        if ((tx.op === 'TR' || tx.op === 'S') && (tx.e === 'char' || tx.e === 'faction')) {
            const coll = tx.e === 'char' ? 'characters' : 'factions';
            if (shadow[coll][tx.id]) {
                shadow[coll][tx.id] = { ...shadow[coll][tx.id] };
            }
        }
        try {
            applyTransaction(shadow, tx);
        } catch (e) {
            violations.push({ field: '_apply', message: `applyTransaction threw: ${e.message}`, tx: tx.tx });
            return { valid: false, violations };
        }
    }
    return { valid: true, violations: [] };
}
```

Export `validateBlock` alongside `validateTransaction` in the export block below.

**Caller update in `index.js`:** find the per-block commit path (around the existing `validateTransaction` loop) and switch to a single `validateBlock(block, _currentState)` call. Reject the whole block if it returns `{ valid: false }`. This preserves the single-tx entry point for OOC/test paths while closing the intra-block gap.

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
    validateBlock,         // block-scoped invariants via shadow-state walk
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
git commit -m "feat(relationship): consistency shape validation + PRINCIPAL uniqueness

Adds shape validators for:
- relationship CR/S — id prefix "pc-" required on both CR and S;
  card slug normalized to lowercase before MAJOR_ARCANA whitelist
  check; orientation normalized to lowercase (LLMs title-case these);
  nuance validated as non-empty string on BOTH CR and S (empty/non-
  string on S was a silent loophole); status hard-rejects on BOTH CR
  (engine-defaults 'active') and S (engine-owned field); last_shift
  null only on CR (audit-trail protection), and from/to validated as
  {card, orientation} objects — string values like "good"/"bad" that
  passed the 'in v' key-presence check now hard-reject
- char.tags (array-of-strings, ≤5 entries, ≤40 chars each)
- faction.tier (KNOWN|TRACKED|PRINCIPAL enum)
- pc.scene_cast A/S — each entry validated as "type:id" format AND
  existence-checked against state.characters/factions so LLM can't
  hallucinate cast refs that land as dangling strings in the ledger
- PRINCIPAL uniqueness (centralized in consistency — one hard-reject
  path for both shape and state-dependent checks; validateTransaction
  now accepts state as a second argument)
- validateBlock (block-scoped shadow-state walk closes same-block
  double-PRINCIPAL exploit)

Hard-rejects malformed transactions at commit time. Index.js call
sites updated to pass _currentState as second arg."
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

- [ ] **Step 4: Render memorials for archived relationships whose target is gone**

After BOTH the character and faction dossier loops complete, iterate `state.relationships` and emit a compact MEMORIAL line for every archived relationship whose target char/faction has been deleted. Without this, a dead-but-loved character silently vanishes from the LLM's prompt the turn after they die (`state.characters[id]` is gone but `state.relationships['pc-id']` is still `archived`). The UI panel would still show them, but the LLM wouldn't — creating a jarring "she who?" on the very next turn.

Add near the bottom of `formatStateView`, before the closing `return lines.join('\n')`:

```javascript
    // Memorials — archived relationships whose subject is no longer a live
    // entity. Emotionally load-bearing dead characters/factions must remain
    // visible in prompt so the LLM can reference the loss. Rendered last so
    // they don't clutter the live-cast section.
    const memorials = [];
    for (const [relId, rel] of Object.entries(state.relationships || {})) {
        if (rel.status !== 'archived') continue;
        if (!relId.startsWith('pc-')) continue;
        const otherId = relId.slice('pc-'.length);
        const stillLive = state.characters?.[otherId] || state.factions?.[otherId];
        if (stillLive) continue;  // archived but target still alive — handled elsewhere
        memorials.push([otherId, rel]);
    }
    if (memorials.length > 0) {
        lines.push('');
        lines.push(`MEMORIALS (${memorials.length}):`);
        for (const [otherId, rel] of memorials) {
            const reason = rel.last_shift?.reason
                ? ` — ${normalizeText(rel.last_shift.reason).slice(0, 60)}`
                : '';
            lines.push(`  † ${otherId} · ${formatCardName(rel.card)} ${rel.orientation}${reason}`);
        }
    }
```

- [ ] **Step 5: Syntax check**

```
node -c state-view.js
```

- [ ] **Step 6: Add a render smoke test**

Append to `scripts/test-relationship.js`:

```javascript
const { formatStateView } = require('../state-view.js');

group('state-view render — relationship block', () => {
    test('active relationship renders with ♥ line', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL', tags: ['idol'] } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'reversed', nuance: 'Hermit because...', last_shift: null,
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

    test('archived relationship for dead char renders as memorial', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'nicol', d: { name: 'Nicol', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-nicol', d: {
                card: 'the-star', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            // Simulate a collision-resolve stamping the death shift onto last_shift
            { tx: 3, op: 'S', e: 'relationship', id: 'pc-nicol', d: {
                f: 'last_shift', v: { tx: 3, collision_id: 'col:duel', from: 'the-star-upright', to: 'the-star-upright', reason: 'killed in duel' },
            }},
            { tx: 4, op: 'D', e: 'char', id: 'nicol' },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('MEMORIALS'), 'memorial section present');
        assert(rendered.includes('† nicol'), 'dead char has memorial line');
        assert(rendered.includes('The Star'), 'memorial shows card');
        assert(rendered.includes('killed in duel'), 'memorial shows last_shift reason');
    });

    test('archived relationship with living target is NOT memorialized', () => {
        // e.g. betrayal where the char still walks the earth but the bond is over
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'rau', d: { name: 'Rau', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-rau', d: {
                card: 'the-tower', orientation: 'reversed', nuance: 'x', status: 'archived', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(!rendered.includes('MEMORIALS'), 'no memorial when target is alive');
    });
});
```

- [ ] **Step 7: Run tests — expect pass**

```
node scripts/test-relationship.js
```

- [ ] **Step 8: Commit**

```
git add state-view.js scripts/test-relationship.js
git commit -m "feat(relationship): render bond block in char/faction dossiers + memorials

Adds the ♥ Bond (PC): <card> · <orientation> line below Agenda in
character and faction dossier renders. Only renders when the
relationship status is 'active'. Tags also render as a compact line
when present. Dormant/archived relationships skip the bond render at
this layer — the next task (lean phonebook) handles cast-gated
rendering and the on-stage-by-location exception.

Also adds a MEMORIALS section at the bottom: archived relationships
whose target char/faction has been D'd render a compact memorial line
so the LLM retains visibility of emotionally load-bearing losses even
after the dead entity is removed from state.characters / state.factions."
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

    // Split characters by on-stage vs off-stage.
    // Buckets (in render order):
    //   inCast           — TRACKED+ char explicitly in scene_cast: full dossier
    //   inCastKnown      — KNOWN char explicitly in scene_cast: mid-weight block
    //                      (the LLM said "this person is here" — don't bury them
    //                      in the KNOWN roll-up just because they have no card)
    //   offStagePrincipal — PRINCIPAL, not in cast: one-liner WITH card
    //   offStageTracked  — TRACKED, not in cast: compact line, no card
    //   dormantOnStageByLocation — dormant rel + char.location matches pc.current_place_id
    //                      (belt-and-suspenders when LLM forgets to cast them)
    //   knownList        — KNOWN, not in cast: Task 11 roll-up with tags
    const inCast = [];
    const inCastKnown = [];
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
        } else if (onStage && tier === 'KNOWN') {
            // KNOWN-in-cast: LLM explicitly put them on stage. They have no card
            // (KNOWN tier can't own a relationship per spec), but they MUST be
            // visible to the LLM or the cast declaration was meaningless.
            inCastKnown.push([id, char]);
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

    // In-cast KNOWN: mid-weight block — no card, no KA, no key_moments,
    // but tags + agenda + location so the LLM can actually write them.
    // This is narrower than the full dossier but richer than the KNOWN
    // roll-up (which is one-line-per-character with tags only).
    for (const [id, char] of inCastKnown) {
        lines.push(`CHARACTER: ${char.name || id} [KNOWN · on-stage]`);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
        if (char.agenda) lines.push(`    Agenda: ${normalizeText(char.agenda)}`);
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

**Faction dormant-on-stage check: use `territory` array, NOT `location` string.**
Characters have a `location` field (a single string — `"place:bridge"`). Factions use a `territory` field (an array — `["place:plant-home"]`). The dormant-reinjection logic must NOT copy `faction.location === currentPlace` from the character loop; that will always be `undefined === string` → false. Use:

```javascript
    for (const [id, faction] of Object.entries(state.factions)) {
        const fqId = `faction:${id}`;
        const tier = String(faction.tier || '').toUpperCase();
        const onStage = castSet.has(fqId);
        const rel = state.relationships?.[`pc-${id}`];
        // Dormant faction re-injects if its territory includes the PC's current location.
        // Factions use territory: [place:X] (array), NOT location (string) like chars.
        const isDormantFactionOnStage = (
            rel && rel.status === 'dormant' &&
            currentPlace &&
            Array.isArray(faction.territory) &&
            faction.territory.includes(currentPlace)
        );
        // Bucket split: same structure as characters
        if (onStage && (tier === 'TRACKED' || tier === 'PRINCIPAL')) {
            // inCastFaction.push([id, faction]);
        } else if (tier === 'PRINCIPAL') {
            // offStagePrincipalFaction.push([id, faction]);
        } else if (tier === 'TRACKED') {
            // offStageTrackedFaction.push([id, faction]);
        } else if (isDormantFactionOnStage) {
            // dormantOnStageFaction.push([id, faction, rel]);
        }
    }
```

Add `inCastFaction`, `offStagePrincipalFaction`, `offStageTrackedFaction`, `dormantOnStageFaction` buckets alongside the character buckets and render them in the same fashion.

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
                card: 'the-hermit', orientation: 'upright', nuance: 'n', last_shift: null,
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
                card: 'the-hermit', orientation: 'upright', nuance: 'n', last_shift: null,
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
                card: 'the-chariot', orientation: 'upright', nuance: 'n', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: [] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('TRACKED (off-stage): Mu'), 'tracked off-stage one-liner');
        assert(!rendered.includes('The Chariot'), 'should NOT show card for off-stage TRACKED');
    });

    test('KNOWN char in scene_cast renders mid-weight block (not roll-up)', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['bartender'] } },
            { tx: 2, op: 'S', e: 'char', id: 'dak', d: { f: 'agenda', v: 'keeps the peace' } },
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:dak'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('CHARACTER: Dak [KNOWN · on-stage]'), 'mid-weight header');
        assert(rendered.includes('Tags: [bartender]'), 'tags present');
        assert(rendered.includes('keeps the peace'), 'agenda present');
        assert(!rendered.includes('♥ Bond'), 'no card for KNOWN');
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
- In-cast KNOWN: mid-weight block (tags + agenda + location, no card).
  Previously KNOWN chars in scene_cast fell through to the roll-up
  and vanished from LLM view despite being explicitly cast — this
  fixes the silent-cast-member bug.
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
- Modify: `state-compute.js` — stamp `char.last_active_tx` on every char-touching tx
- Modify: `state-view.js` — KNOWN render using that field
- Test: `scripts/test-relationship.js`

- [ ] **Step 1: Add failing test for last_active_tx stamping**

Append to `scripts/test-relationship.js`:

```javascript
group('char.last_active_tx stamping', () => {
    test('CR stamps last_active_tx = tx.tx', () => {
        const txs = [
            { tx: 5, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 5, 'stamp on CR');
    });

    test('S updates last_active_tx to latest tx', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
            { tx: 42, op: 'S', e: 'char', id: 'a', d: { f: 'location', v: 'place:x' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 42, 'S updates stamp');
    });

    test('TR on char also updates last_active_tx', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
            { tx: 17, op: 'TR', e: 'char', id: 'a', d: { f: 'tier', from: 'KNOWN', to: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 17, 'TR updates stamp');
    });
});
```

- [ ] **Step 2: Run tests — expect failure**

```
node scripts/test-relationship.js
```

Expected: all three fail — field not stamped.

- [ ] **Step 3: Stamp `last_active_tx` in `applyTransaction`**

Edit `state-compute.js`. At the very end of `applyTransaction`, right before `state.lastTxId = tx.tx;`, add:

```javascript
    // Stamp char.last_active_tx on any tx that touches a specific character.
    // Used by state-view KNOWN roll-up to sort by recency in O(n log n).
    if (tx.e === 'char' && tx.id) {
        const ch = state.characters?.[tx.id];
        if (ch) ch.last_active_tx = tx.tx;
    }

    state.lastTxId = tx.tx;
    return state;
}
```

- [ ] **Step 4: Run tests — expect pass**

```
node scripts/test-relationship.js
node -c state-compute.js
```

- [ ] **Step 5: Render KNOWN with top-15 + older roll-up**

In `state-view.js`, replace the `// KNOWN — handled in the next task` placeholder from Task 10 with:

```javascript
    // KNOWN — tag-driven roll-up, top 15 most-recently-active
    // Sort is O(n log n) on an integer field (char.last_active_tx) — stamped
    // by state-compute on every tx touching the char. Do NOT scan _history
    // here; that's O(chars × history_size) and will tank perf on long chats.
    if (knownList.length > 0) {
        const sorted = knownList.slice().sort(([, a], [, b]) => {
            return (b.last_active_tx || 0) - (a.last_active_tx || 0);
        });
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

Read `ui-panel.js` around line 740-800 (where `char.agenda` is currently rendered). The existing code builds DOM strings with classes like `gl-d-row`. Note the existing structure — if the string-building is inline inside a DOM-manipulating function, extract a pure string-building helper in the next step so we can unit-test it.

- [ ] **Step 2: Extract a pure string-building helper**

Refactor the dossier render so the HTML-string assembly lives in a pure function that can be imported and tested under Node. Example structure:

```javascript
// Pure — builds and returns the HTML string for a single character's dossier.
// Importable/testable without DOM globals.
function buildCharacterDossierHtml(id, char, state) {
    const parts = [];
    // ...existing build logic...
    return parts.join('');
}

// DOM-binding wrapper — uses the helper and mutates the panel.
function renderCharacterDossier(id, char, state, panelEl) {
    panelEl.innerHTML = buildCharacterDossierHtml(id, char, state);
}

export { buildCharacterDossierHtml, renderCharacterDossier };
```

- [ ] **Step 3: Add the relationship render inside the pure helper**

Inside `buildCharacterDossierHtml`, right before the `agenda` line, add:

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

- [ ] **Step 6: Add string-builder unit tests**

Since `buildCharacterDossierHtml` is now a pure function returning a string, we can test it under Node. Append to `scripts/test-relationship.js`:

```javascript
const { buildCharacterDossierHtml } = require('../ui-panel.js');

group('ui-panel — HTML string builder', () => {
    test('active relationship renders gl-relationship div with upright class', () => {
        const state = {
            characters: { lacus: { name: 'Lacus', tier: 'PRINCIPAL' } },
            factions: {},
            relationships: { 'pc-lacus': {
                card: 'the-lovers', orientation: 'upright', nuance: 'genuine alignment', last_shift: null,
            }},
            pc: {},
            _history: {},
        };
        const html = buildCharacterDossierHtml('lacus', state.characters.lacus, state);
        assert(html.includes('class="gl-d-row gl-relationship gl-tarot-upright"'), 'upright class emitted');
        assert(html.includes('The Lovers'), 'card name in display form');
        assert(html.includes('"genuine alignment"'), 'nuance rendered');
    });

    test('reversed orientation emits gl-tarot-reversed class', () => {
        const state = {
            characters: { lacus: { name: 'Lacus', tier: 'PRINCIPAL' } },
            factions: {},
            relationships: { 'pc-lacus': {
                card: 'the-tower', orientation: 'reversed', nuance: 'x', last_shift: null,
            }},
            pc: {},
            _history: {},
        };
        const html = buildCharacterDossierHtml('lacus', state.characters.lacus, state);
        assert(html.includes('gl-tarot-reversed'), 'reversed class emitted');
    });

    test('dormant relationship does NOT emit the bond div', () => {
        const state = {
            characters: { lacus: { name: 'Lacus', tier: 'KNOWN' } },
            factions: {},
            relationships: { 'pc-lacus': {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', status: 'dormant', last_shift: null,
            }},
            pc: {},
            _history: {},
        };
        const html = buildCharacterDossierHtml('lacus', state.characters.lacus, state);
        assert(!html.includes('gl-relationship'), 'dormant suppresses bond div');
    });

    test('archived relationship renders in memorial section', () => {
        const state = {
            characters: { lacus: { name: 'Lacus', tier: 'KNOWN' } },
            factions: {},
            relationships: { 'pc-kira': {
                card: 'the-fool', orientation: 'reversed', nuance: 'x', status: 'archived',
                last_shift: { tx: 412, collision_id: 'c', from: null, to: null, reason: 'died at JOSH-A' },
            }},
            pc: {},
            _history: {},
        };
        const html = buildCharacterDossierHtml('lacus', state.characters.lacus, state);
        assert(html.includes('gl-memorials'), 'memorial section rendered');
        assert(html.includes('kira'), 'archived pair id in memorial');
        assert(html.includes('The Fool'), 'memorial card name');
    });
});
```

**Import note:** if `ui-panel.js` uses `document.createElement` or jQuery at module load time, the `require('../ui-panel.js')` call will throw under Node. In that case, restructure `ui-panel.js` to keep the module top-level free of DOM access — move any DOM bootstrapping into functions that only run when called. The pure `buildCharacterDossierHtml` helper must work in a pure-Node import.

- [ ] **Step 7: Run tests**

```
node scripts/test-relationship.js
```

All 4 new HTML-builder tests should pass. Plus a live-browser manual verification pass is still worth doing for color/style — CSS can't be tested this way.

- [ ] **Step 8: Commit**

```
git add ui-panel.js style.css scripts/test-relationship.js
git commit -m "feat(relationship): UI panel dossier block + memorials

Adds a heart-glyph bond line in each character's dossier (only when
relationship is active), with muted-gold/red color coding for
orientation. Archived relationships collapse into a <details>
memorial section at the bottom of the panel.

Pure string-builder helper (buildCharacterDossierHtml) extracted
from DOM-mutation wrapper so the HTML output is unit-testable under
Node. CSS styling still needs a live-browser spot check."
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

- [ ] **Step 3: Pre-commit PRINCIPAL faction merge on advance turns**

At the advance-turn handler in `index.js`, BEFORE committing the LLM's ledger block, intercept any `S pc field=scene_cast` transaction and merge missing PRINCIPAL factions into its `d.v` array.

**Why pre-commit, not post-commit A tx:** a post-commit `A pc scene_cast=faction:X` transaction creates a "drop→reappend" pair in the ledger on every advance turn. Over a long session, this pollutes the transaction log with constant engine-generated noise. Pre-commit mutation is architecturally cleaner: the engine silently corrects the payload before it lands in the ledger, no secondary tx needed, and the log stays clean.

Locate where `index.js` iterates the parsed tx block before appending (the validation loop, or a "pre-apply hook" if one exists). Add:

```javascript
    // Pre-commit hook: on advance turns, ensure PRINCIPAL factions are in
    // every S pc field=scene_cast transaction before it hits the ledger.
    // This prevents the post-commit drop→reappend log-pollution cycle.
    if (turnMode === 'advance') {
        const principalFactionIds = Object.entries(state.factions || {})
            .filter(([, f]) => String(f.tier || '').toUpperCase() === 'PRINCIPAL')
            .map(([id]) => `faction:${id}`);
        for (const tx of block) {
            if (tx.op === 'S' && tx.e === 'pc' && tx.d?.f === 'scene_cast' && Array.isArray(tx.d.v)) {
                for (const fqId of principalFactionIds) {
                    if (!tx.d.v.includes(fqId)) {
                        tx.d.v.push(fqId);
                    }
                }
            }
        }
    }
```

Run this BEFORE `validateBlock(block, _currentState)` so the merged tx is what gets validated and logged.

**Note:** do NOT emit a separate A tx for this. The pre-commit merge is invisible in the sense that it runs in the JS layer and modifies the transaction payload before ledger write — the logged tx already includes the PRINCIPAL faction.

- [ ] **Step 4: Add correction-queue entries for missing relationship updates**

Find the correction-queue mechanism in `index.js` (the `_inject` slot / `MAX_CORRECTION_ATTEMPTS` logic). After the post-commit state update, scan for:

1. TRACKED+ chars/factions without a paired `relationship:pc-<id>`
2. RESOLVED relational collisions whose relationship wasn't updated in the same tx group

For each, queue a correction prompt. Two design notes:

- **Correction dedup.** Maintain a Set of `(violation_kind, entity_id)` pairs for corrections we've already fired this chat. Don't re-fire for the same pair. This prevents the multi-resolution race (two relational collisions resolve in one block, second one wins `last_shift`, first one would otherwise nag forever).
- **History lookup, not just current value.** Instead of checking `rel.last_shift.collision_id === cid`, scan `state._history[\`relationship:${relId}:last_shift\`]` for any entry whose `to.collision_id` equals `cid`. If found at any point, treat the collision as correctly paired — even if a later resolution overwrote it.

```javascript
    // Module-level dedup set (initialize alongside other correction state)
    if (!_firedRelationshipCorrections) _firedRelationshipCorrections = new Set();

    // Helper: has any past last_shift update referenced this collision?
    function relationshipEverPairedWithCollision(state, relId, collisionId) {
        const historyKey = `relationship:${relId}:last_shift`;
        const entries = state._history?.[historyKey] || [];
        for (const e of entries) {
            if (e.to && typeof e.to === 'object' && e.to.collision_id === collisionId) return true;
        }
        // Current value also counts (first-time write hasn't entered history yet in the same tx)
        const cur = state.relationships?.[relId]?.last_shift;
        if (cur && cur.collision_id === collisionId) return true;
        return false;
    }

    // Correction: missing relationship entity after tier promotion
    for (const [id, char] of Object.entries(state.characters)) {
        const tier = String(char.tier || '').toUpperCase();
        if ((tier !== 'TRACKED' && tier !== 'PRINCIPAL') || state.relationships?.[`pc-${id}`]) continue;
        const dedupKey = `missing-relationship:char:${id}`;
        if (_firedRelationshipCorrections.has(dedupKey)) continue;
        _firedRelationshipCorrections.add(dedupKey);
        queueCorrection({
            kind: 'missing-relationship',
            entity: `char:${id}`,
            prompt: `You promoted char:${id} to ${tier}, but relationship:pc-${id} was not created. Draw the card now:\n  CR relationship:pc-${id} card="<slug>" orientation="upright|reversed" nuance="<1-sentence expression of the archetype for this pair>" last_shift=null\n(Major Arcana slugs only. last_shift must be null at birth — required for consistency validation.)`,
        });
    }
    // Mirror for factions:
    for (const [id, f] of Object.entries(state.factions)) {
        const tier = String(f.tier || '').toUpperCase();
        if ((tier !== 'TRACKED' && tier !== 'PRINCIPAL') || state.relationships?.[`pc-${id}`]) continue;
        const dedupKey = `missing-relationship:faction:${id}`;
        if (_firedRelationshipCorrections.has(dedupKey)) continue;
        _firedRelationshipCorrections.add(dedupKey);
        queueCorrection({
            kind: 'missing-relationship',
            entity: `faction:${id}`,
            prompt: `You set faction:${id} to ${tier}, but relationship:pc-${id} was not created. Draw the card now:\n  CR relationship:pc-${id} card="<slug>" orientation="upright|reversed" nuance="<one-sentence expression>" last_shift=null\n(Major Arcana slugs only. last_shift must be null at birth.)`,
        });
    }

    // Clear dedup keys when the entity gets its relationship (so a future
    // re-demote/re-promote cycle re-fires the correction if needed):
    for (const relId of Object.keys(state.relationships || {})) {
        const otherId = relId.replace(/^pc-/, '');
        _firedRelationshipCorrections.delete(`missing-relationship:char:${otherId}`);
        _firedRelationshipCorrections.delete(`missing-relationship:faction:${otherId}`);
    }

    // Correction: RESOLVED relational collision with no relationship update
    for (const [cid, col] of Object.entries(state.collisions)) {
        if (col.ignition_class !== 'relational') continue;
        if (col.status !== 'RESOLVED' && col.status !== 'CRASHED') continue;
        const other = (col.involved_chars || []).find(x => x !== 'pc');
        if (!other) continue;
        const relId = other.replace(/^(char|faction):/, 'pc-');
        const rel = state.relationships?.[relId];
        if (!rel) {
            // Relational collision tagged as relational but no relationship entity exists
            // for the involved party. Could be: (a) mislabeled collision (should be
            // combat/environmental), or (b) relationship CR was forgotten. Either way
            // we must fire a correction — silent continue would let the error persist
            // until the Task 14 replay harness, which is too late.
            const dedupKey = `orphan-relational-collision:${cid}`;
            if (!_firedRelationshipCorrections.has(dedupKey)) {
                _firedRelationshipCorrections.add(dedupKey);
                queueCorrection({
                    kind: 'orphan-relational-collision',
                    entity: `collision:${cid}`,
                    prompt: `collision:${cid} is tagged ignition_class=relational and resolved, but no relationship:${relId} exists. Either:\n  (A) Create the missing relationship first: CR relationship:${relId} card="<slug>" orientation="upright|reversed" nuance="<description>" last_shift=null\n  (B) If this collision was mislabeled, correct the ignition_class via S collision:${cid} field=ignition_class value=environmental (or combat/social).`,
                });
            }
            continue;
        }
        // Use history lookup, not current value — a later collision in the same
        // block may have overwritten last_shift. The question is "did this
        // collision ever update the relationship," not "is it the latest one."
        if (relationshipEverPairedWithCollision(state, relId, cid)) continue;
        const dedupKey = `missing-relationship-update:${cid}`;
        if (_firedRelationshipCorrections.has(dedupKey)) continue;
        _firedRelationshipCorrections.add(dedupKey);
        queueCorrection({
            kind: 'missing-relationship-update',
            entity: `collision:${cid}`,
            prompt: `collision:${cid} resolved but relationship:${relId} was not updated. Commit the card/orientation/nuance/last_shift now inside a LEDGER block. last_shift must be {tx, collision_id: "${cid}", from: {card, orientation}, to: {card, orientation}, reason}.`,
        });
    }

    // Correction: scene_cast overflow (spec: soft cap 6; Layer 3 nudge).
    // Without this, scene_cast grows unbounded through regular turns —
    // every collision arrival auto-appends, nothing evicts. The lean-phonebook
    // token savings are quickly burned off. Soft warning asks the LLM to
    // either prune the cast or advance the turn (which replaces the cast).
    const SCENE_CAST_SOFT_CAP = 6;
    const cast = state.pc?.scene_cast || [];
    if (cast.length > SCENE_CAST_SOFT_CAP) {
        // Re-fire every turn the cast stays oversized — this is a soft
        // ongoing condition, not a one-shot correctable event. Use a
        // size-bucketed dedup so we don't re-nag on the same overflow size
        // within the same chat window of turns; new additions that push it
        // higher should re-fire.
        const dedupKey = `scene-cast-overflow:${cast.length}`;
        if (!_firedRelationshipCorrections.has(dedupKey)) {
            _firedRelationshipCorrections.add(dedupKey);
            const preview = cast.slice(0, 4).join(', ') + (cast.length > 4 ? `, +${cast.length - 4} more` : '');
            queueCorrection({
                kind: 'scene-cast-overflow',
                entity: 'pc',
                prompt: `Scene cast has ${cast.length} members (soft cap ${SCENE_CAST_SOFT_CAP}): ${preview}. Either (A) prune via S pc field=scene_cast v=[<reduced list>] to drop anyone who's left the scene, or (B) advance the turn so the cast is replaced cleanly. Keeping the cast large wastes injection tokens and dilutes LLM focus on the real on-stage characters.`,
            });
        }
    } else {
        // Clear overflow dedup keys when cast shrinks back under the cap,
        // so a future overflow will re-fire.
        for (const key of Array.from(_firedRelationshipCorrections)) {
            if (key.startsWith('scene-cast-overflow:')) {
                _firedRelationshipCorrections.delete(key);
            }
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

Hook behaviors:
1. Collision arrival at distance 0 auto-appends involved_chars to
   pc.scene_cast (fires only for chars not already in cast, dedupes).
2. Advance turns: PRINCIPAL faction pre-commit merge. Instead of a
   post-commit A tx (which would create a 'drop→reappend' noise cycle
   in the ledger every advance), the engine intercepts S pc scene_cast
   transactions before they hit validateBlock and silently adds any
   missing PRINCIPAL faction refs to the d.v array. One clean tx, no
   secondary append, no log pollution.
3. Correction queue gains four new rules:
   - TRACKED+ entities without paired relationships
   - RESOLVED relational collisions whose last_shift.collision_id
     doesn't match the collision that resolved
   - Orphaned relational collision (tagged relational but no
     relationship:pc-X exists): fires a correction with two recovery
     paths (create the missing relationship OR fix ignition_class).
     Previously the loop 'continue'd silently, hiding the error until
     the Task 14 replay harness.
   - Scene cast overflow (>6 members): soft nudge asking LLM to prune
     or advance. Re-fires on further growth, clears when cast shrinks.

All hooks use existing tx-emission and correction-queue machinery."
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

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-relationship-module.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks 3–5 and 9–11 could partially parallelize and subagents keep the main context clean while processing large code diffs.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
