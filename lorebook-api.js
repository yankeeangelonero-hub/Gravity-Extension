/**
 * lorebook-api.js — Direct lorebook CRUD via SillyTavern's /api/worldinfo/ endpoints.
 *
 * API reference (from src/endpoints/worldinfo.js):
 *   POST /api/worldinfo/list         — list all books (no body needed)
 *   POST /api/worldinfo/get          — get one book: { name }
 *   POST /api/worldinfo/edit         — create or update a book: { name, data: { entries: {...} } }
 *   POST /api/worldinfo/delete       — delete a book: { name }
 */

// Import the world info cache so we can invalidate it after writes
import { worldInfoCache } from '../../../world-info.js';

function getHeaders() {
    return SillyTavern.getContext().getRequestHeaders();
}

/**
 * List all world info books.
 * @returns {Promise<Array<{file_id: string, name: string}>>}
 */
async function listWorldInfoBooks() {
    const response = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getHeaders(),
    });
    if (!response.ok) throw new Error(`Failed to list world info: ${response.status}`);
    return await response.json();
}

/**
 * Load a specific world info book by name.
 * @param {string} name
 * @returns {Promise<Object>} The book data with entries
 */
async function loadWorldInfoBook(name) {
    // Clear cache to ensure we get fresh data from disk
    if (worldInfoCache) {
        worldInfoCache.delete(name);
    }

    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`Failed to get world info "${name}": ${response.status}`);
    const data = await response.json();

    // Update cache with fresh data
    if (worldInfoCache) {
        worldInfoCache.set(name, data);
    }

    return data;
}

/**
 * Save (create or update) a world info book.
 * @param {string} name
 * @param {Object} data - The full book data including entries
 */
async function saveWorldInfoBook(name, data) {
    const entryCount = data?.entries ? Object.keys(data.entries).length : 0;
    console.log(`[GravityLedger] Saving book "${name}" with ${entryCount} entries`);
    const response = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name, data }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save world info "${name}": ${response.status} ${text}`);
    }

    // Invalidate SillyTavern's world info cache so UI sees fresh data
    if (worldInfoCache) {
        worldInfoCache.delete(name);
    }
}

/**
 * Find or create the Gravity Ledger lorebook for a specific chat.
 * @param {string} [chatId]
 * @returns {Promise<string>} The lorebook name
 */
async function ensureLedgerBook(chatId) {
    // Sanitize chatId for safe filenames — replace unsafe chars with underscores
    const safeChatId = chatId ? chatId.replace(/[^a-zA-Z0-9_-]/g, '_') : null;
    const bookName = safeChatId ? `Gravity_Ledger_${safeChatId}` : 'Gravity_Ledger';

    // Check if book exists
    const books = await listWorldInfoBooks();
    const exists = books.some(b => b.file_id === bookName || b.name === bookName);

    if (exists) return bookName;

    // If no chatId, try to find any existing Gravity_Ledger book
    if (!chatId) {
        const existing = books.find(b => b.file_id?.startsWith('Gravity_Ledger') || b.name?.startsWith('Gravity_Ledger'));
        if (existing) return existing.file_id || existing.name;
    }

    // Create new book via /edit
    await saveWorldInfoBook(bookName, { entries: {} });
    return bookName;
}

/**
 * Get all entries in a lorebook.
 * @param {string} bookName
 * @returns {Promise<Object>} Map of uid to entry objects
 */
async function getEntries(bookName) {
    const book = await loadWorldInfoBook(bookName);
    if (!book) return {};
    return book.entries || {};
}

/**
 * Find an entry by comment.
 * @param {string} bookName
 * @param {string} comment
 * @returns {Promise<Object|null>}
 */
async function findEntryByComment(bookName, comment) {
    const entries = await getEntries(bookName);
    for (const [uid, entry] of Object.entries(entries)) {
        if (entry.comment === comment) return { uid: Number(uid), ...entry };
    }
    return null;
}

/**
 * Create a new lorebook entry by adding it to the book and saving.
 * @param {string} bookName
 * @param {Object} entryData
 * @returns {Promise<Object>}
 */
async function createEntry(bookName, entryData) {
    const book = await loadWorldInfoBook(bookName);
    const entries = book.entries || {};

    // Find next available UID
    const existingUids = Object.keys(entries).map(Number);
    const newUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;

    const newEntry = {
        key: entryData.key || [],
        keysecondary: entryData.keysecondary || [],
        comment: entryData.comment || '',
        content: entryData.content || '',
        constant: entryData.constant ?? false,
        selective: entryData.selective ?? false,
        selectiveLogic: entryData.selectiveLogic ?? 0,
        position: entryData.position ?? 0,
        disable: entryData.disable ?? false,
        order: entryData.order ?? 100,
        depth: entryData.depth ?? 4,
        scanDepth: entryData.scanDepth ?? null,
        caseSensitive: entryData.caseSensitive ?? false,
        matchWholeWords: entryData.matchWholeWords ?? false,
        automationId: entryData.automationId ?? '',
        excludeRecursion: entryData.excludeRecursion ?? false,
        preventRecursion: entryData.preventRecursion ?? false,
        delayUntilRecursion: entryData.delayUntilRecursion ?? false,
        probability: entryData.probability ?? 100,
        useProbability: entryData.useProbability ?? true,
        group: entryData.group ?? '',
        groupOverride: entryData.groupOverride ?? false,
        groupWeight: entryData.groupWeight ?? 100,
        sticky: entryData.sticky ?? null,
        cooldown: entryData.cooldown ?? null,
        delay: entryData.delay ?? null,
    };

    entries[newUid] = newEntry;
    book.entries = entries;
    await saveWorldInfoBook(bookName, book);

    return { uid: newUid, ...newEntry };
}

/**
 * Update an existing lorebook entry.
 * @param {string} bookName
 * @param {number} uid
 * @param {Object} updates
 */
async function updateEntry(bookName, uid, updates) {
    const book = await loadWorldInfoBook(bookName);
    const entries = book.entries || {};

    if (!entries[uid]) throw new Error(`Entry ${uid} not found in ${bookName}`);

    Object.assign(entries[uid], updates);
    book.entries = entries;
    await saveWorldInfoBook(bookName, book);
}

/**
 * Delete a lorebook entry.
 * @param {string} bookName
 * @param {number} uid
 */
async function deleteEntry(bookName, uid) {
    const book = await loadWorldInfoBook(bookName);
    const entries = book.entries || {};

    delete entries[uid];
    book.entries = entries;
    await saveWorldInfoBook(bookName, book);
}

export {
    listWorldInfoBooks,
    loadWorldInfoBook,
    saveWorldInfoBook,
    ensureLedgerBook,
    getEntries,
    findEntryByComment,
    createEntry,
    updateEntry,
    deleteEntry,
};
