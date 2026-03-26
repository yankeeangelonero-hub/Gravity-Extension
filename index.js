/**
 * index.js — Gravity Ledger Extension for SillyTavern
 *
 * State machine and append-only ledger for Gravity v10.
 * Storage: chatMetadata (persistent JSON per chat)
 * Injection: setExtensionPrompt at depth 0
 * Format: Command-style lines with self-correcting feedback loop
 */

import { init as initLedger, reset as resetLedger, append, getAllTransactions, exportData, importData } from './ledger-store.js';
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

        // Permanent nudge — always present at depth 0, every turn
        setExtensionPrompt(`${MODULE_NAME}_nudge`,
            '[SYSTEM: Your response is INCOMPLETE without a ---LEDGER--- block at the end. After your prose, append ---LEDGER--- with one command per line, then ---END LEDGER---. This is mandatory. If nothing changed: ---LEDGER---\n(empty)\n---END LEDGER---]',
            PROMPT_IN_CHAT, 0);
    } catch (err) {
        console.error(`${LOG_PREFIX} Inject failed:`, err);
    }
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

    // Build reinforcement
    _pendingReinforcement = getReinforcement(extraction, _turnCounter);
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
    insertChatMessage(`*${pcName} waits, watching.*`);
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

3. FORMAT: Your response must strictly follow this structure:
   Paragraph 1: THE SUMMARY — The passage of time. What the player did during the skip (routines, projects, rest). Success or failure of their goals. New [Day N] timestamp.
   Paragraph 2: THE WORLD STATE — How factions, NPCs, and background forces changed. What moved while the player wasn't looking.
   Paragraph 3: THE HOOK — A real-time physical transition or interruption that ends the skip. Something demands response NOW.
   Paragraph 4: Hand agency back to the player.

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

    console.log(`${LOG_PREFIX} Extension registered.`);
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
})();
