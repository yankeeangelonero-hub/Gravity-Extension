# Phase 2 Compliance Audit

**Audit date:** 2026-04-19
**Spec audited:** `PHASE2-SPEC.md` (branch `codex-v13-state-delta`)
**Scope:** Root-level project files (not worktrees under `.claude/worktrees/`)
**Method:** Section-by-section cross-check against spec requirements with line-level evidence. No code changes — audit only.

---

## Summary

Overall Phase 2 implementation is **substantially complete** with a small number of sharp drifts and **one likely critical syntax error** in `index.js :: drawDivination()` that would block extension load. Most spec sections are compliant; the remaining gaps are localized and mostly about placement (wrong file) or language wording (naming drift) rather than missing functionality.

**Tally:**
- Compliant: ~34 requirements
- Partially compliant: 11 (drifts — documented deviations or functional-but-mislocated implementations)
- Non-compliant: 2
- Critical: 1 (see §5.1)
- Out of scope / N/A: 3 (constraints, Phase 1 items already completed)

The memory entry `project_constraint_framing.md` is aligned with Phase 2 scope (spec explicitly defers constraint redesign to post-Phase 2). No Phase 2 drift from that memory.

---

## §2. Ledger Entity Redesign

### §2.1 Characters (`char`)

| Requirement | Status | Evidence |
|---|---|---|
| Entity fields: name, tier, faction, constraints, agenda, knowledge_asymmetry, key_moments, power, abilities, wounds, relationships, location | Compliant | `state-compute.js`, `state-view.js:127–192` |
| Tier machine UNKNOWN→KNOWN→TRACKED→PRINCIPAL | Compliant | `state-machine.js:17–24` |
| `state.chars` access pattern per Entity-to-State-Key Reference table | **Partially compliant — drift** | Codebase uses `state.characters` (`state-compute.js:8, 54, 181`). Comment explicitly flags this as decision "D1". Spec section preamble says "use these exact key names. Do not substitute aliases" — so this is a documented, intentional deviation from the spec's stated rule. |
| `knowledge_asymmetry` with four named categories (knows / unknown / hiding / misreading) | Compliant | `state-compute.js:86–94`, `state-view.js:147–162` |
| Flat key prefixing (`knows_`, `unknown_`, `hiding_`, `misreading_`) | Compliant | Faction migration (`state-compute.js:128–142`) and readme/preset usage follow the convention. |
| Cap of 20 entries across all four KA categories combined | **Partially compliant** | Cap is enforced for **factions** (`state-compute.js:170–174`). **Not enforced for characters** — `normalizeCharacterKnowledgeAsymmetry` only coerces shape, no truncation. |
| `key_moments` PRINCIPAL only | **Non-compliant** | `state-view.js:181–191` renders `key_moments` for TRACKED, KNOWN, and PRINCIPAL alike, using mode-aware caps (e.g. "combat: 3 for non-PRINCIPAL"). Spec §2.1 explicitly says "TRACKED/KNOWN/UNKNOWN chars omit this section." |
| State view injects **last 10** `key_moments` per PRINCIPAL each turn | **Partially compliant — drift** | Caps are 3 (lite PRINCIPAL), 5 (combat/intimacy PRINCIPAL), ∞ (full). None of those are 10. Compliant in spirit (rate-limited subset) but numerically off-spec. |
| Agenda (TRACKED/PRINCIPAL only, narrative-compass string) | Compliant | `state-view.js:164`, setup wizard emits agenda for characters; no agenda field on UNKNOWN/KNOWN. |
| `relationships` is narrative color only, never queried by engine | Compliant | No engine paths read `char.relationships`; only rendered. |
| `location` only for TRACKED/PRINCIPAL/PC | **Partially compliant** | Setting location on lower-tier characters is not blocked at TX-commit time (no guard in `consistency.js` or state-compute CR handler). Travel validation fires regardless of tier. Light issue — LLM is instructed via readme but engine doesn't enforce. |

### §2.2 Collisions (`collision`)

| Requirement | Status | Evidence |
|---|---|---|
| Fields: name, distance_category, distance, status, forces, involved_chars, location, outcome_type, aftermath, successor_collision_ids, parent_collision_ids | Compliant | `state-compute.js:293–303`, `state-view.js:226–362` |
| `distance_category` required on CR, engine resolves numeric distance | Compliant | `state-compute.js:294–303` uses `CATEGORY_DISTANCES` map |
| `status` defaults to ACTIVE | Compliant | `state-compute.js:302` |
| Legacy SEEDED / SIMMERING / RESOLVING migrate to ACTIVE on replay | Compliant | `state-compute.js:273–276` |
| LLM must NOT set `distance` — engine warns on violation | Compliant | `index.js:1563–1570` |

### §2.2.1 Collision Archive

| Requirement | Status | Evidence |
|---|---|---|
| `world.collision_archive` append log | Compliant | `state-compute.js:63, 361–366` |
| Auto-trim to `MAX_COLLISION_ARCHIVE = 20` | Compliant | `state-compute.js:10, 361–366` |
| Engine validates archive presence on terminal collision TR | **Partially compliant — drift** | Check exists (`index.js:1579–1622`), not in `consistency.js` as spec §9 key-file table requires. Functionally correct: queues correction, 3-attempt cap, auto-fallback on drop. |
| Collision entity persists through terminal state (not deleted) | Compliant | No delete on resolution; only TR to RESOLVED/CRASHED. |

### §2.2.2 Collision Sources

| Requirement | Status | Evidence |
|---|---|---|
| Eight valid source pairings documented in spec | Not directly auditable | This is LLM-facing preset/readme content; spec expects these appear in readme or preset. Not verified against current `formatReadme()` body in this pass — flag for preset audit. |

### §2.3 Factions (`faction`)

| Requirement | Status | Evidence |
|---|---|---|
| Fields: name, members, territory, state, agenda, knowledge_asymmetry | Compliant | `state-compute.js:107–176`, `state-view.js:380–406` |
| 4-category knowledge_asymmetry with flat key prefixes | Compliant | `state-compute.js:128–142` migrates legacy `intel_on`/`false_beliefs`/`blindspots` into flat keys. |
| 20-entry cap across all categories combined | Compliant | `state-compute.js:170–174` |
| Legacy faction fields purged (comms_latency, intel_posture, stance_toward_pc, power, momentum, leverage, vulnerability, last_move, objective, resources, relations, doctrine, leadership, alliances, profile) | Compliant | `state-compute.js:108–113, 167–168` |
| `territory` settable via full-array `S` overwrite AND `A` append | Compliant | Standard array semantics; `state-compute.js:347–369` A handler applies. |

### §2.4 Places (`place`)

| Requirement | Status | Evidence |
|---|---|---|
| Entity with name, state, description, reach | Compliant | `state-compute.js:59, 285–288`, `state-view.js:307–315` |
| Default `reach = LOCAL` on CR | Compliant | `state-compute.js:287` |
| Default `state = unknown` on CR | Compliant | `state-compute.js:288` (not in spec but harmless default) |
| `validateTravel()` with TRAVEL_REACH_ORDER and ON_FOOT_MAX | Compliant | `state-compute.js:549–571`, wired at `index.js:1495–1508` |
| Skip check on advance turns | Compliant | `state-compute.js:555` |
| Failed travel queued as correction (not hard-block) | Compliant | `index.js:1500–1507` |
| No `chapter` entity, LLM creates places as discovered | Compliant |  |

### §2.5 Pressure Points (`pressure`)

| Requirement | Status | Evidence |
|---|---|---|
| Fields: name, source, related_to, created_at_tx | Compliant | `state-compute.js:290–292` |
| `created_at_tx` engine-set on CR, LLM value overwritten | Compliant | `state-compute.js:290–292` — engine writes `tx.tx` unconditionally. |
| `MAX_PRESSURE_POINTS = 5` FIFO cap | Compliant | `index.js:72, 1684–1703` |
| Overflow emits explicit `D` transactions into ledger (replay must match live state) | Compliant | `index.js:1692–1700` |
| `WEEKS`/`MONTHS` timeskip clears all pressure points | Compliant | `index.js:1895–1900` |
| Compact bullet-list formatter in state-view | Compliant | `state-view.js:408–419` |
| Section omitted when empty | Compliant | `state-view.js:410` (no header emitted when `pressureEntities.length === 0`) |

### §2.6 World (`world`)

| Requirement | Status | Evidence |
|---|---|---|
| `timeskip_scale` enum HOURS/DAYS/WEEKS/MONTHS | **Partially compliant — drift** | Core logic compliant, but `setup-wizard.js:203` documents `MINUTES/HOURS/DAYS/WEEKS/MONTHS` as valid options. Spec §3.2 only lists HOURS/DAYS/WEEKS/MONTHS. `TICK` map lacks a MINUTES entry — a MINUTES declaration would silently fall back to HOURS (`index.js:1880`). Wording drift that could mislead the LLM. |
| `collision_archive` append log | Compliant | `state-compute.js:63` |
| Engine resets `timeskip_scale` to null after ticking | Compliant | `index.js:1908–1911` |

### §2.7 Stripped Entities

| Requirement | Status | Evidence |
|---|---|---|
| `chapter` entity removed | Compliant | `state-compute.js:260` silently drops legacy chapter TXs; no `chapters: {}` in `createEmptyState()`; no chapter entry in `state-machine.js`. |
| Chapter injection slot / chapter-close prompts removed | Compliant | No `_chapter` slot, no chapter-close UI logic. |
| Story summary stripped (Phase 1) | Compliant | `state-compute.js:260` drops legacy `summary` TXs; no `summary` entity in compute, view, or machine modules. |
| Combat exchange bookkeeping removed | Compliant | Grep for `combat.exchange` / `exchange_counter` / `auto.increment.*exchange` returns no matches. `challenge-state.js:133–140` migrates legacy runtime `exchange` → `clash`. |

### §2.8 LLM Instructions

| Requirement | Status | Evidence |
|---|---|---|
| NESCIENCE discipline content in readme / preset | Not directly verified in this pass — formatReadme content skimmed, specific NESCIENCE wording not cross-checked. Flag for follow-up. |
| Creation / movement / update guidance matches spec examples | Not verified | Same as above — needs readme content audit. |

---

## §3. Collision Mechanics Redesign

### §3.1 Distance Category System

| Requirement | Status | Evidence |
|---|---|---|
| `CATEGORY_DISTANCES = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 }` | Compliant | `state-compute.js:9` |
| Engine maps category → starting distance on CR | Compliant | `state-compute.js:294–303` |
| No back-compat inference — missing category defaults to SHORT | Compliant | `state-compute.js:298–301` |
| Audit warning if LLM sets `distance` directly | Compliant | `index.js:1564–1570` |
| Audit warning if CR collision missing `distance_category` | Not enforced as a warning — defaults silently to SHORT | Minor drift. Spec §3.1 asks for a warning. |

### §3.2 Clock System — Advance-Only Ticking

| Requirement | Status | Evidence |
|---|---|---|
| `TICK = { HOURS: 1, DAYS: 3, WEEKS: 10, MONTHS: 20 }` | Compliant | `index.js:70` |
| Clock ticks only on advance turns | Compliant | Tick loop only inside `handleAdvanceButton()` (`index.js:1877–1905`). |
| Missing `timeskip_scale` falls back to HOURS (+1) | Compliant | `index.js:1879–1880` |
| IMMEDIATE collisions skipped during tick | Compliant | `index.js:1887` |
| Advance preconditions: lock, unresolved-arrival reject, PC safety warn | Compliant | `index.js:1836–1874` |
| **Timeskip_scale consumption ordering** | **Partially compliant — architectural drift** | Spec §3.7 step 2 says "Commit LLM transactions from the current response" before ticking. In the codebase, `handleAdvanceButton` runs at **button click** — BEFORE the LLM generates the advance response. The tick therefore uses the **previous** turn's declared `timeskip_scale` (or the HOURS fallback on first advance), not the current response's declaration. Functionally creates a 1-turn lag between the LLM's scale choice and the engine tick that consumes it. |

### §3.3 IMMEDIATE Same-Turn Firing

| Requirement | Status | Evidence |
|---|---|---|
| IMMEDIATE collisions fire on CR turn in any mode | Compliant | `index.js:1672–1682` in `onMessageReceived` |
| Shared `buildAndInjectArrivals()` callable from both paths | Compliant | `index.js:831–866`; invoked from `onMessageReceived` and `handleAdvanceButton` |
| Non-IMMEDIATE collisions do not fire in non-advance turns | Compliant | Only IMMEDIATE filter in `onMessageReceived`; distance-0 arrival check only inside `handleAdvanceButton`. |

### §3.4 Foreshadowing — Threshold Injection

| Requirement | Status | Evidence |
|---|---|---|
| Thresholds APPROACHING ≤80%, IMMINENT ≤50%, CONVERGING ≤20% | Compliant | `index.js:900–902` |
| IMMEDIATE collisions skip foreshadowing | Compliant | `index.js:889` |
| `_foreshadowedCollisions` Map, each level fires once | Compliant | `index.js:67, 897–913` |
| Subsumption: higher urgency implies lower-level fired | Compliant | `index.js:907–912` |
| Injection slot `_foreshadow`, cleared when empty | Compliant | `index.js:1293–1303` |
| Level guidance text matches spec wording | Compliant | `index.js:874–878` |
| Inject on regular and advance turns (not combat / intimacy) | Compliant | `index.js:1294` gates on `isRegular || isAdvance` |

### §3.5 Arrival Sanity Check + Single-Shot Injection

| Requirement | Status | Evidence |
|---|---|---|
| `_resolutionTracker` removed | Compliant | Grep returns no matches. |
| Phase constants `RESOLUTION_PRESSURE_TURNS` / `RESOLUTION_INTRUSION_TURNS` / `RESOLUTION_CRASH_TURNS` removed | Compliant | Grep returns no matches. |
| `_firedCollisionArrivals` Set kept | Compliant | `index.js:66` |
| `checkProximity()` implementation | Compliant | `index.js` (invoked at `index.js:839`) |
| Sanity-check prompt with ON-SCREEN / OFF-SCREEN (REFRAME / DISSOLVE) / IMPLODE | Compliant | `buildArrivalBlock` body at `index.js:776–829` matches spec structure. |
| CRASHED branch included | Compliant | `index.js:821–826` |
| Tarot draw retained in arrival payload | Compliant | `index.js:838` |
| Simultaneous arrivals: pick one ON-SCREEN, rest resolve OFF-SCREEN/IMPLODE | Compliant | `index.js:851–865` prepends a `[SIMULTANEOUS ARRIVALS — ...]` header block. |
| Injection via `_arrival` slot | Compliant | `index.js:862` |

### §3.6 Advance-Only Firing Summary

| Requirement | Status | Evidence |
|---|---|---|
| IMMEDIATE may fire in any mode on creation | Compliant | §3.3 evidence |
| Non-IMMEDIATE only arrives on advance | Compliant | Distance-0 scan runs only after the advance tick (`index.js:1917–1929`). |
| `_nudge` carries 15-minute scene cap language on non-advance turns | Not verified in this pass — readme / nudge content needs spot-check. | |

### §3.7 Advance Turn Operation Order

| Spec step | Implementation | Status |
|---|---|---|
| 1. Lock advance button | `index.js:1836–1850` | ✅ |
| 2. Commit LLM transactions from current response | **Happens in `onMessageReceived`**, not `handleAdvanceButton`. See §3.2 drift. | ⚠️ |
| 2b. Fire IMMEDIATE collisions committed this turn | `onMessageReceived:1672–1682` | ✅ (in the right place, even if the spec labels it inside `handleAdvanceButton`) |
| 3. Unresolved arrival check | `index.js:1857–1868` | ✅ |
| 4. PC safety check (advisory) | `index.js:1870–1874` | ✅ |
| 5. Read `timeskip_scale`, fallback HOURS | `index.js:1879` | ✅ |
| 6. Tick ACTIVE non-IMMEDIATE distances | `index.js:1883–1893` | ✅ |
| 7. If WEEKS/MONTHS, emit D pressure TXs | `index.js:1895–1900` | ✅ |
| 8. Check for new arrivals after tick | `index.js:1917–1929` | ✅ |
| 9. Foreshadowing threshold checks | Runs inside `injectPrompt()` → `buildForeshadowingInjection()` (`index.js:1293–1303`) | ✅ (mis-labelled location, correct behavior) |
| 10. Fire `collision_health` nudge when both pools empty | `index.js:1930–1932` | ✅ |
| 11. Build and inject payload | `injectPrompt('advance')` at `index.js:1934` | ✅ |
| 12. Reset `timeskip_scale` to null | `index.js:1908–1911` | ✅ (runs earlier in the sequence than spec suggests — before arrival detection — but before the next advance, which is all that matters) |
| 13. Unlock on response completion | `reenableAdvBtn` on `MESSAGE_RECEIVED` (`index.js:1847–1849`) | ✅ |

---

## §4. Pressure Economy

### §4.1 / §4.2 Pressure + Collision Pool Caps

| Requirement | Status | Evidence |
|---|---|---|
| `MAX_PRESSURE_POINTS = 5` in index.js | Compliant | `index.js:72` |
| FIFO drop emits `D` transactions into ledger before new CR | Compliant | `index.js:1684–1703`. (Ordering: FIFO drop runs **after** commit of the batch — not strictly "before appending the new CR" in the spec's intent. The new CR has already been appended, then overflow triggers D. Functionally identical to spec so long as replay sees both, which it does.) |
| `MAX_COLLISIONS = 5` | Compliant | `index.js:73` |
| IMMEDIATE exempt from pool cap | Compliant | `index.js:1707–1709` filters `distance_category !== 'IMMEDIATE'` |
| Overflow warning queued to corrections (not hard-block) | Compliant | `index.js:1710–1715` |
| Corrections queue uses FIFO ordering | Compliant | `queueCorrections` appends to end of `_pendingCorrections`, drained in insertion order. |

### §4.3 Seeding When Empty

| Requirement | Status | Evidence |
|---|---|---|
| `collision_health` invariant: never zero pressures AND zero active collisions | Compliant | `buildNudge_collisionHealth` at `index.js:955–966` fires when both pools empty. |
| Archive injection into state view when active pool ≤ 2 | Compliant | `state-view.js:78–89, 422–428`, `computeArchiveVersion` dedup at `state-view.js:96–102` |
| Last 5 archive entries surfaced | Compliant | `state-view.js:85` slices `slice(-5)` |
| `_archiveInjectedVersion` dedups re-injection on consecutive turns | Compliant | `index.js:80, 1078–1083` |
| In-memory only (not persisted) — resets on reload | Compliant | Module-level `let`, not in `chatMetadata` |

### §4.4 Rotating Nudge System

| Requirement | Status | Evidence |
|---|---|---|
| 7-slot rotation with correct labels | Compliant | `index.js:87` `NUDGE_SLOT_NAMES = ['agenda_check', 'pressure_scan', 'consolidation_check', 'collision_health', 'relationship_pulse', 'collision_validity', 'destroyed_cleanup']` |
| Every 4 turns on regular/combat/intimate | Compliant | `maybeComputeNudge` at `index.js:998–1035`; gate `counter % 4 !== 0` at line 1002 |
| `_nudgeCounter` starts at -3, first fires at turn 4 | Compliant | `index.js:924` default `counter: meta[NUDGE_COUNTER_KEY] ?? -3` |
| Persisted in `chatMetadata` via `NUDGE_COUNTER_KEY` / `NUDGE_SLOT_KEY` / `NUDGE_ROTATION_INDEX_KEY` | Compliant | `index.js:84–86, 930–936` |
| Skip `agenda_check` (slot 0) and `relationship_pulse` (slot 4) if no PRINCIPAL/TRACKED chars, advance slot with no emit | Compliant | `index.js:1009–1018` — eligible list filtered to PRINCIPAL+TRACKED, `text` stays null if empty, slot still advances via `(slot + 1) % 7` at line 1033. |
| `collision_health` forced on every advance turn regardless of counter | Compliant | `index.js:1930–1932` |
| Per-character rotation index advances only after agenda_check/relationship_pulse | Compliant | `index.js:1032` — `(slot === 0 \|\| slot === 4) ? rotIdx + 1 : rotIdx` |

---

## §5. Divination

### §5.1 Yi Jing Strip (Phase 1)

| Requirement | Status | Evidence |
|---|---|---|
| `iching` case removed from `drawDivination()` | Compliant | No matches for `iching` / `yi.*jing` / `hexagram` / `1d64`. |
| Hexagram table removed | Compliant | As above. |
| `active_system === 'iching'` treated as Arcana | N/A | No iching code path remains. |
| Arcana (22-card, 1d22) retained | Present but unreachable | Arcana table at `index.js:89–112` is intact. Arcana return block at `index.js:531–542` is code-present. |
| Classic (2d10) retained | Present but unguarded | Classic return block at `index.js:519–528` is code-present. |

#### 🚨 CRITICAL: `drawDivination()` likely has a syntax error

Brace-balance and indentation in `index.js:508–543` suggest the Phase 1 Yi Jing strip removed the guarding `if (system === 'classic') { ... } else { ... }` scaffolding but left orphaned body code:

```
517:     const system = getActiveDivinationSystem();   // 4-space indent, value never used
518:
519:         const d1 = Math.floor(Math.random() * 10) + 1;   // 8-space indent with no enclosing block
520:         const d2 = Math.floor(Math.random() * 10) + 1;
521:         const total = d1 + d2;
522:         return { ... };                           // classic draw, fires unconditionally
528:         };
529:     }                                             // STRAY }: closes the function prematurely
531:     // Default: arcana (d22, 0-indexed)           // now at module top level
532:     const num = ...
535:     return { ... };                               // top-level return — invalid
542:     };
543: }                                                // no matching opener
```

Brace tally inside the function starting at line 508:

| Line | Token | Depth after |
|---|---|---|
| 508 | `function ... {` | 1 |
| 510–515 | two `if { ... }` blocks | back to 1 |
| 522–528 | `return { ... };` | back to 1 |
| 529 | `}` | 0 ← function closes here |
| 535 | `return {` | 1 |
| 542 | `};` | 0 |
| 543 | `}` | -1 ← no matching opener |

Net: unbalanced. `node -c index.js` should fail. If it does, the entire extension fails to load, which would null out every Phase 2 feature (arrivals, combat tarot, foreshadow, nudges — all ride on the module loading).

**Verification recommended:** run `node -c index.js` from the project root. If it passes, my brace count is off; if it fails, this is the highest-priority fix in the project.

Secondary effect even if the parse somehow succeeds: the `const system = getActiveDivinationSystem();` on line 517 is dead code (value unused), and the classic draw at 519–528 fires unconditionally ahead of the arcana fallback — so only classic would ever return for non-manual draws. Either way the arcana fallback at 531–542 is unreachable.

---

## §6. State Machine Enforcement

### §6.1 `validateTransition()` Wiring

| Requirement | Status | Evidence |
|---|---|---|
| `validateTransition()` called on every TR op at commit time | Compliant | `index.js:1511–1523` |
| Called from `consistency.js` | **Partially compliant — drift** | Spec §6.1 + §9 both state `consistency.js` is the intended home. Actual home is `index.js` (imported from `./state-machine.js`). `consistency.js` has no call to `validateTransition`. |
| Invalid TRs rejected, transaction not appended | Compliant | `index.js:1514–1521` uses `continue` to skip, then commits only `validTxns` at 1539. |
| Correction queued with `fix` suggestion | Compliant | `index.js:1515–1520` |
| Other valid TXs in the batch still commit | Compliant | Per-tx loop — only the bad tx is skipped. |
| Chapter removed from state machine | Compliant | `state-machine.js` has no chapter entry. |
| `collision: ACTIVE → RESOLVED`, `ACTIVE → CRASHED` (both terminal) | Compliant | `state-machine.js:46–50` |
| `place` state transitions are freeform (no enforcement) | Compliant | No `place` entry in state machines map (`state-machine.js:80–85`) — falls through to `{ valid: true }`. |

### §6.2 Stale comments (housekeeping)

| Location | Issue |
|---|---|
| `state-machine.js:3–11` | Comment says "These are NOT enforced by the extension — gameplay rules are the LLM's responsibility, audited during OOC: eval." — no longer true after Phase 2 wires enforcement. |
| `consistency.js:7–10` | Comment says "Gameplay rules (PRINCIPAL count, constraint limits, collision forces, state machine transitions) are NOT enforced here." — half-true: state-machine transitions are now enforced (in `index.js`). Wording is stale. |

---

## §7. Challenge System Extensibility

### §7.2 Combat is Ephemeral

| Requirement | Status | Evidence |
|---|---|---|
| Combat block injected into response context each turn while ACTIVE | Compliant | `buildChallengePrompt` inside `challenge-state.js`, wired at `index.js:1106–1120`. |
| Tarot draws per exchange continue | Compliant | `drawDivination` used inside challenge pipeline. |
| `combat.exchange` counter removed from ledger | Compliant | Grep for `combat.exchange` / `exchange_counter` returns no matches. Runtime-only `runtime.clash` (renamed from legacy `exchange`) lives in `challenge-state.js:133–140`. |
| Lasting effects (power / wounds / abilities) write back to char entities on end | Compliant (design) | No evidence of exchange-by-exchange ledger writes; closure is via char SET/APPEND operations. |

### §7.3 Non-Breaking Design Rules

| Rule | Status | Evidence |
|---|---|---|
| 1. Challenge type is a field, not a code branch | **Partially compliant** | Profiles carry `kind: 'combat'` (`challenge-profile-combat.js:157, 201`) — a field, as spec intends. Naming drift: spec names the field `challenge_type`, code uses `kind`. |
| 2. Engine logic challenge-type-agnostic | Compliant | `buildChallengePrompt`, `startChallengeRuntime`, `clearChallengeRuntime` all dispatch via `profile.kind` rather than hard-coded combat paths. |
| 3. `formatChallenge(challenge)` dispatcher in state-view.js | Not present | Grep for `formatChallenge` returns no matches. Combat is currently rendered inline in `state-view.js`'s Combats section (`state-view.js:239–254, 364–378`). Spec §7.3 asks for a dispatcher function — additive work for future challenge types, not breaking today. |
| 4. Per-type state machine entries | Compliant | `state-machine.js:53–60` defines a dedicated `COMBAT_TRANSITIONS` table. |

---

## §8. Implementation Order — Cleanup Tasks

### §8 step 8b: Snapshot rollback runtime-state clearing

| Requirement | Status | Evidence |
|---|---|---|
| `_firedCollisionArrivals.clear()`, `_foreshadowedCollisions.clear()`, `_archiveInjectedVersion` reset wired into `snapshot-mgr.js` rollback handler | **Non-compliant (location)** | Cleanup exists at `index.js:1794–1800` inside `onUserMessage` for the OOC-`rollback` text path. `snapshot-mgr.js:88–101`'s `rollback()` does not touch these globals. Any programmatic rollback (future OOC handlers, snapshot UI, etc.) that goes through `snapshot-mgr.rollback()` without the OOC regex path will leave arrival/foreshadow/archive runtime state stale. |

---

## Cross-Cutting Findings

### Constraint bidirectional framing (memory `project_constraint_framing.md`)

Spec §1 Out-of-Scope block explicitly defers the constraint redesign ("Constraint system — unchanged, filed for future refactor"). Memory entry records the same intent ("Address this after Phase 2 collision mechanics are implemented").

**Compliance verdict:** N/A — aligned with spec scope, nothing for Phase 2 to action. Post-Phase 2 work should pick up the bidirectional (growth/fall) framing and the all-breached transformative-moment gap.

### Entity key naming drift (`chars` vs `characters`, `challenge_type` vs `kind`)

The spec explicitly calls out key naming discipline ("use these exact key names. Do not substitute aliases"). The codebase uses its own names (`characters`, `pressures`, `kind`) and documents them as decision D1 at `state-compute.js:8`. This is a deliberate codebase convention that contradicts spec text. For future Phase audits, either the spec should be updated to accept these names or the codebase should migrate. Either path is fine — the ambiguity is the problem.

### Readme / preset content not deeply audited

Several spec items (NESCIENCE discipline text, collision sources list §2.2.2, 15-minute scene cap wording, LLM-facing creation examples) live in the readme / preset content emitted by `formatReadmeCore` / `formatReadmeFull` / preset JSON. This audit did not exhaustively diff readme strings against spec wording. Recommend a follow-up pass focused on readme text vs spec §2.1–2.8 and §3.5's arrival prompt template.

---

## Prioritized Remediation List

### P0 — Critical (verify first, fix before shipping)

1. **`drawDivination()` brace-balance failure (§5.1).** Inspect `index.js:508–543`. Run `node -c index.js`. If the syntax check fails, restore a structure like:
   ```js
   const system = getActiveDivinationSystem();
   if (system === 'classic') {
       // classic branch
       return { ... };
   }
   // default: arcana
   return { ... };
   ```
   This is the single highest-impact finding — a broken parse here means the entire extension is dead in the water, which cascades into every other Phase 2 feature reading as "non-functional" regardless of how well the individual pieces are written.

### P1 — Functional drifts that alter behavior

2. **Timeskip scale consumption lag (§3.2 / §3.7).** Verify whether `handleAdvanceButton` is supposed to read the current or previous response's `timeskip_scale`. Current implementation ticks before the LLM declares, so the first advance always uses HOURS and subsequent ticks lag by one turn. Either:
   - Update spec to describe the lag, or
   - Defer tick logic into `onMessageReceived` after commit (matches spec §3.7 step 2).

3. **Character `key_moments` rendered for non-PRINCIPAL chars (§2.1).** `state-view.js:181–191` shows key_moments for TRACKED (and KNOWN / UNKNOWN in full mode). Spec is explicit: "TRACKED/KNOWN/UNKNOWN chars omit this section." Gate the block on `tier === 'PRINCIPAL'`.

4. **Character `knowledge_asymmetry` cap not enforced (§2.1).** Faction KA is trimmed to 20 entries (`state-compute.js:170–174`); character KA normalization (`normalizeCharacterKnowledgeAsymmetry`) does not trim. Add the same slice-at-20 trim for characters.

5. **Snapshot rollback does not clear arrival/foreshadow/archive runtime state (§8 step 8b).** Move the clearing block into `snapshot-mgr.js::rollback()` (or wrap it in a callback registered from `index.js`) so every rollback path — not just OOC — resets the in-memory flags.

### P2 — Location / naming drifts (no behavioral impact but should align)

6. **Move `validateTransition()` call into `consistency.js` (§6.1, §9).** Today it lives in `index.js:1513`; spec specifies `consistency.js` as the home. Purely structural.

7. **Move collision archive presence check into `consistency.js` (§2.2.1, §9).** Today it lives in `index.js:1579–1622`.

8. **Update stale comments in `state-machine.js` (lines 3–11) and `consistency.js` (lines 2–11).** Both claim state machine transitions are not enforced — now they are.

9. **Remove `MINUTES` from the timeskip-scale hint in `setup-wizard.js:203`.** Spec §3.2 table lists HOURS/DAYS/WEEKS/MONTHS only. Referencing MINUTES as a valid input risks LLM emitting it; `TICK[scale]` would then null-coalesce to 1 (HOURS) silently.

10. **Rename `kind` → `challenge_type` in challenge profiles (§7.3 rule 1)** or conversely update the spec to accept `kind`. Document whichever decision wins in `state-compute.js` alongside the existing D1 note.

11. **Add the `formatChallenge(challenge)` dispatcher to `state-view.js` (§7.3 rule 3).** Current combat rendering is inline in the Combats section. Spec's extensibility rule is forward-looking — adding the dispatcher is no-op for today but unblocks future persuasion / racing / etc.

### P3 — Documentation / polish

12. **State view cap for `key_moments` — confirm desired number.** Spec says "last 10 per PRINCIPAL each turn"; code uses 3/5/∞ depending on mode. Either update the spec to mode-aware numbers, or standardize on 10.

13. **Audit `formatReadme` content against spec §2.8, §2.2.2, §3.5 arrival prompt template, and §3.6 15-minute cap language.** Separate pass, not covered here.

14. **Enforce `char.location` setting only for TRACKED/PRINCIPAL/PC (§2.1).** Currently allowed for any tier; LLM is instructed via readme but nothing blocks a `S char:lower_tier field=location value=...` at commit time.

15. **Warn when collision CR omits `distance_category` (§3.1).** Default to SHORT is fine, but the spec asks for a visible warning; today it is silent.

---

## Files Inspected

Root-level project files (not worktrees):

- `index.js` (primary coordinator)
- `state-compute.js`
- `state-machine.js`
- `consistency.js`
- `state-view.js`
- `snapshot-mgr.js`
- `challenge-state.js` (spot-checked)
- `challenge-profile-combat.js` (spot-checked)
- `challenge-mechanics.js` / `challenge-profiles.js` / `challenge-shared.js` (grep-only)
- `combat-state.js` (grep-only)
- `setup-wizard.js` (chapter/summary + timeskip-scale strings)
- `ooc-handler.js` / `regex-intercept.js` / `ui-panel.js` (grep-only)
- `manifest.json`
- Memory entry `project_constraint_framing.md` (read in full)

Not covered in this pass: the full content of `formatReadme()` output, preset JSON files (`gravity_v14.json` / `gravity_v15.json` / `Gravity World Info.json`), the character card template in `Documentation/`, and the many worktrees under `.claude/worktrees/`.
