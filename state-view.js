/**
 * state-view.js — Format computed state for prompt injection.
 *
 * Provides two format functions:
 * 1. formatStateView(state) — full state overview injected via setExtensionPrompt
 * 2. formatReadme() — command format reference injected via setExtensionPrompt
 *
 * No lorebook interaction — all injection handled by index.js via setExtensionPrompt.
 */

import { getPhonebook, getArrayItemHistory } from './state-compute.js';
import { getHotView } from './memory-tier.js';

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
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
    const manifestation = normalizeText(col?.last_manifestation);
    const includeForces = options.includeForces !== false;
    const includeManifestation = options.includeManifestation !== false;

    if (details) lines.push(`Thread: ${details}`);
    else if (forces) lines.push(`Forces: ${forces}`);

    if (includeForces && details && forces) lines.push(`Forces: ${forces}`);
    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);
    if (includeManifestation && manifestation) lines.push(`Now: ${manifestation}`);

    return lines;
}

function getPressurePointMeta(state, point) {
    const history = getArrayItemHistory(state, 'world', '_', 'pressure_points', point);
    const lastAdd = [...history].reverse().find(entry => entry.to !== undefined);
    if (!lastAdd) return '';
    const ageTx = Math.max(0, (state?.lastTxId || 0) - (lastAdd.tx || 0));
    if (ageTx >= 18) return `stale (${ageTx} tx)`;
    if (ageTx >= 8) return `aging (${ageTx} tx)`;
    return `fresh (${ageTx} tx)`;
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
function formatStateView(state, mode = 'full') {
    const lines = [];
    const slim = (mode === 'slim');
    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // ── Entity Registry (what to write to) ─────────────────────────────
    lines.push('ENTITY REGISTRY — use these IDs in ledger transactions');

    // Characters
    const phonebook = getPhonebook(state);
    lines.push('');
    lines.push('Characters:');
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        let charLine = `  ${char.tier} "${char.name || char.id}"`;
        charLine += formatPowerTag(char);
        charLine += ` → id: ${char.id}`;
        lines.push(charLine);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (!slim && char.condition) lines.push(`    Condition: ${char.condition}`);
        if (char.knowledge_asymmetry !== undefined) {
            lines.push(`    Knowledge asymmetry: ${normalizeText(char.knowledge_asymmetry) || '(unset)'}`);
        }
        if (char.last_seen_at !== undefined && char.last_seen_at !== null && normalizeText(char.last_seen_at)) {
            lines.push(`    Last seen at: ${normalizeText(char.last_seen_at)}`);
        }
        if (!slim && char.power_basis) lines.push(`    Power basis: ${char.power_basis}`);
        if (!slim) {
            const abilities = toList(char.abilities);
            if (abilities.length) lines.push(`    Abilities: ${abilities.join(' | ')}`);
        }
        if (!slim && char.intimacy_stance) {
            lines.push(`    Intimacy stance: ${char.intimacy_stance}`);
        }
        if (!slim && char.wounds && typeof char.wounds === 'object' && Object.keys(char.wounds).length) {
            const woundList = Object.entries(char.wounds).map(([k, v]) => `${k}: ${v}`).join(', ');
            lines.push(`    Wounds: ${woundList}`);
        }
        // Key moments — ALWAYS shown, ALL entries (permanent character history)
        const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
        if (moments.length) {
            lines.push(`    Key moments (${moments.length}):`);
            for (const m of moments) lines.push(`      - ${m}`);
        }
    }
    if (Object.keys(state.characters).length === 0) lines.push('  (none)');

    // Constraints
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
            if (!slim && c.profile) {
                lines.push(`    ${c.profile}`);
            } else if (!slim && c.current_pressure) {
                lines.push(`    Pressure: ${c.current_pressure}`);
            }
        }
    }

    // Collisions — slim: just IDs, full: adds detail section below
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
    if (allCollisions.length) {
        lines.push('');
        lines.push('Collisions:');
        for (const col of allCollisions) {
            const tierLabel = col.tier && col.tier !== 'arc' ? ` (${col.tier})` : '';
            let colLine = `  ${col.name || col.id} [${col.status}]${tierLabel} dist:${col.distance || '?'}`;
            colLine += ` → id: ${col.id}`;
            lines.push(colLine);
            if (slim) {
                const threadLines = getCollisionNarrativeLines(col, { includeForces: false });
                for (const threadLine of threadLines) {
                    lines.push(`    ${threadLine}`);
                }
            }
        }
    }

    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            let combatLine = `  ${combat.name || combat.id} [${combat.status || 'ACTIVE'}]`;
            if (combat.exchange != null) combatLine += ` exch:${combat.exchange}`;
            combatLine += ` → id: ${combat.id}`;
            lines.push(combatLine);
            if (combat.primary_enemy) lines.push(`    Primary enemy: ${typeof combat.primary_enemy === 'object' ? combat.primary_enemy.name || combat.primary_enemy.id || '?' : combat.primary_enemy}`);
            if (combat.situation) lines.push(`    Situation: ${combat.situation}`);
            if (combat.terrain) lines.push(`    Terrain: ${combat.terrain}`);
        }
    }

    // Chapters
    const activeChapters = Object.values(state.chapters).filter(ch => ch.status !== 'CLOSED');
    if (activeChapters.length) {
        lines.push('');
        lines.push('Chapters:');
        for (const ch of activeChapters) {
            lines.push(`  Ch${ch.number || '?'} "${ch.title || ch.focus || '?'}" [${ch.status}] → id: ${ch.id}`);
        }
    }

    // Singletons
    lines.push('');
    lines.push('Singletons (no id needed):');
    lines.push('  world — constants, pressure_points, world_state');
    if (state.pc.name) {
        let pcSingleton = `  pc — "${state.pc.name}"`;
        if (state.pc.location) pcSingleton += ` @ ${state.pc.location}`;
        if (state.pc.condition) pcSingleton += ` [${state.pc.condition}]`;
        lines.push(pcSingleton);
        if (state.pc.current_scene) {
            lines.push(`    SCENE: ${state.pc.current_scene}`);
        }
        if (state.pc.equipment) lines.push(`    Equipment: ${state.pc.equipment}`);
        if (state.pc.power_basis) lines.push(`    Power basis: ${state.pc.power_basis}`);
        const slimAbilities = toList(state.pc.abilities);
        if (slimAbilities.length) lines.push(`    Abilities: ${slimAbilities.join(' | ')}`);
        const slimWounds = (state.pc.wounds && typeof state.pc.wounds === 'object') ? state.pc.wounds : {};
        if (Object.keys(slimWounds).length) {
            lines.push(`    Wounds: ${Object.entries(slimWounds).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        }
    } else {
        lines.push('  pc — (not initialized)');
    }
    const divSys = state.divination?.active_system;
    if (divSys) {
        lines.push(`  divination — system: ${divSys}${state.divination?.last_draw ? `, last draw: ${state.divination.last_draw}` : ''}`);
    }

    // Factions — slim: name + stance only, full: all political fields
    const factionEntities = Object.values(state.factions || {});
    const legacyFactions = Array.isArray(state.world.factions) ? state.world.factions : [];
    if (factionEntities.length || legacyFactions.length) {
        lines.push('');
        lines.push('Factions:');
        for (const f of factionEntities) {
            if (slim) {
                // Slim: just name + power + stance
                const slimStance = (f.reads && f.reads.pc) || f.stance_toward_pc || '?';
                const slimPower = f.power ? ` [${f.power}]` : '';
                lines.push(`  ${f.name || f.id}${slimPower} | Stance: ${slimStance} → id: ${f.id}`);
            } else {
                // shown in detail section below
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

    // ── Current State Detail ───────────────────────────────────────────
    lines.push('');
    lines.push('─── CURRENT STATE ───');

    // Chapter — always shown
    const openChapter = Object.values(state.chapters).find(ch => ch.status === 'OPEN');
    if (openChapter) {
        lines.push('');
        if (openChapter.profile) {
            // New: single profile paragraph
            lines.push(`CHAPTER [${openChapter.status}] → id: ${openChapter.id}`);
            lines.push(`  ${openChapter.profile}`);
        } else {
            // Legacy: separate fields
            lines.push(`CHAPTER ${openChapter.number || '?'}: "${openChapter.title || openChapter.focus || '?'}" [${openChapter.status}]`);
            if (openChapter.arc) lines.push(`  Arc: ${openChapter.arc}`);
            if (openChapter.central_tension) lines.push(`  Tension: ${openChapter.central_tension}`);
        }
    }

    // Constants — always shown (story framing lives here; prose rules live in the preset)
    const c = state.world.constants || {};
    const constantLines = [];
    if (c.power_scale) constantLines.push(`  Power Scale: ${normalizeText(c.power_scale)}`);
    if (c.power_ceiling != null) constantLines.push(`  Power Ceiling: ${c.power_ceiling}`);
    if (c.power_notes) constantLines.push(`  Power Notes: ${normalizeText(c.power_notes)}`);
    if (constantLines.length) {
        lines.push('');
        lines.push('CONSTANTS');
        lines.push(...constantLines);
    }

    // World state — always shown
    if (state.world.world_state) {
        lines.push('');
        lines.push('WORLD STATE');
        lines.push(`  ${state.world.world_state}`);
    }

    // ── Below here: full mode only ───────────────────────────────────────

    if (!slim) {
        // Collisions detail
        const liveCollisions = Object.values(state.collisions).filter(
            c => c.status !== 'RESOLVED' && c.status !== 'SEEDED'
        );
        if (liveCollisions.length) {
            lines.push('');
            lines.push('COLLISIONS');
            for (const col of liveCollisions) {
                const tierLabel = col.tier && col.tier !== 'arc' ? ` (${col.tier})` : '';
                lines.push(`  ⊕ ${col.name || col.id} [${col.status}]${tierLabel} dist:${col.distance || '?'} → id: ${col.id}`);
                const narrativeLines = getCollisionNarrativeLines(col);
                for (const narrativeLine of narrativeLines) {
                    lines.push(`    ${narrativeLine}`);
                }
            }
        }

        if (activeCombats.length) {
            lines.push('');
            lines.push('COMBATS');
            for (const combat of activeCombats) {
                lines.push(`  ⚔ ${combat.name || combat.id} [${combat.status || 'ACTIVE'}] exch:${combat.exchange || '?'} → id: ${combat.id}`);
                if (combat.participants) {
                    lines.push(`    Participants: ${Array.isArray(combat.participants) ? combat.participants.join(', ') : combat.participants}`);
                }
                if (combat.hostiles) {
                    lines.push(`    Hostiles: ${Array.isArray(combat.hostiles) ? combat.hostiles.join(', ') : combat.hostiles}`);
                }
                if (combat.primary_enemy) {
                    lines.push(`    Primary enemy: ${typeof combat.primary_enemy === 'object' ? combat.primary_enemy.name || combat.primary_enemy.id || '?' : combat.primary_enemy}`);
                }
                if (combat.situation) lines.push(`    Situation: ${combat.situation}`);
                if (combat.terrain) lines.push(`    Terrain: ${combat.terrain}`);
                if (combat.threat) lines.push(`    Threat: ${combat.threat}`);
            }
        }

        // Factions detail
        if (factionEntities.length) {
            lines.push('');
            lines.push('FACTIONS');
            for (const f of factionEntities) {
                if (f.profile) {
                    // New: single profile paragraph
                    lines.push(`  ${f.name || f.id}: ${f.profile}`);
                } else {
                    // Legacy: separate fields
                    let line = `  ${f.name || f.id}: ${f.objective || ''}`;
                    line += ` | Resources: ${f.resources || '?'}`;
                    const factionStance = (f.reads && f.reads.pc) || f.stance_toward_pc || '?';
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
                    if (f.blindspots) lines.push(`    Blindspots: ${f.blindspots}`);
                }
                if (f.intel_on && typeof f.intel_on === 'object' && Object.keys(f.intel_on).length) {
                    lines.push('    Intel on:');
                    for (const [subject, intel] of Object.entries(f.intel_on)) {
                        lines.push(`      ${subject}: ${intel}`);
                    }
                }
                if (f.false_beliefs && typeof f.false_beliefs === 'object' && Object.keys(f.false_beliefs).length) {
                    lines.push('    False beliefs:');
                    for (const [subject, belief] of Object.entries(f.false_beliefs)) {
                        lines.push(`      ${subject}: ${belief}`);
                    }
                }
                if (f.relations && typeof f.relations === 'object') {
                    for (const [targetId, relation] of Object.entries(f.relations)) {
                        lines.push(`    ↔ ${targetId}: ${relation}`);
                    }
                }
            }
        }

        // Pressure points
        const pressurePoints = Array.isArray(state.world.pressure_points) ? state.world.pressure_points : (state.world.pressure_points ? [String(state.world.pressure_points)] : []);
        if (pressurePoints.length) {
            lines.push('');
            lines.push('PRESSURE POINTS');
            for (const pp of pressurePoints) {
                const meta = getPressurePointMeta(state, pp);
                lines.push(`  - ${pp}${meta ? ` [${meta}]` : ''}`);
            }
        }

        // PC — full
        if (state.pc.name) {
            lines.push('');
            let pcLine = `PC: ${state.pc.name}`;
            pcLine += formatPowerTag(state.pc);
            lines.push(pcLine);
            if (state.pc.location) lines.push(`  Location: ${state.pc.location}`);
            if (state.pc.condition) lines.push(`  Condition: ${state.pc.condition}`);
            if (state.pc.equipment) lines.push(`  Equipment: ${state.pc.equipment}`);
            if (state.pc.power_basis) lines.push(`  Power basis: ${state.pc.power_basis}`);
            const pcAbilities = toList(state.pc.abilities);
            if (pcAbilities.length) lines.push(`  Abilities: ${pcAbilities.join(' | ')}`);
            // Traits — show last 10 in full mode (older are in cold storage)
            const allTraits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
            const traits = allTraits.slice(-10);
            if (traits.length) {
                const traitPrefix = allTraits.length > 10 ? `  Traits (${allTraits.length} total, showing last 10): ` : '  Traits: ';
                lines.push(`${traitPrefix}${traits.join(', ')}`);
            }
            // Reputation: show pc.reputation (legacy) merged with character reads[pc]
            // Collect all reads OF the PC from tracked characters
            const pcReputation = [];
            for (const char of Object.values(state.characters)) {
                if (char.tier === 'UNKNOWN') continue;
                const readOfPc = char.reads?.pc || char.reads?.[state.pc.name] || char.stance_toward_pc;
                if (readOfPc) pcReputation.push({ who: char.name || char.id, read: readOfPc });
            }
            // Also include legacy pc.reputation entries not covered by character reads
            const legacyRep = (state.pc.reputation && typeof state.pc.reputation === 'object' && !Array.isArray(state.pc.reputation)) ? state.pc.reputation : {};
            for (const [who, r] of Object.entries(legacyRep)) {
                if (!pcReputation.some(p => p.who.toLowerCase().includes(who.toLowerCase()))) {
                    pcReputation.push({ who, read: r });
                }
            }
            if (pcReputation.length) {
                lines.push(`  How others see PC:`);
                for (const { who, read } of pcReputation) {
                    lines.push(`    ${who}: ${read}`);
                }
            }
            const pcWounds = (state.pc.wounds && typeof state.pc.wounds === 'object') ? state.pc.wounds : {};
            if (Object.keys(pcWounds).length) {
                const woundList = Object.entries(pcWounds).map(([k, v]) => `${k}: ${v}`).join(', ');
                lines.push(`  Wounds: ${woundList}`);
            }
        }
    }

    // Timeline — single chronological record, strict temporal order
    // Uses hot view (watermark-based) so archived entries are excluded
    const fullTimeline = Array.isArray(state.story_summary) ? state.story_summary : [];
    const { hot: hotTimeline, arcs } = getHotView('story_summary', state);
    if (hotTimeline.length) {
        // Separate consolidated entries from regular in hot view
        const consolidated = [];
        const regular = [];
        for (const s of hotTimeline) {
            const text = typeof s === 'object' ? (s.text || '') : String(s);
            if (text.includes('[ARC:')) {
                consolidated.push(s);
            } else {
                regular.push(s);
            }
        }

        const displayEntries = slim
            ? [...consolidated, ...regular.slice(-10)]
            : [...consolidated, ...regular];

        const archivedCount = fullTimeline.length - hotTimeline.length;
        const archiveNote = archivedCount > 0 ? `, ${archivedCount} archived` : '';
        lines.push('');
        lines.push(slim ? `TIMELINE (${hotTimeline.length} hot${archiveNote}, showing ${displayEntries.length})` : `TIMELINE (${hotTimeline.length} hot${archiveNote})`);
        for (const s of displayEntries) {
            const text = typeof s === 'object' ? s.text : s;
            const time = typeof s === 'object' ? (s.t || '') : '';
            lines.push(`  ${time ? time + ' ' : ''}${text}`);
        }
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
Structural turns (setup, timeskip, chapter close, heavy cleanup) may still use full ---LEDGER--- syntax.

STANDARD SHAPE:
---STATE---
at: [Day N - HH:MM]
scene: "Where. Who's present. What's happening. Emotional atmosphere."
pc.location: "where the PC is now"
pc.condition: "physical and emotional state"
char:elena.condition: "steady, watchful"
char:elena.knowledge_asymmetry: "Knows the PC is armed, does not know who sent them, is hiding that she already warned the owner"
char:elena.last_seen_at: "[Day 2 - 19:10]"
faction:zaft.intel_on.archangel: "Believes the ship escaped damaged; does not know who the Strike pilot is"
faction:zaft.false_beliefs.strike-pilot: "Assumes the pilot identity is still unconfirmed"
collision:trust-vs-duty.distance: 4
constraint:c1.integrity: STRESSED
char:elena.reads.pc: "Cautious ally"
world.pressure_points+: "A new seam in the world"
summary+: "What happened and what changed"
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
  pc.condition
  pc.current_scene (or scene)
  pc.equipment
  char:id.location
  char:id.condition
  char:id.doing
  char:id.knowledge_asymmetry
  char:id.last_seen_at
  char:id.reads.pc
  faction:id.comms_latency
  faction:id.last_verified_at
  faction:id.intel_posture
  faction:id.blindspots
  faction:id.intel_on.subject
  faction:id.false_beliefs.subject
  collision:id.name
  collision:id.forces
  collision:id.details
  collision:id.cost
  collision:id.target_constraint
  collision:id.distance
  collision:id.status
  collision:id.last_manifestation
  collision:id.outcome_type
  collision:id.aftermath
  collision:id.successor_collision_ids+
  collision:id.parent_collision_ids+
  combat:id.status
  combat:id.exchange
  combat:id.participants
  combat:id.hostiles
  combat:id.primary_enemy
  combat:id.terrain
  combat:id.situation
  combat:id.threat
  combat:id.outcome
  combat:id.aftermath
  constraint:id.integrity
  world.world_state
  world.pressure_points+
  world.pressure_points-
  divination.last_draw
  summary+

STATE MACHINES:
  char tier: UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL
  constraint integrity: STABLE -> STRESSED -> CRITICAL -> BREACHED
  collision status: SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED
  combat status: ACTIVE -> RESOLVED
  chapter status: PLANNED -> OPEN -> CLOSING -> CLOSED
For these fields, write the NEW state only. The extension will compile the transition.

RARE OPS INSIDE STATE BLOCK:
  create char:dak name="Dak" tier=KNOWN location="The Stray Dog"
  destroy char:minor-npc
If a turn gets structurally complicated, switch to a full ---LEDGER--- block instead.

DISCIPLINE:
  Only write what changed materially.
  Keep doing as "action | Cost: what this neglects or risks".
  Keep knowledge_asymmetry current on KNOWN/TRACKED/PRINCIPAL characters when they are active or scene-relevant: what they know, what they do not know, what they are hiding, or what they are misreading right now.
  If the protagonist also exists as char:<pc-id>, treat pc and char:<pc-id> as separate surfaces: pc carries immediate scene/body state, while char:<pc-id> carries the social/knowledge dossier. Updating pc.* does not update the mirrored char dossier.
  Do not globally synchronize off-screen knowledge. Refresh a character's knowledge_asymmetry when they re-enter scene or receive a plausible report, signal, witness account, or sensor update.
  Use faction intel fields for remote awareness: comms_latency, last_verified_at, intel_posture, blindspots, intel_on, and false_beliefs.
  No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them.
  Every live collision needs a story capsule: what is converging, who or what is caught in it, what it costs, and the forced choice looming.
  When a collision presses into the scene, update collision:id.last_manifestation with the concrete current expression.
  Pressure points are seeds, not history. If a seam fired, resolved, or became a collision, REMOVE it.
  If a pressure point gains actors, cost, and a looming forced choice, CREATE a collision from it and REMOVE the pressure point the same turn.
  key_moments are permanent; do not remove them.
  summary+ should capture what happened and what changed. If at: is set, do not repeat the timestamp inside the text unless it matters stylistically.
  Cleanup is still capped on normal turns; save bulk pruning for eval or chapter close.

=== END QUICK REFERENCE ===`;
}

/**
 * Full readme — complete reference with all examples and field documentation.
 * Used on integration turns (chapter close, timeskip, setup) where heavy ledger work is needed.
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
  - Entity types: char, constraint, collision, combat, chapter, faction, world, pc, divination, summary
  - Singletons (no :id needed): world, pc, divination, summary
  - IDs: kebab-case, stable, never change once assigned
  - Reason after -- is required, keep it brief like margin notes
  - Quoted values: use "double quotes" for multi-word values

OPERATIONS:

CREATE — new entity
  > CREATE char:tifa name="Tifa Lockhart" tier=KNOWN -- First encounter
  > CREATE constraint:c1-steady name="The Steady One" owner_id=tifa integrity=STABLE prevents="Showing vulnerability or exhaustion" threshold="Sustained pressure from someone trusted" replacement="Regression — stillness without purpose" replacement_type=regression shedding_order=2 -- Core constraint
  > CREATE collision:trust-vs-duty name="Trust vs Duty" forces="trust,duty" status=SEEDED distance=10 details="Trust and duty are converging. Autumn's loyalty demands she tell Kenji the truth. Her mission demands she doesn't." cost="If it detonates: one of them walks away for good" target_constraint=c1-the-steady-one -- Central tension
  > CREATE combat:alley-fight status=ACTIVE exchange=1 participants="pc,tifa,shinra-sweep" hostiles="shinra-sweep" primary_enemy="shinra-sweep" terrain="Narrow service alley with hard cover and bad firing lanes" situation="Sweep team rounds the corner while driving a wounded runner into the alley" threat="Armored rifles in close quarters with a disguised command element" -- Active combat container
  > CREATE chapter:ch1 number=1 title="Arrival" status=OPEN arc="Meeting" central_tension="Friend or foe?" -- Init chapter

  Constraint fields: name, owner_id, integrity, prevents, threshold, replacement, replacement_type (sophistication/displacement/depth_shift/regression), shedding_order, current_pressure
  Update current_pressure with SET whenever pressure changes:
  > SET constraint:c1-steady field=current_pressure value="Arms uncrossed involuntarily. The softening was visible." -- C1 eased instead of held

MOVE — state machine transition (no skipping levels)
  > MOVE char:tifa field=tier KNOWN->TRACKED -- Promoted after trust scene
  > MOVE constraint:c1-secret field=integrity STABLE->STRESSED -- Pressure from collision
  > MOVE collision:trust-vs-duty field=status SIMMERING->ACTIVE -- Costs now concrete
  > MOVE chapter:ch1 field=status OPEN->CLOSING -- Chapter target reached

SET — overwrite a field
  > SET char:tifa field=doing value="Investigating the reactor" -- New action
  > SET collision:trust-vs-duty field=distance value=6 -- Closer after confrontation
  > SET world field=world_state value="Martial law declared" -- Major world change
  > SET combat:alley-fight field=exchange value=2 -- New exchange begins

APPEND — add to an array field
  > APPEND char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud about memories at the well." -- Pivotal scene
  > APPEND world field=pressure_points value="Shinra patrols increasing in slums" -- Rising tension
  > APPEND pc field=timeline value="[Day 2 — 06:18] Stood between Barret's gun-arm and Tifa." -- Major action

REMOVE — remove from an array field
  > REMOVE char:tifa field=noticed_details value="Scratches on bracer" -- Detail resolved

READ — set a character's read on someone (shorthand for MAP_SET on reads)
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
  > MAP_SET faction:zaft field=intel_on key=archangel value="Believes the ship escaped damaged; pilot identity still uncertain" -- Current intel snapshot
  > MAP_SET faction:zaft field=false_beliefs key=strike-pilot value="Assumes the pilot is still unknown" -- Important wrong belief

  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances,
  comms_latency, last_verified_at, intel_posture, blindspots, intel_on (map: subject → belief snapshot),
  false_beliefs (map: subject → important wrong assumption).
  Pressure points generated from faction conflicts are collision fuel — during advance turns,
  they compress existing collision distances or spawn new collisions.
  A pressure point should stay SHORT: a seam, signal, or pending break.
  Once it has named actors, a concrete cost, and a looming forced choice, it is ready to graduate:
  > APPEND world field=pressure_points value="Demon scouts are testing the church perimeter at dusk." -- New seam
  > CREATE collision:closing-perimeter name="The Closing Perimeter" status=ACTIVE distance=3 forces="demon advance, trapped survivors" details="Demon scouts have stopped probing and started shaping the block into a kill-box. Survivors are still inside, the exits are narrowing, and every delay gives the Prince a cleaner entrance." cost="Every minute they stay, the perimeter tightens. Moving means fighting through demons. Staying means the Prince arrives." target_constraint=c1-protector -- Pressure graduates into collision
  > REMOVE world field=pressure_points value="Demon scouts are testing the church perimeter at dusk." -- The seam is now embodied by the collision

DIVINATION — record current draw only (no history accumulation)
  > SET divination field=last_draw value="XIV — Temperance" -- Record draw (overwrites previous)

TIMELINE — the single chronological record. This IS the story's complete memory.
  With only 3-5 messages of chat context, the LLM reconstructs EVERYTHING from these entries.
  Each entry must be rich enough to write the next scene from, not just remember the last one.

  Every entry MUST include:
  1. Timestamp: [Day N — HH:MM]
  2. What happened: the physical event, who acted, who was present
  3. How it felt: emotional register, body language, what the silence carried
  4. What it changed: relationship shift, constraint pressure, collision movement, power dynamic
  5. What it left open: unresolved tension, unanswered question, the thing that follows the character out of the scene
  6. One concrete sensory detail: the specific image, sound, texture, or gesture that makes this moment THIS moment and not any other

  3-5 sentences per entry. Not a log. Not a summary. A compressed scene you can write FROM.

  > APPEND summary value="[Day 1 — 21:10] Tifa pulled Autumn from Reactor 1 rubble — head wound, minor, hands steady. He heard survivor knocking in a burning apartment and ran inside without calculating; she followed. First debt established: she treated his wound before her own, using the cloth she'd been pressing against her ribs. He noticed. She noticed him noticing. Neither said anything. The asymmetry starts here — she knows what just happened to his world, he doesn't know she was part of it."
  > APPEND summary value="[Day 7 — 19:28] Storage room. Blue potion light. Autumn kissed Tifa slowly — 'I want to make good the claim, the my girl part.' Not the brief table kiss. Her hands gripped his back. A small pre-verbal sound into his mouth. She leaned in — the lean she didn't give at the table. His fingers found her hair near the pink band. When it ended at three inches she said 'okay' in a voice reduced to one syllable. Forehead to sternum. The claim made good. C2 still CRITICAL — the guilt underneath the wanting didn't dissolve, it got quieter."

  Do NOT use pc.timeline — this is the only timeline. One log, one place.

STATE MACHINES (MOVE between adjacent states only, no skipping):
  Character tier:       UNKNOWN → KNOWN → TRACKED → PRINCIPAL
  Constraint integrity: STABLE → STRESSED → CRITICAL → BREACHED (terminal)
    Relief reverse:     CRITICAL → STRESSED → STABLE
  Collision status:     SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED
  Chapter status:       PLANNED → OPEN → CLOSING → CLOSED

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
  last_manifestation — the current concrete expression in scene reality; update it whenever the collision enters or sharpens in-scene

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
  Quiet dialogue: 1–2 | Normal: 2–4 | Action: 4–6 | Heavy (setup, chapter close): 6–12
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
};
