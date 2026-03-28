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
    const parts = [`[ARC SUMMARY NEEDED — The following timeline entries have been archived.
Your job: write ONE arc summary per batch that REPLACES these entries in the LLM's memory.
This is NOT a log. It's a compressed narrative arc — the story of what happened across these beats.

Each arc summary MUST include (8-12 sentences):
1. The arc's shape: what started, what built, what broke or resolved
2. Relationship movements: who got closer, who pulled away, what trust was earned or spent
3. Constraint events: which constraints were tested, what held, what cracked
4. Collision history: what tensions drove this arc, what detonated, what spawned
5. The emotional trajectory: how the characters FELT across this arc, not just what they did
6. 2-3 specific moments that carry the arc's weight — physical details, exact words, gestures
7. What this arc left behind: unresolved threads, changed dynamics, new shapes

Tag: "[ARC: timerange]"
This arc summary is the ONLY record of these events the LLM will see. Make it count.\n`];

    for (const batch of pendingBatches) {
        const entries = batch.entries.map(e => {
            if (typeof e === 'object') return e.text || e.t || JSON.stringify(e);
            return String(e);
        });
        parts.push(`ARCHIVED ENTRIES: ${batch.label} (${batch.count} entries)`);
        parts.push(entries.map(e => `  - ${e}`).join('\n'));
        parts.push(`→ APPEND summary value="[ARC: timerange] your 8-12 sentence arc summary here"\n`);
    }

    parts.push('Write the arc summary ALONGSIDE your normal prose and ledger updates.]');
    return parts.join('\n');
}

/**
 * Get the hot (visible) portion of a tiered array.
 * Returns: { hot: Array, arcs: Array }
 * @param {string} key - tier config key
 * @param {Object} state - current state
 * @returns {{ hot: Array, arcs: Array }}
 */
function getHotView(key, state) {
    const cfg = TIER_CONFIG[key];
    if (!cfg) return { hot: [], arcs: [] };

    const arr = cfg.getArray(state);
    const hot = arr.slice(-cfg.hotCap);

    // Find arc summary entries (tagged with [ARC:] or legacy [CONSOLIDATED:])
    const consolidated = hot.filter(e => {
        const text = typeof e === 'object' ? (e.text || '') : String(e);
        return text.includes('[ARC:') || text.includes('[CONSOLIDATED:');
    });

    return { hot, arcs };
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
