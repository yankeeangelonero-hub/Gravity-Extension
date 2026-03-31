/**
 * lorebook-manager.js — Extension-driven lorebook activation.
 *
 * Scans world info entries tagged with automationId gravity_<module>,
 * builds a module map, and activates/deactivates entries based on turn mode.
 *
 * NO keyword-driven activation. The extension is the sole orchestrator.
 * Prose style, word count, and divination are preset entries (not lorebook) —
 * managed by preset-manager.js.
 *
 * Module activation per turn mode:
 *   regular     → core, deduction_regular, ledger-core
 *   advance     → core, deduction_advance, advance, factions, ledger-core
 *   combat      → core, deduction_combat, combat, ledger-core
 *   intimacy    → core, deduction_intimacy, intimacy, ledger-core
 *   integration → core, advance, combat, intimacy, factions, ledger-full
 *
 * When DeepSeek is active (ledger written by external model):
 *   Drop all ledger-* and deduction_* modules — Opus writes prose only.
 *
 * Sonnet tier activates gravity_intimacy_sonnet during intimacy turns.
 */

// ─── Module Activation Tables ─────────────────────────────────────────────────

const MODULE_ACTIVATION = {
    regular:     ['core', 'deduction_regular', 'ledger-core'],
    advance:     ['core', 'deduction_advance', 'advance', 'factions', 'ledger-core'],
    combat:      ['core', 'deduction_combat', 'combat', 'ledger-core'],
    intimacy:    ['core', 'deduction_intimacy', 'intimacy', 'ledger-core'],
    integration: ['core', 'advance', 'combat', 'intimacy', 'factions', 'ledger-full'],
};

// When DeepSeek handles the ledger — Opus writes prose only, no COT or ledger reference
const MODULE_ACTIVATION_DS = {
    regular:     ['core'],
    advance:     ['core', 'advance', 'factions'],
    combat:      ['core', 'combat'],
    intimacy:    ['core', 'intimacy'],
    integration: ['core', 'advance', 'combat', 'intimacy', 'factions'],
};

const GRAVITY_PREFIX = 'gravity_';

// ─── Module Map ────────────────────────────────────────────────────────────────

// Map: module_name → [{ uid, bookName }]
let _moduleMap = {};

// ─── World Info API Helpers ────────────────────────────────────────────────────

function getAllGravityEntries() {
    try {
        const context = SillyTavern.getContext();
        const { world_info } = context;
        if (!world_info) return [];

        const results = [];
        for (const [bookName, book] of Object.entries(world_info.entries || {})) {
            for (const [uid, entry] of Object.entries(book.entries || {})) {
                const autoId = entry.automationId || '';
                if (autoId.startsWith(GRAVITY_PREFIX)) {
                    results.push({ uid: parseInt(uid), bookName, entry });
                }
            }
        }
        return results;
    } catch (e) {
        console.warn('[GravityLorebook] Failed to read world info entries:', e);
        return [];
    }
}

function setEntryEnabled(uid, bookName, enabled) {
    try {
        const context = SillyTavern.getContext();
        const { world_info, saveWorldInfo } = context;
        if (!world_info?.entries?.[bookName]?.entries?.[uid]) return;

        world_info.entries[bookName].entries[uid].disable = !enabled;

        if (typeof saveWorldInfo === 'function') {
            saveWorldInfo(bookName);
        }
    } catch (e) {
        console.warn(`[GravityLorebook] Failed to toggle entry uid=${uid}:`, e);
    }
}

// ─── Module Map Builder ────────────────────────────────────────────────────────

/**
 * Scan all world info entries for gravity_* automationIds and build the module map.
 * Call on init and on chat change.
 *
 * @returns {string[]} Available module names found
 */
function buildModuleMap() {
    _moduleMap = {};
    const entries = getAllGravityEntries();

    for (const { uid, bookName, entry } of entries) {
        const autoId = entry.automationId || '';
        if (!autoId.startsWith(GRAVITY_PREFIX)) continue;

        const moduleName = autoId.slice(GRAVITY_PREFIX.length);

        if (!_moduleMap[moduleName]) {
            _moduleMap[moduleName] = [];
        }
        _moduleMap[moduleName].push({ uid, bookName });
    }

    console.log('[GravityLorebook] Module map built:', Object.keys(_moduleMap).join(', '));
    return Object.keys(_moduleMap);
}

/**
 * Get all expansion module IDs (non-built-in modules).
 */
function getExpansionModules() {
    const builtIn = new Set([
        'core', 'advance', 'combat', 'intimacy', 'factions',
        'ledger-core', 'ledger-full',
        'intimacy_sonnet',
        'deduction_regular', 'deduction_advance', 'deduction_combat', 'deduction_intimacy',
        'combat_scale',
    ]);
    return Object.keys(_moduleMap).filter(m => !builtIn.has(m));
}

// ─── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate the set of modules for a given turn mode.
 * Disables all other gravity entries to prevent interference.
 *
 * @param {'regular'|'advance'|'combat'|'intimacy'|'integration'} mode
 * @param {Object} options
 * @param {boolean} [options.deepseekEnabled]
 * @param {boolean} [options.sonnetTier] - Activates gravity_intimacy_sonnet during intimacy
 */
function activateModules(mode, options = {}) {
    const { deepseekEnabled = false, sonnetTier = false } = options;

    const table = deepseekEnabled ? MODULE_ACTIVATION_DS : MODULE_ACTIVATION;
    const baseModes = table[mode] || table.regular;

    const activeModules = new Set(baseModes);

    // Sonnet intimacy choice frameworks
    if (sonnetTier && (mode === 'intimacy' || mode === 'integration')) {
        activeModules.add('intimacy_sonnet');
    }

    // Combat scale only if it has content
    if (mode === 'combat' || mode === 'integration') {
        const scaleEntries = _moduleMap['combat_scale'];
        if (scaleEntries) {
            const hasContent = scaleEntries.some(({ uid, bookName }) => {
                try {
                    const context = SillyTavern.getContext();
                    const entry = context.world_info?.entries?.[bookName]?.entries?.[uid];
                    return entry?.content && entry.content.trim().length > 0;
                } catch { return false; }
            });
            if (hasContent) activeModules.add('combat_scale');
        }
    }

    // Apply: enable active modules, disable everything else
    for (const [moduleName, entries] of Object.entries(_moduleMap)) {
        const shouldEnable = activeModules.has(moduleName);
        for (const { uid, bookName } of entries) {
            setEntryEnabled(uid, bookName, shouldEnable);
        }
    }

    console.log(`[GravityLorebook] Mode=${mode} DS=${deepseekEnabled} Sonnet=${sonnetTier} | Active: ${[...activeModules].join(', ')}`);
}

/**
 * Write content into a named module's entries (replaces existing content).
 * Used by the extension to update dynamic entries (e.g. combat_scale).
 *
 * @param {string} moduleName
 * @param {string} content
 */
function writeModuleContent(moduleName, content) {
    const entries = _moduleMap[moduleName];
    if (!entries || entries.length === 0) {
        console.warn(`[GravityLorebook] Module not found: ${moduleName}`);
        return;
    }

    try {
        const context = SillyTavern.getContext();
        const { world_info, saveWorldInfo } = context;

        for (const { uid, bookName } of entries) {
            const entry = world_info?.entries?.[bookName]?.entries?.[uid];
            if (entry) {
                entry.content = content;
                if (typeof saveWorldInfo === 'function') {
                    saveWorldInfo(bookName);
                }
            }
        }
        console.log(`[GravityLorebook] Wrote content to module: ${moduleName}`);
    } catch (e) {
        console.warn(`[GravityLorebook] Failed to write module ${moduleName}:`, e);
    }
}

/**
 * Disable ALL gravity lorebook entries.
 * Called on chat change before re-initializing.
 */
function disableAll() {
    for (const entries of Object.values(_moduleMap)) {
        for (const { uid, bookName } of entries) {
            setEntryEnabled(uid, bookName, false);
        }
    }
}

export {
    buildModuleMap,
    activateModules,
    writeModuleContent,
    getExpansionModules,
    disableAll,
};
