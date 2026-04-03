/**
 * challenge-state.js — Generic challenge engine for structured scenes.
 *
 * Owns the per-chat challenge loop stored in chat metadata. The ledger remains
 * the canonical visible record; this module tracks pending actions, rolls,
 * options, and challenge-mode prompt assembly between turns.
 *
 * Domain-specific behavior is delegated to profile objects registered in
 * challenge-profiles.js. The engine owns mechanics; profiles own meaning.
 */

import { append } from './ledger-store.js';
import { getProfile, detectChallengePrefix } from './challenge-profiles.js';

const CHALLENGE_RUNTIME_KEY = 'gravity_challenge_runtime';
const CHALLENGE_SETTINGS_KEY = 'gravity_challenge_settings';
const LEGACY_COMBAT_RUNTIME_KEY = 'gravity_combat_runtime';
const LEGACY_COMBAT_SETTINGS_KEY = 'gravity_combat_settings';

// ─── Utilities ────────────────────────────────────────────────────────────────

function getContext() {
    return SillyTavern.getContext ? SillyTavern.getContext() : {};
}

function clone(value) {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function toList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value)
        .split(',')
        .map(part => normalizeText(part))
        .filter(Boolean);
}

function coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripNarrativeForcing(reading) {
    const text = String(reading || '').replace(/\r\n/g, '\n');
    const marker = 'NARRATIVE FORCING:';
    const idx = text.indexOf(marker);
    return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

function formatDrawBlock(draw, options = {}) {
    if (!draw) return '(none)';
    const reading = options.stripNarrativeForcing
        ? stripNarrativeForcing(draw.reading)
        : String(draw.reading || '');
    const lines = [`${draw.label}: ${reading}`];
    if (options.guidance) lines.push(options.guidance);
    if (options.includeHtml !== false && draw.html) {
        lines.push(`Render this HTML card reveal before prose when appropriate:\n${draw.html}`);
    }
    return lines.join('\n');
}

function boolText(value) {
    return value ? 'true' : 'false';
}

function mechanicsValue(value) {
    if (value == null || value === '') return 'NONE';
    return String(value).replace(/\s+/g, ' ').trim();
}

// ─── Category Arithmetic (profile-parameterized) ──────────────────────────────

function normalizeCategoryForProfile(value, profile) {
    const text = normalizeText(value)
        .toLowerCase()
        .replace(/[()[\]:.,!?]/g, ' ')
        .replace(/\bdifficulty\b/g, ' ')
        .replace(/\bdc\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return null;

    // Exact match (case-insensitive)
    for (const cat of profile.categories) {
        if (cat.toLowerCase() === text) return cat;
    }

    // Combat-specific aliases for backward compatibility
    if (profile.kind === 'combat') {
        if (text === 'likely') return 'Highly likely';
        if (text === 'unlikely') return 'Highly unlikely';
        if (text === 'standard' || text === 'even') return 'Average';
        if (text === 'auto success' || text === 'auto-success') return 'Absolute';
        if (text === 'auto fail' || text === 'auto-fail') return 'Impossible';
    }

    // Auto-success/fail aliases (generic)
    if (text === 'auto success' || text === 'auto-success') return profile.autoSuccess;
    if (text === 'auto fail' || text === 'auto-fail') return profile.autoFail;

    return null;
}

function categoryStepForProfile(category, profile) {
    if (!category || !profile) return null;
    const normalized = normalizeCategoryForProfile(category, profile);
    if (!normalized) return null;
    const idx = profile.categories.indexOf(normalized);
    return idx >= 0 ? idx : null;
}

function categoryFromStepForProfile(step, profile) {
    if (!Number.isFinite(step) || !profile) return null;
    const safe = Math.max(0, Math.min(profile.categories.length - 1, Math.round(step)));
    return profile.categories[safe];
}

// ─── DC / Threshold Helpers ───────────────────────────────────────────────────

function buildDcTable(mode, profile) {
    if (!profile) return {};
    const table = profile.thresholdTables[mode];
    if (table) return clone(table);
    const defaultTable = profile.thresholdTables[profile.defaultMode];
    return defaultTable ? clone(defaultTable) : {};
}

function describeDcTable(table) {
    return Object.entries(table)
        .map(([cat, dc]) => `${cat}=${dc}+`)
        .join(' | ');
}

function describeSuccessThreshold(category, dc, profile) {
    if (!profile) {
        // Fallback for simple cases
        if (dc == null) return 'no threshold';
        return `${dc}+ on d20`;
    }
    const normalized = normalizeCategoryForProfile(category, profile);
    if (!normalized) return 'no threshold';
    if (normalized === profile.autoSuccess) return 'auto-success';
    if (normalized === profile.autoFail) return 'auto-fail';
    return dc != null ? `${dc}+ on d20` : 'no threshold';
}

function summarizeDrawForMechanics(draw) {
    if (!draw) return 'NONE';
    const reading = stripNarrativeForcing(draw.reading).split('\n').map(part => normalizeText(part)).filter(Boolean)[0];
    return normalizeText(reading || draw.label || 'NONE') || 'NONE';
}

function getRollStateLabel(roll) {
    if (!roll) return 'NONE';
    if (roll.challenge_pending) return 'PENDING_REASSESSMENT';
    if (roll.skip) return roll.reason === 'absolute' ? 'AUTO_SUCCESS' : 'AUTO_FAIL';
    return 'ROLLED';
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function getChallengeSettings(kind) {
    const { chatMetadata } = getContext();

    // Try namespaced key first
    const namespaced = chatMetadata?.[CHALLENGE_SETTINGS_KEY];
    if (namespaced && kind && namespaced[kind]) {
        return clone(namespaced[kind]);
    }

    // Legacy combat settings migration
    if (kind === 'combat') {
        const legacy = chatMetadata?.[LEGACY_COMBAT_SETTINGS_KEY];
        if (legacy) {
            return {
                mode: legacy.mode || 'Cinematic',
                custom_dcs: legacy.custom_dcs || {},
            };
        }
    }

    return { mode: null, custom_dcs: {} };
}

async function setChallengeSettings(kind, settings) {
    const { chatMetadata, saveMetadata } = getContext();
    if (!chatMetadata || !kind) return;

    if (!chatMetadata[CHALLENGE_SETTINGS_KEY]) {
        chatMetadata[CHALLENGE_SETTINGS_KEY] = {};
    }
    chatMetadata[CHALLENGE_SETTINGS_KEY][kind] = settings;

    if (saveMetadata) await saveMetadata();
}

async function setChallengeDifficultyMode(kind, mode) {
    const profile = getProfile(kind);
    if (!profile) return;
    const known = Object.keys(profile.thresholdTables);
    const validMode = known.includes(mode) ? mode : profile.defaultMode;
    const settings = getChallengeSettings(kind);
    settings.mode = validMode;
    await setChallengeSettings(kind, settings);
}

async function setChallengeCustomDcs(kind, customDcs) {
    const settings = getChallengeSettings(kind);
    settings.mode = 'Custom';
    settings.custom_dcs = { ...settings.custom_dcs, ...customDcs };
    await setChallengeSettings(kind, settings);
}

// ─── Runtime CRUD ─────────────────────────────────────────────────────────────

function normalizeRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object') return null;
    const normalized = clone(runtime) || {};
    if (typeof normalized.locked !== 'boolean') {
        normalized.locked = normalized.phase !== 'cleanup_grace';
    }
    // Ensure canonical field names
    if (!normalized.entity_type && normalized.kind) {
        const profile = getProfile(normalized.kind);
        if (profile) normalized.entity_type = profile.entityType;
    }
    if (!normalized.entity_id && normalized.combat_id) {
        normalized.entity_id = normalized.combat_id;
    }
    if (normalized.scene_draw_active === undefined) {
        normalized.scene_draw_active = normalized.phase === 'setup';
    }
    return normalized;
}

function getChallengeRuntime() {
    const { chatMetadata } = getContext();

    // Try canonical key first
    const canonical = chatMetadata?.[CHALLENGE_RUNTIME_KEY];
    if (canonical) return normalizeRuntime(canonical);

    // Legacy combat runtime migration
    const legacy = chatMetadata?.[LEGACY_COMBAT_RUNTIME_KEY];
    if (legacy) return normalizeRuntime(legacy);

    return null;
}

async function setChallengeRuntime(runtime) {
    const { chatMetadata, saveMetadata } = getContext();
    if (!chatMetadata) return;
    if (runtime) {
        chatMetadata[CHALLENGE_RUNTIME_KEY] = runtime;
        // Clean up legacy key if migrating
        if (chatMetadata[LEGACY_COMBAT_RUNTIME_KEY]) {
            delete chatMetadata[LEGACY_COMBAT_RUNTIME_KEY];
        }
    } else {
        delete chatMetadata[CHALLENGE_RUNTIME_KEY];
        delete chatMetadata[LEGACY_COMBAT_RUNTIME_KEY];
    }
    if (saveMetadata) await saveMetadata();
}

async function clearChallengeRuntime() {
    await setChallengeRuntime(null);
}

function isChallengeRuntimeActive() {
    return !!getChallengeRuntime();
}

function isChallengeSessionLocked() {
    const runtime = getChallengeRuntime();
    return !!runtime?.locked;
}

function getActiveProfile() {
    const runtime = getChallengeRuntime();
    if (!runtime) return null;
    return getProfile(runtime.kind);
}

function getActiveChallengeDeductionType() {
    const profile = getActiveProfile();
    return profile?.deductionType || null;
}

// ─── Entity Lookup ────────────────────────────────────────────────────────────

function getChallengeEntity(state, runtime = getChallengeRuntime()) {
    if (!runtime?.entity_id || !runtime?.entity_type) return null;
    const collection = getEntityCollection(state, runtime.entity_type);
    return collection?.[runtime.entity_id] || null;
}

function getActiveChallengeEntity(state, entityType) {
    const collection = getEntityCollection(state, entityType);
    return Object.values(collection || {}).find(e => String(e.status || '').toUpperCase() !== 'RESOLVED') || null;
}

function getEntityCollection(state, entityType) {
    if (!state || !entityType) return null;
    const collectionMap = {
        combat: 'combats',
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        chapter: 'chapters',
        faction: 'factions',
    };
    const key = collectionMap[entityType] || entityType;
    return state[key] || null;
}

// ─── Auto-Seeding ─────────────────────────────────────────────────────────────

function makeEntityId(profile) {
    return `${profile.entityType}-${Date.now().toString(36)}`;
}

async function autoSeedEntity(entityType, entityId, seedFields) {
    const tx = {
        op: 'CR',
        e: entityType,
        id: entityId,
        d: { ...seedFields },
        r: 'system:challenge-engine:auto-seed',
    };
    await append([tx]);
}

// ─── Runtime Lifecycle ────────────────────────────────────────────────────────

async function startChallengeRuntime(kind, sceneDraw) {
    const profile = getProfile(kind);
    if (!profile) return null;

    const entityId = makeEntityId(profile);
    const settings = getChallengeSettings(kind);
    const mode = settings.mode && profile.thresholdTables[settings.mode]
        ? settings.mode
        : profile.defaultMode;

    // Auto-seed the entity via system transaction
    await autoSeedEntity(profile.entityType, entityId, profile.seedFields);

    const runtime = {
        locked: true,
        kind,
        entity_type: profile.entityType,
        entity_id: entityId,
        phase: 'setup',
        exchange: 1,
        scene_draw: clone(sceneDraw),
        scene_draw_active: true,
        difficulty_mode: mode,
        options: [],
        pending_action: null,
        pending_roll: null,
        last_resolution: null,
        last_input: null,
        cleanup_turns_remaining: 0,
        correction_attempts: 0,
        profile_state: profile.initProfileState ? profile.initProfileState({}) : {},
    };
    await setChallengeRuntime(runtime);
    return runtime;
}

// ─── Input Parsing ────────────────────────────────────────────────────────────

function getChallengeCommandBody(rawText, profile) {
    const text = decodeHtmlEntities(rawText);
    const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^\\*?${escaped}:\\s*(.*?)\\*?$`, 'i'));
    if (!match) return null;
    return normalizeText(match[1]);
}

function parseChallengeOptionValue(value, label, profile) {
    const text = decodeHtmlEntities(value);
    const escaped = profile.optionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^\\*?${escaped}:\\s*option\\s*\\|\\s*(\\d+)\\s*\\|\\s*([^|]+)\\|\\s*(.+?)\\*?$`, 'i'));
    if (!match) return null;
    const category = normalizeCategoryForProfile(match[2], profile);
    if (!category) return null;
    return {
        index: Number(match[1]),
        category,
        intent: normalizeText(match[3]),
        label: normalizeText(decodeHtmlEntities(label)) || normalizeText(match[3]),
    };
}

function parseChallengeCustomText(rawText, profile) {
    const text = decodeHtmlEntities(rawText);
    const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacy = text.match(new RegExp(`^\\*?${escaped}:\\s*custom\\s*\\|\\s*([^|]+)\\|\\s*(.+?)\\*?$`, 'i'));
    if (legacy) {
        const category = normalizeCategoryForProfile(legacy[1], profile);
        if (!category) return null;
        return { category, intent: normalizeText(legacy[2]) };
    }

    const body = getChallengeCommandBody(rawText, profile);
    if (body == null || !body) return null;
    const match = body.match(/^(.+?)\s+dc(?:\s*[:=-])?\s+(.+?)$/i)
        || body.match(/^(.+?)\s*\|\s*(.+?)$/i)
        || body.match(/^(.+?)\s+\((.+?)\)\s*$/i);
    if (!match) return null;
    const category = normalizeCategoryForProfile(match[2], profile);
    if (!category) return null;
    return { category, intent: normalizeText(match[1]) };
}

function parseOptionIndexText(value) {
    const match = normalizeText(value).match(/^\*?option\s+(\d+)\*?$/i);
    if (!match) return null;
    return Number(match[1]);
}

function parseBareIndexText(value) {
    const match = normalizeText(value).match(/^\*?(\d+)\*?$/);
    if (!match) return null;
    return Number(match[1]);
}

function parseChallengeIndexText(rawText, profile) {
    const body = getChallengeCommandBody(rawText, profile);
    if (body == null || !body) return null;
    const match = body.match(/^(\d+)$/);
    if (!match) return null;
    return Number(match[1]);
}

function parseChallengeOptionsFromMessage(text, profile) {
    const options = [];
    const pattern = /<span[^>]*class="act"[^>]*data-value="([^"]+)"[^>]*>(.*?)<\/span>/gi;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
        const parsed = parseChallengeOptionValue(match[1], match[2], profile);
        if (parsed) options.push(parsed);
    }
    return options.sort((a, b) => a.index - b.index);
}

// ─── Roll Math ────────────────────────────────────────────────────────────────

function buildRoll(drawFn) {
    const d20 = Math.floor(Math.random() * 20) + 1;
    return { d20, draw: clone(drawFn()) };
}

function resolveRolledOutcome(d20, dc, profile) {
    if (!Number.isFinite(d20) || !Number.isFinite(dc)) {
        return { success: null, critical: null, resolution: null };
    }
    const labels = profile?.resultLabels || { success: 'SUCCESS', fail: 'TRANSFORM', critSuccess: 'CRITICAL_SUCCESS', critFail: 'CRITICAL_TRANSFORM' };
    if (d20 === 20) return { success: true, critical: 'success', resolution: labels.critSuccess };
    if (d20 === 1) return { success: false, critical: 'transform', resolution: labels.critFail };
    return d20 >= dc
        ? { success: true, critical: null, resolution: labels.success }
        : { success: false, critical: null, resolution: labels.fail };
}

function buildRollPayload(category, dcTable, drawFn, profile) {
    const normalized = normalizeCategoryForProfile(category, profile);
    if (normalized === profile?.autoSuccess) {
        return { skip: true, reason: 'absolute', category: normalized };
    }
    if (normalized === profile?.autoFail) {
        return { skip: true, reason: 'impossible', category: normalized };
    }
    const base = buildRoll(drawFn);
    const dc = dcTable[normalized];
    const outcome = resolveRolledOutcome(base.d20, dc, profile);
    return {
        category: normalized,
        dc,
        d20: base.d20,
        draw: base.draw,
        success: outcome.success,
        critical: outcome.critical,
        resolution: outcome.resolution,
    };
}

function buildChallengeRoll(drawFn) {
    const base = buildRoll(drawFn);
    return {
        challenge_pending: true,
        d20: base.d20,
        draw: base.draw,
        dc: null,
        category: null,
        success: null,
        critical: base.d20 === 20 ? 'success' : base.d20 === 1 ? 'transform' : null,
        resolution: 'PENDING_REASSESSMENT',
    };
}

// ─── Action Builders ──────────────────────────────────────────────────────────

function getOptionByIndex(runtime, index) {
    return (runtime.options || []).find(option => option.index === index) || null;
}

function buildOptionAction(option, baselineCategory, profile, options = {}) {
    const baselineStep = categoryStepForProfile(baselineCategory, profile);
    const chosenStep = categoryStepForProfile(option.category, profile);
    const maxStep = profile ? profile.categories.length - 1 : 4;
    const effectiveStep = options.skipClamp
        ? chosenStep
        : (chosenStep != null && baselineStep != null
            ? Math.min(chosenStep, Math.min(maxStep, baselineStep + 1))
            : chosenStep);
    const effectiveCategory = categoryFromStepForProfile(effectiveStep, profile);
    return {
        source: 'option',
        option_index: option.index,
        intent: option.intent,
        label: option.label,
        declared_category: option.category,
        effective_category: effectiveCategory,
        baseline_category: baselineCategory,
        clamped: effectiveCategory !== option.category,
        challenge_required: false,
        assessment_only: false,
    };
}

function buildCustomAction(intent, declaredCategory, baselineCategory, profile, options = {}) {
    const baselineStep = categoryStepForProfile(baselineCategory, profile);
    const declaredStep = categoryStepForProfile(declaredCategory, profile);
    const delta = baselineStep == null || declaredStep == null ? 0 : declaredStep - baselineStep;
    const challengeThreshold = profile?.challengeThreshold ?? 2;
    return {
        source: 'custom',
        intent,
        declared_category: declaredCategory,
        effective_category: declaredCategory,
        baseline_category: baselineCategory,
        clamped: false,
        challenge_required: options.skipChallenge ? false : (challengeThreshold != null && delta >= challengeThreshold),
        assessment_only: false,
    };
}

// ─── Input Record ─────────────────────────────────────────────────────────────

function buildInputRecord(rawText, profile, overrides = {}) {
    return {
        raw_message: normalizeText(decodeHtmlEntities(rawText)),
        explicit_prefix: new RegExp(`^\\*?${profile.inputPrefix}:`, 'i').test(String(rawText || '')),
        parsed_source: 'UNKNOWN',
        option_index: null,
        option_label: '',
        intent: '',
        declared_category: null,
        assessment_only: false,
        ...overrides,
    };
}

// ─── Packet Builders ──────────────────────────────────────────────────────────

function buildChallengeInputBlock(runtime, profile) {
    const input = runtime?.last_input || null;
    const lines = ['[CHALLENGE_INPUT]'];
    lines.push(`KIND: ${runtime?.kind || 'unknown'}`);
    lines.push(`HAS_INPUT: ${boolText(!!input)}`);
    lines.push(`PARSED_BY_EXTENSION: true`);
    lines.push(`RAW_MESSAGE: ${mechanicsValue(input?.raw_message)}`);
    lines.push(`EXPLICIT_PREFIX: ${boolText(!!input?.explicit_prefix)}`);
    lines.push(`PARSED_SOURCE: ${mechanicsValue(input?.parsed_source)}`);
    lines.push(`OPTION_INDEX: ${mechanicsValue(input?.option_index)}`);
    lines.push(`OPTION_LABEL: ${mechanicsValue(input?.option_label)}`);
    lines.push(`INTENT: ${mechanicsValue(input?.intent)}`);
    lines.push(`DECLARED_CATEGORY: ${mechanicsValue(input?.declared_category)}`);
    lines.push(`ASSESSMENT_ONLY: ${boolText(!!input?.assessment_only)}`);
    lines.push(`RESOLUTION_REQUEST: ${input?.assessment_only ? 'ASSESS_FIRST' : (input ? 'RESOLVE_IF_ALLOWED' : 'NONE')}`);
    lines.push('[/CHALLENGE_INPUT]');
    return lines.join('\n');
}

function buildChallengeMechanicsBlock(runtime, profile, settings, dcTable, baseline) {
    const action = runtime?.pending_action || null;
    const roll = runtime?.pending_roll || null;
    const outcomeLocked = !!(roll && !action?.assessment_only);
    const lines = ['[CHALLENGE_MECHANICS]'];
    lines.push(`KIND: ${runtime?.kind || 'unknown'}`);
    lines.push('MATH_OWNER: EXTENSION');
    lines.push(`PHASE: ${mechanicsValue(runtime?.phase)}`);
    lines.push(`LOCKED: ${runtime?.locked ? 'true' : 'false'}`);
    lines.push(`ENTITY_TYPE: ${mechanicsValue(runtime?.entity_type)}`);
    lines.push(`ENTITY_ID: ${mechanicsValue(runtime?.entity_id)}`);
    lines.push(`RUNTIME_EXCHANGE: ${mechanicsValue(runtime?.exchange)}`);
    lines.push(`DIFFICULTY_MODE: ${mechanicsValue(runtime?.difficulty_mode || settings?.mode)}`);
    lines.push(`SUCCESS_THRESHOLDS: ${describeDcTable(dcTable)}`);
    lines.push(`SCENE_DRAW_ACTIVE: ${boolText(!!runtime?.scene_draw_active)}`);
    lines.push(`SCENE_DRAW: ${summarizeDrawForMechanics(runtime?.scene_draw)}`);
    lines.push(`ACTION_SOURCE: ${mechanicsValue(action?.source ? String(action.source).toUpperCase() : null)}`);
    lines.push(`ACTION_STATE: ${action ? (action.assessment_only ? 'ASSESSMENT_ONLY' : (action.setup_buffered ? 'BUFFERED' : 'DECLARED')) : 'NONE'}`);
    lines.push(`ACTION_INTENT: ${mechanicsValue(action?.intent)}`);
    lines.push(`DECLARED_CATEGORY: ${mechanicsValue(action?.declared_category)}`);
    lines.push(`BASELINE_CATEGORY: ${mechanicsValue(action?.baseline_category || baseline?.category)}`);
    lines.push(`BASELINE_THRESHOLD: ${mechanicsValue(describeSuccessThreshold(baseline?.category, dcTable[baseline?.category], profile))}`);
    lines.push(`EFFECTIVE_CATEGORY: ${mechanicsValue(action?.effective_category)}`);
    lines.push(`ACTION_THRESHOLD: ${mechanicsValue(describeSuccessThreshold(roll?.category || action?.effective_category, roll?.dc ?? dcTable[action?.effective_category], profile))}`);

    if (profile.usesD20) {
        lines.push(`ROLL_STATE: ${getRollStateLabel(roll)}`);
        lines.push(`RESOLUTION_LOCKED: ${outcomeLocked ? 'true' : 'false'}`);
        lines.push(`SUCCESS_DECIDED_BY_EXTENSION: ${outcomeLocked ? 'true' : 'false'}`);
        lines.push(`D20_RESULT: ${mechanicsValue(roll?.d20)}`);
        lines.push(`RESULT: ${mechanicsValue(roll?.resolution || (roll?.success === true ? 'SUCCESS' : roll?.success === false ? 'TRANSFORM' : null))}`);
        lines.push(`SUCCESS_STATE: ${roll?.success === true ? 'SUCCESS' : roll?.success === false ? 'TRANSFORM' : 'NONE'}`);
        lines.push(`ROLL_DRAW_ROLE: ${roll?.draw ? 'interpretive_only' : 'NONE'}`);
        lines.push(`ROLL_DRAW: ${summarizeDrawForMechanics(roll?.draw)}`);
        lines.push(`RECORD_LAST_DRAW: ${roll?.skip ? 'false' : roll?.draw ? 'true' : 'false'}`);
    } else {
        lines.push('ROLL_STATE: NO_DICE');
        lines.push('SUCCESS_DECIDED_BY_EXTENSION: false');
    }

    lines.push(`NEXT_OPTIONS_REQUIRED: ${runtime?.phase === 'awaiting_choice' || runtime?.phase === 'awaiting_resolution' || (runtime?.phase === 'setup' && !!action) ? 'true' : 'false'}`);
    lines.push('[/CHALLENGE_MECHANICS]');
    return lines.join('\n');
}

function buildChallengeTaskBlock(runtime, profile, entity) {
    const action = runtime?.pending_action || null;
    const roll = runtime?.pending_roll || null;
    const setupBuffered = runtime?.phase === 'setup' && !!action?.setup_buffered;
    const needsAssessment = !!action?.assessment_only;
    const mustResolveBuffered = setupBuffered && !needsAssessment;
    const mustResolveExchange = runtime?.phase === 'awaiting_resolution' || mustResolveBuffered;
    const mustOutputOptions = runtime?.phase === 'setup'
        || (runtime?.phase === 'awaiting_choice' && (needsAssessment || !(runtime?.options || []).length))
        || runtime?.phase === 'awaiting_resolution';
    const optionRange = profile?.optionCount || [3, 4];

    let turnObjective = 'NONE';
    if (runtime?.phase === 'setup') {
        turnObjective = setupBuffered
            ? (needsAssessment ? 'SETUP_AND_ASSESS' : 'SETUP_AND_RESOLVE_BUFFERED_ACTION')
            : 'SETUP_OPENING';
    } else if (runtime?.phase === 'awaiting_choice') {
        turnObjective = needsAssessment ? 'ASSESS_ACTION_TO_OPTIONS' : 'WAIT_FOR_PLAYER_CHOICE';
    } else if (runtime?.phase === 'awaiting_resolution') {
        turnObjective = 'RESOLVE_EXCHANGE';
    } else if (runtime?.phase === 'awaiting_reassessment') {
        turnObjective = 'REASSESS_DIFFICULTY';
    } else if (runtime?.phase === 'cleanup_grace') {
        turnObjective = 'CLEANUP_AND_EXIT';
    }

    const lines = ['[CHALLENGE_TASK]'];
    lines.push(`KIND: ${runtime?.kind || 'unknown'}`);
    lines.push(`TURN_OBJECTIVE: ${turnObjective}`);
    lines.push(`INPUT_MODE: ${runtime?.locked ? 'LOCKED_CHALLENGE' : 'PREFIX_ONLY'}`);
    lines.push(`PLAYER_MESSAGE_IS_CHALLENGE_INPUT: ${boolText(!!runtime?.locked || action?.source === 'custom' || action?.source === 'option')}`);
    lines.push(`MUST_CREATE_ENTITY: false`);
    lines.push(`MUST_FILL_ENTITY_FIELDS: ${boolText(runtime?.phase === 'setup')}`);
    lines.push(`MUST_ESTABLISH_OPENING: ${boolText(runtime?.phase === 'setup')}`);
    lines.push(`MUST_ASSESS_ACTION_TO_OPTIONS: ${boolText(needsAssessment)}`);
    lines.push(`MUST_NOT_RESOLVE_EXCHANGE: ${boolText(needsAssessment || runtime?.phase === 'awaiting_choice')}`);
    lines.push(`MUST_RESOLVE_BUFFERED_ACTION: ${boolText(mustResolveBuffered)}`);
    lines.push(`MUST_RESOLVE_EXCHANGE: ${boolText(mustResolveExchange)}`);
    lines.push(`MUST_OUTPUT_OPTIONS: ${boolText(mustOutputOptions)}`);
    lines.push(`OPTION_1_CAPTURES_PLAYER_INTENT: ${boolText(needsAssessment)}`);
    lines.push(`OPTION_COUNT: ${optionRange[0]}-${optionRange[1]}`);
    lines.push(`OUTPUT_OPTIONS_IF_CONTINUES: ${boolText(runtime?.phase === 'awaiting_resolution' || mustResolveBuffered)}`);
    lines.push(`MUST_PRESERVE_ROLL: ${boolText(runtime?.phase === 'awaiting_reassessment')}`);
    if (profile.usesD20) {
        lines.push(`MUST_RECORD_LAST_DRAW: ${boolText(!!roll?.draw && !roll?.skip && mustResolveExchange)}`);
    }
    lines.push(`MUST_WRITE_LASTING_CONSEQUENCES: ${boolText(runtime?.phase === 'cleanup_grace')}`);
    lines.push(`MUST_DESTROY_ENTITY: ${boolText(runtime?.phase === 'cleanup_grace')}`);
    lines.push(`ALLOW_NEW_OPTIONS: ${boolText(runtime?.phase !== 'cleanup_grace')}`);
    lines.push(`UPDATE_BLOCK_HINT: ${runtime?.phase === 'cleanup_grace' ? 'LEDGER_PREFERRED' : 'STATE_OK_UNLESS_STRUCTURALLY_COMPLEX'}`);
    lines.push('[/CHALLENGE_TASK]');
    return lines.join('\n');
}

// ─── Prompt Building ──────────────────────────────────────────────────────────

function formatActionSummary(action) {
    if (!action) return '(none)';
    const parts = [action.intent || '(no intent)'];
    if (action.declared_category) parts.push(`declared ${action.declared_category}`);
    if (action.effective_category && action.effective_category !== action.declared_category) {
        parts.push(`effective ${action.effective_category}`);
    } else if (action.effective_category) {
        parts.push(action.effective_category);
    }
    if (action.clamped) parts.push('clamped to baseline safety band');
    if (action.challenge_required) parts.push('challenge required');
    if (action.assessment_only) parts.push('assessment only');
    return parts.join(' | ');
}

function formatRollSummary(roll) {
    if (!roll) return '(none)';
    if (roll.skip) {
        return `No roll — ${roll.reason === 'absolute' ? 'auto-success' : 'auto-fail'} (${roll.category})`;
    }
    const parts = [`d20 ${roll.d20}`];
    if (roll.dc != null) parts.push(`target ${roll.dc}+ on d20`);
    if (roll.category) parts.push(roll.category);
    if (roll.resolution) parts.push(roll.resolution);
    else if (roll.success != null) parts.push(roll.success ? 'SUCCESS' : 'TRANSFORM');
    if (roll.critical && !String(roll.resolution || '').startsWith('CRITICAL_')) {
        parts.push(`critical ${roll.critical}`);
    }
    if (roll.challenge_pending) parts.push('awaiting reassessment');
    return parts.join(' | ');
}

function buildPromptOptionsBlock(options) {
    if (!options?.length) return '(none stored)';
    return options
        .map(option => `  ${option.index}. ${option.label || option.intent} [${option.category}]`)
        .join('\n');
}

function buildChallengePrompt(state) {
    const runtime = getChallengeRuntime();
    if (!runtime || !state) return '';

    const profile = getProfile(runtime.kind);
    if (!profile) return '';

    const entity = getChallengeEntity(state, runtime) || getActiveChallengeEntity(state, runtime.entity_type);
    const settings = getChallengeSettings(runtime.kind);
    const mode = runtime.difficulty_mode || settings.mode || profile.defaultMode;
    const dcTable = buildDcTable(mode, profile);
    const baseline = profile.getBaseline(state, entity);

    const lines = [];
    lines.push(buildChallengeInputBlock(runtime, profile));
    lines.push('');
    lines.push(buildChallengeMechanicsBlock(runtime, profile, { mode }, dcTable, baseline));
    lines.push('');
    lines.push(buildChallengeTaskBlock(runtime, profile, entity));
    lines.push('');
    lines.push('Read CHALLENGE_INPUT, CHALLENGE_MECHANICS, and CHALLENGE_TASK first. They are the canonical extension-owned input, facts, math, and obligations for this turn.');
    if (profile.usesD20) {
        lines.push('The extension alone decides challenge math. If SUCCESS_DECIDED_BY_EXTENSION is true, do not judge success or transform yourself. Narrate the injected RESULT.');
    }
    lines.push('');

    // Delegate context tail to profile
    const helpers = {
        formatDrawBlock,
        formatActionSummary,
        formatRollSummary,
        buildPromptOptionsBlock,
        describeSuccessThreshold: (cat, dc) => describeSuccessThreshold(cat, dc, profile),
        describeDcTable,
        dcTable,
    };
    const contextLines = profile.buildContextLines(runtime, entity, state, baseline, helpers);
    lines.push(...contextLines);

    return lines.join('\n');
}

// ─── Main Input Handler ───────────────────────────────────────────────────────

async function handleChallengeActionSelection(rawText, state, drawFn) {
    const detectedProfile = detectChallengePrefix(rawText);
    let runtime = getChallengeRuntime();

    if (!runtime && !detectedProfile) return { handled: false };

    const profile = runtime ? getProfile(runtime.kind) : detectedProfile;
    if (!profile) return { handled: false };

    const commandBody = getChallengeCommandBody(rawText, profile);

    if (!runtime || (!runtime.locked && commandBody != null)) {
        if (commandBody == null) return { handled: false };
        await startChallengeRuntime(profile.kind, drawFn());
        runtime = getChallengeRuntime();
        if (!runtime) return { handled: false };
    }

    const baseline = profile.getBaseline(state, getChallengeEntity(state, runtime));
    const dcTable = buildDcTable(runtime.difficulty_mode || profile.defaultMode, profile);
    const next = clone(runtime);
    const optionText = parseChallengeOptionValue(rawText, '', profile);
    const optionIndex = optionText?.index ?? parseChallengeIndexText(rawText, profile) ?? parseOptionIndexText(rawText) ?? parseBareIndexText(rawText);
    const explicitCustom = parseChallengeCustomText(rawText, profile);

    // ─── Setup phase ──────────────────────────────────────────────────
    if (next.phase === 'setup') {
        if (commandBody === '') {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'ENTER_CHALLENGE',
            });
            await setChallengeRuntime(next);
            return { handled: true, inject: true, kind: profile.kind };
        }

        if (optionText || optionIndex != null) {
            const option = optionText || getOptionByIndex(next, optionIndex);
            if (!option) return { handled: false };
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'OPTION_SELECTION',
                option_index: option.index,
                option_label: option.label || option.intent || '',
                intent: option.intent || '',
                declared_category: option.category || null,
            });
            const action = buildOptionAction(option, null, profile, { skipClamp: true });
            next.pending_action = { ...action, setup_buffered: true, baseline_category: null };
            if (profile.usesD20) {
                next.pending_roll = {
                    ...buildRollPayload(action.effective_category, dcTable, drawFn, profile),
                    baseline: null,
                    setup_buffered: true,
                };
            }
            await setChallengeRuntime(next);
            return { handled: true, inject: true, kind: profile.kind };
        }

        if (explicitCustom) {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'CUSTOM_DECLARED',
                intent: explicitCustom.intent || '',
                declared_category: explicitCustom.category || null,
            });
            const action = buildCustomAction(explicitCustom.intent, explicitCustom.category, null, profile, { skipChallenge: true });
            next.pending_action = { ...action, setup_buffered: true, baseline_category: null };
            if (profile.usesD20) {
                next.pending_roll = {
                    ...buildRollPayload(action.effective_category, dcTable, drawFn, profile),
                    baseline: null,
                    setup_buffered: true,
                };
            }
            await setChallengeRuntime(next);
            return { handled: true, inject: true, kind: profile.kind };
        }

        const setupText = commandBody != null ? commandBody : normalizeText(rawText);
        if (!setupText || /^ooc:/i.test(setupText)) {
            return { handled: false };
        }

        next.last_input = buildInputRecord(rawText, profile, {
            parsed_source: 'FREEFORM_ASSESSMENT',
            intent: setupText,
            assessment_only: true,
        });
        next.pending_action = {
            source: 'custom',
            intent: setupText,
            declared_category: null,
            effective_category: null,
            baseline_category: null,
            clamped: false,
            challenge_required: false,
            assessment_only: true,
            setup_buffered: true,
        };
        next.pending_roll = null;
        await setChallengeRuntime(next);
        return { handled: true, inject: true, kind: profile.kind };
    }

    // ─── Awaiting reassessment ────────────────────────────────────────
    if (next.phase === 'awaiting_reassessment') {
        const reassessed = explicitCustom || optionText || (optionIndex != null ? getOptionByIndex(next, optionIndex) : null);
        if (!reassessed) {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'REASSESSMENT_PENDING',
                intent: commandBody != null ? commandBody : normalizeText(rawText),
            });
            await setChallengeRuntime(next);
            return { handled: true, inject: true, kind: profile.kind };
        }

        next.last_input = explicitCustom
            ? buildInputRecord(rawText, profile, {
                parsed_source: 'CUSTOM_REASSESSMENT',
                intent: explicitCustom.intent || next.pending_action?.intent || '',
                declared_category: explicitCustom.category || null,
            })
            : buildInputRecord(rawText, profile, {
                parsed_source: 'OPTION_REASSESSMENT',
                option_index: reassessed.index,
                option_label: reassessed.label || reassessed.intent || '',
                intent: reassessed.intent || '',
                declared_category: reassessed.category || null,
            });

        const action = explicitCustom
            ? buildCustomAction(explicitCustom.intent || next.pending_action?.intent || '', explicitCustom.category, baseline.category, profile)
            : buildOptionAction(reassessed, baseline.category, profile);

        action.challenge_required = false;
        next.pending_action = action;
        next.phase = 'awaiting_resolution';

        if (action.effective_category === profile.autoSuccess) {
            next.pending_roll = { skip: true, reason: 'absolute', category: profile.autoSuccess, baseline: baseline.category };
        } else if (action.effective_category === profile.autoFail) {
            next.pending_roll = { skip: true, reason: 'impossible', category: profile.autoFail, baseline: baseline.category };
        } else if (next.pending_roll?.skip) {
            next.pending_roll.category = action.effective_category;
        } else {
            next.pending_roll = {
                ...(next.pending_roll || buildChallengeRoll(drawFn)),
                challenge_pending: false,
                category: action.effective_category,
                dc: dcTable[action.effective_category] ?? null,
            };
            const outcome = resolveRolledOutcome(next.pending_roll.d20, next.pending_roll.dc, profile);
            next.pending_roll.success = outcome.success;
            next.pending_roll.critical = outcome.critical || next.pending_roll.critical || null;
            next.pending_roll.resolution = outcome.resolution;
        }

        await setChallengeRuntime(next);
        return { handled: true, inject: true, kind: profile.kind };
    }

    // ─── Not awaiting_choice → bail ───────────────────────────────────
    if (next.phase !== 'awaiting_choice') {
        return { handled: false };
    }

    // ─── Awaiting choice ──────────────────────────────────────────────
    if (commandBody === '') {
        next.last_input = buildInputRecord(rawText, profile, {
            parsed_source: 'REENTER_CHALLENGE',
        });
        await setChallengeRuntime(next);
        return { handled: true, inject: true, kind: profile.kind };
    }

    if (optionIndex != null) {
        const option = optionText || getOptionByIndex(next, optionIndex);
        if (!option) return { handled: false };

        next.last_input = buildInputRecord(rawText, profile, {
            parsed_source: 'OPTION_SELECTION',
            option_index: option.index,
            option_label: option.label || option.intent || '',
            intent: option.intent || '',
            declared_category: option.category || null,
        });
        const action = buildOptionAction(option, baseline.category, profile);

        if (profile.usesD20) {
            const roll = buildRollPayload(action.effective_category, dcTable, drawFn, profile);
            roll.baseline = baseline.category;
            next.pending_action = action;
            next.pending_roll = roll;
        } else {
            next.pending_action = action;
            next.pending_roll = null;
        }
        next.phase = 'awaiting_resolution';
        await setChallengeRuntime(next);
        return { handled: true, inject: true, kind: profile.kind };
    }

    if (explicitCustom) {
        next.last_input = buildInputRecord(rawText, profile, {
            parsed_source: 'CUSTOM_DECLARED',
            intent: explicitCustom.intent || '',
            declared_category: explicitCustom.category || null,
        });
        const action = buildCustomAction(explicitCustom.intent, explicitCustom.category, baseline.category, profile);
        next.pending_action = action;

        if (action.challenge_required && profile.usesD20) {
            next.pending_roll = buildChallengeRoll(drawFn);
            next.pending_roll.baseline = baseline.category;
            next.phase = 'awaiting_reassessment';
        } else if (profile.usesD20) {
            next.pending_roll = buildRollPayload(action.effective_category, dcTable, drawFn, profile);
            next.pending_roll.baseline = baseline.category;
            next.phase = 'awaiting_resolution';
        } else {
            next.pending_roll = null;
            next.phase = 'awaiting_resolution';
        }

        await setChallengeRuntime(next);
        return { handled: true, inject: true, kind: profile.kind };
    }

    const text = commandBody != null ? commandBody : normalizeText(rawText);
    if (!text || /^ooc:/i.test(text)) {
        return { handled: false };
    }

    next.last_input = buildInputRecord(rawText, profile, {
        parsed_source: 'FREEFORM_ASSESSMENT',
        intent: text,
        assessment_only: true,
    });
    next.pending_action = {
        source: 'custom',
        intent: text,
        declared_category: null,
        effective_category: null,
        baseline_category: baseline.category,
        clamped: false,
        challenge_required: false,
        assessment_only: true,
    };
    next.pending_roll = null;
    next.phase = 'awaiting_choice';
    await setChallengeRuntime(next);
    return { handled: true, inject: true, kind: profile.kind };
}

// ─── Post-Turn Processing ─────────────────────────────────────────────────────

function didDestroyChallengeThisTurn(runtime, committedTxns) {
    return (committedTxns || []).some(tx => tx.op === 'D' && tx.e === runtime.entity_type && tx.id === runtime.entity_id);
}

function didRecordDivinationLastDrawThisTurn(committedTxns) {
    return (committedTxns || []).some(tx => {
        if (tx.e !== 'divination') return false;
        const field = String(tx.d?.f || tx.d?.field || '').toLowerCase();
        return field === 'last_draw';
    });
}

function challengeCorrection(message, profile) {
    return `[CHALLENGE RUNTIME — ${profile?.displayName || 'Active'}]\n${message}`;
}

async function processChallengeAssistantTurn(state, committedTxns, messageText) {
    let runtime = getChallengeRuntime();
    if (!runtime) return null;

    const profile = getProfile(runtime.kind);
    if (!profile) return null;

    // Auto-correct entity ID if the model created a different one
    const entityCreates = (committedTxns || []).filter(tx => tx.e === runtime.entity_type && tx.id).map(tx => tx.id);
    const collection = getEntityCollection(state, runtime.entity_type);
    if ((!collection?.[runtime.entity_id]) && entityCreates.length === 1) {
        runtime = { ...runtime, entity_id: entityCreates[0] };
        await setChallengeRuntime(runtime);
    }

    const options = parseChallengeOptionsFromMessage(messageText, profile);
    const destroyed = didDestroyChallengeThisTurn(runtime, committedTxns);
    const resolved = profile.isResolved
        ? profile.isResolved(runtime, getChallengeEntity(state, runtime), state, committedTxns)
        : false;
    const recordedLastDraw = didRecordDivinationLastDrawThisTurn(committedTxns);
    const entity = getChallengeEntity(state, runtime);
    const optionRange = profile.optionCount || [3, 4];

    // ─── cleanup_grace: hard clear ────────────────────────────────────
    if (runtime.phase === 'cleanup_grace') {
        await clearChallengeRuntime();
        return null;
    }

    if (destroyed) {
        await clearChallengeRuntime();
        return null;
    }

    // ─── Setup phase ──────────────────────────────────────────────────
    if (runtime.phase === 'setup') {
        if (!entity) {
            // Auto-seeded entity should exist. If model destroyed it, flag it.
            if (options.length) {
                await setChallengeRuntime({ ...runtime, options });
            }
            runtime.correction_attempts = (runtime.correction_attempts || 0) + 1;
            if (runtime.correction_attempts >= 3) {
                // Force recovery: re-seed and continue
                await autoSeedEntity(runtime.entity_type, runtime.entity_id, profile.seedFields);
                runtime.correction_attempts = 0;
                await setChallengeRuntime(runtime);
                return challengeCorrection(
                    `The extension re-seeded ${runtime.entity_type}:${runtime.entity_id}. Fill its fields now.`,
                    profile,
                );
            }
            await setChallengeRuntime(runtime);
            return challengeCorrection(
                runtime.pending_action?.setup_buffered
                    ? `Setup is incomplete and a player action is waiting. The extension auto-seeded ${runtime.entity_type}:${runtime.entity_id}. Fill its fields now, then resolve the buffered action.`
                    : `The extension auto-seeded ${runtime.entity_type}:${runtime.entity_id}. Fill its fields now before continuing.`,
                profile,
            );
        }

        // Expire scene draw after setup completes
        if (runtime.scene_draw_active) {
            runtime.scene_draw_active = false;
        }

        if (runtime.pending_action?.setup_buffered && runtime.pending_roll) {
            if (profile.usesD20 && !runtime.pending_roll.skip && !recordedLastDraw && !resolved) {
                return challengeCorrection('The buffered setup action had a fixed rolled result, but this turn did not consume it. Resolve that stored action now, use the injected threshold/d20/draw, record divination.last_draw, then offer next options if the challenge continues.', profile);
            }

            const next = {
                ...runtime,
                last_resolution: {
                    exchange: runtime.exchange,
                    action: clone(runtime.pending_action),
                    roll: clone(runtime.pending_roll),
                },
            };

            if (resolved) {
                next.phase = 'cleanup_grace';
                next.locked = false;
                next.cleanup_turns_remaining = 1;
                next.options = [];
                next.pending_action = null;
                next.pending_roll = null;
                next.correction_attempts = 0;
                await setChallengeRuntime(next);
                if (!destroyed) {
                    return challengeCorrection(`Challenge is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the ${runtime.entity_type} entity.`, profile);
                }
                return null;
            }

            next.phase = 'awaiting_choice';
            next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0);
            next.options = options;
            next.pending_action = null;
            next.pending_roll = null;
            next.correction_attempts = 0;
            await setChallengeRuntime(next);

            if (!options.length) {
                return challengeCorrection(`The buffered setup action resolved, but no next options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
            }
            return null;
        }

        if (runtime.pending_action?.setup_buffered && !runtime.pending_roll) {
            // Assessment-only buffered action (no roll for non-d20 profiles or freeform)
            const next = {
                ...runtime,
                options: options.length ? options : runtime.options || [],
                pending_action: null,
                pending_roll: null,
                phase: 'awaiting_choice',
                correction_attempts: 0,
            };
            await setChallengeRuntime(next);
            if (!options.length) {
                return challengeCorrection(`Setup completed, but the buffered uncategorized action was not turned into options. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
            }
            return null;
        }

        if (runtime.pending_action?.assessment_only) {
            const next = {
                ...runtime,
                options: options.length ? options : runtime.options || [],
                pending_action: null,
                pending_roll: null,
                phase: 'awaiting_choice',
                correction_attempts: 0,
            };
            await setChallengeRuntime(next);
            if (!options.length) {
                return challengeCorrection(`Setup completed, but the buffered uncategorized action was not turned into options. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
            }
            return null;
        }

        const next = {
            ...runtime,
            options,
            pending_action: null,
            pending_roll: null,
            phase: 'awaiting_choice',
            correction_attempts: 0,
        };
        await setChallengeRuntime(next);

        if (!options.length) {
            return challengeCorrection(`Challenge is active but no options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }
        return null;
    }

    // ─── Awaiting choice with assessment ──────────────────────────────
    if (runtime.phase === 'awaiting_choice' && runtime.pending_action?.assessment_only) {
        const next = {
            ...runtime,
            options: options.length ? options : runtime.options || [],
            pending_action: null,
            pending_roll: null,
            correction_attempts: 0,
        };
        await setChallengeRuntime(next);
        if (!options.length) {
            return challengeCorrection(`Challenge is active but the uncategorized action was not assessed into options. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }
        return null;
    }

    // ─── Awaiting choice (normal) ─────────────────────────────────────
    if (runtime.phase === 'awaiting_choice') {
        if (!entity) {
            return challengeCorrection(`Challenge is active but no ${runtime.entity_type} entity exists. The extension auto-seeded it — check if it was destroyed.`, profile);
        }
        if (options.length) {
            await setChallengeRuntime({ ...runtime, options, correction_attempts: 0 });
        }
        return null;
    }

    // ─── Awaiting resolution ──────────────────────────────────────────
    if (runtime.phase === 'awaiting_resolution') {
        if (profile.usesD20 && runtime.pending_roll && !runtime.pending_roll.skip && !recordedLastDraw && !resolved) {
            runtime.correction_attempts = (runtime.correction_attempts || 0) + 1;
            if (runtime.correction_attempts >= 3) {
                // Force to cleanup_grace to avoid trapping
                runtime.phase = 'cleanup_grace';
                runtime.locked = false;
                runtime.correction_attempts = 0;
                await setChallengeRuntime(runtime);
                return null;
            }
            await setChallengeRuntime(runtime);
            return challengeCorrection('A fixed rolled result is waiting, but this turn did not consume it. Resolve the stored action now, use the injected threshold/d20/draw, record divination.last_draw, then offer next options if the challenge continues.', profile);
        }

        const next = {
            ...runtime,
            last_resolution: {
                exchange: runtime.exchange,
                action: clone(runtime.pending_action),
                roll: clone(runtime.pending_roll),
            },
            correction_attempts: 0,
        };

        if (resolved) {
            next.phase = 'cleanup_grace';
            next.locked = false;
            next.cleanup_turns_remaining = 1;
            next.options = [];
            next.pending_action = null;
            next.pending_roll = null;
            await setChallengeRuntime(next);
            if (!destroyed) {
                return challengeCorrection(`Challenge is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the ${runtime.entity_type} entity.`, profile);
            }
            return null;
        }

        next.phase = 'awaiting_choice';
        next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0);
        next.options = options;
        next.pending_action = null;
        next.pending_roll = null;
        await setChallengeRuntime(next);

        if (!options.length) {
            return challengeCorrection(`Challenge is active but no options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }
        return null;
    }

    // ─── Awaiting reassessment ────────────────────────────────────────
    if (runtime.phase === 'awaiting_reassessment') {
        if (resolved) {
            const next = {
                ...runtime,
                phase: 'cleanup_grace',
                locked: false,
                cleanup_turns_remaining: 1,
                correction_attempts: 0,
            };
            await setChallengeRuntime(next);
            if (!destroyed) {
                return challengeCorrection(`Challenge is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the ${runtime.entity_type} entity.`, profile);
            }
            return null;
        }
        return null;
    }

    // ─── Profile-specific validation ──────────────────────────────────
    if (profile.validateTurn) {
        const correction = profile.validateTurn(runtime, state, committedTxns);
        if (correction) {
            runtime.correction_attempts = (runtime.correction_attempts || 0) + 1;
            if (runtime.correction_attempts >= 3) {
                runtime.correction_attempts = 0;
                await setChallengeRuntime(runtime);
                return null; // Give up after 3 attempts
            }
            await setChallengeRuntime(runtime);
            return challengeCorrection(correction, profile);
        }
    }

    return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
    CHALLENGE_RUNTIME_KEY,
    CHALLENGE_SETTINGS_KEY,
    getChallengeSettings,
    setChallengeDifficultyMode,
    setChallengeCustomDcs,
    getChallengeRuntime,
    setChallengeRuntime,
    clearChallengeRuntime,
    isChallengeRuntimeActive,
    isChallengeSessionLocked,
    getActiveProfile,
    getActiveChallengeDeductionType,
    startChallengeRuntime,
    getChallengeEntity,
    getActiveChallengeEntity,
    buildChallengePrompt,
    parseChallengeOptionsFromMessage,
    handleChallengeActionSelection,
    processChallengeAssistantTurn,
    formatRollSummary,
    normalizeCategoryForProfile,
    categoryStepForProfile,
    categoryFromStepForProfile,
    buildDcTable,
};
