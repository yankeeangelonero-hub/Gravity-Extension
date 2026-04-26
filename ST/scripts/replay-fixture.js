// scripts/replay-fixture.js
// Usage: node scripts/replay-fixture.js <path-to-session-json>
// Loads a SillyTavern chat metadata export (or a bare gravity_ledger dump)
// and replays transactions through state-compute.js, printing audit lines
// that surface schema-drift bugs.

'use strict';

const fs = require('fs');
const path = require('path');

const { computeState } = require('../state-compute.js');

const fixturePath = process.argv[2];
if (!fixturePath) {
    console.error('Usage: node scripts/replay-fixture.js <session.json>');
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Support two shapes:
//   1. Full ST chat export: raw.chat_metadata.gravity_ledger.transactions
//   2. Bare gravity_ledger dump: raw.transactions
const txs = raw.chat_metadata?.gravity_ledger?.transactions || raw.transactions;

if (!Array.isArray(txs)) {
    console.error('No transactions[] found in fixture');
    process.exit(1);
}

console.log(`Loaded ${txs.length} transactions from ${path.basename(fixturePath)}`);

// computeState(snapshot, transactions) — pass null snapshot to start fresh
const state = computeState(null, txs);

// ─── Constraint shape audit ───────────────────────────────────────────────────
console.log('\n--- Constraint shape audit ---');
const constraints = Object.values(state.constraints || {});
if (constraints.length === 0) {
    console.log('(no constraints)');
} else {
    for (const c of constraints) {
        console.log(
            `${c.id}: owner_id=${c.owner_id} profile="${String(c.profile || '').slice(0, 40)}..." shedding_order=${c.shedding_order}`
        );
    }
}

// ─── Char orphan audit ────────────────────────────────────────────────────────
console.log('\n--- Char orphan audit ---');
// 'reads' is intentionally absent: normalizeCharacterKnowledgeAsymmetry() in state-compute.js deletes it unconditionally, so it can never appear post-replay.
const ORPHAN_FIELDS = ['want', 'doing', 'stance_toward_pc', 'cost'];
let orphanFound = false;
for (const ch of Object.values(state.characters || {})) {
    const orphans = ORPHAN_FIELDS.filter(f => ch[f] !== undefined);
    if (orphans.length) {
        console.log(`${ch.id}: orphan fields=${orphans.join(',')}`);
        orphanFound = true;
    }
}
if (!orphanFound) console.log('(none)');

// ─── Combat opened_from audit ─────────────────────────────────────────────────
console.log('\n--- Combat opened_from audit ---');
const combats = Object.values(state.combats || {});
if (combats.length === 0) {
    console.log('(no combats)');
} else {
    for (const cb of combats) {
        console.log(`${cb.id}: opened_from=${cb.opened_from || 'MISSING'} primary_enemy=${cb.primary_enemy}`);
    }
}

// ─── Collision ignition audit ─────────────────────────────────────────────────
console.log('\n--- Collision ignition audit ---');
let ignitionMissing = false;
for (const col of Object.values(state.collisions || {})) {
    if (!col.fires_when && !col.ignition_class) {
        console.log(`${col.id}: MISSING fires_when AND ignition_class`);
        ignitionMissing = true;
    }
}
if (!ignitionMissing) console.log('(all collisions have fires_when or ignition_class)');

// ─── Relationship audit ───────────────────────────────────────────────────────
console.log('\n--- Relationship audit ---');
let relProblems = false;
// TRACKED+ chars should have a relationship
for (const [id, char] of Object.entries(state.characters || {})) {
    const tier = String(char.tier || '').toUpperCase();
    if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
    const rel = state.relationships?.[`pc-${id}`];
    if (!rel) {
        console.log(`  MISSING: char:${id} [${tier}] has no relationship:pc-${id}`);
        relProblems = true;
    } else if (rel.status === 'archived') {
        console.log(`  STALE: char:${id} is ${tier} but relationship:pc-${id} is archived`);
        relProblems = true;
    }
}
// Orphan: relationship exists but target doesn't
for (const [relId, rel] of Object.entries(state.relationships || {})) {
    if (!relId.startsWith('pc-')) continue;
    const otherId = relId.slice('pc-'.length);
    const charExists = state.characters?.[otherId];
    const factionExists = state.factions?.[otherId];
    if (!charExists && !factionExists && rel.status !== 'archived') {
        console.log(`  ORPHAN: ${relId} exists but target ${otherId} does not`);
        relProblems = true;
    }
}
if (!relProblems) console.log('(none)');

// ─── Collision-relationship pairing audit ─────────────────────────────────────
console.log('\n--- Collision-relationship pairing audit ---');
let pairingProblems = false;
for (const [cid, col] of Object.entries(state.collisions || {})) {
    if (col.ignition_class !== 'relational') continue;
    if (col.status !== 'RESOLVED' && col.status !== 'CRASHED') continue;
    const other = (col.involved_chars || []).find(x => x !== 'pc');
    if (!other) {
        console.log(`  MALFORMED: collision:${cid} is relational but involved_chars has no non-pc party`);
        pairingProblems = true;
        continue;
    }
    const relId = other.replace(/^(char|faction):/, 'pc-');
    const rel = state.relationships?.[relId];
    if (!rel) {
        console.log(`  MISSING-REL: collision:${cid} resolved for ${relId} but relationship does not exist`);
        pairingProblems = true;
        continue;
    }
    if (rel.last_shift?.collision_id !== cid) {
        console.log(`  MISSING-UPDATE: collision:${cid} resolved but relationship:${relId}.last_shift.collision_id != "${cid}"`);
        pairingProblems = true;
    }
}
if (!pairingProblems) console.log('(none)');

// ─── Tag audit ─────────────────────────────────────────────────────────────────
console.log('\n--- Tag audit ---');
let tagProblems = false;
for (const [id, char] of Object.entries(state.characters || {})) {
    const tags = char.tags;
    if (!Array.isArray(tags)) continue;
    if (tags.length > 5) {
        console.log(`  ${id}: ${tags.length} tags (cap 5)`);
        tagProblems = true;
    }
    for (const t of tags) {
        if (typeof t !== 'string') {
            console.log(`  ${id}: non-string tag ${JSON.stringify(t)}`);
            tagProblems = true;
        } else if (t.length > 40) {
            console.log(`  ${id}: tag "${t.slice(0, 30)}..." exceeds 40 chars`);
            tagProblems = true;
        }
    }
}
if (!tagProblems) console.log('(none)');

// ─── PRINCIPAL uniqueness audit ───────────────────────────────────────────────
console.log('\n--- PRINCIPAL uniqueness audit ---');
const principalChars = Object.entries(state.characters || {}).filter(([, c]) => String(c.tier || '').toUpperCase() === 'PRINCIPAL');
const principalFactions = Object.entries(state.factions || {}).filter(([, f]) => String(f.tier || '').toUpperCase() === 'PRINCIPAL');
let uniqProblems = false;
if (principalChars.length > 1) {
    console.log(`  MULTIPLE PRINCIPAL chars: ${principalChars.map(([id]) => id).join(', ')}`);
    uniqProblems = true;
}
if (principalFactions.length > 1) {
    console.log(`  MULTIPLE PRINCIPAL factions: ${principalFactions.map(([id]) => id).join(', ')}`);
    uniqProblems = true;
}
if (!uniqProblems) console.log('(one or zero PRINCIPAL of each type)');

// ─── Scene cast audit ──────────────────────────────────────────────────────────
console.log('\n--- Scene cast audit ---');
const castItems = state.pc?.scene_cast || [];
let castProblems = false;
for (const ref of castItems) {
    if (typeof ref !== 'string' || !ref.includes(':')) {
        console.log(`  MALFORMED: "${ref}" is not a valid entity ref`);
        castProblems = true;
        continue;
    }
    const [type, id] = ref.split(':');
    const exists = (type === 'char' && state.characters?.[id]) ||
                   (type === 'faction' && state.factions?.[id]);
    if (!exists) {
        console.log(`  DANGLING: scene_cast has "${ref}" but entity does not exist`);
        castProblems = true;
    }
}
if (castItems.length > 6) {
    console.log(`  OVERFULL: scene_cast has ${castItems.length} members (soft cap 6)`);
    castProblems = true;
}
if (!castProblems) console.log('(none)');
