/**
 * state-compute.js — Derive current state from transactions.
 *
 * Full Gravity v10 state model with field-level change history.
 * Every mutable field tracks its transitions with timestamps.
 */

// NOTE: spec §2 uses state.chars as shorthand; codebase keeps state.characters (D1 decision).
const CATEGORY_DISTANCES = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
const MAX_COLLISION_ARCHIVE = 20;
const CHARACTER_TAGS_MAX = 5;

/**
 * @typedef {Object} ComputedState
 * @property {Object<string, Object>} characters
 * @property {Object<string, Object>} constraints
 * @property {Object<string, Object>} collisions
 * @property {Object<string, Object>} combats
 * @property {Object<string, Object>} factions
 * @property {Object} world
 * @property {Object} pc
 * @property {Object} divination
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
        factions: {},
        places: {},
        pressures: {},
        relationships: {},
        world: {
            world_state: '',
            collision_archive: [],
        },
        pc: {
            name: '',
            demonstrated_traits: [],
            current_scene: '',
            current_place_id: '',
            scene_cast: [],
        },
        divination: {
            active_system: 'arcana',
            last_draw: null,    // { value, reading, timestamp }
            readings: [],       // history of all draws
        },
        lastTxId: -1,
        _history: {},  // { "entity:id:field": [{ from, to, t, tx }] }
    };
}

function coerceStringifiedArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const m = trimmed.match(/^\[(.*)\]$/s);
    if (m) {
        const inner = m[1].trim();
        if (!inner) return [];
        return inner.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (trimmed) return [trimmed];
    return [];
}

function normalizeArrayFields(state) {
    for (const c of Object.values(state.collisions || {})) {
        for (const f of ['involved_chars', 'parent_collision_ids', 'successor_collision_ids']) {
            if (c[f] !== undefined && c[f] !== null) {
                const coerced = coerceStringifiedArray(c[f]);
                if (coerced !== null) c[f] = coerced;
            }
        }
    }
    for (const p of Object.values(state.pressures || {})) {
        if (p.related_to !== undefined && p.related_to !== null) {
            const coerced = coerceStringifiedArray(p.related_to);
            if (coerced !== null) p.related_to = coerced;
        }
    }
    for (const f of Object.values(state.factions || {})) {
        for (const fld of ['members', 'territory']) {
            if (f[fld] !== undefined && f[fld] !== null) {
                const coerced = coerceStringifiedArray(f[fld]);
                if (coerced !== null) f[fld] = coerced;
            }
        }
    }
}

function normalizeCharacterKnowledgeAsymmetry(state) {
    const STRUCTURAL_KEYS = ['knows', 'unknown', 'hiding', 'misreading'];
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;
        let ka = char.knowledge_asymmetry;
        if (ka === undefined || ka === null || ka === '') {
            char.knowledge_asymmetry = {};
            ka = char.knowledge_asymmetry;
        } else if (typeof ka === 'string') {
            char.knowledge_asymmetry = { legacy: ka };
            ka = char.knowledge_asymmetry;
        } else if (typeof ka !== 'object' || Array.isArray(ka)) {
            char.knowledge_asymmetry = {};
            ka = char.knowledge_asymmetry;
        }
        if (char.last_seen_at === undefined || char.last_seen_at === null) {
            char.last_seen_at = '';
        }

        for (const bucket of STRUCTURAL_KEYS) {
            const sub = ka[bucket];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
                delete ka[bucket];
                continue;
            }
            for (const [k, v] of Object.entries(sub)) {
                if (typeof v !== 'string' || !v.trim()) continue;
                const flatKey = `${bucket}_${k}`;
                if (ka[flatKey] === undefined) ka[flatKey] = v.trim();
            }
            delete ka[bucket];
        }

        if (char.reads && typeof char.reads === 'object' && !Array.isArray(char.reads)) {
            for (const [k, v] of Object.entries(char.reads)) {
                let str = '';
                if (typeof v === 'string') {
                    str = v.trim();
                } else if (Array.isArray(v) && v.length) {
                    str = String(v[v.length - 1]).trim();
                }
                if (!str) continue;
                const flatKey = `reads_${k}`;
                if (ka[flatKey] === undefined) ka[flatKey] = str;
            }
        }
        delete char.reads;

        const flatKeys = Object.keys(ka).filter(k => k !== 'legacy' && typeof ka[k] === 'string');
        if (flatKeys.length > 20) {
            for (const k of flatKeys.slice(20)) delete ka[k];
        }
    }
}

// Phase 2: faction shape is name/members/territory/state/agenda/knowledge_asymmetry.
// Anything else written by legacy chats must migrate INTO knowledge_asymmetry and then
// be dropped from the faction entity — `intel_on`, `blindspots`, `false_beliefs`,
// `comms_latency`, `last_verified_at`, `intel_posture`, `reads`, `stance_toward_pc`,
// `power`, `momentum`, `leverage`, `vulnerability`, `last_move`, `objective`, `resources`,
// `relations` are all removed at load time.
function migrateFactionToPhase2(state) {
    const LEGACY_FACTION_FIELDS = [
        'comms_latency', 'last_verified_at', 'intel_posture', 'reads',
        'stance_toward_pc', 'power', 'momentum', 'leverage', 'vulnerability',
        'last_move', 'objective', 'resources', 'relations', 'doctrine', 'leadership',
        'alliances', 'profile',
    ];

    for (const faction of Object.values(state.factions || {})) {
        if (!faction.knowledge_asymmetry || typeof faction.knowledge_asymmetry !== 'object' || Array.isArray(faction.knowledge_asymmetry)) {
            faction.knowledge_asymmetry = {};
        }
        const ka = faction.knowledge_asymmetry;
        const setKaKey = (key, value) => {
            if (typeof value !== 'string' || !value.trim()) return;
            if (!ka[key]) ka[key] = value.trim();
        };

        // Migrate intel_on (nested subject → {knows, unknown, hiding, misreading}) into flat keys.
        if (faction.intel_on && typeof faction.intel_on === 'object' && !Array.isArray(faction.intel_on)) {
            for (const [subject, si] of Object.entries(faction.intel_on)) {
                if (typeof si === 'string') {
                    setKaKey(`knows_${subject}`, si);
                    continue;
                }
                if (!si || typeof si !== 'object') continue;
                for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                    const map = si[bucket];
                    if (!map || typeof map !== 'object') continue;
                    for (const [k, v] of Object.entries(map)) {
                        if (typeof v !== 'string' || !v.trim()) continue;
                        const flatKey = k === 'legacy' ? `${bucket}_${subject}` : `${bucket}_${subject}_${k}`;
                        setKaKey(flatKey, v);
                    }
                }
            }
        }
        delete faction.intel_on;

        // Migrate false_beliefs (map: subject → belief) into misreading_<subject>.
        if (faction.false_beliefs && typeof faction.false_beliefs === 'object' && !Array.isArray(faction.false_beliefs)) {
            for (const [subject, belief] of Object.entries(faction.false_beliefs)) {
                setKaKey(`misreading_${subject}`, belief);
            }
        }
        delete faction.false_beliefs;

        // Migrate blindspots (string or map) into unknown_<subject> or a rollup legacy key.
        if (typeof faction.blindspots === 'string') {
            setKaKey('legacy', faction.blindspots);
        } else if (faction.blindspots && typeof faction.blindspots === 'object' && !Array.isArray(faction.blindspots)) {
            for (const [subject, gap] of Object.entries(faction.blindspots)) {
                setKaKey(`unknown_${subject}`, gap);
            }
        }
        delete faction.blindspots;
        delete faction.blindspots_legacy;

        // Drop all remaining banned fields.
        for (const field of LEGACY_FACTION_FIELDS) {
            delete faction[field];
        }

        // Bug 1: flatten pre-existing nested buckets in faction.knowledge_asymmetry (same as char path).
        const STRUCTURAL_KEYS = ['knows', 'unknown', 'hiding', 'misreading'];
        for (const bucket of STRUCTURAL_KEYS) {
            const sub = ka[bucket];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
                delete ka[bucket];
                continue;
            }
            for (const [k, v] of Object.entries(sub)) {
                if (typeof v !== 'string' || !v.trim()) continue;
                const flatKey = `${bucket}_${k}`;
                if (ka[flatKey] === undefined) ka[flatKey] = v.trim();
            }
            delete ka[bucket];
        }

        // Cap flat KA at 20 entries (L4 §2.3). Oldest keys win insertion order; drop excess.
        const kaKeys = Object.keys(ka);
        if (kaKeys.length > 20) {
            for (const k of kaKeys.slice(20)) delete ka[k];
        }
    }
}

function getCollectionName(entityType) {
    // NOTE: spec uses state.chars/state.places but codebase keeps state.characters/state.places.
    // 'chars' → 'characters' is intentional; see decision D1.
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        combat: 'combats',
        faction: 'factions',
        place: 'places',
        pressure: 'pressures',
        world: 'world',
        pc: 'pc',
        divination: 'divination',
        relationship: 'relationships',
    };
    return map[entityType] || entityType;
}

// Aliases the LLM has used instead of canonical constraint field names.
const CONSTRAINT_FIELD_ALIASES = {
    description: 'profile',
    shed: 'shedding_order',
};

/**
 * Normalize aliased field names in a constraint field-bag (CR d object).
 * Converts: description→profile, shed→shedding_order, char→owner_id (strips char: prefix).
 */
function normalizeConstraintFields(fields) {
    if (!fields || typeof fields !== 'object') return fields;
    const out = { ...fields };
    for (const [alias, canonical] of Object.entries(CONSTRAINT_FIELD_ALIASES)) {
        if (out[alias] !== undefined && out[canonical] === undefined) {
            out[canonical] = out[alias];
        }
        delete out[alias];
    }
    if (out.char !== undefined && out.owner_id === undefined) {
        out.owner_id = out.char;
    }
    delete out.char;
    if (typeof out.owner_id === 'string' && out.owner_id.startsWith('char:')) {
        out.owner_id = out.owner_id.slice('char:'.length);
    }
    return out;
}

/**
 * Normalize a single constraint field name + value (for S transactions).
 * Returns { field, value } with canonical names applied.
 */
function normalizeConstraintSField(field, value) {
    // Simple alias map
    if (CONSTRAINT_FIELD_ALIASES[field] !== undefined) {
        return { field: CONSTRAINT_FIELD_ALIASES[field], value };
    }
    // char → owner_id with char: prefix stripping
    if (field === 'char') {
        const v = (typeof value === 'string' && value.startsWith('char:'))
            ? value.slice('char:'.length)
            : value;
        return { field: 'owner_id', value: v };
    }
    // owner_id value may still carry the char: prefix even on a canonical-named S
    if (field === 'owner_id' && typeof value === 'string' && value.startsWith('char:')) {
        return { field: 'owner_id', value: value.slice('char:'.length) };
    }
    return { field, value };
}

// Aliases the LLM has used instead of canonical character field names.
const CHARACTER_FIELD_ALIASES = {
    want: 'agenda',
};

// Phase 2 character fields with no canonical replacement — drop unconditionally.
// `doing` and `cost` duplicate prose context (removed per ledger-scope-reduction).
// `stance_toward_pc` migrated to knowledge_asymmetry.{knows,hiding,misreading}_pc,
// a structural change that cannot be expressed as a simple rename.
const CHARACTER_DEPRECATED_FIELDS = ['doing', 'stance_toward_pc', 'cost'];

/**
 * Normalize aliased field names in a character field-bag (CR d object).
 * Converts: want→agenda. Drops: doing, stance_toward_pc, cost.
 */
function normalizeCharacterFields(fields) {
    if (!fields || typeof fields !== 'object') return fields;
    const out = { ...fields };
    for (const [alias, canonical] of Object.entries(CHARACTER_FIELD_ALIASES)) {
        if (out[alias] !== undefined && out[canonical] === undefined) {
            out[canonical] = out[alias];
        }
        delete out[alias];
    }
    for (const dep of CHARACTER_DEPRECATED_FIELDS) {
        delete out[dep];
    }
    return out;
}

/**
 * Normalize a single character field name + value (for S transactions).
 * Returns { field, value } with canonical names applied. Returns field=null
 * to signal a deprecated field whose S should be skipped entirely.
 */
function normalizeCharacterSField(field, value) {
    if (CHARACTER_FIELD_ALIASES[field] !== undefined) {
        return { field: CHARACTER_FIELD_ALIASES[field], value };
    }
    if (CHARACTER_DEPRECATED_FIELDS.includes(field)) {
        return { field: null, value };
    }
    return { field, value };
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

function adjustRelationshipStatus(state, entityType, entityId, newStatus) {
    if (entityType !== 'char' && entityType !== 'faction') return;
    const relId = `pc-${entityId}`;
    const rel = state.relationships?.[relId];
    if (!rel) return;
    if (rel.status === newStatus) return;
    rel.status = newStatus;
}

/**
 * Apply a single transaction to the state.
 */
function applyTransaction(state, tx) {
    const collection = getCollectionName(tx.e);
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);

    // Silently drop legacy transactions on replay of old chats
    if (tx.e === 'summary' || tx.e === 'chapter') {
        state.lastTxId = tx.tx;
        return state;
    }

    // Silently drop old world.pressure_points array ops (replaced by pressure:<id> entities)
    if (tx.e === 'world' && (tx.op === 'A' || tx.op === 'R') && tx.d?.f === 'pressure_points') {
        state.lastTxId = tx.tx;
        return state;
    }

    // Phase 2: legacy collision statuses migrate to ACTIVE (SEEDED/SIMMERING/RESOLVING were
    // removed from the state machine; chats containing them must still replay cleanly).
    const migrateCollisionStatus = (val) => {
        if (val === 'SEEDED' || val === 'SIMMERING' || val === 'RESOLVING') return 'ACTIVE';
        return val;
    };

    switch (tx.op) {
        case 'CR': {
            if (isSingleton) {
                Object.assign(state[collection], tx.d);
            } else {
                let rawD = tx.d;
                if (tx.e === 'constraint') rawD = normalizeConstraintFields(tx.d);
                else if (tx.e === 'char') rawD = normalizeCharacterFields(tx.d);
                const data = { id: tx.id, ...rawD };
                // Normalize place defaults
                if (tx.e === 'place') {
                    if (!data.reach) data.reach = 'LOCAL';
                    if (!data.state) data.state = 'unknown';
                }
                // Pressure entity: engine stamps created_at_tx from tx.tx (LLM-supplied value overwritten)
                if (tx.e === 'pressure') {
                    data.created_at_tx = tx.tx;
                }
                if (tx.e === 'relationship') {
                    if (!('last_shift' in data)) data.last_shift = null;
                    if (!data.status) data.status = 'active';
                }
                if (tx.e === 'faction') {
                    if (!data.tier) data.tier = 'KNOWN';
                }
                if (tx.e === 'char' && Array.isArray(data.tags)) {
                    data.tags = Array.from(new Set(data.tags));
                    if (data.tags.length > CHARACTER_TAGS_MAX) {
                        data.tags = data.tags.slice(0, CHARACTER_TAGS_MAX);
                    }
                }
                // Phase 2: distance_category → canonical starting distance
                if (tx.e === 'collision') {
                    if (data.distance_category) {
                        data.distance = CATEGORY_DISTANCES[data.distance_category] ?? 10;
                    } else {
                        // Old tx without category — default to SHORT
                        data.distance_category = 'SHORT';
                        if (data.distance == null) data.distance = 10;
                    }
                    data.status = migrateCollisionStatus(data.status) || 'ACTIVE';
                }
                state[collection][tx.id] = data;
            }
            break;
        }

        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            // Bug 5: log when target is missing so silent no-ops are observable.
            // TODO: validation should reject missing-target TRs before commit.
            if (!target) { if (tx.tx > 0) console.warn(`[state-compute] TR no-op: entity ${tx.e}:${tx.id} not found (tx ${tx.tx})`); break; }
            if (tx.d.f) {
                const oldVal = target[tx.d.f];
                let toVal = tx.d.to;
                if (tx.e === 'collision' && tx.d.f === 'status') {
                    toVal = migrateCollisionStatus(toVal);
                }
                target[tx.d.f] = toVal;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && tx.d.f === 'status' && toVal === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                // Bug 2: on tier demotion, clear fields no longer allowed at the new tier.
                if (tx.e === 'char' && tx.d.f === 'tier') {
                    const TIER_ORDER = ['UNKNOWN', 'KNOWN', 'TRACKED', 'PRINCIPAL'];
                    const oldTier = TIER_ORDER.indexOf(String(oldVal || '').toUpperCase());
                    const newTier = TIER_ORDER.indexOf(String(toVal || '').toUpperCase());
                    if (newTier < oldTier) {
                        // Drop PRINCIPAL-only fields when demoting below PRINCIPAL
                        if (newTier < TIER_ORDER.indexOf('PRINCIPAL')) {
                            delete target.agenda;
                            delete target.key_moments;
                            // TODO: intimate_history and demonstrated_traits tier gating unclear — revisit
                            // state-view.js renders them only under showIntimacy (mode flag, not tier);
                            // leaving behavior unchanged until spec clarifies PRINCIPAL-only vs TRACKED+.
                        }
                        // Drop location when demoting to UNKNOWN
                        if (newTier <= TIER_ORDER.indexOf('UNKNOWN')) {
                            delete target.location;
                        }
                    }
                }
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, toVal, tx);
                if ((tx.e === 'char' || tx.e === 'faction') && tx.d.f === 'tier') {
                    const TIER_ORDER = ['UNKNOWN', 'KNOWN', 'TRACKED', 'PRINCIPAL'];
                    const fromIdx = TIER_ORDER.indexOf(String(oldVal || '').toUpperCase());
                    const toIdx = TIER_ORDER.indexOf(String(toVal || '').toUpperCase());
                    const trackedIdx = TIER_ORDER.indexOf('TRACKED');
                    if (fromIdx >= trackedIdx && toIdx < trackedIdx) {
                        adjustRelationshipStatus(state, tx.e, tx.id, 'dormant');
                    } else if (fromIdx < trackedIdx && toIdx >= trackedIdx) {
                        adjustRelationshipStatus(state, tx.e, tx.id, 'active');
                    }
                }
            }
            break;
        }

        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            // Bug 5: log when target is missing so silent no-ops are observable.
            // TODO: validation should reject missing-target Ss before commit.
            if (!target) { if (tx.tx > 0) console.warn(`[state-compute] S no-op: entity ${tx.e}:${tx.id} not found (tx ${tx.tx}, field ${tx.d.f})`); break; }
            if (tx.d.f) {
                // Normalize aliased field names on constraint / character S transactions.
                let sNorm;
                if (tx.e === 'constraint') sNorm = normalizeConstraintSField(tx.d.f, tx.d.v);
                else if (tx.e === 'char') sNorm = normalizeCharacterSField(tx.d.f, tx.d.v);
                else sNorm = { field: tx.d.f, value: tx.d.v };
                const { field: sField, value: sVal } = sNorm;
                if (!sField) break; // deprecated character field — drop the S
                const oldVal = target[sField];
                let newVal = sVal;
                if (tx.e === 'collision' && sField === 'status') {
                    newVal = migrateCollisionStatus(newVal);
                }
                // Bug 4(b): coerce null writes to known map-backed fields to empty object.
                // null on map-backed fields is interpreted as "reset to empty map" — distinguishing explicit-clear from never-had-it is not supported
                const MAP_BACKED_FIELDS = ['knowledge_asymmetry', 'intimate_history', 'wounds'];
                if (newVal === null && MAP_BACKED_FIELDS.includes(sField)) newVal = {};
                target[sField] = newVal;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && sField === 'status' && newVal === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                if (tx.e === 'char' && sField === 'tags' && Array.isArray(target.tags)) {
                    target.tags = Array.from(new Set(target.tags));
                    if (target.tags.length > CHARACTER_TAGS_MAX) {
                        target.tags = target.tags.slice(0, CHARACTER_TAGS_MAX);
                    }
                }
                if (oldVal !== newVal) {
                    recordHistory(state, tx.e, tx.id, sField, oldVal, newVal, tx);
                }
            }
            break;
        }

        case 'A': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (!Array.isArray(target[tx.d.f])) target[tx.d.f] = [];
                const newVal = typeof tx.d.v === 'string' ? tx.d.v : JSON.stringify(tx.d.v);
                // Fields where intentional near-duplicate digests are valid — only block exact repeats.
                const exemptFromFuzzy = (
                    (tx.e === 'world' && tx.d.f === 'collision_archive') ||
                    (tx.e === 'char' && (tx.d.f === 'key_moments' || tx.d.f === 'intimate_history' || tx.d.f === 'demonstrated_traits')) ||
                    (tx.e === 'pc' && tx.d.f === 'demonstrated_traits')
                );
                const isDuplicate = target[tx.d.f].some(existing => {
                    const existingStr = typeof existing === 'string' ? existing : JSON.stringify(existing);
                    if (exemptFromFuzzy) return existingStr === newVal;
                    return stringSimilarity(existingStr, newVal) > 0.8;
                });
                if (!isDuplicate) {
                    target[tx.d.f].push(tx.d.v);
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}[]`, undefined, tx.d.v, tx);
                    if (tx.e === 'world' && tx.d.f === 'collision_archive') {
                        const arr = state.world.collision_archive;
                        if (Array.isArray(arr) && arr.length > MAX_COLLISION_ARCHIVE) {
                            state.world.collision_archive = arr.slice(-MAX_COLLISION_ARCHIVE);
                        }
                    }
                    if (tx.e === 'char' && tx.d.f === 'tags' && Array.isArray(target.tags)) {
                        target.tags = Array.from(new Set(target.tags));
                        if (target.tags.length > CHARACTER_TAGS_MAX) {
                            target.tags = target.tags.slice(0, CHARACTER_TAGS_MAX);
                        }
                    }
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
                // Reject legacy reads writes by routing into KA as flat keys.
                if (tx.d.f === 'reads' && tx.e === 'char') {
                    if (!target.knowledge_asymmetry || typeof target.knowledge_asymmetry !== 'object' || Array.isArray(target.knowledge_asymmetry)) {
                        target.knowledge_asymmetry = {};
                    }
                    const flatKey = `reads_${String(tx.d.k || '').replace(/\./g, '_')}`;
                    const oldVal = target.knowledge_asymmetry[flatKey];
                    target.knowledge_asymmetry[flatKey] = tx.d.v;
                    if (oldVal !== tx.d.v) {
                        recordHistory(state, tx.e, tx.id, `knowledge_asymmetry.${flatKey}`, oldVal, tx.d.v, tx);
                    }
                    break;
                }
                const dotted = tx.d.k && tx.d.k.includes('.');
                let fieldVal = target[tx.d.f];
                // Bug 4(a): null is typeof 'object' but can't be subscripted — re-initialize to {}.
                if (fieldVal === null) { target[tx.d.f] = {}; fieldVal = target[tx.d.f]; }
                if (typeof fieldVal !== 'object' || Array.isArray(fieldVal)) {
                    if (dotted && typeof fieldVal === 'string' && fieldVal.trim()) {
                        target[tx.d.f] = { legacy: fieldVal.trim() };
                    } else {
                        target[tx.d.f] = {};
                    }
                }
                // Flatten dotted KA writes (e.g. knows.weapon → knows_weapon) into the top-level KA map.
                if (dotted && tx.d.f === 'knowledge_asymmetry') {
                    const flatKey = tx.d.k.replace(/\./g, '_');
                    const oldVal = target[tx.d.f][flatKey];
                    target[tx.d.f][flatKey] = tx.d.v;
                    if (oldVal !== tx.d.v) {
                        recordHistory(state, tx.e, tx.id, `${tx.d.f}.${flatKey}`, oldVal, tx.d.v, tx);
                    }
                } else if (dotted) {
                    const keyParts = tx.d.k.split('.');
                    let obj = target[tx.d.f];
                    for (let i = 0; i < keyParts.length - 1; i++) {
                        const k = keyParts[i];
                        if (typeof obj[k] === 'string' && obj[k].trim()) {
                            obj[k] = { legacy: obj[k].trim() };
                        } else if (typeof obj[k] !== 'object' || Array.isArray(obj[k])) {
                            obj[k] = {};
                        }
                        obj = obj[k];
                    }
                    const leafKey = keyParts[keyParts.length - 1];
                    const oldVal = obj[leafKey];
                    obj[leafKey] = tx.d.v;
                    if (oldVal !== tx.d.v) {
                        recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, tx.d.v, tx);
                    }
                } else {
                    const oldVal = target[tx.d.f][tx.d.k];
                    target[tx.d.f][tx.d.k] = tx.d.v;
                    if (oldVal !== tx.d.v) {
                        recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, tx.d.v, tx);
                    }
                }
                // applies to both char and faction KA — target is whichever entity the MS targeted
                // Bug 3: enforce 20-key cap on knowledge_asymmetry after every live MS write.
                // Drop oldest (insertion-order) keys first; latest write always survives.
                if (tx.d.f === 'knowledge_asymmetry' && typeof target.knowledge_asymmetry === 'object' && target.knowledge_asymmetry !== null) {
                    const kaKeys = Object.keys(target.knowledge_asymmetry);
                    if (kaKeys.length > 20) {
                        for (const k of kaKeys.slice(0, kaKeys.length - 20)) delete target.knowledge_asymmetry[k];
                    }
                }
            }
            break;
        }

        case 'MR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                if (tx.d.k && tx.d.k.includes('.')) {
                    const keyParts = tx.d.k.split('.');
                    let obj = target[tx.d.f];
                    if (typeof obj !== 'object' || Array.isArray(obj)) break;
                    for (let i = 0; i < keyParts.length - 1; i++) {
                        obj = obj?.[keyParts[i]];
                        if (typeof obj !== 'object' || Array.isArray(obj)) break;
                    }
                    if (obj && typeof obj === 'object') {
                        const leafKey = keyParts[keyParts.length - 1];
                        const oldVal = obj[leafKey];
                        delete obj[leafKey];
                        recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, undefined, tx);
                    }
                } else if (typeof target[tx.d.f] === 'object') {
                    const oldVal = target[tx.d.f][tx.d.k];
                    delete target[tx.d.f][tx.d.k];
                    recordHistory(state, tx.e, tx.id, `${tx.d.f}.${tx.d.k}`, oldVal, undefined, tx);
                }
            }
            break;
        }

        case 'D': {
            if (!isSingleton) {
                if (tx.e === 'char' || tx.e === 'faction') {
                    const entity = state[collection]?.[tx.id];

                    // 1. Stamp display_name BEFORE deleting entity (after D, entity is gone)
                    const relId = `pc-${tx.id}`;
                    const rel = state.relationships?.[relId];
                    if (rel && entity?.name) {
                        rel.display_name = entity.name;
                    }

                    // 2. Archive the relationship
                    adjustRelationshipStatus(state, tx.e, tx.id, 'archived');

                    // 3. Scrub dangling scene_cast reference
                    const fqId = `${tx.e}:${tx.id}`;
                    if (state.pc && Array.isArray(state.pc.scene_cast)) {
                        state.pc.scene_cast = state.pc.scene_cast.filter(ref => ref !== fqId);
                    }
                }
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
    if (!state.divination) state.divination = { active_system: 'arcana', last_draw: null, readings: [] };
    if (!state.relationships) state.relationships = {};

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

    normalizeArrayFields(state);
    normalizeCharacterKnowledgeAsymmetry(state);
    migrateFactionToPhase2(state);

    return state;
}

function diffStates(before, after) {
    const changes = [];
    for (const col of ['characters', 'constraints', 'collisions', 'factions', 'places', 'pressures']) {
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

// ─── Travel Plausibility ──────────────────────────────────────────────────────

const TRAVEL_REACH_ORDER = ['LOCAL', 'DISTRICT', 'CITY', 'REGIONAL', 'REMOTE'];
const ON_FOOT_MAX = 'DISTRICT'; // highest reach reachable on a non-advance turn

function validateTravel(charId, fromPlaceId, toPlaceId, state, turnMode) {
    if (turnMode === 'advance') return { valid: true };
    const fromPlace = state.places?.[fromPlaceId];
    const toPlace = state.places?.[toPlaceId];
    if (!fromPlace || !toPlace) return { valid: true };
    if (fromPlaceId === toPlaceId) return { valid: true };
    const fromIdx = TRAVEL_REACH_ORDER.indexOf(fromPlace.reach || 'LOCAL');
    const toIdx = TRAVEL_REACH_ORDER.indexOf(toPlace.reach || 'LOCAL');
    const maxIdx = TRAVEL_REACH_ORDER.indexOf(ON_FOOT_MAX);
    if (toIdx > maxIdx || fromIdx > maxIdx) {
        return {
            valid: false,
            error: `Travel from "${fromPlace.name}" (${fromPlace.reach}) to "${toPlace.name}" (${toPlace.reach}) is implausible in a 15-minute scene window.`,
            fix: `Use an ADVANCE turn to timeskip travel, or add a narrative justification (vehicle, special transport) before the location change.`,
        };
    }
    return { valid: true };
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
    CATEGORY_DISTANCES,
    createEmptyState,
    applyTransaction,
    computeState,
    getCollectionName,
    validateTravel,
    getFieldHistory,
    getArrayItemHistory,
    getEntityHistory,
};
