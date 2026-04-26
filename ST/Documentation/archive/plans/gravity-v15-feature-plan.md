# Gravity v15: Advance Engine, Collision Tiering, and Token Efficiency

## Context

Based on a full playtest analysis of Run 1 (Lacus Clyne, 60 messages, 401 transactions, ~38k words of LLM output), we identified three structural problems that limit the Gravity system's effectiveness as an interactive novel-writing tool. The prose quality is strong. The character tracking (doing-cost, reads, constraint integrity) works well. The problems are architectural — the system tracks what *is* with precision but has no mechanism for generating what *could be*.

---

## Problems Identified

### P1: Advance Turns Are Untethered Camera Cuts
**Evidence:** Messages 29-38 in Run 1. Player says "continues what they were doing" five times. Each time the LLM cuts to Kira's internal monologue or Le Creuset's scheming (1,300-2,400 words) without first acknowledging the player's action or returning with a hook. The player becomes a spectator.

**Root cause:** The advance mode injection (`gravity_mode_advance_core`) says "advance forces honestly" and "end on a player-facing hook" but provides no structure for *how*. The LLM chooses whatever interests it — usually the most developed NPC dossier. No beat structure. No mandatory player acknowledgment. No mechanism for the divination draw to select what happens.

### P2: All Collisions Run on the Same Slow Clock
**Evidence:** 8 collisions in Run 1, all using the same SEEDED→SIMMERING→ACTIVE→RESOLVING→RESOLVED lifecycle. Distance counts down from 6-10. A conversation about Lacus's status (should resolve in 3 turns) runs on the same timer as Le Creuset's multi-session political arc. Result: pacing feels uniformly slow. A 3.5-hour in-world gap (16:00→19:40) passes with nothing emergent happening.

**Root cause:** No collision tiering. No mechanism for rapid-fire collisions. Pressure points sit in an array aging until they're consumed by existing collisions or pruned as stale — they never ignite into their own events. Flay Allster was created at setup and never touched across 401 transactions. Crew resentment pressure points were created, absorbed, and replaced without ever generating a scene the player could engage with.

### P3: Token Inefficiency in State Injection
**Evidence:** ~5,200 tokens injected per regular turn. The README (1,600 tokens) repeats identically every turn. The CoT template (1,200 tokens) covers all modes when only one is active. On consecutive turns in the same scene, the full slim state re-serializes even when 90% hasn't changed. 12 characters get registry entries even when only 2-3 are in scene.

**Root cause:** No conditional injection logic. No state delta mode. No scene-scoped filtering. The injection was built for correctness (inject everything, let the LLM sort it out) rather than economy.

---

## Feature List

### F1: Advance Engine — Structured Beat Sequence
**Solves:** P1 (untethered camera cuts)

**Design:** Advance mode becomes a structured 3-5 beat mini-chapter instead of an open-ended "move the world" instruction.

#### F1.1: Beat Structure Template
The advance injection prescribes a fixed beat structure:

```
Beat 1 — PLAYER RESOLUTION: Acknowledge the player's continued action + time passage + concrete result
Beat 2-3 — WORLD MOVEMENT: Collision ticks + flash collision from pressure ignition (F2)
Beat 4-5 — RETURN HOOK: Consequence of beats 2-3 arrives at the player with a new situation
```

- Beat 1 is MANDATORY — the camera must ground the player before cutting away
- Final beat is MANDATORY — must return to the player with something to respond to
- Middle beats are flexible (1-3 depending on what's ripe)

#### F1.2: Divination as Steering Mechanism
The divination draw selects WHICH pressure point ignites during the advance, not just flavor:

- Extension draws divination on advance trigger (already happens)
- Extension scores each pressure point against the draw using a theme table (Tower → conflict/violence/upheaval, Lovers → connection/intimacy, Magician → opportunity/skill, etc.)
- Top-scoring pressure point becomes the flash candidate injected into the advance template
- The draw shapes the *character and method* of how the event arrives

#### F1.3: Advance Injection Rewrite
Replace `gravity_mode_advance_core` lorebook entry with a dynamic injection built by the extension:

```
[GRAVITY ADVANCE — {N} beats]

BEAT 1 — PLAYER: {pc.doing} resolves. Time: {duration}. 
  Write: acknowledge + concrete result (100-200w)

{FLASH/ARC BEATS — computed from F2 collision engine}

FINAL BEAT — RETURN: {hook derived from flash/collision event}
  Write: deliver to player, end on new situation

TARGET: {word budget based on beat count}
```

**Files to modify:**
- `index.js` — advance injection builder (replaces current `_ooc` advance block)
- `Gravity World Info.json` — update `gravity_mode_advance_core` entry
- New: divination theme-matching table (in `index.js` alongside existing divination tables)

---

### F2: Collision Tiering and Pressure Ignition
**Solves:** P2 (same slow clock, no emergent events)

#### F2.1: Three Collision Tiers

| Tier | Starting Distance | Lifespan | Source | Behavior |
|------|-------------------|----------|--------|----------|
| **Flash** | 0-2 | 1-3 turns | Pressure point + divination during advance | Starts ACTIVE. Resolves within the scene or next regular turn. Skips SEEDED/SIMMERING. |
| **Arc** | 4-6 | 5-15 turns | Setup, narrative escalation, or flash collision that didn't resolve | Standard lifecycle. Current default behavior. |
| **Saga** | 8-10 | Chapter-spanning | Core thematic tension | Ticks slowly (every 2-3 advances). Resists easy resolution. Absorbs flash events as complications. |

- Add `tier` field to collision entity (values: `flash`, `arc`, `saga`)
- Default existing collisions to `arc` for backwards compatibility
- Tier determines tick rate during advance: flash moves 1-2 per beat, arc moves 1 per advance, saga moves 0-1 per advance

#### F2.2: Pressure Point Ignition Engine
During advance turns, the extension:

1. Sorts pressure points by age (oldest/stalest first)
2. Draws divination (already implemented)
3. Scores each pressure point against the divination theme
4. Selection logic:
   - Stale (18+ tx age): MANDATORY flash collision at dist 0
   - Aging (8-17 tx): RECOMMENDED flash at dist 1-2
   - Fresh (<8 tx): OPTIONAL — LLM can use or defer
5. Injects the flash collision setup into the advance beat template
6. Removes the consumed pressure point from the array

**Files to modify:**
- `index.js` — new `buildAdvanceBeats()` function, pressure-to-divination scoring
- `state-compute.js` — add `tier` to collision entity schema
- `consistency.js` — accept `tier` field on collision entities
- `state-view.js` — display tier in state view
- `state-machine.js` — document flash lifecycle (ACTIVE→RESOLVING→RESOLVED, skip SEEDED/SIMMERING)

#### F2.3: Collision Merging
When two collisions overlap (same target constraint, overlapping forces, same scene, or causal chain), the advance injection should flag them as merge candidates:

```
MERGE CANDIDATE: "Breaking Point" overlaps "Lacus Leverage" (same target: Lacus's safety)
  → If merged: combined collision absorbs flash, advances arc by 2 distance
```

- Merge evaluation runs during advance beat computation
- Extension detects overlap via shared `target_constraint`, shared character IDs in `forces`, or both collisions manifesting in the same `current_scene`
- Merge is SUGGESTED to the LLM, not forced — the LLM writes the merger dramatically
- Merged collision takes the lower distance of the two and inherits both manifestation histories

#### F2.4: Collision Cascade
Resolving one collision should mechanically affect neighbors:

- When a collision resolves, the extension checks all other active collisions for shared forces or target constraints
- Affected collisions get a distance reduction (1-2) and an injected note: "this collision was accelerated by the resolution of {resolved_collision}"
- This prevents the static-parallel-threads problem — resolving "The Unsaid Name" should move "Lacus Leverage" and "Le Creuset's Card"

**Files to modify:**
- `index.js` — cascade logic after collision resolution
- `state-view.js` — show cascade notes in collision detail

---

### F3: Token Efficiency
**Solves:** P3 (5,200 tokens/turn injection cost)

#### F3.1: Scene-Scoped Character Injection
On regular (slim) turns, only inject full detail for characters relevant to the current scene:

- **In scene** (characters whose `location` matches `pc.current_scene` or who are named in it): full detail — condition, wants, knowledge_asymmetry, doing
- **Elsewhere** (TRACKED/PRINCIPAL not in scene): one-line — name + location only
- **Offscreen** (KNOWN tier, not in any active collision this turn): omitted entirely

Detection: match character `location` against `pc.current_scene` keywords, or check if character ID appears in any active collision with distance ≤ 3.

**Estimated savings:** 400-600 tokens per regular turn

#### F3.2: Collision Relevance Filtering
On regular turns, only inject full narrative capsules for collisions that are:
- Distance ≤ 3 (imminent)
- Have a force member present in the current scene
- Changed status since last turn

Everything else gets a one-line summary: name + status + distance.

**Estimated savings:** 200-400 tokens per regular turn

#### F3.3: State Delta Mode
After the first full state injection in a scene, subsequent turns in the same scene receive only changed fields:

```
═══ GRAVITY STATE DELTA ═══
CHANGED:
  collision:unsaid-name.distance: 4 → 3
  char:lacus-clyne.condition: "composure cracking"
  pc.condition: "tremor window active"
UNCHANGED: scene, all other entities
```

- Track "last injected state" snapshot per chat
- Compare current computed state against snapshot
- Emit delta if scene unchanged; emit full view if scene changed

**Estimated savings:** 800-1,000 tokens on consecutive same-scene turns

#### F3.4: README Graduation
- Turns 1-3: Full README (1,600 tokens)
- Turns 4-10: Compressed cheat sheet (300 tokens) — ops list + common paths only
- Turns 11+: No README injected (re-inject only if correction queue indicates format errors)

Track turn count in extension state.

**Estimated savings:** 1,300-1,600 tokens after turn 10

#### F3.5: Mode-Specific CoT
Split the preset CoT template so only the active mode's deduction fields are injected:
- Regular turn: only regular checklist (~400 tokens instead of ~755)
- Combat turn: only combat checklist
- Advance turn: only advance checklist
- Intimacy turn: only intimacy checklist

This requires the extension to inject the CoT dynamically rather than relying on a static preset entry.

**Estimated savings:** 300-400 tokens per turn

#### Combined Token Budget

| Scenario | Current | After F3 |
|----------|---------|----------|
| Regular turn (new scene) | ~5,200 | ~3,200 |
| Regular turn (same scene, turn 5) | ~5,200 | ~2,400 |
| Regular turn (same scene, turn 12+) | ~5,200 | ~1,500 |
| Advance turn (full mode) | ~7,000+ | ~5,500 |

**Files to modify:**
- `state-view.js` — scene-scoped filtering (F3.1), collision filtering (F3.2), delta mode (F3.3)
- `index.js` — README graduation logic (F3.4), turn counter, delta snapshot tracking
- `gravity_v14.json` — split CoT into per-mode entries or make extension-injected (F3.5)

---

## Implementation Priority

| Priority | Feature | Rationale |
|----------|---------|-----------|
| 1 | F2.1 Collision tiering | Foundation — flash/arc/saga distinction is required before F1 or F2.2 can work |
| 2 | F2.2 Pressure ignition engine | The core mechanic that generates emergent events |
| 3 | F1.1-F1.3 Advance engine | Consumes F2's output — needs tiered collisions and flash events to structure beats |
| 4 | F3.1-F3.2 Scene-scoped injection | Biggest token wins with lowest complexity |
| 5 | F3.3 State delta mode | Requires snapshot tracking infrastructure |
| 6 | F3.4-F3.5 README graduation + CoT split | Straightforward but lower impact |
| 7 | F2.3-F2.4 Merge and cascade | Most complex, can be added after the core loop is working |

---

## Verification

1. **Syntax check** all modified JS files: `node -c <file>`
2. **Replay test:** Load Run 1 chat, verify existing transactions still parse correctly (backwards compatibility with arc-tier default)
3. **Advance test:** Trigger an advance turn and verify:
   - Beat 1 acknowledges player action
   - Divination draw scores against pressure points
   - Flash collision is injected (if pressure point qualifies)
   - Final beat returns to player with hook
4. **Token measurement:** Log injection sizes before/after F3 changes, compare against baseline
5. **Collision tier test:** Create a flash collision manually, verify it starts ACTIVE and skips SEEDED/SIMMERING
6. **Delta test:** Send two consecutive regular turns in the same scene, verify second injection uses delta mode
