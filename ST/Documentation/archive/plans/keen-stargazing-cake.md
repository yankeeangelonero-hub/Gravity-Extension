# Gravity Prose Architecture Overhaul

## Context

The current prose system is monolithic: one heavy Prose Kernel + one heavy Noir Realist style + thin prose subsections buried inside gameplay mode entries. This creates three problems: (1) Sonnet defaults to safe, flat prose because the instructions are too generic and mixed together, (2) all modes sound the same because there's no mode-specific prose modulation, and (3) instruction language leaks into prose ("one beat," "C2 is cracking," "I'm staying").

The goal is to adopt Lucid Loom's modular philosophy — stackable, swappable prose layers — while leveraging Gravity's unique advantage: structured character dossiers that no other RP system provides. The extension fires lorebook keywords per mode, so the user can swap prose personalities by importing a different World Info file with zero code changes.

## Architecture After Changes

```
ALWAYS ON (preset):
  Prose Kernel (quality floor — anti-slop, bans, sensory rotation, instruction leak guard)
  Tense / Narration / Perspective (Groups 2-4)

TOGGLEABLE (preset):
  Group 5 Prose Style (aesthetic register — slimmed to core charge + line method only)
  Character Voice (new — vocabulary prison, stress decay, observation filter)
  Dossier-Driven Prose (exists — add flaw-first decision)

MODE-SPECIFIC (lorebook, fired by extension):
  gravity_prose_regular — Emotional Deflections, Suggestion, Negative Space, Slow-Burn
  gravity_prose_combat — Anti-Camp, Adrenal Degradation, Compression, Rendering
  gravity_prose_intimacy — Impermanence, Suggestion, Psychic Opacity, Intimacy Dynamics
  gravity_prose_advance — Cynicism, Negative Space, Rendering, Counterweight, Jo-ha-kyū

EXISTING MODE GAMEPLAY (lorebook, unchanged trigger):
  gravity_mode_combat_core — what to DO in combat (strip prose subsection)
  gravity_mode_intimacy_core — what to DO in intimacy (strip prose subsection)
  gravity_mode_advance_core — what to DO on advance (strip prose subsection)
  etc.
```

Injection order matters. The model reads the prompt roughly in this order:
1. System prompts (tense, narration, perspective, style, character voice, dossier layer, word count, cast reminder)
2. World Info Before (mode gameplay entries + mode prose entries land here, depth 4)
3. Character description, personality, scenario
4. Gravity Kernel + Prose Kernel
5. World Info After
6. Chat history
7. Examples (if enabled)
8. Extension injections at depth 0: State View, Readme, Nudge, OOC (with lorebook triggers), Exemplars, etc.
9. State Contract + Anchor (depth 0)

Key insight: the lorebook trigger keywords are injected at depth 0 (step 8), but SillyTavern scans the full assembled prompt for WI matches, so entries placed at depth 4 (step 2) still activate correctly. This is proven by the existing mode system.

---

## File Changes

### 1. `gravity_v14.json` — Preset

#### 1a. Prose Kernel Rework

**File:** `gravity_v14.json`, entry `072d4755-52cd-476e-b262-649db0c3b362` ("| L3 - Prose Kernel")

Replace the current content with a restructured quality floor. Key changes:

**Restructure ban list into categorized bans with "doors out"** (Anti-Slopinator pattern):

- **Explaining instead of rendering:** Negation-assertion ("wasn't X but Y"), lock-and-key clichés, physical-blow comparisons. Door: delete the explanation, show aftermath.
- **Throat-clearing:** Opening any beat with narration of reception — words landing, questions hanging, silence settling, action-as-stall (sharp inhale, the pause, going-still). Hard ban as openers. Door: begin with response, not registration.
- **Borrowed language:** Somatic clichés (shivers down spines, breath hitching, hearts skipping, stomachs dropping), predatory tropes (circling, dark hunger), texture fallacies (velvety voice), economy tropes (fluid grace, pregnant pause). Door: plain statement is stronger than decorated evasion.
- **Inflation:** Cosmic melodrama (world shattering, time stopping), filter words (she noticed, he felt), unearned intensifiers. Door: zoom in, trust the domestic to carry the cosmic.

**Add instruction leakage ban** (new section):

- Never echo system language in prose or dialogue: "one beat," "the beat," "collision," "constraint," "pressure point," "distance," C1/C2/col-IDs, STRESSED/BREACHED/CRITICAL, or any mechanical Gravity term.
- If a character would naturally say "I'm staying" — check whether it is the character's voice or the deduction's voice wearing the character's mouth. If the line restates the player's declared intent or the system's turn structure, cut it.
- Deduction reasoning does not leak into prose register. The analytical voice stops at ---END DEDUCTION---. Prose is fiction, not commentary on fiction.
- When a constraint is under pressure, describe what the character is feeling, doing, suppressing, or failing to suppress. Never reference the constraint by ID or mechanical label. The character does not know they have a "constraint." They know they are holding on to something, or failing to.

**Add sensory rotation** (compressed from Lucid Loom sensory stack):

- Rotate sensory channels across paragraphs. If the last paragraph was visual, the next should carry touch, temperature, sound, or smell.
- One background tactile detail per paragraph — the ambient texture the character's body registers without conscious attention.
- Temperature is emotional signal. Fear runs cold. Embarrassment runs hot. Let thermal shifts precede or follow emotional beats.
- A scent introduced once may resurface at emotional spikes as a one-sentence echo. Scent is memory's shortcut.

**Add anti-superiority:**

- NPCs with greater expertise express it through what they know, not through condescension. They do not always have the answer first, always refine the player's plan, or always deliver the final word. When the player raises a valid point, the NPC integrates it visibly.

**Add trauma guards:**

- After a shattering event, allow 1-2 beats of shutdown, then weave subtle signs of processing: a flicker of anger, a quiet question, a reflexive action. Characters grieve while moving. Emotional paralysis does not stall the story.

**Keep existing structure** that works: three live wires, camera and rhythm, "do not" list (minus items moved to categorized bans), "length is a ceiling not a target."

**Remove** the flat banned-habits list (replaced by categorized bans). Remove items now covered by the mode-specific prose entries or Character Voice.

#### 1b. Character Voice Module (new entry)

**New entry** in prompts array. Identifier: `v01ce000-0001-4000-a000-000000000001`. Name: `| Character Voice`. Enabled: false (toggle). system_prompt: true. Position in prompt_order: after Dossier-Driven Prose, before Group 6.

Content adapted from Lucid Loom #194, compressed and connected to Gravity's dossier system:

- **Vocabulary Prison:** Characters think and speak only in words they've earned. A soldier doesn't say "recalibrate" — they say "fix." Internal vocabulary is simpler than speech, not more sophisticated. The dossier's tier, condition, and background constrain the word ceiling.
- **Stress Decay:** Coherence degrades under pressure. Wounds degrade grammar. Adrenaline strips adjectives. Lies introduce artificial pauses, over-explanation, conspicuous precision. Check the character's condition field — what it says should affect how they speak.
- **Observation Filter:** What a character notices reveals the character. A thief notices exits. A medic notices injuries. What they fail to observe matters as much. The reads and noticed_details fields tell you what this character is biased toward seeing — let that bias shape narration.
- **Syntactic Fingerprint:** Grammar reveals origin. Anxious characters fracture into comma-splices. Confident characters use short declaratives. Register shifts with audience — formal with authority, vernacular with peers, performative with strangers.
- **Organic Friction:** Perfect speech is a failure state. Allow false starts, abandoned clauses, environmental interruptions. Scale verbal tics to articulacy and emotional state.

#### 1c. Dossier-Driven Prose Update

**Existing entry** `d0551e00-0001-4000-a000-000000000001`. Add flaw-first decision to the "Constraints as Body Language" section:

- At every choice point, the constraint-driven impulse should be visible before the decision. Show the flaw-powered urge — a physical twitch, a micro-thought driven by the constraint's pressure — then let reason, loyalty, or growth override (or succumb). When the constraint is STABLE, the override wins cleanly. When CRITICAL, the urge shows through despite the character's effort. When BREACHED, the urge IS the action.

#### 1d. Group 5 Style Slim-Down

Slim each style to **aesthetic register only** — core charge + line-level method. Move universal technique sections (establishing space, establishing character, dialogue/social pressure) out of styles and into the Prose Kernel.

Specifically for **Noir Realist** (`pr0se000-0001-4000-a000-000000000001`):
- Keep: Core charge ("inhabited, pressurized, slightly unslept"), line-level method
- Move to Prose Kernel: "Establishing a Space" (universal — all styles need space-rendering rules), "Establishing a Character" (universal — physical-first introductions), "Dialogue and Social Pressure" (universal — leverage-shifting dialogue)
- This slims Noir Realist from ~2500 chars to ~800 chars

Same treatment for Glass Nerve, Lyrical Ruin, Street Voltage — keep the aesthetic core, move universal craft to the quality floor.

**Conflict note:** The "establishing a space" and "establishing a character" techniques currently in Noir Realist are written in noir register. When moving to Prose Kernel, generalize the technique while keeping the principle: objects in a room carry judgment (noir), but the broader rule is "objects reveal the people who built, maintained, or abandoned them" (universal). The active Group 5 style then flavors HOW that rendering sounds.

#### 1e. Noir Realist Examples Update

**Existing entry** `ex0mp000-0001-4000-a000-000000000001`. Currently contains 3 noir examples showing deduction-prose-state flow.

Add a preamble noting examples are style-specific. Consider adding a second examples entry for dossier-driven techniques (the examples from our conversation — asymmetric reads, constraint breach, doing-cost choreography). These would be tagged with technique strengths for the exemplar system.

**Alternative:** Create one examples entry per Group 5 style (matching what we drafted: Glass Nerve examples, Lyrical Ruin examples, Street Voltage examples). Each demonstrates dossier techniques through that style's aesthetic.

---

### 2. `Gravity World Info.json` — Mode-Specific Prose Entries

#### 2a. New Entry: `gravity_prose_regular`

**Key:** `gravity_prose_regular`
**Position:** 0 (system area)
**Depth:** 4
**Order:** 120 (after mode gameplay entries at 100 and optional examples at 110)
**Constant:** false
**Trigger:** Extension injects keyword on regular turns

Content — techniques for regular (dialogue, exploration, social reading) turns:

- **Emotional Deflections:** Characters rarely say the center of the thing. Let them tease past the point, evade, talk around it, shut down exchanges, trail off, refuse to answer. Meaning lives in the gap between what's said and what's meant. Let characters be indirect; the reader does the emotional labor of inference.
- **Suggestion (Dhvani):** The suggested meaning beneath the literal. Omit what the reader can infer. Approach meaning sideways.
- **Negative Space (Ma):** What you don't write gives weight to what you do. The scene that ends mid-motion. The sentence that severs. Silence is a choice the prose makes, not an absence.
- **Slow-Burn Seduction:** Build anticipation through emotional vulnerability and charged moments. Yearning and proximity over physical milestones. Micro-denials and hesitations heighten tension. The transition to physicality should feel inevitable, not mechanically delayed.
- **Mirror Moment:** Once per major scene transition, one sentence of visual self-survey (what the character sees of themselves) followed by one emotional translation. Use the PC's condition and wounds fields.

#### 2b. New Entry: `gravity_prose_combat`

**Key:** `gravity_prose_combat`
**Position/Depth/Order:** same as above

Content — techniques for combat turns:

- **Anti-Camp:** One metaphor maximum per beat. Physical over philosophical at peaks. Short sentences and fragments at impact. Single-statement realizations. Emotional impact = precision + restraint, not saturation. Do not stack metaphors. Do not explain the same injury twice.
- **Adrenal Degradation:** Stress degrades competence — it does not grant resolve. Replace "steeling shoulders" and "darkened eyes" with physiological failure: tremors, nausea, tunnel vision, the urge to flee. Courage is the act of acting despite the body's failure. Check the character's condition and wounds — those fields degrade speech and movement.
- **Compression (Ījāz):** Nouns and verbs. One adjective maximum. No adverbs. If a verb needs modification, find the stronger verb.
- **Rendering (Enargeia):** Could this passage be filmed? If not, it is summary. Place the exchange before the eyes.
- **Counterweight (Tibāq):** Place opposites adjacent without explanation. The winning strike that leaves the winner exposed. The weaker fighter surviving through terrain.

#### 2c. New Entry: `gravity_prose_intimacy`

**Key:** `gravity_prose_intimacy`
**Position/Depth/Order:** same as above

Content — techniques for intimacy turns:

- **Impermanence (Mono no Aware):** Beauty and transience are the same. Joy rendered as faintly sad. Introduce the flaw — the scar, the hesitation, the thing that almost went wrong. Perfection is sterile. The imperfection is where the heat lives.
- **Suggestion (Dhvani):** Approach meaning sideways. Intimacy should never state its own intensity. The intensity lives in what is not said, not named, not touched yet.
- **Anti-Camp:** One metaphor max. Physical sensation over philosophical contemplation. Short sentences at peaks. Do not explain the same feeling multiple times. Do not stack nested purple clauses.
- **Psychic Opacity:** Characters cannot perfectly understand each other through looks or shared silence. Enforce misinterpretation, doubt, asymmetry. Two people in the same bed can be having completely different experiences and neither knows. Check the reads map — if reads are asymmetric, the intimacy is asymmetric.
- **Intimacy Dynamics (The Friction Thread):** Position does not erase personality. Being "on top" does not erase anxiety. Real intimacy involves missed rhythms, adjustments, awkwardness — these are evidence of reality, not failures. Every touch has an internal reason: apology, claim, question, surrender. Reciprocity is a circuit — if one person moves, the other must react, even if the reaction is silence.
- **Multisensory:** Prioritize tactile over visual. Temperature contrasts, friction, internal sensation, the smell of skin. Do not default to describing what it looks like.

#### 2d. New Entry: `gravity_prose_advance`

**Key:** `gravity_prose_advance`
**Position/Depth/Order:** same as above

Content — techniques for advance turns:

- **Aperture of Cynicism:** The world's indifference, not merely its filth. Entropy and cost. Every thread pulled tight creates tension; every victory leaves a scar. The world does not care about the player's plans. Show that through consequence, not cruelty.
- **Negative Space (Ma):** Show what happened through absence, aftermath, and residue. Not "the faction moved" but "the storefront that was open yesterday is boarded." Let the reader see the consequence, not the action.
- **Rendering (Enargeia):** Advance turns must be filmable. Do not narrate offscreen events as summary. Show the consequence arriving — residue, messages, environmental change, someone who shouldn't be here.
- **Counterweight (Tibāq):** Place opposites adjacent. The player's quiet evening beside someone else's catastrophe. The market still running while the perimeter tightens.
- **Rhythm (Jo-ha-kyū):** Begin slow and atmospheric, accelerate through arriving pressure, end swift — snap back to the player in the changed reality. One sentence widening the world. One sentence snapping back to the player's immediate problem.

#### 2e. Strip Prose from Existing Mode Entries

For each existing gameplay entry, remove the "prose:" subsection and leave only gameplay logic. The prose lorebook entries now own prose.

**gravity_mode_combat_core:** Remove "Combat prose:" paragraph (lines about consequence-first verbs, imbalance, scramble, ugly contact, etc.)
**gravity_mode_intimacy_core:** Remove "Intimacy prose:" paragraph (lines about desire and caution, asymmetry, touch/breath/distance, etc.)
**gravity_mode_advance_core:** Remove "Advance prose:" paragraph (lines about lead with changed fact, off-screen residue, etc.)
**gravity_mode_timeskip_core:** Remove "Timeskip prose:" paragraph
**gravity_mode_chapter_close_core:** Remove "Chapter-close prose:" paragraph

Add a one-liner to each: "Prose modulation for this mode is provided by the active prose lorebook entry."

---

### 3. `index.js` — Extension Changes

#### 3a. Add Prose Lorebook Keys

Add to `MODE_LOREBOOK_KEYS`:

```js
const MODE_LOREBOOK_KEYS = Object.freeze({
    // existing gameplay keys
    advanceCore: 'gravity_mode_advance_core',
    advanceOptional: 'gravity_mode_advance_optional_examples',
    combatCore: 'gravity_mode_combat_core',
    combatSetupCore: 'gravity_mode_combat_setup_core',
    combatOptional: 'gravity_mode_combat_optional_examples',
    intimacyCore: 'gravity_mode_intimacy_core',
    intimacyOptional: 'gravity_mode_intimacy_optional_examples',
    timeskipCore: 'gravity_mode_timeskip_core',
    chapterCloseCore: 'gravity_mode_chapter_close_core',
    // NEW: prose keys
    proseRegular: 'gravity_prose_regular',
    proseCombat: 'gravity_prose_combat',
    proseIntimacy: 'gravity_prose_intimacy',
    proseAdvance: 'gravity_prose_advance',
});
```

#### 3b. Fire Prose Keywords Alongside Mode Keywords

Update each `buildModeInjection` call to include the matching prose key:

- **handleAdvanceButton:** Add `MODE_LOREBOOK_KEYS.proseAdvance` to the markers array (alongside advanceCore, advanceOptional)
- **handleCombatButton:** Add `MODE_LOREBOOK_KEYS.proseCombat` to the keys array (alongside combatCore, combatOptional)
- **handleIntimacyButton:** Add `MODE_LOREBOOK_KEYS.proseIntimacy` to the keys array (alongside intimacyCore, intimacyOptional)
- **handleCombatSetupButton:** No prose key — setup is structural, not prose

These all flow through `buildModeInjection` → `buildLorebookTriggerBlock` → injected into `_ooc` slot → SillyTavern scans → WI entries activate.

#### 3c. Regular Turn Prose Trigger

Regular turns don't go through `buildModeInjection`. They call `injectPrompt()` with no OOC injection. The prose keyword needs to reach the prompt another way.

**Option A: Inject into _nudge slot.** The nudge is always set on every turn. Append the trigger keyword to the nudge text:

```js
const nudgeText = `[SYSTEM: TURN FORMAT — ...existing content...]`;
// Append prose trigger for regular turns (non-integration, non-mode)
if (isRegular) {
    nudgeText += `\n\n[WORLD INFO TRIGGERS - DO NOT ECHO:\n${MODE_LOREBOOK_KEYS.proseRegular}\n]`;
}
```

**Option B: Dedicated _prose slot.** Create a new `setExtensionPrompt` slot that fires the appropriate prose keyword based on mode:

```js
const proseKey = isRegular ? MODE_LOREBOOK_KEYS.proseRegular
    : isAdvance ? MODE_LOREBOOK_KEYS.proseAdvance
    : null; // combat/intimacy fire via _ooc
if (proseKey) {
    setExtensionPrompt(`${MODULE_NAME}_prose`,
        `[WORLD INFO TRIGGERS - DO NOT ECHO:\n${proseKey}\n]`,
        PROMPT_IN_CHAT, 0);
} else {
    setExtensionPrompt(`${MODULE_NAME}_prose`, '', PROMPT_NONE, 0);
}
```

**Recommendation: Option A** for simplicity. The nudge slot is already guaranteed to fire on every turn. No new slot needed. For advance/combat/intimacy turns, the prose key is already in the _ooc slot via buildModeInjection, so no double-firing.

**However:** On advance turns, the prose key should fire via _ooc (already handled by 3b). On regular turns, fire via _nudge (3c). Need to ensure no double-firing: if `_pendingOOCInjection` is set (meaning a mode button was pressed), skip the nudge prose injection. The nudge only adds the regular prose trigger when no mode-specific trigger was already set.

Logic:

```js
// At the end of nudge construction, before setExtensionPrompt:
const hasModeTrigger = _pendingOOCInjection || !isRegular;
if (!hasModeTrigger) {
    nudgeText += `\n\n[WORLD INFO TRIGGERS - DO NOT ECHO:\n${MODE_LOREBOOK_KEYS.proseRegular}\n]`;
}
```

Wait — `_pendingOOCInjection` is consumed earlier in injectPrompt. By the time we reach the nudge construction, it's already been set into the _ooc slot and nulled. The check should be against the mode directly:

```js
if (isRegular) {
    // only fire regular prose trigger on actual regular turns
    // combat/intimacy/advance fire their own prose triggers via _ooc
}
```

This is clean because `isRegular` is only true when `_currentInjectMode === 'regular'`, and all mode buttons set the mode to 'advance' or 'integration' before calling injectPrompt.

---

## Potential Conflicts

1. **Token budget:** New content adds ~400-600 chars per mode prose entry (only one fires at a time) + ~500 chars for Prose Kernel expansion + ~800 chars for Character Voice (if toggled). Worst case ~1900 chars additional. The Noir Realist slim-down recovers ~1700 chars. Net change is roughly neutral if Character Voice is enabled, slightly negative if not.

2. **Prose Kernel vs mode prose entries:** The Prose Kernel is the quality floor (what NOT to do, universal technique). Mode prose entries are the mode voice (HOW to write for this specific mode). They don't conflict — they layer. The Prose Kernel says "vary sentence length." The combat prose entry says "compression, one adjective max." The combat entry narrows the Prose Kernel's range for that mode.

3. **Character Voice vs Group 5 Style:** Character Voice owns how characters talk and think (vocabulary, grammar, friction). Group 5 Style owns how narration sounds (aesthetic register). These are different concerns. Potential overlap in dialogue: if Noir Realist says "speech reveals class" and Character Voice says "grammar as class marker," that's reinforcement, not conflict. But we should audit for contradictions after drafting.

4. **Dossier layer vs mode prose entries:** The dossier layer says WHAT to draw from (reads, constraints, noticed_details). The mode entry says HOW the prose should feel (compression, deflection, impermanence). They complement. Example: dossier layer says "constraint CRITICAL should leak through body language." Combat mode entry says "use compression and adrenal degradation." Together: the constraint leaks through shortened speech and trembling hands, rendered in compressed prose.

5. **Existing mode gameplay entries losing prose:** We're stripping prose subsections from combat/intimacy/advance/timeskip/chapter-close entries. This is clean because the prose now lives in dedicated entries. But if a user imports a World Info file that has mode gameplay entries without the corresponding prose entries, they lose the prose guidance entirely. Mitigation: the Prose Kernel still provides a baseline. Also document the expected WI structure.

6. **Anchor prompt overlap:** The Anchor (`05d1145b...`) contains "RULES THAT DRIFT" including "ONE BEAT PER TURN" and "WORD BUDGET IS A CEILING." Some of this overlaps with the restructured Prose Kernel. The Anchor is optional (currently enabled: false in the base preset, enabled in prompt_order). After the rework, audit the Anchor for redundancy and strip items now covered by the Prose Kernel.

7. **Exemplar system interaction:** The `_exemplars` slot injects flagged good prose. The exemplar system already tags by mode and category. The mode prose entries and exemplars should reinforce each other — mode entry says what technique to use, exemplar shows what it looks like when done well. No conflict, but the exemplar injection prompt (`"Match the structural strengths..."`) could reference the active mode prose entry for better specificity.

---

## Verification

1. **Syntax check all changed files:**
   ```bash
   node -c index.js
   node -e "JSON.parse(require('fs').readFileSync('gravity_v14.json','utf8'))"
   node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8'))"
   ```

2. **Verify WI activation:** Enable SillyTavern's World Info debug logging. Start a regular turn — verify `gravity_prose_regular` activates. Press combat button — verify `gravity_prose_combat` AND `gravity_mode_combat_core` both activate. Same for advance and intimacy.

3. **Verify no double-fire:** On a combat turn, verify `gravity_prose_regular` does NOT activate (only combat prose should).

4. **Verify instruction leak fix:** Generate a few turns and check prose output for: "one beat," constraint IDs (C1, C2, col-*), mechanical terms (STRESSED, BREACHED, "collision distance"), or parroted player intent ("I'm staying," "I'm not going anywhere").

5. **Verify mode prose differentiation:** Generate one turn each in regular, combat, intimacy, and advance modes. Compare prose: regular should have subtext and dialogue weight, combat should be compressed and physical, intimacy should be close and sensory, advance should be atmospheric with snap-back.

6. **Token audit:** Check total prompt size with all new content active (Character Voice ON, Dossier Prose ON, mode prose firing). Compare to baseline. Should be within ~200 chars of current total due to Noir Realist slim-down.

## Execution Order

1. Prose Kernel rework (preset) — the foundation everything else builds on
2. Group 5 style slim-down (preset) — recovers token budget for new additions
3. Character Voice module (preset) — new toggle
4. Dossier-Driven Prose update (preset) — add flaw-first decision
5. Mode prose lorebook entries (World Info) — new entries
6. Strip prose from existing mode entries (World Info) — clean separation
7. Extension changes (index.js) — fire prose keywords
8. Anchor audit (preset) — remove redundancy
9. Syntax check + verify
