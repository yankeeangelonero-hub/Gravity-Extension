// scripts/test-missing-rel-clear.js
// Tests that the missing-rel scan actively clears stale _pendingCorrections entries
// when the satisfying relationship now exists in state.
//
// Approach A — tests the filtering contract directly in isolation. The scan logic
// is replicated inline (mirroring the four edited spots in index.js) so that no
// SillyTavern globals are required.
//
// Usage: node scripts/test-missing-rel-clear.js
// Exit code: 0 if all pass, 1 if any fail.

'use strict';

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

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label || 'assertEqual'}: expected ${e}, got ${a}`);
}

// ─── Inline scan helpers (mirrors the four edited spots in index.js) ──────────

/**
 * Run the missing-relationship scan for chars and factions.
 * Mutates pendingCorrections in place; returns it for convenience.
 */
function runMissingRelScan(state, pendingCorrections) {
    const relationships = state.relationships || {};

    // Spot 1 — chars
    for (const [id, char] of Object.entries(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
        const rawKey = `[missing-relationship:char:${id}]`;
        if (relationships[`pc-${id}`]) {
            // Active-clear — mirrors index.js Spot 1
            const before = pendingCorrections.length;
            pendingCorrections.splice(0, pendingCorrections.length,
                ...pendingCorrections.filter(c => c.raw !== rawKey));
            continue;
        }
        // Queue if not already present
        if (!pendingCorrections.find(c => c.raw === rawKey)) {
            pendingCorrections.push({ raw: rawKey, error: `char:${id} needs relationship:pc-${id}` });
        }
    }

    // Spot 2 — factions
    for (const [id, f] of Object.entries(state.factions || {})) {
        const tier = String(f?.tier || '').toUpperCase();
        if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
        const rawKey = `[missing-relationship:faction:${id}]`;
        if (relationships[`pc-${id}`]) {
            // Active-clear — mirrors index.js Spot 2
            pendingCorrections.splice(0, pendingCorrections.length,
                ...pendingCorrections.filter(c => c.raw !== rawKey));
            continue;
        }
        if (!pendingCorrections.find(c => c.raw === rawKey)) {
            pendingCorrections.push({ raw: rawKey, error: `faction:${id} needs relationship:pc-${id}` });
        }
    }

    return pendingCorrections;
}

/**
 * Run the orphan-relational + missing-rel-update scan.
 * Mutates pendingCorrections; returns it.
 */
function runOrphanScan(state, pendingCorrections) {
    const relationships = state.relationships || {};

    for (const [cid, col] of Object.entries(state.collisions || {})) {
        const orphanKey = `[orphan-relational:${cid}]`;
        if (col?.ignition_class !== 'relational') {
            // Spot 3 path B — ignition_class changed; active-clear stale orphan key
            pendingCorrections.splice(0, pendingCorrections.length,
                ...pendingCorrections.filter(c => c.raw !== orphanKey));
            continue;
        }
        const status = String(col?.status || '').toUpperCase();
        if (status !== 'RESOLVED' && status !== 'CRASHED') continue;
        const involved = Array.isArray(col.involved_chars) ? col.involved_chars : [];
        const other = involved.find(x => x && x !== 'pc');
        if (!other) continue;
        const bareOther = String(other).replace(/^(char|faction):/, '');
        const relId = `pc-${bareOther}`;
        const rel = relationships[relId];
        if (!rel) {
            if (!pendingCorrections.find(c => c.raw === orphanKey)) {
                pendingCorrections.push({ raw: orphanKey, error: `orphan: ${cid}` });
            }
            continue;
        }
        // Spot 3 path A — relationship exists; active-clear orphan key
        pendingCorrections.splice(0, pendingCorrections.length,
            ...pendingCorrections.filter(c => c.raw !== orphanKey));

        // Spot 4 — missing-rel-update
        const updateKey = `[missing-rel-update:${cid}]`;
        if (rel.last_shift && rel.last_shift.collision_id === cid) {
            pendingCorrections.splice(0, pendingCorrections.length,
                ...pendingCorrections.filter(c => c.raw !== updateKey));
            continue;
        }
        const history = (state._history?.[`relationship:${relId}:last_shift`]) || [];
        const alreadyPaired = history.some(e => e && e.to && typeof e.to === 'object' && e.to.collision_id === cid);
        if (alreadyPaired) {
            pendingCorrections.splice(0, pendingCorrections.length,
                ...pendingCorrections.filter(c => c.raw !== updateKey));
            continue;
        }
        if (!pendingCorrections.find(c => c.raw === updateKey)) {
            pendingCorrections.push({ raw: updateKey, error: `missing rel update for ${cid}` });
        }
    }

    return pendingCorrections;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

group('faction missing-relationship: queue then clear', () => {
    test('queues [missing-relationship:faction:los-illuminados] when rel absent', () => {
        const state = {
            factions: { 'los-illuminados': { tier: 'TRACKED' } },
            characters: {},
            relationships: {},
        };
        const pending = [];
        runMissingRelScan(state, pending);
        assert(
            pending.some(c => c.raw === '[missing-relationship:faction:los-illuminados]'),
            'correction should be queued'
        );
    });

    test('clears [missing-relationship:faction:los-illuminados] when rel now exists', () => {
        const state = {
            factions: { 'los-illuminados': { tier: 'TRACKED' } },
            characters: {},
            relationships: { 'pc-los-illuminados': { card: 'the-moon', orientation: 'upright' } },
        };
        // Simulate a stale correction from the previous turn
        const pending = [{ raw: '[missing-relationship:faction:los-illuminados]', error: 'stale', attempts: 1 }];
        runMissingRelScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[missing-relationship:faction:los-illuminados]'),
            'correction should be cleared'
        );
        assertEqual(pending.length, 0, 'pending should be empty');
    });
});

group('char missing-relationship: queue then clear', () => {
    test('queues [missing-relationship:char:ada-wong] when rel absent', () => {
        const state = {
            characters: { 'ada-wong': { tier: 'PRINCIPAL' } },
            factions: {},
            relationships: {},
        };
        const pending = [];
        runMissingRelScan(state, pending);
        assert(
            pending.some(c => c.raw === '[missing-relationship:char:ada-wong]'),
            'correction should be queued'
        );
    });

    test('clears [missing-relationship:char:ada-wong] when rel now exists', () => {
        const state = {
            characters: { 'ada-wong': { tier: 'PRINCIPAL' } },
            factions: {},
            relationships: { 'pc-ada-wong': { card: 'the-star', orientation: 'reversed' } },
        };
        const pending = [{ raw: '[missing-relationship:char:ada-wong]', error: 'stale', attempts: 1 }];
        runMissingRelScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[missing-relationship:char:ada-wong]'),
            'correction should be cleared'
        );
        assertEqual(pending.length, 0, 'pending should be empty');
    });

    test('TRACKED chars below threshold are not queued', () => {
        const state = {
            characters: { 'minor-npc': { tier: 'BACKGROUND' } },
            factions: {},
            relationships: {},
        };
        const pending = [];
        runMissingRelScan(state, pending);
        assertEqual(pending.length, 0, 'BACKGROUND char should not trigger correction');
    });
});

group('orphan-relational: queue then clear', () => {
    test('queues [orphan-relational:cid-1] when rel is missing for resolved relational collision', () => {
        const state = {
            collisions: {
                'cid-1': {
                    ignition_class: 'relational',
                    status: 'RESOLVED',
                    involved_chars: ['pc', 'char:ada-wong'],
                },
            },
            relationships: {},
        };
        const pending = [];
        runOrphanScan(state, pending);
        assert(
            pending.some(c => c.raw === '[orphan-relational:cid-1]'),
            'orphan-relational correction should be queued'
        );
    });

    test('clears [orphan-relational:cid-1] when rel now exists', () => {
        const state = {
            collisions: {
                'cid-1': {
                    ignition_class: 'relational',
                    status: 'RESOLVED',
                    involved_chars: ['pc', 'char:ada-wong'],
                },
            },
            relationships: {
                'pc-ada-wong': { card: 'the-tower', orientation: 'upright', last_shift: null },
            },
        };
        const pending = [{ raw: '[orphan-relational:cid-1]', error: 'stale', attempts: 1 }];
        runOrphanScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[orphan-relational:cid-1]'),
            'orphan-relational correction should be cleared'
        );
    });

    test('clears [orphan-relational:cid-1] when ignition_class changed away from relational', () => {
        const state = {
            collisions: {
                'cid-1': {
                    ignition_class: 'environmental',
                    status: 'RESOLVED',
                    involved_chars: ['pc', 'char:ada-wong'],
                },
            },
            relationships: {},
        };
        const pending = [{ raw: '[orphan-relational:cid-1]', error: 'stale from prev turn', attempts: 1 }];
        runOrphanScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[orphan-relational:cid-1]'),
            'orphan-relational correction should be cleared when ignition_class changed'
        );
    });
});

group('missing-rel-update: queue then clear', () => {
    test('queues [missing-rel-update:cid-2] when rel exists but last_shift not set', () => {
        const state = {
            collisions: {
                'cid-2': {
                    ignition_class: 'relational',
                    status: 'CRASHED',
                    involved_chars: ['pc', 'leon-kennedy'],
                },
            },
            relationships: {
                'pc-leon-kennedy': { card: 'the-hermit', orientation: 'upright', last_shift: null },
            },
        };
        const pending = [];
        runOrphanScan(state, pending);
        assert(
            pending.some(c => c.raw === '[missing-rel-update:cid-2]'),
            'missing-rel-update correction should be queued'
        );
    });

    test('clears [missing-rel-update:cid-2] when rel.last_shift now references the collision', () => {
        const state = {
            collisions: {
                'cid-2': {
                    ignition_class: 'relational',
                    status: 'CRASHED',
                    involved_chars: ['pc', 'leon-kennedy'],
                },
            },
            relationships: {
                'pc-leon-kennedy': {
                    card: 'the-hermit',
                    orientation: 'reversed',
                    last_shift: { collision_id: 'cid-2', reason: 'resolved in crash' },
                },
            },
        };
        const pending = [{ raw: '[missing-rel-update:cid-2]', error: 'stale', attempts: 1 }];
        runOrphanScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[missing-rel-update:cid-2]'),
            'missing-rel-update correction should be cleared'
        );
    });

    test('clears [missing-rel-update:cid-2] when history shows the pairing', () => {
        const state = {
            collisions: {
                'cid-2': {
                    ignition_class: 'relational',
                    status: 'CRASHED',
                    involved_chars: ['pc', 'leon-kennedy'],
                },
            },
            relationships: {
                'pc-leon-kennedy': { card: 'the-hermit', orientation: 'upright', last_shift: null },
            },
            _history: {
                'relationship:pc-leon-kennedy:last_shift': [
                    { from: null, to: { collision_id: 'cid-2', reason: 'resolved' } },
                ],
            },
        };
        const pending = [{ raw: '[missing-rel-update:cid-2]', error: 'stale', attempts: 1 }];
        runOrphanScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[missing-rel-update:cid-2]'),
            'missing-rel-update correction should be cleared via history'
        );
    });
});

group('no false-clears: unrelated corrections survive', () => {
    test('unrelated corrections are untouched by char scan', () => {
        const state = {
            characters: { 'ada-wong': { tier: 'PRINCIPAL' } },
            factions: {},
            relationships: { 'pc-ada-wong': { card: 'the-star', orientation: 'upright' } },
        };
        const pending = [
            { raw: '[missing-relationship:char:ada-wong]', error: 'stale', attempts: 1 },
            { raw: '[some-other-correction:xyz]', error: 'keep me', attempts: 0 },
        ];
        runMissingRelScan(state, pending);
        assert(
            !pending.some(c => c.raw === '[missing-relationship:char:ada-wong]'),
            'ada-wong correction cleared'
        );
        assert(
            pending.some(c => c.raw === '[some-other-correction:xyz]'),
            'unrelated correction must survive'
        );
    });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.log('\nFailed tests:');
    for (const { name, err } of failures) {
        console.log(`  - ${name}: ${err.message}`);
    }
}
process.exit(failed > 0 ? 1 : 0);
