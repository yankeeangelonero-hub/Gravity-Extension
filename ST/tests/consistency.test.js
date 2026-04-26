import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, validateTransaction, VALID_OPS, VALID_ENTITIES } from '../consistency.js';

test('VALID_OPS includes all expected operations', () => {
  for (const op of ['CR', 'S', 'TR', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND']) {
    assert.ok(VALID_OPS.includes(op), `Expected ${op} in VALID_OPS`);
  }
});

test('validateTransaction accepts a well-formed CR char', () => {
  const tx = { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } };
  const result = validateTransaction(tx);
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
});

test('validateTransaction passes a well-formed relationship CR with valid card, orientation and nuance', () => {
  const tx = {
    op: 'CR',
    e: 'relationship',
    id: 'pc-lacus',
    d: { card: 'the-lovers', orientation: 'upright', nuance: 'bound by shared idealism' },
  };
  const result = validateTransaction(tx);
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
});

test('validateTransaction catches invalid faction.tier on CR (must be KNOWN, TRACKED, or PRINCIPAL)', () => {
  const tx = { op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'ALLY' } };
  const result = validateTransaction(tx);
  assert.ok(result.violations.length > 0, 'Expected at least one violation for invalid tier');
  assert.ok(
    result.violations.some(v => v.field === 'tier'),
    `Expected a tier violation, got: ${JSON.stringify(result.violations)}`,
  );
});

test('validateBatch returns errors array', () => {
  const txns = [
    { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } },
    { op: 'BADOP' },
  ];
  const result = validateBatch(txns);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
  assert.equal(result.valid, false);
});

test('validateBatch accepts empty array', () => {
  const result = validateBatch([]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.valid, true);
});
