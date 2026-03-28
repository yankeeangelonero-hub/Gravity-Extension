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

            // Move to cold storage
            const coldKey = key === 'story_summary' ? 'summaries'
                : key === 'pc_timeline' ? 'timeline'
                : key === 'pc_traits' ? 'traits'
                : 'summaries';
            cold[coldKey].push(...batch);

            pendingBatches.push({
                key,
                label: cfg.label,
                entries: batch,
                count: batch.length,
            });
        }

        console.log(`${LOG_PREFIX} Rotated ${overflow} entries from ${cfg.label} to cold storage.`);
    }

    // Also check per-character key_moments
    for (const [charId, char] of Object.entries(state.characters || {})) {
        const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
        const charCap = 10;
        if (moments.length > charCap) {
            const overflow = moments.length - charCap;
            const batch = moments.slice(0, overflow);
            if (!cold.moments[charId]) cold.moments[charId] = [];
            cold.moments[charId].push(...batch);
            pendingBatches.push({
                key: `char_moments_${charId}`,
                label: `${char.name || charId}.key_moments`,
                entries: batch,
                count: batch.length,
            });
            console.log(`${LOG_PREFIX} Rotated ${overflow} key_moments from ${char.name || charId} to cold.`);
        }
    }

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
 * Get hot view for a character's key_moments.
 * @param {Object} char
 * @returns {Array}
 */
function getHotMoments(char) {
    const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
    return moments.slice(-10);
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
    getHotMoments,
    getColdStats,
    getColdStorage,
    TIER_CONFIG,
};
