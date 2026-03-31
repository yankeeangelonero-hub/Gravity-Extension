/**
 * snapshot-mgr.js — Snapshot creation, storage, and rollback.
 *
 * Snapshots are stored in chatMetadata alongside transactions.
 * Used for rollback and as computation checkpoints.
 */

import { computeState, createEmptyState } from './state-compute.js';
import {
    getAllTransactions,
    getTransactionsSince,
    append,
    saveSnapshot,
    getSnapshots,
    getLatestSnapshot,
} from './ledger-store.js';

let _snapshotCounter = 0;

/**
 * Initialize snapshot manager.
 */
function init() {
    const snapshots = getSnapshots();
    _snapshotCounter = snapshots.length > 0
        ? Math.max(...snapshots.map(s => s.id || 0)) + 1
        : 0;
}

/**
 * Create a new snapshot of the current computed state.
 * @param {Object} currentState
 * @param {string} [label]
 * @returns {Promise<Object>}
 */
async function createSnapshot(currentState, label) {
    const snapshotId = _snapshotCounter++;
    const snapshot = {
        id: snapshotId,
        label: label || `Snapshot ${snapshotId}`,
        lastTxId: currentState.lastTxId,
        createdAt: new Date().toISOString(),
        state: currentState,
    };

    await saveSnapshot(snapshot);

    // Record in ledger
    await append([{
        op: 'SNAP',
        e: 'system',
        id: `snapshot-${snapshotId}`,
        d: { snapshot_id: snapshotId, label: label || '' },
        r: `Snapshot: ${label || 'auto'}`,
    }]);

    return { id: snapshotId, label: snapshot.label, lastTxId: currentState.lastTxId };
}

/**
 * List all snapshots.
 * @returns {Array}
 */
function listSnapshots() {
    return getSnapshots().map(s => ({
        id: s.id,
        label: s.label,
        lastTxId: s.lastTxId,
        createdAt: s.createdAt,
    }));
}

/**
 * Get a specific snapshot by ID.
 * @param {number} snapshotId
 * @returns {Object|null}
 */
function getSnapshot(snapshotId) {
    const snapshots = getSnapshots();
    return snapshots.find(s => s.id === snapshotId) || null;
}

/**
 * Rollback to a specific snapshot.
 * @param {number} targetSnapshotId
 * @returns {Promise<Object>} The restored state
 */
async function rollback(targetSnapshotId) {
    const snapshot = getSnapshot(targetSnapshotId);
    if (!snapshot) throw new Error(`Snapshot ${targetSnapshotId} not found`);

    await append([{
        op: 'ROLL',
        e: 'system',
        id: `rollback-to-${targetSnapshotId}`,
        d: { target_snapshot_id: targetSnapshotId },
        r: `Rolled back to snapshot ${targetSnapshotId}: ${snapshot.label}`,
    }]);

    return snapshot.state;
}

/**
 * Compute current state: respects rollback, then replays from the effective
 * base (rollback target or latest snapshot) + subsequent transactions.
 *
 * Logic:
 * 1. Find the most recent ROLL transaction in the ledger.
 * 2. If found, use its target snapshot as the base. Only replay transactions
 *    that came AFTER the ROLL (new work since rollback).
 * 3. If no ROLL, use the latest snapshot + transactions since it.
 * 4. If no snapshots at all, replay everything from scratch.
 * @returns {Object}
 */
function computeCurrentState() {
    const allTxns = getAllTransactions();

    // Find the most recent ROLL transaction
    let lastRoll = null;
    for (let i = allTxns.length - 1; i >= 0; i--) {
        if (allTxns[i].op === 'ROLL') {
            lastRoll = allTxns[i];
            break;
        }
    }

    if (lastRoll) {
        // Rollback active — use the target snapshot as base
        const targetId = lastRoll.d?.target_snapshot_id;
        const targetSnapshot = targetId != null ? getSnapshot(targetId) : null;

        if (targetSnapshot) {
            // Replay only transactions that came AFTER the ROLL
            const txnsAfterRoll = allTxns.filter(tx => tx.tx > lastRoll.tx);
            return computeState(targetSnapshot.state, txnsAfterRoll);
        }
        // Target snapshot missing — fall through to normal computation
        console.warn('[GravityLedger:Snapshot] ROLL target snapshot not found, computing from scratch');
    }

    // Normal path — latest snapshot + subsequent transactions
    const latest = getLatestSnapshot();
    if (latest) {
        const txnsSince = getTransactionsSince(latest.lastTxId);
        return computeState(latest.state, txnsSince);
    }

    return computeState(null, allTxns);
}

export {
    init as initSnapshots,
    createSnapshot,
    listSnapshots,
    getSnapshot,
    rollback,
    computeCurrentState,
};
