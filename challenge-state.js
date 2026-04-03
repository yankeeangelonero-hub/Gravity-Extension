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
import {
    clone,
    normalizeText,
    coerceNumber,
    formatDrawBlock,
    boolText,
    mechanicsValue,
} from './challenge-shared.js';
import {
    normalizeCategoryForProfile,
    categoryStepForProfile,
    categoryFromStepForProfile,
    buildDcTable,
    describeDcTable,
    describeSuccessThreshold,
    summarizeDrawForMechanics,
    getRollStateLabel,
    resolveRolledOutcome,
    buildRollPayload,
    buildChallengeRoll,
    formatRollSummary,
} from './challenge-mechanics.js';
import {
    getChallengeCommandBody,
    parseChallengeOptionValue,
    parseChallengeCustomText,
    parseOptionIndexText,
    parseBareIndexText,
    parseChallengeIndexText,
    parseChallengeOptionsFromMessage,
    storeParsedOptions,
    buildInputRecord,
} from './challenge-input.js';

const CHALLENGE_RUNTIME_KEY = 'gravity_challenge_runtime';
const CHALLENGE_SETTINGS_KEY = 'gravity_challenge_settings';
const LEGACY_COMBAT_RUNTIME_KEY = 'gravity_combat_runtime';
const LEGACY_COMBAT_SETTINGS_KEY = 'gravity_combat_settings';

// ─── Utilities ────────────────────────────────────────────────────────────────

function getContext() {
    return SillyTavern.getContext ? SillyTavern.getContext() : {};
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
    const validMode = (known.includes(mode) || mode === 'Custom') ? mode : profile.defaultMode;
    const settings = getChallengeSettings(kind);
    settings.mode = validMode;
    await setChallengeSettings(kind, settings);

    const runtime = getChallengeRuntime();
    if (runtime?.kind === kind && runtime.difficulty_mode !== validMode) {
        await setChallengeRuntime({
            ...runtime,
            difficulty_mode: validMode,
        });
    }
}

async function setChallengeCustomDcs(kind, customDcs) {
    const settings = getChallengeSettings(kind);
    settings.mode = 'Custom';
    settings.custom_dcs = { ...settings.custom_dcs, ...customDcs };
    await setChallengeSettings(kind, settings);

    const runtime = getChallengeRuntime();
    if (runtime?.kind === kind && runtime.difficulty_mode !== 'Custom') {
        await setChallengeRuntime({
            ...runtime,
            difficulty_mode: 'Custom',
        });
    }
}

// ─── Runtime CRUD ─────────────────────────────────────────────────────────────

function normalizeRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object') return null;
    const normalized = clone(runtime) || {};
    if (typeof normalized.locked !== 'boolean') {
        normalized.locked = normalized.phase !== 'cleanup_grace';
    }
    if (normalized.phase === 'setup') {
        normalized.phase = normalized.pending_action?.setup_buffered ? 'setup_buffered' : 'setup_opening';
    }
    if (normalized.phase === 'setup_opening' && normalized.pending_action?.setup_buffered) {
        normalized.phase = 'setup_buffered';
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
        normalized.scene_draw_active = normalized.phase === 'setup_opening' || normalized.phase === 'setup_buffered';
    }
    normalized.option_table_version = Number.isFinite(Number(normalized.option_table_version))
        ? Number(normalized.option_table_version)
        : 0;
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
    const mode = (settings.mode === 'Custom' || profile.thresholdTables[settings.mode])
        ? settings.mode
        : profile.defaultMode;

    // Auto-seed the entity via system transaction
    await autoSeedEntity(profile.entityType, entityId, profile.seedFields);

    const runtime = {
        locked: true,
        kind,
        entity_type: profile.entityType,
        entity_id: entityId,
        phase: 'setup_opening',
        exchange: 1,
        scene_draw: clone(sceneDraw),
        scene_draw_active: true,
        difficulty_mode: mode,
        options: [],
        option_table_version: 0,
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

// ─── Action Builders ──────────────────────────────────────────────────────────

function getOptionByIndex(runtime, index) {
    return (runtime.options || []).find(option => option.index === index) || null;
}

function getOptionById(runtime, id) {
    if (!id) return null;
    return (runtime.options || []).find(option => option.id === id) || null;
}

function resolveSelectedOption(runtime, parsedOption, optionIndex) {
    const hasStoredOptions = Array.isArray(runtime?.options) && runtime.options.length > 0;
    if (parsedOption?.id) {
        const byId = getOptionById(runtime, parsedOption.id);
        if (byId) return byId;
        if (!hasStoredOptions) return parsedOption;
    }
    if (optionIndex != null) {
        const byIndex = getOptionByIndex(runtime, optionIndex);
        if (byIndex) return byIndex;
    }
    return !hasStoredOptions && parsedOption ? parsedOption : null;
}

function getLatestAssistantMessageText() {
    const { chat } = getContext();
    if (!Array.isArray(chat)) return '';
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        if (typeof message.mes === 'string' && message.mes.trim()) {
            return message.mes;
        }
    }
    return '';
}

function recoverOptionsFromLatestAssistant(runtime, profile) {
    if (Array.isArray(runtime?.options) && runtime.options.length) return runtime;
    const latestAssistantMessage = getLatestAssistantMessageText();
    if (!latestAssistantMessage) return runtime;
    const parsedOptions = parseChallengeOptionsFromMessage(latestAssistantMessage, profile);
    return parsedOptions.length ? storeParsedOptions(runtime, parsedOptions) : runtime;
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
    lines.push(`OPTION_ID: ${mechanicsValue(input?.option_id)}`);
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
    lines.push(`ACTION_STATE: ${action ? (action.assessment_only ? 'ASSESSMENT_ONLY' : (runtime?.phase === 'setup_buffered' ? 'BUFFERED' : 'DECLARED')) : 'NONE'}`);
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

    const needsOptions = runtime?.phase === 'awaiting_choice'
        || runtime?.phase === 'setup_opening'
        || runtime?.phase === 'setup_buffered';
    lines.push(`NEXT_OPTIONS_REQUIRED: ${needsOptions ? 'true' : 'false'}`);
    lines.push('[/CHALLENGE_MECHANICS]');
    return lines.join('\n');
}

function buildChallengeTaskBlock(runtime, profile, entity) {
    const action = runtime?.pending_action || null;
    const roll = runtime?.pending_roll || null;
    const setupOpening = runtime?.phase === 'setup_opening';
    const setupBuffered = runtime?.phase === 'setup_buffered';
    const needsAssessment = !!action?.assessment_only;
    const mustResolveBuffered = setupBuffered && !needsAssessment;
    const mustResolveExchange = runtime?.phase === 'awaiting_resolution' || mustResolveBuffered;
    const mustOutputOptions = setupOpening
        || setupBuffered
        || (runtime?.phase === 'awaiting_choice' && (needsAssessment || !(runtime?.options || []).length));
    const outputOptionsIfContinues = runtime?.phase === 'awaiting_resolution' || mustResolveBuffered;
    const optionRange = profile?.optionCount || [3, 4];

    let turnObjective = 'NONE';
    if (setupOpening || setupBuffered) {
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
    lines.push(`MUST_FILL_ENTITY_FIELDS: ${boolText(setupOpening || setupBuffered)}`);
    lines.push(`MUST_ESTABLISH_OPENING: ${boolText(setupOpening || setupBuffered)}`);
    lines.push(`MUST_ASSESS_ACTION_TO_OPTIONS: ${boolText(needsAssessment)}`);
    lines.push(`MUST_NOT_RESOLVE_EXCHANGE: ${boolText(needsAssessment || runtime?.phase === 'awaiting_choice')}`);
    lines.push(`MUST_RESOLVE_BUFFERED_ACTION: ${boolText(mustResolveBuffered)}`);
    lines.push(`MUST_RESOLVE_EXCHANGE: ${boolText(mustResolveExchange)}`);
    lines.push(`MUST_OUTPUT_OPTIONS: ${boolText(mustOutputOptions)}`);
    lines.push(`OPTION_1_CAPTURES_PLAYER_INTENT: ${boolText(needsAssessment)}`);
    lines.push(`OPTION_COUNT: ${optionRange[0]}-${optionRange[1]}`);
    lines.push(`OUTPUT_OPTIONS_IF_CONTINUES: ${boolText(outputOptionsIfContinues)}`);
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
    const dcTable = buildDcTable(mode, profile, settings.custom_dcs);
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
    const settings = getChallengeSettings(profile.kind);
    const dcTable = buildDcTable(runtime.difficulty_mode || settings.mode || profile.defaultMode, profile, settings.custom_dcs);
    let next = clone(runtime);
    const optionText = parseChallengeOptionValue(rawText, '', profile);
    const optionIndex = optionText?.index ?? parseChallengeIndexText(rawText, profile) ?? parseOptionIndexText(rawText) ?? parseBareIndexText(rawText);
    const explicitCustom = parseChallengeCustomText(rawText, profile, {
        allowBare: !!runtime?.locked,
    });

    // ─── Setup phase ──────────────────────────────────────────────────
    if (next.phase === 'setup_opening' || next.phase === 'setup_buffered') {
        if (commandBody === '') {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'ENTER_CHALLENGE',
            });
            await setChallengeRuntime(next);
            return { handled: true, inject: true, deductionType: profile.deductionType };
        }

        if (optionText || optionIndex != null) {
            next = recoverOptionsFromLatestAssistant(next, profile);
            const option = resolveSelectedOption(next, optionText, optionIndex);
            if (!option) {
                next.last_input = buildInputRecord(rawText, profile, {
                    parsed_source: 'UNRESOLVED_OPTION_SELECTION',
                    option_id: optionText?.id || null,
                    option_index: optionText?.index ?? optionIndex ?? null,
                    option_label: optionText?.label || '',
                    intent: optionText?.intent || '',
                    declared_category: optionText?.category || null,
                });
                await setChallengeRuntime(next);
                return { handled: false, deductionType: profile.deductionType };
            }
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'OPTION_SELECTION',
                option_id: option.id || optionText?.id || null,
                option_index: option.index,
                option_label: option.label || option.intent || '',
                intent: option.intent || '',
                declared_category: option.category || null,
            });
            const action = buildOptionAction(option, null, profile, { skipClamp: true });
            next.pending_action = { ...action, setup_buffered: true, baseline_category: null };
            next.phase = 'setup_buffered';
            if (profile.usesD20) {
                next.pending_roll = {
                    ...buildRollPayload(action.effective_category, dcTable, drawFn, profile),
                    baseline: null,
                    setup_buffered: true,
                };
            }
            await setChallengeRuntime(next);
            return { handled: true, inject: true, deductionType: profile.deductionType };
        }

        if (explicitCustom) {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'CUSTOM_DECLARED',
                intent: explicitCustom.intent || '',
                declared_category: explicitCustom.category || null,
            });
            const action = buildCustomAction(explicitCustom.intent, explicitCustom.category, null, profile, { skipChallenge: true });
            next.pending_action = { ...action, setup_buffered: true, baseline_category: null };
            next.phase = 'setup_buffered';
            if (profile.usesD20) {
                next.pending_roll = {
                    ...buildRollPayload(action.effective_category, dcTable, drawFn, profile),
                    baseline: null,
                    setup_buffered: true,
                };
            }
            await setChallengeRuntime(next);
            return { handled: true, inject: true, deductionType: profile.deductionType };
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
        next.phase = 'setup_buffered';
        await setChallengeRuntime(next);
        return { handled: true, inject: true, deductionType: profile.deductionType };
    }

    // ─── Awaiting reassessment ────────────────────────────────────────
    if (next.phase === 'awaiting_reassessment') {
        next = recoverOptionsFromLatestAssistant(next, profile);
        const reassessed = explicitCustom || resolveSelectedOption(next, optionText, optionIndex);
        if (!reassessed) {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'REASSESSMENT_PENDING',
                intent: commandBody != null ? commandBody : normalizeText(rawText),
            });
            await setChallengeRuntime(next);
            return { handled: true, inject: true, deductionType: profile.deductionType };
        }

        next.last_input = explicitCustom
            ? buildInputRecord(rawText, profile, {
                parsed_source: 'CUSTOM_REASSESSMENT',
                intent: explicitCustom.intent || next.pending_action?.intent || '',
                declared_category: explicitCustom.category || null,
            })
            : buildInputRecord(rawText, profile, {
                parsed_source: 'OPTION_REASSESSMENT',
                option_id: reassessed.id || null,
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
        return { handled: true, inject: true, deductionType: profile.deductionType };
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
        return { handled: true, inject: true, deductionType: profile.deductionType };
    }

    if (optionIndex != null) {
        next = recoverOptionsFromLatestAssistant(next, profile);
        const option = resolveSelectedOption(next, optionText, optionIndex);
        if (!option) {
            next.last_input = buildInputRecord(rawText, profile, {
                parsed_source: 'UNRESOLVED_OPTION_SELECTION',
                option_id: optionText?.id || null,
                option_index: optionText?.index ?? optionIndex ?? null,
                option_label: optionText?.label || '',
                intent: optionText?.intent || '',
                declared_category: optionText?.category || null,
            });
            await setChallengeRuntime(next);
            return { handled: false, deductionType: profile.deductionType };
        }

        next.last_input = buildInputRecord(rawText, profile, {
            parsed_source: 'OPTION_SELECTION',
            option_id: option.id || optionText?.id || null,
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
        return { handled: true, inject: true, deductionType: profile.deductionType };
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
        return { handled: true, inject: true, deductionType: profile.deductionType };
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
    return { handled: true, inject: true, deductionType: profile.deductionType };
}

// ─── Post-Turn Processing ─────────────────────────────────────────────────────

async function transitionToCleanupGrace(runtime, profile, destroyed) {
    const next = {
        ...runtime,
        phase: 'cleanup_grace',
        locked: false,
        cleanup_turns_remaining: 1,
        options: [],
        pending_action: null,
        pending_roll: null,
        correction_attempts: 0,
    };
    await setChallengeRuntime(next);
    if (!destroyed) {
        return challengeCorrection(
            `Challenge is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the ${runtime.entity_type} entity.`,
            profile,
        );
    }
    return null;
}

async function maybeRunProfileValidation(profile, runtime, state, committedTxns) {
    if (!profile?.validateTurn) return null;
    const correction = profile.validateTurn(runtime, state, committedTxns);
    if (!correction) return null;

    const next = {
        ...runtime,
        correction_attempts: (runtime.correction_attempts || 0) + 1,
    };
    if (next.correction_attempts < 3) {
        await setChallengeRuntime(next);
        return challengeCorrection(correction, profile);
    }

    next.correction_attempts = 0;
    await setChallengeRuntime(next);
    return null;
}

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
    const isSetupPhase = runtime.phase === 'setup_opening' || runtime.phase === 'setup_buffered';
    if (isSetupPhase) {
        if (!entity) {
            // Preserve any options the model output this turn before correcting
            if (options.length) {
                runtime = storeParsedOptions(runtime, options);
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
                runtime.phase === 'setup_buffered'
                    ? `Setup is incomplete and a player action is waiting. The extension auto-seeded ${runtime.entity_type}:${runtime.entity_id}. Fill its fields now, then resolve the buffered action.`
                    : `The extension auto-seeded ${runtime.entity_type}:${runtime.entity_id}. Fill its fields now before continuing.`,
                profile,
            );
        }

        if (runtime.phase === 'setup_buffered' && runtime.pending_roll) {
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
                return transitionToCleanupGrace(next, profile, destroyed);
            }

            next.phase = 'awaiting_choice';
            next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0);
            next.scene_draw_active = false;
            next.option_table_version = runtime.option_table_version || 0;
            next.options = runtime.options || [];
            next.pending_action = null;
            next.pending_roll = null;
            next.correction_attempts = 0;
            const stored = storeParsedOptions(next, options);
            await setChallengeRuntime(stored);

            if (!options.length) {
                return challengeCorrection(`The buffered setup action resolved, but no next options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
            }
            const validationCorrection = await maybeRunProfileValidation(profile, stored, state, committedTxns);
            if (validationCorrection) return validationCorrection;
            return null;
        }

        if (runtime.phase === 'setup_buffered' && !runtime.pending_roll) {
            // Assessment-only buffered action (no roll for non-d20 profiles or freeform)
            if (!options.length) {
                await setChallengeRuntime(runtime);
                return challengeCorrection(`Setup completed, but the buffered uncategorized action was not turned into options. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
            }
            let next = {
                ...runtime,
                pending_action: null,
                pending_roll: null,
                phase: 'awaiting_choice',
                scene_draw_active: false,
                correction_attempts: 0,
            };
            next = storeParsedOptions(next, options);
            await setChallengeRuntime(next);
            const validationCorrection = await maybeRunProfileValidation(profile, next, state, committedTxns);
            if (validationCorrection) return validationCorrection;
            return null;
        }

        if (!options.length) {
            await setChallengeRuntime(runtime);
            return challengeCorrection(`Challenge is active but no options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }

        let next = {
            ...runtime,
            pending_action: null,
            pending_roll: null,
            phase: 'awaiting_choice',
            scene_draw_active: false,
            correction_attempts: 0,
        };
        next = storeParsedOptions(next, options);
        await setChallengeRuntime(next);
        const validationCorrection = await maybeRunProfileValidation(profile, next, state, committedTxns);
        if (validationCorrection) return validationCorrection;
        return null;
    }

    // ─── Awaiting choice with assessment ──────────────────────────────
    if (runtime.phase === 'awaiting_choice' && runtime.pending_action?.assessment_only) {
        if (!options.length) {
            await setChallengeRuntime(runtime);
            return challengeCorrection(`Challenge is active but the uncategorized action was not assessed into options. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }
        let next = {
            ...runtime,
            pending_action: null,
            pending_roll: null,
            correction_attempts: 0,
        };
        next = storeParsedOptions(next, options);
        await setChallengeRuntime(next);
        const validationCorrection = await maybeRunProfileValidation(profile, next, state, committedTxns);
        if (validationCorrection) return validationCorrection;
        return null;
    }

    // ─── Awaiting choice (normal) ─────────────────────────────────────
    if (runtime.phase === 'awaiting_choice') {
        if (!entity) {
            return challengeCorrection(`Challenge is active but no ${runtime.entity_type} entity exists. The extension auto-seeded it — check if it was destroyed.`, profile);
        }
        if (options.length) {
            runtime = storeParsedOptions({ ...runtime, correction_attempts: 0 }, options);
            await setChallengeRuntime(runtime);
        }
        const validationCorrection = await maybeRunProfileValidation(profile, runtime, state, committedTxns);
        if (validationCorrection) return validationCorrection;
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
            return transitionToCleanupGrace(next, profile, destroyed);
        }

        next.phase = 'awaiting_choice';
        next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0);
        next.pending_action = null;
        next.pending_roll = null;
        const stored = storeParsedOptions(next, options);
        await setChallengeRuntime(stored);

        if (!options.length) {
            return challengeCorrection(`Challenge is active but no options were presented. Output ${optionRange[0]}-${optionRange[1]} clickable options using the exact HTML format.`, profile);
        }
        const validationCorrection = await maybeRunProfileValidation(profile, stored, state, committedTxns);
        if (validationCorrection) return validationCorrection;
        return null;
    }

    // ─── Awaiting reassessment ────────────────────────────────────────
    if (runtime.phase === 'awaiting_reassessment') {
        if (resolved) {
            return transitionToCleanupGrace(runtime, profile, destroyed);
        }
        const validationCorrection = await maybeRunProfileValidation(profile, runtime, state, committedTxns);
        if (validationCorrection) return validationCorrection;
        return null;
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
