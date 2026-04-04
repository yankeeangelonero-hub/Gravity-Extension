/**
 * state-machine.js — State machine definitions and reference data.
 *
 * Defines the valid states and transitions for each entity lifecycle.
 * These are NOT enforced by the extension — gameplay rules are the LLM's
 * responsibility, audited during OOC: eval. This module serves as:
 *
 * 1. Reference documentation for the state machines
 * 2. Utility functions the LLM-facing eval can use to describe valid transitions
 * 3. A library the prompt layer references when explaining rules to the LLM
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
// Tier determines starting distance and tick rate:
//   flash  — starts ACTIVE (dist 0-2), skips SEEDED/SIMMERING, resolves in 1-3 turns
//   arc    — standard lifecycle SEEDED→SIMMERING→ACTIVE→RESOLVING→RESOLVED (dist 4-6)
//   saga   — chapter-spanning (dist 8-10), ticks every 2-3 advances, resists resolution
//
// Flash lifecycle: ACTIVE → RESOLVING → RESOLVED (no SEEDED or SIMMERING)
// Arc/Saga lifecycle: SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED/CRASHED

const COLLISION_STATES = ['SEEDED', 'SIMMERING', 'ACTIVE', 'RESOLVING', 'RESOLVED', 'CRASHED'];

const COLLISION_TRANSITIONS = {
    SEEDED:    { advance: 'SIMMERING' },
    SIMMERING: { advance: 'ACTIVE' },
    ACTIVE:    { advance: 'RESOLVING', crash: 'CRASHED' },
    RESOLVING: { advance: 'RESOLVED', crash: 'CRASHED' },
    RESOLVED:  {},  // terminal
    CRASHED:   {},  // terminal — uncontrolled collision
};

// ─── Combat Lifecycle ──────────────────────────────────────────────────────────
// ACTIVE → RESOLVED

const COMBAT_STATES = ['ACTIVE', 'RESOLVED'];

const COMBAT_TRANSITIONS = {
    ACTIVE: { advance: 'RESOLVED' },
    RESOLVED: {},
};

// ─── Chapter Lifecycle ─────────────────────────────────────────────────────────
// PLANNED → OPEN → CLOSING → CLOSED

const CHAPTER_STATES = ['PLANNED', 'OPEN', 'CLOSING', 'CLOSED'];

const CHAPTER_TRANSITIONS = {
    PLANNED: { advance: 'OPEN' },
    OPEN:    { advance: 'CLOSING' },
    CLOSING: { advance: 'CLOSED' },
    CLOSED:  {},  // terminal
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
 * @param {string} entityType - 'char', 'constraint', 'collision', 'chapter'
 * @param {string} field - The field being transitioned (e.g. 'tier', 'integrity', 'status')
 * @param {string} from - Current state
 * @param {string} to - Target state
 * @returns {ValidationResult}
 */
function validateTransition(entityType, field, from, to) {
    const machines = {
        char:       { field: 'tier', transitions: CHARACTER_TRANSITIONS, states: CHARACTER_TIERS },
        constraint: { field: 'integrity', transitions: CONSTRAINT_TRANSITIONS, states: CONSTRAINT_LEVELS },
        collision:  { field: 'status', transitions: COLLISION_TRANSITIONS, states: COLLISION_STATES },
        combat:     { field: 'status', transitions: COMBAT_TRANSITIONS, states: COMBAT_STATES },
        chapter:    { field: 'status', transitions: CHAPTER_TRANSITIONS, states: CHAPTER_STATES },
    };

    const machine = machines[entityType];
    if (!machine) {
        return { valid: true }; // No state machine for this entity type (world, pc)
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
        chapter:    CHAPTER_TRANSITIONS,
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
 * @param {string} entityType
 * @returns {string|null}
 */
function getStateMachineField(entityType) {
    const fields = {
        char: 'tier',
        constraint: 'integrity',
        collision: 'status',
        combat: 'status',
        chapter: 'status',
    };
    return fields[entityType] || null;
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
    CHAPTER_STATES,
    CHAPTER_TRANSITIONS,
    validateTransition,
    getValidNextStates,
    isTerminal,
    getStateMachineField,
};
