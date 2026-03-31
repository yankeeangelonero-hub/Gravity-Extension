/**
 * preset-manager.js — Per-chat prose settings applied to Gravity Preset prompt entries.
 *
 * Prose styles, word count, and divination are prompt entries in Gravity Preset.json.
 * The extension toggles entries and writes content in-memory (window.oai_settings)
 * on every chat load and settings change — no save called, since per-chat preferences
 * live in chatMetadata and are reapplied fresh on each initialize().
 *
 * Prose style entries (gravity_prose_noir etc.) are toggled enabled/disabled.
 * Word count and divination entries have their content written dynamically.
 * Tense and perspective stay in the nudge (short, per-call, not worth a preset slot).
 */

// ─── Entry ID Tables ───────────────────────────────────────────────────────────

const PROSE_ENTRY_IDS = [
    'gravity_prose_noir',
    'gravity_prose_literary',
    'gravity_prose_cinematic',
    'gravity_prose_minimalist',
    'gravity_prose_wuxia',
];

const WORD_COUNT_ENTRIES = {
    'flexible':   'gravity_word_count_flexible',
    'under 150':  'gravity_word_count_short',
    '150-300':    'gravity_word_count_150',
    '300-600':    'gravity_word_count_300',
    '600-1000':   'gravity_word_count_600',
    '1000-1500':  'gravity_word_count_1000',
};

const DIVINATION_ENTRIES = {
    arcana:  'gravity_divination_arcana',
    iching:  'gravity_divination_iching',
    classic: 'gravity_divination_classic',
};

// ─── Preset API Helpers ────────────────────────────────────────────────────────

function getOaiSettings() {
    try {
        return window.oai_settings || null;
    } catch {
        return null;
    }
}

/**
 * Enable or disable a prompt entry in oai_settings.prompt_order.
 * Modifies in-memory only — no save called (reapplied fresh on each chat load).
 */
function togglePresetEntry(identifier, enabled) {
    const oai = getOaiSettings();
    if (!oai?.prompt_order) return;
    for (const order of oai.prompt_order) {
        if (!Array.isArray(order.order)) continue;
        const entry = order.order.find(e => e.identifier === identifier);
        if (entry) entry.enabled = enabled;
    }
}

// ─── Apply Functions ──────────────────────────────────────────────────────────

/**
 * Toggle gravity_prose_sonnet based on model tier.
 * Prose style, word count, and divination are toggled directly in the preset UI.
 *
 * @param {boolean} sonnetTier
 */
function applyAllPresetSettings({ sonnetTier = false } = {}) {
    togglePresetEntry('gravity_prose_sonnet', sonnetTier);
}

// Kept for external callers (e.g. if invoked by index.js settings change handler).
function applyProseStyle(style, sonnetTier = false) {
    for (const id of PROSE_ENTRY_IDS) {
        togglePresetEntry(id, id === `gravity_prose_${style}`);
    }
    togglePresetEntry('gravity_prose_sonnet', sonnetTier);
}

function applyWordCount(wordCount) {
    const activeId = WORD_COUNT_ENTRIES[wordCount] ?? WORD_COUNT_ENTRIES.flexible;
    for (const id of Object.values(WORD_COUNT_ENTRIES)) {
        togglePresetEntry(id, id === activeId);
    }
}

function applyDivination(system) {
    const key = (system || 'arcana').toLowerCase().replace(/[\s_]/g, '');
    const activeId = DIVINATION_ENTRIES[key] ?? DIVINATION_ENTRIES.arcana;
    for (const id of Object.values(DIVINATION_ENTRIES)) {
        togglePresetEntry(id, id === activeId);
    }
}

export {
    applyProseStyle,
    applyWordCount,
    applyDivination,
    applyAllPresetSettings,
};
