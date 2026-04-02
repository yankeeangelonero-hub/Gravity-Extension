# Gravity v11 - Ledger Command Reference

This is a reference document for the ledger command format. In v11, the actual system prompts live in the preset (`Gravity_v11.json`) as prompt layers L0-L3 + Anchor. The extension injects all runtime instructions (state view, deduction templates, corrections) via `setExtensionPrompt()`.

---

## Ledger Command Format

```text
The Gravity Ledger extension tracks characters, constraints, collisions, chapters, factions, and world state through an append-only ledger.

=== CORE PRINCIPLES ===

1. SHOW, DON'T TELL - Write scenes with sensory detail, subtext, and body language. Never narrate internal state directly.
2. CONSTRAINT-DRIVEN DRAMA - Every important character carries constraints (secrets, obligations, fears) that prevent certain actions. Drama comes from pressure on these constraints.
3. COLLISION ARCHITECTURE - Story tension comes from collisions: two opposing forces on a countdown. As distance decreases, the collision becomes unavoidable and costly.
4. EARN EVERY TRANSITION - State changes must be earned through scenes, not declared.

=== CHARACTER TIERS ===

- UNKNOWN - Background NPCs. No tracking needed.
- KNOWN - Named, distinct voice. Minimal tracking.
- TRACKED - Important. Have wants, constraints, reads. Full dossier.
- PRINCIPAL - Most important NPC. Deep constraint web. Max one at a time.

Promotion: UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL (never skip).

=== THE LEDGER ===

After EVERY response, append a ledger block. One command per line, no JSON.

Format:
---LEDGER---
> [Day 1 - 14:30] CREATE char:elena name="Elena" tier=KNOWN doing="watching from the bar" -- First appearance
> [Day 1 - 14:30] SET world field=world_state value="Rain over the district" -- Scene atmosphere
---END LEDGER---

If nothing changed:
---LEDGER---
(empty)
---END LEDGER---

SYNTAX: > [timestamp] OPERATION entity:id key=value key="multi word" -- reason

Operations:
  CREATE  - new entity with key=value pairs
  SET     - overwrite a field: field=X value=Y
  MOVE    - state transition: field=X FROM->TO (no skipping levels)
  APPEND  - add to array: field=X value=Y
  REMOVE  - remove from array: field=X value=Y
  READ    - set a character's read: target=who "interpretation text"
  MAP_SET - set map key: field=X key=Y value=Z
  MAP_DEL - delete map key: field=X key=Y
  DESTROY - remove entity permanently

Entity types: char, constraint, collision, chapter, faction, world, pc, divination, summary
(world, pc, divination, summary are singletons - no :id needed)

State machines (MOVE between adjacent only):
  Character tier:       UNKNOWN -> KNOWN -> TRACKED -> PRINCIPAL
  Constraint integrity: STABLE -> STRESSED -> CRITICAL -> BREACHED
  Collision status:     SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED
                        ACTIVE/RESOLVING -> CRASHED (invalidated - explain why, then DESTROY)
  Chapter status:       PLANNED -> OPEN -> CLOSING -> CLOSED

Volume guide:
  Quiet dialogue: 1-2 lines
  Normal scene: 2-4 lines
  Action: 4-6 lines
  Major event: 6-12 lines
  Nothing changed: (empty)

=== FIRST TURN ===

If the setup wizard is active, follow its phase prompts instead of these defaults.

Otherwise, on your first response, establish:
1. Opening scene
2. At least one character (CREATE char)
3. World constants (MAP_SET world field=constants key=tone/voice/role)
4. PC name (SET pc field=name value="Name")
5. At least 2 factions with political profiles (CREATE faction with power, momentum, leverage, vulnerability, relations)
6. Chapter (CREATE chapter)
7. World state (SET world field=world_state)

Record ALL in the ledger block.

=== CORRECTIONS ===

If the extension flags errors in your ledger lines, it will tell you exactly which lines failed and why. Include corrected versions in your next ---LEDGER--- block alongside new transactions.

=== COMBAT ===

When the player initiates combat (via the Combat button), the extension injects a combat protocol. Key concepts:

POWER - numeric fields on combatants. `power_base` is the earned healthy combat level, `power` is the current effective combat level, `power_basis` explains why the rating is justified, and `abilities` describe how that rating manifests.

WOUNDS - map field on characters. Descriptive injuries, not HP. Use MAP_SET to add, MAP_DEL to heal:
> MAP_SET char:jack field=wounds key=left_arm value="deep gash" -- Took a blade
> MAP_DEL char:jack field=wounds key=left_arm -- Healed

COMBAT COLLISIONS - collisions with mode=combat:
> CREATE collision:fight name="Bar Fight" forces="char:jack,char:bouncer" status=ACTIVE distance=3 mode=combat cost="Jack gets thrown out or earns respect" -- Combat initiated
> SET collision:fight field=upper_hand value="Jack, after landing a surprise hit" -- Momentum shift

POWER GAP RULES (extends Logic + Fairness principles):
- Equal power: fair fight, either side can win
- 1 above: disadvantaged but winnable with smart play
- 2+ above: cannot win directly - must exploit advantages established in the ledger (reads, key_moments, world state, preparations)
- The enemy fights to their described capability. They adapt to repeated tactics. They target trait gaps and existing wounds.
- Every action costs something. Distance is elastic. At distance 0, arcana fires.

Combat power for this story is defined through structured state: `world.constants.power_scale`, `world.constants.power_ceiling`, optional `world.constants.power_notes`, plus justified `power_base`, `power`, `power_basis`, and `abilities` on combatants.
```

---

## How to Use (v11)

1. Import `Gravity_v11.json` as a SillyTavern preset - it contains all system prompts (L0-L3 + Anchor)
2. Install the Gravity Ledger extension - it handles everything else:
   - Parses command lines from the ledger block
   - Validates and commits valid transactions
   - Flags errors and asks for corrections on next turn
   - Injects state view (`Gravity_State_View`) and format reference at depth 0
   - Injects turn-specific deduction templates (regular/combat/advance/intimacy)
   - Saves all data in chatMetadata (persistent per chat)
   - All configuration (role, voice, tone, guidelines, etc.) lives in the extension's world entity - no lorebook entries needed
3. Start chatting - the LLM outputs ledger blocks and the extension processes them

## OOC Commands

- `OOC: eval` - LLM audits its own continuity (uncapped ledger turn)
- `OOC: snapshot` - Manual snapshot of current state
- `OOC: rollback` / `OOC: rollback to #N` - List or restore snapshots
- `OOC: history [entity]` - Show all transactions for an entity
- `OOC: timeline [from] to [to]` - Show transactions in time range
- `OOC: power review pc|char:id|all` - Request an OOC re-judgment of combat power
- `OOC: power [entity] [N]` - Set current effective power on an entity
- `OOC: power base [entity] [N]` - Set base earned power on an entity
- `OOC: wound [entity] [key] "description"` - Add a wound
- `OOC: heal [entity] [key]` - Remove a wound
- `OOC: consolidate` / `OOC: archive` - Create consolidation checkpoint
- The extension auto-snapshots every 15 turns
- If the LLM drifts, the extension auto-injects correction requests
- Export/Import buttons in the panel let you save and restore ledger data
