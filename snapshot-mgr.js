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
 * Compute current state: from latest snapshot + subsequent transactions.
 * @returns {Object}
 */
function computeCurrentState() {
    const latest = getLatestSnapshot();

    if (latest) {
        const txnsSince = getTransactionsSince(latest.lastTxId);
        return computeState(latest.state, txnsSince);
    } else {
        const allTxns = getAllTransactions();
        return computeState(null, allTxns);
    }
}

export {
    init as initSnapshots,
    createSnapshot,
    listSnapshots,
    getSnapshot,
    rollback,
    computeCurrentState,
};
