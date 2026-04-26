# Gravity Director Handoff

Updated: 2026-04-25

This handoff captures the recommended next architecture step for Gravity:

- keep the current SillyTavern extension and ledger engine
- stop relying on the prose model to emit canonical `---LEDGER---` / `---STATE---` blocks
- introduce a separate **director model** that owns ledger interpretation only
- keep final commit authority in deterministic extension code

This is a design handoff, not an implementation spec. The goal is to give the next spec pass a clear recommendation, clean terminology, and concrete integration points.

## Executive Summary

The right next experiment is **not** "port Gravity to Marinara first" and **not** "use a generic sidecar tracker model."

The right next experiment is:

1. keep Gravity's existing ledger, validation, replay, rollback, and UI in the current SillyTavern extension
2. replace the current block-extraction step with a separate API call to a focused **director model**
3. have that director return strict structured transactions
4. feed those transactions through the existing deterministic validation and commit pipeline

This is the fastest way to prove the real idea:

> one narrow model owns structural ledger judgment, while deterministic code remains the source of truth

If this works in play, the architecture can later be migrated into Marinara or another host without rethinking the core model.

## Problem Statement

Gravity's current core weakness is not the ledger engine itself. It is the way ledger updates enter the engine.

Today, the prose model is responsible for two jobs at once:

- write the visible narrative response
- emit valid structural state updates inside `---LEDGER---` or `---STATE---` blocks

That creates predictable failure modes:

- malformed fences or parser drift
- omitted updates
- structurally invalid operations
- state-machine mistakes
- cleanup/maintenance errors caused by the prose model juggling too many concerns

The existing extension already has strong deterministic logic after extraction:

- block extraction in [regex-intercept.js](../regex-intercept.js)
- transaction validation in [consistency.js](../consistency.js)
- replay in [state-compute.js](../state-compute.js)
- snapshots and rollback in [snapshot-mgr.js](../snapshot-mgr.js)
- commit orchestration in [index.js](../index.js)

The architectural opportunity is to swap out the **state interpretation layer**, not the whole engine.

## Core Recommendation

Introduce a separate **Gravity Director** model with one narrow responsibility:

> Given the latest accepted turn and the current ledger-derived state, decide what ledger operations should commit.

The director does **not** write prose.

The prose model does **not** own the ledger.

The extension remains the final gatekeeper.

### Ownership Split

**Main prose model**

- writes the visible assistant response
- focuses only on scene quality, character voice, pacing, and story beat execution
- does not need to emit canonical ledger syntax

**Gravity Director model**

- reads current structural context plus the new turn
- proposes transaction objects only
- focuses on collisions, constraints, relationships, state-machine transitions, and other ledger-relevant deltas
- may produce "no-op" / empty transaction sets when nothing structural changed

**Deterministic extension code**

- validates every proposed transaction
- rejects illegal transitions or bad shapes
- applies replay and rollback exactly as today
- remains the only component allowed to commit canonical ledger state

## Why "Director" Is Better Than "Sidecar"

"Sidecar" is mostly a hosting/deployment idea. It usually implies a helper model that extracts surface state.

That is not Gravity's hardest problem.

Gravity's hardest problem is editorial:

- what should become a collision
- what should merely remain prose
- when a constraint really strains or breaks
- when a relationship shift is earned
- when a character/faction update is structurally meaningful
- when the model is trying to write around an existing ledger obligation

That is closer to a **director** or **state operator** than a generic tracker.

A tracker asks:

> What happened in the scene?

A director asks:

> What should the world model commit because of what happened in the scene?

Gravity needs the second one.

## Why Prototype In The Current SillyTavern Extension First

This architecture can absolutely be prototyped in the current extension.

That is the recommended first implementation phase because the extension already provides:

- append-only canonical storage in `chatMetadata`
- transaction normalization and append in [ledger-store.js](../ledger-store.js)
- post-response commit orchestration in [index.js](../index.js)
- deterministic validation in [consistency.js](../consistency.js)
- replay logic in [state-compute.js](../state-compute.js)
- snapshots and rollback in [snapshot-mgr.js](../snapshot-mgr.js)
- a working operator UI in [ui-panel.js](../ui-panel.js)

The key seam already exists in [index.js](../index.js):

1. the extension receives the assistant message in `onMessageReceived()`
2. it currently extracts `---STATE---` / `---LEDGER---` via `extractUpdateBlock()`
3. it validates and commits the resulting transactions

The prototype only needs to replace step 2.

### Current Commit Seam

Today:

`assistant message -> extractUpdateBlock() -> validate -> append -> replay`

Proposed:

`assistant message -> call director -> receive structured txs -> validate -> append -> replay`

This lets Gravity test the new architecture without rewriting storage, replay, rollback, or UI.

## Recommended Prototype Shape

### Integration Point

Replace or augment the current extraction step inside [index.js](../index.js) `onMessageReceived()`.

Current relevant flow:

- read the accepted assistant message
- call `extractUpdateBlock()`
- compile state entries if needed
- run validation
- append valid transactions
- run post-commit audits and UI refresh

Prototype flow:

1. assistant response arrives
2. extension sends a small payload to the director API
3. director returns structured txs
4. extension feeds txs into existing validation
5. valid txs commit as normal
6. invalid txs enter the existing correction pipeline

### Director Input

The director should get **narrow, curated context**, not full chat history.

Recommended input:

- current turn mode
- latest user message
- latest assistant response
- current derived state view or compact canonical state payload
- pending correction queue
- optionally the last 1-3 accepted turns for immediate-local context

The director should **not** need the entire transcript if the ledger/state view is doing its job.

### Director Output

The director should return strict JSON only.

Preferred shape:

```json
{
  "transactions": [
    {
      "op": "TR",
      "e": "collision",
      "id": "bridge-confrontation",
      "d": { "f": "status", "from": "ACTIVE", "to": "RESOLVED" },
      "r": "PC forced the confrontation on-screen and the collision completed this turn."
    }
  ],
  "notes": [],
  "confidence": "high"
}
```

The extension should ignore any prose-like commentary and consume only the JSON payload.

### Important Rule

The director proposes.

The extension commits.

Never give the director direct write access to canonical state.

## Recommended Contract For The Director

The spec should make the director contract explicit:

- it is a **ledger operator**, not a prose model
- it outputs only transaction objects
- it should be conservative
- it should prefer no update over speculative update
- it should respect existing state-machine and schema rules
- it should not invent entities or transitions unless clearly earned by the accepted turn
- it should use the ledger/state as the primary long-arc memory, with the new turn as the local delta surface

### Behavioral Priorities

The director should optimize for:

1. structural integrity
2. causal continuity
3. earned change
4. conservative mutation
5. compatibility with deterministic validators

It should explicitly **not** optimize for:

- literary quality
- style matching
- visible response quality
- recap completeness

Those belong elsewhere.

## Failure Policy

The prototype should define failure behavior clearly.

### Director Call Fails

If the director API call fails:

- do not commit anything from the failed call
- queue a correction/reinforcement note if needed
- optionally fall back to the existing parser path only if explicitly enabled for testing

Default recommendation:

- during prototype phase, support an optional fallback to current `extractUpdateBlock()`
- during evaluation, track when fallback was needed

### Director Returns Bad JSON

- treat as zero valid transactions
- record/log the failure
- do not bypass deterministic validation

### Director Returns Invalid Transactions

- pass them through the existing validators
- reject invalid txs exactly as the extension does today
- use existing correction machinery rather than inventing a second correction channel

## Suggested API Boundary

The cleanest prototype is a small relay/service that the extension calls after each accepted assistant message.

Recommended reasons:

- avoid browser-side provider secret handling
- avoid CORS and direct credential leakage concerns
- make retries and logging easier
- keep the director swappable across providers/models

At minimum, the service should expose one endpoint:

`POST /gravity/direct`

Suggested payload:

```json
{
  "chat_id": "optional-host-chat-id",
  "mode": "regular",
  "user_message": "...",
  "assistant_message": "...",
  "state_view": "...",
  "pending_corrections": ["..."],
  "recent_turns": [
    { "user": "...", "assistant": "..." }
  ]
}
```

Suggested response:

```json
{
  "transactions": [],
  "notes": [],
  "model": "director-model-name",
  "duration_ms": 0
}
```

## Spec Questions To Resolve

The next proper spec should answer these explicitly.

### 1. What is the director's exact input surface?

Options:

- full formatted state view text
- compact JSON derived state
- raw transaction ledger tail plus compact state
- state view plus last 1-3 turns

Recommendation:

- start with compact derived state + latest user/assistant + pending corrections

### 2. What output format should be canonical?

Options:

- Gravity's existing tx object shape
- a new higher-level op schema compiled down to tx objects

Recommendation:

- start with tx objects directly to minimize moving parts

### 3. Should the prose model still be allowed to emit ledger blocks?

Recommendation:

- not in the target architecture
- during migration, maybe keep it as an optional debug/fallback path only

### 4. Should the director see the full ledger or the derived state?

Recommendation:

- derived state first
- optionally add a small recent ledger tail if the director needs audit detail

### 5. How do we prevent duplicate commits on swipes/retries?

The spec should define message identity and idempotency rules before implementation.

### 6. What is the success threshold for the prototype?

Recommendation:

- fewer missed structural updates than the current parser-based approach
- fewer malformed update payloads
- no regression in commit safety
- acceptable latency increase

## What Not To Build Yet

The prototype should avoid scope creep.

Do **not** start by:

- building a dedicated Gravity frontend
- porting to Marinara first
- making the director a local sidecar model by default
- replacing deterministic validators with model judgment
- rewriting replay/storage/snapshot logic

Those are follow-on decisions after the architecture is proven.

## Recommended Evaluation Plan

Run the director prototype against a real set of live Gravity play sessions or curated transcripts.

Measure:

- missed required updates
- invalid proposed txs
- false-positive txs that should have stayed prose-only
- collision integrity
- relationship update accuracy
- constraint transition correctness
- latency per turn
- fallback frequency

The evaluation should compare:

- current parser path
- director path
- optional hybrid/fallback path

## If The Prototype Works

If the director approach is clearly better, the long-term path is:

1. extract a host-agnostic Gravity core
2. move the same architecture into a stronger host
3. consider Marinara as the first serious long-term home

At that stage, Marinara becomes attractive because it offers:

- server-side generation orchestration
- built-in tool/agent execution
- DB-backed persistence
- richer UI surfaces

But that is phase 2.

The recommendation of this handoff is phase 1:

> prove the Gravity Director inside the current SillyTavern extension first

## Bottom-Line Recommendation

Spec the next architecture as:

**"Gravity Director prototype inside the current SillyTavern extension, replacing parser-led ledger extraction with a separate API-driven ledger operator while keeping deterministic validation and commit authority in extension code."**

That is the most leverage per unit effort.
