/**
 * memory-tier.js — Hot/cold memory tiering for array fields.
 *
 * Hot memory: recent entries, capped, always injected into prompts.
 * Cold memory: archived originals, stored in chatMetadata, never injected.
 * Consolidated: compressed summaries of cold batches, injected alongside hot.
 *
 * The ledger and computed state remain complete — tiering only affects
 * what's DISPLAYED in the state view injection.
 */

const LOG_PREFIX = '[GravityLedger:Memory]';

// ─── Configuration ──────────────────────────────────────────────────────────

const TIER_CONFIG = {
    story_summary: {
        hotCap: 50,
        batchSize: 20,
        getArray: (state) => state.story_summary || [],
        label: 'story_summary',
    },
    pc_timeline: {
        hotCap: 30,
        batchSize: 15,
        getArray: (state) => state.pc?.timeline || [],
        label: 'pc.timeline',
    },
    pc_traits: {
        hotCap: 20,
        batchSize: 10,
        getArray: (state) => state.pc?.demonstrated_traits || [],
        label: 'pc.demonstrated_traits',
    },
};

// ─── Condensation ───────────────────────────────────────────────────────────

/**
 * Condense a batch of entries into a single summary entry.
 * This is a simple text-based compression — no LLM needed.
 * Extracts timestamps and key content, concatenates into one paragraph.
 * @param {Array} batch - entries being rotated to cold
 * @param {string} label - field label for tagging
 * @returns {Object|string} condensed entry
 */
function condenseBatch(batch, label) {
    if (!batch || batch.length === 0) return null;

    // Extract text from each entry
    const texts = batch.map(entry => {
        if (typeof entry === 'object') return entry.text || entry.t || JSON.stringify(entry);
        return String(entry);
    });

    // Find time range
    const timestamps = batch
        .map(e => typeof e === 'object' ? (e.t || '') : '')
        .filter(t => t.includes('Day'));
    const timeRange = timestamps.length >= 2
        ? `${timestamps[0]} to ${timestamps[timestamps.length - 1]}`
        : timestamps[0] || '';

    // Truncate each entry to ~80 chars and join
    const compressed = texts
        .map(t => t.length > 80 ? t.substring(0, 77) + '...' : t)
        .join(' | ');

    // Cap total at ~500 chars
    const finalText = compressed.length > 500
        ? compressed.substring(0, 497) + '...'
        : compressed;

    const condensedText = `[CONDENSED: ${label}${timeRange ? ` ${timeRange}` : ''}, ${batch.length} entries] ${finalText}`;

    // Return in the same format as the source entries
    if (typeof batch[0] === 'object') {
        return { text: condensedText, t: timeRange, _ts: new Date().toISOString(), _condensed: true };
    }
    return condensedText;
}

// ─── Cold Storage ───────────────────────────────────────────────────────────

function getColdStorage() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata['gravity_cold']) {
        chatMetadata['gravity_cold'] = {
            summaries: [],
            timeline: [],
            traits: [],
            moments: {},       // keyed by char id
            consolidated: [],  // compressed batch summaries
        };
    }
    return chatMetadata['gravity_cold'];
}

/**
 * Check if any tiered array exceeds its hot cap.
 * If so, move the oldest batch to cold storage and flag for consolidation.
 * @param {Object} state - current computed state
 * @returns {{ needsConsolidation: boolean, pendingBatches: Array }}
 */
function checkAndRotate(state) {
    const cold = getColdStorage();
    const pendingBatches = [];

    for (const [key, cfg] of Object.entries(TIER_CONFIG)) {
        const arr = cfg.getArray(state);
        if (arr.length <= cfg.hotCap) continue;

        const overflow = arr.length - cfg.hotCap;
        const batchCount = Math.ceil(overflow / cfg.batchSize);

        for (let b = 0; b < batchCount; b++) {
            const start = b * cfg.batchSize;
            const end = Math.min(start + cfg.batchSize, overflow);
            const batch = arr.slice(start, end);

            if (batch.length === 0) continue;

            // Move originals to cold storage
            const coldKey = key === 'story_summary' ? 'summaries'
                : key === 'pc_timeline' ? 'timeline'
                : key === 'pc_traits' ? 'traits'
                : 'summaries';
            cold[coldKey].push(...batch);

            // Extension-side consolidation: compress batch into one summary entry
            // that stays in hot as a bridge — memories never just vanish
            const condensed = condenseBatch(batch, cfg.label);
            if (condensed) {
                // Insert the consolidated entry at the beginning of the array
                // (oldest position in hot = these are deep history)
                arr.splice(start, 0, condensed);
            }

            pendingBatches.push({
                key,
                label: cfg.label,
                entries: batch,
                count: batch.length,
                condensed,
            });
        }

        console.log(`${LOG_PREFIX} Rotated ${overflow} entries from ${cfg.label} to cold storage, kept condensed summaries in hot.`);
    }

    // key_moments are PERMANENT — never rotated, never trimmed.
    // They are the character's lived history and must not be stripped.

    if (pendingBatches.length > 0) {
        const { saveMetadata } = SillyTavern.getContext();
        saveMetadata();
    }

    return {
        needsConsolidation: pendingBatches.length > 0,
        pendingBatches,
    };
}

/**
 * Build the consolidation prompt for the LLM to summarize a cold batch.
 * @param {Array} pendingBatches
 * @returns {string}
 */
function buildConsolidationPrompt(pendingBatches) {
    const parts = ['[MEMORY CONSOLIDATION — Older entries have been archived. Summarize each batch into ONE consolidated entry (3-5 sentences, preserving key details and emotional texture).\n'];

    for (const batch of pendingBatches) {
        const entries = batch.entries.map(e => {
            if (typeof e === 'object') return e.text || e.t || JSON.stringify(e);
            return String(e);
        });
        parts.push(`BATCH: ${batch.label} (${batch.count} entries)`);
        parts.push(entries.map(e => `  - ${e}`).join('\n'));
        parts.push(`→ APPEND summary field with a 3-5 sentence consolidated summary of the above. Tag it: "[CONSOLIDATED: ${batch.label}]"\n`);
    }

    parts.push('Write the consolidated summaries in your ledger block. The original detailed entries are archived and will not be injected again.]');
    return parts.join('\n');
}

/**
 * Get the hot (visible) portion of a tiered array.
 * Returns: { hot: Array, consolidated: Array }
 * @param {string} key - tier config key
 * @param {Object} state - current state
 * @returns {{ hot: Array, consolidated: Array }}
 */
function getHotView(key, state) {
    const cfg = TIER_CONFIG[key];
    if (!cfg) return { hot: [], consolidated: [] };

    const arr = cfg.getArray(state);
    const hot = arr.slice(-cfg.hotCap);

    // Find consolidated entries (tagged with [CONSOLIDATED:])
    const consolidated = hot.filter(e => {
        const text = typeof e === 'object' ? (e.text || '') : String(e);
        return text.includes('[CONSOLIDATED:');
    });

    return { hot, consolidated };
}

/**
 * Get ALL key_moments for a character — these are permanent, never trimmed.
 * @param {Object} char
 * @returns {Array}
 */
function getAllMoments(char) {
    return Array.isArray(char.key_moments) ? char.key_moments : [];
}

/**
 * Get cold storage stats for the UI panel.
 * @returns {Object}
 */
function getColdStats() {
    const cold = getColdStorage();
    return {
        summaries: cold.summaries.length,
        timeline: cold.timeline.length,
        traits: cold.traits.length,
        moments: Object.values(cold.moments).reduce((sum, arr) => sum + arr.length, 0),
        total: cold.summaries.length + cold.timeline.length + cold.traits.length +
            Object.values(cold.moments).reduce((sum, arr) => sum + arr.length, 0),
    };
}

export {
    checkAndRotate,
    buildConsolidationPrompt,
    getHotView,
    getAllMoments,
    getColdStats,
    getColdStorage,
    TIER_CONFIG,
};
