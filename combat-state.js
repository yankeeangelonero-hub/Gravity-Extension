/**
 * combat-state.js — transient combat runtime and prompt helpers.
 *
 * Owns the per-chat combat loop stored in chat metadata. The ledger remains the
 * canonical visible record; this module tracks pending actions, rolls, options,
 * and combat-mode prompt assembly between turns.
 */

const RUNTIME_KEY = 'gravity_combat_runtime';
const SETTINGS_KEY = 'gravity_combat_settings';

const CATEGORY_ORDER = ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'];
const CATEGORY_STEPS = Object.freeze(Object.fromEntries(CATEGORY_ORDER.map((name, index) => [name, index])));

const DEFAULT_DC_TABLES = Object.freeze({
    Cinematic: Object.freeze({ 'Highly likely': 3, Average: 7, 'Highly unlikely': 12 }),
    Gritty: Object.freeze({ 'Highly likely': 8, Average: 12, 'Highly unlikely': 16 }),
    Heroic: Object.freeze({ 'Highly likely': 2, Average: 5, 'Highly unlikely': 10 }),
    Survival: Object.freeze({ 'Highly likely': 10, Average: 14, 'Highly unlikely': 18 }),
});

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

function defaultSettings() {
    return {
        mode: 'Cinematic',
        custom_dcs: { ...DEFAULT_DC_TABLES.Cinematic },
    };
}

function normalizeMode(mode) {
    const known = ['Cinematic', 'Gritty', 'Heroic', 'Survival', 'Custom'];
    return known.includes(mode) ? mode : 'Cinematic';
}

function normalizeCategory(value) {
    const text = normalizeText(value).toLowerCase();
    if (!text) return null;
    if (text === 'absolute' || text === 'auto success' || text === 'auto-success') return 'Absolute';
    if (text === 'highly likely' || text === 'likely') return 'Highly likely';
    if (text === 'average' || text === 'standard' || text === 'even') return 'Average';
    if (text === 'highly unlikely' || text === 'unlikely') return 'Highly unlikely';
    if (text === 'impossible' || text === 'auto fail' || text === 'auto-fail') return 'Impossible';
    return null;
}

function categoryStep(category) {
    return CATEGORY_STEPS[normalizeCategory(category)] ?? null;
}

function categoryFromStep(step) {
    if (!Number.isFinite(step)) return null;
    const safe = Math.max(0, Math.min(CATEGORY_ORDER.length - 1, Math.round(step)));
    return CATEGORY_ORDER[safe];
}

function buildDcTable(settings = getCombatSettings()) {
    const mode = normalizeMode(settings.mode);
    if (mode !== 'Custom') {
        return clone(DEFAULT_DC_TABLES[mode] || DEFAULT_DC_TABLES.Cinematic);
    }

    const custom = settings.custom_dcs || {};
    return {
        'Highly likely': coerceNumber(custom['Highly likely']) ?? DEFAULT_DC_TABLES.Cinematic['Highly likely'],
        Average: coerceNumber(custom.Average) ?? DEFAULT_DC_TABLES.Cinematic.Average,
        'Highly unlikely': coerceNumber(custom['Highly unlikely']) ?? DEFAULT_DC_TABLES.Cinematic['Highly unlikely'],
    };
}

function describeDcTable(table) {
    return `Highly likely ${table['Highly likely']}+ on d20 | Average ${table.Average}+ on d20 | Highly unlikely ${table['Highly unlikely']}+ on d20`;
}

function describeSuccessThreshold(category, dc) {
    const normalized = normalizeCategory(category);
    if (!normalized) return 'no threshold';
    if (normalized === 'Absolute') return 'auto-success';
    if (normalized === 'Impossible') return 'auto-fail';
    return `${dc}+ on d20`;
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

function getCombatSettings() {
    const { chatMetadata } = getContext();
    const raw = chatMetadata?.[SETTINGS_KEY] || {};
    const defaults = defaultSettings();
    return {
        mode: normalizeMode(raw.mode || defaults.mode),
        custom_dcs: {
            ...defaults.custom_dcs,
            ...(raw.custom_dcs || {}),
        },
    };
}

async function setCombatSettings(nextSettings) {
    const { chatMetadata, saveMetadata } = getContext();
    if (!chatMetadata) return;
    chatMetadata[SETTINGS_KEY] = nextSettings;
    if (saveMetadata) await saveMetadata();
}

async function setCombatDifficultyMode(mode) {
    const settings = getCombatSettings();
    settings.mode = normalizeMode(mode);
    await setCombatSettings(settings);
}

async function setCombatCustomDcs(customDcs) {
    const settings = getCombatSettings();
    settings.mode = 'Custom';
    settings.custom_dcs = {
        ...settings.custom_dcs,
        ...customDcs,
    };
    await setCombatSettings(settings);
}

function getCombatRuntime() {
    const { chatMetadata } = getContext();
    return clone(chatMetadata?.[RUNTIME_KEY] || null);
}

async function setCombatRuntime(runtime) {
    const { chatMetadata, saveMetadata } = getContext();
    if (!chatMetadata) return;
    if (runtime) chatMetadata[RUNTIME_KEY] = runtime;
    else delete chatMetadata[RUNTIME_KEY];
    if (saveMetadata) await saveMetadata();
}

async function clearCombatRuntime() {
    await setCombatRuntime(null);
}

function isCombatRuntimeActive() {
    return !!getCombatRuntime();
}

function isCombatReasonModeActive() {
    const runtime = getCombatRuntime();
    if (!runtime) return false;
    return runtime.phase !== 'cleanup_grace';
}

function makeCombatId() {
    return `combat-${Date.now().toString(36)}`;
}

async function startCombatSetupRuntime(spawnDraw) {
    const settings = getCombatSettings();
    const runtime = {
        combat_id: makeCombatId(),
        phase: 'setup',
        exchange: 1,
        spawn_draw: clone(spawnDraw),
        difficulty_mode: settings.mode,
        options: [],
        pending_action: null,
        pending_roll: null,
        last_resolution: null,
        cleanup_turns_remaining: 0,
    };
    await setCombatRuntime(runtime);
    return runtime;
}

function resolveStateCharacter(state, ref) {
    if (!state || !ref) return null;
    if (ref === 'pc') {
        return {
            entity_type: 'pc',
            id: 'pc',
            name: state.pc?.name || 'PC',
            power: coerceNumber(state.pc?.power),
            power_base: coerceNumber(state.pc?.power_base),
            power_basis: state.pc?.power_basis || '',
            abilities: toList(state.pc?.abilities),
            wounds: state.pc?.wounds || {},
            equipment: state.pc?.equipment || '',
        };
    }

    const key = typeof ref === 'object' ? (ref.id || ref.name || '') : String(ref);
    const byId = state.characters?.[key];
    if (byId) {
        return {
            entity_type: 'char',
            id: byId.id || key,
            name: byId.name || key,
            power: coerceNumber(byId.power),
            power_base: coerceNumber(byId.power_base),
            power_basis: byId.power_basis || '',
            abilities: toList(byId.abilities),
            wounds: byId.wounds || {},
            equipment: byId.equipment || '',
        };
    }

    const lower = key.toLowerCase();
    const byName = Object.values(state.characters || {}).find(char => (char.name || '').toLowerCase() === lower);
    if (!byName) return null;
    return {
        entity_type: 'char',
        id: byName.id || key,
        name: byName.name || key,
        power: coerceNumber(byName.power),
        power_base: coerceNumber(byName.power_base),
        power_basis: byName.power_basis || '',
        abilities: toList(byName.abilities),
        wounds: byName.wounds || {},
        equipment: byName.equipment || '',
    };
}

function resolveCombatantReference(state, ref) {
    if (!ref) return null;
    const resolved = resolveStateCharacter(state, typeof ref === 'object' ? (ref.id || ref.name || '') : ref);
    if (resolved) return resolved;

    if (typeof ref === 'object') {
        return {
            entity_type: 'adhoc',
            id: ref.id || ref.name || '',
            name: ref.name || ref.id || 'Unknown',
            power: coerceNumber(ref.power ?? ref.current_power),
            power_base: coerceNumber(ref.power_base),
            power_basis: ref.power_basis || '',
            abilities: toList(ref.abilities),
            wounds: ref.wounds || {},
            equipment: ref.equipment || '',
        };
    }

    return {
        entity_type: 'adhoc',
        id: String(ref),
        name: String(ref),
        power: coerceNumber(ref),
        power_base: null,
        power_basis: '',
        abilities: [],
        wounds: {},
        equipment: '',
    };
}

function getCombatEntity(state, runtime = getCombatRuntime()) {
    if (!runtime?.combat_id) return null;
    return state?.combats?.[runtime.combat_id] || null;
}

function getActiveCombatEntity(state) {
    return Object.values(state?.combats || {}).find(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED') || null;
}

function getCombatHostiles(combat) {
    if (!combat) return [];
    if (Array.isArray(combat.hostiles)) return combat.hostiles;
    if (Array.isArray(combat.participants)) return combat.participants;
    if (typeof combat.hostiles === 'string') {
        return combat.hostiles.split(',').map(part => normalizeText(part)).filter(Boolean);
    }
    if (typeof combat.participants === 'string') {
        return combat.participants.split(',').map(part => normalizeText(part)).filter(Boolean);
    }
    return [];
}

function getPrimaryOpponent(state, combat) {
    if (!combat) return null;
    if (combat.primary_enemy) {
        const resolved = resolveCombatantReference(state, combat.primary_enemy);
        if (resolved) return resolved;
    }

    const hostiles = getCombatHostiles(combat)
        .map(hostile => resolveCombatantReference(state, hostile))
        .filter(Boolean);

    if (hostiles.length > 0) {
        return hostiles
            .slice()
            .sort((a, b) => (coerceNumber(b.power) ?? -999) - (coerceNumber(a.power) ?? -999))[0];
    }

    const threatPower = coerceNumber(combat.threat_power ?? combat.enemy_power ?? combat.power);
    if (threatPower != null) {
        return {
            entity_type: 'adhoc',
            id: normalizeText(combat.primary_enemy || combat.name || 'hostiles'),
            name: normalizeText(combat.primary_enemy || combat.name || 'Hostile force'),
            power: threatPower,
            power_base: coerceNumber(combat.threat_power_base ?? combat.power_base),
            power_basis: combat.threat || combat.power_basis || '',
            abilities: toList(combat.abilities),
            wounds: {},
            equipment: '',
        };
    }

    return null;
}

function getCombatBaseline(state, runtime = getCombatRuntime(), combat = getCombatEntity(state, runtime)) {
    const pcPower = coerceNumber(state?.pc?.power);
    const primary = getPrimaryOpponent(state, combat);
    const enemyPower = coerceNumber(primary?.power);
    if (pcPower == null || enemyPower == null) {
        return {
            category: 'Average',
            gap: null,
            pc_power: pcPower,
            enemy_power: enemyPower,
            primary_enemy: primary,
        };
    }

    const gap = pcPower - enemyPower;
    let category = 'Average';
    if (gap >= 2) category = 'Absolute';
    else if (gap === 1) category = 'Highly likely';
    else if (gap === -1) category = 'Highly unlikely';
    else if (gap <= -2) category = 'Impossible';

    return {
        category,
        gap,
        pc_power: pcPower,
        enemy_power: enemyPower,
        primary_enemy: primary,
    };
}

function parseCombatOptionValue(value, label = '') {
    const text = decodeHtmlEntities(value);
    const match = text.match(/^\*?combat:\s*option\s*\|\s*(\d+)\s*\|\s*([^|]+)\|\s*(.+?)\*?$/i);
    if (!match) return null;
    const category = normalizeCategory(match[2]);
    if (!category) return null;
    return {
        index: Number(match[1]),
        category,
        intent: normalizeText(match[3]),
        label: normalizeText(decodeHtmlEntities(label)) || normalizeText(match[3]),
    };
}

function getCombatCommandBody(value) {
    const text = decodeHtmlEntities(value);
    const match = text.match(/^\*?combat:\s*(.*?)\*?$/i);
    if (!match) return null;
    return normalizeText(match[1]);
}

function parseCombatCustomText(value) {
    const text = decodeHtmlEntities(value);
    const legacy = text.match(/^\*?combat:\s*custom\s*\|\s*([^|]+)\|\s*(.+?)\*?$/i);
    if (legacy) {
        const category = normalizeCategory(legacy[1]);
        if (!category) return null;
        return {
            category,
            intent: normalizeText(legacy[2]),
        };
    }

    const body = getCombatCommandBody(value);
    if (body == null || !body) return null;
    const match = body.match(/^(.+?)\s+dc\s+(.+?)$/i);
    if (!match) return null;
    const category = normalizeCategory(match[2]);
    if (!category) return null;
    return {
        category,
        intent: normalizeText(match[1]),
    };
}

function parseOptionIndexText(value) {
    const match = normalizeText(value).match(/^\*?option\s+(\d+)\*?$/i);
    if (!match) return null;
    return Number(match[1]);
}

function parseCombatIndexText(value) {
    const body = getCombatCommandBody(value);
    if (body == null || !body) return null;
    const match = body.match(/^(\d+)$/);
    if (!match) return null;
    return Number(match[1]);
}

function parseCombatOptionsFromMessage(text) {
    const options = [];
    const pattern = /<span[^>]*class="act"[^>]*data-value="([^"]+)"[^>]*>(.*?)<\/span>/gi;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
        const parsed = parseCombatOptionValue(match[1], match[2]);
        if (parsed) options.push(parsed);
    }
    return options.sort((a, b) => a.index - b.index);
}

function buildRoll(drawFn) {
    const d20 = Math.floor(Math.random() * 20) + 1;
    return {
        d20,
        draw: clone(drawFn()),
    };
}

function resolveRolledOutcome(d20, dc) {
    if (!Number.isFinite(d20) || !Number.isFinite(dc)) {
        return { success: null, critical: null, resolution: null };
    }
    if (d20 === 20) return { success: true, critical: 'success', resolution: 'CRITICAL_SUCCESS' };
    if (d20 === 1) return { success: false, critical: 'transform', resolution: 'CRITICAL_TRANSFORM' };
    return d20 >= dc
        ? { success: true, critical: null, resolution: 'SUCCESS' }
        : { success: false, critical: null, resolution: 'TRANSFORM' };
}

function buildRollPayload(category, dcTable, drawFn) {
    const normalized = normalizeCategory(category);
    if (normalized === 'Absolute') {
        return { skip: true, reason: 'absolute', category: normalized };
    }
    if (normalized === 'Impossible') {
        return { skip: true, reason: 'impossible', category: normalized };
    }
    const base = buildRoll(drawFn);
    const dc = dcTable[normalized];
    const outcome = resolveRolledOutcome(base.d20, dc);
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

function describeActor(actor) {
    if (!actor) return '(unknown)';
    const parts = [`${actor.name || actor.id || 'Unknown'}`];
    if (actor.power != null) parts.push(`power ${actor.power}`);
    if (actor.power_base != null && actor.power_base !== actor.power) parts.push(`base ${actor.power_base}`);
    if (actor.power_basis) parts.push(`basis: ${actor.power_basis}`);
    if (actor.abilities?.length) parts.push(`abilities: ${actor.abilities.join(' | ')}`);
    if (actor.equipment) parts.push(`equipment: ${actor.equipment}`);
    const wounds = actor.wounds && typeof actor.wounds === 'object' ? Object.entries(actor.wounds) : [];
    if (wounds.length) parts.push(`wounds: ${wounds.map(([key, val]) => `${key}: ${val}`).join(', ')}`);
    return parts.join(' | ');
}

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
    if (roll.dc != null) parts.push(`target ${describeSuccessThreshold(roll.category, roll.dc)}`);
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

function buildCombatPrompt(state) {
    const runtime = getCombatRuntime();
    if (!runtime || !state) return '';

    const combat = getCombatEntity(state, runtime) || getActiveCombatEntity(state);
    const settings = getCombatSettings();
    const dcTable = buildDcTable(settings);
    const baseline = getCombatBaseline(state, runtime, combat);
    const pcActor = resolveStateCharacter(state, 'pc');
    const primaryEnemy = baseline.primary_enemy;
    const hostiles = getCombatHostiles(combat)
        .map(hostile => resolveCombatantReference(state, hostile))
        .filter(Boolean);

    const lines = [];
    lines.push(`Combat runtime is active for combat:${runtime.combat_id}.`);
    lines.push(`Phase: ${runtime.phase}`);
    lines.push(`Runtime exchange: ${runtime.exchange}`);
    lines.push(`Difficulty mode: ${settings.mode}`);
    lines.push(`Success thresholds: ${describeDcTable(dcTable)}`);
    lines.push(`Spawn draw:\n${formatDrawBlock(runtime.spawn_draw, {
        stripNarrativeForcing: true,
        guidance: 'Combat setup usage: use this draw to highlight the encounter circumstance, visible leverage, spacing, terrain, initiative, exposure, and why the opening options sit at their assessed categories. It reveals the shape and pressure of the encounter; it does not force a separate event or resolve the exchange by itself.',
    })}`);
    lines.push('');
    lines.push('PLAYER COMBAT PROFILE');
    lines.push(`  ${describeActor(pcActor)}`);
    if (combat) {
        lines.push('');
        lines.push(`COMBAT ENTITY (${combat.id || runtime.combat_id})`);
        if (combat.status) lines.push(`  Status: ${combat.status}`);
        if (combat.exchange != null) lines.push(`  Ledger exchange: ${combat.exchange}`);
        if (combat.situation) lines.push(`  Situation: ${combat.situation}`);
        if (combat.terrain) lines.push(`  Terrain: ${combat.terrain}`);
        if (combat.threat) lines.push(`  Threat: ${combat.threat}`);
        if (combat.participants) lines.push(`  Participants: ${Array.isArray(combat.participants) ? combat.participants.join(', ') : combat.participants}`);
        if (combat.hostiles) lines.push(`  Hostiles: ${Array.isArray(combat.hostiles) ? combat.hostiles.join(', ') : combat.hostiles}`);
        if (combat.primary_enemy) lines.push(`  Primary enemy field: ${typeof combat.primary_enemy === 'object' ? JSON.stringify(combat.primary_enemy) : combat.primary_enemy}`);
    } else {
        lines.push('');
        lines.push('No combat entity exists yet. Create it this turn before continuing.');
    }

    lines.push('');
    lines.push(`BASELINE: ${baseline.category}${baseline.gap != null ? ` | power gap ${baseline.gap} (PC ${baseline.pc_power} vs enemy ${baseline.enemy_power})` : ''}${baseline.category === 'Highly likely' || baseline.category === 'Average' || baseline.category === 'Highly unlikely' ? ` | threshold ${describeSuccessThreshold(baseline.category, dcTable[baseline.category])}` : ''}`);
    lines.push(`PRIMARY OPPONENT: ${describeActor(primaryEnemy)}`);
    if (hostiles.length) {
        lines.push('HOSTILES:');
        for (const hostile of hostiles) {
            lines.push(`  - ${describeActor(hostile)}`);
        }
    }

    lines.push('');
    lines.push('STORED OPTIONS');
    lines.push(buildPromptOptionsBlock(runtime.options));

    if (runtime.pending_action) {
        lines.push('');
        lines.push(`PENDING ACTION: ${formatActionSummary(runtime.pending_action)}`);
    }
    if (runtime.pending_roll) {
        lines.push(`PENDING ROLL: ${formatRollSummary(runtime.pending_roll)}`);
        if (!runtime.pending_roll.skip) {
            lines.push(`MECHANICAL RESULT: category ${runtime.pending_roll.category || '?'} | threshold ${describeSuccessThreshold(runtime.pending_roll.category, runtime.pending_roll.dc)} | rolled ${runtime.pending_roll.d20} => ${runtime.pending_roll.resolution || (runtime.pending_roll.success ? 'SUCCESS' : 'TRANSFORM')}`);
            lines.push('These are compressed success thresholds, not open-ended narrative difficulty labels. Only the d20 is compared to the threshold. The draw card/hexagram/dice table result is interpretive context, not the mechanical roll total.');
        }
        if (runtime.pending_roll.draw) {
            lines.push(`ROLL DRAW:\n${formatDrawBlock(runtime.pending_roll.draw, {
                stripNarrativeForcing: true,
                guidance: 'Combat resolution usage: this draw colors the already-determined exchange result. It does not replace the d20/threshold result or force a separate twist unrelated to the action. Never compare the draw number to the threshold.',
            })}`);
        }
    }
    if (runtime.last_resolution) {
        lines.push('');
        lines.push(`LAST RESOLUTION: exchange ${runtime.last_resolution.exchange} | ${formatActionSummary(runtime.last_resolution.action)}`);
        lines.push(`LAST ROLL: ${formatRollSummary(runtime.last_resolution.roll)}`);
    }

    lines.push('');
    lines.push('OPTION HTML — when combat is waiting for a player choice, output 3-4 clickable options in exactly this format:');
    lines.push('<span class="act" data-value="combat: option | 1 | Highly likely | Break left through the gap and take the nearest rifle offline">1. Break left through the gap (Highly likely)</span>');
    lines.push('The player may answer with `combat:2` to pick option 2, or `combat: Break left through the gap and take the nearest rifle offline DC Highly likely` for a declared custom action.');

    switch (runtime.phase) {
        case 'setup':
            lines.push('');
            lines.push('PHASE INSTRUCTION: SETUP');
            if (runtime.pending_action?.setup_buffered) {
                lines.push('Setup is incomplete, but the player already committed to an action while the combat entity was still missing or setup had not advanced.');
                lines.push(`First create combat:${runtime.combat_id} and establish participants, hostiles, primary_enemy, terrain, situation, threat, and exchange.`);
                lines.push('Then immediately resolve the buffered player action this same turn.');
                if (runtime.pending_action.assessment_only) {
                    lines.push('Because the buffered action had no declared category, assess it honestly after setup and then output 3-4 clickable options instead of silently ignoring it.');
                    lines.push('Use the spawn draw to clarify the encounter frame and why those options land at their categories, not to inject a separate surprise event.');
                } else {
                    lines.push('A pending action and pending roll payload are already stored. Use them. Do not reinterpret the spawn draw as the resolution roll.');
                    lines.push('End with the next 3-4 clickable options if combat continues.');
                }
            } else {
                lines.push(`Create combat:${runtime.combat_id} now. This is the combat container.`);
                lines.push('Establish participants, hostiles, primary_enemy, terrain, situation, threat, and exchange.');
                lines.push('Assign justified power_base, power, power_basis, and abilities to important new enemies.');
                lines.push('Use the spawn draw to reveal encounter circumstance and leverage: who sees clearly, who is exposed, how the terrain is really working, and why the opening options fall where they do.');
                lines.push('Do not resolve the first exchange yet. Stop on the opening situation and output 3-4 clickable options.');
            }
            break;
        case 'awaiting_choice':
            lines.push('');
            lines.push('PHASE INSTRUCTION: WAITING FOR PLAYER CHOICE');
            if (runtime.pending_action?.assessment_only) {
                lines.push('The player typed a freeform combat action without a category.');
                lines.push('Do not resolve it yet.');
                lines.push('Assess that action against the baseline and output 3-4 clickable options.');
                lines.push('The first option should capture the player’s intended move with your judged category if it is credible.');
            } else {
                lines.push('Combat is active but no valid option list is stored.');
                lines.push('Output 3-4 clickable combat options using the exact combat HTML format.');
            }
            break;
        case 'awaiting_resolution':
            lines.push('');
            lines.push('PHASE INSTRUCTION: RESOLVE ONE EXCHANGE');
            lines.push('Resolve exactly one exchange, then stop and output the next 3-4 clickable options if combat continues.');
            if (runtime.pending_roll?.skip) {
                lines.push(`This action ${runtime.pending_roll.reason === 'absolute' ? 'auto-succeeds' : 'auto-fails'}. Narrate it happening. No roll interpretation is needed.`);
            } else if (runtime.pending_roll) {
                lines.push(`Mechanical resolution is already fixed: ${runtime.pending_roll.category || '?'} action | threshold ${describeSuccessThreshold(runtime.pending_roll.category, runtime.pending_roll.dc)} | rolled ${runtime.pending_roll.d20} => ${runtime.pending_roll.resolution || (runtime.pending_roll.success ? 'SUCCESS' : 'TRANSFORM')}.`);
                lines.push('Do not reinterpret the threshold from the number alone. Treat the injected category as canonical, and do not compare the draw card/hexagram/table number to the threshold. The draw is interpretive only.');
                lines.push('Interpret the combat draw explicitly.');
                lines.push('- On success: the draw colors how the success lands.');
                lines.push('- On transform (below threshold, non-critical): do not frame it as a dead miss or null turn. The attempted action still creates motion, but reality answers with exposure, cost, redirection, or a hard opportunity. The draw determines that transformation.');
                lines.push('- On critical success: the draw amplifies the gain.');
                lines.push('- On critical transform: the draw determines the catastrophic transformation.');
                lines.push('- On tonal mismatch: interpret from the opposition’s perspective or as ironic contrast.');
                lines.push('Low rolls are not ordinary "failure." They are the world forcing a new angle, trade, complication, or opening.');
                lines.push('Record divination.last_draw in the update block for rolled exchanges.');
            }
            lines.push('If combat resolves, write status=RESOLVED plus outcome/aftermath and clean up the combat entity in the same turn if possible.');
            break;
        case 'awaiting_reassessment':
            lines.push('');
            lines.push('PHASE INSTRUCTION: REASSESS TOO-GENEROUS CUSTOM DIFFICULTY');
            lines.push('Challenge the player’s declared difficulty before resolving.');
            lines.push('Do not spend the stored d20/draw. Preserve them for the next reassessed turn.');
            lines.push('Explain why the declared category was too generous compared to the baseline and scene reality.');
            break;
        case 'cleanup_grace':
            lines.push('');
            lines.push('PHASE INSTRUCTION: POST-COMBAT CLEANUP');
            lines.push('Combat is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the combat entity if it still exists.');
            lines.push('Do not output new combat options.');
            break;
    }

    return lines.join('\n');
}

function getOptionByIndex(runtime, index) {
    return (runtime.options || []).find(option => option.index === index) || null;
}

function buildOptionAction(option, baselineCategory, options = {}) {
    const baselineStep = categoryStep(baselineCategory);
    const chosenStep = categoryStep(option.category);
    const effectiveStep = options.skipClamp
        ? chosenStep
        : (chosenStep != null && baselineStep != null
            ? Math.min(chosenStep, Math.min(CATEGORY_ORDER.length - 1, baselineStep + 1))
            : chosenStep);
    const effectiveCategory = categoryFromStep(effectiveStep);
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

function buildCustomAction(intent, declaredCategory, baselineCategory, options = {}) {
    const baselineStep = categoryStep(baselineCategory);
    const declaredStep = categoryStep(declaredCategory);
    const delta = baselineStep == null || declaredStep == null ? 0 : declaredStep - baselineStep;
    return {
        source: 'custom',
        intent,
        declared_category: declaredCategory,
        effective_category: declaredCategory,
        baseline_category: baselineCategory,
        clamped: false,
        challenge_required: options.skipChallenge ? false : delta >= 2,
        assessment_only: false,
    };
}

async function handleCombatActionSelection(rawText, state, drawFn) {
    let runtime = getCombatRuntime();
    const combatBody = getCombatCommandBody(rawText);
    if (!runtime) {
        if (combatBody == null) return { handled: false };
        await startCombatSetupRuntime(drawFn());
        runtime = getCombatRuntime();
        if (!runtime) return { handled: false };
    }

    const baseline = getCombatBaseline(state, runtime);
    const dcTable = buildDcTable(getCombatSettings());
    const next = clone(runtime);
    const optionText = parseCombatOptionValue(rawText);
    const optionIndex = optionText?.index ?? parseCombatIndexText(rawText) ?? parseOptionIndexText(rawText);
    const explicitCustom = parseCombatCustomText(rawText);

    if (next.phase === 'setup') {
        if (combatBody === '') {
            await setCombatRuntime(next);
            return { handled: true, inject: true };
        }

        if (optionText || optionIndex != null) {
            const option = optionText || getOptionByIndex(next, optionIndex);
            if (!option) return { handled: false };
            const action = buildOptionAction(option, null, { skipClamp: true });
            next.pending_action = {
                ...action,
                setup_buffered: true,
                baseline_category: null,
            };
            next.pending_roll = {
                ...buildRollPayload(action.effective_category, dcTable, drawFn),
                baseline: null,
                setup_buffered: true,
            };
            await setCombatRuntime(next);
            return { handled: true, inject: true };
        }

        if (explicitCustom) {
            const action = buildCustomAction(explicitCustom.intent, explicitCustom.category, null, { skipChallenge: true });
            next.pending_action = {
                ...action,
                setup_buffered: true,
                baseline_category: null,
            };
            next.pending_roll = {
                ...buildRollPayload(action.effective_category, dcTable, drawFn),
                baseline: null,
                setup_buffered: true,
            };
            await setCombatRuntime(next);
            return { handled: true, inject: true };
        }

        const setupText = combatBody != null ? combatBody : normalizeText(rawText);
        if (!setupText || /^ooc:/i.test(setupText)) {
            return { handled: false };
        }

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
        await setCombatRuntime(next);
        return { handled: true, inject: true };
    }

    if (next.phase === 'awaiting_reassessment') {
        const reassessed = explicitCustom || optionText || (optionIndex != null ? getOptionByIndex(next, optionIndex) : null);
        if (!reassessed) {
            return {
                handled: true,
                inject: true,
            };
        }

        const action = explicitCustom
            ? buildCustomAction(explicitCustom.intent || next.pending_action?.intent || '', explicitCustom.category, baseline.category)
            : buildOptionAction(reassessed, baseline.category);

        action.challenge_required = false;
        next.pending_action = action;
        next.phase = 'awaiting_resolution';

        if (action.effective_category === 'Absolute') {
            next.pending_roll = { skip: true, reason: 'absolute', category: 'Absolute', baseline: baseline.category };
        } else if (action.effective_category === 'Impossible') {
            next.pending_roll = { skip: true, reason: 'impossible', category: 'Impossible', baseline: baseline.category };
        } else if (next.pending_roll?.skip) {
            next.pending_roll.category = action.effective_category;
        } else {
            next.pending_roll = {
                ...(next.pending_roll || buildChallengeRoll(drawFn)),
                challenge_pending: false,
                category: action.effective_category,
                dc: dcTable[action.effective_category] ?? null,
            };
            const outcome = resolveRolledOutcome(next.pending_roll.d20, next.pending_roll.dc);
            next.pending_roll.success = outcome.success;
            next.pending_roll.critical = outcome.critical || next.pending_roll.critical || null;
            next.pending_roll.resolution = outcome.resolution;
        }

        await setCombatRuntime(next);
        return { handled: true, inject: true };
    }

    if (next.phase !== 'awaiting_choice') {
        return { handled: false };
    }

    if (combatBody === '') {
        return { handled: true, inject: true };
    }

    if (optionIndex != null) {
        const option = optionText || getOptionByIndex(next, optionIndex);
        if (!option) return { handled: false };

        const action = buildOptionAction(option, baseline.category);
        const roll = buildRollPayload(action.effective_category, dcTable, drawFn);
        roll.baseline = baseline.category;
        next.pending_action = action;
        next.pending_roll = roll;
        next.phase = 'awaiting_resolution';
        await setCombatRuntime(next);
        return { handled: true, inject: true };
    }

    if (explicitCustom) {
        const action = buildCustomAction(explicitCustom.intent, explicitCustom.category, baseline.category);
        next.pending_action = action;

        if (action.challenge_required) {
            next.pending_roll = buildChallengeRoll(drawFn);
            next.pending_roll.baseline = baseline.category;
            next.phase = 'awaiting_reassessment';
        } else {
            next.pending_roll = buildRollPayload(action.effective_category, dcTable, drawFn);
            next.pending_roll.baseline = baseline.category;
            next.phase = 'awaiting_resolution';
        }

        await setCombatRuntime(next);
        return { handled: true, inject: true };
    }

    const text = combatBody != null ? combatBody : normalizeText(rawText);
    if (!text || /^ooc:/i.test(text)) {
        return { handled: false };
    }

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
    await setCombatRuntime(next);
    return { handled: true, inject: true };
}

function didResolveCombatThisTurn(runtime, state, committedTxns) {
    const combat = getCombatEntity(state, runtime);
    const resolvedInState = String(combat?.status || '').toUpperCase() === 'RESOLVED';
    const resolvedInTx = (committedTxns || []).some(tx => {
        if (tx.e !== 'combat' || tx.id !== runtime.combat_id) return false;
        if (tx.op === 'TR' && tx.d?.f === 'status') return String(tx.d?.to || '').toUpperCase() === 'RESOLVED';
        if ((tx.op === 'S' || tx.op === 'MS') && tx.d?.f === 'status') return String(tx.d?.v || '').toUpperCase() === 'RESOLVED';
        return false;
    });
    return resolvedInState || resolvedInTx;
}

function didDestroyCombatThisTurn(runtime, committedTxns) {
    return (committedTxns || []).some(tx => tx.op === 'D' && tx.e === 'combat' && tx.id === runtime.combat_id);
}

function combatCorrection(message) {
    return `[COMBAT RUNTIME]\n${message}`;
}

async function processCombatAssistantTurn(state, committedTxns, messageText) {
    let runtime = getCombatRuntime();
    if (!runtime) return null;

    const combatCreates = (committedTxns || []).filter(tx => tx.e === 'combat' && tx.id).map(tx => tx.id);
    if ((!state?.combats?.[runtime.combat_id]) && combatCreates.length === 1) {
        runtime = { ...runtime, combat_id: combatCreates[0] };
        await setCombatRuntime(runtime);
    }

    const options = parseCombatOptionsFromMessage(messageText);
    const destroyed = didDestroyCombatThisTurn(runtime, committedTxns);
    const resolved = didResolveCombatThisTurn(runtime, state, committedTxns);
    const combat = getCombatEntity(state, runtime);

    if (runtime.phase === 'cleanup_grace') {
        await clearCombatRuntime();
        return null;
    }

    if (destroyed) {
        await clearCombatRuntime();
        return null;
    }

    if (runtime.phase === 'setup') {
        if (!combat) {
            return combatCorrection(runtime.pending_action?.setup_buffered
                ? 'Combat setup is incomplete and a player action is waiting. Create `combat:*` now, then resolve the buffered action instead of restarting setup.'
                : 'Combat is active but no combat entity was created. Create `combat:*` now before continuing.');
        }

        if (runtime.pending_action?.setup_buffered && runtime.pending_roll) {
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
                next.cleanup_turns_remaining = 1;
                next.options = [];
                next.pending_action = null;
                next.pending_roll = null;
                await setCombatRuntime(next);
                if (!destroyed) {
                    return combatCorrection('Combat is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the combat entity.');
                }
                return null;
            }

            next.phase = 'awaiting_choice';
            next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(combat?.exchange) ?? 0);
            next.options = options;
            next.pending_action = null;
            next.pending_roll = null;
            await setCombatRuntime(next);

            if (!options.length) {
                return combatCorrection('The buffered setup action resolved, but no next combat options were presented. Output 3-4 clickable combat options using the exact combat HTML format.');
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
            };
            await setCombatRuntime(next);
            if (!options.length) {
                return combatCorrection('Combat setup completed, but the buffered uncategorized action was not turned into options. Output 3-4 clickable combat options using the exact combat HTML format.');
            }
            return null;
        }

        const next = {
            ...runtime,
            options,
            pending_action: null,
            pending_roll: null,
            phase: 'awaiting_choice',
        };
        await setCombatRuntime(next);

        if (!options.length) {
            return combatCorrection('Combat is active but no options were presented. Output 3-4 clickable combat options using the exact combat HTML format.');
        }
        return null;
    }

    if (runtime.phase === 'awaiting_choice' && runtime.pending_action?.assessment_only) {
        const next = {
            ...runtime,
            options: options.length ? options : runtime.options || [],
            pending_action: null,
            pending_roll: null,
        };
        await setCombatRuntime(next);
        if (!options.length) {
            return combatCorrection('Combat is active but the uncategorized action was not assessed into options. Output 3-4 clickable combat options using the exact combat HTML format.');
        }
        return null;
    }

    if (runtime.phase === 'awaiting_choice') {
        if (!combat) {
            return combatCorrection('Combat is active but no combat entity exists. Create `combat:*` now before continuing.');
        }
        if (options.length) {
            await setCombatRuntime({
                ...runtime,
                options,
            });
        }
        return null;
    }

    if (runtime.phase === 'awaiting_resolution') {
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
            next.cleanup_turns_remaining = 1;
            next.options = [];
            next.pending_action = null;
            next.pending_roll = null;
            await setCombatRuntime(next);
            if (!destroyed) {
                return combatCorrection('Combat is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the combat entity.');
            }
            return null;
        }

        next.phase = 'awaiting_choice';
        next.exchange = Math.max((runtime.exchange || 1) + 1, coerceNumber(combat?.exchange) ?? 0);
        next.options = options;
        next.pending_action = null;
        next.pending_roll = null;
        await setCombatRuntime(next);

        if (!options.length) {
            return combatCorrection('Combat is active but no options were presented. Output 3-4 clickable combat options using the exact combat HTML format.');
        }
        return null;
    }

    if (runtime.phase === 'awaiting_reassessment') {
        if (resolved) {
            const next = {
                ...runtime,
                phase: 'cleanup_grace',
                cleanup_turns_remaining: 1,
            };
            await setCombatRuntime(next);
            if (!destroyed) {
                return combatCorrection('Combat is resolved. Before normal play fully resumes, write any final persistent consequences and destroy the combat entity.');
            }
            return null;
        }
        return null;
    }

    return null;
}

export {
    RUNTIME_KEY,
    SETTINGS_KEY,
    CATEGORY_ORDER,
    DEFAULT_DC_TABLES,
    normalizeCategory,
    categoryStep,
    categoryFromStep,
    buildDcTable,
    getCombatSettings,
    setCombatDifficultyMode,
    setCombatCustomDcs,
    getCombatRuntime,
    setCombatRuntime,
    clearCombatRuntime,
    isCombatRuntimeActive,
    isCombatReasonModeActive,
    startCombatSetupRuntime,
    getCombatEntity,
    getActiveCombatEntity,
    getCombatBaseline,
    buildCombatPrompt,
    parseCombatOptionsFromMessage,
    handleCombatActionSelection,
    processCombatAssistantTurn,
    formatRollSummary,
};
