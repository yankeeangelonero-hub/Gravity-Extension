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
