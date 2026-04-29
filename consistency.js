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

import { validateTransition, getStateMachineField, checkPrincipalUniqueness } from './state-machine.js';
import { applyTransaction as _applyTransactionFromCompute } from './state-compute.js';

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
    relationship: 'relationships',
};

// LLM-rejected fields owned by the engine. SET writes here are dropped at
// validation time so state-compute never sees them. distance is decremented
// by the timeskip engine; pressure.created_at_tx is stamped from tx.tx in CR.
// relationship.card and divination fields are rolled by drawDivination() and
// committed by the engine — the LLM must never SET these directly.
const ENGINE_OWNED_FIELDS = {
    collision: new Set(['distance']),
    pressure: new Set(['created_at_tx']),
    relationship: new Set(['card']),
    divination: new Set(['last_draw', 'card', 'orientation']),
};

// ─── Relationship Constants ────────────────────────────────────────────────────

const MAJOR_ARCANA = new Set([
    'the-fool', 'the-magician', 'the-high-priestess', 'the-empress', 'the-emperor',
    'the-hierophant', 'the-lovers', 'the-chariot', 'strength', 'the-hermit',
    'wheel-of-fortune', 'justice', 'the-hanged-man', 'death', 'temperance',
    'the-devil', 'the-tower', 'the-star', 'the-moon', 'the-sun',
    'judgement', 'the-world',
]);

const RELATIONSHIP_ORIENTATIONS = new Set(['upright', 'reversed']);
const RELATIONSHIP_DISTANCES = new Set(['fresh', 'forming', 'established', 'deep', 'core']);
const RELATIONSHIP_INTENSITIES = new Set(['cold', 'simmering', 'active', 'electric']);
const FACTION_TIERS_SET = new Set(['KNOWN', 'TRACKED', 'PRINCIPAL']);
const CHARACTER_TAGS_MAX = 5;
const CHARACTER_TAG_MAXLEN = 40;
const LAST_SHIFT_REASON_MAXLEN = 200;

// ─── Valid Values ──────────────────────────────────────────────────────────────

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'world', 'pc', 'divination', 'relationship'];

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

        // Verify tx.d.from matches the entity's actual current state (mirrors S-path check above).
        const trMachineField = getStateMachineField(tx.e, tx.d?.f);
        if (trMachineField) {
            const trCollection = ENTITY_TO_COLLECTION[tx.e];
            const trEntity = state?.[trCollection]?.[tx.id];
            // same-batch CR-then-TR not covered — mirrors S-path behavior at line ~303
            if (trEntity !== undefined) {
                const trActual = trEntity?.[trMachineField];
                // If entity exists but field not yet set, allow only if claimed from == initial state.
                const INITIAL_STATES = { char: 'UNKNOWN', constraint: 'STABLE', collision: 'ACTIVE', combat: 'ACTIVE', faction: 'KNOWN', relationship: 'active' };
                const initialState = INITIAL_STATES[tx.e];
                if ((trActual === undefined || trActual === null) && String(tx.d?.from || '').toUpperCase() !== initialState) {
                    errors.push({
                        lineNum: i,
                        error: `TR from-state mismatch: claimed "${tx.d?.from}" but actual is ${initialState} (default)`,
                        fix: `Use from=${initialState} to reflect the entity's actual current state.`,
                        raw: `[tr ${tx.e}:${tx.id}]`,
                        tx,
                    });
                    continue;
                } else if (trActual !== undefined && trActual !== null && String(tx.d?.from || '').toUpperCase() !== trActual) {
                    errors.push({
                        lineNum: i,
                        error: `TR from-state mismatch: claimed "${tx.d?.from}" but actual is "${trActual}"`,
                        fix: `Use from=${trActual} to reflect the entity's actual current state.`,
                        raw: `[tr ${tx.e}:${tx.id}]`,
                        tx,
                    });
                    continue;
                }
            }
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

// ─── Relationship Shape Helpers ────────────────────────────────────────────────

function isValidCardObj(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const card = typeof obj.card === 'string' ? obj.card.toLowerCase() : '';
    const orientation = typeof obj.orientation === 'string' ? obj.orientation.toLowerCase() : '';
    const distance = typeof obj.distance === 'string' ? obj.distance.toLowerCase() : '';
    const intensity = typeof obj.intensity === 'string' ? obj.intensity.toLowerCase() : '';
    return MAJOR_ARCANA.has(card)
        && RELATIONSHIP_ORIENTATIONS.has(orientation)
        && RELATIONSHIP_DISTANCES.has(distance)
        && RELATIONSHIP_INTENSITIES.has(intensity);
}

function isValidLastShift(v) {
    if (v === null) return true;
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    if (typeof v.tx !== 'number') return false;
    if (!('collision_id' in v)) return false;
    if (typeof v.reason !== 'string') return false;
    if (v.reason.length > LAST_SHIFT_REASON_MAXLEN) return false;
    if (!isValidCardObj(v.from)) return false;
    if (!isValidCardObj(v.to)) return false;
    return true;
}

function validateRelationshipId(id) {
    if (typeof id !== 'string' || !id.startsWith('pc-') || id.length <= 3) {
        return {
            field: 'id',
            message: `relationship id must be "pc-<other_id>", got "${id}"`,
            fix: 'Use e.g. relationship:pc-lacus (PC is always first in the pair).',
        };
    }
    return null;
}

function validateRelationshipTx(tx) {
    const violations = [];
    const idViolation = validateRelationshipId(tx.id);
    if (idViolation) violations.push(idViolation);

    if (tx.op === 'CR') {
        const d = tx.d || {};
        const card = typeof d.card === 'string' ? d.card.toLowerCase() : d.card;
        const orientation = typeof d.orientation === 'string' ? d.orientation.toLowerCase() : d.orientation;
        if (!MAJOR_ARCANA.has(card)) {
            violations.push({ field: 'card', message: `invalid card slug "${d.card}"`, fix: 'Must be one of the 22 Major Arcana slugs in lowercase-hyphen form.' });
        }
        if (!RELATIONSHIP_ORIENTATIONS.has(orientation)) {
            violations.push({ field: 'orientation', message: `invalid orientation "${d.orientation}"`, fix: '"upright" or "reversed" (lowercase).' });
        }
        if (typeof d.nuance !== 'string' || d.nuance.trim() === '') {
            violations.push({ field: 'nuance', message: 'nuance must be a non-empty string', fix: 'Describe the specific expression of the archetype for this pair.' });
        }
        // distance/intensity are OPTIONAL on CR — state-compute defaults them to
        // fresh/simmering for new relationships. Only reject if the LLM supplied
        // a value that isn't in the allowed vocabulary.
        if (d.distance !== undefined) {
            const distance = typeof d.distance === 'string' ? d.distance.toLowerCase() : d.distance;
            if (!RELATIONSHIP_DISTANCES.has(distance)) {
                violations.push({ field: 'distance', message: `invalid distance "${d.distance}"`, fix: 'Must be one of: fresh, forming, established, deep, core (lowercase). Omit to default to "fresh".' });
            }
        }
        if (d.intensity !== undefined) {
            const intensity = typeof d.intensity === 'string' ? d.intensity.toLowerCase() : d.intensity;
            if (!RELATIONSHIP_INTENSITIES.has(intensity)) {
                violations.push({ field: 'intensity', message: `invalid intensity "${d.intensity}"`, fix: 'Must be one of: cold, simmering, active, electric (lowercase). Omit to default to "simmering".' });
            }
        }
        if (d.status !== undefined) {
            violations.push({ field: 'status', message: 'relationship.status is engine-owned — omit on CR', fix: 'Remove the status field. Status defaults to "active" at birth.' });
        }
        if (d.last_shift !== undefined && !isValidLastShift(d.last_shift)) {
            violations.push({ field: 'last_shift', message: 'last_shift must be null or {tx, collision_id, from: {card, orientation, distance, intensity}, to: {card, orientation, distance, intensity}, reason}', fix: 'Use null at birth.' });
        }
    } else if (tx.op === 'S') {
        const f = tx.d?.f;
        const v = tx.d?.v;
        if (f === 'card') {
            const card = typeof v === 'string' ? v.toLowerCase() : v;
            if (!MAJOR_ARCANA.has(card)) {
                violations.push({ field: 'card', message: `invalid card slug "${v}"`, fix: 'Major Arcana only, lowercase-hyphen.' });
            }
        }
        if (f === 'orientation') {
            const orientation = typeof v === 'string' ? v.toLowerCase() : v;
            if (!RELATIONSHIP_ORIENTATIONS.has(orientation)) {
                violations.push({ field: 'orientation', message: `invalid orientation "${v}"`, fix: '"upright" or "reversed" (lowercase).' });
            }
        }
        if (f === 'nuance') {
            if (typeof v !== 'string' || v.trim() === '') {
                violations.push({ field: 'nuance', message: `nuance must be a non-empty string, got ${JSON.stringify(v)}`, fix: 'Nuance must be a non-empty prose string.' });
            }
        }
        if (f === 'distance') {
            const distance = typeof v === 'string' ? v.toLowerCase() : v;
            if (!RELATIONSHIP_DISTANCES.has(distance)) {
                violations.push({ field: 'distance', message: `invalid distance "${v}"`, fix: 'Must be one of: fresh, forming, established, deep, core (lowercase).' });
            }
        }
        if (f === 'intensity') {
            const intensity = typeof v === 'string' ? v.toLowerCase() : v;
            if (!RELATIONSHIP_INTENSITIES.has(intensity)) {
                violations.push({ field: 'intensity', message: `invalid intensity "${v}"`, fix: 'Must be one of: cold, simmering, active, electric (lowercase).' });
            }
        }
        if (f === 'status') {
            violations.push({ field: 'status', message: 'relationship.status is engine-owned and cannot be SET manually', fix: 'Status follows tier automatically.' });
        }
        if (f === 'last_shift') {
            if (v === null) {
                violations.push({ field: 'last_shift', message: 'S last_shift=null would wipe the audit trail', fix: 'last_shift can only be null at birth (CR).' });
            } else {
                if (v && typeof v.reason === 'string' && v.reason.length > LAST_SHIFT_REASON_MAXLEN) {
                    violations.push({ field: 'last_shift', message: `last_shift.reason is too long (${v.reason.length} chars; max ${LAST_SHIFT_REASON_MAXLEN})`, fix: `Keep reason ≤${LAST_SHIFT_REASON_MAXLEN} chars.` });
                } else if (!isValidLastShift(v)) {
                    violations.push({ field: 'last_shift', message: 'last_shift must be {tx, collision_id, from: {card, orientation, distance, intensity}, to: {card, orientation, distance, intensity}, reason}', fix: 'All five fields required. from/to must be {card, orientation, distance, intensity} objects.' });
                }
            }
        }
    }
    return violations;
}

function validateCharTagsTx(tx) {
    const violations = [];
    if (tx.op === 'CR' && Array.isArray(tx.d?.tags)) {
        const tags = tx.d.tags;
        if (tags.length > CHARACTER_TAGS_MAX) {
            violations.push({ field: 'tags', message: `char.tags must be ≤ ${CHARACTER_TAGS_MAX} (got ${tags.length})`, fix: 'Trim to the most identity-defining tags.' });
        }
        for (const t of tags) {
            if (typeof t !== 'string') violations.push({ field: 'tags', message: 'tags must be strings', fix: 'Remove non-string entries.' });
            else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: 'tags', message: `tag too long`, fix: 'Tags should be 1-3 words.' });
        }
    } else if (tx.op === 'S' && tx.d?.f === 'tags') {
        if (!Array.isArray(tx.d.v)) {
            violations.push({ field: 'tags', message: `S char.tags value must be an array, got ${typeof tx.d.v}`, fix: 'Use an array.' });
            return violations;
        }
        const tags = tx.d.v;
        if (tags.length > CHARACTER_TAGS_MAX) {
            violations.push({ field: 'tags', message: `char.tags must be ≤ ${CHARACTER_TAGS_MAX} (got ${tags.length})`, fix: 'Trim to 5.' });
        }
        for (const t of tags) {
            if (typeof t !== 'string') violations.push({ field: 'tags', message: 'tags must be strings', fix: 'Remove non-string entries.' });
            else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: 'tags', message: `tag too long`, fix: '1-3 words.' });
        }
    } else if (tx.op === 'A' && tx.d?.f === 'tags') {
        const t = tx.d.v;
        if (typeof t !== 'string') violations.push({ field: 'tags', message: 'appended tag must be a string', fix: 'Tags must be plain text strings.' });
        else if (t.length > CHARACTER_TAG_MAXLEN) violations.push({ field: 'tags', message: `tag too long`, fix: '1-3 words.' });
    }
    return violations;
}

function validateFactionTierTx(tx) {
    const violations = [];
    let tier = null;
    if (tx.op === 'CR') tier = tx.d?.tier;
    else if (tx.op === 'S' && tx.d?.f === 'tier') tier = tx.d?.v;
    if (tier === undefined || tier === null) return violations;
    if (!FACTION_TIERS_SET.has(tier)) {
        violations.push({ field: 'tier', message: `invalid faction.tier "${tier}"`, fix: 'Must be KNOWN, TRACKED, or PRINCIPAL.' });
    }
    return violations;
}

function validateSceneCastEntries(refs, state, pendingCreations = null) {
    const violations = [];
    for (const ref of refs) {
        if (typeof ref !== 'string' || !ref.includes(':')) {
            violations.push({ field: 'scene_cast', message: `invalid cast entry "${ref}" — must be "type:id" format`, fix: 'Use char:lacus or faction:zaft.' });
            continue;
        }
        const colonIdx = ref.indexOf(':');
        const type = ref.slice(0, colonIdx);
        const id = ref.slice(colonIdx + 1);
        if (!state) continue;
        let exists = false;
        if (type === 'char') exists = Boolean(state.characters?.[id]);
        else if (type === 'faction') exists = Boolean(state.factions?.[id]);
        else {
            violations.push({ field: 'scene_cast', message: `unsupported entity type "${type}" in cast ref "${ref}"`, fix: 'Only "char:" and "faction:" prefixes allowed.' });
            continue;
        }
        if (!exists) {
            // Forward-ref tolerance: allow refs to entities CR'd later in the same block.
            const pending = type === 'char' ? pendingCreations?.char : type === 'faction' ? pendingCreations?.faction : null;
            if (pending && pending.has(id)) continue;
            violations.push({ field: 'scene_cast', message: `cast ref "${ref}" references a non-existent entity`, fix: `Create ${type}:${id} first.` });
        }
    }
    return violations;
}

/**
 * Validate a single transaction for shape correctness and semantic rules.
 * @param {Object} tx - The transaction object
 * @param {Object|null} state - Current computed state (may be null for stateless checks)
 * @returns {{ valid: boolean, violations: Array<{field: string, message: string, fix: string}> }}
 */
function validateTransaction(tx, state, pendingCreations = null) {
    const violations = [];

    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
        violations.push({ field: 'root', message: 'Transaction must be an object', fix: 'Each transaction should be {...}' });
        return { valid: false, violations };
    }

    // Relationship shape validation
    if (tx.e === 'relationship' && (tx.op === 'CR' || tx.op === 'S')) {
        violations.push(...validateRelationshipTx(tx));
    }
    // char.tags (CR, A, S)
    if (tx.e === 'char' && (tx.op === 'CR' || tx.op === 'A' || tx.op === 'S')) {
        violations.push(...validateCharTagsTx(tx));
    }
    // faction.tier (CR, S)
    if (tx.e === 'faction' && (tx.op === 'CR' || tx.op === 'S')) {
        violations.push(...validateFactionTierTx(tx));
    }
    // pc entity (scene_cast + current_place_id)
    if (tx.e === 'pc') {
        let refs = null;
        if (tx.op === 'S' && tx.d?.f === 'scene_cast' && Array.isArray(tx.d.v)) refs = tx.d.v;
        if (tx.op === 'A' && tx.d?.f === 'scene_cast') refs = [tx.d.v];
        if (refs) violations.push(...validateSceneCastEntries(refs, state, pendingCreations));
        if (tx.op === 'S' && tx.d?.f === 'current_place_id') {
            const v = tx.d.v;
            if (v !== null && v !== '' && v !== undefined) {
                if (typeof v !== 'string' || !v.startsWith('place:') || v.length <= 'place:'.length) {
                    violations.push({ field: 'current_place_id', message: `current_place_id must be "place:<id>", got "${v}"`, fix: 'Use the fully-qualified place id (e.g., place:bridge).' });
                }
            }
        }
    }
    // PRINCIPAL uniqueness (state-dependent)
    if (state && (tx.e === 'char' || tx.e === 'faction')) {
        let newTier = null;
        if (tx.op === 'CR' && tx.d?.tier) newTier = tx.d.tier;
        else if (tx.op === 'TR' && tx.d?.f === 'tier') newTier = tx.d?.to;
        else if (tx.op === 'S' && tx.d?.f === 'tier') newTier = tx.d?.v;
        if (newTier === 'PRINCIPAL') {
            const uniq = checkPrincipalUniqueness(state, tx.e, tx.id, newTier);
            if (!uniq.valid) {
                violations.push({ field: 'tier', message: uniq.error, fix: uniq.fix });
            }
        }
    }
    // CR relationship: target must exist and be TRACKED+
    // Forward-ref tolerance: if target is CR'd later in the same block,
    // check the pending CR's tier instead of demanding shadow presence.
    if (state && tx.e === 'relationship' && tx.op === 'CR') {
        const id = tx.id || '';
        if (id.startsWith('pc-') && id.length > 3) {
            const otherId = id.slice('pc-'.length);
            const char = state.characters?.[otherId];
            const faction = state.factions?.[otherId];
            const target = char || faction;
            let tier = null;
            if (target) {
                tier = String(target.tier || '').toUpperCase();
            } else if (pendingCreations?.char?.has(otherId)) {
                tier = String(pendingCreations.char.get(otherId) || '').toUpperCase();
            } else if (pendingCreations?.faction?.has(otherId)) {
                tier = String(pendingCreations.faction.get(otherId) || '').toUpperCase();
            }
            if (tier === null) {
                violations.push({ field: 'id', message: `relationship target "${otherId}" does not exist as char or faction`, fix: `Create the char or faction at TRACKED+ tier first.` });
            } else if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') {
                violations.push({ field: 'id', message: `relationship:pc-${otherId} requires target tier ≥ TRACKED (current: "${tier}")`, fix: `Promote the target to TRACKED first.` });
            }
        }
    }

    return { valid: violations.length === 0, violations };
}

/**
 * Validate a block of transactions using a shadow-state walk.
 * Catches same-block exploits (e.g. two PRINCIPAL CRs in one block).
 * @param {Array} txs - Array of transactions to validate
 * @param {Object|null} baseState - Starting state before these transactions
 * @returns {{ valid: boolean, violations: Array }}
 */
function validateBlock(txs, baseState) {
    const shadow = {
        characters:    { ...(baseState?.characters    || {}) },
        factions:      { ...(baseState?.factions      || {}) },
        relationships: { ...(baseState?.relationships || {}) },
        constraints:   { ...(baseState?.constraints   || {}) },
        collisions:    { ...(baseState?.collisions     || {}) },
        combats:       { ...(baseState?.combats        || {}) },
        places:        { ...(baseState?.places         || {}) },
        pressures:     { ...(baseState?.pressures      || {}) },
        world:         { ...(baseState?.world          || {}) },
        divination:    { ...(baseState?.divination     || {}) },
        pc:            baseState?.pc ? { ...baseState.pc } : {},
        lastTxId:      baseState?.lastTxId ?? -1,
        _history:      {},
    };
    const violations = [];
    // Identify dropped txs by object reference — tx.tx is unassigned pre-commit
    // (normalizeTransactions stamps it during append), so keying on tx.tx would
    // collapse every tx in the block to the same `undefined` key and cause the
    // caller's filter to drop the entire batch on any single violation.
    const droppedTxs = new Set();

    // Pre-pass: collect entities that will be CR'd in this block so per-tx
    // validators (scene_cast refs, relationship target) can tolerate forward
    // references. Maps store tier so the relationship target check can honor
    // the pending CR's tier instead of falling back to "entity missing".
    const pendingCreations = {
        char: new Map(),
        faction: new Map(),
        place: new Set(),
    };
    for (const tx of txs) {
        if (tx.op !== 'CR') continue;
        if (tx.e === 'char') pendingCreations.char.set(tx.id, tx.d?.tier || 'KNOWN');
        else if (tx.e === 'faction') pendingCreations.faction.set(tx.id, tx.d?.tier || 'KNOWN');
        else if (tx.e === 'place') pendingCreations.place.add(tx.id);
    }

    const applyTransaction = _applyTransactionFromCompute;
    for (const tx of txs) {
        const perTx = validateTransaction(tx, shadow, pendingCreations);
        if (!perTx.valid) {
            violations.push(...perTx.violations.map(v => ({ ...v, tx: tx.tx })));
            droppedTxs.add(tx);
            continue; // skip applying — keep walking the rest of the block
        }
        // Deep-clone the entity being modified so shadow never mutates baseState objects.
        // Must cover all ops (A, R, MS, MR, etc.) not just TR/S.
        const coll = ENTITY_TO_COLLECTION[tx.e];
        if (coll && shadow[coll] && shadow[coll][tx.id] !== undefined) {
            shadow[coll][tx.id] = structuredClone(shadow[coll][tx.id]);
        }
        try {
            applyTransaction(shadow, tx);
        } catch (e) {
            violations.push({ field: '_apply', message: `applyTransaction threw: ${e.message}`, tx: tx.tx });
            droppedTxs.add(tx);
        }
    }
    return { valid: violations.length === 0, violations, droppedTxs };
}

export {
    validateBatch,
    validateFormat,
    validateTransitions,
    findMissingArchiveEntries,
    formatErrors,
    validateTransaction,
    validateBlock,
    VALID_OPS,
    VALID_ENTITIES,
};
