# Gravity Character Card Template

Use this for character cards that will be played with the Gravity preset.

The goal is not to write a wiki page. The goal is to give Gravity enough dramatic material to derive:

- wants
- doing
- cost
- constraint pressure
- reads / misreads
- speech pattern
- observation bias
- collision hooks

Do not write ledger syntax in the card. Do not write prose-style instructions in the card. The preset and lorebooks already own style.

## Core Rules

- Write for drama, not biography.
- Favor current pressure over complete backstory.
- Give behavioral evidence, not abstract traits.
- Prefer defaults over labels: "When X happens, they usually do Y, because Z."
- Make contradictions usable.
- Make the character easy to misread and pressure.
- Include what they want, what it costs, and what breaks them.

## Use It As A Bundle

For lore-heavy or canon characters, do not force everything into the card. Generate these together:

- Character card: the dramatic engine. Current want, cost, pressure, speech, observation bias, misread bias, and collision hooks.
- Scenario / setup context: what is true now, who `{{user}}` is to them, what version of continuity is active, and what structural tension keeps the interaction unstable.
- Lorebook / World Info: reference facts, canon history, organizations, places, prior incidents, and supporting context that may matter later but is not active pressure right now.

When deciding where a fact belongs:

- If it explains present behavior, put it in the card.
- If it defines the ongoing relationship or current situation, put it in the scenario.
- If it is useful background or canon reference, put it in the lorebook.
- If it only becomes true during play, let the ledger/state earn it instead of preloading it.

## Good vs Bad

Bad:

- "Kind, strong, loyal, smart, beautiful."
- Long lore summary with no active pressure.
- Detailed style instructions like "write in poetic noir prose."
- Perfect self-knowledge.
- Hardcoded future plot outcomes.

Good:

- "She wants X, is doing Y, and every step toward it costs Z."
- "He sounds controlled until threatened, then over-explains."
- "She notices weakness in posture before she notices faces."
- "He reads generosity as leverage unless proven otherwise."

## Behavioral Shortcut

If you get stuck, draft a few lines in this format first:

- When [trigger], they usually [behavior], because [underlying reason].

This is often the fastest route to usable pressure, speech, misread bias, and hooks.

## NPC Card Template

```md
Name:
Role in the world:

Core premise:
[One short paragraph. Who are they in motion?]

What they want:
[What they are actively trying to get right now.]

What it costs:
[What pursuing that want risks, damages, exposes, or corners.]

Public face:
[How they present to strangers or the room.]

Private fracture:
[What they cannot bear, repress, redirect, or protect.]

Under pressure:
[What changes in their body, speech, habits, or decisions.]

How they speak:
[Vocabulary level, rhythm, bluntness, evasions, verbal tics, social register.]

What they notice first:
[The kinds of details they clock immediately in people and environments.]

What they misread:
[Their bias. What they systematically get wrong about people.]

Competence:
[What they are genuinely good at.]

Limits:
[What they cannot do, will not do, or fake badly.]

Relationship bias:
[Who they trust, resent, admire, fear, use, or protect by default.]

Story hooks:
- [Hook 1 that can become collision pressure]
- [Hook 2]
- [Hook 3]
```

## PC / Persona Template

For the player persona, emphasize observable behavior and decision style more than hidden autobiography.

```md
Name:
Role / place in the world:

Core premise:
[One short paragraph. Who is this person when the story starts?]

What they want:
[What they are trying to get, avoid, prove, or survive.]

How they operate:
[Problem-solving style, social style, pressure style.]

Demonstrated strengths:
- [Strength 1 in action terms]
- [Strength 2]
- [Strength 3]

Vulnerabilities:
- [Weak point, blind spot, compulsion, wound, or bad habit]
- [Another]

Moral lines:
[What they will not do. What they will do and hate themselves for.]

Under pressure:
[How stress changes their speech, judgment, body, and choices.]

How others read them at first:
[The surface impression they create.]

What that impression misses:
[The hidden truth or contradiction.]

Competence:
[What they can actually do.]

Limits:
[What they cannot do yet, cannot endure, or cannot admit.]

Hooks:
- [Hook 1]
- [Hook 2]
- [Hook 3]
```

## Scenario / Setup Mini Template

Use this to write the ongoing situation around the character. Keep it present-tense and focused on what is true at story start.

```md
Continuity / version:
[Which canon point, AU, or interpretation is active.]

{{user}}'s role:
[Who the player is relative to this character.]

Current situation:
[What is true right now at the start of play.]

Structural tension:
[What keeps the relationship unstable over multiple turns.]

What cannot be solved or said easily:
[Secrets, duty, power imbalance, countdown, dependency, mutual risk, etc.]
```

## Lorebook / World Info Mini Template

Use lorebook entries for factual support, not the card's dramatic core. Keep entries short, reference-friendly, and easy for the model to retrieve when relevant.

```md
Topic:
[Character, faction, place, incident, organization, object, etc.]

What the model should know:
- [Fact 1]
- [Fact 2]
- [Fact 3]

Why it matters:
[Why this reference should exist outside the card.]
```

## Holistic Bundle Prompts

If you are generating card, scenario, and lorebook together, answer these before drafting:

- Which version of this character or continuity are we using?
- What is their current want in this story, not just their franchise-wide vibe?
- Which past facts directly explain their present behavior?
- Which facts matter to the setting but do not belong in the card?
- Who is `{{user}}` to them right now?
- What condition keeps the relationship tense even after one honest conversation?
- What should start in the lorebook, and what should be discovered during play instead?

## Constraint Seed Prompts

If you want Gravity to generate strong constraints, make sure the card implies answers to these:

- What feeling or truth does this person avoid?
- What role are they trapped inside?
- What kind of pressure makes them lose composure?
- What would count as unbearable exposure?
- If they break, what new defense replaces the old one?

## Reads Seed Prompts

If you want Gravity to generate strong reads, make sure the card implies answers to these:

- What kind of person do they trust too fast?
- What kind of person do they assume is dangerous?
- What do they mistake for strength?
- What do they mistake for love, pity, respect, or control?

## Optional Prewrite Prompts

Use these if you want sharper friction before filling the final card. Do not paste all of this into the card unless it stays compact and usable.

- What do they think they are, and what are they actually?
- What is one specific, disproportionate behavior they do because of that gap?
- How do they try to stay in control when they feel unsafe: competence, charm, humor, planning, caretaking, withdrawal, force, something else?
- What happens when that control strategy fails?
- What kind of question, person, or situation gets under their skin faster than they expect?
- When does their default pattern break, and what do they do instead?
- What would count as unbearable exposure for them?
- Who are they most likely to misread, underestimate, overtrust, or use?

## Card Writing Checklist

Before using the card, check:

- Can Gravity infer a current want?
- Can Gravity infer a current cost?
- Can Gravity infer at least 2-3 likely pressures?
- Can Gravity infer this person's default behavior patterns, not just trait labels?
- Can Gravity infer the gap between their self-image and their actual behavior?
- Can Gravity infer their control strategy and what happens when it fails?
- Can Gravity infer at least one pattern-break, where the default does not hold?
- Can Gravity infer how this person talks?
- Can Gravity infer what this person notices and misreads?
- Can you explain why each major fact lives in the card, scenario, or lorebook instead of all three?
- Does the scenario define `{{user}}`'s role and the ongoing structural tension?
- Does the lorebook hold reference/canon overflow without bloating the card?
- Can Gravity turn this into collisions without inventing a different character?

If not, tighten the card until the answers are obvious.

## Compact Version

If you want a shorter card, this is enough:

```md
Name:
Role:
Core premise:
Want:
Cost:
Public face:
Private fracture:
Under pressure:
Speech:
Observation bias:
Misread bias:
Competence:
Limits:
Hooks:
- 
- 
- 
```
