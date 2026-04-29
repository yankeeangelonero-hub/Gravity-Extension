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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
