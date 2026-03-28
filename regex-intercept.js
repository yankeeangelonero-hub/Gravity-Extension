/**
 * regex-intercept.js — Command-style ledger block parser.
 *
 * Parses line-based commands from ---LEDGER--- blocks:
 *   > CREATE char:ada-wong name="Ada Wong" tier=KNOWN -- First encounter
 *   > SET char:ada-wong field=doing value="Investigating" -- New action
 *   > MOVE constraint:c1 field=integrity from=STABLE to=STRESSED -- Pressure
 *   > APPEND char:ada-wong field=noticed_details value="Carries a katana" -- Observed
 *   > READ char:ada-wong target=autumn "Unknown variable" -- Initial read
 *   > MAP_DEL char:ada-wong field=reads key=barret -- No longer relevant
 *   > DESTROY char:minor-npc -- Left permanently
 *
 * Each line is independent — partial parsing works naturally.
 */

// ─── Block Extraction ───────────────────────────────────────────────────────────

const LEDGER_BLOCK_PATTERN = /[-—–]{2,3}\s*LEDGER\s*(?:BLOCK)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*LEDGER\s*[-—–]{2,3}/i;

// Deduction block pattern — stripped from chat display (not parsed, just removed)
const DEDUCTION_BLOCK_PATTERN = /[-—–]{2,3}\s*DEDUCTION\s*[-—–]{2,3}[\s\S]*?[-—–]{2,3}\s*END\s*DEDUCTION\s*[-—–]{2,3}/i;

const LEDGER_BLOCK_FALLBACKS = [
    /```ledger\s*\n?([\s\S]*?)```/i,
    /\[LEDGER\]([\s\S]*?)\[\/LEDGER\]/i,
    /<!--\s*LEDGER\s*-->([\s\S]*?)<!--\s*END\s*LEDGER\s*-->/i,
];

// ─── Compliance Tracking ────────────────────────────────────────────────────────

const COMPLIANCE_WINDOW = 10;
let _complianceHistory = [];

function recordCompliance(turn, status) {
    _complianceHistory.push({ turn, status });
    if (_complianceHistory.length > COMPLIANCE_WINDOW) _complianceHistory.shift();
}

function getComplianceScore() {
    if (_complianceHistory.length === 0) return 1;
    const clean = _complianceHistory.filter(e => e.status === 'clean').length;
    return clean / _complianceHistory.length;
}

// ─── Operation Aliases ──────────────────────────────────────────────────────────

const OP_ALIASES = {
    'CREATE': 'CR', 'NEW': 'CR', 'CR': 'CR',
    'SET': 'S', 'S': 'S', 'UPDATE': 'S',
    'MOVE': 'TR', 'TRANSITION': 'TR', 'TR': 'TR', 'TRANS': 'TR',
    'APPEND': 'A', 'ADD': 'A', 'A': 'A', 'NOTE': 'A',
    'REMOVE': 'R', 'R': 'R', 'DELETE_FROM': 'R',
    'READ': 'MS', 'MAP_SET': 'MS', 'MS': 'MS', 'MAPSET': 'MS',
    'MAP_DEL': 'MR', 'MR': 'MR', 'MAPDEL': 'MR', 'UNREAD': 'MR',
    'DESTROY': 'D', 'D': 'D', 'KILL': 'D', 'REMOVE_ENTITY': 'D',
    'AMEND': 'AMEND', 'FIX': 'AMEND', 'CORRECT': 'AMEND',
};

// ─── Line Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a single command line into a transaction object.
 * Format: [timestamp] OP entity_type:entity_id key=value key="multi word" -- reason
 *
 * @param {string} line - Raw line text
 * @param {number} lineNum - Line number for error reporting
 * @returns {{ tx: Object|null, error: string|null, raw: string }}
 */
function parseLine(line, lineNum) {
    const raw = line.trim();

    // Strip leading > or - or *
    let cleaned = raw.replace(/^[>\-\*]\s*/, '').trim();
    if (!cleaned) return { tx: null, error: null, raw }; // Empty line, skip

    // Extract timestamp: [Day N — HH:MM] or [anything in brackets]
    let timestamp = '';
    const tsMatch = cleaned.match(/^\[([^\]]+)\]\s*/);
    if (tsMatch) {
        timestamp = `[${tsMatch[1]}]`;
        cleaned = cleaned.substring(tsMatch[0].length).trim();
    }

    // Extract reason: everything after --
    let reason = '';
    const reasonIdx = cleaned.indexOf(' -- ');
    if (reasonIdx !== -1) {
        reason = cleaned.substring(reasonIdx + 4).trim();
        cleaned = cleaned.substring(0, reasonIdx).trim();
    } else if (cleaned.endsWith('--')) {
        cleaned = cleaned.slice(0, -2).trim();
    }

    // Extract operation (first word)
    const spaceIdx = cleaned.indexOf(' ');
    if (spaceIdx === -1) {
        return { tx: null, error: `Line ${lineNum}: No operation found in "${raw.substring(0, 60)}"`, raw };
    }

    const opRaw = cleaned.substring(0, spaceIdx).toUpperCase();
    const op = OP_ALIASES[opRaw];
    if (!op) {
        return { tx: null, error: `Line ${lineNum}: Unknown operation "${opRaw}"`, raw };
    }

    const rest = cleaned.substring(spaceIdx + 1).trim();

    // Extract entity type:id (first token, may be type:id or just type)
    const entityMatch = rest.match(/^(\w+)(?::(\S+))?\s*/);
    if (!entityMatch) {
        return { tx: null, error: `Line ${lineNum}: No entity found after ${opRaw}`, raw };
    }

    const entityType = entityMatch[1].toLowerCase();
    const entityId = entityMatch[2] || '';
    const kvString = rest.substring(entityMatch[0].length).trim();

    // Parse key=value pairs
    const data = parseKeyValues(kvString);

    // Build transaction object
    const tx = {
        t: timestamp,
        op,
        e: entityType,
        id: entityId,
        d: {},
        r: reason,
    };

    // Map parsed data to transaction d field based on operation
    switch (op) {
        case 'CR':
            tx.d = data;
            break;
        case 'TR':
            tx.d = {
                f: data.field || data.f || '',
                from: data.from || '',
                to: data.to || '',
            };
            break;
        case 'S':
            tx.d = {
                f: data.field || data.f || '',
                v: data.value || data.v || data.val || '',
            };
            break;
        case 'A':
            tx.d = {
                f: data.field || data.f || '',
                v: data.value || data.v || data.val || '',
            };
            break;
        case 'R':
            tx.d = {
                f: data.field || data.f || '',
                v: data.value || data.v || data.val || '',
            };
            break;
        case 'MS':
            tx.d = {
                f: data.field || data.f || '',
                k: data.key || data.k || data.target || '',
                v: data.value || data.v || data.val || '',
            };
            // If there's a bare quoted string at the end, use it as value
            if (!tx.d.v && data._bareValue) {
                tx.d.v = data._bareValue;
            }
            break;
        case 'MR':
            tx.d = {
                f: data.field || data.f || '',
                k: data.key || data.k || data.target || '',
            };
            break;
        case 'D':
            // Destroy needs no data
            break;
        case 'AMEND':
            tx.d = {
                target_tx: parseInt(data.target_tx || data.tx || '0', 10),
                correction: data.correction || '',
                reason: reason || data.reason || '',
            };
            break;
    }

    return { tx, error: null, raw };
}

/**
 * Parse key=value and key="multi word value" pairs from a string.
 * Also handles a bare quoted string at the end (for READ shorthand).
 *
 * @param {string} str
 * @returns {Object} Key-value map
 */
function parseKeyValues(str) {
    const result = {};
    if (!str) return result;

    // Match key=value or key="value with spaces"
    const pattern = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
    let match;
    let lastMatchEnd = 0;

    while ((match = pattern.exec(str)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        result[key] = value;
        lastMatchEnd = match.index + match[0].length;
    }

    // Check for bare quoted string after all key=value pairs (READ shorthand)
    const remaining = str.substring(lastMatchEnd).trim();
    const bareQuote = remaining.match(/^"([^"]*?)"|^'([^']*?)'/);
    if (bareQuote) {
        result._bareValue = bareQuote[1] ?? bareQuote[2] ?? '';
    }

    // Also handle transition shorthand: "STABLE->STRESSED" or "STABLE→STRESSED"
    const arrowMatch = str.match(/(\w+)\s*(?:->|→)\s*(\w+)/);
    if (arrowMatch && !result.from && !result.to) {
        result.from = arrowMatch[1];
        result.to = arrowMatch[2];
    }

    return result;
}

// ─── Block Parser ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExtractionResult
 * @property {boolean} found
 * @property {Array} transactions - Successfully parsed transactions
 * @property {Array} errors - { lineNum, error, raw } for failed lines
 * @property {boolean} drifted
 * @property {string} cleanedMessage
 */

/**
 * Extract and parse the ledger block from an LLM response.
 * @param {string} message
 * @returns {ExtractionResult}
 */
function extractLedgerBlock(message) {
    if (!message) {
        return { found: false, transactions: [], errors: [], drifted: false, cleanedMessage: message || '' };
    }

    // Try primary pattern
    let match = message.match(LEDGER_BLOCK_PATTERN);
    let drifted = false;

    // Try fallbacks
    if (!match) {
        for (const pattern of LEDGER_BLOCK_FALLBACKS) {
            match = message.match(pattern);
            if (match) { drifted = true; break; }
        }
    }

    if (!match) {
        // Still strip deduction block even if no ledger block found
        const cleanedMsg = message.replace(DEDUCTION_BLOCK_PATTERN, '').trim();
        return { found: false, transactions: [], errors: [], drifted: false, cleanedMessage: cleanedMsg };
    }

    const rawContent = match[1].trim();
    // Strip both ledger block and deduction block from displayed message
    let cleanedMessage = message.replace(match[0], '').trim();
    cleanedMessage = cleanedMessage.replace(DEDUCTION_BLOCK_PATTERN, '').trim();

    // Check for format drift
    if (!drifted && match[0]) {
        const standard = /^---LEDGER---[\s\S]*---END LEDGER---$/;
        if (!standard.test(match[0].trim())) drifted = true;
    }

    // Empty block
    if (!rawContent || rawContent === '[]' || rawContent === '(empty)' || rawContent === 'none') {
        return { found: true, transactions: [], errors: [], drifted, cleanedMessage };
    }

    // Check if it's JSON (legacy format) — try to handle gracefully
    if (rawContent.trimStart().startsWith('[') || rawContent.trimStart().startsWith('{')) {
        return parseLegacyJSON(rawContent, drifted, cleanedMessage);
    }

    // Parse command lines
    const lines = rawContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const transactions = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const { tx, error, raw } = parseLine(lines[i], i + 1);
        if (tx) {
            transactions.push(tx);
        } else if (error) {
            errors.push({ lineNum: i + 1, error, raw });
        }
        // null tx + null error = blank line, skip silently
    }

    return { found: true, transactions, errors, drifted, cleanedMessage };
}

/**
 * Handle legacy JSON format for backwards compatibility.
 */
function parseLegacyJSON(rawContent, drifted, cleanedMessage) {
    try {
        let cleaned = rawContent
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/'/g, '"')
            .replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":')
            .replace(/\/\/.*$/gm, '');

        const parsed = JSON.parse(cleaned);
        const transactions = Array.isArray(parsed) ? parsed : [parsed];
        return { found: true, transactions, errors: [], drifted: true, cleanedMessage };
    } catch (e) {
        return {
            found: true, transactions: [], drifted: true, cleanedMessage,
            errors: [{ lineNum: 0, error: `Legacy JSON parse failed: ${e.message}`, raw: rawContent.substring(0, 100) }],
        };
    }
}

// ─── Reinforcement Messages ────────────────────────────────────────────────────

/**
 * Generate reinforcement based on extraction result.
 * @param {ExtractionResult} result
 * @param {number} turn
 * @returns {string|null}
 */
function getReinforcement(result, turn) {
    if (!result.found) {
        recordCompliance(turn, 'missing');
        const score = getComplianceScore();

        if (score < 0.5) {
            return `[LEDGER: Block missing. REQUIRED after every response.\n` +
                `Format: ---LEDGER---\n> CREATE char:name key=value -- reason\n> SET entity:id field=X value=Y -- reason\n---END LEDGER---\n` +
                `Empty turn: ---LEDGER---\n(empty)\n---END LEDGER---]`;
        }
        return `[LEDGER: Block missing. Append ---LEDGER--- ... ---END LEDGER--- after every response.]`;
    }

    if (result.drifted) {
        recordCompliance(turn, 'drifted');
        return `[LEDGER: Processed. Use standard format: ---LEDGER--- (three dashes, caps).]`;
    }

    recordCompliance(turn, 'clean');
    const score = getComplianceScore();
    if (score < 0.8 && _complianceHistory.length > 3) {
        return `[LEDGER: OK.]`;
    }

    return null;
}

/**
 * Build correction injection for failed lines.
 * @param {Array} failedLines - { lineNum, error, raw, attempts }
 * @returns {string|null}
 */
function buildCorrectionInjection(failedLines) {
    if (!failedLines || failedLines.length === 0) return null;

    const lines = [`[LEDGER CORRECTIONS NEEDED — resubmit these lines fixed:`];
    for (const fl of failedLines) {
        lines.push(`  Original: ${fl.raw}`);
        lines.push(`  Error: ${fl.error}`);
        lines.push('');
    }
    lines.push(`Include corrected lines in your next ---LEDGER--- block along with new transactions.]`);
    return lines.join('\n');
}

/**
 * Strip the ledger block from a message for display.
 * @param {string} message
 * @returns {string}
 */
function stripLedgerBlock(message) {
    if (!message) return message;
    let result = message.replace(LEDGER_BLOCK_PATTERN, '');
    for (const pattern of LEDGER_BLOCK_FALLBACKS) {
        result = result.replace(pattern, '');
    }
    return result.trim();
}

export {
    extractLedgerBlock,
    parseLine,
    parseKeyValues,
    getReinforcement,
    buildCorrectionInjection,
    stripLedgerBlock,
    getComplianceScore,
    LEDGER_BLOCK_PATTERN,
};
