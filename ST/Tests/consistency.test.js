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

test('validateTransaction accepts any operation (format checking deferred to validateBatch)', () => {
  const tx = { op: 'BADOP', e: 'char', id: 'x', d: {} };
  const result = validateTransaction(tx);
  assert.equal(result.violations.length, 0);
});

test('validateTransaction accepts missing entity type (format checking deferred to validateBatch)', () => {
  const tx = { op: 'CR', id: 'x', d: {} };
  const result = validateTransaction(tx);
  assert.equal(result.violations.length, 0);
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
