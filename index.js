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
import { isActive as isSetupActive, getPhasePrompt, checkPhaseCompletion, startSetup, cancelSetup, getPhaseLabel, setPhaseCallback } from './setup-wizard.js';

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

function injectPrompt() {
    const context = SillyTavern.getContext();
    const { setExtensionPrompt } = context;
    if (!setExtensionPrompt) return;

    try {
        // State view
        if (_currentState) {
            const stateView = formatStateView(_currentState);
            setExtensionPrompt(`${MODULE_NAME}_state`, stateView, PROMPT_IN_CHAT, 0);
        }

        // Format readme
        const readme = formatReadme();
        setExtensionPrompt(`${MODULE_NAME}_readme`, readme, PROMPT_IN_CHAT, 0);

        // Setup wizard phase prompt (overrides corrections when active)
        const setupPrompt = getPhasePrompt();
        if (setupPrompt) {
            setExtensionPrompt(`${MODULE_NAME}_setup`, setupPrompt, PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_setup`, '', PROMPT_NONE, 0);
        }

        // OOC command injection (from buttons)
        if (_pendingOOCInjection) {
            setExtensionPrompt(`${MODULE_NAME}_ooc`, _pendingOOCInjection, PROMPT_IN_CHAT, 0);
            _pendingOOCInjection = null;
        } else {
            setExtensionPrompt(`${MODULE_NAME}_ooc`, '', PROMPT_NONE, 0);
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

        // Style exemplars — inject last 5 good paragraphs flagged by the player
        const { chatMetadata } = SillyTavern.getContext();
        const exemplars = chatMetadata?.['gravity_exemplars'] || [];
        if (exemplars.length > 0) {
            const recent = exemplars.slice(-5);
            const exLines = recent.map((ex, i) => `  ${i + 1}. "${ex.text}"`).join('\n');
            setExtensionPrompt(`${MODULE_NAME}_exemplars`,
                `[STYLE EXEMPLARS — the player flagged these as excellent prose. Match this quality and voice:\n${exLines}]`,
                PROMPT_IN_CHAT, 0);
        } else {
            setExtensionPrompt(`${MODULE_NAME}_exemplars`, '', PROMPT_NONE, 0);
        }

        // Faction heartbeat — every 10 turns, check if factions have been active
        if (_turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
            const factions = Object.values(_currentState.factions || {});
            if (factions.length > 0) {
                const factionNames = factions.map(f => `${f.name || f.id} (${f.objective || '?'})`).join(', ');
                setExtensionPrompt(`${MODULE_NAME}_faction`,
                    `[FACTION HEARTBEAT — Turn ${_turnCounter}. Active factions: ${factionNames}.\nFactions execute operations independently. Leaders command subordinates — show the chain of command. You may CUT to a faction scene (a brief beat from their angle) before cutting back to the main scene. If no faction has visibly acted in recent turns, one MUST advance NOW. Show the evidence arriving — through a subordinate, a broadcast, a checkpoint, a consequence.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_faction`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_faction`, '', PROMPT_NONE, 0);
        }

        // Dormant character check — every 15 turns, flag characters with no recent activity
        const DORMANT_THRESHOLD = 20; // transactions since last activity
        if (_turnCounter > 0 && _turnCounter % 15 === 0 && _currentState) {
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
                    `[DORMANT CHARACTERS — gravity still pulls these characters toward collision:\n${dormant.map(d => '  • ' + d).join('\n')}\nGravity is constant — however weak, it pulls toward collision. Their WANT is a force. Their DOING has consequences. Advance them toward the nearest collision — or spawn a new one from their WANT intersecting the current situation. Faction leaders issue orders through subordinates even when offscreen.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_dormant`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_dormant`, '', PROMPT_NONE, 0);
        }

        // Collision arrival — fires when any collision reaches distance ≤ 1 and hasn't been flagged yet
        if (_currentState) {
            const arrivals = [];
            for (const [id, col] of Object.entries(_currentState.collisions || {})) {
                if (_firedCollisionArrivals.has(id)) continue;
                const dist = parseInt(col.distance, 10);
                if (isNaN(dist)) continue;
                const status = (col.status || '').toUpperCase();
                if (dist <= 1 && (status === 'ACTIVE' || status === 'SIMMERING')) {
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
                if ((col.status || '').toUpperCase() !== 'RESOLVING') continue;
                if (_firedCollisionArrivals.has(id + '_stale')) continue;
                // Check how many transactions since it entered RESOLVING
                const statusHist = (_currentState._history || {})[`collision:${id}:status`] || [];
                const lastMove = statusHist[statusHist.length - 1];
                if (lastMove && lastMove.tx) {
                    const txSince = totalTxCount - lastMove.tx;
                    if (txSince >= 15) { // ~3 turns worth of transactions
                        staleResolving.push({ id, col, txSince });
                        _firedCollisionArrivals.add(id + '_stale');
                    }
                }
            }

            if (arrivals.length > 0) {
                const blocks = arrivals.map(a =>
                    `═══ COLLISION ARRIVAL: "${a.col.name || a.id}" ═══
Forces: ${a.forces}
Cost: ${a.col.cost || 'unspecified'}
${a.col.target_constraint ? `Target constraint: ${a.col.target_constraint}` : ''}

THE ARCANA DREW: #${a.cardNum} — ${a.cardReading}

This collision has reached distance ${a.col.distance}. It detonates NOW.

You have FULL LICENSE to make this happen. Move NPCs into the scene. Spawn threats. Have someone arrive with information. Trigger events. Create new characters. Use environmental disasters. Whatever it takes to force this issue into the player's immediate reality.

The tarot card shapes the CIRCUMSTANCE of how this collision arrives — not the outcome. Write the situation, not the resolution. The player must respond to it.

THIS COLLISION IS NOW SPENT. After this scene, MOVE its status to RESOLVED. There is no going back — it detonated.

WHAT HAPPENS NEXT depends on what the confrontation produces:
• CLEAN — the tension dissolves. Forces coexist or one yields. No scar. MOVE to RESOLVED.
• COSTLY — it resolves, but someone paid. Trust spent, secrets exposed, resources lost. MOVE to RESOLVED. Record the cost in character state.
• EVOLUTION — the confrontation reveals a deeper or different tension. MOVE to RESOLVED, then CREATE a new collision from what actually surfaced. The old collision is done — the new one tracks what it mutated into.

In ALL cases this collision is RESOLVED after the player responds. If the underlying tension persists in a new shape, CREATE a fresh collision to track it. No collision survives detonation.

Do NOT let this collision continue to simmer. Do NOT write around it. The issue is HERE.`
                ).join('\n\n');

                setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks, PROMPT_IN_CHAT, 0);
                console.log(`${LOG_PREFIX} Collision arrival fired for: ${arrivals.map(a => a.id).join(', ')}`);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            }

            if (staleResolving.length > 0) {
                const staleBlock = staleResolving.map(s =>
                    `[STALE COLLISION — "${s.col.name || s.id}" has been RESOLVING for ${s.txSince}+ transactions. This collision already detonated — MOVE it to RESOLVED now. If the tension persists in a new form, CREATE a new collision to track it. No collision survives past detonation.]`
                ).join('\n');
                setExtensionPrompt(`${MODULE_NAME}_stale`, staleBlock, PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_stale`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_arrival`, '', PROMPT_NONE, 0);
            setExtensionPrompt(`${MODULE_NAME}_stale`, '', PROMPT_NONE, 0);
        }

        // Permanent nudge — always present at depth 0, every turn
        setExtensionPrompt(`${MODULE_NAME}_nudge`,
            `[SYSTEM: Your response is INCOMPLETE without a ---LEDGER--- block at the end. This is mandatory.

After prose, append:
---LEDGER---
> [Day N — HH:MM] OPERATION entity:id key=value -- reason
---END LEDGER---

WHAT TO TRACK every turn — check each, emit if changed:
- Character DOING/WANT/COST updates (SET)
- Constraint pressure or integrity shifts (SET current_pressure / MOVE integrity)
- Collision distance changes (SET distance)
- READS updates when a character's interpretation shifts (READ)
- Noticed details gained or fired (APPEND / REMOVE)
- Key moments worth recording (APPEND key_moments)
- World state changes (SET world_state)
- PC demonstrated traits, reputation, timeline (APPEND / MAP_SET)
- Story summary after major events (APPEND summary)
- Pressure point cleanup — REMOVE fired/stale entries, don't just accumulate
If nothing changed: (empty)]`,
            PROMPT_IN_CHAT, 0);
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
        if (Array.isArray(moments) && moments.length > 15) {
            warnings.push(`${char.name || id} KEY_MOMENTS: ${moments.length} entries — consolidate to most significant.`);
        }
    }
    if (warnings.length === 0) return null;
    return `[LEDGER HYGIENE WARNING — arrays over capacity:\n${warnings.map(w => '  • ' + w).join('\n')}\nUse REMOVE to prune stale entries. Pressure points that fired or resolved are history, not live wires.]`;
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

    const context = SillyTavern.getContext();
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

function handleSetupButton() {
    if (isSetupActive()) {
        cancelSetup();
        showSetupPhase(null);
        toastr.info('Setup cancelled.');
    } else {
        startSetup();
        showSetupPhase(getPhaseLabel());
        injectPrompt();
        insertChatMessage('OOC: Let\'s set up a new game.');
    }
}

function handleAdvanceButton() {
    const pcName = _currentState?.pc?.name || '{{user}}';
    const doing = _currentState?.pc?.doing || 'what they were doing';
    const divSystem = _currentState?.divination?.active_system;

    // Build divination directive if system is active — roll a real random card
    let divDirective = '';
    if (divSystem) {
        const cardNum = Math.floor(Math.random() * 22); // 0-21 Major Arcana
        divDirective = `\nDIVINATION: The ${divSystem} system drew card #${cardNum}. Read the card's meaning from the preset and interpret it for this moment. The draw colors the world's move — it does not prescribe it. Record with SET divination field=last_draw.`;
    }

    // Inject world-advance directive
    _pendingOOCInjection = `[GRAVITY ADVANCE — ${pcName} maintains vector (continues ${doing}). The PC does not act, speak, or change course this turn.

This is the world's turn. You may write MULTIPLE BEATS and CUT between character angles:

STRUCTURE: Write 2-4 short beats, each from a different angle. Use scene cuts:
- Beat 1: What ${pcName} is doing (brief, maintaining vector)
- Beat 2: An NPC in the scene acts on their own WANT — starts a conversation, reacts, decides
- Beat 3: Cut to a different location — a faction leader issues an order, a subordinate executes, a patrol moves
- Beat 4: Cut back — the consequence arrives where the PC is

Use --- or a location/time header to cut between angles. Each beat can be 50-150 words. Not every beat needs the PC.

PICK from Gravity_State_View:
- NPCs act on their WANT or DOING
- Faction leaders command subordinates — show the order AND the execution
- A pressure point cracks
- A collision tightens because the world moved
- A dormant character's WANT pulls them back
${divDirective}
Full turn: deduction + prose + ledger block.]`;

    insertChatMessage(`*${pcName} continues ${doing}.*`);
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

2. THE BUTTERFLY EFFECT: Advance the agendas of ALL off-screen factions, tracked NPCs, and active collisions. The world moves without the player. For each tracked character: advance DOING, check constraints, update stance. For each collision: compress distance. For world: advance factions, world state, pressure points.

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

    injectPrompt();
    insertChatMessage(`OOC: Timeskip — ${duration}`);
}

async function handleChapterCloseButton() {
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

D. ASK THE PLAYER — present choices for the next chapter:
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
   - Check: would any interruption logically occur during the skip?

C. EMIT LEDGER BLOCK:
   - MOVE chapter: OPEN->CLOSING->CLOSED for old chapter
   - CREATE new chapter (number, title, status=OPEN, arc, central_tension, target_collisions)
   - All timeskip advances (SET/MOVE on characters, collisions, world)
   - APPEND summary with chapter summary
   - APPEND pc timeline entries for skip period

D. WRITE the opening of the new chapter — the player lands in the result, not a summary. Full deduction + prose + ledger block.]`;

    injectPrompt();
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
    });

    // Setup wizard phase change callback
    setPhaseCallback((phase) => {
        showSetupPhase(phase > 0 ? getPhaseLabel() : null);
        injectPrompt();
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
        <button class="gl-input-btn" id="gl-input-skip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
        <button class="gl-input-btn" id="gl-input-good" title="Flag good prose — paste exemplar"><i class="fa-solid fa-thumbs-up"></i> Good</button>
    `;
    sendForm.insertBefore(bar, sendForm.firstChild);

    document.getElementById('gl-input-advance').addEventListener('click', handleAdvanceButton);
    document.getElementById('gl-input-skip').addEventListener('click', handleTimeskipButton);
    document.getElementById('gl-input-good').addEventListener('click', handleGoodTurnButton);
}
