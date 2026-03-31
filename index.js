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
import { computeState, applyTransaction, createEmptyState } from './state-compute.js';
import { formatStateView, formatReadme } from './state-view.js';
import { extractUpdateBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning } from './ui-panel.js';
import { isActive as isSetupActive, getPhasePrompt, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback, showSetupPopup, buildSetupPrompt } from './setup-wizard.js';
import { checkAndRotate, buildConsolidationPrompt } from './memory-tier.js';
import { getStateMachineField } from './state-machine.js';

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
let _pendingDeductionType = 'regular'; // regular, combat, advance, intimacy

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

/**
 * Draw from the active divination system.
 * @returns {{ system: string, label: string, num: number, reading: string, html: string }}
 */
function drawDivination() {
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

    try {
        // State view — slim on regular turns, full on advance/integration
        if (_currentState) {
            const stateView = formatStateView(_currentState, isRegular ? 'slim' : 'full');
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

        // Style exemplars — inject last 5 good paragraphs (skip on integration turns — no prose)
        const { chatMetadata } = SillyTavern.getContext();
        const exemplars = (!isIntegration && chatMetadata?.['gravity_exemplars']) || [];
        if (exemplars.length > 0) {
            const recent = exemplars.slice(-5);
            const exLines = recent.map((ex, i) => `  ${i + 1}. "${ex.text}"`).join('\n');
            setExtensionPrompt(`${MODULE_NAME}_exemplars`,
                `[STYLE EXEMPLARS — the player flagged these as excellent prose. Match this quality and voice:\n${exLines}]`,
                PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_exemplars`, '', PROMPT_NONE, 0);
        }

        // Faction heartbeat — every 10 turns on regular turns only (advance/integration handle factions directly)
        if (isRegular && _turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
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
        if (isRegular && _turnCounter > 0 && _turnCounter % 15 === 0 && _currentState) {
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
            const distWarnings = [];
            const totalTxCount = getAllTransactions().length;

            // Clean up tracker for resolved/crashed collisions
            for (const trackedId of _resolutionTracker.keys()) {
                const col = (_currentState.collisions || {})[trackedId];
                if (!col) { _resolutionTracker.delete(trackedId); continue; }
                const st = (col.status || '').trim().toUpperCase();
                if (st === 'RESOLVED' || st === 'CRASHED') _resolutionTracker.delete(trackedId);
            }

            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                if (status === 'RESOLVED') continue;
                const dist = parseFloat(col.distance);
                const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(', ') : String(col.forces || '?');
                const colDetails = col.details || `Forces: ${forces}\nCost: ${col.cost || 'unspecified'}${col.target_constraint ? `\nTarget constraint: ${col.target_constraint}` : ''}`;

                // ── CRASHED — oracle decides the wreckage ────────────────────────
                if (status === 'CRASHED') {
                    const crashDraw = drawDivination();
                    collisionBlocks.push(`═══ COLLISION CRASHED: "${col.name || id}" ═══
${colDetails}

${crashDraw.label}: ${crashDraw.reading}${crashDraw.html ? `\nRender this HTML card reveal before interpreting:\n${crashDraw.html}` : ''}

This collision CRASHED — the player did not engage, and gravity resolved it without them.

The oracle determines the shape of the wreckage. Write the WORST REASONABLE OUTCOME colored by this draw. The player had their chance. This is what inaction costs.

Consequences are permanent. MOVE status to RESOLVED in the ledger. Record what was lost. If the aftermath seeds new tension, CREATE a new collision from the wreckage.

Then DESTROY this collision: DESTROY collision:${id}`);
                    _resolutionTracker.delete(id);
                    continue;
                }

                // ── New arrival — distance ≤ 0 and not yet tracked ───────────────
                if (!isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
                    const arrivalDraw = drawDivination();
                    _firedCollisionArrivals.add(id);
                    _resolutionTracker.set(id, {
                        phase: 'arrived',
                        arrivalTurn: _turnCounter,
                        arrivalDraw,
                    });

                    collisionBlocks.push(`═══ COLLISION ARRIVAL: "${col.name || id}" ═══
${colDetails}

${arrivalDraw.label}: ${arrivalDraw.reading}${arrivalDraw.html ? `\nRender this HTML card reveal before interpreting:\n${arrivalDraw.html}` : ''}

This collision has reached distance 0. It detonates NOW.

You have FULL LICENSE to make this happen. Move NPCs into the scene. Spawn threats. Have someone arrive with information. Trigger events. Create new characters. Use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

The draw shapes the CIRCUMSTANCE of how this collision arrives — not the outcome. Write the situation, not the resolution. The player must respond to it.

MOVE status to RESOLVING. The resolution clock is now ticking.

Three outcomes are possible:
• RESOLVED — the player engaged and shaped the result. Clean or costly. RESOLVED includes retreat — if the player actively chooses to disengage and pays the cost, that's a resolution. They shaped the outcome.
• EVOLUTION — resolution reveals a different tension. MOVE to RESOLVED, CREATE a new collision from what surfaced.
• CRASHED — the player pretended it wasn't there. Not retreat — inaction. Gravity resolves it for them. Worst outcome. No agency.

The player has ${RESOLUTION_CRASH_TURNS} turns to engage before the oracle decides for them.`);
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

Your deduction MUST name how this collision is affecting the current scene. If the player's action doesn't engage the collision, show how the collision's pressure bleeds into whatever they're doing instead.`);

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

The player has ${RESOLUTION_CRASH_TURNS - turnsSince} turns before gravity resolves this without them.`);

                    } else {
                        // Phase 3: Crash threshold — final warning or auto-crash
                        const crashDraw = drawDivination();
                        collisionBlocks.push(`═══ COLLISION RESOLVING: "${col.name || id}" — THE ORACLE DECIDES (${turnsSince}/${RESOLUTION_CRASH_TURNS}) ═══
${colDetails}

${crashDraw.label}: ${crashDraw.reading}${crashDraw.html ? `\nRender this HTML card reveal before interpreting:\n${crashDraw.html}` : ''}

TIME IS UP. The player has not engaged this collision for ${turnsSince} turns. Gravity will no longer wait.

MOVE this collision to CRASHED in the update block. The oracle determines the shape of the uncontrolled outcome. Write the WORST REASONABLE OUTCOME colored by this draw.

This is what ignoring a collision costs. The player had their chance — every turn for ${turnsSince} turns, the collision pushed toward them. They chose not to engage. Now gravity chooses for them.

Write the crash as a scene that interrupts whatever the player is doing. It is dramatic, consequential, and permanent. Record what was lost. If the aftermath seeds new tension, CREATE a new collision from the wreckage.`);
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

                // ── Distance warnings (non-terminal collisions only) ─────────────
                if (status !== 'CRASHED') {
                    const distHist = (_currentState._history || {})[`collision:${id}:distance`] || [];
                    if (distHist.length > 0) {
                        const last = distHist[distHist.length - 1];
                        const fromDist = parseFloat(last.from);
                        const toDist = parseFloat(last.to);
                        if (!isNaN(fromDist) && !isNaN(toDist) && toDist > fromDist) {
                            distWarnings.push(`"${col.name || id}" distance went ${last.from} → ${last.to} — collision distances are countdowns, they MUST NOT increase. SET it back to ${last.from} or lower.`);
                        }
                    }
                    // Incoherent state: RESOLVING but distance > 0
                    if (status === 'RESOLVING') {
                        if (!isNaN(dist) && dist > 0) {
                            distWarnings.push(`"${col.name || id}" is RESOLVING but distance is ${dist} — a collision cannot resolve at range. If avoided, MOVE to CRASHED. If still approaching, MOVE back to ACTIVE.`);
                        }
                    }
                }
            }

            if (collisionBlocks.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, collisionBlocks.join('\n\n'), PROMPT_IN_CHAT, 0);
                console.log(`${LOG_PREFIX} Collision resolution injection: ${collisionBlocks.length} block(s)`);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            }

            if (distWarnings.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_dist_warn`,
                    `[COLLISION DISTANCE ERROR:\n${distWarnings.map(w => '  • ' + w).join('\n')}]`,
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

        // Nudge — full on regular turns, slim on advance/integration (those prompts already instruct on ledger)
        const DEDUCTION_TEMPLATES = {
            regular: `---DEDUCTION---
Intent: [what the player is trying to do]
Story: [1-2 lines — the dramatic situation, what's at stake]

Collisions:
- [name] | [distance] | [tightening / simmering / resolving] — [why this turn]
New: [spawned — or: none]
Resolving: [at zero — what's the forced choice?]

Constraint: [which of the principal's constraints is pressured, why, integrity direction — or: none pressured]
Factions: [which faction advanced or could advance — if none acted in 10+ turns, one MUST act now]
Cost overlap: [whose costs are colliding — who's being forced to choose]

Divination: [if drawn — result, reading. If not — skip]
Tone check: [which tone rule applies — name it, one line]
Contest: [resolve player actions through logic and established capabilities]

Scene: [who's present, atmosphere — for current_scene update]
Plan: [ONE beat. What happens. What would each character logically do. Stop after the first shift.]
Updates: [all material state changes for the STATE block — or: none]
Chapter: [hold / propose "Title" / advance]
---END DEDUCTION---`,
            combat: `---DEDUCTION---
Action: [what the PC is attempting]
Power: [PC power:X vs enemy power:Y — gap, can this work?]
Advantages: [what PC has established — traits, prep, terrain, reads]
Enemy: [what the enemy would logically do — adapt, counter, exploit]
Wounds: [PC wounds, enemy wounds — effect on this exchange]
Distance: [current → change? why?]
Beat: [ONE exchange. What happens.]
---END DEDUCTION---`,
            advance: `---DEDUCTION---
Focus: [scene/world/offscreen/new_threat/collision]
What moves: [the specific thing that happens]
Draw: [how the divination shapes this]
Collision: [which tightens or spawns — or: none]
Beat: [what happens.]
---END DEDUCTION---`,
            intimacy: `---DEDUCTION---
Stance: [partner's current intimacy_stance]
Constraint: [which is pressured — or: none]
Partner wants: [what their body is showing]
History: [pattern from intimate_history — or: first encounter]
Draw: [how divination shapes the sexual energy]
Beat: [ONE sensory beat.]
---END DEDUCTION---`,
        };

        const deductionTemplate = DEDUCTION_TEMPLATES[_pendingDeductionType] || DEDUCTION_TEMPLATES.regular;
        _pendingDeductionType = 'regular'; // reset after use

        const nudgeText = `[SYSTEM: TURN FORMAT — you MUST follow this exact structure:

IMPORTANT: Do ALL your thinking inside the ---DEDUCTION--- block. Do NOT produce a separate reasoning or thinking block before it. If you catch yourself reasoning before the deduction, STOP and put it inside the deduction instead. One reasoning pass, not two.

1. DEDUCTION block (your ONLY reasoning space — compact, one line per item):
${deductionTemplate}

2. Prose

3. UPDATE block:
- Normal turns: ---STATE--- (compact delta, only material changes)
- Structural turns or explicit cleanup/setup instructions: ---LEDGER--- (full command block, no line limit)${_uncappedTurn ? ' (UNCAPPED — full cleanup allowed)' : ''}
Update current_scene, location, and condition when they materially change or the scene would be hard to reconstruct without them.
CLEANUP (REMOVE/DESTROY): max 3 per regular turn. Save bulk for eval or chapter close.

You have ONLY 3-5 messages of context. Gravity_State_View is your COMPLETE memory.]`;
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
    // Reset inject mode and clear OOC injection — the special turn is over
    _currentInjectMode = 'regular';
    const context = SillyTavern.getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(`${MODULE_NAME}_ooc`, '', PROMPT_NONE, 0);
    }

    const message = context.chat?.[messageId];
    if (!message?.mes) return;

    _turnCounter++;

    // Extract update block (compact STATE or canonical LEDGER)
    const extraction = extractUpdateBlock(message.mes);

    // Strip block from displayed message
    if (extraction.found) {
        message.mes = extraction.cleanedMessage;
    }

    // No block found
    if (!extraction.found) {
        _pendingReinforcement = getReinforcement(extraction, _turnCounter);
        injectPrompt();
        return;
    }

    let extractedTransactions = extraction.transactions || [];
    const extractionErrors = [...(extraction.errors || [])];

    if (extraction.format === 'state') {
        const compiled = compileStateEntries(extraction.stateEntries || [], _currentState);
        extractedTransactions = compiled.transactions;
        extractionErrors.push(...compiled.errors);
    }

    // No transactions at all (empty block or all lines failed)
    if (extractedTransactions.length === 0 && extractionErrors.length === 0) {
        _pendingReinforcement = getReinforcement(extraction, _turnCounter);
        injectPrompt();
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
            _currentState = computeState(_currentState, committed);

            // Clear corrections that were fixed by these commits
            clearMatchedCorrections(committed);

            // Check if setup wizard phase should advance
            if (isSetupActive()) {
                checkPhaseCompletion(committed, _currentState);
            }

            const commitIds = committed.map(tx => tx.tx);
            updatePanel(_currentState, _turnCounter, commitIds);

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

    injectPrompt();
}

async function onUserMessage(messageId) {
    if (!_initialized) await initialize();

    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message?.mes) return;

    // Detect intimacy action from st-clickable-actions (data-value starts with "intimate:")
    const rawText = message.mes.replace(/<[^>]+>/g, '').trim();
    if (rawText.startsWith('intimate:') || rawText.startsWith('*intimate:')) {
        _pendingDeductionType = 'intimacy';
        // Re-inject intimacy context so the LLM stays in intimate scene mode
        _pendingOOCInjection = `[GRAVITY INTIMACY — continuing intimate scene. The player chose an action.

STAY IN INTIMATE SCENE MODE. Write the next prose beat (200-400 words) responding to the player's action.
Then generate 4-5 new clickable choices at the end:
<span class="act" data-value="intimate: [concrete first-person action]">Short display text</span>

RULES STILL ACTIVE:
- One sensory beat per turn. Sensation chains. Anatomical precision.
- Body description: verbose, specific — shape, weight, texture, temperature, response to touch.
- Partner not passive — every 2-3 turns, partner acts on their own.
- Partner interiority flash every 2-3 turns (italicized first-person, 2-4 sentences).
- Collision check: if any collision hits distance 0, it fires mid-scene.
- "OOC: fade to black" → cut to afterglow.

INTIMACY DEDUCTION (use this format, one line per item):
---DEDUCTION---
Stance: [partner's current intimacy_stance]
Constraint: [which is pressured — or: none]
Partner wants: [what their body is showing]
History: [pattern from intimate_history — or: first encounter]
Beat: [ONE sensory beat.]
---END DEDUCTION---
Then prose, then choices, then compact STATE block.]`;
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

    // Store combat rules if provided
    if (answers.combat_rules) {
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        chatMetadata['gravity_combat_rules'] = answers.combat_rules;
        await saveMetadata();
    }

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

    // Check for ripe collisions (distance ≤ 0, not yet fired)
    const ripeCollisions = [];
    // Check for in-progress collisions (already detonated but not yet RESOLVED)
    const inProgressCollisions = [];
    if (_currentState) {
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const dist = parseFloat(col.distance);
            const status = (col.status || '').trim().toUpperCase();

            // Fresh arrival — distance 0, hasn't fired yet
            if (!isNaN(dist) && dist <= 0 && status !== 'RESOLVED' && status !== 'CRASHED' && !_firedCollisionArrivals.has(id)) {
                const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(', ') : String(col.forces || '?');
                ripeCollisions.push({ id, col, forces });
                _firedCollisionArrivals.add(id);
                // Start resolution tracking
                _resolutionTracker.set(id, {
                    phase: 'arrived',
                    arrivalTurn: _turnCounter,
                    arrivalDraw: drawDivination(),
                });
            }
            // Already detonated — fired but still ACTIVE, or RESOLVING
            else if (
                (status === 'RESOLVING') ||
                (!isNaN(dist) && dist <= 0 && status === 'ACTIVE' && _firedCollisionArrivals.has(id))
            ) {
                const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(', ') : String(col.forces || '?');
                inProgressCollisions.push({ id, col, forces });
            }
        }
    }

    // Draw from active divination system
    const draw = drawDivination();

    if (ripeCollisions.length > 0) {
        // Advance = collision detonation. The ripe collision IS the thing that happens.
        const collisionBlocks = ripeCollisions.map(a => {
            const colDetails = a.col.details || `Forces: ${a.forces}\nCost: ${a.col.cost || 'unspecified'}${a.col.target_constraint ? `\nTarget constraint: ${a.col.target_constraint}` : ''}`;
            return `COLLISION: "${a.col.name || a.id}"\n${colDetails}`;
        }).join('\n\n');

        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} yields the turn. The world moves.

${draw.label}: ${draw.reading}${draw.html ? `\nRender this HTML card reveal before interpreting:\n${draw.html}` : ''}
The draw shapes the CIRCUMSTANCE of what happens — not the outcome.

${ripeCollisions.length === 1 ? 'A collision has arrived:' : 'These collisions have arrived:'}

${collisionBlocks}

This is the world's turn and this collision detonates NOW. You have FULL LICENSE to make it happen — move NPCs into the scene, spawn threats, have someone arrive with information, trigger events, create new characters, use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

Write the situation, not the resolution. The player must respond to it.

MOVE this collision's status to RESOLVING. The resolution clock is now ticking — the player has ${RESOLUTION_CRASH_TURNS} turns to engage before gravity resolves it without them (CRASHED = worst outcome, no agency).

Three outcomes are possible:
• RESOLVED — the player engaged and shaped the result. Clean or costly. RESOLVED includes retreat — if the player actively chooses to disengage and pays the cost, that's a resolution. They shaped the outcome.
• EVOLUTION — resolution reveals a different tension. MOVE to RESOLVED, CREATE a new collision from what surfaced.
• CRASHED — the player pretended it wasn't there. Not retreat — inaction. Gravity resolves it for them. Worst outcome.

Record the draw in the update block: divination.last_draw: "[draw result]"
Full turn: deduction + prose + compact STATE block.]`;
    } else if (inProgressCollisions.length > 0) {
        // Collision already detonated but not resolved — player is yielding, push it forward
        const collisionBlocks = inProgressCollisions.map(a => {
            const colDetails = a.col.details || `Forces: ${a.forces} | Cost: ${a.col.cost || 'unspecified'}`;
            return `"${a.col.name || a.id}" [${a.col.status}] — ${colDetails}`;
        }).join('\n');

        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} yields the turn. A collision is in progress.

${draw.label}: ${draw.reading}${draw.html ? `\nRender this HTML card reveal before interpreting:\n${draw.html}` : ''}
The draw shapes what happens next — not the outcome.

IN-PROGRESS COLLISION:
${collisionBlocks}

The player is not acting — they are letting this play out. CONTINUE driving the confrontation forward. Escalate, complicate, or force the moment to its crisis. NPCs act, consequences land, the situation demands response.

This collision is already spent — it MUST reach RESOLVED. Either the confrontation concludes this turn (MOVE to RESOLVED) or it escalates further, but it cannot stall. If it resolves, record the outcome:
• CLEAN — tension dissolves. MOVE to RESOLVED.
• COSTLY — someone paid. MOVE to RESOLVED. Record the cost.
• EVOLUTION — MOVE to RESOLVED, CREATE a new collision from what surfaced.

Record the draw in the update block: divination.last_draw: "[draw result]"
Full turn: deduction + prose + compact STATE block.]`;
    } else {
        // No ripe or in-progress collisions — randomized focus advance
        const focus = pickAdvanceFocus();

        const ADVANCE_PROMPTS = {
            scene: `FOCUS: THE SCENE
Something happens in or near ${pcName}'s current location. This is local, intimate, character-driven.
- An NPC in the scene acts on their own WANT — starts a conversation, makes a decision, reacts to something
- The environment shifts — a sound, a change in light, something noticed for the first time
- A detail the PC filed away comes back as a loaded gun
- Someone arrives or leaves
Write ONE focused beat. Deep, specific, sensory. The PC is present but the world is acting.`,

            world: `FOCUS: THE WORLD MOVES
Faction politics advance. Cut AWAY from ${pcName} to show what's happening in the larger world.
- A faction leader makes a decision. Show the meeting, the order, the execution.
- Alliances shift. A subordinate defies or obeys. Resources deploy.
- The consequence will reach ${pcName} later — plant the seed now.
Rewrite the acting faction's profile via SET faction:id field=profile.
Use --- or a location header to cut to the faction scene. The PC does NOT appear in this beat.`,

            offscreen: `FOCUS: OFF-SCREEN CHARACTER
A TRACKED character the PC hasn't interacted with recently does something driven by their WANT.
Cut to their location. Show what they're dealing with, what choice they face, how their constraints shape their action.
- This character acts independently — the PC may never learn what happened here.
- Or: the consequences arrive at the PC's doorstep next scene.
- Update the character's DOING, location, and reads in the ledger.
Use --- or a location/time header to cut to their scene. One deep beat from their perspective.`,

            new_threat: `FOCUS: SOMETHING NEW
Introduce a new element the story didn't have before this turn.
- A new NPC appears (CREATE with tier, WANT, DOING)
- A new event changes the landscape (environmental, political, personal)
- A new complication makes an existing collision worse
- Information surfaces that reframes something the PC thought they understood
You have FULL LICENSE: create characters, trigger events, introduce threats.
The new element should be COOL — not just tense, but interesting and unexpected.`,

            collision: `FOCUS: COLLISION TIGHTENS
An existing simmering or active collision compresses. Distance decreases.
Pick the collision that would produce the most interesting pressure right now.
- Show WHY it tightened — what moved, who acted, what changed
- The pressure becomes harder for ${pcName} to ignore
- SET the collision's distance closer. Update its details if the shape changed.
If a pressure point in Gravity_State_View feeds this collision, activate it:
REMOVE the pressure point, COMPRESS the collision distance, show the chain of causation.`,
        };

        const focusPrompt = ADVANCE_PROMPTS[focus.key];
        const focusHints = {
            scene: 'The scene shifts around you.',
            world: 'Meanwhile, elsewhere...',
            offscreen: 'Someone you know is busy.',
            new_threat: 'Something new enters the story.',
            collision: 'The pressure tightens.',
        };

        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} maintains vector (continues ${doing}). The PC does not act, speak, or change course this turn.

${draw.label}: ${draw.reading}${draw.html ? `\nRender this HTML card reveal before interpreting:\n${draw.html}` : ''}
The draw colors the world's move — it does not prescribe it.

${focusPrompt}

Record the draw in the update block: divination.last_draw: "[draw result]"

ADVANCE DEDUCTION (use this format, one line per item):
---DEDUCTION---
Focus: [scene/world/offscreen/new_threat/collision]
What moves: [the specific thing that happens]
Draw: [how the divination shapes this]
Collision: [which tightens or spawns — or: none]
Beat: [what happens.]
---END DEDUCTION---
Then prose, then compact STATE block.]`;
    }

    injectPrompt('advance');
    insertChatMessage(`*${pcName} continues what they were doing.*`);
}

function handleCombatSetupButton() {
    _pendingOOCInjection = `[GRAVITY COMBAT SETUP — The player's message contains their combat rules input. Read it and extrapolate a complete power scale for this story.

YOUR TASK:
1. Read the player's message for their combat scaling reference (e.g. "5 = Sephiroth" means Sephiroth is the ceiling).
2. Extrapolate a full power scale from 1 to that ceiling, filling in tiers based on the story's setting, characters, and established lore.
3. SET power on ALL existing characters in Gravity_State_View based on this scale.
4. SET power on the PC.
5. Write a brief summary of the scale you derived and the assignments you made.

Store the full scale description in a world constant:
> MAP_SET world field=constants key=combat_rules value="[your derived scale]"

HARD RULE: Do NOT create any mechanical combat system. No dice. No rolls. No HP. No condition tracks. No attack tables. No modifiers. No turn sequences. NONE. Dice in Gravity exist ONLY for divination — NEVER for combat. Combat is resolved through narrative prose using the Logic and Fairness principles. The power scale is a NARRATIVE REFERENCE for your judgment, not game mechanics.

Do not write prose. Just derive the scale, assign power values via ledger, and confirm.]`;

    injectPrompt('integration');
    // Don't overwrite the user's input — they already typed their rules
}

function handleCombatButton() {
    _pendingDeductionType = 'combat';
    const pcName = _currentState?.pc?.name || '{{user}}';
    const pcPower = _currentState?.pc?.power;

    // Find active combat collisions
    const combatCollisions = Object.values(_currentState?.collisions || {}).filter(
        c => c.mode === 'combat' && c.status !== 'RESOLVED' && c.status !== 'CRASHED'
    );

    // Build power gap assessment if combat collision exists
    let powerAssessment = '';
    if (combatCollisions.length > 0 && pcPower != null) {
        for (const col of combatCollisions) {
            const forces = Array.isArray(col.forces) ? col.forces : [];
            for (const force of forces) {
                const forceId = typeof force === 'string' ? force : force.id || force.name;
                if (!forceId || forceId === 'pc' || forceId === pcName) continue;
                const enemy = _currentState?.characters?.[forceId];
                if (enemy?.power != null) {
                    const gap = pcPower - enemy.power;
                    const gapDesc = gap === 0 ? 'equal'
                        : gap === -1 ? 'disadvantaged but winnable'
                        : gap <= -2 ? 'CANNOT win directly — must use established advantages'
                        : gap === 1 ? 'advantaged'
                        : 'dominant';
                    powerAssessment += `\nPC power:${pcPower} vs ${enemy.name || forceId} power:${enemy.power} | Gap:${gap} (${gapDesc})`;
                }
            }
        }
    }

    // Get combat rules from world constants (LLM-set) or chatMetadata (user-set)
    const { chatMetadata } = SillyTavern.getContext();
    const combatRules = _currentState?.world?.constants?.combat_rules
        || chatMetadata?.['gravity_combat_rules']
        || '';

    // Get PC wounds
    const pcWounds = _currentState?.pc?.wounds;
    let woundLine = '';
    if (pcWounds && typeof pcWounds === 'object' && Object.keys(pcWounds).length) {
        woundLine = `\nPC wounds: ${Object.entries(pcWounds).map(([k, v]) => `${k}: ${v}`).join(', ')}`;
    }

    // Build the injection
    const isSetup = combatCollisions.length === 0;
    const combatDraw = drawDivination();

    _pendingOOCInjection = `[GRAVITY COMBAT — ${pcName} ${isSetup ? 'initiates combat' : 'fights'}.

══ COMBAT ══${powerAssessment || (pcPower != null ? `\nPC power: ${pcPower}` : '')}${woundLine}
${combatRules ? `\nCOMBAT RULES (this story):\n${combatRules}\n` : ''}
${combatDraw.label}: ${combatDraw.reading}
The draw shapes the CIRCUMSTANCE of this combat exchange — not the outcome.

COMBAT PROTOCOL (extends your Logic + Fairness principles):
- In your Contest section: assess the PC's action against demonstrated_traits and established preparations from Gravity_State_View. Unearned capability fails or costs.
- Power gap of 2+: direct combat cannot win. Only advantages established in the ledger (reads, key_moments, world state) can close the gap logically.
- The enemy fights to their described capability (in cost field). They adapt to repeated tactics. They exploit trait gaps and existing wounds.
- Every action costs something. No free hits.
- Distance is elastic (same as narrative collisions). Decrement when the fight's momentum genuinely shifts.
- At distance 0: the draw shapes the decisive moment's arrival.
- Wounds are descriptive via MAP_SET on characters. Track what matters to the story.
- Combat outcomes ripple into collisions, factions, world state.

ABSOLUTE RULE: No dice. No rolls. No HP. No condition tracks. No modifiers. No hit counters. No turn sequences. No mechanical resolution of ANY kind. Divination draws are NOT combat dice — they shape circumstance and atmosphere. The power scale is a narrative reference for YOUR judgment, not a game mechanic. You resolve combat through prose using Logic and Fairness. Write the fight as fiction. Do not simulate it.
${isSetup ? `
SETUP TURN: No combat collision exists yet. This turn is SETUP:
1. CREATE a collision with mode=combat. Establish forces, distance, and threat (in cost field).
2. SET power on any new enemy characters based on the combat rules above.
3. Describe the threat and the opening situation.
4. Do NOT resolve a combat exchange yet — setup is the beat.` : ''}
Record the draw in the update block: divination.last_draw: "[draw result]"

COMBAT DEDUCTION (use this format, one line per item):
---DEDUCTION---
Action: [what the PC is attempting]
Power: [PC power:X vs enemy power:Y — gap, can this work?]
Advantages: [what PC has established — traits, prep, terrain, reads]
Enemy: [what the enemy would logically do — adapt, counter, exploit weakness]
Wounds: [PC wounds, enemy wounds — how these affect this exchange]
Distance: [current → change? why?]
Beat: [ONE exchange. What happens.]
---END DEDUCTION---
Then prose, then compact STATE block.]`;

    injectPrompt('advance');
    insertChatMessage(`*${pcName} ${isSetup ? 'prepares to fight.' : 'engages in combat.'}*`);
}

function handleIntimacyButton() {
    _pendingDeductionType = 'intimacy';
    const pcName = _currentState?.pc?.name || '{{user}}';

    // Gather intimacy stances for scene-active characters
    const stances = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        if (char.tier === 'UNKNOWN' || char.tier === 'KNOWN') continue;
        if (char.intimacy_stance) {
            stances.push(`${char.name || id}: ${char.intimacy_stance}`);
        }
    }

    // Gather intimate history if exists
    const histories = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        const ih = char.intimate_history;
        if (ih && typeof ih === 'object' && Object.keys(ih).length) {
            histories.push(`${char.name || id}: ${Object.entries(ih).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
    }

    const intimacyDraw = drawDivination();

    _pendingOOCInjection = `[GRAVITY INTIMACY — ${pcName} initiates an intimate scene.

${intimacyDraw.label}: ${intimacyDraw.reading}${intimacyDraw.html ? `\nRender this HTML card reveal before interpreting:\n${intimacyDraw.html}` : ''}
The draw shapes the TONE AND TEXTURE of this intimate encounter — not what happens, but HOW it feels. Apply the draw to the sexual energy, not the plot:
- The Fool = first-time energy, discovery, unexpected tenderness
- The Tower = something breaks open mid-act, a wall falls, overwhelming intensity
- Temperance = slow, balanced, both people finding rhythm together
- The Devil = hunger, urgency, the comfortable trap of wanting more than you should
- Death = transformation through intimacy, one version of them ending so another can exist
Interpret the draw through the body, not the mind. The card colors the sensation, the pacing, the involuntary responses.

═══ GATE CHECK — read this FIRST ═══
Before activating, check:
1. Is a sex scene the natural, earned next beat given the relationship, the tone, and the story?
2. Has the player's action or the narrative clearly escalated past casual physical contact?
3. Would both characters plausibly consent in this moment given their dossiers and intimacy stances?

If ANY answer is no: IGNORE this instruction entirely. Write normal prose. Do not acknowledge the gate failed.
If ALL answers are yes: ACTIVATE the intimate scene.

${stances.length ? `INTIMACY STANCES:\n${stances.map(s => `  ${s}`).join('\n')}\nThe stance defines what the character would do RIGHT NOW. Respect it.` : ''}

${histories.length ? `INTIMATE HISTORY:\n${histories.map(h => `  ${h}`).join('\n')}\nIf none exists, everything is discovery.` : 'No intimate history exists. Everything is discovery.'}

CONSTRAINT CHECK: Read constraint integrity from Gravity_State_View. Intimacy may pressure constraints — vulnerability blocks, trust thresholds. The constraint doesn't prevent the scene, it shapes HOW the character experiences it.

═══ THE EXPERIENCE ═══
Multi-turn interactive scene. Each turn:
1. One short, visceral prose beat (200-400 words)
2. 3-4 clickable options for the player
3. Player picks or writes their own

No fixed phase counts. Ends when: a collision arrives and demands resolution, player reaches natural conclusion, or player types "OOC: fade to black."

PROSE RULES:
- ONE SENSORY BEAT per turn. Direct vocabulary. Sensation chains (stimulus → where it travels → involuntary response).
- Texture of touch (material, temperature, pressure). Sounds rendered, not described.
- Pacing mimics the act (longer sentences for slow, fragments at peaks).
- Character first — how they have sex IS characterization.
- The partner is NOT passive — every 2-3 turns, skip choices and let partner act.

BODY DESCRIPTION — verbose, specific, present:
- Describe the body as it appears RIGHT NOW in the scene. Not a catalog — what the POV character notices, what the light catches, what changes under touch.
- Breasts: shape, weight, how they move with breathing or motion, how they respond to touch (skin texture, areola color/size, nipple response to temperature/contact/arousal). How they feel in a hand, against a chest, under a mouth. The specific difference between clothed and bare.
- All body description through the lens of the person experiencing it — what catches their breath, what their hands discover, what surprises them.
- Skin: temperature shifts, goosebumps, flush patterns (where color rises first), how sweat changes texture.
- Sound: involuntary sounds mapped to specific stimuli. What makes her gasp vs. what makes her go quiet. The sounds she doesn't know she's making.
- Anatomical precision. No euphemisms. The vocabulary of bodies, not poetry about them.

PARTNER INTERIORITY: Every 2-3 turns, short italicized first-person block from partner's perspective. 2-4 sentences. Raw internal experience from dossier and constraints.

CLICKABLE CHOICES — after EVERY prose beat, generate 4-5 options using this EXACT HTML format:
<span class="act" data-value="intimate: first-person action description">Short display text</span>

CHOICE PHILOSOPHY — the player can type "kiss her" themselves. Your job is to offer what they COULDN'T think of. Options that are specific to THESE characters, THIS relationship, THIS moment. Things that could only happen because of who they are and what they've been through.

DRAW FROM THE LEDGER. Read the character's constraints, key_moments, intimate_history, reads, and the divination draw. The options should reference:
- A constraint under pressure — what if he touches the part of her she's been protecting?
- A key moment callback — recreate a gesture from a non-intimate scene in an intimate context
- An intimate_history pattern — break it. If she always lets him lead, she takes over. If he always goes slow, he doesn't.
- A character flaw or fear surfacing mid-act — vulnerability that isn't performed
- The divination draw — if Death drew, an option might be "let the old version of this end"
- Something from the environment that isn't furniture — the sound from outside, the temperature, the light changing
- The thing neither of them has said out loud yet

THE OPTIONS SHOULD SURPRISE THE PLAYER. Not "what's the next sex move" but "what could happen between these two people that would change something." Every option should feel like a small story decision, not a menu item.

BAD: "Kiss her neck" "Touch her more" "Go harder" "Whisper something" — generic, could be anyone
GOOD: "Find the scar your balm healed and put your mouth on it" "Say the thing you told Aerith about her" "Stop — ask her what she actually wants, not what she thinks you want" "Let her see your hands shaking" "Do what she did to you on the cot, but reversed"

STRUCTURE:
- Option 1: Character-specific — references their shared history, a key moment, or a constraint
- Option 2: Vulnerability — something emotionally risky, not just physically bold
- Option 3: The partner's unspoken want — what THEY haven't asked for but their body is asking for
- Option 4: Pattern break — the opposite of what this couple usually does
- Option 5: Story beat — an action that would change the relationship's shape, not just the scene's heat

COLLISION CHECK: Each turn, check collision distances. If one reaches zero, it fires mid-scene. The world does not pause for intimacy.

EARLY EXIT: "OOC: fade to black" → cut to afterglow. No judgment.

AFTER THE SCENE: Resume full deduction + prose + compact STATE updates. Post-intimacy update block must include:
- READ updates (how characters see each other now)
- MOVE constraint if intimacy pressured one
- APPEND key_moments (intimate scene recorded — permanent)
- SET intimacy_stance if the stance shifted through the scene

INTIMATE HISTORY — cumulative development tracking. Each MAP_SET BUILDS on previous, never replaces:
- encounters: count + brief note per encounter ("3rd — she initiated for the first time, pulled him down")
- dynamic: who initiates, who leads, power balance, how it's SHIFTING ("was passive → now directs his hands")
- preferences: what they've DISCOVERED they like — not assumed, found ("likes teeth on collarbone — discovered encounter 2, repeated every time since")
- kinks: what's developing beyond vanilla as trust/comfort grows ("light restraint — she held his wrists encounter 4, he reciprocated encounter 5, becoming a pattern")
- boundaries: what they've hit, what made them stop, what they're not ready for YET ("won't be on top — tried once, froze, he read it instantly")
- evolution: the ARC of their sexual relationship ("encounter 1: discovery pace, tentative, stopped early. encounter 3: she knows what she wants, takes it. encounter 5: comfortable enough to laugh mid-act")
- aftermath: how they behave AFTER — this reveals more than the act ("encounter 1: buried face in chest, silent. encounter 4: talks, traces his skin, stays awake")

Each update should reference encounter NUMBER so the development arc is traceable. A preference discovered in encounter 2 that becomes a pattern by encounter 5 is character growth. Track it.

INTIMACY DEDUCTION (use this format, one line per item):
---DEDUCTION---
Stance: [partner's current intimacy_stance — what they'd do right now]
Constraint: [which constraint is pressured by this intimacy — or: none]
Partner wants: [what they haven't asked for but their body is showing]
History: [what pattern from intimate_history applies — or: first encounter]
Draw: [how divination shapes the sexual energy]
Beat: [ONE sensory beat.]
---END DEDUCTION---
Then prose, then choices, then compact STATE block.]`;

    injectPrompt('advance');
    insertChatMessage(`*${pcName} moves closer.*`);
}

async function handleGoodTurnButton() {
    const { Popup, chatMetadata, saveMetadata } = SillyTavern.getContext();
    const text = await Popup.show.input('Good Prose', 'Paste the paragraph(s) you liked:');
    if (!text) return;

    // Store exemplar in chatMetadata
    if (!chatMetadata['gravity_exemplars']) chatMetadata['gravity_exemplars'] = [];
    chatMetadata['gravity_exemplars'].push({
        text: text.trim(),
        turn: _turnCounter,
        _ts: Date.now(),
    });
    // Keep last 10
    if (chatMetadata['gravity_exemplars'].length > 10) {
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

    // Auto-snapshot before timeskip
    if (_currentState) {
        try {
            await createSnapshot(_currentState, `Pre-timeskip snapshot`);
            console.log(`${LOG_PREFIX} Pre-timeskip snapshot created.`);
        } catch (err) {
            console.warn(`${LOG_PREFIX} Pre-timeskip snapshot failed:`, err);
        }
    }

    _pendingOOCInjection = `[SYSTEM OVERRIDE: The user has initiated a time skip of "${duration}". FOR THIS RESPONSE ONLY, suspend your current character persona and act as an impartial, omniscient narrator called "The Passage of Time".

1. THE INTERRUPTION PROTOCOL: Evaluate the requested duration against the logical realities of the world. If the player is fleeing danger, wanted by authorities, or ignoring an active threat, calculate if they would realistically be caught before the skip ends. If yes, ABORT the skip early and drop them immediately into the confrontation.

2. THE BUTTERFLY EFFECT: Advance the agendas of ALL off-screen factions, tracked NPCs, and active collisions. The world moves without the player. For each tracked character: advance DOING, check constraints, update stance. For each collision: compress distance. For world: advance world state, pressure points. For each faction: advance MOMENTUM, update power (rising/stable/declining/collapsed), update relations with other factions, record last_move. Factions with conflicting objectives in the same space create new pressure points.

3. FORMAT — MULTI-BEAT, MULTI-ANGLE: Write 3-6 beats, cutting between locations and characters. Use --- or location/time headers between beats:
   Beat: THE PC — What they did during "${duration}". Routines, projects, rest. Show the rhythm, not a summary.
   Beat: CUT TO [faction HQ / patrol route / offscreen NPC] — What a faction did. Show the order being given or executed. Name the subordinates.
   Beat: CUT TO [tracked character] — What a dormant character did with their WANT. Their own scene, their own momentum.
   Beat: CUT TO [collision surface] — Two forces moved closer. Show the near-miss or the evidence accumulating.
   Beat: CUT BACK TO PC — The hook. Something demands response NOW. A knock, a rumor, a consequence arriving.
   Final: Hand agency back to the player. New [Day N — HH:MM] timestamp.

4. LEDGER: Emit a full ---LEDGER--- block recording ALL state changes from the skip:
   - SET/MOVE on characters (doing, want, constraint pressure)
   - SET on collisions (distance changes)
   - MOVE on collisions (status changes if distances compressed enough)
   - SET on world (world_state, faction advances)
   - APPEND on world (new pressure_points)
   - APPEND on pc (timeline entries for the skip period)
   - APPEND on summary (brief skip summary)

Do NOT close the chapter. The story continues.]`;

    injectPrompt('integration');
    insertChatMessage(`OOC: Timeskip — ${duration}`);
}

async function handleChapterCloseButton() {
    _uncappedTurn = true;
    const chapterDraw = drawDivination();
    _pendingOOCInjection = `[SYSTEM OVERRIDE: The user has requested a chapter close. Pause narrative and execute the full chapter transition protocol across multiple responses.

═══ RESPONSE 1 — EVALUATION (this turn) ═══

A. HEALTH CHECK — audit the ledger state:
   - Collision audit: any stale (5+ turns unchanged), orphaned, or overloaded?
   - Constraint audit: principal's integrity accurate? Drift between ledger state and actual events?
   - Continuity: contradictions between stored state and recent prose?
   - Loaded guns: noticed details that never fired? Details that fired but weren't removed?
   - Missing state: events that happened in prose but never got recorded?
   Emit catch-up transactions for anything missed.

B. CHAPTER SUMMARY — the chapter that just ended:
   - Key beats, turning point, what changed. 3-5 sentences.
   - APPEND this to summary entity.

C. ARC EVALUATION — honest narrative self-assessment:
   - I planned: [from chapter plan / central tension]
   - The player forced: [how they disrupted it]
   - The story went: [actual trajectory]
   - What worked narratively and what didn't
   - Collisions: which resolved, which didn't, which spawned

D. FACTION POLITICS — simulate the macro layer:
   For EACH active faction, REWRITE its profile paragraph based on this chapter's events:
   > SET faction:id field=profile value="[full updated paragraph: objective, power, resources, momentum (include what they did this chapter), leverage, vulnerability, stance toward PC]"
   Update relations map via MAP_SET for any shifts.

   Then SIMULATE inter-faction dynamics:
   - Factions with hostile relations actively undermine each other
   - A declining faction gets desperate — desperate factions make reckless moves
   - A rising faction attracts rivals AND supplicants
   - How do factions view the PC now? Update via READ on faction entities.

   PRESSURE POINT GENERATION — collision fuel for the next chapter:
   From the faction simulation, generate 2-4 NEW pressure points that:
   - Emerge from faction conflicts (political, territorial, resource tensions)
   - Are specific and concrete enough to trigger scenes
   - Name the factions involved
   - Would be COOL to encounter — not just tense, but interesting
   Pressure points are raw seams — during advance turns, they will be converted
   into collision fuel (compressing existing collision distances, shifting forces,
   or spawning new collisions). Write them as seeds, not conclusions.
   REMOVE spent/resolved pressure points from previous chapter.
   APPEND new ones to world.pressure_points.

   Emit all faction updates as ledger transactions (SET/MAP_SET on each faction entity).

E. ASK THE PLAYER — present choices for the next chapter:
   1. Where do you want to start next? (specific scene/location/moment — sanity check: is this reachable from current state?)
   2. How much time passes before the next chapter opens?
   3. Focus: what should the next chapter be about? (or let me decide)
   4. Tone shift: should the tone rules change?
   5. Cast changes: promote, retire, or shift focus?
   Answer as much or as little as you want. Silence = I decide.

═══ RESPONSE 2 — TRANSITION (after player answers) ═══

${chapterDraw.label}: ${chapterDraw.reading}
This draw shapes the TONE AND DIRECTION of the next chapter — not specific events, but the forces at play. Use it to guide:
- What kind of chapter this will be (upheaval, introspection, acceleration, reckoning)
- How faction dynamics shift during the transition
- What collisions tighten or emerge
- The emotional register of the opening scene
Record the draw in the update block: divination.last_draw: "[draw result]"

A. SANITY CHECK the player's requested starting point:
   - Is it reachable given current world state, character positions, and timeline?
   - If not: explain why and propose the closest realistic alternative.

B. TIMESKIP to the new starting point:
   - Advance all tracked characters (SET doing, location, condition, reads)
   - Advance all constraints (MOVE integrity if pressure accumulated)
   - Advance all collisions (compress distances, SET details if shape changed)
   - Rewrite faction profiles (SET profile — each faction acts during the skip)
   - Advance world (SET world_state, APPEND/REMOVE pressure_points)
   - Check: would any interruption logically occur during the skip?

C. EMIT LEDGER BLOCK:
   - MOVE chapter: OPEN->CLOSING->CLOSED for old chapter
   - CREATE new chapter with profile: SET chapter:id field=profile value="[number, title, arc, central tension]"
   - All timeskip advances (SET/MOVE on characters, collisions, world)
   - Faction profile rewrites (SET profile on each faction, MAP_SET relations)
   - APPEND summary with chapter arc summary (rich, 3-5 sentences)
   - UPDATE pc current_scene for the new opening

D. WRITE the opening of the new chapter — the player lands in the result, not a summary. Full deduction + prose + ledger block.]`;

    injectPrompt('integration');
    insertChatMessage('OOC: Close this chapter.');
}

// ─── Revert Turn ───────────────────────────────────────────────────────────────

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
    delete chatMetadata['gravity_combat_rules'];
    delete chatMetadata['gravity_exemplars'];
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
        onCombatSetup: handleCombatSetupButton,
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


