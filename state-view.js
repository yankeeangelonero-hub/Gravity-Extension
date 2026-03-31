/**
 * state-view.js — Format computed state for prompt injection.
 *
 * Provides two format functions:
 * 1. formatStateView(state) — full state overview injected via setExtensionPrompt
 * 2. formatReadme() — command format reference injected via setExtensionPrompt
 *
 * No lorebook interaction — all injection handled by index.js via setExtensionPrompt.
 */

import { getPhonebook } from './state-compute.js';
import { getHotView } from './memory-tier.js';

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
        if (char.power != null) charLine += ` [power:${char.power}]`;
        charLine += ` → id: ${char.id}`;
        lines.push(charLine);
        if (char.location) lines.push(`    Location: ${char.location}`);
        if (!slim && char.condition) lines.push(`    Condition: ${char.condition}`);
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
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED' && c.status !== 'CRASHED');
    if (allCollisions.length) {
        lines.push('');
        lines.push('Collisions:');
        for (const col of allCollisions) {
            let colLine = `  ${col.name || col.id} [${col.status}] dist:${col.distance || '?'}`;
            if (col.mode === 'combat') colLine += ' ⚔';
            colLine += ` → id: ${col.id}`;
            lines.push(colLine);
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

    // Constants — always shown (voice/tone are critical for prose)
    const c = state.world.constants || {};
    if (Object.keys(c).length) {
        lines.push('');
        lines.push('CONSTANTS');
        if (c.role) lines.push(`  Role: ${c.role}`);
        if (c.voice) lines.push(`  Voice: ${c.voice}`);
        if (c.tone) lines.push(`  Tone: ${c.tone}`);
        if (c.tone_rules) {
            const rules = Array.isArray(c.tone_rules) ? c.tone_rules : [c.tone_rules];
            lines.push(`  Tone Rules:`);
            rules.forEach((r, i) => lines.push(`    ${i + 1}. ${r}`));
        }
        if (c.guidelines) lines.push(`  Guidelines: ${c.guidelines}`);
        if (c.motivation) lines.push(`  Motivation: ${c.motivation}`);
        if (c.objective) lines.push(`  Objective: ${c.objective}`);
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
            c => c.status !== 'RESOLVED' && c.status !== 'CRASHED' && c.status !== 'SEEDED'
        );
        if (liveCollisions.length) {
            lines.push('');
            lines.push('COLLISIONS');
            for (const col of liveCollisions) {
                lines.push(`  ⊕ ${col.name || col.id} [${col.status}] dist:${col.distance || '?'} → id: ${col.id}`);
                if (col.details) {
                    // New: single details paragraph
                    lines.push(`    ${col.details}`);
                } else {
                    // Legacy: separate fields
                    const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(' → ') : String(col.forces || '');
                    if (forces) lines.push(`    Forces: ${forces}`);
                    if (col.mode === 'combat') lines.push(`    Mode: COMBAT${col.upper_hand ? ` | Upper hand: ${col.upper_hand}` : ''}`);
                    if (col.cost) lines.push(`    Cost: ${col.cost}`);
                    if (col.target_constraint) lines.push(`    Targets: ${col.target_constraint}`);
                }
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
                lines.push(`  - ${pp}`);
            }
        }

        // PC — full
        if (state.pc.name) {
            lines.push('');
            let pcLine = `PC: ${state.pc.name}`;
            if (state.pc.power != null) pcLine += ` [power:${state.pc.power}]`;
            lines.push(pcLine);
            if (state.pc.location) lines.push(`  Location: ${state.pc.location}`);
            if (state.pc.condition) lines.push(`  Condition: ${state.pc.condition}`);
            if (state.pc.equipment) lines.push(`  Equipment: ${state.pc.equipment}`);
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
  char:id.reads.pc
  collision:id.distance
  collision:id.status
  constraint:id.integrity
  world.world_state
  world.pressure_points+
  world.pressure_points-
  world.constants.tone
  divination.last_draw
  summary+

STATE MACHINES:
  char tier: UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL
  constraint integrity: STABLE -> STRESSED -> CRITICAL -> BREACHED
  collision status: SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED
  chapter status: PLANNED -> OPEN -> CLOSING -> CLOSED
For these fields, write the NEW state only. The extension will compile the transition.

RARE OPS INSIDE STATE BLOCK:
  create char:dak name="Dak" tier=KNOWN location="The Stray Dog"
  destroy char:minor-npc
If a turn gets structurally complicated, switch to a full ---LEDGER--- block instead.

DISCIPLINE:
  Only write what changed materially.
  Keep doing as "action | Cost: what this neglects or risks".
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
  - Entity types: char, constraint, collision, chapter, faction, world, pc, divination, summary
  - Singletons (no :id needed): world, pc, divination, summary
  - IDs: kebab-case, stable, never change once assigned
  - Reason after -- is required, keep it brief like margin notes
  - Quoted values: use "double quotes" for multi-word values

OPERATIONS:

CREATE — new entity
  > CREATE char:tifa name="Tifa Lockhart" tier=KNOWN -- First encounter
  > CREATE constraint:c1-steady name="The Steady One" owner_id=tifa integrity=STABLE prevents="Showing vulnerability or exhaustion" threshold="Sustained pressure from someone trusted" replacement="Regression — stillness without purpose" replacement_type=regression shedding_order=2 -- Core constraint
  > CREATE collision:trust-vs-duty name="Trust vs Duty" forces="trust,duty" status=SEEDED distance=10 -- Central tension
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
  > MAP_SET world field=constants key=tone value="Noir thriller" -- Set tone

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

  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances.
  Pressure points generated from faction conflicts are collision fuel — during advance turns,
  they compress existing collision distances or spawn new collisions.

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

═══ END LEDGER README ═══`;
}


export {
    formatStateView,
    formatReadme,
};
