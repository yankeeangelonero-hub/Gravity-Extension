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
    return { ok: false, reason: 'unimplemented', raw: 'callOpenRouter not yet implemented' };
}

export function renderUserPrompt(input) {
    return '';  // implemented in Task 3.2
}
