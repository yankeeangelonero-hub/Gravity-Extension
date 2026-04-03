# Knowledge Asymmetry System Handoff

## Purpose

This document captures the shipped knowledge-asymmetry model as of April 3, 2026.

The goal is to stop omniscient leakage across:
- active scene participants
- returning characters
- off-screen factions
- remote NPCs operating with delayed or wrong information

The system is intentionally **lightweight**. It is a snapshot-and-refresh model, not a live information-propagation simulation.

## Core Design

Separate three layers:

1. **World truth**
- What actually happened in the fiction.
- Lives in normal Gravity state, summaries, collisions, scenes, and consequences.

2. **Faction intel**
- What a faction currently believes it knows.
- May be delayed, partial, or wrong.

3. **Character knowledge**
- What an individual currently knows, does not know, is hiding, or is misreading.
- May differ from both world truth and faction intel.

This separation is the main anti-bleed guardrail.

## Why This Model

The extension should not try to keep every off-screen character globally synchronized every turn.

That would be:
- expensive in prompt space
- brittle in practice
- hard to maintain honestly
- unnecessary for most scenes

Instead:
- local characters update when they matter
- factions hold coarse intel snapshots
- returning characters refresh from elapsed time, summaries, and faction intel

## Shipped Fields

### Character Layer

Important characters now support:

- `char:id.knowledge_asymmetry`
  What they know, do not know, are hiding, or are misreading right now.

- `char:id.last_seen_at`
  Timestamp anchor for absence and re-entry refresh.

These are normalized for KNOWN / TRACKED / PRINCIPAL characters.

### Faction Layer

Factions now support:

- `faction:id.comms_latency`
  How fast information can plausibly travel.

- `faction:id.last_verified_at`
  Last trustworthy intel refresh.

- `faction:id.intel_posture`
  Broad description of surveillance / reporting posture.

- `faction:id.blindspots`
  Known gaps in what they can detect or trust.

- `faction:id.intel_on.subject`
  Current belief snapshot about a subject.

- `faction:id.false_beliefs.subject`
  Important wrong assumptions that still shape behavior.

## Where It Is Enforced

### Runtime Nudge

[index.js](/D:/claude/Gravity%20Preset/Gravity-Extension/index.js)

The runtime nudge now explicitly says:
- characters only act on what reads, noticed details, knowledge asymmetry, faction intel, and plausible information channels make possible
- remote factions are not live-omniscient
- re-entry refresh should use `last_seen_at`, summary residue, and faction intel

### Hidden Deduction CoT

[gravity_v14.json](/D:/claude/Gravity%20Preset/Gravity-Extension/gravity_v14.json)

The hidden reasoning checklist now includes mode-specific provenance checks:

- `regular`
  Checks what present characters, returning characters, and relevant factions plausibly know.

- `combat`
  Checks what off-scene commanders, factions, and reinforcements plausibly know through sensors, comms, intel snapshots, witnesses, or reports.

- `advance`
  Checks how information actually propagates this turn, with delay and error.

- `intimacy`
  Checks what each participant actually knows versus believes, and keeps hidden facts hidden unless plausibly learned.

### Mode Playbooks

[Gravity World Info.json](/D:/claude/Gravity%20Preset/Gravity-Extension/Gravity%20World%20Info.json)

The mode playbooks reinforce the same logic:

- `advance`
  Explicitly uses faction intel fields and asks how information traveled.

- `combat`
  Explicitly states that remote forces only know what sensors/comms/reports justify.

- `intimacy`
  Explicitly blocks off-scene knowledge leakage into intimate scenes.

### State View / Readme

[state-view.js](/D:/claude/Gravity%20Preset/Gravity-Extension/state-view.js)

The prompt-facing state contract now:
- surfaces `knowledge_asymmetry`
- surfaces `last_seen_at`
- surfaces faction intel snapshots
- documents the rule: **No provenance, no knowledge**

## Operational Rule

Use this as the governing principle:

**If a character or faction did not witness it, receive it, detect it, infer it plausibly, or inherit it from current faction intel, they do not get to act on it.**

That applies across all modes.

## Update Rules

### Update Character Knowledge When

- they are active in the scene
- they re-enter after time away
- they directly witness a reveal
- they receive a plausible report / signal / sensor update
- a major misread becomes materially relevant

### Do Not Update Character Knowledge Just Because

- another scene happened somewhere else
- the reader knows something
- the narrator knows something
- a faction would “probably know by now” without a concrete channel

### Update Faction Intel When

- advance turns move off-screen forces
- a report or sensor contact plausibly arrives
- a strategic situation materially changes
- a wrong belief becomes important enough to track explicitly

## Re-Entry Refresh Model

When a character returns after being absent:

1. Check `last_seen_at`
2. Check relevant `summary+` residue since then
3. Check faction intel if they belong to or rely on a faction
4. Ask what they plausibly:
- learned
- missed
- guessed
- got wrong
- are still hiding
5. Refresh `knowledge_asymmetry` only if the answer materially matters now

This is the intended mechanism for distant or dormant characters rejoining the story.

## Example State Updates

```text
---STATE---
at: [Day 4 - 09:20]
char:athrun.last_seen_at: "[Day 4 - 09:20]"
char:athrun.knowledge_asymmetry: "Knows more than ZAFT command about the Archangel crew. Does not know the ship's current interior state."
faction:zaft.comms_latency: "Ship-to-ship near-real-time; long-range relay delayed by jamming"
faction:zaft.last_verified_at: "[Day 4 - 09:20]"
faction:zaft.intel_posture: "Aggressive monitoring, degraded battlefield certainty"
faction:zaft.blindspots: "Mirage Colloid contacts vanish under damaged sensor coverage"
faction:zaft.intel_on.archangel: "Believes the ship escaped damaged and is buying time"
faction:zaft.false_beliefs.strike-pilot: "Assumes the pilot identity is still unconfirmed"
summary+: "ZAFT command updated its picture of the Archangel, but its certainty is lower than its tone."
---END STATE---
```

## What This System Does Not Do

It does **not**:
- simulate comms networks continuously
- propagate every fact to every NPC
- create per-event provenance graphs
- guarantee perfect knowledge consistency without model cooperation

It is a prompt-and-state discipline system, not a full intel engine.

## Current Strengths

- Cheap to run
- Easy to author in normal `STATE` updates
- Works with existing faction and character entities
- Gives the model a concrete way to keep distant actors partial and wrong
- Scales better than per-character omniscience bookkeeping

## Current Limits

- Re-entry refresh is still model-driven, not extension-automated
- There is no dedicated `intel:*` entity type
- Faction intel is coarse-grained by design
- The model still needs to actually use the fields honestly

## Recommended Next Steps

If the system needs to grow, do it in this order:

1. Live-test asymmetry in:
- advance turns
- multi-faction war rooms
- distant antagonists
- return-entry scenes

2. Decide whether `pc.knowledge_gaps` should become a real surfaced field.

3. Only if needed, add richer optional support such as:
- faction intel heartbeat helpers
- explicit report arrival prompts
- optional per-character `intel_source`

Do **not** jump straight to a heavy simulation layer unless the lightweight model proves insufficient.

## Primary Files

- [index.js](/D:/claude/Gravity%20Preset/Gravity-Extension/index.js)
- [state-compute.js](/D:/claude/Gravity%20Preset/Gravity-Extension/state-compute.js)
- [state-view.js](/D:/claude/Gravity%20Preset/Gravity-Extension/state-view.js)
- [gravity_v14.json](/D:/claude/Gravity%20Preset/Gravity-Extension/gravity_v14.json)
- [Gravity World Info.json](/D:/claude/Gravity%20Preset/Gravity-Extension/Gravity%20World%20Info.json)
- [project_memory.md](/D:/claude/Gravity%20Preset/Gravity-Extension/Documentation/project_memory.md)
