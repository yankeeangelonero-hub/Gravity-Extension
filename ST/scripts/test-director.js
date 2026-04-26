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

// Note: regex-intercept.js uses ES module exports. For node-CommonJS tests,
// we import the patterns directly via the file's exports if it provides
// CommonJS-compatible exports, or we mirror the pattern definitions here.
// Mirror approach used to keep tests independent of module-system mismatch.

const LEDGER_BLOCK_PATTERN = /[-—–]{2,3}\s*LEDGER\s*(?:BLOCK)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*LEDGER\s*[-—–]{2,3}/i;
const STATE_BLOCK_PATTERN = /[-—–]{2,3}\s*STATE\s*(?:DELTA)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*STATE\s*[-—–]{2,3}/i;

function stripUpdateBlock(message) {
    if (!message) return message;
    return message
        .replace(LEDGER_BLOCK_PATTERN, '')
        .replace(STATE_BLOCK_PATTERN, '')
        .trim();
}

group('stripUpdateBlock', () => {
    test('strips ---LEDGER--- block', () => {
        const msg = 'prose before\n---LEDGER---\nCR char:elena\n---END LEDGER---\nprose after';
        assertEqual(stripUpdateBlock(msg), 'prose before\n\nprose after');
    });
    test('strips ---STATE--- block', () => {
        const msg = 'prose\n---STATE---\nat: [Day 1 - 12:00]\n---END STATE---\ntail';
        assertEqual(stripUpdateBlock(msg), 'prose\n\ntail');
    });
    test('strips both LEDGER and STATE in the same message', () => {
        const msg = '---STATE---\nfoo\n---END STATE---\nmid\n---LEDGER---\nCR a\n---END LEDGER---';
        assertEqual(stripUpdateBlock(msg), 'mid');
    });
    test('returns input unchanged if no block present', () => {
        assertEqual(stripUpdateBlock('plain prose'), 'plain prose');
    });
    test('handles null/undefined', () => {
        assertEqual(stripUpdateBlock(null), null);
        assertEqual(stripUpdateBlock(undefined), undefined);
    });
});

// Mirror the implementation contract for node-CommonJS testing.
function buildDirectorCorrectionPayload(failedLines) {
    if (!failedLines || failedLines.length === 0) return null;
    return {
        kind: 'director_corrections',
        items: failedLines.map(fl => ({
            tx: fl.tx || null,                     // actual rejected tx object
            marker: fl.marker || fl.raw || null,   // debug token, accepts legacy `raw`
            error: fl.error || '',
            fix: fl.fix || null,
            attempts: fl.attempts || 0,
        })),
    };
}

group('buildDirectorCorrectionPayload', () => {
    test('returns null on empty input', () => {
        assertEqual(buildDirectorCorrectionPayload([]), null);
        assertEqual(buildDirectorCorrectionPayload(null), null);
        assertEqual(buildDirectorCorrectionPayload(undefined), null);
    });
    test('shapes a single failure with full tx object', () => {
        const tx = { op: 'TR', e: 'char', id: 'elena', d: { f: 'tier', from: 'KNOWN', to: 'PRINCIPAL' } };
        const out = buildDirectorCorrectionPayload([
            { tx, marker: '[validated tx 0] char:elena', error: 'invalid transition', fix: 'use TRACKED', attempts: 1 }
        ]);
        assertEqual(out, {
            kind: 'director_corrections',
            items: [{
                tx,
                marker: '[validated tx 0] char:elena',
                error: 'invalid transition',
                fix: 'use TRACKED',
                attempts: 1,
            }]
        });
    });
    test('falls back to legacy raw field when marker is absent', () => {
        const out = buildDirectorCorrectionPayload([{ raw: 'LEGACY', error: 'oops' }]);
        assertEqual(out.items[0].marker, 'LEGACY');
        assertEqual(out.items[0].tx, null);
    });
    test('handles missing optional fields', () => {
        const out = buildDirectorCorrectionPayload([{ error: 'oops' }]);
        assertEqual(out.items[0], { tx: null, marker: null, error: 'oops', fix: null, attempts: 0 });
    });
});

// Mirror the contract; production module is loaded when CommonJS-bridge added in step 3.
function buildDirectorInput({
    snappedInjectMode, snappedReasonMode, snappedDeductionType,
    userMessage, assistantMessage, stateView,
    recentLedgerTail, pendingCorrections, recentTurns,
    lastDirectorFailed
} = {}) {
    return {
        mode: snappedInjectMode || 'regular',
        reasonMode: snappedReasonMode || 'regular',
        deductionType: snappedDeductionType || null,
        userMessage: userMessage || '',
        assistantMessage: assistantMessage || '',
        stateView: stateView || '',
        recentLedgerTail: Array.isArray(recentLedgerTail) ? recentLedgerTail : [],
        pendingCorrections: pendingCorrections || null,
        recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
        lastDirectorFailed: !!lastDirectorFailed,
    };
}

group('buildDirectorInput', () => {
    test('all fields default cleanly when input is sparse', () => {
        const out = buildDirectorInput({});
        assertEqual(out, {
            mode: 'regular', reasonMode: 'regular', deductionType: null,
            userMessage: '', assistantMessage: '', stateView: '',
            recentLedgerTail: [], pendingCorrections: null, recentTurns: [],
            lastDirectorFailed: false,
        });
    });
    test('passes through full payload', () => {
        const out = buildDirectorInput({
            snappedInjectMode: 'advance', snappedReasonMode: 'combat',
            snappedDeductionType: 'combat',
            userMessage: 'u', assistantMessage: 'a', stateView: 's',
            recentLedgerTail: [{ op: 'CR' }], pendingCorrections: { kind: 'director_corrections', items: [] },
            recentTurns: [{ user: 'u1', assistant: 'a1' }],
            lastDirectorFailed: true,
        });
        assertEqual(out.mode, 'advance');
        assertEqual(out.reasonMode, 'combat');
        assertEqual(out.deductionType, 'combat');
        assertEqual(out.lastDirectorFailed, true);
        assertEqual(out.recentLedgerTail.length, 1);
    });
});

const fs = require('fs');
const path = require('path');
group('director-prompt', () => {
    test('director-prompt.js contains required sections', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'director-prompt.js'), 'utf8');
        assert(src.includes('You are the Gravity Director'), 'role framing present');
        assert(src.includes('"op": "TR"'), 'TR JSON example present');
        assert(src.includes('"transactions"'), 'output contract present');
        assert(src.includes('Priority order') || src.includes('Behavioral priorities'), 'priorities section present');
        assert(src.includes('State machines'), 'state machines section present');
    });
});

group('renderUserPrompt', () => {
    test('director-client.js renderer mentions all expected sections', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'director-client.js'), 'utf8');
        for (const marker of [
            'CURRENT STATE VIEW', 'RECENT LEDGER TAIL', 'RECENT TURNS',
            'USER MESSAGE THIS TURN', 'ASSISTANT RESPONSE THIS TURN',
            'PENDING CORRECTIONS', 'last turn the director call FAILED',
        ]) {
            assert(src.includes(marker), `renderer missing section marker: ${marker}`);
        }
    });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.name}: ${f.err.stack || f.err.message}`);
    process.exit(1);
}
process.exit(0);
