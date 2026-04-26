# Gravity Ledger — Marinara Embedded Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Gravity Ledger into Marinara Engine as two built-in agents (`gravity-ledger-inject` pre_generation, `gravity-ledger-director` post_processing) sharing a TS engine and four new SQLite tables.

**Architecture:** Special-case dispatch mirroring `editor`/`lorebook-keeper`. Inject reads pre-rendered state from `gravity_state_cache`; director runs after the editor block, validates and stages transactions in one atomic SQL transaction (with engine-tick for advance mode), then updates the state cache. Per-`(messageId, swipeIndex)` staging; acceptance on real user turn only.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite), Pino logger, Marinara `BaseLLMProvider`, Node 20+.

**Spec:** `docs/superpowers/specs/2026-04-26-gravity-marinara-embedded-design.md`

---

## File Map

### Part 1 — This repo (`gravity-extension`, `mari-integration` branch)

| Action | Path |
|--------|------|
| Create | `ST/tests/state-machine.test.js` |
| Create | `ST/tests/state-compute.test.js` |
| Create | `ST/tests/consistency.test.js` |

### Part 2 — Marinara fork (separate clone, new branch `gravity-integration`)

**Shared package**

| Action | Path |
|--------|------|
| Modify | `packages/shared/src/types/agent.ts` |
| Modify | `packages/shared/src/schemas/agent.schema.ts` |
| Modify | `packages/shared/src/constants/agent-prompts.ts` |

**DB schema**

| Action | Path |
|--------|------|
| Create | `packages/server/src/db/schema/gravity-transactions.ts` |
| Create | `packages/server/src/db/schema/gravity-state-cache.ts` |
| Create | `packages/server/src/db/schema/gravity-snapshots.ts` |
| Create | `packages/server/src/db/schema/gravity-chat-state.ts` |
| Modify | `packages/server/src/db/schema/index.ts` |

**Gravity service (`packages/server/src/services/gravity/`)**

| Action | Path |
|--------|------|
| Create | `engine/types.ts` |
| Create | `engine/state-machine.ts` |
| Create | `engine/state-compute.ts` |
| Create | `engine/consistency.ts` |
| Create | `engine/ledger-store.ts` |
| Create | `engine/snapshot-mgr.ts` |
| *(skip)* | `engine/relationship.ts` — relationship logic is already embedded in `consistency.ts` and `state-compute.ts` ports; no separate file needed in phase 1 |
| Create | `engine/state-view.ts` |
| Create | `engine/state-cache.ts` |
| Create | `engine/engine-tick.ts` |
| Create | `engine/acceptance.ts` |
| Create | `director/client.ts` |
| Create | `director/prompt.ts` |
| Create | `director/input.ts` |
| Create | `agents/inject-agent.ts` |
| Create | `agents/director-agent.ts` |

**Routes**

| Action | Path |
|--------|------|
| Modify | `packages/server/src/routes/generate.routes.ts` (4 edits) |
| Create | `packages/server/src/routes/gravity.routes.ts` |

---

## Part 1 — Engine Extraction (this repo)

### Task 1: Node test harness for the three host-agnostic engine modules

The ST engine modules (`state-machine.js`, `state-compute.js`, `consistency.js`) are pure JS — no SillyTavern globals. Run them with Node's built-in test runner to confirm correctness before porting to TS.

**Files:**
- Create: `ST/tests/state-machine.test.js`
- Create: `ST/tests/state-compute.test.js`
- Create: `ST/tests/consistency.test.js`

- [ ] **Step 1: Create `ST/tests/state-machine.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTransition,
  CHARACTER_TIERS,
  CONSTRAINT_LEVELS,
  COLLISION_STATES,
} from '../state-machine.js';

test('char UNKNOWN → KNOWN is valid', () => {
  const r = validateTransition('char', 'tier', 'UNKNOWN', 'KNOWN');
  assert.equal(r.valid, true);
});

test('char UNKNOWN → PRINCIPAL is invalid (must go through KNOWN)', () => {
  const r = validateTransition('char', 'tier', 'UNKNOWN', 'PRINCIPAL');
  assert.equal(r.valid, false);
  assert.ok(typeof r.error === 'string');
});

test('constraint BREACHED → STABLE is invalid (terminal state)', () => {
  const r = validateTransition('constraint', 'integrity', 'BREACHED', 'STABLE');
  assert.equal(r.valid, false);
});

test('constraint STRESSED → STABLE is valid (relief)', () => {
  const r = validateTransition('constraint', 'integrity', 'STRESSED', 'STABLE');
  assert.equal(r.valid, true);
});

test('collision ACTIVE → RESOLVED is valid', () => {
  const r = validateTransition('collision', 'status', 'ACTIVE', 'RESOLVED');
  assert.equal(r.valid, true);
});

test('collision RESOLVED → ACTIVE is invalid (terminal)', () => {
  const r = validateTransition('collision', 'status', 'RESOLVED', 'ACTIVE');
  assert.equal(r.valid, false);
});

test('relationship active → dormant is valid', () => {
  const r = validateTransition('relationship', 'status', 'active', 'dormant');
  assert.equal(r.valid, true);
});

test('CHARACTER_TIERS array is defined', () => {
  assert.ok(Array.isArray(CHARACTER_TIERS));
  assert.ok(CHARACTER_TIERS.includes('PRINCIPAL'));
});

test('CONSTRAINT_LEVELS and COLLISION_STATES are defined', () => {
  assert.ok(Array.isArray(CONSTRAINT_LEVELS));
  assert.ok(Array.isArray(COLLISION_STATES));
});
```

- [ ] **Step 2: Run state-machine tests (expect all pass)**

```bash
node --test ST/tests/state-machine.test.js
```

Expected: `9 tests passed` (no failures).

- [ ] **Step 3: Create `ST/tests/state-compute.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, applyTransaction, computeState, CATEGORY_DISTANCES } from '../state-compute.js';

test('createEmptyState returns a valid base structure', () => {
  const s = createEmptyState();
  assert.ok(s.characters && typeof s.characters === 'object');
  assert.ok(s.collisions && typeof s.collisions === 'object');
  assert.equal(s.lastTxId, -1);
});

test('applyTransaction CR char creates an entity', () => {
  const state = createEmptyState();
  const tx = { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } };
  const next = applyTransaction(state, tx);
  assert.ok(next.characters['alice']);
  assert.equal(next.characters['alice'].name, 'Alice');
});

test('applyTransaction S char sets a field', () => {
  const state = createEmptyState();
  const cr = { op: 'CR', e: 'char', id: 'bob', d: { name: 'Bob', tier: 'UNKNOWN' } };
  const s  = { op: 'S', e: 'char', id: 'bob', d: { f: 'tier', v: 'KNOWN' } };
  const next = applyTransaction(applyTransaction(state, cr), s);
  assert.equal(next.characters['bob'].tier, 'KNOWN');
});

test('computeState replays a transaction list', () => {
  const txns = [
    { op: 'CR', e: 'char', id: 'carol', d: { name: 'Carol', tier: 'UNKNOWN' } },
    { op: 'S', e: 'char', id: 'carol', d: { f: 'tier', v: 'TRACKED' } },
  ];
  const state = computeState(txns);
  assert.equal(state.characters['carol'].tier, 'TRACKED');
});

test('CATEGORY_DISTANCES maps expected values', () => {
  assert.equal(CATEGORY_DISTANCES.IMMEDIATE, 1);
  assert.equal(CATEGORY_DISTANCES.SHORT, 10);
  assert.equal(CATEGORY_DISTANCES.MEDIUM, 20);
  assert.equal(CATEGORY_DISTANCES.LONG, 50);
});
```

- [ ] **Step 4: Run state-compute tests (expect all pass)**

```bash
node --test ST/tests/state-compute.test.js
```

Expected: `5 tests passed`.

- [ ] **Step 5: Create `ST/tests/consistency.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, validateTransaction, VALID_OPS, VALID_ENTITIES } from '../consistency.js';

test('VALID_OPS includes all expected operations', () => {
  for (const op of ['CR', 'S', 'TR', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND']) {
    assert.ok(VALID_OPS.includes(op), `Expected ${op} in VALID_OPS`);
  }
});

test('validateTransaction accepts a well-formed CR char', () => {
  const tx = { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } };
  const result = validateTransaction(tx);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
});

test('validateTransaction rejects unknown op', () => {
  const tx = { op: 'BADOP', e: 'char', id: 'x', d: {} };
  const result = validateTransaction(tx);
  assert.ok(result.errors.length > 0);
});

test('validateTransaction rejects missing entity type', () => {
  const tx = { op: 'CR', id: 'x', d: {} };
  const result = validateTransaction(tx);
  assert.ok(result.errors.length > 0);
});

test('validateBatch returns valid and error lists', () => {
  const txns = [
    { op: 'CR', e: 'char', id: 'alice', d: { name: 'Alice', tier: 'UNKNOWN' } },
    { op: 'BADOP' },
  ];
  const result = validateBatch(txns);
  assert.ok(Array.isArray(result.valid));
  assert.ok(typeof result.errors === 'object');
  assert.equal(result.valid.length, 1);
  assert.equal(Object.keys(result.errors).length, 1);
});

test('validateBatch accepts empty array', () => {
  const result = validateBatch([]);
  assert.equal(result.valid.length, 0);
  assert.equal(Object.keys(result.errors).length, 0);
});
```

- [ ] **Step 6: Run consistency tests (expect all pass)**

```bash
node --test ST/tests/consistency.test.js
```

Expected: `6 tests passed`.

- [ ] **Step 7: Commit**

```bash
git add ST/tests/
git commit -m "test(engine): node test harness for state-machine, state-compute, consistency"
```

---

## Part 2 — Marinara Fork

> **Before starting Task 2:** Fork the Marinara Engine repository, create a branch `gravity-integration`, and run `pnpm install`. All remaining tasks operate in the fork. Commands below run from the fork root unless otherwise noted.

### Task 2: Register Gravity agents in shared types

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/schemas/agent.schema.ts`
- Modify: `packages/shared/src/constants/agent-prompts.ts`

- [ ] **Step 1: Add `gravity_state_update` to the `AgentResultType` union in `agent.ts`**

In `packages/shared/src/types/agent.ts`, find the `AgentResultType` union (line ~40) and add before the closing semicolon:

```ts
  | "gravity_state_update"
```

Full union becomes: `"game_state_update" | "text_rewrite" | ... | "game_state_transition" | "gravity_state_update";`

- [ ] **Step 2: Add Gravity IDs to `BUILT_IN_AGENT_IDS` in `agent.ts`**

After `PARTY_PLAYER: "party-player",` (line ~180), add:

```ts
  GRAVITY_LEDGER_INJECT: "gravity-ledger-inject",
  GRAVITY_LEDGER_DIRECTOR: "gravity-ledger-director",
```

- [ ] **Step 3: Add two entries to `BUILT_IN_AGENTS[]` in `agent.ts`**

At the end of the tracker agents section (after `custom-tracker` entry):

```ts
  {
    id: "gravity-ledger-inject",
    name: "Gravity Ledger (State Injection)",
    description:
      "Injects Gravity structural state — collisions, constraints, character dossiers, factions — into the prose model's prompt each turn. Deterministic; no LLM call.",
    phase: "pre_generation",
    enabledByDefault: false,
    defaultInjectAsSection: true,
    category: "tracker",
  },
  {
    id: "gravity-ledger-director",
    name: "Gravity Ledger (Director)",
    description:
      "After the prose response (and after the editor agent), interprets structural state changes and commits them to the Gravity ledger. Requires a separate model connection.",
    phase: "post_processing",
    enabledByDefault: false,
    category: "tracker",
  },
```

- [ ] **Step 4: Add `"gravity-ledger-director": 1` to `BUILT_IN_AGENT_RUN_INTERVAL_DEFAULTS` in `agent.ts`**

After `"lorebook-keeper": 1` (or nearest existing entry), add:

```ts
  "gravity-ledger-director": 1,
```

- [ ] **Step 5: Add `gravity_state_update` to `agentResultTypeSchema` in `agent.schema.ts`**

In `packages/shared/src/schemas/agent.schema.ts`, find `agentResultTypeSchema` (the `z.enum([...]`) and add `"gravity_state_update"` to the array:

```ts
export const agentResultTypeSchema = z.enum([
  "game_state_update",
  // ... existing entries ...
  "gravity_state_update",
]);
```

- [ ] **Step 6: Add director default prompt to `agent-prompts.ts`**

In `packages/shared/src/constants/agent-prompts.ts`, add to `DEFAULT_AGENT_PROMPTS`:

```ts
  "gravity-ledger-inject": "",  // deterministic — no prompt template used
  "gravity-ledger-director": `You are the Gravity Ledger Director. Your sole job is to read the latest prose response and emit structured ledger transactions that update the story state.

OUTPUT FORMAT: respond with valid JSON only.
{
  "transactions": [...],
  "notes": "brief reasoning",
  "confidence": "high" | "medium" | "low"
}

OPERATIONS: CR (create), S (set), TR (transition), A (append), R (remove), MS (map_set), MR (map_del), D (destroy), SNAP, ROLL, AMEND
ENTITY TYPES: char, constraint, collision, combat, faction, place, pressure, world, pc, divination, relationship

CRITICAL RULES:
- Do not set engine-owned fields: collision.distance, pressure.created_at_tx
- Emit only what changed in this turn's prose
- State transitions (TR) must follow valid paths — check current state first
- Use SNAP before any rollback target

Each transaction: { "op": "OP", "e": "entity_type", "id": "entity_id", "d": { ...payload } }`,
```

- [ ] **Step 7: Type-check**

```bash
pnpm check
```

Expected: `0 errors`. If there are type errors, they will be in the union or enum — add the missing literal exactly as shown.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/
git commit -m "feat(gravity): register gravity-ledger-inject and gravity-ledger-director as built-in agents"
```

---

### Task 3: DB schema — four new tables

**Files:**
- Create: `packages/server/src/db/schema/gravity-transactions.ts`
- Create: `packages/server/src/db/schema/gravity-state-cache.ts`
- Create: `packages/server/src/db/schema/gravity-snapshots.ts`
- Create: `packages/server/src/db/schema/gravity-chat-state.ts`
- Modify: `packages/server/src/db/schema/index.ts`

- [ ] **Step 1: Create `gravity-transactions.ts`**

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.js";

export const gravityTransactions = sqliteTable(
  "gravity_transactions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    swipeIndex: integer("swipe_index").notNull().default(0),
    seq: integer("seq").notNull(),
    op: text("op").notNull(),
    payload: text("payload").notNull(),
    accepted: integer("accepted").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    byChatMsgSwipe: index("gravity_tx_chat_msg_swipe").on(t.chatId, t.messageId, t.swipeIndex),
    bySeq: index("gravity_tx_seq").on(t.chatId, t.seq),
    byAccepted: index("gravity_tx_accepted").on(t.chatId, t.accepted),
  }),
);
```

- [ ] **Step 2: Create `gravity-state-cache.ts`**

```ts
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.js";

export const gravityStateCache = sqliteTable(
  "gravity_state_cache",
  {
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    swipeIndex: integer("swipe_index").notNull().default(0),
    stateView: text("state_view").notNull(),
    recentTail: text("recent_tail").notNull(),
    archiveVersion: text("archive_version").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.messageId, t.swipeIndex] }),
  }),
);
```

- [ ] **Step 3: Create `gravity-snapshots.ts`**

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.js";

export const gravitySnapshots = sqliteTable(
  "gravity_snapshots",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    swipeIndex: integer("swipe_index"),
    label: text("label").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    byChat: index("gravity_snap_chat").on(t.chatId),
  }),
);
```

- [ ] **Step 4: Create `gravity-chat-state.ts`**

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats.js";

export const gravityChatState = sqliteTable("gravity_chat_state", {
  chatId: text("chat_id").primaryKey().references(() => chats.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("regular"),
  pendingCorrections: text("pending_corrections"),
  acceptedMessageId: text("accepted_message_id"),
  acceptedSwipeIndex: integer("accepted_swipe_index"),
  nextTxSeq: integer("next_tx_seq").notNull().default(1),
  userTurnsSinceLastDirector: integer("user_turns_since_last_director").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
```

- [ ] **Step 5: Add four exports to `packages/server/src/db/schema/index.ts`**

Append four lines to the barrel file:

```ts
export * from "./gravity-transactions.js";
export * from "./gravity-state-cache.js";
export * from "./gravity-snapshots.js";
export * from "./gravity-chat-state.js";
```

- [ ] **Step 6: Push schema to DB**

```bash
pnpm db:push
```

Expected: Drizzle prints `4 new tables created`. No errors.

- [ ] **Step 7: Type-check**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db/schema/
git commit -m "feat(gravity): add four Gravity DB tables (transactions, state-cache, snapshots, chat-state)"
```

---

### Task 4: Engine core — `types.ts`, `state-machine.ts`, `state-compute.ts`

Create `packages/server/src/services/gravity/engine/` and populate the three pure-logic modules.

- [ ] **Step 1: Create `engine/types.ts`**

```ts
export type TxOp = "CR" | "S" | "TR" | "A" | "R" | "MS" | "MR" | "D" | "SNAP" | "ROLL" | "AMEND";
export type EntityType =
  | "char" | "constraint" | "collision" | "combat" | "faction"
  | "place" | "pressure" | "world" | "pc" | "divination" | "relationship";
export type TurnMode = "regular" | "advance" | "combat" | "intimacy" | "integration";

export interface RawTransaction {
  op: TxOp;
  e?: EntityType;
  id?: string;
  d?: Record<string, unknown>;
  r?: string;  // reason tag (engine-generated)
}

export interface GravityState {
  characters: Record<string, Record<string, unknown>>;
  constraints: Record<string, Record<string, unknown>>;
  collisions: Record<string, Record<string, unknown>>;
  combats: Record<string, Record<string, unknown>>;
  factions: Record<string, Record<string, unknown>>;
  places: Record<string, Record<string, unknown>>;
  pressures: Record<string, Record<string, unknown>>;
  relationships: Record<string, Record<string, unknown>>;
  world: Record<string, unknown>;
  pc: Record<string, unknown>;
  divination: Record<string, unknown>;
  lastTxId: number;
  _history: Record<string, unknown>;
}

export interface ValidationError {
  field?: string;
  message: string;
  fix?: string;
}

export interface ValidationResult {
  valid: RawTransaction[];
  errors: Record<string, ValidationError[]>;
}

export interface TransitionResult {
  valid: boolean;
  error?: string;
  fix?: string;
}
```

- [ ] **Step 2: Create `engine/state-machine.ts`**

Port `ST/state-machine.js` to TypeScript. Keep all logic identical. Change:
- All function declarations add parameter types from `types.ts`
- `export { ... }` → named exports with `: string[]` annotations where needed

```ts
import type { TransitionResult } from "./types.js";

// ── State tables (copy verbatim from ST/state-machine.js) ──────────────────────
export const CHARACTER_TIERS: string[] = ["UNKNOWN", "KNOWN", "TRACKED", "PRINCIPAL"];
export const CHARACTER_TRANSITIONS: Record<string, Record<string, string | null>> = {
  UNKNOWN:   { promote: "KNOWN" },
  KNOWN:     { promote: "TRACKED", retire: null },
  TRACKED:   { promote: "PRINCIPAL", retire: "KNOWN" },
  PRINCIPAL: { retire: "TRACKED" },
};
// ... (copy all tables from ST/state-machine.js) ...

export function validateTransition(
  entityType: string,
  field: string | undefined,
  from: string,
  to: string,
): TransitionResult {
  // Direct copy of the JS implementation — only add types to the signature
}

export function checkPrincipalUniqueness(
  entityType: string,
  entityId: string,
  state: Record<string, Record<string, unknown>>,
): TransitionResult {
  // Direct copy of the JS implementation
}

export function getStateMachineField(entityType: string, field?: string): string | null {
  // Direct copy of the JS implementation
}
```

- [ ] **Step 3: Create `engine/state-compute.ts`**

Port `ST/state-compute.js` to TypeScript. Same approach — copy logic, add types.

```ts
import type { RawTransaction, GravityState } from "./types.js";

export const CATEGORY_DISTANCES: Record<string, number> = {
  IMMEDIATE: 1,
  SHORT: 10,
  MEDIUM: 20,
  LONG: 50,
};

export function createEmptyState(): GravityState {
  // Direct copy from ST/state-compute.js
}

export function applyTransaction(state: GravityState, tx: RawTransaction): GravityState {
  // Direct copy — returns a new state object
}

export function computeState(transactions: RawTransaction[]): GravityState {
  // Direct copy — reduces over all transactions
}

export function getCollectionName(entityType: string): string | null {
  // Direct copy
}
```

- [ ] **Step 4: Type-check**

```bash
pnpm check
```

Expected: `0 errors`. Fix any type errors — common pitfalls: `Object.entries` returns `[string, unknown][]` which may need casting.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/gravity/engine/types.ts
git add packages/server/src/services/gravity/engine/state-machine.ts
git add packages/server/src/services/gravity/engine/state-compute.ts
git commit -m "feat(gravity): port state-machine and state-compute to TS"
```

---

### Task 5: Engine core — `consistency.ts`

- [ ] **Step 1: Create `engine/consistency.ts`**

Port `ST/consistency.js`. This file imports from state-machine and state-compute.

```ts
import { validateTransition, getStateMachineField } from "./state-machine.js";
import { applyTransaction } from "./state-compute.js";
import type { RawTransaction, ValidationError, ValidationResult, GravityState } from "./types.js";

export const VALID_OPS = ["CR", "S", "TR", "A", "R", "MS", "MR", "D", "SNAP", "ROLL", "AMEND"] as const;
export const VALID_ENTITIES = [
  "char", "constraint", "collision", "combat", "faction",
  "place", "pressure", "world", "pc", "divination", "relationship",
] as const;

export interface TransactionValidationResult {
  errors: ValidationError[];
}

export function validateTransaction(tx: unknown): TransactionValidationResult {
  // Direct copy from ST/consistency.js — validateTransaction()
}

export function validateBatch(txns: unknown[]): ValidationResult {
  // Direct copy from ST/consistency.js — validateBatch()
}

export function validateTransitions(
  txns: RawTransaction[],
  state: GravityState,
): Record<string, ValidationError[]> {
  // Direct copy from ST/consistency.js — validateTransitions()
}

export function formatErrors(errors: Record<string, ValidationError[]>): string {
  // Direct copy from ST/consistency.js — formatErrors()
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/engine/consistency.ts
git commit -m "feat(gravity): port consistency validator to TS"
```

---

### Task 6: Storage — `ledger-store.ts` and `snapshot-mgr.ts`

These are new implementations (not ports) that replace the ST chatMetadata-backed versions with Drizzle DB calls.

- [ ] **Step 1: Create `engine/ledger-store.ts`**

```ts
import { eq, and, asc } from "drizzle-orm";
import type { DB } from "../../../db/connection.js";
import { gravityTransactions, gravityChatState } from "../../../db/schema/index.js";
import type { RawTransaction } from "./types.js";
import { computeState } from "./state-compute.js";

export function createLedgerStore(db: DB) {
  return {
    /** All accepted transactions for a chat, in seq order. */
    async getAcceptedTransactions(chatId: string): Promise<RawTransaction[]> {
      const rows = await db
        .select()
        .from(gravityTransactions)
        .where(and(eq(gravityTransactions.chatId, chatId), eq(gravityTransactions.accepted, 1)))
        .orderBy(asc(gravityTransactions.seq));
      return rows.map((r) => JSON.parse(r.payload) as RawTransaction);
    },

    /** All transactions for a specific swipe (accepted or not). */
    async getSwipeTransactions(
      chatId: string,
      messageId: string,
      swipeIndex: number,
    ): Promise<RawTransaction[]> {
      const rows = await db
        .select()
        .from(gravityTransactions)
        .where(
          and(
            eq(gravityTransactions.chatId, chatId),
            eq(gravityTransactions.messageId, messageId),
            eq(gravityTransactions.swipeIndex, swipeIndex),
          ),
        )
        .orderBy(asc(gravityTransactions.seq));
      return rows.map((r) => JSON.parse(r.payload) as RawTransaction);
    },

    /**
     * Allocate seq numbers and stage transactions. Must run inside an outer
     * db.transaction() call — pass the transaction object as `tx`.
     */
    async stageTransactions(
      tx: DB,
      chatId: string,
      messageId: string,
      swipeIndex: number,
      txns: RawTransaction[],
    ): Promise<void> {
      if (txns.length === 0) return;

      const [current] = await tx
        .select({ nextTxSeq: gravityChatState.nextTxSeq })
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId));
      const startSeq = current?.nextTxSeq ?? 1;

      await tx
        .update(gravityChatState)
        .set({ nextTxSeq: startSeq + txns.length })
        .where(eq(gravityChatState.chatId, chatId));

      await tx.insert(gravityTransactions).values(
        txns.map((t, i) => ({
          id: crypto.randomUUID(),
          chatId,
          messageId,
          swipeIndex,
          seq: startSeq + i,
          op: t.op,
          payload: JSON.stringify(t),
          accepted: 0,
        })),
      );
    },

    /** Replay accepted transactions to get the current authoritative state. */
    async computeAcceptedState(chatId: string) {
      const txns = await this.getAcceptedTransactions(chatId);
      return computeState(txns);
    },
  };
}
```

- [ ] **Step 2: Create `engine/snapshot-mgr.ts`**

```ts
import { eq, desc } from "drizzle-orm";
import type { DB } from "../../../db/connection.js";
import { gravitySnapshots } from "../../../db/schema/index.js";
import type { GravityState } from "./types.js";

export function createSnapshotManager(db: DB) {
  return {
    async createSnapshot(
      chatId: string,
      label: string,
      state: GravityState,
      messageId?: string,
      swipeIndex?: number,
    ): Promise<string> {
      const id = crypto.randomUUID();
      await db.insert(gravitySnapshots).values({
        id,
        chatId,
        messageId: messageId ?? null,
        swipeIndex: swipeIndex ?? null,
        label,
        payload: JSON.stringify(state),
      });
      return id;
    },

    async listSnapshots(chatId: string) {
      return db
        .select()
        .from(gravitySnapshots)
        .where(eq(gravitySnapshots.chatId, chatId))
        .orderBy(desc(gravitySnapshots.createdAt));
    },

    async getSnapshot(id: string) {
      const rows = await db
        .select()
        .from(gravitySnapshots)
        .where(eq(gravitySnapshots.id, id))
        .limit(1);
      if (!rows[0]) return null;
      return JSON.parse(rows[0].payload) as GravityState;
    },
  };
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Expected: `0 errors`. If `DB` transaction type complaints arise, use `Parameters<typeof db.transaction>[0]` for the `tx` parameter type.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/gravity/engine/ledger-store.ts
git add packages/server/src/services/gravity/engine/snapshot-mgr.ts
git commit -m "feat(gravity): implement DB-backed ledger-store and snapshot-mgr"
```

---

### Task 7: Presentation — `state-view.ts` and `state-cache.ts`

- [ ] **Step 1: Create `engine/state-view.ts`**

Port `ST/state-view.js` to TypeScript. This is a pure formatting module.

```ts
import type { GravityState, TurnMode } from "./types.js";

export function formatStateView(state: GravityState): string {
  // Direct port of ST/state-view.js formatStateView (or equivalent top-level function)
  // Returns the full entity registry + dossiers as a text block
}

export function buildNudge(mode: TurnMode, state: GravityState): string {
  // Port of the mode-specific nudge builders from ST/state-view.js
  // Returns the _nudge injection text for the given mode
}

export function computeArchiveVersion(state: GravityState): string {
  // Port of computeArchiveVersion from ST/state-view.js
}

export function buildRecentTail(txns: import("./types.js").RawTransaction[], n = 20): string {
  return JSON.stringify(txns.slice(-n));
}
```

> Look at `ST/state-view.js:754` for the full export list; port each exported function with matching TypeScript types.

- [ ] **Step 2: Create `engine/state-cache.ts`**

```ts
import { eq, and } from "drizzle-orm";
import type { DB } from "../../../db/connection.js";
import { gravityStateCache, gravityChatState } from "../../../db/schema/index.js";
import { formatStateView, buildNudge, computeArchiveVersion, buildRecentTail } from "./state-view.js";
import type { GravityState, TurnMode } from "./types.js";

export function createStateCacheStore(db: DB) {
  return {
    /** Read the state-cache row for the last accepted swipe. */
    async getAcceptedCache(chatId: string) {
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);
      if (!chatState?.acceptedMessageId) return null;

      const rows = await db
        .select()
        .from(gravityStateCache)
        .where(
          and(
            eq(gravityStateCache.chatId, chatId),
            eq(gravityStateCache.messageId, chatState.acceptedMessageId),
            eq(gravityStateCache.swipeIndex, chatState.acceptedSwipeIndex ?? 0),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    /** Re-render and upsert the state-cache row for a given swipe. */
    async upsertForSwipe(
      tx: DB,
      chatId: string,
      messageId: string,
      swipeIndex: number,
      state: GravityState,
      acceptedTxns: import("./types.js").RawTransaction[],
      mode: TurnMode,
    ): Promise<void> {
      const stateView = formatStateView(state);
      const recentTail = buildRecentTail(acceptedTxns);
      const archiveVersion = computeArchiveVersion(state);
      await tx
        .insert(gravityStateCache)
        .values({ chatId, messageId, swipeIndex, stateView, recentTail, archiveVersion })
        .onConflictDoUpdate({
          target: [gravityStateCache.chatId, gravityStateCache.messageId, gravityStateCache.swipeIndex],
          set: { stateView, recentTail, archiveVersion },
        });
    },
  };
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/gravity/engine/state-view.ts
git add packages/server/src/services/gravity/engine/state-cache.ts
git commit -m "feat(gravity): implement state-view (port) and state-cache (DB-backed)"
```

---

### Task 8: `engine-tick.ts` and `acceptance.ts`

- [ ] **Step 1: Create `engine/engine-tick.ts`**

Port of `ST/index.js:applyAdvanceTick` (lines 2356–2409), rewritten as a pure function.

```ts
import type { RawTransaction, GravityState, TurnMode } from "./types.js";

const TICK: Record<string, number> = {
  HOURS: 1,
  DAYS: 24,
  WEEKS: 24 * 7,
  MONTHS: 24 * 30,
};

export interface EngineTickResult {
  tickTxns: RawTransaction[];   // to be staged by the caller via stageTransactions
  newArrivalIds: string[];      // collision IDs that just hit distance 0 (caller handles inject)
}

/**
 * Deterministic post-commit phase. Reads world.timeskip_scale from state,
 * emits distance-tick and pressure-clear transactions, always resets scale to HOURS.
 *
 * Call only when mode === "advance"; safe to call on other modes (returns empty).
 */
export function engineTick(state: GravityState, mode: TurnMode): EngineTickResult {
  const tickTxns: RawTransaction[] = [];
  const newArrivalIds: string[] = [];

  if (mode !== "advance") {
    // Scale reset is unconditional — makes the default sticky
    if (state.world?.timeskip_scale && state.world.timeskip_scale !== "HOURS") {
      tickTxns.push({
        op: "S", e: "world", id: "_",
        d: { f: "timeskip_scale", v: "HOURS" },
        r: "system:advance:reset-timeskip",
      });
    }
    return { tickTxns, newArrivalIds };
  }

  const scale = String(state.world?.timeskip_scale ?? "HOURS").toUpperCase();
  const tickDelta = TICK[scale] ?? 1;

  // Tick non-IMMEDIATE ACTIVE collisions
  for (const [id, col] of Object.entries(state.collisions)) {
    const dist = parseFloat(String(col.distance));
    const status = String(col.status ?? "").trim().toUpperCase();
    if (status !== "ACTIVE") continue;
    if (col.distance_category === "IMMEDIATE") continue;
    if (isNaN(dist) || dist <= 0) continue;
    const newDist = Math.max(0, dist - tickDelta);
    if (newDist !== dist) {
      tickTxns.push({
        op: "S", e: "collision", id,
        d: { f: "distance", v: newDist },
        r: "system:advance:tick",
      });
    }
  }

  // WEEKS/MONTHS: clear pressure points
  if (scale === "WEEKS" || scale === "MONTHS") {
    for (const id of Object.keys(state.pressures)) {
      tickTxns.push({
        op: "D", e: "pressure", id,
        r: `system:advance:${scale.toLowerCase()}-clear-pressure`,
      });
    }
  }

  // Arrival detection (distance hits 0 this tick)
  for (const [id, col] of Object.entries(state.collisions)) {
    const status = String(col.status ?? "").toUpperCase();
    const dist = parseFloat(String(col.distance));
    // Check the collision distance BEFORE the tick; tick sets newDist = 0
    if (status === "ACTIVE" && !isNaN(dist) && dist > 0 && dist - tickDelta <= 0) {
      newArrivalIds.push(id);
    }
  }

  // Scale reset (unconditional)
  tickTxns.push({
    op: "S", e: "world", id: "_",
    d: { f: "timeskip_scale", v: "HOURS" },
    r: "system:advance:reset-timeskip",
  });

  return { tickTxns, newArrivalIds };
}
```

- [ ] **Step 2: Create `engine/acceptance.ts`**

```ts
import { eq, and, sql } from "drizzle-orm";
import type { DB } from "../../../db/connection.js";
import { gravityTransactions, gravityChatState } from "../../../db/schema/index.js";
import { logger } from "../../../lib/logger.js";

export function createGravityAcceptance(db: DB) {
  return {
    /**
     * Mark a swipe's staged transactions as accepted and advance the run-interval counter.
     * Call from generate.routes.ts alongside gameStateStore.commit().
     */
    async commitAcceptedGravityTurn(
      chatId: string,
      messageId: string,
      swipeIndex: number,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(gravityTransactions)
          .set({ accepted: 1 })
          .where(
            and(
              eq(gravityTransactions.chatId, chatId),
              eq(gravityTransactions.messageId, messageId),
              eq(gravityTransactions.swipeIndex, swipeIndex),
            ),
          );
        await tx
          .update(gravityChatState)
          .set({
            acceptedMessageId: messageId,
            acceptedSwipeIndex: swipeIndex,
            userTurnsSinceLastDirector: sql`user_turns_since_last_director + 1`,
          })
          .where(eq(gravityChatState.chatId, chatId));
      });
      logger.debug("gravity: committed turn %s swipe %d for chat %s", messageId, swipeIndex, chatId);
    },
  };
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/gravity/engine/engine-tick.ts
git add packages/server/src/services/gravity/engine/acceptance.ts
git commit -m "feat(gravity): implement engine-tick and acceptance helper"
```

---

### Task 9: Director module — `client.ts`, `prompt.ts`, `input.ts`

- [ ] **Step 1: Create `director/prompt.ts`**

Port `ST/director-prompt.js` to TypeScript:

```ts
export function buildDirectorSystemPrompt(template?: string): string {
  if (template) return template;
  // Return the full director system prompt from ST/director-prompt.js buildDirectorSystemPrompt()
  // Copy verbatim — it's the op vocabulary + entity guide + engine-owned-fields warning
  return `[paste full content of ST/director-prompt.js buildDirectorSystemPrompt() here]`;
}
```

> Open `ST/director-prompt.js`, find `buildDirectorSystemPrompt()` at line 196, and copy its return value into the TS function.

- [ ] **Step 2: Create `director/input.ts`**

```ts
import type { GravityState, TurnMode } from "../engine/types.js";

export const MAX_CORRECTION_ATTEMPTS = 3;

export interface CorrectionEntry {
  txId: string;
  rejectedTx: unknown;
  reason: string;
  attempt: number;
}

export interface CorrectionsPayload {
  entries: CorrectionEntry[];
  generatedAt: number;
}

export interface DirectorInput {
  mode: TurnMode;
  assistantMessage: string;
  stateView: string;
  recentTail: string;
  pendingCorrections: CorrectionsPayload | null;
  chatSummary: string | null;
  activatedLorebookTitles: string[];
}

export function buildDirectorInput(params: {
  mode: TurnMode;
  assistantMessage: string;
  stateView: string;
  recentTail: string;
  pendingCorrections: CorrectionsPayload | null;
  chatSummary?: string | null;
  activatedLorebookTitles?: string[];
}): DirectorInput {
  return {
    mode: params.mode,
    assistantMessage: params.assistantMessage,
    stateView: params.stateView,
    recentTail: params.recentTail,
    pendingCorrections: params.pendingCorrections,
    chatSummary: params.chatSummary ?? null,
    activatedLorebookTitles: params.activatedLorebookTitles ?? [],
  };
}

export function renderDirectorUserPrompt(input: DirectorInput): string {
  // Port of ST/director-client.js renderUserPrompt() — builds the user message
  // for the director call. Copy the template from ST/director-input.js buildDirectorInput()
  // and ST/director-client.js renderUserPrompt().
  const parts: string[] = [];
  parts.push(`MODE: ${input.mode}`);
  parts.push(`\n---PROSE---\n${input.assistantMessage}\n---END PROSE---`);
  parts.push(`\n---STATE---\n${input.stateView}\n---END STATE---`);
  if (input.recentTail) parts.push(`\n---RECENT TX---\n${input.recentTail}\n---END RECENT TX---`);
  if (input.pendingCorrections?.entries.length) {
    parts.push(`\n---CORRECTIONS NEEDED---\n${JSON.stringify(input.pendingCorrections.entries, null, 2)}\n---END CORRECTIONS---`);
  }
  if (input.chatSummary) parts.push(`\n---SUMMARY---\n${input.chatSummary}\n---END SUMMARY---`);
  if (input.activatedLorebookTitles.length) {
    parts.push(`\nActive lore: ${input.activatedLorebookTitles.join(", ")}`);
  }
  return parts.join("\n");
}
```

- [ ] **Step 3: Create `director/client.ts`**

```ts
import type { BaseLLMProvider, ChatMessage } from "../../llm/base-provider.js";
import { buildDirectorSystemPrompt } from "./prompt.js";
import { renderDirectorUserPrompt } from "./input.js";
import type { DirectorInput } from "./input.js";
import { logger } from "../../../lib/logger.js";

export interface DirectorProposal {
  transactions: unknown[];
  notes: string;
  confidence: "high" | "medium" | "low";
  model: string;
  durationMs: number;
}

/** Extract JSON from a response that may have markdown fences or leading prose. */
function extractJson(text: string): string {
  // Try markdown fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  // Find the first { and last }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export async function callDirector(
  input: DirectorInput,
  provider: BaseLLMProvider,
  model: string,
  promptTemplate: string | undefined,
  signal: AbortSignal,
): Promise<DirectorProposal> {
  const t0 = Date.now();
  const systemPrompt = buildDirectorSystemPrompt(promptTemplate);
  const userPrompt = renderDirectorUserPrompt(input);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  logger.debug("[gravity-director] calling model %s (%d chars system, %d chars user)", model, systemPrompt.length, userPrompt.length);

  const result = await provider.chatComplete(messages, {
    model,
    temperature: 0.3,
    maxTokens: 4096,
    stream: false,
    responseFormat: { type: "json_object" },
    signal,
  });

  const raw = result.content?.trim() ?? "";
  const durationMs = Date.now() - t0;

  let parsed: { transactions?: unknown[]; notes?: string; confidence?: string };
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    logger.warn("[gravity-director] JSON parse failed, raw=%s", raw.slice(0, 200));
    parsed = { transactions: [], notes: "parse error", confidence: "low" };
  }

  return {
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    confidence: (parsed.confidence as "high" | "medium" | "low") ?? "low",
    model,
    durationMs,
  };
}
```

- [ ] **Step 4: Type-check**

```bash
pnpm check
```

Expected: `0 errors`. If `responseFormat` is not on the `chatComplete` options type, omit it — the tolerant JSON extractor is the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/gravity/director/
git commit -m "feat(gravity): implement director client, prompt, and input builder"
```

---

### Task 10: Agent entry-points — `inject-agent.ts` and `director-agent.ts`

- [ ] **Step 1: Create `agents/inject-agent.ts`**

```ts
import { eq } from "drizzle-orm";
import type { DB } from "../../../db/connection.js";
import { gravityChatState } from "../../../db/schema/index.js";
import { createStateCacheStore } from "../engine/state-cache.js";
import { createLedgerStore } from "../engine/ledger-store.js";
import { computeState } from "../engine/state-compute.js";
import { buildNudge } from "../engine/state-view.js";
import type { TurnMode } from "../engine/types.js";
import { logger } from "../../../lib/logger.js";

export interface GravityInjectResult {
  text: string;
  archiveVersion: string;
  mode: TurnMode;
}

export function createInjectAgent(db: DB) {
  const stateCacheStore = createStateCacheStore(db);
  const ledgerStore = createLedgerStore(db);

  return {
    async loadGravityInjectForChat(chatId: string): Promise<GravityInjectResult | null> {
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);

      if (!chatState) {
        logger.debug("[gravity-inject] no chat state for chat %s — chat not initialized", chatId);
        return null;
      }

      if (!chatState.acceptedMessageId) {
        logger.debug("[gravity-inject] no accepted turn yet for chat %s", chatId);
        return null;
      }

      const cache = await stateCacheStore.getAcceptedCache(chatId);
      if (!cache) {
        logger.warn("[gravity-inject] state-cache missing for chat %s — state-cache rebuild needed", chatId);
        return null;
      }

      const mode = chatState.mode as TurnMode;

      // Rebuild state from accepted transactions to pass to buildNudge
      const acceptedTxns = await ledgerStore.getAcceptedTransactions(chatId);
      const state = computeState(acceptedTxns);
      const nudge = buildNudge(mode, state);
      const text = `${cache.stateView}\n\n${nudge}`;

      return { text, archiveVersion: cache.archiveVersion, mode };
    },
  };
}
```

- [ ] **Step 2: Create `agents/director-agent.ts`**

```ts
import type { DB } from "../../../db/connection.js";
import { eq, sql } from "drizzle-orm";
import { gravityChatState } from "../../../db/schema/index.js";
import { createLedgerStore } from "../engine/ledger-store.js";
import { createStateCacheStore } from "../engine/state-cache.js";
import { validateBatch, validateTransitions } from "../engine/consistency.js";
import { computeState } from "../engine/state-compute.js";
import { engineTick } from "../engine/engine-tick.js";
import { buildDirectorInput } from "../director/input.js";
import { callDirector } from "../director/client.js";
import type { CorrectionsPayload, CorrectionEntry } from "../director/input.js";
import type { RawTransaction, TurnMode } from "../engine/types.js";
import type { BaseLLMProvider } from "../../llm/base-provider.js";
import type { AgentConfig, AgentContext } from "@marinara-engine/shared";
import { logger } from "../../../lib/logger.js";

export interface GravityDirectorInput {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  assistantMessage: string;
  agentConfig: AgentConfig;
  context: AgentContext;
  provider: BaseLLMProvider;
  model: string;
  signal: AbortSignal;
}

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
  };
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}

export function createDirectorAgent(db: DB) {
  const ledgerStore = createLedgerStore(db);
  const stateCacheStore = createStateCacheStore(db);

  return {
    async runGravityDirector(input: GravityDirectorInput): Promise<GravityDirectorResult> {
      const t0 = Date.now();
      const { chatId, messageId, swipeIndex, assistantMessage, agentConfig, context, provider, model, signal } = input;

      // ── 1. Resolve prompt template ────────────────────────────────────────────
      // agentConfig.promptTemplate is null/empty by default; falls back to default in callDirector
      const promptTemplate = agentConfig.promptTemplate || undefined;

      // ── 2. Load shared state ──────────────────────────────────────────────────
      const [chatState] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);
      const mode = (chatState?.mode ?? "regular") as TurnMode;
      const pendingCorrections = chatState?.pendingCorrections
        ? (JSON.parse(chatState.pendingCorrections) as CorrectionsPayload)
        : null;

      // ── 3. Load last-accepted state-cache ─────────────────────────────────────
      const cache = await stateCacheStore.getAcceptedCache(chatId);
      const stateView = cache?.stateView ?? "";
      const recentTail = cache?.recentTail ?? "[]";

      // ── 4. Build director input ───────────────────────────────────────────────
      const directorInput = buildDirectorInput({
        mode,
        assistantMessage,
        stateView,
        recentTail,
        pendingCorrections,
        chatSummary: context.chatSummary ?? null,
        activatedLorebookTitles: context.activatedLorebookEntries?.map((e: { title: string }) => e.title) ?? [],
      });

      // ── 5. LLM call ───────────────────────────────────────────────────────────
      let proposal;
      try {
        proposal = await callDirector(directorInput, provider, model, promptTemplate, signal);
      } catch (err) {
        logger.error(err, "[gravity-director] LLM call failed for chat %s", chatId);
        return makeError(agentConfig, "LLM call failed", t0);
      }

      // ── Steps 6–9: single SQL transaction ────────────────────────────────────
      let committed = 0;
      let rejected = 0;
      let newArrivalIds: string[] = [];
      const allErrors: Record<string, unknown> = {};

      try {
        await db.transaction(async (tx) => {
          // 6. validateAndStage
          const { valid, errors } = validateBatch(proposal.transactions);
          Object.assign(allErrors, errors);
          rejected = proposal.transactions.length - valid.length;

          // Validate state-machine transitions against current accepted state
          const acceptedTxns = await ledgerStore.getAcceptedTransactions(chatId);
          const currentState = computeState(acceptedTxns);
          const transitionErrors = validateTransitions(valid, currentState);
          Object.assign(allErrors, transitionErrors);
          const validAfterTransitions = valid.filter((_, i) => !transitionErrors[String(i)]);
          rejected += valid.length - validAfterTransitions.length;

          await ledgerStore.stageTransactions(tx as DB, chatId, messageId, swipeIndex, validAfterTransitions);
          committed = validAfterTransitions.length;

          // 7. Engine tick
          const stagedState = computeState([...acceptedTxns, ...validAfterTransitions]);
          const tickResult = engineTick(stagedState, mode);
          newArrivalIds = tickResult.newArrivalIds;
          if (tickResult.tickTxns.length > 0) {
            await ledgerStore.stageTransactions(tx as DB, chatId, messageId, swipeIndex, tickResult.tickTxns);
          }

          // 8. Update state cache for this swipe
          const allStagedTxns = [...acceptedTxns, ...validAfterTransitions, ...tickResult.tickTxns];
          const finalState = computeState(allStagedTxns);
          await stateCacheStore.upsertForSwipe(tx as DB, chatId, messageId, swipeIndex, finalState, acceptedTxns, mode);

          // 9. Upsert gravity_chat_state
          const newCorrections = buildNewCorrections(allErrors, proposal.transactions, pendingCorrections);
          await (tx as DB)
            .update(gravityChatState)
            .set({
              pendingCorrections: newCorrections ? JSON.stringify(newCorrections) : null,
              userTurnsSinceLastDirector: 0,
            })
            .where(eq(gravityChatState.chatId, chatId));
        });
      } catch (err) {
        logger.error(err, "[gravity-director] transaction failed for chat %s", chatId);
        return makeError(agentConfig, "DB transaction failed", t0);
      }

      const durationMs = Date.now() - t0;
      logger.info(
        "[gravity-director] chat=%s committed=%d rejected=%d arrivals=%d model=%s dur=%dms",
        chatId, committed, rejected, newArrivalIds.length, model, durationMs,
      );

      return {
        agentId: agentConfig.id,
        agentType: "gravity-ledger-director",
        type: "gravity_state_update",
        data: { committed, rejected, errors: allErrors, newArrivalIds, durationMs, model },
        tokensUsed: 0,
        durationMs,
        success: true,
        error: null,
      };
    },
  };
}

function makeError(agentConfig: AgentConfig, message: string, t0: number): GravityDirectorResult {
  return {
    agentId: agentConfig.id,
    agentType: "gravity-ledger-director",
    type: "gravity_state_update",
    data: { committed: 0, rejected: 0, errors: {}, newArrivalIds: [], durationMs: Date.now() - t0, model: "" },
    tokensUsed: 0,
    durationMs: Date.now() - t0,
    success: false,
    error: message,
  };
}

function buildNewCorrections(
  errors: Record<string, unknown>,
  allTxns: unknown[],
  existing: CorrectionsPayload | null,
): CorrectionsPayload | null {
  const MAX = 3;
  const entries: CorrectionEntry[] = [];
  for (const [idx, errs] of Object.entries(errors)) {
    const i = Number(idx);
    const prev = existing?.entries.find((e) => e.txId === String(i));
    const attempt = (prev?.attempt ?? 0) + 1;
    if (attempt > MAX) continue;
    entries.push({
      txId: String(i),
      rejectedTx: allTxns[i],
      reason: JSON.stringify(errs),
      attempt,
    });
  }
  if (entries.length === 0) return null;
  return { entries, generatedAt: Math.floor(Date.now() / 1000) };
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Fix any type errors — the most likely: `AgentContext` field names for `chatSummary` and `activatedLorebookEntries`. Check `packages/shared/src/types/agent.ts` `AgentContext` interface and adjust field names.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/gravity/agents/
git commit -m "feat(gravity): implement inject-agent and director-agent entry-points"
```

---

### Task 11: Wire `generate.routes.ts` — four surgical edits

Each edit is independent; make one at a time and check it compiles.

- [ ] **Step 1: Edit (a) — acceptance hook at `:~334`**

Find this block in `generate.routes.ts`:
```ts
          const gs = await gameStateStore.getByMessage(lastAsstMsg.id, lastAsstMsg.activeSwipeIndex);
          if (gs) await gameStateStore.commit(gs.id);
          break;
```

Replace with:
```ts
          const gs = await gameStateStore.getByMessage(lastAsstMsg.id, lastAsstMsg.activeSwipeIndex);
          if (gs) await gameStateStore.commit(gs.id);
          // Gravity: accept this swipe's staged transactions
          await gravityAcceptance.commitAcceptedGravityTurn(
            input.chatId,
            lastAsstMsg.id,
            lastAsstMsg.activeSwipeIndex,
          );
          break;
```

At the top of the route handler (near `const gameStateStore = createGameStateStorage(app.db);`), add:

```ts
const gravityAcceptance = createGravityAcceptance(app.db);
```

Add the import near the top of the file:
```ts
import { createGravityAcceptance } from "../services/gravity/engine/acceptance.js";
```

- [ ] **Step 2: Compile-check after edit (a)**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 3: Edit (b) — filter Gravity from standard pipeline at `:~3605`**

Find:
```ts
let pipelineAgents = resolvedAgents.filter((a) => a.type !== "editor" && a.type !== "lorebook-keeper");
```

Replace with:
```ts
let pipelineAgents = resolvedAgents.filter(
  (a) =>
    a.type !== "editor" &&
    a.type !== "lorebook-keeper" &&
    a.type !== "gravity-ledger-inject" &&
    a.type !== "gravity-ledger-director",
);
```

- [ ] **Step 4: Edit (c) — inject Gravity state in tracker-parts block at `:~3565`**

Find the section where `trackerParts.push` lines appear. Add this block immediately before the `if (trackerParts.length > 0)` check:

```ts
// Gravity Ledger inject
const gravityInjectAgent = resolvedAgents.find((a) => a.type === "gravity-ledger-inject");
if (gravityInjectAgent?.enabled) {
  const gravityInject = await gravityInjectStore.loadGravityInjectForChat(input.chatId);
  if (gravityInject) {
    trackerParts.push(wrapContent(gravityInject.text, "Gravity Ledger", wrapFormat));
    const injectResult = {
      agentId: gravityInjectAgent.id,
      agentType: "gravity-ledger-inject",
      type: "context_injection" as const,
      data: { text: gravityInject.text, archiveVersion: gravityInject.archiveVersion },
      tokensUsed: 0,
      durationMs: 0,
      success: true,
      error: null,
    };
    await agentsStore.saveRun({ agentConfigId: gravityInjectAgent.id, chatId: input.chatId, messageId: null, result: injectResult });
    sendAgentEvent(injectResult);
  }
}
```

Near `const gameStateStore = createGameStateStorage(app.db);`, add:
```ts
const gravityInjectStore = createInjectAgent(app.db);
```

Add import:
```ts
import { createInjectAgent } from "../services/gravity/agents/inject-agent.js";
```

- [ ] **Step 5: Edit (d) — director call after editor block at `:~6151+`**

Find the block that ends the editor section (search for the comment `// editor block` or the last `sendAgentEvent(editorResult)` before the SSE stream close). Add immediately after:

```ts
// ── Gravity Director (runs after editor — sees post-edit message text) ──────
const directorAgent = resolvedAgents.find((a) => a.type === "gravity-ledger-director");
if (directorAgent?.enabled && messageId && !abortController.signal.aborted) {
  const chatState = await db
    .select({ counter: gravityChatState.userTurnsSinceLastDirector })
    .from(gravityChatState)
    .where(eq(gravityChatState.chatId, input.chatId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const interval = (directorAgent.settings?.runInterval as number | undefined) ?? 1;
  if ((chatState?.counter ?? 0) >= interval) {
    // Read post-edit message text (editor may have rewritten it)
    const finalMessages = await chats.listMessages(input.chatId);
    const finalAsstMsg = [...finalMessages].reverse().find((m) => m.id === messageId);
    const finalText = finalAsstMsg?.swipes?.[finalAsstMsg.activeSwipeIndex ?? 0]?.text ?? "";

    // Resolve provider from directorAgent.connectionId / directorAgent.model
    const directorProvider = await resolveProviderForAgent(directorAgent, app);
    if (directorProvider) {
      const dirResult = await gravityDirectorAgent.runGravityDirector({
        chatId: input.chatId,
        messageId,
        swipeIndex: targetSwipeIndex ?? 0,
        assistantMessage: finalText,
        agentConfig: directorAgent,
        context: agentContext,
        provider: directorProvider.provider,
        model: directorProvider.model,
        signal: abortController.signal,
      });
      await agentsStore.saveRun({ agentConfigId: directorAgent.id, chatId: input.chatId, messageId, result: dirResult });
      sendAgentEvent(dirResult);
    }
  }
}
```

Add near other store initializations:
```ts
const gravityDirectorAgent = createDirectorAgent(app.db);
```

Add imports:
```ts
import { createDirectorAgent } from "../services/gravity/agents/director-agent.js";
import { gravityChatState } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
```

> **Note:** `resolveProviderForAgent` is an existing helper in generate.routes.ts (or equivalent) used by the editor/lorebook-keeper. Find how those agents resolve their provider and follow the same pattern. If the helper is named differently, adapt. The key is: read `directorAgent.connectionId` + `directorAgent.model` to get a `BaseLLMProvider` instance.

- [ ] **Step 6: Type-check after all four edits**

```bash
pnpm check
```

Expected: `0 errors`. Most likely issues: `AgentResult` shape doesn't include `agentType` — check `AgentResult` interface and adjust the return objects.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/generate.routes.ts
git commit -m "feat(gravity): wire four generate.routes.ts edits (acceptance, filter, inject, director)"
```

---

### Task 12: End-to-end verification (manual)

- [ ] **Step 1: Verify editor compatibility**

1. Enable the `editor` agent and `gravity-ledger-director` in a test chat.
2. Send a user message. The editor rewrites the assistant message.
3. Check server logs: `[gravity-director]` log line should appear **after** editor logs.
4. Confirm `dirResult.data.committed > 0` in the SSE stream or `agent_runs` table.
5. The `final_text` passed to the director should match the editor's rewritten text, not the original.

- [ ] **Step 2: Verify per-swipe staging**

1. Send one user message. Swipe three times (three assistant responses). Accept the third swipe.
2. Query the DB: `SELECT message_id, swipe_index, accepted FROM gravity_transactions WHERE chat_id = '<id>' ORDER BY seq;`
3. Expected: rows for swipe 0, 1, 2 with `accepted = 0`; rows for swipe 2 with `accepted = 1` after the next user message. Swipes 0 and 1 remain `accepted = 0`.

- [ ] **Step 3: Verify advance-mode tick**

1. Switch mode to `advance` (OOC command or direct DB update: `UPDATE gravity_chat_state SET mode='advance' WHERE chat_id='...'`).
2. Create a collision with `distance = 48` and no `distance_category = "IMMEDIATE"`.
3. Have the director emit `S world.timeskip_scale = "DAYS"` in its transaction output.
4. After the director runs, query `gravity_transactions` for engine tick rows: look for `op='S', payload LIKE '%timeskip_scale%HOURS%'` and `op='S', payload LIKE '%distance%24%'`.
5. The state cache should reflect `distance = 24` for the collision.

---

### Task 13: Export endpoint

**Files:**
- Create: `packages/server/src/routes/gravity.routes.ts`

- [ ] **Step 1: Create `gravity.routes.ts`**

```ts
import type { FastifyPluginAsync } from "fastify";
import { eq, and } from "drizzle-orm";
import { gravityTransactions, gravityStateCache, gravitySnapshots, gravityChatState } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";

export const gravityRoutes: FastifyPluginAsync = async (app) => {
  // ── Export ────────────────────────────────────────────────────────────────────
  app.get<{ Params: { chatId: string }; Querystring: { include_pending?: string } }>(
    "/api/gravity/export/:chatId",
    async (req, reply) => {
      const { chatId } = req.params;
      const includePending = req.query.include_pending === "true";

      const txWhere = includePending
        ? eq(gravityTransactions.chatId, chatId)
        : and(eq(gravityTransactions.chatId, chatId), eq(gravityTransactions.accepted, 1));

      const [transactions, stateCache, snapshots, chatState] = await Promise.all([
        app.db.select().from(gravityTransactions).where(txWhere),
        app.db.select().from(gravityStateCache).where(eq(gravityStateCache.chatId, chatId)),
        app.db.select().from(gravitySnapshots).where(eq(gravitySnapshots.chatId, chatId)),
        app.db
          .select()
          .from(gravityChatState)
          .where(eq(gravityChatState.chatId, chatId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);

      logger.info("[gravity-export] chat=%s txns=%d", chatId, transactions.length);
      return reply.send({ transactions, stateCache, snapshots, chatState });
    },
  );

  // ── Import ────────────────────────────────────────────────────────────────────
  app.post<{ Params: { chatId: string } }>(
    "/api/gravity/import/:chatId",
    async (req, reply) => {
      const { chatId } = req.params;
      const body = req.body as {
        transactions?: unknown[];
        chatState?: unknown;
      };

      if (!Array.isArray(body?.transactions)) {
        return reply.status(400).send({ error: "transactions must be an array" });
      }

      // Refuse pending rows (accepted !== 1) unless allow_pending flag set
      const toImport = (body.transactions as Array<{ accepted?: number }>).filter(
        (t) => t.accepted === 1,
      );

      await app.db.transaction(async (tx) => {
        if (toImport.length > 0) {
          await tx.insert(gravityTransactions).values(
            toImport.map((t: Record<string, unknown>) => ({
              id: t["id"] as string,
              chatId,
              messageId: (t["message_id"] ?? t["messageId"]) as string,
              swipeIndex: (t["swipe_index"] ?? t["swipeIndex"] ?? 0) as number,
              seq: t["seq"] as number,
              op: t["op"] as string,
              payload: t["payload"] as string,
              accepted: 1,
              createdAt: (t["created_at"] ?? t["createdAt"]) as number ?? Math.floor(Date.now() / 1000),
            })),
          );
        }
        if (body.chatState) {
          const cs = body.chatState as Record<string, unknown>;
          await tx
            .insert(gravityChatState)
            .values({
              chatId,
              mode: (cs["mode"] as string) ?? "regular",
              pendingCorrections: (cs["pending_corrections"] ?? cs["pendingCorrections"] as string | null) ?? null,
              acceptedMessageId: (cs["accepted_message_id"] ?? cs["acceptedMessageId"] as string | null) ?? null,
              acceptedSwipeIndex: (cs["accepted_swipe_index"] ?? cs["acceptedSwipeIndex"] as number | null) ?? null,
              nextTxSeq: (cs["next_tx_seq"] ?? cs["nextTxSeq"] as number) ?? 1,
              userTurnsSinceLastDirector: 0,
            })
            .onConflictDoUpdate({
              target: gravityChatState.chatId,
              set: {
                mode: (cs["mode"] as string) ?? "regular",
                acceptedMessageId: (cs["accepted_message_id"] ?? cs["acceptedMessageId"] as string | null) ?? null,
                acceptedSwipeIndex: (cs["accepted_swipe_index"] ?? cs["acceptedSwipeIndex"] as number | null) ?? null,
                nextTxSeq: (cs["next_tx_seq"] ?? cs["nextTxSeq"] as number) ?? 1,
              },
            });
        }
      });

      logger.info("[gravity-import] chat=%s imported %d transactions", chatId, toImport.length);
      return reply.send({ imported: toImport.length });
    },
  );
};
```

- [ ] **Step 2: Register the route plugin in the server**

Find where other route plugins are registered (e.g., `chats.routes.ts`, `generate.routes.ts` are registered in `server/src/index.ts` or `app.ts`). Add:

```ts
import { gravityRoutes } from "./routes/gravity.routes.js";
// ...
app.register(gravityRoutes);
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Expected: `0 errors`.

- [ ] **Step 4: Smoke-test export**

Start the dev server and call:
```bash
curl http://localhost:PORT/api/gravity/export/SOME_CHAT_ID
```

Expected: `{ "transactions": [], "stateCache": [], "snapshots": [], "chatState": null }` for an uninitialized chat.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/gravity.routes.ts
git commit -m "feat(gravity): export and import endpoints (/api/gravity/export and /import)"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| §1 Core premise (no pipeline exec) | Task 2, Task 11 |
| §3.1 Shared types + agent registration | Task 2 |
| §3.1.1 Config surface (enabled, connectionId, promptTemplate, runInterval) | Task 11 edit (d) |
| §3.2(a) Acceptance hook | Task 11 edit (a), Task 8 acceptance.ts |
| §3.2(b) Filter + inject | Task 11 edits (b) and (c) |
| §3.2(c) Director after editor | Task 11 edit (d) |
| §3.3 Four DB schema files | Task 3 |
| §3.4 services/gravity/ directory layout | Tasks 4–10 |
| §4 Director runtime (single SQL tx, steps 6–9) | Task 10 director-agent.ts |
| §4.1 Engine-tick (TICK table, scale token, advance-only) | Task 8 engine-tick.ts |
| §4.2 Tolerant JSON parse | Task 9 client.ts extractJson() |
| §4.3 CorrectionsPayload | Task 9 input.ts |
| §5 Inject runtime | Task 10 inject-agent.ts |
| §6 Acceptance flow | Task 8 acceptance.ts + Task 11 edit (a) |
| §6.1 Unaccepted row lifecycle | accepted=0 default in schema (Task 3); accepted-only queries in ledger-store (Task 6) |
| §8 Export endpoint (phase 1 separate route) | Task 13 |
| §11 Steps 1–6 | Tasks 1–11 |
| §11 Steps 7–9 (E2E verification) | Task 12 |
| §11 Steps 10, 13 (setup wizard, phase-2 hardening) | Deferred — needs sub-spec |
| §11 Step 12 (ST→Marinara import) | Task 13 import endpoint |

**Open implementation note (§9 coupling risk):**

The spec notes: "does `chats.getMessageActiveSwipeText(messageId)` already exist?" — Task 11 edit (d) reads the swipe text by listing messages and finding by `messageId`. If Marinara already exposes a helper for this, use it. If not, the direct approach in edit (d) is correct.

**Provider resolution in Task 11 edit (d):** Look for how `editor` resolves its provider in `generate.routes.ts` (search `resolveProviderForAgent` or `getProviderForConnection`). Use the identical pattern. The method name may differ from what's shown here.
