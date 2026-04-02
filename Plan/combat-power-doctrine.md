# Combat Power Doctrine

This note defines how combat power should work in Gravity Ledger before the new combat system is implemented.

It is a companion to [combat-system-handoff.md](./combat-system-handoff.md). The handoff defines the combat loop. This document defines what `power` means, how it is authored, how it changes, and how it is used to judge both existing and newly introduced combatants.

## Goals

- Make combat power non-arbitrary.
- Keep the extension math simple and stable.
- Give the LLM concrete narrative reasons for each rating.
- Let combat power change when the story earns it.
- Use the same scale to judge newly introduced enemies consistently.

## Core Principle

`power` is not a vibes number.

It is a bounded abstraction of a character's current direct-combat authority in this setting. The number is justified by narrative evidence such as training, discipline, equipment, supernatural edges, battlefield experience, or severe impairment.

The number alone is not enough. Every meaningful combatant also needs a short explanation of why they deserve that rating and what that rating looks like in action.

## World-Level Contract

The world defines the scale first. Individual ratings are assigned relative to that scale.

Recommended world constants:

- `world.constants.power_scale`
  A short ladder explaining what each level means in this story.
- `world.constants.power_ceiling`
  The highest credible direct-combat level in the current setting.
- `world.constants.power_notes`
  Optional caveats that shape combat judgment, such as "guns dominate at range" or "magic requires setup and concentration."

Example:

```text
power_scale:
1 = trained but ordinary
2 = seasoned fighter
3 = elite specialist / master of one discipline
4 = terrifying battlefield threat
5 = setting-defining monster

power_ceiling:
5

power_notes:
Firearms dominate open ground. Magic is rare and powerful but usually requires setup.
```

## Character-Level Contract

For the PC and any important recurring combatant, use:

- `power_base`
  The character's normal earned combat level when healthy and fully functional.
- `power`
  The character's current effective combat level. This is the value the extension uses for combat baseline math.
- `power_basis`
  A short explanation of why the rating is justified in-story.
- `abilities`
  A short list of combat-relevant capabilities, advantages, or limitations.

Existing fields like `wounds` and `equipment` still matter and must continue to inform judgment.

Example:

```text
pc.power_base = 3
pc.power = 3
pc.power_basis = "Master swordsman with real battlefield experience, disciplined footwork, strong duel instincts, and excellent close-range timing. Limited ranged threat."
pc.abilities = [
  "Master swordsmanship",
  "Fast draw and counter timing",
  "Close-quarters footwork",
  "Weak against multiple shooters in open ground"
]
```

## Setup Authoring Rules

Setup should no longer treat combat as freeform "combat rules" text.

Instead, setup should author:

1. The world power ladder.
2. The world power ceiling.
3. The PC's `power_base`.
4. The PC's `power`.
5. The PC's `power_basis`.
6. The PC's `abilities`.

At setup time:

- `power` should normally start equal to `power_base`.
- The player should be asked not just for a number, but for why the number is deserved.
- Important NPCs can be rated by the LLM from card/scenario/world context, but each one should also receive `power_basis` and `abilities`.

## Judging Combat Baseline

The extension should use current `power`, not `power_base`, for combat baseline math.

Recommended baseline mapping:

- PC advantage `+2` or more -> `Absolute`
- PC advantage `+1` -> `Highly likely`
- Equal power -> `Average`
- PC disadvantage `-1` -> `Highly unlikely`
- PC disadvantage `-2` or more -> `Impossible`

This is only the baseline.

The LLM then judges whether the actual action should stay at baseline or shift within a narrow band based on:

- abilities
- terrain
- preparation
- equipment
- wounds
- numbers advantage
- positioning
- initiative

Normal rule:

- baseline can shift by 1 category if the situation strongly supports it
- a 2-category shift requires a very explicit, already-established hard counter or overwhelming edge

## Dynamic Power Rules

`power` is dynamic. `power_base` is slower to move.

### Change `power` when:

- a serious wound materially lowers effective combat ability
- exhaustion, poison, fear, or shock degrades real performance
- a temporary boost or transformation raises effective combat authority
- loss of key equipment removes a major combat edge

### Change `power_base` when:

- the character completes meaningful training
- a new skill is genuinely earned
- a permanent supernatural change occurs
- a major long-term equipment upgrade becomes part of the character's normal kit
- a permanent injury or loss reduces their normal ceiling

### Guardrail

Do not double-count harm.

Minor wounds should usually affect narration, option quality, and risk framing without automatically lowering `power`.

Lower `power` only when the impairment changes the character's actual combat ceiling in a meaningful way.

## New Enemy Judging Rules

This system must also be used to judge newly introduced enemies.

For any important new enemy, assign:

- `power_base`
- `power`
- `power_basis`
- `abilities`

The rating must be anchored to:

- training
- discipline
- equipment
- supernatural edges
- battlefield experience
- faction support
- visible demonstrated behavior

No naked ratings.

Bad:

```text
char:captain.power = 4
```

Good:

```text
char:captain.power_base = 4
char:captain.power = 4
char:captain.power_basis = "Veteran commander with elite close-quarters training, armored kit, combat discipline under pressure, and experience leading squads in live urban violence."
char:captain.abilities = [
  "Elite CQB training",
  "Squad command under fire",
  "Heavy sidearm and body armor",
  "Aggressive breach tactics"
]
```

Disposable enemies may be compressed into the active combat entity instead of receiving full persistent character records.

## OOC Power Review

The player should be able to request an out-of-character re-judgment of combat power when the story changes.

Suggested commands:

- `OOC: power review pc`
- `OOC: power review char:tifa`
- `OOC: power review all`
- `OOC: power review pc because the rib injury is now affecting his breathing and footwork`
- `OOC: power review char:tifa because she completed live-fire training and now fights with real confidence`

The LLM should review:

- the world power scale
- the world power ceiling
- current `power_base`
- current `power`
- `power_basis`
- `abilities`
- wounds
- equipment
- recent demonstrated evidence in summary, timeline, key moments, or scene history

Allowed outcomes:

- no change
- temporary effective change -> update `power`
- permanent growth or decline -> update `power_base` and usually `power`
- explanation refinement -> improve `power_basis` or `abilities` without changing the rating

This review should not write a prose scene. It should only emit judgment and state updates.

## Doctrine Summary

- `power` is the current effective combat rating.
- `power_base` is the normal earned combat rating.
- `power_basis` explains why the number is deserved.
- `abilities` explain how that rating manifests.
- the world power ladder defines what the numbers mean.
- setup must ask for justification, not just a number.
- combat math uses current `power`.
- dynamic changes to `power` are allowed when the story earns them.
- new enemies must be judged on the same scale.
- OOC power review provides a clean re-judgment path when the narrative changes.
