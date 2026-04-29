# Collision Surfacing Protocol

Date: 2026-04-30
Status: Selected direction (beyond-parity design)
Related: `2026-04-28-st-marinara-parity-gaps.md` §6 (replaces the arrival-gate design sketched there); `2026-04-26-gravity-marinara-embedded-design.md` (architectural baseline)

> **Context.** The parity tracker enumerates `engineTick` → `newArrivalIds` → inject-agent arrival sanity-check as a hijack mechanism, mirroring ST's `_arrival` slot. Once we started designing how collisions should *actually* hijack a story (not just "fire when distance hits 0"), it became clear that single-turn arrival forcing is too brittle: it forces a reckoning on a turn that may not be scene-appropriate, and it gives the player no room to engage the collision organically across multiple beats. This spec replaces the arrival-gate design with a **surfacing protocol** that splits collision lifecycle work between regular turns (scene-level extraction and pressure ripening) and advance turns (strategic conclude / surface). It is explicitly beyond ST parity — ST has the building blocks (pressures, distance, arrival) but not the four-phase rhythm.

## 1. Mental model

**Regular turns are the player's heartbeat. Advance turns are the engine's heartbeat.**

```
… regular regular regular regular  ADVANCE  regular regular  ADVANCE  regular …
   └────── stretch N ──────┘                └─ stretch N+1 ─┘
```

- **Regular turns:** prose happens at scene level. The director extracts state changes, ripens pressure points into collisions, and flags background collisions that prose accidentally engaged. Engine state changes are *bookkeeping*, not strategic.
- **Advance turns:** the engine catches up. Surfaced collisions from the prior stretch are concluded (resolved / evolved / voided). Distances tick. Foreshadow updates. A new set of collisions is *surfaced* for the next stretch — i.e., flagged as "these threads should weave through the next stretch's regular turns."

Surfacing is the hijack mechanism. The player still writes the scenes; the engine names which threads must show up across the stretch.

A player who never advances gets pure character-work mode. The engine respects that — no auto-progression, no degradation, no surfacing. This is the explicit opt-out; no priority toggles or hijack-disable flags are needed.

## 2. Architecture: two director jobs, one director agent

The existing `gravity-ledger-director` agent runs post-processing on every turn. Today its work is mode-neutral. Under this protocol the director's responsibilities split by mode:

| Mode | Director job | Engine job |
|---|---|---|
| `regular` | Extract state from prose; ripen pressures; flag background touches | None (engine doesn't tick) |
| `advance` | Conclude prior stretch; pick what to surface next; (still extracts from any prose this turn) | Tick distances; detect convergence; anti-stall; foreshadow band-transition |

The split is enforced by the director's *system prompt template*, not by separate agents. The `mode` column on `gravity_chat_state` already drives which prompt is used (existing wiring); we add a second prompt template branch for advance mode.

Inject-agent renders different things on regular vs advance turns too — see §6.

## 3. Phase machine: the advance turn

Every advance turn runs four phases in order. The first three happen inside the director (it's all one LLM call but the prompt structures the work as ordered tasks); the fourth happens deterministically in the engine after the director returns.

### Phase 1 — Conclusion

**Input:** `gravity_chat_state.surfaced_collision_ids` (set by the previous advance), `gravity_chat_state.touched_collision_ids` (accumulated by regular-turn directors since last advance), and the regular-turn prose history of the stretch.

**Director task:**
1. For each collision in `surfaced_collision_ids`: did the stretch's prose land it? Emit one of:
   - `S collision:X status=RESOLVED + S outcome_type=DIRECT|EVOLVED|DISSOLVED + S aftermath="..."`
   - `S collision:X status=CRASHED + S outcome_type=IMPLODED + S aftermath="..."` (it should have landed and didn't)
   - Keep surfaced for one more stretch (no transaction; persists)
   - Demote to background (`S collision:X surfaced=false`)
2. For each collision in `touched_collision_ids` (background that prose accidentally engaged): evaluate whether the touch was material. If material: promote to surface for the next stretch by including in Phase 3's surface list. If trivial: clear the flag, leave background.

### Phase 2 — Tick (deterministic, post-LLM)

Existing `engineTick` runs after the director's transactions are validated and staged. Adds:
- **Foreshadow band-transition detection.** Compare each collision's pre-tick distance band (IMMEDIATE / SHORT / MEDIUM / LONG) to its post-tick band. Emit a `foreshadow_event` for each collision that crossed *into* SHORT or MEDIUM. The state-view renderer consumes this; see §6.
- **Anti-stall check.** For each collision at IMMEDIATE for ≥3 advance turns without status change: emit a `stall_warning` slot in the next director's input. The director on the *next* advance must resolve the stall (escalate / demote / merge) or explicitly justify continued idle.
- **Convergence detection.** Pairwise scan of ACTIVE collisions for shared `involved_chars`, shared `location`, or significant `forces` token overlap. When a pair scores above threshold, emit a `convergence_signal` slot for the next director's Phase 3 input.

The scale reset and existing distance reduction stay as they are.

### Phase 3 — Surface (director task)

**Input:** all ACTIVE collisions at IMMEDIATE/SHORT distance (the candidate set), plus any promoted from Phase 1 background-touch evaluation, plus any `convergence_signal` from Phase 2.

**Director task:** pick up to **3** collisions to surface for the next stretch. Selection criteria (in director's prompt):
1. Logical to surface given current scene/cast/location (the director judges).
2. Convergence-flagged collisions are preferred — converging pressures want to land together.
3. IMMEDIATE distance preferred over SHORT, all else equal.
4. Newly-promoted background-touched collisions surface if the touch was material (Phase 1 carries this).

Output: a list of collision ids written to `gravity_chat_state.surfaced_collision_ids`. The director may also emit `S collision:X surfaced=true` transactions for traceability (the field on the entity is informational; the canonical store is the `gravity_chat_state` array).

If the director has no logical surfacing for this advance, the array can be empty. Empty surface is fine — the next stretch is pure character work.

### Phase 4 — State-view foreshadow update (deterministic)

Engine consumes Phase 2's `foreshadow_event`s and Phase 3's surfaced ids, updates `gravity_chat_state.foreshadow_status` (a JSON map of collision id → `{ band, last_fired_advance }`). The state-view renderer reads this on every subsequent inject (regular and advance) until the next foreshadow event for that collision.

## 4. Regular-turn director extensions

The regular-turn director picks up two new responsibilities on top of existing extraction work.

### 4.1 Pressure ripening

For each existing pressure point, the director judges whether this turn's prose has *significantly* added to it (not merely referenced it).

**Ready signals (any one suffices when combined with director judgment):**
- Pressure has been referenced in prose ≥3 times across the last N regular turns
- Intensity has escalated by ≥2 tiers (where pressures track intensity ordinally)
- Involved-chars count grew significantly
- Prose explicitly enacted the pressure ("the rumor became fact when …")

**Conversion rules:**
- **CR a new collision** from the pressure when no existing ACTIVE collision has resonant `forces`. The pressure is consumed (`D pressure:X`). New collision links via `predecessor_pressure_id: X` for traceability. New collision starts un-surfaced (background).
- **Merge into an existing collision** when an ACTIVE collision's `forces` semantically overlap the pressure. Pressure is consumed; collision gains `evolved_from_pressure_ids` (array append) and may receive a distance/intensity bump.
- **Edge case — prose enacts the collision in the scene itself.** If the regular-turn prose doesn't merely escalate the pressure but *enacts* the collision (the brewing tension explicitly erupts in this scene), the director CRs the collision *and* emits `S collision:X surfaced=true`. The next advance's Phase 1 then concludes it like any other surfaced collision. This handles the "the scene WAS the collision" case where surfacing-then-conclusion would feel artificial.

### 4.2 Background-touch flagging

For each ACTIVE non-surfaced collision, the director scans the turn's prose for involvement: did the prose mention this collision's involved chars, walk through its location, or invoke its forces? If yes, append the collision id to `gravity_chat_state.touched_collision_ids`.

This is a JSON array. It accumulates across regular turns and is *consumed and cleared* by Phase 1 of the next advance turn. Phase 1 reads the flagged list and decides per-collision whether the touch was material.

### 4.3 Pressure cap

`gravity_chat_state` enforces a hard cap of **20 pressure points**. At the end of every director run (regular *and* advance), if the pressure pool exceeds 20, the engine emits `D pressure:X` transactions for the oldest excess until 20 remain. This is engine work, not director judgment — the director shouldn't be asked to triage pressure cleanup; ripening is the proper drain mechanism, and the cap is a safety valve.

ST's cap is 5 (cited in the parity tracker §1). The bump to 20 is intentional: under this protocol, pressures are the primary feedstock for collision creation, so the engine needs more headroom for accumulation before ripening fires. 5 was tuned for ST's monolithic prompt budget; Marinara's split pipeline has more room.

### 4.4 What regular-turn director does NOT do

- It does **not** change collision distance (that's `engineTick`).
- It does **not** set `surfaced=true` on collisions other than the prose-enacts-collision edge case in §4.1.
- It does **not** conclude collisions (no `RESOLVED / EVOLVED / DISSOLVED / IMPLODED` status changes from regular turns). Only Phase 1 of advance can conclude.
- It does **not** read `surfaced_collision_ids` for any decision-making — that's read-only context for the inject agent rendering the next prose turn, not a director input.

The reason for the strict no-conclude rule is reproducibility: surfacing is a stretch-level commitment, and letting regular-turn directors close collisions mid-stretch would defeat the surfacing-then-conclusion rhythm. The one carve-out (§4.1 prose-enacts-collision) is structurally a *creation* event with surfaced=true at birth, not a conclusion.

## 5. Schema changes

### 5.1 `gravity_chat_state` additions

```ts
// packages/server/src/db/schema/gravity-chat-state.ts
export const gravityChatState = sqliteTable("gravity_chat_state", {
  // … existing columns …
  surfacedCollisionIds: text("surfaced_collision_ids").notNull().default("[]"),    // JSON: string[]
  touchedCollisionIds: text("touched_collision_ids").notNull().default("[]"),     // JSON: string[]
  foreshadowStatus: text("foreshadow_status").notNull().default("{}"),            // JSON: Record<id, {band, lastFiredAdvance}>
  lastSurfaceAdvance: integer("last_surface_advance"),                            // turn_seq of the advance that wrote surfaced_collision_ids; null pre-protocol
});
```

All four are NOT NULL with safe defaults so existing rows stay valid after migration. `lastSurfaceAdvance` is nullable to mark "no surfacing has happened yet for this chat" distinct from "the surface array is empty by choice."

### 5.2 Collision entity additions (state, not schema — entity is JSON-shaped)

Director may emit these fields on collision entities; engine reads them; state-view renders them.

| Field | Type | Set by | Purpose |
|---|---|---|---|
| `surfaced` | boolean | Director (Phase 3 / §4.1 edge case) | Mirrors gravity_chat_state.surfacedCollisionIds for entity-level traceability |
| `predecessor_pressure_id` | string | Director (§4.1 ripening) | Audit trail for pressure → collision conversion |
| `evolved_from_pressure_ids` | string[] | Director (§4.1 merging) | Audit trail for pressure → existing-collision merge |
| `last_foreshadow_band` | string | Engine (Phase 2) | Prevents foreshadow re-fire while collision sits at the same band |
| `idle_advance_count` | integer | Engine (Phase 2) | Counter for anti-stall (resets on status change) |

The canonical surfacing store is `gravity_chat_state.surfacedCollisionIds`. Entity-level `surfaced` is informational; it lets state-view filter without loading chat-state separately, and gives transaction history a record of when surfacing flipped.

### 5.3 Pressure entity additions (state)

| Field | Type | Set by | Purpose |
|---|---|---|---|
| `reference_count` | integer | Director (regular) | Increments when prose references; one ready signal |
| `created_advance` | integer | Engine (creation time) | Used by Phase 4.3 cap eviction to identify "oldest" |

## 6. Inject agent changes

`inject-agent.ts` today renders `cache.stateView + "\n\n" + buildNudge(mode, state)`. Under this protocol it renders a slotted block:

```
{stateView}

{currentlySurfacedBlock}        // omitted if surfaced_collision_ids is empty

{foreshadowStatusBlock}         // omitted if foreshadow_status is empty

{nudgeForMode}                  // existing buildNudge output
```

### 6.1 `currentlySurfacedBlock`

Reads `gravity_chat_state.surfacedCollisionIds`, looks up the collisions in the state, renders:

```
[CURRENTLY SURFACED — these threads must weave through the next stretch:
  • {collision.name}: {forces} (distance: {distance_category})
  • {collision.name}: {forces} (distance: {distance_category})
]
```

Rendered on every turn (regular and advance) for the entire stretch until the next advance changes the surface set. The prose model treats this as binding: at least one surfaced collision must visibly tighten or progress in the scene; ignoring all of them in a regular turn is a warning condition.

### 6.2 `foreshadowStatusBlock`

Reads `gravity_chat_state.foreshadowStatus`, renders persistent ambient pressure cues for non-surfaced approaching collisions:

```
[FORESHADOW — building pressure (not yet surfaced):
  • {collision.name} approaches ({band}) — {one-line cue derived from collision.forces}
]
```

The cue is rendered as a status indicator (atmospheric), not a directive. The prose model is free to weave it in or not. This preserves ST's creeping-dread texture without spamming fresh nudges every regular turn.

### 6.3 `state-view.ts` filter changes

`formatStateView` is updated to:
- Filter out `surfaced=false` collisions from the active block (they're shown in foreshadow if applicable, omitted otherwise).
- Filter out `RESOLVED`, `CRASHED` collisions entirely (this is the parity-tracker #6d filter; this spec ships it as part of the surfacing rollout since both touch the same render path).
- Surfaced collisions get a small visual marker (`★` or similar) in the active block so the prose-model context is unambiguous.

## 7. Director prompt template changes

Two changes to `gravity-ledger-director`'s template, gated on `mode`.

### 7.1 Regular-mode additions

Append to the regular template:

```
## Pressure ripening (this turn)
For each pressure in state, judge whether THIS TURN's prose has significantly
advanced it. If a pressure shows ready signals (referenced ≥3 times across recent
turns, intensity escalated ≥2 tiers, involved_chars grew, OR prose explicitly
enacted it):
  - If an ACTIVE collision's forces resonate: MERGE
    (D pressure:X + S collision:Y evolved_from_pressure_ids append=X +
     optionally S collision:Y distance=… or intensity=…)
  - Else: CONVERT
    (D pressure:X + CR collision:<new-id> name="…" forces="…"
     distance_category=SHORT|MEDIUM predecessor_pressure_id=X surfaced=false)
  - Edge case: if THIS TURN's prose ENACTS the collision (not just escalates
    pressure), set surfaced=true on the new collision.
Do not ripen more than one pressure per turn unless prose explicitly justifies it.

## Background-touch flagging
For each ACTIVE non-surfaced collision in state, judge whether this turn's prose
referenced its involved_chars, location, or forces. If yes, the engine will
record the touch — emit nothing for this; just note it in your reasoning.
(The system extracts touched ids from your reasoning notes structurally; do not
fabricate a transaction.)
```

The "do not ripen more than one pressure per turn" rule prevents director over-eagerness.

### 7.2 Advance-mode prompt (new template)

A separate template body for `mode=advance`, structured around the four phases:

```
## Phase 1 — Conclusion
The previous advance surfaced these collisions: {surfaced_collision_ids}
The stretch's regular-turn prose is shown above (recent_tail).

For each surfaced collision, decide:
  (a) Resolved by prose — emit S status=RESOLVED + outcome_type + aftermath
  (b) Evolved into another collision — emit S outcome_type=EVOLVED +
      successor_collision_ids + S status=RESOLVED
  (c) Dissolved (became irrelevant) — emit S outcome_type=DISSOLVED + status=RESOLVED
  (d) Should have landed but didn't — emit IMPLODE pattern
  (e) Keep surfaced for another stretch — no transaction; persists by default
  (f) Demote to background — S surfaced=false

These collisions were touched by background prose this stretch:
  {touched_collision_ids}
For each, evaluate materiality. Promote to surface (Phase 3) if material; else
clear via S touched=false (the engine will move them out of the touched array).

## Phase 2 — (engine, no director input needed)

## Phase 3 — Surface
Candidates (ACTIVE at IMMEDIATE/SHORT, plus Phase 1 promotions, plus any
convergence_signal from this advance):
  {candidate_list}

Pick up to 3 to surface for the NEXT stretch. Selection rules:
  - Logical to surface given current scene/cast/location
  - Convergence-flagged pairs preferred (they want to land together)
  - IMMEDIATE preferred over SHORT, all else equal

Emit S collision:X surfaced=true for each chosen. The engine will write the
canonical surfaced_collision_ids array from the entity flags.

If none are logical to surface, emit nothing here — empty surfacing is fine.
```

The advance-mode template *also* includes the regular-mode body (extraction, ripening, touch-flagging) as a prelude, since advance turns can have prose too (the player narrates their advance).

## 8. Migration

Schema migration adds the four new gravity_chat_state columns with defaults, so existing chats are valid post-migration with empty surfacing state. They behave as if they're all in stretch zero — the next advance turn writes the first `surfaced_collision_ids` and the protocol activates.

No backfill of existing collisions is needed. Pre-protocol collisions remain ACTIVE and un-surfaced until the next advance turn surfaces them through normal Phase 3 selection. Foreshadow status starts empty and populates on the first band transition the engine sees.

The pressure cap bump from 5 to 20 takes effect immediately. Existing chats with >5 pressures (none today, since ST's cap was 5) are unaffected; new chats accumulate up to 20.

## 9. Director model dependency

Phase 1's per-collision conclusion judgment, Phase 3's "logical to surface" selection, and §4.1's pressure-ripening decisions are all generative-and-structured calls — exactly the work Haiku is poor at and Sonnet handles well. **This protocol assumes a Sonnet-tier director.** Running it on Haiku would produce mechanical surfacing (top-N by distance, no scene fit) and timid ripening (under-conversion).

Pairs cleanly with parity gap #5 (setup uses chat connection): the same logic that says "setup needs prose-tier model" applies to advance-turn director under this protocol. Recommend the same connection-resolution change extend to *all* director invocations in `mode=advance`, with `mode=regular` allowed to fall through to the cheaper agent connection. This is a §5 follow-up sub-spec, not a hard dependency for shipping this protocol on Sonnet uniformly.

## 10. Validation

Smoke-test scenario (modeled on the 2026-04-28 setup smoke):

1. Setup chat with 3 seeded collisions (one IMMEDIATE, two SHORT) and 4 seeded pressures.
2. Run 3 regular turns of prose that engages collision A (IMMEDIATE), references collision B (background, SHORT), and adds 2 references to pressure P1.
3. Run an advance turn.
4. **Assertions:**
   - Phase 1: collision A is concluded (RESOLVED / EVOLVED / DISSOLVED based on prose) or IMPLODE. Pressure P1 should be a ripening candidate.
   - Phase 2: collision B's distance should tick down. If it crosses MEDIUM, foreshadow_event fires.
   - Phase 3: surfaced_collision_ids contains 1-3 ids drawn from the candidate set.
   - touched_collision_ids is cleared.
5. Run 1 more regular turn and verify inject renders the new surfaced block, the foreshadow block (for collision B if foreshadow fired), and the prose model engages at least one surfaced collision.

Unit tests under `packages/server/test/`:
- `surfacing-phase1-conclusion.test.ts` — given a stretch of prose mentions, director conclusion classification.
- `surfacing-phase3-selection.test.ts` — given a candidate set and scene context, selection cap and convergence preference.
- `pressure-ripening.test.ts` — ready-signal detection and CR-vs-merge decision.
- `pressure-cap.test.ts` — 20-cap enforcement and oldest-eviction.
- `foreshadow-band-transition.test.ts` — engine emits events on entry to SHORT/MEDIUM, suppresses re-entry within same band.

## 11. Open follow-ons (out of scope here)

- **Per-mode model selection** (Sonnet for advance, Haiku for regular). Spec'd as a §5 follow-up.
- **Per-stretch retrospective.** A "what changed this stretch" summary surfaced to the player on advance turns. Nice-to-have for player-facing UI; not required for the protocol.
- **Surfaced-collision priority weighting.** Currently all surfaced collisions are equal; could add primary/secondary distinction within the surface set if 3-collision stretches feel chaotic in playtesting.
- **Pressure → constraint binding.** Companion mechanism where ripening pressures can also generate or strengthen constraints, not just collisions. Mentioned in earlier design conversations; scoped to a follow-up if the constraint side of the engine of escalation needs more pressure feedstock.
- **Convergence threshold tuning.** Phase 2's convergence detection has a "score above threshold" rule that needs tuning data. Pilot with conservative threshold; relax based on observed false-negative rate (collisions that should have flagged but didn't).

## 12. Relationship to parity tracker §6

This protocol *replaces* the arrival-gate design in `2026-04-28-st-marinara-parity-gaps.md` §6b and the foreshadow design in §6c with the cleaner four-phase machine. It also subsumes §6d (state-view filter for resolved/crashed) since `state-view.ts` is being rewritten anyway under §6.3. Items remaining in parity tracker §6 after this protocol ships:

- §6a (tick never fires) — resolved by mode controls (parity tracker #3); orthogonal to surfacing.
- §6e (combat-collision subtype) — orthogonal; this protocol doesn't define combat differently from other modes. A combat-mode advance turn runs the same four phases.

The parity tracker should be updated to reference this spec when it ships, and #6b/#6c marked as superseded.
