// director-client.js
// OpenRouter client for the Gravity director model.
// Browser-side fetch, structured-output enforcement, normalized
// failure modes. Single async function: proposeTransactions(input, config).
//
// Spec: docs/superpowers/specs/2026-04-25-gravity-director-design.md §3.1.

import { buildDirectorSystemPrompt } from './director-prompt.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000;

const TX_RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        transactions: { type: 'array', items: { type: 'object' } },
        notes: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['transactions', 'notes', 'confidence'],
};

/**
 * @param {object} input   director payload (see director-input.js)
 * @param {object} config  { enabled, model, apiKey }
 * @returns {Promise<{ok:true, transactions, notes, confidence, model, durationMs}
 *                 | {ok:false, reason, raw, model?, durationMs?}>}
 */
export async function proposeTransactions(input, config) {
    if (!config || !config.enabled) {
        return { ok: false, reason: 'disabled', raw: 'Director not enabled in settings.' };
    }
    if (!config.apiKey) {
        return { ok: false, reason: 'auth', raw: 'No OpenRouter API key configured.' };
    }
    return callOpenRouter(input, config);
}

async function callOpenRouter(input, config) {
    const t0 = performance.now();
    const body = {
        model: config.model || 'anthropic/claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [
            { role: 'system', content: buildDirectorSystemPrompt() },
            { role: 'user', content: renderUserPrompt(input) },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'commit_transactions',
                strict: true,
                schema: TX_RESPONSE_SCHEMA,
            },
        },
    };

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        res = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey,
                'HTTP-Referer': location.origin || 'http://localhost',
                'X-Title': 'Gravity Director',
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network',
                 raw: e.message, durationMs: performance.now() - t0 };
    }

    const text = await res.text();
    if (!res.ok) {
        const reason = res.status === 401 || res.status === 403 ? 'auth'
                     : res.status === 429 ? 'ratelimit'
                     : 'http_error';
        return { ok: false, reason, raw: `HTTP ${res.status}: ${text.slice(0, 500)}`,
                 durationMs: performance.now() - t0 };
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'invalid_json', raw: text.slice(0, 500),
                          durationMs: performance.now() - t0 }; }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        return { ok: false, reason: 'schema_mismatch', raw: 'No message.content string.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    let out;
    try { out = JSON.parse(content); }
    catch (e) { return { ok: false, reason: 'invalid_json', raw: content.slice(0, 500),
                          model: parsed.model, durationMs: performance.now() - t0 }; }

    if (!Array.isArray(out.transactions)) {
        return { ok: false, reason: 'schema_mismatch', raw: 'transactions field missing or not array.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    return {
        ok: true,
        transactions: out.transactions,
        notes: out.notes || '',
        confidence: out.confidence || 'medium',
        model: parsed.model,
        durationMs: performance.now() - t0,
    };
}

export function renderUserPrompt(input) {
    return [
        `MODE: ${input.mode}${input.deductionType ? ' (' + input.deductionType + ')' : ''}`,
        `REASON_MODE: ${input.reasonMode}`,
        '',
        '=== CURRENT STATE VIEW ===',
        input.stateView,
        '',
        '=== RECENT LEDGER TAIL (last committed txs) ===',
        JSON.stringify(input.recentLedgerTail, null, 2),
        '',
        '=== RECENT TURNS (last 3 user/assistant pairs) ===',
        input.recentTurns.map(t => `USER: ${t.user}\nASSISTANT: ${t.assistant}`).join('\n---\n'),
        '',
        '=== USER MESSAGE THIS TURN ===',
        input.userMessage,
        '',
        '=== ASSISTANT RESPONSE THIS TURN (prose only) ===',
        input.assistantMessage,
        '',
        input.pendingCorrections
            ? '=== PENDING CORRECTIONS (your previous proposed txs were rejected) ===\n' +
              JSON.stringify(input.pendingCorrections, null, 2)
            : '',
        input.lastDirectorFailed
            ? '=== NOTE: last turn the director call FAILED. Be aware of possible unfinished business. ==='
            : '',
        '',
        'Propose the transactions that should commit for THIS turn.',
    ].filter(Boolean).join('\n');
}
