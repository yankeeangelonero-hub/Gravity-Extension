# Gravity Relationship Module Design

Date: 2026-04-21
Status: Approved (design phase; implementation plan pending)

## Overview

Add a first-class relationship simulation layer to the Gravity Ledger. Relationships between the PC and TRACKED+ characters (and TRACKED+ factions) are represented as tarot-archetyped bonds. Every persistent change to a relationship flows through a collision — the ledger tells the full story of how the bond moved and why.

Today, "how does X feel about PC" is recoverable only by re-deriving it from prose each turn, which drifts. The relationship module gives the LLM a persistent status field (tarot card + orientation + nuance) that updates only through structured events (collision resolutions), with a scene-management layer (phonebook) that gates which relationships inject into the prompt each turn.

This design extends the existing schema — no new core architectural concepts. The tarot vocabulary already exists in `state.divination`; the collision machinery already handles multi-party convergence; character tiers already gate attention budget. The module stitches these together.

## Scope

### In
- New `relationship` entity for PC ↔ TRACKED+ pairs (chars and factions)
- Tarot card + orientation + nuance + status + last_shift per relationship
- Faction tier system (KNOWN/TRACKED/PRINCIPAL) with PRINCIPAL uniqueness
- Scene-management fields on `pc` (`current_place_id`, `scene_cast`) and a lean phonebook injection model
- Tag system on characters for queryable KNOWN roll-ups
- `ignition_class="relational"` convention for collisions that move relationship cards
- Validation across all three layers (consistency / state-machine / self-correcting loop)

### Out
- Char ↔ char (PC not involved) relationship entities — KA covers asymmetric perception already; no edge entity for these pairs
- Multi-card spreads (past/present/future or current/shadow) — single card MVP; `shadow_card` reserved as non-breaking extension if playtesting shows it's needed
- PC's own identity card (separate filed task — see Deferred)
- Minor Arcana cards — Major only (22 cards)
- Migration from existing chat fixtures — fresh chats only

### Deferred
- **PC card / Principal card consolidation** (filed as separate spawned task). The pre-existing divination-adjacent writes are orthogonal to the new relationship module; consolidate them in a separate pass.
- **Shadow card extension.** If the single-card model misses "surface bond vs hidden bond" distinctions during playtesting, add `shadow_card` as an additive non-breaking field. No shadow logic in MVP.

## Architecture

### Entity: `relationship`

```
relationship:pc-<other_id>
  id:              "pc-lacus"          // convention: pc always first
  card:            "the-hermit"        // Major Arcana slug (22 whitelist)
  orientation:     "upright" | "reversed"
  nuance:          "<free text, ~100-word soft cap>"
  status:          "active" | "dormant" | "archived"
  last_shift:      null | {            // null at birth; set on first collision resolve
    tx:            234,
    collision_id:  "lacus-first-step",
    from:          { card: "the-fool", orientation: "upright" },
    to:            { card: "the-hermit", orientation: "reversed" },
    reason:        "She named what he was avoiding; he withdrew."
  }
```

Cards use kebab-case Major Arcana slugs. The 22-slug whitelist:

```
the-fool, the-magician, the-high-priestess, the-empress, the-emperor,
the-hierophant, the-lovers, the-chariot, strength, the-hermit,
wheel-of-fortune, justice, the-hanged-man, death, temperance, the-devil,
the-tower, the-star, the-moon, the-sun, judgement, the-world
```

### Schema Additions

**`pc` singleton:**
```
pc.current_place_id:  "place:<id>"          // PC's current physical location
pc.scene_cast:        ["char:<id>", "faction:<id>", ...]   // active cast for the current stage
```

**`faction` entity:**
```
faction.tier:         "KNOWN" | "TRACKED" | "PRINCIPAL"   // max 1 PRINCIPAL
```

**`char` entity:**
```
char.tags:            ["kebab-case", ...]   // optional, max 5, each ≤ 40 chars
```

### Collisions — `ignition_class="relational"`

Relational collisions are ordinary collisions with a specific convention:
- `ignition_class: "relational"`
- `involved_chars: [pc, <other>]` (exactly one non-pc party — a char or faction)
- `fires_when` names the fork (e.g., "PC confronts Lacus about the Manifold signal")
- On RESOLVED or CRASHED, the same ledger block must update `relationship:pc-<other>` via explicit `S` ops

Same-turn orientation flips use `distance_category: "IMMEDIATE"` — arrives and resolves that turn.

## Lifecycle Rules

### Birth (not a change — exception to "every change is a collision")

Relationship entities are born at the moment a character or faction reaches TRACKED+.

- **`CR char:<id>`** with `tier ∈ {TRACKED, PRINCIPAL}` → same ledger block must `CR relationship:pc-<id>` with initial card/orientation/nuance drawn by the LLM.
- **`TR char:<id> field=tier from=KNOWN to=TRACKED`** → same rule.
- **`CR faction:<id>`** with `tier ∈ {TRACKED, PRINCIPAL}` → same rule. A faction created without a tier defaults to KNOWN (no relationship entity).

The LLM chooses the initial card based on accumulated KA, demonstrated_traits, recent reads, and scene context. No collision is required for birth. At birth, `last_shift` is `null` — there is no prior state to record. The first relational collision to resolve sets `last_shift` to its first complete value.

### Change (always a collision)

A relationship's card, orientation, or nuance can only change via a resolving relational collision. In the same ledger block as the collision's status transition to RESOLVED or CRASHED, the LLM must write:

- `S relationship:pc-<other> field=card value=<new>` (if card changes)
- `S relationship:pc-<other> field=orientation value=<new>` (if orientation flips)
- `S relationship:pc-<other> field=nuance value=<new>` (always, to describe the post-shift state)
- `S relationship:pc-<other> field=last_shift value={tx, collision_id, from, to, reason}` (always)

No free-text shifts, no direct `S` ops outside a collision resolve. Micro-shifts (subtle strain within a single scene) still require a collision — declared as `distance_category: "IMMEDIATE"`, which arrives and resolves on the same turn.

### Dormancy (demotion)

Status transitions are engine-driven — the LLM does not write them. This keeps the "every relational content change is a collision" rule unambiguous: `card`/`orientation`/`nuance`/`last_shift` are LLM-written inside collision resolves; `status` is engine-written on tier movement or death.

- **`TR char:<id> field=tier from=TRACKED to=KNOWN`** → engine auto-`S relationship:pc-<id> field=status value=dormant`. LLM does not need to write this explicitly.
- Dormant relationships stop rendering in state-view by default, **except** when `char.location == pc.current_place_id` — they re-inject compactly (the on-stage-by-location rule).
- Re-promotion (`KNOWN → TRACKED`) → engine auto-`S status=active`. The card/orientation/nuance remain as they were at the moment of dormancy. If the LLM wants a fresh draw to reflect time passed, it must schedule a relational collision on the next interaction (respecting the "every change is a collision" rule).

### Death (permanent archive)

- **`D char:<id>`** or **`D faction:<id>`** → engine auto-`S` on `relationship:pc-<id>` with `status=archived`. The relationship's current `card`/`orientation` become the memorial state. If `last_shift` is still `null` (char D'd before any relational collision resolved), the memorial simply shows the birth card; no final-shift line renders.
- Archived relationships never re-activate via direct state change. They render at the bottom of the relationship block as a compact memorial line.

**Semantic note — `D` is for permanent destruction only.** Fake deaths, presumed-dead scenarios, and resurrections should NOT issue `D`. Use tier demotion (`TR char:<id> field=tier from=TRACKED to=KNOWN`) with `last_seen_at` to mark a character as offscreen-assumed-gone. KA updates on other characters handle "PC thinks they're dead"; the reveal later is a KA correction, not an entity-level change. If `D` was issued in error and must be reversed, use the standard `AMEND` transaction machinery.

## Scene Management (Phonebook)

### Lifecycle by turn mode

| Turn mode | Cast behavior |
|---|---|
| `integration` (setup wizard) | LLM declares initial `pc.current_place_id` + `pc.scene_cast` as part of setup |
| `advance` (world moves / timeskip) | LLM **replaces** `pc.scene_cast` for the new stage |
| `regular` (player prose) | LLM **appends only** — `A pc field=scene_cast value=char:<id>` on character entry |
| `regular` (engine auto) | Engine auto-adds collision `involved_chars` to cast when a collision arrives at distance 0 on PC's stage |

Entries-only, no mid-stage removals. A character stepping out briefly stays in cast until the next `advance` rewrites it — this matches episodic structure (an actor in Scene 2 and Scene 4 is still in the episode cast).

### Auto-cast rules

- **PRINCIPAL faction:** always in cast; engine adds on advance if missing
- **PRINCIPAL char:** not auto-cast — can be off-stage (a principal on another thread is narratively valid)
- **`D char:<id>`** or **`D faction:<id>`:** engine removes from cast

### Injection scope — the "lean phonebook"

| State | What renders in state-view |
|---|---|
| **In cast, TRACKED+** | Full dossier — name, tier, agenda, KA, constraints, tarot card, nuance |
| **Off-stage PRINCIPAL** | One-liner — `PRINCIPAL: <name> — last seen at <place> · <card> <orientation>` |
| **Off-stage TRACKED** | Compact line — `TRACKED: <name> @ <last_location> · last tx <n> ago` (no card) |
| **Off-stage dormant, on-stage by location** | Compact line with card — re-injects when `char.location == pc.current_place_id` |
| **KNOWN (active, top 15)** | One-line: `<name> [tag, tag, tag]` — tags primary, agenda optional fallback |
| **KNOWN (beyond 15)** | Names-only trailing roll-up |

KNOWN characters use tags (up to 5 per character) as their primary descriptor. Tags are queryable — the LLM can filter by "who's a smuggler" or "who knows the Manifold signal" when deciding who to pull into a scene. The 15-most-recently-active cap prevents balloon on long chats.

## Rendering

### state-view.js — prompt injection format

Relationship block sits inside each in-cast character's dossier, directly below `Agenda:`. The `♥` glyph anchors it visually in the prompt stream (can be swapped for a text token like `RELATIONSHIP:` if glyph handling is model-unreliable).

```
CHARACTER: Lacus Clyne [PRINCIPAL]
    Location: place:archangel-medbay
    Tags: [idol, coordinator, orb-royalty]
    Agenda: Find a response to the war that isn't choosing a side.
    ♥ Bond (PC): The Hermit · reversed
      "Hermit because he won't come down from the mountain even
       when Lacus climbs up to him. Last shift at tx 234 after
       she named what he was avoiding."
    KA: knows_manifold_signal: "Sensed resonance in corridor..."
    (constraints, intimate_history, key_moments as today)
```

Faction relationships render identically inside each in-cast faction's block.

### Relationship linkage in collision render

When a relational collision appears in the active pool, state-view tags the pair:

```
COLLISIONS (active, closest first):
  lacus-rupture · distance 2 · ignition_class=relational · [PC ↔ Lacus]
    forces: She discovered what he's hiding about the Manifold signal.
    cost:   When it fires, the bond shifts — Hermit reversed → Tower upright.
```

Reinforces the "every change is a collision" rule right where the LLM is writing the resolution.

### ui-panel.js — floating DOM panel

New section at the top of each character's dossier card, above the existing KA section:

```
┌─────────────────────────────────────────────┐
│ LACUS CLYNE              PRINCIPAL          │
│ ♥ THE HERMIT · reversed                     │
│    "Hermit because he won't come down..."   │
│ AGENDA: Find a response to the war...       │
│ KA: (existing rendering)                    │
└─────────────────────────────────────────────┘
```

Upright cards get a muted gold accent; reversed cards get muted red. Archived relationships render collapsed at the bottom as memorials — one click to expand the final `last_shift` block.

## Validation

Three layers, matching existing architecture.

### Layer 1 — `consistency.js` (shape validation, hard reject)

- `CR relationship:*` requires: `id` matching `pc-<other_id>`, `card` ∈ whitelist, `orientation` ∈ {upright, reversed}, `nuance` non-empty
- Card slug must match one of the 22 Major Arcana
- `status` ∈ {active, dormant, archived}
- `last_shift` must be either `null` (birth state, before first relational collision resolves) or a complete object with all five fields (`tx`, `collision_id`, `from`, `to`, `reason`)
- `faction.tier` ∈ {KNOWN, TRACKED, PRINCIPAL}
- `char.tags` array of strings, max 5 elements, each ≤ 40 chars
- `pc.scene_cast` array of valid `char:<id>`/`faction:<id>` refs
- `pc.current_place_id` must be `place:<id>`

### Layer 2 — `state-machine.js` (transition validation, hard reject)

- `relationship.status`: `active ↔ dormant`, any → `archived` terminal. No `archived → *`
- `faction.tier`: flexible transitions; PRINCIPAL uniqueness enforced — second PRINCIPAL assignment rejects
- Cannot `CR relationship:pc-<id>` unless target exists with tier ≥ TRACKED
- Cannot `D` a char/faction currently in `pc.scene_cast` — must exit cast first (prevents dangling refs)

### Layer 3 — Self-correcting loop (soft warning, injected correction)

Failed pairings land but queue a correction nudge for the next turn (matches existing `_inject` slot pattern):

| Violation | Correction |
|---|---|
| Tier promotion without matching relationship CR | Prompt LLM to draw the card now |
| Relational collision RESOLVED without relationship update | Prompt LLM to commit the card/orientation/nuance/last_shift |
| `scene_cast` > 6 entries | Soft warning suggesting prune or advance |
| `char.tags` > 5 | Prompt to trim |

(Status transitions on demotion / re-promotion / death are engine-driven and don't need corrections — the engine writes them directly.)

Drops after 3 failed attempts (matches `MAX_CORRECTION_ATTEMPTS`).

### Replay harness audits

Extend `scripts/replay-fixture.js` with:

- **Relationship audit** — for every TRACKED+ char/faction, verify `relationship:pc-<id>` exists with status ≠ archived
- **Collision-relationship pairing audit** — for every RESOLVED relational collision, verify same-block relationship update
- **Tag audit** — flag chars with > 5 tags or oversized tag strings
- **PRINCIPAL uniqueness audit** — count(chars tier=PRINCIPAL) ≤ 1, count(factions tier=PRINCIPAL) ≤ 1
- **Scene cast audit** — flag entries referring to D'd/nonexistent chars/factions

### Deliberately not validated

- **Nuance content** — free text, LLM judgment (soft warn at > 100 words)
- **Tag vocabulary** — emergent; no enforced taxonomy
- **Card "appropriateness"** — The Lovers upright for an enemy is weird but not invalid
- **"Is this collision actually relational?"** — trust the LLM's `ignition_class=relational` declaration

## Integration Points

### Existing modules touched

- **`state-compute.js`** — new entity type `relationship`; CR/S handlers; tier-change auto-effects for archive/dormant; PRINCIPAL-uniqueness enforcement
- **`state-machine.js`** — new transition rules for `relationship.status` and `faction.tier`
- **`consistency.js`** — new shape validators
- **`state-view.js`** — lean phonebook render logic; relationship block; compact off-stage/KNOWN lines
- **`ui-panel.js`** — relationship section in dossier; memorial rendering
- **`index.js`** — cast-change hooks; validation wiring; correction queueing
- **`scripts/replay-fixture.js`** — new audit sections

### Readme/preset implications

- `gravity_v15.json` — document relationship grammar; the ignition_class=relational convention; the tag system
- Encourage LLM to set `char.tags` at CR (especially for KNOWN) so they stay callable
- Encourage LLM to set `faction.tier` at CR for new factions

### Self-correcting loop reuse

New corrections plug into the existing `_inject` slot and correction-queue mechanics. No new injection slot required.

## Trade-offs & Rationale

### Why tarot over fixed tiers

Tarot gives a bounded-but-rich vocabulary (22 × 2 = 44 states) that the LLM already understands intrinsically. Fixed tiers (stranger/friend/enemy) are too rigid for most real relationships. Free-text is too unbounded and drifts. Tarot is the middle path, and it dovetails with the existing divination system's vocabulary — one shared language across the module.

### Why "every change is a collision"

Forces every persistent relational shift to exist in the ledger as a structured event with a reason attached. Produces a complete audit trail. Prevents the LLM from drifting relationship state via unstructured narration. The ceremony cost (declaring even micro-shifts as IMMEDIATE collisions) is acceptable because relational stakes are the most important kind of stakes — they deserve the ledger's attention.

### Why single-card MVP (not shadow)

We're already at heavy LLM cognitive load (cast, cards, nuance, last_shift, collision pool, KA). Doubling the card surface per relationship triples the drift risk. Collision foreshadow + KA already capture most of what a shadow card would do. If playtesting reveals a genuine gap, `shadow_card` is additive and non-breaking.

### Why the lean phonebook

Token budget on long chats is the real constraint. Rendering every TRACKED+ character's full dossier every turn balloons injection cost past the point where the LLM can attend to it. Cast-gated rendering focuses attention on who's *actually on stage* while preserving off-stage context as compact one-liners (PRINCIPAL) or tag-driven lookups (KNOWN).

### Monitored concern — LLM friction on IMMEDIATE relational micro-shifts

A single-scene micro-shift (e.g., a subtle trust strain in one conversation) currently requires ~6 transactions: collision CR (with forces/cost/ignition_class/fires_when/involved_chars/distance_category), collision TR to RESOLVED (with outcome_type + aftermath), plus 4 `S` ops on the relationship entity. That's heavy boilerplate for a small beat, on top of generating engaging prose in the same turn.

The risk is LLM avoidance: rather than take the cognitive hit, the model may simply not flag micro-shifts at all, and the relationship drifts in prose without ledger anchoring.

We're keeping the design as-is for MVP — relaxing the "every change is a collision" rule would re-open the free-text drift problem we specifically designed around. If playtesting shows avoidance, the right mitigation is an **engine-assisted macro**: a shorthand syntax like `RELSHIFT pc-lacus from=upright to=reversed reason="..."` that parses server-side and expands to the full transaction sequence. LLM writes one line; ledger gets the full audit trail. This is a preset/parser-layer optimization, not a state-model change — additive and non-breaking.

Flag: watch for low ratio of relational collisions to narrative relational beats in early playtests. If LLM is narrating shifts but not logging them, the macro is the next move.

## Open Questions (to revisit during implementation)

1. **Cap on active relationships** — should we hard-cap TRACKED+ at, say, 8 per chat? Or let narrative decide? Currently unlimited.
2. **Dormant-archive GC** — do archived relationships ever get pruned from state (e.g., after 100 turns with no re-reference)? Probably no — memorials are emotional weight, cheap to keep.
3. **Faction scene-presence inference** — is a TRACKED faction "on-stage" only if one of its members is in cast? Or when its territory intersects `pc.current_place_id`? Current design: the LLM explicitly adds the faction to `scene_cast` — no inference.
4. **Tag uniqueness** — should tags be globally unique (i.e., "pilot" means the same thing across the chat)? Emergent for now; revisit if drift is an issue.
5. **Readme weight** — how much preset space does this module take? Must trade against existing readme budget.
6. **PRINCIPAL cap (1 vs 2–3).** Currently capped at 1 PRINCIPAL char and 1 PRINCIPAL faction (matches existing Gravity convention). Dual-protagonist narratives (Lacus + Kira, Cloud + Tifa) may want 2. Functional cost of relaxing to 2–3 is tiny (one extra one-liner render per off-stage PRINCIPAL ≈ 50 tokens). Tradeoff: relaxing blurs what PRINCIPAL *means* as a narrative pin. Keep at 1 for MVP; relax if playtesting shows recurring friction on multi-central-character chats.

## Acceptance Criteria

- Fresh chat: creating a PRINCIPAL char triggers relationship CR with card drawn. State-view renders the bond block.
- IMMEDIATE relational collision same turn: flips orientation, updates nuance, records last_shift. State-view reflects the change next turn.
- Demotion: TR char tier TRACKED → KNOWN triggers engine-auto `status=dormant`. State-view stops rendering unless on-stage by location. Re-promotion auto-reactivates; card only changes via a subsequent collision.
- `D char`: relationship auto-archives with final `last_shift`. Memorial renders at bottom.
- PRINCIPAL faction: contested assignment rejects second PRINCIPAL; LLM must demote first.
- Phonebook: advance turn rewrites `scene_cast`; regular turn appends only; off-stage TRACKED collapses to compact line; off-stage KNOWN renders as tag-list with 15-cap.
- Replay harness: fresh session dump passes all new audit sections showing `(none)`.

## Next

Invoke `superpowers:writing-plans` to produce the implementation plan (module-by-module task breakdown, in order).
