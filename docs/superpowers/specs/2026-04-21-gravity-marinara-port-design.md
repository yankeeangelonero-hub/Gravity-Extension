# Gravity → Marinara Port Design

Date: 2026-04-21  
Status: Approved

## Overview

Port Gravity Ledger from SillyTavern to MarinaraEngine (Roleplay mode). Full migration — SillyTavern abandoned. The core reliability win is replacing `---LEDGER---` parsing with a structured JSON state delta validated post-generation. SQL replaces chatMetadata. The SillyTavern extension API dependency is eliminated.

## Scope

### In

- Collision engine (core)
- Constraint integrity (core)
- Lightweight character state (wounds, capability descriptor)
- Challenge system — beat-by-beat with tarot formation integration (trimmed, modular)
- Tarot divination — standalone draws + embedded in challenge beats

### Out

- Challenge state machine / player input parser / profile registry scaffolding (SillyTavern artefacts)
- Combat facade (not needed — combat is a challenge profile)
- Full character dossiers (knowledge_asymmetry → agent memory; key_moments/demonstrated_traits → Marinara Character Tracker built-in)
- All other Gravity entities (factions, places, pressure points, world, pc, divination entity)
- Gravity UI panel (rebuilt in Marinara's React client separately)
- Setup wizard (out of scope for Phase 1)

## Platform

- **Marinara chat mode**: Roleplay
- **Main model**: Claude Opus (handles all prose + interpretation)
- **No additional LLM calls** — all pre-gen injection is deterministic, state validation is deterministic TypeScript + Zod

## Architecture

### Three Components

**1. Gravity Service** (`packages/server/src/services/gravity/`)  
Owns all state. SQL tables via Drizzle ORM. Context builders. State delta validation logic. Challenge beat resolution (card draw, dice roll, outcome band calculation). Does not make LLM calls.

**2. Context Injection** (deterministic, pre-gen)  
Gravity Service hooks into Marinara's prompt assembly service (`packages/server/src/services/prompt/`). Injects collision/constraint/character state every turn. Injects challenge payload (formation cards, roll, outcome band) every turn when a challenge is ACTIVE. Injects most recent divination draw when one exists from the current turn. No Marinara agent registration — direct prompt assembly hook.

**3. Gravity State Processor** (post-gen, deterministic)  
A post-processing hook (not an LLM agent). Receives Opus's response, extracts the `{"gravity": [...]}` block, validates each op against Zod schema, enforces transition rules, commits valid operations to SQL, flags invalid ops for next-turn correction injection. No LLM call — pure TypeScript.

### Turn Types

**Regular turn**: context injection → Opus prose + delta → State Agent commits.

**Advance turn** (`/advance` slash command): advance-framed context injection → Opus world-movement prose + delta (with `advance_collision` ops) → State Agent commits. `advance_collision` ops are only valid on advance turns — State Agent rejects them otherwise.

**Challenge active** (either turn type): challenge payload appended to context injection (fresh card draw + dice roll + outcome band each turn) → Opus interprets formation and narrates beat → delta includes `beat` op → State Agent commits beat record. On `conclude_challenge` op, challenge closes and payload stops firing.

### Collision Arrival

No special arrival gate. When distance reaches 0 on an advance turn, the context frames it as imminent. Opus writes the arrival naturally and resolves via `resolve_collision`.

## Data Layer

All tables scoped by `chat_id`. Managed via Drizzle ORM migrations.

### `gravity_collisions`
| Field | Type | Notes |
|---|---|---|
| id | text PK | |
| chat_id | text | |
| name | text | |
| parties | JSON | array of char IDs |
| stakes | text | |
| distance | integer | |
| status | text | ACTIVE / RESOLVED / CRASHED |
| resolution | text | nullable |
| created_at | timestamp | |
| updated_at | timestamp | |

### `gravity_constraints`
| Field | Type | Notes |
|---|---|---|
| id | text PK | |
| chat_id | text | |
| char_id | text | |
| description | text | |
| integrity | text | INTACT / STRAINED / BROKEN / SHATTERED |
| aftermath | text | nullable, populated on break |
| created_at | timestamp | |
| updated_at | timestamp | |

### `gravity_characters`
| Field | Type | Notes |
|---|---|---|
| id | text PK | Marinara character ID |
| chat_id | text | |
| capability | text | narrative descriptor of demonstrated power |
| wounds | JSON | array of wound strings |
| created_at | timestamp | |
| updated_at | timestamp | |

### `gravity_challenges`
| Field | Type | Notes |
|---|---|---|
| id | text PK | |
| chat_id | text | |
| challenger_id | text | |
| defender_id | text | |
| type | text | combat / social / investigation / ... |
| context | text | |
| dc | integer | locked at creation, Opus sets |
| formation_id | text | references formation registry |
| status | text | ACTIVE / RESOLVED |
| outcome | text | nullable |
| resolved_at | timestamp | nullable |
| created_at | timestamp | |

One active challenge per chat at a time (Phase 1 constraint).

### `gravity_challenge_beats`
| Field | Type | Notes |
|---|---|---|
| id | text PK | |
| challenge_id | text FK | |
| beat_number | integer | |
| formation_cards | JSON | array of `{position, card}` |
| roll | integer | |
| dc | integer | snapshot of DC at beat time |
| outcome_band | text | triumph / success / partial / failure / catastrophe |
| beat_summary | text | Opus's narrative summary of the beat |
| created_at | timestamp | |

### `gravity_divination`
| Field | Type | Notes |
|---|---|---|
| id | text PK | |
| chat_id | text | |
| formation_id | text | |
| cards | JSON | array of `{position, card}` |
| context | text | nullable |
| created_at | timestamp | |

## State Delta Format

Opus appends a JSON block at the end of every response. Gravity State Agent parses and commits.

```json
{"gravity": [
  {"op": "create_collision", "id": "kira-athrun", "name": "...", "parties": ["kira", "athrun"], "stakes": "...", "distance": 4},
  {"op": "advance_collision", "id": "kira-athrun"},
  {"op": "resolve_collision", "id": "kira-athrun", "status": "RESOLVED", "resolution": "..."},
  {"op": "create_constraint", "id": "...", "char_id": "kira", "description": "..."},
  {"op": "strain_constraint", "id": "..."},
  {"op": "break_constraint", "id": "...", "aftermath": "..."},
  {"op": "set_wounds", "char_id": "kira", "wounds": ["injured shoulder"]},
  {"op": "create_challenge", "id": "...", "challenger_id": "kira", "defender_id": "athrun", "type": "combat", "context": "...", "dc": 12, "formation_id": "duel"},
  {"op": "beat", "challenge_id": "...", "outcome_band": "partial", "summary": "..."},
  {"op": "conclude_challenge", "challenge_id": "...", "outcome": "..."},
  {"op": "draw_divination", "formation_id": "single", "context": "..."}
]}
```

**Note on `draw_divination`**: this is a two-turn event. Opus writes the op this turn (server draws cards + stores to `gravity_divination`). Next turn the context injection surfaces the draw and Opus interprets it in prose. Opus should narrate "the cards are drawn" this turn without knowing the result.

### Validation Rules (enforced by State Agent)

- `advance_collision` only valid on advance turns
- Constraint integrity must follow INTACT → STRAINED → BROKEN → SHATTERED (no skipping)
- `beat` only valid when a challenge is ACTIVE for this chat
- `conclude_challenge` closes challenge; subsequent `beat` ops rejected
- `create_challenge` rejected if a challenge is already ACTIVE
- Unknown ops flagged and injected as corrections next turn

## Context Injection Format

### Regular Turn

```
[GRAVITY STATE]
Collisions:
  kira-athrun (distance 3) — Kira discovers Athrun is ZAFT; stakes: their friendship
  lacus-plant (distance 1) — IMMINENT

Constraints:
  Kira: "Will not fire on ZAFT pilots" — STRAINED

Characters:
  Kira Yamato — wounds: none
  Athrun Zala — wounds: injured shoulder
```

### Advance Turn

```
[GRAVITY STATE — ADVANCE]
This is a world-movement turn. Collision clocks are advancing.
Write `advance_collision` for each collision that progresses this turn.

Collisions:
  kira-athrun (distance 3) — ...
  lacus-plant (distance 1) — IMMINENT

Constraints: [same]
Characters: [same]
```

### Challenge Active (appended to either)

```
[ACTIVE CHALLENGE — combat, duel formation]
DC: 12

The Strike: Seven of Swords
The Counter: The Tower
Roll: 14 → Partial Success

Interpret this formation and narrate the beat.
Write `beat` with outcome_band and summary.
Write `conclude_challenge` when the challenge resolves.
```

## File Structure

```
packages/server/src/services/gravity/
  ├── engine.ts              — state queries, context builders, advance-turn logic
  ├── schema.ts              — Drizzle table definitions
  ├── state-processor.ts     — post-gen deterministic validation + commit (no LLM)
  └── challenge/
      ├── index.ts           — challenge lifecycle (create, beat, conclude)
      ├── mechanics.ts       — dice rolls, difficulty targets, outcome bands
      ├── tarot/
      │   ├── index.ts       — draw logic, formation application
      │   ├── decks.ts       — Arcana + Classic card data
      │   └── formations/
      │       ├── registry.ts
      │       ├── single.ts  — standalone divination
      │       ├── duel.ts    — combat beats (The Strike / The Counter)
      │       └── triangle.ts — social beats (Intent / Resistance / Turning Point)
      └── profiles/
          ├── registry.ts
          └── combat.ts      — first challenge profile
```

### Challenge Profile Interface

```typescript
interface ChallengeProfile {
  type: string
  name: string
  difficultyTargets: Record<string, number>  // TRIVIAL→8, EASY→10, NORMAL→12, HARD→15, BRUTAL→18
  formationId: string
  outcomeBands: { label: string; minDelta: number }[]
}
```

### Tarot Formation Interface

```typescript
interface TarotPosition {
  label: string
  deck: 'arcana' | 'classic' | 'both'
}

interface TarotFormation {
  id: string
  positions: TarotPosition[]
}
```

Formations are reusable across profiles. New challenge types reference existing formations or add one file. New decks added to `decks.ts` automatically available to all formations.

## Modularity Seams

- **New challenge type**: one file in `profiles/`, one registry entry
- **New tarot formation**: one file in `formations/`, one registry entry
- **New deck**: extend `decks.ts`
- **Multiple simultaneous challenges**: remove Phase 1 constraint, index challenge payload by challenge ID
- **Knowledge asymmetry agent**: add as Marinara agent using agent memory — no Gravity Service changes needed

## What Marinara Provides Natively

- Character cards (static personality, description, system prompt)
- Character Tracker built-in agent (key_moments, demonstrated_traits)
- Knowledge asymmetry → agent memory managed externally
- Chat branching (replaces snapshot/rollback)
- Lorebook (static world facts, backstory secrets)
