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
