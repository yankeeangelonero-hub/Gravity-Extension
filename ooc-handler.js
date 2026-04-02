/**
 * ooc-handler.js - OOC keyword dispatch for structural operations.
 */

import { createSnapshot, listSnapshots, rollback, computeCurrentState } from './snapshot-mgr.js';
import {
    getAllTransactions,
    getTransactionsForEntity,
    getTransactionsInRange,
    append,
} from './ledger-store.js';

const OOC_PATTERNS = [
    { pattern: /ooc:\s*power\s+review\b/i, handler: handlePowerReview },
    { pattern: /ooc:\s*power\s+base\s+(\S+)\s+(-?\d+)/i, handler: handlePowerBase },
    { pattern: /ooc:\s*power\s+(\S+)\s+(-?\d+)/i, handler: handlePower },
    { pattern: /ooc:\s*wound\s+(\S+)\s+(\S+)\s+"([^"]+)"/i, handler: handleWound },
    { pattern: /ooc:\s*wound\s+(\S+)\s+(\S+)\s+(.+)/i, handler: handleWound },
    { pattern: /ooc:\s*heal\s+(\S+)\s+(\S+)/i, handler: handleHeal },
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

    const lines = ['[LEDGER: Available snapshots:'];
    for (const snap of snapshots.slice(-5)) {
        lines.push(`  #${snap.id}: "${snap.label}" (tx ${snap.lastTxId}, ${snap.createdAt})`);
    }
    lines.push('Reply "OOC: rollback to #N" to confirm.]');
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
    lines.push('=== LEDGER: SYSTEM EVALUATION ===');
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
        lines.push(`  tx#${tx.tx} ${tx.t || ''} ${tx.op} ${tx.e}:${tx.id || '-'} - ${tx.r || summarizeTxData(tx)}`);
    }
    lines.push('');
    lines.push('CURRENT STATE:');
    for (const [id, char] of Object.entries(state.characters)) {
        const constraints = Object.values(state.constraints)
            .filter(c => c.owner_id === id)
            .map(c => `${c.name}[${c.integrity}]`).join(', ');
        lines.push(`  ${char.name || id} [${char.tier}] - ${constraints || 'no constraints'}`);
    }
    for (const col of Object.values(state.collisions)) {
        if (col.status === 'RESOLVED') continue;
        lines.push(`  + ${col.name || col.id} [${col.status}] dist:${col.distance || '?'}`);
    }
    lines.push('');
    lines.push('AUDIT AND CLEANUP (uncapped - no line limit this turn):');
    lines.push('1. CONTINUITY: Check for errors, missing/ghost state, rule violations, stale fields.');
    lines.push('2. STALE FIELDS: Review ALL location, condition, equipment, doing fields. Update any that are outdated.');
    lines.push('3. KNOWLEDGE GAPS: Verify pc.knowledge_gaps is accurate - add missing gaps, remove discovered ones.');
    lines.push('4. POWER: Audit power_base, power, power_basis, and abilities. Lower power only for real impairment. Raise power_base only when growth is earned.');
    lines.push('5. PRESSURE POINTS: For each pressure point, decide KEEP / REMOVE / ESCALATE. REMOVE fired or stale seams; if one now has actors, cost, and a looming forced choice, CREATE a collision from it and REMOVE the pressure point.');
    lines.push('6. PRUNE: REMOVE stale noticed details, resolved entries, duplicate summaries.');
    lines.push('7. CONSOLIDATE: If story_summary exceeds 30 entries, consolidate oldest batches into 3-5 sentence overviews.');
    lines.push('8. FIX: emit AMEND for any continuity errors found.');
    lines.push('This turn is UNCAPPED - emit as many ledger lines as needed for a thorough cleanup.');
    lines.push('=== END EVALUATION ===');
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

    const lines = [`=== HISTORY: ${query} (${txns.length} TX) ===`];
    for (const tx of txns) {
        lines.push(`  tx#${tx.tx} ${tx.t || ''} ${tx.op} - ${tx.r || summarizeTxData(tx)}`);
        if (tx.op === 'TR') lines.push(`    ${tx.d.f}: ${tx.d.from} -> ${tx.d.to}`);
        if (tx.op === 'S') lines.push(`    ${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        if (tx.op === 'A') lines.push(`    ${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        if (tx.op === 'MS') lines.push(`    ${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
    }
    lines.push('=== END HISTORY ===');
    return lines.join('\n');
}

async function handleTimeline(match) {
    const from = match[1].trim();
    const to = match[2].trim();
    const txns = getTransactionsInRange(from, to);

    if (txns.length === 0) return `[LEDGER: No transactions between "${from}" and "${to}".]`;

    const lines = [`=== TIMELINE: ${from} to ${to} (${txns.length} TX) ===`];
    for (const tx of txns) {
        lines.push(`  tx#${tx.tx} ${tx.t} ${tx.op} ${tx.e}:${tx.id || '-'} - ${tx.r || summarizeTxData(tx)}`);
    }
    lines.push('=== END TIMELINE ===');
    return lines.join('\n');
}

async function handleConsolidate() {
    const state = computeCurrentState();
    const snap = await createSnapshot(state, 'Consolidation checkpoint');
    return `[LEDGER: Consolidated. Snapshot #${snap.id} at tx ${snap.lastTxId}.]`;
}

async function handlePowerReview(match) {
    const state = computeCurrentState();
    const allTxns = getAllTransactions();
    const fullMessage = match.input || match[0];
    const reviewMatch = fullMessage.match(/ooc:\s*power\s+review\b\s*([\s\S]*)/i);
    const remainder = (reviewMatch ? reviewMatch[1] : '').trim();

    let targetRef = 'pc';
    let requestReason = '';

    if (remainder) {
        const becauseIndex = remainder.toLowerCase().indexOf(' because ');
        if (becauseIndex >= 0) {
            targetRef = remainder.slice(0, becauseIndex).trim() || 'pc';
            requestReason = remainder.slice(becauseIndex + ' because '.length).trim();
        } else if (remainder.toLowerCase().startsWith('because ')) {
            requestReason = remainder.slice('because '.length).trim();
        } else {
            targetRef = remainder;
        }
    }

    const targets = resolvePowerReviewTargets(state, targetRef);
    if (targets.length === 0) {
        return `[LEDGER: No power-tracked target found for "${targetRef}". Use pc, all, char:id, an exact character id, or an exact character name.]`;
    }

    const constants = state.world?.constants || {};
    const lines = [];
    lines.push('[GRAVITY POWER REVIEW]');
    lines.push('No prose scene. Re-judge combat power honestly against the established scale and current evidence.');
    if (requestReason) lines.push(`Player request: ${requestReason}`);
    lines.push('');
    lines.push('WORLD POWER CONTEXT:');
    lines.push(`  Power scale: ${constants.power_scale || 'not set - infer a consistent scale from setup and existing state'}`);
    lines.push(`  Power ceiling: ${constants.power_ceiling ?? 'not set'}`);
    if (constants.power_notes) lines.push(`  Power notes: ${constants.power_notes}`);
    lines.push('');
    lines.push('REVIEW TARGETS:');

    for (const target of targets) {
        lines.push(`- ${target.label}`);
        lines.push(`  Current power: ${target.entity.power ?? 'unset'}`);
        lines.push(`  Base power: ${target.entity.power_base ?? 'unset'}`);
        if (target.entity.power_basis) lines.push(`  Basis: ${target.entity.power_basis}`);
        const abilities = toArray(target.entity.abilities);
        if (abilities.length) lines.push(`  Abilities: ${abilities.join(' | ')}`);
        if (target.entity.equipment) lines.push(`  Equipment: ${target.entity.equipment}`);
        const wounds = target.entity.wounds && typeof target.entity.wounds === 'object'
            ? Object.entries(target.entity.wounds).map(([k, v]) => `${k}: ${v}`).join(', ')
            : '';
        if (wounds) lines.push(`  Wounds: ${wounds}`);
        for (const evidence of buildPowerEvidence(target, state, allTxns)) {
            lines.push(`  Evidence: ${evidence}`);
        }
        lines.push('');
    }

    lines.push('REVIEW RULES:');
    lines.push('- power = current effective combat level used for math.');
    lines.push('- power_base = normal earned combat level when healthy and fully functional.');
    lines.push('- Lower power only if current condition, lost gear, fear, exhaustion, or severe wounds materially reduce the real combat ceiling.');
    lines.push('- Raise power_base only if training, earned skill growth, major gear upgrades, or permanent supernatural change justify it.');
    lines.push('- Do not double-count minor wounds. Minor wounds usually affect narration and option quality without changing power.');
    lines.push('- No naked numbers. If the rating changes, update power_basis and abilities when the explanation also needs refinement.');
    lines.push('- If nothing changed, say so explicitly and keep the state unchanged.');
    lines.push('');
    lines.push('OUTPUT:');
    lines.push('1. Brief judgment only.');
    lines.push('2. Then a compact ---STATE--- block for simple changes or ---LEDGER--- block for wider edits.');
    lines.push('3. No scene prose.');

    return lines.join('\n');
}

async function handlePowerBase(match) {
    const entityRef = match[1].trim();
    const value = parseInt(match[2], 10);
    const { entityType, entityId } = parseEntityRef(entityRef);

    const tx = {
        op: 'S',
        e: entityType,
        id: entityId,
        d: { f: 'power_base', v: value },
        r: 'OOC power base command',
    };
    await append([tx]);
    return `[LEDGER: Power base set - ${entityRef} power_base = ${value}]`;
}

async function handlePower(match) {
    const entityRef = match[1].trim();
    const value = parseInt(match[2], 10);
    const { entityType, entityId } = parseEntityRef(entityRef);

    const tx = {
        op: 'S',
        e: entityType,
        id: entityId,
        d: { f: 'power', v: value },
        r: 'OOC power command',
    };
    await append([tx]);
    return `[LEDGER: Power set - ${entityRef} power = ${value}]`;
}

async function handleWound(match) {
    const entityRef = match[1].trim();
    const key = match[2].trim();
    const value = match[3].trim();
    const { entityType, entityId } = parseEntityRef(entityRef);

    const tx = {
        op: 'MS',
        e: entityType,
        id: entityId,
        d: { f: 'wounds', k: key, v: value },
        r: 'OOC wound command',
    };
    await append([tx]);
    return `[LEDGER: Wound added - ${entityRef} wounds.${key} = "${value}"]`;
}

async function handleHeal(match) {
    const entityRef = match[1].trim();
    const key = match[2].trim();
    const { entityType, entityId } = parseEntityRef(entityRef);

    const tx = {
        op: 'MR',
        e: entityType,
        id: entityId,
        d: { f: 'wounds', k: key },
        r: 'OOC heal command',
    };
    await append([tx]);
    return `[LEDGER: Wound healed - ${entityRef} wounds.${key} removed]`;
}

function parseEntityRef(entityRef) {
    const ref = String(entityRef || '').trim();
    if (!ref) {
        throw new Error('Missing entity reference. Use "pc" or "char:id".');
    }
    if (ref === 'pc') {
        return { entityType: 'pc', entityId: '' };
    }

    const [entityType, entityId] = ref.split(':');
    if (!entityType || !entityId) {
        throw new Error(`Invalid entity "${entityRef}". Use format: char:id or pc`);
    }
    return { entityType, entityId };
}

function resolvePowerReviewTargets(state, targetRef) {
    const ref = String(targetRef || 'pc').trim();
    if (!ref || ref === 'pc') {
        return hasPowerProfile(state.pc)
            ? [{ ref: 'pc', label: `PC${state.pc?.name ? ` (${state.pc.name})` : ''}`, entity: state.pc }]
            : [];
    }

    if (ref === 'all') {
        const targets = [];
        if (hasPowerProfile(state.pc)) {
            targets.push({ ref: 'pc', label: `PC${state.pc?.name ? ` (${state.pc.name})` : ''}`, entity: state.pc });
        }
        for (const [id, char] of Object.entries(state.characters || {})) {
            if (!hasPowerProfile(char)) continue;
            targets.push({ ref: `char:${id}`, label: `${char.name || id} [char:${id}]`, entity: char });
        }
        return targets;
    }

    if (ref.startsWith('char:')) {
        const id = ref.slice('char:'.length);
        const char = state.characters?.[id];
        if (!char) throw new Error(`No tracked character found for "${ref}".`);
        return [{ ref, label: `${char.name || id} [char:${id}]`, entity: char }];
    }

    const directById = state.characters?.[ref];
    if (directById) {
        return [{ ref: `char:${ref}`, label: `${directById.name || ref} [char:${ref}]`, entity: directById }];
    }

    const byName = Object.entries(state.characters || {}).find(([, char]) =>
        String(char.name || '').toLowerCase() === ref.toLowerCase()
    );
    if (byName) {
        const [id, char] = byName;
        return [{ ref: `char:${id}`, label: `${char.name || id} [char:${id}]`, entity: char }];
    }

    throw new Error(`No power review target found for "${ref}".`);
}

function hasPowerProfile(entity) {
    if (!entity || typeof entity !== 'object') return false;
    return entity.power != null
        || entity.power_base != null
        || !!entity.power_basis
        || toArray(entity.abilities).length > 0;
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return [String(value)];
}

function buildPowerEvidence(target, state, allTxns) {
    const lines = [];
    const entity = target.entity || {};

    if (target.ref === 'pc') {
        const traits = toArray(entity.demonstrated_traits).slice(-3);
        for (const trait of traits) lines.push(`Trait: ${trait}`);

        const summaries = toArray(state.story_summary).slice(-2);
        for (const summary of summaries) lines.push(`Summary: ${typeof summary === 'object' ? summary.text || '' : summary}`);

        const pcTxns = allTxns
            .filter(tx => tx.e === 'pc')
            .slice(-5)
            .map(tx => `tx#${tx.tx} ${tx.op} ${summarizeTxData(tx)}`);
        lines.push(...pcTxns);
    } else if (target.ref.startsWith('char:')) {
        const id = target.ref.slice('char:'.length);
        const moments = toArray(entity.key_moments).slice(-2);
        for (const moment of moments) lines.push(`Moment: ${moment}`);

        const charTxns = getTransactionsForEntity(id)
            .slice(-5)
            .map(tx => `tx#${tx.tx} ${tx.op} ${summarizeTxData(tx)}`);
        lines.push(...charTxns);
    }

    return lines.slice(0, 8);
}

function summarizeTxData(tx) {
    if (!tx.d) return '';
    switch (tx.op) {
        case 'CR': return `created ${tx.e}`;
        case 'TR': return `${tx.d.f}: ${tx.d.from}->${tx.d.to}`;
        case 'S': return `${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'A': return `${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'R': return `${tx.d.f} -= ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MS': return `${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MR': return `${tx.d.f}[${tx.d.k}] removed`;
        case 'D': return 'destroyed';
        case 'AMEND': return `amends tx#${tx.d.target_tx}`;
        default: return JSON.stringify(tx.d).substring(0, 60);
    }
}

export { processOOC, OOC_PATTERNS };
