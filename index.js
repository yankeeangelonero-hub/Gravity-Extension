/**
 * index.js — Gravity Ledger Extension for SillyTavern
 *
 * State machine and append-only ledger for Gravity v10.
 * Storage: chatMetadata (persistent JSON per chat)
 * Injection: setExtensionPrompt at depth 0
 * Format: Command-style lines with self-correcting feedback loop
 */

import { init as initLedger, reset as resetLedger, append, getAllTransactions, getTransactionsForEntity, exportData, importData, compactTransactions, getSnapshots } from './ledger-store.js';
import { initSnapshots, computeCurrentState, createSnapshot, onRollback } from './snapshot-mgr.js';
import { validateBatch, formatErrors, validateTransitions, findMissingArchiveEntries, validateBlock } from './consistency.js';
import { computeState, applyTransaction, createEmptyState, getArrayItemHistory, validateTravel, CATEGORY_DISTANCES, diffStates } from './state-compute.js';
import * as compactor from './ledger-compactor.js';
import { formatStateView, formatReadme, computeArchiveVersion } from './state-view.js';
import { extractUpdateBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning } from './ui-panel.js';
import { isActive as isSetupActive, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback, showSetupPopup, buildSetupPrompt } from './setup-wizard.js';
import { getStateMachineField } from './state-machine.js';
import {
    buildChallengePrompt,
    clearChallengeRuntime,
    getChallengeRuntime,
    handleChallengeActionSelection,
    isChallengeRuntimeActive,
    isChallengeSessionLocked,
    getActiveProfile,
    getActiveChallengeDeductionType,
    processChallengeAssistantTurn,
    startChallengeRuntime,
} from './challenge-state.js';
import { detectChallengePrefix } from './challenge-profiles.js';

const MODULE_NAME = 'gravity-ledger';
const LOG_PREFIX = '[GravityLedger]';

// extension_prompt_types: NONE=-1, IN_PROMPT=0, IN_CHAT=1
const PROMPT_NONE = -1;
const PROMPT_IN_CHAT = 1;

// ─── State ─────────────────────────────────────────────────────────────────────

let _initialized = false;
let _currentState = null;
let _turnCounter = 0;
let _autoSnapshotInterval = 15;
let _currentChatId = null;

// ─── Self-Correcting Feedback ──────────────────────────────────────────────────

const MAX_CORRECTION_ATTEMPTS = 3;
let _pendingCorrections = [];
let _pendingReinforcement = null;
let _pendingOOCInjection = null;
let _uncappedTurn = false;
let _currentInjectMode = 'regular';
let _currentReasonMode = 'regular';
let _lastCompletedMode = 'regular'; // snapshot before reset — used by exemplar flagging
let _pendingDeductionType = null; // one-shot override for combat, advance, intimacy
let _pendingManualDivination = null; // one-shot player-supplied divination roll

// ─── Collision Arrival / Foreshadow Tracking ─────────────────────────────────
// One-shot dedup: once a collision fires the sanity-check gate it doesn't fire again.
// Foreshadow Set: collision ids that have already fired their single foreshadow trigger.
// Both reset on chat change, snapshot rollback, and import.
let _firedCollisionArrivals = new Set();
let _foreshadowedCollisions = new Set();

// Foreshadow percentage thresholds — must match the pipeline in buildForeshadowLines().
// Single foreshadow trigger per collision, fired when distance <= the per-category
// absolute threshold below. IMMEDIATE collisions never foreshadow (they fire on creation).
const FORESHADOW_DISTANCES = { SHORT: 2, MEDIUM: 3, LONG: 7 };

/**
 * Reconstruct _firedCollisionArrivals and _foreshadowedCollisions from current state.
 * Called during initialize(), handleRevertTurn(), and any rollback path so that
 * stale Set entries don't survive a page reload or revert.
 *
 * RESOLVED/CRASHED collisions go straight into `fired` (arrival already happened).
 * ACTIVE collisions already past their per-category foreshadow distance populate `foreshadow`.
 * ACTIVE distance-0 collisions are NOT pre-seeded into `fired` — the arrival pipeline
 * catches them naturally on the next turn (pre-seeding would suppress an arrival that
 * never actually fired, e.g. if the user closed the tab before the LLM responded).
 */
function reconstructArrivalState(state) {
    const fired = new Set();
    const foreshadow = new Set();
    const collisions = state?.collisions || {};
    for (const [id, col] of Object.entries(collisions)) {
        if (!col) continue;
        if (col.status === 'RESOLVED' || col.status === 'CRASHED') {
            fired.add(id);
            continue;
        }
        if (col.status !== 'ACTIVE') continue;
        if (col.distance_category === 'IMMEDIATE') continue;
        const threshold = FORESHADOW_DISTANCES[col.distance_category];
        if (typeof threshold !== 'number') continue;
        const dist = typeof col.distance === 'number' ? col.distance : parseFloat(col.distance);
        if (isNaN(dist) || dist <= 0) continue;
        if (dist <= threshold) foreshadow.add(id);
    }
    return { fired, foreshadow };
}

// Dedup keys for relationship-module corrections (§13 — missing relationship,
// orphaned relational collision, missing rel update, scene cast overflow).
// Cleared on chat change, rollback, import, and when the underlying condition resolves.
let _firedRelationshipCorrections = new Set();

// Advance tick multipliers — collisions tick by this much per advance scale (§3.2)
const TICK = { HOURS: 1, DAYS: 3, WEEKS: 10, MONTHS: 20 };
// Phase 2: Pool caps (§4.1, §4.2, §2.2.1)
const MAX_PRESSURE_POINTS = 5;
const MAX_COLLISIONS = 5;
const MAX_COLLISION_ARCHIVE = 20;
let _advanceLocked = false;
// Tracks the last turn on which buildAndInjectArrivals fired — prevents injectPrompt from
// clearing the _arrival slot on the same turn an IMMEDIATE collision arrived.
let _arrivalLastFiredTurn = -1;
let _archiveCorrectionAttempts = new Map(); // collision id → attempt count for archive-presence corrections
let _archiveInjectedVersion = null; // hash: `${archiveLength}:${thin|ok}` — see §4.3
let _pendingNudgeText = null; // rotating nudge maintenance text for next injectPrompt call (§4.4)
// Idempotency guard for injectPrompt — GENERATION_STARTED re-fires injectPrompt within the same
// turn (and on swipes/regens, where onMessageReceived doesn't run). On the second call we replay
// the snapshotted one-shot values instead of remutating consumption flags.
let _injectFingerprint = 0;
let _lastInjectFingerprint = -1;
let _lastInjectSnapshot = null;

// Phase 2: Rotating nudge system chatMetadata keys (§4.4)
const NUDGE_COUNTER_KEY = 'gravity_nudge_counter';
const NUDGE_SLOT_KEY = 'gravity_nudge_slot';
const NUDGE_ROTATION_INDEX_KEY = 'gravity_nudge_rotation_index';
const NUDGE_SLOT_NAMES = ['agenda_check', 'pressure_scan', 'consolidation_check', 'collision_health', 'relationship_pulse', 'collision_validity', 'destroyed_cleanup'];

const ARCANA_TABLE = [
    'The Fool — A leap into the unknown. Something begins that nobody planned.',
    'The Magician — Resources align. Skill meets opportunity.',
    'The High Priestess — Hidden knowledge surfaces. Intuition over logic.',
    'The Empress — Abundance, shelter, aid. The world provides.',
    'The Emperor — Authority intervenes. Structure, control, hierarchy.',
    'The Hierophant — Tradition and institutions assert themselves.',
    'The Lovers — A choice between two paths. Relationship tested.',
    'The Chariot — Willpower overcomes. Victory through determination.',
    'Strength — Quiet power. Patience defeats force.',
    'The Hermit — Isolation clarifies. Truth found in solitude.',
    'Wheel of Fortune — Fate intervenes. What was rising falls. What was falling rises.',
    'Justice — Consequences arrive precisely. The math is exact.',
    'The Hanged Man — Sacrifice or suspension. New perspective from discomfort.',
    'Death — Transformation. Something ends so something else can exist.',
    'Temperance — Balance and synthesis. The middle path works this time.',
    'The Devil — Chains chosen or discovered. The comfortable trap.',
    'The Tower — Catastrophic revelation. A structure collapses. No one is ready.',
    'The Star — Hope after devastation. The reason to keep going.',
    'The Moon — Deception, illusion, fear. Nothing is what it appears.',
    'The Sun — Clarity and success. The rare clean win.',
    'Judgement — Reckoning. The past demands an answer.',
    'The World — Completion. A cycle closes. The full picture visible.',
];

const ARCANA_ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];

const CLASSIC_TABLE = `| Roll | Conditions |
| 2 | Worst conditions. Maximum preparation on opposing side. A second complication compounds the first. The board shifts. |
| 3-5 | Heavy. The force arrives prepared and hostile. No easy angles. |
| 6-9 | Hard. Direct, no advantages for anyone. Exactly as serious as it looks. |
| 10-14 | Contested. Mixed signals, incomplete information. Neither side has clean advantage. |
| 15-18 | Exploitable. A vulnerability, a gap, a piece of timing that gives an opening. |
| 19 | Favorable. The force arrives weakened, distracted, or compromised. |
| 20 | The board changes shape. A second collision crashes into the first. Nobody predicted this. |
2 and 20 are special. Both reshape the board. Dice never override logic.`;

const NARRATIVE_FORCING = 'NARRATIVE FORCING: The draw must visibly alter the scene — not just color the mood. Something HAPPENS because of this draw. A person appears, a plan fails, a door opens, a body drops, a truth surfaces. The draw is not a metaphor — it is an event. Find the coolest, most unexpected intersection with the current scene and MAKE IT HAPPEN in the prose.\nDO NOT call any dice tool or function. DO NOT use the D&D Dice tool. The number above was generated by the extension — it IS the result. Just use it.';

// ─── Advance Focus Randomizer ──────────────────────────────────────────────

const ADVANCE_FOCUS_TABLE = [
    { key: 'scene',      weight: 30, label: 'Scene' },
    { key: 'world',      weight: 20, label: 'World Politics' },
    { key: 'offscreen',  weight: 20, label: 'Off-screen Character' },
    { key: 'new_threat', weight: 15, label: 'New Threat/Event' },
    { key: 'collision',  weight: 15, label: 'Collision Tightens' },
];

const MODE_LOREBOOK_KEYS = Object.freeze({
    intimacyCore: 'gravity_mode_intimacy_core',
    intimacyOptional: 'gravity_mode_intimacy_optional_examples',
    // prose modulation keys (fired alongside mode gameplay keys)
    proseRegular: 'gravity_prose_regular',
    proseIntimacy: 'gravity_prose_intimacy',
});

function getCollectionForEntityType(state, entityType) {
    if (!state || !entityType) return null;
    const map = {
        char: state.characters,
        constraint: state.constraints,
        collision: state.collisions,
        combat: state.combats,
        faction: state.factions,
        world: state.world,
        pc: state.pc,
        divination: state.divination,
    };
    return map[entityType] || null;
}

function valuesEquivalent(a, b) {
    if (a === b) return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function rewriteDuplicateActiveChallengeCreate(transactions, state) {
    const runtime = getChallengeRuntime();
    if (!runtime?.entity_type || !runtime?.entity_id || !Array.isArray(transactions) || transactions.length === 0) {
        return { transactions, rewrittenCount: 0 };
    }

    const collection = getCollectionForEntityType(state, runtime.entity_type);
    const existing = ['world', 'pc', 'divination'].includes(runtime.entity_type)
        ? collection
        : collection?.[runtime.entity_id];
    if (!existing) return { transactions, rewrittenCount: 0 };

    let rewrittenCount = 0;
    const rewritten = [];

    for (const tx of transactions) {
        if (tx?.op !== 'CR' || tx.e !== runtime.entity_type || tx.id !== runtime.entity_id) {
            rewritten.push(tx);
            continue;
        }

        rewrittenCount++;
        const reason = tx.r
            ? `${tx.r} | system:challenge-engine:rewrite-duplicate-create`
            : 'system:challenge-engine:rewrite-duplicate-create';

        for (const [field, value] of Object.entries(tx.d || {})) {
            if (field === 'id' || valuesEquivalent(existing?.[field], value)) continue;
            const stateField = getStateMachineField(tx.e, field);
            if (stateField) {
                // Read current value from state so TR has a valid `from`; skip if none exists
                const currentFieldValue = existing?.[field];
                if (currentFieldValue === undefined || currentFieldValue === null) continue;
                rewritten.push({
                    op: 'TR',
                    e: tx.e,
                    id: tx.id,
                    d: { f: field, from: currentFieldValue, to: value },
                    r: reason,
                });
            } else {
                rewritten.push({
                    op: 'S',
                    e: tx.e,
                    id: tx.id,
                    d: { f: field, v: value },
                    r: reason,
                });
            }
        }
    }

    return { transactions: rewritten, rewrittenCount };
}

function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function inferExemplarCategory(text, modeHint = 'regular') {
    const sample = String(text || '').toLowerCase();
    if (!sample) return modeHint;
    if (/\b(kiss|kissed|mouth|breath|touch|touched|thigh|hip|waist|shoulder|skin|leaned in|leaned against)\b/.test(sample)) return 'intimacy';
    if (/\b(blood|blade|gun|shot|shots|strike|struck|wound|wounds|cover|impact|lunged|swung|knife|rifle|fist)\b/.test(sample)) return 'combat';
    if (/\b(door|threshold|arrived|arrival|walked in|came in|entered|stepped in|stepped through)\b/.test(sample)) return 'arrival';
    if (/\b(meanwhile|elsewhere|off-screen|offscreen|by the time|later|outside|down the street|radio|rumor|order)\b/.test(sample)) return 'advance';
    if (/["“”]/.test(text)) return 'dialogue';
    if (/\b(smell|sound|light|air|floor|wall|window|room|rain|heat|cold|dust|taste)\b/.test(sample)) return 'scene';
    return modeHint;
}

function inferExemplarStrengths(text) {
    const sample = String(text || '').toLowerCase();
    const strengths = [];
    if (/\b(smell|sound|light|air|heat|cold|texture|dust|taste|floor|wall|window)\b/.test(sample)) strengths.push('concrete detail');
    if (/["“”]/.test(text)) strengths.push('dialogue leverage');
    if (/\b(stop|stopped|pause|paused|hesitate|hesitated|recalculation|leaned|pulled back|after)\b/.test(sample)) strengths.push('aftereffect');
    if (/\b(door|arrived|entered|walked in|came in|threshold)\b/.test(sample)) strengths.push('entrance framing');
    if (/\b(blood|wound|impact|cover|breath|strike|shot|blade|gun)\b/.test(sample)) strengths.push('kinetic consequence');
    if (strengths.length === 0) strengths.push('beat control');
    return strengths.slice(0, 2);
}

function normalizeExemplarRecord(exemplar) {
    const source = (typeof exemplar === 'object' && exemplar !== null) ? exemplar : { text: exemplar };
    const text = String(source.text || '').trim();
    if (!text) return null;
    const modeHint = source.mode_hint || source.category || 'regular';
    return {
        text,
        category: source.category || inferExemplarCategory(text, modeHint),
        strengths: Array.isArray(source.strengths) && source.strengths.length
            ? source.strengths.filter(Boolean).slice(0, 2)
            : inferExemplarStrengths(text),
        mode_hint: modeHint,
        turn: source.turn || 0,
        _ts: source._ts || 0,
    };
}

function getExemplarTargets(activeMode, deductionType) {
    if (deductionType === 'combat') return ['combat', 'arrival', 'scene'];
    if (deductionType === 'intimacy') return ['intimacy', 'dialogue', 'scene'];
    if (activeMode === 'advance') return ['advance', 'arrival', 'scene'];
    return ['dialogue', 'scene', 'arrival', 'regular'];
}

function selectExemplarsForPrompt(exemplars, activeMode, deductionType, limit = 3) {
    const normalized = exemplars.map(normalizeExemplarRecord).filter(Boolean);
    if (normalized.length === 0) return [];
    const targets = getExemplarTargets(activeMode, deductionType);
    const scored = normalized.map((ex, idx) => {
        const matchIndex = targets.indexOf(ex.category);
        const matchScore = matchIndex >= 0 ? (targets.length - matchIndex) * 10 : 0;
        return {
            ex,
            idx,
            score: matchScore + idx / 1000 + (ex._ts || 0) / 1e15,
        };
    });
    scored.sort((a, b) => b.score - a.score);
    const chosen = [];
    const seen = new Set();
    for (const { ex } of scored) {
        if (seen.has(ex.text)) continue;
        chosen.push(ex);
        seen.add(ex.text);
        if (chosen.length >= limit) break;
    }
    if (chosen.length === 0) {
        return normalized.slice(-limit);
    }
    return chosen;
}

function formatExemplarForPrompt(exemplar, index) {
    const tags = [exemplar.category, ...(exemplar.strengths || []).slice(0, 2)].filter(Boolean);
    const label = tags.length ? `[${tags.join(' | ')}] ` : '';
    return `  ${index + 1}. ${label}"${exemplar.text}"`;
}

function buildLorebookTriggerBlock(keys = []) {
    const active = uniqueStrings(keys);
    if (active.length === 0) return '';
    return `[WORLD INFO TRIGGERS - DO NOT ECHO:
${active.join('\n')}
]`;
}

function buildModeInjection(title, body, keys = []) {
    const sections = [`[${title}]`];
    const triggerBlock = buildLorebookTriggerBlock(keys);
    if (triggerBlock) sections.push(triggerBlock);
    if (body) sections.push(body.trim());
    return sections.join('\n\n');
}

function formatDrawInstruction(draw, guidance) {
    if (!draw) return guidance || '';
    const sections = [`${draw.label}: ${draw.reading}`];
    if (draw.html) {
        sections.push(`Render this HTML card reveal in visible output before the prose scene, never inside hidden reasoning:\n${draw.html}`);
    }
    if (guidance) sections.push(guidance);
    return sections.join('\n');
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function stringSimilarity(a, b) {
    if (a === b) return 1;
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const lower = s => normalizeText(s).toLowerCase();
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

function getCollisionForcesText(col) {
    if (Array.isArray(col?.forces)) {
        return col.forces
            .map(force => normalizeText(force?.name || force))
            .filter(Boolean)
            .join(', ');
    }
    return normalizeText(col?.forces);
}

function buildCollisionStoryCapsule(id, col) {
    const lines = [];
    const forces = getCollisionForcesText(col);
    const location = normalizeText(col?.location);
    const involvedChars = Array.isArray(col?.involved_chars) ? col.involved_chars.filter(Boolean) : [];
    if (forces) lines.push(`Forces: ${forces}`);
    else lines.push(`Collision: ${col?.name || id}`);
    if (location) lines.push(`Location: ${location}`);
    if (involvedChars.length) lines.push(`Involved: ${involvedChars.join(', ')}`);
    return lines.join('\n');
}

function buildCollisionNarrativeWarnings(id, col, status) {
    const warnings = [];
    const name = col?.name || id;
    const forces = getCollisionForcesText(col);
    const location = normalizeText(col?.location);
    const involvedChars = Array.isArray(col?.involved_chars) ? col.involved_chars.filter(Boolean) : [];

    if (!forces) {
        warnings.push(`"${name}" is ${status} but missing forces — SET collision:${id}.forces so the pressure has named poles.`);
    }
    if (status === 'ACTIVE' && !location) {
        warnings.push(`"${name}" is ${status} but missing location — SET collision:${id}.location so the pressure is grounded in a place.`);
    }
    if (status === 'ACTIVE' && !involvedChars.length) {
        warnings.push(`"${name}" is ${status} but no involved_chars — APPEND collision:${id}.involved_chars so the pressure has a cast.`);
    }

    return warnings;
}

/**
 * Get the active divination system. Checks chatMetadata first, then ledger state.
 */
function getActiveDivinationSystem() {
    const { chatMetadata } = SillyTavern.getContext();
    const stored = chatMetadata?.['gravity_divination_system'];
    return stored || (_currentState?.divination?.active_system || 'arcana').toLowerCase();
}

/**
 * Set the active divination system.
 */
async function setDivinationSystem(system) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata['gravity_divination_system'] = system;
    await saveMetadata();
}

function getNarrativeForcingText(source = 'extension') {
    if (source === 'manual') {
        return 'NARRATIVE FORCING: The draw must visibly alter the scene — not just color the mood. Something HAPPENS because of this draw. A person appears, a plan fails, a door opens, a body drops, a truth surfaces. The draw is not a metaphor — it is an event. Find the coolest, most unexpected intersection with the current scene and MAKE IT HAPPEN in the prose.\nDO NOT call any dice tool or function. DO NOT use the D&D Dice tool. The number above came from the player\'s manual roll — it IS the result. Just use it.';
    }
    return NARRATIVE_FORCING;
}

function normalizeManualArcanaIndex(rawResult) {
    const result = Number(rawResult);
    if (!Number.isInteger(result)) return null;
    if (result >= 1 && result <= 22) return result - 1;
    if (result >= 0 && result <= 21) return result;
    return null;
}

function parseManualDivinationOverride(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const arcanaPatterns = [
        /\b(?:1d22|d22)\b\s*(?:=|:|->|=>)\s*(\d{1,2})\b/i,
        /\b(?:1d22|d22)\b\s*\(\s*(\d{1,2})\s*\)/i,
        /\brolled?\s*(\d{1,2})\s*(?:on|from)\s*(?:1d22|d22)\b/i,
    ];
    for (const pattern of arcanaPatterns) {
        const match = raw.match(pattern);
        if (!match) continue;
        const manualResult = Number(match[1]);
        const num = normalizeManualArcanaIndex(manualResult);
        if (num == null) continue;
        return {
            system: 'arcana',
            num,
            sourceText: `1d22 = ${manualResult}${manualResult >= 1 && manualResult <= 22 ? ` -> #${num}` : ''}`,
        };
    }

    const classicPatterns = [
        /\b(?:2d10|1d10\s*\+\s*1d10)\b\s*(?:=|:|->|=>)\s*(\d{1,2})\b/i,
        /\b(?:2d10|1d10\s*\+\s*1d10)\b\s*\(\s*(\d{1,2})\s*\)/i,
        /\brolled?\s*(\d{1,2})\s*(?:on|from)\s*(?:2d10|1d10\s*\+\s*1d10)\b/i,
    ];
    for (const pattern of classicPatterns) {
        const match = raw.match(pattern);
        if (!match) continue;
        const total = Number(match[1]);
        if (!Number.isInteger(total) || total < 2 || total > 20) continue;
        return {
            system: 'classic',
            num: total,
            sourceText: `2d10 = ${total}`,
        };
    }

    return null;
}

function consumeManualDivinationOverride() {
    const manual = _pendingManualDivination;
    _pendingManualDivination = null;
    return manual;
}

function buildClassicDraw(total, source = 'extension', sourceText = '', d1 = null, d2 = null) {
    const prefix = source === 'manual' && sourceText ? `MANUAL ROLL: ${sourceText}\n` : '';
    const rollLine = Number.isInteger(d1) && Number.isInteger(d2)
        ? `${d1} + ${d2} = ${total}`
        : `Total = ${total}`;
    return {
        system: 'classic',
        label: 'THE DICE ROLLED',
        num: total,
        reading: `${prefix}${rollLine}\n${CLASSIC_TABLE}\n${getNarrativeForcingText(source)}`,
        html: '',
    };
}

function buildArcanaDraw(num, source = 'extension', sourceText = '') {
    const cardName = ARCANA_TABLE[num].split(' — ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' — ')[1] || '';
    const cardSlug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const prefix = source === 'manual' && sourceText ? `MANUAL ROLL: ${sourceText}\n` : '';
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
        cardName,
        cardSlug,
        reading: `${prefix}#${num} — ${ARCANA_TABLE[num]}\nUSE THIS EXACT CARD. Do not override or pick a different one.\n${getNarrativeForcingText(source)}`,
        html: `<div style="background:linear-gradient(180deg,#0a0a1a 0%,#1a0a2e 100%);border:1px solid #d4af37;border-radius:8px;padding:20px;margin:16px auto;max-width:280px;text-align:center;box-shadow:0 0 15px rgba(212,175,55,0.2);"><div style="color:#d4af37;font-size:0.75em;letter-spacing:3px;text-transform:uppercase;">The Arcana</div><div style="color:#f0e6d3;font-size:1.8em;margin:12px 0 4px 0;font-weight:bold;">${cardName}</div><div style="color:#d4af37;font-size:0.9em;font-style:italic;">${ARCANA_ROMAN[num]}</div><div style="width:40px;height:1px;background:#d4af37;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.4;">${cardMeaning}</div></div>`,
    };
}

/**
 * Draw from the active divination system.
 * @returns {{ system: string, label: string, num: number, reading: string, html: string }}
 */
function drawDivination() {
    const manual = consumeManualDivinationOverride();
    if (manual?.system === 'classic') {
        return buildClassicDraw(manual.num, 'manual', manual.sourceText);
    }
    if (manual?.system === 'arcana') {
        return buildArcanaDraw(manual.num, 'manual', manual.sourceText);
    }

    const system = getActiveDivinationSystem();

    if (system === 'classic') {
        const d1 = Math.floor(Math.random() * 10) + 1;
        const d2 = Math.floor(Math.random() * 10) + 1;
        const total = d1 + d2;
        return {
            system: 'classic',
            label: 'THE DICE ROLLED',
            num: total,
            cardSlug: null,
            reading: `${d1} + ${d2} = ${total}\n${CLASSIC_TABLE}\n${NARRATIVE_FORCING}`,
            html: '',
        };
    }

    // Default: arcana (d22, 0-indexed)
    const num = Math.floor(Math.random() * 22);
    const cardName = ARCANA_TABLE[num].split(' — ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' — ')[1] || '';
    const cardSlug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
        cardName,
        cardSlug,
        reading: `#${num} — ${ARCANA_TABLE[num]}\nUSE THIS EXACT CARD. Do not override or pick a different one.\n${NARRATIVE_FORCING}`,
        html: `<div style="background:linear-gradient(180deg,#0a0a1a 0%,#1a0a2e 100%);border:1px solid #d4af37;border-radius:8px;padding:20px;margin:16px auto;max-width:280px;text-align:center;box-shadow:0 0 15px rgba(212,175,55,0.2);"><div style="color:#d4af37;font-size:0.75em;letter-spacing:3px;text-transform:uppercase;">The Arcana</div><div style="color:#f0e6d3;font-size:1.8em;margin:12px 0 4px 0;font-weight:bold;">${cardName}</div><div style="color:#d4af37;font-size:0.9em;font-style:italic;">${ARCANA_ROMAN[num]}</div><div style="width:40px;height:1px;background:#d4af37;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.4;">${cardMeaning}</div></div>`,
    };
}

/**
 * Add failed lines to the correction queue.
 * If a line has been retried too many times, drop it.
 */
function queueCorrections(errors) {
    for (const err of errors) {
        // Check if this line is already in the queue (same raw text)
        const existing = _pendingCorrections.find(c => c.raw === err.raw);
        if (existing) {
            existing.attempts++;
            existing.error = err.error;
            if (existing.attempts >= MAX_CORRECTION_ATTEMPTS) {
                console.warn(`${LOG_PREFIX} Dropping correction after ${MAX_CORRECTION_ATTEMPTS} attempts: ${err.raw.substring(0, 60)}`);
                _pendingCorrections = _pendingCorrections.filter(c => c !== existing);
            }
        } else {
            _pendingCorrections.push({ ...err, attempts: 1 });
        }
    }
}

/**
 * Returns true when the engine-pushed correction condition still applies.
 * Called by clearMatchedCorrections to drop engine raws whose underlying
 * condition is satisfied without waiting for an LLM entity match.
 */
function engineConditionStillTrue(entityType, entityId, condition, state) {
    if (entityType === 'collision' && condition === 'missing-distance-category') {
        const c = state?.collisions?.[entityId];
        return !!c && !c.distance_category;
    }
    if (entityType === 'pressure' && condition === 'excess-created-at-tx') {
        // Once the engine has stamped created_at_tx, the warning is moot — always clear.
        return false;
    }
    if (entityType === 'char' && condition === 'missing-agenda-on-promotion') {
        const c = state?.characters?.[entityId];
        return !!c && (c.tier === 'TRACKED' || c.tier === 'PRINCIPAL') && !c.agenda;
    }
    if (entityType === 'collision' && condition === 'pool-cap-exceeded') {
        const activeNonImmediate = Object.values(state?.collisions || {})
            .filter(c => (c.status || '').toUpperCase() === 'ACTIVE' && c.distance_category !== 'IMMEDIATE');
        return activeNonImmediate.length > MAX_COLLISIONS;
    }
    return false;
}

/**
 * Check if incoming transactions fix any pending corrections.
 * A correction is "fixed" if a new valid transaction matches the same entity+op.
 */
function clearMatchedCorrections(committedTxns) {
    if (_pendingCorrections.length === 0) return;

    _pendingCorrections = _pendingCorrections.filter(corr => {
        // Engine-pushed corrections may lack `raw`; they fall through to attempt-count expiry.
        for (const tx of committedTxns) {
            if (!tx.id || !corr.raw) continue;
            // Match the full entity:id token to prevent partial-id collisions (e.g. char:ada vs char:adam)
            const fullToken = tx.e ? `${tx.e}:${tx.id}` : null;
            if (fullToken && corr.raw.includes(fullToken)) return false;
            // Fallback: bare id with non-word-char boundaries (capture-group form avoids lookbehind for ES2017 compat)
            const escapedId = tx.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const bareRe = new RegExp('(^|[^\\w:])' + escapedId + '(?![\\w:])');
            if (bareRe.test(corr.raw)) return false;
        }
        return true;
    });

    // Engine corrections (raw starting with '[engine:') clear when their underlying
    // condition is satisfied, rather than waiting for an LLM entity match.
    const stillNeeded = new Set();
    for (const corr of _pendingCorrections) {
        if (!corr.raw || !corr.raw.startsWith('[engine:')) continue;
        const m = corr.raw.match(/^\[engine:(\w+):([^:]+):([^\]]+)\]$/);
        if (!m) continue;
        const [, entityType, entityId, condition] = m;
        if (engineConditionStillTrue(entityType, entityId, condition, _currentState)) {
            stillNeeded.add(corr.raw);
        }
    }
    _pendingCorrections = _pendingCorrections.filter(corr => {
        if (!corr.raw || !corr.raw.startsWith('[engine:')) return true;
        return stillNeeded.has(corr.raw);
    });
}

// ─── State View Mode ──────────────────────────────────────────────────────────

/**
 * Determine which state view mode to use based on turn context.
 *   lite     — regular turns without combat/intimacy
 *   combat   — combat challenge active or combat deduction
 *   intimacy — intimacy deduction active
 *   full     — advance, integration, setup
 */
function getStateViewMode(isRegular, isAdvance, isIntegration, challengeRuntimeActive, reasonMode) {
    if (isIntegration) return 'full';
    if (isAdvance) return 'full';
    if (challengeRuntimeActive) return 'combat';
    if (reasonMode === 'intimacy') return 'intimacy';
    if (reasonMode === 'combat') return 'combat';
    return 'lite';
}

// ─── Visible Ledger ────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Format committed transactions as visible HTML for the chat message.
 */
function formatCommittedTxnsHtml(committedTxns) {
    if (!committedTxns?.length) return '';
    const lines = [];
    for (const tx of committedTxns) {
        const entityRef = tx.id ? `${tx.e}:${tx.id}` : tx.e;
        const field = tx.d?.f || '';
        const value = tx.d?.v ?? tx.d?.to ?? '';
        if (tx.op === 'TR') {
            lines.push(`${entityRef}.${field} ${tx.d.from} → ${tx.d.to}`);
        } else if (tx.op === 'S') {
            lines.push(`${entityRef}.${field} → "${value}"`);
        } else if (tx.op === 'CR') {
            lines.push(`+ ${entityRef} (${tx.d?.name || tx.d?.tier || 'created'})`);
        } else if (tx.op === 'D') {
            lines.push(`- ${entityRef} (destroyed)`);
        } else if (tx.op === 'A') {
            if (field) {
                lines.push(`${entityRef}.${field}+ "${value}"`);
            }
        } else if (tx.op === 'R') {
            lines.push(`${entityRef}.${field}- "${value}"`);
        } else if (tx.op === 'MS') {
            const key = tx.d?.k || '';
            lines.push(`${entityRef}.${field}.${key} → "${value}"`);
        } else if (tx.op === 'MR') {
            const key = tx.d?.k || '';
            lines.push(`${entityRef}.${field}.${key} (removed)`);
        }
    }
    if (lines.length === 0) return '';
    const lineHtml = lines.map(l => `<div class="gl-ledger-line">${escapeHtml(l)}</div>`).join('\n');
    return `\n<div class="gl-ledger-display"><div class="gl-ledger-header">STATE</div>\n${lineHtml}\n</div>`;
}

// ─── Prompt Injection ──────────────────────────────────────────────────────────

function getStateTarget(state, entityType, entityId) {
    if (!state) return null;
    if (entityType === 'world') return state.world || null;
    if (entityType === 'pc') return state.pc || null;
    if (entityType === 'divination') return state.divination || null;

    const collections = {
        char: state.characters,
        constraint: state.constraints,
        collision: state.collisions,
        combat: state.combats,
        faction: state.factions,
        place: state.places,
        pressure: state.pressures,
    };
    return collections[entityType]?.[entityId] || null;
}

function compileStateEntries(stateEntries, currentState) {
    const workingState = currentState ? structuredClone(currentState) : createEmptyState();
    let activeTimestamp = '';
    const transactions = [];
    const errors = [];

    for (let i = 0; i < stateEntries.length; i++) {
        const entry = stateEntries[i];
        if (entry.kind === 'timestamp') {
            activeTimestamp = entry.timestamp || '';
            continue;
        }

        let tx = null;

        if (entry.kind === 'directTx') {
            tx = { ...entry.tx };
        } else if (entry.kind === 'scene') {
            tx = { op: 'S', e: 'pc', id: '', d: { f: 'current_scene', v: entry.value } };
        } else {
            const target = getStateTarget(workingState, entry.entityType, entry.entityId);
            const requiresExistingTarget = !['world', 'pc', 'divination'].includes(entry.entityType);
            if (requiresExistingTarget && !target) {
                errors.push({
                    lineNum: i + 1,
                    error: `STATE target ${entry.entityType}:${entry.entityId} not found. Use the exact id from Gravity_State_View or CREATE it first.`,
                    raw: entry.raw || `[state ${i + 1}]`,
                });
                continue;
            }
            const currentValue = entry.key != null ? target?.[entry.field]?.[entry.key] : target?.[entry.field];
            const machineField = getStateMachineField(entry.entityType);

            if (entry.kind === 'append') {
                tx = { op: 'A', e: entry.entityType, id: entry.entityId, d: { f: entry.field, v: entry.value } };
            } else if (entry.kind === 'remove') {
                if (entry.key != null) {
                    tx = { op: 'MR', e: entry.entityType, id: entry.entityId, d: { f: entry.field, k: entry.key } };
                } else {
                    tx = { op: 'R', e: entry.entityType, id: entry.entityId, d: { f: entry.field, v: entry.value } };
                }
            } else if (entry.kind === 'set') {
                // No-op prevention: skip if value unchanged (E)
                if (entry.key == null && currentValue != null && String(currentValue) === String(entry.value)) {
                    continue; // silently drop — value already matches
                }
                if (entry.key != null) {
                    if (entry.value === null) {
                        tx = { op: 'MR', e: entry.entityType, id: entry.entityId, d: { f: entry.field, k: entry.key } };
                    } else {
                        // No-op prevention for map_set
                        const mapCurrent = target?.[entry.field]?.[entry.key];
                        if (mapCurrent != null && String(mapCurrent) === String(entry.value)) {
                            continue; // silently drop — map value already matches
                        }
                        tx = { op: 'MS', e: entry.entityType, id: entry.entityId, d: { f: entry.field, k: entry.key, v: entry.value } };
                    }
                } else if (machineField === entry.field && target && currentValue != null && String(currentValue) !== String(entry.value) && entry.value !== '') {
                    tx = { op: 'TR', e: entry.entityType, id: entry.entityId, d: { f: entry.field, from: currentValue, to: entry.value } };
                } else {
                    tx = { op: 'S', e: entry.entityType, id: entry.entityId, d: { f: entry.field, v: entry.value } };
                }
            }
        }

        if (!tx) {
            errors.push({ lineNum: i + 1, error: 'Unsupported STATE line', raw: entry.raw || `[state ${i + 1}]` });
            continue;
        }

        if (!tx.t && activeTimestamp) tx.t = activeTimestamp;
        transactions.push(tx);

        try {
            applyTransaction(workingState, {
                tx: -(i + 1),
                t: tx.t || '',
                _ts: '',
                op: tx.op,
                e: tx.e,
                id: tx.id || '',
                d: tx.d || {},
                r: tx.r || '',
            });
        } catch (err) {
            console.warn(`${LOG_PREFIX} Working-state apply failed for compiled STATE entry:`, err);
        }
    }

    return { transactions, errors };
}

// ─── Collision Arrival Pipeline (§3.3, §3.5) ─────────────────────────────────

function checkProximity(col, state) {
    if (!col.location) return 'unknown';
    const involvedChars = (col.involved_chars || [])
        .map(id => state.characters[id])
        .filter(Boolean);
    if (involvedChars.length === 0) return 'unknown';
    const atLocation = involvedChars.filter(c => c.location === col.location);
    if (atLocation.length > 0) return 'on-screen-plausible';
    return 'off-screen-likely';
}

function buildInvolvedCharsSummary(col, state) {
    const ids = Array.isArray(col.involved_chars) ? col.involved_chars : [];
    if (ids.length === 0) return 'unknown';
    return ids.map(id => {
        const c = state.characters[id];
        if (!c) return id;
        const locName = c.location ? (state.places?.[c.location]?.name || c.location) : null;
        return locName ? `${c.name || id} @ ${locName}` : (c.name || id);
    }).join(', ');
}

// Build the single-turn arrival sanity-check block injected via the _arrival slot (§3.5).
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
    const immediateNote = col.distance_category === 'IMMEDIATE'
        ? '\nThis collision arrives immediately — brief, sharp, decisive. Resolve in this scene.'
        : '';
    const costLine = col.cost ? `\nScenario: ${col.cost}` : '';
    const ignitionLine = (col.ignition_class || col.fires_when)
        ? `\nIgnition: ${(col.ignition_class || 'clock').toLowerCase()}${col.fires_when ? ` — fires when ${col.fires_when}` : ''}`
        : '';
    const triggerCheck = col.fires_when
        ? `\nTRIGGER CHECK: Does the current scene satisfy "${col.fires_when}"? If not, prefer DISSOLVE or IMPLODE — do not force a scene the declared trigger has not earned.`
        : '';
    return `[GRAVITY — COLLISION ARRIVED: "${col.name || col.id}"]
Draw: ${draw.label} — ${draw.reading}

Forces: ${col.forces || '(unspecified)'}${costLine}${ignitionLine}
Involved: ${involvedSummary}
Anchored at: ${placeName || 'unspecified'}
${proximityLine}${immediateNote}

PRE-EMPTION CHECK: Has the player already addressed the scenario above? If so, DISSOLVE — do not force a scene the narrative has already handled.${triggerCheck}

SANITY CHECK — commit one of these NOW:

  ON-SCREEN — The collision's forces are present in this scene. Make it the central beat.
    Write it arriving. Then in the ledger:
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DIRECT
      S collision:${col.id} field=aftermath value="<what permanently changed>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [id ${col.id}] [resolution] on-screen — <how> [hook] <handles> [aftermath] <change>"

  OFF-SCREEN — The forces resolved while characters were elsewhere. Choose:
    A) REFRAME — it mutated. Create a successor.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=EVOLVED
      A collision:${col.id} field=successor_collision_ids value=<new-id>
      CR collision:<new-id> name="..." distance_category=SHORT forces="..." ...
      A world field=collision_archive value="[collision] ${col.name || col.id} [id ${col.id}] [resolution] off-screen — mutated into <new-id> [hook] <handles> [aftermath] <change>"
    B) DISSOLVE — it ended quietly.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DISSOLVED
      S collision:${col.id} field=aftermath value="<one sentence: what changed off-screen>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [id ${col.id}] [resolution] off-screen — dissolved [hook] <any residue> [aftermath] <change>"

  IMPLODE — The narrative has moved completely past this.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=IMPLODED
      S collision:${col.id} field=aftermath value="Imploded — narrative moved on."
      A world field=collision_archive value="[collision] ${col.name || col.id} [id ${col.id}] [resolution] imploded — <why> [hook] none [aftermath] n/a"

CRASHED status — if distance hits 0 and the scene does not engage:
      TR collision:${col.id} field=status from=ACTIVE to=CRASHED
      S collision:${col.id} field=outcome_type value=CRASHED
      S collision:${col.id} field=aftermath value="<consequence of being ignored>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [id ${col.id}] [resolution] crashed — ignored [hook] <consequence threads> [aftermath] <change>"

No multi-turn delay. This collision is decided this turn.
Commit the decision in the ledger this turn. No waiting.`;
}

// ── Per-turn rolling compaction ───────────────────────────────────────────────

async function runPerTurnCompaction() {
    const snapshots = getSnapshots();
    if (snapshots.length === 0) return;  // nothing to do until first snapshot exists
    const oldestRetained = Math.min(...snapshots.map(s => s.lastTxId || 0));
    if (!oldestRetained) return;

    const cheapCompactors = [
        compactor.coalesceLastWriteWins,
        compactor.coalesceMSLastWriteWins,
        compactor.dropDestroyedEntityTxs,
        compactor.cancelAppendRemovePairs,
    ];

    await compactTransactions((all) => {
        const safe = all.filter(tx => tx.tx < oldestRetained);
        const unsafe = all.filter(tx => tx.tx >= oldestRetained);
        const { result, diverged } = compactor.compactWithIntegrityCheck(
            safe, cheapCompactors, computeState, diffStates,
        );
        if (diverged) return all;  // abort cleanly
        return result.concat(unsafe);
    });
}

async function runDeepCompaction() {
    const snapshots = getSnapshots();
    if (snapshots.length === 0) return;
    const oldestRetained = Math.min(...snapshots.map(s => s.lastTxId || 0));

    const deepCompactors = [
        compactor.stripResolvedCollisionIntermediates,
        (txs) => compactor.cullSnapAndRoll(txs, oldestRetained),
    ];

    await compactTransactions((all) => {
        const safe = all.filter(tx => tx.tx < oldestRetained);
        const unsafe = all.filter(tx => tx.tx >= oldestRetained);
        const { result, diverged } = compactor.compactWithIntegrityCheck(
            safe, deepCompactors, computeState, diffStates,
        );
        if (diverged) return all;
        return result.concat(unsafe);
    });
}

async function buildAndInjectArrivals(ids, state) {
    const blocks = [];
    // Collect arrival collisions so we can auto-append their involved_chars to pc.scene_cast
    // AFTER their arrival injection is built (engine-owned convenience write — the party
    // physically walks onto the stage when a collision arrives).
    const arrivalCollisions = [];
    for (const id of ids) {
        if (_firedCollisionArrivals.has(id)) continue;
        _firedCollisionArrivals.add(id);
        const col = state.collisions[id];
        if (!col) continue;
        arrivalCollisions.push(col);
        const draw = drawDivination();
        // Engine auto-commit: record this draw so the LLM never needs to write divination.last_draw
        try {
            await append([{ op: 'S', e: 'divination', id: '', d: { f: 'last_draw', v: draw.label }, r: 'engine:arrival:auto-draw' }]);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Arrival draw auto-commit failed:`, err);
        }
        const proximity = checkProximity(col, state);
        const involvedSummary = buildInvolvedCharsSummary(col, state);
        const placeName = col.location
            ? (state.places?.[col.location]?.name || col.location)
            : null;
        const proximityLine = {
            'on-screen-plausible': 'Involved characters are at this location.',
            'off-screen-likely': 'Involved characters are currently elsewhere.',
            'unknown': 'Character locations relative to this collision are unknown.',
        }[proximity];
        blocks.push(buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine));
    }

    // Auto-cast: for each arriving collision, emit engine A tx on pc.scene_cast for each
    // involved char not already in the cast. Uses bare-id → char:id normalization; pc sentinel skipped.
    if (arrivalCollisions.length > 0 && state?.pc) {
        const currentCast = Array.isArray(state.pc.scene_cast) ? state.pc.scene_cast : [];
        const castSet = new Set(currentCast);
        const autoCastTxns = [];
        for (const col of arrivalCollisions) {
            const involved = Array.isArray(col.involved_chars) ? col.involved_chars : [];
            for (const party of involved) {
                if (!party || party === 'pc') continue;
                const fqRef = String(party).includes(':') ? String(party) : `char:${party}`;
                if (castSet.has(fqRef)) continue;
                // Ensure the char actually exists — skip silently otherwise (state-compute would drop it)
                const bareId = fqRef.startsWith('char:') ? fqRef.slice('char:'.length) : fqRef;
                if (!state.characters?.[bareId]) continue;
                castSet.add(fqRef);
                autoCastTxns.push({
                    op: 'A', e: 'pc', id: '_',
                    d: { f: 'scene_cast', v: fqRef },
                    r: `system:arrival:auto-cast:${col.id}`,
                });
            }
        }
        if (autoCastTxns.length > 0) {
            try {
                const committed = await append(autoCastTxns);
                _currentState = computeState(_currentState, committed);
                console.log(`${LOG_PREFIX} Arrival auto-cast: appended ${committed.length} cast ref(s)`);
            } catch (err) {
                console.warn(`${LOG_PREFIX} Arrival auto-cast append failed:`, err);
            }
        }
    }

    if (blocks.length > 0) {
        if (blocks.length > 1) {
            // Build name list from collisions that actually produced a block — skipped arrivals
            // (already fired, missing entity) must not appear in the "simultaneous" roster.
            const firedNames = ids
                .filter(id => state.collisions[id] && _firedCollisionArrivals.has(id))
                .map(id => `"${state.collisions[id].name || id}"`)
                .slice(0, blocks.length);
            blocks.unshift(`[SIMULTANEOUS ARRIVALS — ${blocks.length} collisions have arrived this turn: ${firedNames.join(', ')}. ONLY ONE may resolve ON-SCREEN. Apply rule of cool — pick the most dramatically compelling. Resolve the rest OFF-SCREEN (REFRAME or DISSOLVE) or IMPLODE. Every arrived collision must be committed this turn.]`);
        }
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks.join('\n\n'), PROMPT_IN_CHAT, 0);
        _arrivalLastFiredTurn = _turnCounter;
        console.log(`${LOG_PREFIX} Collision arrival injection: ${blocks.length} block(s)`);
    }
}

// ─── Foreshadowing ────────────────────────────────────────────────────────────

function buildForeshadowBlock(col) {
    const placeName = col.location ? (_currentState.places?.[col.location]?.name || col.location) : 'unspecified';
    const involved = buildInvolvedCharsSummary(col, _currentState);
    const current = Math.round(parseFloat(col.distance));
    const costLine = col.cost ? `\nScenario: ${col.cost}` : '';
    return `[FORESHADOW]
"${col.name || col.id}" is drawing closer (${current} ticks remaining).
Forces: ${col.forces || '(unspecified)'}${costLine}
Anchored at: ${placeName} | Involved: ${involved}
The collision's forces are near. Someone moves differently. A name surfaces. Weave its approach into the scene without making it the focus.
If the player has already addressed this scenario, DISSOLVE the collision instead of forcing its arrival.`;
}

function buildForeshadowingInjection(state) {
    const lines = [];
    for (const [id, col] of Object.entries(state.collisions || {})) {
        if (col.distance_category === 'IMMEDIATE') continue;
        if ((col.status || '').toUpperCase() !== 'ACTIVE') continue;
        if (_foreshadowedCollisions.has(id)) continue;

        const threshold = FORESHADOW_DISTANCES[col.distance_category];
        if (typeof threshold !== 'number') continue;

        const current = parseFloat(col.distance);
        if (isNaN(current) || current <= 0) continue;
        if (current > threshold) continue;

        _foreshadowedCollisions.add(id);
        lines.push(buildForeshadowBlock(col));
    }
    return lines.length > 0 ? lines.join('\n\n') : null;
}

// ─── Rotating Nudge System (§4.4) ─────────────────────────────────────────────

function getNudgeState() {
    const meta = SillyTavern.getContext().chatMetadata;
    return {
        counter: meta[NUDGE_COUNTER_KEY] ?? -3,
        slot: meta[NUDGE_SLOT_KEY] ?? 0,
        rotIdx: meta[NUDGE_ROTATION_INDEX_KEY] ?? 0,
    };
}

function saveNudgeState(counter, slot, rotIdx) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    chatMetadata[NUDGE_COUNTER_KEY] = counter;
    chatMetadata[NUDGE_SLOT_KEY] = slot;
    chatMetadata[NUDGE_ROTATION_INDEX_KEY] = rotIdx;
    saveMetadata();
}

function buildNudge_agendaCheck(state, charId) {
    const char = state.characters[charId];
    if (!char) return null;
    const name = char.name || charId;
    return `[GRAVITY NUDGE — agenda_check]\nReview ${name}'s agenda. Has this scene or recent events shifted their direction?\nIf yes: S char:${charId} field=agenda value="..."\nIf unchanged, skip.`;
}

function buildNudge_pressureScan(state) {
    return `[GRAVITY NUDGE — pressure_scan]\nIdentify any new pressure points seeded by this scene. Seed with: CR pressure:<id> — name, source, related_to.\nIf nothing new, skip.`;
}

function buildNudge_consolidationCheck(state) {
    const pressureCount = Object.keys(state.pressures || {}).length;
    if (pressureCount === 0) return null;
    return `[GRAVITY NUDGE — consolidation_check]\nReview active pressure points (${pressureCount} current). Can any be combined into an existing collision or fed to seed a new one?\nIf yes: S collision:<id> field=forces value="..." or CR collision:<id> — then D pressure:<id>.\nIf not ready, skip.`;
}

function buildNudge_collisionHealth(state) {
    if (!state) return null;
    const pressureCount = Object.keys(state.pressures || {}).length;
    const activeCollisions = Object.values(state.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
    if (pressureCount > 0 || activeCollisions > 0) return null;
    const archiveEntries = Array.isArray(state.world?.collision_archive) ? state.world.collision_archive : [];
    const archiveHint = archiveEntries.length
        ? `\nArchive hooks (recent):\n${archiveEntries.slice(-3).map(e => '  • ' + e).join('\n')}`
        : '';
    return `[GRAVITY NUDGE — collision_health]\nBoth pressure pool and collision pool are empty — nothing is driving the narrative forward. Seed immediately from:\n  • Character agendas and wants\n  • Faction tensions and ambitions\n  • Collision archive hooks${archiveHint}\nCreate at least one pressure point (CR pressure:<id>) or collision (CR collision:<id>).`;
}

function buildNudge_relationshipPulse(state, charId) {
    const char = state.characters[charId];
    if (!char) return null;
    const name = char.name || charId;
    const isPrincipal = char.tier === 'PRINCIPAL';
    let prompt = `[GRAVITY NUDGE — relationship_pulse]\nHas this scene affected ${name}'s relationship with the PC?`;
    if (isPrincipal) {
        prompt += `\nIf significant: A char:${charId} field=key_moments value="[moment] <what happened> [hook] <open thread> [weight] <why this matters in one phrase>"`;
    }
    prompt += `\nIf no meaningful shift, skip.`;
    return prompt;
}

function buildNudge_collisionValidity(state) {
    const active = Object.entries(state.collisions || {})
        .filter(([, c]) => (c.status || '').toUpperCase() === 'ACTIVE');
    if (!active.length) return null;
    const names = active.map(([id, c]) => `${c.name || id} (${id})`).join(', ');
    return `[GRAVITY NUDGE — collision_validity]\nReview active collisions: ${names}.\nHas the narrative made any irrelevant, redundant, or impossible?\nIf yes, IMPLODE: TR collision:<id> field=status from=ACTIVE to=RESOLVED + S outcome_type=IMPLODED + S aftermath="..." + A world field=collision_archive value="[collision] ... [id <id>] [resolution] ... [hook] ... [aftermath] ...".\nIf all still valid, skip.`;
}

function buildNudge_destroyedCleanup(state) {
    // These fields are arrays; MR is map-delete and is invalid here — use R (remove from array) or S (rewrite array)
    return `[GRAVITY NUDGE — destroyed_cleanup]\nScan for destroyed character IDs still referenced in collision.involved_chars, faction.members, or pressure.related_to.\nRemove stale refs with R (remove from array) or S (overwrite array) operations.\nIf nothing stale, skip.`;
}

/**
 * Decide whether to fire a nudge this turn. Updates chatMetadata counters.
 * Returns nudge text (string) or null if not firing this turn.
 * Only fires on regular/combat/intimate turns — advance uses buildNudge_collisionHealth directly.
 */
function maybeComputeNudge(state, mode) {
    if (!state || mode === 'advance') return null;
    const { counter, slot, rotIdx } = getNudgeState();
    const newCounter = counter + 1;
    if (counter % 4 !== 0) {
        saveNudgeState(newCounter, slot, rotIdx);
        return null;
    }
    // Fire the nudge for current slot
    const slotName = NUDGE_SLOT_NAMES[slot];
    let text = null;
    if (slotName === 'agenda_check' || slotName === 'relationship_pulse') {
        const eligible = Object.entries(state.characters || {})
            .filter(([, c]) => c.tier === 'PRINCIPAL' || c.tier === 'TRACKED')
            .map(([id]) => id);
        if (eligible.length > 0) {
            const charId = eligible[rotIdx % eligible.length];
            text = slotName === 'agenda_check'
                ? buildNudge_agendaCheck(state, charId)
                : buildNudge_relationshipPulse(state, charId);
        }
    } else if (slotName === 'pressure_scan') {
        text = buildNudge_pressureScan(state);
    } else if (slotName === 'consolidation_check') {
        text = buildNudge_consolidationCheck(state);
    } else if (slotName === 'collision_health') {
        text = buildNudge_collisionHealth(state);
    } else if (slotName === 'collision_validity') {
        text = buildNudge_collisionValidity(state);
    } else if (slotName === 'destroyed_cleanup') {
        text = buildNudge_destroyedCleanup(state);
    }
    // Rotation advances only after slot 0 (agenda_check) and slot 4 (relationship_pulse).
    // Monotonic growth — no modulo — ensures cadence is unaffected by empty eligibility.
    const nextRotIdx = (slot === 0 || slot === 4) ? rotIdx + 1 : rotIdx;
    saveNudgeState(newCounter, (slot + 1) % 7, nextRotIdx);
    return text;
}

/**
 * Inject prompts based on turn mode.
 * @param {'regular'|'advance'|'integration'} [mode='regular']
 *   regular     — player prose turn (slim state, core readme)
 *   advance     — world moves turn (full state, core readme, skip heartbeat/dormant)
 *   integration — timeskip/setup (full state, full readme)
 */
function injectPrompt(mode) {
    // If no mode specified, reuse the current mode (prevents GENERATION_STARTED from downgrading).
    // An explicit mode (or any caller that sets a fresh one-shot before calling) bumps the
    // fingerprint so the snapshot replay path doesn't fire — see _lastInjectFingerprint below.
    if (mode) {
        _currentInjectMode = mode;
        _injectFingerprint++;
    }
    const activeMode = _currentInjectMode;

    const context = SillyTavern.getContext();
    const { setExtensionPrompt } = context;
    if (!setExtensionPrompt) return;

    // Idempotency: if we've already injected for this fingerprint (e.g. GENERATION_STARTED
    // firing right after onMessageReceived), replay the snapshot without re-consuming
    // _archiveInjectedVersion / _pendingNudgeText / _foreshadowedCollisions / _pendingOOCInjection.
    if (_lastInjectFingerprint === _injectFingerprint && _lastInjectSnapshot) {
        try {
            for (const [slot, payload] of Object.entries(_lastInjectSnapshot.slots)) {
                if (payload && payload.text) {
                    setExtensionPrompt(slot, payload.text, PROMPT_IN_CHAT, 0);
                } else {
                    setExtensionPrompt(slot, '', PROMPT_NONE, 0);
                }
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} Inject replay failed:`, err);
        }
        return;
    }

    const _injectSnapshot = { slots: {} };
    const _setPrompt = (slot, text) => {
        _injectSnapshot.slots[slot] = text ? { text } : null;
        if (text) {
            setExtensionPrompt(slot, text, PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(slot, '', PROMPT_NONE, 0);
        }
    };

    const isRegular = activeMode === 'regular';
    const isAdvance = activeMode === 'advance';
    const isIntegration = activeMode === 'integration';
    const challengeRuntimeActive = isChallengeRuntimeActive();
    const challengeSessionLocked = isChallengeSessionLocked();
    const challengeRuntime = getChallengeRuntime();
    const activeProfile = getActiveProfile();
    if (challengeRuntime?.phase === 'cleanup_grace') {
        _uncappedTurn = true;
    }

    try {
        let nextReasonMode = _currentReasonMode || 'regular';
        if (_pendingDeductionType) {
            nextReasonMode = _pendingDeductionType;
            _pendingDeductionType = null;
        } else if (challengeSessionLocked && activeProfile) {
            nextReasonMode = activeProfile.deductionType || activeProfile.kind;
        }
        _currentReasonMode = nextReasonMode;

        // State view — four modes: lite, combat, intimacy, full
        if (_currentState) {
            const archiveVersion = computeArchiveVersion(_currentState);
            const includeArchive = archiveVersion !== _archiveInjectedVersion;
            const stateViewMode = getStateViewMode(isRegular, isAdvance, isIntegration, challengeRuntimeActive, nextReasonMode);
            const stateView = formatStateView(_currentState, stateViewMode, includeArchive);
            _setPrompt(`${MODULE_NAME}_state`, stateView);
            if (includeArchive) _archiveInjectedVersion = archiveVersion;
        }

        // Format readme — core on regular/advance, full on integration
        const readme = formatReadme(isIntegration ? 'full' : 'core');
        _setPrompt(`${MODULE_NAME}_readme`, readme);

        // Setup wizard phase prompt (active phase injected via _pendingOOCInjection from handleSetupButton)
        _setPrompt(`${MODULE_NAME}_setup`, '');

        // OOC command injection (from buttons)
        // Only update when there's a new injection — don't clear on re-inject
        // (GENERATION_STARTED re-calls injectPrompt, which would wipe the OOC prompt)
        if (_pendingOOCInjection) {
            _setPrompt(`${MODULE_NAME}_ooc`, _pendingOOCInjection);
            _pendingOOCInjection = null;
        }

        const challengePromptBody = _currentState ? buildChallengePrompt(_currentState) : '';
        if (challengePromptBody && activeProfile) {
            _setPrompt(
                `${MODULE_NAME}_challenge`,
                buildModeInjection(
                    `GRAVITY CHALLENGE — Active ${activeProfile.displayName} Session`,
                    challengePromptBody,
                    Object.values(activeProfile.lorebookKeys).filter(Boolean),
                ),
            );
        } else {
            _setPrompt(`${MODULE_NAME}_challenge`, '');
        }

        // Corrections + reinforcement
        let injection = '';
        if (_pendingCorrections.length > 0) {
            injection = buildCorrectionInjection(_pendingCorrections) || '';
        }
        if (_pendingReinforcement) {
            injection = injection ? injection + '\n' + _pendingReinforcement : _pendingReinforcement;
        }

        _setPrompt(`${MODULE_NAME}_inject`, injection || '');

        // Style exemplars — inject mode-matched good paragraphs (skip on integration turns — no prose)
        const { chatMetadata } = SillyTavern.getContext();
        const exemplars = (!isIntegration && chatMetadata?.['gravity_exemplars']) || [];
        if (exemplars.length > 0) {
            const selected = selectExemplarsForPrompt(exemplars, activeMode, nextReasonMode, 3);
            const exLines = selected.map(formatExemplarForPrompt).join('\n');
            _setPrompt(`${MODULE_NAME}_exemplars`,
                `[STYLE EXEMPLARS — the player flagged these as strong prose. Match the structural strengths that fit this turn's mode. Do not copy exact wording, imagery, or house voice.\n${exLines}]`);
        } else {
            _setPrompt(`${MODULE_NAME}_exemplars`, '');
        }

        // Faction heartbeat — every 10 turns on regular turns only (advance/integration handle factions directly)
        if (isRegular && !challengeSessionLocked && _turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
            const factions = Object.values(_currentState.factions || {});
            if (factions.length > 0) {
                const factionDetails = factions.map(f => {
                    let detail = `${f.name || f.id} (${f.agenda || '?'})`;
                    if (f.state) detail += ` [${f.state}]`;
                    return detail;
                }).join('\n  ');
                _setPrompt(`${MODULE_NAME}_faction`,
                    `[FACTION HEARTBEAT — Turn ${_turnCounter}.\n  ${factionDetails}\nFactions execute operations independently, driven by their AGENDA. Leaders command subordinates — show the chain of command. Check faction knowledge_asymmetry to keep intel consistent. You may CUT to a faction scene before cutting back. If no faction has visibly acted in recent turns, one MUST advance NOW — pick the faction whose AGENDA most threatens the current scene.]`);
            } else {
                _setPrompt(`${MODULE_NAME}_faction`, '');
            }
        } else {
            _setPrompt(`${MODULE_NAME}_faction`, '');
        }

        // Dormant character check — every 15 turns on regular turns only
        const DORMANT_THRESHOLD = 20; // transactions since last activity
        if (isRegular && !challengeSessionLocked && _turnCounter > 0 && _turnCounter % 15 === 0 && _currentState) {
            const allTx = getAllTransactions();
            const totalTx = allTx.length;
            const dormant = [];
            for (const [id, char] of Object.entries(_currentState.characters || {})) {
                if (char.tier === 'UNKNOWN' || char.tier === 'KNOWN') continue;
                const charTxns = getTransactionsForEntity(id);
                const lastTx = charTxns.length > 0 ? charTxns[charTxns.length - 1].tx : 0;
                const gap = totalTx - lastTx;
                if (gap >= DORMANT_THRESHOLD) {
                    dormant.push(`${char.name || id} [${char.tier}] — AGENDA: ${char.agenda || '?'} — last activity ${gap} transactions ago`);
                }
            }
            if (dormant.length > 0) {
                _setPrompt(`${MODULE_NAME}_dormant`,
                    `[DORMANT CHARACTERS — gravity still pulls these characters toward collision:\n${dormant.map(d => '  • ' + d).join('\n')}\nGravity is constant — however weak, it pulls toward collision. Their AGENDA is a force. Their actions have consequences. Advance them toward the nearest collision — or spawn a new one from their AGENDA intersecting the current situation.]`);
            } else {
                _setPrompt(`${MODULE_NAME}_dormant`, '');
            }
        } else {
            _setPrompt(`${MODULE_NAME}_dormant`, '');
        }

        // ── Collision Audit (warnings + closure checks) ───────────────────────
        if (_currentState) {
            const collisionWarnings = [];

            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                if (status === 'RESOLVED') continue;
                const dist = parseFloat(col.distance);
                collisionWarnings.push(...buildCollisionNarrativeWarnings(id, col, status));

                // ── Distance warnings ─────────────────────────────────────────────
                const distHist = (_currentState._history || {})[`collision:${id}:distance`] || [];
                if (distHist.length > 0) {
                    const last = distHist[distHist.length - 1];
                    const fromDist = parseFloat(last.from);
                    const toDist = parseFloat(last.to);
                    if (!isNaN(fromDist) && !isNaN(toDist) && toDist > fromDist) {
                        collisionWarnings.push(`"${col.name || id}" distance went ${last.from} → ${last.to} — collision distances are countdowns, they MUST NOT increase. SET it back to ${last.from} or lower.`);
                    }
                }
            }

            // Arrival injection is event-driven via buildAndInjectArrivals()
            // (IMMEDIATE: onMessageReceived; distance-0: handleAdvanceButton after tick).

            // ── Closure audit — resolved collisions missing required fields ────────
            const closureWarnings = [];
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                // Half-closed: outcome_type set but status still ACTIVE.
                // Usually means the LLM emitted outcome/aftermath but the TR
                // didn't land (wrong grammar or rejected). The status TR is
                // missing and must be added on the next turn.
                if (status === 'ACTIVE' && col.outcome_type) {
                    closureWarnings.push(`"${col.name || id}" has outcome_type=${col.outcome_type} but status is still ACTIVE — the status transition didn't land. In a ---STATE--- block add: collision:${id}.status: ${col.outcome_type === 'CRASHED' ? 'CRASHED' : 'RESOLVED'}. In a ---LEDGER--- block use: TR collision:${id} field=status from=ACTIVE to=${col.outcome_type === 'CRASHED' ? 'CRASHED' : 'RESOLVED'}.`);
                    continue;
                }
                if (status !== 'RESOLVED') continue;
                if (!col.outcome_type) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing outcome_type (DIRECT / EVOLVED / MERGED / DISSOLVED / IMPLODED / CRASHED)`);
                if (!col.aftermath) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing aftermath — what changed, what was lost, what it left behind`);
                if (col.outcome_type === 'EVOLVED' && !col.successor_collision_ids) {
                    closureWarnings.push(`"${col.name || id}" has outcome_type: EVOLVED but no successor_collision_ids — link the new collision this evolved into.`);
                }
            }
            if (closureWarnings.length > 0) {
                collisionWarnings.push(...closureWarnings.map(w => `[CLOSURE AUDIT] ${w}`));
            }

            if (_arrivalLastFiredTurn !== _turnCounter) {
                // Only clear if buildAndInjectArrivals did not already set the slot this turn
                _setPrompt(`${MODULE_NAME}_arrival`, '');
            }

            if (collisionWarnings.length > 0) {
                _setPrompt(`${MODULE_NAME}_dist_warn`,
                    `[COLLISION AUDIT:\n${collisionWarnings.map(w => '  • ' + w).join('\n')}]`);
            } else {
                _setPrompt(`${MODULE_NAME}_dist_warn`, '');
            }
        } else {
            if (_arrivalLastFiredTurn !== _turnCounter) {
                _setPrompt(`${MODULE_NAME}_arrival`, '');
            }
            _setPrompt(`${MODULE_NAME}_dist_warn`, '');
        }

        // Nudge now only signals the active deduction mode; the preset owns the actual protocol.
        const reasonMode = nextReasonMode || 'regular';

        let nudgeText = `[SYSTEM: GRAVITY RUNTIME FLAGS
GRAVITY_REASON_MODE: ${reasonMode}

Flags are hidden reasoning only — never echo or paraphrase.

Output order after thinking:
1. Divination card HTML — only if this turn's injections explicitly request a draw. ${reasonMode === 'regular' ? 'DIVINATION: none this turn.' : ''}
2. Prose — carries the narrative.
3. UPDATE block — carries state changes only:
   - Normal turns: ---STATE--- (compact delta, material changes only)
   - Structural turns: ---LEDGER--- (full block, no line limit)${_uncappedTurn ? ' (UNCAPPED)' : ''}

Gravity tracks what prose can't: asymmetries, pressures, distances, reads-over-time. It does not track narrative recap — that belongs to the companion memory extension. Write state deltas for what changed, not restatements of what the prose just described.]`;

        // Fire regular prose trigger on regular turns only
        // (combat/intimacy/advance fire their own prose triggers via _ooc)
        if (isRegular && !challengeSessionLocked) {
            nudgeText += `\n\n[WORLD INFO TRIGGERS - DO NOT ECHO:\n${MODE_LOREBOOK_KEYS.proseRegular}\n]`;
        }

        _setPrompt(`${MODULE_NAME}_nudge`, nudgeText);

        // ── Nudge maintenance slot (§4.4) — rotating per-turn ledger tasks ─────
        if (_pendingNudgeText) {
            _setPrompt(`${MODULE_NAME}_nudge_maintenance`, _pendingNudgeText);
            _pendingNudgeText = null;
        } else {
            _setPrompt(`${MODULE_NAME}_nudge_maintenance`, '');
        }

        // ── Foreshadowing — pre-arrival threshold cues (§3.4) ─────────────────
        if ((isRegular || isAdvance) && _currentState) {
            const foreshadow = buildForeshadowingInjection(_currentState);
            _setPrompt(`${MODULE_NAME}_foreshadow`, foreshadow || '');
        } else {
            _setPrompt(`${MODULE_NAME}_foreshadow`, '');
        }

        _lastInjectFingerprint = _injectFingerprint;
        _lastInjectSnapshot = _injectSnapshot;
    } catch (err) {
        console.error(`${LOG_PREFIX} Inject failed:`, err);
    }
}

// ─── Array Size Checks ────────────────────────────────────────────────────────

const ARRAY_SIZE_LIMITS = {
    demonstrated_traits: { path: s => s.pc?.demonstrated_traits, label: 'PC TRAITS', cap: 20 },
};

function checkArraySizes(state) {
    if (!state) return null;
    const warnings = [];
    for (const [key, cfg] of Object.entries(ARRAY_SIZE_LIMITS)) {
        const arr = cfg.path(state);
        if (Array.isArray(arr) && arr.length > cfg.cap) {
            warnings.push(`${cfg.label}: ${arr.length} entries (cap ${cfg.cap}) — consolidate. REMOVE resolved/stale/duplicate entries.`);
        }
    }
    // Per-character arrays: key_moments are PERMANENT (never warn, never trim).
    if (warnings.length === 0) return null;
    return `[LEDGER HYGIENE WARNING — arrays over capacity:\n${warnings.map(w => '  • ' + w).join('\n')}\nPrune 2–3 stale entries per turn using REMOVE. Do NOT batch-remove everything at once — spread cleanup across multiple turns. Pressure points that fired or resolved are history, not live wires.]`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getChatId() {
    return SillyTavern.getContext().chatId || null;
}

// ─── Initialization ────────────────────────────────────────────────────────────

async function initialize(force = false) {
    const chatId = getChatId();
    if (_initialized && !force && chatId === _currentChatId) return;

    _initialized = false;
    _currentState = null;
    _turnCounter = 0;
    _pendingCorrections = [];
    _pendingReinforcement = null;
    _pendingOOCInjection = null;
    _uncappedTurn = false;
    _currentInjectMode = 'regular';
    _currentReasonMode = 'regular';
    _pendingDeductionType = null;
    _pendingManualDivination = null;
    _firedCollisionArrivals = new Set();
    _foreshadowedCollisions = new Set();
    _firedRelationshipCorrections = new Set();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();
    _archiveInjectedVersion = null;
    _pendingNudgeText = null;
    _lastInjectFingerprint = -1;
    _lastInjectSnapshot = null;
    _injectFingerprint = 0;

    if (!chatId) {
        console.log(`${LOG_PREFIX} No active chat.`);
        updatePanel(null, 0);
        return;
    }

    try {
        _currentChatId = chatId;
        await initLedger(chatId);
        initSnapshots();
        _currentState = computeCurrentState();
        // Reconstruct arrival/foreshadow sets from persisted state so that
        // page reloads don't re-fire prompts for already-resolved collisions.
        const _reconstructed = reconstructArrivalState(_currentState);
        _firedCollisionArrivals = _reconstructed.fired;
        _foreshadowedCollisions = _reconstructed.foreshadow;
        _initialized = true;

        const txCount = getAllTransactions().length;
        setBookName(chatId);
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
        console.log(`${LOG_PREFIX} Initialized for chat ${chatId}. ${txCount} TX loaded.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Init failed:`, err);
        setBookName(null);
    }
}

async function onChatChanged() {
    const newChatId = getChatId();
    console.log(`${LOG_PREFIX} Chat changed → ${newChatId || '(none)'}`);
    resetLedger();
    await initialize(true);
}

// ─── Message Handlers ──────────────────────────────────────────────────────────

async function onMessageReceived(messageId) {
    if (!_initialized) await initialize();
    // New turn boundary — invalidate the injectPrompt snapshot so one-shot flags are reconsumed.
    _injectFingerprint++;
    // Snapshot the mode before resetting so exemplar flagging preserves the real turn mode
    _lastCompletedMode = _currentInjectMode;
    // Reset inject mode and clear OOC injection — the special turn is over
    _currentInjectMode = 'regular';
    _currentReasonMode = 'regular';
    _pendingDeductionType = null;
    const context = SillyTavern.getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(`${MODULE_NAME}_ooc`, '', PROMPT_NONE, 0);
    }

    const message = context.chat?.[messageId];
    if (!message?.mes) return;
    let challengeCorrection = null;

    _turnCounter++;

    // Extract update block (compact STATE or canonical LEDGER)
    const extraction = extractUpdateBlock(message.mes);
    const cleanedAssistantMessage = extraction.found ? extraction.cleanedMessage : message.mes;

    // No block found
    if (!extraction.found) {
        _pendingReinforcement = getReinforcement(extraction, _turnCounter);
        challengeCorrection = await processChallengeAssistantTurn(_currentState, [], cleanedAssistantMessage);
        if (challengeCorrection) {
            _pendingReinforcement = _pendingReinforcement
                ? `${_pendingReinforcement}\n${challengeCorrection}`
                : challengeCorrection;
        }
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
        return;
    }

    let extractedTransactions = extraction.transactions || [];
    let duplicateChallengeCreateRewriteCount = 0;
    const extractionErrors = [...(extraction.errors || [])];

    if (extraction.format === 'state') {
        const compiled = compileStateEntries(extraction.stateEntries || [], _currentState);
        extractedTransactions = compiled.transactions;
        extractionErrors.push(...compiled.errors);
    }

    const duplicateCreateRewrite = rewriteDuplicateActiveChallengeCreate(extractedTransactions, _currentState);
    extractedTransactions = duplicateCreateRewrite.transactions;
    duplicateChallengeCreateRewriteCount = duplicateCreateRewrite.rewrittenCount;

    // No transactions at all (empty block or all lines failed)
    if (extractedTransactions.length === 0 && extractionErrors.length === 0) {
        _pendingReinforcement = getReinforcement(extraction, _turnCounter);
        challengeCorrection = await processChallengeAssistantTurn(_currentState, [], message.mes);
        if (challengeCorrection) {
            _pendingReinforcement = _pendingReinforcement
                ? `${_pendingReinforcement}\n${challengeCorrection}`
                : challengeCorrection;
        }
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
        return;
    }

    // Cleanup gate: REMOVE/DESTROY/MAP_DEL capped outside eval turns
    // All other operations (SET, APPEND, MAP_SET, MOVE, CREATE, READ) are unlimited
    const CLEANUP_OPS = ['R', 'MR', 'D'];
    const CLEANUP_CAP = 3;
    let cleanupDropped = 0;
    if (!_uncappedTurn) {
        let cleanupCount = 0;
        extractedTransactions = extractedTransactions.filter(tx => {
            if (CLEANUP_OPS.includes(tx.op)) {
                cleanupCount++;
                if (cleanupCount > CLEANUP_CAP) {
                    cleanupDropped++;
                    return false;
                }
            }
            return true;
        });
        if (cleanupDropped > 0) {
            console.warn(`${LOG_PREFIX} Dropped ${cleanupDropped} cleanup operations (cap ${CLEANUP_CAP} outside eval turns).`);
        }
    }
    _uncappedTurn = false;

    // Validate each transaction individually.
    // pendingState mirrors _currentState plus prior same-batch tier/integrity/status TRs so
    // a same-turn promotion-then-location batch isn't rejected against pre-promotion tier.
    let validTxns = [];
    const validationErrors = [];
    let committedTxns = [];
    const pendingState = _currentState ? structuredClone(_currentState) : createEmptyState();
    for (let i = 0; i < extractedTransactions.length; i++) {
        const tx = extractedTransactions[i];
        const result = validateBatch([tx]);
        if (!result.valid) {
            // Include entity:id token in raw so clearMatchedCorrections can match it when fixed
            const entityToken = tx.e && tx.id ? `${tx.e}:${tx.id}` : (tx.e ? tx.e : `tx-${i}`);
            validationErrors.push({
                lineNum: i,
                error: result.errors.map(e => e.message).join('; '),
                raw: `[validated tx ${i}] ${entityToken}`,
            });
            continue;
        }

        // ── Travel plausibility + tier gate (§2.1, §2.4) ───────────────────
        if (tx.op === 'S' && tx.e === 'char' && tx.d?.f === 'location') {
            const charBefore = pendingState.characters?.[tx.id];
            const tier = String(charBefore?.tier || 'UNKNOWN').toUpperCase();
            if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') {
                validationErrors.push({
                    lineNum: i,
                    error: `char:${tx.id} is tier ${tier}; location is only tracked for TRACKED/PRINCIPAL chars (§2.1). Promote first or omit location.`,
                    fix: `Remove the location SET, or TR this character to TRACKED first.`,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
            const fromPlaceId = charBefore?.location;
            const travel = validateTravel(tx.id, fromPlaceId, tx.d.v, pendingState, _lastCompletedMode || _currentInjectMode);
            if (!travel.valid) {
                validationErrors.push({
                    lineNum: i,
                    error: travel.error,
                    fix: travel.fix,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
        }

        // ── CR char location gate (§2.1, §2.4) — mirrors the S gate above ────
        // A CR with a location field bypasses the S gate; apply the same tier+travel check.
        if (tx.op === 'CR' && tx.e === 'char' && tx.d?.location !== undefined) {
            const charBefore = pendingState.characters?.[tx.id];
            const tier = String((charBefore?.tier ?? tx.d?.tier ?? 'UNKNOWN')).toUpperCase();
            if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') {
                validationErrors.push({
                    lineNum: i,
                    error: `char:${tx.id} is tier ${tier}; location is only tracked for TRACKED/PRINCIPAL chars (§2.1). Promote first or omit location from CR.`,
                    fix: `Include tier=TRACKED or higher in the CR payload, or create the character first and then set location in a follow-up S op.`,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
            const fromPlaceId = charBefore?.location;
            // fromPlaceId undefined on genuine first create — validateTravel treats this as first placement (returns valid:true when fromPlace is falsy)
            const travel = validateTravel(tx.id, fromPlaceId, tx.d.location, pendingState, _lastCompletedMode || _currentInjectMode);
            if (!travel.valid) {
                validationErrors.push({
                    lineNum: i,
                    error: travel.error,
                    fix: travel.fix,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
        }

        // State-machine TR validation runs as a post-loop batch call below
        // (consistency.js::validateTransitions, §6.1). Retained stub only to
        // document intent at the per-tx site.

        validTxns.push(tx);

        // Apply state-machine TRs (tier/integrity/status) to pendingState so subsequent same-batch
        // ops see the post-transition snapshot. Only state-machine fields need replay here.
        if (tx.op === 'TR' && (tx.d?.f === 'tier' || tx.d?.f === 'integrity' || tx.d?.f === 'status')) {
            try {
                applyTransaction(pendingState, {
                    tx: -(i + 1), // negative tx.tx marks intra-batch shadow replay — pendingState is discarded after validation, so recordHistory pollution is contained
                    t: tx.t || '',
                    _ts: '',
                    op: tx.op,
                    e: tx.e,
                    id: tx.id || '',
                    d: tx.d || {},
                    r: tx.r || '',
                });
            } catch (_) { /* validation-only mirror, ignore replay failures */ }
        }

        // Replay CR char/place into pendingState so later same-batch location gates see real tier/reach
        if (tx.op === 'CR' && (tx.e === 'char' || tx.e === 'place')) {
            try {
                applyTransaction(pendingState, {
                    tx: -(i + 1),
                    t: tx.t || '',
                    _ts: '',
                    op: tx.op,
                    e: tx.e,
                    id: tx.id || '',
                    d: tx.d || {},
                    r: tx.r || '',
                });
            } catch (_) { /* validation-only mirror, ignore replay failures */ }
        }
        // Replay S place reach writes so validateTravel sees up-to-date reach in same batch
        if (tx.op === 'S' && tx.e === 'place' && (tx.d?.f === 'reach' || tx.d?.f === 'contains')) {
            try {
                applyTransaction(pendingState, {
                    tx: -(i + 1),
                    t: tx.t || '',
                    _ts: '',
                    op: tx.op,
                    e: tx.e,
                    id: tx.id || '',
                    d: tx.d || {},
                    r: tx.r || '',
                });
            } catch (_) { /* validation-only mirror, ignore replay failures */ }
        }
    }

    // ── State-machine TR validation (§6.1, wired in consistency.js) ────────────
    // Pass _currentState so validateTransitions can derive `from` for S ops on
    // state-machine fields (tier/integrity/status) — the LLM only writes `to`.
    const trResult = validateTransitions(validTxns, _currentState);
    validTxns = trResult.valid;
    for (const e of trResult.errors) validationErrors.push(e);

    // ── PRINCIPAL faction pre-commit merge on advance turns ─────────────────────
    // Ensure PRINCIPAL factions always appear in pc.scene_cast when the LLM
    // writes a replacement list during an advance turn. Mutate the tx payload
    // IN PLACE before ledger write so the commit log carries the merged value
    // (avoids a post-commit drop→reappend cycle that would pollute history).
    const isAdvanceTurn = _lastCompletedMode === 'advance';
    if (isAdvanceTurn && _currentState) {
        const principalFactionRefs = Object.entries(_currentState.factions || {})
            .filter(([, f]) => String(f?.tier || '').toUpperCase() === 'PRINCIPAL')
            .map(([id]) => `faction:${id}`);
        if (principalFactionRefs.length > 0) {
            for (const tx of validTxns) {
                if (tx.op === 'S' && tx.e === 'pc' && tx.d?.f === 'scene_cast' && Array.isArray(tx.d.v)) {
                    for (const fqId of principalFactionRefs) {
                        if (!tx.d.v.includes(fqId)) {
                            tx.d.v.push(fqId);
                        }
                    }
                }
            }
        }
    }

    // ── Block-level validation (§13) ────────────────────────────────────────────
    // Catches same-block exploits (e.g. two PRINCIPAL CRs in one batch) that the
    // per-tx loop above cannot see because each tx is checked against the frozen
    // pre-batch state. Runs after the PRINCIPAL merge so the merged payload is
    // what gets validated. Rejects the entire block on violation — no partial commit.
    if (validTxns.length > 0) {
        const blockCheck = validateBlock(validTxns, _currentState);
        if (!blockCheck.valid) {
            for (const v of blockCheck.violations) {
                const rawToken = v.tx !== undefined
                    ? `[block tx=${v.tx} field=${v.field}]`
                    : `[block field=${v.field}]`;
                validationErrors.push({
                    lineNum: -1,
                    error: `Block validation failed — ${v.field}: ${v.message}`,
                    fix: v.fix || 'Re-examine the batch — one of the same-block transactions conflicts with another.',
                    raw: rawToken,
                });
            }
            console.warn(`${LOG_PREFIX} validateBlock dropped ${blockCheck.droppedTxs.size} tx(s): ${blockCheck.violations.length} violation(s).`);
            validTxns = validTxns.filter(tx => !blockCheck.droppedTxs.has(tx));
        }
    }

    // Combine all errors (extraction parse errors + validation errors)
    const allErrors = [...extractionErrors, ...validationErrors];

    // Queue errors for correction on next turn
    if (allErrors.length > 0) {
        queueCorrections(allErrors);
        console.warn(`${LOG_PREFIX} ${allErrors.length} errors queued for correction.`);
    }

    // Commit valid transactions
    if (validTxns.length > 0) {
        try {
            const committed = await append(validTxns);
            committedTxns = committed;
            _currentState = computeState(_currentState, committed);

            // Clear corrections that were fixed by these commits
            clearMatchedCorrections(committed);

            // Check if setup wizard phase should advance
            if (isSetupActive()) {
                checkPhaseCompletion(committed, _currentState);
            }

            if (_turnCounter % _autoSnapshotInterval === 0) {
                await createSnapshot(_currentState, `Auto-snapshot turn ${_turnCounter}`);
                try { await runDeepCompaction(); }
                catch (e) { console.warn('[GravityLedger] Deep compaction failed:', e); }
            }

            if (_lastCompletedMode === 'regular' || _lastCompletedMode === 'combat' || _lastCompletedMode === 'intimacy') {
                try { await runPerTurnCompaction(); }
                catch (e) { console.warn('[GravityLedger] Per-turn compaction failed:', e); }
            }

            console.log(`${LOG_PREFIX} Committed ${committed.length} TX, ${allErrors.length} errors. Turn ${_turnCounter}.`);
        } catch (err) {
            console.error(`${LOG_PREFIX} Commit failed:`, err);
        }
    }

    // ── Engine-owned field audit — CR-side only ───────────────────────────────
    // S writes to engine-owned fields (collision.distance, pressure.created_at_tx)
    // are now rejected upstream by consistency.js::validateTransitions and never
    // reach committedTxns, so post-hoc S-warning loops were dead and removed.
    // CR ops are not gated by validateTransitions in the same way (state-compute
    // applies its own defaults), so the CR-side hygiene warnings stay.
    for (const tx of committedTxns) {
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            queueCorrections([{
                raw: `[engine:collision:${tx.id}:missing-distance-category]`,
                error: 'Collision is missing distance_category — engine cannot tick distance. Please SET collision.distance_category to one of: IMMEDIATE, IMMINENT, NEAR, FAR.',
            }]);
        }
        if (tx.op === 'CR' && tx.e === 'pressure' && tx.d?.created_at_tx !== undefined) {
            queueCorrections([{
                raw: `[engine:pressure:${tx.id}:excess-created-at-tx]`,
                error: 'Pressure entity carries created_at_tx, which is engine-owned. Drop that field on creation; the engine assigns it.',
            }]);
        }
    }

    // ── Agenda-on-promotion audit (§2.1) ──────────────────────────────────────
    // When a char is promoted to TRACKED or PRINCIPAL in this turn, require an
    // agenda. Fires once per promoted character; relies on the rotating
    // agenda_check nudge to catch drift after that.
    for (const tx of committedTxns) {
        if (tx.op !== 'TR' || tx.e !== 'char' || tx.d?.f !== 'tier') continue;
        const toTier = String(tx.d?.to || '').toUpperCase();
        if (toTier !== 'TRACKED' && toTier !== 'PRINCIPAL') continue;
        const char = _currentState?.characters?.[tx.id];
        if (!char || (typeof char.agenda === 'string' && char.agenda.trim())) continue;
        queueCorrections([{
            raw: `[engine:char:${tx.id}:missing-agenda-on-promotion]`,
            error: `Character ${tx.id} was promoted to ${toTier} but has no agenda. SET char:${tx.id} field=agenda value="<short noun phrase>".`,
        }]);
    }

    // ── Archive presence check (§2.2.1) ────────────────────────────────────────
    // Scan ALL RESOLVED/CRASHED collisions each turn (not just TRs from this
    // turn). The counter increments every turn the archive remains missing so
    // the auto-fallback path (§2.2.1) actually fires after MAX_CORRECTION_ATTEMPTS.
    if (_currentState) {
        const archive = Array.isArray(_currentState.world?.collision_archive) ? _currentState.world.collision_archive : [];

        for (const [colId, col] of Object.entries(_currentState.collisions || {})) {
            const status = (col?.status || '').toUpperCase();
            if (status !== 'RESOLVED' && status !== 'CRASHED') continue;

            const idToken = `[id ${colId}]`;
            const matched = archive.some(entry => typeof entry === 'string' && entry.includes(idToken));

            if (matched) {
                _archiveCorrectionAttempts.delete(colId);
                continue;
            }

            const attempts = (_archiveCorrectionAttempts.get(colId) || 0) + 1;
            if (attempts > MAX_CORRECTION_ATTEMPTS) {
                const fallback = `[collision] ${col.name || colId} [id ${colId}] [resolution] ${col.outcome_type || col.status} — auto-generated (archive missing after ${MAX_CORRECTION_ATTEMPTS} attempts) [hook] none [aftermath] ${col.aftermath || 'unknown'}`;
                try {
                    const autoTxns = await append([{ op: 'A', e: 'world', id: '_', d: { f: 'collision_archive', v: fallback }, r: 'system:archive:auto-fallback' }]);
                    _currentState = computeState(_currentState, autoTxns);
                } catch (_) { /* non-critical */ }
                _archiveCorrectionAttempts.delete(colId);
            } else {
                _archiveCorrectionAttempts.set(colId, attempts);
                queueCorrections([{
                    raw: `[collision:${colId} archive]`,
                    error: `Missing archive entry for resolved collision ${colId}. Add: A world field=collision_archive value="[collision] ${col.name || colId} [id ${colId}] [resolution] ... [hook] ... [aftermath] ..."`,
                }]);
            }
        }
    }

    // ── Visible ledger HTML — append to message so player sees state changes ──
    if (committedTxns.length > 0) {
        const ledgerHtml = formatCommittedTxnsHtml(committedTxns);
        if (ledgerHtml && message) {
            message.mes += ledgerHtml;
            // Persist the modified message
            try {
                const ctx = SillyTavern.getContext();
                ctx.saveChatDebounced?.();
            } catch (_) { /* non-critical */ }
        }
    }

    // Build reinforcement FIRST — then append size warnings on top
    _pendingReinforcement = getReinforcement(extraction, _turnCounter);

    // Check array sizes and warn if bloated
    const sizeWarnings = checkArraySizes(_currentState);
    if (sizeWarnings) {
        _pendingReinforcement = (_pendingReinforcement || '') + '\n' + sizeWarnings;
    }
    if (cleanupDropped > 0) {
        _pendingReinforcement = (_pendingReinforcement || '') +
            `\n[LEDGER: ${cleanupDropped} cleanup operations dropped (REMOVE/DESTROY capped at ${CLEANUP_CAP} outside eval turns). Save bulk cleanup for OOC: eval.]`;
    }
    if (allErrors.length > 0 && validTxns.length > 0) {
        _pendingReinforcement = (_pendingReinforcement || '') +
            `\n[LEDGER: ${validTxns.length} TX committed, ${allErrors.length} failed.]`;
    } else if (validTxns.length === 0 && allErrors.length > 0) {
        _pendingReinforcement = formatErrors(allErrors.map(e => ({
            field: `line ${e.lineNum}`,
            message: e.error,
            fix: 'Resubmit corrected line',
        })));
    }
    if (duplicateChallengeCreateRewriteCount > 0) {
        const runtime = getChallengeRuntime();
        _pendingReinforcement = (_pendingReinforcement || '') +
            `\n[CHALLENGE RUNTIME]\nThe extension already seeded ${runtime?.entity_type || 'challenge'}:${runtime?.entity_id || ''}. Do not create it again. Only set or update its fields.`;
    }

    challengeCorrection = await processChallengeAssistantTurn(_currentState, committedTxns, cleanedAssistantMessage);
    if (challengeCorrection) {
        _pendingReinforcement = _pendingReinforcement
            ? `${_pendingReinforcement}\n${challengeCorrection}`
            : challengeCorrection;
    }

    // ── Post-commit pipeline — wrapped so updatePanel always fires even on errors ──
    try {
        // ── IMMEDIATE collision firing (§3.3) — fire on the turn they are created ──
        if (_currentState) {
            const immediateArrivals = Object.entries(_currentState.collisions || {})
                .filter(([id, col]) => col.distance_category === 'IMMEDIATE'
                    && col.status === 'ACTIVE'
                    && !_firedCollisionArrivals.has(id))
                .map(([id]) => id);
            if (immediateArrivals.length > 0) {
                await buildAndInjectArrivals(immediateArrivals, _currentState);
            }
        }

        // ── Advance tick pipeline (§3.7 steps 5–10) ────────────────────────────────
        // Runs AFTER LLM transactions have committed so world.timeskip_scale (the advance scale field) reflects
        // the current turn's declaration, not the previous one.
        if (_lastCompletedMode === 'advance') {
            await applyAdvanceTick();
        }

        // ── Pressure FIFO cap (§4.1) — auto-drop oldest when pool exceeds 5 ────────
        if (_currentState) {
            const pressureIds = Object.keys(_currentState.pressures || {});
            if (pressureIds.length > MAX_PRESSURE_POINTS) {
                const sorted = pressureIds
                    .map(id => ({ id, created_at_tx: _currentState.pressures[id].created_at_tx ?? 0 }))
                    .sort((a, b) => a.created_at_tx - b.created_at_tx);
                const toDrop = sorted.slice(0, sorted.length - MAX_PRESSURE_POINTS);
                const dropTxns = toDrop.map(p => ({
                    op: 'D', e: 'pressure', id: p.id,
                    r: 'system:pressure:fifo-overflow',
                }));
                if (dropTxns.length > 0) {
                    try {
                        const dropped = await append(dropTxns);
                        _currentState = computeState(_currentState, dropped);
                    } catch (_) { /* non-critical */ }
                }
            }
        }

        // ── Collision pool cap warning (§4.2) ───────────────────────────────────────
        if (_currentState) {
            const activeNonImmediate = Object.values(_currentState.collisions || {})
                .filter(c => (c.status || '').toUpperCase() === 'ACTIVE'
                    && c.distance_category !== 'IMMEDIATE');
            if (activeNonImmediate.length > MAX_COLLISIONS) {
                queueCorrections([{
                    raw: `[engine:collision:pool:pool-cap-exceeded]`,
                    error: `Collision pool has ${activeNonImmediate.length} active non-IMMEDIATE collisions (cap ${MAX_COLLISIONS}). Consolidate: merge two with the MERGE flow, or IMPLODE the least relevant one. IMMEDIATE collisions are exempt.`,
                }]);
            }
        }

        // ── Relationship-module corrections (§13) ───────────────────────────────────
        // 5b. TRACKED+ chars without relationship:pc-<id>
        // 5b. TRACKED+ factions without relationship:pc-<id>
        // 5c. Orphaned/stale relational collisions (no paired relationship, or no
        //     last_shift update tying the relationship to the resolved collision)
        // 5d. Scene cast overflow (> SCENE_CAST_SOFT_CAP)
        if (_currentState) {
            const relationships = _currentState.relationships || {};

            // 5b — missing relationship on TRACKED+ chars
            // Note: queueCorrections deduplicates by raw key and drops after MAX_CORRECTION_ATTEMPTS;
            // calling it every turn lets the attempt counter increment naturally (no external gate needed).
            // The card is rolled only on first queue and reused on retries — otherwise each turn
            // would hand the LLM a new card for the same missing relationship, looking like a reroll.
            for (const [id, char] of Object.entries(_currentState.characters || {})) {
                const tier = String(char?.tier || '').toUpperCase();
                if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
                if (relationships[`pc-${id}`]) continue;
                const rawKey = `[missing-relationship:char:${id}]`;
                const existing = _pendingCorrections.find(c => c.raw === rawKey);
                if (existing) {
                    queueCorrections([{ raw: rawKey, error: existing.error }]);
                    continue;
                }
                const draw = drawDivination();
                queueCorrections([{
                    raw: rawKey,
                    error: `char:${id} is ${tier} but has no relationship:pc-${id}. The engine drew: ${draw.label}. CREATE relationship:pc-${id} card="${draw.cardSlug || draw.label}" orientation="upright|reversed" nuance="<one-sentence bond description>" distance="fresh|forming|established|deep|core" intensity="cold|simmering|active|electric" last_shift=null\n(last_shift must be null at birth)`,
                }]);
            }
            // 5b — missing relationship on TRACKED+ factions
            for (const [id, f] of Object.entries(_currentState.factions || {})) {
                const tier = String(f?.tier || '').toUpperCase();
                if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') continue;
                if (relationships[`pc-${id}`]) continue;
                const rawKey = `[missing-relationship:faction:${id}]`;
                const existing = _pendingCorrections.find(c => c.raw === rawKey);
                if (existing) {
                    queueCorrections([{ raw: rawKey, error: existing.error }]);
                    continue;
                }
                const draw = drawDivination();
                queueCorrections([{
                    raw: rawKey,
                    error: `faction:${id} is ${tier} but has no relationship:pc-${id}. The engine drew: ${draw.label}. CREATE relationship:pc-${id} card="${draw.cardSlug || draw.label}" orientation="upright|reversed" nuance="<one-sentence bond description>" distance="fresh|forming|established|deep|core" intensity="cold|simmering|active|electric" last_shift=null`,
                }]);
            }

            // 5c — orphaned relational collisions + missing rel update
            for (const [cid, col] of Object.entries(_currentState.collisions || {})) {
                if (col?.ignition_class !== 'relational') continue;
                const status = String(col?.status || '').toUpperCase();
                if (status !== 'RESOLVED' && status !== 'CRASHED') continue;
                const involved = Array.isArray(col.involved_chars) ? col.involved_chars : [];
                const other = involved.find(x => x && x !== 'pc');
                if (!other) continue;
                // Normalize to bare id (strip char:/faction: prefix if present)
                const bareOther = String(other).replace(/^(char|faction):/, '');
                const relId = `pc-${bareOther}`;
                const rel = relationships[relId];
                if (!rel) {
                    queueCorrections([{
                        raw: `[orphan-relational:${cid}]`,
                        error: `collision:${cid} is tagged ignition_class=relational and ${status.toLowerCase()}, but no relationship:${relId} exists. Either:\n  (A) CREATE the missing relationship:${relId} card="..." orientation="..." nuance="..." distance="fresh|forming|established|deep|core" intensity="cold|simmering|active|electric" last_shift=null\n  (B) If mislabeled, SET collision:${cid} field=ignition_class value=environmental`,
                    }]);
                    continue;
                }
                // Relationship exists — was it updated to reference this collision?
                if (rel.last_shift && rel.last_shift.collision_id === cid) continue;
                const histKey = `relationship:${relId}:last_shift`;
                const history = _currentState._history?.[histKey] || [];
                const alreadyPaired = history.some(e => e && e.to && typeof e.to === 'object' && e.to.collision_id === cid);
                if (alreadyPaired) continue;
                queueCorrections([{
                    raw: `[missing-rel-update:${cid}]`,
                    error: `collision:${cid} resolved but relationship:${relId} was not updated. Commit now:\n  SET relationship:${relId} field=orientation value="upright|reversed"\n  SET relationship:${relId} field=nuance value="<updated expression>"\n  SET relationship:${relId} field=distance value="fresh|forming|established|deep|core"\n  SET relationship:${relId} field=intensity value="cold|simmering|active|electric"\n  SET relationship:${relId} field=last_shift value={tx, collision_id: "${cid}", from:{card,orientation,distance,intensity}, to:{card,orientation,distance,intensity}, reason}`,
                }]);
            }

            // 5d — scene cast overflow (soft cap)
            const SCENE_CAST_SOFT_CAP = 6;
            const castNow = Array.isArray(_currentState.pc?.scene_cast) ? _currentState.pc.scene_cast : [];
            const CAST_OVERFLOW_KEY = 'cast-overflow';
            if (castNow.length > SCENE_CAST_SOFT_CAP) {
                if (!_firedRelationshipCorrections.has(CAST_OVERFLOW_KEY)) {
                    _firedRelationshipCorrections.add(CAST_OVERFLOW_KEY);
                    const preview = castNow.slice(0, 4).join(', ')
                        + (castNow.length > 4 ? `, +${castNow.length - 4} more` : '');
                    queueCorrections([{
                        raw: `[${CAST_OVERFLOW_KEY}]`,
                        error: `Scene cast has ${castNow.length} members (soft cap ${SCENE_CAST_SOFT_CAP}): ${preview}. Either prune with SET pc field=scene_cast v=[<reduced list>] or advance the turn to replace the cast.`,
                    }]);
                }
            } else {
                _firedRelationshipCorrections.delete(CAST_OVERFLOW_KEY);
            }
        }

        // ── Rotating nudge (§4.4) — compute before inject so slot clears if not firing ──
        // Preserve any nudge already queued by applyAdvanceTick (e.g. collision_health on advance turns).
        if (!_pendingNudgeText) {
            _pendingNudgeText = maybeComputeNudge(_currentState, _lastCompletedMode || 'regular');
        }

        injectPrompt();
    } catch (err) {
        console.error(`${LOG_PREFIX} Post-commit pipeline error (panel will still update):`, err);
        try { injectPrompt(); } catch (_) { /* best-effort */ }
    } finally {
        updatePanel(_currentState, _turnCounter, committedTxns);
    }
}

async function onUserMessage(messageId) {
    if (!_initialized) await initialize();
    _injectFingerprint++;

    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message?.mes) return;

    const rawText = message.mes.replace(/<[^>]+>/g, '').trim();
    const manualDivinationOverride = parseManualDivinationOverride(rawText);
    if (manualDivinationOverride) {
        _pendingManualDivination = manualDivinationOverride;
    }
    const challengeLocked = isChallengeSessionLocked();
    const challengePrefix = detectChallengePrefix(rawText);
    if ((challengeLocked || challengePrefix) && !/^ooc:/i.test(rawText)) {
        const challengeResult = await handleChallengeActionSelection(rawText, _currentState, drawDivination);
        if (challengeResult.handled) {
            _currentState = computeCurrentState();
            _pendingDeductionType = challengeResult.deductionType || getActiveChallengeDeductionType() || 'combat';
            _pendingReinforcement = null;
            injectPrompt('advance');
            updatePanel(_currentState, _turnCounter);
            return;
        }
        if (challengeLocked) {
            // Input could not be parsed (e.g. bare number with no stored options).
            // Record the failed input so the prompt doesn't show stale data,
            // and inject a correction requesting fresh options.
            _pendingDeductionType = getActiveChallengeDeductionType() || 'combat';
            _pendingReinforcement = `[CHALLENGE RUNTIME]\nThe player sent "${rawText.slice(0, 80)}" but the extension could not resolve it to a stored option or recognized command. Output ${getActiveProfile()?.optionCount?.[0] || 3}-${getActiveProfile()?.optionCount?.[1] || 4} clickable options using the exact HTML format so the player can choose.`;
            injectPrompt('advance');
            updatePanel(_currentState, _turnCounter);
            return;
        }
        if (challengePrefix) {
            _pendingDeductionType = challengePrefix.deductionType || 'combat';
            injectPrompt('advance');
            updatePanel(_currentState, _turnCounter);
            return;
        }
    }

    // Detect intimacy action from st-clickable-actions (data-value starts with "intimate:")
    // This handles intimacy continuation when no challenge runtime is active
    if (!challengeLocked && (rawText.startsWith('intimate:') || rawText.startsWith('*intimate:'))) {
        _pendingDeductionType = 'intimacy';
        _pendingOOCInjection = buildModeInjection(
            'GRAVITY INTIMACY - continuing intimate scene',
            `The player chose an intimate action. Stay in intimate scene mode if the scene still makes sense.

Write the next prose beat responding to that action, then generate 4-5 new clickable choices using this exact HTML:
<span class="act" data-value="intimate: [concrete first-person action]">Short display text</span>

Collision pressure stays live. "OOC: fade to black" cuts to afterglow.

Then write prose, render the choices, and end with a compact STATE block.`,
            [MODE_LOREBOOK_KEYS.intimacyCore, MODE_LOREBOOK_KEYS.intimacyOptional, MODE_LOREBOOK_KEYS.proseIntimacy],
        );
        injectPrompt('advance');
        return;
    }

    const result = await processOOC(message.mes);
    if (result.handled && result.injection) {
        _uncappedTurn = /ooc:\s*(eval|cleanup)\b/i.test(message.mes);
        _pendingReinforcement = result.injection;
        _currentState = computeCurrentState();
        // Rollback runtime-state cleanup is handled by the onRollback listener
        // registered at module init (PHASE2-SPEC §8 step 8b).
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
    }
}

// ─── UI Button Handlers ────────────────────────────────────────────────────────

function insertChatMessage(text) {
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }
}

async function handleSetupButton() {
    if (isSetupActive()) {
        cancelSetup();
        showSetupPhase(null);
        toastr.info('Setup cancelled.');
        return;
    }

    const answers = await showSetupPopup();
    if (!answers) return; // User cancelled

    startSetup();
    showSetupPhase(getPhaseLabel());
    _pendingOOCInjection = buildSetupPrompt(answers);
    injectPrompt('integration');
    insertChatMessage('OOC: Begin game setup.');
}

// ─── Advance Tick Pipeline (§3.7 steps 5–10) ──────────────────────────────────
// Runs from onMessageReceived AFTER the LLM's advance-turn transactions have
// committed. Reads the just-committed world.timeskip_scale (set by the LLM), ticks collisions,
// clears pressure on WEEKS/MONTHS, detects new arrivals, fires collision_health.
async function applyAdvanceTick() {
    if (!_currentState) return;

    const scale = (_currentState.world?.timeskip_scale || 'HOURS').toString().toUpperCase();
    const tickDelta = TICK[scale] ?? 1;

    const tickTxns = [];
    for (const [id, col] of Object.entries(_currentState.collisions || {})) {
        const dist = parseFloat(col.distance);
        const status = (col.status || '').trim().toUpperCase();
        if (status !== 'ACTIVE') continue;
        if (col.distance_category === 'IMMEDIATE') continue;
        if (isNaN(dist) || dist <= 0) continue;
        const newDist = Math.max(0, dist - tickDelta);
        if (newDist !== dist) {
            tickTxns.push({ op: 'S', e: 'collision', id, d: { f: 'distance', v: newDist }, r: 'system:advance:tick' });
        }
    }

    // WEEKS / MONTHS clears pressure points — stale small tensions lapse
    if (scale === 'WEEKS' || scale === 'MONTHS') {
        for (const id of Object.keys(_currentState.pressures || {})) {
            tickTxns.push({ op: 'D', e: 'pressure', id, r: `system:advance:${scale.toLowerCase()}-clear-pressure` });
        }
    }

    if (tickTxns.length > 0) {
        await append(tickTxns);
        _currentState = computeCurrentState();
    }

    // Reset timeskip_scale after consuming
    if (_currentState.world?.timeskip_scale) {
        await append([{ op: 'S', e: 'world', id: '_', d: { f: 'timeskip_scale', v: null }, r: 'system:advance:reset-timeskip' }]);
        _currentState = computeCurrentState();
    }

    // Arrival detection — fire sanity-check for distances that hit 0 after tick
    const newArrivalIds = [];
    for (const [id, col] of Object.entries(_currentState.collisions || {})) {
        const status = (col.status || '').toUpperCase();
        const dist = parseFloat(col.distance);
        if (status === 'ACTIVE' && !isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
            newArrivalIds.push(id);
        }
    }
    if (newArrivalIds.length > 0) {
        await buildAndInjectArrivals(newArrivalIds, _currentState);
    }

    // collision_health fires on every advance turn regardless of nudge counter (§4.4)
    const healthNudge = buildNudge_collisionHealth(_currentState);
    if (healthNudge) _pendingNudgeText = healthNudge;

    updatePanel(_currentState, _turnCounter);
}

async function handleAdvanceButton() {
    if (_advanceLocked) return;
    _advanceLocked = true;

    // eventSource / event_types live on the SillyTavern context, not the module
    // scope — extract locally so the reenable listener can wire and unwire.
    const { eventSource, event_types } = SillyTavern.getContext();

    // Release the lock on the next MESSAGE_RECEIVED OR after a 2-minute timeout
    // (covers silent LLM failures, stream stalls, etc.). The panel button's
    // disabled state is managed by ui-panel.js; this listener exists solely to
    // clear `_advanceLocked` so a subsequent advance press isn't a silent no-op.
    let timeoutId = null;
    const releaseAdvanceLock = () => {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        _advanceLocked = false;
        eventSource.off(event_types.MESSAGE_RECEIVED, releaseAdvanceLock);
    };
    timeoutId = setTimeout(() => {
        console.warn(`${LOG_PREFIX} Advance lock timeout — releasing after 2min of no MESSAGE_RECEIVED.`);
        releaseAdvanceLock();
    }, 120000);
    eventSource.on(event_types.MESSAGE_RECEIVED, releaseAdvanceLock);

    try {
    _pendingDeductionType = 'advance';

    // ── Advance preconditions (§3.2) ──────────────────────────────────────────
    // TODO: move arrival check to post-commit per spec (§3.5) — the LLM should be able to
    // resolve arrivals during the advance turn itself, not be blocked before generation.
    if (_currentState) {
        // Warn only: unresolved arrivals should be resolved by the LLM this turn, not blocked pre-generation
        const unresolved = Object.values(_currentState.collisions || {}).find(col =>
            (col.status || '').toUpperCase() === 'ACTIVE' &&
            parseFloat(col.distance) <= 0
        );
        if (unresolved) {
            toastr.warning(`Unresolved arrival: "${unresolved.name || unresolved.id}" has arrived (distance 0). The advance will proceed — the LLM should resolve it this turn.`);
            // Proceed rather than abort — the LLM commits the resolution during this advance turn
        }

        // Advisory: PC in active combat
        const pcInCombat = Object.values(_currentState.combats || {}).some(c => (c.status || '').toUpperCase() === 'ACTIVE');
        if (pcInCombat) {
            toastr.warning('PC is not in a safe position to advance. Consider resolving the current situation before advancing.');
        }
    }

    // Tick consumption + arrival detection + collision_health nudge now run in
    // onMessageReceived() after the LLM commits its `S world timeskip_scale` TX.
    // This matches PHASE2-SPEC §3.7 steps 2→6 — commit first, then tick.

    injectPrompt('advance');
    const pcName = _currentState?.pc?.name || '{{user}}';
    insertChatMessage(`*${pcName} continues.*`);

    } catch (err) {
        console.error(`${LOG_PREFIX} handleAdvanceButton error:`, err);
        releaseAdvanceLock();
    }
}

async function handleCombatButton() {
    if (!isChallengeSessionLocked()) {
        const combatDraw = drawDivination();
        // Engine auto-commit: record this draw so the LLM never needs to write divination.last_draw
        try {
            await append([{ op: 'S', e: 'divination', id: '', d: { f: 'last_draw', v: combatDraw.label }, r: 'engine:combat:auto-draw' }]);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Combat draw auto-commit failed:`, err);
        }
        await startChallengeRuntime('combat', combatDraw);
        _currentState = computeCurrentState();
        _pendingDeductionType = 'combat';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
        insertChatMessage('combat: ');
    }
}

async function handleIntimacyButton() {
    _pendingDeductionType = 'intimacy';
    const pcName = _currentState?.pc?.name || '{{user}}';

    const histories = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        const ih = char.intimate_history;
        if (ih && typeof ih === 'object' && Object.keys(ih).length) {
            histories.push(`${char.name || id}: ${Object.entries(ih).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
    }

    const intimacyDraw = drawDivination();
    // Engine auto-commit: record this draw so the LLM never needs to write divination.last_draw
    try {
        await append([{ op: 'S', e: 'divination', id: '', d: { f: 'last_draw', v: intimacyDraw.label }, r: 'engine:intimacy:auto-draw' }]);
    } catch (err) {
        console.warn(`${LOG_PREFIX} Intimacy draw auto-commit failed:`, err);
    }
    const historyBlock = histories.length
        ? `INTIMATE HISTORY:\n${histories.map(h => `  ${h}`).join('\n')}`
        : 'No intimate history exists yet. Treat this as discovery.';

    _pendingOOCInjection = buildModeInjection(
        'GRAVITY INTIMACY',
        `${pcName} initiates an intimate scene.

${formatDrawInstruction(intimacyDraw, 'The draw colors tone and texture, not consent or plot.')}

Before activating, check that the scene is earned, clearly beyond casual contact, and that consent is plausible from the current dossiers and stances. If any answer is no, ignore this instruction and write normal prose.

${historyBlock}

If active, write one short sensory beat and then generate 4-5 clickable choices using this exact HTML:
<span class="act" data-value="intimate: first-person action description">Short display text</span>

Check collisions every turn. If one hits distance 0, the world interrupts the scene. After the scene, resume prose + STATE updates for reads, stance shifts, key moments, intimate history, and constraint pressure.`,
        [MODE_LOREBOOK_KEYS.intimacyCore, MODE_LOREBOOK_KEYS.intimacyOptional, MODE_LOREBOOK_KEYS.proseIntimacy],
    );

    injectPrompt('advance');
    insertChatMessage(`*${pcName} moves closer.*`);
}

function handlePowerReviewButton() {
    insertChatMessage('OOC: power review pc');
}

async function handleGoodTurnButton() {
    const { Popup, chatMetadata, saveMetadata } = SillyTavern.getContext();
    const text = await Popup.show.input('Good Prose', 'Paste the paragraph(s) you liked:');
    if (!text) return;

    const trimmed = text.trim();
    const modeHint = _lastCompletedMode || 'regular';
    const exemplar = normalizeExemplarRecord({
        text: trimmed,
        mode_hint: modeHint,
        turn: _turnCounter,
        _ts: Date.now(),
    });

    // Store exemplar in chatMetadata
    if (!chatMetadata['gravity_exemplars']) chatMetadata['gravity_exemplars'] = [];
    chatMetadata['gravity_exemplars'].push(exemplar);
    // Keep a slightly larger pool so mode-targeted selection still has range
    if (chatMetadata['gravity_exemplars'].length > 15) {
        chatMetadata['gravity_exemplars'].shift();
    }
    await saveMetadata();

    _injectFingerprint++;
    injectPrompt();
    toastr.success('Exemplar saved');
}

function handleRegisterButton() {
    insertChatMessage('OOC: promote ');
}

async function handleRevertTurn(txIds) {
    if (!txIds || txIds.length === 0) {
        toastr.warning('Nothing to revert.');
        return;
    }
    try {
        const { Popup } = SillyTavern.getContext();
        const result = await Popup.show.confirm('Revert Turn', `Revert ${txIds.length} transactions from the last turn?`);
        if (!result) return;

        // Remove the transactions from the ledger
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        const data = chatMetadata['gravity_ledger'];
        if (data && data.transactions) {
            data.transactions = data.transactions.filter(tx => !txIds.includes(tx.tx));
            // lastTxId is the NEXT free id, not the max existing id.
            // Keep it at least 1 past the highest surviving tx to avoid reuse.
            const maxSurviving = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.tx || 0)) : 0;
            data.lastTxId = maxSurviving + 1;
            await saveMetadata();
        }

        // Reinitialize to recompute state (initialize resets all runtime sets and
        // calls reconstructArrivalState, so arrival/foreshadow/corrections are clean).
        await clearChallengeRuntime();
        resetLedger();
        _pendingCorrections = [];
        _archiveCorrectionAttempts = new Map();
        _firedRelationshipCorrections = new Set();
        await initialize(true);
        toastr.success(`Reverted ${txIds.length} transactions.`);
    } catch (err) {
        console.error(`${LOG_PREFIX} Revert failed:`, err);
        toastr.error('Revert failed: ' + err.message);
    }
}

// ─── Swipe/Delete Detection ────────────────────────────────────────────────────

function onMessageSwiped() {
    console.log(`${LOG_PREFIX} Message swiped — ledger may be stale.`);
    setStaleWarning(true);
}

function onMessageDeleted() {
    console.log(`${LOG_PREFIX} Message deleted — ledger may be stale.`);
    setStaleWarning(true);
}

// ─── Export/Import/New for UI ──────────────────────────────────────────────────

async function handleNewLedger() {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    delete chatMetadata['gravity_ledger'];
    delete chatMetadata['gravity_cold'];
    delete chatMetadata['gravity_cold_watermarks'];
    delete chatMetadata['gravity_exemplars'];
    delete chatMetadata['gravity_challenge_runtime'];
    delete chatMetadata['gravity_challenge_settings'];
    delete chatMetadata[NUDGE_COUNTER_KEY];
    delete chatMetadata[NUDGE_SLOT_KEY];
    delete chatMetadata[NUDGE_ROTATION_INDEX_KEY];
    await saveMetadata();
    resetLedger();
    _pendingCorrections = [];
    _pendingReinforcement = null;
    _firedCollisionArrivals = new Set();
    _foreshadowedCollisions = new Set();
    _firedRelationshipCorrections = new Set();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();
    _archiveInjectedVersion = null;
    await initialize(true);
}

async function handleExportData() {
    return exportData();
}

async function handleImportData(data) {
    // Clear stale cold memory from previous dataset
    const { chatMetadata } = SillyTavern.getContext();
    delete chatMetadata['gravity_cold'];
    delete chatMetadata['gravity_cold_watermarks'];
    delete chatMetadata['gravity_challenge_runtime'];
    delete chatMetadata['gravity_challenge_settings'];
    delete chatMetadata[NUDGE_COUNTER_KEY];
    delete chatMetadata[NUDGE_SLOT_KEY];
    delete chatMetadata[NUDGE_ROTATION_INDEX_KEY];
    await importData(data);
    _pendingCorrections = [];
    _pendingReinforcement = null;
    _firedCollisionArrivals = new Set();
    _foreshadowedCollisions = new Set();
    _firedRelationshipCorrections = new Set();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();
    _archiveInjectedVersion = null;
    await initialize(true);
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    createPanel();

    // Clear arrival / foreshadow / archive runtime state on every rollback path
    // (OOC text, future programmatic calls, snapshot UI). PHASE2-SPEC §8 step 8b.
    onRollback(() => {
        _firedCollisionArrivals = new Set();
        _foreshadowedCollisions = new Set();
        _firedRelationshipCorrections = new Set();
        _arrivalLastFiredTurn = -1;
        _archiveCorrectionAttempts = new Map();
        _archiveInjectedVersion = null;
        _lastInjectFingerprint = -1;
        _lastInjectSnapshot = null;
    });

    setCallbacks({
        onNew: handleNewLedger,
        onExport: handleExportData,
        onImport: handleImportData,
        onSetup: handleSetupButton,
        onRegister: handleRegisterButton,
        onAdvance: handleAdvanceButton,
        onRevertTurn: handleRevertTurn,
        onGoodTurn: handleGoodTurnButton,
        onCombat: handleCombatButton,
        onPowerReview: handlePowerReviewButton,
        onIntimacy: handleIntimacyButton,
        onDivinationChange: async (system) => {
            await setDivinationSystem(system);
            toastr.info(`Divination system: ${system}`);
        },
    });

    // Setup wizard phase change callback
    setPhaseCallback((phase) => {
        showSetupPhase(phase > 0 ? getPhaseLabel() : null);
        injectPrompt(phase > 0 ? 'integration' : 'regular');
        updatePanel(_currentState, _turnCounter);
        if (phase === 0 && _lastPhase > 0) {
            toastr.success('Setup complete!');
        }
        _lastPhase = phase;
    });
    let _lastPhase = 0;

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);

    // Re-inject prompts before generation
    eventSource.on(event_types.GENERATION_STARTED, () => {
        if (_initialized) injectPrompt();
    });

    // Quick-access Advance/Combat buttons above chat input
    createInputButtons();

    // Intimacy clickable actions handled by st-clickable-actions extension
    // LLM outputs: <span class="act" data-value="intimate: action">Display</span>

    console.log(`${LOG_PREFIX} Extension registered.`);
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
})();

function createInputButtons() {
    const sendForm = document.getElementById('form_sheld');
    if (!sendForm || document.getElementById('gl-input-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'gl-input-bar';
    bar.innerHTML = `
        <button class="gl-input-btn" id="gl-input-advance" title="Advance — world takes a turn"><i class="fa-solid fa-play"></i> Advance</button>
        <button class="gl-input-btn" id="gl-input-combat" title="Initiate combat"><i class="fa-solid fa-burst"></i> Combat</button>
    `;
    sendForm.insertBefore(bar, sendForm.firstChild);

    document.getElementById('gl-input-advance').addEventListener('click', handleAdvanceButton);
    document.getElementById('gl-input-combat').addEventListener('click', handleCombatButton);
}

