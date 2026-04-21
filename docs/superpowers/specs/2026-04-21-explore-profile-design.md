# Explore Profile — Design

**Date:** 2026-04-21
**Status:** Approved for implementation planning
**Scope:** New challenge profile (`explore`) added to the generic challenge engine. No engine changes.

---

## 1. Context

Gravity Ledger already ships a generic challenge engine (`challenge-state.js` + `challenge-mechanics.js` + `challenge-input.js` + `challenge-shared.js`) driven by domain-specific profiles registered in `challenge-profiles.js`. Combat is currently the sole reference profile.

The engine owns mechanics (categories, thresholds, d20 rolls, tarot draws, option parsing, phase flow, auto-seed). Profiles own meaning (what "combat" means, baseline computation, prompt text, resolution branch doctrine).

This spec adds a second profile — `explore` — that gives the LLM an explicit creative mandate: the player spends a "give me fresh stuff" pass, the tarot draw colors what emerges, and the LLM is authorized (and instructed) to introduce new entities (people, places, quests, factions, pressures) as a natural part of resolving explore clashes.

## 2. Goals

- Ship a new profile that mechanically behaves like combat but narratively functions as content generation.
- Zero engine changes. The engine is profile-agnostic by design and explore must prove it.
- Write a "how to add a challenge profile" guide so the next profile (intimacy, per user's stated plan) can follow the same pattern without reverse-engineering.
- Preserve the single-runtime invariant: one challenge session active at a time.
- Preserve Gravity's doctrine that failure is never inherently bad — the tarot draw supplies valence; the mechanic supplies intensity.

## 3. Non-Goals

- Refactoring shared helpers between combat and explore profiles (explicitly deferred — wait for a third profile before DRY-ing).
- Building a `collision → explore` activation path. The door is left open structurally (explore is a registered profile, so the generic activation hook will recognize it), but no trigger is built in v1.
- Changing combat's behavior in any way.
- UI polish (distinct accent colors, animations). Explore reuses combat's CSS in v1.
- Authoring lorebook content beyond stubs (`gravity_mode_explore_core`, `gravity_mode_explore_optional_examples`, `gravity_prose_explore`). Content is iterated post-launch.

## 4. Design Decisions (Locked In)

| Decision | Choice | Rationale |
|---|---|---|
| Session shape | Multi-clash, same as combat | User explicitly chose "same mechanics" |
| Session anchor | Standalone `explore:<id>` entity with free-text `target` string | Self-contained; no cross-entity lookups at seed; mirrors combat's self-contained pattern |
| Baseline | Fixed `Average`; `gap: null`; no power assessment | Explore has no opponent; LLM assigns per-option categories by boldness/risk |
| Difficulty modes | Reuse combat's Cinematic / Gritty / Heroic / Survival tables | Same DC numbers; consistent player experience across profiles |
| Scene draw | Yes — dealt at setup, colors location atmosphere and visible leads | Consistent with combat; core to "draw-driven" explore premise |
| Invocation | `explore:` prefix + UI button with `fa-compass` icon | Mirrors combat's `combat:` + button |
| Escape mechanisms | (1) Narrative departure (LLM-driven); (2) Advance-turn prompt nudge; (3) Combat handoff when resolution triggers a fight | Prompt-level, no engine forcing |
| Coexistence | Single-runtime invariant preserved. Cross-profile prefix attempts rejected with neutral warning. | Matches current engine assumption |
| Runtime helper file | New `explore-state.js` (mirror of `combat-state.js`) | Anticipated divergence in UI presentation over time |

## 5. Doctrinal Core — Resolution Branch Semantics

The tarot draw determines **valence** (gift, threat, twist, hook). The d20 versus DC determines **intensity** (subtle vs. punctuated). Nothing in the mechanic forces misfortune — the draw alone decides whether an outcome is boon or burden.

| Branch | Meaning | LLM Authorization |
|---|---|---|
| **SUCCESS** (d20 ≥ DC) | PC finds the expected kind of thing for the chosen option | Introduce 1 new entity from `{char, place, constraint, collision}`; draw colors tone |
| **CRITICAL_SUCCESS** (nat 20) | Big find, amplified | Up to 2 entities; `collision` quest hooks and `faction` seeds authorized |
| **TRANSFORM** (d20 < DC, non-critical) | Expected thing isn't there. **Apply the rule of cool** — read the draw, introduce the most interesting thing this location could plausibly hold given that draw. The mechanic does not preload misfortune; the draw decides whether it's a boon (injured dragon in the vault), threat (body in the vault), twist (vault is empty and that matters), or hook (someone else's secret). | 1 entity, any type including `faction`, `pressure` — draw's tone selects the type |
| **CRITICAL_TRANSFORM** (nat 1) | Starkly different, weighty. Rule of cool at full amplification. | Up to 2 entities, any types, memorable. Could be windfall or catastrophe. |
| **AUTO_SUCCESS** (category=Absolute) | Narrate, no draw | No authorized entity introduction; the outcome was a given |
| **AUTO_FAIL** (category=Impossible) | Narrate, no draw | No authorized entity introduction |

**Standing hygiene rail across all branches:** new `char` entities default to `CAMEO` tier unless the fiction clearly justifies promotion. Explore must not bloat the character roster with SUPPORTING-tier strangers.

## 6. File Surface

### New files (3)

1. **`challenge-profile-explore.js`** (~300 lines) — profile definition, structural twin of `challenge-profile-combat.js`.
2. **`explore-state.js`** (~165 lines) — UI runtime helpers, mirror of `combat-state.js` (`getExploreBaseline`, `getExploreEntity`, `getExploreSettings`, `setExploreDifficultyMode`, `setExploreCustomDcs`).
3. **`Documentation/Extension/adding_a_challenge_profile.md`** — step-by-step guide, uses combat + explore as reference implementations.

### Edited files (8)

| File | Nature of edit |
|---|---|
| `challenge-profiles.js` | Register the explore profile in the `PROFILES` registry |
| `state-compute.js` | Add `explores: {}` collection; register `explore` in entity-type → collection map; register in `INITIAL_STATES` |
| `consistency.js` | Add `explore` to entity-type → collection map, `VALID_ENTITIES`, `INITIAL_STATES` |
| `state-machine.js` | Add `EXPLORE_STATES` + `EXPLORE_TRANSITIONS`; register in `validateTransition`, `getValidNextStates`, `getStateMachineField`; export |
| `state-view.js` | Add `explore` branch in `formatChallenge`; add active-Explores registry block |
| `ui-panel.js` | Add explore section mirroring combat section |
| `index.js` | Add `handleExploreButton`; register `onExplore` in bootstrap; add explore button in toolbar; add explore deduction template; add explore exemplar targets in `getExemplarTargets` |
| `Documentation/README.md` | Add pointer to `adding_a_challenge_profile.md` |

### NOT touched (engine core)

- `challenge-state.js`, `challenge-mechanics.js`, `challenge-input.js`, `challenge-shared.js` — engine, stays generic.
- `ledger-store.js`, `snapshot-mgr.js`, `regex-intercept.js` — infra, stays generic.
- `ooc-handler.js`, `setup-wizard.js` — no explore-specific commands in v1.

## 7. Profile Contract (`challenge-profile-explore.js`)

### Identity
```js
kind: 'explore',
displayName: 'Explore',
inputPrefix: 'explore',
deductionType: 'explore',
entityType: 'explore',
```

### Mechanics (same as combat)
- `categories`: `['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute']`
- `categoryAliases`: same 8 aliases combat uses
- `thresholdTables`: `{ Cinematic, Gritty, Heroic, Survival }` — same numbers
- `defaultMode`: `'Cinematic'`
- `usesD20: true`, `usesDraws: true`, `challengeThreshold: 2`
- `resultLabels`: `{ success: 'SUCCESS', fail: 'TRANSFORM', critSuccess: 'CRITICAL_SUCCESS', critFail: 'CRITICAL_TRANSFORM' }`
- `phases`: `['setup_opening', 'setup_buffered', 'awaiting_choice', 'awaiting_resolution', 'awaiting_reassessment', 'cleanup_grace']`
- `optionCount: [3, 4]`, `optionPrefix: 'explore'`

### Persistence
```js
seedFields:       { kind: 'explore', status: 'ACTIVE' },
modelFields:      ['target', 'outcome', 'aftermath'],
resolutionFields: ['outcome', 'aftermath'],
lorebookKeys: {
  core:     'gravity_mode_explore_core',
  optional: 'gravity_mode_explore_optional_examples',
  prose:    'gravity_prose_explore',
},
```

`target` is filled **by the LLM during setup** (same pattern combat uses for `primary_enemy`). The player's input text is already visible via `CHALLENGE_INPUT` injection, so the LLM writes `target="the market"` in its setup-turn update block. `validateTurn` catches the case where `target` is still empty after setup.

### Hooks

| Hook | Behavior |
|---|---|
| `getBaseline(state, entity)` | Returns `{ category: 'Average', gap: null, target: entity?.target \|\| null }`. No power-gap computation. Combat-specific fields (`primary_enemy`, `pc_power`, `enemy_power`) are omitted — the engine only reads `baseline.category`; other fields are profile-private. |
| `resolveParticipants(state, entity)` | Returns `{ pc, opponents: [], allies: [] }`. PC only. |
| `describeActor(actor)` | Same helper combat uses, minus opponent-specific fields (no `power`, no `wounds`). Describes PC's carry. |
| `buildContextLines(runtime, entity, state, baseline, helpers)` | Largest method. Profile-specific doctrine per phase (see Section 8). |
| `sceneDrawGuidance()` | `"location atmosphere, visible leads, why the options fall at their assessed categories"` |
| `resultDrawGuidance()` | `"SUCCESS: colors the tone of the expected find. TRANSFORM: rule of cool — determines what genuinely interesting thing emerges instead. The draw supplies valence; the mechanic supplies intensity."` |
| `setupGuidance()` | Instructs LLM to fill `target` from player input; carry atmosphere and sensory detail in scene prose. |
| `cleanupGuidance()` | Instructs LLM to preserve CR'd entities; write `outcome` + `aftermath`; destroy the explore container. |
| `validateTurn(runtime, state, committedTxns)` | Checks: if `phase` is post-setup and `entity.target` is empty, return correction string. Otherwise return `null`. |
| `initProfileState(state)` | Returns `{}`. No profile-specific persistent state. |
| `isResolved(runtime, entity, state, committedTxns)` | Resolved when `entity.status === 'RESOLVED'` OR a committed TR/S transaction sets status to RESOLVED. Same pattern as combat. |

## 8. `buildContextLines` — Per-Phase Instructions

All phases include: scene-draw block (with explore-specific guidance), stored options block, pending action summary (if any), pending roll summary (if any), last resolution (if any), option HTML format reminder with `explore:` prefix, exit-condition reminder.

### `setup_opening` / `setup_buffered`
- Instruct LLM to fill `target` on `explore:<id>` from the player's input.
- Use scene draw to paint the location's atmosphere, what leads are visible, why the options sit at their assessed categories.
- Output 3-4 clickable options for the opening.
- Do not resolve a find yet.

### `awaiting_choice`
- Explore is locked but no valid option list is stored (or player typed a freeform action without a category).
- Assess the action if present; output 3-4 clickable options.

### `awaiting_resolution`
- Mechanical resolution is already fixed (category, d20, DC, draw, resolution label).
- Resolve exactly one clash using the injected values.
- Apply the resolution branch doctrine (Section 5). On TRANSFORM, apply the rule of cool.
- Introduce CR transactions for new entities as part of the update block.
- If the clash naturally triggers combat, spawn a combat collision and resolve explore this same turn.
- End with 3-4 clickable next-step options if the location still holds leads, or offer closure.

### `awaiting_reassessment`
- Same as combat — challenge the player's declared difficulty before resolving. Preserve stored d20/draw.

### `cleanup_grace`
- Write lasting consequences. Ensure any CR'd entities are persisted.
- Write `outcome` and `aftermath` on `explore:<id>`.
- Destroy the explore container.
- Do not output new options.

### Advance-turn override
When an advance turn fires while explore is locked, the profile injects: *"The world is moving on. Close the current explore session this turn: write `outcome` and `aftermath` on `explore:<id>`, set `status` to RESOLVED, destroy the explore entity. Carry any persistent discoveries forward as their own CR transactions before closing."*

## 9. Invocation & Input

### Prefix invocation
Player types `explore: the market` → `detectChallengePrefix` in `challenge-profiles.js` iterates registered profiles, matches `inputPrefix: 'explore'`, returns the explore profile. Engine locks runtime, auto-seeds `explore:<id>` with `{ kind: 'explore', status: 'ACTIVE' }`, injects `CHALLENGE_INPUT` into next prompt. Zero new code paths.

### Custom inline category
`explore: sneak into the back rooms DC Highly unlikely` — existing parsers pick up the category against the explore profile's `categories`/`categoryAliases`. Fully reused.

### Option picks
LLM emits option HTML like:
```html
<span class="act" data-value="explore: option | opt-e1-v1-1 | 1 | Highly likely | Skim the public stalls for oddities">1. Skim the public stalls (Highly likely)</span>
```
Player clicks → existing option parser handles it. Indexed picks (`explore:2`) work via `parseBareIndexText`.

### UI button
`handleExploreButton()` at `index.js` calls `startChallengeRuntime('explore', drawDivination())`. Button element uses `fa-compass` icon, placed next to combat button.

**Empty-target button-press case:** clicking the button without a typed target (or using prefix `explore:` with no body) enters setup with no `CHALLENGE_INPUT` content. The explore profile's setup instructions tell the LLM to read current scene context and either (a) render the PC's immediate surroundings as 3-4 explorable target options the player can pick from, or (b) ask the player what they want to explore. The LLM picks the fit. Once the player commits to a target, the LLM fills `explore:<id>.target` on the next turn and the normal flow resumes. Mirrors how combat's button-press-with-no-enemy works.

### UI panel runtime helpers (`explore-state.js`)
Mirrors `combat-state.js` exactly: exports `getExploreBaseline`, `getExploreEntity`, `getExploreRuntime`, `getExploreSettings`, `setExploreDifficultyMode`, `setExploreCustomDcs`. `ui-panel.js` imports these for the explore section.

## 10. State Layer Changes

### `state-compute.js`
- `createEmptyState()`: add `explores: {}`.
- Entity-type → collection map: add `explore: 'explores'`.
- `INITIAL_STATES`: add `explore: 'ACTIVE'`.
- Normalization loop list (around line 774): add `'explores'` if applicable (verify at implementation).

### `consistency.js`
- Entity-type → collection map (line 24): add `explore: 'explores'`.
- `VALID_ENTITIES` (line 44): add `'explore'`.
- `INITIAL_STATES` (line 346): add `explore: 'ACTIVE'`.
- No field whitelist: consistency validates shape only (per CLAUDE.md); per-field checks stay in the profile's `validateTurn`.

### `state-machine.js`
```js
const EXPLORE_STATES = ['ACTIVE', 'RESOLVED'];
const EXPLORE_TRANSITIONS = {
    ACTIVE:   { advance: 'RESOLVED' },
    RESOLVED: {},
};
```
Register in `validateTransition`'s `machines`, `getValidNextStates`'s `machines`, `getStateMachineField`'s `fields`. Export both constants. `validateTransition` at `index.js:1514` then rejects invalid explore-status TRs at commit time automatically.

### `snapshot-mgr.js`
No edit. Snapshots operate on the full state tree; the new `explores` collection rides along generically.

## 11. Presentation Layer Changes

### `state-view.js`
- `formatChallenge` (around line 108): add `if (type === 'explore')` branch that produces one line showing `[status] — target: <target> → id: <id>`.
- Active-session registry (around line 311): add `Explores:` block that iterates `state.explores` and routes each through `formatChallenge`.

### `index.js` — deduction template
New entry in the deduction-template dispatch (same site combat/regular/advance/intimacy templates live). The explore template walks the LLM through 5-6 fields:

1. **Scene atmosphere** — read the scene draw; what tone / era / mood does this location carry?
2. **Visible leads** — 3-4 plausible lines of inquiry from where PC is standing.
3. **Per-lead category** — honest assessment (Highly likely / Average / Highly unlikely / Impossible); baseline is Average; boldness / stealth / disruption push upward, casual / overt / protected-by-status push downward.
4. **PC context** — what `knowledge_asymmetry` / abilities / equipment bends any lead's category?
5. **Entity permissions** — SUCCESS introduces 1 expected-kind entity; TRANSFORM applies rule of cool with 1 any-type entity; CRITICAL variants scale up; new chars default to CAMEO.
6. **Continuation cue** — after this clash resolves, is the location tapped out or does it hold deeper leads?

### `index.js` — button + exemplar targets
- `handleExploreButton` mirrors `handleCombatButton` at line 2147.
- `onExplore` registered in bootstrap config at line 2396.
- Button DOM added next to combat button around line 2446: `<button class="gl-input-btn" id="gl-input-explore" title="Begin exploration"><i class="fa-solid fa-compass"></i> Explore</button>`.
- Click listener added around line 2454.
- `getExemplarTargets` at line 283: add `if (deductionType === 'explore') return ['explore', 'scene'];`

### `ui-panel.js`
Mirror the combat section:
- Header row: runtime state (active/resolved/none).
- If active: target, current phase, difficulty mode dropdown, DC table display, last resolution summary, stored options summary.
- Difficulty mode selector wired to `setExploreDifficultyMode`.
- Custom DC editor wired to `setExploreCustomDcs`.
- Reuses combat's CSS classes.

### `style.css`
No changes in v1. Future polish (distinct accent color) is post-launch.

### Lorebook content stubs
Three new entries in `Gravity World Info.json` (content deliverable, not code):
- `gravity_mode_explore_core` — core mode rules.
- `gravity_mode_explore_optional_examples` — 2-3 worked examples.
- `gravity_prose_explore` — prose guidance for exploration scenes.

## 12. Coexistence & Escape

### Single-runtime invariant
`getChallengeRuntime()` is scalar. Only one challenge session active at a time.

- Explore locked + player types `combat:` → existing cross-profile guard warns / rejects. Verify warning text is profile-agnostic; if combat-specific, neutralize to "the active challenge."
- Explore locked + player clicks combat button → `handleCombatButton` short-circuits with toast: *"Finish the current explore session before starting combat."* Symmetric guard added to `handleExploreButton`.

### Explore → Combat handoff (LLM-driven)
When a clash resolution triggers a fight (ambush, recognition, escalation), the LLM's update block contains: (1) `CR collision:<id>` with combat intent; (2) `S explore:<id>.outcome` and `TR explore:<id>.status ACTIVE→RESOLVED` with `aftermath`; (3) destroys explore entity or leaves RESOLVED for ledger history. Next turn: collision opens combat via existing collision → combat activation. Zero engine change.

### Advance-turn exit (LLM-driven)
Advance turns inject the explore profile's override instruction (Section 8). `validateTurn` soft-warns if explore is still ACTIVE after an advance turn executed. LLM usually catches this on the next turn via the correction queue.

### Natural narrative exit
PC prose signaling departure ("I return home", "leave the market", "head back to the ship") — LLM recognizes and closes the session in its update block. No button, no OOC, no prefix.

### OOC commands
All existing OOC commands (`snapshot`, `rollback`, `eval`, `history`, `consolidate`) operate on the ledger and state generically. `explore:<id>` entities ride through them.

- `ooc: snapshot` — snapshots include active explores. No edit.
- `ooc: rollback` — if rollback moves past an explore CR, state-compute re-materializes without the explore, and the existing stale-runtime guard at `challenge-state.js:1085` fires. Works generically.
- `ooc: eval` — diagnostic dump; if current handler hardcodes `state.combats`, add `state.explores`. Verify at implementation.

### Future: `collision → explore` activation
Not built in v1. The explore profile is registered, so the generic collision → challenge activation hook will recognize it when a later contributor wires an explore-intent collision path. Documented in the extension guide as an intentional future extension.

### Intimacy coexistence
Phase 2 removed the intimacy profile; intimacy is now prose + `knowledge_asymmetry`. No runtime collision. User has stated intent to re-add intimacy as a future profile copied from explore — this spec's "how to add a profile" guide supports that directly.

## 13. Error Handling

| Error | Detection | Recovery |
|---|---|---|
| LLM doesn't fill `target` after setup | `validateTurn` returns correction string | Correction queued via self-correction loop |
| LLM writes options with wrong prefix | `parseChallengeOptionsFromMessage` profile-scopes parsing | Options ignored; phase stays `awaiting_choice`; next turn reminds LLM of correct prefix |
| Malformed option HTML | existing challenge-input parsers return null | Option not stored; format reminder next turn |
| LLM skips CR on SUCCESS | No mechanical check | Acceptable — doctrine encourages, does not enforce |
| LLM ignores advance-turn exit | `validateTurn` soft-warn | Warning queued; self-resolves on next regular turn |
| Rollback past explore CR | Existing stale-runtime guard (`challenge-state.js:1085`) | Runtime cleared with existing message |
| Explore button while combat active | `handleExploreButton` guard | Toast; no state change |
| Engine auto-seed failure | Existing challenge-engine error handling | Lock not acquired; player sees failure message |
| Explore entity destroyed mid-session | State-compute + stale-runtime guard | Runtime cleared |
| Custom DC mode with missing DCs | `buildDcTable` falls back to profile defaults | Silent fallback (same as combat) |
| Two prefixes in one message | `detectChallengePrefix` returns first match | Second ignored; not a new risk |

## 14. Verification Plan

### Mandatory — syntax checks

```bash
node -c challenge-profile-explore.js
node -c explore-state.js
node -c challenge-profiles.js
node -c state-compute.js
node -c consistency.js
node -c state-machine.js
node -c state-view.js
node -c ui-panel.js
node -c index.js
```
Every implementation plan step ends by syntax-checking the touched files.

### Manual scenarios (SillyTavern browser run)

1. **Happy path** — `explore: the market` → setup scene with 3-4 options → pick "Skim the stalls" → SUCCESS + CR char → session continues → player departs → LLM closes with `outcome`/`aftermath`.
2. **Transform (rule of cool)** — pick a Highly-unlikely option that rolls under DC → verify LLM introduces a surprising draw-colored entity, not a dead miss.
3. **Custom inline difficulty** — `explore: sneak into the vault DC Highly unlikely` → verify category routing.
4. **Advance exit** — mid-session, hit advance button → verify explore closes same turn.
5. **Combat handoff** — LLM resolves transform as ambush → verify explore closes + combat collision opens same turn.
6. **Combat → explore block** — start combat; try `explore:` → verify rejected with neutral messaging.
7. **Rollback mid-session** — open explore, pick option, `ooc: rollback` to before seed → verify runtime clears cleanly.
8. **Difficulty mode switch** — change Cinematic → Gritty mid-session → verify next clash uses Gritty DCs.
9. **State-view integrity** — with active explore, inspect injected state prompt → verify `Explores:` block appears alongside `Combats:`.
10. **UI panel** — toggle panel open → verify explore section renders target, phase, last resolution.

### Regression checks

11. Start combat after explore fully resolves → verify clean transition.
12. Plain regular turn with no challenge locks → verify no explore-related prompt injections leak in.

## 15. Documentation Deliverable

### `Documentation/Extension/adding_a_challenge_profile.md`

Step-by-step guide for adding a new challenge profile, using combat + explore as the two reference implementations. Covers:

1. **Profile contract** — required fields (`kind`, `inputPrefix`, `entityType`, `deductionType`), required hooks (`getBaseline`, `resolveParticipants`, `buildContextLines`, `validateTurn`, `isResolved`), persistence shape (`seedFields`, `modelFields`, `resolutionFields`), lorebook keys.
2. **Registration** — adding to `PROFILES` in `challenge-profiles.js`.
3. **State layer wiring** — `state-compute.js` (collection, entity-type map, initial states, normalization), `consistency.js` (entity-type map, `VALID_ENTITIES`, `INITIAL_STATES`), `state-machine.js` (states, transitions, machine registry, field registry, exports).
4. **Presentation wiring** — `state-view.js` (formatChallenge branch, active-registry block), `ui-panel.js` (runtime section), `index.js` (button handler, bootstrap registration, deduction template, exemplar targets), `explore-state.js`-equivalent helper file.
5. **Doctrinal guidance** — how to frame outcome branches (don't preload misfortune on TRANSFORM; the draw supplies valence, the mechanic supplies intensity), when to authorize entity creation, how the draw couples to results, tier-defaulting for new chars.
6. **Verification checklist** — syntax checks for modified files, minimum set of manual scenarios (happy path, transform branch, escape mechanisms, cross-profile block).

Guide lives in `Documentation/Extension/` and is linked from `Documentation/README.md` so the session-start protocol surfaces it.

## 16. Out of Scope / Future

- **Shared profile helpers** — wait for a third profile before extracting common pieces. Intimacy is planned next.
- **`collision → explore` activation path** — door left open; no trigger wired.
- **Visual distinguishers in UI panel** — reuse combat CSS in v1.
- **OOC commands for explore** — none planned; existing generic OOC commands work.
- **Telemetry / metrics** — out of scope.
- **Setup wizard integration** — not needed; explore is runtime-invoked.

## 17. Implementation Sequencing (high-level)

The implementation plan (written next via `writing-plans` skill) will sequence the edits in a safe order — roughly: state-layer first (so the entity type exists before anything references it), then the profile file, then registration, then presentation, then button wiring, then documentation. Each step syntax-checks its touched files before the next step begins.
