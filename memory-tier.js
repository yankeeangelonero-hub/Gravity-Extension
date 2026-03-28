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
// No auto-condensation. The main LLM writes consolidated summaries as part
// of its normal response when prompted by buildConsolidationPrompt().

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

            pendingBatches.push({
                key,
                label: cfg.label,
                entries: batch,
                count: batch.length,
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
    const parts = [`[MEMORY CONSOLIDATION — The following entries have been archived to cold storage.
Your job: write ONE consolidated summary per batch (3-5 sentences) that preserves:
- Key events and turning points
- Emotional texture and character dynamics
- Specific details that make moments recoverable (not generic)
Tag each: "[CONSOLIDATED: label]"
APPEND to summary in your ledger block. These replace the archived entries in the LLM's memory.\n`];

    for (const batch of pendingBatches) {
        const entries = batch.entries.map(e => {
            if (typeof e === 'object') return e.text || e.t || JSON.stringify(e);
            return String(e);
        });
        parts.push(`ARCHIVED BATCH: ${batch.label} (${batch.count} entries)`);
        parts.push(entries.map(e => `  - ${e}`).join('\n'));
        parts.push(`→ APPEND summary value="[CONSOLIDATED: ${batch.label}] your 3-5 sentence summary here"\n`);
    }

    parts.push('Do this ALONGSIDE your normal prose and ledger updates — it does not replace them.]');
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
