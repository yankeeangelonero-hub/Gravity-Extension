/**
 * ooc-handler.js — OOC keyword dispatch for structural operations.
 */

import { createSnapshot, listSnapshots, rollback, computeCurrentState } from './snapshot-mgr.js';
import {
    getAllTransactions,
    getTransactionsForEntity,
    getTransactionsInRange,
} from './ledger-store.js';

const OOC_PATTERNS = [
    { pattern: /ooc:\s*snapshot\b/i, handler: handleSnapshot },
    { pattern: /ooc:\s*rollback\s+to\s+#?(\d+)/i, handler: handleRollbackConfirm },
    { pattern: /ooc:\s*rollback\b/i, handler: handleRollback },
    { pattern: /ooc:\s*eval\b/i, handler: handleEval },
    { pattern: /ooc:\s*history\s+(.+)/i, handler: handleHistory },
    { pattern: /ooc:\s*timeline\s+(.+)\s+to\s+(.+)/i, handler: handleTimeline },
    { pattern: /ooc:\s*archive\b/i, handler: handleConsolidate },
    { pattern: /ooc:\s*consolidate\b/i, handler: handleConsolidate },
];

async function processOOC(message) {
    if (!message) return { handled: false, injection: null };

    for (const { pattern, handler } of OOC_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
            try {
                const injection = await handler(match);
                return { handled: true, injection };
            } catch (err) {
                return { handled: true, injection: `[LEDGER ERROR: ${err.message}]` };
            }
        }
    }
    return { handled: false, injection: null };
}

async function handleSnapshot() {
    const state = computeCurrentState();
    const snap = await createSnapshot(state, 'Manual snapshot');
    return `[LEDGER: Snapshot #${snap.id} created at tx ${snap.lastTxId}. Label: "${snap.label}"]`;
}

async function handleRollback() {
    const snapshots = listSnapshots();
    if (snapshots.length === 0) return `[LEDGER: No snapshots available.]`;

    const lines = [`[LEDGER: Available snapshots:`];
    for (const snap of snapshots.slice(-5)) {
        lines.push(`  #${snap.id}: "${snap.label}" (tx ${snap.lastTxId}, ${snap.createdAt})`);
    }
    lines.push(`Reply "OOC: rollback to #N" to confirm.]`);
    return lines.join('\n');
}

async function handleRollbackConfirm(match) {
    const targetId = parseInt(match[1], 10);
    await rollback(targetId);
    return `[LEDGER: Rolled back to snapshot #${targetId}. State restored.]`;
}

async function handleEval() {
    const state = computeCurrentState();
    const allTxns = getAllTransactions();

    await createSnapshot(state, 'Pre-eval safety snapshot');

    const lines = [];
    lines.push('═══ LEDGER: SYSTEM EVALUATION ═══');
    lines.push('');
    lines.push(`Ledger: ${allTxns.length} transactions total`);
    lines.push(`Characters: ${Object.keys(state.characters).length}`);
    lines.push(`Constraints: ${Object.keys(state.constraints).length}`);
    lines.push(`Collisions: ${Object.keys(state.collisions).length}`);
    lines.push(`Chapters: ${Object.keys(state.chapters).length}`);
    lines.push('');
    lines.push('RECENT TRANSACTIONS (last 30):');
    for (const tx of allTxns.slice(-30)) {
        lines.push(`  tx#${tx.tx} ${tx.t || ''} ${tx.op} ${tx.e}:${tx.id || '—'} — ${tx.r || summarizeTxData(tx)}`);
    }
    lines.push('');
    lines.push('CURRENT STATE:');
    for (const [id, char] of Object.entries(state.characters)) {
        const constraints = Object.values(state.constraints)
            .filter(c => c.owner_id === id)
            .map(c => `${c.name}[${c.integrity}]`).join(', ');
        lines.push(`  ${char.name || id} [${char.tier}] — ${constraints || 'no constraints'}`);
    }
    for (const col of Object.values(state.collisions)) {
        if (col.status === 'RESOLVED') continue;
        lines.push(`  ⊕ ${col.name || col.id} [${col.status}] dist:${col.distance || '?'}`);
    }
    lines.push('');
    lines.push('AUDIT FOR: continuity errors, missing/ghost state, rule violations, stale data.');
    lines.push('TO FIX: emit AMEND in ---LEDGER--- block.');
    lines.push('═══ END EVALUATION ═══');
    return lines.join('\n');
}

async function handleHistory(match) {
    const query = match[1].trim();
    const txns = getTransactionsForEntity(query);

    if (txns.length === 0) {
        const allTxns = getAllTransactions();
        const fuzzy = allTxns.filter(tx =>
            tx.id?.toLowerCase().includes(query.toLowerCase()) ||
            tx.r?.toLowerCase().includes(query.toLowerCase())
        );
        if (fuzzy.length === 0) return `[LEDGER: No history for "${query}".]`;
        const ids = [...new Set(fuzzy.map(tx => tx.id).filter(Boolean))];
        return `[LEDGER: No exact match. Did you mean: ${ids.slice(0, 5).join(', ')}?]`;
    }

    const lines = [`═══ HISTORY: ${query} (${txns.length} TX) ═══`];
    for (const tx of txns) {
        lines.push(`  tx#${tx.tx} ${tx.t || ''} ${tx.op} — ${tx.r || summarizeTxData(tx)}`);
        if (tx.op === 'TR') lines.push(`    ${tx.d.f}: ${tx.d.from} → ${tx.d.to}`);
        if (tx.op === 'S') lines.push(`    ${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        if (tx.op === 'A') lines.push(`    ${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        if (tx.op === 'MS') lines.push(`    ${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
    }
    lines.push(`═══ END HISTORY ═══`);
    return lines.join('\n');
}

async function handleTimeline(match) {
    const from = match[1].trim();
    const to = match[2].trim();
    const txns = getTransactionsInRange(from, to);

    if (txns.length === 0) return `[LEDGER: No transactions between "${from}" and "${to}".]`;

    const lines = [`═══ TIMELINE: ${from} to ${to} (${txns.length} TX) ═══`];
    for (const tx of txns) {
        lines.push(`  tx#${tx.tx} ${tx.t} ${tx.op} ${tx.e}:${tx.id || '—'} — ${tx.r || summarizeTxData(tx)}`);
    }
    lines.push(`═══ END TIMELINE ═══`);
    return lines.join('\n');
}

async function handleConsolidate() {
    const state = computeCurrentState();
    const snap = await createSnapshot(state, 'Consolidation checkpoint');
    return `[LEDGER: Consolidated. Snapshot #${snap.id} at tx ${snap.lastTxId}.]`;
}

function summarizeTxData(tx) {
    if (!tx.d) return '';
    switch (tx.op) {
        case 'CR': return `created ${tx.e}`;
        case 'TR': return `${tx.d.f}: ${tx.d.from}→${tx.d.to}`;
        case 'S':  return `${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'A':  return `${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'R':  return `${tx.d.f} -= ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MS': return `${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MR': return `${tx.d.f}[${tx.d.k}] removed`;
        case 'D':  return `destroyed`;
        case 'AMEND': return `amends tx#${tx.d.target_tx}`;
        default: return JSON.stringify(tx.d).substring(0, 60);
    }
}

export { processOOC, OOC_PATTERNS };
