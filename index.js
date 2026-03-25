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
import { formatStateView, formatReadme, formatCharacterEntry } from './state-view.js';
import { extractLedgerBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';
import { processOOC } from './ooc-handler.js';
import { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase } from './ui-panel.js';
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

            updatePanel(_currentState, _turnCounter);

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

// ─── OOC Command Injections (from UI buttons) ─────────────────────────────────

function injectOOCCommand(text, leadingMessage) {
    _pendingOOCInjection = text;
    injectPrompt();
    // Insert leading message into chat input for the player to send
    const textarea = document.getElementById('send_textarea');
    if (textarea && leadingMessage) {
        textarea.value = leadingMessage;
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
        // Insert leading message into chat input
        const textarea = document.getElementById('send_textarea');
        if (textarea) {
            textarea.value = 'OOC: Let\'s set up a new game.';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.focus();
        }
    }
}

// OOC tool prompts for buttons
const OOC_PROMPTS = {
    preflight: `[OOC: PREFLIGHT — Mid-chapter constraint review]
Enter psychologist voice. Read the current state and audit:
- For each principal constraint: test count, evidence, integrity, direction, projection
- Shedding order: unchanged or revised?
- Collision health: active count, tightening vs stalling
- System check: turns since consolidation, entity registry, timestamps, constants populated
Output the review. Ask if player wants to fix issues or continue.`,

    chapter_close: `[OOC: CHAPTER TRANSITION — Multi-step protocol]
Execute Step 1 this response:
1. Chapter summary (3-5 sentences, key beats, turning point)
2. Author reflection (planned vs actual)
3. Arc check (closer to answered?)
Say "Step 1 complete. Type 'continue' for health check."`,

    timeskip: `[OOC: TIMESKIP]
The player wants to skip ahead. Ask how long, then:
1. Consolidation snapshot
2. Advance the world (characters, constraints, collisions, factions)
3. Health check post-advance
4. Emit advance transactions
5. Write landing scene with full deduction + ledger`,

    archive: `[OOC: ARCHIVE — Consolidation]
Review recent prose for missed ledger transactions. Check for:
- Constraint tests never recorded
- Collision distance changes missed
- READS updates not captured
- Noticed details that fired but weren't removed
Emit catch-up transactions with original timestamps.`,

    eval: `[OOC: FULL SYSTEM EVALUATION]
Deep diagnostic across 5 phases:
1. Read state view + transaction history
2. Hot state integrity (principal, cast, PC, collisions)
3. Cold state integrity (ledger entities)
4. Cross-reference (action-state drift)
5. Structural (data integrity)
Output pass counts, issues, and AMEND transactions for fixes.`,
};

async function handleOOCButton(command) {
    if (command === 'snapshot') {
        // Snapshot runs locally, no LLM needed
        try {
            const snap = await createSnapshot(_currentState, 'Manual snapshot');
            toastr.success(`Snapshot #${snap.id} created.`);
        } catch (err) {
            toastr.error('Snapshot failed: ' + err.message);
        }
        return;
    }

    const LEADING_MESSAGES = {
        preflight: 'OOC: Run a preflight check.',
        chapter_close: 'OOC: Close this chapter.',
        timeskip: 'OOC: Timeskip.',
        archive: 'OOC: Archive and consolidate.',
        eval: 'OOC: Full system evaluation.',
    };

    const prompt = OOC_PROMPTS[command];
    if (prompt) {
        injectOOCCommand(prompt, LEADING_MESSAGES[command] || `OOC: ${command}`);
    }
}

async function handlePromoteButton() {
    const { Popup } = SillyTavern.getContext();
    const name = await Popup.show.input('Promote Character', 'Character name to promote:');
    if (!name) return;
    injectOOCCommand(`[OOC: PROMOTE ${name}]
Promote ${name} from KNOWN to TRACKED (or TRACKED to PRINCIPAL).
1. Draft dossier from chat context (want, doing, cost, 1-2 constraints, reads, noticed details, stance)
2. Present to player for confirmation
3. On confirmation, emit ledger commands for tier change + dossier fields + constraints`,
    `OOC: Promote ${name}.`);
}

async function handleRetireButton() {
    const { Popup } = SillyTavern.getContext();
    const name = await Popup.show.input('Retire Character', 'Character name to retire:');
    if (!name) return;
    injectOOCCommand(`[OOC: RETIRE ${name}]
Retire ${name} to KNOWN tier. Emit tier transition. Dossier goes dormant.`,
    `OOC: Retire ${name}.`);
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
        onOOC: handleOOCButton,
        onPromote: handlePromoteButton,
        onRetire: handleRetireButton,
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

    // Re-inject prompts before generation
    eventSource.on(event_types.GENERATION_STARTED, () => {
        if (_initialized) injectPrompt();
    });

    console.log(`${LOG_PREFIX} Extension registered.`);
    initialize().catch(err => console.error(`${LOG_PREFIX} Init error:`, err));
})();
