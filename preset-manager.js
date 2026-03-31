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

// ─── Word Count Content ────────────────────────────────────────────────────────

const WORD_COUNT_CONTENT = {
    'under 150':  'LENGTH: Under 150 words ceiling. Not a target — match the beat. One beat = one response.',
    '150-300':    'LENGTH: 150-300 words ceiling. Not a target.',
    '300-600':    'LENGTH: 300-600 words ceiling. Not a target.',
    '600-1000':   'LENGTH: 600-1000 words ceiling. Not a target.',
    '1000-1500':  'LENGTH: 1000-1500 words ceiling. Not a target.',
    'flexible':   'LENGTH: Flexible — match the scene. Let the beat determine the length. A quiet exchange is 80 words. A collision detonation earns 600.',
};

// ─── Divination System Content ─────────────────────────────────────────────────

const DIVINATION_CONTENT = {
    arcana: `DIVINATION: Major Arcana oracle (d22).
When a DIVINATION DRAW appears in context, read the card as a narrative lens — not a directive. The card names a threshold, a cost, or a tension latent in the scene. Apply it as a pressure on the collision's resolution: what kind of consequence does this card make possible?
A Death draw means something must end — the specific ending is your narrative judgment. A Fool draw means something leaps blind into unknown territory. A Tower draw means the structure that felt stable is about to fall. Read the archetypal meaning; do not invent a rigid outcome.`,

    iching: `DIVINATION: 易経 I Ching oracle (d64).
When a DIVINATION DRAW appears in context, read the hexagram as a diagnosis of the moment's pattern of forces. Each hexagram describes a configuration of energies (yielding/firm, ascending/descending, flow/blockage). Apply it to the collision at hand: is this a moment for action or withdrawal? What force is overextended? What is the natural direction that still moves toward resolution?
Read the hexagram's name and judgment as a situational diagnosis, not a command.`,

    classic: `DIVINATION: Classic Entropy oracle (2d10).
When a DIVINATION DRAW appears in context, read the combined total as an entropy gauge: high (16-20) means escalation, consequence, and irreversible shift; mid (9-15) means complication or partial outcome; low (2-8) means delay, unexpected opening, or cost extracted from the wrong party.
This is not a success/failure gate — it is a narrative pressure that shapes the beat's character and cost.`,
};

// ─── Prose Style Entry IDs ─────────────────────────────────────────────────────

const PROSE_ENTRY_IDS = [
    'gravity_prose_noir',
    'gravity_prose_literary',
    'gravity_prose_cinematic',
    'gravity_prose_minimalist',
    'gravity_prose_wuxia',
];

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

/**
 * Write content into a prompt entry in oai_settings.prompts.
 * Modifies in-memory only.
 */
function writePresetEntryContent(identifier, content) {
    const oai = getOaiSettings();
    if (!oai?.prompts) return;
    const prompt = oai.prompts.find(p => p.identifier === identifier);
    if (prompt) prompt.content = content;
}

// ─── Apply Functions ──────────────────────────────────────────────────────────

/**
 * Enable one prose style entry, disable all others.
 * Also toggles gravity_prose_sonnet based on model tier.
 *
 * @param {string} style - 'noir' | 'literary' | 'cinematic' | 'minimalist' | 'wuxia'
 * @param {boolean} sonnetTier
 */
function applyProseStyle(style, sonnetTier = false) {
    for (const id of PROSE_ENTRY_IDS) {
        togglePresetEntry(id, id === `gravity_prose_${style}`);
    }
    togglePresetEntry('gravity_prose_sonnet', sonnetTier);
}

/**
 * Write the word count instruction into the gravity_word_count preset entry.
 *
 * @param {string} wordCount - 'flexible' | 'under 150' | '150-300' | '300-600' | '600-1000' | '1000-1500'
 */
function applyWordCount(wordCount) {
    const content = WORD_COUNT_CONTENT[wordCount] ?? WORD_COUNT_CONTENT.flexible;
    writePresetEntryContent('gravity_word_count', content);
}

/**
 * Write the divination system description into the gravity_divination preset entry.
 *
 * @param {string} system - 'arcana' | 'iching' | 'classic'
 */
function applyDivination(system) {
    const key = (system || 'arcana').toLowerCase().replace(/[\s_]/g, '').replace('iching', 'iching');
    const content = DIVINATION_CONTENT[key] ?? DIVINATION_CONTENT.arcana;
    writePresetEntryContent('gravity_divination', content);
}

/**
 * Apply all per-chat prose settings to the preset in one call.
 * Called on chat load and after any settings change.
 *
 * @param {Object} opts
 * @param {string} [opts.proseStyle]
 * @param {string} [opts.wordCount]
 * @param {string} [opts.divination]
 * @param {boolean} [opts.sonnetTier]
 */
function applyAllPresetSettings({ proseStyle = 'noir', wordCount = 'flexible', divination = 'arcana', sonnetTier = false } = {}) {
    applyProseStyle(proseStyle, sonnetTier);
    applyWordCount(wordCount);
    applyDivination(divination);
}

export {
    applyProseStyle,
    applyWordCount,
    applyDivination,
    applyAllPresetSettings,
};
