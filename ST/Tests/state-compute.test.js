import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, applyTransaction, computeState, CATEGORY_DISTANCES } from '../state-compute.js';

test('createEmptyState returns a valid base structure', () => {
  const s = createEmptyState();
  assert.ok(s.characters && typeof s.characters === 'object');
  assert.ok(s.collisions && typeof s.collisions === 'object');
  assert.equal(s.lastTxId, -1);
});

test('applyTransaction CR char creates an entity', () => {
  const state = createEmptyState();
  const tx = { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } };
  const next = applyTransaction(state, tx);
  assert.ok(next.characters['alice']);
  assert.equal(next.characters['alice'].name, 'Alice');
});

test('applyTransaction S char sets a field', () => {
  const state = createEmptyState();
  const cr = { op: 'CR', e: 'char', id: 'bob', d: { name: 'Bob', tier: 'UNKNOWN' } };
  const s  = { op: 'S', e: 'char', id: 'bob', d: { f: 'tier', v: 'KNOWN' } };
  const next = applyTransaction(applyTransaction(state, cr), s);
  assert.equal(next.characters['bob'].tier, 'KNOWN');
});

test('computeState replays a transaction list', () => {
  const txns = [
    { op: 'CR', e: 'char', id: 'carol', d: { name: 'Carol', tier: 'UNKNOWN' } },
    { op: 'S', e: 'char', id: 'carol', d: { f: 'tier', v: 'TRACKED' } },
  ];
  const state = computeState(null, txns);
  assert.equal(state.characters['carol'].tier, 'TRACKED');
});

test('CATEGORY_DISTANCES maps expected values', () => {
  assert.equal(CATEGORY_DISTANCES.IMMEDIATE, 1);
  assert.equal(CATEGORY_DISTANCES.SHORT, 10);
  assert.equal(CATEGORY_DISTANCES.MEDIUM, 20);
  assert.equal(CATEGORY_DISTANCES.LONG, 50);
});
