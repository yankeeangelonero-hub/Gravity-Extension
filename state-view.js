/**
 * state-view.js — Format computed state for prompt injection.
 *
 * Provides:
 * 1. formatStateView(state) — full state overview injected via setExtensionPrompt
 *
 * No lorebook interaction — all injection handled by index.js via setExtensionPrompt.
 */

import { getArrayItemHistory } from './state-compute.js';

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatCardName(slug) {
    if (!slug || typeof slug !== 'string') return '';
    return slug.split('-').map(w => {
        if (w.length <= 2) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
}

function getCollisionForcesText(col) {
    if (Array.isArray(col?.forces)) {
        return col.forces
            .map(force => normalizeText(force?.name || force))
            .filter(Boolean)
            .join(' | ');
    }
    return normalizeText(col?.forces);
}

function getCollisionNarrativeLines(col) {
    const lines = [];
    if (col.forces) lines.push(`Forces: ${getCollisionForcesText(col)}`);
    if (col.cost) lines.push(`Scenario: ${normalizeText(col.cost)}`);
    if (col.ignition_class || col.fires_when) {
        const cls = col.ignition_class ? String(col.ignition_class).toLowerCase() : '';
        const trigger = col.fires_when ? normalizeText(col.fires_when) : '';
        if (cls && trigger) lines.push(`Ignition: ${cls} — fires when ${trigger}`);
        else if (cls) lines.push(`Ignition: ${cls}`);
        else lines.push(`Fires when: ${trigger}`);
    }
    if (col.location) lines.push(`Location: ${col.location}`);
    const involved = toList(col.involved_chars);
    if (involved.length) lines.push(`Involved: ${involved.join(', ')}`);
    if (col.aftermath) lines.push(`Aftermath: ${col.aftermath}`);
    return lines;
}


function toList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return [String(value)];
}

function formatPowerTag(entity) {
    const hasCurrent = entity?.power != null;
    const hasBase = entity?.power_base != null;
    if (!hasCurrent && !hasBase) return '';
    if (hasCurrent && hasBase) return ` [power:${entity.power}|base:${entity.power_base}]`;
    return hasCurrent ? ` [power:${entity.power}]` : ` [base:${entity.power_base}]`;
}

function formatRelationshipStage(rel) {
    if (!rel) return '';
    const d = rel.distance;
    const i = rel.intensity;
    if (typeof d !== 'string' || typeof i !== 'string') return '';
    return ` · ${d} / ${i}`;
}

/**
 * Render the full state view into the always-on lorebook entry.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
/**
 * Format the full state into a prompt-friendly string.
 * Includes entity IDs so the LLM knows exactly what to target in ledger transactions.
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */

/**
 * Format the collision_archive injection block. Returns empty string when
 * archive is empty or pool is not thin (§4.3).
 * @param {Object} state
 * @returns {string}
 */
function formatCollisionArchive(state) {
    const archiveEntries = Array.isArray(state?.world?.collision_archive) ? state.world.collision_archive : [];
    if (!archiveEntries.length) return '';
    const activeCollisionCount = Object.values(state?.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
    if (activeCollisionCount > 2) return '';
    const lines = ['Collision Archive (last resolved — pool is thin, seed new collisions from these hooks):'];
    for (const entry of archiveEntries.slice(-5)) {
        lines.push(`  • ${entry}`);
    }
    return lines.join('\n');
}

/**
 * Hash used by injectPrompt to skip redundant archive re-injection. §4.3.
 * @param {Object} state
 * @returns {string}
 */
function computeArchiveVersion(state) {
    const archiveEntries = Array.isArray(state?.world?.collision_archive) ? state.world.collision_archive : [];
    const activeCollisionCount = Object.values(state?.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
    const thin = activeCollisionCount <= 2 ? 'thin' : 'ok';
    const fingerprint = archiveEntries.slice(-5).map(e => String(e || '').slice(0, 20)).join('|');
    return `${archiveEntries.length}:${thin}:${fingerprint}`;
}

/**
 * Dispatch challenge entity formatting by type (§7.3 rule 3).
 * Reads `kind` first, falling back to `challenge_type` for spec-matching code paths.
 * Today only `combat` is implemented; future challenge types add their own branch
 * without touching this function's callers.
 * @param {Object} challenge
 * @param {Object} opts — { compact: boolean } compact=true for registry listing
 * @returns {string[]} lines to push into the state view
 */
function formatChallenge(challenge, { compact = false } = {}) {
    const type = challenge?.kind || challenge?.challenge_type || 'combat';
    const lines = [];
    if (type === 'combat') {
        if (compact) {
            let combatLine = `  ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}]`;
            if (challenge.primary_enemy) {
                const pe = typeof challenge.primary_enemy === 'object'
                    ? (challenge.primary_enemy.name || challenge.primary_enemy.id || '?')
                    : challenge.primary_enemy;
                combatLine += ` vs ${pe}`;
            }
            if (challenge.opened_from) combatLine += ` (from collision:${challenge.opened_from})`;
            combatLine += ` → id: ${challenge.id}`;
            lines.push(combatLine);
        } else {
            lines.push(`  ⚔ ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}] → id: ${challenge.id}`);
            if (challenge.primary_enemy) {
                const pe = typeof challenge.primary_enemy === 'object'
                    ? (challenge.primary_enemy.name || challenge.primary_enemy.id || '?')
                    : challenge.primary_enemy;
                lines.push(`    Primary enemy: ${pe}`);
            }
            if (challenge.opened_from) lines.push(`    Opened from: collision:${challenge.opened_from}`);
            if (challenge.outcome) lines.push(`    Outcome: ${challenge.outcome}`);
            if (challenge.aftermath) lines.push(`    Aftermath: ${challenge.aftermath}`);
        }
        return lines;
    }
    // Future challenge types slot in here.
    return lines;
}

function formatStateView(state, modeOrOpts = 'full', includeArchiveArg = true) {
    // Accept either (state, mode, includeArchive) or (state, { mode, includeArchive })
    let mode, includeArchive;
    if (modeOrOpts && typeof modeOrOpts === 'object') {
        mode = modeOrOpts.mode || 'full';
        includeArchive = modeOrOpts.includeArchive !== undefined ? modeOrOpts.includeArchive : true;
    } else {
        mode = modeOrOpts || 'full';
        includeArchive = includeArchiveArg;
    }
    const lines = [];
    // ── Mode flags ────────────────────────────────────────────────────────
    const isLite = (mode === 'lite');
    const isCombat = (mode === 'combat');
    const isIntimacy = (mode === 'intimacy');
    const isFull = (mode === 'full');
    // Derived feature flags
    const showPower = isCombat || isFull;          // power tags, abilities, wounds
    const showIntimacy = isIntimacy || isFull;      // intimate_history, demonstrated_traits
    const showConstraintDetail = isIntimacy || isFull; // full constraint profile
    const showConstants = isCombat || isFull;       // power scale/ceiling/notes
    const showFullDetail = isFull;                  // faction detail, full PC dossier

    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // ── Entity Registry ──────────────────────────────────────────────────
    lines.push('ENTITY REGISTRY — use these IDs in ledger transactions');

    // Characters — bucketed by scene presence (§lean phonebook)
    lines.push('');
    lines.push('Characters:');

    // Helper: render the full TRACKED/PRINCIPAL dossier for a char
    const renderFullCharDossier = (id, char) => {
        const tier = char.tier || 'KNOWN';
        const isPrincipal = tier === 'PRINCIPAL';
        lines.push(`CHARACTER: ${char.name || id} [${tier}] → id: ${id}`);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
        const rel = state.relationships?.[`pc-${id}`];
        if (rel && rel.status === 'active') {
            const orientLabel = rel.orientation === 'reversed' ? 'reversed' : 'upright';
            lines.push(`    ♥ Bond (PC): ${formatCardName(rel.card)} · ${orientLabel}${formatRelationshipStage(rel)}`);
            if (rel.nuance) lines.push(`      "${rel.nuance}"`);
        }
        const ka = char.knowledge_asymmetry;
        if (ka !== undefined && ka !== null) {
            if (typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const [k, v] of Object.entries(ka)) {
                    if (typeof v === 'string' && v) kaLines.push(`      ${k}: ${v}`);
                }
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            }
        }
        if (char.agenda) lines.push(`    Agenda: ${normalizeText(char.agenda)}`);
        if (char.last_seen_at !== undefined && char.last_seen_at !== null && normalizeText(char.last_seen_at)) {
            lines.push(`    Last seen at: ${normalizeText(char.last_seen_at)}`);
        }
        // Combat fields — only in combat/full
        if (showPower) {
            const powerTag = formatPowerTag(char);
            if (powerTag) lines.push(`    Power:${powerTag.replace(/^\s*\[/, ' [')}`);
            if (char.power_basis) lines.push(`    Power basis: ${char.power_basis}`);
            const abilities = toList(char.abilities);
            if (abilities.length) lines.push(`    Abilities: ${abilities.join(' | ')}`);
            if (char.wounds && typeof char.wounds === 'object' && Object.keys(char.wounds).length) {
                const woundList = Object.entries(char.wounds).map(([k, v]) => `${k}: ${v}`).join(', ');
                lines.push(`    Wounds: ${woundList}`);
            }
        }
        // Key moments — PRINCIPAL only, last 10 per turn (§2.1).
        if (isPrincipal) {
            const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
            const displayMoments = moments.slice(-10);
            if (displayMoments.length) {
                const capNote = moments.length > displayMoments.length ? `, showing last ${displayMoments.length}` : '';
                lines.push(`    Key moments (${moments.length}${capNote}):`);
                for (const m of displayMoments) lines.push(`      - ${m}`);
            }
        }
    };

    // Bucket assignment
    const castSet = new Set(state.pc?.scene_cast || []);
    const currentPlace = state.pc?.current_place_id || '';
    // current_place_id is stored as "place:<bareId>"; char.location is stored as "<bareId>"
    const currentPlaceBare = currentPlace.startsWith('place:') ? currentPlace.slice('place:'.length) : currentPlace;

    const inCast = [];
    const inCastKnown = [];
    const offStagePrincipal = [];
    const offStageTracked = [];
    const dormantOnStageByLocation = [];
    const knownList = [];

    for (const [id, char] of Object.entries(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        const fqId = `char:${id}`;
        const tier = String(char.tier || 'KNOWN').toUpperCase();
        const onStage = castSet.has(fqId);
        const rel = state.relationships?.[`pc-${id}`];
        const isDormantOnStage = (
            rel && rel.status === 'dormant' &&
            currentPlaceBare && (char.location === currentPlaceBare || char.location === currentPlace)
        );

        if (onStage && (tier === 'TRACKED' || tier === 'PRINCIPAL')) {
            inCast.push([id, char]);
        } else if (onStage && tier === 'KNOWN') {
            inCastKnown.push([id, char]);
        } else if (tier === 'PRINCIPAL') {
            offStagePrincipal.push([id, char]);
        } else if (tier === 'TRACKED') {
            offStageTracked.push([id, char]);
        } else if (isDormantOnStage) {
            dormantOnStageByLocation.push([id, char, rel]);
        } else if (tier === 'KNOWN') {
            knownList.push([id, char]);
        }
    }

    // In-cast TRACKED+: full dossier
    for (const [id, char] of inCast) {
        renderFullCharDossier(id, char);
    }

    // In-cast KNOWN: mid-weight block
    for (const [id, char] of inCastKnown) {
        lines.push(`CHARACTER: ${char.name || id} [KNOWN · on-stage] → id: ${id}`);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
        if (char.agenda) lines.push(`    Agenda: ${normalizeText(char.agenda)}`);
    }

    // Off-stage PRINCIPAL: one-liner with card + tags sub-line
    for (const [id, char] of offStagePrincipal) {
        const rel = state.relationships?.[`pc-${id}`];
        const cardFrag = rel && rel.status === 'active'
            ? ` · Bond (PC): ${formatCardName(rel.card)} · ${rel.orientation}${formatRelationshipStage(rel)}`
            : '';
        const loc = char.location ? ` — last seen ${char.location}` : '';
        lines.push(`PRINCIPAL (off-stage): ${char.name || id}${loc}${cardFrag} → id: ${id}`);
        if (Array.isArray(char.tags) && char.tags.length > 0) {
            lines.push(`    Tags: [${char.tags.join(', ')}]`);
        }
    }

    // Off-stage TRACKED: compact line, no card
    for (const [id, char] of offStageTracked) {
        const loc = char.location ? ` @ ${char.location}` : '';
        lines.push(`TRACKED (off-stage): ${char.name || id}${loc} → id: ${id}`);
    }

    // Dormant on-stage by location: compact with card (belt-and-suspenders re-injection)
    for (const [id, char, rel] of dormantOnStageByLocation) {
        lines.push(`DORMANT (on-stage): ${char.name || id} · ${formatCardName(rel.card)} ${rel.orientation} → id: ${id}`);
        if (rel.nuance) lines.push(`    "${rel.nuance}"`);
    }

    // KNOWN — roll-up: top 15 by last_active_tx, rest as name-only older list
    if (knownList.length > 0) {
        const sorted = knownList.slice().sort(([, a], [, b]) => {
            return (b.last_active_tx || 0) - (a.last_active_tx || 0);
        });
        const TOP_N = 15;
        const top = sorted.slice(0, TOP_N);
        const older = sorted.slice(TOP_N);

        lines.push('');
        lines.push(`KNOWN (${top.length} most-recently-active${older.length ? `; ${older.length} older below` : ''}):`);
        for (const [id, char] of top) {
            const tagsFrag = Array.isArray(char.tags) && char.tags.length > 0
                ? ` [${char.tags.join(', ')}]`
                : '';
            const fallback = !tagsFrag && char.agenda ? ` — "${normalizeText(char.agenda).slice(0, 80)}"` : '';
            const locFallback = !tagsFrag && !char.agenda && char.location ? ` @ ${char.location}` : '';
            lines.push(`  • ${char.name || id}${tagsFrag}${fallback}${locFallback} → id: ${id}`);
        }
        if (older.length > 0) {
            const names = older.map(([, c]) => c.name || '<unnamed>').join(', ');
            lines.push(`Older KNOWN (${older.length} inactive): ${names}`);
        }
    }

    if (Object.keys(state.characters).length === 0) lines.push('  (none)');

    // Constraints — mode-aware detail level
    const constraints = Object.values(state.constraints);
    if (constraints.length) {
        lines.push('');
        lines.push('Constraints:');
        for (const c of constraints) {
            const owner = state.characters[c.owner_id];
            const ownerName = owner?.name || c.owner_id;
            // Detect schema drift on canonical fields — surface loudly so the LLM can self-correct
            // next turn (same feedback loop the corrections system uses for format errors).
            const drifts = [];
            if (!c.owner_id) {
                const aliasChar = typeof c.char === 'string' && c.char ? c.char.replace(/^char:/, '') : '';
                drifts.push(aliasChar
                    ? `owner_id missing — 'char' was used instead. Fix: S constraint:${c.id} field=owner_id value=${aliasChar}`
                    : `owner_id missing. Fix: S constraint:${c.id} field=owner_id value=<char_id>`);
            }
            if (!c.integrity) {
                drifts.push(`integrity missing. Fix: S constraint:${c.id} field=integrity value=<STABLE|STRESSED|CRITICAL|BREACHED>`);
            }
            if (!c.name) {
                drifts.push(`name missing. Fix: S constraint:${c.id} field=name value="..."`);
            }
            let cLine = `  ${c.name || '(unnamed)'} [${c.integrity || 'UNKNOWN'}] (${ownerName || '?'})`;
            if (c.shedding_order) cLine += ` shed:${c.shedding_order}`;
            cLine += ` → id: ${c.id}`;
            lines.push(cLine);
            for (const d of drifts) lines.push(`    [SCHEMA DRIFT] ${d}`);
            // Lite: name [INTEGRITY] only (already in header line)
            // Combat: + current_pressure
            if (isCombat && !showConstraintDetail && c.current_pressure) {
                lines.push(`    Pressure: ${c.current_pressure}`);
            }
            // Intimacy/Full: full constraint profile
            if (showConstraintDetail) {
                if (c.profile) {
                    lines.push(`    ${c.profile}`);
                } else {
                    if (c.prevents) lines.push(`    Prevents: ${c.prevents}`);
                    if (c.threshold) lines.push(`    Threshold: ${c.threshold}`);
                    if (c.replacement) lines.push(`    Replacement: ${c.replacement}${c.replacement_type ? ` (${c.replacement_type})` : ''}`);
                }
                if (c.current_pressure) lines.push(`    Pressure: ${c.current_pressure}`);
            }
        }
    }

    // Collisions — registry listing
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED' && c.status !== 'CRASHED');
    if (allCollisions.length) {
        lines.push('');
        lines.push('Collisions:');
        for (const col of allCollisions) {
            const catLabel = col.distance_category ? ` ${col.distance_category}` : '';
            let colLine = `  ${col.name || col.id} [${col.status}]${catLabel} dist:${col.distance ?? '?'}`;
            colLine += ` → id: ${col.id}`;
            lines.push(colLine);
        }
    }

    // Combats — always show registry if active (routed through formatChallenge, §7.3 rule 3)
    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            lines.push(...formatChallenge(combat, { compact: true }));
        }
    }


    // Singletons — PC fields are mode-aware
    lines.push('');
    lines.push('Singletons (no id needed):');
    lines.push('  world — power_scale, power_ceiling, power_notes, world_state, collision_archive');
    if (state.pc.name) {
        let pcSingleton = `  pc — "${state.pc.name}"`;
        // Only show location when current_scene is not set (scene subsumes location)
        if (state.pc.location && !state.pc.current_scene) pcSingleton += ` @ ${state.pc.location}`;
        lines.push(pcSingleton);
        if (state.pc.current_scene) {
            lines.push(`    SCENE: ${state.pc.current_scene}`);
        }
        // Combat-relevant PC fields — only in combat/full
        if (showPower) {
            if (state.pc.equipment) lines.push(`    Equipment: ${state.pc.equipment}`);
            if (state.pc.power_basis) lines.push(`    Power basis: ${state.pc.power_basis}`);
            const pcAbilities = toList(state.pc.abilities);
            if (pcAbilities.length) lines.push(`    Abilities: ${pcAbilities.join(' | ')}`);
            const pcWounds = (state.pc.wounds && typeof state.pc.wounds === 'object') ? state.pc.wounds : {};
            if (Object.keys(pcWounds).length) {
                lines.push(`    Wounds: ${Object.entries(pcWounds).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
            }
        }
    } else {
        lines.push('  pc — (not initialized)');
    }

    // Divination — hide last_draw in lite to prevent bleed
    const divSys = state.divination?.active_system;
    if (divSys) {
        if (isLite) {
            lines.push(`  divination — system: ${divSys}`);
        } else {
            lines.push(`  divination — system: ${divSys}${state.divination?.last_draw ? `, last draw: ${state.divination.last_draw}` : ''}`);
        }
    }

    // Factions — bucketed by scene presence (§lean phonebook)
    const factionEntities = Object.values(state.factions || {});
    if (factionEntities.length) {
        lines.push('');
        lines.push('Factions:');

        const renderFullFaction = (id, faction) => {
            const territoryStr = Array.isArray(faction.territory) ? faction.territory.join(', ') : faction.territory;
            const territory = territoryStr ? ` @ ${territoryStr}` : '';
            const fState = faction.state ? ` [${faction.state}]` : '';
            lines.push(`  ${faction.name || id}${territory}${fState} → id: ${id}`);
            if (Array.isArray(faction.tags) && faction.tags.length > 0) {
                lines.push(`    Tags: [${faction.tags.join(', ')}]`);
            }
            const rel = state.relationships?.[`pc-${id}`];
            if (rel && rel.status === 'active') {
                const orientLabel = rel.orientation === 'reversed' ? 'reversed' : 'upright';
                lines.push(`    ♥ Bond (PC): ${formatCardName(rel.card)} · ${orientLabel}${formatRelationshipStage(rel)}`);
                if (rel.nuance) lines.push(`      "${rel.nuance}"`);
            }
            // Lite mode: emit compact KA so the model can use faction.knowledge_asymmetry on regular turns
            if (isLite) {
                const ka = faction.knowledge_asymmetry;
                if (ka && typeof ka === 'object' && !Array.isArray(ka)) {
                    for (const [k, v] of Object.entries(ka)) {
                        if (typeof v === 'string' && v) lines.push(`    ${k}: ${v}`);
                    }
                }
            }
        };

        const inCastFaction = [];
        const inCastKnownFaction = [];
        const offStagePrincipalFaction = [];
        const offStageTrackedFaction = [];
        const dormantOnStageFaction = [];
        const knownFactionList = [];

        for (const [id, faction] of Object.entries(state.factions)) {
            const fqId = `faction:${id}`;
            const tier = String(faction.tier || 'KNOWN').toUpperCase();
            const onStage = castSet.has(fqId);
            const rel = state.relationships?.[`pc-${id}`];
            const isDormantFactionOnStage = (
                rel && rel.status === 'dormant' &&
                currentPlaceBare &&
                Array.isArray(faction.territory) &&
                (faction.territory.includes(currentPlaceBare) || faction.territory.includes(currentPlace))
            );
            if (onStage && (tier === 'TRACKED' || tier === 'PRINCIPAL')) {
                inCastFaction.push([id, faction]);
            } else if (onStage && tier === 'KNOWN') {
                // Mid-weight in-cast KNOWN: lightweight render (no full KA)
                inCastKnownFaction.push([id, faction]);
            } else if (tier === 'PRINCIPAL') {
                offStagePrincipalFaction.push([id, faction]);
            } else if (tier === 'TRACKED') {
                offStageTrackedFaction.push([id, faction]);
            } else if (isDormantFactionOnStage) {
                dormantOnStageFaction.push([id, faction, rel]);
            } else {
                knownFactionList.push([id, faction]);
            }
        }

        for (const [id, faction] of inCastFaction) {
            renderFullFaction(id, faction);
        }
        for (const [id, faction] of inCastKnownFaction) {
            const territoryStr = Array.isArray(faction.territory) ? faction.territory.join(', ') : faction.territory;
            const territory = territoryStr ? ` @ ${territoryStr}` : '';
            lines.push(`FACTION: ${faction.name || id} [KNOWN · on-stage]${territory} → id: ${id}`);
            if (faction.agenda) lines.push(`    Agenda: ${normalizeText(faction.agenda)}`);
        }
        for (const [id, faction] of offStagePrincipalFaction) {
            const rel = state.relationships?.[`pc-${id}`];
            const cardFrag = rel && rel.status === 'active'
                ? ` · ${formatCardName(rel.card)} ${rel.orientation}`
                : '';
            lines.push(`PRINCIPAL faction (off-stage): ${faction.name || id}${cardFrag} → id: ${id}`);
        }
        for (const [id, faction] of offStageTrackedFaction) {
            lines.push(`TRACKED faction (off-stage): ${faction.name || id} → id: ${id}`);
        }
        for (const [id, faction, rel] of dormantOnStageFaction) {
            lines.push(`DORMANT faction (on-stage): ${faction.name || id} · ${formatCardName(rel.card)} ${rel.orientation} → id: ${id}`);
        }
        // KNOWN factions rendered minimally when present (mirrors pre-refactor behavior of listing all)
        for (const [id, faction] of knownFactionList) {
            const territoryStr = Array.isArray(faction.territory) ? faction.territory.join(', ') : faction.territory;
            const territory = territoryStr ? ` @ ${territoryStr}` : '';
            const fState = faction.state ? ` [${faction.state}]` : '';
            lines.push(`  ${faction.name || id}${territory}${fState} → id: ${id}`);
        }
    }

    // Places — all entries; created by LLM as narrative discovers them
    const placeEntities = Object.values(state.places || {});
    if (placeEntities.length) {
        lines.push('');
        lines.push('Places:');
        for (const p of placeEntities) {
            lines.push(`  ${p.name || p.id} [${p.state || 'unknown'}] (${p.reach || 'LOCAL'}) → id: ${p.id}`);
            if (p.description) lines.push(`    ${p.description}`);
        }
    }

    // ── Current State Detail ──────────────────────────────────────────────
    lines.push('');
    lines.push('─── CURRENT STATE ───');


    // Power context — combat and full only (internalized after setup, not needed on regular turns)
    if (showConstants) {
        const w = state.world || {};
        const constantLines = [];
        if (w.power_scale) constantLines.push(`  Power Scale: ${normalizeText(w.power_scale)}`);
        if (w.power_ceiling != null) constantLines.push(`  Power Ceiling: ${w.power_ceiling}`);
        if (w.power_notes) constantLines.push(`  Power Notes: ${normalizeText(w.power_notes)}`);
        if (constantLines.length) {
            lines.push('');
            lines.push('POWER CONTEXT');
            lines.push(...constantLines);
        }
    }

    // World state — always shown
    if (state.world.world_state) {
        lines.push('');
        lines.push('WORLD STATE');
        lines.push(`  ${state.world.world_state}`);
    }

    // ── Mode-aware detail sections ────────────────────────────────────────

    // Collisions detail — all modes except lite
    if (!isLite) {
        const liveCollisions = Object.values(state.collisions).filter(
            cl => cl.status !== 'RESOLVED' && cl.status !== 'CRASHED'
        );
        if (liveCollisions.length) {
            lines.push('');
            lines.push('COLLISIONS');
            for (const col of liveCollisions) {
                const catLabel = col.distance_category ? ` ${col.distance_category}` : '';
                lines.push(`  ⊕ ${col.name || col.id} [${col.status}]${catLabel} dist:${col.distance ?? '?'} → id: ${col.id}`);
                const narrativeLines = getCollisionNarrativeLines(col);
                for (const narrativeLine of narrativeLines) {
                    lines.push(`    ${narrativeLine}`);
                }
            }
        }
    }

    // Combats detail — combat and full modes (routed through formatChallenge)
    if (showPower && activeCombats.length) {
        lines.push('');
        lines.push('COMBATS');
        for (const combat of activeCombats) {
            lines.push(...formatChallenge(combat, { compact: false }));
        }
    }

    // Factions detail — full mode only. Phase 2 schema: name/members/territory/state/agenda/knowledge_asymmetry.
    if (showFullDetail && factionEntities.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of factionEntities) {
            const header = [`  ${f.name || f.id}`];
            if (f.territory) {
                const territoryStr = Array.isArray(f.territory) ? f.territory.join(', ') : f.territory;
                header.push(`territory: ${territoryStr}`);
            }
            if (f.state) header.push(`state: ${f.state}`);
            lines.push(header.join(' | '));
            if (f.agenda) lines.push(`    Agenda: ${normalizeText(f.agenda)}`);
            const members = toList(f.members);
            if (members.length) lines.push(`    Members: ${members.join(', ')}`);
            const ka = f.knowledge_asymmetry;
            if (ka && typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const [k, v] of Object.entries(ka)) {
                    if (typeof v === 'string' && v) kaLines.push(`      ${k}: ${v}`);
                }
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            }
        }
    }

    // Pressure points — compact bullet list from pressure:<id> entities (§2.5)
    const pressureEntities = Object.values(state.pressures || {});
    if (pressureEntities.length) {
        lines.push('');
        lines.push('Pressure Points:');
        for (const p of pressureEntities) {
            const related = Array.isArray(p.related_to) && p.related_to.length
                ? ` → ${p.related_to.join(', ')}`
                : '';
            lines.push(`  • ${p.name || p.id} [${p.source || '?'}]${related}`);
        }
    }

    // Collision archive — inject last 5 entries when active pool is thin (≤ 2) (§4.3)
    if (includeArchive) {
        const archiveBlock = formatCollisionArchive(state);
        if (archiveBlock) {
            lines.push('');
            lines.push(archiveBlock);
        }
    }

    // PC dossier — traits & how-others-see-PC (intimacy and full modes).
    // Phase 2: "how X sees PC" lives in X.knowledge_asymmetry — look for keys mentioning pc.
    if (showIntimacy && state.pc.name) {
        lines.push('');
        lines.push(`PC DOSSIER: ${state.pc.name}`);
        const allTraits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
        const traitCap = isFull ? 10 : 5;
        const traits = allTraits.slice(-traitCap);
        if (traits.length) {
            const traitPrefix = allTraits.length > traitCap ? `  Traits (${allTraits.length} total, showing last ${traitCap}): ` : '  Traits: ';
            lines.push(`${traitPrefix}${traits.join(', ')}`);
        }
        const pcReads = [];
        for (const char of Object.values(state.characters)) {
            if (char.tier === 'UNKNOWN') continue;
            if (isIntimacy && !isFull && char.tier === 'KNOWN') continue;
            const ka = char.knowledge_asymmetry;
            if (!ka || typeof ka !== 'object' || Array.isArray(ka)) continue;
            const pcEntries = [];
            for (const [k, v] of Object.entries(ka)) {
                if (typeof v !== 'string' || !v) continue;
                if (k.endsWith('_pc') || k.includes('_pc_') || k.toLowerCase().includes(state.pc.name.toLowerCase())) {
                    pcEntries.push(`${k}: ${v}`);
                }
            }
            if (pcEntries.length) pcReads.push({ who: char.name || char.id, entries: pcEntries });
        }
        if (pcReads.length) {
            lines.push(`  How others see PC:`);
            for (const { who, entries } of pcReads) {
                lines.push(`    ${who}:`);
                for (const e of entries) lines.push(`      - ${e}`);
            }
        }
    }

    // Memorials — archived relationships whose target entity has been D'd
    {
        const memorials = [];
        for (const [relId, rel] of Object.entries(state.relationships || {})) {
            if (rel.status !== 'archived') continue;
            if (!relId.startsWith('pc-')) continue;
            const otherId = relId.slice('pc-'.length);
            const stillLive = state.characters?.[otherId] || state.factions?.[otherId];
            if (stillLive) continue;
            memorials.push([otherId, rel]);
        }
        if (memorials.length > 0) {
            lines.push('');
            lines.push(`MEMORIALS (${memorials.length}):`);
            for (const [otherId, rel] of memorials) {
                const displayName = rel.display_name || otherId;
                const reason = rel.last_shift?.reason
                    ? ` — ${normalizeText(rel.last_shift.reason).slice(0, 60)}`
                    : '';
                lines.push(`  † ${displayName} · ${formatCardName(rel.card)} ${rel.orientation}${reason}`);
            }
        }
    }

    // ── Token budget warning ──────────────────────────────────────────────
    const stateText = lines.join('\n');
    const approxTokens = Math.ceil(stateText.length / 4);
    if (approxTokens > 8000) {
        console.warn(`[GravityLedger:StateView] State view ~${approxTokens} tokens — over 8k budget. Consider consolidation.`);
    } else if (approxTokens > 6000) {
        console.warn(`[GravityLedger:StateView] State view ~${approxTokens} tokens — approaching 6k budget.`);
    }

    lines.push('');
    lines.push('═══ END STATE VIEW ═══');
    return lines.join('\n');
}


export {
    formatStateView,
    computeArchiveVersion,
};
