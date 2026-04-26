# Gravity Ledger Discord Bot — Claude Code Handoff

## What This Is

A Discord bot that ports the Gravity Ledger narrative state machine from SillyTavern (browser extension) to Discord. The bot wraps an append-only ledger engine with the Anthropic Claude API to run persistent, spatially-aware narrative RPG sessions in Discord threads.

This is NOT a simple chatbot with a persona. It is a **narrative simulation engine** where deterministic code handles state, spatial math, and validation while the LLM handles prose and narrative decisions.

---

## Source Context

The original project is a SillyTavern extension (pure JS, no build step). The original `AGENTS.md` is included at the bottom of this document for architectural reference. **Do not port the SillyTavern code directly** — build a clean-room implementation in Node.js targeting Discord + Claude API, using the original architecture as a specification.

---

## Architecture Overview

### Core Principle

Code is the physics engine. The LLM is the narrator. Never trust the LLM with spatial math, state management, or validation.

### Three-Layer Design (preserved from original)

1. **Data Layer** — Append-only ledger transactions stored in SQLite per Discord thread. Snapshots and rollback. Transactions are never deleted or overwritten.
2. **Compute Layer** — Replays all transactions to derive current state. Validates transaction format. Defines valid state transitions (documented, not enforced by code — LLM follows them).
3. **Presentation Layer** — Formats state for prompt injection. Renders embeds and slash command outputs. Parses `---LEDGER---` blocks from LLM responses.

### New Layers (Discord-specific)

4. **Spatial Layer** — Flexible coordinate grid, entity positioning, distance calculations, pathfinding, proximity-based encounter triggering, fog of war, map rendering.
5. **Tick Layer** — Scheduler for autonomous world events (disabled by default, opt-in per session). NPC movement, collision escalation, faction heartbeats on real-time clocks.
6. **Discord Layer** — Bot connection, slash commands, thread-based session management, webhook-based NPC identities, role-based permissions.

---

## Tech Stack

- **Runtime**: Node.js (v20+)
- **Discord**: discord.js v14
- **LLM**: Anthropic Claude API (`@anthropic-ai/sdk`)
- **Database**: SQLite via `better-sqlite3` (one DB file, tables keyed per thread/session)
- **Scheduler**: `node-cron` (for world ticks)
- **No build step, no bundler, no TypeScript** — plain JS with ES modules

---

## Project Structure

```
gravity-discord/
├── package.json
├── .env.example              # DISCORD_TOKEN, ANTHROPIC_API_KEY, etc.
├── config.js                 # Default settings, tunable per session
├── index.js                  # Entry point — bot startup, event wiring
│
├── core/                     # Platform-agnostic ledger engine
│   ├── ledger-store.js       # Append-only transaction storage (SQLite)
│   ├── state-compute.js      # Replay transactions → derive current state
│   ├── state-machine.js      # Valid transitions (documented, not enforced)
│   ├── consistency.js        # Transaction format validation
│   ├── snapshot-mgr.js       # Snapshot/rollback
│   ├── memory-tier.js        # Hot/cold memory rotation
│   └── divination.js         # Random tables (Arcana/Classic/I-Ching)
│
├── spatial/                  # Spatial reasoning (code-driven, NOT LLM)
│   ├── world-grid.js         # Flexible coordinate grid (scales per session)
│   ├── pathfinding.js        # A* or grid traversal between locations
│   ├── proximity.js          # Distance calculations, encounter triggering
│   ├── fog-of-war.js         # Per-PC visibility based on position + perception
│   └── map-renderer.js       # Text/emoji map generation for Discord embeds
│
├── prompt/                   # Prompt assembly (replaces SillyTavern injection)
│   ├── assembler.js          # Builds full system prompt from components
│   ├── state-view.js         # Formats current state for injection
│   ├── readme-inject.js      # Command format reference
│   ├── nudge-inject.js       # Mode flags for hidden reasoning
│   ├── correction-inject.js  # Failed ledger lines queued for self-correction
│   ├── spatial-inject.js     # Spatial briefing (nearby entities, terrain, distances)
│   └── card-loader.js        # Character card importer (V2 spec JSON)
│
├── discord/                  # Discord-specific integration
│   ├── bot.js                # discord.js client setup, event handlers
│   ├── commands.js           # Slash command definitions and handlers
│   ├── session-mgr.js        # Thread → session mapping, lifecycle
│   ├── embeds.js             # Rich embed builders for state display
│   ├── webhooks.js           # NPC identity webhooks (name + avatar per NPC)
│   └── permissions.js        # Role-based access (GM, player, spectator)
│
├── tick/                     # Autonomous world ticking
│   ├── scheduler.js          # Cron-based tick scheduling per session
│   ├── tick-handler.js       # What happens each tick (check timers, move NPCs)
│   ├── journey-mgr.js        # Travel pacing (tick budget per journey)
│   └── collision-timer.js    # Real-time collision escalation
│
├── llm/                      # Claude API integration
│   ├── client.js             # Anthropic SDK wrapper
│   ├── ledger-parser.js      # Extract ---LEDGER--- blocks from responses
│   └── turn-handler.js       # Full turn lifecycle (prompt → API → parse → commit → respond)
│
└── db/
    └── schema.sql            # SQLite schema
```

---

## Database Schema

```sql
-- One row per session (Discord thread)
CREATE TABLE sessions (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    config JSON DEFAULT '{}',          -- per-session settings (tick pace, etc.)
    world_grid JSON DEFAULT '{}',      -- spatial grid definition
    character_card JSON DEFAULT '{}',  -- loaded character card data
    status TEXT DEFAULT 'active'       -- active, paused, archived
);

-- Append-only ledger (core of everything)
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    source TEXT NOT NULL,               -- 'llm', 'system', 'tick', 'ooc'
    raw_line TEXT NOT NULL,             -- original ledger line
    operation TEXT NOT NULL,            -- CR, S, TR, A, R, MS, MR, D, SNAP, ROLL, AMEND
    entity_type TEXT,                   -- char, constraint, collision, chapter, faction, world, pc, divination, summary
    entity_id TEXT,
    field TEXT,
    value TEXT,
    valid BOOLEAN DEFAULT TRUE,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);

-- Snapshots for rollback
CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    name TEXT,
    state JSON NOT NULL,               -- serialized full state at snapshot time
    transaction_id INTEGER NOT NULL,    -- last transaction included
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);

-- Conversation history for Claude API context
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,                 -- 'user', 'assistant'
    content TEXT NOT NULL,
    turn_number INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);

-- Cold storage for memory tiering
CREATE TABLE cold_storage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    category TEXT NOT NULL,            -- 'story_summary', 'timeline', 'traits'
    data JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);

-- Spatial entity positions
CREATE TABLE entity_positions (
    thread_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    location_name TEXT,                -- human-readable location name
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, entity_id),
    FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);
```

---

## Slash Commands

| Command | Role | Description |
|---------|------|-------------|
| `/start` | GM/Player | Start a new session in the current thread |
| `/loadcard` | GM/Player | Upload and import a character card (V2 JSON) |
| `/state` | Any | Show current entity state as an embed |
| `/map` | Any | Render the current map (fog-of-war per player) |
| `/snapshot [name]` | GM/Player | Create a named snapshot |
| `/rollback [name]` | GM | Rollback to a snapshot |
| `/eval` | GM/Player | Trigger OOC eval (LLM audits state consistency) |
| `/combat` | GM/Player | Enter combat mode |
| `/history [n]` | Any | Show last N transactions |
| `/worldtick on/off` | GM | Enable/disable autonomous ticking |
| `/worldtick pace [relaxed/standard/intense]` | GM | Set tick interval |
| `/downtime [action]` | Player | Set downtime activity for when offline |
| `/journal` | Player | Show PC timeline and traits |
| `/settings` | GM | Adjust session settings (temperature, context limit) |
| `/end` | GM | Archive the session |

---

## Data Flow (Per Turn)

### Player-initiated turn:
```
1. Player posts message in thread
2. discord/bot.js receives message event
3. session-mgr.js looks up active session for thread
4. prompt/assembler.js builds system prompt:
   a. state-view.js → full entity state
   b. spatial-inject.js → "PC is at [12,8], nearby: merchant at [13,9], bandit camp at [14,7]"
   c. readme-inject.js → ledger command format reference
   d. nudge-inject.js → current mode flag (regular/combat/advance/intimacy)
   e. correction-inject.js → any failed lines from previous turn
5. llm/client.js sends to Claude API: system prompt + conversation history + user message
6. llm/ledger-parser.js extracts ---LEDGER--- block from response
7. core/consistency.js validates each transaction line
8. core/ledger-store.js appends valid transactions to SQLite
9. core/state-compute.js replays all transactions → updated _currentState
10. spatial/proximity.js updates entity positions, checks encounter triggers
11. Any invalid lines queued as corrections for next turn
12. discord/bot.js posts prose to thread (ledger block in spoiler or hidden)
13. If NPC messages warranted, discord/webhooks.js posts as NPC identity
```

### Tick-initiated turn (when enabled):
```
1. tick/scheduler.js fires on interval
2. tick/tick-handler.js checks all active sessions:
   a. Any collision timers expired? → escalate
   b. Any NPCs with movement schedules? → update positions
   c. Any journey in progress? → advance to next beat
   d. Faction heartbeat due? → trigger faction action
3. For each session needing a tick:
   a. Build prompt with tick context ("No player input. World advances autonomously.")
   b. Call Claude API
   c. Parse, validate, commit, same as player turn
   d. Post result to thread via webhook (as relevant NPC) or as bot
4. Consolidate quiet ticks — don't spam multiple low-event ticks
```

---

## Spatial System Design

### World Grid

The grid is session-specific and scale-flexible:

```javascript
// Example world grid definition (stored in sessions.world_grid)
{
  "scale": "region",        // "room", "city", "region", "continent"
  "unit_km": 5,             // each cell = 5km (only for region/continent)
  "width": 20,
  "height": 15,
  "locations": {
    "ashwick":     { "x": 15, "y": 3,  "type": "city",     "name": "Ashwick" },
    "thornfield":  { "x": 10, "y": 7,  "type": "town",     "name": "Thornfield" },
    "greymire":    { "x": 8,  "y": 9,  "type": "wetland",  "name": "Greymire Wetlands" },
    "bandit_camp": { "x": 12, "y": 6,  "type": "camp",     "name": "Bandit Camp" }
  },
  "roads": [
    { "from": "thornfield", "to": "ashwick", "waypoints": [[12,6], [14,4]], "terrain": "forest_road" },
    { "from": "thornfield", "to": "greymire", "waypoints": [[9,8]], "terrain": "muddy_path" }
  ],
  "terrain_defaults": "grassland"
}
```

### Map Renderer (text/emoji in Discord embeds)

```javascript
// map-renderer.js generates this from grid + entity positions
// Emoji key:
// 🏰 city  🏘️ town  ⚔️ hostile  🏕️ camp  👤 player
// 🌲 forest  🌊 water  🏔️ mountain  · open

// Output:
`🏔️ · · · · · · · · 🏔️
 · · · 🌲 · · 🌲 · · ·
 · · 🌲 🏘️---🌉---🏰 ·
 · · · · · · / · · · ·
 · 🌲 · · · 🏕️ · · · ·
 · · · ⚔️ · · · 🌊 · ·
 · · 🏘️ · · · 🌊🌊 · ·
 · · · · · 👤 · 🌊 · ·`
```

### Spatial Prompt Injection

Every turn, `spatial-inject.js` provides the LLM with a deterministic spatial briefing:

```
[SPATIAL CONTEXT]
PC location: Greymire Road [8,10]
Destination: Ashwick [15,3] — 12 cells / ~60km — journey beat 2 of 4
Terrain: wetland transitioning to forest road
Nearby entities (within 3 cells):
  - Merchant caravan at [9,9] — 1.4 cells — moving toward Thornfield
  - Greymire scouts (dormant NPC) at [7,11] — 1.4 cells
Active collisions in range:
  - "The Merchant War" — actors near Thornfield [10,7] — 3.6 cells
Pressure points in range:
  - "Missing scouts" — located at Greymire [8,9] — 1 cell
Weather: Overcast, light rain
```

The LLM narrates based on this briefing. It does NOT calculate distances or positions.

### Key Spatial Rules

- **All distance/position math happens in code** — the LLM receives pre-computed results
- **Movement transactions are validated** — if the LLM outputs `TR char.maren location ashwick→riverwatch` but the distance is impossible in one turn, the transaction is rejected and queued as a correction
- **Fog of war is per-PC** — `/map` shows different views to different players based on their position and perception radius
- **NPCs have movement schedules** — defined as waypoint lists with timing, executed by the tick system
- **Encounters trigger on proximity** — when entity_positions shows two relevant entities within encounter range, the system flags it for the next turn's prompt

---

## Tick System Design

### Configuration (per session)

```javascript
// Stored in sessions.config
{
  "tick_enabled": false,          // off by default
  "tick_interval_minutes": 30,    // default: standard pace
  "journey_tick_budget": {
    "short": 1,                   // within a city: 0-1 ticks
    "medium": 3,                  // 30km: 2-4 ticks
    "long": 6                     // expedition: 5-8 ticks
  },
  "collision_escalation_hours": {
    "simmering_to_active": 24,
    "active_to_resolving": 12,
    "atmosphere_phase": 6,
    "direct_intrusion_phase": 6,
    "crash_phase": 3
  },
  "faction_heartbeat_hours": 12,
  "dormant_npc_check_hours": 24,
  "quiet_tick_consolidation": true  // batch low-event ticks into one message
}
```

### Tick Pacing Presets

| Preset | Interval | Feel |
|--------|----------|------|
| `relaxed` | 2 hours | Slow burn, play-by-post |
| `standard` | 30 min | Active session |
| `intense` | 10 min | Real-time pressure |

### Journey Pacing

When a PC is traveling, the tick system manages journey beats:

```javascript
// journey-mgr.js
{
  "active_journey": {
    "pc": "player_1",
    "from": [8, 10],
    "to": [15, 3],
    "route": [[8,10], [10,8], [12,6], [14,4], [15,3]],
    "current_waypoint": 1,
    "total_beats": 4,
    "current_beat": 2,
    "ticks_per_beat": 1,
    "started_at": "2025-01-15T14:00:00Z"
  }
}
```

Each beat = one tick-triggered LLM call with spatial context about what's at/near the current waypoint. The LLM decides if the beat is atmospheric, an encounter, or an arrival.

---

## Ledger Format Reference

### Operations

| Op | Full Name | Example |
|----|-----------|---------|
| `CR` | Create | `CR char.maren name "Maren"` |
| `S` | Set | `S char.maren trust 6` |
| `TR` | Transition/Move | `TR char.maren location riverwatch→ashwick` |
| `A` | Append | `A pc.timeline "Met Maren at the docks"` |
| `R` | Remove | `R char.maren inventory "old map"` |
| `MS` | Map Set | `MS world.pressure_points "border_tension" "Trade routes contested"` |
| `MR` | Map Delete | `MR world.pressure_points "border_tension"` |
| `D` | Destroy | `D char.maren` |
| `SNAP` | Snapshot | `SNAP "before_battle"` |
| `ROLL` | Rollback | `ROLL "before_battle"` |
| `AMEND` | Amend last | `AMEND char.maren trust 5→6` |

### Entity Types

`char`, `constraint`, `collision`, `chapter`, `faction`, `world`, `pc`, `divination`, `summary`

### State Machines (documented, not code-enforced)

- **Collision status**: SEEDED → SIMMERING → ACTIVE → RESOLVING → RESOLVED
- **Collision outcomes**: DIRECT, EVOLVED, MERGED, IMPLODED, CRASHED
- **Character tiers**: defined in state-machine.js
- **Constraint integrity**: defined in state-machine.js
- **Chapter status**: defined in state-machine.js

### Ledger Block Format (in LLM output)

```
---LEDGER---
CR char.elric name "Elric" location "Ashwick" tier "secondary"
S collision.merchant_war status SIMMERING→ACTIVE
A pc.timeline "Discovered the merchant war has reached Ashwick"
TR pc location greymire_road→ashwick_gates
MS world.pressure_points "sealed_gates" "Ashwick gates sealed — no entry without papers"
---END LEDGER---
```

### Self-Correcting Feedback Loop

Failed ledger lines are queued as corrections → injected into next prompt so LLM can fix them → cleared when resolved → dropped after 3 attempts.

---

## Character Card Import

Support SillyTavern V2 character card format (JSON):

```javascript
// card-loader.js extracts:
{
  "name": "...",
  "description": "...",       // character persona
  "personality": "...",
  "scenario": "...",
  "first_mes": "...",          // first message / greeting
  "mes_example": "...",        // example dialogues
  "system_prompt": "...",
  "post_history_instructions": "...",
  "tags": [],
  "creator_notes": "...",
  "character_book": {          // embedded lorebook
    "entries": [
      {
        "keys": ["keyword1", "keyword2"],
        "content": "Lorebook entry content...",
        "enabled": true,
        "insertion_order": 100
      }
    ]
  }
}
```

The card data is injected into the system prompt by `assembler.js`. Lorebook entries are keyword-triggered — `assembler.js` scans the recent conversation for matching keywords and injects relevant entries.

---

## Prompt Assembly Order

`assembler.js` builds the system prompt in this order:

1. **Base system prompt** — "You are a narrative engine. You output prose followed by a ---LEDGER--- block..."
2. **Character card** — persona, scenario, personality (from loaded card)
3. **Lorebook entries** — keyword-matched entries from character_book
4. **State view** — full entity registry and dossiers (from state-compute)
5. **Spatial briefing** — PC position, nearby entities, terrain, distances (from spatial layer)
6. **Readme** — ledger command format reference
7. **Mode nudge** — current turn mode flag (regular/combat/advance/intimacy)
8. **Corrections** — any failed ledger lines from previous turn
9. **Divination** — active draws if applicable
10. **Collision/pressure context** — active collision phases, pressure point status

Conversation history (from messages table) is sent as the `messages` array in the API call, NOT in the system prompt.

---

## NPC Webhook System

Discord webhooks allow posting as different identities (name + avatar):

```javascript
// webhooks.js
// When the LLM's response includes NPC-initiated dialogue or actions,
// post those segments via a webhook with the NPC's name and avatar.
//
// Usage:
// 1. On session start or NPC creation, create/cache a webhook for the thread's channel
// 2. When posting NPC content, send via webhook with NPC name/avatar overrides
// 3. Bot's own responses (narration, system messages) still post as the bot
//
// This makes NPCs feel like independent entities in the Discord thread.
```

---

## Environment Variables

```env
DISCORD_TOKEN=                  # Discord bot token
ANTHROPIC_API_KEY=              # Claude API key
CLAUDE_MODEL=claude-sonnet-4-20250514  # Model to use
MAX_CONTEXT_TOKENS=8000         # Context window budget for conversation history
TEMPERATURE=0.8                 # Default generation temperature
DB_PATH=./data/gravity.db       # SQLite database path
```

---

## Build Phases

### Phase 1 — Core Engine (start here)
- [ ] Project scaffolding (package.json, .env, config)
- [ ] SQLite schema and connection
- [ ] `core/ledger-store.js` — append transactions, query by thread
- [ ] `core/consistency.js` — validate transaction format
- [ ] `core/state-compute.js` — replay transactions → state object
- [ ] `core/snapshot-mgr.js` — create/restore snapshots
- [ ] `core/divination.js` — random tables

### Phase 2 — Discord Integration
- [ ] `discord/bot.js` — discord.js client, ready/message events
- [ ] `discord/session-mgr.js` — thread → session lifecycle
- [ ] `discord/commands.js` — slash commands (start, state, snapshot, rollback, history, end)
- [ ] `discord/embeds.js` — state display embeds
- [ ] `discord/permissions.js` — role checking

### Phase 3 — Prompt Engine + LLM
- [ ] `prompt/state-view.js` — format state for injection
- [ ] `prompt/readme-inject.js` — command reference
- [ ] `prompt/nudge-inject.js` — mode flags
- [ ] `prompt/correction-inject.js` — error queue
- [ ] `prompt/assembler.js` — compose full system prompt
- [ ] `prompt/card-loader.js` — V2 character card parser
- [ ] `llm/client.js` — Anthropic SDK wrapper
- [ ] `llm/ledger-parser.js` — extract ---LEDGER--- blocks
- [ ] `llm/turn-handler.js` — full turn lifecycle

### Phase 4 — Spatial System
- [ ] `spatial/world-grid.js` — grid definition, scale configuration
- [ ] `spatial/pathfinding.js` — A* between locations
- [ ] `spatial/proximity.js` — distance calc, encounter triggers
- [ ] `spatial/fog-of-war.js` — per-PC visibility
- [ ] `spatial/map-renderer.js` — text/emoji map for embeds
- [ ] `prompt/spatial-inject.js` — spatial briefing for LLM
- [ ] `/map` slash command

### Phase 5 — World Ticking (off by default)
- [ ] `tick/scheduler.js` — cron scheduling per session
- [ ] `tick/tick-handler.js` — tick logic (what to check)
- [ ] `tick/journey-mgr.js` — travel pacing
- [ ] `tick/collision-timer.js` — real-time escalation
- [ ] `discord/webhooks.js` — NPC identity posting
- [ ] `/worldtick` slash command

### Phase 6 — Polish
- [ ] Memory tiering (`core/memory-tier.js`)
- [ ] Lorebook keyword matching
- [ ] Quiet tick consolidation
- [ ] Error handling and graceful degradation
- [ ] README.md with setup instructions

---

## Key Design Principles

1. **Append-only** — transactions are never deleted or overwritten. State is always derived by replay.
2. **Code validates, LLM narrates** — all spatial math, state validation, and encounter triggering happens in code. The LLM receives pre-computed context and writes prose.
3. **Self-correcting** — invalid ledger lines are fed back as corrections. The LLM fixes its own mistakes within 3 attempts.
4. **Session-isolated** — each Discord thread is an independent game session with its own ledger, state, and world grid.
5. **Tick-optional** — the world tick system exists in the architecture from day one but is disabled by default. Opt-in per session via `/worldtick on`.
6. **Scale-flexible** — the spatial grid works at any zoom level (room, city, region, continent) configured per session.
7. **LLM-agnostic core** — the ledger engine, spatial system, and state management don't depend on Claude specifically. Only `llm/client.js` knows about the Anthropic API.

---

## Testing Strategy

No test framework initially. Validate via:

```bash
# Syntax check all files
for f in $(find . -name '*.js'); do node -c "$f"; done
```

Manual testing loop:
1. Start bot, create a session in a test thread
2. Send a player message, verify prose + ledger block returned
3. Run `/state` to verify ledger committed correctly
4. Run `/map` to verify spatial rendering
5. Run `/snapshot`, send more messages, then `/rollback`
6. Enable ticking, verify autonomous world events

---

## Reference: Original AGENTS.md

The original SillyTavern extension architecture document should be included in the repository as `docs/ORIGINAL_AGENTS.md` for reference. Key things to preserve from the original:

- All entity types and operations
- State machine transitions (collision lifecycle, character tiers, constraint integrity)
- Self-correcting feedback loop behavior
- Divination tables and draw mechanics
- Memory tiering caps and consolidation
- Turn mode definitions (regular, combat, advance, intimacy)
- Deduction template structure (the LLM uses these inside `<think>` blocks)
- Injection slot purposes (_state, _readme, _inject, _nudge, etc.)
- OOC command behaviors

The Discord bot reimplements these concepts in a server context rather than a browser extension context.

---

## Notes for Claude Code

- Start with Phase 1. Get transactions appending and replaying correctly before touching Discord or the LLM.
- The ledger parser is critical — the regex for extracting `---LEDGER---` blocks must be robust against varied LLM formatting (extra whitespace, missing end markers, nested code blocks).
- The prompt assembler will be the most-iterated file. Keep it modular so injection slots can be reordered and toggled independently.
- For the spatial system, start with simple Manhattan distance. A* pathfinding can come later.
- Webhook creation has rate limits. Cache webhooks per channel and reuse them.
- SQLite is chosen for simplicity. If this scales to many concurrent sessions, migration to PostgreSQL is straightforward since the schema is simple.
- The tick system MUST have a kill switch. If a bug causes runaway ticks, `/worldtick off` or bot restart must stop all scheduled ticks immediately.
