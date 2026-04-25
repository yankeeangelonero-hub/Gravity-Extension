/**
 * regex-intercept.js — Command-style ledger block parser.
 *
 * Parses line-based commands from ---LEDGER--- blocks:
 *   > CREATE char:ada-wong name="Ada Wong" tier=KNOWN -- First encounter
 *   > SET char:ada-wong field=agenda value="Investigate the warehouse fire and find the witness" -- Updated agenda
 *   > MOVE constraint:c1 field=integrity from=STABLE to=STRESSED -- Pressure
 *   > APPEND char:ada-wong field=noticed_details value="Carries a katana" -- Observed
 *   > MAP_SET char:ada-wong field=knowledge_asymmetry key=lying_about_alibi value="Claims she was alone" -- New asymmetry
 *   > MAP_DEL char:ada-wong field=knowledge_asymmetry key=lying_about_alibi -- No longer relevant
 *   > DESTROY char:minor-npc -- Left permanently
 *
 * Each line is independent — partial parsing works naturally.
 */

// ─── Block Extraction ───────────────────────────────────────────────────────────

const LEDGER_BLOCK_PATTERN = /[-—–]{2,3}\s*LEDGER\s*(?:BLOCK)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*LEDGER\s*[-—–]{2,3}/i;

// Deduction block pattern — stripped from chat display (not parsed, just removed)
const DEDUCTION_BLOCK_PATTERN = /[-—–]{2,3}\s*DEDUCTION\s*[-—–]{2,3}[\s\S]*?[-—–]{2,3}\s*END\s*DEDUCTION\s*[-—–]{2,3}/i;

const STATE_BLOCK_PATTERN = /[-\u2014\u2013]{2,3}\s*STATE\s*(?:DELTA)?\s*[-\u2014\u2013]{2,3}([\s\S]*?)[-\u2014\u2013]{2,3}\s*END\s*STATE\s*[-\u2014\u2013]{2,3}/i;

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

// Regex that matches any OP_ALIASES key at the start of a line (case-insensitive,
// followed by a word boundary). Used by parseStateLine to route verb-syntax
// lines (including short-form codes like TR, CR, S) to parseLine. Must be
// derived from OP_ALIASES so whitelist can't drift.
const DIRECT_TX_VERB_REGEX = new RegExp(
    '^(' + Object.keys(OP_ALIASES)
        .sort((a, b) => b.length - a.length) // longest-first so MAP_SET matches before MS
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|') + ')\\b',
    'i'
);

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
 * Walk a bracketed array literal starting at str[start] (must be '[').
 * Tracks quote state and bracket depth so quoted/nested commas don't split.
 * Returns { elements, end } where end is the index AFTER the matching ']'.
 * Returns null if no matching ']' is found.
 */
function scanBracketArray(str, start) {
    if (str[start] !== '[') return null;
    let depth = 1;
    let quote = null;
    const elements = [];
    let buf = '';
    let i = start + 1;
    for (; i < str.length; i++) {
        const ch = str[i];
        if (quote) {
            if (ch === '\\' && i + 1 < str.length) {
                buf += ch + str[i + 1];
                i++;
                continue;
            }
            if (ch === quote) quote = null;
            buf += ch;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
            buf += ch;
            continue;
        }
        if (ch === '[') {
            depth++;
            buf += ch;
            continue;
        }
        if (ch === ']') {
            depth--;
            if (depth === 0) {
                const trimmed = buf.trim();
                if (trimmed.length > 0 || elements.length > 0) elements.push(trimmed);
                return { elements, end: i + 1 };
            }
            buf += ch;
            continue;
        }
        if (ch === ',' && depth === 1) {
            elements.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
    }
    return null;
}

function unwrapElement(elem) {
    const t = elem.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\'')))) {
        return t.substring(1, t.length - 1);
    }
    return t;
}

function parseArrayLiteral(str, start) {
    const scan = scanBracketArray(str, start);
    if (!scan) return null;
    // Tolerate trailing comma: ["a", "b",] → ["a", "b"]
    const cleaned = scan.elements.length > 0 && scan.elements[scan.elements.length - 1] === ''
        ? scan.elements.slice(0, -1)
        : scan.elements;
    return { value: cleaned.map(unwrapElement), end: scan.end };
}

/**
 * Parse key=value and key="multi word value" pairs from a string.
 * Also handles a bare quoted string at the end (for READ shorthand) and
 * bracket-array literals (e.g. key=[a, "b, c", char:x]) via a quote/depth-aware
 * scanner — naive split(',') would mangle quoted commas.
 *
 * @param {string} str
 * @returns {Object} Key-value map
 */
function parseKeyValues(str) {
    const result = {};
    if (!str) return result;

    let i = 0;
    let lastEnd = 0;
    while (i < str.length) {
        // Skip whitespace
        while (i < str.length && /\s/.test(str[i])) i++;
        if (i >= str.length) break;

        // Try to match a key= prefix
        const keyMatch = str.slice(i).match(/^(\w+)\s*=\s*/);
        if (!keyMatch) break;

        const key = keyMatch[1].toLowerCase();
        i += keyMatch[0].length;

        if (i >= str.length) {
            result[key] = '';
            lastEnd = i;
            break;
        }

        // Bracket array literal
        if (str[i] === '[') {
            const arr = parseArrayLiteral(str, i);
            if (arr) {
                result[key] = arr.value;
                i = arr.end;
                lastEnd = i;
                continue;
            }
            // Unterminated — fall through to bare-token path
        }

        // Quoted string
        if (str[i] === '"' || str[i] === '\'') {
            const q = str[i];
            let j = i + 1;
            while (j < str.length && str[j] !== q) {
                if (str[j] === '\\' && j + 1 < str.length) j += 2;
                else j++;
            }
            result[key] = str.substring(i + 1, j);
            i = j < str.length ? j + 1 : j;
            lastEnd = i;
            continue;
        }

        // Bare token (whitespace-terminated)
        let j = i;
        while (j < str.length && !/\s/.test(str[j])) j++;
        const token = str.substring(i, j);
        if (token === 'null') result[key] = null;
        else if (token === 'true') result[key] = true;
        else if (token === 'false') result[key] = false;
        else result[key] = token;
        i = j;
        lastEnd = i;
    }

    // Check for bare quoted string after all key=value pairs (READ shorthand)
    const remaining = str.substring(lastEnd).trim();
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

function parseStateScalar(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('[')) {
        const arr = parseArrayLiteral(trimmed, 0);
        if (arr && arr.end === trimmed.length) return arr.value;
    }
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
        return trimmed.substring(1, trimmed.length - 1);
    }
    if (/^(null|\(delete\)|delete)$/i.test(trimmed)) return null;
    if (/^\(empty\)$/i.test(trimmed)) return '';
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

function findStateSeparatorIndex(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if ((ch === '"' || ch === '\'') && text[i - 1] !== '\\') {
            quote = quote === ch ? null : (quote || ch);
            continue;
        }
        if (ch === ':' && !quote) {
            const next = text[i + 1];
            if (next === undefined || /\s/.test(next)) return i;
        }
    }
    return -1;
}

function parseStateLine(line, lineNum) {
    const raw = line.trim();
    let cleaned = raw.replace(/^[>\-\*]\s*/, '').trim();
    if (!cleaned) return { entry: null, error: null, raw };

    if (DIRECT_TX_VERB_REGEX.test(cleaned)) {
        const verbRaw = cleaned.match(/^(\w+)/)?.[1] || '';
        const mappedOp = OP_ALIASES[verbRaw.toUpperCase()];
        if (mappedOp === 'CR') {
            // CREATE is allowed in STATE blocks — route through LEDGER line parser
            const { tx, error } = parseLine(cleaned, lineNum);
            if (tx) return { entry: { kind: 'directTx', tx, raw }, error: null, raw };
            return { entry: null, error: error || `Line ${lineNum}: Failed to parse CREATE line`, raw };
        }
        return {
            entry: null,
            error: `Line ${lineNum}: Verb syntax ("${verbRaw} ...") is not allowed inside ---STATE--- blocks. STATE blocks are compact-only — use dotted-path form (e.g. "collision:id.status: RESOLVED"). Verb syntax (S/TR/A/MS/...) belongs in ---LEDGER--- blocks.`,
            raw,
        };
    }

    const timestampMatch = cleaned.match(/^at\s*:\s*(.+)$/i);
    if (timestampMatch) {
        const value = parseStateScalar(timestampMatch[1]);
        if (typeof value !== 'string' || !value.trim()) {
            return { entry: null, error: `Line ${lineNum}: Invalid block timestamp`, raw };
        }
        return { entry: { kind: 'timestamp', timestamp: value.trim(), raw }, error: null, raw };
    }

    const sceneMatch = cleaned.match(/^scene\s*:\s*(.+)$/i);
    if (sceneMatch) {
        return { entry: { kind: 'scene', value: parseStateScalar(sceneMatch[1]), raw }, error: null, raw };
    }

    const separatorIndex = findStateSeparatorIndex(cleaned);
    if (separatorIndex === -1) {
        // Heuristic: if the line looks like ledger syntax (first word, then
        // entity:id, then one or more key=value pairs), the LLM likely used
        // the wrong grammar. Point them at the dotted-path form explicitly.
        const looksLikeLedgerSyntax = /^\w+\s+\w+:[\w-]+\s+\w+=/.test(cleaned);
        const hint = looksLikeLedgerSyntax
            ? ' — this looks like ledger-block syntax. Inside ---STATE--- blocks, use dotted-path form (e.g. "collision:id.status: RESOLVED"), not verb form ("TR collision:id field=status …"). Verb syntax belongs in ---LEDGER--- blocks.'
            : '';
        return { entry: null, error: `Line ${lineNum}: STATE line must be "path: value"${hint}`, raw };
    }
    let path = cleaned.slice(0, separatorIndex).trim();
    const rawValue = cleaned.slice(separatorIndex + 1);
    let kind = 'set';

    if (path.endsWith('+')) {
        kind = 'append';
        path = path.slice(0, -1).trim();
    } else if (path.endsWith('-')) {
        kind = 'remove';
        path = path.slice(0, -1).trim();
    }

    if (!path) {
        return { entry: null, error: `Line ${lineNum}: Missing STATE path before ":"`, raw };
    }

    const parts = path.split('.').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) {
        return { entry: null, error: `Line ${lineNum}: Invalid STATE path "${path}"`, raw };
    }

    const entityToken = parts[0];
    const entityMatch = entityToken.match(/^(\w+)(?::(.+))?$/);
    if (!entityMatch) {
        return { entry: null, error: `Line ${lineNum}: Invalid entity token "${entityToken}"`, raw };
    }

    const entityType = entityMatch[1].toLowerCase();
    const entityId = entityMatch[2] || '';
    const field = parts[1] || '';
    // Depth-4+ paths (e.g. char:elena.knowledge_asymmetry.knows_apostle,
    // faction:zaft.knowledge_asymmetry.knows_archangel_status) produce a dotted key
    const key = parts.length >= 4 ? parts.slice(2).join('.') : (parts[2] || '');

    if (!field) {
        return { entry: null, error: `Line ${lineNum}: STATE path "${path}" is missing a field`, raw };
    }
    if (parts.length > 5) {
        return { entry: null, error: `Line ${lineNum}: STATE path "${path}" is too deep`, raw };
    }

    return {
        entry: {
            kind,
            entityType,
            entityId,
            field,
            key: key || null,
            value: parseStateScalar(rawValue),
            raw,
        },
        error: null,
        raw,
    };
}

function findBlockCandidate(message, primary, format) {
    const match = message.match(primary);
    if (!match) return null;
    return { format, match, drifted: false, index: match.index ?? 0 };
}

// ─── Block Parser ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExtractionResult
 * @property {boolean} found
 * @property {'ledger'|'state'|null} format
 * @property {Array} transactions - Successfully parsed transactions
 * @property {Array} stateEntries - Parsed compact STATE entries
 * @property {Array} errors - { lineNum, error, raw } for failed lines
 * @property {boolean} drifted
 * @property {string} cleanedMessage
 */

/**
 * Extract and parse the ledger block from an LLM response.
 * @param {string} message
 * @returns {ExtractionResult}
 */
function extractLedgerBlockFromMatch(message, match) {
    const rawContent = match[1].trim();
    let cleanedMessage = message.replace(match[0], '').trim();
    cleanedMessage = cleanedMessage.replace(DEDUCTION_BLOCK_PATTERN, '').trim();

    // Flag non-canonical fences (em-dashes, two-dash forms) so the reinforcement
    // layer can nudge the LLM back to ---LEDGER--- / ---END LEDGER---.
    let drifted = false;
    if (match[0]) {
        const standard = /^---LEDGER---[\s\S]*---END LEDGER---$/;
        if (!standard.test(match[0].trim())) drifted = true;
    }

    if (!rawContent || rawContent === '[]' || rawContent === '(empty)' || rawContent === 'none') {
        return { found: true, format: 'ledger', transactions: [], stateEntries: [], errors: [], drifted, cleanedMessage };
    }

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
    }

    return { found: true, format: 'ledger', transactions, stateEntries: [], errors, drifted, cleanedMessage };
}

function extractStateBlockFromMatch(message, match) {
    const rawContent = match[1].trim();
    let cleanedMessage = message.replace(match[0], '').trim();
    cleanedMessage = cleanedMessage.replace(DEDUCTION_BLOCK_PATTERN, '').trim();

    let drifted = false;
    if (match[0]) {
        const standard = /^---STATE---[\s\S]*---END STATE---$/;
        if (!standard.test(match[0].trim())) drifted = true;
    }

    if (!rawContent || rawContent === '[]' || rawContent === '(empty)' || rawContent === 'none') {
        return { found: true, format: 'state', transactions: [], stateEntries: [], errors: [], drifted, cleanedMessage };
    }

    const lines = rawContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const stateEntries = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const { entry, error, raw } = parseStateLine(lines[i], i + 1);
        if (entry) {
            stateEntries.push(entry);
        } else if (error) {
            errors.push({ lineNum: i + 1, error, raw });
        }
    }

    return { found: true, format: 'state', transactions: [], stateEntries, errors, drifted, cleanedMessage };
}

function extractUpdateBlock(message) {
    if (!message) {
        return { found: false, format: null, transactions: [], stateEntries: [], errors: [], drifted: false, cleanedMessage: message || '' };
    }

    const ledger = findBlockCandidate(message, LEDGER_BLOCK_PATTERN, 'ledger');
    const state = findBlockCandidate(message, STATE_BLOCK_PATTERN, 'state');
    const block = (!ledger && !state)
        ? null
        : (!state || (ledger && ledger.index <= state.index) ? ledger : state);

    if (!block) {
        const cleanedMsg = message.replace(DEDUCTION_BLOCK_PATTERN, '').trim();
        return { found: false, format: null, transactions: [], stateEntries: [], errors: [], drifted: false, cleanedMessage: cleanedMsg };
    }

    if (block.format === 'state') {
        return extractStateBlockFromMatch(message, block.match);
    }
    return extractLedgerBlockFromMatch(message, block.match);
}

function extractLedgerBlock(message) {
    if (!message) {
        return { found: false, format: null, transactions: [], stateEntries: [], errors: [], drifted: false, cleanedMessage: message || '' };
    }

    const block = findBlockCandidate(message, LEDGER_BLOCK_PATTERN, 'ledger');
    if (!block) {
        const cleanedMsg = message.replace(DEDUCTION_BLOCK_PATTERN, '').trim();
        return { found: false, format: null, transactions: [], stateEntries: [], errors: [], drifted: false, cleanedMessage: cleanedMsg };
    }

    return extractLedgerBlockFromMatch(message, block.match);
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
            return `[STATE/LEDGER: Update block missing. REQUIRED after every response.\n` +
                `Normal prose turns (preferred): ---STATE---\nat: [Day N - HH:MM]\nscene: "Where. Who. Atmosphere."\npc.location: "..."\n---END STATE---\n` +
                `Structural turns may still use full ---LEDGER--- ... ---END LEDGER---.]`;
        }
        return `[STATE/LEDGER: Update block missing. Append ---STATE--- ... ---END STATE--- after normal turns, or ---LEDGER--- ... ---END LEDGER--- for structural turns.]`;
    }

    if (result.drifted) {
        recordCompliance(turn, 'drifted');
        if (result.format === 'state') {
            return `[STATE: Processed. Use standard format: ---STATE--- (three dashes, caps).]`;
        }
        return `[LEDGER: Processed. Use standard format: ---LEDGER--- (three dashes, caps).]`;
    }

    recordCompliance(turn, 'clean');
    const score = getComplianceScore();
    if (score < 0.8 && _complianceHistory.length > 3) {
        return `[STATE/LEDGER: OK.]`;
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

    const lines = [`[STATE/LEDGER CORRECTIONS NEEDED — resubmit these lines fixed:`];
    for (const fl of failedLines) {
        lines.push(`  Original: ${fl.raw}`);
        lines.push(`  Error: ${fl.error}${fl.fix ? ' — ' + fl.fix : ''}`);
        lines.push('');
    }
    lines.push(`Include corrected information in your next ---STATE--- or ---LEDGER--- block along with new updates.]`);
    return lines.join('\n');
}

/**
 * Strip the ledger block from a message for display.
 * @param {string} message
 * @returns {string}
 */
function stripLedgerBlock(message) {
    if (!message) return message;
    return message.replace(LEDGER_BLOCK_PATTERN, '').trim();
}

/**
 * Strip both LEDGER and STATE update blocks from a message.
 * Used by the director input pipeline (assistantMessage cleaning,
 * recentTurns cleaning) and display cleaning. Migration chats
 * frequently contain ---STATE--- blocks that stripLedgerBlock misses.
 * @param {string} message
 * @returns {string}
 */
function stripUpdateBlock(message) {
    if (!message) return message;
    return message
        .replace(LEDGER_BLOCK_PATTERN, '')
        .replace(STATE_BLOCK_PATTERN, '')
        .trim();
}

export {
    extractUpdateBlock,
    extractLedgerBlock,
    parseLine,
    parseKeyValues,
    parseStateLine,
    parseStateScalar,
    getReinforcement,
    buildCorrectionInjection,
    stripLedgerBlock,
    stripUpdateBlock,
    getComplianceScore,
    LEDGER_BLOCK_PATTERN,
    STATE_BLOCK_PATTERN,
};
