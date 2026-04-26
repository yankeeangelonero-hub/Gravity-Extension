# Challenge Engine Architecture

Generic extension-owned challenge runtime that replaces the combat-specific subsystem.
Combat, intimacy, racing, chases, debates, etc. become profiles on one engine.

## Design Principle

The engine owns mechanics. Profiles own domain meaning. The model owns fiction.

```
Engine (challenge-state.js)
  ├── lock/unlock
  ├── phase machine
  ├── input parsing
  ├── option storage
  ├── threshold lookup
  ├── roll handling (optional per profile)
  ├── result classification
  ├── cleanup grace
  ├── packet injection
  └── post-turn validation

Profile (challenge-profile-*.js)
  ├── baseline doctrine
  ├── participant resolution
  ├── category set + ordering
  ├── threshold tables
  ├── result label set
  ├── entity field schema
  ├── auto-seed fields
  ├── context block builder
  ├── draw guidance
  ├── lorebook keys
  └── option/cleanup guidance
```

---

## Entity Model

### Entity type: `challenge`

Replaces `combat:*`. Stored in `state.challenges`. The `kind` field identifies the profile.

```
challenge:alley-fight.kind        = combat
challenge:alley-fight.status      = ACTIVE | RESOLVED
challenge:alley-fight.exchange    = 1
challenge:alley-fight.*           = (profile-defined fields)
```

State machine for all challenges:
```
ACTIVE -> RESOLVED
```

Profile-defined fields vary. The engine only cares about `kind`, `status`, and `exchange`.
Everything else is profile-specific context the model fills.

### Why one entity type, not many

- The engine needs one place to find "the active challenge" regardless of kind.
- `state.challenges` is one collection to scan.
- Auto-seeding creates the entity, so the model doesn't write `CR challenge:*` — it only `S` sets fields.
- The `kind` field is human-readable in the ledger: `CR challenge:rooftop-chase kind=race`.

### Registration changes

**consistency.js**: Add `'challenge'` to `VALID_ENTITIES`.

**state-compute.js**: Add to `createEmptyState`:
```js
challenges: {},
```
Add to `getCollectionName`:
```js
challenge: 'challenges',
```

**state-machine.js**: Add:
```js
const CHALLENGE_STATES = ['ACTIVE', 'RESOLVED'];
const CHALLENGE_TRANSITIONS = {
    ACTIVE: { advance: 'RESOLVED' },
    RESOLVED: {},
};
```
Add `challenge` to the `machines` map in `validateTransition`.

---

## Runtime Data Model

Key: `chatMetadata['gravity_challenge_runtime']`

```js
{
    // Engine-owned
    locked: boolean,
    challenge_id: string,         // "ch-{timestamp}"
    kind: string,                 // 'combat' | 'intimacy' | 'race' | ...
    phase: string,                // setup | awaiting_choice | awaiting_resolution | awaiting_reassessment | cleanup_grace
    exchange: number,
    scene_draw: object | null,    // initial divination draw (renamed from spawn_draw)
    scene_draw_expired: boolean,  // true after setup completes
    difficulty_mode: string,
    options: array,               // stored clickable options
    pending_action: object | null,
    pending_roll: object | null,  // null when profile.usesD20 is false
    last_resolution: object | null,
    last_input: object | null,
    cleanup_turns_remaining: number,
    correction_attempts: number,  // NEW: hard retry counter

    // Profile-owned (opaque to engine)
    profile_state: object,        // profile-specific transient data
}
```

### pending_action shape (unchanged from combat)
```js
{
    source: 'option' | 'custom',
    option_index: number | null,
    intent: string,
    label: string,
    declared_category: string | null,
    effective_category: string | null,
    baseline_category: string | null,
    clamped: boolean,
    challenge_required: boolean,
    assessment_only: boolean,
    setup_buffered: boolean,      // still needed if player acts during setup
}
```

### pending_roll shape (unchanged, but optional)
```js
{
    skip: boolean,
    reason: string,               // 'auto_success' | 'auto_fail'
    category: string,
    dc: number,
    d20: number,
    draw: object | null,
    success: boolean,
    critical: string | null,
    resolution: string,           // profile-defined result label
    challenge_pending: boolean,
    baseline: string,
}
```

When `profile.usesD20 === false`, the engine skips roll generation entirely.
The profile can still use draws for interpretive context.

### options shape (unchanged)
```js
[{ index: number, category: string, intent: string, label: string }]
```

---

## Profile Interface Contract

Each profile exports a plain object. No classes. No inheritance.

```js
// challenge-profile-combat.js
export default {

    // ─── Identity ────────────────────────────────────────────────────────
    kind: 'combat',
    displayName: 'Combat',
    inputPrefix: 'combat',          // player types "combat:" to enter

    // ─── Categories ──────────────────────────────────────────────────────
    // Ordered weakest → strongest.
    categories: ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'],
    autoSuccess: 'Absolute',        // category that skips roll (auto-success)
    autoFail: 'Impossible',         // category that skips roll (auto-fail)

    // ─── Thresholds ──────────────────────────────────────────────────────
    thresholdTables: {
        Cinematic:  { 'Highly likely': 3,  Average: 7,  'Highly unlikely': 12 },
        Gritty:     { 'Highly likely': 8,  Average: 12, 'Highly unlikely': 16 },
        Heroic:     { 'Highly likely': 2,  Average: 5,  'Highly unlikely': 10 },
        Survival:   { 'Highly likely': 10, Average: 14, 'Highly unlikely': 18 },
    },
    defaultMode: 'Cinematic',

    // ─── Resolution ──────────────────────────────────────────────────────
    usesD20: true,
    usesDraws: true,
    challengeThreshold: 2,          // category delta that triggers reassessment
    resultLabels: {
        success:      'SUCCESS',
        fail:         'TRANSFORM',
        critSuccess:  'CRITICAL_SUCCESS',
        critFail:     'CRITICAL_TRANSFORM',
    },

    // ─── Phases ──────────────────────────────────────────────────────────
    // Which phases this profile uses. Engine skips unused phases.
    phases: ['setup', 'awaiting_choice', 'awaiting_resolution', 'awaiting_reassessment', 'cleanup_grace'],

    // ─── Options ─────────────────────────────────────────────────────────
    optionCount: [3, 4],            // [min, max]
    optionPrefix: 'combat',         // data-value prefix in HTML spans

    // ─── Entity Schema ───────────────────────────────────────────────────
    // Fields the auto-seeded entity starts with.
    seedFields: {
        kind: 'combat',
        status: 'ACTIVE',
        exchange: 1,
    },
    // Fields the model should fill during setup.
    modelFields: ['participants', 'hostiles', 'primary_opponent', 'terrain', 'situation', 'threat'],
    // Fields written at resolution.
    resolutionFields: ['outcome', 'aftermath'],

    // ─── Lorebook Keys ───────────────────────────────────────────────────
    lorebookKeys: {
        core:     'gravity_mode_combat_core',
        optional: 'gravity_mode_combat_optional_examples',
        prose:    'gravity_prose_combat',
    },

    // ─── Behavioral Hooks (functions) ────────────────────────────────────

    /**
     * Compute baseline category from state.
     * @param {Object} state - current derived state
     * @param {Object} entity - the challenge entity (may be null during setup)
     * @returns {{ category: string, gap: number|null, pc_stat: number|null, opponent_stat: number|null, primary_opponent: Object|null }}
     */
    getBaseline(state, entity) {
        // Power gap doctrine: PC power vs primary opponent power
        // +2 or more = Absolute, +1 = Highly likely, 0 = Average, -1 = Highly unlikely, -2 or less = Impossible
    },

    /**
     * Resolve the primary opponent and all hostiles from state.
     * @param {Object} state
     * @param {Object} entity
     * @returns {{ pc: Object, opponents: Object[], allies: Object[] }}
     */
    resolveParticipants(state, entity) {
        // Reads entity.hostiles, entity.primary_opponent, resolves from state.characters
    },

    /**
     * Format an actor for the prompt.
     * @param {Object} actor - resolved participant
     * @returns {string}
     */
    describeActor(actor) {
        // "name | power X | power_base Y | abilities [a, b] | wounds {head: 1}"
    },

    /**
     * Build profile-specific context lines for the prompt.
     * Called after the generic engine blocks. Returns string[] to append.
     * @param {Object} runtime
     * @param {Object} entity
     * @param {Object} state
     * @param {Object} baseline
     * @returns {string[]}
     */
    buildContextLines(runtime, entity, state, baseline) {
        // PLAYER COMBAT PROFILE, PRIMARY OPPONENT, HOSTILES, BASELINE, etc.
    },

    /**
     * Scene draw guidance (for setup).
     * @returns {string}
     */
    sceneDrawGuidance() {
        return 'encounter circumstance, leverage, spacing, terrain, initiative, exposure, and why the opening options sit at their assessed categories';
    },

    /**
     * Result draw guidance (for resolution).
     * @returns {string}
     */
    resultDrawGuidance() {
        return 'colors the already-determined exchange result';
    },

    /**
     * Setup-phase instruction.
     * @returns {string}
     */
    setupGuidance() {
        return 'Establish participants, hostiles, primary_opponent, terrain, situation, threat. Assign justified power_base, power, power_basis, and abilities to important new enemies.';
    },

    /**
     * Cleanup-phase instruction.
     * @returns {string}
     */
    cleanupGuidance() {
        return 'Write lasting fallout, update wounds to char entities, destroy the challenge entity.';
    },

    /**
     * Profile-specific validation after assistant turn.
     * Called after the engine's generic validation.
     * @param {Object} runtime
     * @param {Object} state
     * @param {Object[]} committedTxns
     * @returns {string|null} - correction message or null
     */
    validateTurn(runtime, state, committedTxns) {
        return null;
    },

    /**
     * Initialize profile_state when challenge starts.
     * @param {Object} state
     * @returns {Object}
     */
    initProfileState(state) {
        return {};
    },
};
```

---

## Intimacy Profile (proves the abstraction)

```js
// challenge-profile-intimacy.js
export default {
    kind: 'intimacy',
    displayName: 'Intimate Scene',
    inputPrefix: 'intimate',

    categories: ['Boundary', 'Tentative', 'Comfortable', 'Open', 'Surrender'],
    autoSuccess: 'Surrender',
    autoFail: 'Boundary',

    thresholdTables: {
        Default:  { Tentative: 6, Comfortable: 4, Open: 8 },
        Gentle:   { Tentative: 3, Comfortable: 2, Open: 5 },
        Intense:  { Tentative: 9, Comfortable: 6, Open: 12 },
    },
    defaultMode: 'Default',

    usesD20: false,                  // no dice in intimacy
    usesDraws: true,                 // draws set tone, not mechanics
    challengeThreshold: null,        // no reassessment phase
    resultLabels: {
        success:     'DEEPEN',
        fail:        'REDIRECT',
        critSuccess: 'REVEAL',
        critFail:    'WITHDRAW',
    },

    // No reassessment in intimacy
    phases: ['setup', 'awaiting_choice', 'awaiting_resolution', 'cleanup_grace'],

    optionCount: [4, 5],
    optionPrefix: 'intimate',

    seedFields: {
        kind: 'intimacy',
        status: 'ACTIVE',
        exchange: 1,
    },
    modelFields: ['participants', 'atmosphere', 'trust_level', 'wants', 'limits'],
    resolutionFields: ['outcome', 'aftermath'],

    lorebookKeys: {
        core:     'gravity_mode_intimacy_core',
        optional: 'gravity_mode_intimacy_optional_examples',
        prose:    'gravity_prose_intimacy',
    },

    getBaseline(state, entity) {
        // Stance + trust doctrine.
        // Reads intimacy_stance, trust from relevant char entities.
        // Open/willing = easier categories, guarded/hurt = harder.
    },

    resolveParticipants(state, entity) {
        // All participants from entity.participants, resolved from state.characters.
        // No hostiles/allies distinction — just partners.
    },

    describeActor(actor) {
        // "name | intimacy_stance X | trust Y | wants [...] | limits [...]"
    },

    buildContextLines(runtime, entity, state, baseline) {
        // STANCES, INTIMATE HISTORY, LIMITS, WANTS, TRUST LEVEL
    },

    sceneDrawGuidance() {
        return 'tone and texture of the scene — not consent, not plot';
    },

    resultDrawGuidance() {
        return 'emotional color of the moment';
    },

    setupGuidance() {
        return 'Establish participants, atmosphere, trust_level, wants, limits. Check that the scene is earned, beyond casual contact, and consent is plausible.';
    },

    cleanupGuidance() {
        return 'Write aftermath — reads, stance shifts, key moments, intimate history, constraint pressure.';
    },

    validateTurn(runtime, state, committedTxns) {
        // Check stances are respected, limits not violated
        return null;
    },

    initProfileState(state) {
        // Build stance map from current characters
        const stances = {};
        for (const [id, char] of Object.entries(state?.characters || {})) {
            if (char.intimacy_stance) stances[id] = char.intimacy_stance;
        }
        return { stances, histories: {} };
    },
};
```

---

## Race Profile (sketch)

```js
// challenge-profile-race.js
export default {
    kind: 'race',
    displayName: 'Race',
    inputPrefix: 'race',

    categories: ['Impossible', 'Risky', 'Even', 'Favored', 'Dominant'],
    autoSuccess: 'Dominant',
    autoFail: 'Impossible',

    thresholdTables: {
        Street:  { Favored: 4, Even: 8, Risky: 13 },
        Track:   { Favored: 3, Even: 7, Risky: 11 },
        Offroad: { Favored: 6, Even: 10, Risky: 15 },
    },
    defaultMode: 'Street',

    usesD20: true,
    usesDraws: true,
    challengeThreshold: 2,
    resultLabels: {
        success:     'GAIN',
        fail:        'SLIP',
        critSuccess: 'SURGE',
        critFail:    'SPIN',
    },

    phases: ['setup', 'awaiting_choice', 'awaiting_resolution', 'cleanup_grace'],

    optionCount: [3, 4],
    optionPrefix: 'race',

    seedFields: { kind: 'race', status: 'ACTIVE', exchange: 1 },
    modelFields: ['participants', 'track', 'position', 'hazards', 'lead'],
    resolutionFields: ['outcome', 'aftermath'],

    lorebookKeys: {
        core: 'gravity_mode_race_core',
        prose: 'gravity_prose_combat',  // reuse combat prose for now
    },

    getBaseline(state, entity) {
        // Speed/handling gap vs primary opponent
    },

    // ... other hooks follow same pattern
};
```

---

## Packet Structure

The engine injects one prompt block containing three structured packets plus a context tail.
Profile-specific director framing comes from lorebook entries, not inline.

### [CHALLENGE_INPUT]

What the player said, parsed by the extension.

```
[CHALLENGE_INPUT]
KIND: combat
HAS_INPUT: true
PARSED_BY_EXTENSION: true
RAW_MESSAGE: combat:2
EXPLICIT_PREFIX: true
PARSED_SOURCE: OPTION_SELECTION
OPTION_INDEX: 2
OPTION_LABEL: Break left through the gap
INTENT: Break left through the gap and take the nearest rifle offline
DECLARED_CATEGORY: Highly likely
ASSESSMENT_ONLY: false
RESOLUTION_REQUEST: RESOLVE_IF_ALLOWED
[/CHALLENGE_INPUT]
```

### [CHALLENGE_MECHANICS]

All extension-owned facts. Pure key-value, no instruction prose.

```
[CHALLENGE_MECHANICS]
KIND: combat
MATH_OWNER: EXTENSION
PHASE: awaiting_resolution
LOCKED: true
CHALLENGE_ID: ch-abc123
EXCHANGE: 3
DIFFICULTY_MODE: Cinematic
SUCCESS_THRESHOLDS: Highly likely=3+ | Average=7+ | Highly unlikely=12+
SCENE_DRAW_ACTIVE: false
ACTION_SOURCE: OPTION
ACTION_STATE: DECLARED
ACTION_INTENT: Break left through the gap and take the nearest rifle offline
DECLARED_CATEGORY: Highly likely
BASELINE_CATEGORY: Average
EFFECTIVE_CATEGORY: Highly likely
ACTION_THRESHOLD: 3+ on d20
ROLL_STATE: ROLLED
RESOLUTION_LOCKED: true
SUCCESS_DECIDED_BY_EXTENSION: true
D20_RESULT: 14
RESULT: SUCCESS
SUCCESS_STATE: SUCCESS
ROLL_DRAW_ROLE: interpretive_only
ROLL_DRAW: The Tower — sudden structural failure, exposure of hidden weakness
RECORD_LAST_DRAW: true
NEXT_OPTIONS_REQUIRED: true
[/CHALLENGE_MECHANICS]
```

### [CHALLENGE_TASK]

What the model must do this turn. Boolean flags, no explanation.

```
[CHALLENGE_TASK]
KIND: combat
TURN_OBJECTIVE: RESOLVE_EXCHANGE
INPUT_MODE: LOCKED_CHALLENGE
MUST_CREATE_ENTITY: false
MUST_ESTABLISH_OPENING: false
MUST_ASSESS_ACTION_TO_OPTIONS: false
MUST_NOT_RESOLVE: false
MUST_RESOLVE_EXCHANGE: true
MUST_OUTPUT_OPTIONS: true
OPTION_COUNT: 3-4
MUST_RECORD_LAST_DRAW: true
MUST_WRITE_LASTING_CONSEQUENCES: false
MUST_DESTROY_ENTITY: false
ALLOW_NEW_OPTIONS: true
[/CHALLENGE_TASK]
```

### Context tail

After the three packets, the engine appends profile-generated context.
This is the only place that varies by profile.

```
Read CHALLENGE_INPUT, CHALLENGE_MECHANICS, and CHALLENGE_TASK first. They are canonical.

CHALLENGE ENTITY (ch-abc123)
  Kind: combat
  Status: ACTIVE
  Exchange: 3
  Terrain: Narrow service alley with hard cover
  Situation: Sweep team pinned behind dumpster
  Threat: Armored rifles at close range

PLAYER PROFILE
  Kael | power 6 | power_base 6 | abilities [knife fighting, parkour]

BASELINE: Average | power gap 0 (PC 6 vs enemy 6) | threshold 7+
PRIMARY OPPONENT: Sweep Leader | power 6 | abilities [rifle, tactical comms]

STORED OPTIONS
  1. Break left through the gap [Highly likely]
  2. Hold position and wait for opening [Average]
  3. Rush the leader directly [Highly unlikely]

PENDING ACTION: Break left through the gap | declared Highly likely | effective Highly likely | option
PENDING ROLL: d20 14 | target 3+ on d20 | Highly likely | SUCCESS
MECHANICAL RESULT: Highly likely action | threshold 3+ on d20 | rolled 14 => SUCCESS

ROLL DRAW:
  The Tower — sudden structural failure, exposure of hidden weakness
  Combat resolution usage: this draw colors the already-determined exchange result.

OPTION HTML — output 3-4 clickable options in this format:
<span class="act" data-value="combat: option | 1 | Highly likely | Intent text">1. Display text (Highly likely)</span>
```

### What's NOT in the packet

Phase-specific prose instructions (move to lorebook entries):
- How to interpret transforms
- How to use the scene draw
- How to narrate results

The engine injects a one-line phase label. The lorebook entry for that profile
owns the narrative guidance for each phase.

---

## Engine Responsibilities

### challenge-state.js owns:

1. **Runtime lifecycle**: start, save, clear, get.
2. **Phase machine**: setup → awaiting_choice → awaiting_resolution → (awaiting_reassessment if profile allows) → cleanup_grace.
3. **Input parsing**: generic `handleChallengeActionSelection(rawText, state, drawFn)`.
   - Detects profile prefix from `rawText` (e.g., `combat:`, `intimate:`, `race:`).
   - Parses option selections, custom declarations, freeform assessment.
   - Routes through phase-dependent logic (same as current combat, but profile-aware).
4. **Option storage**: parse options from model output, store in runtime.
5. **Roll handling**: `buildRollPayload(category, dcTable, drawFn)` — only called if `profile.usesD20`.
6. **Result classification**: `resolveRolledOutcome(d20, dc)` using `profile.resultLabels`.
7. **Baseline delegation**: calls `profile.getBaseline(state, entity)`.
8. **Packet building**: `buildChallengePrompt(state)` assembles the three blocks + context tail.
9. **Post-turn validation**: `processChallengeAssistantTurn(state, txns, text)`.
   - Generic checks: entity exists, options output, last_draw recorded.
   - Profile checks: `profile.validateTurn(runtime, state, txns)`.
   - Hard retry counter: `runtime.correction_attempts++`. After 3, forced recovery.
10. **Auto-seeding**: emit `CR challenge:{id}` transaction with `profile.seedFields` on start.
11. **Scene draw expiry**: set `scene_draw_expired: true` when leaving setup phase.
12. **Cleanup grace**: one committed turn, then hard clear regardless.

### challenge-state.js does NOT own:

- What baseline means for a given domain (profile hook).
- What participants look like (profile hook).
- What the prompt should say about narrative craft (lorebook entry).
- What fields the entity has beyond kind/status/exchange (profile schema).
- How to describe actors (profile hook).

### Profile registration

```js
// challenge-profiles.js (registry)
import combat from './challenge-profile-combat.js';
import intimacy from './challenge-profile-intimacy.js';

const PROFILES = Object.freeze({
    combat,
    intimacy,
});

export function getProfile(kind) {
    return PROFILES[kind] || null;
}

export function getProfileByPrefix(prefix) {
    return Object.values(PROFILES).find(p => p.inputPrefix === prefix) || null;
}

export function listProfiles() {
    return Object.keys(PROFILES);
}
```

---

## Engine Integration (index.js)

### Input routing (replaces current combat+intimacy bifurcation)

```js
// Current: two separate blocks for combat and intimacy
// After: one unified block

const challengeLocked = isChallengeRuntimeActive();
const challengePrefix = detectChallengePrefix(rawText);  // 'combat' | 'intimate' | 'race' | null

if ((challengeLocked || challengePrefix) && !/^ooc:/i.test(rawText)) {
    const result = await handleChallengeActionSelection(rawText, _currentState, drawDivination);
    if (result.handled) {
        _pendingDeductionType = result.kind;  // profile.kind used for deduction routing
        _pendingReinforcement = null;
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
        return;
    }
    if (challengeLocked || challengePrefix) {
        _pendingDeductionType = getActiveProfile()?.kind || 'combat';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
        return;
    }
}
```

### Button handlers

Each profile can register a button. The handler calls `startChallengeRuntime(kind, drawFn)`.

```js
async function handleCombatButton() {
    if (!isChallengeRuntimeActive()) {
        await startChallengeRuntime('combat', drawDivination());
        _pendingDeductionType = 'combat';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
    }
    insertChatMessage('combat: ');
}

function handleIntimacyButton() {
    if (!isChallengeRuntimeActive()) {
        await startChallengeRuntime('intimacy', drawDivination());
        _pendingDeductionType = 'intimacy';
        injectPrompt('advance');
        updatePanel(_currentState, _turnCounter);
    }
    insertChatMessage('intimate: ');
}
```

### Prompt injection

```js
const challengePromptBody = _currentState ? buildChallengePrompt(_currentState) : '';
if (challengePromptBody) {
    const profile = getActiveProfile();
    setExtensionPrompt(
        `${MODULE_NAME}_challenge`,
        buildModeInjection(
            `GRAVITY CHALLENGE — Active ${profile.displayName} Session`,
            challengePromptBody,
            Object.values(profile.lorebookKeys).filter(Boolean),
        ),
        PROMPT_IN_CHAT,
        0,
    );
}
```

### Post-assistant processing

```js
// Replace processCombatAssistantTurn with:
const correction = await processChallengeAssistantTurn(state, committedTxns, messageText);
if (correction) {
    _corrections.push({ line: correction, attempts: 0 });
}
```

---

## Auto-Seeding

When the challenge starts, the engine emits a `CR` transaction directly.

```js
async function startChallengeRuntime(kind, sceneDraw) {
    const profile = getProfile(kind);
    if (!profile) return null;

    const challengeId = makeChallengeId();
    const settings = getChallengeSettings();

    // Auto-seed the entity via a system transaction
    const seedTx = {
        op: 'CR',
        e: 'challenge',
        id: challengeId,
        d: { ...profile.seedFields },
        source: 'system',
    };
    await commitTransaction(seedTx);

    // Initialize runtime
    const runtime = {
        locked: true,
        challenge_id: challengeId,
        kind,
        phase: 'setup',
        exchange: 1,
        scene_draw: clone(sceneDraw),
        scene_draw_expired: false,
        difficulty_mode: profile.thresholdTables[settings.mode] ? settings.mode : profile.defaultMode,
        options: [],
        pending_action: null,
        pending_roll: null,
        last_resolution: null,
        last_input: null,
        cleanup_turns_remaining: 0,
        correction_attempts: 0,
        profile_state: profile.initProfileState ? profile.initProfileState(computeCurrentState()) : {},
    };
    await setChallengeRuntime(runtime);
    return runtime;
}
```

The model never writes `CR challenge:*`. It only writes `S challenge:*.terrain "value"` etc.
This is the single biggest reliability improvement from the previous review.

---

## Hard Validation with Retry Counter

```js
async function processChallengeAssistantTurn(state, committedTxns, messageText) {
    let runtime = getChallengeRuntime();
    if (!runtime) return null;

    const profile = getProfile(runtime.kind);
    const entity = getChallengeEntity(state, runtime);
    const options = parseChallengeOptionsFromMessage(messageText, profile);
    const destroyed = didDestroyChallengeThisTurn(runtime, committedTxns);
    const resolved = didResolveChallengeThisTurn(runtime, state, committedTxns);
    const recordedDraw = didRecordDivinationThisTurn(committedTxns);

    // ─── cleanup_grace: hard clear ──────────────────────────────────
    if (runtime.phase === 'cleanup_grace' || destroyed) {
        await clearChallengeRuntime();
        return null;
    }

    // ─── generic validation ─────────────────────────────────────────
    let correction = null;

    if (runtime.phase === 'setup' && !entity) {
        // Entity should exist because we auto-seeded. If the model destroyed it
        // or something went wrong, re-seed.
        correction = `Challenge entity challenge:${runtime.challenge_id} is missing. The extension seeded it — do not destroy it during setup. Fill its fields now.`;
    }

    if (runtime.phase === 'awaiting_resolution' && runtime.pending_roll && !runtime.pending_roll.skip && !recordedDraw && !resolved) {
        correction = 'A rolled result is waiting but divination.last_draw was not recorded. Resolve the stored action now.';
    }

    if ((runtime.phase === 'setup' || runtime.phase === 'awaiting_choice' || runtime.phase === 'awaiting_resolution') && !options.length && !resolved) {
        const expected = profile.optionCount ? `${profile.optionCount[0]}-${profile.optionCount[1]}` : '3-4';
        correction = correction || `No clickable options detected. Output ${expected} options using the exact HTML format.`;
    }

    // ─── profile-specific validation ────────────────────────────────
    if (!correction && profile.validateTurn) {
        correction = profile.validateTurn(runtime, state, committedTxns);
    }

    // ─── retry counter ──────────────────────────────────────────────
    if (correction) {
        runtime.correction_attempts = (runtime.correction_attempts || 0) + 1;
        if (runtime.correction_attempts >= 3) {
            // Forced recovery: advance phase to avoid infinite loop
            // Log the failure but don't trap the user
            console.warn(`[challenge] giving up after ${runtime.correction_attempts} correction attempts in phase ${runtime.phase}`);
            correction = null;
            runtime.correction_attempts = 0;
            // Force advance to next logical phase
        }
        await setChallengeRuntime(runtime);
        if (correction) return `[CHALLENGE RUNTIME]\n${correction}`;
    }

    // ─── phase transitions (same logic as current combat) ───────────
    // ... advance phase, update options, clear pending action/roll, etc.
    // Expire scene draw when leaving setup:
    if (runtime.phase === 'setup' && entity) {
        runtime.scene_draw_expired = true;
    }

    // ... rest follows current processCombatAssistantTurn pattern
    return null;
}
```

---

## Deduction Type Routing

The preset's hidden reasoning (CoT) currently routes by deduction type:
`regular`, `combat`, `advance`, `intimacy`.

With the challenge engine, `_pendingDeductionType` is set to the profile's `kind`.
The preset needs to handle new kinds or fall back to a generic challenge deduction.

Options:
1. Each profile maps to an existing deduction type (combat→combat, intimacy→intimacy, race→combat).
2. Add a generic `challenge` deduction type that works for any kind.
3. Profiles declare their deduction type: `deductionType: 'combat'`.

**Recommendation**: Option 3. Profiles declare explicitly. This lets combat use the combat deduction
and new profiles use whatever deduction fits best without requiring preset changes for every new profile.

```js
// In the profile:
deductionType: 'combat',  // which CoT template the preset should use
```

---

## Migration Steps

### Phase 1: Foundation (no behavior change)

1. Add `challenge` to `VALID_ENTITIES` in consistency.js.
2. Add `challenges: {}` to `createEmptyState()` in state-compute.js.
3. Add `challenge: 'challenges'` to `getCollectionName()`.
4. Add `CHALLENGE_STATES` and `CHALLENGE_TRANSITIONS` to state-machine.js.
5. Add `challenge` to the `validateTransition` machines map.
6. Syntax check all changed files.

### Phase 2: Extract engine from combat

1. Copy `combat-state.js` to `challenge-state.js`.
2. Rename all `combat` references to `challenge` in the new file.
3. Extract combat-specific logic (baseline, participant resolution, actor description, context block building) into `challenge-profile-combat.js`.
4. Make `challenge-state.js` import the profile and delegate to its hooks.
5. Keep `combat-state.js` as a thin wrapper that re-exports from `challenge-state.js` with `kind='combat'`.
6. Syntax check.

### Phase 3: Wire into index.js

1. Replace `combat-state.js` imports with `challenge-state.js` imports.
2. Unify the combat + intimacy input routing blocks into one challenge block.
3. Replace `handleCombatButton` with generic `startChallengeRuntime('combat', ...)`.
4. Replace `handleIntimacyButton` with `startChallengeRuntime('intimacy', ...)`.
5. Replace `_combat` prompt injection with `_challenge`.
6. Replace `processCombatAssistantTurn` with `processChallengeAssistantTurn`.
7. Syntax check.

### Phase 4: Auto-seeding

1. Implement `startChallengeRuntime` with auto-seed transaction.
2. Remove setup-phase entity creation obligation from prompt.
3. Setup phase now only expects field-fill, not entity creation.
4. Syntax check + manual test combat flow.

### Phase 5: Scene draw expiry + hard validation

1. Add `scene_draw_expired` flag, expire on setup exit.
2. Add `correction_attempts` counter to runtime.
3. Implement forced recovery after 3 attempts.
4. Syntax check.

### Phase 6: Intimacy profile

1. Write `challenge-profile-intimacy.js`.
2. Remove standalone intimacy handling from index.js (handleIntimacyButton, the inline injection at lines 1554-1603, the continuation block at 1403-1420).
3. Intimacy now goes through the same engine as combat.
4. Test intimacy flow through the challenge engine.

### Phase 7: Entity migration

1. Deprecate `combat:*` entity type.
2. Add migration logic: on load, if `state.combats` has entries, copy them to `state.challenges` with `kind: 'combat'`.
3. Update `state-view.js` to render `challenge:*` entities.
4. Update `ui-panel.js` to show challenge state instead of combat-only state.
5. Eventually remove `combat:*` from `VALID_ENTITIES` (after grace period).

### Phase 8: Cleanup

1. Delete `combat-state.js` (now fully replaced by challenge-state.js).
2. Update CLAUDE.md.
3. Update documentation.
4. Write `challenge-profile-race.js` or another profile to prove extensibility.

---

## Key Design Decisions

### Why `challenge:*` and not keep `combat:*`?

One entity type means one collection, one lookup, one state machine.
The engine doesn't need to know about every possible domain-specific entity type.
Auto-seeding makes entity creation transparent — the model never writes `CR`, so the entity type name is less visible to it.

### Why profiles as plain objects, not classes?

No inheritance. No `super()`. No `this` binding issues. Just data + functions.
Profiles are imported, registered in a map, looked up by kind. Simple.

### Why keep the same phase machine?

The 5-phase machine (setup → awaiting_choice → awaiting_resolution → awaiting_reassessment → cleanup_grace) is generic enough. Profiles opt out of phases they don't use (e.g., intimacy skips awaiting_reassessment by setting `challengeThreshold: null`). Adding more phases is overhead without evidence of need.

### Why auto-seed instead of letting the model create?

This was the top recommendation from the previous review. The first-turn obligation (create entity + establish scene + present options) is the most fragile moment in the current system. Auto-seeding eliminates it. The model only fills fields, which is incremental and recoverable.

### Why keep lorebook entries for director framing?

The engine packet should be pure facts. Narrative guidance ("how to interpret a transform") is craft instruction, not mechanical data. Lorebook entries already fire per mode, and the profile declares which keys to trigger. This keeps the packet small and the model's attention on the data.
