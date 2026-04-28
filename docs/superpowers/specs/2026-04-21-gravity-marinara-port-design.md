# Gravity Service — Architecture & Migration Design

Date: 2026-04-21 (originally) — Rewritten 2026-04-26
Status: Draft (pending implementation)

> **History.** This document originally described a direct port of Gravity into Marinara as an embedded service with single-LLM (deterministic post-processing) state extraction. That design is **superseded in place by this rewrite**. The director-prototype results (`director-prototype` branch, validated 2026-04-26 — see `docs/superpowers/plans/2026-04-26-director-handoff.md`) confirmed that a separate director-model API call is the right architectural commitment, and conversation on 2026-04-26 also locked in a phase-3 native-frontend goal. Together those decisions make a host-embedded service the wrong shape — Gravity should be a **standalone service** with multiple host clients (SillyTavern transitional, Marinara as next host, native frontend as long-term home).

## 1. Goal and non-goals

**Goal.** Stand up Gravity as a standalone HTTP service that owns its engine, storage, and director LLM call. Hosts (SillyTavern extension, Marinara webhook agent, future native frontend) become thin clients of one stable API. The service survives any host transition with zero internal changes.

**Non-goals.**
- No fork of Marinara. Integration is a small webhook agent configured in Marinara's UI.
- No replacement of Marinara's prose-prompt assembly. Hosts still own character cards, persona, recent messages, lorebook — Gravity injects structural state on top.
- No multi-user / shared-deployment concerns in phase 1. Localhost-bound, single-user.
- No second LLM family beyond the director. The host's prose model and Gravity's director model are the only two LLM consumers.

## 2. Locked decisions

| # | Decision | Source |
|---|---|---|
| 1 | Two-LLM architecture: prose model (host-side) + director model (service-side). | Director-prototype validation 2026-04-26 |
| 2 | Standalone service, not host-embedded. | Phase-3 native-frontend goal |
| 3 | Gravity owns its own storage. Hosts pass `chatId` only; service maps it to internal state. | Service architecture |
| 4 | Director call lives inside the service. Hosts never see the OpenRouter key. | Auth simplification |
| 5 | Engine modules port from JS to TS. Pure logic, no host imports, fully node-testable. | Refactor goal |
| 6 | Marinara integration via custom webhook tool agent — no Marinara fork, no built-in agent registration. | Decoupling for phase 3 |
| 7 | SillyTavern extension stays usable as a thin client during transition. | Continuity for active sessions |
| 8 | The Gravity state-view (entity registry, dossiers, collisions, constraints, factions, knowledge_asymmetry) is the canonical context surface. Host-side `AgentContext` is convenient but not required — the ledger view is richer than a persona card for prose purposes. | Context-sufficiency analysis 2026-04-26 |

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Gravity Service                               │
│  (Node.js, single process, default port 9099, localhost-bound)      │
│                                                                     │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │ engine/ │   │ director/│   │ storage/ │   │ api/ (Express)   │ │
│  │ pure TS │   │ LLM call │   │ SQLite + │   │ HTTP endpoints   │ │
│  │         │   │ + prompt │   │ Drizzle  │   │ (see §6)         │ │
│  └─────────┘   └──────────┘   └──────────┘   └──────────────────┘ │
└────────────────────────────▲────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────┴────────┐  ┌────────┴───────┐  ┌────────┴─────────┐
│ SillyTavern    │  │ Marinara       │  │ Native Frontend  │
│ extension      │  │ webhook agent  │  │ (phase 3)        │
│ (thin client)  │  │ (~50 lines)    │  │ (own UI)         │
└────────────────┘  └────────────────┘  └──────────────────┘
```

### 3.1 Service responsibilities

- Owns canonical Gravity state per `chatId` in SQLite.
- Owns the director LLM call (OpenRouter, currently `anthropic/claude-sonnet-4-6`).
- Validates and commits transactions via the engine layer.
- Returns formatted state-view text on demand for prompt injection.
- Runs the correction-feedback loop (failed director ops → next-call corrections payload).
- Exposes import/export endpoints for chat portability.

### 3.2 Host responsibilities

- Maintains its own `chatId` namespace and passes it consistently.
- Assembles the prose-model prompt (cards, persona, recent messages, lorebook) and injects Gravity's state-view block at a fixed position.
- After the prose model responds, sends the response text + user message to the service for commit.
- Re-fetches state for the next turn.

### 3.3 Why this shape

The director-prototype proved a separate model can reliably emit ledger transactions from prose. The service architecture takes that further: the director call and the engine that consumes its output don't need to live in the host. Decoupling them means:

- One stable API surface across all hosts.
- The host only needs to know "ask Gravity for a state block, send Gravity the response after generation." That contract is small enough to implement in any host in ~50 lines.
- Phase 3 frontend reuses the same service. No rewrite, no second port.
- The OpenRouter key never leaves the service process.

## 4. Engine modules (TS port targets)

These existing JS modules port directly to TypeScript inside `engine/`. Each is pure (no host imports today already, or trivial decoupling needed):

| Source (JS) | Target (TS) | Notes |
|---|---|---|
| `consistency.js` | `engine/consistency.ts` | Tx shape validation. Pure. |
| `state-machine.js` | `engine/state-machine.ts` | Transition rules. Pure. |
| `state-compute.js` | `engine/state-compute.ts` | Replay → state. Pure. |
| `ledger-store.js` | `engine/ledger-store.ts` | Append-only log + snapshots. **Decouple `chatMetadata`/`saveMetadata`** — replace with storage-adapter interface. |
| `snapshot-mgr.js` | `engine/snapshot-mgr.ts` | Snapshot/rollback. Pure (consumes ledger-store). |
| `relationship.js` | `engine/relationship.ts` | Relationship logic. Already has node-test harness. |
| `state-view.js` | `engine/state-view.ts` | State formatting for injection. Mostly pure; has some host string helpers to tease apart. |

**Out of `engine/`** — these are host or service infrastructure, not engine:
- `index.js` (SillyTavern coordinator) → splits: SillyTavern extension client + service `api/` layer
- `ui-panel.js` → SillyTavern-only, stays in extension client
- `regex-intercept.js` → mostly dead under director architecture (block parsing); `stripUpdateBlock` and friends migrate to a host-side display cleaner
- `director-client.js`, `director-prompt.js`, `director-input.js` → port to `director/` module inside service
- `setup-wizard.js` → migrates to a host-side wizard that POSTs structured payloads to a service `init` endpoint (see §10)
- `ooc-handler.js` → host-side; becomes a thin layer that translates OOC commands to service API calls

## 5. Storage

### 5.1 Engine choice

**SQLite** via Drizzle ORM. One file per service installation (`gravity.db` in service config dir). Justified by: single-process, single-user, no network DB needed, Drizzle parity with Marinara's stack, file-portable for backup/share.

Future option: support Postgres via Drizzle's existing dialect abstraction. No phase-1 cost.

### 5.2 Schema (Drizzle)

Two storage models live side-by-side. **Both are required** — see §7 for why.

#### 5.2.1 Append-only transaction log (canonical)

```ts
gravity_transactions {
  id          integer PK autoincrement
  chat_id     text NOT NULL INDEX
  tx_id       integer NOT NULL  -- monotonic per chat (replaces _txCounter)
  op          text NOT NULL     -- CR | S | TR | A | R | MS | MR | D | SNAP | ROLL | AMEND
  e           text NOT NULL     -- entity type
  entity_id   text              -- nullable for world-scoped ops
  d           json              -- op-specific data
  r           text              -- one-sentence reason
  created_at  integer NOT NULL  -- unix ms
  source      text NOT NULL     -- 'director' | 'wizard' | 'amend' | 'rollback'
  UNIQUE(chat_id, tx_id)
}

gravity_snapshots {
  id          integer PK autoincrement
  chat_id     text NOT NULL INDEX
  tx_id       integer NOT NULL  -- snapshot taken at this tx
  state       json NOT NULL     -- full _currentState dump
  label       text              -- optional user-facing name
  created_at  integer NOT NULL
}
```

This is the source of truth. State is derived by replay.

#### 5.2.2 Derived state cache (performance)

```ts
gravity_state_cache {
  chat_id     text PK
  state       json NOT NULL     -- _currentState equivalent
  state_view  text NOT NULL     -- pre-rendered state-view block
  last_tx_id  integer NOT NULL  -- cache validity marker
  updated_at  integer NOT NULL
}
```

Updated atomically on every commit. Read by `GET /gravity/state/:chatId` to avoid re-replay on every prompt assembly.

Cache invalidation: any commit/rollback for a chat triggers a recompute and write. Deterministic, no TTL needed.

### 5.3 Migration from `chatMetadata`

Existing SillyTavern users have `chatMetadata['gravity_ledger']` containing `{ transactions, snapshots, lastTxId }`. The service exposes `POST /gravity/import` accepting the current export shape (see §9). The SillyTavern client gains an "Export to Gravity Service" button that POSTs the chatMetadata blob; the service replays it into the SQL store under a chosen `chatId`.

## 6. HTTP API

All endpoints under `/gravity`. JSON request/response. Localhost-only by default; no auth (single-user). If exposed beyond localhost, a static bearer token should be added.

### 6.1 State injection (per-turn read)

```
GET /gravity/state/:chatId
  Query: ?mode=regular|advance|combat|intimacy (default regular)
  Response 200: {
    chatId,
    mode,
    stateView,         // pre-rendered text block for prompt injection
    nudges: { ... },   // mode-specific deduction template + maintenance nudges
    pendingCorrections: [...],  // for surfacing in next prompt
    lastTxId
  }
  Response 404: chat not initialized
```

### 6.2 Director commit (per-turn write)

```
POST /gravity/commit
  Body: {
    chatId,
    mode,                      // turn type used to gate ops (e.g., advance_collision)
    userMessage: "...",
    assistantMessage: "...",   // the prose model's response
    recentTurns?: [{user, assistant}, ...]  // optional, last 1-3 turns
  }
  Response 200: {
    committed: number,
    rejected: number,
    errors: [{tx, error, fix}, ...],
    newState: {...},           // updated state cache
    newStateView: "...",       // pre-rendered for next prompt
    director: { model, durationMs, txsProposed, confidence }
  }
  Response 5xx: director call failed (network/auth/etc.) — service does not commit, returns reason
```

### 6.3 Manual ops (operator UI / OOC commands)

```
POST /gravity/append           — manual tx append (operator authority)
POST /gravity/snapshot         — explicit snapshot
POST /gravity/rollback         — rollback to snapshot
GET  /gravity/transactions/:chatId  — full tx log (for UI display)
GET  /gravity/snapshots/:chatId
```

### 6.4 Init / lifecycle

```
POST /gravity/init
  Body: {
    chatId,
    setupAnswers: { ... }       // see §10
  }
  Response: { initialState, initialTxs }

DELETE /gravity/chat/:chatId    — wipe a chat's state
```

### 6.5 Export / import

```
GET  /gravity/export/:chatId   — see §8 for shape options
POST /gravity/import
  Body: { chatId, data, format: 'transactions' | 'snapshot+tail' | 'state-only' }
```

### 6.6 Health

```
GET /gravity/health             — { ok: true, version, dbPath, openRouterConfigured }
```

## 7. Director call

Lives inside `director/`. Reuses the prompt + client design from the `director-prototype` branch with these locked-in lessons:

- **`response_format: { type: 'json_object' }`**, not `json_schema`. Strict json_schema triggers degenerate "satisfy schema with empty objects" loops on Bedrock-routed Claude.
- **Tolerant JSON extraction** — `extractJSON()` strips prose prefixes before `JSON.parse`. Some models prefix reasoning before the JSON.
- **Concrete priorities** in the system prompt: "track what happened / causal continuity / validator compatibility". The earlier abstract priorities ("earned change / conservative mutation") caused stuck `txs=0` outputs.
- **Explicit engine-owned-fields list** — the director must NEVER write `collision.distance`, `char.last_active_tx`, `relationship.status`, `world.timeskip_scale` (engine ticks these).
- **Short field names enforced** — `v` not `value`, `k` not `key`. The validator rejects long forms.
- **`max_tokens: 4096`** to give room for full-turn deltas.

### 7.1 Failure handling

Director call failures (network, auth, invalid JSON, schema mismatch) return 5xx from `POST /gravity/commit`. The service does not commit anything from a failed call. The host displays a "Gravity director failed — last turn not committed" badge.

Rejected transactions (validator failures) flow into the corrections queue. Next call's input includes them as structured `pendingCorrections`. After 3 attempts the correction is dropped (matches current `MAX_CORRECTION_ATTEMPTS`).

## 8. Export format reformatting

> **Open design question.** Today the SillyTavern extension exports `{ transactions: [...], snapshots: [...], lastTxId }` — a pure ledger of transactions, replayable from genesis. This is faithful but heavy: a long chat may carry thousands of txs even after consolidation.

Three candidate export shapes for the service:

| Shape | Contents | Pros | Cons |
|---|---|---|---|
| **A. Transactions (current)** | Full tx log from genesis + snapshots + lastTxId | Replay-faithful; lossless; debuggable | Large; replay cost on import |
| **B. Snapshot + tail** | Latest snapshot + txs since snapshot + lastTxId | Smaller; faster import; still replayable from snapshot | Requires snapshots to exist; loses pre-snapshot detail |
| **C. State-only** | Derived state JSON, no tx log | Smallest; instant import | Loses history; no rollback; no audit trail |

**Recommendation (to be confirmed):** ship **all three** behind a `format` query param. Default to **B (snapshot+tail)** for routine export — it's the right tradeoff for portability. **A** for backup/audit. **C** for "send my current state to a teammate" lightweight share.

### 8.1 Backward compatibility

- `POST /gravity/import` accepts the current SillyTavern shape (`{ transactions, snapshots, lastTxId }`) under `format: 'transactions'`. No data is stranded.
- Service-side, internal storage stays append-only regardless of which format is exported.

### 8.2 Versioning

Export envelope adds:
```json
{
  "gravityExportVersion": 2,
  "format": "snapshot+tail",
  "createdAt": 1234567890,
  "data": { ... }
}
```
Version 1 = the legacy SillyTavern shape (recognized on import by absence of envelope).

## 9. Host integration patterns

### 9.1 SillyTavern extension (transitional client)

Current extension code shrinks dramatically. New responsibilities:

- Replace `extractUpdateBlock` / `consistency.validate` / `appendTransactions` chain with `POST /gravity/commit`.
- Replace direct `state-view.formatStateView()` injection with `GET /gravity/state/:chatId` followed by `setExtensionPrompt(MODULE_NAME, '_state', stateView, ...)`.
- Operator UI panel (`ui-panel.js`) reads from `GET /gravity/transactions/:chatId` and `GET /gravity/snapshots/:chatId`.
- OOC commands (`ooc-handler.js`) become thin translators: `power review` → POST manual op, `snapshot` → POST snapshot, etc.
- Setup wizard collects answers in DOM, POSTs to `/gravity/init`. No prose-model emission for setup.

The extension keeps its `chatId` mapping (one Gravity chat per SillyTavern chat). Service must be running locally; extension shows a "Gravity service unreachable" banner if not.

### 9.2 Marinara webhook agent

Configured entirely in Marinara's UI as a **user-created agent** with a webhook custom tool. No fork. No built-in agent registration. Estimated <100 lines of agent-side glue (a system prompt + tool config).

Two agent phases:

1. **`pre_generation` agent** — calls `GET /gravity/state/:chatId`, injects the `stateView` as a context section. (Or: a single stateful agent that handles both phases if Marinara supports that.)
2. **`post_processing` agent** — calls `POST /gravity/commit` with the `mainResponse` from `AgentContext`. Logs commit results.

The agent's `chatId` is Marinara's `AgentContext.chatId` passed verbatim. No translation.

### 9.3 Native frontend (phase 3)

Future React/Tauri app. Consumes the same HTTP API. The prose-model call lives in the frontend (or a lightweight backend it speaks to); state injection and commit are the same `GET /gravity/state` and `POST /gravity/commit` calls.

The native frontend is the long-term home but is not blocked on Marinara — it can be built in parallel against the same service.

## 10. Initialization & setup — open question, needs more thought

> **This section is deliberately incomplete.** Setup is the thorniest open issue and we want to think it through before locking a design. What's below is a sketch, not a commitment.

### 10.1 Today's flow (SillyTavern)

`setup-wizard.js` collects structured answers (opening situation, power scale, PC base, principal characters, factions, places, abilities) via DOM forms, then constructs a prose-side prompt (~50 lines of "EMIT ALL OF THE FOLLOWING in one ---LEDGER--- block:") that the prose model fulfills by emitting CR transactions. Brittle — prose model gets contradictory instructions, and the answers don't survive the director-prototype cutover.

### 10.2 Three plausible service-side shapes

**Option X — Pure deterministic init.** Service exposes `POST /gravity/init` accepting structured `setupAnswers`. Service constructs CR transactions directly from form input — no LLM call. Pros: deterministic, fast, no prose-model hallucination. Cons: rigid; the wizard's value today is partly in *interpreting* user input narratively (e.g., "small criminal organization with three lieutenants" → 4 char CRs with implicit relationships).

**Option Y — Director-mediated init.** Service POST receives `setupAnswers`, runs a one-shot director call ("convert these answers to initial transactions"), commits. Pros: keeps the narrative interpretation; reuses the director call shape. Cons: a director call before any state exists is conceptually different from the per-turn director call (no state to read, no recent ledger tail) — needs a separate prompt.

**Option Z — Bridge / hybrid.** Some fields go straight to deterministic CRs (PC name, factions, places); narrative fields ("opening situation", "what the principal wants") go through a director-mediated pass. Most realistic but most code.

### 10.3 Bridge concern

Even after the service exists, the SillyTavern extension and Marinara may need to handle init flows differently:

- SillyTavern extension already has the wizard DOM. It can collect answers and POST to `/gravity/init`.
- Marinara doesn't have a Gravity-specific wizard UI. Either (a) Gravity ships its own minimal setup UI served by the service, (b) Marinara users initialize via OOC command in chat (`/gravity init` → opens form), or (c) skip the wizard for Marinara and require manual ops to seed state.

This needs a separate sub-spec once the architecture is stood up. For phase 1 of the service: ship Option X (deterministic init) with the existing SillyTavern wizard schema as the input shape. Defer the narrative-interpretation case until the deterministic path is proven.

### 10.4 Timeskip / advance turn parity

Same question shape: timeskip currently uses prose-model emission. Service should expose `POST /gravity/timeskip` that takes `{ chatId, scale, summary }` and applies the timeskip rules deterministically (advancing relationships, dormant character flags, faction heartbeat, collision ticks per scale). No LLM call needed; same transactional shape.

## 11. State delta / op vocabulary

The director's output shape stays exactly as the director-prototype validated it — Gravity's existing tx object format:

```json
[
  { "op": "TR", "e": "collision", "id": "bridge-confrontation",
    "d": { "f": "status", "from": "ACTIVE", "to": "RESOLVED" },
    "r": "PC forced confrontation on-screen and it completed." },
  { "op": "MS", "e": "char", "id": "elena",
    "d": { "f": "knowledge_asymmetry", "k": "knows_evidence", "v": "Has seen the documents." },
    "r": "She just read them." }
]
```

No new op vocabulary; the existing 11 ops (`CR`, `S`, `TR`, `A`, `R`, `MS`, `MR`, `D`, `SNAP`, `ROLL`, `AMEND`) and 11 entity types (`char`, `constraint`, `collision`, `combat`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`, `relationship`) carry over unchanged. The TS port preserves the validator semantics exactly.

The original 2026-04-21 design proposed a higher-level op vocabulary (`create_collision`, `advance_collision`, etc.). That layer is now rejected — it added a translation seam without buying anything. Director-prototype proved the existing tx shape is workable.

## 12. Migration sequence

1. **B (this doc).** Done.
2. **C0 — engine extraction.** In *this* repo, isolate engine modules (consistency, state-machine, state-compute, ledger-store, snapshot-mgr, relationship, state-view) into a clean folder with zero SillyTavern imports. Add storage-adapter interface so ledger-store can talk to either `chatMetadata` (existing) or SQLite (future). Full node test coverage. **Output:** SillyTavern extension still works, all logic node-testable.
3. **C1 — service skeleton.** New service repo (or `service/` subfolder). Express + Drizzle + SQLite. Port engine modules to TS. Implement HTTP API §6. Director call ported from `director-prototype` branch. **Output:** standalone service runnable, tested against synthetic inputs.
4. **C2 — SillyTavern thin client.** Extension swaps direct engine calls for HTTP calls. Existing chats migrate via export → import. **Output:** SillyTavern extension is a thin client; service is the source of truth.
5. **D — Marinara webhook agent.** Build the user-created agent in Marinara UI. **Output:** Marinara users can run Gravity.
6. **E — phase 3 frontend.** Whenever. Same API.

## 13. Out of scope (this spec)

- The native frontend's UI design (phase 3 separate spec).
- Multi-user / cloud-deployed service variants.
- Plugin/extension system for third-party Gravity ops.
- Performance tuning beyond the state-cache table.
- Director model fine-tuning, eval suites, or comparative model benchmarks (separate evaluation plan).
- Setup wizard's narrative-interpretation path (Option Y/Z above) — deferred until Option X proven.
- Bridge for Marinara setup UX — see §10.3.

## 14. References

- `Documentation/gravity_director_handoff.md` — original director architecture argument
- `docs/superpowers/specs/2026-04-25-gravity-director-design.md` — director prototype spec (in-extension version, now feeds into the service)
- `docs/superpowers/plans/2026-04-25-gravity-director.md` — director implementation plan
- `docs/superpowers/plans/2026-04-26-director-handoff.md` — director-prototype validation results (the `director-prototype` branch state)
- `Documentation/system_architecture_reference.md` — current code map
- Marinara: `D:\claude\Marinara\MarinaraEngine\Marinara-Engine` — host integration target (agent pipeline at `packages/server/src/services/agents/`, schema at `packages/server/src/db/schema/`)
