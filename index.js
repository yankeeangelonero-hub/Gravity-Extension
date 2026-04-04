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
import { computeState, applyTransaction, createEmptyState, getArrayItemHistory } from './state-compute.js';
import { formatStateView, formatReadme } from './state-view.js';
import { extractUpdateBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning } from './ui-panel.js';
import { isActive as isSetupActive, getPhasePrompt, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback, showSetupPopup, buildSetupPrompt } from './setup-wizard.js';
import { checkAndRotate, buildConsolidationPrompt } from './memory-tier.js';
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

// ─── Collision Resolution Tracking ───────────────────────────────────────────

// Map of collision ID → { phase, arrivalTurn, arrivalDraw, lastEscalationDraw }
// phase: 'arrived' → 'pressure' → 'intrusion' → 'crash'
// Cleared on chat change.
let _firedCollisionArrivals = new Set(); // legacy compat — still used for one-shot arrival detection
let _resolutionTracker = new Map();      // collision id → resolution state

const RESOLUTION_PRESSURE_TURNS = 2;  // turns 1-2: oracle bleeds into atmosphere
const RESOLUTION_INTRUSION_TURNS = 4; // turns 3-4: oracle manifests, direct intrusion
const RESOLUTION_CRASH_TURNS = 6;     // turn 5+: oracle decides, crash if unresolved

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
    chapterCloseCore: 'gravity_mode_chapter_close_core',
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
        chapter: state.chapters,
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
    const manifestation = normalizeText(col?.last_manifestation);

    if (details) lines.push(`Thread: ${details}`);
    if (forces) lines.push(`Forces: ${forces}`);
    else if (!details) lines.push(`Collision: ${col?.name || id}`);

    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);
    if (manifestation) lines.push(`Current manifestation: ${manifestation}`);

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
    const manifestation = normalizeText(col?.last_manifestation);
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

    if ((status === 'ACTIVE' || status === 'RESOLVING') && !manifestation) {
        warnings.push(`"${name}" is ${status} but missing last_manifestation — SET collision:${id}.last_manifestation to the concrete way this pressure is entering the scene right now.`);
    }

    return warnings;
}

function getPressurePoints(state) {
    const raw = state?.world?.pressure_points;
    if (Array.isArray(raw)) return raw.map(p => normalizeText(p)).filter(Boolean);
    if (raw) return [normalizeText(raw)].filter(Boolean);
    return [];
}

function getPressurePointAgeTx(state, point) {
    const history = getArrayItemHistory(state, 'world', '_', 'pressure_points', point);
    const lastAdd = [...history].reverse().find(entry => entry.to !== undefined);
    return lastAdd ? Math.max(0, (state?.lastTxId || 0) - (lastAdd.tx || 0)) : null;
}

function classifyPressurePointAge(ageTx) {
    if (ageTx == null) return 'unknown';
    if (ageTx >= 18) return 'stale';
    if (ageTx >= 8) return 'aging';
    return 'fresh';
}

function buildPressurePointAudit(state) {
    const pressurePoints = getPressurePoints(state);
    if (pressurePoints.length === 0) return null;

    const liveCollisions = Object.entries(state?.collisions || {})
        .filter(([, col]) => normalizeText(col?.status).toUpperCase() !== 'RESOLVED')
        .map(([id, col]) => ({
            id,
            name: col?.name || id,
            text: normalizeText([
                col?.name,
                col?.details,
                getCollisionForcesText(col),
                col?.cost,
                col?.last_manifestation,
            ].filter(Boolean).join(' | ')),
        }));

    const warnings = [];
    const embodied = [];
    const duplicates = [];
    const candidates = [];
    const seen = [];
    const annotated = [];

    for (const point of pressurePoints) {
        const duplicateOf = seen.find(prev => stringSimilarity(prev, point) > 0.82);
        if (duplicateOf) {
            duplicates.push({ point, duplicateOf });
            continue;
        }
        seen.push(point);

        const matchedCollision = liveCollisions.find(col => {
            const pointText = point.toLowerCase();
            const collisionText = col.text.toLowerCase();
            const collisionName = normalizeText(col.name).toLowerCase();
            return stringSimilarity(point, col.text) > 0.5
                || (collisionName && pointText.includes(collisionName))
                || (collisionName && collisionText.includes(pointText))
                || (pointText.length > 12 && collisionText.includes(pointText));
        });

        const ageTx = getPressurePointAgeTx(state, point);
        const ageClass = classifyPressurePointAge(ageTx);
        if (matchedCollision) {
            embodied.push({ point, collision: matchedCollision.name, ageTx, ageClass });
        } else {
            candidates.push({ point, ageTx, ageClass });
        }
        annotated.push({ point, ageTx, ageClass, matchedCollision: matchedCollision?.name || '' });
    }

    if (pressurePoints.length > 5) {
        warnings.push(`PRESSURE_POINTS: ${pressurePoints.length} live seams — trim stale ones and convert the hottest seam into a collision if it now has actors, cost, and a forced choice.`);
    }
    for (const dup of duplicates.slice(0, 3)) {
        warnings.push(`Pressure point "${dup.point}" duplicates "${dup.duplicateOf}" — REMOVE one duplicate. Pressure points are seeds, not a backlog.`);
    }
    for (const item of embodied.slice(0, 3)) {
        warnings.push(`Pressure point "${item.point}" appears to already be embodied by live collision "${item.collision}" — REMOVE the pressure point if that seam has already graduated into the collision.`);
    }
    for (const item of candidates.filter(item => item.ageClass === 'stale').slice(0, 3)) {
        warnings.push(`Pressure point "${item.point}" has been live for ${item.ageTx} tx without graduating — REMOVE it as stale or ESCALATE it into a collision now.`);
    }
    if (liveCollisions.length === 0 && candidates.length > 0) {
        warnings.push(`No live collision currently carries these seams — escalate the hottest pressure point into a collision unless it is stale.`);
    } else if (candidates.length > liveCollisions.length + 1) {
        warnings.push(`There are ${candidates.length} pressure points not clearly carried by live collisions — prune stale seams or graduate one into a collision this turn.`);
    }

    const candidateLines = annotated.slice(0, 5).map(item => {
        const ageText = item.ageTx == null ? 'age unknown' : `${item.ageTx} tx old`;
        const statusText = item.matchedCollision
            ? `already embodied by collision "${item.matchedCollision}"`
            : item.ageClass === 'stale'
                ? 'stale if not escalated now'
                : item.ageClass === 'aging'
                    ? 'aging seam'
                    : 'fresh seam';
        return `  • ${item.point} — ${ageText}; ${statusText}`;
    });
    const prompt = `[PRESSURE POINT CHECK:
${candidateLines.length ? candidateLines.join('\n') : '  • Review current seams and remove any that already fired.'}
Pressure points are SEEDS, not history.
For each pressure point, decide one:
  KEEP — only if it is still a live seam but not yet specific enough to become a collision.
  REMOVE — if it fired, resolved, became irrelevant, or is already embodied by a live collision.
  ESCALATE — if it now has actors, a concrete cost, and a looming forced choice, CREATE a collision from it and REMOVE the pressure point in the same turn.
If no live collision currently carries the world's pressure, at least one surviving pressure point should either escalate into a collision or be pruned as stale.]`;

    return { warnings, prompt };
}

/**
 * Pressure ignition engine — selects a pressure point to ignite as a flash collision.
 *
 * Selection logic (from v15 spec F2.2):
 *   stale  (18+ tx): MANDATORY flash at dist 0
 *   aging  (8-17 tx): RECOMMENDED flash at dist 0-1 if score > 0
 *   fresh  (<8 tx):  OPTIONAL — only if score >= 3
 *
 * Returns null if no pressure point qualifies this turn.
 *
 * @param {Object} state - Current computed state
 * @param {Object} draw - Current divination draw (from drawDivination())
 * @returns {{ point: string, dist: number, mandate: 'mandatory'|'recommended'|'optional', score: number } | null}
 */
function buildFlashIgnition(state, draw) {
    const pressurePoints = getPressurePoints(state);
    if (pressurePoints.length === 0) return null;

    // Annotate each point with age and score
    const annotated = pressurePoints.map(point => {
        const ageTx = getPressurePointAgeTx(state, point);
        const ageClass = classifyPressurePointAge(ageTx);
        const score = scorePressurePointAgainstDraw(point, draw);
        return { point, ageTx, ageClass, score };
    });

    // Sort: stale first, then by score descending within each age class
    annotated.sort((a, b) => {
        const ageOrder = { stale: 0, aging: 1, fresh: 2, unknown: 3 };
        const aOrder = ageOrder[a.ageClass] ?? 3;
        const bOrder = ageOrder[b.ageClass] ?? 3;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.score - a.score;
    });

    for (const item of annotated) {
        if (item.ageClass === 'stale') {
            // Mandatory flash — this seam has waited too long
            return { point: item.point, dist: 0, mandate: 'mandatory', score: item.score };
        }
        if (item.ageClass === 'aging' && item.score > 0) {
            // Recommended flash — aging seam resonates with the draw
            const dist = item.score >= 2 ? 0 : 1;
            return { point: item.point, dist, mandate: 'recommended', score: item.score };
        }
        if (item.ageClass === 'fresh' && item.score >= 3) {
            // Optional flash — fresh but strongly resonates with draw themes
            return { point: item.point, dist: 2, mandate: 'optional', score: item.score };
        }
    }

    return null;
}

function pickAdvanceFocus() {
    const totalWeight = ADVANCE_FOCUS_TABLE.reduce((sum, f) => sum + f.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const focus of ADVANCE_FOCUS_TABLE) {
        roll -= focus.weight;
        if (roll <= 0) return focus;
    }
    return ADVANCE_FOCUS_TABLE[0]; // fallback
}

// ─── Divination System ─────────────────────────────────────────────────────

const NARRATIVE_FORCING = 'NARRATIVE FORCING: The draw must visibly alter the scene — not just color the mood. Something HAPPENS because of this draw. A person appears, a plan fails, a door opens, a body drops, a truth surfaces. The draw is not a metaphor — it is an event. Find the coolest, most unexpected intersection with the current scene and MAKE IT HAPPEN in the prose.\nDO NOT call any dice tool or function. DO NOT use the D&D Dice tool. The number above was generated by the extension — it IS the result. Just use it.';

const CLASSIC_TABLE = `| Roll | Conditions |
| 2 | Worst conditions. Maximum preparation on opposing side. A second complication compounds the first. The board shifts. |
| 3-5 | Heavy. The force arrives prepared and hostile. No easy angles. |
| 6-9 | Hard. Direct, no advantages for anyone. Exactly as serious as it looks. |
| 10-14 | Contested. Mixed signals, incomplete information. Neither side has clean advantage. |
| 15-18 | Exploitable. A vulnerability, a gap, a piece of timing that gives an opening. |
| 19 | Favorable. The force arrives weakened, distracted, or compromised. |
| 20 | The board changes shape. A second collision crashes into the first. Nobody predicted this. |
2 and 20 are special. Both reshape the board. Dice never override logic.`;

const ICHING_TRIGRAMS = `Lower trigram = inner situation. Upper trigram = outer/visible situation.
乾 (Heaven) = active force, initiative. 坤 (Earth) = yielding, nurture. 震 (Thunder) = shock, action. 坎 (Water) = danger, the abyss. 艮 (Mountain) = stillness, obstruction. 巽 (Wind) = gentle penetration. 離 (Fire) = clarity, illumination. 兌 (Lake) = joy, openness.
The hexagram carries rhythm. Stillness slows the beat. Movement compresses — things arrive before anyone processes them.`;

const ARCANA_ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];

// ─── Divination Theme Table (for pressure ignition scoring) ──────────────────
// Each entry maps an Arcana card to themes. Used to score pressure points
// against the current draw — higher score = better ignition candidate.
const DIVINATION_THEME_TABLE = [
    // 0  The Fool
    ['beginning', 'unknown', 'risk', 'leap', 'accident', 'naive'],
    // 1  The Magician
    ['skill', 'opportunity', 'resources', 'manipulation', 'capability', 'plan'],
    // 2  The High Priestess
    ['secret', 'hidden', 'knowledge', 'intuition', 'mystery', 'silence'],
    // 3  The Empress
    ['protection', 'abundance', 'ally', 'shelter', 'comfort', 'care'],
    // 4  The Emperor
    ['authority', 'control', 'hierarchy', 'order', 'power', 'institution'],
    // 5  The Hierophant
    ['tradition', 'rule', 'belief', 'obligation', 'loyalty', 'duty'],
    // 6  The Lovers
    ['choice', 'relationship', 'bond', 'desire', 'tension', 'connection'],
    // 7  The Chariot
    ['will', 'conflict', 'victory', 'struggle', 'drive', 'force'],
    // 8  Strength
    ['patience', 'restraint', 'quiet', 'endurance', 'suppression', 'calm'],
    // 9  The Hermit
    ['isolation', 'truth', 'solitude', 'search', 'distance', 'alone'],
    // 10 Wheel of Fortune
    ['fate', 'change', 'chance', 'reversal', 'timing', 'luck'],
    // 11 Justice
    ['consequence', 'balance', 'debt', 'fair', 'exact', 'truth'],
    // 12 The Hanged Man
    ['sacrifice', 'wait', 'suspend', 'perspective', 'cost', 'pause'],
    // 13 Death
    ['end', 'transform', 'loss', 'change', 'death', 'transition'],
    // 14 Temperance
    ['balance', 'compromise', 'blend', 'patience', 'synthesis', 'middle'],
    // 15 The Devil
    ['trap', 'obsession', 'chain', 'comfort', 'addiction', 'bind'],
    // 16 The Tower
    ['collapse', 'revelation', 'shock', 'violence', 'destruction', 'upheaval'],
    // 17 The Star
    ['hope', 'recover', 'trust', 'guide', 'calm', 'future'],
    // 18 The Moon
    ['fear', 'illusion', 'deception', 'hidden', 'instinct', 'shadow'],
    // 19 The Sun
    ['success', 'clarity', 'win', 'joy', 'visible', 'open'],
    // 20 Judgement
    ['reckoning', 'past', 'account', 'call', 'answer', 'wake'],
    // 21 The World
    ['complete', 'cycle', 'closure', 'whole', 'end', 'arrival'],
];

/**
 * Score a pressure point string against a divination draw.
 * Returns 0-6: number of theme keywords that appear in the pressure point text.
 * @param {string} point - The pressure point text
 * @param {{ index: number }} draw - The divination draw (must have .index for arcana)
 * @returns {number}
 */
function scorePressurePointAgainstDraw(point, draw) {
    if (!draw || draw.index == null || !DIVINATION_THEME_TABLE[draw.index]) return 0;
    const themes = DIVINATION_THEME_TABLE[draw.index];
    return themes.filter(theme => new RegExp(`\\b${theme}\\b`, 'i').test(point || '')).length;
}

/**
 * Get the active divination system. Checks chatMetadata first, then ledger state.
 */
function getActiveDivinationSystem() {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata?.['gravity_divination_system']
        || (_currentState?.divination?.active_system || 'arcana').toLowerCase();
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

    const iChingPatterns = [
        /\b(?:1d64|d64)\b\s*(?:=|:|->|=>)\s*(\d{1,2})\b/i,
        /\b(?:1d64|d64)\b\s*\(\s*(\d{1,2})\s*\)/i,
        /\brolled?\s*(\d{1,2})\s*(?:on|from)\s*(?:1d64|d64)\b/i,
    ];
    for (const pattern of iChingPatterns) {
        const match = raw.match(pattern);
        if (!match) continue;
        const num = Number(match[1]);
        if (!Number.isInteger(num) || num < 1 || num > 64) continue;
        return {
            system: 'iching',
            num,
            sourceText: `1d64 = ${num}`,
        };
    }

    return null;
}

function consumeManualDivinationOverride() {
    const manual = _pendingManualDivination;
    _pendingManualDivination = null;
    return manual;
}

function buildIChingDraw(num, source = 'extension', sourceText = '') {
    const prefix = source === 'manual' && sourceText ? `MANUAL ROLL: ${sourceText}\n` : '';
    return {
        system: 'iching',
        label: 'THE I CHING DREW',
        num,
        reading: `${prefix}Hexagram ${num} â€” interpret per the æ˜“çµŒ King Wen sequence (1=ä¹¾, 2=å¤, 3=å±¯... 64=æœªæ¸ˆ). You know the æ˜“çµŒ. From the number derive: hexagram symbol, Chinese name, English translation, core situational reading. ${ICHING_TRIGRAMS}\n${getNarrativeForcingText(source)}`,
        html: `<div style="background:linear-gradient(180deg,#0a0a0a 0%,#1a1008 100%);border:1px solid #8b7355;border-radius:4px;padding:20px;margin:16px auto;max-width:280px;text-align:center;"><div style="color:#8b7355;font-size:0.7em;letter-spacing:4px;text-transform:uppercase;">æ˜“çµŒ Â· The Book of Changes</div><div style="color:#f0e6d3;font-size:1.4em;margin:12px 0 4px 0;">[HEXAGRAM NAME]</div><div style="color:#8b7355;font-size:0.9em;font-style:italic;">[English] Â· ${num}</div><div style="width:40px;height:1px;background:#8b7355;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.5;">[One-line situational reading]</div></div>`,
    };
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
    if (manual?.system === 'iching') {
        return buildIChingDraw(manual.num, 'manual', manual.sourceText);
    }
    if (manual?.system === 'classic') {
        return buildClassicDraw(manual.num, 'manual', manual.sourceText);
    }
    if (manual?.system === 'arcana') {
        return buildArcanaDraw(manual.num, 'manual', manual.sourceText);
    }

    const system = getActiveDivinationSystem();

    if (system === 'iching' || system === 'i_ching' || system === 'i ching') {
        const num = Math.floor(Math.random() * 64) + 1;
        return {
            system: 'iching',
            label: 'THE I CHING DREW',
            num,
            reading: `Hexagram ${num} — interpret per the 易経 King Wen sequence (1=乾, 2=坤, 3=屯... 64=未済). You know the 易経. From the number derive: hexagram symbol, Chinese name, English translation, core situational reading. ${ICHING_TRIGRAMS}\n${NARRATIVE_FORCING}`,
            html: `<div style="background:linear-gradient(180deg,#0a0a0a 0%,#1a1008 100%);border:1px solid #8b7355;border-radius:4px;padding:20px;margin:16px auto;max-width:280px;text-align:center;"><div style="color:#8b7355;font-size:0.7em;letter-spacing:4px;text-transform:uppercase;">易経 · The Book of Changes</div><div style="color:#f0e6d3;font-size:1.4em;margin:12px 0 4px 0;">[HEXAGRAM NAME]</div><div style="color:#8b7355;font-size:0.9em;font-style:italic;">[English] · ${num}</div><div style="width:40px;height:1px;background:#8b7355;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.5;">[One-line situational reading]</div></div>`,
        };
    }

    if (system === 'classic' || system === '2d10') {
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

// ─── Prompt Injection ──────────────────────────────────────────────────────────

function getStateTarget(state, entityType, entityId) {
    if (!state) return null;
    if (entityType === 'world') return state.world || null;
    if (entityType === 'pc') return state.pc || null;
    if (entityType === 'divination') return state.divination || null;
    if (entityType === 'summary') return state.story_summary || null;

    const collections = {
        char: state.characters,
        constraint: state.constraints,
        collision: state.collisions,
        combat: state.combats,
        chapter: state.chapters,
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
        } else if (entry.kind === 'summary') {
            tx = { op: 'A', e: 'summary', id: '', d: { f: '', v: entry.value } };
        } else if (entry.kind === 'removeSummary') {
            errors.push({ lineNum: i + 1, error: 'STATE summary- is not supported. Use a full LEDGER block for destructive timeline cleanup.', raw: entry.raw || '[summary-]' });
            continue;
        } else {
            const target = getStateTarget(workingState, entry.entityType, entry.entityId);
            const requiresExistingTarget = !['world', 'pc', 'divination', 'summary'].includes(entry.entityType);
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
                if (entry.key != null) {
                    if (entry.value === null) {
                        tx = { op: 'MR', e: entry.entityType, id: entry.entityId, d: { f: entry.field, k: entry.key } };
                    } else {
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

/**
 * Inject prompts based on turn mode.
 * @param {'regular'|'advance'|'integration'} [mode='regular']
 *   regular     — player prose turn (slim state, core readme)
 *   advance     — world moves turn (full state, core readme, skip heartbeat/dormant)
 *   integration — chapter close/timeskip/setup (full state, full readme)
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

        // State view — slim on regular turns, full on advance/integration or active challenge
        if (_currentState) {
            const stateView = formatStateView(_currentState, isRegular && !challengeRuntimeActive ? 'slim' : 'full');
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

        // Pressure point audit — keep seams live, prune stale ones, and graduate them into collisions
        if (_currentState) {
            const pressureAudit = buildPressurePointAudit(_currentState);
            if (pressureAudit) {
                setExtensionPrompt(`${MODULE_NAME}_pressure`, pressureAudit.prompt, PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_pressure`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_pressure`, '', PROMPT_NONE, 0);
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
                    dormant.push(`${char.name || id} [${char.tier}] — WANT: ${char.want || '?'}, DOING: ${char.doing || '?'} — last activity ${gap} transactions ago`);
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

        // ── Collision Resolution System (oracle-driven escalation) ─────────────
        if (_currentState) {
            const collisionBlocks = [];
            const collisionWarnings = [];
            const pressureAudit = buildPressurePointAudit(_currentState);
            if (pressureAudit?.warnings?.length) {
                collisionWarnings.push(...pressureAudit.warnings.map(w => `[PRESSURE POINT AUDIT] ${w}`));
            }

            // Clean up tracker for resolved/crashed collisions
            for (const trackedId of _resolutionTracker.keys()) {
                const col = (_currentState.collisions || {})[trackedId];
                if (!col) { _resolutionTracker.delete(trackedId); continue; }
                const st = (col.status || '').trim().toUpperCase();
                if (st === 'RESOLVED') _resolutionTracker.delete(trackedId);
            }

            const newArrivals = [];

            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                if (status === 'RESOLVED') continue;
                const dist = parseFloat(col.distance);
                const colDetails = buildCollisionStoryCapsule(id, col);
                collisionWarnings.push(...buildCollisionNarrativeWarnings(id, col, status));

                // ── New arrival — distance ≤ 0 and not yet tracked ───────────────
                if (!isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
                    const arrivalDraw = drawDivination();
                    _firedCollisionArrivals.add(id);
                    _resolutionTracker.set(id, {
                        phase: 'arrived',
                        arrivalTurn: _turnCounter,
                        arrivalDraw,
                    });
                    newArrivals.push({ id, col, colDetails, arrivalDraw });
                    continue;
                }

                // ── Resolution escalation — already tracked, RESOLVING ───────────
                if (status === 'RESOLVING' && _resolutionTracker.has(id)) {
                    const tracker = _resolutionTracker.get(id);
                    const turnsSince = _turnCounter - tracker.arrivalTurn;

                    if (turnsSince <= RESOLUTION_PRESSURE_TURNS) {
                        // Phase 1: The Oracle Bleeds In — atmosphere, subtext
                        const arrDraw = tracker.arrivalDraw;
                        collisionBlocks.push(`═══ COLLISION RESOLVING: "${col.name || id}" — THE ORACLE BLEEDS IN (${turnsSince}/${RESOLUTION_CRASH_TURNS}) ═══
${colDetails}

Arrival draw: ${arrDraw.label}: ${arrDraw.reading}

The collision is RESOLVING. Its presence permeates the current scene as atmosphere and subtext. The draw's themes color every interaction — tension in the air, loaded silences, environmental details that echo the collision's forces.

DO NOT let the player ignore this. The collision's weight is in the room even if its forces aren't. Subtext in dialogue. Physical tension in body language. Environmental details that mirror the approaching confrontation.

Your hidden deduction must name how this collision is affecting the current scene. If the player's action doesn't engage the collision, show how the collision's pressure bleeds into whatever they're doing instead. If the collision stays live after this beat, SET collision:${id}.last_manifestation to the concrete way it pressed into the scene.`);

                    } else if (turnsSince <= RESOLUTION_INTRUSION_TURNS) {
                        // Phase 2: The Oracle Manifests — direct intrusion with fresh draw
                        const intrusionDraw = drawDivination();
                        tracker.lastEscalationDraw = intrusionDraw;
                        collisionBlocks.push(`═══ COLLISION RESOLVING: "${col.name || id}" — THE ORACLE MANIFESTS (${turnsSince}/${RESOLUTION_CRASH_TURNS}) ═══
${colDetails}

${intrusionDraw.label}: ${intrusionDraw.reading}${intrusionDraw.html ? `\nRender this HTML card reveal before interpreting:\n${intrusionDraw.html}` : ''}

The collision is done waiting. It PHYSICALLY INTRUDES on the player's current scene THIS TURN.

The oracle determines HOW it arrives. Use this draw to shape the method of intrusion — not a generic interruption, but a specific, vivid, dramatically inevitable manifestation of the collision's forces crashing into the player's reality.

This is not subtext anymore. An NPC arrives. A consequence detonates. A choice is forced. The collision's forces are IN THE ROOM and they are not leaving until the player responds.

You have FULL LICENSE: move NPCs, trigger events, create witnesses, use the environment. The draw is the shape. The collision is the force. Write the most dramatically honest intrusion this draw suggests.

If the collision survives the beat, SET collision:${id}.last_manifestation to the concrete intrusion you wrote. The player has ${RESOLUTION_CRASH_TURNS - turnsSince} turns before gravity resolves this without them.`);

                    } else {
                        // Phase 3: Crash threshold — gravity resolves without player
                        const crashDraw = drawDivination();
                        collisionBlocks.push(`═══ COLLISION RESOLVING: "${col.name || id}" — THE ORACLE DECIDES (${turnsSince}/${RESOLUTION_CRASH_TURNS}) ═══
${colDetails}

${crashDraw.label}: ${crashDraw.reading}${crashDraw.html ? `\nRender this HTML card reveal before interpreting:\n${crashDraw.html}` : ''}

TIME IS UP. The player has not engaged this collision for ${turnsSince} turns. Gravity will no longer wait.

MOVE this collision to RESOLVED in the update block. Set outcome_type: CRASHED and record aftermath. The oracle determines the shape of the uncontrolled outcome. Write the WORST REASONABLE OUTCOME colored by this draw.

This is what ignoring a collision costs. The player had their chance — every turn for ${turnsSince} turns, the collision pushed toward them. They chose not to engage. Now gravity chooses for them.

Write the crash as a scene that interrupts whatever the player is doing. It is dramatic, consequential, and permanent. Record what was lost in aftermath. If the wreckage seeds new tension, CREATE a successor collision and link it with successor_collision_ids.`);
                    }
                    continue;
                }

                // ── RESOLVING but not in tracker (e.g., LLM moved to RESOLVING manually) ──
                if (status === 'RESOLVING' && !_resolutionTracker.has(id)) {
                    _resolutionTracker.set(id, {
                        phase: 'arrived',
                        arrivalTurn: _turnCounter,
                        arrivalDraw: drawDivination(),
                    });
                    // Will pick up escalation next turn
                }

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
                // Incoherent state: RESOLVING but distance > 0
                if (status === 'RESOLVING') {
                    if (!isNaN(dist) && dist > 0) {
                        collisionWarnings.push(`"${col.name || id}" is RESOLVING but distance is ${dist} — a collision cannot resolve at range. If avoided, MOVE to RESOLVED with outcome_type: CRASHED. If still approaching, MOVE back to ACTIVE.`);
                    }
                }
            }

            // ── Build arrival blocks (deferred to allow convergence handling) ──────
            if (newArrivals.length === 1) {
                const { id, col, colDetails, arrivalDraw } = newArrivals[0];
                collisionBlocks.push(`═══ COLLISION ARRIVAL: "${col.name || id}" ═══
${colDetails}

${arrivalDraw.label}: ${arrivalDraw.reading}${arrivalDraw.html ? `\nRender this HTML card reveal before interpreting:\n${arrivalDraw.html}` : ''}

This collision has reached distance 0. It detonates NOW.

You have FULL LICENSE to make this happen. Move NPCs into the scene. Spawn threats. Have someone arrive with information. Trigger events. Create new characters. Use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

The draw shapes the CIRCUMSTANCE of how this collision arrives — not the outcome. Write the situation, not the resolution. The player must respond to it.

MOVE status to RESOLVING. SET collision:${id}.last_manifestation to the concrete arrival you wrote. The resolution clock is now ticking.

Four outcomes are possible:
• RESOLVED (outcome_type: DIRECT) — the player engaged and shaped the result. Clean or costly, including active retreat.
• RESOLVED (outcome_type: EVOLVED) — resolution reveals a deeper tension. Record aftermath, CREATE a successor collision, link with successor_collision_ids.
• RESOLVED (outcome_type: IMPLODED) — the collision collapsed internally before the player engaged. Record what fell apart and why. Successor optional.
• RESOLVED (outcome_type: CRASHED) — the player ignored it and gravity resolves it for them. Worst outcome. Write the worst reasonable outcome. Record aftermath.

Every closure requires: collision:${id}.status: RESOLVED — collision:${id}.outcome_type: DIRECT/EVOLVED/IMPLODED/CRASHED — collision:${id}.aftermath: "..."

The player has ${RESOLUTION_CRASH_TURNS} turns to engage before the oracle decides for them.`);

            } else if (newArrivals.length > 1) {
                // Multiple simultaneous arrivals — build individual blocks then add convergence
                for (const { id, col, colDetails, arrivalDraw } of newArrivals) {
                    collisionBlocks.push(`═══ COLLISION ARRIVAL: "${col.name || id}" ═══
${colDetails}

${arrivalDraw.label}: ${arrivalDraw.reading}${arrivalDraw.html ? `\nRender this HTML card reveal before interpreting:\n${arrivalDraw.html}` : ''}`);
                }
                const convergenceDraw = drawDivination();
                const arrivalNames = newArrivals.map(a => `"${a.col.name || a.id}"`).join(' and ');
                collisionBlocks.push(`═══ CONVERGENCE: ${newArrivals.length} COLLISIONS ARRIVE SIMULTANEOUSLY ═══
${arrivalNames} have all hit distance 0 on the same turn.

${convergenceDraw.label}: ${convergenceDraw.reading}${convergenceDraw.html ? `\nRender this HTML card reveal before interpreting:\n${convergenceDraw.html}` : ''}

Choose the relationship between these arrivals before writing the scene. Choose one:
• PARALLEL — they arrive at the same time but remain distinct tensions. One foregrounds first; the others are active in the same scene or immediate next beat. No forced merge.
• CASCADE — one collision becomes the trigger or delivery vehicle for another. Both remain distinct, but their arrivals are causally linked. Name which drives which.
• COMPOSITE — the simultaneous arrivals form a single larger event. Write one coherent converged scene. Each parent collision typically closes with outcome_type: MERGED. CREATE a composite successor collision and link parent_collision_ids / successor_collision_ids.

Do not announce this choice as visible meta text. Let the scene itself make the structure clear: PARALLEL means one arrival foregrounds while the others stay live, CASCADE means one arrival delivers the next, and COMPOSITE means the arrivals land as one merged event. The convergence draw colors the shape of the combined event.

If a parent collision closes inside the converged event, each parent still needs status: RESOLVED, outcome_type: MERGED, aftermath, and successor linkage.

MOVE each arrived collision to RESOLVING. SET each collision's last_manifestation to how it entered the converged scene. The resolution clock is now ticking for all of them.`);
            }

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

            if (collisionBlocks.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, collisionBlocks.join('\n\n'), PROMPT_IN_CHAT, 0);
                console.log(`${LOG_PREFIX} Collision resolution injection: ${collisionBlocks.length} block(s)`);
            } else {
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
            setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
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

These flags are for hidden reasoning only. Never echo or paraphrase them in visible output.

After the thinking pass closes, visible output is:
1. Optional divination card HTML when another injection requests it
2. Prose
3. UPDATE block:
- Normal turns: ---STATE--- (compact delta, only material changes)
- Structural turns or explicit cleanup/setup instructions: ---LEDGER--- (full command block, no line limit)${_uncappedTurn ? ' (UNCAPPED - full cleanup allowed)' : ''}

Update current_scene, location, and condition when they materially change or the scene would be hard to reconstruct without them.
Knowledge firewall: characters only act on what their reads, noticed_details, knowledge_asymmetry, faction intel, and plausible information channels make possible. Hidden facts stay hidden until learned, revealed, reported, sensed, or inferred honestly.
Remote factions are not live-omniscient. Use faction comms_latency, last_verified_at, intel_posture, blindspots, intel_on, and false_beliefs to decide what they know right now.
When a character re-enters after time away, use last_seen_at plus summary residue and faction intel to refresh what they plausibly learned, missed, guessed, or got wrong while absent.
CLEANUP (REMOVE/DESTROY): max 3 per regular turn. Save bulk for eval or chapter close.

You have ONLY 3-5 messages of context. Gravity_State_View is your COMPLETE memory.]`;

        // Fire regular prose trigger on regular turns only
        // (combat/intimacy/advance fire their own prose triggers via _ooc)
        if (isRegular && !challengeSessionLocked) {
            nudgeText += `\n\n[WORLD INFO TRIGGERS - DO NOT ECHO:\n${MODE_LOREBOOK_KEYS.proseRegular}\n]`;
        }

        setExtensionPrompt(`${MODULE_NAME}_nudge`, nudgeText, PROMPT_IN_CHAT, 0);
    } catch (err) {
        console.error(`${LOG_PREFIX} Inject failed:`, err);
    }
}

// ─── Array Size Checks ────────────────────────────────────────────────────────

const ARRAY_SIZE_LIMITS = {
    pressure_points: { path: s => s.world?.pressure_points, label: 'PRESSURE_POINTS', cap: 15 },
    demonstrated_traits: { path: s => s.pc?.demonstrated_traits, label: 'PC TRAITS', cap: 20 },
    timeline: { path: s => s.pc?.timeline, label: 'PC TIMELINE', cap: 30 },
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
    _resolutionTracker = new Map();

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

    // Cleanup gate: REMOVE/DESTROY/MAP_DEL capped outside eval/chapter-close turns
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
            console.warn(`${LOG_PREFIX} Dropped ${cleanupDropped} cleanup operations (cap ${CLEANUP_CAP} outside eval/chapter-close).`);
        }
    }
    _uncappedTurn = false;

    // Validate each transaction individually
    const validTxns = [];
    const validationErrors = [];
    let committedTxns = [];
    for (let i = 0; i < extractedTransactions.length; i++) {
        const result = validateBatch([extractedTransactions[i]]);
        if (result.valid) {
            validTxns.push(extractedTransactions[i]);
        } else {
            validationErrors.push({
                lineNum: i,
                error: result.errors.map(e => e.message).join('; '),
                raw: `[validated tx ${i}]`,
            });
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
            }

            console.log(`${LOG_PREFIX} Committed ${committed.length} TX, ${allErrors.length} errors. Turn ${_turnCounter}.`);
        } catch (err) {
            console.error(`${LOG_PREFIX} Commit failed:`, err);
        }
    }

    // Build reinforcement FIRST — then append tiering/size warnings on top
    _pendingReinforcement = getReinforcement(extraction, _turnCounter);

    // Memory tiering — check if hot arrays exceeded caps, rotate to cold
    const rotation = checkAndRotate(_currentState);
    if (rotation.needsConsolidation) {
        const consolidationPrompt = buildConsolidationPrompt(rotation.pendingBatches);
        _pendingReinforcement = (_pendingReinforcement || '') + '\n' + consolidationPrompt;
        _uncappedTurn = true; // Allow large ledger block for consolidation
    }

    // Check array sizes and warn if bloated
    const sizeWarnings = checkArraySizes(_currentState);
    if (sizeWarnings) {
        _pendingReinforcement = (_pendingReinforcement || '') + '\n' + sizeWarnings;
    }
    if (cleanupDropped > 0) {
        _pendingReinforcement = (_pendingReinforcement || '') +
            `\n[LEDGER: ${cleanupDropped} cleanup operations dropped (REMOVE/DESTROY capped at ${CLEANUP_CAP} outside eval/chapter-close). Save bulk cleanup for OOC: eval or chapter close.]`;
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
function handleAdvanceButton() {
    _pendingDeductionType = 'advance';
    const pcName = _currentState?.pc?.name || '{{user}}';
    const doing = _currentState?.pc?.doing || 'what they were doing';

    const ripeCollisions = [];
    const inProgressCollisions = [];
    if (_currentState) {
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const dist = parseFloat(col.distance);
            const status = (col.status || '').trim().toUpperCase();

            if (!isNaN(dist) && dist <= 0 && status !== 'RESOLVED' && !_firedCollisionArrivals.has(id)) {
                ripeCollisions.push({ id, col });
                _firedCollisionArrivals.add(id);
                _resolutionTracker.set(id, {
                    phase: 'arrived',
                    arrivalTurn: _turnCounter,
                    arrivalDraw: drawDivination(),
                });
            } else if (
                status === 'RESOLVING' ||
                (!isNaN(dist) && dist <= 0 && status === 'ACTIVE' && _firedCollisionArrivals.has(id))
            ) {
                inProgressCollisions.push({ id, col });
            }
        }
    }

    const draw = drawDivination();
    const markers = [MODE_LOREBOOK_KEYS.advanceCore, MODE_LOREBOOK_KEYS.advanceOptional, MODE_LOREBOOK_KEYS.proseAdvance];

    if (ripeCollisions.length === 1) {
        const a = ripeCollisions[0];
        const colDetails = buildCollisionStoryCapsule(a.id, a.col);
        _pendingOOCInjection = buildModeInjection(
            'GRAVITY ADVANCE',
            `${pcName} yields the turn. The world moves.\n\n${formatDrawInstruction(draw, 'The draw colors the circumstance, not the outcome.')}\n\nARRIVED COLLISION:\n${`COLLISION: "${a.col.name || a.id}"\n${colDetails}`}\n\nThis is the world's move. Force the issue into the player's immediate reality now. Write the arrival, not the final resolution. MOVE the collision to RESOLVING, SET collision:${a.id}.last_manifestation to the concrete arrival, record divination.last_draw, then write prose and end with a compact STATE block.`,
            markers,
        );
    } else if (ripeCollisions.length > 1) {
        const collisionBlocks = ripeCollisions.map(a => {
            const colDetails = buildCollisionStoryCapsule(a.id, a.col);
            return `COLLISION: "${a.col.name || a.id}"\n${colDetails}`;
        }).join('\n\n');
        const convergenceDraw = drawDivination();
        const arrivalNames = ripeCollisions.map(a => `"${a.col.name || a.id}"`).join(' and ');
        _pendingOOCInjection = buildModeInjection(
            'GRAVITY ADVANCE',
            `${pcName} yields the turn. The world moves.\n\n${formatDrawInstruction(draw, 'The draw colors the circumstance, not the outcome.')}\n\nARRIVED COLLISIONS:\n${collisionBlocks}\n\nCONVERGENCE — ${arrivalNames} arrive on the same turn.\n${convergenceDraw.label}: ${convergenceDraw.reading}${convergenceDraw.html ? `\nRender this HTML card reveal:\n${convergenceDraw.html}` : ''}\n\nDeclare the relationship before writing the scene:\n• PARALLEL — distinct arrivals; one foregrounds first, others active in same beat\n• CASCADE — one triggers or delivers the other; name which drives which\n• COMPOSITE — one converged event; parents close as MERGED; CREATE a composite successor collision\n\nIf a parent collision closes inside the converged event, each parent still needs status: RESOLVED, outcome_type: MERGED, aftermath, and successor linkage.\n\nMOVE each arrived collision to RESOLVING. SET each collision's last_manifestation to the concrete way it entered the converged scene. Record divination.last_draw, then write prose and end with a compact STATE block.`,
            markers,
        );
    } else if (inProgressCollisions.length > 0) {
        const collisionBlocks = inProgressCollisions.map(a => {
            const colDetails = buildCollisionStoryCapsule(a.id, a.col);
            return `"${a.col.name || a.id}" [${a.col.status}] - ${colDetails}`;
        }).join('\n');

        _pendingOOCInjection = buildModeInjection(
            'GRAVITY ADVANCE',
            `${pcName} yields the turn while a collision is already in motion.\n\n${formatDrawInstruction(draw, 'The draw colors what happens next, not the outcome.')}\n\nIN-PROGRESS COLLISION:\n${collisionBlocks}\n\nKeep pushing the confrontation. It cannot stall. Either resolve it this turn or force it into a sharper crisis. For each collision that stays live, SET that collision's last_manifestation to the new concrete manifestation. If it resolves, MOVE it to RESOLVED with outcome_type and aftermath. Record divination.last_draw, then write prose and end with a compact STATE block.`,
            markers,
        );
    } else {
        const focus = pickAdvanceFocus();
        const ADVANCE_PROMPTS = {
            scene: 'FOCUS: THE SCENE\nMove something local: an NPC acts, the environment shifts, someone arrives or leaves, or a noticed detail fires.',
            world: `FOCUS: THE WORLD\nCut away from ${pcName}. Show a faction or macro move whose consequences will matter later.`,
            offscreen: 'FOCUS: OFF-SCREEN CHARACTER\nA tracked character pursues their own want. Show the beat and update what it changes.',
            new_threat: 'FOCUS: SOMETHING NEW\nIntroduce a fresh threat, complication, or revelation that belongs to the current story logic.',
            collision: `FOCUS: PRESSURE TIGHTENS\nPick the collision that creates the most honest pressure right now and show why it compressed. If no existing collision can honestly carry the beat, escalate the hottest pressure point into a new collision and REMOVE the pressure point it came from.`,
        };

        _pendingOOCInjection = buildModeInjection(
            'GRAVITY ADVANCE',
            `${pcName} maintains vector (continues ${doing}). The PC does not take a new action this turn.\n\n${formatDrawInstruction(draw, 'The draw colors the world\'s move - it does not prescribe it.')}\n\n${ADVANCE_PROMPTS[focus.key]}\n\nRecord divination.last_draw, then write prose and end with a compact STATE block.`,
            markers,
        );
    }

    injectPrompt('advance');
    insertChatMessage(`*${pcName} continues what they were doing.*`);
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

Use a full LEDGER block for the structural updates across characters, factions, collisions, world, pressure points, timeline, and summary. Record divination.last_draw in the update block. Do not close the chapter.`,
        [MODE_LOREBOOK_KEYS.timeskipCore],
    );

    injectPrompt('integration');
    insertChatMessage(`OOC: Timeskip - ${duration}`);
}

async function handleChapterCloseButton() {
    _uncappedTurn = true;
    const chapterDraw = drawDivination();

    _pendingOOCInjection = buildModeInjection(
        'GRAVITY CHAPTER CLOSE',
        `Execute chapter close across multiple responses.

Response 1:
- Audit state drift, stale collisions, missing updates, and loaded guns that fired or rotted.
- Append a durable chapter summary.
- Reassess every active faction and refresh pressure points.
- Ask the player where the next chapter should start, how much time passes, and what they want emphasized.

Response 2 after the player's answer:
${formatDrawInstruction(chapterDraw, 'The draw colors the tone and direction of the next chapter.')}
- Sanity-check the requested start.
- Timeskip to the opening.
- Close the old chapter, open the new one, emit the structural LEDGER updates, and write the new opening scene.`,
        [MODE_LOREBOOK_KEYS.chapterCloseCore],
    );

    injectPrompt('integration');
    insertChatMessage('OOC: Close this chapter.');
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
    _resolutionTracker = new Map();
    _firedCollisionArrivals = new Set();
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
    _resolutionTracker = new Map();
    _firedCollisionArrivals = new Set();
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
        onChapterClose: handleChapterCloseButton,
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




