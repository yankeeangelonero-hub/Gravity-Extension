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
