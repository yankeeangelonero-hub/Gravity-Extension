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

// reads.<target> is an append-log array capped at 5; string values are legacy
function getLatestRead(readsObj, key) {
    const val = readsObj?.[key];
    if (!val) return null;
    if (Array.isArray(val)) return val.length ? val[val.length - 1] : null;
    return val;
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

function getCollisionNarrativeLines(col, options = {}) {
    const lines = [];
    const details = normalizeText(col?.details);
    const forces = getCollisionForcesText(col);
    const cost = normalizeText(col?.cost);
    const targetConstraint = normalizeText(col?.target_constraint);
    const includeForces = options.includeForces !== false;

    if (details) lines.push(`Thread: ${details}`);
    else if (forces) lines.push(`Forces: ${forces}`);

    if (includeForces && details && forces) lines.push(`Forces: ${forces}`);
    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);

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
    return `${archiveEntries.length}:${thin}`;
}

function formatStateView(state, mode = 'full', includeArchive = true) {
    const lines = [];
    // ── Mode flags ────────────────────────────────────────────────────────
    const isLite = (mode === 'lite');
    const isCombat = (mode === 'combat');
    const isIntimacy = (mode === 'intimacy');
    const isFull = (mode === 'full');
    // Derived feature flags
    const showPower = isCombat || isFull;          // power tags, abilities, wounds
    const showIntimacy = isIntimacy || isFull;      // intimacy_stance, reads, traits
    const showConstraintDetail = isIntimacy || isFull; // full constraint profile
    const showConstants = isCombat || isFull;       // power scale/ceiling/notes
    const showFullDetail = isFull;                  // faction detail, full PC dossier

    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // ── Entity Registry ──────────────────────────────────────────────────
    lines.push('ENTITY REGISTRY — use these IDs in ledger transactions');

    // Characters — tier-aware rendering
    lines.push('');
    lines.push('Characters:');
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        const tier = char.tier || 'KNOWN';
        const isPrincipal = tier === 'PRINCIPAL';
        const isTracked = tier === 'TRACKED';
        const isKnown = tier === 'KNOWN';

        // Header line — power tag only in combat/full
        let charLine = `  ${tier} "${char.name || char.id}"`;
        if (showPower) charLine += formatPowerTag(char);
        charLine += ` → id: ${char.id}`;
        lines.push(charLine);

        // Location — all tiers
        if (char.location) lines.push(`    Location: ${char.location}`);

        // KNOWN tier: name + location only (knowledge proxied by faction intel)
        if (isKnown) continue;

        // TRACKED+ fields: knowledge_asymmetry, last_seen_at
        const ka = char.knowledge_asymmetry;
        if (ka !== undefined && ka !== null) {
            if (typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                    const map = ka[bucket];
                    if (map && typeof map === 'object' && Object.keys(map).length) {
                        const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
                        for (const [k, v] of Object.entries(map)) {
                            kaLines.push(`      [${label}] ${k}: ${v}`);
                        }
                    }
                }
                if (ka.legacy) kaLines.push(`      [legacy] ${ka.legacy}`);
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            } else if (typeof ka === 'string' && ka) {
                lines.push(`    Knowledge asymmetry: ${normalizeText(ka)}`);
            }
        }
        if (char.last_seen_at !== undefined && char.last_seen_at !== null && normalizeText(char.last_seen_at)) {
            lines.push(`    Last seen at: ${normalizeText(char.last_seen_at)}`);
        }

        // Condition — PRINCIPAL always, TRACKED only in combat/full
        if (isPrincipal && char.condition) {
            lines.push(`    Condition: ${char.condition}`);
        } else if (isTracked && showPower && char.condition) {
            lines.push(`    Condition: ${char.condition}`);
        }

        // Combat fields — only in combat/full
        if (showPower) {
            if (char.power_basis) lines.push(`    Power basis: ${char.power_basis}`);
            const abilities = toList(char.abilities);
            if (abilities.length) lines.push(`    Abilities: ${abilities.join(' | ')}`);
            if (char.wounds && typeof char.wounds === 'object' && Object.keys(char.wounds).length) {
                const woundList = Object.entries(char.wounds).map(([k, v]) => `${k}: ${v}`).join(', ');
                lines.push(`    Wounds: ${woundList}`);
            }
        }

        // Intimacy fields — only in intimacy/full
        if (showIntimacy && char.intimacy_stance) {
            lines.push(`    Intimacy stance: ${char.intimacy_stance}`);
        }

        // Key moments — tier-aware capping
        const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
        let momentCap;
        if (isFull) momentCap = Infinity;
        else if (isCombat || isIntimacy) momentCap = isPrincipal ? 5 : 3;
        else momentCap = isPrincipal ? 3 : 1; // lite
        const displayMoments = momentCap === Infinity ? moments : moments.slice(-momentCap);
        if (displayMoments.length) {
            const capNote = moments.length > displayMoments.length ? `, showing last ${displayMoments.length}` : '';
            lines.push(`    Key moments (${moments.length}${capNote}):`);
            for (const m of displayMoments) lines.push(`      - ${m}`);
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
            let cLine = `  ${c.name} [${c.integrity}] (${ownerName})`;
            if (c.shedding_order) cLine += ` shed:${c.shedding_order}`;
            cLine += ` → id: ${c.id}`;
            lines.push(cLine);
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
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
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

    // Combats — always show registry if active
    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            let combatLine = `  ${combat.name || combat.id} [${combat.status || 'ACTIVE'}]`;
            if (combat.primary_enemy) {
                const pe = typeof combat.primary_enemy === 'object' ? (combat.primary_enemy.name || combat.primary_enemy.id || '?') : combat.primary_enemy;
                combatLine += ` vs ${pe}`;
            }
            if (combat.opened_from) combatLine += ` (from collision:${combat.opened_from})`;
            combatLine += ` → id: ${combat.id}`;
            lines.push(combatLine);
        }
    }


    // Singletons — PC fields are mode-aware
    lines.push('');
    lines.push('Singletons (no id needed):');
    lines.push('  world — constants, world_state, collision_archive');
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

    // Factions — lite/combat/intimacy: name + stance + power; full: detail section below
    const factionEntities = Object.values(state.factions || {});
    const legacyFactions = Array.isArray(state.world.factions) ? state.world.factions : [];
    if (factionEntities.length || legacyFactions.length) {
        lines.push('');
        lines.push('Factions:');
        for (const f of factionEntities) {
            if (!showFullDetail) {
                const fStance = getLatestRead(f.reads, 'pc') || f.stance_toward_pc || '?';
                const fPower = f.power ? ` [${f.power}]` : '';
                lines.push(`  ${f.name || f.id}${fPower} | Stance: ${fStance} → id: ${f.id}`);
            } else {
                lines.push(`  ${f.name || f.id} → id: ${f.id}`);
            }
        }
        for (const f of legacyFactions) {
            if (typeof f === 'object' && f.name) {
                const alreadyListed = factionEntities.some(fe => fe.name === f.name);
                if (!alreadyListed) lines.push(`  ${f.name}: ${f.objective || ''} | Stance: ${f.stance_toward_pc || '?'}`);
            } else if (typeof f === 'string') {
                lines.push(`  ${f}`);
            }
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


    // Constants — combat and full only (internalized after setup, not needed on regular turns)
    if (showConstants) {
        const cn = state.world.constants || {};
        const constantLines = [];
        if (cn.power_scale) constantLines.push(`  Power Scale: ${normalizeText(cn.power_scale)}`);
        if (cn.power_ceiling != null) constantLines.push(`  Power Ceiling: ${cn.power_ceiling}`);
        if (cn.power_notes) constantLines.push(`  Power Notes: ${normalizeText(cn.power_notes)}`);
        if (constantLines.length) {
            lines.push('');
            lines.push('CONSTANTS');
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
            cl => cl.status !== 'RESOLVED' && cl.status !== 'SEEDED'
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

    // Combats detail — combat and full modes
    if (showPower && activeCombats.length) {
        lines.push('');
        lines.push('COMBATS');
        for (const combat of activeCombats) {
            lines.push(`  ⚔ ${combat.name || combat.id} [${combat.status || 'ACTIVE'}] → id: ${combat.id}`);
            if (combat.primary_enemy) {
                const pe = typeof combat.primary_enemy === 'object' ? (combat.primary_enemy.name || combat.primary_enemy.id || '?') : combat.primary_enemy;
                lines.push(`    Primary enemy: ${pe}`);
            }
            if (combat.opened_from) lines.push(`    Opened from: collision:${combat.opened_from}`);
            if (combat.outcome) lines.push(`    Outcome: ${combat.outcome}`);
            if (combat.aftermath) lines.push(`    Aftermath: ${combat.aftermath}`);
        }
    }

    // Factions detail — full mode only
    if (showFullDetail && factionEntities.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of factionEntities) {
            if (f.profile) {
                lines.push(`  ${f.name || f.id}: ${f.profile}`);
            } else {
                let line = `  ${f.name || f.id}: ${f.objective || ''}`;
                line += ` | Resources: ${f.resources || '?'}`;
                const factionStance = getLatestRead(f.reads, 'pc') || f.stance_toward_pc || '?';
                line += ` | Stance: ${factionStance}`;
                if (f.power) line += ` | Power: ${f.power}`;
                const momentum = f.last_move && f.momentum && !f.momentum.includes(f.last_move)
                    ? `${f.momentum}; last: ${f.last_move}` : (f.momentum || f.last_move || '');
                if (momentum) line += ` | Momentum: ${momentum}`;
                lines.push(line);
                if (f.leverage) lines.push(`    Leverage: ${f.leverage}`);
                if (f.vulnerability) lines.push(`    Vulnerability: ${f.vulnerability}`);
                if (f.comms_latency) lines.push(`    Comms latency: ${f.comms_latency}`);
                if (f.last_verified_at) lines.push(`    Last verified at: ${f.last_verified_at}`);
                if (f.intel_posture) lines.push(`    Intel posture: ${f.intel_posture}`);
            }
            if (f.intel_on && typeof f.intel_on === 'object' && Object.keys(f.intel_on).length) {
                lines.push('    Intel on:');
                for (const [subject, si] of Object.entries(f.intel_on)) {
                    if (typeof si !== 'object' || Array.isArray(si)) {
                        lines.push(`      ${subject}: ${si}`);
                        continue;
                    }
                    const siLines = [];
                    for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                        const map = si[bucket];
                        if (map && typeof map === 'object' && Object.keys(map).length) {
                            const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
                            for (const [k, v] of Object.entries(map)) {
                                siLines.push(`        [${label}] ${k}: ${v}`);
                            }
                        }
                    }
                    if (siLines.length) {
                        lines.push(`      ${subject}:`);
                        lines.push(...siLines);
                    }
                }
            }
            if (f.relations && typeof f.relations === 'object') {
                for (const [targetId, relation] of Object.entries(f.relations)) {
                    lines.push(`    ↔ ${targetId}: ${relation}`);
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

    // PC dossier — traits & reads (intimacy and full modes)
    if (showIntimacy && state.pc.name) {
        lines.push('');
        lines.push(`PC DOSSIER: ${state.pc.name}`);
        // Traits — intimacy: last 5, full: last 10
        const allTraits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
        const traitCap = isFull ? 10 : 5;
        const traits = allTraits.slice(-traitCap);
        if (traits.length) {
            const traitPrefix = allTraits.length > traitCap ? `  Traits (${allTraits.length} total, showing last ${traitCap}): ` : '  Traits: ';
            lines.push(`${traitPrefix}${traits.join(', ')}`);
        }
        // Reads/reputation — how others see the PC
        const pcReputation = [];
        for (const char of Object.values(state.characters)) {
            if (char.tier === 'UNKNOWN') continue;
            // In intimacy mode, skip KNOWN (their reads are low-fidelity)
            if (isIntimacy && !isFull && char.tier === 'KNOWN') continue;
            const readsLog = char.reads?.pc || char.reads?.[state.pc.name];
            const readsArr = Array.isArray(readsLog) ? readsLog : (readsLog ? [readsLog] : null);
            const readOfPc = readsArr ? readsArr[readsArr.length - 1] : char.stance_toward_pc;
            if (readOfPc) pcReputation.push({ who: char.name || char.id, read: readOfPc, log: readsArr });
        }
        // Legacy pc.reputation entries not covered by character reads
        const legacyRep = (state.pc.reputation && typeof state.pc.reputation === 'object' && !Array.isArray(state.pc.reputation)) ? state.pc.reputation : {};
        for (const [who, r] of Object.entries(legacyRep)) {
            if (!pcReputation.some(p => p.who.toLowerCase().includes(who.toLowerCase()))) {
                pcReputation.push({ who, read: r });
            }
        }
        if (pcReputation.length) {
            lines.push(`  How others see PC:`);
            for (const { who, read, log } of pcReputation) {
                if (isFull && log && log.length > 1) {
                    lines.push(`    ${who} (${log.length} reads):`);
                    for (const entry of log) lines.push(`      - ${entry}`);
                } else {
                    lines.push(`    ${who}: ${read}`);
                }
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
Structural turns (setup, timeskip, heavy cleanup) may still use full ---LEDGER--- syntax.

STANDARD SHAPE:
---STATE---
at: [Day N - HH:MM]
scene: "Where. Who's present. What's happening. Emotional atmosphere."
pc.location: "where the PC is now"
char:elena.condition: "steady, watchful"
char:elena.knowledge_asymmetry.knows.weapon: "PC is armed"
char:elena.knowledge_asymmetry.unknown.sender: "does not know who sent them"
char:elena.knowledge_asymmetry.hiding.owner-warn: "already warned the owner"
char:elena.last_seen_at: "[Day 2 - 19:10]"
faction:zaft.intel_on.archangel.knows.status: "ship escaped damaged"
faction:zaft.intel_on.archangel.unknown.pilot: "Strike pilot identity unknown"
faction:zaft.intel_on.archangel.misreading.pilot-identity: "Assumes pilot still unconfirmed"
collision:trust-vs-duty.distance_category: SHORT
constraint:c1.integrity: STRESSED
char:elena.reads.pc: "Cautious ally"
world.collision_archive+: "[collision] ... [resolution] ... [hook] ... [aftermath] ..."
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
  char:id.condition
  char:id.knowledge_asymmetry.knows.<key>
  char:id.knowledge_asymmetry.unknown.<key>
  char:id.knowledge_asymmetry.hiding.<key>
  char:id.knowledge_asymmetry.misreading.<key>
  char:id.last_seen_at
  char:id.reads.pc
  faction:id.comms_latency
  faction:id.last_verified_at
  faction:id.intel_posture
  faction:id.intel_on.<subject>.knows.<key>
  faction:id.intel_on.<subject>.unknown.<key>
  faction:id.intel_on.<subject>.hiding.<key>
  faction:id.intel_on.<subject>.misreading.<key>
  place:id.name
  place:id.state
  place:id.reach
  place:id.description
  collision:id.name
  collision:id.forces
  collision:id.details
  collision:id.cost
  collision:id.target_constraint
  collision:id.distance_category   (set on creation: IMMEDIATE|SHORT|MEDIUM|LONG)
  collision:id.distance             (engine-owned — read only; do not SET)
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
  divination.last_draw

STATE MACHINES:
  char tier: UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL
  constraint integrity: STABLE -> STRESSED -> CRITICAL -> BREACHED
  collision status: ACTIVE -> RESOLVED (or ACTIVE -> CRASHED if ignored)
  combat status: ACTIVE -> RESOLVED
For these fields, write the NEW state only. The extension will compile the transition.

RARE OPS INSIDE STATE BLOCK:
  create char:dak name="Dak" tier=KNOWN location="The Stray Dog"
  create place:warehouse-district name="Warehouse District" state=contested reach=DISTRICT description="Industrial sprawl south of the river."
  create pressure:border-tension name="Border tension" source="faction:vela" related_to=[char:pc,faction:vela]
  destroy pressure:border-tension
  destroy char:minor-npc
If a turn gets structurally complicated, switch to a full ---LEDGER--- block instead.

DISCIPLINE:
  Only write what changed materially.
  Keep char:id.condition terse — 10-15 words describing body/mind state. Scene prose carries longer description.
  Keep knowledge_asymmetry current on TRACKED/PRINCIPAL characters when they are active or scene-relevant. Use the four buckets: knows (facts they hold), unknown (gaps you want to track), hiding (facts they are actively concealing), misreading (false beliefs they hold). Add or remove individual keys; never overwrite the whole field.
  KNOWN characters inherit knowledge from their faction's intel_on map. Only set individual knowledge_asymmetry keys on a KNOWN character when they learn something their faction does not know yet.
  If the protagonist also exists as char:<pc-id>, treat pc and char:<pc-id> as separate surfaces: pc carries immediate scene/body state, while char:<pc-id> carries the social/knowledge dossier. Updating pc.* does not update the mirrored char dossier.
  Do not globally synchronize off-screen knowledge. Refresh a character's knowledge_asymmetry when they re-enter scene or receive a plausible report, signal, witness account, or sensor update.
  Use faction intel fields for remote awareness: comms_latency, last_verified_at, intel_posture, and intel_on. Each intel_on subject has the same four buckets as knowledge_asymmetry: knows, unknown, hiding, misreading.
  No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them.
  Combat is a thin container. Scene prose carries terrain and tactical narrative; the spawning collision carries cost and forces. Combat tracks only: who's fighting whom (primary_enemy), and what ended where (outcome + aftermath on RESOLVED).
  Every live collision needs a story capsule: what is converging, who or what is caught in it, what it costs, and the forced choice looming.
  Pressure points (pressure:<id>) are seeds — small tensions not yet a collision. Cap is 5; oldest auto-drops on overflow. Destroy when consumed: D pressure:<id>.
  If 3+ related pressure points accumulate, combine them into a collision (CR collision) and destroy the consumed pressures.
  WEEKS or MONTHS timeskips automatically clear all pressure points — the engine handles this.
  key_moments are permanent; do not remove them.
  Cleanup is still capped on normal turns; save bulk pruning for eval or OOC: eval.
  On advance turns, emit: world.timeskip_scale: HOURS|DAYS|WEEKS|MONTHS (default HOURS). WEEKS and MONTHS clear all pressure points.
  Scene time on non-advance turns: ≤15 min in-world. Non-IMMEDIATE collisions cannot arrive in real-time — use ADVANCE to tick clocks.

=== END QUICK REFERENCE ===`;
}

/**
 * Full readme — complete reference with all examples and field documentation.
 * Used on integration turns (timeskip, setup) where heavy ledger work is needed.
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
  > CREATE collision:trust-vs-duty name="Trust vs Duty" distance_category=MEDIUM forces="Trust and duty converging — loyalty demands truth, mission demands silence." involved_chars=[tifa,kenji] location=7th-heaven -- Central tension
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
  > APPEND char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud about memories at the well." -- Pivotal scene
  > APPEND world field=collision_archive value="[collision] Ada betrayal [resolution] on-screen — PC caught her at the handoff [hook] the flash drive she dropped; eye contact [aftermath] trust cracked" -- Resolved collision

REMOVE — remove from an array field
  > REMOVE char:tifa field=noticed_details value="Scratches on bracer" -- Detail resolved

READ — append a read entry (shorthand for MAP_SET on reads; engine caps log at 5, newest wins)
  > READ char:tifa target=cloud "Something wrong with his memories" -- Updated after evasion

MAP_SET — set a key in a map field
  > MAP_SET pc field=reputation key=tifa value="Investor. Unbearable. Has a room now." -- Reputation narrative
  > MAP_SET world field=constants key=power_scale value="1=trained but ordinary, 3=elite specialist, 5=setting-defining monster" -- Set combat power ladder
  > MAP_SET world field=constants key=power_ceiling value=5 -- Highest credible direct-combat level in this setting
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

INTIMACY STANCE — per-character field describing their current sexual/intimate posture toward the PC.
  This is NOT a permission level. It is a living description of where this character is RIGHT NOW:
  what they want, what they fear, what they're using intimacy for, what they don't know yet.
  > SET char:tifa field=intimacy_stance value="Will lean into him, hold his hand, rest against his shoulder — but freezes if it edges toward anything sexual. The guilt is the wall: she feels like wanting him is taking something she hasn't earned." -- Post C1 breach
  > SET char:tifa field=intimacy_stance value="Reciprocates freely but initiates nothing. Needs proof this isn't gratitude before she'll reach first." -- After asymmetry resolved

  The stance shifts when the narrative earns it. Accumulated trust, vulnerability, physical
  history, constraint changes, collision outcomes, quiet moments that land differently — any of
  these can move the wall. The shift must be visible in the prose BEFORE you update the field.
  What CANNOT move the wall: the player demanding it. The character decides, not the player.

  When no intimacy_stance exists on a character, default to: reserved, boundary unknown, must be discovered through interaction.

═══ WRITING INTIMATE SCENES ═══

Sex is not a reward. It is two people navigating consent, desire, fear, trust, and their own damage.
The system tracks this through intimacy_stance (where they are) and intimate_history (what happened).

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
  - After intimacy: UPDATE intimacy_stance, intimate_history, reads, and relevant constraints.
  - What happens in bed doesn't stay in bed. It changes how characters look at each other at breakfast.

UNHEALTHY PATTERNS ARE VALID NARRATIVE:
  - Not every sexual relationship is healthy. Characters can use sex to avoid vulnerability,
    to control, to self-destruct, to prove something, to fill a void.
  - Track the DYNAMIC, not just the acts. The system records patterns, not just events.
  - An unhealthy dynamic is a collision seed. Track it. Let it detonate.

CHECKING THE STANCE:
  Before writing ANY intimate escalation, check the character's intimacy_stance.
  - If the stance says they'd freeze, they freeze. Write the freeze.
  - If the stance says they'd reciprocate but not initiate, they don't initiate.
  - If no stance exists, the character defaults to guarded — boundaries must be discovered.
  - The player's desire does not override the character's stance. The character is a person.

UPDATING THE STANCE:
  The stance shifts when the NARRATIVE earns it — constraint breaches, trust built through
  action (not words), vulnerability reciprocated, time together, conflict survived.
  Never shift because the player pushed. Shift because something real changed.
  The stance can also TIGHTEN — betrayal, trauma, a constraint reforming after breach.

═══ END INTIMACY GUIDE ═══

MAP_DEL — remove a key from a map field
  > MAP_DEL char:tifa field=reads key=barret -- No longer relevant

DESTROY — remove an entity permanently
  > DESTROY char:minor-npc -- Left the story

FACTIONS — create and manage factions with political simulation
  > CREATE faction:shinra name="Shinra Corp" objective="Control the reactors" resources="Military" stance_toward_pc="Hostile" power="stable" momentum="Expanding into Sector 7" leverage="Military force" vulnerability="Public opinion" -- Full political profile
  > SET faction:shinra field=power value="declining" -- Lost reactor control
  > MAP_SET faction:shinra field=relations key=avalanche value="Hostile — active operations against" -- Inter-faction relation
  > SET faction:zaft field=comms_latency value="Ship-to-ship near-real-time; long-range relay delayed by jamming" -- Intel travel speed
  > SET faction:zaft field=last_verified_at value="[Day 4 — 09:20]" -- Last trustworthy refresh
  > MAP_SET faction:zaft field=intel_on key=archangel.knows.status value="Ship escaped damaged" -- Confirmed intel
  > MAP_SET faction:zaft field=intel_on key=archangel.unknown.pilot value="Strike pilot identity" -- Known gap
  > MAP_SET faction:zaft field=intel_on key=archangel.misreading.pilot-identity value="Assumes pilot still unconfirmed" -- False belief

  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances,
  comms_latency, last_verified_at, intel_posture,
  intel_on (nested map: subject → {knows, unknown, hiding, misreading} — four buckets per subject).
  Pressure points (pressure:<id> entities) are collision fuel — small tensions not yet collisions.
  Cap is 5; oldest auto-drops on overflow. Destroy when consumed into a collision.
  > CREATE pressure:perimeter-tension name="Demon scouts testing church perimeter" source="faction:demon-vanguard" related_to=[char:pc,place:church] -- New seam
  > CREATE collision:closing-perimeter name="The Closing Perimeter" distance_category=SHORT forces="demon advance, trapped survivors" involved_chars=[pc] location=church -- Seam graduates
  > DESTROY pressure:perimeter-tension -- Consumed into collision

DIVINATION — record current draw only (no history accumulation)
  > SET divination field=last_draw value="XIV — Temperance" -- Record draw (overwrites previous)

STATE MACHINES (MOVE between adjacent states only, no skipping):
  Character tier:       UNKNOWN → KNOWN → TRACKED → PRINCIPAL
  Constraint integrity: STABLE → STRESSED → CRITICAL → BREACHED (terminal)
    Relief reverse:     CRITICAL → STRESSED → STABLE
  Collision status:     ACTIVE → RESOLVED (or ACTIVE → CRASHED if ignored)

COLLISIONS ARE STORY ENGINES, NOT LABELS:
  Every live collision should tell you, cold:
  1. what is converging
  2. who or what is trapped in it
  3. what engagement, delay, or failure costs
  4. how it is showing up in the scene right now
  5. what forced choice is looming
  details           — the story capsule for the collision
  cost              — the price of delay, engagement, or failure
  target_constraint — which tracked defense this pressure is leaning on (if personal)

COLLISION CLOSURE (required on every RESOLVED transition):
  Every collision that reaches RESOLVED must record three fields:
  > SET collision:id field=outcome_type value=DIRECT     -- Player engaged and shaped the result
  > SET collision:id field=outcome_type value=EVOLVED    -- Resolution revealed a deeper tension
  > SET collision:id field=outcome_type value=MERGED     -- Multiple parent collisions fused into a composite successor event
  > SET collision:id field=outcome_type value=IMPLODED   -- Collision collapsed internally (betrayal, self-destruction, internal failure before it reached the player)
  > SET collision:id field=outcome_type value=CRASHED    -- Player ignored it; gravity resolved it; worst outcome
  > SET collision:id field=aftermath value="What changed. What was lost. What it left behind."
  For EVOLVED or MERGED: add successor_collision_ids and link parent_collision_ids on the new collision.

  IMPLODED example — the secret-holder breaks before the confrontation:
  > MOVE collision:loyalty-trap field=status RESOLVING->RESOLVED
  > SET collision:loyalty-trap field=outcome_type value=IMPLODED
  > SET collision:loyalty-trap field=aftermath value="Mira confessed before Autumn could corner her — not from guilt, from fear. The confrontation Autumn had been building toward never happened. What remains is not resolution but rubble: a confession that arrived too fast to trust, and a debt she didn't earn."

  EVOLVED example — resolution surfaces a new tension:
  > MOVE collision:shadow-activity field=status RESOLVING->RESOLVED
  > SET collision:shadow-activity field=outcome_type value=EVOLVED
  > SET collision:shadow-activity field=aftermath value="The watcher was neutralized, but not before transmitting. Someone now knows Arcueid is in the district."
  > SET collision:shadow-activity field=successor_collision_ids+ value=handler-convergence
  > CREATE collision:handler-convergence name="Handler Convergence" status=SIMMERING distance=7 forces="handler network, Arcueid's exposure" cost="If they move first: extraction becomes impossible" details="The watcher's transmission went through. The handler network now has a confirmed sighting. This is not over — it has moved upstream." parent_collision_ids=shadow-activity

HYGIENE — keep arrays clean (incrementally, 2–3 REMOVEs per turn max):
  - Pressure points: REMOVE when activated (converted into collision fuel) or no longer relevant. These are seeds, not history.
  - Noticed details: REMOVE when fired (used in scene) or no longer relevant.
  - Before APPEND: check if a similar entry already exists. Update or skip, don't duplicate.

VOLUME PER TURN (HARD CAP: 20 lines — excess lines are DROPPED):
  Quiet dialogue: 1–2 | Normal: 2–4 | Action: 4–6 | Heavy (setup, timeskip): 6–12
  NEVER dump bulk REMOVE operations. Prune 2–3 stale entries per turn.

PRIORITY ORDER — when near the cap, emit in this order:
  1. State machine transitions  2. Collision distance  3. DOING/WANT  4. World state
  5. Faction updates  6. Summary  7. Moments/details  8. READS  9. PC  10. Intimate history
  11. REMOVEs — always last, 2–3 max

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
    formatCollisionArchive,
    computeArchiveVersion,
};
