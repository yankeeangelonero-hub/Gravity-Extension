/**
 * state-compute.js — Derive current state from transactions.
 *
 * Full Gravity v10 state model with field-level change history.
 * Every mutable field tracks its transitions with timestamps.
 */

/**
 * @typedef {Object} ComputedState
 * @property {Object<string, Object>} characters
 * @property {Object<string, Object>} constraints
 * @property {Object<string, Object>} collisions
 * @property {Object<string, Object>} combats
 * @property {Object<string, Object>} chapters
 * @property {Object<string, Object>} factions
 * @property {Object} world
 * @property {Object} pc
 * @property {Object} divination
 * @property {Array} story_summary
 * @property {number} lastTxId
 * @property {Object} _history - field change history per entity
 */

/**
 * Simple string similarity (Dice coefficient on bigrams).
 * Returns 0.0–1.0. Used for duplicate APPEND detection.
 */
function stringSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const lower = s => s.toLowerCase().trim();
    const bigrams = s => {
        const set = new Map();
        const str = lower(s);
        for (let i = 0; i < str.length - 1; i++) {
            const bi = str.substring(i, i + 2);
            set.set(bi, (set.get(bi) || 0) + 1);
        }
        return set;
    };
    const aBi = bigrams(a);
    const bBi = bigrams(b);
    let intersection = 0;
    for (const [bi, count] of aBi) {
        intersection += Math.min(count, bBi.get(bi) || 0);
    }
    return (2 * intersection) / (a.length - 1 + b.length - 1);
}

function createEmptyState() {
    return {
        characters: {},
        constraints: {},
        collisions: {},
        combats: {},
        chapters: {},
        factions: {},
        world: {
            world_state: '',
            pressure_points: [],
            constants: {},
        },
        pc: {
            name: '',
            demonstrated_traits: [],
            current_scene: '',
        },
        divination: {
            active_system: '',  // 'classic', 'arcana', 'iching'
            last_draw: null,    // { value, reading, timestamp }
            readings: [],       // history of all draws
        },
        story_summary: [],  // append-only: [{ text, timestamp, chapter }]
        lastTxId: -1,
        _history: {},  // { "entity:id:field": [{ from, to, t, tx }] }
    };
}

function normalizeCharacterKnowledgeAsymmetry(state) {
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;
        if (char.knowledge_asymmetry === undefined || char.knowledge_asymmetry === null) {
            char.knowledge_asymmetry = '';
        }
    }
}

function getCollectionName(entityType) {
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        combat: 'combats',
        chapter: 'chapters',
        faction: 'factions',
        world: 'world',
        pc: 'pc',
        divination: 'divination',
        summary: 'story_summary',
    };
    return map[entityType] || entityType;
}

/**
 * Record a field change in the history tracker.
 */
function recordHistory(state, entityType, entityId, field, from, to, tx) {
    const key = `${entityType}:${entityId || '_'}:${field}`;
    if (!state._history[key]) state._history[key] = [];
    state._history[key].push({
        from,
        to,
        t: tx.t || '',
        _ts: tx._ts || '',
        tx: tx.tx,
        r: tx.r || '',
    });
}

/**
 * Get change history for a specific entity field.
 */
function getFieldHistory(state, entityType, entityId, field) {
    const key = `${entityType}:${entityId || '_'}:${field}`;
    return state._history[key] || [];
}

function getArrayFieldHistory(state, entityType, entityId, field) {
    return getFieldHistory(state, entityType, entityId, `${field}[]`);
}

function toComparableArrayValue(value) {
    return typeof value === 'string'
        ? value.replace(/\s+/g, ' ').trim().toLowerCase()
        : JSON.stringify(value);
}

function getArrayItemHistory(state, entityType, entityId, field, value) {
    const target = toComparableArrayValue(value);
    return getArrayFieldHistory(state, entityType, entityId, field).filter(entry =>
        toComparableArrayValue(entry.to !== undefined ? entry.to : entry.from) === target
    );
}

/**
 * Get all history for an entity.
 */
function getEntityHistory(state, entityType, entityId) {
    const prefix = `${entityType}:${entityId || '_'}:`;
    const result = {};
    for (const [key, entries] of Object.entries(state._history)) {
        if (key.startsWith(prefix)) {
            const field = key.substring(prefix.length);
            result[field] = entries;
        }
    }
    return result;
}

/**
 * Apply a single transaction to the state.
 */
function applyTransaction(state, tx) {
    const collection = getCollectionName(tx.e);
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);
    const isSummary = tx.e === 'summary';

    // Handle summary as a special append-only entity
    if (isSummary && tx.op === 'A') {
        state.story_summary.push({
            text: tx.d.v || tx.d.value || tx.d.text || '',
            chapter: tx.d.chapter || '',
            t: tx.t || '',
            _ts: tx._ts || '',
        });
        state.lastTxId = tx.tx;
        return state;
    }

    switch (tx.op) {
        case 'CR': {
            if (isSingleton) {
                Object.assign(state[collection], tx.d);
            } else {
                const data = { id: tx.id, ...tx.d };
                // Backward compat: normalize legacy CRASHED status on creation
                if (tx.e === 'collision' && typeof data.status === 'string' &&
                    data.status.trim().toUpperCase() === 'CRASHED') {
                    data.status = 'RESOLVED';
                    if (!data.outcome_type) data.outcome_type = 'CRASHED';
                }
                state[collection][tx.id] = data;
            }
            break;
        }

        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                let newTo = tx.d.to;
                // Backward compat: normalize MOVE collision status CRASHED → RESOLVED
                if (tx.e === 'collision' && tx.d.f === 'status' &&
                    typeof newTo === 'string' && newTo.trim().toUpperCase() === 'CRASHED') {
                    newTo = 'RESOLVED';
                    if (!target.outcome_type) target.outcome_type = 'CRASHED';
                }
                const oldVal = target[tx.d.f];
                target[tx.d.f] = newTo;
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, newTo, tx);
            }
            break;
        }

        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                let newVal = tx.d.v;
                // Backward compat: normalize SET collision status CRASHED → RESOLVED
                if (tx.e === 'collision' && tx.d.f === 'status' &&
                    typeof newVal === 'string' && newVal.trim().toUpperCase() === 'CRASHED') {
                    newVal = 'RESOLVED';
                    if (!target.outcome_type) target.outcome_type = 'CRASHED';
                }
                const oldVal = target[tx.d.f];
                target[tx.d.f] = newVal;
                if (oldVal !== newVal) {
                    recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, newVal, tx);
                }
            }
            break;
        }

        case 'A': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (!Array.isArray(target[tx.d.f])) target[tx.d.f] = [];
                // Duplicate detection — reject appends >80% similar to existing entry
                const newVal = typeof tx.d.v === 'string' ? tx.d.v : JSON.stringify(tx.d.v);
                const isDuplicate = target[tx.d.f].some(existing => {
                    const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing);
                    return stringSimilarity(existingStr, newVal) > 0.8;
                });
                if (!isDuplicate) {
                    target[tx.d.f].push(tx.d.v);
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}[]`, undefined, tx.d.v, tx);
                }
            }
            break;
        }

        case 'R': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f && Array.isArray(target[tx.d.f])) {
                const beforeLength = target[tx.d.f].length;
                target[tx.d.f] = target[tx.d.f].filter(item =>
                    typeof item === 'string' ? item !== tx.d.v : JSON.stringify(item) !== JSON.stringify(tx.d.v)
                );
                if (target[tx.d.f].length !== beforeLength) {
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}[]`, tx.d.v, undefined, tx);
                }
            }
            break;
        }

        case 'MS': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (typeof target[tx.d.f] !== 'object' || Array.isArray(target[tx.d.f])) {
                    target[tx.d.f] = {};
                }
                const oldVal = target[tx.d.f][tx.d.k];
                target[tx.d.f][tx.d.k] = tx.d.v;
                if (oldVal !== tx.d.v) {
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, tx.d.v, tx);
                }
            }
            break;
        }

        case 'MR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f && typeof target[tx.d.f] === 'object') {
                const oldVal = target[tx.d.f][tx.d.k];
                delete target[tx.d.f][tx.d.k];
                recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, undefined, tx);
            }
            break;
        }

        case 'D': {
            if (!isSingleton) {
                delete state[collection][tx.id];
            }
            break;
        }

        case 'AMEND':
            break;

        default:
            break;
    }

    state.lastTxId = tx.tx;
    return state;
}

/**
 * Compute full state from a snapshot plus transactions.
 */
function computeState(snapshot, transactions) {
    const state = snapshot ? structuredClone(snapshot) : createEmptyState();

    // Ensure _history exists (may be missing from old snapshots)
    if (!state._history) state._history = {};
    if (!state.factions) state.factions = {};
    if (!state.divination) state.divination = { active_system: '', last_draw: null, readings: [] };
    if (!state.story_summary) state.story_summary = [];

    // First pass: collect amendments
    const amendments = new Map();
    for (const tx of transactions) {
        if (tx.op === 'AMEND' && tx.d?.target_tx != null && tx.d?.correction) {
            amendments.set(tx.d.target_tx, tx.d.correction);
        }
    }

    // Second pass: apply
    for (const tx of transactions) {
        if (tx.op === 'SNAP' || tx.op === 'ROLL' || tx.op === 'AMEND') continue;

        if (amendments.has(tx.tx)) {
            applyTransaction(state, { ...amendments.get(tx.tx), tx: tx.tx });
        } else {
            applyTransaction(state, tx);
        }
    }

    normalizeCharacterKnowledgeAsymmetry(state);

    return state;
}

function diffStates(before, after) {
    const changes = [];
    for (const col of ['characters', 'constraints', 'collisions', 'chapters', 'factions']) {
        const bc = before[col] || {};
        const ac = after[col] || {};
        for (const id of Object.keys(ac)) {
            if (!bc[id]) { changes.push({ entity: col, id, type: 'created', data: ac[id] }); continue; }
            for (const field of new Set([...Object.keys(bc[id]), ...Object.keys(ac[id])])) {
                if (JSON.stringify(bc[id][field]) !== JSON.stringify(ac[id][field])) {
                    changes.push({ entity: col, id, type: 'changed', field, from: bc[id][field], to: ac[id][field] });
                }
            }
        }
        for (const id of Object.keys(bc)) {
            if (!ac[id]) changes.push({ entity: col, id, type: 'deleted' });
        }
    }
    for (const s of ['world', 'pc', 'divination']) {
        for (const field of new Set([...Object.keys(before[s] || {}), ...Object.keys(after[s] || {})])) {
            if (JSON.stringify((before[s] || {})[field]) !== JSON.stringify((after[s] || {})[field])) {
                changes.push({ entity: s, id: s, type: 'changed', field, from: (before[s] || {})[field], to: (after[s] || {})[field] });
            }
        }
    }
    return changes;
}

function getPhonebook(state) {
    const result = { principal: null, tracked: [], known: [] };
    for (const char of Object.values(state.characters)) {
        switch (char.tier) {
            case 'PRINCIPAL': result.principal = char.name || char.id; break;
            case 'TRACKED': result.tracked.push(char.name || char.id); break;
            case 'KNOWN': result.known.push(char.name || char.id); break;
        }
    }
    return result;
}

export {
    createEmptyState,
    applyTransaction,
    computeState,
    diffStates,
    getPhonebook,
    getCollectionName,
    getFieldHistory,
    getArrayFieldHistory,
    getArrayItemHistory,
    getEntityHistory,
};
