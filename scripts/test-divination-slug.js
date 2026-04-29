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
