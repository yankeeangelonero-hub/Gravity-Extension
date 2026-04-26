# Gravity Ledger — Marinara Embedded Integration Design

Date: 2026-04-26
Status: Selected direction (revised 2026-04-26 after Marinara codebase audit)

> **Context.** This document describes the embedded architecture for porting Gravity Ledger into Marinara Engine. It supersedes — for the current planning round — the standalone-service alternative at `2026-04-21-gravity-marinara-port-design.md`. The key fork: this path makes Marinara Gravity's permanent home and builds against its internals. The service path treats Marinara as one of N hosts.

> **Revision note (2026-04-26).** A careful audit against the Marinara codebase (`Marinara Engine/Marinara-Engine/`, `marinara-engine` v1.5.5) drove these changes from the first draft:
>
> - **§3.2 rewritten.** The "make `buildAgentExtras` async" approach is replaced with the existing pre-step loader pattern (`context.memory._availableSprites` and friends). Avoids cascading API changes across `agent-executor.ts` and `agent-pipeline.ts`.
> - **§4 corrected.** `AgentContext.memory` is request-scoped scratchpad, not persistent storage. Persistent agent state lives in the `agent_memory` DB table and is accessed via storage helpers (async). The spec now distinguishes the two clearly, defines `CorrectionsPayload`, and adopts a tolerant-JSON contract for cross-provider portability.
> - **§3.3 tightened.** New tables declare FKs to `chats.id` and follow Marinara's `createdAt`/`updatedAt` timestamp convention.
> - **§3.4 expanded.** Prompt templates use the existing `getDefaultAgentPrompt` + DB-override pattern. Pino logger required server-side per Marinara CLAUDE.md.
> - **§9 updated.** Coupling-risk row for `buildAgentExtras` drops from medium to low under the new approach.

## 1. Core premise

Gravity is implemented as **two built-in Marinara agents** sharing a common engine and DB schema inside the Marinara monorepo:

- `gravity-ledger-inject` — `pre_generation` phase. Reads cached Gravity state, returns a `context_injection` result containing the state-view block for the prose model's prompt.
- `gravity-ledger-director` — `post_processing` phase. Receives `mainResponse` from `AgentContext`, runs the Gravity director LLM call via Marinara's existing provider system, validates and commits transactions to SQL, updates the state cache, persists corrections.

Both agents share:

- A common `packages/server/src/services/gravity/engine/` module (pure TS engine logic ported from the JS extension).
- Gravity-specific DB tables in `packages/server/src/db/schema/`.
- Marinara's existing provider infrastructure (no bespoke OpenRouter client — user configures the director connection in Marinara's UI).

No standalone service. No second process. No HTTP boundary.

## 2. What Marinara's pipeline provides for free

Reading `agent-executor.ts` and `agent-pipeline.ts`:

| Marinara feature | Gravity benefit |
|---|---|
| `AgentContext.mainResponse` | Post-generation agent receives the prose text directly — no parsing |
| `AgentContext.memory` (`Record<string, unknown>`) | Request-scoped scratchpad. Pre-step loaders populate underscore-prefixed keys (e.g. `_availableSprites`, `_existingLorebookEntries`) read sync by `buildAgentExtras` |
| `agent_memory` DB table | Persistent K-V per agent per chat; Gravity stores correction queue, last committed txId, resolved mode here. Read/written via async storage helpers (`getAgentMemoryValue`, `setAgentMemoryValue`) |
| `AgentContext.characters` | Character cards (name, description) available to the director — useful for bootstrapping `char` entities on first reference |
| `AgentContext.activatedLorebookEntries` | The director sees which lore entries were surfaced this turn — genuine signal Gravity's own state doesn't carry |
| `AgentContext.chatSummary` | Rolling summary available — reduces the director's need for `recentTurns` input |
| `AgentContext.signal` | AbortSignal wired through to provider calls — clean cancellation on swipe/regenerate |
| Provider+model batching | Same connection+model groups into one LLM call (`agent-pipeline.ts:48-63`). **Caveat:** tool-using agents are extracted from batches (`agent-executor.ts:90`); director must declare no tools to participate in batching |
| Connection override per agent | `AgentConfig.connectionId` resolves to a `BaseLLMProvider` instance — user sets the director model in Marinara's agent settings drawer |
| `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS` | Director can run every N turns; default is per-agent in `agent.ts:468` |
| Chat branching / checkpoints | Existing feature; preserves chat metadata. See §6 for Gravity's snapshot/branching strategy |
| SSE streaming events | `AgentResult` events fire over the SSE stream; Gravity state panel can subscribe |

## 3. Exact coupling surface (files to change in Marinara)

This is what a fork actually touches. The audit in §1's revision note drove these from the first draft.

### 3.1 `packages/shared/src/types/agent.ts`

Add to the `AgentResultType` union (currently 20 entries at `agent.ts:15-40`):
```ts
| "gravity_state_update"
```

Add to `BUILT_IN_AGENT_IDS` (`agent.ts:157`):
```ts
GRAVITY_LEDGER_INJECT: "gravity-ledger-inject",
GRAVITY_LEDGER_DIRECTOR: "gravity-ledger-director",
```

Add two entries to `BUILT_IN_AGENTS[]`:
```ts
{
  id: "gravity-ledger-inject",
  name: "Gravity Ledger (State Injection)",
  description: "Injects Gravity structural state — collisions, constraints, character dossiers, factions — into the prose model's prompt each turn.",
  phase: "pre_generation",
  enabledByDefault: false,
  defaultInjectAsSection: true,
  category: "tracker",
},
{
  id: "gravity-ledger-director",
  name: "Gravity Ledger (Director)",
  description: "After each prose response, interprets structural state changes and commits them to the Gravity ledger. Requires a separate model connection configured as the director.",
  phase: "post_processing",
  enabledByDefault: false,
  category: "tracker",
},
```

`category: "tracker"` is already established (`agent.ts:183`); existing tracker agents include `world-state`, `quest`, `character-tracker`, `custom-tracker`. Use them as registration templates.

Add to `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS` (`agent.ts:468-472`):
```ts
"gravity-ledger-director": 1,  // every turn; user-adjustable
```

**Default prompt templates.** Director and inject agents need system prompts. Marinara's pattern (`agent-executor.ts:49`) resolves them via `getDefaultAgentPrompt(agentType)`, with per-agent overrides stored in `agent_configs.promptTemplate`. Add Gravity prompts to `packages/shared/src/constants/agent-prompts.ts` (the existing prompt registry).

**Name collision check (still safe):** `BUILT_IN_AGENT_IDS.DIRECTOR = "director"` already exists at `agent.ts:157` as "Narrative Director" (pre_generation event-injector, `category: "writer"`). Different responsibility; different id. No conflict as long as we use `gravity-ledger-inject` and `gravity-ledger-director`. Never reuse `"director"`.

### 3.2 Pre-step loader + sync read in `agent-executor.ts` (revised approach)

The first draft proposed making `buildAgentExtras` async to load Gravity state from the DB. The audit found Marinara already has a cleaner pattern: **pre-step loaders in `generate.routes.ts` populate `context.memory._<key>` before the pipeline runs; `buildAgentExtras` reads them sync.** Existing examples: `_availableSprites`, `_availableBackgrounds`, `_existingLorebookEntries`, `_sourceMaterial`, `_chunkInfo`, `_previousExtractions`, `_knowledgeRetrievalMaterial`. We adopt the same pattern.

**Three additions, all small:**

**(a) Pre-step loader in `packages/server/src/routes/generate.routes.ts` (alongside the existing loaders around `:3220`):**
```ts
if (resolvedAgents.some((a) => a.type === "gravity-ledger-inject" || a.type === "gravity-ledger-director")) {
  try {
    const gravityState = await loadGravityStateForChat(chatId);
    if (gravityState) {
      agentContext.memory._gravityState = gravityState;
      // shape: { stateView: string, recentTail: TransactionLike[], mode: GravityMode, archiveVersion: string }
    }
  } catch (err) {
    logger.warn(err, "[gravity] state cache load failed; continuing without injection");
  }
}
```
`loadGravityStateForChat` lives in `services/gravity/engine/state-cache.ts` and queries `gravity_state_cache` by `chat_id`.

**(b) Sync read block in `agent-executor.ts:buildAgentExtras` (alongside the existing `_availableSprites` block at `:720`):**
```ts
if (context.memory._gravityState) {
  const gs = context.memory._gravityState as GravityStateView;
  parts.push(`<gravity_state>`);
  parts.push(gs.stateView);
  parts.push(`</gravity_state>`);
}
```

**(c) Dispatch case in `parseAgentResponse`:**
```ts
case "gravity-ledger-director":
  return parseGravityDirectorResponse(responseText);
```
`parseGravityDirectorResponse` lives in the gravity engine module; the executor just dispatches.

**Coupling impact:** `buildAgentExtras` keeps its current synchronous signature. No cascade through `executeAgent`, `executeAgentBatch`, `buildBatchSystemPrompt`, or `agent-pipeline.ts`. The async DB call lives in `generate.routes.ts`, which is already async. This is the highest-leverage simplification surfaced by the audit.

### 3.3 `packages/server/src/db/schema/`

New files (one table per file, matching Marinara's existing convention):

```
packages/server/src/db/schema/gravity-transactions.ts
packages/server/src/db/schema/gravity-state-cache.ts
packages/server/src/db/schema/gravity-snapshots.ts
```

`packages/server/src/db/schema/index.ts` — add three exports (additive; pattern matches existing entries at `:1-18`).

**Conventions to follow** (drawn from `agents.ts`, `chats.ts`, etc.):
- Drizzle ORM (`sqliteTable`, `text`, `integer`, `blob`).
- `text("id").primaryKey()` for IDs (matches existing tables).
- All three tables include `chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" })`.
- Standard `createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql\`(unixepoch())\`)` and `updatedAt` columns.
- JSON payloads stored as `text("payload")` (per `agents.ts:16`).
- Indices on `(chat_id, created_at)` for `gravity_transactions` (replay performance) and `(chat_id)` on the other two.

**Migration:** `pnpm db:push` regenerates SQL from the TS schema (per Marinara CLAUDE.md). No hand-written migration file.

### 3.4 New directory `packages/server/src/services/gravity/`

```
packages/server/src/services/gravity/
  engine/
    consistency.ts        — tx shape validation (ported from consistency.js)
    state-machine.ts      — transition rules
    state-compute.ts      — replay → state
    ledger-store.ts       — append-only log (reads/writes gravity_transactions table)
    snapshot-mgr.ts       — snapshot logic
    relationship.ts       — relationship logic
    state-view.ts         — state formatting for injection
    state-cache.ts        — gravity_state_cache reader/writer; exposes loadGravityStateForChat
  director/
    client.ts             — LLM call via BaseLLMProvider; tolerant JSON parse
    prompt.ts             — director system prompt + op vocabulary (consumed by getDefaultAgentPrompt)
    input.ts              — payload builder; types for CorrectionsPayload, GravityMode
  agents/
    inject-agent.ts       — gravity-ledger-inject executor
    director-agent.ts     — gravity-ledger-director executor
    response-parser.ts    — parseGravityDirectorResponse (called from agent-executor.parseAgentResponse)
```

**Logging convention.** All server-side files import the shared Pino logger:
```ts
import { logger } from "../../lib/logger.js";
```
Per Marinara CLAUDE.md: never `console.log/warn/error` in server code; use Pino format specifiers. Errors: `logger.error(err, "message")`.

**Nothing else in Marinara is modified** beyond §3.1, §3.2 (a/b/c), and §3.3. New files in `services/gravity/` are Marinara-untouched.

## 4. Director call via Marinara's provider

The director uses `BaseLLMProvider` — the same interface every other Marinara agent uses.

The director agent's `connectionId` is set by the user in Marinara's agent settings (any configured connection — OpenRouter, Anthropic, OpenAI, local, etc.). The agent executor resolves it to a `BaseLLMProvider` instance and passes it to the director executor.

**Two memory surfaces, two access patterns:**

| Surface | What lives there | Access |
|---|---|---|
| `context.memory._gravityState` (request-scoped) | The state cache row loaded by the pre-step in §3.2(a). Cleared between requests. | Sync read inside the executor. |
| `agent_memory` DB table (persistent per `agentConfigId`+`chatId`) | `pendingCorrections`, `lastCommittedTxId`, `gravityMode`. Survives across turns. | Async via `getAgentMemoryValue` / `setAgentMemoryValue` from `services/storage/agents.storage.ts`. |

The first draft conflated these by reading `context.memory.pendingCorrections`. Corrected here.

**Director executor (post_processing):**

```ts
// services/gravity/agents/director-agent.ts
import { logger } from "../../../lib/logger.js";
import { getAgentMemoryValue, setAgentMemoryValue } from "../../storage/agents.storage.js";

export async function executeDirectorAgent(
  config: AgentExecConfig,
  context: AgentContext,
  provider: BaseLLMProvider,
  model: string,
): Promise<AgentResult> {
  const gravityState = context.memory._gravityState as GravityStateView | undefined;
  if (!gravityState) {
    logger.debug("[gravity-director] no state cache; chat not initialized");
    return makeNotInitializedResult(config);
  }

  const corrections = (await getAgentMemoryValue(
    config.id, context.chatId, "pendingCorrections",
  )) as CorrectionsPayload | null;

  const mode = ((await getAgentMemoryValue(
    config.id, context.chatId, "gravityMode",
  )) as string | null) ?? "regular";

  const input = buildDirectorInput({
    mode,
    assistantMessage: context.mainResponse ?? "",
    stateView: gravityState.stateView,
    recentLedgerTail: gravityState.recentTail,
    pendingCorrections: corrections,
    chatSummary: context.chatSummary ?? null,
    activatedLorebookEntries: context.activatedLorebookEntries ?? [],
  });

  const proposal = await callDirector(input, provider, model, context.signal);
  if (!proposal.ok) {
    logger.warn({ reason: proposal.reason }, "[gravity-director] proposal failed");
    return makeDirectorError(config, proposal.reason);
  }

  const { committed, rejected, errors } = await validateAndCommit(context.chatId, proposal.transactions);
  await setAgentMemoryValue(config.id, context.chatId, "pendingCorrections", buildCorrectionsPayload(errors));
  await updateStateCache(context.chatId);  // Gravity-owned helper; not a Marinara hook

  return {
    agentId: config.id,
    agentType: config.type,
    type: "gravity_state_update",
    data: { committed, rejected, errors, model, durationMs: proposal.durationMs },
    tokensUsed: proposal.tokensUsed,
    durationMs: proposal.durationMs,
    success: true,
    error: null,
  };
}
```

**`updateStateCache` is Gravity-owned** (lives in `engine/state-cache.ts`). It rewrites the `gravity_state_cache` row for the chat after a successful commit. Not a Marinara hook.

### 4.1 Response format and provider portability

The first draft assumed `response_format: { type: "json_object" }` works universally. The audit found `BaseLLMProvider.responseFormat` is forwarded verbatim to the underlying SDK; OpenAI honors it, Anthropic/Google/local providers may ignore it.

**Stance:** the director uses `responseFormat: { type: "json_object" }` as an optimization but **never depends on it**. The tolerant JSON extractor (already proven in the prototype — handles markdown fences, leading prose, trailing trailers) is the contract. Provider portability comes from this fallback, not from format negotiation.

This matches the prototype lessons (`json_object` mode + tolerant parse, validated against the Bedrock Claude bug) and removes a hidden coupling to OpenAI-only deployments.

### 4.2 `CorrectionsPayload` shape

Defined in `services/gravity/director/input.ts`:

```ts
export type CorrectionEntry = {
  txId: string;             // the rejected transaction's id
  rejectedTx: unknown;      // serialized transaction, for the director to amend
  reason: string;           // validator error message
  attempt: number;          // 1..MAX_CORRECTION_ATTEMPTS (3)
};

export type CorrectionsPayload = {
  entries: CorrectionEntry[];
  generatedAt: number;      // unix seconds
};
```

Stored as JSON in `agent_memory.value` (the table column is `text`, per `agents.ts:46`). Cleared on successful commit; entry attempts dropped after `MAX_CORRECTION_ATTEMPTS = 3`.

## 5. Context injection path

The inject agent runs in `pre_generation` and returns `context_injection`. It does no LLM call and no DB write — it formats the pre-loaded state-cache snapshot and a mode-specific nudge.

```ts
// services/gravity/agents/inject-agent.ts
export async function executeInjectAgent(
  config: AgentExecConfig,
  context: AgentContext,
): Promise<AgentResult> {
  const gravityState = context.memory._gravityState as GravityStateView | undefined;
  if (!gravityState) return makeNotInitializedResult(config);

  const mode = ((await getAgentMemoryValue(
    config.id, context.chatId, "gravityMode",
  )) as string | null) ?? "regular";

  const stateView = gravityState.stateView;
  const nudge = buildNudge(mode, gravityState);

  return {
    agentId: config.id,
    agentType: config.type,
    type: "context_injection",
    data: { text: [stateView, nudge].filter(Boolean).join("\n\n") },
    tokensUsed: 0,
    durationMs: 0,
    success: true,
    error: null,
  };
}
```

`defaultInjectAsSection: true` (set at registration in §3.1) tells the assembler to inject this as a prompt section; `context_injection` results are already consumed by `prose-guardian` and `knowledge-retrieval` agents, so the assembler path needs no changes.

## 6. Storage and snapshots

Three Gravity-owned tables, all keyed by `chat_id`:
- `gravity_transactions` — append-only ledger.
- `gravity_state_cache` — pre-rendered state-view + recent ledger tail (refreshed on commit by `updateStateCache`).
- `gravity_snapshots` — explicit `SNAP`/`ROLL` checkpoints.

**Snapshot/rollback vs chat branching.** Marinara's chat-branching feature copies messages and metadata under a new `chat_id`. Gravity transactions are scoped by `chat_id`, so a branch creates a new chat with no Gravity history.

Three options:

- **A. Keep snapshot-mgr (recommended for phase 1).** Gravity manages its own snapshot/rollback independently of Marinara branching. `snapshot-mgr.ts` ports from the extension. Users use Gravity's own `SNAP`/`ROLL` ops via OOC; Marinara branching is unrelated to Gravity.
- **B. Hook into Marinara branching (later enhancement).** On branch creation, copy Gravity rows under the new `chat_id`. Marinara doesn't currently emit a branching event; this would require either adding an event emitter to chat storage or running the copy at the branch-route handler. Defer.
- **C. Hybrid.** Marinara branching triggers a Gravity snapshot; rollback to Marinara branch also rolls back Gravity. Most integrated, most coupled. Defer.

Option A keeps coupling at zero and preserves prototype-validated operator behavior. Revisit after phase 1.

## 7. Setup / initialization

Marinara doesn't ship a Gravity-specific form UI. Two paths:

- **OOC command + modal (recommended).** Add an OOC handler `/gravity init`; the command opens a Marinara modal (Marinara already uses modals for other features), collects answers, posts to an internal route handled by `services/gravity/agents/setup-agent.ts` or a new route in `routes/gravity.routes.ts`. Engine creates initial transactions deterministically — no LLM call for setup. Same constraints as the service-spec's §10.
- **Inject-agent fallback.** If no state for the chat, the inject agent emits a one-time prompt instructing the prose model to gather setup info. Conflicts with director-owned ledger emission; only acceptable as a degraded path.

Recommend the OOC modal path. **Still needs a sub-spec** — same judgment as the service path.

## 8. Export / import

Marinara's chat export endpoint (`chats.routes.ts:926-1010`) currently writes messages + character/user names + metadata only — no agent data, no tracker state.

Two options:

- **A. Extend Marinara's chat export.** Add a `gravity` field to the export envelope at `chats.routes.ts:991` containing the chat's transactions + state cache + snapshots. Portable across Marinara instances. Touches one Marinara route file.
- **B. Separate Gravity export endpoint** at `/api/gravity/export/:chatId`. Independent of chat export; less coupled but less integrated.

**Phase 1: ship B** (independent endpoint) to avoid scope creep on the chat-export surface. **Phase 2: extend A** once the embedded port is stable. Same export-format question as the service spec (transactions / snapshot+tail / state-only — ship all three; default snapshot+tail).

## 9. Coupling risk assessment

Updated after the §3.2 revision.

| Marinara change | Impact (revised) |
|---|---|
| `AgentResultType` enum extended | Zero impact (we add to it; they can add more) |
| `AgentResultType` renamed/restructured | One-line fix to `"gravity_state_update"` |
| `AgentContext` field renamed (e.g. `mainResponse → responseText`) | One-line fix in `director-agent.ts` |
| `AgentContext` field removed | Higher impact for `agentMemory` storage helpers and `mainResponse`; medium for others |
| `buildAgentExtras` signature changes | **Low** under the pre-step pattern (we only add a sync read block; no signature change) |
| `parseAgentResponse` dispatch refactored | Must update our case — medium |
| `BaseLLMProvider` interface changes | Must update `client.ts` — could be significant |
| Agent pipeline phases changed/added | Re-target `phase` value — minor to significant |
| `agent_memory` storage API changes | Must update memory access in `director-agent.ts` and `inject-agent.ts` — medium |
| Drizzle version upgrade | Standard migration; affects all schema equally |
| `agent_configs` / `agent_runs` schema changed | Must update agent registration if shape changes |

**Highest actual risk:** `BaseLLMProvider` interface and `AgentContext` field stability. Both internal to Marinara's server package; strong implicit stability guarantees (every built-in agent depends on them) but no explicit versioned contract. **API-stability signal from `git log` of `agent.ts` and `agent-executor.ts`:** medium-high. Recent commits are additive (new agents) or refinements (logging refactor); core types unchanged for months.

**Lowest risk:** DB schema additions (purely additive), `AgentResultType` additions (purely additive), new files in `services/gravity/` (Marinara never touches them), pre-step loader and `buildAgentExtras` read block (additive).

## 10. When this path is better than the service path

| Factor | Embedded wins | Service wins |
|---|---|---|
| Marinara is the long-term home (phase 3 = Marinara-native frontend) | ✓ — no throwaway work | |
| Phase 3 is a fully independent frontend | | ✓ — embedded work is throwaway |
| SillyTavern needs to stay usable in parallel | | ✓ — service handles both; embedded doesn't |
| User comfort: one process, one config | ✓ | |
| Director model configured in Marinara UI | ✓ | |
| Lorebook entries and chat summary available to director | ✓ | |
| No coupling at all to Marinara internals | | ✓ |
| Potential upstream PR / maintainer-maintained | ✓ — if accepted | |
| Port to any future host without rework | | ✓ |
| Works without Marinara running | | ✓ |

## 11. Migration sequence (embedded path)

1. **Engine extraction** (in this repo first). Isolate JS engine modules into clean, host-agnostic form. Add node tests. Same as C0 in the service path — this step is shared between both architectures.
2. **Fork Marinara.** Create a working branch in a separate clone; add §3.1 registrations.
3. **Port engine to TS.** Move extracted modules into `packages/server/src/services/gravity/engine/`. Add `state-cache.ts`. Wire to DB.
4. **Add the three schema files.** `pnpm db:push`. Verify FKs and indices.
5. **Add the pre-step loader** in `generate.routes.ts` (§3.2(a)) and the sync read block in `agent-executor.ts:buildAgentExtras` (§3.2(b)).
6. **Build the two agents.** `inject-agent.ts`, `director-agent.ts`, `response-parser.ts`. Use `BaseLLMProvider` and Pino logger throughout. Test with synthetic inputs.
7. **Add prompt templates** to whatever module backs `getDefaultAgentPrompt`. Verify per-agent override works through the agent settings UI.
8. **Enable in Marinara.** Configure `gravity-ledger-inject` and `gravity-ledger-director` in agent settings. Point director at a connection. Test live.
9. **SillyTavern export → Marinara import.** Build the `POST /api/gravity/import` route. Migrate active chats.
10. **Setup wizard.** OOC modal path per §7.
11. **Phase-2 hardening.** Extend chat export (§8 option A). Optional: Marinara branching hook (§6 option B).

## 12. Summary comparison (both specs side by side)

|  | Embedded (this spec) | Standalone service (other spec) |
|---|---|---|
| Process count | 1 | 2 (Marinara + Gravity service) |
| Marinara fork required | Yes | No |
| Files changed in Marinara | ~5 (additive) | 0 |
| Engine module location | `packages/server/src/services/gravity/engine/` | `gravity-service/engine/` |
| Director model config | Marinara agent settings (UI) | Service env var / settings file |
| AgentContext available | Yes | No (compensated by ledger state) |
| Persistent agent memory | `agent_memory` DB table | Service-internal store |
| Chat branching integration | Possible (Option B/C, deferred) | Not applicable |
| SillyTavern parallel support | No | Yes |
| Phase 3 independent frontend | Rework required | No rework |
| Upstream PR possibility | Yes | N/A |
| Coupling to Marinara internals | Real, bounded, mostly additive | Near-zero |
| Auth for director key | Marinara connection system | Service-internal |

## 13. References

- `2026-04-21-gravity-marinara-port-design.md` — the standalone service design (the other option)
- `2026-04-25-gravity-director-design.md` — director prototype spec (in-extension reference)
- `2026-04-26-director-handoff.md` — prototype validation results
- Marinara: `packages/shared/src/types/agent.ts` — `AgentResultType`, `AgentContext`, `BUILT_IN_AGENTS`, `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS`
- Marinara: `packages/server/src/services/agents/agent-executor.ts` — `parseAgentResponse`, `buildAgentExtras` (sync; pre-step loaders read at `:601-810`), `JSON_AGENTS`, batching at `:404`
- Marinara: `packages/server/src/services/agents/agent-pipeline.ts` — phase orchestration; tool extraction from batches at `:90`
- Marinara: `packages/server/src/services/storage/agents.storage.ts` — `getAgentMemoryValue`, `setAgentMemoryValue`
- Marinara: `packages/server/src/routes/generate.routes.ts:3220-3260` — existing pre-step loader pattern (`_availableSprites`, `_availableBackgrounds`, `_existingLorebookEntries`)
- Marinara: `packages/server/src/db/schema/agents.ts` — `agentConfigs`, `agentMemory`, `agentRuns` schemas
- Marinara: `CLAUDE.md` — Pino logging mandate, `pnpm check` / `pnpm db:push` workflow
