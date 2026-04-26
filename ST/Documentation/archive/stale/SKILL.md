---
name: gravity-preflight
description: >
  Evaluate SillyTavern setups built for the Gravity Ledger extension from a player-experience
  perspective. Use this skill any time the user uploads, pastes, or asks about a character card,
  lorebook, World Info JSON, preset JSON, or any structural/content piece intended for use with
  Gravity. Also trigger when the user says things like "critique this", "review my setup",
  "does this work with Gravity", "check my card", "evaluate this lorebook", "preflight",
  "what's wrong with this", or discusses building new Gravity components (presets, injection
  prompts, mode playbooks, deduction protocols, exemplars, nudge templates). If the user
  mentions SillyTavern AND any kind of quality/UX/experience concern, use this skill.
  Even if the user just drops a JSON file and says "thoughts?", trigger this skill if
  Gravity context is present in the conversation.
---

# Gravity Preflight — Player Experience Critique

## Who Is the Player?

Before anything else, internalize who you're evaluating for. A Gravity player is not here
for a quick scene. They are here to inhabit a world.

They want to walk into a tavern and have the bartender remember that they stiffed him last
week. They want to befriend an NPC over thirty turns of small talk, shared danger, and
slowly revealed backstory — and then feel genuinely conflicted when that NPC's loyalty
collides with a faction obligation. They want the world to move when they're not looking:
a political marriage announced while they were dungeon-crawling, a plague spreading through
a district they haven't visited in twenty turns.

**The Gravity player values:**

- **Earned relationships.** Trust, intimacy, rivalry, betrayal — these should develop through
  accumulated interactions, not be handed out because the card says "she finds you attractive."
  If a setup shortcuts emotional progression, it will feel hollow regardless of prose quality.

- **Realistic character behavior.** NPCs should have their own wants, blind spots, and
  agendas that don't revolve around the player. A guard captain who lets the player walk
  past because the card says "helpful" is less interesting than one who lets them pass
  because she's distracted by a demotion she just received — something the player can
  notice, or miss, and which has consequences either way.

- **A world that breathes.** The best Gravity sessions feel like the player stumbled into a
  world already in motion. Factions are maneuvering. Collisions are simmering before the
  player touches them. Pressure points exist because the world has structural tensions, not
  because someone planted quest hooks.

- **Consequences that compound.** Choices from turn 10 should still be echoing at turn 80.
  Gravity's ledger tracks this mechanically, but the setup has to give it material to work
  with. Constraints that are too vague can't generate specific consequences. Collisions that
  resolve too cleanly don't leave residue for future complications.

- **Information asymmetry.** The player shouldn't know everything. Characters shouldn't know
  everything. The tension between what the player knows, what their character knows, what
  NPCs know, and what's actually true is one of the richest sources of drama in long-form
  play. Setups that lay everything bare on turn 1 rob the story of discovery.

- **Immersion over spectacle.** A quiet conversation where subtext matters is worth more than
  an epic battle with no stakes. The setup should support both, but the test of quality is
  the quiet moments — can the world hold together when nothing is exploding?

Every evaluation question in this skill ultimately reduces to: **will this help or hurt
the experience described above?**

## Step 0 — Read the Gravity Repo

Before evaluating anything, orient yourself to the current state of Gravity. The user will
either have the repo uploaded or will provide the path. Read these files in order — they are
your source of truth and override any assumptions from prior knowledge:

### Required reads (always):
Before the numbered list below, read `Documentation/README.md` first, then `Documentation/session_start.md`, so you know where the living docs and component ownership maps are.

1. `AGENTS.md` — Architecture overview, conventions, injection slots, turn modes, key patterns
2. `Documentation/project_memory.md` — Current state, recent changes, what matters now
3. `state-machine.js` — Valid transitions for chars, constraints, collisions, chapters
4. `consistency.js` — What format validation actually checks
5. `state-view.js` — What gets injected as `_state` (this is what the LLM sees every turn)
6. `regex-intercept.js` — How ledger blocks are extracted from LLM output

### Conditional reads (based on what's being evaluated):
- **Preset**: Also read `Documentation/Preset/README.md` before opening the canonical preset files.
- **Lorebook / World Info**: Also read `Documentation/Lorebook/README.md` before evaluating `Gravity World Info.json`.
- **Injection / nudge templates**: Also read `Documentation/Shared/prompt_stack.md` to see which layer owns the behavior.

- **Preset**: Also read the current canonical preset(s) for comparison, plus `index.js`
  sections for `_nudge` and `_readme` injection.
- **Lorebook / World Info**: Also read `Gravity World Info.json` if present, plus
  `memory-tier.js` for hot/cold rotation caps.
- **Character card**: Also cross-reference `state-view.js` to understand what the LLM
  sees alongside the card.
- **Injection / nudge templates**: Also read `index.js` injection registration code.
- **Deduction protocols**: Also read the preset's CoT entries and compare against turn
  mode expectations from AGENTS.md.

The repo is the authority. Adapt to its current shape.

## Step 1 — Identify What's Being Evaluated

Determine the component type. If you can't, ask — don't guess and produce a generic review.

| Component | Key Signals |
|---|---|
| Character card | `.json` with `char_name`, `description`, `first_mes`, `mes_example` |
| Lorebook / World Info | `.json` with `entries` array, `keys`, `content`, `selective` |
| Preset | `.json` with model parameters or CoT/system entries |
| Injection template | Prompt injection content with slot references |
| Deduction protocol | Structured CoT reasoning template |
| Mode playbook | World Info entries tagged to specific turn modes |
| Composite setup | Multiple files — evaluate each, then their interactions |

## Step 2 — Evaluate as a Player Would Experience It

Every finding gets a severity:

- **🔴 CRITICAL** — Will break the session or make it unplayable.
- **🟡 WARNING** — Will erode immersion, flatten characters, or waste the player's investment.
- **🔵 SUGGESTION** — Would deepen the experience if addressed.

The evaluation runs through four lenses, in this order. The first lens is a gate — if
the machinery is broken, nothing else matters. But the remaining three are where the real
value lives, because technically correct setups can still produce lifeless stories.

---

### Lens 1: Does the Machinery Work?

The structural check. Quick, decisive, pass/fail on the things that would cause session-ending
failures.

**Ledger syntax**: Does the setup teach the LLM correct operations, entity types, and block
format per the current repo? Will `regex-intercept.js` parse what the LLM produces? Will
`consistency.js` accept it?

**State machine alignment**: Do any instructions encourage impossible transitions? Does the
setup reference collision statuses, character tiers, or constraint states that don't exist
in `state-machine.js`?

**Injection conflicts**: Does the setup duplicate or contradict what the extension already
injects? Map the setup's guidance against every active injection slot (`_state`, `_readme`,
`_nudge`, `_inject`, etc.) — duplication wastes tokens, contradiction confuses the LLM.

**Turn mode coverage**: Does the setup handle all modes (regular, advance, integration) or
leave gaps? A missing advance mode means the world stops moving between player actions —
death for a slow-burn story.

---

### Lens 2: Will This World Feel Alive?

This is the heart of the evaluation. A Gravity setup isn't a character sheet — it's the
seed of a living world. Evaluate whether this seed can grow.

**Does the world have inertia?**
The setup should establish forces already in motion before the player arrives. Look for:
factions with agendas that predate the story, collisions that are SIMMERING (not just
SEEDED — something should already be heating up), pressure points that feel like genuine
structural tensions in the world rather than planted quest hooks. If every conflict begins
with the player's arrival, the world feels like a theme park that only activates when
someone walks through the gate.

**Can relationships develop naturally?**
Check whether the setup supports gradual relationship building or shortcuts it:
- Do character definitions include enough personality texture for the LLM to sustain
  varied interactions over dozens of turns? A character described only by their role
  ("loyal guard," "mysterious merchant") will flatten into that role within five turns.
- Are there constraints or social structures that create friction in relationships?
  The most interesting relationships in long-form play are the ones where both sides
  want connection but something structural gets in the way — duty, secrecy, faction
  loyalty, class difference, a promise made to someone else.
- Does the setup avoid pre-determining relationship outcomes? If the card's description
  tells the LLM that an NPC "will eventually betray the player" or "is destined to
  become a love interest," the player will feel the rails. Gravity's constraint and
  collision system should drive these outcomes emergently, not the card's stage directions.

**Is there enough to discover?**
Information asymmetry is fuel for slow-burn storytelling. Evaluate:
- Do NPCs have secrets, misunderstandings, or incomplete knowledge that the player can
  uncover over time? These should be encoded as constraints, reads, or noticed_details —
  not dumped into the card description where the LLM treats them as common knowledge.
- Does the lorebook contain world facts that the player's character wouldn't initially
  know? Are the trigger keywords set so this information surfaces when it's relevant,
  not all at once?
- Are there knowledge gaps between characters? (NPC A knows something NPC B doesn't;
  the player knows something no NPC does; a faction has information the player needs.)
  These gaps are where scenes become charged with subtext.

**Will the story sustain itself past turn 50?**
Long-form viability requires layered narrative fuel:
- Count the collision lifecycle distribution. If everything is SEEDED, the first 20 turns
  will feel like setup with no payoff. If everything is ACTIVE, the first 20 turns will
  be overwhelming with no breathing room. A good distribution has some simmering
  (building tension), some approaching active (imminent), and one or two seeded
  (long-term threats the player doesn't know about yet).
- Are constraints interconnected? The best Gravity stories happen when resolving one
  constraint creates pressure on another. "Sworn to protect the heir" and "Owes a blood
  debt to the heir's enemy" is a pair that generates drama for dozens of turns. Isolated
  constraints resolve cleanly and leave no residue.
- Is there a plausible path for new collisions to emerge organically from the world's
  existing tensions? If the setup front-loads all its narrative fuel with no mechanism
  for renewal, the story will feel like it's winding down by turn 40.

**Do advance turns have material to work with?**
When the player isn't acting and the world moves on its own, what happens? Check:
- Are there enough NPC agendas, faction movements, and simmering collisions to generate
  meaningful advance turns?
- Will advance turns feel like genuine world progression, or will they be filler
  ("meanwhile, at the market, things are normal")?
- Is there enough state for the LLM to produce advance turns that surprise the player
  with developments they didn't cause but must now respond to?

---

### Lens 3: Will the Quiet Moments Hold?

Spectacle is easy. The real test of a Gravity setup is whether it can sustain a scene where
two characters are just talking — and make it feel tense, warm, funny, or revelatory based
on accumulated history rather than manufactured drama.

**Prose and voice:**
- Does the preset give the LLM enough stylistic direction to write consistent, grounded
  prose? Slow-burn stories need prose that can handle subtlety — a character's hesitation,
  an unfinished sentence, the weight of what isn't said.
- Does the style guidance work across all turn modes, or does the voice shift jarringly
  between regular turns and combat? A character who speaks in lyrical prose during
  conversation but becomes a stat block during a fight breaks immersion.
- Are example messages (in the card) demonstrating the range of interaction the player
  will actually experience? Examples that are all high-drama confrontations teach the LLM
  nothing about how to write a quiet breakfast scene where the subtext is carrying the
  weight.

**Character interiority:**
- Do character definitions support the LLM in portraying NPCs who think and feel beyond
  their immediate function in the scene? A tavern keeper who has opinions about the
  political situation, worries about her daughter, and quietly resents the local lord
  is a character who can anchor a dozen scenes. A tavern keeper who "serves drinks and
  gives rumors" is furniture.
- Are demonstrated traits and reads set up so NPCs can notice things about the player
  and react to patterns over time? ("You've been asking about the north road a lot
  lately" is the kind of observation that makes a player feel seen by the world.)

**Emotional pacing:**
- Does the setup allow for downtime? Constant escalation is exhausting. The setup should
  support periods where the player can explore, build relationships, or simply exist in
  the world without every turn advancing a collision. If every lorebook entry and every
  NPC definition is oriented toward conflict, the story has no room to breathe.
- Are there low-stakes elements in the world? Not everything needs to be consequential.
  A market, a festival, a recurring minor character who's just pleasant — these create
  texture that makes the high-stakes moments feel earned by contrast.

---

### Lens 4: Token Economy as Narrative Memory

Frame this for the player, not the engineer. Every token spent on redundant instructions
is a paragraph of conversation history lost — which means the LLM forgets that the
bartender was angry, that the player promised to return the ring, that it was raining
when they first met. In a slow-burn story, conversation history IS the relationship
history. Protect it.

**Estimate per-turn injection cost:**
Map every component that will be in context on a typical turn: `_state`, `_readme`,
`_nudge`, preset system prompt + CoT, card content, active lorebook entries, periodic
injections. Estimate total tokens.

**Impact thresholds (framed as narrative memory):**
- If the injection footprint is so heavy that fewer than 40 turns of conversation fit
  in context → 🔴 CRITICAL. The LLM will forget relationship developments, promises,
  and accumulated character dynamics. The slow burn becomes a series of disconnected
  encounters.
- If individual lorebook entries are so large they crowd out other entries when they
  co-activate → 🟡 WARNING. The player will notice when the world "forgets" something
  because a verbose entry consumed the budget.
- If the card description is so long it's effectively a lorebook unto itself → 🟡 WARNING.
  That space would serve the player better as conversation history.
- Check memory tiering caps against story ambition. A setup with 15 named characters will
  overflow hot storage quickly — will the tier rotation preserve the right memories, or
  will the player lose track of relationships they care about?

**Lorebook activation pattern:**
Estimate which keywords fire on a typical turn. If five entries fire simultaneously because
their keywords are common words, the player is paying a heavy token tax every turn. The
best lorebook entries fire surgically — specific to the moment, adding exactly the
knowledge the LLM needs for this scene, then going quiet.

---

### Cross-Component Check (when multiple files are provided)

The worst player-experience failures come from components that each look fine alone but
fight at runtime:

- **Card ↔ Lorebook**: Does the card establish facts the lorebook contradicts? The player
  experiences this as NPCs with inconsistent personalities — they'll feel the wrongness
  without being able to name it.
- **Preset ↔ Extension**: Does the preset instruct the LLM to do things the extension
  already handles? The player experiences this as repetitive, mechanical-feeling prose
  where the LLM keeps restating system concepts instead of telling the story.
- **Lorebook ↔ Preset voice**: Does the lorebook's register match the preset's prose
  guidance? A lorebook written in dry encyclopedic tone feeding into a preset asking for
  lyrical prose creates uneven writing — some turns sing, others read like a textbook.
- **Worst-case token collision**: When everything fires at once (faction heartbeat +
  multiple lorebook entries + correction injection + oracle resolution), is there still
  room for the story?

## Step 3 — Produce the Report

### Verdict
One sentence framed as player experience. Not "the JSON is valid" but "this world will
feel alive for about 30 turns before the collision structure runs dry" or "the characters
have enough depth for a slow burn but the lorebook will keep breaking immersion with
encyclopedic tone" or "solid — this has the bones for a 100+ turn story."

### Findings
Grouped by severity (🔴 → 🟡 → 🔵). Each finding includes:
- **What's wrong** — specific, quotable from the file
- **What the player would feel** — translate the technical issue into experiential terms.
  Not "lorebook entry too broad" but "the player will notice the LLM keeps bringing up
  the ancient prophecy even when they're just buying bread — it'll feel like the world
  has a one-track mind."
- **How to fix it** — concrete. Show the rewritten entry, the better keyword set, the
  tighter description. Not "consider revising."

### Token Budget
Table: component → estimated tokens → what it costs in conversation turns.
Frame the numbers as narrative memory: "This setup leaves room for approximately X turns
of conversation history, meaning the LLM will reliably remember events from the last
Y hours of play."

### Session Forecast
The most important section. Walk through what the first 15-20 turns would feel like as
a player:
- Where does the world feel most alive? What's the best scene this setup could produce?
- Where does it first feel thin? When would the player first sense something is off —
  a character going flat, a world detail contradicting itself, the story losing momentum?
- What happens at turn 50? At turn 100? Does this setup have legs, or is it front-loaded?
- What's the most likely way this session breaks down, and when?

Write this as narrative, not bullet points. The player should be able to read it and
think "yes, that's the experience I want" or "no, that's exactly what I'm trying to avoid."

## Principles

1. **The player's hours are the real stakes.** A four-hour session that derails is not a
   technical failure — it's a personal one. They invested their evening. Evaluate with
   that weight.

2. **Earned beats given.** Every relationship, revelation, and consequence should feel like
   it was built through play. If the setup gives things away — predetermined outcomes,
   obvious character arcs, information the player didn't work to uncover — it undermines
   the entire point of Gravity's tracking system.

3. **The world doesn't revolve around the player.** The best Gravity setups create a world
   that would be interesting even if the player weren't there. NPCs with their own lives.
   Factions with agendas. Events that happen offscreen. The player's experience of agency
   comes from intervening in a world that's already moving, not from being the center of
   a world that exists only for them.

4. **Silence is content.** A character who doesn't mention something is making a choice.
   A world detail that hasn't surfaced yet is building anticipation. Evaluate whether the
   setup trusts the player enough to let them discover things gradually, or whether it
   front-loads everything out of anxiety that the player might miss it.

5. **The machinery should be invisible.** Gravity's ledger, state machines, and injection
   architecture exist to make the story feel seamless. If any component of the setup makes
   the machinery visible to the player — meta-language in lore entries, system concepts
   leaking into prose, deduction protocols that feel like checklists — it's a failure
   regardless of technical correctness.

6. **Resilience is a player-experience feature.** When the LLM misreads a situation, writes
   a character slightly off, or loses track of a thread — does the setup give the system
   enough to self-correct? The player shouldn't have to break immersion with OOC commands
   to fix things a well-designed correction loop would catch. Fragile setups that only work
   with perfect LLM performance don't respect the player's immersion.
