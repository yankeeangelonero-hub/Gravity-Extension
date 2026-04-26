import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTransition,
  CHARACTER_TIERS,
  CONSTRAINT_LEVELS,
  COLLISION_STATES,
} from '../state-machine.js';

test('char UNKNOWN → KNOWN is valid', () => {
  const r = validateTransition('char', 'tier', 'UNKNOWN', 'KNOWN');
  assert.equal(r.valid, true);
});

test('char UNKNOWN → PRINCIPAL is invalid (must go through KNOWN)', () => {
  const r = validateTransition('char', 'tier', 'UNKNOWN', 'PRINCIPAL');
  assert.equal(r.valid, false);
  assert.ok(typeof r.error === 'string');
});

test('constraint BREACHED → STABLE is invalid (terminal state)', () => {
  const r = validateTransition('constraint', 'integrity', 'BREACHED', 'STABLE');
  assert.equal(r.valid, false);
});

test('constraint STRESSED → STABLE is valid (relief)', () => {
  const r = validateTransition('constraint', 'integrity', 'STRESSED', 'STABLE');
  assert.equal(r.valid, true);
});

test('collision ACTIVE → RESOLVED is valid', () => {
  const r = validateTransition('collision', 'status', 'ACTIVE', 'RESOLVED');
  assert.equal(r.valid, true);
});

test('collision RESOLVED → ACTIVE is invalid (terminal)', () => {
  const r = validateTransition('collision', 'status', 'RESOLVED', 'ACTIVE');
  assert.equal(r.valid, false);
});

test('relationship active → dormant is valid', () => {
  const r = validateTransition('relationship', 'status', 'active', 'dormant');
  assert.equal(r.valid, true);
});

test('CHARACTER_TIERS array is defined', () => {
  assert.ok(Array.isArray(CHARACTER_TIERS));
  assert.ok(CHARACTER_TIERS.includes('PRINCIPAL'));
});

test('CONSTRAINT_LEVELS and COLLISION_STATES are defined', () => {
  assert.ok(Array.isArray(CONSTRAINT_LEVELS));
  assert.ok(Array.isArray(COLLISION_STATES));
});
