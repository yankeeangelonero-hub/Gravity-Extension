/**
 * ledger-compactor.js — Pure compaction functions over the transaction array.
 *
 * All functions are pure: input array unchanged, return new array.
 * Replay equivalence: computeState(compacted) must equal computeState(original)
 * for the entity state slice (history may differ — see diffStates ignored keys).
 *
 * SAFETY CONSTRAINT: callers must only feed transactions older than the oldest
 * retained snapshot's lastTxId, so rollback windows remain intact.
 */

const TERMINAL_COLLISION_STATUSES = new Set(['RESOLVED', 'CRASHED']);

// (entity, field) pairs whose history must NOT be coalesced. The runtime reads
// `_history['relationship:<id>:last_shift']` (index.js:2044) to suppress
// duplicate resolution corrections — coalescing earlier writes truncates that
// history and re-fires the correction every turn after a relationship resolves.
const COALESCE_PRESERVE_HISTORY = new Set([
    'relationship::last_shift',
]);

function shouldPreserveHistory(entity, field) {
    return COALESCE_PRESERVE_HISTORY.has(`${entity}::${field}`);
}

/**
 * Coalesce consecutive S writes on the same (entity, id, field) — keep only the latest.
 * Preserves order of non-S transactions. Pure overwrite semantics make this safe.
 * Skips (entity, field) pairs listed in COALESCE_PRESERVE_HISTORY.
 */
function coalesceLastWriteWins(transactions) {
    // Walk back-to-front: first S we see for a (e, id, field) is the winner.
    const seen = new Set();
    const keep = new Array(transactions.length).fill(true);
    for (let i = transactions.length - 1; i >= 0; i--) {
        const tx = transactions[i];
        if (tx.op !== 'S') continue;
        const f = tx.d?.f;
        if (typeof f !== 'string') continue;
        if (shouldPreserveHistory(tx.e, f)) continue;  // history-sensitive — never coalesce
        const key = `${tx.e}::${tx.id}::${f}`;
        if (seen.has(key)) {
            keep[i] = false;
        } else {
            seen.add(key);
        }
    }
    return transactions.filter((_, i) => keep[i]);
}

/**
 * Coalesce consecutive MS writes on the same (entity, id, field, key).
 */
function coalesceMSLastWriteWins(transactions) {
    const seen = new Set();
    const keep = new Array(transactions.length).fill(true);
    for (let i = transactions.length - 1; i >= 0; i--) {
        const tx = transactions[i];
        if (tx.op !== 'MS') continue;
        const f = tx.d?.f, k = tx.d?.k;
        if (typeof f !== 'string' || typeof k !== 'string') continue;
        const key = `${tx.e}::${tx.id}::${f}::${k}`;
        if (seen.has(key)) {
            keep[i] = false;
        } else {
            seen.add(key);
        }
    }
    return transactions.filter((_, i) => keep[i]);
}

/**
 * Drop CR/S/A/MS/TR/R/MR transactions that touch entities later destroyed by D.
 * The D transaction itself is preserved (it has side-effects on relationships/scene_cast).
 */
function dropDestroyedEntityTxs(transactions) {
    const destroyed = new Map();  // (e, id) -> first D index
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op === 'D') {
            const key = `${tx.e}::${tx.id}`;
            if (!destroyed.has(key)) destroyed.set(key, i);
        }
    }
    return transactions.filter((tx, i) => {
        if (tx.op === 'D') return true;  // always keep D
        if (tx.op === 'SNAP' || tx.op === 'ROLL' || tx.op === 'AMEND') return true;
        const key = `${tx.e}::${tx.id}`;
        const dIdx = destroyed.get(key);
        if (dIdx === undefined) return true;
        // Keep only if this tx is AFTER the D (e.g. re-create with same id — rare).
        return i > dIdx;
    });
}

/**
 * Cancel A+R pairs on the same (entity, id, field, value) where R follows A
 * with no intervening S that rewrites the whole array.
 */
function cancelAppendRemovePairs(transactions) {
    const drop = new Set();
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op !== 'R') continue;
        const f = tx.d?.f, v = tx.d?.v;
        if (typeof f !== 'string') continue;
        // Walk back to find a matching A; abort if a S on (e,id,f) appears.
        for (let j = i - 1; j >= 0; j--) {
            if (drop.has(j)) continue;
            const prev = transactions[j];
            if (prev.e !== tx.e || prev.id !== tx.id) continue;
            if (prev.op === 'S' && prev.d?.f === f) break;  // wholesale rewrite
            if (prev.op === 'A' && prev.d?.f === f && JSON.stringify(prev.d?.v) === JSON.stringify(v)) {
                drop.add(j);
                drop.add(i);
                break;
            }
        }
    }
    return transactions.filter((_, i) => !drop.has(i));
}

/**
 * For collisions whose terminal status is RESOLVED or CRASHED:
 * keep only CR, terminal TR, and S writes to outcome_type/aftermath.
 * Drop intermediate S/MS/TR on distance/name/forces/involved_chars/etc.
 *
 * Engine-rolled distance ticks are also dropped — they're useless once resolved.
 *
 * SEMANTIC CAVEAT: After this compaction runs, AMENDing a RESOLVED collision
 * back to ACTIVE will reset its distance to its CR-time value, not its last
 * pre-resolution value. The intermediate distance history is gone. Document
 * this in CLAUDE.md and surface it in any UI that exposes retcon AMENDs.
 */
function stripResolvedCollisionIntermediates(transactions) {
    // Pass 1: identify resolved collisions and their terminal TR tx index.
    const terminalIdx = new Map();  // collisionId -> terminal TR index
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.op === 'TR' && tx.e === 'collision'
            && tx.d?.f === 'status'
            && TERMINAL_COLLISION_STATUSES.has(tx.d?.to)) {
            terminalIdx.set(tx.id, i);
        }
    }
    if (terminalIdx.size === 0) return transactions;

    // Pass 2: for each resolved collision, keep only CR + terminal TR + outcome/aftermath S.
    const KEEP_FIELDS = new Set(['outcome_type', 'aftermath']);
    return transactions.filter((tx, i) => {
        if (tx.e !== 'collision') return true;
        if (!terminalIdx.has(tx.id)) return true;  // not yet resolved
        if (tx.op === 'CR') return true;
        if (i === terminalIdx.get(tx.id)) return true;  // the terminal TR
        if (tx.op === 'S' && KEEP_FIELDS.has(tx.d?.f)) return true;
        return false;
    });
}

/**
 * Drop SNAP and ROLL transactions older than the earliest retained snapshot's lastTxId.
 * computeState already skips these in replay, but they bloat the array.
 */
function cullSnapAndRoll(transactions, oldestRetainedSnapshotLastTxId) {
    if (typeof oldestRetainedSnapshotLastTxId !== 'number') return transactions;
    return transactions.filter(tx => {
        if (tx.op !== 'SNAP' && tx.op !== 'ROLL') return true;
        return tx.tx >= oldestRetainedSnapshotLastTxId;
    });
}

/**
 * Compose multiple compactors and verify replay equivalence.
 * Returns either the compacted array (if equivalent) or the original (if diverged).
 *
 * @param {Array} transactions
 * @param {Array<Function>} compactors - functions that take and return tx arrays
 * @param {Function} computeState - imported from state-compute
 * @param {Function} diffStates - imported from state-compute
 * @returns {{ result: Array, diverged: boolean, diff: Object|null }}
 */
const IGNORED_DIFF_KEYS = new Set(['_history', '_lastTxId']);

function filterDiff(diff) {
    // diffStates returns an array of change records: [{ entity, id, type, field, ... }, ...]
    // We don't care about derived order-sensitive keys — filter only by entity/field name.
    if (!diff) return null;
    if (Array.isArray(diff)) {
        // Each record has an `entity` key naming the collection ('characters', '_history', etc.)
        const real = diff.filter(d => !IGNORED_DIFF_KEYS.has(d?.entity ?? d?.key ?? d?.path));
        return real.length > 0 ? real : null;
    }
    if (typeof diff === 'object') {
        const real = Object.entries(diff).filter(([k]) => !IGNORED_DIFF_KEYS.has(k));
        return real.length > 0 ? Object.fromEntries(real) : null;
    }
    return diff;
}

function compactWithIntegrityCheck(transactions, compactors, computeState, diffStates) {
    let working = transactions;
    for (const fn of compactors) {
        working = fn(working);
    }
    const before = computeState(null, transactions);
    const after = computeState(null, working);
    const rawDiff = diffStates(before, after);
    const realDiff = filterDiff(rawDiff);
    if (realDiff) {
        console.warn('[GravityCompactor] Diverged — reverting to uncompacted.', realDiff);
        return { result: transactions, diverged: true, diff: realDiff };
    }
    return { result: working, diverged: false, diff: null };
}

export {
    coalesceLastWriteWins,
    coalesceMSLastWriteWins,
    dropDestroyedEntityTxs,
    cancelAppendRemovePairs,
    stripResolvedCollisionIntermediates,
    cullSnapAndRoll,
    compactWithIntegrityCheck,
};
