// scripts/test-director.js
// Unit tests for the director helper layer (stripUpdateBlock,
// buildDirectorCorrectionPayload, director-input builder).
//
// Usage: node scripts/test-director.js
// Exit code: 0 if all pass, 1 if any fail.

'use strict';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        failed++; failures.push({ name, err });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function group(name, fn) { console.log(`\n${name}`); fn(); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label || 'assertEqual'}: expected ${e}, got ${a}`);
}

// ─── Tests added by subsequent tasks ──────────────────────────────────────────

group('harness sanity', () => {
    test('1+1=2', () => { assertEqual(1 + 1, 2); });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.name}: ${f.err.stack || f.err.message}`);
    process.exit(1);
}
process.exit(0);
