/**
 * ledger-store.js — Append-only ledger storage via chatMetadata.
 *
 * All data is stored in chatMetadata['gravity_ledger'] as a JSON object:
 * {
 *   transactions: [...],     // Full transaction history
 *   snapshots: [...],        // State snapshots
 *   lastTxId: number,
 *   createdAt: string,
 *   updatedAt: string
 * }
 *
 * This persists with the chat file on disk — no lorebook needed for storage.
 */

const METADATA_KEY = 'gravity_ledger';

let _txCounter = 0;
let _transactions = [];
let _currentChatId = null;

/**
 * Reset the ledger store state. Called when switching chats.
 */
function reset() {
    _txCounter = 0;
    _transactions = [];
    _currentChatId = null;
}

/**
 * Get the ledger data object from chatMetadata.
 * @returns {Object}
 */
function getLedgerData() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[METADATA_KEY]) {
        chatMetadata[METADATA_KEY] = {
            transactions: [],
            snapshots: [],
            lastTxId: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }
    return chatMetadata[METADATA_KEY];
}

/**
 * Save the current ledger data to disk.
 */
async function persist() {
    const data = getLedgerData();
    data.transactions = _transactions;
    data.lastTxId = _txCounter;
    data.updatedAt = new Date().toISOString();

    const { saveMetadata } = SillyTavern.getContext();
    await saveMetadata();
    console.log(`[GravityLedger] Persisted ${_transactions.length} TX to chatMetadata.`);
}

/**
 * Initialize the ledger store from chatMetadata.
 * @param {string} [chatId]
 */
async function init(chatId) {
    if (chatId && _currentChatId && chatId !== _currentChatId) {
        reset();
    }
    _currentChatId = chatId || null;

    const data = getLedgerData();
    _transactions = data.transactions || [];
    _txCounter = data.lastTxId || (_transactions.length > 0
        ? Math.max(..._transactions.map(tx => tx.tx || 0)) + 1
        : 0);

    console.log(`[GravityLedger] Loaded ${_transactions.length} TX from chatMetadata.`);
}

/**
 * Assign transaction IDs, normalize fields, and add real timestamps.
 * @param {Array} transactions
 * @returns {Array}
 */
function normalizeTransactions(transactions) {
    const now = new Date().toISOString();
    return transactions.map(tx => ({
        tx: tx.tx ?? _txCounter++,
        t: tx.t || tx.timestamp || '',
        _ts: now,  // Real-world timestamp
        op: tx.op || tx.type || 'S',
        e: tx.e || tx.entity || '',
        id: tx.id || tx.entity_id || '',
        d: tx.d || tx.data || {},
        r: tx.r || tx.reason || '',
    }));
}

/**
 * Append validated transactions to the ledger.
 * @param {Array} transactions
 * @returns {Promise<Array>} Committed transactions with IDs
 */
async function append(transactions) {
    const normalized = normalizeTransactions(transactions);
    _transactions.push(...normalized);
    await persist();
    return normalized;
}

/**
 * Get all transactions.
 * @returns {Array}
 */
function getAllTransactions() {
    return _transactions;
}

/**
 * Get transactions since a specific tx_id.
 * @param {number} sinceTxId
 * @returns {Array}
 */
function getTransactionsSince(sinceTxId) {
    return _transactions.filter(tx => tx.tx > sinceTxId);
}

/**
 * Get transactions for a specific entity.
 * @param {string} entityId
 * @returns {Array}
 */
function getTransactionsForEntity(entityId) {
    return _transactions.filter(tx =>
        tx.id === entityId ||
        (tx.op === 'AMEND' && tx.d?.correction?.id === entityId)
    );
}

/**
 * Get transactions within a time range.
 * @param {string} fromTimestamp
 * @param {string} [toTimestamp]
 * @returns {Array}
 */
function getTransactionsInRange(fromTimestamp, toTimestamp) {
    return _transactions.filter(tx => {
        if (!tx.t) return false;
        if (fromTimestamp && tx.t < fromTimestamp) return false;
        if (toTimestamp && tx.t > toTimestamp) return false;
        return true;
    });
}

/**
 * Get current tx counter.
 * @returns {number}
 */
function getCurrentTxId() {
    return _txCounter;
}

/**
 * Save a snapshot to chatMetadata.
 * @param {Object} snapshot
 */
async function saveSnapshot(snapshot) {
    const data = getLedgerData();
    data.snapshots.push(snapshot);

    // Keep only last 5 snapshots
    if (data.snapshots.length > 5) {
        data.snapshots = data.snapshots.slice(-5);
    }

    await persist();
}

/**
 * Get all snapshots.
 * @returns {Array}
 */
function getSnapshots() {
    const data = getLedgerData();
    return data.snapshots || [];
}

/**
 * Get the latest snapshot.
 * @returns {Object|null}
 */
function getLatestSnapshot() {
    const snapshots = getSnapshots();
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

/**
 * Export the full ledger data as JSON.
 * @returns {Object}
 */
function exportData() {
    return getLedgerData();
}

/**
 * Import ledger data from JSON.
 * @param {Object} data
 */
async function importData(data) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata[METADATA_KEY] = data;
    _transactions = data.transactions || [];
    _txCounter = data.lastTxId || 0;
    await saveMetadata();
}

export {
    init,
    reset,
    append,
    persist,
    getAllTransactions,
    getTransactionsSince,
    getTransactionsForEntity,
    getTransactionsInRange,
    getCurrentTxId,
    normalizeTransactions,
    saveSnapshot,
    getSnapshots,
    getLatestSnapshot,
    exportData,
    importData,
    METADATA_KEY,
};
