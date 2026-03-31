/**
 * ledger-agent.js — Post-generation ledger extraction via DeepSeek.
 *
 * After Opus writes prose, this module:
 * 1. Extracts <!-- GRAVITY: ... --> annotations from the prose
 * 2. Builds a prompt with full state view + ledger readme + prose + annotations
 * 3. Calls DeepSeek API (OpenAI-compatible endpoint)
 * 4. Returns the raw ledger block text for parsing by regex-intercept.js
 *
 * Annotations guide state machine decisions (tier, integrity, collision distance)
 * so DeepSeek doesn't have to infer them from prose alone.
 *
 * On API failure: returns null cleanly — caller falls back to requesting
 * a ledger block from the prose model on the next turn.
 */

// ─── Annotation Extraction ────────────────────────────────────────────────────

// Pattern: <!-- GRAVITY: directive1, directive2 -->  (one or many per response)
const ANNOTATION_PATTERN = /<!--\s*GRAVITY:\s*(.*?)\s*-->/gi;

/**
 * Extract GRAVITY annotations from prose and return cleaned prose.
 *
 * Annotation examples:
 *   <!-- GRAVITY: constraint:c1-detachment STRESSED, char:tifa TRACKED -->
 *   <!-- GRAVITY: collision:rooftop-fight distance=1, pc wounds:shoulder="cut" -->
 *   <!-- GRAVITY: new-char:rufus-shinra "Rufus Shinra", chapter:ch1 CLOSING -->
 *
 * @param {string} prose - Raw Opus output
 * @returns {{ cleanedProse: string, annotations: string[] }}
 */
function extractAnnotations(prose) {
    if (!prose) return { cleanedProse: prose || '', annotations: [] };

    const annotations = [];
    const cleanedProse = prose.replace(ANNOTATION_PATTERN, (_, body) => {
        annotations.push(body.trim());
        return '';
    }).trim();

    return { cleanedProse, annotations };
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────

const DEEPSEEK_SYSTEM_PROMPT = `You are a state machine manager for a narrative tracking system called Gravity Ledger.

You will receive:
1. A prose scene written by another AI model
2. The current world state (entities, relationships, statuses)
3. Author annotations marking what changed (GRAVITY: directives)
4. The ledger command syntax reference

Your job: output ONLY a ---LEDGER--- block capturing every state change implied by the prose and annotations.

RULES:
- Output NOTHING except the ledger block. No prose, no commentary, no explanation, no preamble.
- Annotations are AUTHORITATIVE for state machine transitions. If an annotation says "constraint:c1 STRESSED", emit the MOVE. Do not second-guess it.
- For everything else, extract from the prose: location changes, doing updates, new characters, condition changes, current_scene, timeline entries.
- Update current_scene EVERY turn. 2-3 sentences: where, who's present, what's happening, emotional atmosphere.
- Update pc location and condition EVERY turn.
- Follow command syntax exactly. One command per line starting with >.
- Use entity IDs from the state view. Match existing entities by name — do not invent new IDs for entities already listed.
- For genuinely new entities (mentioned in prose, not in state), create kebab-case IDs.
- Timestamps: extract from prose context or use the most recent timestamp visible.
- If nothing changed (pure dialogue, no state movement): output ---LEDGER---\n(empty)\n---END LEDGER---
- Do not include the deduction block. Do not add commentary. Just the ledger block.`;

/**
 * Build the messages array for the DeepSeek chat completions API.
 *
 * @param {string} prose - Cleaned prose (annotations stripped)
 * @param {string[]} annotations - Extracted GRAVITY annotation strings
 * @param {string} stateView - Full state view with entity IDs
 * @param {string} readme - Ledger quick reference
 * @param {Object} [extras] - Optional context: divinationDraw, turnType, setupContext
 * @returns {Array} OpenAI-format messages array
 */
function buildLedgerPrompt(prose, annotations, stateView, readme, extras = {}) {
    const annotationBlock = annotations.length > 0
        ? annotations.map(a => `  • ${a}`).join('\n')
        : '(none — infer all changes from prose)';

    let userContent = `STATE VIEW:\n${stateView}\n\n`;
    userContent += `COMMAND REFERENCE:\n${readme}\n\n`;
    userContent += `AUTHOR ANNOTATIONS:\n${annotationBlock}\n\n`;

    if (extras.divinationDraw) {
        userContent += `DIVINATION DRAW THIS TURN: ${extras.divinationDraw}\n  Record: SET divination field=last_draw value="[draw result]"\n\n`;
    }

    if (extras.setupContext) {
        userContent += `SETUP CONTEXT:\n${extras.setupContext}\n\n`;
    }

    userContent += `PROSE THIS TURN:\n${prose}\n\nGenerate the ---LEDGER--- block.`;

    return [
        { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];
}

// ─── API Call ─────────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_MODEL = 'deepseek/deepseek-chat';
const TIMEOUT_MS = 30000;

/**
 * Fetch available models from OpenRouter.
 *
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<Array<{id: string, name: string}>>} Sorted model list
 * @throws {Error} On network failure or API error
 */
async function fetchOpenRouterModels(apiKey) {
    const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenRouter models API error ${response.status}: ${errorText.substring(0, 200)}`);
    }
    const data = await response.json();
    return (data?.data || [])
        .map(m => ({ id: m.id, name: m.name || m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Call OpenRouter and return the raw response text.
 *
 * @param {Array} messages - Chat completions messages
 * @param {string} apiKey - OpenRouter API key
 * @param {string} [model] - Model ID
 * @returns {Promise<string>} Raw response text (contains ---LEDGER--- block)
 * @throws {Error} On network failure or API error
 */
async function callDeepSeek(messages, apiKey, model = DEFAULT_MODEL) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.1,
                max_tokens: 2000,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`OpenRouter API error ${response.status}: ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || '';

        if (content.includes('---LEDGER---') && !content.includes('---END LEDGER---')) {
            return content + '\n---END LEDGER---';
        }

        return content;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error(`OpenRouter API timeout after ${TIMEOUT_MS / 1000}s`);
        }
        throw err;
    }
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────

/**
 * Full pipeline: extract annotations → build prompt → call API → return ledger.
 *
 * @param {string} prose - Raw Opus output (may contain GRAVITY annotations)
 * @param {import('./state-compute.js').ComputedState} state - Current computed state
 * @param {Object} options
 * @param {string} options.apiKey - DeepSeek API key
 * @param {string} [options.model] - Model ID (default: 'deepseek-chat')
 * @param {string} [options.turnType] - 'regular'|'advance'|'combat'|'intimacy'|'integration'
 * @param {string} [options.divinationDraw] - Draw result string if applicable
 * @param {string} [options.setupContext] - Setup wizard prompt context if applicable
 * @param {string} options.stateView - Pre-rendered full state view
 * @param {string} options.readme - Ledger command reference text
 * @returns {Promise<{ ledgerText: string, cleanedProse: string, annotations: string[] } | null>}
 *   Returns null on failure (caller handles fallback).
 */
async function generateLedger(prose, state, options) {
    const { apiKey, model, divinationDraw, setupContext, stateView, readme } = options;

    if (!apiKey) {
        console.warn('[LedgerAgent] No OpenRouter API key configured.');
        return null;
    }

    const { cleanedProse, annotations } = extractAnnotations(prose);

    // If Opus somehow included a ledger block anyway, use it directly
    if (prose.includes('---LEDGER---')) {
        console.log('[LedgerAgent] Opus included a ledger block — using it directly, skipping DeepSeek.');
        return { ledgerText: prose, cleanedProse, annotations };
    }

    try {
        const messages = buildLedgerPrompt(
            cleanedProse,
            annotations,
            stateView,
            readme,
            { divinationDraw, setupContext },
        );

        const start = Date.now();
        const ledgerText = await callDeepSeek(messages, apiKey, model || DEFAULT_MODEL);
        const elapsed = Date.now() - start;

        console.log(`[LedgerAgent] OpenRouter responded in ${elapsed}ms. Annotations: ${annotations.length}. Block length: ${ledgerText.length} chars.`);

        return { ledgerText, cleanedProse, annotations };
    } catch (err) {
        console.error('[LedgerAgent] OpenRouter call failed:', err.message);
        return null;
    }
}

/**
 * Get DeepSeek settings from chatMetadata.
 * @returns {{ enabled: boolean, apiKey: string, model: string }}
 */
function getDeepSeekSettings() {
    try {
        const { chatMetadata } = SillyTavern.getContext();
        const ds = chatMetadata?.['gravity_deepseek'] || {};
        return {
            enabled: ds.enabled === true,
            apiKey: ds.apiKey || '',
            model: ds.model || DEFAULT_MODEL,
            models: ds.models || [],
        };
    } catch {
        return { enabled: false, apiKey: '', model: DEFAULT_MODEL, models: [] };
    }
}

/**
 * Save DeepSeek settings to chatMetadata.
 * @param {{ enabled?: boolean, apiKey?: string, model?: string }} updates
 */
async function saveDeepSeekSettings(updates) {
    try {
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        chatMetadata['gravity_deepseek'] = {
            ...(chatMetadata['gravity_deepseek'] || {}),
            ...updates,
        };
        await saveMetadata();
    } catch (e) {
        console.warn('[LedgerAgent] Failed to save DeepSeek settings:', e);
    }
}

// ─── Transaction Summary ──────────────────────────────────────────────────────

/**
 * Produce a short human-readable summary of committed transactions.
 * Shown below the response in the chat after ledger commit.
 *
 * @param {Array} txns - Committed transaction objects
 * @returns {string|null} Summary string, or null if nothing to show
 */
function summarizeTransactions(txns) {
    if (!txns || txns.length === 0) return null;

    const chars = new Set();
    const collisionMoves = [];
    const constraintMoves = [];
    const creates = [];
    let sceneUpdated = false;
    let timelineCount = 0;

    for (const { op, entity, id, field } of txns) {
        if (op === 'READ') continue;

        if ((entity === 'character' || entity === 'pc') && id) {
            chars.add(id);
        }

        if (op === 'M') {
            // MOVE = state machine transition
            if (entity === 'collision' && id) {
                const tx = txns.find(t => t.op === 'M' && t.entity === 'collision' && t.id === id);
                collisionMoves.push(`${id}→${tx?.value ?? '?'}`);
            }
            if (entity === 'constraint' && id) {
                const tx = txns.find(t => t.op === 'M' && t.entity === 'constraint' && t.id === id);
                constraintMoves.push(`${id}→${tx?.value ?? '?'}`);
            }
        }

        if (entity === 'world') {
            if (field === 'current_scene') sceneUpdated = true;
            if (field === 'timeline') timelineCount++;
        }

        if (op === 'C' && id) creates.push(`${entity}:${id}`);
    }

    const parts = [];
    if (chars.size) parts.push([...chars].join(', '));
    if (collisionMoves.length) parts.push(collisionMoves.join(' · '));
    if (constraintMoves.length) parts.push(constraintMoves.join(' · '));
    if (creates.length) parts.push(`new: ${creates.join(', ')}`);
    const worldParts = [];
    if (sceneUpdated) worldParts.push('scene');
    if (timelineCount > 0) worldParts.push(`${timelineCount}× timeline`);
    if (worldParts.length) parts.push(worldParts.join(' · '));

    const header = `${txns.length} tx`;
    return parts.length ? `${header} — ${parts.join(' | ')}` : header;
}

export {
    extractAnnotations,
    buildLedgerPrompt,
    callDeepSeek,
    fetchOpenRouterModels,
    generateLedger,
    getDeepSeekSettings,
    saveDeepSeekSettings,
    summarizeTransactions,
    ANNOTATION_PATTERN,
};
