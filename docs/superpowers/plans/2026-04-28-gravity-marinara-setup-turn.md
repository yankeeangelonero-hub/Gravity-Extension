# Gravity Marinara Setup Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "New Game Setup" flow to Gravity-on-Marinara: a popup form in the existing `GravityLedgerDrawer` collects opening-situation, power-scale, and PC-power inputs; a new `POST /api/gravity/setup/:chatId` route runs the director once with a setup-mode prompt to seed the opening ledger; on success, the client fires a synthetic `OOC: Begin the opening scene.` user message and lets the standard generation pipeline produce the opening prose against the seeded state.

**Architecture:** Director-only seeding (two LLM cycles total: setup-director, then normal first turn). Setup transactions are anchored to a sentinel `messageId='__setup__'` and committed with `accepted=1` immediately, so the inject agent has live state on turn 1. Server side: new `setup-agent.ts` + new `setup-input.ts` + `callSetupDirector` in `director/client.ts` + new POST route in `gravity.routes.ts` + a `acceptedImmediately` flag added to `ledger-store.stageTransactions`. Client side: new `GravitySetupModal` component, new `useGravitySetup` mutation hook, button wired into `GravityLedgerDrawer`'s header.

**Tech Stack:** TypeScript, Fastify, Drizzle (SQLite), React, Zustand, TanStack Query, Tailwind. Repo is the Marinara monorepo (`Marinara Engine/Marinara-Engine/`); branch is `gravity-integration`. Validation gate: `pnpm check` from the monorepo root (TypeScript + ESLint). No automated test suite — manual smoke at phase boundaries.

**Working directory:** All paths in this plan are relative to `Marinara Engine/Marinara-Engine/`. Run `pnpm install` once at the start. Run `pnpm check` from the monorepo root after each task. Read `packages/client/.instructions.md` before editing any client code (per Marinara CLAUDE.md).

**Reference spec:** `docs/superpowers/specs/2026-04-28-gravity-marinara-setup-design.md` (in the outer Gravity-Extension repo).

---

## File Structure

**Create:**
- `packages/shared/src/types/gravity-setup.ts` — `SetupAnswers`, `SetupContext` types shared by server + client
- `packages/server/src/services/gravity/director/setup-input.ts` — `buildSetupPrompt(answers, context)` returns `{ systemPrompt, userPrompt }`
- `packages/server/src/services/gravity/agents/setup-agent.ts` — `createSetupAgent(db)` factory exposing `runGravitySetup`
- `packages/client/src/components/chat/GravitySetupModal.tsx` — modal with the seven form fields, mounted by the drawer
- `packages/client/src/hooks/use-gravity-setup.ts` — TanStack mutation that POSTs to `/api/gravity/setup/:chatId` and on success calls `useGenerate` with the synthetic message

**Modify:**
- `packages/shared/src/index.ts` — re-export gravity-setup types
- `packages/shared/src/constants/agent-prompts.ts` — add `gravity-ledger-director-setup` template
- `packages/server/src/services/gravity/director/client.ts` — export `extractJson` and `stripThinkingBlocks` (so setup-input can re-use them indirectly via `callSetupDirector`); add `callSetupDirector`
- `packages/server/src/services/gravity/engine/ledger-store.ts` — `stageTransactions` accepts optional `acceptedImmediately?: boolean` parameter (default false)
- `packages/server/src/routes/gravity.routes.ts` — add `POST /setup/:chatId` route
- `packages/client/src/components/chat/GravityLedgerDrawer.tsx` — add "New Game Setup" button in the header; mount `<GravitySetupModal/>`

**Convention reminders:**
- Server: never `console.log`, use `logger` from `../../../lib/logger.ts` (adjust depth)
- Client: `console.*` is fine; don't import server logger
- File extensions: `.ts` in server `import`s, `.tsx` for React; types in `@marinara-engine/shared` build to `.js` (use `.js` in shared-package import paths even for `.ts` source — Marinara uses NodeNext module resolution)

---

## Phase A — Server-side Foundation

**Phase A goal:** A direct `curl POST /api/gravity/setup/<chatId>` with form answers commits an opening ledger to `gravity_transactions` with `accepted=1`, seeds `gravity_state_cache` under `messageId='__setup__'`, sets `gravity_chat_state.acceptedMessageId='__setup__'`, and returns 200 with `{ committed, rejected, errors, durationMs, model }`.

### Task 1: Add the setup director prompt template

**Files:**
- Modify: `packages/shared/src/constants/agent-prompts.ts`

- [ ] **Step 1: Add the new prompt key**

In `packages/shared/src/constants/agent-prompts.ts`, locate the `DEFAULT_AGENT_PROMPTS` map and add `gravity-ledger-director-setup` immediately after the existing `gravity-ledger-director` entry:

```ts
  /* ────────────────────────────────────────── */
  "gravity-ledger-director-setup": `You are the Gravity Ledger Director running in SETUP mode. Build the complete opening ledger for a new game from the player's setup answers, the character card, and the user's persona.

OUTPUT FORMAT: respond with valid JSON only.
{
  "transactions": [...],
  "notes": "brief reasoning",
  "confidence": "high" | "medium" | "low"
}

OPERATIONS: CR (create), S (set), TR (transition), A (append), R (remove), MS (map_set), MR (map_del), D (destroy)
ENTITY TYPES: char, constraint, collision, faction, place, pressure, world, pc

You are the FIRST writer of state for this chat. There is no prior ledger. Build EVERYTHING needed for the prose model to write a strong opening scene.

EMIT ALL OF THE FOLLOWING in the transactions array:

1. PC entity (entity 'pc'):
   - S pc field=name value=<persona name>
   - 2-4 A pc field=demonstrated_traits APPEND ops extracted from the persona description
   - if PC base power was provided in the form: S pc field=power_base, S pc field=power, S pc field=power_basis, A pc field=abilities (one A per ability)

2. PRINCIPAL char (CR with tier=PRINCIPAL):
   - id slug derived from the character card name
   - S agenda (narrative compass — what they're working toward)
   - S location (place id from §6)
   - 4 MS knowledge_asymmetry entries: knows_<slug>, unknown_<slug>, hiding_<slug>, misreading_<slug>
   - if combat-capable: S power_base, S power, S power_basis, A abilities
   - 3-4 constraints (CREATE constraint:<slug> with integrity=STABLE, prevents, threshold, replacement, replacement_type, shedding_order)

3. WORLD entity (entity 'world'):
   - S world_state (one-sentence macro reality)
   - S timeskip_scale value="HOURS"
   - if power_scale provided: S power_scale
   - if power_ceiling provided: S power_ceiling
   - if power_notes provided: S power_notes

4. FACTIONS (CR + S/A/MS): at least 2 with opposing agendas. Each:
   - S agenda
   - A members (char ids)
   - A territory (place ids)
   - 4 MS knowledge_asymmetry entries

5. COLLISIONS (CR): at least 1 with status=ACTIVE. Each:
   - distance_category (IMMEDIATE / SHORT / MEDIUM / LONG)
   - forces (force1 vs force2 — narrative pressures driving this collision)
   - involved_chars (array including pc and the principal id)
   - location (place id)

6. PLACES (CR): at least 1 for the opening scene. Each:
   - reach (LOCAL / REGIONAL / GLOBAL)
   - state (safe / contested / hostile / unknown)
   - description (one or two sentences)

7. PRESSURE POINTS (CR): 2-3 seams where the world is about to break. Each:
   - source (PC / char id / faction id / place id)
   - related_to (array of collision ids; may be empty)

8. KNOWN NPCs (CR with tier=KNOWN): any scenario NPCs surfaced in the card, persona, or activated lorebook. Do NOT set individual knowledge_asymmetry on KNOWN tier — they inherit from their faction.

POWER AUTHORING RULES:
- No naked numbers. Every meaningful combat rating needs power_basis + abilities.
- power_base = earned combat level when healthy.
- power = current effective combat level.
- power = power_base unless setup establishes a wound, impairment, missing gear, or boost.

PC vs PRINCIPAL: never merge. PC is the player's persona; PRINCIPAL is the character card NPC. They are separate entities.

OUTPUT CONTRACT: a single JSON object { "transactions": [...], "notes": "...", "confidence": "..." } where each transaction matches { "op": OP, "e": ENTITY_TYPE, "id": ENTITY_ID, "d": { ...payload } }. No SNAP/ROLL/AMEND ops; those are engine-only. No prose, no markdown fences, no trailing commentary.`,

```

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS (no TypeScript or ESLint errors).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants/agent-prompts.ts
git commit -m "feat(shared): add gravity-ledger-director-setup prompt template"
```

---

### Task 2: Define shared setup types

**Files:**
- Create: `packages/shared/src/types/gravity-setup.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the types file**

Create `packages/shared/src/types/gravity-setup.ts`:

```ts
// ──────────────────────────────────────────────
// Shared types for the Gravity New-Game Setup flow
// ──────────────────────────────────────────────

/** Form answers collected by GravitySetupModal. All fields optional. */
export interface SetupAnswers {
  opening: string;
  powerScale: string;
  powerCeiling: string;
  powerNotes: string;
  pcPowerBase: string;
  pcPowerBasis: string;
  pcAbilities: string; // newline-separated lines
}

/** Snapshot of the chat's persona for the setup prompt. */
export interface SetupPersonaSnapshot {
  name: string;
  description: string;
}

/** Snapshot of the chat's principal character card for the setup prompt. */
export interface SetupCharacterSnapshot {
  name: string;
  description: string;
  scenario: string | null;
  personality: string | null;
}

/** Snapshot of activated lorebook entries (greeting-time activations). */
export interface SetupLorebookEntrySnapshot {
  name: string;
  content: string;
}

/** Pre-built context the server hands to setup-input.ts. */
export interface SetupContext {
  user: SetupPersonaSnapshot;
  principal: SetupCharacterSnapshot;
  scenario: string | null;
  activatedLorebookEntries: SetupLorebookEntrySnapshot[];
}

/** Response shape from POST /api/gravity/setup/:chatId. */
export interface SetupResult {
  success: boolean;
  committed: number;
  rejected: number;
  errors: Record<string, unknown>;
  durationMs: number;
  model: string;
}

/** The reserved sentinel messageId for the setup batch. */
export const GRAVITY_SETUP_MESSAGE_ID = "__setup__";
```

- [ ] **Step 2: Re-export from the package index**

In `packages/shared/src/index.ts`, find the existing gravity exports (search for `gravity-state`) and add directly below:

```ts
export type {
  SetupAnswers,
  SetupPersonaSnapshot,
  SetupCharacterSnapshot,
  SetupLorebookEntrySnapshot,
  SetupContext,
  SetupResult,
} from "./types/gravity-setup.js";
export { GRAVITY_SETUP_MESSAGE_ID } from "./types/gravity-setup.js";
```

- [ ] **Step 3: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/gravity-setup.ts packages/shared/src/index.ts
git commit -m "feat(shared): add gravity setup types and SETUP_MESSAGE_ID sentinel"
```

---

### Task 3: Build the setup payload renderer

**Files:**
- Create: `packages/server/src/services/gravity/director/setup-input.ts`

- [ ] **Step 1: Create the file**

Create `packages/server/src/services/gravity/director/setup-input.ts`:

```ts
/**
 * setup-input.ts — Build the user prompt sent to the setup director.
 *
 * The system prompt is the registered template (gravity-ledger-director-setup);
 * the user prompt is rendered here from the form answers and the chat context.
 */

import type { SetupAnswers, SetupContext } from "@marinara-engine/shared";
import { getDefaultAgentPrompt } from "@marinara-engine/shared";

export interface SetupPromptBundle {
  systemPrompt: string;
  userPrompt: string;
}

export function buildSetupPrompt(
  answers: SetupAnswers,
  context: SetupContext,
  promptTemplateOverride: string | undefined,
): SetupPromptBundle {
  const systemPrompt =
    promptTemplateOverride && promptTemplateOverride.trim()
      ? promptTemplateOverride
      : getDefaultAgentPrompt("gravity-ledger-director-setup");

  const filled: string[] = [];
  const blank: string[] = [];

  if (answers.opening) filled.push(`Opening situation: ${answers.opening}`);
  else blank.push("opening arc and central question (derive from scenario)");

  if (answers.powerScale) filled.push(`World power scale: ${answers.powerScale}`);
  else blank.push("world power scale (what each combat rating means in this story)");

  if (answers.powerCeiling) filled.push(`World power ceiling: ${answers.powerCeiling}`);
  else blank.push("world power ceiling");

  if (answers.powerNotes) filled.push(`World power notes: ${answers.powerNotes}`);

  if (answers.pcPowerBase) filled.push(`PC base power: ${answers.pcPowerBase}`);
  else blank.push("PC base power");

  if (answers.pcPowerBasis) filled.push(`PC power basis: ${answers.pcPowerBasis}`);
  else blank.push("why the PC deserves their combat rating");

  if (answers.pcAbilities) {
    const lines = answers.pcAbilities
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `  - ${l}`)
      .join("\n");
    if (lines) filled.push(`PC combat abilities:\n${lines}`);
  } else {
    blank.push("PC combat abilities, training, gear edges, and limitations");
  }

  const sections: string[] = [];
  if (filled.length) {
    sections.push(`PLAYER PROVIDED:\n${filled.map((f) => `  ${f}`).join("\n")}`);
  }
  if (blank.length) {
    sections.push(
      `AUTO-FILL (derive from character card, persona, scenario, and activated lorebook):\n${blank
        .map((b) => `  - ${b}`)
        .join("\n")}`,
    );
  }

  sections.push(`CHARACTER CARD (the PRINCIPAL — tier=PRINCIPAL):
  Name: ${context.principal.name}
  Description: ${context.principal.description}
  Scenario: ${context.principal.scenario ?? "(none)"}
  Personality: ${context.principal.personality ?? "(none)"}`);

  sections.push(`PERSONA (the player character — PC):
  Name: ${context.user.name}
  Description: ${context.user.description}`);

  if (context.scenario && context.scenario !== context.principal.scenario) {
    sections.push(`CHAT SCENARIO OVERRIDE:\n  ${context.scenario}`);
  }

  if (context.activatedLorebookEntries.length > 0) {
    const entries = context.activatedLorebookEntries
      .map((e) => `  [${e.name}] ${e.content}`)
      .join("\n");
    sections.push(`ACTIVATED LOREBOOK ENTRIES:\n${entries}`);
  }

  const userPrompt = sections.join("\n\n");
  return { systemPrompt, userPrompt };
}
```

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/director/setup-input.ts
git commit -m "feat(gravity): add setup-input prompt builder"
```

---

### Task 4: Add callSetupDirector to the director client

**Files:**
- Modify: `packages/server/src/services/gravity/director/client.ts`

- [ ] **Step 1: Export the JSON helpers and add callSetupDirector**

In `packages/server/src/services/gravity/director/client.ts`:

(a) Change the two `function` declarations to `export function` (so the new helper can reuse them and so future code can too):

```ts
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, "").trim();
}

export function extractJson(text: string): string {
  const stripped = stripThinkingBlocks(text);
  const fenceMatch = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) return stripped.slice(start, end + 1);
  return stripped;
}
```

(b) At the bottom of the file, add:

```ts
/**
 * Call the director in SETUP mode. Unlike `callDirector`, this does not build
 * a DirectorInput / MODE / ---PROSE--- / ---STATE--- payload — setup has none
 * of those. It takes a fully-rendered system + user prompt pair and returns
 * the same DirectorProposal shape so downstream stage/cache logic is shared.
 */
export async function callSetupDirector(
  systemPrompt: string,
  userPrompt: string,
  provider: BaseLLMProvider,
  model: string,
  signal: AbortSignal,
): Promise<DirectorProposal> {
  const t0 = Date.now();

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  logger.debug(
    "[gravity-director-setup] calling model %s (%d chars system, %d chars user)",
    model,
    systemPrompt.length,
    userPrompt.length,
  );

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
  logger.info(
    "[gravity-director-setup] raw response: %d chars, %dms model=%s",
    raw.length,
    durationMs,
    model,
  );

  let parsed: { transactions?: unknown[]; notes?: string; confidence?: string };
  try {
    parsed = JSON.parse(extractJson(raw)) as {
      transactions?: unknown[];
      notes?: string;
      confidence?: string;
    };
  } catch {
    logger.warn("[gravity-director-setup] JSON parse failed, raw=%s", raw.slice(0, 300));
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

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/director/client.ts
git commit -m "feat(gravity): add callSetupDirector and export json helpers"
```

---

### Task 5: Extend ledger-store with acceptedImmediately flag

**Files:**
- Modify: `packages/server/src/services/gravity/engine/ledger-store.ts`

- [ ] **Step 1: Add the optional flag**

In `packages/server/src/services/gravity/engine/ledger-store.ts`, change the `stageTransactions` signature and INSERT block. The chat-state upsert is unchanged.

Replace the entire `stageTransactions` method (the existing function around lines 51-95) with:

```ts
    /**
     * Allocate seq numbers and stage transactions. Must run inside an outer
     * db.transaction() call — pass the transaction object as `tx`.
     *
     * If `acceptedImmediately` is true, rows are inserted with accepted=1
     * (used by the setup-agent to seed the opening ledger before any message
     * exists). Default is false (regular director path).
     */
    async stageTransactions(
      tx: DB,
      chatId: string,
      messageId: string,
      swipeIndex: number,
      txns: RawTransaction[],
      acceptedImmediately: boolean = false,
    ): Promise<void> {
      if (txns.length === 0) return;

      const [current] = await tx
        .select({ nextTxSeq: gravityChatState.nextTxSeq })
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId));
      const startSeq = current?.nextTxSeq ?? 1;

      // Fix 1: upsert instead of bare UPDATE so a missing row is created rather
      // than silently dropped (happens on fresh chats with no gravity_chat_state row).
      await tx
        .insert(gravityChatState)
        .values({ chatId, nextTxSeq: startSeq + txns.length })
        .onConflictDoUpdate({
          target: gravityChatState.chatId,
          set: { nextTxSeq: startSeq + txns.length },
        });

      const now = new Date().toISOString();
      const acceptedFlag = acceptedImmediately ? 1 : 0;
      await tx.insert(gravityTransactions).values(
        txns.map((t, i) => {
          // Fix 3: stamp engine metadata into the payload before storage so that
          // state-compute.ts (tx.tx, last_active_tx, AMEND lookup, etc.) works
          // correctly on DB-replayed transactions.
          const stamped: RawTransaction = { ...t, tx: startSeq + i, _ts: now };
          return {
            id: crypto.randomUUID(),
            chatId,
            messageId,
            swipeIndex,
            seq: startSeq + i,
            op: stamped.op,
            payload: JSON.stringify(stamped),
            accepted: acceptedFlag,
          };
        }),
      );
    },
```

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS. Existing callers (director-agent.ts) continue to work because the new parameter has a default.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/engine/ledger-store.ts
git commit -m "feat(gravity): add acceptedImmediately flag to stageTransactions"
```

---

### Task 6: Build the setup-agent

**Files:**
- Create: `packages/server/src/services/gravity/agents/setup-agent.ts`

- [ ] **Step 1: Create the file**

Create `packages/server/src/services/gravity/agents/setup-agent.ts`:

```ts
/**
 * setup-agent.ts — Gravity new-game setup orchestrator.
 *
 * Runs once per chat (refused if the chat already has accepted state). Calls
 * the setup director with the form answers + character card + persona, validates
 * the proposed transactions, stages them with accepted=1 under the sentinel
 * messageId='__setup__', renders the state cache, and writes the chat-state row
 * with the acceptance pointer. All DB writes happen in a single SQL transaction.
 */

import { eq } from "drizzle-orm";
import type { DB } from "../../../db/connection.ts";
import { gravityChatState } from "../../../db/schema/index.ts";
import { createLedgerStore } from "../engine/ledger-store.ts";
import { createStateCacheStore } from "../engine/state-cache.ts";
import { validateFormat, validateTransitions } from "../engine/consistency.ts";
import { computeState } from "../engine/state-compute.ts";
import { engineTick } from "../engine/engine-tick.ts";
import { callSetupDirector } from "../director/client.ts";
import { buildSetupPrompt } from "../director/setup-input.ts";
import type { RawTransaction } from "../engine/types.ts";
import type { BaseLLMProvider } from "../../llm/base-provider.ts";
import type { SetupAnswers, SetupContext, SetupResult } from "@marinara-engine/shared";
import { GRAVITY_SETUP_MESSAGE_ID } from "@marinara-engine/shared";
import { logger } from "../../../lib/logger.ts";

export interface RunGravitySetupInput {
  chatId: string;
  answers: SetupAnswers;
  setupContext: SetupContext;
  provider: BaseLLMProvider;
  model: string;
  promptTemplateOverride: string | undefined;
  signal: AbortSignal;
}

export interface RunGravitySetupOutcome {
  status: "ok" | "already-initialized" | "rejected-all" | "llm-failed";
  result?: SetupResult;
  message?: string;
}

export function createSetupAgent(db: DB) {
  const ledgerStore = createLedgerStore(db);
  const stateCacheStore = createStateCacheStore(db);

  return {
    async runGravitySetup(input: RunGravitySetupInput): Promise<RunGravitySetupOutcome> {
      const t0 = Date.now();
      const { chatId, answers, setupContext, provider, model, promptTemplateOverride, signal } = input;

      // ── 1. Guard: chat already initialized? ─────────────────────────────────
      const [existing] = await db
        .select()
        .from(gravityChatState)
        .where(eq(gravityChatState.chatId, chatId))
        .limit(1);
      if (existing?.acceptedMessageId) {
        return {
          status: "already-initialized",
          message: "This chat already has a Gravity ledger.",
        };
      }

      // ── 2. Build the setup prompt ───────────────────────────────────────────
      const { systemPrompt, userPrompt } = buildSetupPrompt(answers, setupContext, promptTemplateOverride);

      // ── 3. Call the setup director ──────────────────────────────────────────
      let proposal;
      try {
        proposal = await callSetupDirector(systemPrompt, userPrompt, provider, model, signal);
      } catch (err) {
        logger.error(err, "[gravity-setup] LLM call failed for chat %s", chatId);
        return { status: "llm-failed", message: err instanceof Error ? err.message : "LLM call failed" };
      }

      if (proposal.transactions.length === 0) {
        return { status: "rejected-all", message: "Setup director returned no transactions." };
      }

      // ── 4-7. Validate, stage (accepted=1), engine-tick, state-cache, chat-state ─
      let committed = 0;
      let rejected = 0;
      const allErrors: Record<string, unknown> = {};

      try {
        await db.transaction(async (tx) => {
          const txDb = tx as unknown as DB;

          // 4a. Format validation
          const formatValid: RawTransaction[] = [];
          for (let i = 0; i < proposal.transactions.length; i++) {
            const errs = validateFormat(proposal.transactions[i] as unknown, i);
            if (errs.length === 0) {
              formatValid.push(proposal.transactions[i] as RawTransaction);
            } else {
              allErrors[String(i)] = errs;
              rejected++;
            }
          }

          // 4b. State-machine transition validation against an empty state
          const currentState = computeState(null, []);
          const { valid: validAfterTransitions, errors: transitionErrors } =
            validateTransitions(formatValid, currentState);
          for (const e of transitionErrors) {
            allErrors[String(e.lineNum)] = e;
          }
          rejected += formatValid.length - validAfterTransitions.length;

          if (validAfterTransitions.length === 0) {
            throw new Error("ALL_REJECTED");
          }

          // 4c. Pre-create the chat-state row so stageTransactions sees a real
          // nextTxSeq starting at 1.
          await txDb
            .insert(gravityChatState)
            .values({ chatId, mode: "regular", nextTxSeq: 1 })
            .onConflictDoNothing();

          // 4d. Stage with accepted=1 under the sentinel
          await ledgerStore.stageTransactions(
            txDb,
            chatId,
            GRAVITY_SETUP_MESSAGE_ID,
            0,
            validAfterTransitions,
            true, // acceptedImmediately
          );
          committed = validAfterTransitions.length;

          // 5. Engine tick (mode=regular → no advance ticks; scale-reset is harmless)
          const stagedState = computeState(null, validAfterTransitions);
          const tickResult = engineTick(stagedState, "regular");
          if (tickResult.tickTxns.length > 0) {
            await ledgerStore.stageTransactions(
              txDb,
              chatId,
              GRAVITY_SETUP_MESSAGE_ID,
              0,
              tickResult.tickTxns,
              true,
            );
            committed += tickResult.tickTxns.length;
          }

          // 6. State cache for the sentinel swipe
          const allStaged = [...validAfterTransitions, ...tickResult.tickTxns];
          const finalState = computeState(null, allStaged);
          await stateCacheStore.upsertForSwipe(
            txDb,
            chatId,
            GRAVITY_SETUP_MESSAGE_ID,
            0,
            finalState,
            allStaged,
            "regular",
          );

          // 7. Chat-state acceptance pointer
          await txDb
            .update(gravityChatState)
            .set({
              mode: "regular",
              acceptedMessageId: GRAVITY_SETUP_MESSAGE_ID,
              acceptedSwipeIndex: 0,
              userTurnsSinceLastDirector: 0,
            })
            .where(eq(gravityChatState.chatId, chatId));
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ALL_REJECTED") {
          return {
            status: "rejected-all",
            message: "Setup director's transactions all failed validation.",
          };
        }
        logger.error(err, "[gravity-setup] DB transaction failed for chat %s", chatId);
        return { status: "llm-failed", message: "Setup commit failed" };
      }

      const durationMs = Date.now() - t0;
      logger.info(
        "[gravity-setup] chat=%s committed=%d rejected=%d model=%s dur=%dms",
        chatId,
        committed,
        rejected,
        model,
        durationMs,
      );

      return {
        status: "ok",
        result: {
          success: true,
          committed,
          rejected,
          errors: allErrors,
          durationMs,
          model,
        },
      };
    },
  };
}
```

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/gravity/agents/setup-agent.ts
git commit -m "feat(gravity): add setup-agent for new-game director seeding"
```

---

### Task 7: Add the POST /setup/:chatId route

**Files:**
- Modify: `packages/server/src/routes/gravity.routes.ts`

This task wires the setup-agent into the HTTP layer with full provider resolution mirroring the pattern at `generate.routes.ts:2207-2256`.

- [ ] **Step 1: Add the new imports at the top of gravity.routes.ts**

In `packages/server/src/routes/gravity.routes.ts`, after the existing imports near the top, add:

```ts
import { createSetupAgent } from "../services/gravity/agents/setup-agent.js";
import { createCharactersStorage } from "../services/storage/characters.storage.js";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createAgentsStorage } from "../services/storage/agents.storage.js";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { createLLMProvider, resolveBaseUrl } from "../services/llm/provider-registry.js";
import type { SetupAnswers, SetupContext, SetupResult } from "@marinara-engine/shared";
```

(Verify each import path resolves — if any name differs, adjust to match the actual export. For example, `connections.storage.ts` may export `createConnectionsStorage` or a different name; use what's there.)

- [ ] **Step 2: Add a per-chat in-memory lock map**

Above the `gravityRoutes` function declaration in `gravity.routes.ts`, add:

```ts
/** Per-chatId locks to prevent concurrent POST /setup/:chatId for the same chat. */
const setupLocks = new Map<string, Promise<unknown>>();
```

- [ ] **Step 3: Add the route inside gravityRoutes**

Inside the `gravityRoutes` function, immediately after the existing `POST /init/:chatId` handler (after its closing `);`), add the new handler:

```ts
  // ── POST /setup/:chatId ─────────────────────────────────────────────────
  // Runs the gravity-ledger-director once in setup mode to seed the opening
  // ledger from the player's setup-form answers + character card + persona.
  // Idempotent guard: refuses if gravity_chat_state.acceptedMessageId is set.
  app.post<{
    Params: { chatId: string };
    Body: { answers: SetupAnswers };
  }>("/setup/:chatId", async (req, reply) => {
    const { chatId } = req.params;
    const answers = req.body?.answers;

    if (!answers || typeof answers !== "object") {
      return reply.status(400).send({ error: "Missing answers payload" });
    }

    // Lock — single concurrent setup per chat
    if (setupLocks.has(chatId)) {
      return reply.status(409).send({ error: "Setup already running for this chat" });
    }

    const work = (async () => {
      const chats = createChatsStorage(app.db);
      const characters = createCharactersStorage(app.db);
      const agents = createAgentsStorage(app.db);
      const connections = createConnectionsStorage(app.db);

      // ── Resolve chat + character card + persona ─────────────────────────
      const chat = await chats.getById(chatId);
      if (!chat) {
        return reply.status(404).send({ error: "Chat not found" });
      }

      // Principal character: chat is keyed by characterId in current Marinara schema
      const principal = await characters.getById(chat.characterId);
      if (!principal) {
        return reply.status(400).send({ error: "Chat has no character card" });
      }

      // Persona: read the chat's personaId, fall back to the active default persona
      let persona = chat.personaId ? await characters.getPersona(chat.personaId) : null;
      if (!persona) {
        const all = await characters.listPersonas();
        persona =
          all.find((p) => String((p as { isActive?: unknown }).isActive) === "true") ??
          all[0] ??
          null;
      }
      if (!persona) {
        return reply.status(400).send({ error: "No persona configured for this chat" });
      }

      const setupContext: SetupContext = {
        user: {
          name: persona.name,
          description: persona.description ?? "",
        },
        principal: {
          name: principal.name,
          description: principal.description ?? "",
          scenario: principal.scenario ?? null,
          personality: principal.personality ?? null,
        },
        scenario: chat.scenario ?? principal.scenario ?? null,
        // Phase 1: skip lorebook activation (deterministic minimal context).
        // The director can still derive context from the card; lorebook
        // greeting-time activation can be added in a follow-up.
        activatedLorebookEntries: [],
      };

      // ── Resolve director config (provider/model/promptTemplate) ─────────
      const allAgents = await agents.list();
      const directorCfg = allAgents.find((a) => a.type === "gravity-ledger-director");
      if (!directorCfg) {
        return reply
          .status(400)
          .send({ error: "Gravity director agent is not configured for this chat" });
      }

      // Connection: per-agent connectionId → default-for-agents → chat connection
      let connId = directorCfg.connectionId ?? null;
      if (!connId) {
        const def = await connections.getDefaultForAgents();
        connId = def?.id ?? null;
      }
      if (!connId) {
        connId = chat.connectionId ?? null;
      }
      if (!connId) {
        return reply.status(400).send({ error: "No LLM connection resolvable for the director" });
      }

      const conn = await connections.getWithKey(connId);
      const baseUrl = conn ? resolveBaseUrl(conn) : null;
      if (!conn || !baseUrl) {
        return reply.status(400).send({ error: "Resolved connection is not usable" });
      }

      const provider = createLLMProvider(
        conn.provider,
        baseUrl,
        conn.apiKey,
        conn.maxContext,
        conn.openrouterProvider,
        conn.maxTokensOverride,
      );
      const model = conn.model;

      // ── Run the setup-agent ─────────────────────────────────────────────
      const agent = createSetupAgent(app.db);
      const abortController = new AbortController();
      req.raw.on("close", () => abortController.abort());

      const outcome = await agent.runGravitySetup({
        chatId,
        answers,
        setupContext,
        provider,
        model,
        promptTemplateOverride: directorCfg.promptTemplate || undefined,
        signal: abortController.signal,
      });

      switch (outcome.status) {
        case "already-initialized":
          return reply.status(409).send({ error: outcome.message });
        case "rejected-all":
          return reply.status(422).send({ error: outcome.message });
        case "llm-failed":
          return reply.status(502).send({ error: outcome.message });
        case "ok":
          return reply.send(outcome.result satisfies SetupResult);
      }
    })();

    setupLocks.set(chatId, work);
    try {
      return await work;
    } finally {
      setupLocks.delete(chatId);
    }
  });
```

- [ ] **Step 4: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

If a storage helper has a different name than what's imported (e.g., `createConnectionsStorage` may not exist), the type checker will surface it. Open the relevant `*.storage.ts` file, find the actual exported factory, and update the import.

- [ ] **Step 5: Manual server smoke test**

Start the dev server (Marinara's normal `pnpm dev` from the monorepo root). With a chat that has Gravity director configured but no accepted state, run:

```bash
curl -X POST http://localhost:<port>/api/gravity/setup/<chatId> \
  -H 'Content-Type: application/json' \
  -d '{"answers":{"opening":"Escape the city before the cult finds us","powerScale":"1=trained but ordinary, 5=setting-defining","powerCeiling":"5","powerNotes":"Firearms dominate open ground","pcPowerBase":"3","pcPowerBasis":"Master swordsman","pcAbilities":"Counter timing\nFast draw"}}'
```

Expected response: 200 with `{ "success": true, "committed": <N>, "rejected": <M>, ... }` where N is roughly 20-40.

Verify in `pnpm db:studio`:
- `gravity_transactions` has rows for that chat with `accepted=1` and `message_id='__setup__'`.
- `gravity_state_cache` has a row for `(chatId, '__setup__', 0)`.
- `gravity_chat_state` has `acceptedMessageId='__setup__'`, `acceptedSwipeIndex=0`, `userTurnsSinceLastDirector=0`.

Re-run the same `curl` — expected: 409 `{"error":"This chat already has a Gravity ledger."}`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/gravity.routes.ts
git commit -m "feat(gravity): add POST /setup/:chatId route with director provider resolution"
```

---

## Phase A Validation Checkpoint

Before starting Phase B:

- [ ] `pnpm check` passes from monorepo root.
- [ ] `curl POST /api/gravity/setup/<chatId>` smoke test (Task 7 Step 5) succeeds on a fresh chat.
- [ ] Re-running the curl returns 409.
- [ ] `gravity_transactions`, `gravity_state_cache`, `gravity_chat_state` rows match expected shape.
- [ ] All Phase A commits made.

---

## Phase B — Client-side Setup Modal

**Phase B goal:** A "New Game Setup" button in the `GravityLedgerDrawer` header opens a modal with the seven form fields. Submitting calls `POST /api/gravity/setup/:chatId` and on success automatically generates the opening scene by calling `useGenerate` with the synthetic message `"OOC: Begin the opening scene."`. Failure surfaces a clear inline error.

### Task 8: Add useGravitySetup mutation hook

**Files:**
- Create: `packages/client/src/hooks/use-gravity-setup.ts`

- [ ] **Step 1: Create the hook**

Create `packages/client/src/hooks/use-gravity-setup.ts`:

```ts
// ──────────────────────────────────────────────
// useGravitySetup — POST /api/gravity/setup/:chatId then trigger opening scene
// ──────────────────────────────────────────────
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SetupAnswers, SetupResult } from "@marinara-engine/shared";
import { api, ApiError } from "../lib/api-client";
import { useGenerate } from "./use-generate";
import { useChats } from "./use-chats";

interface UseGravitySetupOptions {
  chatId: string;
  connectionId: string | null;
  onSuccessAfterGenerate?: () => void;
}

export function useGravitySetup({
  chatId,
  connectionId,
  onSuccessAfterGenerate,
}: UseGravitySetupOptions) {
  const qc = useQueryClient();
  const generate = useGenerate();
  // useChats is referenced so the user list is warm before generation;
  // remove if not needed in your build.
  void useChats;

  return useMutation({
    mutationFn: async (answers: SetupAnswers): Promise<SetupResult> => {
      return api.post<SetupResult>(`/gravity/setup/${chatId}`, { answers });
    },
    onSuccess: async (result) => {
      // Invalidate the gravity state query so the drawer re-renders with seeded state
      await qc.invalidateQueries({ queryKey: ["gravity", "state", chatId] });

      // Fire the synthetic opening turn through the standard generate hook.
      // useGenerate creates the user message and runs the full pipeline
      // (inject sees seeded state, prose model writes the opening scene,
      // editor + post-processing director run as normal).
      const generated = await generate({
        chatId,
        connectionId,
        userMessage: "OOC: Begin the opening scene.",
      });

      console.log("[gravity-setup] commit complete:", result, "generated:", generated);
      onSuccessAfterGenerate?.();
    },
    onError: (err) => {
      console.error("[gravity-setup] failed:", err);
    },
  });
}

/** Discriminate ApiError so the modal can branch on HTTP status. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
```

- [ ] **Step 2: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/use-gravity-setup.ts
git commit -m "feat(client): add useGravitySetup mutation hook"
```

---

### Task 9: Build GravitySetupModal

**Files:**
- Create: `packages/client/src/components/chat/GravitySetupModal.tsx`

- [ ] **Step 1: Create the modal**

Create `packages/client/src/components/chat/GravitySetupModal.tsx`:

```tsx
// ──────────────────────────────────────────────
// GravitySetupModal — popup form for new-game setup.
// Mirrors ST/setup-wizard.js's seven fields. All fields optional.
// ──────────────────────────────────────────────
import { useState } from "react";
import { X } from "lucide-react";
import type { SetupAnswers } from "@marinara-engine/shared";
import { useGravitySetup, isApiError } from "../../hooks/use-gravity-setup";

interface GravitySetupModalProps {
  chatId: string;
  connectionId: string | null;
  open: boolean;
  onClose: () => void;
}

const EMPTY: SetupAnswers = {
  opening: "",
  powerScale: "",
  powerCeiling: "",
  powerNotes: "",
  pcPowerBase: "",
  pcPowerBasis: "",
  pcAbilities: "",
};

export function GravitySetupModal({ chatId, connectionId, open, onClose }: GravitySetupModalProps) {
  const [answers, setAnswers] = useState<SetupAnswers>(EMPTY);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const setup = useGravitySetup({
    chatId,
    connectionId,
    onSuccessAfterGenerate: () => {
      setAnswers(EMPTY);
      setErrorMessage(null);
      onClose();
    },
  });

  if (!open) return null;

  const update = (key: keyof SetupAnswers) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setAnswers((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async () => {
    setErrorMessage(null);
    try {
      await setup.mutateAsync(answers);
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 409) {
          setErrorMessage(
            "This chat already has a Gravity ledger. Start a new chat to run setup again.",
          );
        } else if (err.status === 422) {
          setErrorMessage("The director's setup output failed validation. Try again.");
        } else if (err.status === 502) {
          setErrorMessage("The director's LLM call failed. Check connection and try again.");
        } else {
          setErrorMessage(`Setup failed: ${err.message}`);
        }
      } else {
        setErrorMessage("Setup failed. See console for details.");
      }
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gravity-setup-title"
        className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 id="gravity-setup-title" className="text-lg font-semibold text-zinc-100">
              New Game Setup
            </h3>
            <p className="mt-1 text-xs text-zinc-400">
              Set the opening story direction and combat power doctrine. Leave anything blank for the
              director to derive from the character card and persona.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={setup.isPending}
            className="text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Opening Situation" hint="What's the story about?">
            <input
              type="text"
              className="gl-input"
              placeholder="e.g. Escape the city before the faction finds us"
              value={answers.opening}
              onChange={update("opening")}
            />
          </Field>

          <Field label="Power Scale" hint="What each combat rating means in this setting">
            <textarea
              rows={3}
              className="gl-input"
              placeholder="e.g. 1=trained but ordinary, 3=elite specialist, 5=setting-defining monster"
              value={answers.powerScale}
              onChange={update("powerScale")}
            />
          </Field>

          <Field label="Power Ceiling" hint="Highest credible direct-combat level here">
            <input
              type="number"
              className="gl-input w-24"
              placeholder="5"
              min={1}
              value={answers.powerCeiling}
              onChange={update("powerCeiling")}
            />
          </Field>

          <Field label="Power Notes" hint="Caveats like range dominance, armor, magic cost">
            <textarea
              rows={2}
              className="gl-input"
              placeholder="e.g. Firearms dominate open ground. Magic is rare and needs setup."
              value={answers.powerNotes}
              onChange={update("powerNotes")}
            />
          </Field>

          <Field label="PC Base Power" hint="Earned combat rating when healthy">
            <input
              type="number"
              className="gl-input w-24"
              placeholder="3"
              min={0}
              value={answers.pcPowerBase}
              onChange={update("pcPowerBase")}
            />
          </Field>

          <Field label="PC Power Basis" hint="Why does the PC deserve that rating?">
            <textarea
              rows={3}
              className="gl-input"
              placeholder="e.g. Master swordsman with disciplined footwork and strong close-range timing."
              value={answers.pcPowerBasis}
              onChange={update("pcPowerBasis")}
            />
          </Field>

          <Field label="PC Combat Abilities" hint="One per line: training, gear edge, ability, limitation">
            <textarea
              rows={4}
              className="gl-input"
              placeholder={"Master swordsmanship\nFast draw and counter timing\nWeak against multiple shooters in open ground"}
              value={answers.pcAbilities}
              onChange={update("pcAbilities")}
            />
          </Field>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {errorMessage}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={setup.isPending}
            className="rounded border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={setup.isPending}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {setup.isPending ? "Generating opening…" : "Start Game"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-zinc-200">
        {label} <span className="ml-2 text-xs font-normal text-zinc-500">{hint}</span>
      </label>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Add the gl-input utility class (if not present)**

Search for an existing `gl-input` Tailwind class in the codebase; if not present, add this snippet to the same file's top of return tree using inline classes, or extend the component's Tailwind by replacing each `className="gl-input"` instance with:

```tsx
className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
```

(use `replace_all` in your editor; preserve the `w-24` modifier on number inputs by appending it after the base class).

- [ ] **Step 3: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/GravitySetupModal.tsx
git commit -m "feat(client): add GravitySetupModal with seven setup fields"
```

---

### Task 10: Wire button + modal into GravityLedgerDrawer

**Files:**
- Modify: `packages/client/src/components/chat/GravityLedgerDrawer.tsx`

- [ ] **Step 1: Add button + modal state**

In `packages/client/src/components/chat/GravityLedgerDrawer.tsx`:

(a) Add the import near the other imports at the top of the file:

```tsx
import { GravitySetupModal } from "./GravitySetupModal";
import { Sparkles } from "lucide-react";
```

(Add `Sparkles` to the existing `lucide-react` import block instead of duplicating it.)

(b) The drawer currently receives `chatId` and an `onClose` prop. The setup modal needs `connectionId`. Find the parent that renders `<GravityLedgerDrawer ... />` (it lifts the `gravityDrawerOpen` state — see the panel-UI plan) and add `connectionId` to the props passed in. In `GravityLedgerDrawer.tsx`, extend the props interface:

```tsx
interface GravityLedgerDrawerProps {
  chatId: string;
  connectionId: string | null;
  open: boolean;
  onClose: () => void;
}
```

And destructure it in the component:

```tsx
export function GravityLedgerDrawer({ chatId, connectionId, open, onClose }: GravityLedgerDrawerProps) {
```

(c) Add modal-open state inside the component, near the existing `useState<Tab>("state")` line:

```tsx
const [setupOpen, setSetupOpen] = useState(false);
```

(d) In the drawer header (find the JSX block that contains the existing `Download` / `Network` icons), add a "New Game Setup" button. Place it on the left side of the header action group, before the existing icons:

```tsx
<button
  onClick={() => setSetupOpen(true)}
  className="flex items-center gap-1 rounded border border-emerald-700 bg-emerald-900/30 px-2 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-800/40"
  aria-label="New Game Setup"
>
  <Sparkles size={14} />
  New Game Setup
</button>
```

(e) At the very bottom of the drawer's return — directly before the closing `</>` (or `</div>` if the drawer is wrapped) — mount the modal:

```tsx
<GravitySetupModal
  chatId={chatId}
  connectionId={connectionId}
  open={setupOpen}
  onClose={() => setSetupOpen(false)}
/>
```

- [ ] **Step 2: Update parent that renders the drawer**

Find the file the panel-UI plan modified to mount `<GravityLedgerDrawer/>` (`packages/client/src/components/chat/ChatCommonOverlays.tsx` per that plan). Pass `connectionId` through. Locate the `<GravityLedgerDrawer ...` usage and add the `connectionId` prop, sourcing it from whatever the existing chat-area uses (look for a `connectionId` already in scope from the active chat or chat preset).

If the parent doesn't have `connectionId` in scope, source it the same way `useGenerate` callers do — for example, via `useChat(activeChatId)?.connectionId` or via the existing chat preset state. Pick whichever pattern the file already uses for connection-id flow.

- [ ] **Step 3: Run pnpm check**

Run from monorepo root: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/GravityLedgerDrawer.tsx packages/client/src/components/chat/ChatCommonOverlays.tsx
git commit -m "feat(client): wire New Game Setup button + modal into Gravity drawer"
```

(Adjust the `git add` line if the parent file you modified is different from `ChatCommonOverlays.tsx`.)

---

## Phase B Validation Checkpoint

- [ ] `pnpm check` passes from monorepo root.
- [ ] All Phase B commits made.

---

## Phase C — End-to-end smoke

### Task 11: Manual end-to-end test

- [ ] **Step 1: Start the dev server**

From monorepo root: `pnpm dev`. Open Marinara in the browser.

- [ ] **Step 2: Set up a fresh test chat**

Create a new chat with a character card that has a meaningful description, set a persona with a meaningful description, and add the gravity-ledger-director agent to the chat (configured with a working LLM connection).

- [ ] **Step 3: Run setup flow**

Open the Gravity drawer. Click "New Game Setup". Fill in all seven fields with concrete answers (e.g., opening = "Escape the city before the cult finds us"). Click "Start Game".

Expected:
- Button label switches to "Generating opening…"
- After a few seconds, modal closes
- The chat shows a user message "OOC: Begin the opening scene." followed by an assistant message containing the opening scene
- The drawer's State tab now shows: PC, the principal, ≥2 factions, ≥1 ACTIVE collision, ≥1 place, 2-3 pressure points
- The drawer's Turns tab shows the post-processing director's run from turn 1 (the assistant's opening scene)

- [ ] **Step 4: Re-setup blocked**

Click "New Game Setup" on the same chat. Submit again. Expected: error toast / inline message: "This chat already has a Gravity ledger. Start a new chat to run setup again."

- [ ] **Step 5: Blank-fields path**

Create a second fresh chat. Open Gravity drawer → "New Game Setup". Submit with all fields blank. Expected: setup still succeeds; the director derives everything from the character card + persona. State tab shows similar coverage to step 3.

- [ ] **Step 6: LLM-misconfigured path**

Create a third fresh chat with the gravity-ledger-director agent set to a connection with an invalid API key. Click "New Game Setup". Submit. Expected: modal shows red error "The director's LLM call failed. Check connection and try again." Form values preserved; modal stays open. After fixing the connection, re-submit — succeeds.

- [ ] **Step 7: Verify per-swipe staging continues to work**

In the chat from step 3, swipe the assistant's opening message. Wait for the regenerated swipe to complete. The drawer's State tab should reflect the new swipe's state.

- [ ] **Step 8: Verify acceptance moves the pointer past the sentinel**

Send a regular user message ("Look around the room"). After the assistant responds and the next user turn fires, check `gravity_chat_state` in `pnpm db:studio`:
- `acceptedMessageId` is now the assistant message id of the opening scene (NOT `__setup__`)
- `acceptedSwipeIndex` matches the chosen swipe
- `userTurnsSinceLastDirector` >= 1

The sentinel rows in `gravity_transactions` remain `accepted=1` and continue to contribute to state replay.

---

## Self-Review

Run this checklist against the completed plan:

**Spec coverage:**
- §1 player flow — covered by Tasks 7 (server flow) + 9 (modal) + 10 (wiring) + 11 step 3 (smoke)
- §2 architecture choice — encoded in Task 6 (director-only seeding, accepted=1 immediately)
- §3 sequence diagram — implemented in Task 6's single-SQL-transaction body
- §4.1 new files — Tasks 2, 3, 6, 9, 8 (in that file order)
- §4.2 modified files — Tasks 1, 4, 5, 7, 10
- §4.3 server-side context assembly — Task 7 step 3 inline in the route
- §4.4 client-side programmatic send — Task 8 (uses `useGenerate({ userMessage })` directly; no separate `useCreateMessage`)
- §4.5 files NOT modified — implicit (we never touch `generate.routes.ts`, `agent-executor.ts`, or schema files)
- §5 setup director system prompt — Task 1 (full prompt body included)
- §6 failure handling — Task 7 status mapping + Task 9 ApiError branch
- §6.1 acceptance hook post-setup — no code change required (verified during exploration); covered by Task 11 step 8 manual verification
- §7 concurrency — Task 7 `setupLocks` map
- §8 setup-mode flag deferred — explicitly not implemented; mode='regular' set in Task 6
- §9 testing — Task 11 manual smoke
- §10 migration sequence — this plan's task order matches

**Placeholder scan:** No "TBD" / "TODO" / "fill in" left.

**Type consistency:** `SetupAnswers`, `SetupContext`, `SetupResult` defined in Task 2, used identically in Tasks 3, 6, 7, 8, 9. `GRAVITY_SETUP_MESSAGE_ID` constant defined in Task 2, referenced in Task 6.

**Known unknowns flagged for the implementer:**
- Task 7 Step 1: confirm `createConnectionsStorage` and `resolveBaseUrl` import paths (the names in this plan match patterns observed in `generate.routes.ts:2207-2256` and `services/llm/provider-registry.js`, but check both exports exist before pushing).
- Task 9 Step 2: the `gl-input` Tailwind class may not exist; substitute the inline class string given.
- Task 10 Step 2: the parent component that mounts the drawer needs `connectionId` in scope; the panel-UI plan put this in `ChatCommonOverlays.tsx`, but the actual current location may differ — check before editing.
