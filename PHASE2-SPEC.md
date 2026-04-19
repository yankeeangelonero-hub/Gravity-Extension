# Gravity Ledger — Phase 2 Specification

**Branch:** `codex-v13-state-delta`  
**Status:** Design agreed, implementation in progress  
**Scope:** Ledger entity redesign, collision mechanics redesign, engine-owned math, validateTransition wiring, challenge extensibility

### Partial Implementations Already on Branch

Several Phase 2 features have landed on the codex branch. Implementation tasks must build on these, not rewrite them:

| Commit | What landed | Impact on task |
|---|---|---|
| `aea6598` | Distance compression engine (tick multipliers, category mapping) | Task 5 (`§3.2`) — modify existing logic, not write from scratch |
| `0928d88` | Combat entity thinning (exchange bookkeeping removed) | Task 9 (`§7.2`) — build on existing work, verify schema matches spec |
| `8a47eb8` | Nudge prompt simplification | Task 14 (`§4.4`) — extend existing nudge system |
| `d3f505c` | Pressure/collision tier scaffolding (flash/arc/saga tier system) | Task 11 (`§2.5/§4.1`) — **strip the flash/arc/saga tier system**; this spec uses only `distance_category` (IMMEDIATE/SHORT/MEDIUM/LONG) |
| `355ea87` / `997a31f` | Four-map knowledge asymmetry (`knows`/`unknown`/`hiding`/`misreading`) | Spec now adopts this schema — §2.1, §2.3, §2.8 updated below |

---

## 1. Overview

Phase 2 has four primary goals:

1. **Ledger entity redesign** — five tracked entity types (characters, collisions, factions, places, pressure points). Chapters stripped. Combat is ephemeral. Story summary is gone (Phase 1 done). Places are new and enable proximity-aware sanity checks. Pressure points are raw narrative seeds that feed collision creation.
2. **Engine-owned collision math** — distance categories with canonical starting values, timeskip multipliers, IMMEDIATE same-turn firing, foreshadowing at percentage thresholds.
3. **Redesigned arrival mechanics** — sanity check gate (ON-SCREEN / OFF-SCREEN / IMPLODE) before a single decisive arrival injection. Multi-turn oracle escalation removed. Tarot draw retained.
4. **State machine enforcement** — wire `validateTransition()` into the turn pipeline. Chapter state machine removed along with the entity.
5. **Pressure Economy** — pressure points as raw narrative seeds (capped at 5, FIFO), collision feeding mechanics, capped collision pool (max 5 active), and a rotating per-turn nudge that spreads ledger maintenance across normal play instead of stacking it on advance turns.

### Out of Scope for Phase 2

- Constraint system (`STABLE → STRESSED → CRITICAL → BREACHED`) — unchanged, filed for future refactor into challenge system.
- Yi Jing / I Ching divination — strip is Phase 1 work. If not yet done, complete it before Phase 2 begins. Tarot (Arcana) and Classic (2d10) are retained.
- Story summary — stripped in Phase 1. Nothing in the spec should reference it.

---

## 2. Ledger Entity Redesign

The ledger tracks only what the engine computes on or the LLM needs as structured reference. Five active entity types.

### Entity-to-State-Key Reference

All code samples and implementation notes use these exact key names. Do not substitute aliases.

| Entity type | Ledger prefix | State key | Access pattern |
|---|---|---|---|
| `char` | `char:<id>` | `state.chars` | `state.chars[id]` |
| `collision` | `collision:<id>` | `state.collisions` | `state.collisions[id]` |
| `faction` | `faction:<id>` | `state.factions` | `state.factions[id]` |
| `place` | `place:<id>` | `state.places` | `state.places[id]` |
| `pressure` | `pressure:<id>` | `state.pressures` | `state.pressures[id]` |
| `world` | `world` | `state.world` | `state.world` (singleton) |

### 2.1 Characters (`char`)

**Purpose:** Active characters the engine needs to track state for.

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `tier` | enum | `UNKNOWN → KNOWN → TRACKED → PRINCIPAL` — engine validates transitions |
| `faction` | string | Faction ID this character belongs to |
| `constraints` | array | Inline constraints with integrity state (`STABLE → STRESSED → CRITICAL → BREACHED`) |
| `agenda` | string | **TRACKED and PRINCIPAL only.** Narrative compass — what this character is working toward. The LLM reads this to find collision seeds. UNKNOWN/KNOWN chars omit this. |
| `knowledge_asymmetry` | map | Four named categories: **knows** (relevant things this char knows), **unknown** (important blind spots), **hiding** (secrets actively concealed), **misreading** (false beliefs held as true) |
| `key_moments` | array | **PRINCIPAL only.** Up to 100 self-contained moment entries tracking significant beats with the PC. TRACKED/KNOWN/UNKNOWN chars omit this. |
| `power` | number | Combat power rating |
| `abilities` | array | Named abilities (used in combat) |
| `wounds` | array | Active wounds affecting capability |
| `relationships` | map | Keyed by entity ID (PC, other chars, factions) — brief relational descriptor. **Narrative color only — not queried by engine logic.** |
| `location` | place ID | Points to a `place` entity. **Only tracked for TRACKED, PRINCIPAL, and the PC.** KNOWN and UNKNOWN chars omit this. |

**Tier rules:** UNKNOWN chars are background entities. KNOWN have names and basic profile. TRACKED are active enough to warrant location tracking. PRINCIPAL are central to current arcs and get full dossier treatment in the state view.

**Agenda** (TRACKED and PRINCIPAL only) is a narrative compass — not a task list or objective marker, but the general direction this character is pushing. What are they working toward? What do they want? The LLM reads it to generate collision seeds: when two characters' agendas intersect or conflict, that's friction worth tracking.

Examples:
- `"Consolidating control over the eastern district before the rival faction notices"`
- `"Finding proof that the outbreak was deliberate, regardless of who gets hurt"`
- `"Getting close enough to PC to extract intel, while fighting genuine attachment"`

Set on creation or tier promotion: `S char:<id> field=agenda value="..."`. Update via `S` when the character's direction shifts — constraint breach, major collision outcome, or revelation that reorients them. UNKNOWN and KNOWN chars do not get agendas; they are not narratively important enough to warrant it.

**Knowledge asymmetry** is not a general knowledge inventory. It uses four named categories as natural organizational buckets:

- **`knows`** — Relevant things this character knows. Information with narrative weight: intel they could act on, leverage they hold, facts that shape their decisions.
- **`unknown`** — Important things this character does NOT know. Exploitable blind spots, ticking problems, facts others have that this one lacks.
- **`hiding`** — Secrets this character is actively concealing. Information they possess but are suppressing, misdirecting, or lying about.
- **`misreading`** — Things this character believes incorrectly. False assumptions they're operating on — wrong about someone's loyalty, motive, or the state of the world.

Each entry uses a **unique descriptive key** within its category. The category prefix is the key prefix: `knows_`, `unknown_`, `hiding_`, `misreading_`. Multiple independent entries per category are supported.

```
MS char:<id> field=knowledge_asymmetry key=knows_outbreak value="Knows the outbreak was deliberate"
MS char:<id> field=knowledge_asymmetry key=unknown_inner_circle value="Unaware their inner circle is compromised"
MS char:<id> field=knowledge_asymmetry key=hiding_employer value="Concealing their true employer from the PC"
MS char:<id> field=knowledge_asymmetry key=misreading_loyalty value="Believes Leon is still loyal to Umbrella"
```

Remove by key when resolved: `MR char:<id> field=knowledge_asymmetry key=hiding_employer`. The same four-category structure applies to factions (§2.3).

**Cap: 20 entries across all four categories combined.** Engine auto-trims by insertion order when exceeded.

**NESCIENCE discipline** — Knowledge management rules for avoiding LLM omniscience: see §2.8.

**Key moments** (PRINCIPAL characters only) track up to 100 significant beats with the PC that define the relationship. Each entry is self-contained — written so the LLM can pull it cold 300 turns later and immediately use it as a narrative hook. Format:

```
[moment] <tight scene beat — what happened, written so anyone can picture it cold>
[hook] <concrete handles for reuse — physical detail, emotional thread, callback dialogue>
[weight] <why this matters — turning point, trust marker, betrayal, revelation, etc.>
```

Example:
```
[moment] Ada held PC at gunpoint in the clock tower but lowered her weapon. PC saw her hand shaking. Neither acknowledged it.
[hook] physical — Ada's trigger hand; emotional — the unspoken understanding; callback — "you had the shot"
[weight] turning point — first crack in Ada's professional detachment
```

Moments can capture dialogue exchanges, shared objects, witnessed events, or private acts. The LLM creates entries as significant moments occur. To add: `A char:<id> field=key_moments value="[moment] ... [hook] ... [weight] ..."`. Entries are never edited — if a moment's meaning shifts, add a new entry that references it. Cap is 100 entries; when full, the LLM drops the oldest or least load-bearing entry before adding. To drop: use `S char:<id> field=key_moments value=[...]` with the full array minus the removed entry. This is infrequent given the high cap, but the technique is explicit — no partial-edit operations exist for arrays.

**State view injection:** `state-view.js` injects the last 10 `key_moments` entries per PRINCIPAL character into the state view each turn. TRACKED/KNOWN/UNKNOWN chars omit this section.

**Relational data authority** — three fields describe relationships between entities, each serving a distinct purpose. Do not substitute one for another:

| Field | Authority for | Engine reads? |
|---|---|---|
| `faction.members` | Faction composition | Yes — for faction-level logic |
| `collision.involved_chars` | Collision proximity / entanglement | Yes — for proximity check at arrival |
| `char.relationships` | Narrative color (display only) | No — never queried by engine |

### 2.2 Collisions (`collision`)

**Purpose:** Engine-owned countdown to a narrative forcing function.

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Short descriptive label |
| `distance_category` | enum | `IMMEDIATE / SHORT / MEDIUM / LONG` — LLM sets on creation, engine resolves numeric distance |
| `distance` | number | Live countdown value, engine-owned |
| `status` | enum | `ACTIVE → RESOLVED`, or `ACTIVE → CRASHED` (arrival ignored — forces acted without characters) |
| `forces` | string | What narrative pressures are driving this collision |
| `involved_chars` | array | Character IDs whose fates are entangled with this collision |
| `location` | place ID | Where this collision is anchored. Used in proximity sanity check at arrival. |
| `outcome_type` | enum | On resolution: `DIRECT / EVOLVED / MERGED / IMPLODED / DISSOLVED / CRASHED`. Set alongside the terminal `TR`. `CRASHED` outcome_type pairs with `CRASHED` status to confirm how it ended. `DISSOLVED` marks a quiet off-screen end with no successor. |
| `aftermath` | string | What permanently changed after resolution |
| `successor_collision_ids` | array | If EVOLVED — new collisions this spawned. Append with `A`, not `S`. |
| `parent_collision_ids` | array | If MERGED — prior collisions that fused into this |

#### 2.2.1 Collision Archive

When a collision reaches a terminal status (RESOLVED or CRASHED), the **LLM writes** a hookable archive entry as part of the same ledger block as the terminal `TR`. The archive persists in the ledger under `world.collision_archive` as an append log.

**Resolved collision entities persist in the ledger** — they are not deleted. The archive entry is a separate narrative digest for future reuse, not a replacement for the entity itself. Pointer integrity (e.g. `parent_collision_ids`, `successor_collision_ids`) depends on the entity remaining.

**Cap: 20 entries.** Engine auto-trims to `MAX_COLLISION_ARCHIVE = 20` after each append — oldest entry dropped. This is engine-side; the LLM does not need to manage the cap.

**Validation:** The engine checks for a `world.collision_archive` append when processing a terminal collision `TR`. If missing, it queues a correction: `"Missing archive entry for resolved collision ${id}. Add: A world field=collision_archive value=\"...\""`. Cleared when the append is received.

**Dropped correction fallback:** If the archive correction is dropped after `MAX_CORRECTION_ATTEMPTS` (3), the engine auto-generates a minimal archive entry from the collision entity's existing fields (`name`, `forces`, `involved_chars`, `outcome_type`) and appends it. The entry lacks narrative hooks but preserves pointer continuity for archive-based seeding.

**Entry format** (written by the LLM at resolution time, designed to be reusable 300 turns later):

```
[collision] <name — what the collision was about>
[resolution] <how it resolved — on-screen event, off-screen mutation, void, or merged>
[hook] <concrete handles for future use — consequences still rippling, relationships changed, new tensions seeded>
[aftermath] <what changed in the world because of this collision>
```

Example:
```
[collision] Syndicate's evidence purge
[resolution] on-screen — PC interrupted the burn, partial files recovered
[hook] physical — the half-burned dossier; relational — Syndicate now knows PC's face; tension — incomplete evidence still dangerous
[aftermath] Syndicate shifted from suppression to active elimination; PC holds leverage but can't use it safely
```

**LLM writes the entry as part of resolution** — in the same ledger block as the terminal `TR`:
```
A world field=collision_archive value="[collision] ... [resolution] ... [hook] ... [aftermath] ..."
```

**State view injection:** When the active collision pool drops to 2 or fewer, the last 5 archive entries are appended to the `_state` slot by `state-view.js`. This surfaces dormant consequence threads for reactivation without cluttering the view when the collision pool is healthy. The engine tracks `_archiveInjectedVersion` (hash of last injected archive + pool count) to re-inject only when the archive gains a new entry or the pool count crosses the ≤2 threshold — preventing redundant injection on consecutive turns. `_archiveInjectedVersion` is **in-memory only** — it is not persisted in `chatMetadata`. It resets on page reload, which may cause one redundant injection on the first turn after reload.

**Purpose:** Archive entries are fuel for future collision seeding and pressure point generation. A collision that resolved 50 turns ago can seed a new one because its aftermath — with concrete hooks — is still sitting in the archive. The nudge system references the archive when the collision pool runs low (§4.3).

#### 2.2.2 Collision Sources — What Can Collide

Collisions can arise from any combination of PC, characters, factions, pressure points, archived collisions, and places. The LLM should consider all of these when seeding pressure points and creating collisions. Valid source pairings:

| Source | Description |
|---|---|
| **PC vs Character** | PC's actions clash with a tracked/principal character's agenda |
| **Character vs Character** | Two NPCs' agendas collide; PC gets caught in the middle or picks a side |
| **PC vs Faction** | PC runs afoul of a faction's goals or territory |
| **Character vs Faction** | An NPC's agenda conflicts with their own or another faction — internal power struggles, defections, betrayals |
| **Faction vs Faction** | Two factions' agendas clash — war, territory disputes, resource competition |
| **Pressure coalescence** | Unrelated small tensions accumulate until combined into a collision; no single source, just enough friction in proximity |
| **Archive echo** | A resolved collision's aftermath (from §2.2.1) seeds a new one; consequences from 50 turns ago ripple forward |
| **Place vs anyone** | A place's state changes — disaster, resource depletion, contamination, occupation — forcing a collision on whoever's there |

This list is not exhaustive. Any two agendas, knowledge asymmetries, or world state changes that create irreconcilable friction are valid collision material. The `involved_chars` field supports multiple parties; collisions don't have to be binary.

### 2.3 Factions (`faction`)

**Purpose:** Structured reference for group actors.

**Fields:** `name`, `members` (char ID array), `territory` (place ID array), `state` (one-word status — e.g. `active`, `weakened`, `collapsed`), `agenda` (string), `knowledge_asymmetry` (map).

`territory` is an array set by full-array `S` overwrite. `A` is also supported for appending individual place IDs: `A faction:<id> field=territory value=place:<place-id>`.

Factions are reference entities — the engine doesn't compute on them beyond injecting them into the state view. LLM updates them as the narrative evolves.

**Agenda** is the faction's overarching direction — the same concept as character agenda, applied at group scale. Not a task list: a narrative compass the LLM uses to find friction with other factions, characters, and the PC.

Examples:
- `"Expanding territory into neutral zones while maintaining plausible deniability"`
- `"Purging infected zones at any cost — civilian casualties are acceptable losses"`

Set: `S faction:<id> field=agenda value="..."`. Update when the faction's direction shifts due to leadership change, major loss, or collision outcome.

**Knowledge asymmetry** follows the same four-category structure as characters (§2.1):

- **`knows`** — Intel this faction possesses and can act on.
- **`unknown`** — Critical gaps they haven't detected. What other actors could exploit.
- **`hiding`** — Information the faction is actively suppressing or concealing from others.
- **`misreading`** — False assumptions the faction is operating on — wrong about another faction's strength, an NPC's loyalties, or the current state of play.

Examples:
```
MS faction:<id> field=knowledge_asymmetry key=hiding_outbreak value="Suppressing knowledge that the outbreak was deliberate"
MS faction:<id> field=knowledge_asymmetry key=unknown_infiltration value="Unaware their inner circle has been compromised"
MS faction:<id> field=knowledge_asymmetry key=misreading_alliance value="Believes the northern faction is still neutral"
```

Same keying convention: `knows_`, `unknown_`, `hiding_`, `misreading_` prefixes. Remove by key with `MR` when exposed or resolved. Cap: 20 entries across all categories combined, engine auto-trims. NESCIENCE discipline applies — see §2.8.

### 2.4 Places (`place`)

**Purpose:** Persistent location records. Enable the engine to reason about proximity at collision arrival, and give the LLM accurate spatial memory when revisiting locations.

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `state` | string | `safe / contested / hostile / destroyed / unknown` — or freeform |
| `description` | string | One or two sentences: what this place is, what makes it notable |
| `reach` | enum | `LOCAL / DISTRICT / CITY / REGIONAL / REMOTE` — travel scale, used for plausibility checks |

**Why places matter:**

- Characters at tier TRACKED or higher have a `location` field pointing to a place ID. The engine can check whether characters involved in a collision share the same location as the collision's anchored place.
- At collision arrival, this proximity check informs the sanity check prompt — if the involved characters are elsewhere, the engine signals that an ON-SCREEN resolution may be implausible.
- Places persist in the ledger with their state, so the LLM can accurately describe a location it visited ten sessions ago rather than reinventing it.

**LLM creates places as the narrative discovers them.** There is no pre-populated place list. If the story enters a warehouse district for the first time, the LLM creates it.

#### Travel Plausibility Check

When the LLM emits `S char:<id> field=location value=<place-id>` on a non-advance turn, the engine validates that the move is plausible within the 15-minute global time cap.

**`reach` scale:**

| Value | Meaning | On-foot in 15 min? |
|---|---|---|
| `LOCAL` | Same building, block, or immediate area | Yes |
| `DISTRICT` | Same city district or neighborhood | Marginal — allowed with a note |
| `CITY` | Across town | No — requires advance or vehicle justification |
| `REGIONAL` | Different city or area | No |
| `REMOTE` | Requires special transport (another country, orbit, etc.) | No |

**Validation logic** (runs in `consistency.js` or a new `validateTravel()` called from the `S` handler):

```javascript
const TRAVEL_REACH_ORDER = ['LOCAL', 'DISTRICT', 'CITY', 'REGIONAL', 'REMOTE'];
const ON_FOOT_MAX = 'DISTRICT'; // highest reach allowed on a non-advance turn

function validateTravel(charId, fromPlaceId, toPlaceId, state, turnMode) {
    if (turnMode === 'advance') return { valid: true }; // timeskip, no constraint
    const fromPlace = state.places?.[fromPlaceId];
    const toPlace = state.places?.[toPlaceId];
    if (!fromPlace || !toPlace) return { valid: true }; // can't validate without data
    if (fromPlaceId === toPlaceId) return { valid: true }; // no move

    const fromIdx = TRAVEL_REACH_ORDER.indexOf(fromPlace.reach || 'LOCAL');
    const toIdx = TRAVEL_REACH_ORDER.indexOf(toPlace.reach || 'LOCAL');
    const maxIdx = TRAVEL_REACH_ORDER.indexOf(ON_FOOT_MAX);

    // `reach` describes the place's own scale, not inter-place distance.
    // Flag the move if EITHER place is CITY or larger — implies crossing a scale boundary
    // that exceeds on-foot travel in 15 minutes.
    if (toIdx > maxIdx || fromIdx > maxIdx) {
        return {
            valid: false,
            error: `Travel from "${fromPlace.name}" (${fromPlace.reach}) to "${toPlace.name}" (${toPlace.reach}) is implausible in a 15-minute scene window.`,
            fix: `Use an ADVANCE turn to timeskip travel, or add a narrative justification (vehicle, special transport) before the location change.`,
        };
    }
    return { valid: true };
}
```

Failed travel checks join the corrections queue — same path as invalid state transitions. The LLM receives the error and fix suggestion and can either use an advance turn or amend the move with a justification field.

**Implementation note:** `state-compute.js` normalizes missing `reach` to `LOCAL` on `CR`. The `reach || 'LOCAL'` null guard in `validateTravel` is therefore unreachable but harmless to keep.

**This is light validation, not a travel system.** The engine does not simulate routing or distances. The LLM still narrates the journey. The check only fires when `reach` values exist on both places and the destination is beyond the on-foot threshold for a non-advance turn. If `reach` is absent on either place, the check is skipped.

### 2.5 Pressure Points (`pressure`)

**Purpose:** Raw narrative seeds — small tensions that haven't coalesced into a collision yet. They are consumed when they feed a collision or resolve naturally.

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Short label — what the tension is |
| `source` | string | Character, faction, or event that generated it |
| `related_to` | array | Optional links to char IDs, faction IDs, or collision IDs |
| `created_at_tx` | number | Engine-set on CR — transaction index at creation. Used for FIFO ordering. **LLM must not set this field.** |

Cap: **max 5 active pressure points (FIFO).** When a 6th is added, the engine drops the oldest by `created_at_tx`. `WEEKS` and `MONTHS` timeskips clear all pressure points — stale small tensions are no longer current after a long skip. See §4 for feeding mechanics, seeding-when-empty invariant, and the rotating nudge system.

**Implementation note:** `state-compute.js` maintains a `_txIndex` counter (incremented on every applied transaction). On pressure `CR`, the engine sets `entity.created_at_tx = _txIndex`. The LLM must not set this field.

**Pressure points are transient.** They exist to be consumed or forgotten. The LLM should apply rule of cool — keep the dramatically interesting ones alive by feeding them into collisions, and let the boring ones fall off naturally via FIFO. A pressure point that hasn't generated a collision after a few turns isn't a failure; it's kindling that didn't catch. The cap enforces this by evicting stale entries automatically.

### 2.6 World (`world`)

**Purpose:** Global singleton, engine-created at ledger init. Tracks transient engine-readable state. The LLM does not create or destroy it — only sets fields on it.

**Phase 2 fields:**

| Field | Type | Notes |
|---|---|---|
| `timeskip_scale` | enum | `HOURS / DAYS / WEEKS / MONTHS` — LLM sets each advance turn; engine consumes and resets to null after ticking collision clocks |
| `collision_archive` | append log | Last `MAX_COLLISION_ARCHIVE` (20) resolved collision entries. Engine auto-trims oldest after each `A` append. |

These are the only two world fields Phase 2 touches. Other pre-existing world fields (e.g. `active_divination_system`) are unchanged.

### 2.7 Stripped Entities

**Chapters** — removed entirely. No `chapter` entity, no chapter state machine (`PLANNED → OPEN → CLOSING → CLOSED`), no chapter-close prompts, no chapter injection slot. `state-compute.js` removes `chapters: {}` from `createEmptyState()`. `state-machine.js` removes the chapter entry. `state-view.js` removes chapter formatting. `index.js` removes any chapter-close UI logic.

**Story summary** — stripped in Phase 1. No spec reference. If any lingering code paths reference a summary entity or field, remove them.

**Combat exchange in ledger** — removed. Combat is ephemeral. Lasting combat effects (power changes, new wounds, ability changes) fold into the `char` entity. The combat challenge itself lives in hot context for its duration and is not tracked as a persistent ledger entity. See §8 for challenge system details.

### 2.8 LLM Instructions

These instructions belong in the readme injection (`state-view.js` readme builder) and in the preset.

#### NESCIENCE — Knowledge Management

「信息差 + Theory of Mind」The LLM must avoid omniscience in characters and factions:
- Each character can only know what they have realistically observed or heard. No "Hollywood physics" logic.
- Must accurately maintain hidden/personal information and secrets.
- Must avoid "Sherlock Holmes" guesses — explore how characters can be oblivious or unaware.
- News and rumors must travel realistically; both method and inaccessibility matter.
- If a character was absent from a scene, they are oblivious to its details until properly informed.
- Communication media: a character can only know a message's contents if they are the originator or receiver.
- Analyze past messages to avoid contradicting established knowledge states.

Factions obey the same rules — they can only know what they have realistically learned through their network, communications, and intelligence operations. Use `knowledge_asymmetry` on both characters and factions to track the gaps.

**Managing knowledge asymmetry:**
```
MS char:<id> field=knowledge_asymmetry key=knows_evidence value="Has seen the incriminating documents"
MS char:<id> field=knowledge_asymmetry key=unknown_tail value="Doesn't know she's being followed"
MS char:<id> field=knowledge_asymmetry key=hiding_employer value="Concealing who she really works for"
MS char:<id> field=knowledge_asymmetry key=misreading_loyalty value="Thinks PC is still on her side"
```
Remove when the state changes — secret exposed, blind spot filled, false belief corrected:
```
MR char:<id> field=knowledge_asymmetry key=hiding_employer
```
Same structure for factions — replace `char:<id>` with `faction:<id>`. Cap is 20 entries across all four categories combined. Use the four categories as natural buckets; do not invent new prefix conventions.

**Creating a character:**
```
CR char:<id> name="..." tier=UNKNOWN
CR char:<id> name="..." tier=KNOWN faction=<faction-id>
CR char:<id> name="..." tier=TRACKED faction=<faction-id> location=<place-id>
```
Tier defaults to UNKNOWN if omitted. Location is only meaningful at TRACKED or higher — omit it for UNKNOWN/KNOWN chars.

**Creating a place:**
```
CR place:<id> name="..." state=safe reach=DISTRICT description="One or two sentences."
```
Create places as the narrative discovers them. Do not pre-populate. Place IDs should be slug-style (`warehouse-district`, `elena-apartment`, `upper-city-bridge`). `reach` defaults to `LOCAL` if omitted — set it accurately so travel plausibility checks work.

**Moving a character between locations:**
```
S char:<id> field=location value=<place-id>
```
Only update location for TRACKED/PRINCIPAL chars and the PC.

**Anchoring a collision to a place:**
```
S collision:<id> field=location value=<place-id>
```
Do this on creation if the collision has a natural home base, or when one becomes apparent. The engine uses this for proximity checks at arrival.

**Creating a collision:**
```
CR collision:<id> name="..." distance_category=MEDIUM forces="..." location=<place-id> involved_chars=[<id1>,<id2>]
```
All collisions start `ACTIVE`. Do not set `status` on creation — it defaults to ACTIVE.

**Creating an IMMEDIATE collision:**
```
CR collision:<id> name="..." distance_category=IMMEDIATE forces="..." involved_chars=[<id1>]
```
IMMEDIATE collisions start ACTIVE, fire on the creation turn, and are exempt from the 5-collision pool cap.

**Creating a faction:**
```
CR faction:<id> name="..." state="active" agenda="..."
A faction:<id> field=members value=char:<member-id>
S faction:<id> field=territory value=[place:<id>]
```

**Creating a pressure point:**
```
CR pressure:<id> name="..." source="..."
CR pressure:<id> name="..." source="..." related_to=[char:ada,faction:syndicate]
```
Destroy when consumed: `D pressure:<id>`. See §4 for feeding mechanics and when to create vs. escalate directly to a collision.

**Advance turn ledger block (minimum required):**
```
S world field=timeskip_scale value=HOURS
```
Default is HOURS if omitted — set explicitly to DAYS, WEEKS, or MONTHS when the skip is longer. Optionally add character location updates, faction state changes, and archive entries for any collisions that resolved off-screen during the skip. `WEEKS` or `MONTHS` timeskips automatically clear all pressure points — the engine handles this, but the LLM should not re-seed them until the next scene establishes new tensions.

---

## 3. Collision Mechanics Redesign

### 3.1 Distance Category System

**Current state:** Collisions store a raw numeric `distance` field with no semantic category. LLM sets it to whatever feels right. Engine decrements by 1 per advance turn (`handleAdvanceButton()` in `index.js`).

**Phase 2 change:** The LLM sets `distance_category` on creation. The engine maps it to a canonical numeric starting distance and controls all subsequent math. The LLM must NOT set `distance` to an arbitrary number.

| Category | Starting Distance | Meaning |
|---|---|---|
| `IMMEDIATE` | `1` | Fires on the same turn it is created, any mode. No carry-over. |
| `SHORT` | `10` | Near-term — a few advances |
| `MEDIUM` | `20` | Mid-range — several advances |
| `LONG` | `50` | Long-arc — many advances |

**Implementation: `state-compute.js`**

In `applyTransaction()`, `case 'CR'` for collision entities, after existing normalization:

```javascript
const CATEGORY_DISTANCES = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
if (tx.d.distance_category) {
    entity.distance = CATEGORY_DISTANCES[tx.d.distance_category] ?? 10;
} else {
    // No back-compat inference. Reject or default to SHORT.
    entity.distance_category = 'SHORT';
    entity.distance = 10;
}
```

No backward-compat distance inference. New collisions require `distance_category`. Old collisions without it default to `SHORT`.

**Audit warning update** (`handleAdvanceButton()` in `index.js`): Warn if the LLM emits a `S collision:<id> field=distance value=<n>` — distances are engine-owned. Warn if `CR collision` is missing `distance_category`.

---

### 3.2 Clock System — Advance-Only Ticking

**Current state:** Engine decrements distance by exactly 1 per advance turn. No timeskip magnitude.

**Phase 2 change:** Clock only ticks on advance turns (unchanged), but tick magnitude depends on the timeskip scale the LLM declares on each advance turn.

#### Timeskip Classification

The LLM outputs inside the ledger block on every advance turn:

```
S world field=timeskip_scale value=DAYS
```

**Tick multipliers:**

| Declaration | Tick Delta | Meaning |
|---|---|---|
| `HOURS` | +1 | A few hours |
| `DAYS` | +3 | A day or two |
| `WEEKS` | +10 | Up to one week |
| `MONTHS` | +20 | Up to one month |

If omitted: `HOURS` (+1).

**Implementation: `index.js` — `handleAdvanceButton()`**

Replace the fixed `-1` decrement with:

```javascript
const state = computeCurrentState(); // after committing timeskip transaction
const scale = state.world.timeskip_scale || 'HOURS';
const TICK = { HOURS: 1, DAYS: 3, WEEKS: 10, MONTHS: 20 };
const tickDelta = TICK[scale] ?? 1;

const txns = [];
for (const [id, col] of Object.entries(state.collisions)) {
    if (col.status !== 'ACTIVE') continue;
    if (col.distance_category === 'IMMEDIATE') continue;
    const dist = parseFloat(col.distance);
    if (isNaN(dist) || dist <= 0) continue;
    const newDist = Math.max(0, dist - tickDelta);
    txns.push({ op: 'S', e: 'collision', id, d: { f: 'distance', v: newDist } });
}

// WEEKS or MONTHS timeskip clears all pressure points — stale small tensions lapse
if (['WEEKS', 'MONTHS'].includes(scale)) {
    for (const id of Object.keys(state.pressures || {})) {
        txns.push({ op: 'D', e: 'pressure', id });
    }
}
```

Reset `world.timeskip_scale` to null after consuming it. If null on the next advance turn, fall back to `HOURS` (+1) — HOURS is the baseline default. See full operation order at §3.7.

#### Advance Preconditions

Before executing the advance tick, the engine enforces:

1. **Advance lock** — The advance button is locked on click and unlocked when the response completes. This prevents rapid clicks from queuing multiple ticks before the LLM resolves the previous one.

2. **No unresolved arrivals** — If any ACTIVE collision has `distance === 0`, the advance is **rejected**:
   `"Unresolved arrival: '${col.name}' has arrived (distance 0). Resolve it before advancing."`
   The LLM must resolve or dispose of all arrived collisions before the clock can tick again.

3. **PC safety check** — If the PC is in active combat or immediate danger, the engine **warns** (advisory, not hard-block):
   `"PC is not in a safe position to timeskip. Consider resolving the current situation before advancing."`
   The user can override, but the warning fires.

---

### 3.3 IMMEDIATE Collisions — Same-Turn Firing

**Phase 2 change:** `IMMEDIATE` collisions fire on the same turn they are created, in any mode (regular, combat, intimate). They do not carry over.

**Implementation: `onMessageReceived()` in `index.js`**

After transaction commit and state recompute:

```javascript
const immediateArrivals = Object.entries(_currentState.collisions)
    .filter(([id, col]) =>
        col.distance_category === 'IMMEDIATE' &&
        col.status === 'ACTIVE' &&
        !_firedCollisionArrivals.has(id)
    );

if (immediateArrivals.length > 0) {
    buildAndInjectArrivals(immediateArrivals.map(([id]) => id), _currentState);
}
```

Extract `buildAndInjectArrivals(ids, state)` as a shared function callable from both `onMessageReceived` and `handleAdvanceButton`. This function runs the sanity check logic (§3.5) and fires the arrival injection.

**Guard on non-advance turns:** Non-IMMEDIATE distance-based collision checks must only run inside `handleAdvanceButton`. In `onMessageReceived`, only IMMEDIATE collisions are checked.

---

### 3.4 Foreshadowing — Pre-Arrival Threshold Injection

**Phase 2 change:** The engine injects foreshadowing prompts at percentage-based distance thresholds before arrival. These are narrative cues — they nudge the LLM to weave in atmospheric tension. Not gameplay events.

#### Threshold Design

`remaining_pct = current_distance / starting_distance` (using `CATEGORY_DISTANCES` for starting).

| Label | Threshold | Injection Intensity |
|---|---|---|
| `APPROACHING` | ≤ 80% | Subtle — ambient hint, one line |
| `IMMINENT` | ≤ 50% | Clear foreshadow — NPC behavior, environmental signal |
| `CONVERGING` | ≤ 20% | Strong — the collision's forces are visibly in motion |

`IMMEDIATE` collisions skip foreshadowing entirely.

**Tracking:** `_foreshadowedCollisions` Map: `id → Set<'APPROACHING'|'IMMINENT'|'CONVERGING'>`. Reset on snapshot rollback. **`_firedCollisionArrivals` must also be cleared on rollback** — see §8 step 8b.

**Implementation: `buildForeshadowingInjection(state)`**

Called from `injectPrompt()` for regular and advance modes:

```javascript
function buildForeshadowingInjection(state) {
    const CATEGORY_DISTANCES = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
    const lines = [];

    for (const [id, col] of Object.entries(state.collisions)) {
        if (col.distance_category === 'IMMEDIATE') continue;
        if (col.status !== 'ACTIVE') continue;

        const start = CATEGORY_DISTANCES[col.distance_category] ?? 10;
        const current = parseFloat(col.distance);
        if (isNaN(current) || current <= 0) continue;

        const pct = current / start;
        const fired = _foreshadowedCollisions.get(id) || new Set();

        let level = null;
        if (pct <= 0.20 && !fired.has('CONVERGING')) level = 'CONVERGING';
        else if (pct <= 0.50 && !fired.has('IMMINENT')) level = 'IMMINENT';
        else if (pct <= 0.80 && !fired.has('APPROACHING')) level = 'APPROACHING';

        if (!level) continue;
        fired.add(level);
        // Subsumption — firing a higher-urgency level implies all lower levels were skipped
        if (level === 'CONVERGING') {
            fired.add('IMMINENT');
            fired.add('APPROACHING');
        } else if (level === 'IMMINENT') {
            fired.add('APPROACHING');
        }
        _foreshadowedCollisions.set(id, fired);
        lines.push(buildForeshadowBlock(col, level));
    }

    return lines.length > 0 ? lines.join('\n\n') : null;
}
```

**Injection slot:** `${MODULE_NAME}_foreshadow`, after `_nudge`, cleared when empty.

**Foreshadow block format:**

```
[FORESHADOW — ${level}]
"${col.name}" is drawing closer (${Math.round(current)} ticks remaining).
Anchored at: ${placeName || 'unspecified'} | Involved: ${involvedCharsSummary}
${levelGuidance}
Weave its approach into the scene without making it the focus.
```

`levelGuidance`:
- `APPROACHING` — "A distant rumble. An offhand remark. Plant the seed."
- `IMMINENT` — "Someone moves differently. A name surfaces. The collision's forces are near."
- `CONVERGING` — "The forces are visibly in motion. Every other beat should carry their weight."

---

### 3.5 Arrival — Sanity Check Gate + Single-Shot Injection

**Current state:** `_resolutionTracker` fires a 3-phase oracle escalation across multiple turns: atmosphere (turns 1-2), intrusion (turns 3-4), crash (turns 5+). Each phase injects escalating pressure.

**Phase 2 change:** Remove the multi-turn escalation entirely. Replace with a single decisive arrival injection preceded by a sanity check gate. The tarot draw is retained and used in the arrival payload.

**`_resolutionTracker` is removed.** So are the phase constants (`RESOLUTION_PRESSURE_TURNS`, `RESOLUTION_INTRUSION_TURNS`, `RESOLUTION_CRASH_TURNS`) and the phase-switching logic in `index.js`. Keep `_firedCollisionArrivals` Set — it still prevents re-firing.

#### Proximity Check

Before building the arrival injection, the engine checks whether the collision's arrival is spatially plausible:

```javascript
function checkProximity(col, state) {
    if (!col.location) return 'unknown'; // no anchor, can't tell
    const involvedChars = (col.involved_chars || [])
        .map(id => state.chars[id])
        .filter(Boolean);
    const atLocation = involvedChars.filter(c => c.location === col.location);
    if (atLocation.length > 0) return 'on-screen-plausible';
    if (involvedChars.length > 0) return 'off-screen-likely';
    return 'unknown';
}
```

The proximity result is included in the arrival injection as context, not as a decision — the LLM makes the call.

#### Sanity Check Prompt (injected via `_arrival` slot)

```
[GRAVITY — COLLISION ARRIVED: "${col.name}"]
Draw: ${draw.label} — ${draw.reading}

Forces: ${col.forces}
Involved: ${involvedCharsSummary}
Anchored at: ${placeName || 'unspecified'}
${proximityLine}  ← e.g. "Characters involved are currently at this location." or "Involved characters are elsewhere."

SANITY CHECK — commit one of these NOW:

  ON-SCREEN — The collision's forces are present in this scene. Make it the central beat.
    Write it arriving. Then in the ledger:
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DIRECT
      S collision:${col.id} field=aftermath value="<what permanently changed>"
      A world field=collision_archive value="[collision] ${col.name} [resolution] on-screen — <how> [hook] <handles> [aftermath] <change>"

  OFF-SCREEN — The forces resolved while characters were elsewhere.
    Choose:
    A) REFRAME — It mutated. Create a successor collision with a new distance_category.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=EVOLVED
      A collision:${col.id} field=successor_collision_ids value=<new-id>
      CR collision:<new-id> name="..." distance_category=SHORT forces="..." ...
      A world field=collision_archive value="[collision] ${col.name} [resolution] off-screen — mutated into <new-id> [hook] <handles> [aftermath] <change>"
    B) DISSOLVE — It ended quietly.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DISSOLVED
      S collision:${col.id} field=aftermath value="<one sentence: what changed off-screen>"
      A world field=collision_archive value="[collision] ${col.name} [resolution] off-screen — dissolved [hook] <any residue> [aftermath] <change>"

  IMPLODE — The narrative has moved completely past this. It no longer makes sense.
    Kill it without ceremony:
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=IMPLODED
      S collision:${col.id} field=aftermath value="Imploded — narrative moved on."
      A world field=collision_archive value="[collision] ${col.name} [resolution] imploded — <why> [hook] none [aftermath] n/a"

No multi-turn delay. This collision is decided this turn.

**CRASHED status:** A collision becomes CRASHED if distance hits 0 and the scene does not engage with it — the forces acted without the characters. This is the worst outcome. If this happens:
    TR collision:${col.id} field=status from=ACTIVE to=CRASHED
    S collision:${col.id} field=outcome_type value=CRASHED
    S collision:${col.id} field=aftermath value="<consequence of being ignored>"
    A world field=collision_archive value="[collision] ${col.name} [resolution] crashed — ignored [hook] <consequence threads> [aftermath] <change>"
`CRASHED` as `status` marks the lifecycle state. `CRASHED` as `outcome_type` confirms how it ended. Both are set on a crash.
```

#### ON-SCREEN: Full Context Payload

When the LLM chooses ON-SCREEN, the injection already contains everything it needs in the arrival block above (forces, involved chars, tarot draw). The collision becomes the **central beat of the scene**. No follow-up injections from the engine. The engine trusts the LLM to resolve it within the scene.

IMMEDIATE collisions (distance_category=IMMEDIATE) are brief and decisive by nature — the arrival prompt should note: *"This collision arrives immediately — brief, sharp, decisive. Resolve in this scene."*

#### Implementation: `buildAndInjectArrivals(ids, state)`

```javascript
function buildAndInjectArrivals(ids, state) {
    const blocks = [];

    for (const id of ids) {
        if (_firedCollisionArrivals.has(id)) continue;
        _firedCollisionArrivals.add(id);

        const col = state.collisions[id];
        if (!col) continue;

        const draw = drawDivination();
        const proximity = checkProximity(col, state);
        const involvedSummary = buildInvolvedCharsSummary(col, state);
        const placeName = col.location ? (state.places?.[col.location]?.name || col.location) : null;
        const proximityLine = {
            'on-screen-plausible': 'Involved characters are at this location.',
            'off-screen-likely': 'Involved characters are currently elsewhere.',
            'unknown': 'Character locations relative to this collision are unknown.',
        }[proximity];

        blocks.push(buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine));
    }

    if (blocks.length > 0) {
        setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks.join('\n\n'), PROMPT_IN_CHAT, 0);
    }
}
```

#### Simultaneous Arrivals

When multiple collisions arrive on the same advance turn (multiple reach distance 0 after the tick), the engine injects all of them in the same `_arrival` block. **Only one gets the ON-SCREEN spotlight.** The LLM applies rule of cool:

- **Select the most dramatically compelling arrival** for ON-SCREEN resolution.
- **All remaining arrivals** must be resolved as OFF-SCREEN (evolve or dissolve) or IMPLODE.
- No collision may be left hanging — every arrived collision must be committed this turn.

The engine labels each arrival block separately so the LLM can see them all at once and make the judgment call.

---

### 3.6 Advance-Only Firing — Enforcement Summary

| Turn Mode | IMMEDIATE fires? | Non-IMMEDIATE fires? | Clock ticks? |
|---|---|---|---|
| `regular` | Yes (on creation turn) | No | No |
| `combat` | Yes (on creation turn) | No | No |
| `intimate` | Yes (on creation turn) | No | No |
| `advance` | Yes (if newly created) | Yes (distance countdown) | Yes |

**15-Minute Global Cap**

Regular, combat, and intimate turns represent moment-to-moment action within approximately 15 minutes of in-world time. This cap applies to **all non-advance modes** — not just regular.

Add to `_nudge` for all non-advance turns:

```
Scene time: ≤15 min in-world. Non-IMMEDIATE collisions cannot arrive in real-time.
Use ADVANCE to skip time and let collision clocks tick.
```

Engine enforces this mechanically by only ticking clocks in `handleAdvanceButton`.

---

### 3.7 Advance Turn Operation Order

The complete sequence inside `handleAdvanceButton()`:

```
1.  Lock advance button
2.  Commit LLM transactions from the current response
2b. Fire IMMEDIATE collisions whose CR was committed in this turn (calls `buildAndInjectArrivals`)
3.  Unresolved arrival check — any ACTIVE collision at distance 0? If yes, reject and unlock
4.  PC safety check — warn if PC is in danger (advisory)
5.  Read timeskip_scale from committed world transactions (fallback: HOURS if null)
6.  Tick all ACTIVE non-IMMEDIATE collision distances by multiplier
7.  If WEEKS or MONTHS: emit D transactions for all active pressure points
8.  Check for new arrivals (distance 0 after tick)
9.  Run foreshadowing threshold checks for ACTIVE collisions above 0
10. Fire collision_health nudge if both pools empty
11. Build and inject payload: arrivals (§3.5) + foreshadowing (§3.4) + nudge (§4.4)
12. Reset world.timeskip_scale to null
13. Unlock advance button on response completion
```

---

## 4. Pressure Economy

### 4.1 Pressure Points — Entity and Cap

Schema, FIFO cap, and timeskip-clear behavior: see §2.5. Implementation constant: `MAX_PRESSURE_POINTS = 5` in `index.js`.

**FIFO drop ledger record:** When the engine auto-drops the oldest pressure point on overflow, it emits an auto-`D` transaction (`D pressure:<id>`) into the ledger **before** appending the new `CR`. This ensures ledger replay produces the same state as live computation.

When consumed by collision feeding, the LLM destroys them: `D pressure:<id>`. This concentrates dramatic weight into collisions rather than letting small tensions accumulate indefinitely.

### 4.2 Collision Feeding — Pressure Points Fuel Collisions

Pressure points are consumed to:

1. **Seed new collisions** — when 3+ related pressure points accumulate, the LLM combines them into a new collision with an appropriate `distance_category` and destroys the consumed pressure points.
2. **Evolve existing collisions** — an active collision absorbs related pressure points, gaining narrative weight. This may broaden its scope, add `involved_chars`, or deepen its `forces` description. Destroy the consumed pressure points.
3. **Merge collisions** — two collisions heading in the same narrative direction can be merged into one with greater dramatic impact. The consumed collision resolves with `outcome_type=MERGED`, and the surviving collision gains a `parent_collision_ids` pointer back to it.

**[MERGE EXAMPLE]** Two collisions heading in the same direction — `ada_betrayal` and `umbrella_leak` both involve Ada's double life unraveling. Merge `ada_betrayal` into `umbrella_leak`:
```
TR collision:ada_betrayal field=status from=ACTIVE to=RESOLVED
S collision:ada_betrayal field=outcome_type value=MERGED
A collision:umbrella_leak field=parent_collision_ids value=ada_betrayal
S collision:umbrella_leak field=forces value="Ada's cover is blown AND Umbrella's internal documents are surfacing — the two threads are now one"
S collision:umbrella_leak field=involved_chars value=[ada, leon, wesker]
A world field=collision_archive value="[collision] ada_betrayal [resolution] MERGED into umbrella_leak — both threads involved Ada's cover [hook] physical — the stolen flash drive; emotional — Leon's reaction when both truths surfaced at once [aftermath] Ada's operational cover now fully compromised from two independent sources"
```

**[EVOLUTION EXAMPLE]** A collision absorbs related pressure points and expands in scope. Update `forces` and `involved_chars`, then destroy the consumed pressure points:
```
S collision:territory_war field=forces value="Was a border dispute — now Faction Vela has mobilized after absorbing pressure from border-tension and supply-raid"
S collision:territory_war field=involved_chars value=[vela_commander, pc, neutral_trader]
D pressure:border_tension
D pressure:supply_raid
```

**Collision pool cap: max 5 active collisions.** Stored as `MAX_COLLISIONS` in `index.js`. These constants are tunable without touching logic. **IMMEDIATE collisions are exempt from this cap** — they fire and resolve within the same turn, so they never accumulate in the pool.

**Enforcement:** The engine does not hard-block creation beyond the cap — it injects a warning into the corrections queue if the cap is exceeded (IMMEDIATE excluded), and the nudge will push consolidation on the next trigger.

**Corrections queue:** Uses FIFO ordering. Corrections are consumed in the order they were queued and cleared when the matching fix is received.

### 4.3 Seeding When Empty

When the collision pool is empty (no ACTIVE collisions), the nudge must push the LLM to generate pressure points from:

- Current character agendas and faction tensions (agenda field conflicts)
- Unresolved `knowledge_asymmetry` entries (secrets that could surface)
- Constraints approaching breach (`STRESSED` or `CRITICAL`)
- Recent world state changes or faction territorial shifts
- **Collision archive** (§2.2.1) — resolved collisions whose aftermath entries contain unresolved hooks. A consequence still rippling, a relationship that shifted, a tension seeded but not yet re-ignited.

**Invariant: the ledger must never have zero pressure points AND zero active collisions.** This state means nothing is driving the narrative forward. The `collision_health` nudge slot (§4.4) enforces this by checking both pools each cycle and firing a seeding prompt when both are empty.

### 4.4 Rotating Nudge System

Instead of stacking all maintenance on advance turns, the engine cycles through a short rotation of focused tasks appended to normal turn responses. One nudge per trigger — not a laundry list.

**Nudge rotation** (cycle in order, repeating):

| Slot | Label | Task |
|---|---|---|
| 0 | `agenda_check` | Review one PRINCIPAL or TRACKED character's agenda (rotate through both tiers in insertion order). Has recent play shifted their direction? Update via S if yes. |
| 1 | `pressure_scan` | Identify any new pressure points from this scene. Seed if present. |
| 2 | `consolidation_check` | Review active pressure points. Can any be combined into a collision or fed into an existing one? |
| 3 | `collision_health` | Check both pools. If zero pressure points AND zero active collisions, seed from character agendas, faction tensions, and collision archive hooks. Also fires on advance turns regardless of nudge counter. |
| 4 | `relationship_pulse` | Has this scene affected a PRINCIPAL or TRACKED character's relationship with PC? Log a key moment (PRINCIPAL only) if significant. |
| 5 | `collision_validity` | Review active collisions. Has the narrative made any of them irrelevant, redundant, or impossible? IMPLODE them: TR to RESOLVED with outcome_type=IMPLODED, a one-line aftermath, and an archive entry. |
| 6 | `destroyed_cleanup` | Scan for destroyed character IDs still referenced in `collision.involved_chars`, `faction.members`, or `pressure.related_to`. Remove stale references with `S` (overwrite array) or `MR` operations. |

**Frequency:** Every 4 normal turns. Engine tracks `_nudgeCounter` (integer, incremented each regular/combat/intimate turn) and `_nudgeSlot` (0–6, wrapping at 7). Both are persisted in `chatMetadata`. The `_nudgeCounter % 4 === 0` check runs at the **start** of each turn, before `_nudgeCounter` is incremented. When the check fires, advance `_nudgeSlot` and then increment `_nudgeCounter`.

`_nudgeCounter` starts at `-3` on fresh chats, so the first nudge fires on turn 4, not turn 1. This gives the session time to establish characters and scene context before maintenance begins.

**Advance turn special case:** On every advance turn, the engine runs a `collision_health` check regardless of `_nudgeCounter`. If both pools are empty, the seeding prompt fires. This ensures post-timeskip turns always have narrative fuel.

The character referenced in `agenda_check` and `relationship_pulse` rotates through PRINCIPAL and TRACKED chars in insertion order (shared rotation index, also persisted in `chatMetadata`). **Skip `agenda_check` (slot 0) and `relationship_pulse` (slot 4) if no PRINCIPAL or TRACKED characters exist in `state.chars`** — advance `_nudgeSlot` normally but emit no prompt.

**Injection format** — appended via `${MODULE_NAME}_nudge_maintenance`, cleared when empty:

```
[GRAVITY NUDGE — agenda_check]
Review Ada Wong's agenda. Has this scene or recent events shifted her direction?
If yes: S char:ada field=agenda value="..."
If unchanged, skip.
```

**Advance turns are now lighter.** They handle only:
- Timeskip classification (`world.timeskip_scale`)
- Tick collision clocks (§3.2)
- Arrival sanity check + payload injection (§3.5)
- Foreshadowing threshold checks (§3.4)

All other maintenance — agendas, pressure seeding, consolidation, relationship moments, stale collision cleanup — is distributed across normal play via the nudge rotation. Exception: `collision_health` also fires on every advance turn.

---

## 5. Divination

### 5.1 Yi Jing Strip (Phase 1 Completion Task)

The Yi Jing / I Ching system is removed. Current codebase still has it in `index.js` (I Ching table, 1d64 roll logic, `iching` branch in `drawDivination()`). If not done in Phase 1:

- Remove the `iching` case from `drawDivination()`
- Remove the hexagram table
- If `active_system` is `iching`, treat as Arcana and proceed

**Retained:** Arcana (Major Tarot, 22 cards, 1d22), Classic (2d10).

The draw mechanism is used by:
- Collision arrival payloads (§3.5 — tarot draw colors the sanity check context)
- Combat exchanges (§7.2 — tarot draw colors each exchange while combat is ACTIVE)

---

## 6. State Machine Enforcement

### 6.1 Wire `validateTransition()`

**Current state:** `validateTransition()` is fully implemented in `state-machine.js`. Returns `{ valid: true }` or `{ valid: false, error, fix }`. Never called in the turn pipeline.

**Phase 2 change:** Call it on every `TR` operation at commit time in `consistency.js`.

```javascript
// In the TR validation block in consistency.js:
const { validateTransition } = require('./state-machine.js');
const result = validateTransition(tx.e, tx.d.f, tx.d.from, tx.d.to);
if (!result.valid) {
    return { valid: false, error: result.error, fix: result.fix, tx: tx.tx };
}
```

**Invalid transitions are REJECTED** — the transaction is NOT appended to the ledger. The entity's status remains unchanged. A correction is queued with the `fix` suggestion from `validateTransition()`. The LLM receives the error and suggested fix on the next turn: `"Invalid transition: [error]. Suggestion: [fix]."` Do not throw or abort the turn — only the invalid transaction is rejected, the rest of the ledger block is committed normally.

**Affected state machines** (remove chapter from `state-machine.js`):

| Entity | Field | Valid transitions |
|---|---|---|
| `char` | `tier` | UNKNOWN→KNOWN→TRACKED→PRINCIPAL (promote), reverse (retire) |
| `constraint` | `integrity` | STABLE→STRESSED→CRITICAL→BREACHED (pressure), reverse (relief) |
| `collision` | `status` | ACTIVE→RESOLVED; ACTIVE→CRASHED |
| `place` | `state` | No enforced transitions — freeform field, LLM sets directly |

**Chapter removed** from `state-machine.js` state table.

All collisions start `ACTIVE` on creation — no initial transition validation needed. Only subsequent `TR` ops (ACTIVE→RESOLVED, ACTIVE→CRASHED) are validated.

---

## 7. Challenge System Extensibility

### 7.1 Current Architecture

Combat is a **thin entity** (`combat.exchange`, `combat.status`, `combat.primary_enemy`) riding the challenge system (`challenge-state.js`). `state-view.js` formats it as a thin container.

### 7.2 Phase 2: Combat is Ephemeral in the Ledger, Not in the Prompt

**What stays exactly as-is:**
- The combat block is **actively injected into the response context every turn** while combat is `ACTIVE`. The engine continues to build and inject this block via the existing prompt slot — combat is not silent.
- **Tarot draws continue per exchange.** Each combat exchange draws a tarot card that colors how the exchange plays out — the same mechanism collisions use at arrival. The divination system serves both combat and collision mechanics. This is unchanged.
- The combat prompt injection, the tarot draw, and the per-turn combat block all remain fully active.

**What is removed — ledger exchange bookkeeping only:**
- `combat.exchange` counter is removed from the ledger. The engine no longer auto-increments it or stores the round count as a transaction. The LLM does not need to track or commit exchange numbers.
- Per-turn exchange details (who struck, what happened each round) are not committed to the ledger. They live in hot prose context for the duration of the combat and are not persisted.

**What happens when combat ends:**
Lasting effects write back to character entities in the ledger:

- Power changes: `S char:<id> field=power value=<n>`
- New wounds: `A char:<id> field=wounds value="..."`
- Ability changes: `S char:<id> field=abilities value=[...]`

The combat entity (`combat:<id>`) records the final outcome (`outcome`, `aftermath`) and transitions to `RESOLVED`. Only the durable facts survive in the ledger — the blow-by-blow is ephemeral.

### 7.3 Non-Breaking Design Rules

These rules govern all Phase 2 changes to ensure future challenge types (persuasion, racing, etc.) require only additive work:

1. **Challenge type is a field, not a code branch.** Schema: `kind: 'combat' | 'persuasion' | ...` (the codebase names this field `kind` on the profile and serialized entity; earlier drafts of this spec called it `challenge_type`). Shared fields (`status`, `outcome`, `aftermath`) are base entity fields. Type-specific fields are optional or namespaced.

2. **Engine logic is challenge-type-agnostic.** Any tick or lifecycle logic applies by entity status, not by type. Adding a new challenge type means adding a formatter, not forking the engine loop.

3. **Prompt injection is type-aware.** `state-view.js` should have a `formatChallenge(challenge)` function dispatching on `challenge_type`. Current combat format becomes the `combat` branch. New types add branches without touching shared code.

4. **State machine entries are per-type.** `state-machine.js` has separate entries for `combat`, future `persuasion`, etc. — even if they share the same transition graph. This lets future types diverge without breaking existing enforcement.

Flag any Phase 2 code that would violate rules 1 or 2.

---

## 8. Implementation Order

Suggested sequence to minimize conflicts:

1. **§5.1** — Yi Jing strip (cleanup first, unblocks divination simplification)
2. **§2.7** — Strip chapters: `state-compute.js`, `state-machine.js`, `state-view.js`, `index.js` chapter-close logic
3. **§2.4** — Add `place` entity type: `createEmptyState()`, `applyTransaction()` CR handler, `state-view.js` formatter, ledger readme update
4. **§3.1** — Distance category field: `state-compute.js` CR handler, collision fields, ledger readme
5. **§3.2** — Timeskip multipliers: `handleAdvanceButton` tick delta, `world.timeskip_scale`
6. **§3.3** — IMMEDIATE same-turn firing: `onMessageReceived`, shared `buildAndInjectArrivals()`
7. **§3.5** — Arrival sanity check: remove `_resolutionTracker` and phase constants, write new arrival block builder with proximity check
8. **§3.4** — Foreshadowing injection: `_foreshadow` slot, threshold tracking
8b. Wire `_firedCollisionArrivals.clear()`, `_foreshadowedCollisions.clear()`, and `_archiveInjectedVersion` reset into `snapshot-mgr.js` rollback handler. (Can be done as part of step 8 or immediately after.)
9. **§7.2** — Combat ephemeral: remove exchange auto-increment if it exists, update combat entity schema
10. **§6.1** — `validateTransition()` wiring: `consistency.js` TR check, remove chapter from state machine table
11. **§2.5 / §4.1** — Add `pressure` entity type: `createEmptyState()`, `applyTransaction()` CR/D handlers, engine-set `created_at_tx`, FIFO drop on overflow, WEEKS/MONTHS clear in `handleAdvanceButton`. `MAX_PRESSURE_POINTS = 5` and `MAX_COLLISIONS = 5` constants in `index.js`. State view formatter: compact bullet list, omit section when empty.
12. **§4.2** — Collision feeding: cap enforcement warnings (IMMEDIATE exempt), corrections queue FIFO, consolidation path in nudge
13. **§4.3** — Seeding-when-empty invariant: archive injection into state view when pool ≤ 2 (`state-view.js`), last 5 entries surfaced
14. **§4.4** — Rotating nudge: `_nudgeCounter`, `_nudgeSlot`, char rotation index in `chatMetadata`, nudge injection slot, `collision_health` on advance turns, `agenda_check` PRINCIPAL+TRACKED rotation

Steps 4-6 are tightly coupled (category → tick → IMMEDIATE). Do them together. Step 7 is the most disruptive deletion; do it as a single focused change. Steps 11-14 are additive with no destructive component — do them as a unit after the collision pipeline is stable.

---

## 9. Key File Reference

| File | Relevant Sections | Phase 2 Touch |
|---|---|---|
| `index.js` | `handleAdvanceButton()`, `onMessageReceived()`, `injectPrompt()`, `_resolutionTracker` (removed in Phase 2), oracle phase-switching logic (removed in Phase 2), phase constants | §3.2 (tick + pressure clear), §3.3, §3.4, §3.5, §4.4 (nudge counter/slot/char-rotation index in `chatMetadata`), §7.2 |
| `state-compute.js` | `applyTransaction()` CR/TR/D handlers, `createEmptyState()` | §2.4 (place), §2.5 (pressure + `created_at_tx`), §2.6 (world), §2.7 (chapter removal), §3.1 |
| `state-machine.js` | `validateTransition()`, state tables | §2.7 (chapter removal), §6.1 (simplified collision transitions) |
| `consistency.js` | TR validation block, archive presence check on terminal collision TR | §6.1, §2.2.1 (archive validation) |
| `state-view.js` | Collision formatting, readme builder, chapter formatting | §2.1 (key_moments last-10 injection per PRINCIPAL), §2.4, §2.5 (pressure formatter — compact bullet list), §2.7, §3.1 (readme), §4.3 (archive injection when pool ≤ 2) |
| `challenge-state.js` | Combat entity schema | §7.2, §7.3 |
