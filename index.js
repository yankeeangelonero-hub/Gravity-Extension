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
import { computeState } from './state-compute.js';
import { formatStateView, formatReadme } from './state-view.js';
import { extractLedgerBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning } from './ui-panel.js';
import { isActive as isSetupActive, getPhasePrompt, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback, showSetupPopup, buildSetupPrompt } from './setup-wizard.js';

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

// ─── Collision Arrival Tracking ───────────────────────────────────────────────

// Set of collision IDs that have already had their arrival injection fired.
// Cleared on chat change. Prevents re-firing every turn while at dist 0.
let _firedCollisionArrivals = new Set();

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

        // Collision arrival — fires on next turn (regular or advance) when distance hits 0
        if (_currentState) {
            const arrivals = [];
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                if (_firedCollisionArrivals.has(id)) continue;
                const dist = parseFloat(col.distance);
                if (isNaN(dist)) continue;
                const status = (col.status || '').trim().toUpperCase();
                if (dist <= 0 && status !== 'RESOLVED') {
                    const cardNum = Math.floor(Math.random() * 22);
                    const cardReading = ARCANA_TABLE[cardNum];
                    const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(', ') : String(col.forces || '?');
                    arrivals.push({ id, col, cardNum, cardReading, forces });
                    _firedCollisionArrivals.add(id);
                }
            }

            // Stale RESOLVING check — collisions stuck in RESOLVING too long
            const staleResolving = [];
            const totalTxCount = getAllTransactions().length;
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                if ((col.status || '').trim().toUpperCase() !== 'RESOLVING') continue;
                if (_firedCollisionArrivals.has(id + '_stale')) continue;
                const statusHist = (_currentState._history || {})[`collision:${id}:status`] || [];
                const lastMove = statusHist[statusHist.length - 1];
                if (lastMove && lastMove.tx) {
                    const txSince = totalTxCount - lastMove.tx;
                    if (txSince >= 15) {
                        staleResolving.push({ id, col, txSince });
                        _firedCollisionArrivals.add(id + '_stale');
                    }
                }
            }

            // Distance-increase warning — distances are countdowns, they should not increase
            const distWarnings = [];
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                if (status === 'RESOLVED' || status === 'CRASHED') continue;
                const distHist = (_currentState._history || {})[`collision:${id}:distance`] || [];
                if (distHist.length > 0) {
                    const last = distHist[distHist.length - 1];
                    const fromDist = parseFloat(last.from);
                    const toDist = parseFloat(last.to);
                    if (!isNaN(fromDist) && !isNaN(toDist) && toDist > fromDist) {
                        distWarnings.push(`"${col.name || id}" distance went ${last.from} → ${last.to} — collision distances are countdowns, they MUST NOT increase. SET it back to ${last.from} or lower.`);
                    }
                }
            }

            // Incoherent collision check — RESOLVING but distance > 0 means the confrontation
            // can't actually be happening. Either it was avoided (CRASHED/RESOLVED) or it's not
            // RESOLVING yet (revert to ACTIVE).
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                const status = (col.status || '').trim().toUpperCase();
                if (status !== 'RESOLVING') continue;
                const dist = parseFloat(col.distance);
                if (!isNaN(dist) && dist > 0) {
                    distWarnings.push(`"${col.name || id}" is RESOLVING but distance is ${dist} — a collision cannot resolve at range. If the confrontation was avoided or is no longer possible, MOVE to RESOLVED. If it's still approaching, MOVE back to ACTIVE.`);
                }
            }

            if (arrivals.length > 0) {
                const blocks = arrivals.map(a =>
                    `═══ COLLISION ARRIVAL: "${a.col.name || a.id}" ═══
Forces: ${a.forces}
Cost: ${a.col.cost || 'unspecified'}
${a.col.target_constraint ? `Target constraint: ${a.col.target_constraint}` : ''}

THE ARCANA DREW: #${a.cardNum} — ${a.cardReading}

This collision has reached distance 0. It detonates NOW.

You have FULL LICENSE to make this happen. Move NPCs into the scene. Spawn threats. Have someone arrive with information. Trigger events. Create new characters. Use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

The tarot card shapes the CIRCUMSTANCE of how this collision arrives — not the outcome. Write the situation, not the resolution. The player must respond to it.

THIS COLLISION IS NOW SPENT. After this scene, MOVE its status to RESOLVED.

WHAT HAPPENS NEXT depends on what the confrontation produces:
• CLEAN — tension dissolves. MOVE to RESOLVED.
• COSTLY — someone paid. MOVE to RESOLVED. Record the cost.
• EVOLUTION — reveals a different tension. MOVE to RESOLVED, CREATE a new collision from what surfaced.

No collision survives detonation.`
                ).join('\n\n');

                setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks, PROMPT_IN_CHAT, 0);
                console.log(`${LOG_PREFIX} Collision arrival fired for: ${arrivals.map(a => a.id).join(', ')}`);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            }

            if (staleResolving.length > 0) {
                const staleBlock = staleResolving.map(s =>
                    `[STALE COLLISION — "${s.col.name || s.id}" has been RESOLVING for ${s.txSince}+ transactions. MOVE it to RESOLVED now. If the tension persists in a new form, CREATE a new collision to track it.]`
                ).join('\n');
                setExtensionPrompt(`${MODULE_NAME}_stale`, staleBlock, PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_stale`, '', PROMPT_NONE, 0);
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
            setExtensionPrompt(`${MODULE_NAME}_stale`, '', PROMPT_NONE, 0);
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
        if (isRegular) {
            setExtensionPrompt(`${MODULE_NAME}_nudge`,
                `[SYSTEM: Your response is INCOMPLETE without a ---LEDGER--- block at the end. This is mandatory.

After prose, append:
---LEDGER---
> [Day N — HH:MM] OPERATION entity:id key=value -- reason
---END LEDGER---

WHAT TO TRACK — emit in PRIORITY ORDER (cap: 20 lines, excess dropped):
1. State transitions (MOVE constraint integrity, collision status, chapter status)
2. Collision distance changes (SET distance)
3. Character DOING/WANT updates (SET)
4. World state changes (SET world_state)
5. Faction updates (SET power/momentum/last_move, MAP_SET relations)
6. Story summary (APPEND summary) — every significant scene, 2-4 sentences with texture
7. Key moments / noticed details (APPEND)
8. READS updates when interpretation shifts (READ)
9. PC traits, timeline, reputation (APPEND / MAP_SET)
10. Intimacy stance shifts after constraint/narrative changes (SET intimacy_stance — with reason)
11. Intimate history after intimate scenes (MAP_SET intimate_history)
12. Housekeeping REMOVEs — ALWAYS LAST, 2–3 per turn max, never bulk dumps
If nothing changed: (empty)]`,
                PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_nudge`,
                `[SYSTEM: Include a ---LEDGER--- block at the end. Cap: 20 lines${_uncappedTurn ? ' (UNCAPPED this turn)' : ''}.]`,
                PROMPT_IN_CHAT, 0);
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} Inject failed:`, err);
    }
}

// ─── Array Size Checks ────────────────────────────────────────────────────────

const ARRAY_SIZE_LIMITS = {
    pressure_points: { path: s => s.world?.pressure_points, label: 'PRESSURE_POINTS', cap: 10 },
    demonstrated_traits: { path: s => s.pc?.demonstrated_traits, label: 'PC TRAITS', cap: 12 },
    timeline: { path: s => s.pc?.timeline, label: 'PC TIMELINE', cap: 20 },
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
        const moments = char.key_moments;
        if (Array.isArray(moments) && moments.length > 25) {
            warnings.push(`${char.name || id} KEY_MOMENTS: ${moments.length} entries — consolidate to most significant.`);
        }
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
    _firedCollisionArrivals = new Set();

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

    // Extract ledger block (command-style or legacy JSON)
    const extraction = extractLedgerBlock(message.mes);

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

    // Extraction-level errors (failed lines from command parser)
    const extractionErrors = extraction.errors || [];

    // No transactions at all (empty block or all lines failed)
    if (extraction.transactions.length === 0 && extractionErrors.length === 0) {
        _pendingReinforcement = getReinforcement(extraction, _turnCounter);
        injectPrompt();
        return;
    }

    // Hard cap: drop transactions beyond 20 to prevent bulk-remove dumps
    // Disabled for eval and chapter-close turns which legitimately need large blocks
    const TX_CAP = 20;
    let txOverflow = 0;
    if (!_uncappedTurn && extraction.transactions.length > TX_CAP) {
        txOverflow = extraction.transactions.length - TX_CAP;
        extraction.transactions.length = TX_CAP;
        console.warn(`${LOG_PREFIX} Ledger block exceeded cap (${TX_CAP + txOverflow} lines). Dropped ${txOverflow} excess transactions.`);
    }
    _uncappedTurn = false;

    // Validate each transaction individually
    const validTxns = [];
    const validationErrors = [];
    for (let i = 0; i < extraction.transactions.length; i++) {
        const result = validateBatch([extraction.transactions[i]]);
        if (result.valid) {
            validTxns.push(extraction.transactions[i]);
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

    // Check array sizes and warn if bloated
    const sizeWarnings = checkArraySizes(_currentState);

    // Build reinforcement
    _pendingReinforcement = getReinforcement(extraction, _turnCounter);
    if (sizeWarnings) {
        _pendingReinforcement = (_pendingReinforcement || '') + '\n' + sizeWarnings;
    }
    if (txOverflow > 0) {
        _pendingReinforcement = (_pendingReinforcement || '') +
            `\n[LEDGER: OVERFLOW — ${txOverflow} lines dropped (cap is ${TX_CAP}). Emit in priority order: state transitions > distance > DOING/WANT > world > summary > details. REMOVEs are LOWEST priority — 2–3 per turn max.]`;
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

    const result = await processOOC(message.mes);
    if (result.handled && result.injection) {
        _uncappedTurn = /ooc:\s*eval\b/i.test(message.mes);
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
            if (!isNaN(dist) && dist <= 0 && status !== 'RESOLVED' && !_firedCollisionArrivals.has(id)) {
                const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(', ') : String(col.forces || '?');
                ripeCollisions.push({ id, col, forces });
                _firedCollisionArrivals.add(id);
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

    // Roll one card for the whole advance
    const cardNum = Math.floor(Math.random() * 22);
    const cardReading = ARCANA_TABLE[cardNum];

    if (ripeCollisions.length > 0) {
        // Advance = collision detonation. The ripe collision IS the thing that happens.
        const collisionBlocks = ripeCollisions.map(a =>
            `COLLISION: "${a.col.name || a.id}"
Forces: ${a.forces}
Cost: ${a.col.cost || 'unspecified'}
${a.col.target_constraint ? `Target constraint: ${a.col.target_constraint}` : ''}`
        ).join('\n\n');

        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} yields the turn. The world moves.

THE ARCANA DREW: #${cardNum} — ${cardReading}
The card shapes the CIRCUMSTANCE of what happens — not the outcome.

${ripeCollisions.length === 1 ? 'A collision has arrived:' : 'These collisions have arrived:'}

${collisionBlocks}

This is the world's turn and this collision detonates NOW. You have FULL LICENSE to make it happen — move NPCs into the scene, spawn threats, have someone arrive with information, trigger events, create new characters, use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

Write the situation, not the resolution. The player must respond to it.

THIS COLLISION IS NOW SPENT. After this scene, MOVE its status to RESOLVED. There is no going back — it detonated.

WHAT HAPPENS NEXT depends on what the confrontation produces:
• CLEAN — the tension dissolves. No scar. MOVE to RESOLVED.
• COSTLY — someone paid. MOVE to RESOLVED. Record the cost.
• EVOLUTION — the confrontation reveals a different tension. MOVE to RESOLVED, then CREATE a new collision from what surfaced.

No collision survives detonation. If the tension persists in a new shape, CREATE a fresh collision.

Record the draw: SET divination field=last_draw value="[card name]"
Full turn: deduction + prose + ledger block.]`;
    } else if (inProgressCollisions.length > 0) {
        // Collision already detonated but not resolved — player is yielding, push it forward
        const collisionBlocks = inProgressCollisions.map(a =>
            `"${a.col.name || a.id}" [${a.col.status}] — Forces: ${a.forces}
Cost: ${a.col.cost || 'unspecified'}`
        ).join('\n');

        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} yields the turn. A collision is in progress.

THE ARCANA DREW: #${cardNum} — ${cardReading}
The card shapes what happens next — not the outcome.

IN-PROGRESS COLLISION:
${collisionBlocks}

The player is not acting — they are letting this play out. CONTINUE driving the confrontation forward. Escalate, complicate, or force the moment to its crisis. NPCs act, consequences land, the situation demands response.

This collision is already spent — it MUST reach RESOLVED. Either the confrontation concludes this turn (MOVE to RESOLVED) or it escalates further, but it cannot stall. If it resolves, record the outcome:
• CLEAN — tension dissolves. MOVE to RESOLVED.
• COSTLY — someone paid. MOVE to RESOLVED. Record the cost.
• EVOLUTION — MOVE to RESOLVED, CREATE a new collision from what surfaced.

Record the draw: SET divination field=last_draw value="[card name]"
Full turn: deduction + prose + ledger block.]`;
    } else {
        // No ripe or in-progress collisions — normal world-advance with multi-beat structure
        _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} maintains vector (continues ${doing}). The PC does not act, speak, or change course this turn.

THE ARCANA DREW: #${cardNum} — ${cardReading}
The card colors the world's move — it does not prescribe it.

This is the world's turn. You may write MULTIPLE BEATS and CUT between character angles:

STRUCTURE: Write 2-4 short beats, each from a different angle. Use scene cuts:
- Beat 1: What ${pcName} is doing (brief, maintaining vector)
- Beat 2: An NPC in the scene acts on their own WANT — starts a conversation, reacts, decides
- Beat 3: Cut to a different location — a faction leader issues an order, a subordinate executes, a patrol moves
- Beat 4: Cut back — the consequence arrives where the PC is

Use --- or a location/time header to cut between angles. Each beat can be 50-150 words. Not every beat needs the PC.

PRESSURE POINT PROTOCOL — the Rule of Cool:
Scan the pressure_points array in the state view. If any exist, pick the one that would
produce the COOLEST moment right now — not the most dramatic or intense, but the most
interesting, unexpected, or stylish intersection with the current scene.

You have FULL LICENSE to make it happen: move NPCs into position, introduce new NPCs,
spawn threats, have faction subordinates arrive with orders, trigger events, create new
characters, use environmental disasters. Whatever it takes to force this pressure into
the player's immediate reality. Show the chain of causation — which faction's action
created this pressure, how it reaches the PC, what it forces.

A pressure point DOES NOT detonate on its own. It feeds the collision engine:
- If an existing collision is relevant: COMPRESS its distance (SET distance closer),
  add to its forces, or shift its cost. The faction politics make a personal confrontation
  worse, faster, or differently shaped.
- If no existing collision fits: CREATE a new collision from the pressure point.
  Give it forces, status=SIMMERING or ACTIVE, a distance, and a cost.
  The pressure has crystallized into a proper confrontation.

After activating a pressure point, REMOVE it from world.pressure_points. It has been
converted into collision fuel — it is no longer a raw seam, it is now tracked momentum.

If no pressure points exist or none fit, PICK from Gravity_State_View instead:
- NPCs act on their WANT or DOING
- A collision tightens because the world moved
- A dormant character's WANT pulls them back

Record the draw: SET divination field=last_draw value="[card name]"
Full turn: deduction + prose + ledger block.]`;
    }

    injectPrompt('advance');
    insertChatMessage(`*${pcName} continues what they were doing.*`);
}

function handleCombatButton() {
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

    // Get combat rules from chatMetadata
    const { chatMetadata } = SillyTavern.getContext();
    const combatRules = chatMetadata?.['gravity_combat_rules'] || '';

    // Get PC wounds
    const pcWounds = _currentState?.pc?.wounds;
    let woundLine = '';
    if (pcWounds && typeof pcWounds === 'object' && Object.keys(pcWounds).length) {
        woundLine = `\nPC wounds: ${Object.entries(pcWounds).map(([k, v]) => `${k}: ${v}`).join(', ')}`;
    }

    // Build the injection
    const isSetup = combatCollisions.length === 0;

    _pendingOOCInjection = `[GRAVITY COMBAT — ${pcName} ${isSetup ? 'initiates combat' : 'fights'}.

══ COMBAT ══${powerAssessment || (pcPower != null ? `\nPC power: ${pcPower}` : '')}${woundLine}
${combatRules ? `\nCOMBAT RULES (this story):\n${combatRules}\n` : ''}
COMBAT PROTOCOL (extends your Logic + Fairness principles):
- In your Contest section: assess the PC's action against demonstrated_traits and established preparations from Gravity_State_View. Unearned capability fails or costs.
- Power gap of 2+: direct combat cannot win. Only advantages established in the ledger (reads, key_moments, world state) can close the gap logically.
- The enemy fights to their described capability (in cost field). They adapt to repeated tactics. They exploit trait gaps and existing wounds.
- Every action costs something. No free hits.
- Distance is elastic (same as narrative collisions). Decrement when the fight's momentum genuinely shifts.
- At distance 0: arcana fires, decisive moment arrives.
- Wounds are descriptive via MAP_SET on characters. Track what matters to the story.
- Combat outcomes ripple into collisions, factions, world state.

ABSOLUTE RULE: No dice. No rolls. No HP. No condition tracks. No modifiers. No hit counters. No turn sequences. No mechanical resolution of ANY kind. Dice exist ONLY for divination — NEVER for combat. The power scale is a narrative reference for YOUR judgment, not a game mechanic. You resolve combat through prose using Logic and Fairness. Write the fight as fiction. Do not simulate it.
${isSetup ? `
SETUP TURN: No combat collision exists yet. This turn is SETUP:
1. CREATE a collision with mode=combat. Establish forces, distance, and threat (in cost field).
2. SET power on any new enemy characters based on the combat rules above.
3. Describe the threat and the opening situation.
4. Do NOT resolve a combat exchange yet — setup is the beat.` : ''}
Full turn: deduction + prose + ledger block.]`;

    injectPrompt('advance');
    insertChatMessage(`*${pcName} ${isSetup ? 'prepares to fight.' : 'engages in combat.'}*`);
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
   For EACH active faction, evaluate based on this chapter's events:
   1. POWER SHIFT: Did this faction gain or lose ground? Update power field (rising/stable/declining/collapsed).
   2. MOMENTUM: What is the faction now actively pursuing? Update momentum field.
   3. RELATIONS: Did alliances shift? New rivalries? Betrayals? Update relations map via MAP_SET.
   4. LAST MOVE: What did this faction DO this chapter, even offscreen? Update last_move.
   5. LEVERAGE & VULNERABILITY: Did these change? Update if so.

   Then SIMULATE inter-faction dynamics:
   - Factions with hostile relations actively undermine each other
   - A declining faction gets desperate — desperate factions make reckless moves
   - A rising faction attracts rivals AND supplicants
   - Check pc.reputation — the PC's standing colors every faction's calculus

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

A. SANITY CHECK the player's requested starting point:
   - Is it reachable given current world state, character positions, and timeline?
   - If not: explain why and propose the closest realistic alternative.

B. TIMESKIP to the new starting point:
   - Advance all tracked characters (DOING, constraints, reads, stance)
   - Advance all collisions (compress distances, check for arrivals)
   - Advance world (factions, world state, pressure points)
   - Advance faction politics: each faction executes its MOMENTUM during the skip.
     Update relations based on timeskip duration. Factions with conflicting objectives
     in the same territory create new pressure points. A rising faction may absorb
     or squeeze a declining one.
   - Check: would any interruption logically occur during the skip?

C. EMIT LEDGER BLOCK:
   - MOVE chapter: OPEN->CLOSING->CLOSED for old chapter
   - CREATE new chapter (number, title, status=OPEN, arc, central_tension, target_collisions)
   - All timeskip advances (SET/MOVE on characters, collisions, world)
   - Faction updates (SET power/momentum/last_move, MAP_SET relations on each faction)
   - APPEND summary with chapter summary
   - APPEND pc timeline entries for skip period

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
            data.lastTxId = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.tx || 0)) : 0;
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
    await saveMetadata();
    resetLedger();
    _pendingCorrections = [];
    _pendingReinforcement = null;
    await initialize(true);
}

async function handleExportData() {
    return exportData();
}

async function handleImportData(data) {
    await importData(data);
    _pendingCorrections = [];
    _pendingReinforcement = null;
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
        <button class="gl-input-btn" id="gl-input-skip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
        <button class="gl-input-btn" id="gl-input-good" title="Flag good prose — paste exemplar"><i class="fa-solid fa-thumbs-up"></i> Good</button>
    `;
    sendForm.insertBefore(bar, sendForm.firstChild);

    document.getElementById('gl-input-advance').addEventListener('click', handleAdvanceButton);
    document.getElementById('gl-input-combat').addEventListener('click', handleCombatButton);
    document.getElementById('gl-input-skip').addEventListener('click', handleTimeskipButton);
    document.getElementById('gl-input-good').addEventListener('click', handleGoodTurnButton);
}
