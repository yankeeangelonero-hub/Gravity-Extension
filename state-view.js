/**
 * state-view.js — Format computed state for prompt injection.
 *
 * Provides two format functions:
 * 1. formatStateView(state) — full state overview injected via setExtensionPrompt
 * 2. formatReadme() — command format reference injected via setExtensionPrompt
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

/**
 * Format the ledger readme — command reference, format spec, writing guide, and examples.
 * @returns {string}
 */
function formatReadme(mode = 'full') {
    if (mode === 'core') return formatReadmeCore();
    return formatReadmeFull();
}

/**
 * Core readme — minimal syntax reference with one example per operation.
 * Used on regular and advance turns to save ~2000 tokens.
 */
function formatReadmeCore() {
    return `=== GRAVITY STATE DELTA - QUICK REFERENCE ===

Normal prose turns use a compact ---STATE--- block.
Structural turns (setup, heavy cleanup) may still use full ---LEDGER--- syntax.

STANDARD SHAPE:
---STATE---
at: [Day N - HH:MM]
scene: "Where. Who's present. What's happening. Emotional atmosphere."
pc.location: "where the PC is now"
char:elena.knowledge_asymmetry.weapon_concealed: "PC is armed but hiding it under coat"
char:elena.knowledge_asymmetry.sender_unknown: "does not know who sent them"
char:elena.knowledge_asymmetry.owner_already_warned: "already warned the owner — hiding this from PC"
char:elena.last_seen_at: "[Day 2 - 19:10]"
faction:zaft.knowledge_asymmetry.archangel_status: "ship escaped damaged"
faction:zaft.knowledge_asymmetry.archangel_pilot_unknown: "Strike pilot identity unknown"
faction:zaft.knowledge_asymmetry.misreads_pilot_as_unconfirmed: "Assumes pilot still unconfirmed"
faction:zaft.agenda: "Recover the N-Jammer cores before the Alliance regroups"
collision:trust-vs-duty.distance_category: SHORT
constraint:c1.integrity: STRESSED
char:elena.knowledge_asymmetry.misreads_pc_as_cautious_ally: "Reads PC as a cautious ally but will not say so"
world.collision_archive+: "[collision] ... [id <collision-id>] [resolution] ... [hook] ... [aftermath] ..."
---END STATE---

PATH RULES:
  path: value              -> set field
  path+: value             -> append to array
  path-: value             -> remove from array
  entity.field.key: value  -> map set
  entity.field.key: delete -> map delete
  scene: "..."             -> shorthand for pc.current_scene
  at: [Day N - HH:MM]      -> block timestamp for every line below it

COMMON PATHS:
  pc.location
  pc.current_scene (or scene)
  pc.equipment
  char:id.location
  char:id.knowledge_asymmetry.<flat_semantic_key>   (e.g., weapon_concealed, lying_about_alibi, misreads_intent_as_friendly)
  char:id.last_seen_at
  char:id.agenda
  faction:id.name
  faction:id.territory                              (array of place ids: [place:warehouse, place:docks])
  faction:id.state
  faction:id.agenda
  faction:id.members+
  faction:id.knowledge_asymmetry.<flat_semantic_key>   (e.g., archangel_status, pilot_identity_unknown, misreads_pilot_as_unconfirmed)
  place:id.name
  place:id.state
  place:id.reach
  place:id.description
  collision:id.name
  collision:id.forces
  collision:id.distance_category   (set on creation: IMMEDIATE|SHORT|MEDIUM|LONG)
  collision:id.distance             (engine-owned — read only; do not SET)
  collision:id.ignition_class      (set on creation: clock|tripwire|revelation|decision|accumulator — how it fires)
  collision:id.fires_when           (set on creation: one sentence — the concrete scene condition that counts as this firing)
  collision:id.location
  collision:id.involved_chars
  collision:id.status
  collision:id.outcome_type
  collision:id.aftermath
  collision:id.successor_collision_ids+
  collision:id.parent_collision_ids+
  world.timeskip_scale              (advance turns only: HOURS|DAYS|WEEKS|MONTHS)
  combat:id.status
  combat:id.primary_enemy
  combat:id.opened_from
  combat:id.outcome
  combat:id.aftermath
  constraint:id.integrity
  world.world_state
  pressure:id.name
  pressure:id.source
  pressure:id.related_to
  world.collision_archive+

STATE MACHINES:
  char tier: UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL
  constraint integrity: STABLE -> STRESSED -> CRITICAL -> BREACHED
  collision status: ACTIVE -> RESOLVED (or ACTIVE -> CRASHED if ignored)
  combat status: ACTIVE -> RESOLVED
For these fields, write the NEW state only. The extension will compile the transition.

RARE OPS INSIDE STATE BLOCK:
  create char:dak name="Dak" tier=KNOWN
  create place:warehouse-district name="Warehouse District" state=contested reach=DISTRICT description="Industrial sprawl south of the river."
  create pressure:border-tension name="Border tension" source="faction:vela" related_to=[char:pc,faction:vela]
  destroy pressure:border-tension
  destroy char:minor-npc
If a turn gets structurally complicated, switch to a full ---LEDGER--- block instead.

DISCIPLINE:
  Only write what changed materially.
  Keep knowledge_asymmetry current on TRACKED/PRINCIPAL characters when they are active or scene-relevant. knowledge_asymmetry is a FLAT map of semantic keys — pick a short, meaningful key per fact (e.g., weapon_concealed, lying_about_alibi, misreads_pc_as_friendly, owner_already_warned). Add or remove individual keys; never overwrite the whole field.
  Use misreads_* keys for false beliefs (e.g., misreads_pilot_as_unconfirmed).
  KNOWN characters inherit knowledge from their faction's knowledge_asymmetry. Only set individual knowledge_asymmetry keys on a KNOWN character when they learn something their faction does not know yet.
  If the protagonist also exists as char:<pc-id>, treat pc and char:<pc-id> as separate surfaces: pc carries immediate scene/body state, while char:<pc-id> carries the social/knowledge dossier. Updating pc.* does not update the mirrored char dossier.
  Do not globally synchronize off-screen knowledge. Refresh a character's knowledge_asymmetry when they re-enter scene or receive a plausible report, signal, witness account, or sensor update.
  Use faction knowledge_asymmetry for remote awareness — flat map of semantic keys (e.g., archangel_status, pilot_identity_unknown, hiding_supply_route, misreads_alliance_intent), cap 20 keys total. Update after plausible intel events; do not globally synchronize.
  No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them.
  NESCIENCE discipline (Theory of Mind — each character/faction knows only what they realistically observed, heard, deduced from evidence they have access to, or were told via a plausible channel). Avoid "Sherlock Holmes" leaps — explore obliviousness as much as insight. News and rumors travel on channels with latency and distortion; absence from a scene means absence of knowledge until a plausible report arrives. Communication-media rule: only the originator or recipient of a message knows its contents. Before updating knowledge_asymmetry, check past turns — do not contradict established knowledge states without explicit revelation.
  Combat is a thin container. Scene prose carries terrain and tactical narrative; the spawning collision carries cost and forces. Combat tracks only: who's fighting whom (primary_enemy), and what ended where (outcome + aftermath on RESOLVED).
  Every live collision needs a story capsule: what is converging (forces), who is caught in it (involved_chars), what it costs and what will concretely happen when it lands (cost). The \`cost\` field is the success condition — if the player addresses the scenario it describes, the collision is pre-empted and should be DISSOLVED or RESOLVED immediately, even if distance > 0.
  Every collision needs an ignition spec on creation: ignition_class (clock|tripwire|revelation|decision|accumulator) and fires_when (one sentence naming the concrete scene condition that counts as this firing). If you cannot name a concrete trigger, the thing is a constraint, not a collision — file it as a constraint instead. Defaults to clock if omitted, but state it explicitly so the arrival check has something to test against.
    - clock: fires when distance ticks to 0 (default — for time-pressured convergences)
    - tripwire: fires when named characters meet a specific scene condition (e.g., "Flay and Lacus in the same unsupervised corridor")
    - revelation: fires when a specific piece of information becomes known (e.g., "Mu names the Resonance aloud to Autumn")
    - decision: fires when a named character commits to a pending choice (e.g., "Ramius signs the POW custodial order")
    - accumulator: fires when repeated small beats cross a threshold (e.g., "third Flay incident that the crew can no longer explain away")
  Pressure points (pressure:<id>) are seeds — small tensions not yet a collision. Cap is 5; oldest auto-drops on overflow. Destroy when consumed: D pressure:<id>.
  If 3+ related pressure points accumulate, combine them into a collision (CR collision) and destroy the consumed pressures.
  WEEKS or MONTHS advance scales automatically clear all pressure points — the engine handles this.
  Collision closure grammar: inside ---STATE--- blocks use dotted-path form — collision:id.status: RESOLVED (and .outcome_type, .aftermath). Do NOT use ledger verb syntax (TR collision:id field=status from=ACTIVE to=RESOLVED) inside STATE blocks — verb syntax is REJECTED; move it to a ---LEDGER--- block.
  key_moments are permanent under 100 entries per character. When a character's key_moments list hits 100, drop the oldest or least load-bearing entry with a full-array SET (not a partial REMOVE) before adding a new one. This is infrequent given the high cap.
  Cleanup is still capped on normal turns; save bulk pruning for eval or OOC: eval.
  On advance turns, emit: world.timeskip_scale: HOURS|DAYS|WEEKS|MONTHS (default HOURS). WEEKS and MONTHS clear all pressure points.
  Scene time on non-advance turns: ≤15 min in-world. Non-IMMEDIATE collisions cannot arrive in real-time — use ADVANCE to tick clocks.

=== END QUICK REFERENCE ===`;
}

/**
 * Full readme — complete reference with all examples and field documentation.
 * Used on integration turns (setup, heavy cleanup) where heavy ledger work is needed.
 */
function formatReadmeFull() {
    return `═══ GRAVITY LEDGER — COMMAND FORMAT ═══

LEDGER BLOCK — append after EVERY response, one command per line:

---LEDGER---
> [Day 1 — 21:15] CREATE char:ada-wong name="Ada Wong" tier=KNOWN -- First encounter
> [Day 1 — 21:15] SET world field=world_state value="Rainy night in the district" -- Atmosphere
> [Day 1 — 21:15] MOVE constraint:c1-detachment field=integrity STABLE->STRESSED -- Pressure from encounter
---END LEDGER---

Empty turn (nothing changed):
---LEDGER---
(empty)
---END LEDGER---

SYNTAX: > [timestamp] OPERATION entity_type:entity_id key=value key="multi word" -- reason
  - One line per transaction. Each line is independent.
  - Timestamps: [Day N — HH:MM]
  - Entity types: char, constraint, collision, combat, faction, place, pressure, world, pc, divination
  - Singletons (no :id needed): world, pc, divination
  - IDs: kebab-case, stable, never change once assigned
  - Reason after -- is required, keep it brief like margin notes
  - Quoted values: use "double quotes" for multi-word values

OPERATIONS:

CREATE — new entity
  > CREATE char:tifa name="Tifa Lockhart" tier=KNOWN -- First encounter
  > CREATE constraint:c1-steady name="The Steady One" owner_id=tifa integrity=STABLE prevents="Showing vulnerability or exhaustion" threshold="Sustained pressure from someone trusted" replacement="Regression — stillness without purpose" replacement_type=regression shedding_order=2 -- Core constraint
  > CREATE collision:trust-vs-duty name="Trust vs Duty" distance_category=MEDIUM ignition_class=tripwire fires_when="Tifa and Kenji are alone in a room where she can ask about Cloud without interruption" forces="Trust and duty converging — loyalty demands truth, mission demands silence." cost="Tifa will corner Kenji about Cloud's location. If he lies she will know; if he tells the truth the mission is blown. One conversation, forced choice." involved_chars=[tifa,kenji] location=7th-heaven -- Central tension
  > CREATE combat:alley-fight status=ACTIVE primary_enemy="shinra-sweep" opened_from=ambush-trap -- Thin combat container; scene + collision carry the tactical narrative
  > CREATE place:warehouse-district name="Warehouse District" state=contested reach=DISTRICT description="Industrial sprawl south of the river. Quiet during daylight." -- New anchor

  Place fields: name, state (safe/contested/hostile/destroyed/unknown or freeform), reach (LOCAL/DISTRICT/CITY/REGIONAL/REMOTE), description.
  reach defaults to LOCAL. Set accurately — engine uses it for travel plausibility checks (non-advance turns cap at DISTRICT).

  Constraint fields: name, owner_id, integrity, prevents, threshold, replacement, replacement_type (sophistication/displacement/depth_shift/regression), shedding_order, current_pressure
  Update current_pressure with SET whenever pressure changes:
  > SET constraint:c1-steady field=current_pressure value="Arms uncrossed involuntarily. The softening was visible." -- C1 eased instead of held

MOVE — state machine transition (no skipping levels)
  > MOVE char:tifa field=tier KNOWN->TRACKED -- Promoted after trust scene
  > MOVE constraint:c1-secret field=integrity STABLE->STRESSED -- Pressure from collision
  > MOVE collision:trust-vs-duty field=status ACTIVE->RESOLVED -- Collision resolved on-screen

SET — overwrite a field
  > SET world field=world_state value="Martial law declared" -- Major world change
  > SET combat:alley-fight field=outcome value="Team broke left, neutralized sweep, runner made the doorway" -- On RESOLVED
  > SET combat:alley-fight field=aftermath value="One sweep operative wounded; runner bleeding; cover compromised" -- What remains

APPEND — add to an array field
  > APPEND char:tifa field=key_moments value="[moment] Confronted Cloud about the well memories, voice cracking on his name [hook] He still hasn't asked her about Sephiroth [weight] First time she's seen the cracks in his composure — the persona is starting to slip" -- Pivotal scene
  > APPEND world field=collision_archive value="[collision] Ada betrayal [id ada-betrayal] [resolution] on-screen — PC caught her at the handoff [hook] the flash drive she dropped; eye contact [aftermath] trust cracked" -- Resolved collision

REMOVE — remove from an array field
  > REMOVE faction:shinra field=members value="char:tseng" -- Member departed
  (key_moments are only trimmed via full-array SET at the 100-cap boundary; no partial REMOVE.)

MAP_SET — set a key in a map field
  > MAP_SET char:elena field=knowledge_asymmetry key=misreads_pc_as_cautious_ally value="Reads PC as cautious but will not say so" -- Flat semantic key
  > SET world field=power_scale value="1=trained but ordinary, 3=elite specialist, 5=setting-defining monster" -- Set combat power ladder
  > SET world field=power_ceiling value=5 -- Highest credible direct-combat level in this setting
  > SET pc field=power_base value=3 -- Earned combat level when healthy
  > SET pc field=power value=3 -- Current effective combat level
  > SET pc field=power_basis value="Master swordsman with real battlefield experience and disciplined footwork" -- Why the rating is justified
  > APPEND pc field=abilities value="Fast draw and counter timing" -- Combat capability

COMBAT OPTION HTML — when combat mode asks for options, use this exact clickable format:
  <span class="act" data-value="combat: option | 1 | Highly likely | Break left through the gap and take the nearest rifle offline">Break left through the gap (Highly likely)</span>

INTIMATE HISTORY — per-character map tracking sexual development over time.
  Update keys via MAP_SET after intimate scenes. These are CUMULATIVE — each update builds on previous entries.
  Standard keys:
    encounters     — count + dates. Brief note on each (what happened, what was different).
    dynamic        — who initiates, who leads, power balance, emotional tone during. How has this shifted?
    preferences    — what this character has DISCOVERED they like. Updated as they learn — not assumed upfront.
                     Include what worked, what surprised them, what they asked for again.
    boundaries     — what they've hit, what made them stop or freeze, what they're not ready for yet.
                     Boundaries can shift (both directions) — note when and why.
    evolution      — how their sexual relationship has CHANGED over time. Early awkwardness → comfort?
                     Growing trust → new vulnerability? Routine → staleness? Track the arc.
    aftermath      — how they behave AFTER intimacy. Do they pull closer or pull away? Talk or go silent?
                     Sleep or leave? This reveals more than the act itself.
  > MAP_SET char:tifa field=intimate_history key=encounters value="3 — [Day 2] first, tentative, stopped early; [Day 4] slower, more confident, she initiated; [Day 6] first time she didn't pull the sheet up after" -- Cumulative
  > MAP_SET char:tifa field=intimate_history key=preferences value="Discovered she likes his hands on her waist — holds them there. Doesn't like being pinned — freezes, he learned to read it." -- Learned through experience
  > MAP_SET char:tifa field=intimate_history key=dynamic value="She initiates now. Took 3 encounters to stop letting him lead everything. Still won't ask for what she wants out loud — shows with her hands instead." -- Pattern shift

═══ WRITING INTIMATE SCENES ═══

Sex is not a reward. It is two people navigating consent, desire, fear, trust, and their own damage.
The system tracks this through intimate_history (what happened) and knowledge_asymmetry (what they hide or misread about each other).

CONSENT IS ONGOING:
  - Consent is not a gate that opens once. It is active, every moment.
  - Characters can say yes and then stop. Can want something and not be ready.
  - Can be ready and change their mind. This is not failure — it is realism.
  - "I want to" and "I can" are different sentences. Both must be true.

DISCOVERY, NOT PERFORMANCE:
  - First times are awkward. People learn what works. Chemistry is built, not assumed.
  - Something that works once might not work again. Bodies are not machines.
  - Characters discover preferences they didn't know they had — and limits they didn't expect.
  - Write the learning, not the choreography.

BOUNDARIES ARE FOUND BY BUMPING INTO THEM:
  - Characters don't know all their limits upfront. Some are discovered mid-scene.
  - A hand moves somewhere and the body tenses. A word lands wrong. A position triggers a memory.
  - These moments are not interruptions — they ARE the scene. Write them.
  - After a boundary is found: the response matters more than the boundary itself.

THE RELATIONSHIP SHAPES THE SEX, THE SEX SHAPES THE RELATIONSHIP:
  - Intimate scenes feed back into constraint states, reads, trust, and character dynamics.
  - After intimacy: UPDATE intimate_history, knowledge_asymmetry (hiding/misreading), and relevant constraints.
  - What happens in bed doesn't stay in bed. It changes how characters look at each other at breakfast.

UNHEALTHY PATTERNS ARE VALID NARRATIVE:
  - Not every sexual relationship is healthy. Characters can use sex to avoid vulnerability,
    to control, to self-destruct, to prove something, to fill a void.
  - Track the DYNAMIC, not just the acts. The system records patterns, not just events.
  - An unhealthy dynamic is a collision seed. Track it. Let it detonate.

CHECKING BOUNDARIES:
  Before writing ANY intimate escalation, consult the character's knowledge_asymmetry
  (what they hide, what they fear, what they misread), their relationships, and their recent
  intimate_history. Write from who they are in the moment:
  - If they would freeze, they freeze. Write the freeze.
  - If they would reciprocate but not initiate, they do not initiate.
  - Default posture when undocumented: guarded — boundaries must be discovered.
  - The player's desire does not override the character's agency.

UPDATING THE DOSSIER:
  Intimate shifts land on intimate_history (what happened) and knowledge_asymmetry
  (what changed in what they know, hide, or misread). Shifts are earned by narrative —
  constraint breaches, trust built through action (not words), vulnerability reciprocated,
  time together, conflict survived. Never shift because the player pushed.
  A character's guarded posture can also TIGHTEN after betrayal or trauma — capture that
  shift in knowledge_asymmetry (hiding/misreading) and, if a constraint is involved, in its
  integrity TR.

═══ END INTIMACY GUIDE ═══

MAP_DEL — remove a key from a map field
  > MAP_DEL char:tifa field=knowledge_asymmetry key=hiding_secret_from_barret -- Reveal no longer relevant

DESTROY — remove an entity permanently
  > DESTROY char:minor-npc -- Left the story

FACTIONS — create and manage factions as organizations with territory, agenda, and asymmetric knowledge
  > CREATE faction:shinra name="Shinra Corp" territory=[place:midgar-plate] state="dominant" agenda="Consolidate reactor control before the Wutai investigation lands" -- Phase 2 shape
  > SET faction:shinra field=state value="declining" -- Lost reactor control
  > SET faction:shinra field=agenda value="Recover reactor control before the board meets" -- Agenda shifts with story
  > APPEND faction:shinra field=members value="char:tseng" -- Named member
  > MAP_SET faction:zaft field=knowledge_asymmetry key=archangel_status value="Ship escaped damaged" -- Confirmed intel
  > MAP_SET faction:zaft field=knowledge_asymmetry key=archangel_pilot_unknown value="Strike pilot identity unknown" -- Known gap
  > MAP_SET faction:zaft field=knowledge_asymmetry key=misreads_pilot_as_unconfirmed value="Assumes pilot still unconfirmed" -- False belief

  Faction fields (Phase 2): name, members (array of char: ids or string names), territory (array of place: ids), state,
  agenda, knowledge_asymmetry (flat map of semantic keys, cap 20 total).
  Pressure points (pressure:<id> entities) are collision fuel — small tensions not yet collisions.
  Cap is 5; oldest auto-drops on overflow. Destroy when consumed into a collision.
  > CREATE pressure:perimeter-tension name="Demon scouts testing church perimeter" source="faction:demon-vanguard" related_to=[char:pc,place:church] -- New seam
  > CREATE collision:closing-perimeter name="The Closing Perimeter" distance_category=SHORT ignition_class=clock fires_when="demon scouts reach the perimeter and PC has not evacuated or fortified" forces="demon advance, trapped survivors" cost="The demon scouts will breach the church perimeter. If PC hasn't evacuated or fortified by then, survivors die in the crossfire." involved_chars=[pc] location=church -- Seam graduates
  > DESTROY pressure:perimeter-tension -- Consumed into collision

DIVINATION — engine-owned (do NOT write these yourself)
  The engine commits divination draws automatically. Do NOT write divination.last_draw, divination.card, or divination.orientation yourself.

STATE MACHINES (MOVE between adjacent states only, no skipping):
  Character tier:       UNKNOWN → KNOWN → TRACKED → PRINCIPAL
  Constraint integrity: STABLE → STRESSED → CRITICAL → BREACHED (terminal)
    Relief reverse:     CRITICAL → STRESSED → STABLE
  Collision status:     ACTIVE → RESOLVED (or ACTIVE → CRASHED if ignored)

COLLISIONS ARE STORY ENGINES, NOT LABELS:
  Every live collision should tell you, cold:
  1. what is converging (forces — the named tensions)
  2. what the scenario IS (cost — the concrete thing that will happen when it lands)
  3. how it fires (ignition_class + fires_when — the trigger that counts as arrival)
  4. who is in the line of fire (involved_chars)
  5. where it is landing (location)
  6. how close it is (distance_category → distance)
  7. what status it sits in (ACTIVE → RESOLVED or CRASHED)

  The \`cost\` field is the scenario contract. It must describe, in concrete terms:
  - What event or confrontation will occur when this collision arrives
  - What it costs the people involved (stakes)
  - What "resolved" looks like (so you can recognize when the player pre-empts it)
  If the player addresses the scenario described in \`cost\` before distance hits 0, the collision
  is pre-empted — DISSOLVE or RESOLVE it immediately. Do not let a collision arrive mechanically
  when its scenario has already been handled narratively.

  The \`ignition_class\` + \`fires_when\` pair is the firing contract. Pick one class on creation:
  - clock: time-pressured. Fires when distance ticks to 0. Use for convergences that need time to arrive.
  - tripwire: condition-pressured. Fires when a specific scene condition is met (named characters colocated, a line crossed, a door opened). Distance is advisory only.
  - revelation: information-pressured. Fires when a specific piece of information becomes known (someone names the secret, evidence surfaces, the mask slips).
  - decision: agency-pressured. Fires when a named character commits to a pending choice (an order signed, a line spoken, a deal accepted).
  - accumulator: pressure-pressured. Fires when repeated small beats cross a threshold (Nth incident, sustained hostility reaches breaking point).

  \`fires_when\` is a one-sentence concrete trigger. It is the test you apply at arrival: if the current scene satisfies it, the collision fires ON-SCREEN; if not, prefer DISSOLVE or IMPLODE over forcing a scene the trigger hasn't actually earned.

  If you cannot name a concrete \`fires_when\`, the thing is an ongoing condition, not a collision — file it as a constraint (constraint:<id> with integrity STABLE→STRESSED→CRITICAL→BREACHED) instead. Constraints model ongoing fields; collisions model events that arrive.

  \`forces\` names the tensions. \`cost\` describes the scene that will happen. \`ignition_class\` + \`fires_when\` describe how it fires. All four are required on creation.

COLLISION CLOSURE (required on every RESOLVED transition):
  Every collision that reaches RESOLVED must record three fields:
  > SET collision:id field=outcome_type value=DIRECT     -- Player engaged and shaped the result
  > SET collision:id field=outcome_type value=EVOLVED    -- Resolution revealed a deeper tension; a successor collision spawned
  > SET collision:id field=outcome_type value=MERGED     -- This collision was absorbed into another active collision
  > SET collision:id field=outcome_type value=DISSOLVED  -- Off-screen end with no successor; forces dispersed quietly
  > SET collision:id field=outcome_type value=IMPLODED   -- Collision collapsed internally (betrayal, self-destruction, internal failure before it reached the player)
  > SET collision:id field=outcome_type value=CRASHED    -- Player ignored it; gravity resolved it; worst outcome
  > SET collision:id field=aftermath value="What changed. What was lost. What it left behind."
  For EVOLVED: add successor_collision_ids on this collision; add parent_collision_ids on the new successor.
  For MERGED: add parent_collision_ids on the surviving (still-ACTIVE) collision pointing back to this one. No successor_collision_ids on the merged collision — it was absorbed, not spawned.
  For DISSOLVED / IMPLODED / CRASHED: no successor/parent linkage.

  IMPLODED example — the secret-holder breaks before the confrontation:
  > MOVE collision:loyalty-trap field=status ACTIVE->RESOLVED
  > SET collision:loyalty-trap field=outcome_type value=IMPLODED
  > SET collision:loyalty-trap field=aftermath value="Mira confessed before Autumn could corner her — not from guilt, from fear. The confrontation Autumn had been building toward never happened. What remains is not resolution but rubble: a confession that arrived too fast to trust, and a debt she didn't earn."

  EVOLVED example — resolution surfaces a new tension:
  > MOVE collision:shadow-activity field=status ACTIVE->RESOLVED
  > SET collision:shadow-activity field=outcome_type value=EVOLVED
  > SET collision:shadow-activity field=aftermath value="The watcher was neutralized, but not before transmitting. Someone now knows Arcueid is in the district."
  > APPEND collision:shadow-activity field=successor_collision_ids value=handler-convergence
  > CREATE collision:handler-convergence name="Handler Convergence" distance_category=SHORT ignition_class=clock fires_when="handlers reach the safehouse before PC has moved Arcueid or prepared an exit" forces="handler network advancing on Arcueid; if they move first extraction becomes impossible" cost="Handlers will arrive at the safehouse. If PC hasn't moved Arcueid or prepared an exit by then, extraction becomes a fight instead of a disappearance." location=district-safehouse involved_chars=[pc,arcueid] parent_collision_ids=[shadow-activity]

HYGIENE — keep arrays clean (incrementally, 2–3 REMOVEs per turn max):
  - Pressure points: REMOVE when activated (converted into collision fuel) or no longer relevant. These are seeds, not history.
  - Before APPEND: check if a similar entry already exists. Update or skip, don't duplicate.

VOLUME PER TURN (HARD CAP: 20 lines — excess lines are DROPPED):
  Quiet dialogue: 1–2 | Normal: 2–4 | Action: 4–6 | Heavy (setup): 6–12
  NEVER dump bulk REMOVE operations. Prune 2–3 stale entries per turn.

PRIORITY ORDER — when near the cap, emit in this order:
  1. State machine transitions  2. Collision distance  3. agenda / knowledge_asymmetry  4. World state
  5. Faction updates  6. Key moments  7. Scene / PC location  8. Intimate history
  9. REMOVEs — always last, 2–3 max

OOC COMMANDS (player types in chat):
  OOC: snapshot | rollback | rollback to #N | eval | history [id] | archive
  OOC: power review pc
  OOC: power review char:id
  OOC: power review all
  OOC: power pc 3              -- Manual current-power override
  OOC: power base pc 3         -- Manual base-power override

═══ END LEDGER README ═══`;
}


export {
    formatStateView,
    formatReadme,
    computeArchiveVersion,
};
