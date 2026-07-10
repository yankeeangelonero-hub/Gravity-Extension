# Gravity v2 — Mechanical Emission Contract Design

Date: 2026-07-10
Status: Selected direction (brainstorm output — supersedes the director-based emission model in `2026-04-25-gravity-director-design.md`)

> **Context.** This document is the outcome of a structured brainstorm on the "bigger refactor / new version" question. It redefines *how the model and the engine exchange state* — the emission contract — and retires the separate-director architecture. It deliberately does **not** redesign the game systems (collisions, dossiers, nudge content, challenges, divination): play-testing validated all of them. The problem is the transport protocol, not the game.

> **Empirical findings this design rests on (play-testing, 2026-06/07):**
> 1. **One smart model doing prose + ledgering beats the director split.** The separate director model (own API key, own OpenRouter call) is dead: it lacked feel for the scene despite receiving state, and added a second failure surface. → The single-model constraint is a *premise* of v2, not an open question.
> 2. **The two real pains are scaffolding token cost and compliance/correction churn.** Long-chat state drift and prose-quality tax did *not* materialize as problems. The state stays true and the writing stays good — the model just spends 300–700 output tokens/turn writing illegible blocks and periodically fumbles the format.
> 3. **All four subsystems earned their keep:** collisions + arrival gates, dossiers + knowledge asymmetry, nudges + heartbeats, challenges + divination. Nothing is cut in v2.
> 4. **Audience is the author.** No migration guarantees, no onboarding polish, SFW-default packaging out of scope. Capability and iteration speed win ties.

## 1. Problem statement

One smart model (switchable among 2–3 frontier models — no hard dependency on any vendor's prefill/reasoning/structured-output API) writes prose and drives the ledger. The current protocol makes it pay twice:

- **Token cost.** Per `regex-intercept.js:71`, each ledger line carries `[Day N — HH:MM] OP entity:id key=value -- reason`: ~5–10 tokens of actual delta wrapped in ~20–35 tokens of metadata. On top, a full `---DEDUCTION---` block (11 fields in regular mode) is emitted and stripped every turn. A busy turn spends 300–700 output tokens on scaffolding.
- **Compliance churn.** The format is rich enough to get wrong. The correction loop (`MAX_CORRECTION_ATTEMPTS`, reinforcement injections, maintenance nudges) exists mostly to police a protocol that is harder than the decisions it encodes.

**Target:** ~an order of magnitude fewer scaffolding tokens (median turn ≤ ~50), with compliance failure made *structurally* rare rather than correction-loop-managed. Streaming preserved on ordinary turns.

## 2. Design principle: the model decides, the machine transacts

Every ledger write is classified by *who can know it*:

| Tier | Who knows it | Mechanism | Output cost |
|---|---|---|---|
| **A — Mechanical** | Engine already knows | Never emitted. Engine writes the transaction itself. | 0 |
| **B — Decidable** | Engine detects the situation; model chooses | Enumerated question (gate) → one-token answer → engine compiles txs | 1–5 tokens |
| **C — Generative** | Only the model knows | Compact delta line, exception-only | ~8–12 tokens/line |

The arrival gate (§3.5 of the Phase-2 spec: engine detects distance 0, model answers ON-SCREEN / OFF-SCREEN / IMPLODE, resolution compiles mechanically) is the validated prototype of Tier B. v2 generalizes it from special case to default shape.

### 2.1 Tier A — promoted to mechanical (never emitted again)

Already mechanical today: divination rolls, challenge/combat math, snapshots/rollback, distance ticks on advance/timeskip (`TICK` multipliers). Newly promoted:

- **Timestamps.** Engine owns the world clock and stamps every transaction at commit. The model never writes `[Day N — HH:MM]` again.
- **Reasons/provenance.** The prose *is* the reason. At commit, the engine attaches the nearest prose sentence mentioning the entity as provenance. Model-written reasons remain only where intent genuinely isn't in the prose: optional on `TR`, required on `D`.
- **Presence & dormancy.** Engine scans the prose against the entity registry (name + alias match). In-scene characters get dormancy counters reset and scene cast updated. No emission, ever.
- **Cap hygiene.** Instead of `_nudge_maintenance` asking the model to trim over-cap arrays (input tokens to ask + output tokens to comply), the engine auto-archives lowest-salience items and reports in the panel. The model never participates.
- **No-op suppression.** At commit, every `S` op is diffed against current state; no-ops are silently dropped (also keeps replay history clean). A high no-op ratio triggers a one-time corrective nudge — the expensive habit visibly does nothing, so the model learns the cheap one.

### 2.2 Tier B — decision gates (generalized arrival gate)

A **gate** is an engine-detected situation with an enumerated answer set. Lifecycle: engine detects trigger during commit → injects a one-line question next turn (gate slot) → model answers inline in the footer → engine compiles the answer into however many transactions it implies → gate closes (one-shot, dedup persisted per §6).

Initial gate set:

| Gate | Trigger (engine-detected) | Question | Compiles to |
|---|---|---|---|
| Arrival (exists) | collision distance 0 | `? c3: ON-SCREEN / OFF-SCREEN / IMPLODE` | status TR + resolution txs |
| Tier promotion | background char crosses scene-frequency threshold | `? promote mira→TRACKED (y/n)` | CR/TR batch |
| Constraint touch | constraint's subject appeared in scene | `? constraint c2: held / stressed / broken` | integrity TR |
| Collision spawn | repeated co-occurrence of two pressure points | `? spawn collision from p1+p4 (name it / no)` | CR collision or nothing |
| Timeskip aftermath | timeskip committed | compact per-entity "anything change? (no / one-liner)" | S batch |

Gate answers are multiple-choice: they **cannot be malformed**, so the correction loop is irrelevant for this entire class of writes.

### 2.3 Tier C — the compact footer (what the model still writes)

Genuine narrative judgment: new entity introductions, relationship / knowledge-asymmetry shifts, pressure creation, world facts.

- **Grammar:** the existing compact `---STATE---` dotted-path form (`char:kaito.loc: docks`) becomes the **only** format. The verbose verb-form `---LEDGER---` grammar is retired (parser keeps reading it during migration; prompts stop teaching it). One format also halves the correction loop's job.
- **Exception-only:** unchanged = unmentioned. Enforced by no-op suppression (§2.1), not just requested.
- **Lazy creation:** a dotted write to an unknown id auto-creates a skeleton entity with defaults. A new character costs one line, not a fully-specified `CR`; the dossier fills in over subsequent turns and interviews (§3).
- **Gate answers ride in the same footer** (`? c3: ON-SCREEN`).

**Before/after, same turn:**

```
[Day 12 — 14:30] S char:kaito location=docks -- Kaito followed the smuggler's tip to the waterfront
[Day 12 — 14:30] TR collision:c3 status=RESOLVED -- the ambush played out on-screen
[Day 12 — 14:30] A char:kaito.key_moments="confronted Vex at the docks"
```
→
```
---STATE---
kaito.loc: docks
? c3: ON-SCREEN
---END STATE---
```
(~90 tokens → ~12. The TR compiles from the gate answer; the key_moment waits for the next interview; timestamp and provenance are machine-stamped.)

## 3. Interview turns (the second half of the hybrid)

Most turns use only the footer. On **trigger turns**, the engine runs an *interview*: a mechanically generated questionnaire sent via `generateQuietPrompt` — **same model, same chat context**, so the single-model premise holds; this is not the director redux (the director was a *different* model with no scene feel). The model fills in constrained answers; the engine compiles them into transactions.

- **Triggers:** arrival resolutions with nontrivial fallout; challenge-session end; every-N-turns consolidation (replaces the rotating nudge system's per-turn drip: agenda checks, relationship pulses, pressure scans batch here); post-timeskip integration.
- **Content:** only *plausible* deltas, pre-filtered by the engine — who was in scene since the last interview, which dossier fields have pending mechanical candidates (key_moments harvested from exemplar/scene data), which relationships had interactions. Checkbox/short-blank format.
- **Archival writes move here entirely:** `key_moments`, `demonstrated_traits`, `intimate_history` appends leave the per-turn hot path. They are record-keeping, not next-turn-critical.
- **Cost:** one extra generation on a minority of turns; input re-billing is mitigated by provider prompt caching. Prose turns stay pure and streaming-native.

**Rebalancing rule:** if footer compliance churn persists in practice, shift weight toward interviews (more gates, thinner footer) rather than growing the correction loop. The correction loop survives only as a thin safety net and its firing rate is the health metric of the whole design.

## 4. Deduction retirement

The emitted `---DEDUCTION---` block is deleted from the protocol. Deliberation moves to native reasoning where the active model has it ("think through intent / collisions / constraints / plan before writing" as reasoning guidance), and is simply skipped otherwise — frontier models are the target (§1 premise).

**Open A/B (cheap, do early):** run identical scenes with and without deduction guidance on the 2–3 target models. Testing validated the *subsystems*, not the 11-field deduction block specifically; it may be vestigial on frontier models. Keep the visible block only if the A/B shows a real quality drop on a reasoning-less target model.

## 5. What dies, what stays

| Dies | Replaced by |
|---|---|
| Director subsystem: `director-client.js`, `director-input.js`, `director-prompt.js`, `director-settings.html`, OpenRouter key in `extensionSettings`, `window.__gravityDirectorStatus` | Single-model footer + interviews via ST's own generation (`generateQuietPrompt`); also closes the two High findings from the 2026-07-10 ST-docs conformance review |
| Verbose `---LEDGER---` verb grammar (as a taught format) | Compact `---STATE---` dotted grammar (parser keeps legacy read path during migration) |
| Emitted `---DEDUCTION---` block | Native reasoning guidance (pending §4 A/B) |
| Per-turn rotating nudge emissions + `_nudge_maintenance` model-side hygiene | Interview batching (Tier B/C) + engine auto-archive (Tier A) |
| Model-written timestamps and most reasons | Machine stamping + prose-sentence provenance |

| Stays (validated) | Notes |
|---|---|
| Append-only ledger, replay, snapshots, state machines | Untouched core; `validateTransition` still gates every TR at commit |
| Collisions, dossiers/knowledge asymmetry, nudge *content*, challenges, divination | Same mechanics; only their transport changes |
| Correction loop | Thin safety net; firing rate becomes the protocol health metric |
| UI panel | Gains: gate-pending indicator, interview-turn marker, auto-archive report |

## 6. Runtime-state durability (folded in from the conformance review)

One-shot dedup state (`_firedCollisionArrivals`, `_foreshadowedCollisions`, `_firedRelationshipCorrections`, correction attempts, open-gate set) moves from module memory into `chatMetadata`, rehydrated in `initialize()`. Gates make this mandatory: an F5 must not re-ask or double-compile a gate. (Resets on chat change / rollback / import keep their current semantics.)

## 7. Relationship to the Marinara port

The emission contract is **host-agnostic engine logic** and should land in the portable engine module, not in ST glue:

- Tier A (mechanical derivation, stamping, no-op suppression, auto-archive) and gate detection/compilation live in the engine — the same code the Marinara `gravity-ledger-director` post_processing agent calls (embedded design §1).
- The footer/interview prompts and the `generateQuietPrompt` plumbing are per-host adapters (ST extension now; Marinara's provider infrastructure later — which the embedded design already mandates instead of a bespoke HTTP client).
- Retiring the director in ST removes the one piece of the current extension the embedded design had to work around (separate connection, key storage).

## 8. Migration phases

1. **Phase 1 — no format break** (pure wins): machine-stamp timestamps/provenance; make reasons optional; no-op suppression; deduction → native-reasoning guidance (+ §4 A/B); delete director subsystem; persist one-shot state (§6).
2. **Phase 2 — contract switch:** STATE-only compact grammar as the taught format; exception-only contract; lazy creation; legacy LEDGER parser retained read-only.
3. **Phase 3 — hybrid completion:** gate framework (detection → question → compile) with the §2.2 initial set; interview turns on triggers; nudge rotation and archival writes absorbed; panel affordances.

De-risk before Phase 3: the **one-afternoon interview prototype** — after a real turn in a live chat, fire a hand-built questionnaire through `generateQuietPrompt` and judge whether same-model-same-context answers have the scene feel the director lacked.

## 9. Success criteria

- Median regular-turn scaffolding ≤ ~50 output tokens (from 300–700).
- Correction loop firing rate near zero over a 100-turn chat; zero malformed gate answers by construction.
- No regression in the four validated subsystems over a long test chat.
- Engine-side pieces land in the portable module with node tests (extends the existing `tests/` harness), consumable unchanged by the Marinara agents.
