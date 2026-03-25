/**
 * state-view.js — Render computed state into lorebook entries.
 *
 * Maintains three types of lorebook entries:
 * 1. Gravity_State_View (always-on) — full state overview with entity registry
 * 2. Gravity_Char_[id] (keyword-triggered) — per-character dossiers
 * 3. Gravity_Ledger_Readme (always-on, low depth) — format spec, commands, writing guide
 *
 * These are the LLM's window into cold state. The extension keeps them current
 * after every ledger commit.
 */

import { getPhonebook } from './state-compute.js';

const STATE_VIEW_COMMENT = 'Gravity_State_View';
const LEDGER_README_COMMENT = 'Gravity_Ledger_Readme';
const CHAR_ENTRY_PREFIX = 'Gravity_Char_';

/**
 * Render the full state view into the always-on lorebook entry.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderStateView(bookName, state) {
    const content = formatStateView(state);
    const existing = await findEntryByComment(bookName, STATE_VIEW_COMMENT);

    if (existing) {
        await updateEntry(bookName, existing.uid, { content });
    } else {
        await createEntry(bookName, {
            comment: STATE_VIEW_COMMENT,
            content,
            constant: true,  // Always injected
            key: [],
            disable: false,
            order: 10,
            position: 1,     // After system prompt
            depth: 0,
        });
    }
}

/**
 * Format the full state into a prompt-friendly string.
 * Includes entity IDs so the LLM knows exactly what to target in ledger transactions.
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */
function formatStateView(state) {
    const lines = [];
    lines.push('═══ GRAVITY STATE VIEW ═══');
    lines.push('');

    // ── Entity Registry (what to write to) ─────────────────────────────
    // Every entity ID the LLM can target in ledger transactions.
    lines.push('ENTITY REGISTRY — use these IDs in ledger transactions');

    // Characters
    const phonebook = getPhonebook(state);
    lines.push('');
    lines.push('Characters:');
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        lines.push(`  ${char.tier} "${char.name || char.id}" → id: ${char.id}`);
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
            lines.push(`  ${c.name} [${c.integrity}] (${ownerName}) → id: ${c.id}`);
        }
    }

    // Collisions
    const allCollisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
    if (allCollisions.length) {
        lines.push('');
        lines.push('Collisions:');
        for (const col of allCollisions) {
            const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(' → ') : String(col.forces || '');
            lines.push(`  ⊕ ${col.name || col.id} [${col.status}] ${forces} | dist:${col.distance || '?'} → id: ${col.id}`);
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
    lines.push('  world — factions, constants, pressure_points, world_state');
    if (state.pc.name) {
        lines.push(`  pc — "${state.pc.name}"`);
    } else {
        lines.push('  pc — (not initialized)');
    }

    // ── Current State Detail ───────────────────────────────────────────
    lines.push('');
    lines.push('─── CURRENT STATE ───');

    // Chapter
    const openChapter = Object.values(state.chapters).find(ch => ch.status === 'OPEN');
    if (openChapter) {
        lines.push('');
        lines.push(`CHAPTER ${openChapter.number || '?'}: "${openChapter.title || openChapter.focus || '?'}" [${openChapter.status}]`);
        if (openChapter.arc) lines.push(`  Arc: ${openChapter.arc}`);
        if (openChapter.central_tension) lines.push(`  Tension: ${openChapter.central_tension}`);
    }

    // Collisions detail
    const liveCollisions = Object.values(state.collisions).filter(
        c => c.status !== 'RESOLVED' && c.status !== 'SEEDED'
    );
    if (liveCollisions.length) {
        lines.push('');
        lines.push('COLLISIONS');
        for (const col of liveCollisions) {
            const forces = Array.isArray(col.forces) ? col.forces.map(f => f.name || f).join(' → ') : String(col.forces || '');
            lines.push(`  ⊕ ${col.name || col.id} | ${forces} | dist:${col.distance || '?'} | ${col.status}`);
            if (col.cost) lines.push(`    Cost: ${col.cost}`);
            if (col.target_constraint) lines.push(`    Targets: ${col.target_constraint}`);
        }
    }

    // Constants
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

    // World state
    if (state.world.world_state) {
        lines.push('');
        lines.push('WORLD STATE');
        lines.push(`  ${state.world.world_state}`);
    }

    // Factions
    const factions = Array.isArray(state.world.factions) ? state.world.factions : [];
    if (factions.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of factions) {
            if (typeof f === 'object') {
                lines.push(`  ${f.name}: ${f.objective || ''} | Stance: ${f.stance_toward_pc || '?'}`);
            } else {
                lines.push(`  ${f}`);
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

    // PC
    if (state.pc.name) {
        lines.push('');
        lines.push(`PC: ${state.pc.name}`);
        const traits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
        if (traits.length) {
            lines.push(`  Traits: ${traits.join(', ')}`);
        }
        const rep = (state.pc.reputation && typeof state.pc.reputation === 'object' && !Array.isArray(state.pc.reputation)) ? state.pc.reputation : {};
        if (Object.keys(rep).length) {
            lines.push(`  Reputation:`);
            for (const [who, r] of Object.entries(rep)) {
                lines.push(`    ${who}: ${r}`);
            }
        }
    }

    // Story Summary
    const summary = Array.isArray(state.story_summary) ? state.story_summary : [];
    if (summary.length) {
        lines.push('');
        lines.push('STORY SO FAR');
        for (const s of summary) {
            const text = typeof s === 'object' ? s.text : s;
            const time = typeof s === 'object' ? (s.t || '') : '';
            lines.push(`  ${time ? time + ' ' : ''}${text}`);
        }
    }
    lines.push('');
    lines.push('NOTE: After major events or chapter closes, APPEND summary with a brief story beat.');

    lines.push('');
    lines.push('═══ END STATE VIEW ═══');
    return lines.join('\n');
}

/**
 * Render per-character keyword-triggered lorebook entries.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderCharacterEntries(bookName, state) {
    const entries = await getEntries(bookName);

    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue; // No entry for unknown characters

        const comment = `${CHAR_ENTRY_PREFIX}${char.id}`;
        const content = formatCharacterEntry(char, state);
        const keywords = buildCharacterKeywords(char);

        const existing = Object.entries(entries).find(([, e]) => e.comment === comment);

        if (existing) {
            await updateEntry(bookName, Number(existing[0]), {
                content,
                key: keywords,
                disable: char.tier === 'KNOWN', // KNOWN chars have dormant entries
            });
        } else if (char.tier === 'TRACKED' || char.tier === 'PRINCIPAL') {
            await createEntry(bookName, {
                comment,
                content,
                key: keywords,
                constant: false,
                disable: false,
                order: 50,
                position: 1,
                depth: 4,
                scanDepth: 2,
            });
        }
    }
}

/**
 * Format a character's state into a prompt-friendly string.
 * @param {Object} char
 * @param {import('./state-compute.js').ComputedState} state
 * @returns {string}
 */
function formatCharacterEntry(char, state) {
    const lines = [];
    lines.push(`═══ ${char.name || char.id} [${char.tier}] ═══`);

    if (char.want) lines.push(`W: ${char.want}`);
    if (char.doing) lines.push(`DO: ${char.doing}${char.cost ? ` | $: ${char.cost}` : ''}`);

    // Constraints
    const constraints = Object.values(state.constraints).filter(c => c.owner_id === char.id);
    if (constraints.length) {
        lines.push('');
        lines.push('Constraints:');
        for (const c of constraints) {
            let line = `  ${c.name} [${c.integrity}]`;
            if (c.prevents) line += ` — prevents: ${c.prevents}`;
            if (c.shedding_order != null) line += ` (shed: ${c.shedding_order})`;
            lines.push(line);
            if (c.integrity === 'BREACHED' && c.replacement) {
                lines.push(`    → Replaced by: ${c.replacement} (${c.replacement_type})`);
            }
        }
    }

    // Reads
    if (char.reads && Object.keys(char.reads).length) {
        lines.push('');
        lines.push('READS:');
        for (const [who, interpretation] of Object.entries(char.reads)) {
            lines.push(`  ${who}: ${interpretation}`);
        }
    }

    // Noticed details
    if (char.noticed_details?.length) {
        lines.push('');
        lines.push('Noticed:');
        for (const detail of char.noticed_details) {
            lines.push(`  🔫 ${detail}`);
        }
    }

    // Key moments
    if (char.key_moments?.length) {
        lines.push('');
        lines.push('Key Moments:');
        for (const moment of char.key_moments.slice(-5)) { // Last 5
            lines.push(`  ${moment}`);
        }
    }

    // Stance (TRACKED only)
    if (char.stance_toward_pc) {
        lines.push('');
        lines.push(`Stance toward PC: ${char.stance_toward_pc}`);
    }

    lines.push(`═══ END ${char.name || char.id} ═══`);
    return lines.join('\n');
}

/**
 * Build keyword array for a character entry.
 * @param {Object} char
 * @returns {string[]}
 */
function buildCharacterKeywords(char) {
    const keywords = [];
    if (char.name) {
        keywords.push(char.name);
        // Add first name as keyword too
        const firstName = char.name.split(' ')[0];
        if (firstName !== char.name) keywords.push(firstName);
    }
    if (char.id && char.id !== char.name) keywords.push(char.id);
    return keywords;
}

/**
 * Render the command readme into a low-depth always-on lorebook entry.
 * Gives the LLM a persistent reference for ledger format, commands, and examples.
 * @param {string} bookName
 */
async function renderReadme(bookName) {
    const content = formatReadme();
    const existing = await findEntryByComment(bookName, LEDGER_README_COMMENT);

    if (existing) {
        await updateEntry(bookName, existing.uid, { content });
    } else {
        await createEntry(bookName, {
            comment: LEDGER_README_COMMENT,
            content,
            constant: true,   // Always injected
            key: [],
            disable: false,
            order: 5,
            position: 1,      // After system prompt
            depth: 4,         // Low depth — available but not top priority
        });
    }
}

/**
 * Format the ledger readme — command reference, format spec, writing guide, and examples.
 * @returns {string}
 */
function formatReadme() {
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
  > SET char:tifa field=want value="Keep Cloud safe" -- Goal clarified
  > SET collision:trust-vs-duty field=distance value=6 -- Closer after confrontation
  > SET world field=world_state value="Martial law declared" -- Major world change
  > SET pc field=name value="Autumn" -- Init PC

APPEND — add to an array field
  > APPEND char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud about memories at the well. Composure broke for one beat." -- Pivotal scene
  > APPEND char:tifa field=noticed_details value="Cloud flinched when she said Sephiroth — micro-expression, jaw tightened" -- Chekhov detail
  > APPEND world field=pressure_points value="Shinra patrols increasing in slums — checkpoints tightening" -- Rising tension
  > APPEND pc field=demonstrated_traits value="Mirror technique — uses Tifa's own caregiving style to bypass her defenses. Effective without being aggressive." -- Observed trait pattern
  > APPEND pc field=timeline value="[Day 2 — 06:18] Stood between Barret's gun-arm and Tifa. Soft voice, not aggressive. Offered to leave." -- Major action

REMOVE — remove from an array field
  > REMOVE char:tifa field=noticed_details value="Scratches on bracer" -- Detail resolved

READ — set a character's read on someone (shorthand for MAP_SET on reads)
  > READ char:tifa target=cloud "Something wrong with his memories" -- Updated after evasion

MAP_SET — set a key in a map field
  > MAP_SET pc field=reputation key=tifa value="Investor. Unbearable. Has a room now. Not leaving." -- Reputation narrative
  > MAP_SET pc field=reputation key=shinra value="Unknown. No file. Civilian near Reactor 1 blast — potential suspect if identified." -- Faction reputation
  > MAP_SET world field=constants key=tone value="Noir thriller" -- Set tone
  > MAP_SET char:tifa field=intimate_history key=ENCOUNTERS value="1" -- Post-intimacy tracking
  > MAP_SET char:tifa field=intimate_history key=DYNAMIC value="She led. He held still." -- Intimacy pattern

MAP_DEL — remove a key from a map field
  > MAP_DEL char:tifa field=reads key=barret -- No longer relevant

DESTROY — remove an entity permanently
  > DESTROY char:minor-npc -- Left the story

FACTIONS — create and manage factions
  > CREATE faction:shinra name="Shinra Corp" objective="Control the reactors" resources="Military" stance_toward_pc="Hostile" -- Major faction
  > SET faction:shinra field=stance_toward_pc value="Neutral" -- Stance shifted after negotiation

DIVINATION — record draws and readings
  > SET divination field=active_system value="arcana" -- Set active system
  > SET divination field=last_draw value="XIV — Temperance" -- Record draw
  > APPEND divination field=readings value="XIV Temperance — balance sought between opposing forces" -- Log reading

STORY SUMMARY — append-only story beats (include after major events)
  > APPEND summary field=text value="Ch1: Ada and Autumn meet in the safehouse. Trust tentative." -- Chapter 1 summary
  > APPEND summary field=text value="The Organization's surveillance was discovered." -- Key event

STATE MACHINES (MOVE between adjacent states only, no skipping):
  Character tier:       UNKNOWN → KNOWN → TRACKED → PRINCIPAL
  Constraint integrity: STABLE → STRESSED → CRITICAL → BREACHED (terminal)
    Relief reverse:     CRITICAL → STRESSED → STABLE
  Collision status:     SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED (or CRASHED from ACTIVE/RESOLVING)
  Chapter status:       PLANNED → OPEN → CLOSING → CLOSED

VOLUME PER TURN:
  Quiet dialogue: 1–2 lines
  Normal scene: 2–4 lines
  Action/confrontation: 4–6 lines
  Heavy turn (setup, chapter close, promotion): 6–12 lines
  Nothing changed: (empty)

FULL EXAMPLE — action scene:
---LEDGER---
> [Day 2 — 03:00] MOVE constraint:c2-cover field=integrity STRESSED->CRITICAL -- Guard recognized him
> [Day 2 — 03:00] APPEND char:cloud field=key_moments value="Guard recognized him from Nibelheim" -- Pivotal
> [Day 2 — 03:00] SET char:cloud field=doing value="Fighting to escape checkpoint" -- Forced into action
> [Day 2 — 03:00] SET collision:identity-crisis field=distance value=3 -- Near collision
> [Day 2 — 03:00] SET world field=world_state value="Checkpoint breach — alarms in Sector 7" -- World reacts
---END LEDGER---

OOC COMMANDS (player types in chat):
  OOC: snapshot       — Save checkpoint
  OOC: rollback       — List snapshots
  OOC: rollback to #N — Restore to snapshot N
  OOC: eval           — Full system audit
  OOC: history [id]   — Entity change history
  OOC: archive        — Consolidation checkpoint

═══ END LEDGER README ═══`;
}

/**
 * Full render: state view + all character entries + readme.
 * Called after every successful ledger commit.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} state
 */
async function renderAll(bookName, state) {
    try {
        await renderStateView(bookName, state);
        await renderCharacterEntries(bookName, state);
        await renderReadme(bookName);
        console.log(`[GravityLedger] Rendered state view + character entries + readme to "${bookName}".`);
    } catch (err) {
        console.error('[GravityLedger] renderAll failed:', err);
    }
}

export {
    renderStateView,
    renderCharacterEntries,
    renderReadme,
    renderAll,
    formatStateView,
    formatCharacterEntry,
    formatReadme,
    STATE_VIEW_COMMENT,
    LEDGER_README_COMMENT,
    CHAR_ENTRY_PREFIX,
};
