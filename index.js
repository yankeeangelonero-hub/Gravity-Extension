/**
 * index.js — Gravity Ledger Extension for SillyTavern
 *
 * State machine and append-only ledger for Gravity v10.
 * Storage: chatMetadata (persistent JSON per chat)
 * Injection: setExtensionPrompt at depth 0
 * Format: Command-style lines with self-correcting feedback loop
 */

import { init as initLedger, reset as resetLedger, append, getAllTransactions, getTransactionsForEntity, exportData, importData } from './ledger-store.js';
import { initSnapshots, computeCurrentState, createSnapshot } from './snapshot-mgr.js';
import { validateBatch, formatErrors } from './consistency.js';
import { computeState, applyTransaction, createEmptyState, getArrayItemHistory, validateTravel, CATEGORY_DISTANCES } from './state-compute.js';
import { formatStateView, formatReadme } from './state-view.js';
import { extractUpdateBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning } from './ui-panel.js';
import { isActive as isSetupActive, getPhasePrompt, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback, showSetupPopup, buildSetupPrompt } from './setup-wizard.js';
import { getStateMachineField, validateTransition } from './state-machine.js';
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
// Foreshadow map: id → Set<'APPROACHING'|'IMMINENT'|'CONVERGING'> — each level fires once.
// Both reset on chat change, snapshot rollback, and import.
let _firedCollisionArrivals = new Set();
let _foreshadowedCollisions = new Map();

// Phase 2: Timeskip multipliers (§3.2)
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

// ─── Advance Focus Randomizer ──────────────────────────────────────────────

const ADVANCE_FOCUS_TABLE = [
    { key: 'scene',      weight: 30, label: 'Scene' },
    { key: 'world',      weight: 20, label: 'World Politics' },
    { key: 'offscreen',  weight: 20, label: 'Off-screen Character' },
    { key: 'new_threat', weight: 15, label: 'New Threat/Event' },
    { key: 'collision',  weight: 15, label: 'Collision Tightens' },
];

const MODE_LOREBOOK_KEYS = Object.freeze({
    advanceCore: 'gravity_mode_advance_core',
    advanceOptional: 'gravity_mode_advance_optional_examples',
    combatCore: 'gravity_mode_combat_core',
    combatOptional: 'gravity_mode_combat_optional_examples',
    intimacyCore: 'gravity_mode_intimacy_core',
    intimacyOptional: 'gravity_mode_intimacy_optional_examples',
    timeskipCore: 'gravity_mode_timeskip_core',
    // prose modulation keys (fired alongside mode gameplay keys)
    proseRegular: 'gravity_prose_regular',
    proseCombat: 'gravity_prose_combat',
    proseIntimacy: 'gravity_prose_intimacy',
    proseAdvance: 'gravity_prose_advance',
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
                rewritten.push({
                    op: 'TR',
                    e: tx.e,
                    id: tx.id,
                    d: { f: field, to: value },
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
    const details = normalizeText(col?.details);
    const forces = getCollisionForcesText(col);
    const cost = normalizeText(col?.cost);
    const targetConstraint = normalizeText(col?.target_constraint);
    if (details) lines.push(`Thread: ${details}`);
    if (forces) lines.push(`Forces: ${forces}`);
    else if (!details) lines.push(`Collision: ${col?.name || id}`);

    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);

    return lines.join('\n');
}

function isThinCollisionDetails(details) {
    const clean = normalizeText(details);
    if (!clean) return false;
    const words = clean.split(/\s+/).filter(Boolean);
    return clean.length < 80 || words.length < 12;
}

function buildCollisionNarrativeWarnings(id, col, status) {
    const warnings = [];
    const name = col?.name || id;
    const details = normalizeText(col?.details);
    const cost = normalizeText(col?.cost);
    const forces = getCollisionForcesText(col);

    if (!forces) {
        warnings.push(`"${name}" is ${status} but missing forces — SET collision:${id}.forces so the pressure has named poles.`);
    }

    if (!details) {
        warnings.push(`"${name}" is ${status} but missing details — every live collision needs a narrative thread. SET collision:${id}.details to a compact story capsule naming: what is converging, who or what is caught in it, how it is surfacing now, and the forced choice looming.`);
    } else if (isThinCollisionDetails(details)) {
        warnings.push(`"${name}" details are still too thin — rewrite collision:${id}.details as a fuller story capsule with source pressure, the people or places at risk, the present expression, and the forced choice looming.`);
    }

    if ((status === 'SIMMERING' || status === 'ACTIVE' || status === 'RESOLVING') && !cost) {
        warnings.push(`"${name}" is ${status} but missing cost — SET collision:${id}.cost to what engagement, delay, or failure will cost.`);
    }

    return warnings;
}

\\b`, 'i').test(point || '')).length;
}

/**
 * Get the active divination system. Checks chatMetadata first, then ledger state.
 */
function getActiveDivinationSystem() {
    const { chatMetadata } = SillyTavern.getContext();
    const stored = chatMetadata?.['gravity_divination_system'];
    // Back-compat: old chats with iching selected fall through to arcana
    if (stored === 'iching' || stored === 'i_ching' || stored === 'i ching') return 'arcana';
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
    const cardName = ARCANA_TABLE[num].split(' â€” ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' â€” ')[1] || '';
    const prefix = source === 'manual' && sourceText ? `MANUAL ROLL: ${sourceText}\n` : '';
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
        reading: `${prefix}#${num} â€” ${ARCANA_TABLE[num]}\nUSE THIS EXACT CARD. Do not override or pick a different one.\n${getNarrativeForcingText(source)}`,
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

        const d1 = Math.floor(Math.random() * 10) + 1;
        const d2 = Math.floor(Math.random() * 10) + 1;
        const total = d1 + d2;
        return {
            system: 'classic',
            label: 'THE DICE ROLLED',
            num: total,
            reading: `${d1} + ${d2} = ${total}\n${CLASSIC_TABLE}\n${NARRATIVE_FORCING}`,
            html: '',
        };
    }

    // Default: arcana (d22, 0-indexed)
    const num = Math.floor(Math.random() * 22);
    const cardName = ARCANA_TABLE[num].split(' — ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' — ')[1] || '';
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
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
 * Check if incoming transactions fix any pending corrections.
 * A correction is "fixed" if a new valid transaction matches the same entity+op.
 */
function clearMatchedCorrections(committedTxns) {
    if (_pendingCorrections.length === 0) return;

    _pendingCorrections = _pendingCorrections.filter(corr => {
        // Try to see if any committed tx matches this correction's entity
        // Simple heuristic: if correction's raw text mentions the same entity id
        // and a tx was committed for that entity, consider it fixed
        for (const tx of committedTxns) {
            if (tx.id && corr.raw.includes(tx.id)) return false;
            if (tx.e && corr.raw.toLowerCase().includes(tx.e)) return false;
        }
        return true;
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
    if (ids.length === 0) return 'no tracked characters';
    return ids.map(id => {
        const c = state.characters[id];
        if (!c) return id;
        const locName = c.location ? (state.places?.[c.location]?.name || c.location) : null;
        return locName ? `${c.name || id} @ ${locName}` : (c.name || id);
    }).join(', ');
}

// Stub: full sanity-check template implemented in PR-D (Task 7)
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
    const immediateNote = col.distance_category === 'IMMEDIATE'
        ? '\nThis collision arrives immediately — brief, sharp, decisive. Resolve in this scene.'
        : '';
    return `[GRAVITY — COLLISION ARRIVED: "${col.name || col.id}"]
Draw: ${draw.label} — ${draw.reading}

Forces: ${col.forces || '(unspecified)'}
Involved: ${involvedSummary}
Anchored at: ${placeName || 'unspecified'}
${proximityLine}${immediateNote}

SANITY CHECK — commit one of these NOW:

  ON-SCREEN — The collision's forces are present in this scene. Make it the central beat.
    Write it arriving. Then in the ledger:
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DIRECT
      S collision:${col.id} field=aftermath value="<what permanently changed>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] on-screen — <how> [hook] <handles> [aftermath] <change>"

  OFF-SCREEN — The forces resolved while characters were elsewhere. Choose:
    A) REFRAME — it mutated. Create a successor.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=EVOLVED
      A collision:${col.id} field=successor_collision_ids value=<new-id>
      CR collision:<new-id> name="..." distance_category=SHORT forces="..." ...
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] off-screen — mutated into <new-id> [hook] <handles> [aftermath] <change>"
    B) DISSOLVE — it ended quietly.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DISSOLVED
      S collision:${col.id} field=aftermath value="<one sentence: what changed off-screen>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] off-screen — dissolved [hook] <any residue> [aftermath] <change>"

  IMPLODE — The narrative has moved completely past this.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=IMPLODED
      S collision:${col.id} field=aftermath value="Imploded — narrative moved on."
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] imploded — <why> [hook] none [aftermath] n/a"

CRASHED status — if distance hits 0 and the scene does not engage:
      TR collision:${col.id} field=status from=ACTIVE to=CRASHED
      S collision:${col.id} field=outcome_type value=CRASHED
      S collision:${col.id} field=aftermath value="<consequence of being ignored>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] crashed — ignored [hook] <consequence threads> [aftermath] <change>"

No multi-turn delay. This collision is decided this turn.`;
}

function buildAndInjectArrivals(ids, state) {
    const blocks = [];
    for (const id of ids) {
        if (_firedCollisionArrivals.has(id)) continue;
        _firedCollisionArrivals.add(id);
        const col = state.collisions[id];
        if (!col) continue;
        const draw = drawDivination();
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
    if (blocks.length > 0) {
        if (blocks.length > 1) {
            const names = ids
                .filter(id => state.collisions[id])
                .map(id => `"${state.collisions[id].name || id}"`)
                .join(', ');
            blocks.unshift(`[SIMULTANEOUS ARRIVALS — ${blocks.length} collisions have arrived this turn: ${names}. ONLY ONE may resolve ON-SCREEN. Apply rule of cool — pick the most dramatically compelling. Resolve the rest OFF-SCREEN (REFRAME or DISSOLVE) or IMPLODE. Every arrived collision must be committed this turn.]`);
        }
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks.join('\n\n'), PROMPT_IN_CHAT, 0);
        _arrivalLastFiredTurn = _turnCounter;
        console.log(`${LOG_PREFIX} Collision arrival injection: ${blocks.length} block(s)`);
    }
}

// ─── Foreshadowing ────────────────────────────────────────────────────────────

function buildForeshadowBlock(col, level) {
    const placeName = col.location ? (_currentState.places?.[col.location]?.name || col.location) : 'unspecified';
    const involved = buildInvolvedCharsSummary(col, _currentState);
    const current = Math.round(parseFloat(col.distance));
    const guidance = {
        APPROACHING: 'A distant rumble. An offhand remark. Plant the seed.',
        IMMINENT: "Someone moves differently. A name surfaces. The collision's forces are near.",
        CONVERGING: "The forces are visibly in motion. Every other beat should carry their weight.",
    }[level];
    return `[FORESHADOW — ${level}]
"${col.name || col.id}" is drawing closer (${current} ticks remaining).
Anchored at: ${placeName} | Involved: ${involved}
${guidance}
Weave its approach into the scene without making it the focus.`;
}

function buildForeshadowingInjection(state) {
    const lines = [];
    for (const [id, col] of Object.entries(state.collisions || {})) {
        if (col.distance_category === 'IMMEDIATE') continue;
        if ((col.status || '').toUpperCase() !== 'ACTIVE') continue;

        const start = CATEGORY_DISTANCES[col.distance_category] ?? 10;
        const current = parseFloat(col.distance);
        if (isNaN(current) || current <= 0) continue;

        const pct = current / start;
        const fired = _foreshadowedCollisions.get(id) || new Set();

        let level = null;
        if (pct <= 0.20 && !fired.has('CONVERGING')) level = 'CONVERGING';
        else if (pct <= 0.50 && !fired.has('IMMINENT')) level = 'IMMINENT';
        else if (pct <= 0.80 && !fired.has('APPROACHING')) level = 'APPROACHING';

        if (!level) continue;
        fired.add(level);
        // Subsumption — firing a higher-urgency level implies all lower levels were skipped
        if (level === 'CONVERGING') {
            fired.add('IMMINENT');
            fired.add('APPROACHING');
        } else if (level === 'IMMINENT') {
            fired.add('APPROACHING');
        }
        _foreshadowedCollisions.set(id, fired);
        lines.push(buildForeshadowBlock(col, level));
    }
    return lines.length > 0 ? lines.join('\n\n') : null;
}

/**
 * Inject prompts based on turn mode.
 * @param {'regular'|'advance'|'integration'} [mode='regular']
 *   regular     — player prose turn (slim state, core readme)
 *   advance     — world moves turn (full state, core readme, skip heartbeat/dormant)
 *   integration — timeskip/setup (full state, full readme)
 */
function injectPrompt(mode) {
    // If no mode specified, reuse the current mode (prevents GENERATION_STARTED from downgrading)
    if (mode) {
        _currentInjectMode = mode;
    }
    const activeMode = _currentInjectMode;

    const context = SillyTavern.getContext();
    const { setExtensionPrompt } = context;
    if (!setExtensionPrompt) return;

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
            const stateViewMode = getStateViewMode(isRegular, isAdvance, isIntegration, challengeRuntimeActive, nextReasonMode);
            const stateView = formatStateView(_currentState, stateViewMode);
            setExtensionPrompt(`${MODULE_NAME}_state`, stateView, PROMPT_IN_CHAT, 0);
        }

        // Format readme — core on regular/advance, full on integration
        const readme = formatReadme(isIntegration ? 'full' : 'core');
        setExtensionPrompt(`${MODULE_NAME}_readme`, readme, PROMPT_IN_CHAT, 0);

        // Setup wizard phase prompt (overrides corrections when active)
        const setupPrompt = getPhasePrompt();
        if (setupPrompt) {
            setExtensionPrompt(`${MODULE_NAME}_setup`, setupPrompt, PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_setup`, '', PROMPT_NONE, 0);
        }

        // OOC command injection (from buttons)
        // Only update when there's a new injection — don't clear on re-inject
        // (GENERATION_STARTED re-calls injectPrompt, which would wipe the OOC prompt)
        if (_pendingOOCInjection) {
            setExtensionPrompt(`${MODULE_NAME}_ooc`, _pendingOOCInjection, PROMPT_IN_CHAT, 0);
            _pendingOOCInjection = null;
        }

        const challengePromptBody = _currentState ? buildChallengePrompt(_currentState) : '';
        if (challengePromptBody && activeProfile) {
            setExtensionPrompt(
                `${MODULE_NAME}_challenge`,
                buildModeInjection(
                    `GRAVITY CHALLENGE — Active ${activeProfile.displayName} Session`,
                    challengePromptBody,
                    Object.values(activeProfile.lorebookKeys).filter(Boolean),
                ),
                PROMPT_IN_CHAT,
                0,
            );
        } else {
            setExtensionPrompt(`${MODULE_NAME}_challenge`, '', PROMPT_NONE, 0);
        }
        // Clear legacy combat slot if it was previously set
        setExtensionPrompt(`${MODULE_NAME}_combat`, '', PROMPT_NONE, 0);

        // Corrections + reinforcement
        let injection = '';
        if (_pendingCorrections.length > 0) {
            injection = buildCorrectionInjection(_pendingCorrections) || '';
        }
        if (_pendingReinforcement) {
            injection = injection ? injection + '\n' + _pendingReinforcement : _pendingReinforcement;
        }

        if (injection) {
            setExtensionPrompt(`${MODULE_NAME}_inject`, injection, PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_inject`, '', PROMPT_NONE, 0);
        }

        // Style exemplars — inject mode-matched good paragraphs (skip on integration turns — no prose)
        const { chatMetadata } = SillyTavern.getContext();
        const exemplars = (!isIntegration && chatMetadata?.['gravity_exemplars']) || [];
        if (exemplars.length > 0) {
            const selected = selectExemplarsForPrompt(exemplars, activeMode, nextReasonMode, 3);
            const exLines = selected.map(formatExemplarForPrompt).join('\n');
            setExtensionPrompt(`${MODULE_NAME}_exemplars`,
                `[STYLE EXEMPLARS — the player flagged these as strong prose. Match the structural strengths that fit this turn's mode. Do not copy exact wording, imagery, or house voice.\n${exLines}]`,
                PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_exemplars`, '', PROMPT_NONE, 0);
        }

        // Faction heartbeat — every 10 turns on regular turns only (advance/integration handle factions directly)
        if (isRegular && !challengeSessionLocked && _turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
            const factions = Object.values(_currentState.factions || {});
            if (factions.length > 0) {
                const factionDetails = factions.map(f => {
                    let detail = `${f.name || f.id} (${f.objective || '?'})`;
                    if (f.power) detail += ` [${f.power}]`;
                    if (f.momentum) detail += ` — doing: ${f.momentum}`;
                    return detail;
                }).join('\n  ');
                setExtensionPrompt(`${MODULE_NAME}_faction`,
                    `[FACTION HEARTBEAT — Turn ${_turnCounter}.\n  ${factionDetails}\nFactions execute operations independently based on their MOMENTUM. Leaders command subordinates — show the chain of command. Rising factions expand; declining factions get desperate. Check faction RELATIONS for alliance/rivalry dynamics. You may CUT to a faction scene before cutting back. If no faction has visibly acted in recent turns, one MUST advance NOW — pick the faction whose MOMENTUM most threatens the current scene.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_faction`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_faction`, '', PROMPT_NONE, 0);
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
                    dormant.push(`${char.name || id} [${char.tier}] — WANT: ${char.want || '?'} — last activity ${gap} transactions ago`);
                }
            }
            if (dormant.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_dormant`,
                    `[DORMANT CHARACTERS — gravity still pulls these characters toward collision:\n${dormant.map(d => '  • ' + d).join('\n')}\nGravity is constant — however weak, it pulls toward collision. Their WANT is a force. Their DOING has consequences. Advance them toward the nearest collision — or spawn a new one from their WANT intersecting the current situation.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_dormant`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_dormant`, '', PROMPT_NONE, 0);
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
                if (status !== 'RESOLVED') continue;
                if (!col.outcome_type) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing outcome_type (DIRECT / EVOLVED / MERGED / IMPLODED / CRASHED)`);
                if (!col.aftermath) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing aftermath — what changed, what was lost, what it left behind`);
                if ((col.outcome_type === 'EVOLVED' || col.outcome_type === 'MERGED') && !col.successor_collision_ids) {
                    closureWarnings.push(`"${col.name || id}" has outcome_type: ${col.outcome_type} but no successor_collision_ids — link or explain why no successor seam remains`);
                }
            }
            if (closureWarnings.length > 0) {
                collisionWarnings.push(...closureWarnings.map(w => `[CLOSURE AUDIT] ${w}`));
            }

            if (_arrivalLastFiredTurn !== _turnCounter) {
                // Only clear if buildAndInjectArrivals did not already set the slot this turn
                setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            }

            if (collisionWarnings.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_dist_warn`,
                    `[COLLISION AUDIT:\n${collisionWarnings.map(w => '  • ' + w).join('\n')}]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_dist_warn`, '', PROMPT_NONE, 0);
            }
        } else {
            if (_arrivalLastFiredTurn !== _turnCounter) {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            }
            setExtensionPrompt(`${MODULE_NAME}_dist_warn`, '', PROMPT_NONE, 0);
        }

        // Intimacy stance enforcement — surface active stances so the LLM checks before writing
        if (_currentState) {
            const stanceLines = [];
            for (const [id, char] of Object.entries(_currentState.characters || {})) {
                if (!char.intimacy_stance) continue;
                stanceLines.push(`  ${char.name || id}: ${char.intimacy_stance}`);
            }
            if (stanceLines.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_intimacy`,
                    `[INTIMACY STANCE CHECK — respect these before writing intimate content:\n${stanceLines.join('\n')}\nThe character's stance is the boundary. The player's desire does not override it. If the scene escalates past what the stance allows, the character resists, freezes, or redirects — write THAT. Update the stance via SET only when a constraint shift or significant narrative event earns it.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_intimacy`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_intimacy`, '', PROMPT_NONE, 0);
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

        setExtensionPrompt(`${MODULE_NAME}_nudge`, nudgeText, PROMPT_IN_CHAT, 0);

        // ── Foreshadowing — pre-arrival threshold cues (§3.4) ─────────────────
        if ((isRegular || isAdvance) && _currentState) {
            const foreshadow = buildForeshadowingInjection(_currentState);
            if (foreshadow) {
                setExtensionPrompt(`${MODULE_NAME}_foreshadow`, foreshadow, PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_foreshadow`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_foreshadow`, '', PROMPT_NONE, 0);
        }
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
    // Check per-character arrays
    for (const [id, char] of Object.entries(state.characters || {})) {
        const noticed = char.noticed_details;
        if (Array.isArray(noticed) && noticed.length > 15) {
            warnings.push(`${char.name || id} NOTICED_DETAILS: ${noticed.length} entries — REMOVE fired/resolved details.`);
        }
        // key_moments are PERMANENT — never warn about size, never trim.
        // They are the character's lived history.
    }
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
    _foreshadowedCollisions = new Map();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();

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

    // Validate each transaction individually
    const validTxns = [];
    const validationErrors = [];
    let committedTxns = [];
    for (let i = 0; i < extractedTransactions.length; i++) {
        const tx = extractedTransactions[i];
        const result = validateBatch([tx]);
        if (!result.valid) {
            validationErrors.push({
                lineNum: i,
                error: result.errors.map(e => e.message).join('; '),
                raw: `[validated tx ${i}]`,
            });
            continue;
        }

        // ── Travel plausibility (§2.4) ────────────────────────────────────
        if (tx.op === 'S' && tx.e === 'char' && tx.d?.f === 'location') {
            const charBefore = _currentState.characters?.[tx.id];
            const fromPlaceId = charBefore?.location;
            const travel = validateTravel(tx.id, fromPlaceId, tx.d.v, _currentState, _currentInjectMode);
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
        // ─────────────────────────────────────────────────────────────────

        // ── Validate state machine transitions (TR ops only) ─────────────
        if (tx.op === 'TR') {
            const transitionResult = validateTransition(tx.e, tx.d?.f, tx.d?.from, tx.d?.to);
            if (!transitionResult.valid) {
                validationErrors.push({
                    lineNum: i,
                    error: transitionResult.error,
                    fix: transitionResult.fix,
                    raw: `[tr ${tx.e}:${tx.id}]`,
                });
                continue;
            }
        }
        // ─────────────────────────────────────────────────────────────────

        validTxns.push(tx);
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
            }

            console.log(`${LOG_PREFIX} Committed ${committed.length} TX, ${allErrors.length} errors. Turn ${_turnCounter}.`);
        } catch (err) {
            console.error(`${LOG_PREFIX} Commit failed:`, err);
        }
    }

    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Add distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR — the engine resolves the numeric distance.`,
                attempts: 0,
            });
        }
    }

    // ── Archive presence check (§2.2.1, §6.1) ──────────────────────────────────
    // After each commit, scan for terminal collision TRs without a matching archive append.
    if (committedTxns.length > 0) {
        const terminalIds = committedTxns
            .filter(tx => tx.op === 'TR' && tx.e === 'collision'
                && (tx.d?.to === 'RESOLVED' || tx.d?.to === 'CRASHED'))
            .map(tx => tx.id);

        const archiveAppended = committedTxns.some(tx =>
            tx.op === 'A' && tx.e === 'world' && tx.d?.f === 'collision_archive'
        );

        for (const colId of terminalIds) {
            if (archiveAppended) {
                _archiveCorrectionAttempts.delete(colId);
                continue;
            }
            const attempts = (_archiveCorrectionAttempts.get(colId) || 0) + 1;
            if (attempts > MAX_CORRECTION_ATTEMPTS) {
                // Auto-generate fallback archive entry
                const col = _currentState.collisions?.[colId];
                if (col) {
                    const fallback = `[collision] ${col.name || colId} [resolution] ${col.outcome_type || col.status} — auto-generated (archive missing after ${MAX_CORRECTION_ATTEMPTS} attempts) [hook] none [aftermath] ${col.aftermath || 'unknown'}`;
                    try {
                        const autoTxns = await append([{ op: 'A', e: 'world', id: '_', d: { f: 'collision_archive', v: fallback }, r: 'system:archive:auto-fallback' }]);
                        _currentState = computeState(_currentState, autoTxns);
                    } catch (_) { /* non-critical */ }
                }
                _archiveCorrectionAttempts.delete(colId);
            } else {
                _archiveCorrectionAttempts.set(colId, attempts);
                queueCorrections([{
                    raw: `[collision:${colId} archive]`,
                    error: `Missing archive entry for resolved collision ${colId}. Add: A world field=collision_archive value="[collision] ... [resolution] ... [hook] ... [aftermath] ..."`,
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

    // ── IMMEDIATE collision firing (§3.3) — fire on the turn they are created ──
    if (_currentState) {
        const immediateArrivals = committedTxns
            .filter(tx => tx.op === 'CR' && tx.e === 'collision'
                && tx.d?.distance_category === 'IMMEDIATE')
            .map(tx => tx.id)
            .filter(id => !_firedCollisionArrivals.has(id));
        if (immediateArrivals.length > 0) {
            buildAndInjectArrivals(immediateArrivals, _currentState);
        }
    }

    // ── Pressure FIFO cap (§4.1) — auto-drop oldest when pool exceeds 5 ────────
    if (_currentState) {
        const pressureCRs = committedTxns.filter(tx => tx.op === 'CR' && tx.e === 'pressure');
        if (pressureCRs.length > 0) {
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
    }

    // ── Collision pool cap warning (§4.2) ───────────────────────────────────────
    if (_currentState) {
        const activeNonImmediate = Object.values(_currentState.collisions || {})
            .filter(c => (c.status || '').toUpperCase() === 'ACTIVE'
                && c.distance_category !== 'IMMEDIATE');
        if (activeNonImmediate.length > MAX_COLLISIONS) {
            _pendingCorrections.push({
                text: `Collision pool has ${activeNonImmediate.length} active non-IMMEDIATE collisions (cap ${MAX_COLLISIONS}). Consolidate: merge two with the MERGE flow, or IMPLODE the least relevant one. IMMEDIATE collisions are exempt.`,
                attempts: 0,
            });
        }
    }

    injectPrompt();
    updatePanel(_currentState, _turnCounter, committedTxns.map(tx => tx.tx));
}

async function onUserMessage(messageId) {
    if (!_initialized) await initialize();

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
        // Rollback resets arrival/foreshadow state — the rolled-back collisions may re-arrive
        if (/ooc:\s*rollback\b/i.test(message.mes)) {
            _firedCollisionArrivals = new Set();
            _foreshadowedCollisions = new Map();
            _arrivalLastFiredTurn = -1;
        }
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
/**
 * Build the structured beat sequence for an advance turn.
 *
 * Beat structure (F1.1):
 *   Beat 1 — PLAYER RESOLUTION (mandatory): acknowledge player action + time + result
 *   Beats 2-N — WORLD MOVEMENT: arrived collisions, general focus
 *   Final beat — RETURN HOOK (mandatory): consequence arrives at player
 *
 * @param {Object} state - Current computed state
 * @param {Object} draw - Primary divination draw
 * @param {Array<{id: string, col: Object}>} ripeCollisions - Collisions at dist 0, not yet in resolution tracker
 * @param {Array<{id: string, col: Object}>} inProgressCollisions - RESOLVING or already-tracked at dist 0
 * @returns {string} The instruction block for the advance injection
 */
function buildAdvanceBeats(state, draw, ripeCollisions, inProgressCollisions, compressed = []) {
    const pcName = state?.pc?.name || '{{user}}';
    const lines = [];

    // ── Beat 1: PLAYER RESOLUTION (mandatory) ─────────────────────────────────
    lines.push(`BEAT 1 — PLAYER: ${pcName} continues. Time passes.`);
    lines.push(`  Write: acknowledge what the PC actually accomplished or failed to accomplish. Concrete result, 80-150w. The camera stays on the PC first.`);
    lines.push('');

    // ── Mechanical compression notice ─────────────────────────────────────────
    if (compressed.length > 0) {
        lines.push(`[ENGINE — DISTANCE COMPRESSED THIS TURN]`);
        for (const c of compressed) {
            lines.push(`  "${c.name}" distance: ${c.oldDist} → ${c.newDist}`);
        }
        lines.push(`  These distances were already decreased by the engine. Do NOT decrease them again in your ledger output this turn.`);
        lines.push('');
    }

    // ── Beats 2-N: WORLD MOVEMENT ─────────────────────────────────────────────
    let beatNum = 2;

    // Arrived collisions take priority in world movement beats
    if (ripeCollisions.length > 0) {
        const colBlocks = ripeCollisions.map(a => {
            const details = buildCollisionStoryCapsule(a.id, a.col);
            return `    COLLISION: "${a.col.name || a.id}" [dist:0]\n${details.split('\n').map(l => '    ' + l).join('\n')}`;
        }).join('\n');
        lines.push(`BEAT ${beatNum} — COLLISION ARRIVES:`);
        lines.push(colBlocks);
        lines.push(`  MOVE each arrived collision to RESOLVING.`);
        lines.push('');
        beatNum++;
    }

    // In-progress collisions push toward resolution
    if (inProgressCollisions.length > 0) {
        const colBlocks = inProgressCollisions.map(a => {
            const details = buildCollisionStoryCapsule(a.id, a.col);
            return `    "${a.col.name || a.id}" [${a.col.status}]\n${details.split('\n').map(l => '    ' + l).join('\n')}`;
        }).join('\n');
        lines.push(`BEAT ${beatNum} — COLLISION PUSHES:`);
        lines.push(colBlocks);
        lines.push(`  Keep it moving. Either resolve this turn or force a sharper crisis.`);
        lines.push('');
        beatNum++;
    }

    // If no collisions, use a general focus beat
    if (ripeCollisions.length === 0 && inProgressCollisions.length === 0) {
        const focus = pickAdvanceFocus();
        const FOCUS_PROMPTS = {
            scene: `  FOCUS: THE SCENE — something local moves. An NPC acts, the environment shifts, someone arrives or leaves, a noticed detail fires.`,
            world: `  FOCUS: THE WORLD — cut away from ${pcName}. A faction or macro move plays out. Its consequences will land later.`,
            offscreen: `  FOCUS: OFF-SCREEN CHARACTER — a tracked character pursues their own want. Show the beat, update what it changes.`,
            new_threat: `  FOCUS: SOMETHING NEW — introduce a fresh complication or revelation that belongs to the current story logic.`,
            collision: `  FOCUS: PRESSURE TIGHTENS — pick the collision that creates the most honest pressure and show why it compressed. If no existing collision can carry the beat, escalate the hottest pressure point into a new collision and REMOVE the pressure point.`,
        };
        lines.push(`BEAT ${beatNum} — WORLD MOVE:`);
        lines.push(FOCUS_PROMPTS[focus.key] || FOCUS_PROMPTS.scene);
        lines.push('');
        beatNum++;
    }

    // ── Final Beat: RETURN HOOK (mandatory) ───────────────────────────────────
    lines.push(`BEAT ${beatNum} — RETURN (mandatory): The world's move lands on ${pcName}.`);
    lines.push(`  Write: the consequence of beats 2-${beatNum - 1} arrives at the PC. End on a new situation — something they must respond to. The camera returns. 80-150w.`);
    lines.push('');

    // ── Draw instruction ───────────────────────────────────────────────────────
    lines.push(formatDrawInstruction(draw, 'The draw colors how the world moves — its character and method, not the outcome.'));
    lines.push('');
    lines.push(`Record divination.last_draw, then write beats in order and end with a compact STATE block.`);

    return lines.join('\n');
}

async function handleAdvanceButton() {
    if (_advanceLocked) return;
    _advanceLocked = true;

    // Lock DOM button immediately; re-enable on next MESSAGE_RECEIVED
    const advBtn = document.getElementById('gl-input-advance');
    if (advBtn) {
        advBtn.disabled = true;
        const reenableAdvBtn = () => {
            advBtn.disabled = false;
            _advanceLocked = false;
            eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
    }

    try {
    _pendingDeductionType = 'advance';

    // ── Advance preconditions (§3.2) ──────────────────────────────────────────
    if (_currentState) {
        // Hard block: any ACTIVE collision at distance 0 must be resolved first
        const unresolved = Object.values(_currentState.collisions || {}).find(col =>
            (col.status || '').toUpperCase() === 'ACTIVE' &&
            parseFloat(col.distance) <= 0
        );
        if (unresolved) {
            toastr.error(`Unresolved arrival: "${unresolved.name || unresolved.id}" has arrived (distance 0). Resolve it before advancing.`);
            if (advBtn) { advBtn.disabled = false; }
            _advanceLocked = false;
            return;
        }

        // Advisory: PC in active combat
        const pcInCombat = Object.values(_currentState.combats || {}).some(c => (c.status || '').toUpperCase() === 'ACTIVE');
        if (pcInCombat) {
            toastr.warning('PC is not in a safe position to timeskip. Consider resolving the current situation before advancing.');
        }
    }

    // ── Engine-side distance compression (timeskip-scale-aware, §3.2) ────────
    const compressed = [];
    if (_currentState) {
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
                compressed.push({ id, name: col.name || id, oldDist: dist, newDist });
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

        // Reset timeskip_scale after consuming — use '' to survive JSON round-trip
        if (_currentState.world?.timeskip_scale) {
            await append([{ op: 'S', e: 'world', id: '_', d: { f: 'timeskip_scale', v: '' }, r: 'system:advance:reset-timeskip' }]);
            _currentState = computeCurrentState();
        }

        updatePanel(_currentState, _turnCounter);
    }

    // ── Arrival detection: fire sanity-check gate for newly arrived collisions ──
    const newArrivalIds = [];
    if (_currentState) {
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const status = (col.status || '').toUpperCase();
            const dist = parseFloat(col.distance);
            if (status === 'ACTIVE' && !isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
                newArrivalIds.push(id);
            }
        }
    }
    if (newArrivalIds.length > 0) {
        buildAndInjectArrivals(newArrivalIds, _currentState);
    }
    // Build beat data from arrived collisions for the advance beat template
    const ripeCollisions = newArrivalIds.map(id => ({ id, col: _currentState.collisions[id] })).filter(a => a.col);
    // RESOLVING collisions still surfaced in advance beats for legacy back-compat (removed in PR-E)
    const inProgressCollisions = [];
    if (_currentState) {
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const status = (col.status || '').trim().toUpperCase();
            if (status === 'RESOLVING') {
                inProgressCollisions.push({ id, col });
            }
        }
    }

    const draw = drawDivination();
    const beatBlock = buildAdvanceBeats(_currentState, draw, ripeCollisions, inProgressCollisions, compressed);

    const markers = [MODE_LOREBOOK_KEYS.advanceCore, MODE_LOREBOOK_KEYS.advanceOptional, MODE_LOREBOOK_KEYS.proseAdvance];
    _pendingOOCInjection = buildModeInjection('GRAVITY ADVANCE', beatBlock, markers);

    injectPrompt('advance');
    const pcName = _currentState?.pc?.name || '{{user}}';
    insertChatMessage(`*${pcName} continues.*`);

    } catch (err) {
        console.error(`${LOG_PREFIX} handleAdvanceButton error:`, err);
        if (advBtn) { advBtn.disabled = false; }
        _advanceLocked = false;
    }
}

async function handleCombatButton() {
    if (!isChallengeSessionLocked()) {
        await startChallengeRuntime('combat', drawDivination());
        _currentState = computeCurrentState();
        _pendingDeductionType = 'combat';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
    }
    insertChatMessage('combat: ');
}

function handleIntimacyButton() {
    _pendingDeductionType = 'intimacy';
    const pcName = _currentState?.pc?.name || '{{user}}';

    const stances = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        if (char.tier === 'UNKNOWN' || char.tier === 'KNOWN') continue;
        if (char.intimacy_stance) {
            stances.push(`${char.name || id}: ${char.intimacy_stance}`);
        }
    }

    const histories = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        const ih = char.intimate_history;
        if (ih && typeof ih === 'object' && Object.keys(ih).length) {
            histories.push(`${char.name || id}: ${Object.entries(ih).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
    }

    const intimacyDraw = drawDivination();
    const stanceBlock = stances.length
        ? `ACTIVE STANCES:\n${stances.map(s => `  ${s}`).join('\n')}`
        : 'No explicit intimacy stances are stored yet.';
    const historyBlock = histories.length
        ? `INTIMATE HISTORY:\n${histories.map(h => `  ${h}`).join('\n')}`
        : 'No intimate history exists yet. Treat this as discovery.';

    _pendingOOCInjection = buildModeInjection(
        'GRAVITY INTIMACY',
        `${pcName} initiates an intimate scene.

${formatDrawInstruction(intimacyDraw, 'The draw colors tone and texture, not consent or plot.')}

Before activating, check that the scene is earned, clearly beyond casual contact, and that consent is plausible from the current dossiers and stances. If any answer is no, ignore this instruction and write normal prose.

${stanceBlock}

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

    injectPrompt();
    toastr.success('Exemplar saved');
}

function handleRegisterButton() {
    insertChatMessage('OOC: promote ');
}

async function handleTimeskipButton() {
    const { Popup } = SillyTavern.getContext();
    const duration = await Popup.show.input('Timeskip', 'How much time passes? (e.g., "3 days", "a week", "until morning")');
    if (!duration) return;

    if (_currentState) {
        try {
            await createSnapshot(_currentState, 'Pre-timeskip snapshot');
            console.log(`${LOG_PREFIX} Pre-timeskip snapshot created.`);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Pre-timeskip snapshot failed:`, err);
        }
    }

    const timeskipDraw = drawDivination();

    _pendingOOCInjection = buildModeInjection(
        'GRAVITY TIMESKIP',
        `The user requested a time skip of "${duration}". For this response only, narrate as an impartial omniscient voice called "The Passage of Time."

${formatDrawInstruction(timeskipDraw, 'The draw shapes the character of the elapsed time - what kind of pressure, drift, or convergence defines this skip. It does not override continuity or collision logic.')}

First, sanity-check whether active danger, pursuit, or unresolved pressure would interrupt the skip. If yes, abort early and drop the player into that interruption.

Advance the world honestly across 3-6 beats: the PC's rhythm, at least one off-screen faction or tracked character, a collision or pressure point tightening, and the landing scene that demands response now.

Use a full LEDGER block for the structural updates across characters, factions, collisions, world, and pressure points. Record divination.last_draw in the update block.`,
        [MODE_LOREBOOK_KEYS.timeskipCore],
    );

    injectPrompt('integration');
    insertChatMessage(`OOC: Timeskip - ${duration}`);
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

        // Reinitialize to recompute state
        await clearChallengeRuntime();
        resetLedger();
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
    delete chatMetadata['gravity_combat_runtime'];
    delete chatMetadata['gravity_combat_settings'];
    delete chatMetadata['gravity_challenge_runtime'];
    delete chatMetadata['gravity_challenge_settings'];
    await saveMetadata();
    resetLedger();
    _pendingCorrections = [];
    _pendingReinforcement = null;
    _firedCollisionArrivals = new Set();
    _foreshadowedCollisions = new Map();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();
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
    delete chatMetadata['gravity_combat_runtime'];
    delete chatMetadata['gravity_combat_settings'];
    delete chatMetadata['gravity_challenge_runtime'];
    delete chatMetadata['gravity_challenge_settings'];
    await importData(data);
    _pendingCorrections = [];
    _pendingReinforcement = null;
    _firedCollisionArrivals = new Set();
    _foreshadowedCollisions = new Map();
    _arrivalLastFiredTurn = -1;
    _archiveCorrectionAttempts = new Map();
    await initialize(true);
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    createPanel();
    setCallbacks({
        onNew: handleNewLedger,
        onExport: handleExportData,
        onImport: handleImportData,
        onSetup: handleSetupButton,
        onTimeskip: handleTimeskipButton,
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

    // Quick-access buttons above chat input
    createInputButtons();

    // Intimacy clickable actions handled by st-clickable-actions extension
    // LLM outputs: <span class="act" data-value="intimate: action">Display</span>

    console.log(`${LOG_PREFIX} Extension registered.`);
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
})();

function createInputButtons() {
    const sendForm = document.getElementById('form_sheld');
    if (!sendForm) return;

    const bar = document.createElement('div');
    bar.id = 'gl-input-bar';
    bar.innerHTML = `
        <button class="gl-input-btn" id="gl-input-advance" title="Advance — world takes a turn"><i class="fa-solid fa-play"></i> Advance</button>
        <button class="gl-input-btn" id="gl-input-combat" title="Initiate combat"><i class="fa-solid fa-burst"></i> Combat</button>
        <button class="gl-input-btn" id="gl-input-intimacy" title="Initiate intimate scene"><i class="fa-solid fa-heart"></i> Intimacy</button>
        <button class="gl-input-btn" id="gl-input-skip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
        <button class="gl-input-btn" id="gl-input-good" title="Flag good prose — paste exemplar"><i class="fa-solid fa-thumbs-up"></i> Good</button>
    `;
    sendForm.insertBefore(bar, sendForm.firstChild);

    document.getElementById('gl-input-advance').addEventListener('click', handleAdvanceButton);
    document.getElementById('gl-input-combat').addEventListener('click', handleCombatButton);
    document.getElementById('gl-input-intimacy').addEventListener('click', handleIntimacyButton);
    document.getElementById('gl-input-skip').addEventListener('click', handleTimeskipButton);
    document.getElementById('gl-input-good').addEventListener('click', handleGoodTurnButton);
}




