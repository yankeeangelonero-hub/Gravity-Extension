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

group('relationship entity — CR + S', () => {
    test('CR relationship:pc-lacus creates entity with engine-defaulted status=active', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool',
                orientation: 'upright',
                nuance: 'First impression.',
                last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rel = state.relationships?.['pc-lacus'];
        assert(rel !== undefined, 'relationship not in state.relationships');
        assertEqual(rel.card, 'the-fool', 'card');
        assertEqual(rel.orientation, 'upright', 'orientation');
        assertEqual(rel.status, 'active', 'status defaulted to active by engine');
        assertEqual(rel.last_shift, null, 'last_shift null at birth');
    });

    test('S relationship field=card updates card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'relationship', id: 'pc-lacus', d: { f: 'card', v: 'the-hermit' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].card, 'the-hermit', 'card updated');
    });

    test('CR relationship without last_shift defaults to null', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-fool', orientation: 'upright', nuance: 'x',
                // last_shift omitted intentionally
            }},
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].last_shift, null, 'last_shift defaulted to null');
        assertEqual(state.relationships['pc-lacus'].status, 'active', 'status defaulted to active');
    });
});

group('faction.tier', () => {
    test('CR faction with tier=TRACKED stores tier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.zaft.tier, 'TRACKED', 'tier stored');
    });

    test('CR faction without tier defaults to KNOWN', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'shinra', d: { name: 'Shinra' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.shinra.tier, 'KNOWN', 'default tier');
    });

    test('S faction field=tier updates tier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'faction', id: 'zaft', d: { f: 'tier', v: 'PRINCIPAL' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.factions.zaft.tier, 'PRINCIPAL', 'tier updated');
    });
});

group('char.tags', () => {
    test('CR char with tags stores them', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['smuggler', 'archangel'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['smuggler', 'archangel'], 'tags stored');
    });

    test('CR char with >5 tags keeps only first 5', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN',
              tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['a', 'b', 'c', 'd', 'e'], 'tags capped at 5');
    });

    test('A char field=tags appends and respects cap', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['a', 'b', 'c', 'd'] } },
            { tx: 2, op: 'A', e: 'char', id: 'dak', d: { f: 'tags', v: 'e' } },
            { tx: 3, op: 'A', e: 'char', id: 'dak', d: { f: 'tags', v: 'f' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['a', 'b', 'c', 'd', 'e'], 'append respects cap');
    });

    test('CR char with duplicate tags dedupes BEFORE capping', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN',
              tags: ['smuggler', 'smuggler', 'smuggler', 'smuggler', 'smuggler', 'rebel'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.dak.tags, ['smuggler', 'rebel'], 'dedup preserves unique traits');
    });
});

group('pc.scene_cast + pc.current_place_id', () => {
    test('empty state has pc.current_place_id and pc.scene_cast defaults', () => {
        const state = computeState(null, []);
        assertEqual(state.pc.current_place_id, '', 'current_place_id default');
        assertEqual(state.pc.scene_cast, [], 'scene_cast default');
    });

    test('S pc field=current_place_id sets it', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:medbay' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.current_place_id, 'place:medbay', 'place id set');
    });

    test('S pc field=scene_cast replaces array (advance-turn semantics)', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:a', 'char:b'] } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:c'] } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.scene_cast, ['char:c'], 'S replaced cast');
    });

    test('A pc field=scene_cast appends (regular-turn entry semantics)', () => {
        const txs = [
            { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:a'] } },
            { tx: 2, op: 'A', e: 'pc', id: '', d: { f: 'scene_cast', v: 'char:b' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.pc.scene_cast, ['char:a', 'char:b'], 'append extended cast');
    });
});

function makeRel(id, card, orientation, status) {
    return {
        tx: 100, op: 'CR', e: 'relationship', id, d: {
            card, orientation, nuance: 'x', status: status || 'active', last_shift: null,
        }
    };
}

group('engine-driven relationship.status', () => {
    test('TR char tier TRACKED->KNOWN auto-dormants relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'char', id: 'lacus', d: { f: 'tier', from: 'TRACKED', to: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'dormant', 'auto-dormant on demotion');
    });

    test('TR char tier KNOWN->TRACKED auto-activates dormant relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', status: 'dormant', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'char', id: 'lacus', d: { f: 'tier', from: 'KNOWN', to: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'active', 'auto-active on re-promotion');
    });

    test('D char:id auto-archives relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-lacus'].status, 'archived', 'auto-archive on death');
    });

    test('D char:id stamps rel.display_name before entity is removed', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus Clyne', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assert(!state.characters['lacus'], 'entity removed from state.characters');
        assertEqual(state.relationships['pc-lacus'].display_name, 'Lacus Clyne', 'name preserved in rel');
    });

    test('D char:id also scrubs pc.scene_cast reference', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus', 'char:kira'] } },
            { tx: 3, op: 'D', e: 'char', id: 'lacus' },
        ];
        const state = computeState(null, txs);
        assert(!state.pc.scene_cast.includes('char:lacus'), 'dead char scrubbed from scene_cast');
        assert(state.pc.scene_cast.includes('char:kira'), 'living cast member retained');
    });

    test('D faction:id scrubs pc.scene_cast reference', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['faction:zaft'] } },
            { tx: 3, op: 'D', e: 'faction', id: 'zaft' },
        ];
        const state = computeState(null, txs);
        assert(!state.pc.scene_cast.includes('faction:zaft'), 'dead faction scrubbed from scene_cast');
    });

    test('TR faction tier TRACKED->KNOWN auto-dormants faction relationship', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: { name: 'ZAFT', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-zaft', d: {
                card: 'the-chariot', orientation: 'reversed', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'TR', e: 'faction', id: 'zaft', d: { f: 'tier', from: 'TRACKED', to: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.relationships['pc-zaft'].status, 'dormant', 'faction auto-dormant');
    });
});

const { validateTransition } = require('../state-machine.js');

group('state-machine: relationship.status transitions', () => {
    test('active -> dormant allowed', () => {
        const r = validateTransition('relationship', 'status', 'active', 'dormant');
        assertEqual(r.valid, true, 'active->dormant allowed');
    });
    test('dormant -> active allowed', () => {
        const r = validateTransition('relationship', 'status', 'dormant', 'active');
        assertEqual(r.valid, true, 'dormant->active allowed');
    });
    test('active -> archived allowed', () => {
        const r = validateTransition('relationship', 'status', 'active', 'archived');
        assertEqual(r.valid, true, 'active->archived allowed');
    });
    test('archived -> active REJECTED (terminal)', () => {
        const r = validateTransition('relationship', 'status', 'archived', 'active');
        assertEqual(r.valid, false, 'archived is terminal');
    });
});

group('state-machine: faction.tier transitions', () => {
    test('KNOWN -> TRACKED allowed', () => {
        const r = validateTransition('faction', 'tier', 'KNOWN', 'TRACKED');
        assertEqual(r.valid, true, 'promote allowed');
    });
    test('TRACKED -> PRINCIPAL allowed', () => {
        const r = validateTransition('faction', 'tier', 'TRACKED', 'PRINCIPAL');
        assertEqual(r.valid, true, 'promote allowed');
    });
    test('PRINCIPAL -> KNOWN allowed (demotion)', () => {
        const r = validateTransition('faction', 'tier', 'PRINCIPAL', 'KNOWN');
        assertEqual(r.valid, true, 'demote allowed');
    });
});

const consistency = require('../consistency.js');

group('consistency: relationship shape', () => {
    test('CR relationship with invalid card slug rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'made-up-card', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid card should reject');
    });

    test('CR relationship with invalid orientation rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-fool', orientation: 'sideways', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid orientation should reject');
    });

    test('CR relationship with valid fields passes', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'reversed', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid CR should pass');
    });

    test('CR relationship with bad id format rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'lacus-kira', d: {
            card: 'the-fool', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'non-pc-prefixed id should reject');
    });

    test('S relationship last_shift with missing fields rejects', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: { tx: 5, collision_id: 'x' }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'incomplete last_shift should reject');
    });

    test('S relationship last_shift=null REJECTS (audit trail protection)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: null
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S last_shift=null would wipe audit trail — must reject');
    });

    test('CR relationship last_shift=null passes (birth state)', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'null last_shift at birth is legitimate');
    });

    test('S relationship status REJECTS unconditionally (engine-owned)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'status', v: 'active'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S status must reject regardless of value — engine-only field');
    });

    test('CR relationship with omitted status passes (defaults to active)', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'CR without status should pass (defaulted by engine)');
    });

    test('S relationship nuance="" rejects (empty nuance loophole)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: ''
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'empty string nuance must reject');
    });

    test('S relationship nuance=42 rejects (type coercion loophole)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: 42
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'non-string nuance must reject');
    });

    test('S relationship nuance with valid string passes', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'nuance', v: 'The hermit archetype deepens after the Jachin encounter.'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid nuance string passes');
    });

    test('S relationship missing pc- prefix rejects (id prefix bypass)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'lacus', d: {
            f: 'card', v: 'the-hermit'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'missing pc- prefix on S must reject');
    });

    test('CR orientation "Upright" (title-case) passes after normalization', () => {
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'Upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'title-cased orientation should pass after normalization');
    });

    test('S orientation "Reversed" (title-case) passes after normalization', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'orientation', v: 'Reversed'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'title-cased S orientation normalizes to reversed');
    });

    test('S last_shift with string from/to rejects (sub-object validation)', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: 'the-hermit-upright', to: 'the-tower-reversed',
                reason: 'betrayal',
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'string from/to must reject');
    });

    test('S last_shift with valid card-obj from/to passes', () => {
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: { card: 'the-hermit', orientation: 'upright' },
                to: { card: 'the-tower', orientation: 'reversed' },
                reason: 'betrayal at the hangar',
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'valid last_shift with card-obj from/to passes');
    });

    test('S last_shift with reason > 200 chars rejects (token bloat cap)', () => {
        const longReason = 'x'.repeat(201);
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: { card: 'the-hermit', orientation: 'upright' },
                to: { card: 'the-tower', orientation: 'reversed' },
                reason: longReason,
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'reason > 200 chars must reject');
        assert(result.violations.some(v => /too long/i.test(v.message)), 'specific too-long message');
    });

    test('S last_shift with reason exactly 200 chars passes', () => {
        const maxReason = 'x'.repeat(200);
        const tx = { tx: 1, op: 'S', e: 'relationship', id: 'pc-lacus', d: {
            f: 'last_shift', v: {
                tx: 5, collision_id: 'col:duel',
                from: { card: 'the-hermit', orientation: 'upright' },
                to: { card: 'the-tower', orientation: 'reversed' },
                reason: maxReason,
            }
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'reason at exactly 200 chars passes');
    });
});

group('consistency: scene_cast entity-ref validation', () => {
    test('S pc scene_cast with non-existent char rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:ghost'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'hallucinated char id in scene_cast must reject');
        assert(result.violations.some(v => v.field === 'scene_cast'), 'violation on scene_cast field');
    });

    test('A pc scene_cast with non-existent faction rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'A', e: 'pc', id: '', d: { f: 'scene_cast', v: 'faction:phantom' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'hallucinated faction id in scene_cast A must reject');
    });

    test('S pc scene_cast with unsupported type rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['collision:x'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'non-char/faction entity type in scene_cast must reject');
    });

    test('S pc scene_cast with existing char passes', () => {
        const state = { characters: { lacus: { tier: 'TRACKED' } }, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'existing char in scene_cast passes');
    });

    test('S pc scene_cast with existing faction passes', () => {
        const state = { characters: {}, factions: { zaft: { tier: 'PRINCIPAL' } }, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['faction:zaft'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'existing faction in scene_cast passes');
    });

    test('S pc scene_cast with malformed ref (no colon) rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['lacus'] } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'bare id without type prefix must reject');
    });

    test('S pc current_place_id without place: prefix rejects', () => {
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'bridge' } };
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'bare place id without "place:" prefix must reject');
    });

    test('S pc current_place_id with place: prefix passes', () => {
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:bridge' } };
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'well-formed place id passes');
    });

    test('S pc current_place_id null clears field (passes)', () => {
        const tx = { tx: 1, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: null } };
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'null clears place id — allowed');
    });

    test('CR char with >5 tags rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'char', id: 'dak', d: {
            name: 'Dak', tier: 'KNOWN', tags: ['a','b','c','d','e','f']
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'too many tags should reject');
    });

    test('S char tags with >5 entries rejects (S exploit closed)', () => {
        const tx = { tx: 1, op: 'S', e: 'char', id: 'dak', d: {
            f: 'tags', v: ['a','b','c','d','e','f']
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S with >5 tags must reject');
    });

    test('S char tags with non-array rejects', () => {
        const tx = { tx: 1, op: 'S', e: 'char', id: 'dak', d: { f: 'tags', v: 'rebel' } };
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'S tags with string value (not array) must reject');
    });

    test('S char tags with valid array passes', () => {
        const tx = { tx: 1, op: 'S', e: 'char', id: 'dak', d: { f: 'tags', v: ['rebel', 'pilot'] } };
        const result = consistency.validateTransaction(tx, null);
        assert(result.valid, 'S tags with valid ≤5-entry array passes');
    });

    test('CR faction with invalid tier rejects', () => {
        const tx = { tx: 1, op: 'CR', e: 'faction', id: 'zaft', d: {
            name: 'ZAFT', tier: 'SUPREME'
        }};
        const result = consistency.validateTransaction(tx, null);
        assert(!result.valid, 'invalid tier should reject');
    });

    test('second PRINCIPAL char rejects via central validator', () => {
        const state = {
            characters: { kira: { tier: 'PRINCIPAL' } },
            factions: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'second PRINCIPAL char rejected');
    });

    test('TR faction tier to PRINCIPAL when one already exists rejects', () => {
        const state = {
            characters: {},
            factions: { zaft: { tier: 'PRINCIPAL' }, alliance: { tier: 'TRACKED' } },
        };
        const tx = { tx: 1, op: 'TR', e: 'faction', id: 'alliance', d: { f: 'tier', from: 'TRACKED', to: 'PRINCIPAL' } };
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'second PRINCIPAL faction via TR rejected');
    });

    test('same-block double-PRINCIPAL rejects via validateBlock (shadow-state walk)', () => {
        const baseState = { characters: {}, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'char', id: 'ally', d: { name: 'Ally', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'char', id: 'enemy', d: { name: 'Enemy', tier: 'PRINCIPAL' } },
        ];
        const result = consistency.validateBlock(block, baseState);
        assert(!result.valid, 'same-block duplicate PRINCIPAL must reject');
        assert(result.violations.some(v => /PRINCIPAL/i.test(v.message)), 'reason cites PRINCIPAL');
    });

    test('same-block CR + TR pushing two PRINCIPALs rejects', () => {
        const baseState = { characters: {}, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'char', id: 'enemy', d: { name: 'Enemy', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'char', id: 'ally', d: { name: 'Ally', tier: 'TRACKED' } },
            { tx: 3, op: 'TR', e: 'char', id: 'ally', d: { f: 'tier', from: 'TRACKED', to: 'PRINCIPAL' } },
        ];
        const result = consistency.validateBlock(block, baseState);
        assert(!result.valid, 'CR + TR producing two PRINCIPALs must reject');
    });

    test('validateBlock drops only the offending tx, not the whole block', () => {
        const baseState = { characters: {}, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'char', id: 'ally', d: { name: 'Ally', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'char', id: 'npc', d: { name: 'NPC', tier: 'TRACKED' } },
            { tx: 3, op: 'CR', e: 'char', id: 'enemy', d: { name: 'Enemy', tier: 'PRINCIPAL' } },
        ];
        const result = consistency.validateBlock(block, baseState);
        assert(!result.valid, 'block with second PRINCIPAL has violation');
        assert(result.droppedTxIds.has(3), 'tx 3 (second PRINCIPAL) is in droppedTxIds');
        assert(!result.droppedTxIds.has(1), 'tx 1 (first PRINCIPAL) is NOT dropped');
        assert(!result.droppedTxIds.has(2), 'tx 2 (TRACKED) is NOT dropped');
    });

    test('validateBlock does not mutate baseState entities via A ops', () => {
        const baseState = { characters: { lacus: { tier: 'TRACKED', tags: ['pilot'] } }, factions: {}, relationships: {} };
        const block = [
            { tx: 1, op: 'A', e: 'char', id: 'lacus', d: { f: 'tags', v: 'ace' } },
        ];
        consistency.validateBlock(block, baseState);
        assertEqual(baseState.characters.lacus.tags.length, 1, 'validateBlock must not mutate baseState.tags');
    });

    test('validateBlock does not crash on CR of non-char/faction entities', () => {
        const baseState = { characters: {}, factions: {}, relationships: {}, collisions: {} };
        const block = [
            { tx: 1, op: 'CR', e: 'collision', id: 'coll1', d: { label: 'The Reckoning', involved_chars: ['pc'], distance: 3 } },
        ];
        // Must not throw — the shadow now initialises all collections
        let threw = false;
        try { consistency.validateBlock(block, baseState); } catch (e) { threw = true; }
        assert(!threw, 'validateBlock must not throw on collision CR in block');
    });

    test('CR relationship for KNOWN-tier char rejects', () => {
        const state = {
            characters: { flay: { tier: 'KNOWN' } },
            factions: {},
            relationships: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-flay', d: {
            card: 'the-fool', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'CR relationship for KNOWN target must reject');
    });

    test('CR relationship for missing target rejects', () => {
        const state = { characters: {}, factions: {}, relationships: {} };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-ghost', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(!result.valid, 'CR relationship for nonexistent target rejects');
    });

    test('CR relationship for TRACKED+ target passes', () => {
        const state = {
            characters: { lacus: { tier: 'PRINCIPAL' } },
            factions: {},
            relationships: {},
        };
        const tx = { tx: 1, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
            card: 'the-hermit', orientation: 'upright', nuance: 'x', last_shift: null,
        }};
        const result = consistency.validateTransaction(tx, state);
        assert(result.valid, 'TRACKED+ target should pass');
    });
});

const { formatStateView } = require('../state-view.js');

group('state-view render — relationship block', () => {
    test('active relationship renders with ♥ line', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL', tags: ['idol'] } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'reversed', nuance: 'Hermit because...', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('Bond (PC): The Hermit · reversed'), 'relationship line present');
        assert(rendered.includes('Tags: [idol]'), 'tags line present');
    });

    test('dormant relationship does not render Bond line', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'reversed', nuance: 'x', status: 'dormant', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(!rendered.includes('Bond (PC): The Hermit'), 'dormant should not render the bond line');
    });

    test('archived relationship for dead char renders as memorial', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'nicol', d: { name: 'Nicol', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-nicol', d: {
                card: 'the-star', orientation: 'upright', nuance: 'x', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'relationship', id: 'pc-nicol', d: {
                f: 'last_shift', v: { tx: 3, collision_id: 'col:duel', from: { card: 'the-star', orientation: 'upright' }, to: { card: 'the-star', orientation: 'upright' }, reason: 'killed in duel' },
            }},
            { tx: 4, op: 'D', e: 'char', id: 'nicol' },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('MEMORIALS'), 'memorial section present');
        assert(rendered.includes('† Nicol'), 'dead char has memorial line');
        assert(rendered.includes('The Star'), 'memorial shows card');
        assert(rendered.includes('killed in duel'), 'memorial shows last_shift reason');
    });

    test('archived relationship with living target is NOT memorialized', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'rau', d: { name: 'Rau', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-rau', d: {
                card: 'the-tower', orientation: 'reversed', nuance: 'x', status: 'archived', last_shift: null,
            }},
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(!rendered.includes('MEMORIALS'), 'no memorial when target is alive');
    });
});

group('lean phonebook — cast gating', () => {
    test('TRACKED char in scene_cast renders full dossier', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'n', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('CHARACTER: Lacus [TRACKED]'), 'full dossier for in-cast');
    });

    test('PRINCIPAL char off-stage renders one-liner', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'PRINCIPAL' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'n', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: [] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('PRINCIPAL (off-stage): Lacus'), 'principal off-stage one-liner');
        assert(!rendered.includes('CHARACTER: Lacus [PRINCIPAL]'), 'should NOT render full dossier');
    });

    test('TRACKED char off-stage renders compact line without card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'mu', d: { name: 'Mu', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-mu', d: {
                card: 'the-chariot', orientation: 'upright', nuance: 'n', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: [] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('TRACKED (off-stage): Mu'), 'tracked off-stage one-liner');
        assert(!rendered.includes('The Chariot'), 'should NOT show card for off-stage TRACKED');
    });

    test('KNOWN char in scene_cast renders mid-weight block (not roll-up)', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['bartender'] } },
            { tx: 2, op: 'S', e: 'char', id: 'dak', d: { f: 'agenda', v: 'keeps the peace' } },
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:dak'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('CHARACTER: Dak [KNOWN · on-stage]'), 'mid-weight header');
        assert(rendered.includes('Tags: [bartender]'), 'tags present');
        assert(rendered.includes('keeps the peace'), 'agenda present');
        assert(!rendered.includes('♥ Bond'), 'no card for KNOWN');
    });

    test('dormant char on-stage by location re-injects with card', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'flay', d: { name: 'Flay', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-flay', d: {
                card: 'death', orientation: 'upright', nuance: 'g', status: 'dormant', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:bridge' } },
            { tx: 4, op: 'S', e: 'char', id: 'flay', d: { f: 'location', v: 'place:bridge' } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('DORMANT (on-stage): Flay'), 'dormant-on-stage re-injects');
    });

    test('dormant char: bare char.location matches place:-prefixed current_place_id', () => {
        // char.location is stored as bare id ("bridge"), current_place_id as "place:bridge"
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'flay', d: { name: 'Flay', tier: 'KNOWN' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-flay', d: {
                card: 'death', orientation: 'upright', nuance: 'g', status: 'dormant', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'current_place_id', v: 'place:bridge' } },
            { tx: 4, op: 'S', e: 'char', id: 'flay', d: { f: 'location', v: 'bridge' } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('DORMANT (on-stage): Flay'), 'bare location matches place:-prefixed current_place_id');
    });

    test('character headers include entity ID token', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'lacus', d: { name: 'Lacus', tier: 'TRACKED' } },
            { tx: 2, op: 'CR', e: 'relationship', id: 'pc-lacus', d: {
                card: 'the-hermit', orientation: 'upright', nuance: 'n', last_shift: null,
            }},
            { tx: 3, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['char:lacus'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('→ id: lacus'), 'entity ID present in prompt for LLM reference');
    });

    test('KNOWN faction in scene_cast renders lightweight (not full dossier)', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'faction', id: 'alliance', d: { name: 'Alliance', tier: 'KNOWN', agenda: 'patrol the lane' } },
            { tx: 2, op: 'S', e: 'pc', id: '', d: { f: 'scene_cast', v: ['faction:alliance'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('FACTION: Alliance [KNOWN · on-stage]'), 'lightweight faction header for KNOWN in cast');
        assert(rendered.includes('patrol the lane'), 'agenda present for KNOWN in-cast faction');
        assert(!rendered.includes('Knowledge asymmetry:'), 'no KA for KNOWN in-cast faction (lightweight only)');
    });
});

group('char.last_active_tx stamping', () => {
    test('CR stamps last_active_tx = tx.tx', () => {
        const txs = [
            { tx: 5, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 5, 'stamp on CR');
    });

    test('S updates last_active_tx to latest tx', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
            { tx: 42, op: 'S', e: 'char', id: 'a', d: { f: 'location', v: 'place:x' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 42, 'S updates stamp');
    });

    test('TR on char also updates last_active_tx', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'a', d: { name: 'A', tier: 'KNOWN' } },
            { tx: 17, op: 'TR', e: 'char', id: 'a', d: { f: 'tier', from: 'KNOWN', to: 'TRACKED' } },
        ];
        const state = computeState(null, txs);
        assertEqual(state.characters.a.last_active_tx, 17, 'TR updates stamp');
    });
});

group('state-view — KNOWN roll-up', () => {
    test('KNOWN chars render with tags', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', tags: ['smuggler', 'archangel'] } },
            { tx: 2, op: 'CR', e: 'char', id: 'finch', d: { name: 'Old Finch', tier: 'KNOWN', tags: ['engineer'] } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('• Dak [smuggler, archangel]'), 'Dak with tags');
        assert(rendered.includes('• Old Finch [engineer]'), 'Finch with tag');
    });

    test('KNOWN without tags falls back to agenda', () => {
        const txs = [
            { tx: 1, op: 'CR', e: 'char', id: 'dak', d: { name: 'Dak', tier: 'KNOWN', agenda: 'Runs the night shift.' } },
        ];
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('• Dak — "Runs the night shift."'), 'agenda fallback');
    });

    test('KNOWN > 15 shows top-15 plus older-rollup', () => {
        const txs = [];
        for (let i = 0; i < 20; i++) {
            txs.push({ tx: i + 1, op: 'CR', e: 'char', id: `k${i}`, d: { name: `K${i}`, tier: 'KNOWN', tags: ['a'] } });
        }
        const state = computeState(null, txs);
        const rendered = formatStateView(state, { mode: 'regular' });
        assert(rendered.includes('Older KNOWN (5 inactive):'), 'older rollup present');
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
