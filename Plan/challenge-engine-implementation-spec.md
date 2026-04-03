# Challenge Engine Implementation Spec

Status: recommended implementation path after combat-runtime learnings

This spec translates the broader architecture idea into a reliable rollout plan.
It is intentionally stricter than `Plan/challenge-engine-architecture.md` where the
review exposed migration, lock-state, or responsibility ambiguities.

## Document Precedence

For the first implementation pass, this document supersedes the following parts of
`Plan/challenge-engine-architecture.md`:
- the proposed `challenge:*` entity replacement model
- the `scene_draw_expired` flag naming
- the high-level rollout ordering

Until the architecture document is revised, treat this spec as the canonical source
for implementation decisions.

## Goal

Generalize the current combat runtime into a reusable extension-owned challenge
engine that can support combat, intimacy, racing, chases, debates, and similar
structured scenes.

The engine should be generic. The profile should be domain-specific. The model
should remain responsible for judgment and fiction, not protocol or math.

## Core Rules

1. The extension owns mechanics.
   - Lock state
   - Input parsing
   - Option storage
   - Threshold lookup
   - Roll generation
   - Result classification
   - Turn obligations
   - Post-turn validation

2. The profile owns domain meaning.
   - Baseline doctrine
   - Categories and ordering
   - Participant resolution
   - Draw guidance
   - Entity fields
   - Cleanup expectations
   - Lorebook keys
   - Deduction type

3. The model owns fiction.
   - Assess whether an action is credible
   - Judge category when category is not already fixed
   - Narrate the injected result
   - Decide enemy/partner/opposition behavior
   - Write durable consequences
   - Decide when the challenge is resolved in state

4. One concern, one authority.
   - The extension should never ask the model to re-decide math it already decided.
   - The extension should not attempt to fully simulate domain logic in JS.

## What We Learned From Combat

These are the design constraints this spec is built around:

1. Lock is more important than "runtime active".
   - Routing must depend on a mode lock, not just the presence of a runtime
     object. Cleanup or stale runtime state must not hijack normal turns.

2. Setup is the most fragile moment.
   - The model should not be responsible for bootstrapping the runtime container.
   - Auto-seeding the container is the cleanest reliability improvement.

3. Structured packets work better than prose instructions.
   - The model follows combat more reliably when input, math, and obligations are
     injected as explicit fields instead of sentence-style explanation.

4. The extension must own the math completely.
   - Thresholds, d20, and final result should be injected as canonical facts.
   - The model should narrate `SUCCESS`, `TRANSFORM`, etc., not re-judge them.

5. Scene draws and resolution draws must be separated.
   - Scene draw only frames setup/opening circumstance.
   - Result draw only colors a resolved exchange.
   - Scene draw must expire after setup succeeds.

6. Bare option numbers and custom actions need one normalized input path.
   - `4`, `combat:2`, `combat: run away`, and `combat: run away DC Average`
     cannot use different logic branches.

7. Options need stable storage.
   - The engine must not depend on the model remembering what option 4 was.

8. The challenge container should be minimal.
   - The runtime entity is tactical state, not a second dossier for participants.

9. Hard validation is necessary.
   - If the assistant forgets to output required options or consume a stored roll,
     the engine must detect it and reinject a correction.

10. Entity migration is more dangerous than the abstraction itself.
   - History, rollback, and old-chat compatibility make "replace combat with
     challenge everywhere at once" riskier than it looks.

## Recommended Architecture

### Engine module

Create `challenge-state.js`.

This module becomes the generic runtime engine and owns:
- runtime lifecycle
- lock state
- phase transitions
- input parsing
- option parsing and storage
- threshold lookup
- roll payload creation
- result classification
- packet generation
- post-turn validation
- cleanup grace

### Profile modules

Profiles are plain objects, for example:
- `challenge-profile-combat.js`
- `challenge-profile-intimacy.js`
- later `challenge-profile-race.js`

Profiles define:
- `kind`
- `displayName`
- `inputPrefix`
- `deductionType`
- `entityType`
- `usesD20`
- `usesDraws`
- `categories`
- `autoSuccess`
- `autoFail`
- `thresholdTables`
- `defaultMode`
- `resultLabels`
- `optionCount`
- `optionPrefix`
- `seedFields`
- `modelFields`
- `resolutionFields`
- `lorebookKeys`
- hooks such as `getBaseline`, `resolveParticipants`, `buildContextLines`,
  `setupGuidance`, `cleanupGuidance`, `validateTurn`, `initProfileState`

### Registry module

Create `challenge-profiles.js` to expose:
- `getProfile(kind)`
- `getProfileByPrefix(prefix)`
- `getActiveProfile(runtime)`
- `listProfiles()`

## Important Design Correction: Do Not Unify Entity Types Yet

Do not replace `combat:*` with `challenge:*` in the first implementation.

Instead, make the engine generic while letting profiles declare their entity type.

Recommended profile field:

```js
entityType: 'combat'
```

Why:
- Current chats already contain `combat:*`.
- `_history` keys are entity-type specific.
- OOC history/eval/rollback behavior depends on that history shape.
- Immediate entity-type unification would require transaction migration or a
  history alias layer, which is a separate risk surface.

So the first generic engine should support profile-owned entity types:
- Combat profile uses `combat:*`
- Every v1 profile must still declare a durable entity type for its runtime
  container, even if that entity stays minimal

If a later `challenge:*` unification is still desired, do it as a separate,
explicit migration project with history compatibility.

## Runtime Data Model

Store runtime in:

```js
chatMetadata['gravity_challenge_runtime']
```

Runtime shape:

```js
{
    locked: boolean,
    kind: string,
    session_id: string,             // runtime-only session id, not a ledger target
    entity_type: string,
    entity_id: string,              // authoritative durable entity target
    phase: string,
    exchange: number,

    scene_draw: object | null,
    scene_draw_active: boolean,     // canonical name; do not use scene_draw_expired

    options: [],
    option_table_version: number,
    pending_action: object | null,
    pending_roll: object | null,
    last_input: object | null,
    last_resolution: object | null,

    difficulty_mode: string,
    cleanup_turns_remaining: number,
    correction_attempts: number,

    profile_state: {},
}
```

### Required invariants

1. `locked` controls routing.
2. `entity_type` and `entity_id` are the durable runtime container references.
3. `entity_id` is the only authoritative state target. `session_id` is runtime-only.
4. `scene_draw_active` is true only during setup phases.
5. `pending_roll` exists only when the extension has already computed a roll or
   explicit no-roll result.
6. `last_input` is always the normalized input packet for the current turn.
7. Only one active challenge runtime is supported per chat.

### Single active challenge constraint

The first implementation supports exactly one locked or live challenge runtime at a
time per chat.

This is intentional.
- Combat and intimacy should not overlap in v1.
- Nested or concurrent challenges are out of scope.
- The runtime key stores one object, not a stack.

## Phase Model

Replace the current broad setup phase with stricter subphases:

- `setup_opening`
- `setup_buffered`
- `awaiting_choice`
- `awaiting_resolution`
- `awaiting_reassessment`
- `cleanup_grace`

### Meaning

`setup_opening`
- Container already exists because the engine seeded it.
- The model must establish the opening and output options.
- No exchange resolution yet.

`setup_buffered`
- The player acted before setup fully completed.
- The model must finish the opening and then either:
  - assess the buffered action into options, or
  - resolve the buffered action immediately if the extension already fixed the
    result

`awaiting_choice`
- The engine is waiting for a new option pick or custom action.

`awaiting_resolution`
- The extension has a fully parsed action and, when applicable, a fixed roll.

`awaiting_reassessment`
- The extension preserved a roll but the player declared a category that was too
  generous, so the model must challenge the category before resolution continues.

`cleanup_grace`
- Resolution has happened.
- The model may write fallout and destroy the entity.
- The extension hard-clears the runtime after the grace window even if cleanup is
  imperfect.

### Setup buffering mechanics

When the player acts during `setup_opening`, the engine must:

1. Normalize the input into `last_input`.
2. Parse and store a canonical `pending_action`.
3. Transition `phase` from `setup_opening` to `setup_buffered`.
4. Keep setup incomplete until the opening state and first option frame are
   established.

No separate `buffered_input` field is required in the canonical engine model.
`setup_buffered` is represented by:
- `phase === 'setup_buffered'`
- `pending_action !== null`

Roll generation during `setup_buffered`:
- If the action is assessment-only, do not generate a roll.
- If the action has a declared category and the profile permits immediate
  resolution, the engine may generate and store `pending_roll`.
- If setup information is still insufficient for a safe fixed result, keep the
  parsed `pending_action` and defer roll generation until the transition to
  `awaiting_resolution`.

Compatibility note:
- The current combat runtime uses `pending_action.setup_buffered = true`.
- During migration, the combat wrapper may still map that legacy flag into
  `phase = setup_buffered`, but the engine's canonical meaning is the phase, not
  the flag.

## Input Contract

All challenge input must be normalized through one parser.

The engine should support:
- explicit prefix input: `combat: ...`, `intimate: ...`
- bare numeric option picks while locked: `2`
- prefixed numeric picks: `combat:2`
- prefixed custom actions with category
- prefixed or unprefixed freeform custom actions while locked

The engine should output one canonical packet:

```text
[CHALLENGE_INPUT]
KIND: combat
HAS_INPUT: true
PARSED_BY_EXTENSION: true
RAW_MESSAGE: combat:2
EXPLICIT_PREFIX: true
PARSED_SOURCE: OPTION_SELECTION
OPTION_ID: opt-e1-v1-n2
OPTION_INDEX: 2
OPTION_LABEL: Break left through the gap
INTENT: Break left through the gap and take the nearest rifle offline
DECLARED_CATEGORY: Highly likely
ASSESSMENT_ONLY: false
RESOLUTION_REQUEST: RESOLVE_IF_ALLOWED
[/CHALLENGE_INPUT]
```

### Stable option ids

Numbers are for UX only.

Runtime should store:

```js
[{ id, index, category, intent, label }]
```

The engine must resolve `2` to the stored option object itself, not ask the model
to infer what option 2 meant.

Recommended id format:

```text
opt-e{exchange}-v{option_table_version}-n{index}
```

Examples:
- `opt-e1-v1-n2`
- `opt-e3-v4-n1`

Rules:
- Increment `option_table_version` each time a new option table is stored.
- Numeric picks resolve only against the current option table version.
- Prefixed option ids may be preserved internally even if the visible HTML still
  shows numbered choices.

## Packet Contract

The engine should inject four structured packets:

- `[CHALLENGE_INPUT]`
- `[CHALLENGE_STATE]`
- `[CHALLENGE_MECHANICS]`
- `[CHALLENGE_TASK]`

### CHALLENGE_STATE

This should contain stable runtime facts, not prose:
- kind
- locked
- phase
- entity type
- entity id
- exchange
- scene draw active or expired
- participant summary if needed

### CHALLENGE_MECHANICS

This should contain extension-owned math facts only:
- thresholds
- action state
- baseline category
- declared category
- effective category
- threshold for the current action
- d20 result
- locked result
- result labels
- whether `divination.last_draw` must be written

If `SUCCESS_DECIDED_BY_EXTENSION` is true, the model must not judge outcome.

### CHALLENGE_TASK

This should contain turn obligations only:
- `MUST_ESTABLISH_OPENING`
- `MUST_ASSESS_ACTION_TO_OPTIONS`
- `MUST_RESOLVE_EXCHANGE`
- `MUST_OUTPUT_OPTIONS`
- `MUST_RECORD_LAST_DRAW`
- `MUST_WRITE_LASTING_CONSEQUENCES`
- `MUST_DESTROY_ENTITY`
- `OPTION_COUNT`

No narrative explanation should live here.

## Auto-Seeding

The engine should auto-seed the runtime container on challenge start.

For combat:
- seed `combat:*`
- do not ask the model to `CR combat:*`

This is the most important reliability improvement.

Recommended helper:
- use the existing ledger append path
- mark system-seeded transactions with a reason/source the extension can audit

The model should only fill or update fields after seeding.

### Runtime-key migration

The first generic rollout must bridge existing combat metadata.

On runtime load:
- if `gravity_challenge_runtime` exists, use it
- else if `gravity_combat_runtime` exists, translate it into challenge-runtime
  shape for the combat profile and persist the translated value

During the grace period:
- `combat-state.js` may continue reading legacy combat runtime state through the
  facade
- new writes should prefer `gravity_challenge_runtime`

## Draw Rules

### Scene draw

- Created when the challenge starts
- Active only in `setup_opening` and `setup_buffered`
- Used only to illuminate opening circumstance, leverage, spacing, initiative,
  exposure, and why the first options fall where they do
- Must expire after setup completes successfully

### Result draw

- Created only when the profile uses result draws for a resolved exchange
- Applies only to that exchange
- Never compared numerically to the threshold
- Colors the already-determined result

## Math Rules

The extension should be the sole owner of:
- threshold tables
- active difficulty mode
- d20
- result classification

Profiles may define their own:
- category ordering
- threshold tables
- result labels
- reassessment threshold
- whether d20 is used at all

The model may still judge category when the action is not yet fixed, but once the
extension locks a result, the model only narrates it.

## Settings Model

Settings must be namespaced per profile.

Recommended metadata shape:

```js
chatMetadata['gravity_challenge_settings'] = {
    combat: {
        mode: 'Cinematic',
        customThresholds: null,
    },
    intimacy: {
        mode: 'Default',
    },
    race: {
        mode: 'Street',
    },
};
```

Do not reuse combat difficulty metadata for all profiles.

### Settings migration

Existing chats may already contain:

```js
chatMetadata['gravity_combat_settings'] = {
    mode,
    customDCs,
}
```

On first load of the generic engine:
- if `gravity_challenge_settings` exists, use it
- else if `gravity_combat_settings` exists, migrate it into
  `gravity_challenge_settings.combat`
- preserve compatibility reads from the old key during the migration window

## Deduction Routing

Profiles must declare their deduction type explicitly.

Recommended field:

```js
deductionType: 'combat'
```

Why:
- `kind` is not always a preset reasoning mode.
- Combat can use combat CoT.
- Intimacy can use intimacy CoT.
- Race can temporarily reuse combat CoT without pretending `kind === combat`.

`index.js` should route on `profile.deductionType`, not `profile.kind`.

### Deduction state ownership

Keep `_pendingDeductionType` in `index.js` for the first rollout.

The engine should not own global deduction state yet.
Instead, it should expose one lightweight decision point:
- `getActiveChallengeDeductionType()` or equivalent derived from the active profile

Then `index.js` can continue to manage the one-shot routing variable without
mixing that concern into runtime storage.

## Validation Rules

The engine must validate each assistant turn after commit.

Generic validation:
- required entity exists
- stored roll was consumed when required
- `divination.last_draw` was written when required
- options were output when required
- options were parseable
- pending action was cleared or preserved correctly

Profile validation:
- delegated to `profile.validateTurn()`

Retry policy:
- increment `correction_attempts` when validation fails
- reinject a focused correction
- after 3 failed attempts, force recovery to avoid trapping the user forever

Forced recovery should be profile-aware and conservative.

### Default forced recovery by phase

These are engine defaults. Profiles may override them if needed.

`setup_opening`
- Keep `locked = true`
- Re-seed the minimal entity if it is missing
- Clear malformed option tables
- Stay in `setup_opening`
- Re-request opening establishment plus options

`setup_buffered`
- Keep `locked = true`
- Preserve `pending_action`
- If action state is malformed, downgrade to assessment-only instead of discarding
  the action
- Stay in `setup_buffered`
- Re-request opening plus buffered-intent capture

`awaiting_choice`
- Keep `locked = true`
- Clear stale or malformed options
- Stay in `awaiting_choice`
- Request a fresh option table

`awaiting_resolution`
- Keep `locked = true`
- Preserve `pending_action` and `pending_roll`
- Drop nonessential context noise if needed
- Stay in `awaiting_resolution`
- Reissue a minimal "narrate the stored result now" correction rather than
  discarding the player's action

`awaiting_reassessment`
- Keep `locked = true`
- Preserve the stored roll
- Stay in `awaiting_reassessment`
- Re-request a corrected category judgment

`cleanup_grace`
- Clear runtime
- Do not continue trapping the user in challenge mode

### Resolution detection

Profiles must provide an explicit resolution detector.

Recommended hook:

```js
isResolved(runtime, entity, state, committedTxns) => boolean
```

The engine uses this hook to decide:
- whether to enter `cleanup_grace`
- whether to release the lock
- whether cleanup obligations now apply

Do not rely on combat-specific heuristics in the generic engine core.

## Minimal Entity Doctrine

Runtime entities should be tactical containers, not repeated dossiers.

Combat entity guidance:
- short `participants`
- short `hostiles`
- id-only or terse `primary_enemy`
- short `terrain`
- short `situation`
- short `threat`

Participant power, abilities, wounds, intimacy stance, limits, and similar
identity data should remain on `char:*` and `pc`.

## Extraction Seams From Current combat-state.js

The current `combat-state.js` is large because it mixes generic engine work and
combat-specific doctrine in the same functions. The extraction should separate
along these seams:

### Move into challenge-state.js

- runtime CRUD and metadata access
- lock checks
- input normalization
- prefix detection
- option parsing and storage
- threshold-table lookup
- roll payload creation
- result classification
- generic packet builders
- generic phase transitions
- generic post-turn validation
- cleanup grace handling

### Move into challenge-profile-combat.js

- power-gap baseline doctrine
- combat participant resolution
- actor formatting for combat dossiers
- combat-specific context tail lines
- scene draw phrasing for encounter leverage
- result draw phrasing for exchange interpretation
- combat cleanup guidance
- combat-specific post-turn validation

### Keep temporarily in combat-state.js facade

- backwards-compatible exports used by `index.js` and `ui-panel.js`
- legacy runtime translation from combat-only shape to generic shape
- compatibility helpers for old settings/runtime keys during migration

## Rollout Plan

### Phase 1 - Scaffolding and compatibility shims

1. Add `challenge-state.js`
2. Add `challenge-profiles.js`
3. Create `challenge-profile-combat.js`
4. Keep `combat-state.js` as a thin facade over the combat profile
5. Keep current `combat:*` entity type and current combat UI naming
6. Preserve current `_combat` slot during this phase

Goal: no visible behavior change. This phase is scaffolding plus compatibility,
not a user-facing reliability pass by itself.

### Phase 2 - First real combat reliability pass

1. Move combat runtime logic into the engine
2. Auto-seed `combat:*`
3. Add stable option ids
4. Split setup into `setup_opening` and `setup_buffered`
5. Add `CHALLENGE_*` packets under the combat prompt
6. Expire scene draw after successful setup
7. Tighten post-turn validation

Goal: combat becomes the proof case

### Phase 3 - Generic routing and settings

1. Route challenge input through one path in `index.js`
2. Switch routing to lock-based checks, not runtime-active checks
3. Namespace profile settings in chat metadata
4. Route `_pendingDeductionType` from `profile.deductionType`

### Phase 4 - Intimacy on the same engine

1. Add `challenge-profile-intimacy.js`
2. Reuse the engine with no d20 math
3. Keep intimacy-specific director framing in lorebook entries
4. Validate stance/limits in the profile hook

### Phase 5 - Optional future unification

Only after the engine is stable across at least two profiles:
- decide whether a generic `challenge:*` entity is still worth it
- if yes, design a history-safe migration layer first

This is explicitly not part of the first implementation.

## Implementation Handoff — Phases 1+2

Completed: `3d7db38` on `codex-v13-state-delta` (2026-04-03)

### What was built

Phases 1 and 2 were implemented together as one coherent unit. Phase 3 routing
was also partially completed since it was required by the unified input path.

Files created:
- `challenge-state.js` (~820 lines) — generic engine
- `challenge-profile-combat.js` (~490 lines) — combat profile
- `challenge-profiles.js` (~40 lines) — profile registry

Files modified:
- `combat-state.js` — replaced with ~160-line facade delegating to the engine
- `index.js` — imports from engine, unified input routing, `_challenge` slot

### What was implemented from Phase 1

All 6 items completed:
1. `challenge-state.js` created
2. `challenge-profiles.js` created
3. `challenge-profile-combat.js` created
4. `combat-state.js` kept as thin facade (ui-panel.js still imports from it)
5. `combat:*` entity type preserved — profile declares `entityType: 'combat'`
6. Injection slot renamed from `_combat` to `_challenge` (done early for
   correctness — keeping the old name in the generic engine would require a
   later rename through prompt-sensitive code)

### What was implemented from Phase 2

5 of 7 items completed. Phase 2 is **not fully complete** — the two deferred
items are required before this phase can be marked done.

1. Combat runtime logic moved into the engine ✓
2. Auto-seed `combat:*` via system `CR` transaction through `append()` ✓
   - Transaction tagged with `r: 'system:challenge-engine:auto-seed'`
   - `MUST_CREATE_ENTITY` is now always `false`; replaced by `MUST_FILL_ENTITY_FIELDS`
3. Stable option ids — **not yet implemented**. The spec requires
   `opt-e{exchange}-v{option_table_version}-n{index}` format (line 367).
   Without this, option resolution still depends on the model consistently
   numbering options, which the spec identified as a reliability risk (line 96).
   Must be completed before Phase 2 is closed.
4. Setup phase split into `setup_opening`/`setup_buffered` — **not yet
   implemented**. The spec defines these as distinct phases with different
   mechanics (lines 262-317), including explicit rules for when roll generation
   should be deferred during `setup_buffered`. The current implementation uses
   a single `setup` phase with `pending_action.setup_buffered` as a flag,
   which conflates the two. This is a reliability gap: the engine cannot
   distinguish "model has not established opening yet" from "model established
   opening but player input arrived" without the phase split. Must be completed
   before Phase 2 is closed.
5. `CHALLENGE_*` packets emitted with `KIND: combat` ✓
6. Scene draw expires after setup via `scene_draw_active` flag ✓
7. Post-turn validation tightened with `correction_attempts` counter ✓
   - Forced recovery after 3 failed attempts per phase
   - `setup`: re-seeds entity if missing
   - `awaiting_resolution`: forces to `cleanup_grace` to avoid trapping
   - `cleanup_grace`: hard clears on next turn regardless

### What was implemented from Phase 3

3 of 4 items completed:
1. Challenge input routed through one path in `index.js` ✓
   - `detectChallengePrefix(rawText)` replaces separate combat/intimacy regex
2. Routing uses lock-based check (`isChallengeSessionLocked`) ✓
3. Settings namespaced to `gravity_challenge_settings.combat` ✓
   - Legacy `gravity_combat_settings` read as fallback
4. Deduction type routing from `profile.deductionType` ✓
   - Engine returns `profile.deductionType` in the result object
   - `_pendingDeductionType` set from `challengeResult.deductionType`
   - Sticky latch uses `activeProfile.deductionType` instead of hardcoded `'combat'`
   - `getActiveChallengeDeductionType()` derives from the active profile

### Decisions that deviated from this spec

1. **`scene_draw_active`**: The implementation uses `scene_draw_active` as the
   spec defines at line 211. This is not a deviation — it follows the spec's
   canonical naming. The architecture doc used the older `scene_draw_expired`
   name which this spec supersedes.

2. **No entity type registration**: The spec's Phase 1 mentioned keeping `combat:*`.
   No changes were made to `consistency.js`, `state-compute.js`, or
   `state-machine.js` since the combat entity type already exists.

3. **Utility duplication**: `coerceNumber`, `normalizeText`, `toList` are
   duplicated between `challenge-state.js` and `challenge-profile-combat.js`.
   This avoids a circular dependency (profile cannot import from engine that
   imports from profile registry). Should be extracted to `challenge-utils.js`
   when the second profile is added.

4. **Intimacy continuation fallback preserved**: The `intimate:` continuation
   block in `index.js` (~line 1407) was kept as a fallback for when no challenge
   runtime is locked. It will be removed when the intimacy profile is added in
   Phase 4.

### What remains for Phase 4 (Intimacy on the same engine)

1. Create `challenge-profile-intimacy.js` with:
   - `usesD20: false`
   - `challengeThreshold: null` (no reassessment)
   - Stance/trust-based baseline
   - `intimate` input prefix and option prefix
2. Register it in `challenge-profiles.js`
3. Remove the inline intimacy handling from `index.js`:
   - The `intimate:` continuation block (~line 1407-1424)
   - The `handleIntimacyButton()` inline OOC injection (~line 1557-1603)
   - Replace with `startChallengeRuntime('intimacy', drawDivination())`
4. Extract shared utilities to `challenge-utils.js`

### What must be completed before Phase 2 is closed

- Stable option IDs (`opt-e{exchange}-v{option_table_version}-n{index}`) with
  `option_table_version` increment on each new table (spec lines 355-375)
- Setup phase split into `setup_opening` / `setup_buffered` with distinct
  mechanics for roll deferral and buffered-action assessment (spec lines 262-317)

### What remains deferred to later phases

- Entity type unification (`challenge:*` replacing `combat:*`) — Phase 5
- Removing the `combat-state.js` facade — after ui-panel.js migrated
- Intimacy profile — Phase 4

## Non-Goals

These are not part of the first implementation:
- replacing every domain entity with `challenge:*`
- automatic migration of old transaction history
- making the extension judge full fictional credibility
- adding a universal deduction template for all future profiles
- fully abstracting away profile-specific lorebook framing

## Success Criteria

The implementation is successful when:

1. Combat behaves the same or better for users, but with fewer protocol failures.
2. Scene draw no longer contaminates later exchanges.
3. Locked result turns no longer drift into model-side math.
4. Bare option numbers and custom actions resolve reliably.
5. The same engine can run at least one second profile without combat-specific
   branching in the engine core.
6. Old chats with `combat:*` remain readable and auditable.
