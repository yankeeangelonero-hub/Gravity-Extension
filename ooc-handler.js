/**
 * ooc-handler.js — OOC keyword dispatch for structural operations.
 */

import { createSnapshot, listSnapshots, rollback, computeCurrentState } from './snapshot-mgr.js';
import {
    getAllTransactions,
    getTransactionsForEntity,
    getTransactionsInRange,
    append,
} from './ledger-store.js';
import { checkAndRotate, buildConsolidationPrompt } from './memory-tier.js';

const OOC_PATTERNS = [
    // Voice/tone OOC commands removed — replaced by Prose Style dropdown in Settings tab
    { pattern: /ooc:\s*combat\s+setup\b/i, handler: handleCombatSetup },
    { pattern: /ooc:\s*combat\s+rules\b/i, handler: handleCombatRules },
    { pattern: /ooc:\s*power\s+(\S+)\s+(\d+)/i, handler: handlePower },
    { pattern: /ooc:\s*wound\s+(\S+)\s+(\S+)\s+"([^"]+)"/i, handler: handleWound },
    { pattern: /ooc:\s*wound\s+(\S+)\s+(\S+)\s+(.+)/i, handler: handleWound },
    { pattern: /ooc:\s*heal\s+(\S+)\s+(\S+)/i, handler: handleHeal },
    { pattern: /ooc:\s*snapshot\b/i, handler: handleSnapshot },
    { pattern: /ooc:\s*rollback\s+to\s+#?(\d+)/i, handler: handleRollbackConfirm },
    { pattern: /ooc:\s*rollback\b/i, handler: handleRollback },
    { pattern: /ooc:\s*eval\b/i, handler: handleEval },
    { pattern: /ooc:\s*history\s+(.+)/i, handler: handleHistory },
    { pattern: /ooc:\s*timeline\s+(.+)\s+to\s+(.+)/i, handler: handleTimeline },
    { pattern: /ooc:\s*divination\s+(arcana|iching|i.ching|classic|2d10)\b/i, handler: handleDivinationSwitch },
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
    lines.push(`Factions: ${Object.keys(state.factions || {}).length}`);
    lines.push(`Story summary entries: ${(state.story_summary || []).length}`);
    lines.push(`Divination: ${state.divination?.active_system || 'not set'}`);
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
    lines.push('AUDIT AND CLEANUP (uncapped — no line limit this turn):');
    lines.push('1. CONTINUITY: Check for errors, missing/ghost state, rule violations, stale fields.');
    lines.push('2. STALE FIELDS: Review ALL location, condition, equipment, doing fields. Update any that are outdated.');
    lines.push('3. CURRENT SCENE: Verify pc.current_scene reflects the actual scene. Update demonstrated_traits if stale.');
    lines.push('4. PRUNE: REMOVE fired pressure points, stale noticed details, resolved entries, duplicate summaries.');
    lines.push('5. CONSOLIDATE: If story_summary exceeds 30 entries, consolidate oldest batches into 3-5 sentence overviews.');
    lines.push('6. FIX: emit AMEND for any continuity errors found.');
    lines.push('This turn is UNCAPPED — emit as many ledger lines as needed for a thorough cleanup.');
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

    // Run hot→cold rotation and check if consolidation is needed
    const { needsConsolidation, pendingBatches } = checkAndRotate(state);
    if (needsConsolidation) {
        const prompt = buildConsolidationPrompt(pendingBatches);
        return `[LEDGER: Snapshot #${snap.id} at tx ${snap.lastTxId}. Memory rotated — ${pendingBatches.length} batch(es) archived to cold storage.\n\n${prompt}]`;
    }
    return `[LEDGER: Snapshot #${snap.id} at tx ${snap.lastTxId}. No arrays over hot cap — nothing to rotate.]`;
}

// ─── Divination OOC Command ──────────────────────────────────────────────────

async function handleDivinationSwitch(match) {
    const system = match[1].toLowerCase().replace(/[\s.]/g, '');
    const normalized = system === '2d10' ? 'classic' : system;
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata['gravity_divination_system'] = normalized;
    await saveMetadata();
    return `[LEDGER: Divination system set to ${normalized}.]`;
}

// ─── Combat OOC Commands ─────────────────────────────────────────────────────

async function handleCombatSetup(match) {
    // match.input is the full message; extract everything after "combat setup"
    const fullMessage = match.input || match[0];
    const setupMatch = fullMessage.match(/ooc:\s*combat\s+setup\b\s*([\s\S]*)/i);
    const afterSetup = setupMatch ? setupMatch[1] : '';
    // Strip HTML tags (SillyTavern messages may contain <br>, <p>, etc.)
    const rulesText = afterSetup.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    if (!rulesText) {
        return `[LEDGER: No rules provided. Usage: "OOC: combat setup <your power scale and combat rules>"\nExample: "OOC: combat setup 1=civilian, 3=soldier, 5=dragon. Combat is gritty and lethal."]`;
    }
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata['gravity_combat_rules'] = rulesText;
    await saveMetadata();
    return `[LEDGER: Combat rules stored.

${rulesText}

SET power on all existing characters based on this scale. Use the entity IDs from Gravity_State_View.

HARD RULE — READ CAREFULLY:
You MUST NOT create any mechanical combat system. No dice rolls. No 2d6. No d20. No hit points. No condition tracks. No attack rolls. No damage tables. No turn sequences. No threat thresholds. No hit counters. No modifiers table. NONE OF THAT.

Dice in Gravity exist ONLY for divination (arcana draws, collision arrivals). Combat has NO dice. Combat has NO mechanics.

The power scale is a NARRATIVE REFERENCE for you to judge outcomes through prose. A power-3 character fighting a power-5 character LOSES — you write that loss. You don't roll for it. You judge it through Logic and Fairness, the same way you judge everything else in Gravity.

Wounds are descriptive text via MAP_SET (e.g. "broken ribs"), not HP tiers or condition tracks.

Your ONLY job right now: SET power on existing characters via ledger commands. Do not build a combat engine. Do not create rules tables. Just assign the numbers and confirm.]`;
}

async function handleCombatRules() {
    const { chatMetadata } = SillyTavern.getContext();
    const rules = chatMetadata['gravity_combat_rules'];
    if (!rules) return `[LEDGER: No combat rules defined. Use "OOC: combat setup <rules>" to set them.]`;
    return `[LEDGER: Current combat rules:\n\n${rules}]`;
}

async function handlePower(match) {
    const entityRef = match[1].trim();  // e.g. "char:dragon" or "pc"
    const value = parseInt(match[2], 10);

    const isPc = entityRef === 'pc';
    const entityType = isPc ? 'pc' : entityRef.split(':')[0];
    const entityId = isPc ? '' : entityRef.split(':')[1];

    if (!isPc && (!entityType || !entityId)) {
        return `[LEDGER: Invalid entity "${entityRef}". Use format: char:id or pc]`;
    }

    const tx = {
        op: 'S',
        e: entityType,
        id: entityId,
        d: { f: 'power', v: value },
        r: 'OOC power command',
    };
    await append([tx]);
    return `[LEDGER: Power set — ${entityRef} power = ${value}]`;
}

async function handleWound(match) {
    const entityRef = match[1].trim();  // e.g. "char:jack" or "pc"
    const key = match[2].trim();        // e.g. "arm" or "left_leg"
    const value = match[3].trim();      // e.g. "deep gash"

    const isPc = entityRef === 'pc';
    const entityType = isPc ? 'pc' : entityRef.split(':')[0];
    const entityId = isPc ? '' : entityRef.split(':')[1];

    if (!isPc && (!entityType || !entityId)) {
        return `[LEDGER: Invalid entity "${entityRef}". Use format: char:id or pc]`;
    }

    const tx = {
        op: 'MS',
        e: entityType,
        id: entityId,
        d: { f: 'wounds', k: key, v: value },
        r: 'OOC wound command',
    };
    await append([tx]);
    return `[LEDGER: Wound added — ${entityRef} wounds.${key} = "${value}"]`;
}

async function handleHeal(match) {
    const entityRef = match[1].trim();
    const key = match[2].trim();

    const isPc = entityRef === 'pc';
    const entityType = isPc ? 'pc' : entityRef.split(':')[0];
    const entityId = isPc ? '' : entityRef.split(':')[1];

    if (!isPc && (!entityType || !entityId)) {
        return `[LEDGER: Invalid entity "${entityRef}". Use format: char:id or pc]`;
    }

    const tx = {
        op: 'MR',
        e: entityType,
        id: entityId,
        d: { f: 'wounds', k: key },
        r: 'OOC heal command',
    };
    await append([tx]);
    return `[LEDGER: Wound healed — ${entityRef} wounds.${key} removed]`;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

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
