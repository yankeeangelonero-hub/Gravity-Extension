# Explore Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `explore` challenge profile to Gravity Ledger that reuses the existing challenge engine mechanics (d20 + DC + tarot draw + multi-clash session) but whose doctrine instructs the LLM to introduce new entities — people, places, quests, factions, pressures — in response to player-initiated exploration.

**Architecture:** Pure profile addition. Zero changes to the generic engine (`challenge-state.js`, `challenge-mechanics.js`, `challenge-input.js`, `challenge-shared.js`). The plan creates two new files (`challenge-profile-explore.js`, `explore-state.js`), wires the new entity type through the state and presentation layers, adds a new input button, and publishes a "how to add a profile" guide for future extensions.

**Tech Stack:** Pure JavaScript (ES modules), SillyTavern extension runtime, chatMetadata persistence. No build step, no test framework. Validation: `node -c <file>` for syntax; manual SillyTavern scenarios for behavior.

**Spec:** `docs/superpowers/specs/2026-04-21-explore-profile-design.md`

**Key conventions (from CLAUDE.md and the spec):**
- `consistency.js` validates format only — no per-field gameplay rules.
- `validateTransition` at commit time enforces state-machine transitions.
- `chatMetadata` is the canonical store; snapshots/rollback are generic.
- New `char` entities default to `CAMEO` unless fiction justifies promotion (standing hygiene rail for all explore resolution branches).
- Tarot draw supplies **valence** (boon/threat/twist/hook); d20 vs DC supplies **intensity**. TRANSFORM applies the **rule of cool**: ask the LLM to think of something genuinely interesting the draw can spawn into the scene.

**Implementation order (locked):** State layer → profile + registration → helper file → presentation layer → button wiring → lorebook stubs → documentation → final verification. Each task syntax-checks the files it touched.

---

## File Structure

### New files (3)

| File | Purpose |
|---|---|
| `challenge-profile-explore.js` | Explore profile definition — hooks, thresholds, lorebook keys, per-phase context lines |
| `explore-state.js` | Backward-compatible-style facade over the challenge engine for explore (mirror of `combat-state.js`) |
| `Documentation/Extension/adding_a_challenge_profile.md` | Step-by-step extension guide, uses combat + explore as reference implementations |

### Edited files (9)

| File | Edit type |
|---|---|
| `challenge-profiles.js` | Register explore profile |
| `state-compute.js` | Add `explores: {}` collection; register `explore` in the entity-type map |
| `consistency.js` | Add `explore` to the entity-type map, `VALID_ENTITIES`, and `INITIAL_STATES` |
| `state-machine.js` | Add EXPLORE states and transitions; register in all three machine registries; export |
| `state-view.js` | Add `explore` branch in `formatChallenge`; add active-Explores registry block |
| `ui-panel.js` | Add explore section and runtime helpers |
| `index.js` | Add `MODE_LOREBOOK_KEYS` entries; register `explore` in `getCollectionForEntityType`; add `handleExploreButton`; register `onExplore`; add button DOM + listener; add explore exemplar targets |
| `Gravity World Info.json` | Three new lorebook entry stubs |
| `Documentation/README.md` | Link the new extension guide |

### NOT touched

- `challenge-state.js`, `challenge-mechanics.js`, `challenge-input.js`, `challenge-shared.js` — the generic engine is profile-agnostic by design; explore proves it.
- `ledger-store.js`, `snapshot-mgr.js`, `regex-intercept.js` — infrastructure; they operate over the full state tree and ride along generically.
- `ooc-handler.js`, `setup-wizard.js` — no explore-specific commands in v1.
- `style.css` — UI polish is post-launch; v1 reuses combat's classes.

---

## Task 1: State machine — add EXPLORE states

**Why first:** nothing else can legally write `explore` entities until the transition validator knows about them.

**Files:**
- Modify: `state-machine.js`

- [ ] **Step 1: Add EXPLORE_STATES and EXPLORE_TRANSITIONS constants**

Insert a new block immediately after the `COMBAT_TRANSITIONS` definition (at the end of the "Combat Lifecycle" section in `state-machine.js`, before `// ─── Transition Validator ──`):

```js
// ─── Explore Lifecycle ────────────────────────────────────────────────────────
// ACTIVE → RESOLVED
// Same shape as combat. Single forward transition on clash resolution or
// advance-turn exit.

const EXPLORE_STATES = ['ACTIVE', 'RESOLVED'];

const EXPLORE_TRANSITIONS = {
    ACTIVE: { advance: 'RESOLVED' },
    RESOLVED: {},
};
```

- [ ] **Step 2: Register explore in `validateTransition`'s machine map**

Inside `validateTransition`, modify the `machines` literal (currently at `state-machine.js:81`) to include explore:

```js
const machines = {
    char:       { field: 'tier', transitions: CHARACTER_TRANSITIONS, states: CHARACTER_TIERS },
    constraint: { field: 'integrity', transitions: CONSTRAINT_TRANSITIONS, states: CONSTRAINT_LEVELS },
    collision:  { field: 'status', transitions: COLLISION_TRANSITIONS, states: COLLISION_STATES },
    combat:     { field: 'status', transitions: COMBAT_TRANSITIONS, states: COMBAT_STATES },
    explore:    { field: 'status', transitions: EXPLORE_TRANSITIONS, states: EXPLORE_STATES },
};
```

- [ ] **Step 3: Register explore in `getValidNextStates`'s machine map**

Inside `getValidNextStates` (currently at `state-machine.js:139`), modify the `machines` literal:

```js
const machines = {
    char:       CHARACTER_TRANSITIONS,
    constraint: CONSTRAINT_TRANSITIONS,
    collision:  COLLISION_TRANSITIONS,
    combat:     COMBAT_TRANSITIONS,
    explore:    EXPLORE_TRANSITIONS,
};
```

- [ ] **Step 4: Register explore in `getStateMachineField`'s field map**

Inside `getStateMachineField` (currently at `state-machine.js:175`), modify the `fields` literal:

```js
const fields = {
    char: 'tier',
    constraint: 'integrity',
    collision: 'status',
    combat: 'status',
    explore: 'status',
};
```

- [ ] **Step 5: Add explore constants to the export list**

Modify the bottom `export { … }` block so it includes the two new constants next to the combat ones:

```js
export {
    CHARACTER_TIERS,
    CHARACTER_TRANSITIONS,
    CONSTRAINT_LEVELS,
    CONSTRAINT_TRANSITIONS,
    COLLISION_STATES,
    COLLISION_TRANSITIONS,
    COMBAT_STATES,
    COMBAT_TRANSITIONS,
    EXPLORE_STATES,
    EXPLORE_TRANSITIONS,
    validateTransition,
    getStateMachineField,
};
```

- [ ] **Step 6: Syntax-check**

Run: `node -c state-machine.js`
Expected: no output (success).

- [ ] **Step 7: Commit**

```bash
git add state-machine.js
git commit -m "feat(explore): add EXPLORE state machine (ACTIVE → RESOLVED)

Registers explore in validateTransition, getValidNextStates, and
getStateMachineField so commit-time transition validation covers
the new entity type. Same shape as combat."
```

---

## Task 2: Consistency — register `explore` entity type

**Why next:** once the state machine knows about explore, the format validator must accept it before any profile code can emit CR transactions.

**Files:**
- Modify: `consistency.js`

- [ ] **Step 1: Add `explore` to the entity-type → collection map**

Edit `consistency.js`, at the `ENTITY_TO_COLLECTION` literal (currently at `consistency.js:20`), add the `explore` entry after `combat`:

```js
const ENTITY_TO_COLLECTION = {
    char: 'characters',
    constraint: 'constraints',
    collision: 'collisions',
    combat: 'combats',
    explore: 'explores',
    faction: 'factions',
    place: 'places',
    pressure: 'pressures',
    world: 'world',
    pc: 'pc',
    divination: 'divination',
};
```

- [ ] **Step 2: Add `'explore'` to `VALID_ENTITIES`**

At `consistency.js:44`, extend the `VALID_ENTITIES` array:

```js
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'explore', 'faction', 'place', 'pressure', 'world', 'pc', 'divination'];
```

- [ ] **Step 3: Add `explore: 'ACTIVE'` to `INITIAL_STATES`**

At `consistency.js:346`, extend the inline `INITIAL_STATES` literal:

```js
const INITIAL_STATES = { char: 'UNKNOWN', constraint: 'STABLE', collision: 'ACTIVE', combat: 'ACTIVE', explore: 'ACTIVE' };
```

- [ ] **Step 4: Syntax-check**

Run: `node -c consistency.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add consistency.js
git commit -m "feat(explore): register explore in consistency validator

Adds explore to ENTITY_TO_COLLECTION, VALID_ENTITIES, and the
inline INITIAL_STATES used by the TR auto-fill path."
```

---

## Task 3: state-compute — add `explores` collection

**Why next:** state-compute must materialize `state.explores` before any code paths look it up.

**Files:**
- Modify: `state-compute.js`

- [ ] **Step 1: Add `explores: {}` to `createEmptyState`**

Edit `state-compute.js`, inside `createEmptyState` (currently at `state-compute.js:52`), add the `explores` collection next to `combats`:

```js
function createEmptyState() {
    return {
        characters: {},
        constraints: {},
        collisions: {},
        combats: {},
        explores: {},
        factions: {},
        places: {},
        pressures: {},
        world: {
            world_state: '',
            collision_archive: [],
        },
        pc: {
            name: '',
            demonstrated_traits: [],
            current_scene: '',
        },
        divination: {
            active_system: 'arcana',
            last_draw: null,
            readings: [],
        },
        lastTxId: -1,
        _history: {},
    };
}
```

- [ ] **Step 2: Add `explores` to the State typedef at the top of the file**

The typedef block preceding `createEmptyState` lists `@property {Object<string, Object>} combats` at around `state-compute.js:17`. Add an `explores` line directly under it:

```
 * @property {Object<string, Object>} combats
 * @property {Object<string, Object>} explores
```

- [ ] **Step 3: Register `explore: 'explores'` in `getCollectionName`**

Edit `getCollectionName` (currently at `state-compute.js:268`), add the mapping next to `combat`:

```js
function getCollectionName(entityType) {
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        combat: 'combats',
        explore: 'explores',
        faction: 'factions',
        place: 'places',
        pressure: 'pressures',
        world: 'world',
        pc: 'pc',
        divination: 'divination',
    };
    return map[entityType] || entityType;
}
```

- [ ] **Step 4: Add `'explores'` to the `diffStates` collection list**

Edit `diffStates` (at `state-compute.js:774`). The existing loop omits `combats` as an intentional convention (challenge containers are engine-scoped). Do not add `explores` to `diffStates` — match combat's handling. No edit.

Leave this step as a **no-op verification**. Inspect `state-compute.js:774` and confirm the list reads exactly:
```js
for (const col of ['characters', 'constraints', 'collisions', 'factions', 'places', 'pressures']) {
```
If this is what you see, move on. The `diffStates` signal is used for live-state diff display; combat and explore containers are intentionally excluded to avoid noisy churn each turn.

- [ ] **Step 5: Syntax-check**

Run: `node -c state-compute.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add state-compute.js
git commit -m "feat(explore): add explores collection to state

Registers state.explores and wires explore → explores into the
entity-type map. diffStates list unchanged (challenge containers
are intentionally excluded from diff display, same as combats)."
```

---

## Task 4: Create `challenge-profile-explore.js`

**Why next:** the state layer now supports `explore`; the profile can safely emit CR/S/TR against it.

**Files:**
- Create: `challenge-profile-explore.js`

- [ ] **Step 1: Write the profile module**

Create `challenge-profile-explore.js` with this exact content:

```js
/**
 * challenge-profile-explore.js — Explore profile for the challenge engine.
 *
 * Mechanically mirrors combat (d20 + DC + scene draw + multi-clash session).
 * Doctrinally different: explore is a creative-mandate profile — the player
 * spends a "give me fresh stuff" pass, the tarot draw colors what emerges,
 * and the LLM is authorized (and instructed) to introduce new entities
 * (char, place, constraint, collision, faction, pressure) as a natural
 * part of resolving each clash.
 *
 * Key doctrine:
 * - SUCCESS: introduce the expected kind of thing; draw colors tone.
 * - TRANSFORM: apply the RULE OF COOL — the expected thing isn't there,
 *   the draw decides what genuinely interesting thing IS. Never frame as
 *   a dead miss. Valence (boon/threat/twist/hook) comes from the draw;
 *   intensity (subtle vs. punctuated) comes from the d20 versus DC.
 * - Standing hygiene rail: new `char` entities default to CAMEO tier.
 */

const exploreProfile = Object.freeze({
    kind: 'explore',
    displayName: 'Explore',
    inputPrefix: 'explore',
    deductionType: 'explore',
    entityType: 'explore',

    categories: ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'],
    categoryAliases: Object.freeze([
        Object.freeze({ phrase: 'likely', category: 'Highly likely' }),
        Object.freeze({ phrase: 'unlikely', category: 'Highly unlikely' }),
        Object.freeze({ phrase: 'standard', category: 'Average' }),
        Object.freeze({ phrase: 'even', category: 'Average' }),
        Object.freeze({ phrase: 'auto success', category: 'Absolute' }),
        Object.freeze({ phrase: 'auto-success', category: 'Absolute' }),
        Object.freeze({ phrase: 'auto fail', category: 'Impossible' }),
        Object.freeze({ phrase: 'auto-fail', category: 'Impossible' }),
    ]),
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

    phases: ['setup_opening', 'setup_buffered', 'awaiting_choice', 'awaiting_resolution', 'awaiting_reassessment', 'cleanup_grace'],

    optionCount: [3, 4],
    optionPrefix: 'explore',

    seedFields: Object.freeze({ kind: 'explore', status: 'ACTIVE' }),
    modelFields: ['target', 'outcome', 'aftermath'],
    resolutionFields: ['outcome', 'aftermath'],

    lorebookKeys: Object.freeze({
        core: 'gravity_mode_explore_core',
        optional: 'gravity_mode_explore_optional_examples',
        prose: 'gravity_prose_explore',
    }),

    getBaseline(state, entity) {
        // Explore has no opponent. Baseline is always Average; the LLM
        // assigns per-option categories by boldness / stealth / risk.
        // Only `category` is consumed by the engine; other fields are
        // profile-private context used by prompt + UI.
        return {
            category: 'Average',
            gap: null,
            target: entity?.target || null,
        };
    },

    resolveParticipants(state, entity) {
        const pc = {
            entity_type: 'pc',
            id: 'pc',
            name: state?.pc?.name || 'PC',
            equipment: state?.pc?.equipment || '',
        };
        return { pc, opponents: [], allies: [] };
    },

    describeActor(actor) {
        if (!actor) return '(unknown)';
        const parts = [`${actor.name || actor.id || 'Unknown'}`];
        if (actor.equipment) parts.push(`equipment: ${actor.equipment}`);
        return parts.join(' | ');
    },

    buildContextLines(runtime, entity, state, baseline, helpers) {
        const {
            formatDrawBlock,
            formatActionSummary,
            formatRollSummary,
            buildPromptOptionsBlock,
            describeSuccessThreshold,
            describeDcTable,
            dcTable,
        } = helpers;
        const lines = [];

        lines.push(`Challenge runtime is active for explore:${runtime.entity_id}.`);
        lines.push(`Challenge lock: ${runtime.locked ? 'engaged' : 'released'}`);
        lines.push(`Phase: ${runtime.phase}`);
        lines.push(`Difficulty mode: ${runtime.difficulty_mode}`);
        lines.push(`Success thresholds: ${describeDcTable(dcTable)}`);
        lines.push(`Scene draw:\n${formatDrawBlock(runtime.scene_draw, {
            stripNarrativeForcing: true,
            active: runtime.scene_draw_active,
            guidance: runtime.scene_draw_active
                ? 'Explore setup usage: use this draw to color the LOCATION — its atmosphere, era, mood, the visible leads standing out, and why the opening options sit at their assessed categories. It reveals the shape and feel of the place; it does not force a separate event or resolve the clash by itself.'
                : 'Scene draw has expired. Do not use it for further clashes.',
        })}`);
        lines.push('');
        lines.push('PLAYER EXPLORER PROFILE');
        const pcName = state?.pc?.name || 'PC';
        const pcEquip = state?.pc?.equipment ? ` | equipment: ${state.pc.equipment}` : '';
        lines.push(`  ${pcName}${pcEquip}`);

        if (entity) {
            lines.push('');
            lines.push(`EXPLORE ENTITY (${entity.id || runtime.entity_id})`);
            lines.push('  This explore container already exists. Do not create it again; only set or update its fields.');
            if (entity.status) lines.push(`  Status: ${entity.status}`);
            if (entity.target) lines.push(`  Target: ${entity.target}`);
            if (entity.outcome) lines.push(`  Outcome: ${entity.outcome}`);
            if (entity.aftermath) lines.push(`  Aftermath: ${entity.aftermath}`);
        } else {
            lines.push('');
            lines.push('The extension auto-seeded the explore entity. Do not create it again. Fill its fields this turn.');
        }

        lines.push('');
        lines.push(`BASELINE: ${baseline.category}${baseline.target ? ` | target: ${baseline.target}` : ''}${baseline.category === 'Highly likely' || baseline.category === 'Average' || baseline.category === 'Highly unlikely' ? ` | threshold ${describeSuccessThreshold(baseline.category, dcTable[baseline.category])}` : ''}`);

        lines.push('');
        lines.push('STORED OPTIONS');
        lines.push(buildPromptOptionsBlock(runtime.options));

        if (runtime.pending_action) {
            lines.push('');
            lines.push(`PENDING ACTION: ${formatActionSummary(runtime.pending_action)}`);
            if (runtime.pending_action.source === 'custom') {
                lines.push('This turn came from a custom explore command. The action intent has already been parsed into CHALLENGE_MECHANICS and PENDING ACTION. Do not treat the player message as a regular prose turn.');
            }
        }
        if (runtime.pending_roll) {
            lines.push(`PENDING ROLL: ${formatRollSummary(runtime.pending_roll)}`);
            if (!runtime.pending_roll.skip) {
                lines.push(`MECHANICAL RESULT: category ${runtime.pending_roll.category || '?'} | threshold ${describeSuccessThreshold(runtime.pending_roll.category, runtime.pending_roll.dc)} | rolled ${runtime.pending_roll.d20} => ${runtime.pending_roll.resolution || (runtime.pending_roll.success ? 'SUCCESS' : 'TRANSFORM')}`);
                lines.push('These are compressed success thresholds, not open-ended narrative difficulty labels. Only the d20 is compared to the threshold. The draw card / dice table result is interpretive context, not the mechanical roll total.');
            }
            if (runtime.pending_roll.draw) {
                lines.push(`ROLL DRAW:\n${formatDrawBlock(runtime.pending_roll.draw, {
                    stripNarrativeForcing: true,
                    guidance: 'Explore resolution usage: this draw supplies valence (boon/threat/twist/hook). On SUCCESS the draw colors the tone of the expected find. On TRANSFORM apply the RULE OF COOL — the expected thing is not there, and the draw determines what genuinely interesting thing IS. Never compare the draw number to the threshold.',
                })}`);
            }
        }
        if (runtime.last_resolution) {
            lines.push('');
            lines.push(`LAST RESOLUTION: clash ${runtime.last_resolution.clash} | ${formatActionSummary(runtime.last_resolution.action)}`);
            lines.push(`LAST ROLL: ${formatRollSummary(runtime.last_resolution.roll)}`);
        }

        lines.push('');
        lines.push('OPTION HTML — when explore is waiting for a player choice, output 3-4 clickable options in exactly this format:');
        lines.push('<span class="act" data-value="explore: option | opt-e1-v1-1 | 1 | Highly likely | Skim the public stalls for oddities">1. Skim the public stalls (Highly likely)</span>');
        lines.push('The player may answer with `explore:2` to pick option 2, or `explore: sneak into the back rooms DC Highly unlikely` for a declared custom action.');

        lines.push('');
        lines.push('ENTITY INTRODUCTION AUTHORIZATION');
        lines.push('Explore is a creative-mandate profile. You are AUTHORIZED and EXPECTED to introduce new entities (char, place, constraint, collision, faction, pressure) as part of resolving each clash. Branch doctrine:');
        lines.push('- SUCCESS (d20 ≥ DC): introduce 1 new entity of the expected kind for the chosen option. Draw colors tone.');
        lines.push('- CRITICAL_SUCCESS (nat 20): amplified find. Up to 2 entities. `collision` quest-hooks and `faction` seeds authorized.');
        lines.push('- TRANSFORM (d20 < DC, non-critical): the expected thing isn\'t there. APPLY THE RULE OF COOL — read the draw and introduce the most interesting thing this location could plausibly hold given that draw. 1 entity, any type. Draw chooses the type: boon (injured dragon in the vault), threat (body in the vault), twist (vault is empty and that matters), or hook (someone else\'s secret).');
        lines.push('- CRITICAL_TRANSFORM (nat 1): starkly different, weighty. Rule of cool at full amplification. Up to 2 entities, any types, memorable. Could be windfall or catastrophe — the draw decides.');
        lines.push('- AUTO_SUCCESS (Absolute): narrate, no draw, no authorized entity introduction.');
        lines.push('- AUTO_FAIL (Impossible): narrate, no draw, no authorized entity introduction.');
        lines.push('STANDING HYGIENE RAIL: new `char` entities default to `CAMEO` tier unless the fiction clearly justifies promotion. Do not bloat the character roster with SUPPORTING-tier strangers.');

        // Phase instructions
        switch (runtime.phase) {
            case 'setup_opening':
            case 'setup_buffered':
                lines.push('');
                lines.push('PHASE INSTRUCTION: SETUP');
                if (runtime.phase === 'setup_buffered') {
                    lines.push('Setup is incomplete, but the player already committed to an action while setup had not advanced.');
                    lines.push(`explore:${runtime.entity_id} already exists. Do not create it again.`);
                    lines.push(`Fill explore:${runtime.entity_id} field: target (a short string naming the place being explored — "the market", "the ruined chapel", "the captain\'s quarters"). Carry atmosphere, sensory detail, and visible leads in scene prose, not in persisted fields.`);
                    lines.push('Then immediately resolve the buffered player action this same turn.');
                    if (runtime.pending_action.assessment_only) {
                        lines.push('Because the buffered action had no declared category, assess it honestly after setup and then output 3-4 clickable options instead of silently ignoring it.');
                        lines.push('Use the scene draw to clarify the location frame and why those options land at their categories, not to inject a separate surprise event.');
                    } else {
                        lines.push('A pending action and pending roll payload are already stored. Use them. Do not reinterpret the scene draw as the resolution roll.');
                        lines.push('Do not downgrade this buffered declared action into a fresh assessment step or a replacement option set first. Resolve the stored action now using the injected category, threshold, d20, and draw.');
                        lines.push('If this buffered action was rolled, record divination.last_draw in the update block this same turn.');
                        lines.push('End with the next 3-4 clickable options if the location still holds leads.');
                    }
                } else {
                    lines.push(`The extension auto-seeded explore:${runtime.entity_id}. Do not create it again.`);
                    lines.push('Set `target` on the explore container from CHALLENGE_INPUT. If the player invoked explore without naming a target (empty input), either render their immediate surroundings as 3-4 explorable target options, or ask the player what they want to explore. Once a target is committed, fill it this turn.');
                    lines.push('Use the scene draw to paint the location: its atmosphere, era, mood, visible leads standing out from the background, and why the opening options fall where they do.');
                    lines.push('Do not resolve the first clash yet. Stop on the opening situation and output 3-4 clickable options.');
                }
                break;
            case 'awaiting_choice':
                lines.push('');
                lines.push('PHASE INSTRUCTION: WAITING FOR PLAYER CHOICE');
                if (runtime.pending_action?.assessment_only) {
                    lines.push('The player typed a freeform explore action without a category.');
                    lines.push('Do not resolve it yet.');
                    lines.push('Assess that action against the baseline and output 3-4 clickable options.');
                    lines.push('CHALLENGE_INPUT already contains the intended move. The first option should capture that intent with your judged category if it is credible.');
                } else {
                    lines.push('Explore is active but no valid option list is stored.');
                    lines.push('Output 3-4 clickable explore options using the exact explore HTML format.');
                }
                break;
            case 'awaiting_resolution':
                lines.push('');
                lines.push('PHASE INSTRUCTION: RESOLVE ONE CLASH');
                lines.push('Resolve exactly one clash, then stop and output the next 3-4 clickable options if the location still holds leads.');
                if (runtime.pending_roll?.skip) {
                    lines.push(`This action ${runtime.pending_roll.reason === 'absolute' ? 'auto-succeeds' : 'auto-fails'}. Narrate it happening. No roll interpretation is needed. Do not introduce new entities on auto branches.`);
                } else if (runtime.pending_roll) {
                    lines.push(`Mechanical resolution is already fixed: ${runtime.pending_roll.category || '?'} action | threshold ${describeSuccessThreshold(runtime.pending_roll.category, runtime.pending_roll.dc)} | rolled ${runtime.pending_roll.d20} => ${runtime.pending_roll.resolution || (runtime.pending_roll.success ? 'SUCCESS' : 'TRANSFORM')}.`);
                    lines.push('Do not reinterpret the threshold from the number alone. Treat the injected category as canonical, and do not compare the draw card / table number to the threshold. The draw is interpretive only.');
                    lines.push('Do not decide success or transform yourself. The extension already decided it.');
                    lines.push('Interpret the explore draw explicitly. Apply the ENTITY INTRODUCTION AUTHORIZATION block above to this resolution.');
                    lines.push('- On SUCCESS: the draw colors the tone of the expected kind of find. Introduce 1 entity of that kind. Write CR transactions in the update block.');
                    lines.push('- On TRANSFORM: apply the RULE OF COOL. The expected thing isn\'t there; ask yourself what is the most interesting thing this location could plausibly hold, given the draw, and introduce it. 1 entity, any type. Never a dead miss.');
                    lines.push('- On CRITICAL_SUCCESS: amplified find. Up to 2 entities. Quest hooks and faction seeds authorized.');
                    lines.push('- On CRITICAL_TRANSFORM: starkly different, weighty. Rule of cool at full amplification. Up to 2 entities, any types.');
                    lines.push('Record divination.last_draw in the update block for rolled clashes.');
                }
                lines.push('If the clash naturally triggers combat (ambush, recognition, escalation), spawn a `collision` with combat intent and close explore this same turn: write `outcome` + `aftermath`, TR status ACTIVE→RESOLVED, and destroy the explore entity. The collision opens combat on the next turn via existing activation.');
                lines.push('If the location is tapped out, close the session: write `outcome` + `aftermath`, TR status ACTIVE→RESOLVED, destroy the explore entity. Otherwise output 3-4 clickable next-lead options.');
                break;
            case 'awaiting_reassessment':
                lines.push('');
                lines.push('PHASE INSTRUCTION: REASSESS TOO-GENEROUS CUSTOM DIFFICULTY');
                lines.push('Challenge the player\'s declared difficulty before resolving.');
                lines.push('Do not spend the stored d20/draw. Preserve them for the next reassessed turn.');
                lines.push('Explain why the declared category was too generous compared to the baseline and location reality.');
                break;
            case 'cleanup_grace':
                lines.push('');
                lines.push('PHASE INSTRUCTION: POST-EXPLORE CLEANUP');
                lines.push('Exploration has resolved. Before normal play fully resumes, write any final persistent consequences and destroy the explore entity if it still exists.');
                lines.push('Ensure any entities introduced during the session are persisted via their own CR transactions.');
                lines.push('Do not output new explore options.');
                break;
        }

        return lines;
    },

    sceneDrawGuidance() {
        return 'location atmosphere, era, mood, visible leads, and why the opening options fall at their assessed categories';
    },

    resultDrawGuidance() {
        return 'supplies valence (boon/threat/twist/hook). SUCCESS: colors the tone of the expected find. TRANSFORM: rule of cool — determines what genuinely interesting thing emerges instead.';
    },

    setupGuidance() {
        return 'The extension already seeded the explore entity. Do not create it again. Set `target` on it from the player input. If the player named no target, render immediate surroundings as options or ask. Carry atmosphere, sensory detail, and visible leads in scene prose, not in persisted fields.';
    },

    cleanupGuidance() {
        return 'Write `outcome` + `aftermath` on the explore entity, persist any CR\'d entities introduced during the session, destroy the explore entity. On advance-turn exit: close the session this same turn — write outcome/aftermath, TR status ACTIVE→RESOLVED, destroy the explore entity, carry any persistent discoveries forward as their own CR transactions before closing.';
    },

    validateTurn(runtime, state, committedTxns) {
        const entity = state?.explores?.[runtime?.entity_id];
        if (!entity) return null;

        const postSetup = runtime?.phase === 'awaiting_choice'
            || runtime?.phase === 'awaiting_resolution'
            || runtime?.phase === 'awaiting_reassessment'
            || runtime?.phase === 'cleanup_grace';

        if (!postSetup) return null;

        if (!entity.target) {
            return `Explore is active but explore:${runtime.entity_id} is missing required field: target. Set a short string naming the place being explored (e.g. "the market", "the ruined chapel") before continuing.`;
        }
        return null;
    },

    initProfileState(state) {
        return {};
    },

    isResolved(runtime, entity, state, committedTxns) {
        // Dual-check is intentional. The engine may call this in a turn where
        // the LLM emits both `TR status RESOLVED` and `D explore` in the same
        // ---LEDGER--- block. Depending on ordering, `entity` may already be
        // gone from state but the TR still shows up in `committedTxns`.
        // Checking both sides prevents the runtime from failing to unlock on
        // that race. Keep both branches.
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

export default exploreProfile;
```

- [ ] **Step 2: Syntax-check**

Run: `node -c challenge-profile-explore.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add challenge-profile-explore.js
git commit -m "feat(explore): add explore challenge profile

New profile registered to the challenge engine: d20 + DC + scene
draw + multi-clash session, but doctrinally a creative-mandate
profile. SUCCESS introduces an expected-kind entity; TRANSFORM
applies the rule of cool. Valence from draw, intensity from d20."
```

---

## Task 5: Register explore profile in `challenge-profiles.js`

**Why next:** the profile file exists but is invisible to the engine until it is in `PROFILES`.

**Files:**
- Modify: `challenge-profiles.js`

- [ ] **Step 1: Import and register**

Replace the full contents of `challenge-profiles.js` with:

```js
/**
 * challenge-profiles.js — Profile registry for the challenge engine.
 *
 * Registers all challenge profiles and provides lookup by kind or input prefix.
 */

import combatProfile from './challenge-profile-combat.js';
import exploreProfile from './challenge-profile-explore.js';

const PROFILES = Object.freeze({
    combat: combatProfile,
    explore: exploreProfile,
});

function getProfile(kind) {
    return PROFILES[kind] || null;
}

function getProfileByPrefix(prefix) {
    if (!prefix) return null;
    const lower = prefix.toLowerCase();
    return Object.values(PROFILES).find(p => p.inputPrefix.toLowerCase() === lower) || null;
}

function detectChallengePrefix(rawText) {
    const text = String(rawText || '').replace(/^\*/, '');
    for (const profile of Object.values(PROFILES)) {
        const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^${escaped}:`, 'i').test(text)) {
            return profile;
        }
    }
    return null;
}

function listProfiles() {
    return Object.keys(PROFILES);
}

export {
    getProfile,
    getProfileByPrefix,
    detectChallengePrefix,
    listProfiles,
};
```

- [ ] **Step 2: Syntax-check**

Run: `node -c challenge-profiles.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add challenge-profiles.js
git commit -m "feat(explore): register explore profile in PROFILES

Imports challenge-profile-explore.js and exposes it through the
engine registry. detectChallengePrefix picks up the 'explore:'
input prefix automatically."
```

---

## Task 6: Create `explore-state.js` facade

**Why next:** `ui-panel.js` needs the same ergonomic helpers it uses for combat.

**Files:**
- Create: `explore-state.js`

- [ ] **Step 1: Write the facade module**

Create `explore-state.js` with this exact content:

```js
/**
 * explore-state.js — Backward-compatible-style facade over the challenge engine for explore.
 *
 * Mirror of combat-state.js. Keeps UI and other call sites thin by exposing
 * explore-flavored wrappers over the generic challenge engine.
 */

import {
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
} from './challenge-state.js';

import { getProfile } from './challenge-profiles.js';

// ─── Legacy Constants ─────────────────────────────────────────────────────────

const RUNTIME_KEY = CHALLENGE_RUNTIME_KEY;
const SETTINGS_KEY = CHALLENGE_SETTINGS_KEY;

const exploreProfile = getProfile('explore');

const CATEGORY_ORDER = exploreProfile?.categories || ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'];
const DEFAULT_DC_TABLES = exploreProfile?.thresholdTables || {};

// ─── Wrappers ─────────────────────────────────────────────────────────────────

function normalizeCategory(value) {
    return normalizeCategoryForProfile(value, exploreProfile);
}

function categoryStep(category) {
    return categoryStepForProfile(category, exploreProfile);
}

function categoryFromStep(step) {
    return categoryFromStepForProfile(step, exploreProfile);
}

function buildDcTableLegacy(settings) {
    const mode = settings?.mode || exploreProfile?.defaultMode || 'Cinematic';
    return buildDcTable(mode, exploreProfile, settings?.custom_dcs);
}

function getExploreSettings() {
    return getChallengeSettings('explore');
}

async function setExploreDifficultyMode(mode) {
    return setChallengeDifficultyMode('explore', mode);
}

async function setExploreCustomDcs(customDcs) {
    return setChallengeCustomDcs('explore', customDcs);
}

function getExploreRuntime() {
    return getChallengeRuntime();
}

async function setExploreRuntime(runtime) {
    return setChallengeRuntime(runtime);
}

async function clearExploreRuntime() {
    return clearChallengeRuntime();
}

function isExploreRuntimeActive() {
    return isChallengeRuntimeActive();
}

function isExploreLocked() {
    return isChallengeSessionLocked();
}

async function startExploreSetupRuntime(spawnDraw) {
    return startChallengeRuntime('explore', spawnDraw);
}

function getExploreEntity(state, runtime) {
    return getChallengeEntity(state, runtime);
}

function getActiveExploreEntity(state) {
    return getActiveChallengeEntity(state, 'explore');
}

function getExploreBaseline(state, runtime, explore) {
    const profile = getProfile('explore');
    if (!profile) return { category: 'Average', gap: null, target: null };
    const entity = explore || getChallengeEntity(state, runtime);
    return profile.getBaseline(state, entity);
}

function buildExplorePrompt(state) {
    return buildChallengePrompt(state);
}

function parseExploreOptionsFromMessage(text) {
    return parseChallengeOptionsFromMessage(text, exploreProfile);
}

async function handleExploreActionSelection(rawText, state, drawFn) {
    return handleChallengeActionSelection(rawText, state, drawFn);
}

async function processExploreAssistantTurn(state, committedTxns, messageText) {
    return processChallengeAssistantTurn(state, committedTxns, messageText);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
    RUNTIME_KEY,
    SETTINGS_KEY,
    CATEGORY_ORDER,
    DEFAULT_DC_TABLES,
    normalizeCategory,
    categoryStep,
    categoryFromStep,
    buildDcTableLegacy as buildDcTable,
    getExploreSettings,
    setExploreDifficultyMode,
    setExploreCustomDcs,
    getExploreRuntime,
    setExploreRuntime,
    clearExploreRuntime,
    isExploreRuntimeActive,
    isExploreLocked,
    startExploreSetupRuntime,
    getExploreEntity,
    getActiveExploreEntity,
    getExploreBaseline,
    buildExplorePrompt,
    parseExploreOptionsFromMessage,
    handleExploreActionSelection,
    processExploreAssistantTurn,
    formatRollSummary,
};
```

- [ ] **Step 2: Syntax-check**

Run: `node -c explore-state.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add explore-state.js
git commit -m "feat(explore): add explore-state facade

Mirror of combat-state.js. Provides explore-flavored wrappers
over the generic challenge engine for UI and call-site use.
Settings are namespaced per profile ('explore')."
```

---

## Task 7: state-view — add explore formatting

**Why next:** once state.explores can exist, the state-view prompt injection must include them in the active-challenge registry.

**Files:**
- Modify: `state-view.js`

- [ ] **Step 1: Add explore branch to `formatChallenge`**

Open `state-view.js`. The current `formatChallenge` function (at `state-view.js:114`) ends with:
```js
    // Future challenge types slot in here.
    return lines;
}
```

Replace the `// Future challenge types slot in here.` comment line with an explore branch, so `formatChallenge` ends with:

```js
    if (type === 'explore') {
        if (compact) {
            let line = `  ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}]`;
            if (challenge.target) line += ` — target: ${challenge.target}`;
            line += ` → id: ${challenge.id}`;
            lines.push(line);
        } else {
            lines.push(`  🧭 ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}] → id: ${challenge.id}`);
            if (challenge.target) lines.push(`    Target: ${challenge.target}`);
            if (challenge.outcome) lines.push(`    Outcome: ${challenge.outcome}`);
            if (challenge.aftermath) lines.push(`    Aftermath: ${challenge.aftermath}`);
        }
        return lines;
    }
    // Future challenge types slot in here.
    return lines;
}
```

- [ ] **Step 2: Update the `formatChallenge` docblock**

The comment above `formatChallenge` (at `state-view.js:105-113`) says "Today only `combat` is implemented". Update the comment block to read:

```js
/**
 * Dispatch challenge entity formatting by type (§7.3 rule 3).
 * Reads `kind` first, falling back to `challenge_type` for spec-matching code paths.
 * Currently implemented: `combat`, `explore`. Future challenge types add their own
 * branch without touching this function's callers.
 * @param {Object} challenge
 * @param {Object} opts — { compact: boolean } compact=true for registry listing
 * @returns {string[]} lines to push into the state view
 */
```

- [ ] **Step 3: Add active-Explores registry block**

Edit `state-view.js` in `formatStateView`. Locate the Combats registry block (at `state-view.js:311-319`):

```js
    // Combats — always show registry if active (routed through formatChallenge, §7.3 rule 3)
    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            lines.push(...formatChallenge(combat, { compact: true }));
        }
    }
```

Insert a symmetric Explores block immediately after it:

```js
    // Explores — always show registry if active (routed through formatChallenge)
    const activeExplores = Object.values(state.explores || {}).filter(ex => String(ex.status || '').toUpperCase() !== 'RESOLVED');
    if (activeExplores.length) {
        lines.push('');
        lines.push('Explores:');
        for (const explore of activeExplores) {
            lines.push(...formatChallenge(explore, { compact: true }));
        }
    }
```

- [ ] **Step 4: Syntax-check**

Run: `node -c state-view.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add state-view.js
git commit -m "feat(explore): format explore entities in state view

Adds explore branch to formatChallenge and surfaces active
explores in the injected state prompt next to the Combats block."
```

---

## Task 8: index.js — register explore in lorebook keys, collection map, exemplar targets

**Why next:** wire the engine plumbing in index.js before adding the button so the button has everything it needs.

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add explore lorebook keys to `MODE_LOREBOOK_KEYS`**

At `index.js:144-157`, modify the `MODE_LOREBOOK_KEYS` literal to add explore entries next to the combat ones:

```js
const MODE_LOREBOOK_KEYS = Object.freeze({
    advanceCore: 'gravity_mode_advance_core',
    advanceOptional: 'gravity_mode_advance_optional_examples',
    combatCore: 'gravity_mode_combat_core',
    combatOptional: 'gravity_mode_combat_optional_examples',
    exploreCore: 'gravity_mode_explore_core',
    exploreOptional: 'gravity_mode_explore_optional_examples',
    intimacyCore: 'gravity_mode_intimacy_core',
    intimacyOptional: 'gravity_mode_intimacy_optional_examples',
    timeskipCore: 'gravity_mode_timeskip_core',
    // prose modulation keys (fired alongside mode gameplay keys)
    proseRegular: 'gravity_prose_regular',
    proseCombat: 'gravity_prose_combat',
    proseExplore: 'gravity_prose_explore',
    proseIntimacy: 'gravity_prose_intimacy',
    proseAdvance: 'gravity_prose_advance',
});
```

- [ ] **Step 2: Register explore in `getCollectionForEntityType`**

At `index.js:159-172`, modify the `map` literal inside `getCollectionForEntityType` to add explore:

```js
function getCollectionForEntityType(state, entityType) {
    if (!state || !entityType) return null;
    const map = {
        char: state.characters,
        constraint: state.constraints,
        collision: state.collisions,
        combat: state.combats,
        explore: state.explores,
        faction: state.factions,
        world: state.world,
        pc: state.pc,
        divination: state.divination,
    };
    return map[entityType] || null;
}
```

- [ ] **Step 3: Add explore to `getExemplarTargets`**

At `index.js:283-288`, modify `getExemplarTargets` so it routes `deductionType === 'explore'` to explore-flavored exemplars:

```js
function getExemplarTargets(activeMode, deductionType) {
    if (deductionType === 'combat') return ['combat', 'arrival', 'scene'];
    if (deductionType === 'explore') return ['explore', 'scene', 'dialogue'];
    if (deductionType === 'intimacy') return ['intimacy', 'dialogue', 'scene'];
    if (activeMode === 'advance') return ['advance', 'arrival', 'scene'];
    return ['dialogue', 'scene', 'arrival', 'regular'];
}
```

- [ ] **Step 4: Syntax-check**

Run: `node -c index.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(explore): wire explore plumbing in index.js

Adds exploreCore/exploreOptional/proseExplore lorebook keys,
registers explore → state.explores in getCollectionForEntityType,
and routes deductionType='explore' to explore-flavored exemplars."
```

---

## Task 9: index.js — handleExploreButton + button DOM + listener + bootstrap

**Why next:** plumbing is in place; now add the user-facing invocation surface.

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add `handleExploreButton` next to `handleCombatButton`**

Edit `index.js`. Locate `handleCombatButton` (at `index.js:2147-2156`):

```js
async function handleCombatButton() {
    if (!isChallengeSessionLocked()) {
        await startChallengeRuntime('combat', drawDivination());
        _currentState = computeCurrentState();
        _pendingDeductionType = 'combat';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
    }
    insertChatMessage('combat: ');
}
```

Immediately after it, add:

```js
async function handleExploreButton() {
    if (isChallengeSessionLocked()) {
        toastr.info('Finish the current challenge session before starting a new one.');
        return;
    }
    await startChallengeRuntime('explore', drawDivination());
    _currentState = computeCurrentState();
    _pendingDeductionType = 'explore';
    injectPrompt('advance');
    updatePanel(_currentState, _turnCounter);
    insertChatMessage('explore: ');
}
```

Note: combat's button does `insertChatMessage('combat: ')` before exiting but only starts the runtime if unlocked. Explore's button tightens the guard so clicking explore while combat is locked shows a toast instead of inserting an explore prefix that would be rejected. This also satisfies Section 12 of the spec (symmetric cross-profile guard).

- [ ] **Step 2: Register `onExplore` callback in bootstrap `setCallbacks`**

In the bootstrap IIFE, at `index.js:2387-2403`, modify the `setCallbacks` call to include `onExplore`:

```js
    setCallbacks({
        onExport: handleExportLedger,
        onImport: handleImportLedger,
        onNew: handleNewChat,
        onSetup: handleSetupButton,
        onTimeskip: handleTimeskipButton,
        onRegister: handleRegisterButton,
        onAdvance: handleAdvanceButton,
        onRevertTurn: handleRevertTurn,
        onGoodTurn: handleGoodTurnButton,
        onCombat: handleCombatButton,
        onExplore: handleExploreButton,
        onPowerReview: handlePowerReviewButton,
        onIntimacy: handleIntimacyButton,
        onDivinationChange: async (system) => {
            await setDivinationSystem(system);
            toastr.info(`Divination system: ${system}`);
        },
    });
```

- [ ] **Step 3: Add explore button to the input bar**

At `index.js:2442-2450`, modify `createInputButtons`'s `bar.innerHTML` to add an Explore button next to Combat:

```js
    bar.innerHTML = `
        <button class="gl-input-btn" id="gl-input-advance" title="Advance — world takes a turn"><i class="fa-solid fa-play"></i> Advance</button>
        <button class="gl-input-btn" id="gl-input-combat" title="Initiate combat"><i class="fa-solid fa-burst"></i> Combat</button>
        <button class="gl-input-btn" id="gl-input-explore" title="Begin exploration"><i class="fa-solid fa-compass"></i> Explore</button>
        <button class="gl-input-btn" id="gl-input-intimacy" title="Initiate intimate scene"><i class="fa-solid fa-heart"></i> Intimacy</button>
        <button class="gl-input-btn" id="gl-input-skip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
        <button class="gl-input-btn" id="gl-input-good" title="Flag good prose — paste exemplar"><i class="fa-solid fa-thumbs-up"></i> Good</button>
    `;
```

- [ ] **Step 4: Wire the click listener**

Immediately after the combat listener in `createInputButtons` (at `index.js:2454`), add the explore listener. The listener block should now read:

```js
    document.getElementById('gl-input-advance').addEventListener('click', handleAdvanceButton);
    document.getElementById('gl-input-combat').addEventListener('click', handleCombatButton);
    document.getElementById('gl-input-explore').addEventListener('click', handleExploreButton);
    document.getElementById('gl-input-intimacy').addEventListener('click', handleIntimacyButton);
    document.getElementById('gl-input-skip').addEventListener('click', handleTimeskipButton);
    document.getElementById('gl-input-good').addEventListener('click', handleGoodTurnButton);
```

- [ ] **Step 5: Syntax-check**

Run: `node -c index.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat(explore): add Explore input button + handler

handleExploreButton starts an explore challenge runtime (guarded
against overlap with an active combat session) and inserts the
'explore: ' prefix into the composer. Button uses fa-compass."
```

---

## Task 10: ui-panel — add Explore section and runtime helpers

**Why next:** the UI panel can surface the active runtime to the user.

**Files:**
- Modify: `ui-panel.js`

- [ ] **Step 1: Import explore-state helpers**

At the top of `ui-panel.js` (the existing import block at `ui-panel.js:12-20`), add an explore-state import immediately after the combat-state import:

```js
import {
    buildDcTable,
    getCombatBaseline,
    getCombatEntity,
    getCombatRuntime,
    getCombatSettings,
    setCombatCustomDcs,
    setCombatDifficultyMode,
} from './combat-state.js';
import {
    getExploreBaseline,
    getExploreEntity,
    getExploreRuntime,
    getExploreSettings,
    setExploreCustomDcs,
    setExploreDifficultyMode,
    buildDcTable as buildExploreDcTable,
} from './explore-state.js';
```

- [ ] **Step 2: Add `_onExplore` callback and wire it in `setCallbacks`**

At `ui-panel.js:34`, immediately after `let _onCombat = null;`, add:

```js
let _onExplore = null;
```

At `ui-panel.js:64`, modify the `setCallbacks` signature to include `onExplore`:

```js
function setCallbacks({ onExport, onImport, onNew, onSetup, onTimeskip, onRegister, onAdvance, onRevertTurn, onGoodTurn, onCombat, onExplore, onPowerReview, onDivinationChange, onIntimacy }) {
```

Inside the function body, next to `_onCombat = onCombat;`, add:

```js
    _onExplore = onExplore;
```

- [ ] **Step 3: Add explore helpers mirroring the combat pair**

Directly after `syncCombatDifficultyControls` (at `ui-panel.js:62`), add:

```js
function getExploreThresholdTable(settings) {
    return buildExploreDcTable(settings);
}

function renderExploreModeOptions(selectedMode) {
    return [
        'Cinematic',
        'Gritty',
        'Heroic',
        'Survival',
        'Custom',
    ].map(mode => `<option value="${mode}"${selectedMode === mode ? ' selected' : ''}>${mode}</option>`).join('');
}

function syncExploreDifficultyControls() {
    const settings = getExploreSettings();
    const thresholds = getExploreThresholdTable(settings);
    const commandSelect = document.getElementById('gl-cmd-explore-mode');
    if (commandSelect) commandSelect.value = settings.mode;
    const summary = document.getElementById('gl-cmd-explore-thresholds');
    if (summary) {
        summary.textContent = `HL ${thresholds['Highly likely']}+ | Avg ${thresholds.Average}+ | HU ${thresholds['Highly unlikely']}+`;
    }
}
```

- [ ] **Step 4: Add Explore command button and difficulty selector to the command bar**

At `ui-panel.js:245-254`, the command bar HTML currently reads:

```
            <button class="gl-cmd-btn" data-cmd="combat" title="Initiate combat — fight this"><i class="fa-solid fa-burst"></i> Combat</button>
            <label class="gl-d-row" style="display:inline-flex;align-items:center;gap:6px;margin:0 6px;" title="Combat difficulty mode">
                <span style="font-size:11px;opacity:.8;">Difficulty</span>
                <select class="gl-div-select" id="gl-cmd-combat-mode" style="height:26px;padding:2px 6px;">
                    ${renderCombatModeOptions(getCombatSettings().mode)}
                </select>
                <span class="gl-history-time" id="gl-cmd-combat-thresholds"></span>
            </label>
            <button class="gl-cmd-btn" data-cmd="power_review" title="Request an OOC review of current combat power"><i class="fa-solid fa-scale-balanced"></i> Power Review</button>
            <button class="gl-cmd-btn" data-cmd="intimacy" title="Initiate intimate scene"><i class="fa-solid fa-heart"></i> Intimacy</button>
```

Insert an Explore block between `power_review` and `intimacy`:

```
            <button class="gl-cmd-btn" data-cmd="power_review" title="Request an OOC review of current combat power"><i class="fa-solid fa-scale-balanced"></i> Power Review</button>
            <button class="gl-cmd-btn" data-cmd="explore" title="Begin exploration — give me fresh stuff"><i class="fa-solid fa-compass"></i> Explore</button>
            <label class="gl-d-row" style="display:inline-flex;align-items:center;gap:6px;margin:0 6px;" title="Explore difficulty mode">
                <span style="font-size:11px;opacity:.8;">Difficulty</span>
                <select class="gl-div-select" id="gl-cmd-explore-mode" style="height:26px;padding:2px 6px;">
                    ${renderExploreModeOptions(getExploreSettings().mode)}
                </select>
                <span class="gl-history-time" id="gl-cmd-explore-thresholds"></span>
            </label>
            <button class="gl-cmd-btn" data-cmd="intimacy" title="Initiate intimate scene"><i class="fa-solid fa-heart"></i> Intimacy</button>
```

- [ ] **Step 5: Wire the command-bar Explore difficulty-select change handler**

At `ui-panel.js:273-279` the combat command-bar select handler is registered. Directly after it, add:

```js
    document.getElementById('gl-cmd-explore-mode')?.addEventListener('change', async (e) => {
        const value = e.target.value;
        await setExploreDifficultyMode(value);
        syncExploreDifficultyControls();
        renderAllSections();
        toastr.info(`Explore difficulty: ${value}`);
    });
```

- [ ] **Step 6: Wire the `explore` command-bar button**

At `ui-panel.js:288-295`, modify the `switch (cmd)` block in the command-bar click handler to add an `explore` case immediately after the `combat` case:

```js
        switch (cmd) {
            case 'setup': if (_onSetup) _onSetup(); break;
            case 'timeskip': if (_onTimeskip) _onTimeskip(); break;
            case 'register': if (_onRegister) _onRegister(); break;
            case 'advance': if (_onAdvance) _onAdvance(); break;
            case 'combat': if (_onCombat) _onCombat(); break;
            case 'explore': if (_onExplore) _onExplore(); break;
            case 'power_review': if (_onPowerReview) _onPowerReview(); break;
```

(Keep the other cases as they are.)

- [ ] **Step 7: Add Explore section to the panel section list**

At `ui-panel.js:320-329`, the `sections` array lists the Combat section. Insert an Explore section immediately after Combat:

```js
    const sections = [
        { id: 'characters', icon: 'fa-users', title: 'Cast', html: renderCharacters(_lastState) },
        { id: 'world', icon: 'fa-globe', title: 'Factions & World', html: renderWorld(_lastState) },
        { id: 'collisions', icon: 'fa-burst', title: 'Collisions', html: renderCollisions(_lastState) },
        { id: 'pressures', icon: 'fa-fire-flame-simple', title: 'Pressures', html: renderPressures(_lastState) },
        { id: 'combat', icon: 'fa-crosshairs', title: 'Combat', html: renderCombat(_lastState) },
        { id: 'explore', icon: 'fa-compass', title: 'Explore', html: renderExplore(_lastState) },
        { id: 'places', icon: 'fa-map-location-dot', title: 'Places', html: renderPlaces(_lastState) },
        { id: 'divination', icon: 'fa-star', title: 'Divination', html: renderDivination(_lastState) },
        { id: 'exemplars', icon: 'fa-thumbs-up', title: 'Style Exemplars', html: renderExemplars() },
    ];
```

- [ ] **Step 8: Wire the in-panel Explore difficulty select and custom-DC inputs**

At `ui-panel.js:390-412`, the combat in-panel select and custom-DC input handlers are registered. Directly after `container.querySelectorAll('.gl-combat-custom-dc')…` block closes (at `ui-panel.js:412`), add:

```js
    const exploreModeSelect = container.querySelector('#gl-explore-mode');
    if (exploreModeSelect) {
        exploreModeSelect.addEventListener('change', async () => {
            await setExploreDifficultyMode(exploreModeSelect.value);
            syncExploreDifficultyControls();
            renderAllSections();
            toastr.info(`Explore difficulty: ${exploreModeSelect.value}`);
        });
    }

    container.querySelectorAll('.gl-explore-custom-dc').forEach(input => {
        input.addEventListener('change', async () => {
            const kind = input.dataset.kind;
            const value = Number(input.value);
            if (!kind || !Number.isFinite(value)) return;
            const patch = {};
            patch[kind] = value;
            await setExploreCustomDcs(patch);
            syncExploreDifficultyControls();
            renderAllSections();
            toastr.info('Custom explore threshold updated');
        });
    });
```

- [ ] **Step 9: Add a `syncExploreDifficultyControls()` call inside `renderAllSections`**

At `ui-panel.js:447`, immediately after `syncCombatDifficultyControls();`, add the explore sync. This placement matters: line 447 sits *inside* `renderAllSections()` (just before its closing `}` at line 448), so the sync fires on every panel re-render — not only at initial creation. Mirroring the combat pattern keeps the explore difficulty select and custom-DC inputs in lockstep with any state change that triggers a re-render.

```js
    syncExploreDifficultyControls();
```

- [ ] **Step 10: Add `renderExplore` section renderer**

At `ui-panel.js:1066` (the start of `renderCombat`), the combat renderer begins. Directly before `renderCombat` (or immediately after it — either is fine; put it after for grouping), add `renderExplore`. Place it immediately after `renderCombat`'s closing brace (the `return parts.join('');` followed by `}` at around `ui-panel.js:1157`):

```js
function renderExplore(state) {
    const runtime = getExploreRuntime();
    const exploreActive = runtime && runtime.entity_type === 'explore';
    const settings = getExploreSettings();
    const thresholds = getExploreThresholdTable(settings);
    const explore = exploreActive ? getExploreEntity(state, runtime) : null;
    const baseline = exploreActive ? getExploreBaseline(state, runtime, explore) : null;
    const parts = [];

    parts.push(`<div class="gl-d-row"><b>Difficulty:</b>
        <select class="gl-div-select" id="gl-explore-mode">
            ${renderExploreModeOptions(settings.mode)}
        </select>
    </div>`);
    parts.push(`<div class="gl-d-row gl-history-time">Thresholds: Highly likely ${esc(thresholds['Highly likely'])}+ | Average ${esc(thresholds.Average)}+ | Highly unlikely ${esc(thresholds['Highly unlikely'])}+</div>`);

    if (settings.mode === 'Custom') {
        const custom = settings.custom_dcs || {};
        parts.push(`<div class="gl-d-row"><b>Custom thresholds:</b></div>`);
        parts.push(`<div class="gl-d-row">Highly likely <input class="gl-explore-custom-dc" data-kind="Highly likely" type="number" value="${esc(custom['Highly likely'] ?? 3)}" style="width:64px;margin-left:8px"></div>`);
        parts.push(`<div class="gl-d-row">Average <input class="gl-explore-custom-dc" data-kind="Average" type="number" value="${esc(custom.Average ?? 7)}" style="width:64px;margin-left:8px"></div>`);
        parts.push(`<div class="gl-d-row">Highly unlikely <input class="gl-explore-custom-dc" data-kind="Highly unlikely" type="number" value="${esc(custom['Highly unlikely'] ?? 12)}" style="width:64px;margin-left:8px"></div>`);
    }

    if (!exploreActive) {
        parts.push(`<div class="gl-empty">No active explore runtime</div>`);
        return parts.join('');
    }

    parts.push(`<div class="gl-d-section"><b>Runtime:</b></div>`);
    parts.push(`<div class="gl-d-row"><b>Explore ID:</b> ${esc(runtime.entity_id)}</div>`);
    parts.push(`<div class="gl-d-row"><b>Lock:</b> ${esc(runtime.locked ? 'engaged' : 'released')}</div>`);
    parts.push(`<div class="gl-d-row"><b>Phase:</b> ${esc(runtime.phase || '?')}</div>`);
    parts.push(`<div class="gl-d-row"><b>Clash:</b> ${esc(runtime.clash ?? '?')}</div>`);
    if (baseline) {
        parts.push(`<div class="gl-d-row"><b>Baseline:</b> ${esc(baseline.category)}</div>`);
        if (baseline.category === 'Highly likely' || baseline.category === 'Average' || baseline.category === 'Highly unlikely') {
            parts.push(`<div class="gl-d-row"><b>Baseline threshold:</b> ${esc(thresholds[baseline.category])}+ on d20</div>`);
        }
        if (baseline.target) {
            parts.push(`<div class="gl-d-row"><b>Target:</b> ${esc(baseline.target)}</div>`);
        }
    }

    if (explore) {
        parts.push(`<div class="gl-d-section"><b>Explore Entity:</b></div>`);
        parts.push(`<div class="gl-d-row"><b>Status:</b> ${esc(explore.status || 'ACTIVE')}</div>`);
        if (explore.target) parts.push(`<div class="gl-d-row"><b>Target:</b> ${esc(explore.target)}</div>`);
        if (explore.outcome) parts.push(`<div class="gl-d-row"><b>Outcome:</b> ${esc(explore.outcome)}</div>`);
        if (explore.aftermath) parts.push(`<div class="gl-d-row"><b>Aftermath:</b> ${esc(explore.aftermath)}</div>`);
    } else {
        parts.push(`<div class="gl-d-row"><b>Explore Entity:</b> not created yet</div>`);
    }

    if (runtime.pending_action) {
        parts.push(`<div class="gl-d-section"><b>Pending Action:</b></div>`);
        parts.push(`<div class="gl-d-row">${esc(runtime.pending_action.intent || '')}</div>`);
        if (runtime.pending_action.declared_category) parts.push(`<div class="gl-d-row"><b>Declared:</b> ${esc(runtime.pending_action.declared_category)}</div>`);
        if (runtime.pending_action.effective_category) parts.push(`<div class="gl-d-row"><b>Effective:</b> ${esc(runtime.pending_action.effective_category)}</div>`);
    }

    if (runtime.pending_roll || runtime.last_resolution?.roll) {
        const roll = runtime.pending_roll || runtime.last_resolution?.roll;
        parts.push(`<div class="gl-d-section"><b>${runtime.pending_roll ? 'Pending Roll' : 'Last Roll'}:</b></div>`);
        if (roll.skip) {
            parts.push(`<div class="gl-d-row">${esc(roll.reason === 'absolute' ? 'Auto-success' : 'Auto-fail')} (${esc(roll.category)})</div>`);
        } else {
            if (roll.d20 != null) parts.push(`<div class="gl-d-row"><b>d20:</b> ${esc(roll.d20)}</div>`);
            if (roll.dc != null) parts.push(`<div class="gl-d-row"><b>Threshold:</b> ${esc(roll.dc)}+ on d20</div>`);
            if (roll.category) parts.push(`<div class="gl-d-row"><b>Category:</b> ${esc(roll.category)}</div>`);
            if (roll.resolution || roll.success != null) {
                const label = roll.resolution || (roll.success ? 'SUCCESS' : 'TRANSFORM');
                const criticalNote = roll.critical && !String(label).startsWith('CRITICAL_')
                    ? ` (critical ${esc(roll.critical)})`
                    : '';
                parts.push(`<div class="gl-d-row"><b>Result:</b> ${esc(label)}${criticalNote}</div>`);
            }
            if (roll.challenge_pending) parts.push(`<div class="gl-d-row"><b>State:</b> awaiting reassessment</div>`);
            if (roll.draw?.label) parts.push(`<div class="gl-d-row"><b>Draw:</b> ${esc(roll.draw.label)}</div>`);
        }
    }

    const options = Array.isArray(runtime.options) ? runtime.options : [];
    if (options.length) {
        parts.push(`<div class="gl-d-section"><b>Stored Options:</b></div>`);
        for (const option of options) {
            parts.push(`<div class="gl-d-row">${esc(option.index)}. ${esc(option.label || option.intent)} <span class="gl-history-time">[${esc(option.category)}]</span></div>`);
        }
    }

    return parts.join('');
}
```

Note: `runtime.combat_id` is the legacy field name the combat renderer uses via `getCombatRuntime`. The generic challenge runtime field is `entity_id` (see `challenge-state.js:285`). The explore renderer reads `runtime.entity_id` directly — that is the canonical field. Do NOT copy `runtime.combat_id` into explore.

Additional note: `renderCombat` guards only on `!runtime` so it stays visible even when an explore session is locked. For explore we use `exploreActive = runtime && runtime.entity_type === 'explore'` so the explore section correctly reads "No active explore runtime" when combat is the locked session (and vice versa). This fixes a subtle cross-contamination both sections would otherwise have: currently `renderCombat` displays combat-shaped data pulled from a non-combat runtime. Apply the symmetric fix to `renderCombat` in the next step.

- [ ] **Step 11: Fix `renderCombat` to gate on `entity_type === 'combat'`**

Still in `ui-panel.js`, in `renderCombat` (at `ui-panel.js:1066-1091`), replace:

```js
function renderCombat(state) {
    const runtime = getCombatRuntime();
    const settings = getCombatSettings();
    const thresholds = getCombatThresholdTable(settings);
    const combat = runtime ? getCombatEntity(state, runtime) : null;
    const baseline = runtime ? getCombatBaseline(state, runtime, combat) : null;
```

with:

```js
function renderCombat(state) {
    const runtime = getCombatRuntime();
    const combatActive = runtime && runtime.entity_type === 'combat';
    const settings = getCombatSettings();
    const thresholds = getCombatThresholdTable(settings);
    const combat = combatActive ? getCombatEntity(state, runtime) : null;
    const baseline = combatActive ? getCombatBaseline(state, runtime, combat) : null;
```

And replace (at `ui-panel.js:1089-1092`):

```js
    if (!runtime) {
        parts.push(`<div class="gl-empty">No active combat runtime</div>`);
        return parts.join('');
    }
```

with:

```js
    if (!combatActive) {
        parts.push(`<div class="gl-empty">No active combat runtime</div>`);
        return parts.join('');
    }
```

The `runtime.combat_id` display at line 1095 stays — it relies on the `combat_id` alias kept by the challenge runtime normalizer (`challenge-state.js:157-158`), so when `entity_type === 'combat'` this field is always present.

- [ ] **Step 12: Syntax-check**

Run: `node -c ui-panel.js`
Expected: no output.

- [ ] **Step 13: Commit**

```bash
git add ui-panel.js
git commit -m "feat(explore): add Explore panel section + command-bar controls

Mirrors the Combat section: difficulty-mode select, custom DC
editor, runtime summary, pending/last roll, stored options.
Also tightens renderCombat to gate on entity_type === 'combat'
so sessions don't cross-contaminate the UI."
```

---

## Task 11: Add explore lorebook entry stubs to Gravity World Info

**Why next:** the profile's `lorebookKeys` reference three entries the lorebook currently does not define. Without stubs, the mode-gameplay injection for explore will silently inject empty strings.

**Files:**
- Modify: `Gravity World Info.json`

- [ ] **Step 1: Open and inspect the existing combat entries as a template**

Run: `grep -n "gravity_mode_combat_core\|gravity_mode_combat_optional_examples\|gravity_prose_combat" "Gravity World Info.json"`

Identify the three combat entries and note their structure (keys like `"key": ["gravity_mode_combat_core"]`, content body, order/position fields).

- [ ] **Step 2: Add three explore entry stubs next to the combat entries**

Duplicate the structure of each combat entry into a new entry, changing the key and the body. Each new entry is a placeholder — the final content is authored post-launch. Use this minimum viable body for each:

**`gravity_mode_explore_core`** body:
```
EXPLORE MODE — CREATIVE MANDATE

The player invoked `explore:`. This is a "give me fresh stuff" pass: the player is spending a turn asking the world to reveal something new about the location.

Mechanics are identical to combat: d20 + difficulty threshold + scene draw + multi-clash session.

Doctrine differs: the tarot draw supplies VALENCE (boon / threat / twist / hook). The d20 versus DC supplies INTENSITY (subtle vs. punctuated). Nothing in the mechanic forces misfortune — the draw alone decides whether an outcome is boon or burden.

Branch doctrine:
- SUCCESS: introduce 1 new entity of the expected kind for the chosen option. Draw colors tone.
- CRITICAL_SUCCESS: amplified find. Up to 2 entities. Quest hooks (collision) and faction seeds authorized.
- TRANSFORM: apply the RULE OF COOL. The expected thing isn't there; the draw decides what genuinely interesting thing IS. 1 entity, any type. Never a dead miss.
- CRITICAL_TRANSFORM: starkly different, weighty. Rule of cool at full amplification. Up to 2 entities, any types.

New `char` entities default to `CAMEO` tier unless the fiction clearly justifies promotion.

The extension's injected CHALLENGE_MECHANICS block specifies the mechanical result. Do not reinterpret it — only color it.
```

**`gravity_mode_explore_optional_examples`** body:
```
EXPLORE MODE — WORKED EXAMPLES (OPTIONAL)

Example 1 — SUCCESS on a Highly-likely stalls browse:
Draw: The Sun. Outcome: PC spots an out-of-place brass astrolabe in a trinket pile. CR item-style pressure or place entity as fits the world.

Example 2 — TRANSFORM on a Highly-unlikely vault break:
Draw: The Moon. The vault is empty of gold, but the far wall has been scraped raw from the inside — something was kept in here, and it got out. CR collision:<id> with quest intent.

Example 3 — CRITICAL_TRANSFORM on an Average library browse:
Draw: The Tower. A page the PC lifts collapses the stack; underneath, a body mummified in shelf-dust. CR char:<id> tier CAMEO with the dead-person's dossier; CR collision:<id> with investigative intent.

These are illustrative only — the live scene draw and roll determine the actual outcome.
```

**`gravity_prose_explore`** body:
```
EXPLORE MODE — PROSE GUIDANCE

Exploration prose leans sensory and atmospheric. The scene draw colors atmosphere — period, mood, smells, sounds, light quality. Visible leads should feel found, not announced.

On SUCCESS: write the find as something the PC notices first, then recognizes. Introduce new entities inside the prose, then persist them via CR transactions in the update block.

On TRANSFORM: do not frame it as "the PC finds nothing." Frame it as "the PC finds something else." The draw dictates tone — a boon feels like luck, a threat feels like held breath, a twist feels like gears turning, a hook feels like a pulled thread.

Close each clash with a concrete forward lead (a clickable option row) or a clean exit beat if the location is tapped out.
```

Match the order/position/insertion-mode fields of the corresponding combat entry exactly, adjusting only the `key` array and the body text. Specifically, use these values (verified from the combat entries — uid:3 at order:100, uid:5 at order:110, uid:11 at order:120):

| New entry | Match against combat entry | `order` | `position` | `disable` |
|---|---|---|---|---|
| `gravity_mode_explore_core` | `gravity_mode_combat_core` (uid:3) | **100** | 0 | false |
| `gravity_mode_explore_optional_examples` | `gravity_mode_combat_optional_examples` (uid:5) | **110** | 0 | **true** |
| `gravity_prose_explore` | `gravity_prose_combat` (uid:11) | **120** | 0 | false |

The ascending 100 → 110 → 120 ordering is load-bearing: core doctrine must render before optional examples, which must render before prose guidance, so the prompt stacks coherently when all three fire together. Do not pick a different triple — keep the existing combat pattern.

- [ ] **Step 3: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json', 'utf8'))"`
Expected: no output, no SyntaxError.

- [ ] **Step 4: Commit**

```bash
git add "Gravity World Info.json"
git commit -m "feat(explore): add explore lorebook entry stubs

Three new World Info entries — gravity_mode_explore_core,
gravity_mode_explore_optional_examples, gravity_prose_explore —
keyed to the profile's lorebookKeys. Content is minimum viable;
iterate post-launch."
```

---

## Task 12: Create the extension guide

**Why next:** the spec explicitly requires a guide so the next profile (intimacy, per the user's plan) can follow the pattern.

**Files:**
- Create: `Documentation/Extension/adding_a_challenge_profile.md`

- [ ] **Step 1: Write the guide**

Create `Documentation/Extension/adding_a_challenge_profile.md` with this content:

````markdown
# Adding a Challenge Profile

This guide documents how to add a new challenge profile to Gravity Ledger's generic challenge engine, using the existing `combat` and `explore` profiles as reference implementations.

Owner: Extension layer.

## When to add a profile

Add a profile when you have a mechanic that reuses the full challenge-engine shape — d20 + DC + scene draw + multi-clash session — but whose meaning and prompt doctrine differ from combat or explore. Examples: intimacy, heist, investigation, negotiation.

Do **not** add a profile for one-shot mechanics that don't need phases, stored options, or a persisted session container. Those belong as OOC commands or advance-turn nudges.

## Engine vs. profile split

The engine (`challenge-state.js`, `challenge-mechanics.js`, `challenge-input.js`, `challenge-shared.js`) owns mechanics. It must stay profile-agnostic — no profile-specific branches.

A profile owns meaning. It defines:
- What "this mode" is called in the ledger (entity type + input prefix).
- How the baseline category is computed.
- What the LLM is instructed to do at each phase.
- Which lorebook entries fire when the profile is active.
- What counts as a required-field post-setup check.

If you find yourself wanting to `if (profile.kind === 'foo')` in the engine, that is a smell — fold the branch into a profile hook instead.

## Profile contract

A profile is a frozen module-default object. Required fields:

| Field | Type | Notes |
|---|---|---|
| `kind` | string | Unique identifier (e.g. `'combat'`, `'explore'`) |
| `displayName` | string | Human label for logs and UI |
| `inputPrefix` | string | The text prefix the player types (`combat:`, `explore:`) |
| `deductionType` | string | Used by `getExemplarTargets` and the pending-deduction flow |
| `entityType` | string | The ledger entity type — registered in `consistency.js` and `state-compute.js` |
| `categories` | string[] | Ordered list, low → high. Currently `['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute']` for all profiles |
| `categoryAliases` | { phrase, category }[] | Player-friendly synonyms |
| `autoSuccess` / `autoFail` | string | Which category skips the roll |
| `thresholdTables` | { [mode]: { [category]: d20-threshold } } | DC tables per difficulty mode |
| `defaultMode` | string | Starting difficulty mode |
| `usesD20` / `usesDraws` | boolean | Currently always `true` |
| `challengeThreshold` | number | Min categories a player can "jump" before the LLM must reassess |
| `resultLabels` | { success, fail, critSuccess, critFail } | Labels used in prompts and UI |
| `phases` | string[] | Must contain the canonical six: setup_opening, setup_buffered, awaiting_choice, awaiting_resolution, awaiting_reassessment, cleanup_grace |
| `optionCount` | [min, max] | How many clickable options the LLM should emit |
| `optionPrefix` | string | Usually same as `inputPrefix` |
| `seedFields` | { kind, status, ... } | What the engine auto-writes when the session starts |
| `modelFields` | string[] | Non-engine fields the LLM is expected to populate |
| `resolutionFields` | string[] | Fields that must be filled before cleanup (for audit) |
| `lorebookKeys` | { core, optional, prose } | World Info keys that fire for this profile's gameplay turns |

Required hooks:

| Hook | Called when | Contract |
|---|---|---|
| `getBaseline(state, entity)` | Every prompt build | Return `{ category, ... }`. Only `category` is consumed by the engine — other fields are profile-private. |
| `resolveParticipants(state, entity)` | Prompt build, UI | Return `{ pc, opponents, allies }`. Arrays may be empty. |
| `describeActor(actor)` | Prompt context | Stringify one participant for the prompt |
| `buildContextLines(runtime, entity, state, baseline, helpers)` | Every prompt build | The big one — see below |
| `sceneDrawGuidance()` | Prompt | One-line instruction for how the setup draw should be used |
| `resultDrawGuidance()` | Prompt | One-line instruction for how the resolution draw should be used |
| `setupGuidance()` | Prompt | Short instruction for the setup phase |
| `cleanupGuidance()` | Prompt | Short instruction for cleanup / exit |
| `validateTurn(runtime, state, committedTxns)` | Post-commit | Return a correction string if the LLM dropped a required field, else `null` |
| `initProfileState(state)` | Session start | Return initial `profile_state` (usually `{}`) |
| `isResolved(runtime, entity, state, committedTxns)` | Post-commit | Return `true` when the session should unlock |

`buildContextLines` is the largest hook. It is handed a `helpers` object with formatter functions (`formatDrawBlock`, `formatActionSummary`, `formatRollSummary`, `buildPromptOptionsBlock`, `describeSuccessThreshold`, `describeDcTable`, `dcTable`) so every profile produces a consistent prompt shape. Its job is to push profile-specific doctrine into the line array — per-phase instructions, branch authorization, hygiene rails, option HTML format reminder.

## Registration checklist

For a profile called `foo`:

1. **`challenge-profile-foo.js`** — write the profile module (see combat and explore as references).
2. **`challenge-profiles.js`** — import and add to `PROFILES`.
3. **`state-machine.js`** — **required.** Every challenge profile entity type must register a state machine, even if it only has two states (`ACTIVE → RESOLVED` like explore). Without registration, `validateTransition()` (called from `index.js:1514` at commit time) silently passes every `TR` through, so illegal transitions land in the ledger and corrupt `_currentState` on replay. If `foo`'s lifecycle genuinely only needs one state, still register `FOO_STATES = ['ACTIVE']` with `FOO_TRANSITIONS = { ACTIVE: {} }` so `getStateMachineField` resolves and any stray `TR foo:<id> status -> X` is rejected.
   - Add `FOO_STATES` and `FOO_TRANSITIONS`.
   - Register in `validateTransition`'s `machines` literal.
   - Register in `getValidNextStates`'s `machines` literal.
   - Register in `getStateMachineField`'s `fields` literal.
   - Export both constants.
4. **`consistency.js`**:
   - Add `foo: 'foos'` to `ENTITY_TO_COLLECTION`.
   - Add `'foo'` to `VALID_ENTITIES`.
   - Add `foo: 'ACTIVE'` (or matching initial state) to the inline `INITIAL_STATES`.
5. **`state-compute.js`**:
   - Add `foos: {}` to `createEmptyState`.
   - Add `@property {Object<string, Object>} foos` to the state typedef.
   - Add `foo: 'foos'` to `getCollectionName`.
6. **`state-view.js`**:
   - Add a `foo` branch in `formatChallenge` (both compact and full).
   - Add an active-Foos registry block in `formatStateView`.
7. **`index.js`**:
   - Add `fooCore`, `fooOptional`, `proseFoo` entries to `MODE_LOREBOOK_KEYS`.
   - Add `foo: state.foos` to `getCollectionForEntityType`.
   - Add `if (deductionType === 'foo') return [...]` to `getExemplarTargets`.
   - Write `handleFooButton` — usually mirrors `handleCombatButton` or `handleExploreButton`.
   - Register `onFoo: handleFooButton` in the bootstrap `setCallbacks` call.
   - Add a button to `createInputButtons`'s innerHTML.
   - Add a click listener in `createInputButtons`.
8. **`foo-state.js`** — create a facade mirroring `combat-state.js` / `explore-state.js`. Exposes `getFooBaseline`, `getFooEntity`, `getFooRuntime`, `getFooSettings`, `setFooDifficultyMode`, `setFooCustomDcs`, etc.
9. **`ui-panel.js`**:
   - Import from `foo-state.js`.
   - Add `_onFoo` callback slot.
   - Add `getFooThresholdTable`, `renderFooModeOptions`, `syncFooDifficultyControls` helpers.
   - Add an Explore-equivalent command button and difficulty selector to the command bar.
   - Wire the command-bar `foo` switch case.
   - Add `{ id: 'foo', icon: '...', title: '...', html: renderFoo(_lastState) }` to the `sections` array.
   - Wire the in-panel difficulty select and custom-DC inputs.
   - Call `syncFooDifficultyControls()` at panel init.
   - Write `renderFoo(state)` — gate on `runtime && runtime.entity_type === 'foo'` so cross-session contamination doesn't leak into the UI.
10. **`Gravity World Info.json`** — add three entries: `gravity_mode_foo_core`, `gravity_mode_foo_optional_examples`, `gravity_prose_foo`.
11. **`Documentation/README.md`** — if the profile is a significant addition, link relevant component docs.

## Doctrinal guidance

### The tarot draw is valence; the d20 is intensity

Every profile must preserve Gravity's core doctrine: **the draw supplies valence (boon / threat / twist / hook), the d20-versus-DC supplies intensity (subtle vs. punctuated).** Nothing in the mechanic forces misfortune.

When writing branch prompts:
- Don't frame TRANSFORM as "bad thing happens."
- Do frame TRANSFORM as "expected thing isn't there — something else is, and the draw decides what."

The explore profile formalizes this as the RULE OF COOL: on TRANSFORM, ask the LLM to think of something genuinely interesting this location, fight, scene, etc., could plausibly spawn given the draw.

### Entity creation authorization

Some profiles authorize the LLM to introduce new entities (explore). Others don't (combat — which introduces enemies at setup only, not per-clash). State this in `buildContextLines` as an explicit ENTITY INTRODUCTION AUTHORIZATION block. Be specific: which entity types are allowed on which branches, how many, what the default tier is for new `char` entities.

### Standing hygiene rails

New `char` entities default to `CAMEO` tier across all profiles unless the fiction clearly justifies promotion. This prevents profile features (especially creative-mandate ones like explore) from bloating the character roster.

### Coexistence

The engine enforces a single-runtime invariant. Only one challenge session is active at a time. Your profile's button handler should toast and exit if another session is locked. The `detectChallengePrefix` logic in `challenge-profiles.js` is shared by all profiles and will correctly route any registered prefix — you don't need to add branching there.

### Escape mechanisms

Prompt-level, not engine-level. Your profile's `buildContextLines` advance-turn branch (if applicable) should instruct the LLM to close the session this same turn. The engine does not forcibly end sessions.

## Verification checklist

For any new profile, the minimum verification is:

1. `node -c <each modified file>` — syntax passes.
2. **Happy path** — invoke the profile, pick an option that succeeds, verify the expected resolution branch fires.
3. **Transform branch** — invoke, pick an option that fails, verify valence comes from the draw (not a generic "you fail").
4. **Auto-success / auto-fail** — ensure category `Absolute` / `Impossible` skip the roll cleanly.
5. **Advance-turn exit** — mid-session, fire an advance turn, verify session closes same turn.
6. **Cross-profile block** — start another profile's session, try the new profile's prefix, verify rejection is clean.
7. **Rollback** — mid-session, `ooc: rollback` past the seed transaction, verify runtime clears.
8. **State-view integrity** — inspect the injected state prompt mid-session; verify the new registry block renders correctly.
9. **UI panel** — open the panel; verify the new section renders target/phase/result/options correctly.
10. **Regression** — run combat (and any other existing profile) one full session; verify nothing drifted.

## Reference implementations

- `challenge-profile-combat.js` — opposed-actor profile. Computes a power-gap baseline, resolves participants from state.characters, introduces enemies only at setup.
- `challenge-profile-explore.js` — creative-mandate profile. Fixed-Average baseline, PC-only participants, introduces entities per-clash.

When adding a profile, start by deciding which reference is closer to your mechanic and copy-adapt its structure.
````

- [ ] **Step 2: Commit**

```bash
git add "Documentation/Extension/adding_a_challenge_profile.md"
git commit -m "docs(extension): add 'Adding a Challenge Profile' guide

Step-by-step reference for adding new challenge profiles to the
generic engine. Uses combat and explore as reference
implementations; written to support future profile work (e.g.
re-adding intimacy as a profile)."
```

---

## Task 13: Link the guide from Documentation/README.md

**Why next:** the session-start protocol reads README.md first; without a link the guide is invisible to future sessions.

**Files:**
- Modify: `Documentation/README.md`

- [ ] **Step 1: Add a row to the "Current Living References" list**

At the bottom of `Documentation/README.md` (at around `Documentation/README.md:118-123`), extend the `## Current Living References` list to include the new guide:

```markdown
## Current Living References

- Extension runtime map: `Documentation/Extension/runtime_map.md`
- Adding a challenge profile: `Documentation/Extension/adding_a_challenge_profile.md`
- Preset reasoning and prose: `Documentation/Preset/reasoning_and_prose.md`
- Lorebook mode keys and entries: `Documentation/Lorebook/mode_keys_and_entries.md`
- Cross-component ownership: `Documentation/Shared/prompt_stack.md`
```

- [ ] **Step 2: Commit**

```bash
git add Documentation/README.md
git commit -m "docs: link the 'Adding a Challenge Profile' guide

Session-start README now surfaces the extension guide for future
sessions following the documentation hub protocol."
```

---

## Task 14: Final verification pass

**Why last:** every previous task syntax-checked its own touched files, but a final cross-file check catches integration drift.

**Files:** no changes, read-only.

- [ ] **Step 1: Syntax-check every touched JS file in one sweep**

Run sequentially (in a `bash`-compatible shell on this platform — forward slashes, `/dev/null`, no Windows-specific syntax):

```bash
node -c state-machine.js && \
node -c consistency.js && \
node -c state-compute.js && \
node -c challenge-profile-explore.js && \
node -c challenge-profiles.js && \
node -c explore-state.js && \
node -c state-view.js && \
node -c index.js && \
node -c ui-panel.js && \
echo "all-clean"
```

Expected final line: `all-clean`.

- [ ] **Step 2: Verify lorebook JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json', 'utf8')); console.log('json-ok')"
```

Expected: `json-ok`.

- [ ] **Step 3: Spot-check the profile registry**

```bash
node --input-type=module -e "import('./challenge-profiles.js').then(m => { console.log(m.listProfiles()); console.log(!!m.detectChallengePrefix('explore: the market')); console.log(!!m.detectChallengePrefix('combat: the thug')); })"
```

Expected output:
```
[ 'combat', 'explore' ]
true
true
```

If the module test fails because of SillyTavern-global imports, skip this step (the engine pulls `chatMetadata` from ST's context at runtime; a node-only module smoke-test may fail there). The syntax check in Step 1 is sufficient if so.

- [ ] **Step 4: Manual browser scenarios (in SillyTavern)**

Load the extension, then run through these scenarios. Each is a pass/fail against the acceptance criteria in the spec's Section 14.

| # | Scenario | Expected |
|---|---|---|
| 1 | `explore: the market` → pick option 1 on SUCCESS | 1 CR entity, session continues with next options |
| 2 | `explore: <action>` → pick an Unlikely option that rolls under DC | TRANSFORM — LLM introduces a draw-colored entity, NOT a "you find nothing" |
| 3 | `explore: sneak into the vault DC Highly unlikely` | Category routed to Highly unlikely |
| 4 | Mid-session, click Advance button | Explore closes same turn with outcome+aftermath |
| 5 | LLM resolves transform as ambush → writes CR collision with combat intent | Explore RESOLVED + collision opens combat next turn |
| 6 | While combat is locked, click Explore button | Toast "Finish the current challenge session before starting a new one." No state change |
| 7 | Open explore, pick option, `ooc: rollback` past seed | Runtime cleared; clean state |
| 8 | Change difficulty Cinematic → Gritty mid-session | Next clash uses Gritty DCs |
| 9 | Open SillyTavern generation log mid-session | Injected state prompt contains `Explores:` block with target+id |
| 10 | Open UI panel | Explore section renders target, phase, last resolution |
| 11 | Finish explore, then start combat | Clean handoff; no residual explore runtime |
| 12 | Plain regular turn with no challenge | No explore-related injections leak |

If any scenario fails, file a bug against the relevant task and roll back that task's commit with `git revert <sha>` before debugging.

- [ ] **Step 5: No final commit**

All commits happened at task boundaries. This task is verification-only. Do not create a merge commit.

---

## Self-Review Notes (for the author of this plan)

### Spec coverage check

Each spec section maps to a task:

- §4 locked decisions — Task 4 (profile) embodies all decisions.
- §5 branch doctrine — Task 4 `buildContextLines`, Task 11 lorebook core entry.
- §6 file surface — Tasks 1-13 cover every file in the surface list.
- §7 profile contract — Task 4.
- §8 per-phase `buildContextLines` — Task 4 phase switch.
- §9 invocation — Task 5 (prefix), Task 9 (button).
- §10 state layer — Tasks 1, 2, 3.
- §11 presentation — Tasks 7, 8, 10.
- §12 coexistence & escape — Task 9 Step 1 guard; Task 4 advance-turn phase branch.
- §13 error handling — Task 4 `validateTurn`; Task 9 Step 1 guard.
- §14 verification — Task 14.
- §15 documentation — Task 12, Task 13.

All covered.

### Type-consistency check

- Entity type string: `'explore'` — used consistently in `challenge-profile-explore.js`, `challenge-profiles.js`, `consistency.js`, `state-compute.js`, `index.js`, `state-view.js`, `ui-panel.js`.
- Collection name: `'explores'` — used consistently in `createEmptyState`, `ENTITY_TO_COLLECTION`, `getCollectionName`, `getCollectionForEntityType`, `state.explores` reads in `state-view.js` and `validateTurn`.
- Runtime field: `runtime.entity_id` — the canonical generic field used in all explore code (not `runtime.explore_id`; that alias was never created, unlike combat's legacy `combat_id`).
- Profile hook name: `getExploreBaseline`, `getExploreEntity`, `getExploreRuntime`, `getExploreSettings`, `setExploreDifficultyMode`, `setExploreCustomDcs` — all match the `combat-state.js` pattern.
- Lorebook keys: `gravity_mode_explore_core`, `gravity_mode_explore_optional_examples`, `gravity_prose_explore` — match in profile, `MODE_LOREBOOK_KEYS`, and World Info JSON.
- State-machine field: `status` (matches combat). Transitions `ACTIVE → RESOLVED`.
- UI DOM ids: `gl-input-explore`, `gl-cmd-explore-mode`, `gl-cmd-explore-thresholds`, `gl-explore-mode`, `gl-explore-custom-dc` (class) — all match the `explore` / `gl-explore-*` naming; no collisions with combat ids.
- UI section id: `'explore'`, icon `fa-compass`. Consistent.

No naming drift detected.

### Placeholder scan

- No `TODO` / `TBD` / "implement later" in any task step.
- Every code block is complete.
- Every command has expected output.
- Every commit message is written.
- "Similar to Task N" does not appear — Task 6 and Task 4 both include full file bodies rather than referencing each other.
