# Combat System Design Spec — Handoff Document

This document captures the complete combat system design for Gravity Ledger, agreed upon through iterative design discussion. It is intended as a handoff to Claude Code / Codex for implementation on the `combat` branch.

## Status Update - 2026-04-02

This handoff predates the repository's power-doctrine refactor. The overall combat-loop vision below is still the target, but the following points now supersede older assumptions in this document:

- Combat baseline is computed from current effective `power`, not the narrative character `tier` ladder. `tier` remains `UNKNOWN/KNOWN/TRACKED/PRINCIPAL` and is not a combat stat.
- Setup no longer authors `world.constants.combat_rules`. It now authors `world.constants.power_scale`, `world.constants.power_ceiling`, optional `world.constants.power_notes`, plus `power_base`, `power`, `power_basis`, and `abilities` on the PC and important combatants.
- `power` is dynamic. `power_base` is the healthy earned rating. Severe impairment can lower `power`; lasting growth or decline can change `power_base`.
- `OOC: power review pc|char:id|all` is the supported re-judgment path when the story earns a power change.
- As of 2026-04-02, the repo has implemented the setup, prompt, UI, and OOC portions of this doctrine, but not yet the full `combat` entity runtime, `_combat` slot, difficulty-toggle settings, or `combat-state.js`.

Use [combat-power-doctrine.md](./combat-power-doctrine.md) as the field contract for the power model referenced throughout this handoff.

---

## Philosophy

Combat is not a fight simulator with narrative chrome. It is a **relationship accelerator that uses physical danger as the catalyst.** Fights exist in the story because danger forces people to show who they really are. Injury is not punishment — it is a narrative device that advances relationships, reveals character, and shifts dynamics.

The LLM's role during combat is **action movie director** — not a judge, not a physics engine, not a rules arbiter. A good action director asks: what makes this scene land? What makes the audience care? The director knows that the audience needs to see the hero bleed — not for punishment, but because it makes the victory (or the sacrifice, or the betrayal) mean something.

Every injury, setback, or complication should exist to **advance a relationship, reveal a character, or shift a dynamic.** An ally takes a bullet for the PC. The PC blocks a hit meant for a love interest. A wound forces a faction member to choose sides. The deduction question is never "how much damage" but "who moves because of this."

---

## Core Loop

### 1. Spawn (Divination)

The extension casts a hexagram (or draws from whichever divination system the player has configured) at the start of combat. The hexagram determines the situation - enemies, terrain, timing, and tone. The LLM spawns the encounter to match the hexagram's nature.

- Grim hexagram (Obstruction, The Abysmal, Splitting Apart) — grim situation. More enemies, worse terrain, bad timing.
- Favorable hexagram (Peace, The Creative) — favorable situation. The player has the advantage, fewer or weaker enemies.
- The spawn draw is not the combat math anchor. Baseline difficulty comes from current `power` versus the opposition; the draw colors the setup and tone.

The spawn hexagram sets the stage. After this, the oracle steps back - per-exchange randomness comes from the d20 and divination draw.

### 2. Scene Description

The LLM describes the tactical situation as a director would - what the environment looks like, where the enemies are, what they're doing RIGHT NOW. The opposition is always in motion, always competent within their established `power`, `power_basis`, and `abilities`. The director never shows enemies standing still waiting for the hero.

Wounds, abilities, and state of ALL characters in the scene (PC, allies, enemies) are shown in the injection. The LLM uses everyone's state as narrative opportunity — an ally reacts to the PC's injuries, an enemy exploits a weakness, a wounded grunt becomes desperate.

### 3. Player Intent — Two Situations

#### Situation 1: Choose from Options (Default Flow)

The LLM presents 3-4 concrete options based on the character's traits, the situation, and the opposition. Each option includes an assessed difficulty category. The player picks one.

Flow:
1. LLM writes prose + presents 3-4 options with difficulty categories
2. Player picks an option (types "option 2" or describes their choice)
3. Extension rolls d20 + divination draw, maps category to DC, injects everything
4. LLM resolves with prose + ledger updates

Two turns, two single LLM calls. The assessment happens in turn 1, the roll happens between turns, resolution in turn 2. Fits the existing single-call architecture.

#### Situation 2: Declare Custom Action

The player states their own intent and self-assesses the difficulty. The extension provides a power baseline as a fairness check.

Flow:
1. Player declares action + self-assessed difficulty category
2. Extension rolls d20 + divination draw, injects alongside the power baseline
3. LLM compares player's assessment against baseline:
   - **Within 1 step of baseline** — accept and resolve in one call
   - **2+ steps more generous than baseline** — challenge and ask player to reconsider. The same roll stands (player already committed). Resolved next turn after player revises.
   - **Harsher than baseline** — always accept (player is choosing to make it harder on themselves)

The power baseline is the anchor that prevents gaming. The LLM has structural permission to push back because the math supports it.

The player can always declare their own intent. They are never boxed into LLM-generated options.

### 4. Difficulty Assessment

The LLM (in Situation 1) or the player (in Situation 2) assigns ONE qualitative category: **how likely is this action given who's doing it, what's happening, and the current state?**

Five categories:

| Category | Meaning | Roll? |
|---|---|---|
| **Absolute** | This is the character's established capability. No uncertainty. It just happens. | No — auto-success |
| **Highly likely** | Should probably work. Minor tension. The character's strengths apply clearly. | Yes |
| **Average** | Genuinely contested. Could go either way. Balanced forces. | Yes |
| **Highly unlikely** | The odds are against you. Requires things to line up. The big swing. | Yes |
| **Impossible** | The director wouldn't put this in the script. Breaks internal logic. | No — auto-fail |

**Absolute and Impossible skip the roll entirely.** Absolute just happens — the LLM narrates the success. Impossible doesn't happen — the LLM explains why and the situation continues. Only the three middle categories trigger dice.

For Situation 2 (player self-assessment): the extension only skips the roll when both the player's assessment AND the power baseline agree on Absolute or Impossible. If they disagree, the extension rolls against the baseline DC and the LLM negotiates.

#### Difficulty Toggle

The player sets a difficulty mode in the extension settings. This does two things:

1. **Sets the DC table** — maps categories to numbers
2. **Injects a framing prompt** — tells the LLM how to think about difficulty in this mode

| Mode | Framing | Highly Likely | Average | Highly Unlikely |
|---|---|---|---|---|
| **Cinematic** | Action blockbuster. Grunts are scenery. Named opponents are real fights. | DC 3 | DC 7 | DC 12 |
| **Gritty** | Realistic thriller. Everyone is dangerous. Fights are fast and costly. | DC 8 | DC 12 | DC 16 |
| **Heroic** | Wuxia epic. Ordinary soldiers are beneath you. Only rivals matter. | DC 2 | DC 5 | DC 10 |
| **Survival** | Horror. The opposition is overwhelming. Running is usually correct. | DC 10 | DC 14 | DC 18 |

DC values are configurable by the player. These are defaults. The mode framing prompt is injected via `setExtensionPrompt()` alongside the combat state.

#### Power Baseline (Fairness Anchor)

The extension computes a baseline difficulty from current effective `power`, not from the narrative character `tier` ladder:

- Power difference +2 or more - baseline: absolute
- Power +1 - baseline: highly likely
- Equal power - baseline: average
- Power -1 - baseline: highly unlikely
- Power -2 or more - baseline: impossible

`power_base` is the healthy earned combat level. `power` is the current effective combat level. Baseline math uses `power`, not `power_base`.

This baseline is always injected into the combat context. In Situation 1, the LLM uses it to calibrate its option assessments (should stay within 1 step of baseline). In Situation 2, the LLM uses it to validate the player's self-assessment.

### 5. The Roll

The **extension** rolls — the player never touches dice. When the player picks an option (Situation 1) or declares an action with difficulty (Situation 2), the extension immediately generates:

- **d20** — compared against the DC
- **Divination draw** — from whichever system the player configured (Tarot / I-Ching / Classic)

Both are injected before the LLM writes resolution prose.

#### Resolution

| d20 Result | What Happens | Draw Interpretation |
|---|---|---|
| **Meets or beats DC** | Success. The player's intent plays out. | Draw colors HOW the success happens — the style, the flair, the collateral. |
| **Below DC** | The situation transforms. The player's action happened but reality had its own opinion. | Draw determines the nature of the transformation. |
| **Natural 20** | Critical success. Success that exceeds the player's intent. Something extra happens. | Draw amplifies — what bonus occurs, what unexpected advantage opens. |
| **Natural 1** | Critical transform. The situation transforms dramatically against the player. | Draw determines the catastrophic development. |

**The draw is always interpreted.** There are no unused draws. On clean success, the draw shapes the texture of the victory. On failure or crits, the draw drives the transformation.

#### Draw Tonal Mismatch

When the draw's tone contradicts the roll outcome, **interpret the draw from the opposition's perspective or as ironic contrast:**

- The Sun (joy, vitality) on a nat 1 — the enemy finds their moment of triumph
- The Tower (catastrophe) on a nat 20 — the enemy's position collapses
- Peace on a critical transform — a false calm before something worse
- The Abysmal on a critical success — the PC drags the enemy down into the abyss

One paragraph in the combat deduction template covers this. The rule: the draw describes the FULL scene — what everyone did, not just the player.

### 6. State Update

After the prose, the LLM writes ledger commands reflecting what happened. Wounds, position changes, resource expenditure, relationship shifts — all recorded via standard ledger operations.

Per-character combat state (stances, wounds, momentum, abilities) lives on the **combat entity** via map operations:

```
MS combat.sublevel4 "autumn_stance" "aggressive"
MS combat.sublevel4 "autumn_wounds" "lance burn across ribs — breathing impaired"
MS combat.sublevel4 "turk_captain_stance" "defensive"
MS combat.sublevel4 "turk_squad_remaining" "3"
```

Persistent narrative consequences (relationship shifts, demonstrated traits) are written to char/PC entities directly:

```
A pc.timeline "Took a hit protecting the child in Sublevel 4"
A char.tifa noticed_details "saw Autumn shield the child with her own body"
```

### 7. Next Exchange or Resolution

The director describes the new situation and presents new options. The loop repeats.

**The player controls pacing.** They can declare "I end this" at any time. The LLM assesses the category — if the opposition is weakened and the situation supports it, "I finish this" is highly likely or absolute. If the opposition is still strong, it's average or unlikely. The extension rolls.

The player can also declare "I disengage" or "I escape" at any time. Same assessment, same roll.

**There is no mechanical exit condition.** No stress boxes, no exchange counters, no terminal hexagrams. The fight ends when the player decides to end it and the dice agree.

---

## Wounds and Abilities

Wounds and abilities are **narrative context, not flat modifiers.** They do not directly modify DC calculations, but they do shape category judgment and can justify a real change to current `power` when impairment or growth materially changes a combatant's ceiling.

The combat injection shows wounds and abilities for **everyone in the scene** — PC, allies, and enemies. The LLM uses all of it to:

- Shape which options are offered ("your burned ribs make climbing risky")
- Drive NPC reactions (ally steps in front of wounded PC, enemy targets the weak side)
- Create narrative opportunity (wounded grunt becomes desperate, ally runs out of ammo)

The prompt instructs the LLM explicitly: wounds and abilities should **shape the options offered and how outcomes are described**, not just be mentioned in passing.

Important guardrail:

- Minor wounds should usually affect narration, options, and risk framing without automatically lowering `power`.
- Severe impairment can lower `power`.
- Lasting growth, training, major gear upgrades, or permanent decline can change `power_base` and usually `power`.

---

## Enemy Representation

The **LLM decides** how to represent enemies based on the encounter's power dynamics:

- **Grunts well below PC power** - compressed group entity: `MS combat.sublevel4 "turk_squad" "4 remaining, power 2, aggressive"`. One line, not worth individual tracking.
- **Same-band opponents** - individual entries with wounds, stance, tactics.
- **Above-band boss** - detailed individual with `power_base`, `power`, `power_basis`, abilities, wounds, and tactical approach.

This is self-regulating: a fight against 20 grunts is one map entry. A duel against a rival is a full dossier. The director decides what deserves a close-up.

### Post-Combat Cleanup

When combat resolves:

1. **Persistent consequences** are written to char/PC entities first (timeline, relationship changes, demonstrated traits, lasting wounds if narratively significant)
2. **Combat entity is destroyed** (`D combat.sublevel4`) — all per-exchange state (stances, per-enemy wounds, momentum) goes with it
3. **Enemy char entities created during combat** are destroyed — they don't persist in state

The PC's timeline accumulates combat history: "Defeated 3 Turk soldiers and their captain in Sublevel 4." Over many sessions, this builds into a character legend — "has cut through a hundred men" becomes reputation that changes how NPCs react, how allies defer, how enemies hesitate. The memory tiering system naturally consolidates old timeline entries into batch summaries, so this grows into legend rather than bloating state.

---

## Combat Entity Type

Combat is its own entity type — **not a collision**. Collisions are narrative pressure events with their own lifecycle (SEEDED - SIMMERING - ACTIVE - RESOLVING - RESOLVED) and oracle-driven resolution. Combat is a scene-level mechanical loop with rolls and exchanges. Mixing them causes confusion, especially when collision slots are already full.

A collision can *trigger* a combat, but they are tracked as separate entities. The collision continues its own lifecycle while the combat runs. When combat resolves, the LLM can update both entities in the same ledger block.

### Combat Entity Fields

```
CR combat.sublevel4 status=ACTIVE terrain="corridor" spawn_hex="Hexagram 29 — The Abysmal"
MS combat.sublevel4 "enemies" "turk_squad(4,power2), turk_captain(1,power3)"
MS combat.sublevel4 "autumn_stance" "aggressive"
MS combat.sublevel4 "autumn_wounds" "lance burn across ribs"
MS combat.sublevel4 "turk_captain_stance" "defensive"
S combat.sublevel4 status RESOLVED
S combat.sublevel4 outcome "victory — captain disarmed, squad routed"
D combat.sublevel4
```

Lifecycle: `ACTIVE -> RESOLVED` (then destroyed). No intermediate states needed.

Valid in `consistency.js`: add `combat` to `VALID_ENTITIES`.

---

## Combat Entry — Three Paths

### 1. Player-Initiated

The player hits the **Combat mode button** in the extension UI. The extension:
- Draws the spawn hexagram
- Creates the combat entity
- Enters combat mode
- Injects the `_combat` slot

### 2. Collision-Spawned

A collision escalates to violence organically. The LLM writes `CR combat.X ...` in a ledger block during collision resolution. The extension detects the new combat entity and:
- Draws the spawn hexagram (or uses the collision's existing oracle draw)
- Enters combat mode
- Injects the `_combat` slot

### 3. Advance-Spawned

During a world advance turn, divination suggests danger. The LLM spawns a combat encounter and writes `CR combat.X ...` in the ledger. Same detection and activation as collision-spawned.

All three paths converge to the same state: combat mode active, spawn hexagram drawn, `_combat` injection slot firing.

---

## Injection Architecture

### New Injection Slot: `_combat`

When combat mode is active, the extension injects the combat context via `setExtensionPrompt()` at depth 0, slot `_combat`.

Contents:

```
[COMBAT — Exchange {n}]
Mode: {difficulty_toggle} — {framing_summary}
Spawn: {hexagram_name} ({hexagram_number}) — {hexagram_meaning}

SITUATION:
{Full situation carry-forward — all exchanges in this combat. Compressed only after combat ends.}

PC STATE:
  Capabilities: {from char card / dossier}
  Wounds: {from combat entity map}
  Abilities: {relevant traits and skills}

ALLIES IN SCENE:
  {ally_1}: {wounds, stance, abilities — narrative opportunity for the director}

OPPOSITION:
  {enemy_1 or group}: power {n}, {current state from combat entity map}
  ...

POWER DIFFERENTIAL: {computed, e.g. "+2 PC advantage vs captain, +3 vs grunts"}
BASELINE CATEGORY: {computed from power differential against primary opponent}

PLAYER INTENT: {what the player chose or declared}
PLAYER ASSESSED DIFFICULTY: {category — Situation 2 only}

ROLLS THIS EXCHANGE:
  d20: {result}
  Draw: {card/hexagram name} — {brief traditional meaning}
  DC: {number, from difficulty toggle table}
Resolution: {SUCCESS / TRANSFORM / CRITICAL SUCCESS / CRITICAL TRANSFORM}

DIRECTOR FRAMING:
{Difficulty mode framing prompt — cinematic/gritty/heroic/survival}

Remember: You are directing a scene. The draw describes the full scene — what everyone
did, not just the player. If the draw contradicts the roll outcome, interpret it from
the opposition's perspective or as ironic contrast. Wounds and abilities are narrative
opportunity — shape your options and descriptions around them. The opposition is always
competent and always in motion.
```

**Context budget:** No mid-combat compression. The full situation accumulates during the fight. When combat resolves, the entire combat is compressed to: PC timeline entry + persistent wounds + relationship changes. Typical combat encounters are short enough that accumulation is not a problem.

### Modified Injection Slot: `_nudge`

The existing `_nudge` slot already handles mode flags. When combat is active, it sets the mode to `combat` so the preset selects the combat deduction protocol in `<think>`.

### Combat Deduction Protocol (Preset / World Info)

Inside `<think>`, the LLM runs the combat deduction. Fields:

1. **Scene** — what does the space look like, where is everyone, what has changed
2. **Opposition** — what is each enemy doing RIGHT NOW, independently. Use their wounds and state.
3. **Player intent** — what is the player trying to do
4. **Assessment** — (Situation 1) which category fits, reasoning, compare against power baseline. Stay within 1 step of baseline unless a clear hard counter exists. (Situation 2) compare player's self-assessment against baseline, accept or challenge.
5. **Roll interpretation** — d20 result vs DC. Read the draw as describing the FULL scene. If draw tone contradicts roll, interpret from opposition's perspective or as ironic contrast.
6. **Dramatic value** — who in this scene cares about what just happened? Which relationships advance? Where's the rule of cool? How do wounds and abilities create narrative opportunity for everyone present?
7. **Plan** — what happens in the prose, beat by beat, one exchange only
8. **Ledger updates** — what state changes on the combat entity and char entities

---

## Extension Implementation

### New Module: `combat-state.js`

Manages the combat lifecycle. Responsibilities:

- **Enter combat** — triggered by Combat mode button OR detection of `CR combat.X` in ledger. Draws the spawn hexagram. Sets mode to combat.
- **Per-exchange rolls** — generates d20 + divination draw. Looks up DC from difficulty toggle table. Computes resolution type (success/transform/crit success/crit failure). For Absolute/Impossible: skips the roll.
- **Power differential** — computes from current effective `power` in current state. Derives baseline category.
- **Assessment validation (Situation 2)** — compares player's self-assessed difficulty against power baseline. If 2+ steps more generous, flags for LLM challenge.
- **Build `_combat` injection** — assembles the full injection string from current state, rolls, and framing.
- **Exit combat** — triggered when the LLM's ledger commands set `combat.X status RESOLVED`. Clears combat mode. Returns to regular/advance mode.

### Difficulty Toggle: Settings UI

Add to `ui-panel.js` or extension settings:

- Dropdown: Cinematic / Gritty / Heroic / Survival / Custom
- Custom: editable DC values for each category
- The toggle stores in extension settings, persists per chat

### Framing Prompts

Store in the extension or in `Gravity World Info.json` as keyword-triggered entries. Each difficulty mode has a framing prompt that injects when combat is active in that mode.

### Ledger Commands

No new operations needed. Combat uses existing operations on the new `combat` entity type:

```
CR combat.sublevel4 status=ACTIVE terrain="corridor" spawn_hex="Hexagram 29"
MS combat.sublevel4 "autumn_stance" "aggressive"
MS combat.sublevel4 "autumn_wounds" "lance burn across ribs"
MS combat.sublevel4 "turk_squad_remaining" "3"
S combat.sublevel4 status RESOLVED
S combat.sublevel4 outcome "victory"
D combat.sublevel4
```

### Consistency Validation

`consistency.js` — add `combat` to `VALID_ENTITIES`. Validate format of combat operations. No gameplay rule enforcement — same philosophy as the rest of Gravity.

---

## Repository Progress - 2026-04-03

Already implemented in the repo:

- Setup now authors the combat power doctrine (`power_scale`, `power_ceiling`, `power_notes`, `power_base`, `power`, `power_basis`, `abilities`) instead of old freeform combat rules.
- OOC power review is live via `OOC: power review pc|char:id|all`, with manual `power` and `power base` overrides still available.
- Prompt/state/UI surfacing for `power_base`, `power`, `power_basis`, and `abilities` is live in setup, state view, panel dossiers, combat prompt text, and supporting docs/prompt assets.
- Old `world.constants.combat_rules` / `gravity_combat_rules` setup flow has been stripped from the active runtime path.
- `combat` is now a first-class entity in validation and computed state.
- `combat-state.js` is now live and owns combat runtime state, baseline math, rolls, option parsing, and cleanup grace behavior.
- The dedicated `_combat` injection slot is live in `index.js`.
- Difficulty toggle settings plus configurable DC tables are live in the panel.
- The old one-shot collision-adjacent combat runtime in `index.js` has been replaced by the new combat entity loop.

Still pending / notable gaps:

- Auto-detecting newly created `combat:*` entities that originate outside the combat button flow is not fully wired yet. The handoff design envisioned collision-spawned and advance-spawned auto-entry; this pass implemented the active runtime once combat mode is started.
- Live in-app testing is still needed. Current validation is syntax-only plus JSON parse checks.
- There is still no dedicated manual orphan-combat cleanup tool if the model leaves a `combat:*` entity behind after cleanup grace expires.

---

## What Lives Where

| Component | Location | Responsibility |
|---|---|---|
| Combat lifecycle, rolls, injection | `combat-state.js` (new) | Mechanical layer — rolls, DCs, state |
| Difficulty toggle UI | `ui-panel.js` (addition) | Player-facing settings |
| Combat deduction protocol | Preset / World Info | LLM reasoning scaffold |
| Director framing prompts | World Info or extension config | Mode-specific LLM framing |
| DC tables | Extension settings | Player-configurable numbers |
| Spawn hexagram | Existing divination system in `index.js` | Random generation |
| Per-exchange draws | Existing divination system in `index.js` | Random generation |
| Combat entity type | `consistency.js` (addition) | Format validation |
| Combat detection | `index.js` (addition) | Auto-detect `CR combat.X` |

---

## Summary of the Loop

```
Spawn hexagram sets the stage
  -> LLM describes scene (everyone's wounds/abilities/state as narrative fuel)
  -> SITUATION 1: LLM presents 3-4 options with difficulty categories
     -> Player picks one
     -> Extension rolls d20 + draw, maps category to DC
  -> SITUATION 2: Player declares custom action + self-assessed difficulty
     -> Extension rolls d20 + draw, injects power baseline
     -> LLM accepts (within 1 step) or challenges (2+ steps off)
  -> Absolute? -> auto-success, no roll
  -> Impossible? -> auto-fail, no roll
  -> d20 >= DC? -> success, draw colors how
  -> d20 < DC? -> transform, draw determines nature
  -> nat 20? -> crit success, draw amplifies
  -> nat 1? -> crit failure, draw determines catastrophe
  -> Draw contradicts roll? -> interpret from opposition's perspective
  -> LLM writes prose (one exchange, director framing, everyone reacts)
  -> LLM writes ledger (combat entity map ops + char/PC updates)
  -> Post-combat: timeline entry, persistent consequences, destroy combat entity
  -> Loop until player declares "I end this" / "I escape" and succeeds
```

---

## Design Principles (For the LLM's Reference)

1. The director hurts the hero because it makes the audience care. Injury is a narrative device.
2. The opposition is always competent and always in motion. The camera never shows enemies standing still.
3. The draw describes the full scene — what everyone did, not just the player. If it contradicts the roll, read it from the opposition's perspective.
4. Failure is not "you missed." Failure is "reality had its own opinion." The draw tells you what that opinion was.
5. Every complication should advance a relationship, reveal a character, or shift a dynamic.
6. The player controls pacing. They decide when to end it. The dice decide if reality agrees.
7. Wounds and abilities are narrative opportunity for everyone in the scene — not just the PC, but allies and enemies too.
8. The LLM assesses categories (Situation 1) or validates them (Situation 2). The extension handles all math, all rolls.
9. Combat exists inside the story, not beside it. Wounds persist as timeline legend. A thousand defeated enemies becomes reputation that shapes every future encounter.
10. Combat is not a collision. It is its own entity, its own lifecycle, its own injection slot.

---

## Branch

All work happens on the `combat` branch. Update `Documentation/project_memory.md` with implementation progress.
