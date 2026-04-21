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

group('relationship entity — CR + S', () => {
    test('CR relationship:pc-lacus creates entity with engine-defaulted status=active', () => {
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
});

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
        assertEqual(state.characters.dak.tags, ['smuggler', 'rebel'], 'dedup preserves unique traits');
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
