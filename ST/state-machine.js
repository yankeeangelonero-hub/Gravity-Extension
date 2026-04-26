/**
 * state-machine.js — State machine definitions and transition enforcement.
 *
 * Defines the valid states and transitions for each entity lifecycle.
 * Phase 2 wires `validateTransition()` into the commit pipeline via
 * `consistency.js::validateTransitions()` — invalid TRs are rejected at
 * commit time (§6.1). This module serves as:
 *
 * 1. Authoritative state tables for each entity type
 * 2. `validateTransition()` — the enforcement function called by consistency.js
 * 3. Utility helpers (getValidNextStates, isTerminal) for future OOC eval work
 */

// ─── Character Tier ────────────────────────────────────────────────────────────
// UNKNOWN → KNOWN → TRACKED → PRINCIPAL
// Reverse: PRINCIPAL → TRACKED/KNOWN, TRACKED → KNOWN

const CHARACTER_TIERS = ['UNKNOWN', 'KNOWN', 'TRACKED', 'PRINCIPAL'];

const CHARACTER_TRANSITIONS = {
    UNKNOWN:   { promote: 'KNOWN' },
    KNOWN:     { promote: 'TRACKED', retire: null },  // retire from KNOWN = destroy
    TRACKED:   { promote: 'PRINCIPAL', retire: 'KNOWN' },
    PRINCIPAL: { retire: 'TRACKED' },
};

// ─── Constraint Integrity ──────────────────────────────────────────────────────
// STABLE → STRESSED → CRITICAL → BREACHED (terminal)
// Relief: CRITICAL → STRESSED → STABLE

const CONSTRAINT_LEVELS = ['STABLE', 'STRESSED', 'CRITICAL', 'BREACHED'];

const CONSTRAINT_TRANSITIONS = {
    STABLE:   { pressure: 'STRESSED' },
    STRESSED: { pressure: 'CRITICAL', relief: 'STABLE' },
    CRITICAL: { pressure: 'BREACHED', relief: 'STRESSED' },
    BREACHED: {},  // terminal — no transitions out
};

// ─── Collision Lifecycle ───────────────────────────────────────────────────────
// Phase 2: Simplified — all collisions start ACTIVE.
// ACTIVE → RESOLVED (on-screen, off-screen, evolved, dissolved, imploded)
// ACTIVE → CRASHED (distance hit 0 and scene did not engage)

const COLLISION_STATES = ['ACTIVE', 'RESOLVED', 'CRASHED'];

const COLLISION_TRANSITIONS = {
    ACTIVE:   { resolve: 'RESOLVED', crash: 'CRASHED' },
    RESOLVED: {},  // terminal
    CRASHED:  {},  // terminal — forces acted without characters
};

// ─── Combat Lifecycle ──────────────────────────────────────────────────────────
// ACTIVE → RESOLVED

const COMBAT_STATES = ['ACTIVE', 'RESOLVED'];

const COMBAT_TRANSITIONS = {
    ACTIVE: { advance: 'RESOLVED' },
    RESOLVED: {},
};

// ─── Relationship Status ───────────────────────────────────────────────────────
// active <-> dormant (bidirectional), any -> archived (terminal)

const RELATIONSHIP_STATUSES = ['active', 'dormant', 'archived'];

const RELATIONSHIP_TRANSITIONS = {
    active:   { dormant: 'dormant', archive: 'archived' },
    dormant:  { activate: 'active', archive: 'archived' },
    archived: {},  // terminal — no transitions out
};

// ─── Faction Tier ─────────────────────────────────────────────────────────────
// KNOWN <-> TRACKED <-> PRINCIPAL (flexible, all movements allowed)

const FACTION_TIERS = ['KNOWN', 'TRACKED', 'PRINCIPAL'];

const FACTION_TRANSITIONS = {
    KNOWN:     { promote: 'TRACKED', escalate: 'PRINCIPAL' },
    TRACKED:   { promote: 'PRINCIPAL', retire: 'KNOWN' },
    PRINCIPAL: { retire: 'TRACKED', demote: 'KNOWN' },
};

// ─── Transition Validator ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [error] - Human-readable error if invalid
 * @property {string} [fix] - Suggested fix
 */

/**
 * Validate a state transition.
 * @param {string} entityType - 'char', 'constraint', 'collision', 'combat'
 * @param {string} field - The field being transitioned (e.g. 'tier', 'integrity', 'status')
 * @param {string} from - Current state
 * @param {string} to - Target state
 * @returns {ValidationResult}
 */
function validateTransition(entityType, field, from, to) {
    const machines = {
        char:         { field: 'tier',   transitions: CHARACTER_TRANSITIONS,     states: CHARACTER_TIERS },
        constraint:   { field: 'integrity', transitions: CONSTRAINT_TRANSITIONS, states: CONSTRAINT_LEVELS },
        collision:    { field: 'status', transitions: COLLISION_TRANSITIONS,     states: COLLISION_STATES },
        combat:       { field: 'status', transitions: COMBAT_TRANSITIONS,        states: COMBAT_STATES },
        faction:      { field: 'tier',   transitions: FACTION_TRANSITIONS,       states: FACTION_TIERS },
        relationship: { field: 'status', transitions: RELATIONSHIP_TRANSITIONS,  states: RELATIONSHIP_STATUSES },
    };

    const machine = machines[entityType];
    if (!machine) {
        return { valid: true }; // No state machine for this entity type (world, pc, place, etc.)
    }

    // Only validate the state-machine-governed field
    if (field !== machine.field) {
        return { valid: true };
    }

    // Check the 'from' state exists
    if (!machine.transitions[from]) {
        return {
            valid: false,
            error: `Unknown ${entityType} state: "${from}"`,
            fix: `Valid states: ${machine.states.join(', ')}`,
        };
    }

    // Check if the transition is allowed
    const allowedTargets = Object.values(machine.transitions[from]).filter(Boolean);
    if (!allowedTargets.includes(to)) {
        // Build a helpful error
        const adjacent = allowedTargets.length > 0
            ? `From "${from}", valid targets: ${allowedTargets.join(', ')}`
            : `"${from}" is a terminal state — no transitions allowed`;

        // Check if they're trying to skip
        const fromIdx = machine.states.indexOf(from);
        const toIdx = machine.states.indexOf(to);
        const skipping = Math.abs(toIdx - fromIdx) > 1;

        return {
            valid: false,
            error: skipping
                ? `Cannot skip ${entityType} ${field} from "${from}" to "${to}" — must go through intermediate states`
                : `Invalid ${entityType} ${field} transition: "${from}" → "${to}"`,
            fix: adjacent,
        };
    }

    return { valid: true };
}

/**
 * Check that promoting an entity to PRINCIPAL is unique (max one PRINCIPAL per type).
 * @param {Object} state - Current computed state
 * @param {string} entityType - 'char' or 'faction'
 * @param {string} entityId - The entity being promoted
 * @param {string} newTier - The target tier
 * @returns {ValidationResult}
 */
function checkPrincipalUniqueness(state, entityType, entityId, newTier) {
    if (newTier !== 'PRINCIPAL') return { valid: true };
    const collection = entityType === 'char' ? state.characters : state.factions;
    if (!collection) return { valid: true };
    for (const [id, ent] of Object.entries(collection)) {
        if (id === entityId) continue;
        if (String(ent.tier || '').toUpperCase() === 'PRINCIPAL') {
            return {
                valid: false,
                error: `A PRINCIPAL ${entityType} already exists: "${id}". Max one PRINCIPAL per entity type.`,
                fix: `Demote ${id} to TRACKED first (TR ${entityType}:${id} field=tier from=PRINCIPAL to=TRACKED), then promote ${entityId}.`,
            };
        }
    }
    return { valid: true };
}

/**
 * Get valid next states for an entity in a given state.
 * @param {string} entityType
 * @param {string} currentState
 * @returns {string[]}
 */
function getValidNextStates(entityType, currentState) {
    const machines = {
        char:       CHARACTER_TRANSITIONS,
        constraint: CONSTRAINT_TRANSITIONS,
        collision:  COLLISION_TRANSITIONS,
        combat:     COMBAT_TRANSITIONS,
    };

    const transitions = machines[entityType];
    if (!transitions || !transitions[currentState]) return [];
    return Object.values(transitions[currentState]).filter(Boolean);
}

/**
 * Check if a state is terminal (no outgoing transitions).
 * @param {string} entityType
 * @param {string} state
 * @returns {boolean}
 */
function isTerminal(entityType, state) {
    return getValidNextStates(entityType, state).length === 0;
}

/**
 * Get the state machine field name for an entity type.
 * Two call modes:
 *   1-arg — return the machine field (or null) for this entity type.
 *   2-arg — return the machine field ONLY if `field` matches it; otherwise null.
 * The 2-arg form is convenient for callers that want "is this TX targeting the
 * state-machine field?" — answer is truthy iff this entity has a machine AND
 * the caller's field matches.
 *
 * @param {string} entityType
 * @param {string} [field] - if provided, gate return on `field === machineField`
 * @returns {string|null}
 */
function getStateMachineField(entityType, field) {
    const fields = {
        char:         'tier',
        constraint:   'integrity',
        collision:    'status',
        combat:       'status',
        faction:      'tier',
        relationship: 'status',
    };
    const machineField = fields[entityType] || null;
    if (field === undefined) return machineField;
    return machineField === field ? machineField : null;
}

export {
    CHARACTER_TIERS,
    CHARACTER_TRANSITIONS,
    CONSTRAINT_LEVELS,
    CONSTRAINT_TRANSITIONS,
    COLLISION_STATES,
    COLLISION_TRANSITIONS,
    COMBAT_STATES,
    COMBAT_TRANSITIONS,
    FACTION_TIERS,
    FACTION_TRANSITIONS,
    RELATIONSHIP_STATUSES,
    RELATIONSHIP_TRANSITIONS,
    validateTransition,
    checkPrincipalUniqueness,
    getStateMachineField,
};
