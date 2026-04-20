/**
 * consistency.js — Format and structure validation + state-machine transition guard.
 *
 * The extension validates that ledger transactions are well-formed:
 * correct JSON structure, valid operation codes, required fields present,
 * valid entity type codes, proper data shapes.
 *
 * Phase 2 also wires state-machine transition enforcement here (§6.1): every
 * `TR` operation is checked against `state-machine.js::validateTransition()`
 * at commit time, and invalid transitions are rejected while the rest of the
 * batch still commits.
 *
 * Gameplay rules beyond state-machine transitions (PRINCIPAL count, constraint
 * limits, collision forces) remain the LLM's responsibility, audited during
 * OOC: eval.
 */

import { validateTransition, getStateMachineField } from './state-machine.js';

const ENTITY_TO_COLLECTION = {
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
};

// LLM-rejected fields owned by the engine. SET writes here are dropped at
// validation time so state-compute never sees them. distance is decremented
// by the timeskip engine; pressure.created_at_tx is stamped from tx.tx in CR.
const ENGINE_OWNED_FIELDS = {
    collision: new Set(['distance']),
    pressure: new Set(['created_at_tx']),
};

// ─── Valid Values ──────────────────────────────────────────────────────────────

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'world', 'pc', 'divination'];

// Required fields per operation type
const OP_REQUIRED_FIELDS = {
    CR:    ['e', 'id', 'd'],           // Create: entity type, id, data payload
    TR:    ['e', 'id', 'd'],           // Transition: needs d.f, d.from, d.to
    S:     ['e', 'id', 'd'],           // Set: needs d.f, d.v
    A:     ['e', 'id', 'd'],           // Append: needs d.f, d.v
    R:     ['e', 'id', 'd'],           // Remove: needs d.f, d.v
    MS:    ['e', 'id', 'd'],           // Map set: needs d.f, d.k, d.v
    MR:    ['e', 'id', 'd'],           // Map remove: needs d.f, d.k
    D:     ['e', 'id'],                // Destroy: just entity type and id
    SNAP:  [],                          // Snapshot: no required fields
    ROLL:  ['d'],                       // Rollback: needs d.target_snapshot_id
    AMEND: ['d'],                       // Amend: needs d.target_tx, d.correction
};

// Required data subfields per operation type
const OP_DATA_FIELDS = {
    TR:    ['f', 'from', 'to'],        // field, from-state, to-state
    S:     ['f', 'v'],                  // field, value
    A:     ['f', 'v'],                  // field, value to append
    R:     ['f', 'v'],                  // field, value to remove
    MS:    ['f', 'k', 'v'],            // field, key, value
    MR:    ['f', 'k'],                  // field, key
    ROLL:  ['target_snapshot_id'],
    AMEND: ['target_tx', 'correction'],
};

/**
 * @typedef {Object} FormatViolation
 * @property {string} field - Which field has the issue
 * @property {string} message - Human-readable error
 * @property {string} fix - How to fix it
 */

/**
 * Validate a batch of transactions for format correctness only.
 * Does NOT check gameplay rules — that's the LLM's job during eval.
 *
 * @param {Array} transactions
 * @returns {{ errors: FormatViolation[], valid: boolean }}
 */
function validateBatch(transactions) {
    const errors = [];

    if (!Array.isArray(transactions)) {
        errors.push({
            field: 'root',
            message: 'Transactions must be an array',
            fix: 'Wrap transactions in [...brackets...]',
        });
        return { errors, valid: false };
    }

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const txErrors = validateFormat(tx, i);
        errors.push(...txErrors);
    }

    return { errors, valid: errors.length === 0 };
}

/**
 * Validate the format of a single transaction.
 * @param {Object} tx - The transaction object
 * @param {number} index - Position in the batch (for error messages)
 * @returns {FormatViolation[]}
 */
function validateFormat(tx, index) {
    const errors = [];
    const prefix = `tx[${index}]`;

    // Must be an object
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
        errors.push({
            field: prefix,
            message: `${prefix}: Transaction must be an object`,
            fix: 'Each transaction should be {...}',
        });
        return errors;
    }

    // op is required and must be valid
    if (!tx.op) {
        errors.push({
            field: `${prefix}.op`,
            message: `${prefix}: Missing "op" (operation code)`,
            fix: `Valid ops: ${VALID_OPS.join(', ')}`,
        });
        return errors; // Can't check further without op
    }

    if (!VALID_OPS.includes(tx.op)) {
        errors.push({
            field: `${prefix}.op`,
            message: `${prefix}: Unknown op "${tx.op}"`,
            fix: `Valid ops: ${VALID_OPS.join(', ')}`,
        });
        return errors;
    }

    // Check required top-level fields for this op
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);
    const required = OP_REQUIRED_FIELDS[tx.op] || [];
    for (const field of required) {
        // Singletons (world, pc) don't need an id
        if (field === 'id' && isSingleton) continue;

        if (tx[field] === undefined || tx[field] === null || tx[field] === '') {
            errors.push({
                field: `${prefix}.${field}`,
                message: `${prefix}: Missing required field "${field}" for op "${tx.op}"`,
                fix: `Add "${field}" to the transaction`,
            });
        }
    }

    // Validate entity type if present
    if (tx.e && !VALID_ENTITIES.includes(tx.e)) {
        errors.push({
            field: `${prefix}.e`,
            message: `${prefix}: Unknown entity type "${tx.e}"`,
            fix: `Valid types: ${VALID_ENTITIES.join(', ')}`,
        });
    }

    // Singletons (world, pc) don't need an id for most ops
    if (tx.e && !['world', 'pc', 'divination'].includes(tx.e) && required.includes('id')) {
        if (!tx.id || typeof tx.id !== 'string') {
            errors.push({
                field: `${prefix}.id`,
                message: `${prefix}: Entity id must be a non-empty string`,
                fix: `Add a string "id" for the ${tx.e} entity`,
            });
        }
    }

    // Check data subfields for this op
    if (tx.d && typeof tx.d === 'object') {
        const dataFields = OP_DATA_FIELDS[tx.op] || [];
        for (const field of dataFields) {
            if (tx.d[field] === undefined) {
                errors.push({
                    field: `${prefix}.d.${field}`,
                    message: `${prefix}: Missing data field "d.${field}" for op "${tx.op}"`,
                    fix: `Op "${tx.op}" requires d.${field}`,
                });
            }
        }
    } else if (required.includes('d')) {
        errors.push({
            field: `${prefix}.d`,
            message: `${prefix}: "d" (data) must be an object`,
            fix: `Add "d": {...} with the required fields`,
        });
    }

    // Validate timestamp format if present (advisory — don't reject, just warn)
    if (tx.t && typeof tx.t === 'string') {
        if (!tx.t.match(/\[Day \d+/i) && tx.t !== '') {
            // Non-standard timestamp format — not blocking, LLM can fix during eval
        }
    }

    return errors;
}

/**
 * Format validation errors into an injection message for the LLM.
 * @param {FormatViolation[]} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (errors.length === 0) return '';

    const lines = [`[LEDGER: FORMAT ERROR — ${errors.length} issue(s):`];
    for (const err of errors.slice(0, 5)) { // Cap at 5 to avoid flooding
        lines.push(`  ${err.message}. Fix: ${err.fix}`);
    }
    if (errors.length > 5) {
        lines.push(`  ...and ${errors.length - 5} more.`);
    }
    lines.push('Resubmit corrected transactions.]');
    return lines.join('\n');
}

/**
 * Identify terminal collision TRs (RESOLVED/CRASHED) in a committed batch that
 * lack a matching `world.collision_archive` entry.
 * §2.2.1 — "engine checks for a world.collision_archive append when processing
 * a terminal collision TR". Pure detection; caller owns the correction-queue
 * side effects.
 *
 * @param {Array} committedTxns — transactions just appended
 * @param {Object} state — post-commit computed state
 * @returns {Array<{ id: string, name: string, to: string }>} missing entries
 */
function findMissingArchiveEntries(committedTxns, state) {
    if (!Array.isArray(committedTxns) || committedTxns.length === 0) return [];
    const archive = Array.isArray(state?.world?.collision_archive) ? state.world.collision_archive : [];

    const terminals = committedTxns
        .filter(tx => tx.op === 'TR' && tx.e === 'collision'
            && (tx.d?.to === 'RESOLVED' || tx.d?.to === 'CRASHED'))
        .map(tx => ({ id: tx.id }));

    const missing = [];
    for (const { id: colId } of terminals) {
        const col = state.collisions?.[colId];
        const nameToken = col?.name ? String(col.name) : '';
        const idToken = `[id ${colId}]`;
        const matched = archive.some(entry => typeof entry === 'string' && entry.includes(idToken));
        if (!matched) missing.push({ id: colId, name: nameToken });
    }
    return missing;
}

/**
 * Validate state-machine transitions for a batch of transactions (§6.1).
 * Gates `TR` ops, `S` ops on machine-governed fields (tier/integrity/status),
 * and engine-owned field writes (collision.distance, pressure.created_at_tx).
 * Rejected TXs are pulled out of `valid` and returned as structured errors.
 * Other TXs in the batch still commit (per-tx filtering, not batch abort).
 *
 * `state` is the post-replay computed state; needed to derive `from` for `S`
 * ops since the LLM only writes `to`. Caller passes _currentState.
 *
 * @param {Array} transactions
 * @param {Object} [state] - current computed state (optional; required for S-on-machine-field gating)
 * @returns {{ valid: Array, errors: Array<{ lineNum: number, error: string, fix: string, raw: string, tx: any }> }}
 */
function validateTransitions(transactions, state) {
    const valid = [];
    const errors = [];
    if (!Array.isArray(transactions)) return { valid: [], errors: [] };

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];

        if (tx?.op === 'S') {
            const engineFields = ENGINE_OWNED_FIELDS[tx.e];
            if (engineFields && engineFields.has(tx.d?.f)) {
                errors.push({
                    lineNum: i,
                    error: `${tx.e}:${tx.id}.${tx.d.f} is engine-owned — SET is rejected`,
                    fix: tx.e === 'collision' && tx.d.f === 'distance'
                        ? `Set distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR; the engine resolves and ticks the numeric distance.`
                        : `Do not write ${tx.e}.${tx.d.f} directly — the engine manages this field.`,
                    raw: `[s ${tx.e}:${tx.id} ${tx.d.f}]`,
                    tx,
                });
                continue;
            }

            const machineField = getStateMachineField(tx.e, tx.d?.f);
            if (machineField) {
                const collection = ENTITY_TO_COLLECTION[tx.e];
                const entity = state?.[collection]?.[tx.id];
                const fromVal = entity?.[machineField];
                if (fromVal === undefined || fromVal === null) {
                    errors.push({
                        lineNum: i,
                        error: `Cannot SET ${tx.e}:${tx.id}.${machineField} — entity not found or has no current ${machineField}; use TR instead`,
                        fix: `Use TR ${tx.e}:${tx.id} field=${machineField} from=<current> to=${tx.d?.v} so the state machine can validate the move.`,
                        raw: `[s ${tx.e}:${tx.id} ${machineField}]`,
                        tx,
                    });
                    continue;
                }
                const result = validateTransition(tx.e, machineField, fromVal, tx.d?.v);
                if (!result.valid) {
                    errors.push({
                        lineNum: i,
                        error: result.error,
                        fix: `${result.fix} (Use TR, not S, for state-machine fields.)`,
                        raw: `[s ${tx.e}:${tx.id} ${machineField}]`,
                        tx,
                    });
                    continue;
                }
            }

            valid.push(tx);
            continue;
        }

        if (tx?.op !== 'TR') {
            valid.push(tx);
            continue;
        }
        const result = validateTransition(tx.e, tx.d?.f, tx.d?.from, tx.d?.to);
        if (result.valid) {
            valid.push(tx);
        } else {
            errors.push({
                lineNum: i,
                error: result.error,
                fix: result.fix,
                raw: `[tr ${tx.e}:${tx.id}]`,
                tx,
            });
        }
    }
    return { valid, errors };
}

export {
    validateBatch,
    validateFormat,
    validateTransitions,
    findMissingArchiveEntries,
    formatErrors,
    VALID_OPS,
    VALID_ENTITIES,
};
