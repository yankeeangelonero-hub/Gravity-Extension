# Gravity Ledger Panel UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped Gravity Ledger WidgetPopover with a full-height Side Drawer that exposes a structured State tab and a per-turn Turns tab, so the user can verify the director is committing meaningful transactions and inspect the ledger turn-by-turn.

**Architecture:** Server-side, project the engine state into structured `entities` on `/state/:chatId` and pass per-run data (committed/rejected txs, confidence, notes, turnSeq) through the `gravity-ledger-director` agent result. Client-side, replace the gravity store's `lastDirectorResult` with a session-capped `history: DirectorRun[]`, fetch state through TanStack Query keyed on `archiveVersion`, and render a Side Drawer (matching `ChatGalleryDrawer` convention) with State + Turns tabs. PC and characters share the same modal projection.

**Tech Stack:** TypeScript, React, Zustand, TanStack Query, Drizzle (SQLite), Fastify, Tailwind. Repo is the Marinara monorepo (`Marinara Engine/Marinara-Engine/`); branch is `gravity-integration`. Validation gate: `pnpm check` (TypeScript + ESLint). No automated test suite — manual smoke at phase boundaries.

**Working directory:** All paths in this plan are relative to `Marinara Engine/Marinara-Engine/`. Run `pnpm install` once at the start. Run `pnpm check` from the monorepo root after each task.

**Reference spec:** `docs/superpowers/specs/2026-04-27-gravity-ledger-panel-ui-design.md` (in the outer Gravity-Extension repo).

---

## File Structure

**Create:**
- `packages/shared/src/types/gravity-state.ts` — entity interfaces shared by server + client
- `packages/server/src/services/gravity/engine/entities-projection.ts` — pure function that projects `GravityState` → `GravityEntities`
- `packages/client/src/hooks/use-gravity-state.ts` — TanStack Query hook keyed on `archiveVersion`
- `packages/client/src/components/chat/GravityLedgerDrawer.tsx` — drawer shell + State tab + Turns tab + CharacterDetailModal (co-located sub-components)

**Modify:**
- `packages/shared/src/index.ts` — re-export gravity-state types
- `packages/server/src/services/gravity/agents/director-agent.ts` — pass through `committedTxs`, `rejectedTxs`, `confidence`, `notes`, `turnSeq`
- `packages/server/src/routes/gravity.routes.ts` — add `entities` to `/state/:chatId` response
- `packages/client/src/stores/gravity.store.ts` — replace `lastDirectorResult` with `history: DirectorRun[]`
- `packages/client/src/stores/chat.store.ts` — call `useGravityStore.getState().reset()` on chat switch
- `packages/client/src/hooks/use-generate.ts` — replace `setDirectorResult` calls with `addDirectorRun`
- `packages/client/src/components/chat/RoleplayHUD.tsx` — open drawer instead of WidgetPopover; switch widget badge selector
- `packages/client/src/components/chat/RoleplayHUDPanels.tsx` — delete `GravityLedgerPanel` export (migrated to drawer)
- `packages/client/src/components/chat/ChatArea.tsx` — lift `gravityDrawerOpen` state (mirroring `galleryOpen`)
- `packages/client/src/components/chat/ChatCommonOverlays.tsx` — mount `GravityLedgerDrawer`

**Convention reminders:**
- Server: never `console.log`, use `logger` from `../lib/logger.ts`
- Client: `console.*` is fine; don't import server logger
- File extensions: `.ts` in server `import`s, `.tsx` for React; types in `@marinara-engine/shared` build to `.js` (use `.js` in import paths even for `.ts` source — Marinara uses NodeNext module resolution)

---

## Phase A — Data Layer (server + store + hooks)

**Phase A goal:** When a director run completes, the agent result carries structured tx data; when the State tab fetches `/state/:chatId`, it gets a typed `entities` object; when the user switches chats, gravity state resets.

### Task 1: Define shared entity types

**Files:**
- Create: `packages/shared/src/types/gravity-state.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the shared types file**

Create `packages/shared/src/types/gravity-state.ts`:

```ts
// ──────────────────────────────────────────────
// Shared types for the Gravity Ledger UI
// ──────────────────────────────────────────────

/** Op codes the director can emit (engine-only codes SNAP/ROLL/AMEND excluded). */
export type DirectorOpCode = "CR" | "S" | "MS" | "A" | "R" | "MR" | "TR" | "D";

export type AnyOpCode = DirectorOpCode | "SNAP" | "ROLL" | "AMEND";

export interface RawTransactionLike {
  op: AnyOpCode;
  e?: string;
  id?: string;
  d?: Record<string, unknown>;
  r?: string;
  tx?: number;
  t?: string;
  _ts?: string;
}

export interface RejectedTx {
  tx: RawTransactionLike;
  reason: string;
}

export interface DirectorRun {
  /** User-turn index in chat history (0-based message position). */
  turnSeq: number;
  committed: number;
  rejected: number;
  committedTxs: RawTransactionLike[];
  rejectedTxs: RejectedTx[];
  newArrivalIds: string[];
  confidence: "high" | "medium" | "low";
  notes: string;
  durationMs: number;
  model: string;
}

export interface CharBond {
  card: string;
  orientation: "upright" | "reversed";
  status: string;
  stage?: string;
  nuance?: string;
}

/** Lightweight projection of a character entity for the panel UI. Forward-compatible via [k: string]: unknown. */
export interface CharEntity {
  id: string;
  name: string;
  tier: "PRINCIPAL" | "TRACKED" | "KNOWN";
  location?: string;
  tags?: string[];
  knowledgeAsymmetry?: Record<string, string>;
  demonstratedTraits?: string[];
  agenda?: string;
  lastSeenAt?: string;
  onStage: boolean;
  bond?: CharBond;
  constraintIds: string[];
  powerBasis?: string;
  abilities?: string[];
  wounds?: Record<string, string>;
  keyMoments?: string[];
  [k: string]: unknown;
}

/** PC entity. Shares most of CharEntity's shape so the same modal renders both. */
export interface PcEntity {
  id: "pc";
  name: string;
  tier: "PC";
  sceneCast: string[];
  currentPlaceId?: string;
  location?: string;
  tags?: string[];
  knowledgeAsymmetry?: Record<string, string>;
  demonstratedTraits?: string[];
  agenda?: string;
  powerBasis?: string;
  abilities?: string[];
  wounds?: Record<string, string>;
  keyMoments?: string[];
  [k: string]: unknown;
}

export interface CollisionEntity {
  id: string;
  status: string;
  reach?: string;
  remaining?: number;
  description?: string;
  [k: string]: unknown;
}

export interface PressureEntity {
  id: string;
  description?: string;
  [k: string]: unknown;
}

export interface ConstraintEntity {
  id: string;
  status?: string;
  description?: string;
  charId?: string | string[];
  [k: string]: unknown;
}

export interface PlaceEntity {
  id: string;
  name?: string;
  reach?: string;
  [k: string]: unknown;
}

export interface FactionEntity {
  id: string;
  name?: string;
  tier?: string;
  [k: string]: unknown;
}

export interface WorldEntity {
  mode: string;
  timeskip?: string | null;
  [k: string]: unknown;
}

export interface GravityEntities {
  chars: CharEntity[];
  collisions: CollisionEntity[];
  pressures: PressureEntity[];
  constraints: ConstraintEntity[];
  places: PlaceEntity[];
  factions: FactionEntity[];
  pc: PcEntity | null;
  world: WorldEntity | null;
}

export interface GravityStateResponse {
  initialized: boolean;
  mode: string;
  stateView: string;
  archiveVersion: string;
  nextTxSeq: number;
  entities: GravityEntities;
}

/** Director projects mode → mode + skin. */
export interface ProjectedMode {
  mode: "REGULAR" | "ADVANCE" | "CHALLENGE" | string;
  skin?: string;
}

export function projectMode(raw: string): ProjectedMode {
  switch (raw) {
    case "regular":
      return { mode: "REGULAR" };
    case "advance":
      return { mode: "ADVANCE" };
    case "combat":
      return { mode: "CHALLENGE", skin: "combat" };
    case "intimacy":
      return { mode: "CHALLENGE", skin: "intimacy" };
    default:
      return { mode: raw.toUpperCase() };
  }
}

/** Maps director op codes to readable names for tooltips. */
export const OP_CODE_NAMES: Record<AnyOpCode, string> = {
  CR: "CREATE",
  S: "SET",
  MS: "MERGE_SET",
  A: "APPEND",
  R: "REMOVE",
  MR: "MERGE_REMOVE",
  TR: "TRANSITION",
  D: "DELETE",
  SNAP: "SNAPSHOT (engine internal)",
  ROLL: "ROLLBACK (engine internal)",
  AMEND: "AMEND (engine internal)",
};
```

- [ ] **Step 2: Re-export from shared index**

Modify `packages/shared/src/index.ts`. Find the block of `export * from "./types/...";` lines and add this line alphabetically (after `./types/game.js`):

```ts
export * from "./types/gravity-state.js";
```

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes. If `pnpm check` fails because `dist/` is stale, run `pnpm -r --filter @marinara-engine/shared build` first.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/gravity-state.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Gravity Ledger panel UI types"
```

---

### Task 2: Implement entities projection

**Files:**
- Create: `packages/server/src/services/gravity/engine/entities-projection.ts`

- [ ] **Step 1: Create the projection module**

Create `packages/server/src/services/gravity/engine/entities-projection.ts`:

```ts
// ──────────────────────────────────────────────
// Project the engine GravityState into the structured
// GravityEntities shape consumed by the panel UI.
// Fields are passed through as-is; defensive on shape.
// ──────────────────────────────────────────────
import type { GravityState } from "./types.ts";
import type {
  CharEntity,
  CollisionEntity,
  ConstraintEntity,
  FactionEntity,
  GravityEntities,
  PcEntity,
  PlaceEntity,
  PressureEntity,
  WorldEntity,
} from "@marinara-engine/shared";

type Bag = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}
function asStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Bag)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectChar(id: string, raw: Bag, sceneCast: Set<string>, relationships: Record<string, Bag>): CharEntity {
  const tier = (asString(raw.tier) ?? "KNOWN").toUpperCase();
  const onStage = sceneCast.has(`char:${id}`);
  const rel = relationships[`pc-${id}`];

  const out: CharEntity = {
    id,
    name: asString(raw.name) ?? id,
    tier: (tier === "PRINCIPAL" || tier === "TRACKED" ? tier : "KNOWN") as CharEntity["tier"],
    onStage,
    constraintIds: [],
  };

  const loc = asString(raw.location);
  if (loc) out.location = loc;
  const tags = asStringArray(raw.tags);
  if (tags) out.tags = tags;
  const ka = asStringMap(raw.knowledge_asymmetry);
  if (ka) out.knowledgeAsymmetry = ka;
  const dt = asStringArray(raw.demonstrated_traits);
  if (dt) out.demonstratedTraits = dt;
  const agenda = asString(raw.agenda);
  if (agenda) out.agenda = agenda;
  const lsa = asString(raw.last_seen_at);
  if (lsa) out.lastSeenAt = lsa;
  const pb = asString(raw.power_basis);
  if (pb) out.powerBasis = pb;
  const abilities = asStringArray(raw.abilities);
  if (abilities) out.abilities = abilities;
  const wounds = asStringMap(raw.wounds);
  if (wounds) out.wounds = wounds;
  const km = asStringArray(raw.key_moments);
  if (km) out.keyMoments = km;

  if (rel && asString(rel.card)) {
    const orientation = rel.orientation === "reversed" ? "reversed" : "upright";
    out.bond = {
      card: String(rel.card),
      orientation,
      status: asString(rel.status) ?? "unknown",
      stage: asString(rel.stage),
      nuance: asString(rel.nuance),
    };
  }

  return out;
}

function projectPc(raw: Bag): PcEntity {
  const out: PcEntity = {
    id: "pc",
    name: asString(raw.name) ?? "PC",
    tier: "PC",
    sceneCast: asStringArray(raw.scene_cast) ?? [],
  };
  const cpid = asString(raw.current_place_id);
  if (cpid) out.currentPlaceId = cpid;
  const tags = asStringArray(raw.tags);
  if (tags) out.tags = tags;
  const ka = asStringMap(raw.knowledge_asymmetry);
  if (ka) out.knowledgeAsymmetry = ka;
  const dt = asStringArray(raw.demonstrated_traits);
  if (dt) out.demonstratedTraits = dt;
  const agenda = asString(raw.agenda);
  if (agenda) out.agenda = agenda;
  const pb = asString(raw.power_basis);
  if (pb) out.powerBasis = pb;
  const abilities = asStringArray(raw.abilities);
  if (abilities) out.abilities = abilities;
  const wounds = asStringMap(raw.wounds);
  if (wounds) out.wounds = wounds;
  const km = asStringArray(raw.key_moments);
  if (km) out.keyMoments = km;
  return out;
}

function projectCollision(id: string, raw: Bag): CollisionEntity {
  return {
    id,
    status: asString(raw.status) ?? "UNKNOWN",
    reach: asString(raw.reach),
    remaining: typeof raw.remaining === "number" ? raw.remaining : undefined,
    description: asString(raw.description) ?? asString(raw.title),
  };
}

function projectPressure(id: string, raw: Bag): PressureEntity {
  return { id, description: asString(raw.description) ?? asString(raw.title) };
}

function projectConstraint(id: string, raw: Bag): ConstraintEntity {
  const out: ConstraintEntity = {
    id,
    status: asString(raw.status),
    description: asString(raw.description) ?? asString(raw.title),
  };
  // Optional charId field (engine schema add tracked separately — degraded mode if absent).
  const cid = raw.charId ?? raw.char_id;
  if (typeof cid === "string") out.charId = cid;
  else if (Array.isArray(cid) && cid.every((x) => typeof x === "string")) out.charId = cid as string[];
  return out;
}

function projectPlace(id: string, raw: Bag): PlaceEntity {
  return { id, name: asString(raw.name), reach: asString(raw.reach) };
}

function projectFaction(id: string, raw: Bag): FactionEntity {
  return { id, name: asString(raw.name), tier: asString(raw.tier) };
}

function projectWorld(raw: Bag): WorldEntity {
  return {
    mode: asString(raw.mode) ?? "regular",
    timeskip: typeof raw.timeskip === "string" ? raw.timeskip : null,
  };
}

/** Resolve constraintIds for each char from the constraints array (uses explicit charId only). */
function attachConstraintIds(chars: CharEntity[], constraints: ConstraintEntity[]): void {
  const charIds = new Set(chars.map((c) => c.id));
  for (const cs of constraints) {
    const cid = cs.charId;
    const targets = typeof cid === "string" ? [cid] : Array.isArray(cid) ? cid : [];
    for (const t of targets) {
      if (!charIds.has(t)) continue;
      const char = chars.find((c) => c.id === t);
      if (char) char.constraintIds.push(cs.id);
    }
  }
}

export function projectEntities(state: GravityState): GravityEntities {
  const sceneCast = new Set(
    Array.isArray(state.pc.scene_cast) ? (state.pc.scene_cast as unknown[]).map(String) : [],
  );
  const relationships = state.relationships as Record<string, Bag>;

  const chars: CharEntity[] = [];
  for (const [id, raw] of Object.entries(state.characters)) {
    if ((raw as Bag).tier === "UNKNOWN") continue;
    chars.push(projectChar(id, raw as Bag, sceneCast, relationships));
  }

  const collisions = Object.entries(state.collisions).map(([id, raw]) => projectCollision(id, raw as Bag));
  const pressures = Object.entries(state.pressures).map(([id, raw]) => projectPressure(id, raw as Bag));
  const constraints = Object.entries(state.constraints).map(([id, raw]) => projectConstraint(id, raw as Bag));
  const places = Object.entries(state.places).map(([id, raw]) => projectPlace(id, raw as Bag));
  const factions = Object.entries(state.factions).map(([id, raw]) => projectFaction(id, raw as Bag));

  attachConstraintIds(chars, constraints);

  return {
    chars,
    collisions,
    pressures,
    constraints,
    places,
    factions,
    pc: state.pc && Object.keys(state.pc).length > 0 ? projectPc(state.pc as Bag) : null,
    world: state.world && Object.keys(state.world).length > 0 ? projectWorld(state.world as Bag) : null,
  };
}
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes. If `@marinara-engine/shared` types aren't found, rebuild it first: `pnpm -r --filter @marinara-engine/shared build`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/engine/entities-projection.ts
git commit -m "feat(gravity-engine): add entities projection for panel UI"
```

---

### Task 3: Add `entities` to `/state/:chatId` route

**Files:**
- Modify: `packages/server/src/routes/gravity.routes.ts`

- [ ] **Step 1: Wire projection into route**

Modify `packages/server/src/routes/gravity.routes.ts`. At the top, add imports near the existing engine imports:

```ts
import { computeState } from "../services/gravity/engine/state-compute.js";
import { projectEntities } from "../services/gravity/engine/entities-projection.js";
import { ledgerStore as makeLedgerStore } from "../services/gravity/engine/ledger-store.js";
```

Wait — verify the actual export names. Open `packages/server/src/services/gravity/engine/ledger-store.ts` and `state-compute.ts` first; the `ledger-store` export is `createLedgerStore`. Use this exact import:

```ts
import { computeState } from "../services/gravity/engine/state-compute.js";
import { projectEntities } from "../services/gravity/engine/entities-projection.js";
import { createLedgerStore } from "../services/gravity/engine/ledger-store.js";
```

In the route handler for `GET /state/:chatId` (around line 48), modify the response. Replace the existing `return reply.send({...})` blocks (both the no-cache and cache-present branches) with the new shape.

Find the no-cache return block (currently around lines 88-90):

```ts
if (!cache) {
  return reply.send({ initialized: false, mode: chatState?.mode ?? "regular", stateView: "", archiveVersion: "", nextTxSeq: chatState?.nextTxSeq ?? 1 });
}
```

Replace with:

```ts
if (!cache) {
  return reply.send({
    initialized: false,
    mode: chatState?.mode ?? "regular",
    stateView: "",
    archiveVersion: "",
    nextTxSeq: chatState?.nextTxSeq ?? 1,
    entities: {
      chars: [],
      collisions: [],
      pressures: [],
      constraints: [],
      places: [],
      factions: [],
      pc: null,
      world: null,
    },
  });
}
```

Then find the cache-present return block (currently around lines 92-98):

```ts
return reply.send({
  initialized: true,
  mode: chatState?.mode ?? "regular",
  stateView: cache.stateView,
  archiveVersion: cache.archiveVersion,
  nextTxSeq: chatState?.nextTxSeq ?? 1,
});
```

Replace with:

```ts
// Build entities from the same transaction set that produced this cache row's stateView.
// The cache row may be the accepted cache (normal path) OR the most-recent staged cache
// (fallback path when acceptedMessageId is null — e.g. turn 1 before acceptance runs).
// A global getAcceptedTransactions() would diverge from the staged stateView on that path,
// so we bound the query to transactions at or before cache.messageId and include staged
// rows only for the exact swipe that this cache row describes.
const { lte: lteOp, or: orOp } = await import("drizzle-orm");
const boundedTxns = await app.db
  .select()
  .from(gravityTransactions)
  .where(
    and(
      eq(gravityTransactions.chatId, chatId),
      lteOp(gravityTransactions.messageId, cache.messageId),
      orOp(
        eq(gravityTransactions.accepted, 1),
        and(
          eq(gravityTransactions.messageId, cache.messageId),
          eq(gravityTransactions.swipeIndex, cache.swipeIndex),
        ),
      ),
    ),
  )
  .orderBy(gravityTransactions.txSeq);
const computedState = computeState(null, boundedTxns);
const entities = projectEntities(computedState);

return reply.send({
  initialized: true,
  mode: chatState?.mode ?? "regular",
  stateView: cache.stateView,
  archiveVersion: cache.archiveVersion,
  nextTxSeq: chatState?.nextTxSeq ?? 1,
  entities,
});
```

> **Note on imports:** `lte`, `or` are from `drizzle-orm` — add them to the existing import line alongside `eq`, `and`, `desc`. The dynamic `import()` above is illustrative; merge into the static import at the top of the file. `gravityTransactions` is already imported. Verify `cache.swipeIndex` is the correct column name against the schema before running `pnpm check`.

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Manual smoke (server)**

Start the dev server: `pnpm dev` in the monorepo root.

In a separate terminal, hit the route for an existing chat (replace `<CHAT_ID>` with a real chatId from your dev database — find one via `sqlite3 packages/server/marinara.db "SELECT id FROM chats LIMIT 1;"`):

```bash
curl -s http://localhost:3000/api/gravity/state/<CHAT_ID> | jq '.entities | keys'
```

Expected output: `["chars","collisions","constraints","factions","pc","places","pressures","world"]`

Also verify a populated chat returns non-empty `chars`:

```bash
curl -s http://localhost:3000/api/gravity/state/<CHAT_ID> | jq '.entities.chars | length'
```

Expected: a number, possibly 0 for a new chat, > 0 for a chat that's run a few turns.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/gravity.routes.ts
git commit -m "feat(gravity-routes): include structured entities in /state response"
```

---

### Task 4: Pass through director-agent fields

**Files:**
- Modify: `packages/server/src/services/gravity/agents/director-agent.ts`
- Modify: `packages/server/src/db/schema/chats.ts` (read only — no schema change)

- [ ] **Step 1: Extend GravityDirectorResult data type**

Modify `packages/server/src/services/gravity/agents/director-agent.ts`. Find the `GravityDirectorResult` interface (lines 43-59) and replace its `data` shape:

```ts
export interface GravityDirectorResult {
  agentId: string;
  agentType: "gravity-ledger-director";
  type: "gravity_state_update";
  data: {
    committed: number;
    rejected: number;
    errors: Record<string, unknown>;
    newArrivalIds: string[];
    durationMs: number;
    model: string;
    /** New: full transaction objects that were committed this run. */
    committedTxs: unknown[];
    /** New: rejected transaction objects with validator reason strings. */
    rejectedTxs: Array<{ tx: unknown; reason: string }>;
    /** New: director's self-reported confidence. */
    confidence: "high" | "medium" | "low";
    /** New: director's free-text reasoning (notes field of the JSON response). */
    notes: string;
    /** New: 0-based message position for this director run. */
    turnSeq: number;
  };
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}
```

- [ ] **Step 2: Add turnSeq lookup helper**

In the same file, near the bottom (after `buildNewCorrections`), add a helper that resolves `messageId` to a 1-based user-turn index:

```ts
import { messages } from "../../../db/schema/index.js";
import { sql, lte as lteMsg } from "drizzle-orm";

async function resolveTurnSeq(db: DB, chatId: string, messageId: string): Promise<number> {
  // Count USER-ROLE messages in this chat created at or before the target message's createdAt.
  // Only user messages are counted so the result is "after the Nth user turn" — which is
  // what the UI label "Turn N" should mean. Counting all messages (including assistant/system)
  // would produce a message-index, not a turn-index, and inflate the number by 2–3x.
  const [target] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!target) return 1;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.role, "user"),
        lteMsg(messages.createdAt, target.createdAt),
      ),
    );
  return Math.max(1, Number(count));
}
```

The `messages` and `eq` imports may already exist — merge with existing import lines if so. `sql`, `lte`, `and` are from drizzle-orm. Use `lteMsg` as a local alias if `lte` is already imported under a different alias.

> **Row key note:** `turnSeq` is used as the React list key for turn rows. The minimum value is now 1 (not 0), eliminating the falsy-key hazard from the original fallback `turnSeq: 0`.

- [ ] **Step 3: Track committed/rejected tx objects + collect reasons**

Modify the `runGravityDirector` body. After the existing `try { await db.transaction(async (tx) => { ... })` block, but **inside** the transaction, change the way committed/rejected txs are tracked.

Find the `formatValid` loop and replace it with one that also tracks rejections with reasons. Replace lines starting with `// 6. Validate format per-transaction...` (around lines 133-143) through the end of the existing `validateTransitions` block (around line 155) with:

```ts
// 6. Validate format per-transaction, build format-valid list
const formatValid: RawTransaction[] = [];
const rejectedWithReasons: Array<{ tx: unknown; reason: string }> = [];
for (let i = 0; i < proposal.transactions.length; i++) {
  const errs = validateFormat(proposal.transactions[i] as unknown, i);
  if (errs.length === 0) {
    formatValid.push(proposal.transactions[i] as RawTransaction);
  } else {
    allErrors[String(i)] = errs;
    rejected++;
    rejectedWithReasons.push({
      tx: proposal.transactions[i],
      reason: errs.map((e) => e.message ?? String(e)).join("; "),
    });
  }
}

// Validate state-machine transitions against current accepted state
const acceptedTxns = await ledgerStore.getAcceptedTransactions(chatId);
const currentState = computeState(null, acceptedTxns);
const { valid: validAfterTransitions, errors: transitionErrors } = validateTransitions(
  formatValid,
  currentState,
);
const validSet = new Set(validAfterTransitions);
for (const droppedFromTransitions of formatValid) {
  if (validSet.has(droppedFromTransitions)) continue;
  const err = transitionErrors.find((e) => e.tx === droppedFromTransitions);
  rejectedWithReasons.push({
    tx: droppedFromTransitions,
    reason: err?.message ?? "transition validation failed",
  });
}
for (const e of transitionErrors) {
  allErrors[String(e.lineNum)] = e;
}
rejected += formatValid.length - validAfterTransitions.length;
```

Hoist `let rejectedWithReasons` and `let committedTxs` declarations above the `try` block alongside the existing `let committed = 0; let rejected = 0; ...` block (around line 126). Replace that block with:

```ts
let committed = 0;
let rejected = 0;
let newArrivalIds: string[] = [];
const allErrors: Record<string, unknown> = {};
let committedTxs: RawTransaction[] = [];
let rejectedWithReasons: Array<{ tx: unknown; reason: string }> = [];
```

After the `await ledgerStore.stageTransactions(... validAfterTransitions);` line (assigning `committed`), append:

```ts
committedTxs = validAfterTransitions.slice();
```

Inside the engine-tick block, after `if (tickResult.tickTxns.length > 0) { ... }`, append:

```ts
committedTxs.push(...tickResult.tickTxns);
```

- [ ] **Step 4: Resolve turnSeq before returning**

After the `try { await db.transaction(...) } catch { ... return makeError(...) }` block, but before the `return { ... }` at line 200, add:

```ts
const turnSeq = await resolveTurnSeq(db, chatId, messageId);
```

- [ ] **Step 5: Update the return shape**

Replace the existing `return { agentId, ..., data: { committed, rejected, errors, newArrivalIds, durationMs, model } }` block (around lines 200-209) with:

```ts
return {
  agentId: agentConfig.id,
  agentType: "gravity-ledger-director",
  type: "gravity_state_update",
  data: {
    committed,
    rejected,
    errors: allErrors,
    newArrivalIds,
    durationMs,
    model,
    committedTxs,
    rejectedTxs: rejectedWithReasons,
    confidence: proposal.confidence,
    notes: proposal.notes,
    turnSeq,
  },
  tokensUsed: 0,
  durationMs,
  success: true,
  error: null,
};
```

- [ ] **Step 6: Update the makeSkipped + makeError data blocks**

For both `makeSkipped` and `makeError` helpers near the bottom of the file, replace the `data` literal with one that includes the new fields (default values):

```ts
data: {
  committed: 0,
  rejected: 0,
  errors: {},
  newArrivalIds: [],
  durationMs: Date.now() - t0,
  model: "",
  committedTxs: [],
  rejectedTxs: [],
  confidence: "low" as const,
  notes: "",
  turnSeq: 0,
},
```

Apply this same `data` literal in both `makeSkipped` and `makeError`.

- [ ] **Step 7: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes. If `transitionErrors` typing complains about `.tx`, open `consistency.ts` to confirm the `TransitionError` shape — it has `tx: RawTransaction` per line 116. The error.find lookup is fine.

- [ ] **Step 8: Manual smoke (server, end-to-end)**

Restart `pnpm dev`. Send a message in a Gravity-enabled chat in the running app. Watch the server logs — the director run should log `committed=N rejected=M` as before. Confirm no crash and no new error logs.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/services/gravity/agents/director-agent.ts
git commit -m "feat(gravity-director): include txs, confidence, notes, turnSeq in agent result"
```

---

### Task 5: Replace gravity store with `history` array

**Files:**
- Modify: `packages/client/src/stores/gravity.store.ts`

- [ ] **Step 1: Rewrite the store**

Replace the entire contents of `packages/client/src/stores/gravity.store.ts` with:

```ts
// ──────────────────────────────────────────────
// Zustand Store: Gravity Ledger Slice
// ──────────────────────────────────────────────
import { create } from "zustand";
import type { DirectorRun } from "@marinara-engine/shared";

const HISTORY_CAP = 50;

interface GravityState {
  /** Per-director-run timeline for this chat session. Capped at HISTORY_CAP entries (oldest dropped). */
  history: DirectorRun[];
  /** Running total of committed transactions across the full session (not just the visible window). */
  totalCommitted: number;
  /** Running total of rejected transactions across the full session. */
  totalRejected: number;
  /** Archive version fingerprint from the last inject run — drives state-tab refetch. */
  archiveVersion: string | null;

  addDirectorRun: (run: DirectorRun) => void;
  setArchiveVersion: (v: string) => void;
  reset: () => void;
}

export const useGravityStore = create<GravityState>((set) => ({
  history: [],
  totalCommitted: 0,
  totalRejected: 0,
  archiveVersion: null,

  addDirectorRun: (run) =>
    set((s) => {
      const next = s.history.concat(run);
      const trimmed = next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
      return {
        history: trimmed,
        totalCommitted: s.totalCommitted + run.committed,
        totalRejected: s.totalRejected + run.rejected,
      };
    }),

  setArchiveVersion: (archiveVersion) => set({ archiveVersion }),

  reset: () => set({ history: [], totalCommitted: 0, totalRejected: 0, archiveVersion: null }),
}));
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: TypeScript errors at the existing call sites (`use-generate.ts`, `RoleplayHUD.tsx`, `RoleplayHUDPanels.tsx`) referencing `lastDirectorResult` / `setDirectorResult`. These will be fixed in subsequent tasks. Note them down.

- [ ] **Step 3: Do not commit yet** — wait until call sites are fixed.

---

### Task 6: Update `use-generate.ts` agent_result handler

**Files:**
- Modify: `packages/client/src/hooks/use-generate.ts`

- [ ] **Step 1: Switch the store selector**

Modify `packages/client/src/hooks/use-generate.ts`. Replace line 332:

```ts
const setGravityDirectorResult = useGravityStore((s) => s.setDirectorResult);
```

with:

```ts
const addGravityDirectorRun = useGravityStore((s) => s.addDirectorRun);
```

- [ ] **Step 2: Update the first agent_result handler (lines ~739-748)**

Replace the entire `if (result.agentType === "gravity-ledger-director") { ... }` block at lines 739-748 with:

```ts
if (result.agentType === "gravity-ledger-director") {
  const d = result.data as Record<string, unknown>;
  addGravityDirectorRun({
    turnSeq: (d.turnSeq as number) ?? 0,
    committed: (d.committed as number) ?? 0,
    rejected: (d.rejected as number) ?? 0,
    committedTxs: (d.committedTxs as unknown[]) ?? [],
    rejectedTxs: (d.rejectedTxs as Array<{ tx: unknown; reason: string }>) ?? [],
    newArrivalIds: (d.newArrivalIds as string[]) ?? [],
    confidence: (d.confidence as "high" | "medium" | "low") ?? "low",
    notes: (d.notes as string) ?? "",
    durationMs: result.durationMs,
    model: (d.model as string) ?? "",
  });
}
```

- [ ] **Step 3: Update the second agent_result handler (lines ~1571-1580)**

Replace the second `if (result.agentType === "gravity-ledger-director") { ... }` block at lines 1571-1580 with the **same** block as Step 2 above (identical body).

- [ ] **Step 4: Run `pnpm check`**

```bash
pnpm check
```

Expected: errors in `use-generate.ts` are fixed. Errors in `RoleplayHUD.tsx` and `RoleplayHUDPanels.tsx` remain. Continue.

- [ ] **Step 5: Do not commit yet.**

---

### Task 7: Update `RoleplayHUD.tsx` widget badge selector

**Files:**
- Modify: `packages/client/src/components/chat/RoleplayHUD.tsx`

- [ ] **Step 1: Switch widget selector**

Modify `packages/client/src/components/chat/RoleplayHUD.tsx`. Replace lines 745-747:

```ts
const totalCommitted = useGravityStore((s) => s.totalCommitted);
const lastResult = useGravityStore((s) => s.lastDirectorResult);
const hasArrivals = (lastResult?.newArrivalIds.length ?? 0) > 0;
```

with:

```ts
const totalCommitted = useGravityStore((s) => s.totalCommitted);
const lastRun = useGravityStore((s) => (s.history.length > 0 ? s.history[s.history.length - 1] : null));
const hasArrivals = (lastRun?.newArrivalIds.length ?? 0) > 0;
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: `RoleplayHUD.tsx` errors fixed. `RoleplayHUDPanels.tsx` errors remain.

- [ ] **Step 3: Do not commit yet.**

---

### Task 8: Delete `GravityLedgerPanel` from `RoleplayHUDPanels.tsx`

**Files:**
- Modify: `packages/client/src/components/chat/RoleplayHUDPanels.tsx`

The panel body in this file is being replaced by the new dedicated drawer. Removing it now keeps the codebase consistent — the drawer is created in Phase B Task 10, but the lazy import in `RoleplayHUD.tsx` will be flipped at the same time.

- [ ] **Step 1: Remove the GravityLedgerPanel section**

In `packages/client/src/components/chat/RoleplayHUDPanels.tsx`, delete the entire block from line 1249 (the `// ════…` separator before "Gravity Ledger Panel") through the closing `}` of the function (around line 1352).

Also remove now-unused imports at the top of the file:
- `useGravityStore`
- `RefreshCw`
- `GravityStateResponse` interface (lines 1253-1259)
- Any other unused symbols this removal creates

Run a quick scan to confirm:

```bash
grep -n "useGravityStore\|RefreshCw\|GravityStateResponse" packages/client/src/components/chat/RoleplayHUDPanels.tsx
```

Expected: no matches.

- [ ] **Step 2: Temporarily stub `GravityLedgerPanel` import in RoleplayHUD.tsx**

In `RoleplayHUD.tsx` at line 77-79, the lazy import will fail because the export was deleted:

```ts
const GravityLedgerPanel = lazy(async () =>
  import("./RoleplayHUDPanels").then((module) => ({ default: module.GravityLedgerPanel })),
);
```

Delete this lazy declaration entirely. Also delete the `<GravityLedgerPanel ... />` usage (line ~782) inside the WidgetPopover, and the surrounding `<WidgetPopover open={open} ...>...</WidgetPopover>` block (lines 774-784) — leaving just the button. The drawer wiring lands in Task 10.

The widget body should temporarily be (replacing lines 749-786):

```tsx
return (
  <div className="relative">
    <button
      ref={buttonRef}
      onClick={() => setOpen(!open)}
      className={cn(WIDGET, "text-teal-300", open && "bg-black/60 border-white/20")}
      title="Gravity Ledger"
    >
      <div className="relative flex items-center justify-center h-7 max-md:h-auto shrink-0">
        <Network size="0.875rem" className="text-teal-400/70 max-md:h-4 max-md:w-4" />
        {hasArrivals && (
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        )}
      </div>
      {totalCommitted > 0 ? (
        <span className="text-[0.4375rem] font-bold text-teal-300/70 tabular-nums shrink-0">
          {totalCommitted}
        </span>
      ) : (
        <span className="text-[0.5625rem] font-semibold leading-tight text-teal-300/50 shrink-0 max-md:hidden">
          Gravity
        </span>
      )}
    </button>
  </div>
);
```

This loses the popover until Task 10 wires the drawer — acceptable interim state.

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes. All `lastDirectorResult` references gone.

- [ ] **Step 4: Commit Tasks 5–8 together**

```bash
git add packages/client/src/stores/gravity.store.ts \
        packages/client/src/hooks/use-generate.ts \
        packages/client/src/components/chat/RoleplayHUD.tsx \
        packages/client/src/components/chat/RoleplayHUDPanels.tsx
git commit -m "refactor(gravity-store): replace lastDirectorResult with history array"
```

---

### Task 9: Wire `reset()` to chat-switch effect

**Files:**
- Modify: `packages/client/src/stores/chat.store.ts`

- [ ] **Step 1: Add gravity reset alongside existing per-chat resets**

In `packages/client/src/stores/chat.store.ts`, find lines 183-184 inside `setActiveChatId`:

```ts
if (id !== prev) {
  useAgentStore.getState().reset();
  useGameStateStore.getState().setGameState(null);
```

Add a new line directly after `useAgentStore.getState().reset();`:

```ts
useGravityStore.getState().reset();
```

Add the import at the top of the file (alongside the other store imports):

```ts
import { useGravityStore } from "./gravity.store";
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Manual smoke**

In the running app, switch between two chats. The HUD widget badge count should reset (totalCommitted=0) when switching to a different chat, then re-populate as the director runs in the new chat.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/stores/chat.store.ts
git commit -m "fix(chat-store): reset gravity store on chat switch"
```

---

### Task 10: Create `useGravityState` query hook

**Files:**
- Create: `packages/client/src/hooks/use-gravity-state.ts`

- [ ] **Step 1: Create the hook**

Create `packages/client/src/hooks/use-gravity-state.ts`:

```ts
// ──────────────────────────────────────────────
// Hook: Gravity Ledger state fetcher (TanStack Query).
// Cache key includes BOTH archiveVersion (bumped by the inject agent) AND
// directorRunCount (incremented by every director run via addDirectorRun).
// archiveVersion alone is insufficient: the inject agent runs at the START of
// the next user turn, so the State tab would stay stale for the entire turn
// after the director commits. Including directorRunCount ensures the State tab
// refetches immediately after each director run completes.
// ──────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import type { GravityStateResponse } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { useGravityStore } from "../stores/gravity.store";

const gravityStateKeys = {
  state: (chatId: string, archiveVersion: string | null, directorRunCount: number) =>
    ["gravity-state", chatId, archiveVersion ?? "initial", directorRunCount] as const,
};

export function useGravityState(chatId: string | null) {
  const archiveVersion = useGravityStore((s) => s.archiveVersion);
  const directorRunCount = useGravityStore((s) => s.history.length);
  return useQuery({
    queryKey: gravityStateKeys.state(chatId ?? "", archiveVersion, directorRunCount),
    queryFn: () => api.get<GravityStateResponse>(`/gravity/state/${chatId}`),
    enabled: Boolean(chatId),
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/use-gravity-state.ts
git commit -m "feat(client): add useGravityState query hook"
```

---

### Phase A smoke checklist

Before moving to Phase B:

- [ ] `pnpm check` passes from monorepo root
- [ ] `pnpm dev` starts cleanly
- [ ] `curl /api/gravity/state/<chatId> | jq '.entities'` returns the structured shape
- [ ] Sending a message in a Gravity-enabled chat triggers a director run and the server log shows committed/rejected counts
- [ ] HUD widget displays the running `totalCommitted` count (no popover yet — interim state)
- [ ] Switching chats resets the badge

---

## Phase B — Drawer Shell

**Phase B goal:** A working Side Drawer that opens from the HUD widget, has a working header (title bar + mode badge + session strip), tab bar, close + export buttons. Tabs are stubbed empty.

### Task 11: Create GravityLedgerDrawer scaffold

**Files:**
- Create: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Create the drawer scaffold**

Create `packages/client/src/components/chat/GravityLedgerDrawer.tsx`:

```tsx
// ──────────────────────────────────────────────
// Gravity Ledger Drawer — Side drawer with State + Turns tabs.
// Replaces the prior WidgetPopover-based GravityLedgerPanel.
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import { Download, Network, X } from "lucide-react";
import { useGravityState } from "../../hooks/use-gravity-state";
import { useGravityStore } from "../../stores/gravity.store";
import { projectMode } from "@marinara-engine/shared";
import { api } from "../../lib/api-client";

interface GravityLedgerDrawerProps {
  chatId: string;
  open: boolean;
  onClose: () => void;
}

type Tab = "state" | "turns";

export function GravityLedgerDrawer({ chatId, open, onClose }: GravityLedgerDrawerProps) {
  const [tab, setTab] = useState<Tab>("state");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open for keyboard users.
  useEffect(() => {
    if (open) closeBtnRef.current?.focus();
  }, [open]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="absolute inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gravity-drawer-title"
        className="absolute right-0 top-0 z-50 flex h-full w-80 max-md:w-full flex-col border-l border-[var(--border)] bg-[var(--background)] shadow-2xl animate-fade-in-up max-md:pt-[env(safe-area-inset-top)]"
      >
        <DrawerHeader chatId={chatId} closeBtnRef={closeBtnRef} onClose={onClose} />
        <TabBar tab={tab} onTabChange={setTab} />
        <div className="flex-1 overflow-y-auto">
          {tab === "state" ? (
            <StateTab chatId={chatId} />
          ) : (
            <TurnsTab />
          )}
        </div>
      </div>
    </>
  );
}

// ── Header ────────────────────────────────────────────────

function DrawerHeader({
  chatId,
  closeBtnRef,
  onClose,
}: {
  chatId: string;
  closeBtnRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { data } = useGravityState(chatId);
  const totalCommitted = useGravityStore((s) => s.totalCommitted);
  const totalRejected = useGravityStore((s) => s.totalRejected);
  const lastRun = useGravityStore((s) => (s.history.length > 0 ? s.history[s.history.length - 1] : null));
  const projected = projectMode(data?.mode ?? "regular");

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const bundle = await api.get<unknown>(`/gravity/export/${chatId}?include_pending=true`);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `gravity-debug-${chatId}-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[GravityDrawer] export failed", err);
      setExportError("Export failed — see console");
      setTimeout(() => setExportError(null), 3000);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--border)]">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Network size="0.875rem" className="text-teal-400/70 shrink-0" />
          <h3 id="gravity-drawer-title" className="text-sm font-bold truncate">
            Gravity Ledger
          </h3>
          <span className="text-[0.625rem] font-mono uppercase text-[var(--muted-foreground)] shrink-0">
            {projected.mode}
            {projected.skin ? <span className="opacity-60"> · {projected.skin}</span> : null}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleExport}
            disabled={exporting}
            title={exportError ?? "Export debug JSON"}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-all hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <Download size="0.875rem" className={exporting ? "animate-pulse" : ""} />
          </button>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-all hover:bg-[var(--accent)]"
            aria-label="Close drawer"
          >
            <X size="1rem" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 pb-2.5 text-[0.6875rem] text-[var(--muted-foreground)] tabular-nums">
        <span>⚖️ {totalCommitted} committed</span>
        <span>·</span>
        <span>{totalRejected} rejected</span>
        {lastRun ? (
          <>
            <span>·</span>
            <span className="font-mono opacity-70">{lastRun.model}</span>
          </>
        ) : null}
        <span className="ml-auto">seq {data?.nextTxSeq ?? 1}</span>
      </div>
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────

function TabBar({ tab, onTabChange }: { tab: Tab; onTabChange: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "state", label: "State" },
    { id: "turns", label: "Turns" },
  ];
  return (
    <div role="tablist" aria-label="Gravity Ledger tabs" className="shrink-0 flex border-b border-[var(--border)]">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`gravity-tabpanel-${t.id}`}
          id={`gravity-tab-${t.id}`}
          onClick={() => onTabChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              const next = tab === "state" ? "turns" : "state";
              onTabChange(next);
            }
          }}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            tab === t.id
              ? "border-b-2 border-teal-400 text-[var(--foreground)]"
              : "border-b-2 border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Tab panels (stubs — implemented in Phase C / D) ──────

function StateTab({ chatId }: { chatId: string }) {
  return (
    <div
      role="tabpanel"
      id="gravity-tabpanel-state"
      aria-labelledby="gravity-tab-state"
      className="p-4 text-xs text-[var(--muted-foreground)]"
    >
      State tab — chat {chatId} (placeholder)
    </div>
  );
}

function TurnsTab() {
  return (
    <div
      role="tabpanel"
      id="gravity-tabpanel-turns"
      aria-labelledby="gravity-tab-turns"
      className="p-4 text-xs text-[var(--muted-foreground)]"
    >
      Turns tab (placeholder)
    </div>
  );
}
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): scaffold GravityLedgerDrawer with header + tabs"
```

---

### Task 12: Lift drawer state to ChatArea + mount in overlays + wire HUD widget

**Files:**
- Modify: `packages/client/src/components/chat/ChatArea.tsx`
- Modify: `packages/client/src/components/chat/ChatCommonOverlays.tsx`
- Modify: `packages/client/src/components/chat/RoleplayHUD.tsx`
- Modify: `packages/client/src/components/chat/ChatRoleplaySurface.tsx`

This task mirrors how `galleryOpen` is handled across the four files. `ChatRoleplaySurface.tsx` is the parent that renders both `RoleplayHUD` and `ChatCommonOverlays` in roleplay mode — without threading the new props through it, the HUD widget button cannot open the drawer and the overlay-hiding logic will miss the new drawer state.

- [ ] **Step 1: Add state in ChatArea**

In `packages/client/src/components/chat/ChatArea.tsx`, around line 100 where `galleryOpen` is declared, add:

```ts
const [gravityDrawerOpen, setGravityDrawerOpen] = useState(false);
```

Pass these into `ChatCommonOverlays` and into `RoleplayHUD`. Find every prop block where `galleryOpen={galleryOpen}` and `onCloseGallery={...}` are passed (there are several render sites — lines ~1227, 1245, 1292, 1314-1317, 1393-1394, 1422-1425). Mirror the same pair for gravity:

```tsx
gravityDrawerOpen={gravityDrawerOpen}
onOpenGravityDrawer={() => setGravityDrawerOpen(true)}
onCloseGravityDrawer={() => setGravityDrawerOpen(false)}
```

(Drop `onOpenGravityDrawer` from prop sites that only pass `onCloseGallery`, mirroring the pattern of where `onOpenGallery` is or isn't included — match each call site.)

- [ ] **Step 2: Add prop types + mount drawer in ChatCommonOverlays**

In `packages/client/src/components/chat/ChatCommonOverlays.tsx`, find the props interface (around line 175-180) and add:

```ts
gravityDrawerOpen: boolean;
onCloseGravityDrawer: () => void;
```

Add the lazy import at the top alongside other lazy drawers:

```ts
const GravityLedgerDrawer = lazy(async () => {
  const module = await import("./GravityLedgerDrawer");
  return { default: module.GravityLedgerDrawer };
});
```

In the JSX (around line 261 where `ChatGalleryDrawer` mounts), add a sibling `<Suspense>` block:

```tsx
{chat && (
  <Suspense fallback={null}>
    {gravityDrawerOpen && (
      <GravityLedgerDrawer chatId={chat.id} open={gravityDrawerOpen} onClose={onCloseGravityDrawer} />
    )}
  </Suspense>
)}
```

Destructure the new props in the function signature alongside existing ones.

- [ ] **Step 3: Wire HUD widget button to call onOpenGravityDrawer**

In `packages/client/src/components/chat/RoleplayHUD.tsx`, the `GravityLedgerWidget` previously owned local `open` state. Now it receives an open handler from above.

Find the props of the parent component(s) that receive `onOpenGallery`, etc. (search for "onOpenGallery" in this file). Add:

```ts
onOpenGravityDrawer: () => void;
```

to every prop interface that includes `onOpenGallery`, and thread it down to `GravityLedgerWidget`. Update `GravityLedgerWidget` signature:

```ts
function GravityLedgerWidget({
  layout = "top",
  onOpen,
}: {
  layout?: HudPosition;
  onOpen: () => void;
}) {
```

Note: `chatId` is removed from the widget — no longer needed since the widget no longer renders the panel directly.

Replace the widget body (the temporary stub from Task 8) with:

```tsx
const totalCommitted = useGravityStore((s) => s.totalCommitted);
const lastRun = useGravityStore((s) => (s.history.length > 0 ? s.history[s.history.length - 1] : null));
const hasArrivals = (lastRun?.newArrivalIds.length ?? 0) > 0;

return (
  <button
    onClick={onOpen}
    className={cn(WIDGET, "text-teal-300")}
    title="Gravity Ledger"
  >
    <div className="relative flex items-center justify-center h-7 max-md:h-auto shrink-0">
      <Network size="0.875rem" className="text-teal-400/70 max-md:h-4 max-md:w-4" />
      {hasArrivals && (
        <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
      )}
    </div>
    {totalCommitted > 0 ? (
      <span className="text-[0.4375rem] font-bold text-teal-300/70 tabular-nums shrink-0">
        {totalCommitted}
      </span>
    ) : (
      <span className="text-[0.5625rem] font-semibold leading-tight text-teal-300/50 shrink-0 max-md:hidden">
        Gravity
      </span>
    )}
  </button>
);
```

Remove the unused `useState`, `useRef`, and `buttonRef` declarations from this widget. Remove unused imports if `pnpm check` complains.

At the call sites in this same file (lines 356 and 440), update:

```tsx
<GravityLedgerWidget chatId={chatId} layout={layout} />
```

to:

```tsx
<GravityLedgerWidget layout={layout} onOpen={onOpenGravityDrawer} />
```

and thread `onOpenGravityDrawer` through any RoleplayHUD-level props that are needed.

- [ ] **Step 4: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 5: Thread props through ChatRoleplaySurface**

Open `packages/client/src/components/chat/ChatRoleplaySurface.tsx`. Search for how `galleryOpen` / `onOpenGallery` / `onCloseGallery` are threaded through this file — it receives them as props from `ChatArea` and passes them into the `RoleplayHUD` and `ChatCommonOverlays` components it renders. Apply the same pattern for the three gravity props:

```ts
// In ChatRoleplaySurface props interface, alongside galleryOpen:
gravityDrawerOpen: boolean;
onOpenGravityDrawer: () => void;
onCloseGravityDrawer: () => void;
```

Pass all three into every `<RoleplayHUD ... />` and `<ChatCommonOverlays ... />` call site inside this file. `ChatArea` already passes them (Step 1), so the surface just forwards them.

Run `pnpm check` after this step — TypeScript will flag any missed prop sites.

- [ ] **Step 6: Manual smoke**

Open the running app. Click the Network icon in the HUD strip. The drawer should slide in from the right covering the right column (or full width on mobile). Click the X or backdrop to close. Esc should close. Header should show "Gravity Ledger" + the mode badge (REGULAR for a regular-mode chat). Tabs should render placeholder text. The session strip should show 0 / 0 / seq 1 for a fresh chat, increment after a director run.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/chat/ChatArea.tsx \
        packages/client/src/components/chat/ChatCommonOverlays.tsx \
        packages/client/src/components/chat/ChatRoleplaySurface.tsx \
        packages/client/src/components/chat/RoleplayHUD.tsx
git commit -m "feat(client): wire Gravity drawer open state through ChatArea/Overlays/HUD"
```

---

### Phase B smoke checklist

- [ ] HUD Network icon opens the drawer
- [ ] Backdrop click + X button + Escape all close it
- [ ] Mode badge shows correct projection (REGULAR / ADVANCE / CHALLENGE · skin)
- [ ] Session strip shows correct totalCommitted/totalRejected/seq
- [ ] Export button downloads a `gravity-debug-{chatId}-{date}.json` file (open it; should be parseable JSON)
- [ ] Tab arrow keys move between tabs
- [ ] No console errors

---

## Phase C — State Tab

**Phase C goal:** State tab renders a structured entity browser, with a Character Detail modal, PC row, other entity sections, Raw toggle, and empty/loading/error states.

### Task 13: State tab shell + collapsible primitive

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Add a collapsible-section primitive at the bottom of the file**

Above the existing `function StateTab(...)` stub in `GravityLedgerDrawer.tsx`, add:

```tsx
function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-[var(--border)]/50">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-[0.6875rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)] hover:bg-[var(--accent)]/30"
      >
        <span>
          <span aria-hidden="true">{open ? "▼" : "▶"}</span> {title}{" "}
          <span className="opacity-60">({count})</span>
        </span>
      </button>
      {open ? <div className="px-4 pb-3">{children}</div> : null}
    </section>
  );
}
```

- [ ] **Step 2: Replace the StateTab stub with a real shell**

Replace the existing `function StateTab(...)` with:

```tsx
function StateTab({ chatId }: { chatId: string }) {
  const { data, isLoading, error, refetch } = useGravityState(chatId);
  const [raw, setRaw] = useState(false);

  if (isLoading) {
    return (
      <div role="tabpanel" id="gravity-tabpanel-state" aria-labelledby="gravity-tab-state" className="p-4">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-[var(--accent)]/40" />
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div role="tabpanel" id="gravity-tabpanel-state" aria-labelledby="gravity-tab-state" className="p-4 text-xs">
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-red-300">
          Failed to load state.{" "}
          <button onClick={() => refetch()} className="underline">
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!data?.initialized) {
    return (
      <div
        role="tabpanel"
        id="gravity-tabpanel-state"
        aria-labelledby="gravity-tab-state"
        className="flex h-full items-center justify-center p-8 text-center text-xs text-[var(--muted-foreground)]"
      >
        Gravity has not initialized for this chat. Send a message to begin.
      </div>
    );
  }

  return (
    <div role="tabpanel" id="gravity-tabpanel-state" aria-labelledby="gravity-tab-state">
      <div className="flex justify-end px-4 py-2">
        <button
          onClick={() => setRaw((v) => !v)}
          className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          {raw ? "Structured" : "Raw"}
        </button>
      </div>
      {raw ? (
        <pre className="whitespace-pre-wrap break-words px-4 pb-4 text-[0.625rem] font-mono leading-relaxed text-[var(--muted-foreground)]">
          {data.stateView}
        </pre>
      ) : (
        <StructuredStateView data={data} />
      )}
    </div>
  );
}

function StructuredStateView({ data }: { data: GravityStateResponse }) {
  // Sections implemented in subsequent tasks; for now a placeholder so the file compiles.
  return (
    <div className="text-xs text-[var(--muted-foreground)] px-4 pb-4">
      {data.entities.chars.length} chars, {data.entities.collisions.length} collisions
    </div>
  );
}
```

Add the import at the top of the file:

```ts
import type { GravityStateResponse } from "@marinara-engine/shared";
```

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 4: Manual smoke**

Open the drawer in a chat with Gravity initialized. State tab should show "N chars, M collisions". Click Raw → see the original `stateView` text. Click Structured → see the count line again.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): state tab shell with raw toggle and empty/loading states"
```

---

### Task 14: CHARACTERS section + character row + Character Detail modal

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Replace `StructuredStateView` with the real implementation**

In `GravityLedgerDrawer.tsx`, replace the placeholder `StructuredStateView` with:

```tsx
function StructuredStateView({ data }: { data: GravityStateResponse }) {
  const [detailFor, setDetailFor] = useState<{ char: CharEntity | null; pc: PcEntity | null }>({
    char: null,
    pc: null,
  });

  return (
    <div>
      <CollapsibleSection title="CHARACTERS" count={data.entities.chars.length} defaultOpen>
        {data.entities.chars.length === 0 ? (
          <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
        ) : (
          <ul className="space-y-1">
            {data.entities.chars.map((c) => (
              <li key={c.id}>
                <CharacterRow char={c} onClick={() => setDetailFor({ char: c, pc: null })} />
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CharacterDetailModal
        char={detailFor.char}
        pc={detailFor.pc}
        constraints={data.entities.constraints}
        onClose={() => setDetailFor({ char: null, pc: null })}
      />
    </div>
  );
}

function CharacterRow({ char, onClick }: { char: CharEntity; onClick: () => void }) {
  const tierColor =
    char.tier === "PRINCIPAL"
      ? "text-amber-300"
      : char.tier === "TRACKED"
        ? "text-teal-300"
        : "text-[var(--muted-foreground)]";
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[0.6875rem] hover:bg-[var(--accent)]/40"
    >
      <span className={`font-mono text-[0.5625rem] tabular-nums ${tierColor}`}>[{char.tier}]</span>
      <span className="flex-1 truncate font-medium text-[var(--foreground)]">{char.name}</span>
      {char.location ? (
        <span className="text-[0.5625rem] font-mono text-[var(--muted-foreground)] truncate">
          {char.location}
        </span>
      ) : null}
    </button>
  );
}

function CharacterDetailModal({
  char,
  pc,
  constraints,
  onClose,
}: {
  char: CharEntity | null;
  pc: PcEntity | null;
  constraints: ConstraintEntity[];
  onClose: () => void;
}) {
  // Trap escape; the drawer's own escape handler still fires, so close the modal first.
  useEffect(() => {
    if (!char && !pc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [char, pc, onClose]);

  const subject = char ?? pc;
  if (!subject) return null;

  const tierLabel = char ? char.tier : "PC";
  const linkedConstraints = char
    ? constraints.filter((cs) => char.constraintIds.includes(cs.id))
    : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${subject.name} details`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">
            {subject.name} <span className="text-[0.625rem] font-mono opacity-60">[{tierLabel}]</span>
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
            aria-label="Close"
          >
            <X size="1rem" />
          </button>
        </div>
        <div className="space-y-3 p-4 text-xs">
          <DetailRow label="Location" value={subject.location ?? (pc?.currentPlaceId ?? null)} />
          <DetailList label="Tags" items={subject.tags} />
          {pc ? <DetailList label="Scene Cast" items={pc.sceneCast} /> : null}
          <DetailKvList label="Knowledge" items={subject.knowledgeAsymmetry} />
          <DetailList label="Demonstrated Traits" items={subject.demonstratedTraits} bullet />
          <DetailRow label="Agenda" value={subject.agenda ?? null} />
          {char?.bond ? (
            <div>
              <div className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">
                Bond (PC)
              </div>
              <div className="mt-0.5 text-[var(--foreground)]">
                {char.bond.card} · {char.bond.orientation}
                {char.bond.stage ? ` · ${char.bond.stage}` : ""} · {char.bond.status}
              </div>
              {char.bond.nuance ? <div className="opacity-60 italic">"{char.bond.nuance}"</div> : null}
            </div>
          ) : null}
          {(subject.powerBasis || subject.abilities || subject.wounds) ? (
            <div className="space-y-1.5">
              <div className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">
                Power
              </div>
              {subject.powerBasis ? <DetailRow label="Basis" value={subject.powerBasis} /> : null}
              <DetailList label="Abilities" items={subject.abilities} />
              <DetailKvList label="Wounds" items={subject.wounds} />
            </div>
          ) : null}
          {char?.tier === "PRINCIPAL" && subject.keyMoments && subject.keyMoments.length > 0 ? (
            <DetailList label="Key Moments" items={subject.keyMoments} bullet />
          ) : null}
          {linkedConstraints.length > 0 ? (
            <div>
              <div className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">
                Constraints
              </div>
              <ul className="mt-1 space-y-0.5">
                {linkedConstraints.map((cs) => (
                  <li key={cs.id} className="flex justify-between">
                    <span>{cs.id}</span>
                    {cs.status ? (
                      <span className="font-mono text-[0.5625rem] opacity-60">[{cs.status}]</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">{label}</span>
      <div className="text-[var(--foreground)]">{value}</div>
    </div>
  );
}

function DetailList({
  label,
  items,
  bullet = false,
}: {
  label: string;
  items: string[] | undefined;
  bullet?: boolean;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <span className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">{label}</span>
      {bullet ? (
        <ul className="mt-1 space-y-0.5">
          {items.map((it, i) => (
            <li key={i} className="text-[var(--foreground)]">· {it}</li>
          ))}
        </ul>
      ) : (
        <div className="text-[var(--foreground)]">{items.join(" · ")}</div>
      )}
    </div>
  );
}

function DetailKvList({
  label,
  items,
}: {
  label: string;
  items: Record<string, string> | undefined;
}) {
  if (!items || Object.keys(items).length === 0) return null;
  return (
    <div>
      <span className="text-[0.625rem] font-mono uppercase tracking-wider text-[var(--muted-foreground)]">{label}</span>
      <ul className="mt-1 space-y-0.5">
        {Object.entries(items).map(([k, v]) => (
          <li key={k} className="flex gap-2">
            <span className="font-mono text-[var(--muted-foreground)] shrink-0">{k}</span>
            <span className="text-[var(--foreground)]">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Add the imports at the top of the file**

```ts
import type {
  CharEntity,
  ConstraintEntity,
  GravityStateResponse,
  PcEntity,
} from "@marinara-engine/shared";
```

(Replace the existing `import type { GravityStateResponse } ...` line if it's narrower.)

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 4: Manual smoke**

In a chat with at least one tracked character: open the drawer → State tab → CHARACTERS section is open → click a character row → modal pops with location, tags, knowledge, traits, etc. Escape closes the modal but not the drawer. Click outside the modal closes it.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): characters section + character detail modal"
```

---

### Task 15: PC section (sharing modal)

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Add a PC section to `StructuredStateView`**

Just below the `</CollapsibleSection>` for CHARACTERS in `StructuredStateView`, add:

```tsx
{data.entities.pc ? (
  <CollapsibleSection title="PC" count={1} defaultOpen>
    <button
      onClick={() => setDetailFor({ char: null, pc: data.entities.pc! })}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[0.6875rem] hover:bg-[var(--accent)]/40"
    >
      <span className="font-mono text-[0.5625rem] tabular-nums text-amber-300">[PC]</span>
      <span className="flex-1 truncate font-medium text-[var(--foreground)]">{data.entities.pc.name}</span>
      {data.entities.pc.currentPlaceId ? (
        <span className="text-[0.5625rem] font-mono text-[var(--muted-foreground)] truncate">
          {data.entities.pc.currentPlaceId}
        </span>
      ) : null}
    </button>
    {data.entities.pc.sceneCast.length > 0 ? (
      <div className="mt-2 px-2 text-[0.625rem] text-[var(--muted-foreground)]">
        Scene cast: {data.entities.pc.sceneCast.join(" · ")}
      </div>
    ) : null}
  </CollapsibleSection>
) : null}
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Manual smoke**

Open drawer → State tab → PC section visible → click PC row → modal opens with PC fields including Scene Cast block.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): PC section sharing the character detail modal"
```

---

### Task 16: Other entity sections (collisions, pressures, constraints, places, factions, world)

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Add the remaining sections to `StructuredStateView`**

Below the PC section in `StructuredStateView`, add the following blocks in order:

```tsx
<CollapsibleSection title="COLLISIONS" count={data.entities.collisions.length} defaultOpen>
  {data.entities.collisions.length === 0 ? (
    <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
  ) : (
    <ul className="space-y-2">
      {data.entities.collisions.map((c) => (
        <li key={c.id} className="text-[0.6875rem]">
          <div className="flex items-center gap-2">
            <span className="font-mono">{c.id}</span>
            <span className="font-mono text-[0.5625rem] text-[var(--muted-foreground)]">[{c.status}]</span>
            {c.reach ? <span className="font-mono text-[0.5625rem] opacity-60">{c.reach}</span> : null}
            {typeof c.remaining === "number" ? (
              <span className="ml-auto tabular-nums opacity-60">{c.remaining} remaining</span>
            ) : null}
          </div>
          {c.description ? <div className="ml-2 italic opacity-70">"{c.description}"</div> : null}
        </li>
      ))}
    </ul>
  )}
</CollapsibleSection>

<CollapsibleSection title="PRESSURES" count={data.entities.pressures.length}>
  {data.entities.pressures.length === 0 ? (
    <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
  ) : (
    <ul className="space-y-1 text-[0.6875rem]">
      {data.entities.pressures.map((p) => (
        <li key={p.id} className="flex gap-2">
          <span className="font-mono shrink-0">{p.id}</span>
          {p.description ? <span className="opacity-70">"{p.description}"</span> : null}
        </li>
      ))}
    </ul>
  )}
</CollapsibleSection>

<CollapsibleSection title="CONSTRAINTS" count={data.entities.constraints.length}>
  {data.entities.constraints.length === 0 ? (
    <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
  ) : (
    <ul className="space-y-1 text-[0.6875rem]">
      {data.entities.constraints.map((c) => (
        <li key={c.id} className="flex gap-2">
          <span className="font-mono shrink-0">{c.id}</span>
          {c.status ? <span className="font-mono text-[0.5625rem] opacity-60">[{c.status}]</span> : null}
          {c.description ? <span className="opacity-70">"{c.description}"</span> : null}
        </li>
      ))}
    </ul>
  )}
</CollapsibleSection>

<CollapsibleSection title="PLACES" count={data.entities.places.length}>
  {data.entities.places.length === 0 ? (
    <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
  ) : (
    <ul className="space-y-1 text-[0.6875rem]">
      {data.entities.places.map((p) => (
        <li key={p.id} className="flex gap-2">
          <span className="font-mono shrink-0">{p.id}</span>
          {p.name ? <span>{p.name}</span> : null}
          {p.reach ? <span className="ml-auto font-mono text-[0.5625rem] opacity-60">{p.reach}</span> : null}
        </li>
      ))}
    </ul>
  )}
</CollapsibleSection>

<CollapsibleSection title="FACTIONS" count={data.entities.factions.length}>
  {data.entities.factions.length === 0 ? (
    <div className="text-[0.625rem] text-[var(--muted-foreground)]/50">—</div>
  ) : (
    <ul className="space-y-1 text-[0.6875rem]">
      {data.entities.factions.map((f) => (
        <li key={f.id} className="flex gap-2">
          <span className="font-mono shrink-0">{f.id}</span>
          {f.name ? <span>{f.name}</span> : null}
          {f.tier ? <span className="ml-auto font-mono text-[0.5625rem] opacity-60">[{f.tier}]</span> : null}
        </li>
      ))}
    </ul>
  )}
</CollapsibleSection>

{data.entities.world ? (
  <CollapsibleSection title="WORLD" count={1}>
    <div className="text-[0.6875rem] font-mono">
      mode: {data.entities.world.mode}
      {data.entities.world.timeskip ? ` · timeskip: ${data.entities.world.timeskip}` : " · timeskip: null"}
    </div>
  </CollapsibleSection>
) : null}
```

- [ ] **Step 2: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 3: Manual smoke**

Open drawer in a populated chat. Each section header shows the right count; clicking expands. Sections with 0 entries show `—`.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): collisions/pressures/constraints/places/factions/world sections"
```

---

### Phase C smoke checklist

- [ ] All 8 sections render with correct counts
- [ ] Clicking a character or PC opens the modal with rich detail
- [ ] Raw toggle switches between structured view and `<pre>` text dump
- [ ] Empty (`initialized: false`) chat shows the "send a message to begin" hint
- [ ] Loading skeleton appears briefly on initial open
- [ ] Constraints linked to a character appear in the modal's Constraints subsection (requires engine `charId` field — degraded mode shows nothing if absent)

---

## Phase D — Turns Tab

**Phase D goal:** Turns tab renders a per-director-run timeline with collapsible committed/rejected dropdowns, op-code rendering, confidence dot, director notes, and empty/truncation states.

### Task 17: Turn rows + committed/rejected dropdowns + notes

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Replace the TurnsTab stub**

Replace the existing `function TurnsTab() { ... }` placeholder in `GravityLedgerDrawer.tsx` with:

```tsx
function TurnsTab() {
  const history = useGravityStore((s) => s.history);
  const totalRuns = useGravityStore((s) => s.history.length); // for visible runs
  // The store caps at 50; if you ever needed total, plumb it via store separately.

  if (history.length === 0) {
    return (
      <div
        role="tabpanel"
        id="gravity-tabpanel-turns"
        aria-labelledby="gravity-tab-turns"
        className="flex h-full items-center justify-center p-8 text-center text-xs text-[var(--muted-foreground)]"
      >
        No director runs yet. The director fires after the assistant's reply.
      </div>
    );
  }

  // History is appended chronologically; show newest first.
  const reversed = [...history].reverse();
  return (
    <div role="tabpanel" id="gravity-tabpanel-turns" aria-labelledby="gravity-tab-turns" className="divide-y divide-[var(--border)]/50">
      {totalRuns === 50 ? (
        <div className="px-4 py-2 text-[0.625rem] text-[var(--muted-foreground)]/60 italic">
          Showing last 50 runs (older runs dropped from session memory).
        </div>
      ) : null}
      {reversed.map((run) => (
        <TurnRow key={`${run.turnSeq}-${run.model}`} run={run} />
      ))}
    </div>
  );
}

function TurnRow({ run }: { run: DirectorRun }) {
  const [showCommitted, setShowCommitted] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2 text-[0.6875rem]">
        <span className="font-mono shrink-0 text-[var(--muted-foreground)] tabular-nums w-12">Turn {run.turnSeq}</span>
        <button
          onClick={() => setShowCommitted((v) => !v)}
          disabled={run.committed === 0}
          className="flex items-center gap-0.5 text-teal-300 disabled:text-[var(--muted-foreground)]/40 disabled:cursor-default"
        >
          +{run.committed} committed
          {run.committed > 0 ? <span aria-hidden="true">{showCommitted ? "▼" : "▶"}</span> : null}
        </button>
        <button
          onClick={() => setShowRejected((v) => !v)}
          disabled={run.rejected === 0}
          className="flex items-center gap-0.5 text-red-300/80 disabled:text-[var(--muted-foreground)]/40 disabled:cursor-default"
        >
          {run.rejected} rejected
          {run.rejected > 0 ? <span aria-hidden="true">{showRejected ? "▼" : "▶"}</span> : null}
        </button>
        <span className="ml-auto flex items-center gap-2 text-[var(--muted-foreground)] tabular-nums">
          <span>{(run.durationMs / 1000).toFixed(1)}s</span>
          <ConfidenceDot confidence={run.confidence} />
        </span>
      </div>
      {showCommitted && run.committed > 0 ? (
        <ul className="mt-1.5 ml-12 space-y-0.5 text-[0.625rem] font-mono">
          {run.committedTxs.map((tx, i) => (
            <li key={i} className="text-[var(--muted-foreground)]">
              <TxLine tx={tx} />
            </li>
          ))}
        </ul>
      ) : null}
      {showRejected && run.rejected > 0 ? (
        <ul className="mt-1.5 ml-12 space-y-0.5 text-[0.625rem] font-mono">
          {run.rejectedTxs.map((rt, i) => (
            <li key={i} className="text-red-300/70">
              <TxLine tx={rt.tx} /> <span className="opacity-60">— {rt.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.notes ? <DirectorNotes notes={run.notes} /> : null}
    </div>
  );
}

function ConfidenceDot({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const map = {
    high: { color: "bg-emerald-400", label: "high" },
    medium: { color: "bg-amber-400", label: "medium" },
    low: { color: "bg-red-400/70", label: "low" },
  };
  const m = map[confidence];
  return (
    <span
      className={`h-1.5 w-1.5 rounded-full ${m.color}`}
      aria-label={`confidence: ${m.label}`}
      title={`Confidence: ${m.label} — self-reported by the director model, uncalibrated`}
    />
  );
}

function TxLine({ tx }: { tx: unknown }) {
  if (!tx || typeof tx !== "object") return <span>(invalid tx)</span>;
  const t = tx as RawTransactionLike;
  const opName = OP_CODE_NAMES[t.op] ?? t.op;
  const summary = summarizeTxData(t);
  return (
    <span>
      <span className="font-bold text-[var(--foreground)]" title={opName}>
        {t.op}
      </span>{" "}
      <span className="opacity-80">{t.e ?? "?"}</span>{" "}
      <span className="opacity-80">· {t.id ?? "?"}</span>
      {summary ? <span className="opacity-70"> {summary}</span> : null}
    </span>
  );
}

function summarizeTxData(t: RawTransactionLike): string {
  const d = t.d ?? {};
  const f = typeof d.f === "string" ? d.f : null;
  const v = "v" in d ? d.v : undefined;
  const from = "from" in d ? d.from : undefined;
  const to = "to" in d ? d.to : undefined;
  if (t.op === "TR" && f) return `${f}: ${String(from)} → ${String(to)}`;
  if (f && v !== undefined) {
    const vs = typeof v === "string" ? `"${v}"` : JSON.stringify(v);
    return `${f}: ${vs}`;
  }
  return "";
}

function DirectorNotes({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = notes.split(/\r?\n/).length > 3 || notes.length > 220;
  return (
    <div className="mt-1.5 ml-12 text-[0.625rem] italic text-[var(--muted-foreground)]">
      <div className={expanded ? "whitespace-pre-wrap" : "line-clamp-3 whitespace-pre-wrap"}>{notes}</div>
      {isLong ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[0.5625rem] uppercase tracking-wider not-italic underline-offset-2 hover:underline"
        >
          {expanded ? "show less" : "show more"}
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Add imports at the top of the file**

Add to the existing `@marinara-engine/shared` type imports:

```ts
import type {
  CharEntity,
  ConstraintEntity,
  DirectorRun,
  GravityStateResponse,
  PcEntity,
  RawTransactionLike,
} from "@marinara-engine/shared";
import { OP_CODE_NAMES } from "@marinara-engine/shared";
```

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes. If `line-clamp-3` is unrecognized, ensure `@tailwindcss/line-clamp` is enabled (Tailwind v3.3+ has it by default — should be fine).

- [ ] **Step 4: Manual smoke**

Send a few messages in a Gravity-enabled chat to accumulate director runs. Open Turns tab → see one row per run, newest first. Click `+N committed ▶` → list of tx lines expands. Hover an op code → tooltip shows the full name. Confidence dot has a tooltip explaining self-reported. Send a message that triggers rejected txs (hard to force; if no rejections, just verify no crash).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx
git commit -m "feat(client): turns tab with committed/rejected dropdowns and director notes"
```

---

### Phase D smoke checklist

- [ ] Empty Turns tab shows the "no director runs yet" hint
- [ ] One row per director run appears, newest first
- [ ] Committed dropdown lists each tx with op-code + entity + id + summary
- [ ] Rejected dropdown shows reason after each tx (when present)
- [ ] Confidence dot tooltip explains it's uncalibrated
- [ ] Director notes block clamps to 3 lines, "show more" expands

---

## Phase E — Polish

### Task 18: Focus return + tab arrow keys + final accessibility pass

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`
- Modify: `packages/client/src/components/chat/RoleplayHUD.tsx`

The drawer already has `role="dialog"`, `aria-modal`, escape, backdrop click, and tab roles. Two gaps remain: focus return on close, and verifying tab arrow-key navigation works correctly in practice.

- [ ] **Step 1: Plumb a `returnFocusRef` from the widget**

In `RoleplayHUD.tsx`, give the widget button a stable ref and pass it via `onOpen`:

Change `GravityLedgerWidget` signature:

```ts
function GravityLedgerWidget({
  layout = "top",
  onOpen,
}: {
  layout?: HudPosition;
  onOpen: (returnFocusEl: HTMLElement | null) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const totalCommitted = useGravityStore((s) => s.totalCommitted);
  const lastRun = useGravityStore((s) => (s.history.length > 0 ? s.history[s.history.length - 1] : null));
  const hasArrivals = (lastRun?.newArrivalIds.length ?? 0) > 0;

  return (
    <button
      ref={buttonRef}
      onClick={() => onOpen(buttonRef.current)}
      className={cn(WIDGET, "text-teal-300")}
      title="Gravity Ledger"
    >
      {/* …existing button body unchanged… */}
    </button>
  );
}
```

In ChatArea, change the open handler to remember the trigger:

```ts
const gravityReturnFocusRef = useRef<HTMLElement | null>(null);
// …
const onOpenGravityDrawer = (el: HTMLElement | null) => {
  gravityReturnFocusRef.current = el;
  setGravityDrawerOpen(true);
};
const onCloseGravityDrawer = () => {
  setGravityDrawerOpen(false);
  // Restore focus on next tick so the closing animation completes first.
  setTimeout(() => gravityReturnFocusRef.current?.focus(), 0);
};
```

(Replace the inline `() => setGravityDrawerOpen(true)` callsites with the named functions.)

- [ ] **Step 2: Verify tab arrow-key navigation**

The TabBar implementation already handles ArrowLeft/ArrowRight in its `onKeyDown`. Test in the browser: focus a tab button, press → arrow, focus + selection should move.

- [ ] **Step 3: Run `pnpm check`**

```bash
pnpm check
```

Expected: passes.

- [ ] **Step 4: Manual smoke**

- Tab to the HUD network icon, press Enter → drawer opens, focus on Close button.
- Press Esc → drawer closes, focus returns to the network icon.
- Tab into the tab bar, press → arrow → tab switches.
- Open Character Detail modal → press Esc → modal closes but drawer stays open.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx \
        packages/client/src/components/chat/RoleplayHUD.tsx \
        packages/client/src/components/chat/ChatArea.tsx
git commit -m "feat(client): focus return and accessibility polish for Gravity drawer"
```

---

### Task 19: Final manual smoke pass

**Files:** none (verification only)

- [ ] **Step 1: End-to-end smoke**

Walk through the full feature in `pnpm dev`:

1. Start a fresh Gravity-enabled chat (or load an existing one)
2. Click HUD Network icon → drawer slides in
3. State tab loads → see character rows
4. Click a character → modal opens with knowledge, traits, bond, abilities (if PRINCIPAL: key moments)
5. Esc → modal closes, drawer stays
6. Click Raw button → see `<pre>` state dump
7. Click Structured → return to entity view
8. Click PC row → modal opens with Scene Cast, current location
9. Send a message → assistant replies → director runs
10. Switch to Turns tab → see new row at top with committed count
11. Click `+N committed ▼` → see tx list with op codes
12. Hover op code → tooltip shows full name
13. Hover confidence dot → tooltip shows "self-reported, uncalibrated"
14. Click Export icon → JSON downloads, open it, parses correctly
15. Switch to a different chat → drawer stays open if it was open, or close it; Turns tab is empty for the new chat
16. Switch back → if drawer was closed, reopen → State refetches via TanStack Query

- [ ] **Step 2: `pnpm check` final**

```bash
pnpm check
```

Expected: passes cleanly.

- [ ] **Step 3: Optional `pnpm version:check`**

This UI work doesn't bump versions; skip unless you're preparing a release.

- [ ] **Step 4: No commit needed** (verification only)

---

## Self-Review Notes

**Spec coverage:** Drawer shell ✓, two-row header ✓, mode badge w/ projection ✓, session strip ✓, tab bar ✓, State tab w/ collapsibles ✓, character rows + modal ✓, PC ✓, other entity sections ✓, Raw toggle ✓, empty/loading/error states ✓, Turns tab ✓, committed/rejected dropdowns w/ op codes ✓, director notes w/ clamp ✓, confidence dot w/ caveat ✓, export ✓, store history+cap+reset ✓, agent passthrough ✓, accessibility ✓.

**Out of spec scope (deferred, separate plans):** engine `charId` schema add (constraints subsection in modal renders empty until that lands); engine mode-enum consolidation (UI projection layer absorbs current 5-mode shape today); PC-vs-Char schema unification (UI projection makes them render uniformly without engine change).

**Known caveats:**
- `RoleplayHUD.tsx` had threading complexity due to multiple call sites — verify all `<RoleplayHUD ... />` usages received `onOpenGravityDrawer` correctly; if `pnpm check` complains about missing prop, add it where missing.
- The `messages.createdAt` text-string ordering in `resolveTurnSeq` works because messages use ISO timestamps. If existing chats have non-ISO `createdAt` strings, sorting may be lexicographic and wrong — verify with `sqlite3 ... "SELECT createdAt FROM messages LIMIT 5"` and fix the comparator if needed.
- `transitionErrors.find((e) => e.tx === tx)` reference equality is correct because `validateTransitions` returns the same RawTransaction objects in `errors[].tx` as in the input list — see `consistency.ts:267` and 304+.
