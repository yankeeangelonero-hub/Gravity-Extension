/**
 * consistency.js — Format and structure validation only.
 *
 * The extension validates that ledger transactions are well-formed:
 * correct JSON structure, valid operation codes, required fields present,
 * valid entity type codes, proper data shapes.
 *
 * Gameplay rules (PRINCIPAL count, constraint limits, collision forces,
 * state machine transitions) are NOT enforced here. Those are the LLM's
 * responsibility, audited during OOC: eval.
 */

// ─── Valid Values ──────────────────────────────────────────────────────────────

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'chapter', 'faction', 'world', 'pc', 'divination', 'summary'];

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
    const isSingleton = ['world', 'pc', 'divination', 'summary'].includes(tx.e);
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
    if (tx.e && !['world', 'pc', 'divination', 'summary'].includes(tx.e) && required.includes('id')) {
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

export {
    validateBatch,
    validateFormat,
    formatErrors,
    VALID_OPS,
    VALID_ENTITIES,
};
