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
