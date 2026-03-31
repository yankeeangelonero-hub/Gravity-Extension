/**
 * rules-engine.js — Prose settings and compatibility shim.
 *
 * Rule content has moved to Gravity World Info.json (lorebook entries).
 * Lorebook-manager.js activates the correct entries per turn mode.
 *
 * This module now only:
 * 1. Manages per-chat prose settings (tense, perspective, style, model tier, word count)
 * 2. Exports SONNET_ENFORCEMENT for ui-panel.js to push into the preset's nsfw slot
 * 3. Exports getProseSettings() for other modules that need tense/perspective info
 */

// ─── Sonnet Enforcement ────────────────────────────────────────────────────────
// Exported for ui-panel.js to write into the preset nsfw slot when model tier = sonnet.
// Also used by lorebook-manager.js to activate gravity_prose_sonnet.

export const SONNET_ENFORCEMENT = `═══ PROSE ENFORCEMENT (model tier: Sonnet) ═══

SHOW, NEVER TELL. This is the most important rule.
- NEVER write: "She felt sad" "He was angry" "The room was tense" "She was nervous"
- INSTEAD write what the BODY does: "Her hand stopped on the mug handle." "His jaw set two degrees past comfortable."
- If you catch yourself naming an emotion, DELETE IT. Replace with a physical action.

EVERY PARAGRAPH must contain:
1. One sensory detail that is NOT visual (smell, texture, temperature, sound, taste)
2. One gesture or action that reveals character (not "she smiled" — WHAT kind of smile, what it costs her)
3. Zero named emotions

DIALOGUE RULES:
- Characters do NOT speak in complete, grammatical sentences unless that IS their character.
- Action beats between dialogue lines show what the body does while talking.

BANNED → REPLACEMENT:
- "couldn't help but [verb]" → just do the verb
- "found themselves [verb]ing" → just verb directly
- "something shifted/changed" → NAME what shifted: "His weight moved to the back foot."
- "silence stretched" → describe what fills it: "The clock. The ice in the glass. Her breathing."
- "shivers down spine" → specific location: "The hair on her forearms lifted."
- "breath catching" → what breath DOES: "The inhale stopped halfway, held by the ribs."
- "eyes meeting" → what the eyes DO: "She looked at him the way you look at a door you're deciding whether to open."
- "heart pounding/racing" → physical consequence: "She could feel her pulse in her wrists."`;

// ─── Prose Style Labels ────────────────────────────────────────────────────────
// For UI display. Actual content lives in lorebook entries (gravity_prose_*).

export const PROSE_STYLE_LABELS = {
    'noir':       'Noir Realist',
    'literary':   'Literary Fiction',
    'cinematic':  'Cinematic',
    'minimalist': 'Minimalist',
    'wuxia':      'Wuxia Chronicle',
};

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Get prose settings from chatMetadata.
 * @returns {{ wordCount: string, proseStyle: string, tense: string, perspective: string, modelTier: string }}
 */
export function getProseSettings() {
    try {
        const { chatMetadata } = SillyTavern.getContext();
        return {
            wordCount:   chatMetadata?.['gravity_word_count']    || 'flexible',
            proseStyle:  chatMetadata?.['gravity_prose_style']   || 'noir',
            tense:       chatMetadata?.['gravity_tense']         || 'present',
            perspective: chatMetadata?.['gravity_perspective']   || 'close-third',
            modelTier:   chatMetadata?.['gravity_model_tier']    || 'opus',
        };
    } catch {
        return { wordCount: 'flexible', proseStyle: 'noir', tense: 'present', perspective: 'close-third', modelTier: 'opus' };
    }
}

/**
 * Build a tense+perspective line for injection in the nudge.
 * Called by index.js to include session-specific settings in the extension nudge
 * since the preset cannot encode per-chat values.
 *
 * @returns {string} e.g. "Present tense. Close-third rotating focus."
 */
export function buildSettingsLine() {
    const s = getProseSettings();

    const tenseLabel = s.tense.charAt(0).toUpperCase() + s.tense.slice(1);

    const perspMap = {
        'close-third': 'Close-third rotating focus through the subjective lens of the character in focus',
        'first':       'First-person narration from the PC\'s perspective',
        'second':      'Second-person narration addressing the player directly',
        'omniscient':  'Omniscient narration — the narrator knows all but characters only act on what they plausibly know',
    };
    const perspDesc = perspMap[s.perspective] || perspMap['close-third'];

    // Word count is now a preset entry (gravity_word_count), not injected here.
    return `${tenseLabel} tense. ${perspDesc}.`;
}
