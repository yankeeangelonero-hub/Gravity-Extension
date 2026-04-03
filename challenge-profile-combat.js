/**
 * challenge-profile-combat.js — Combat profile for the challenge engine.
 *
 * Defines combat-specific doctrine: power-gap baseline, participant resolution,
 * actor formatting, context lines, threshold tables, and draw guidance.
 * The generic engine delegates to these hooks at every domain-specific decision point.
 */

// ─── Private Helpers ──────────────────────────────────────────────────────────

function coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
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

// ─── Profile Definition ───────────────────────────────────────────────────────

const combatProfile = Object.freeze({
    kind: 'combat',
    displayName: 'Combat',
    inputPrefix: 'combat',
    deductionType: 'combat',
    entityType: 'combat',

    categories: ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'],
    autoSuccess: 'Absolute',
    autoFail: 'Impossible',

    thresholdTables: Object.freeze({
        Cinematic: Object.freeze({ 'Highly likely': 3, Average: 7, 'Highly unlikely': 12 }),
        Gritty: Object.freeze({ 'Highly likely': 8, Average: 12, 'Highly unlikely': 16 }),
        Heroic: Object.freeze({ 'Highly likely': 2, Average: 5, 'Highly unlikely': 10 }),
        Survival: Object.freeze({ 'Highly likely': 10, Average: 14, 'Highly unlikely': 18 }),
    }),
    defaultMode: 'Cinematic',

    usesD20: true,
    usesDraws: true,
    challengeThreshold: 2,

    resultLabels: Object.freeze({
        success: 'SUCCESS',
        fail: 'TRANSFORM',
        critSuccess: 'CRITICAL_SUCCESS',
        critFail: 'CRITICAL_TRANSFORM',
    }),

    phases: ['setup', 'awaiting_choice', 'awaiting_resolution', 'awaiting_reassessment', 'cleanup_grace'],

    optionCount: [3, 4],
    optionPrefix: 'combat',

    seedFields: Object.freeze({ kind: 'combat', status: 'ACTIVE', exchange: 1 }),
    modelFields: ['participants', 'hostiles', 'primary_opponent', 'terrain', 'situation', 'threat'],
    resolutionFields: ['outcome', 'aftermath'],

    lorebookKeys: Object.freeze({
        core: 'gravity_mode_combat_core',
        optional: 'gravity_mode_combat_optional_examples',
        prose: 'gravity_prose_combat',
    }),

    getBaseline(state, entity) {
        const pcPower = coerceNumber(state?.pc?.power);
        const primary = getPrimaryOpponent(state, entity);
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
    },

    resolveParticipants(state, entity) {
        const pc = resolveStateCharacter(state, 'pc');
        const hostileRefs = getCombatHostiles(entity);
        const opponents = hostileRefs
            .map(ref => resolveCombatantReference(state, ref))
            .filter(Boolean);
        return { pc, opponents, allies: [] };
    },

    describeActor,

    buildContextLines(runtime, entity, state, baseline, helpers) {
        const { formatDrawBlock, formatActionSummary, formatRollSummary,
            buildPromptOptionsBlock, describeSuccessThreshold, describeDcTable, dcTable } = helpers;
        const lines = [];

        const pcActor = resolveStateCharacter(state, 'pc');
        const primaryEnemy = baseline.primary_enemy;
        const hostiles = getCombatHostiles(entity)
            .map(ref => resolveCombatantReference(state, ref))
            .filter(Boolean);

        lines.push(`Challenge runtime is active for combat:${runtime.entity_id}.`);
        lines.push(`Challenge lock: ${runtime.locked ? 'engaged' : 'released'}`);
        lines.push(`Phase: ${runtime.phase}`);
        lines.push(`Runtime exchange: ${runtime.exchange}`);
        lines.push(`Difficulty mode: ${runtime.difficulty_mode}`);
        lines.push(`Success thresholds: ${helpers.describeDcTable(helpers.dcTable)}`);
        lines.push(`Scene draw:\n${formatDrawBlock(runtime.scene_draw, {
            stripNarrativeForcing: true,
            active: runtime.scene_draw_active,
            guidance: runtime.scene_draw_active
                ? 'Combat setup usage: use this draw to highlight the encounter circumstance, visible leverage, spacing, terrain, initiative, exposure, and why the opening options sit at their assessed categories. It reveals the shape and pressure of the encounter; it does not force a separate event or resolve the exchange by itself.'
                : 'Scene draw has expired. Do not use it for further exchanges.',
        })}`);
        lines.push('');
        lines.push('PLAYER COMBAT PROFILE');
        lines.push(`  ${describeActor(pcActor)}`);

        if (entity) {
            lines.push('');
            lines.push(`COMBAT ENTITY (${entity.id || runtime.entity_id})`);
            if (entity.status) lines.push(`  Status: ${entity.status}`);
            if (entity.exchange != null) lines.push(`  Ledger exchange: ${entity.exchange}`);
            if (entity.situation) lines.push(`  Situation: ${entity.situation}`);
            if (entity.terrain) lines.push(`  Terrain: ${entity.terrain}`);
            if (entity.threat) lines.push(`  Threat: ${entity.threat}`);
            if (entity.participants) lines.push(`  Participants: ${Array.isArray(entity.participants) ? entity.participants.join(', ') : entity.participants}`);
            if (entity.hostiles) lines.push(`  Hostiles: ${Array.isArray(entity.hostiles) ? entity.hostiles.join(', ') : entity.hostiles}`);
            if (entity.primary_enemy) lines.push(`  Primary enemy field: ${typeof entity.primary_enemy === 'object' ? JSON.stringify(entity.primary_enemy) : entity.primary_enemy}`);
        } else {
            lines.push('');
            lines.push('The extension auto-seeded the combat entity. Fill its fields this turn.');
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
            if (runtime.pending_action.source === 'custom') {
                lines.push('This turn came from a custom combat command. The action intent has already been parsed into CHALLENGE_MECHANICS and PENDING ACTION. Do not treat the player message as a regular prose turn.');
            }
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

        // Phase instructions
        switch (runtime.phase) {
            case 'setup':
                lines.push('');
                lines.push('PHASE INSTRUCTION: SETUP');
                if (runtime.pending_action?.setup_buffered) {
                    lines.push('Setup is incomplete, but the player already committed to an action while setup had not advanced.');
                    lines.push(`Fill combat:${runtime.entity_id} fields: participants, hostiles, primary_enemy, terrain, situation, threat, and exchange.`);
                    lines.push('Then immediately resolve the buffered player action this same turn.');
                    if (runtime.pending_action.assessment_only) {
                        lines.push('Because the buffered action had no declared category, assess it honestly after setup and then output 3-4 clickable options instead of silently ignoring it.');
                        lines.push('Use the scene draw to clarify the encounter frame and why those options land at their categories, not to inject a separate surprise event.');
                    } else {
                        lines.push('A pending action and pending roll payload are already stored. Use them. Do not reinterpret the scene draw as the resolution roll.');
                        lines.push('Do not downgrade this buffered declared action into a fresh assessment step or a replacement option set first. Resolve the stored action now using the injected category, threshold, d20, and draw.');
                        lines.push('If this buffered action was rolled, record divination.last_draw in the update block this same turn.');
                        lines.push('End with the next 3-4 clickable options if combat continues.');
                    }
                } else {
                    lines.push(`The extension auto-seeded combat:${runtime.entity_id}. Fill its fields now.`);
                    lines.push('Establish participants, hostiles, primary_enemy, terrain, situation, threat, and exchange.');
                    lines.push('Assign justified power_base, power, power_basis, and abilities to important new enemies.');
                    lines.push('Use the scene draw to reveal encounter circumstance and leverage: who sees clearly, who is exposed, how the terrain is really working, and why the opening options fall where they do.');
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
                    lines.push('CHALLENGE_INPUT already contains the intended move. The first option should capture that intent with your judged category if it is credible.');
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
                    lines.push('Do not decide success or transform yourself. The extension already decided it.');
                    lines.push('Interpret the combat draw explicitly.');
                    lines.push('- On success: the draw colors how the success lands.');
                    lines.push('- On transform (below threshold, non-critical): do not frame it as a dead miss or null turn. The attempted action still creates motion, but reality answers with exposure, cost, redirection, or a hard opportunity. The draw determines that transformation.');
                    lines.push('- On critical success: the draw amplifies the gain.');
                    lines.push('- On critical transform: the draw determines the catastrophic transformation.');
                    lines.push('- On tonal mismatch: interpret from the opposition\'s perspective or as ironic contrast.');
                    lines.push('Low rolls are not ordinary "failure." They are the world forcing a new angle, trade, complication, or opening.');
                    lines.push('Record divination.last_draw in the update block for rolled exchanges.');
                }
                lines.push('If combat resolves, write status=RESOLVED plus outcome/aftermath and clean up the combat entity in the same turn if possible.');
                break;
            case 'awaiting_reassessment':
                lines.push('');
                lines.push('PHASE INSTRUCTION: REASSESS TOO-GENEROUS CUSTOM DIFFICULTY');
                lines.push('Challenge the player\'s declared difficulty before resolving.');
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

        return lines;
    },

    sceneDrawGuidance() {
        return 'encounter circumstance, leverage, spacing, terrain, initiative, exposure, and why the opening options sit at their assessed categories';
    },

    resultDrawGuidance() {
        return 'colors the already-determined exchange result';
    },

    setupGuidance() {
        return 'Fill entity fields: participants, hostiles, primary_opponent, terrain, situation, threat, exchange. Assign justified power_base, power, power_basis, and abilities to important new enemies.';
    },

    cleanupGuidance() {
        return 'Write lasting fallout, update wounds to char entities, destroy the combat entity.';
    },

    validateTurn(runtime, state, committedTxns) {
        return null;
    },

    initProfileState(state) {
        return {};
    },

    isResolved(runtime, entity, state, committedTxns) {
        const resolvedInState = String(entity?.status || '').toUpperCase() === 'RESOLVED';
        const resolvedInTx = (committedTxns || []).some(tx => {
            if (tx.e !== runtime.entity_type || tx.id !== runtime.entity_id) return false;
            if (tx.op === 'TR' && tx.d?.f === 'status') return String(tx.d?.to || '').toUpperCase() === 'RESOLVED';
            if ((tx.op === 'S' || tx.op === 'MS') && tx.d?.f === 'status') return String(tx.d?.v || '').toUpperCase() === 'RESOLVED';
            return false;
        });
        return resolvedInState || resolvedInTx;
    },
});

export default combatProfile;
