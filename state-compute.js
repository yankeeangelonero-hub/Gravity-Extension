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
 * @property {Object<string, Object>} chapters
 * @property {Object<string, Object>} factions
 * @property {Object} world
 * @property {Object} pc
 * @property {Object} divination
 * @property {Array} story_summary
 * @property {number} lastTxId
 * @property {Object} _history - field change history per entity
 */

function createEmptyState() {
    return {
        characters: {},
        constraints: {},
        collisions: {},
        chapters: {},
        factions: {},
        world: {
            world_state: '',
            pressure_points: [],
            constants: {},
            knowledge_asymmetry: {},
        },
        pc: {
            name: '',
            demonstrated_traits: [],
            reputation: {},
            timeline: [],
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

function getCollectionName(entityType) {
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
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
                state[collection][tx.id] = { id: tx.id, ...tx.d };
            }
            break;
        }

        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                target[tx.d.f] = tx.d.to;
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, tx.d.to, tx);
            }
            break;
        }

        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                target[tx.d.f] = tx.d.v;
                if (oldVal !== tx.d.v) {
                    recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, tx.d.v, tx);
                }
            }
            break;
        }

        case 'A': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (!Array.isArray(target[tx.d.f])) target[tx.d.f] = [];
                target[tx.d.f].push(tx.d.v);
            }
            break;
        }

        case 'R': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f && Array.isArray(target[tx.d.f])) {
                target[tx.d.f] = target[tx.d.f].filter(item =>
                    typeof item === 'string' ? item !== tx.d.v : JSON.stringify(item) !== JSON.stringify(tx.d.v)
                );
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
    getEntityHistory,
};
