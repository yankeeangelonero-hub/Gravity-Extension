/**
 * setup-wizard.js — Guided 3-phase setup with auto-advance and cancel.
 *
 * Phase 1: Voice & Tone → detects constants.voice + constants.tone set
 * Phase 2: Story & Arc → detects chapter created
 * Phase 3: Cast & Opening → detects principal char created
 *
 * Each phase injects its prompt. Extension watches committed TX to auto-advance.
 */

const LOG_PREFIX = '[GravityLedger:Setup]';

let _phase = 0; // 0=idle, 1=voice/tone, 2=story/arc, 3=cast/opening
let _onPhaseChange = null;

function getPhase() { return _phase; }
function isActive() { return _phase > 0; }

function setPhaseCallback(fn) { _onPhaseChange = fn; }

function startSetup() {
    _phase = 1;
    console.log(`${LOG_PREFIX} Setup started — Phase 1: Voice & Tone`);
    if (_onPhaseChange) _onPhaseChange(_phase);
}

function cancelSetup() {
    _phase = 0;
    console.log(`${LOG_PREFIX} Setup cancelled.`);
    if (_onPhaseChange) _onPhaseChange(_phase);
}

/**
 * Check committed transactions to detect phase completion.
 * Called after every successful commit.
 * @param {Array} committedTxns
 * @param {Object} state - current computed state
 */
function checkPhaseCompletion(committedTxns, state) {
    if (_phase === 0) return;

    switch (_phase) {
        case 1: {
            // Phase 1 complete when voice AND tone are set
            const constants = state.world?.constants || {};
            if (constants.voice && constants.tone) {
                _phase = 2;
                console.log(`${LOG_PREFIX} Phase 1 complete. Advancing to Phase 2: Story & Arc`);
                if (_onPhaseChange) _onPhaseChange(_phase);
            }
            break;
        }
        case 2: {
            // Phase 2 complete when a chapter is created
            const chapters = Object.keys(state.chapters || {});
            if (chapters.length > 0) {
                _phase = 3;
                console.log(`${LOG_PREFIX} Phase 2 complete. Advancing to Phase 3: Cast & Opening`);
                if (_onPhaseChange) _onPhaseChange(_phase);
            }
            break;
        }
        case 3: {
            // Phase 3 complete when a PRINCIPAL character exists
            const principal = Object.values(state.characters || {}).find(c => c.tier === 'PRINCIPAL');
            if (principal) {
                _phase = 0;
                console.log(`${LOG_PREFIX} Phase 3 complete. Setup finished!`);
                if (_onPhaseChange) _onPhaseChange(_phase);
            }
            break;
        }
    }
}

/**
 * Get the injection prompt for the current phase.
 * Returns null if setup is not active.
 */
function getPhasePrompt() {
    switch (_phase) {
        case 1: return PHASE_1_PROMPT;
        case 2: return PHASE_2_PROMPT;
        case 3: return PHASE_3_PROMPT;
        default: return null;
    }
}

/**
 * Get a human-readable label for the current phase.
 */
function getPhaseLabel() {
    switch (_phase) {
        case 1: return 'Phase 1/3: Voice & Tone';
        case 2: return 'Phase 2/3: Story & Arc';
        case 3: return 'Phase 3/3: Cast & Opening';
        default: return '';
    }
}

// ─── Phase Prompts ──────────────────────────────────────────────────────────────

const PHASE_1_PROMPT = `[GRAVITY SETUP — PHASE 1 of 3: Voice & Tone]

Do NOT write prose. Present these questions to the player:

VOICE — how should the prose feel?
1. Sentence rhythm? (compressed and punchy / flowing and reflective / dry and precise / other)
2. What does the protagonist notice first? (physical details / emotional undercurrents / tactical information / absurdity)
3. Internal observation style? (sarcastic / analytical / poetic / matter-of-fact)
4. Action description? (visceral and sensory / casual precision / cinematic / clinical)
5. Where does humor live? (everywhere / only in contrast / nowhere / in what's unsaid)
6. When does the voice go quiet? (emotional reveals / violence / moments of beauty / never)

TONE — how does the world work?
7. How hard do consequences hit? Do injuries linger? Is death real?
8. How do strangers behave? (helpful / transactional / hostile / indifferent)
9. How fast does trust build? What earns it? What breaks it?
10. What does winning cost? (clean / complicated / suspicious / pyrrhic)
11. How does help arrive? (freely / transactionally / reluctantly / never)
12. What does the world feel like at rest? (safe / tense / hostile / indifferent)
13. What collisions interest you most? (personal / political / survival / all)

Answer as much or as little as you want. I'll derive the rest.

After the player responds, synthesize and emit ledger commands:
---LEDGER---
> MAP_SET world field=constants key=voice value="[synthesized voice]" -- Phase 1 voice
> MAP_SET world field=constants key=tone value="[synthesized tone]" -- Phase 1 tone
> MAP_SET world field=constants key=tone_rules value="1. [Rule] 2. [Rule] 3. [Rule]" -- Exactly 3 tone rules
---END LEDGER---`;

const PHASE_2_PROMPT = `[GRAVITY SETUP — PHASE 2 of 3: Story & Arc]

Do NOT write prose. Present these questions:

STORY — what are we playing?
1. What is the opening arc about? Central question?
2. What should the first chapter focus on?
3. Your character's immediate motivation?
4. Short-term objective?

CONFIGURATION:
5. Role? (Roleplayer / Game Master / Writer)
6. Length? (flexible / 1000-1500 words / under 150 / 150-300)
7. Guidelines? (NSFW / SFW)

After the player responds, emit ledger commands for world setup:
---LEDGER---
> MAP_SET world field=constants key=role value="[role text]" -- Phase 2 role
> MAP_SET world field=constants key=length value="[length text]" -- Phase 2 length
> MAP_SET world field=constants key=guidelines value="[guidelines text]" -- Phase 2 guidelines
> MAP_SET world field=constants key=motivation value="[from answer]" -- Phase 2 motivation
> MAP_SET world field=constants key=objective value="[from answer]" -- Phase 2 objective
> SET world field=world_state value="[macro reality]" -- World state
> APPEND world field=pressure_points value="[seam where forces collide]" -- Pressure
> CREATE faction:name name="[Faction Name]" objective="[goal]" resources="[resources]" stance_toward_pc="[stance]" power="[rising/stable/declining]" momentum="[current action]" leverage="[source of power]" vulnerability="[exploitable weakness]" -- Faction with political profile
> MAP_SET faction:name field=relations key=[other-faction-id] value="[stance toward them]" -- Inter-faction relation
> CREATE chapter:ch1-slug number=1 title="[focus]" status=OPEN arc="[central question]" central_tension="[forced choice]" -- Chapter 1
> CREATE collision:slug name="[name]" forces="force1,force2" status=SEEDED distance=10 -- Initial collision
---END LEDGER---

Create at least 2 factions with opposing or intersecting objectives. For each faction, establish:
- power: their current position (rising/stable/declining)
- momentum: what they are actively doing right now
- leverage: what gives them power over others
- vulnerability: what could be used against them
- relations: how they view each other faction (via MAP_SET)
These political dynamics generate the macro-level pressure that drives the story between chapters.`;

const PHASE_3_PROMPT = `[GRAVITY SETUP — PHASE 3 of 3: Cast & Opening]

Name the principal character (the most important NPC). If not specified, propose one from the scenario.

Build their constraint system (3-4 constraints). For each:
- Name (short, evocative)
- Prevents (what they can't do)
- Threshold (what breaks it)
- Replacement type (sophistication / displacement / depth_shift / regression)

Set their initial intimacy stance — a natural-language description of where this character starts
with the PC physically/sexually. This is NOT a permission level. It describes:
- What they're comfortable with right now and why
- What they'd resist and why
- What would need to change for the stance to shift
Base it on the character's personality, constraints, and relationship to the PC at story start.

Present to the player for confirmation. After confirmation, emit ledger commands:

---LEDGER---
> CREATE char:name name="[Full Name]" tier=PRINCIPAL want="[motivation]" doing="[action]" cost="[risk]" -- Principal
> SET char:name field=intimacy_stance value="[initial stance based on character and relationship]" -- Starting boundary
> CREATE constraint:c1-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=regression shedding_order=1 -- Constraint 1
> CREATE constraint:c2-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=displacement shedding_order=2 -- Constraint 2
> CREATE constraint:c3-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=depth_shift shedding_order=3 -- Constraint 3
> SET pc field=name value="[PC Name]" -- PC init
> APPEND pc field=demonstrated_traits value="[from persona card]" -- Trait
> CREATE char:npc-name name="[NPC]" tier=KNOWN -- Scenario NPC
---END LEDGER---

Then write the opening scene with full deduction and ledger block. The story begins.`;

export {
    getPhase,
    isActive,
    startSetup,
    cancelSetup,
    checkPhaseCompletion,
    getPhasePrompt,
    getPhaseLabel,
    setPhaseCallback,
};
