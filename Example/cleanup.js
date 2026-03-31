/**
 * cleanup.js — Load ledger JSON, compute state, identify issues, generate fixes.
 *
 * Run: node Example/cleanup.js
 * Output: Example/cleaned.json
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'Tifa Lockhart - 2026-03-24@14h51m30s655ms - Branch #1 (2).json');
const OUTPUT = path.join(__dirname, 'cleaned.json');

// ─── Minimal state compute (standalone, no imports needed) ─────────────────

function createEmptyState() {
    return {
        characters: {}, constraints: {}, collisions: {}, chapters: {},
        factions: {}, world: { world_state: '', pressure_points: [], constants: {}, knowledge_asymmetry: {} },
        pc: { name: '', demonstrated_traits: [], reputation: {}, timeline: [] },
        divination: { active_system: '', last_draw: null, readings: [] },
        story_summary: [], lastTxId: -1, _history: {},
    };
}

function applyTransaction(state, tx) {
    const collectionMap = {
        char: 'characters', constraint: 'constraints', collision: 'collisions',
        chapter: 'chapters', faction: 'factions', world: 'world', pc: 'pc',
        divination: 'divination', summary: 'story_summary',
    };
    const collection = collectionMap[tx.e] || tx.e;
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);
    const isSummary = tx.e === 'summary';

    if (isSummary && tx.op === 'A') {
        state.story_summary.push({
            text: tx.d.v || tx.d.value || tx.d.text || '',
            chapter: tx.d.chapter || '', t: tx.t || '', _ts: tx._ts || '',
        });
        state.lastTxId = tx.tx;
        return state;
    }

    switch (tx.op) {
        case 'CR': {
            if (isSingleton) Object.assign(state[collection], tx.d);
            else state[collection][tx.id] = { id: tx.id, ...tx.d };
            break;
        }
        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) target[tx.d.f] = tx.d.to;
            break;
        }
        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) target[tx.d.f] = tx.d.v;
            break;
        }
        case 'A': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (!Array.isArray(target[tx.d.f])) target[tx.d.f] = [];
                target[tx.d.f].push(tx.d.v);
            }
            break;
        }
        case 'R': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f && Array.isArray(target[tx.d.f])) {
                target[tx.d.f] = target[tx.d.f].filter(item =>
                    typeof item === 'string' ? item !== tx.d.v : JSON.stringify(item) !== JSON.stringify(tx.d.v)
                );
            }
            break;
        }
        case 'MS': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (typeof target[tx.d.f] !== 'object' || Array.isArray(target[tx.d.f])) target[tx.d.f] = {};
                target[tx.d.f][tx.d.k] = tx.d.v;
            }
            break;
        }
        case 'MR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f && typeof target[tx.d.f] === 'object') {
                delete target[tx.d.f][tx.d.k];
            }
            break;
        }
        case 'D': {
            if (!isSingleton) delete state[collection][tx.id];
            break;
        }
    }
    state.lastTxId = tx.tx;
    return state;
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('Loading ledger...');
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const txns = data.transactions || [];
console.log(`  ${txns.length} transactions, lastTxId: ${data.lastTxId}`);

// Find latest snapshot to start from
const snapshots = data.snapshots || [];
let state;
let startIdx = 0;

if (snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    console.log(`  Starting from snapshot #${latest.id} (tx ${latest.lastTxId})`);
    state = JSON.parse(JSON.stringify(latest.state));
    state._history = state._history || {};
    startIdx = txns.findIndex(tx => tx.tx > latest.lastTxId);
    if (startIdx === -1) startIdx = txns.length;
} else {
    state = createEmptyState();
}

// Replay remaining transactions
console.log(`  Replaying ${txns.length - startIdx} transactions from index ${startIdx}...`);
for (let i = startIdx; i < txns.length; i++) {
    applyTransaction(state, txns[i]);
}

// ─── Analyze ───────────────────────────────────────────────────────────────

console.log('\n═══ STATE ANALYSIS ═══');

// Characters
const chars = Object.values(state.characters);
console.log(`\nCharacters: ${chars.length}`);
for (const c of chars) {
    console.log(`  ${c.tier} "${c.name || c.id}" power:${c.power || 'unset'} location:${c.location || 'unset'}`);
}

// PC
console.log(`\nPC: ${state.pc.name}`);
console.log(`  power: ${state.pc.power || 'unset'}`);
console.log(`  location: ${state.pc.location || 'unset'}`);
console.log(`  condition: ${state.pc.condition || 'unset'}`);
console.log(`  equipment: ${state.pc.equipment || 'unset'}`);
console.log(`  doing: ${state.pc.doing || 'unset'}`);
console.log(`  traits: ${(state.pc.demonstrated_traits || []).length} entries`);
console.log(`  timeline: ${(state.pc.timeline || []).length} entries`);
console.log(`  knowledge_gaps: ${(state.pc.knowledge_gaps || []).length} entries`);

// Constraints
const constraints = Object.values(state.constraints);
console.log(`\nConstraints: ${constraints.length}`);
for (const c of constraints) {
    const owner = state.characters[c.owner_id]?.name || c.owner_id;
    console.log(`  ${c.name} [${c.integrity}] (${owner}) pressure: ${c.current_pressure ? 'set' : 'unset'}`);
}

// Collisions
const collisions = Object.values(state.collisions);
console.log(`\nCollisions: ${collisions.length}`);
for (const c of collisions) {
    const forces = Array.isArray(c.forces) ? c.forces.map(f => f.name || f).join(', ') : String(c.forces || '?');
    console.log(`  ${c.name || c.id} [${c.status}] dist:${c.distance || '?'} forces: ${forces}`);
}

// Summary
console.log(`\nStory summary: ${state.story_summary.length} entries`);

// Factions
const factions = Object.values(state.factions);
console.log(`\nFactions: ${factions.length}`);
for (const f of factions) {
    const relCount = f.relations ? Object.keys(f.relations).length : 0;
    console.log(`  ${f.name || f.id} power:${f.power || '?'} momentum:${f.momentum ? 'set' : 'unset'} relations:${relCount}`);
}

// World constants
console.log(`\nWorld constants: ${Object.keys(state.world.constants || {}).keys}`);
for (const [k, v] of Object.entries(state.world.constants || {})) {
    console.log(`  ${k}: ${String(v).substring(0, 60)}...`);
}

// Divination
console.log(`\nDivination: system=${state.divination.active_system || 'unset'} last_draw=${state.divination.last_draw || 'none'}`);

// ─── Generate Corrective Transactions ──────────────────────────────────────

console.log('\n═══ GENERATING FIXES ═══');
const fixes = [];
let nextTxId = data.lastTxId + 1;
const now = new Date().toISOString();
const ts = '[Day 8 — 23:59]'; // Cleanup timestamp

function fix(op, e, id, d, reason) {
    fixes.push({ tx: nextTxId++, t: ts, _ts: now, op, e, id: id || '', d, r: `[CLEANUP] ${reason}` });
}

// 1. Fix PC doing if stale
if (state.pc.doing && state.pc.doing.toLowerCase().includes('sector 5')) {
    fix('S', 'pc', '', { f: 'doing', v: 'Post-forge. In storeroom with Tifa. Processing.' }, 'Stale doing — Sector 5 move was cancelled Day 7');
    console.log('  FIX: PC doing (stale Sector 5 reference)');
}

// 2. Add knowledge_gaps if missing
if (!state.pc.knowledge_gaps || state.pc.knowledge_gaps.length === 0) {
    const gaps = [
        "Carver's true loyalties and whether he's Shinra-loyal or opportunistic",
        "Whether Barret knew the transit frame priority was triggered by his own gun-arm",
        "Aerith's nature as the last Cetra/Ancient",
        "Cloud's personal history with Aerith (pre-existing relationship)",
        "The shape Tifa saw — Cloud's involuntary responses to Aerith-adjacent stimuli",
        "Shinra investigation progress — Tanaka cross-referencing lock bypass patterns",
    ];
    for (const gap of gaps) {
        fix('A', 'pc', '', { f: 'knowledge_gaps', v: gap }, 'Knowledge gap initialization');
    }
    console.log(`  FIX: Added ${gaps.length} knowledge_gaps`);
}

// 3. Fix divination system if arcana but should be iching
if (state.divination.active_system === 'arcana' || !state.divination.active_system) {
    // Keep as-is unless user specified iching — we'll note it
    console.log(`  NOTE: Divination system is "${state.divination.active_system || 'unset'}" — user may want to SET to iching`);
}

// 4. Normalize collision forces to arrays
for (const [id, col] of Object.entries(state.collisions)) {
    if (col.forces && typeof col.forces === 'string') {
        const arr = col.forces.split(',').map(s => s.trim()).filter(Boolean);
        fix('S', 'collision', id, { f: 'forces', v: arr }, `Normalize forces from string to array`);
        console.log(`  FIX: Normalize forces on collision:${id}`);
    }
}

// 5. Consolidate story_summary if over 30 entries
const summaries = state.story_summary;
if (summaries.length > 30) {
    console.log(`  CONSOLIDATION: ${summaries.length} summaries → creating era summaries`);

    // Group by day
    const byDay = {};
    for (const s of summaries) {
        const text = typeof s === 'object' ? (s.text || s.t || '') : String(s);
        const time = typeof s === 'object' ? (s.t || '') : '';
        const dayMatch = time.match(/Day\s+(\d+)/i) || text.match(/Day\s+(\d+)/i) || text.match(/\[Day\s+(\d+)/i);
        const day = dayMatch ? parseInt(dayMatch[1]) : 0;
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(text);
    }

    // Create era summaries for older days, keep recent individual entries
    const eraSummaries = [];
    const recentEntries = [];
    const latestDay = Math.max(...Object.keys(byDay).map(Number));

    for (const [dayStr, entries] of Object.entries(byDay).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const day = Number(dayStr);
        if (day >= latestDay - 1) {
            // Keep recent entries individually
            recentEntries.push(...entries);
        } else {
            // Consolidate older days
            const combined = entries.join(' | ');
            const truncated = combined.length > 500 ? combined.substring(0, 497) + '...' : combined;
            eraSummaries.push(`[CONSOLIDATED: Day ${day}] ${truncated}`);
        }
    }

    // Remove all old summaries and replace with consolidated + recent
    // We can't REMOVE individual summary entries easily, so we'll note the target count
    console.log(`    Era summaries: ${eraSummaries.length}`);
    console.log(`    Recent entries kept: ${recentEntries.length}`);
    console.log(`    Target total: ${eraSummaries.length + recentEntries.length}`);

    // Directly modify the state's summary array for the output
    state.story_summary = [
        ...eraSummaries.map(text => ({ text, t: '', _ts: now })),
        ...recentEntries.map(text => typeof text === 'object' ? text : { text, t: '', _ts: now }),
    ];
    console.log(`    Final summary count: ${state.story_summary.length}`);
}

// 6. Trim timeline if over 30
if ((state.pc.timeline || []).length > 30) {
    const timeline = state.pc.timeline;
    const kept = timeline.slice(-30);
    const archived = timeline.slice(0, -30);
    console.log(`  TRIM: PC timeline ${timeline.length} → 30 (archived ${archived.length})`);
    state.pc.timeline = kept;
}

// 7. Trim demonstrated_traits if over 20
if ((state.pc.demonstrated_traits || []).length > 20) {
    const traits = state.pc.demonstrated_traits;
    const kept = traits.slice(-20);
    console.log(`  TRIM: PC traits ${traits.length} → 20`);
    state.pc.demonstrated_traits = kept;
}

// 8. Trim character key_moments if over 10
for (const [id, char] of Object.entries(state.characters)) {
    if (Array.isArray(char.key_moments) && char.key_moments.length > 10) {
        const kept = char.key_moments.slice(-10);
        console.log(`  TRIM: ${char.name || id} key_moments ${char.key_moments.length} → 10`);
        char.key_moments = kept;
    }
}

// 9. Add location/condition/equipment to PC if missing
if (!state.pc.location) {
    fix('S', 'pc', '', { f: 'location', v: 'Seventh Heaven storeroom — cot, beside Tifa' }, 'Initialize location field');
    console.log('  FIX: PC location added');
}
if (!state.pc.condition) {
    fix('S', 'pc', '', { f: 'condition', v: 'Fatigued. Post-forge. Operationally spent but emotionally present.' }, 'Initialize condition field');
    console.log('  FIX: PC condition added');
}
if (!state.pc.equipment) {
    fix('S', 'pc', '', { f: 'equipment', v: 'Infantry sword, Fire materia, Cure x1, Barrier x2, Ice2, Lightning, 1 potion, 1 ether, Carver slip' }, 'Initialize equipment field');
    console.log('  FIX: PC equipment added');
}

// 10. Add location to tracked characters if missing
const charLocations = {
    'tifa-lockhart': 'Seventh Heaven storeroom — edge of cot, mug in hands',
    'cloud-strife': 'Seventh Heaven — upstairs or departed',
    'barret-wallace': 'Seventh Heaven — upstairs with Marlene',
    'jessie-rasberry': 'Seventh Heaven basement or departed',
    'aerith': 'Sector 5 slums — church and surroundings',
};
for (const [charId, loc] of Object.entries(charLocations)) {
    const char = state.characters[charId];
    if (char && !char.location) {
        fix('S', 'char', charId, { f: 'location', v: loc }, 'Initialize location field');
        console.log(`  FIX: ${char.name || charId} location added`);
    }
}

// ─── Apply fixes to transaction log ────────────────────────────────────────

if (fixes.length > 0) {
    console.log(`\nAppending ${fixes.length} corrective transactions...`);
    txns.push(...fixes);
    // Apply fixes to state
    for (const tx of fixes) {
        applyTransaction(state, tx);
    }
}

// ─── Build cleaned output ──────────────────────────────────────────────────

// Create a new snapshot with the cleaned state
const cleanedSnapshot = {
    id: snapshots.length,
    label: 'Post-cleanup snapshot',
    lastTxId: nextTxId - 1,
    createdAt: now,
    state: JSON.parse(JSON.stringify(state)),
};

// Remove _history from snapshot to save space (it's huge)
delete cleanedSnapshot.state._history;

const output = {
    transactions: txns,
    snapshots: [...snapshots, cleanedSnapshot],
    lastTxId: nextTxId - 1,
    createdAt: data.createdAt,
    updatedAt: now,
};

console.log(`\nWriting cleaned file...`);
console.log(`  Transactions: ${output.transactions.length} (was ${data.transactions.length})`);
console.log(`  Snapshots: ${output.snapshots.length} (was ${snapshots.length})`);
console.log(`  Summary entries: ${state.story_summary.length}`);
console.log(`  PC timeline: ${(state.pc.timeline || []).length}`);
console.log(`  PC traits: ${(state.pc.demonstrated_traits || []).length}`);

fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
console.log(`\n✓ Written to ${OUTPUT}`);
