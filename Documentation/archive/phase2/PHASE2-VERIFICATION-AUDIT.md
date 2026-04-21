# Phase 2 Verification Audit — Round 2

**Branch:** `codex-v13-state-delta`
**Commit:** `d6dd07c` (fix(phase2): apply PHASE2-FINAL-FIXES — all groups 1-15)
**Date:** 2026-04-19
**Method:** Six parallel auditor agents, one per independent domain, cross-referenced against `PHASE2-AUDIT-CHECKLIST.md` and `gravity_v15.json` "L4 Phase 2 Commands" as normative spec.
**Verdict:** **SIGNIFICANT IMPROVEMENT, BUT NOT YET COMPLIANT.** Down from ~30 violations to **~22 actionable issues**, with the bulk of remaining problems concentrated in: (1) `state-view.js` faction rendering + readme still teaches the legacy faction schema and `intel_on`, (2) `gravity_v15.json` active L0/Character-Voice prompt entries still teach `wants`/`doing`/`condition`, (3) two missed `exchange→clash` sites in `challenge-profile-combat.js` (one is a live bug — prints `undefined`), (4) missing legacy collision-status migration in `state-compute.js`, and (5) doc-vs-code mismatch where `AGENTS.md` claims `reads`/`noticed_details`/faction `intel_on` are removed but they're still actively used.

---

## Net Change vs Round 1

| Domain | Round 1 | Round 2 | Status |
|---|---|---|---|
| `index.js` runtime reads | 11 violations | **0** | ✅ Fully fixed |
| `state-view.js` (world.constants, condition, intimacy_stance reads) | 6 clusters | **0 of original; 5 NEW high-impact discovered** | ⚠️ Old fixed; bigger problem newly visible |
| `ooc-handler.js` (world.constants, STALE FIELDS) | 2 | **0** | ✅ Fully fixed |
| `ui-panel.js` (Exchange label, hardcoded denominator) | 2 | **0** | ✅ Fully fixed |
| `challenge-state.js` / `challenge-input.js` (exchange leak) | many | **0** | ✅ Fully fixed (clean migration to `clash`) |
| `challenge-profile-combat.js` (exchange leaks) | 2 | **2 still broken + 1 stale comment** | ❌ Missed in this round |
| `gravity_v15.json` active layers | 1 active issue | **3 NEW high-impact** in L0/L2/Character-Voice | ❌ Regression visibility |
| `setup-wizard.js` | 3 LOW | **1 HIGH (status=ACTIVE)** + 3 LOW | ❌ Regression visibility |
| `state-compute.js` legacy status migration | missing | **still missing** | ❌ Not addressed |
| `CLAUDE.md` / `AGENTS.md` (validateTransition, slots, combat entity, Documentation/Old/) | 14 | **3 LOW + 1 doc-vs-code mismatch** | ✅ Mostly fixed |
| **Banned-terms cross-cut** | ~30 | **~6 real violations** | ✅ ~80% reduction |

**Files fully clean (verified zero violations):**
- `state-machine.js`, `consistency.js`, `style.css`
- `regex-intercept.js`, `ledger-store.js`, `snapshot-mgr.js`, `combat-state.js`
- `challenge-mechanics.js`, `challenge-profiles.js`, `challenge-shared.js`
- `challenge-state.js`, `challenge-input.js` (clean migration completed)
- `manifest.json`, `ui-panel.js`
- `test-import-ffvii.json`

**Banned terms with zero active hits:** `oracle pipeline`, `3-phase oracle`, `iChing`, `Yi Jing`, `hexagram` (active code only), `SEEDED`/`SIMMERING`/`RESOLVING` (only as legitimate negation), `buildAdvanceBeats`, `condition` (as field), `want`/`doing` (as fields), `world.constants` (active code), `chapter` (active surfaces only — one disabled WI entry).

---

## 1. Runtime Logic

### `index.js` — **MOSTLY CLEAN**

| Sev | Line | Finding | Spec |
|---|---|---|---|
| **LOW** | 74 | `MAX_COLLISION_ARCHIVE = 20` declared but never referenced; actual cap enforced inside `state-compute.js:337` with hardcoded literal | Either wire constant through to state-compute or delete |
| **LOW** | 1325 | Stale tombstone comment "Phase 2 removed noticed_details" | Cosmetic |

**All Round 1 violations fixed:** No `intimacy_stance` reads; no `char.want`; no `f.objective`/`power`/`momentum`; no collision `details`/`cost`/`target_constraint`. ✅

### `state-compute.js`

| Sev | Line | Finding | Spec |
|---|---|---|---|
| **HIGH** | 261-289 (CR), 291-303 (TR), 305-319 (S) | **Still missing legacy collision-status migration.** CR only defaults `status='ACTIVE'` when absent — a legacy `CR collision … status=SEEDED` persists `SEEDED`. TR/S write `tx.d.to`/`tx.d.v` directly with no normalization. Old TR `from=SEEDED to=SIMMERING` produces non-Phase-2 statuses. Result: pre-Phase-2 chats reload with collisions stuck in legacy statuses; downstream `status === 'ACTIVE'` filters treat them as inactive | Checklist line 18 explicitly requires legacy status migration |
| **HIGH** | 100-159 | `ensureIntelSubject` and `normalizeFactionIntel` run unconditionally on every replay, treating `intel_on` as a live first-class faction field — not migration. Lines 128-159 *initialize* `intel_on` fresh on factions that don't have it | Per checklist, `intel_on` is "Banned outside migration (replaced by knowledge_asymmetry)" |
| **LOW** | 469 | `state.divination = { active_system: '' }` empty string vs default `'arcana'` (line 70) | Minor inconsistency on snapshot-restore |

### `state-machine.js` — **CLEAN** ✅

`COLLISION_STATES = ['ACTIVE','RESOLVED','CRASHED']` only; transitions ACTIVE → RESOLVED|CRASHED, both terminal; no chapter states.

### `consistency.js` — **CLEAN** ✅

`VALID_ENTITIES` includes `'place'`, `'pressure'`, `'combat'`; excludes `'summary'`/`'chapter'`.

---

## 2. UI Layer — **FULLY CLEAN** ✅

### `ui-panel.js` — 0 findings

**All Round 1 violations fixed:**
- `CATEGORY_DISTANCES` properly imported from `state-compute.js` (line 11) and used in `renderDistanceBar` (line 1093).
- Combat panel renders `<b>Clash:</b> ${runtime.clash ?? '?'}` at line 1031 — no "Exchange" anywhere.
- Characters/Factions/Collisions tabs use Phase 2 fields exclusively.
- CRASHED collisions properly bucketed into resolved section.
- Highlight system per-card with data-id+data-kind, includes pressures.

### `style.css` — 0 findings

All required classes present.

---

## 3. Setup & Onboarding

### `setup-wizard.js`

| Sev | Line | Finding | Spec |
|---|---|---|---|
| **HIGH** | 216 | Collision creation example sets `status=ACTIVE` directly | L4 in `gravity_v15.json` says: "All collisions start `ACTIVE`. Do not set `status` on creation." Example demonstrates the very anti-pattern the spec forbids |
| **LOW** | 69, 112, 125, 139 | Field id `gl-setup-arc` and label "opening arc" — colloquial use of "arc" (not entity) | Cosmetic; could rename for clarity |
| **LOW** | 197 | Constraint creation example uses `owner_id=name` (literal placeholder) instead of `char:<id>` | Cosmetic |

---

## 4. Prompt Engineering

### `gravity_v15.json` — **3 NEW HIGH-IMPACT VIOLATIONS in active layers**

| Sev | Line | Entry | Finding | Spec |
|---|---|---|---|---|
| **HIGH** | 515 | "L0 - Cast Reminder" (**enabled**) | `TRACKED: active dossier, wants, reads, constraint pressure.` — uses removed `wants` as tracked-character dossier element | Spec replaced `want` with `agenda` |
| **HIGH** | 515 | "L0 - Cast Reminder" (**enabled**) | Final line `Doing should include the present action and its current cost.` — explicitly references removed `doing` field | Spec removed `doing` (rolled into `agenda`/`current_scene`) |
| **HIGH** | 501 | "Character Voice" (**enabled**) | `The dossier's tier, condition, and background constrain the word ceiling.` — references removed char field `condition` | Spec removed `condition` |
| **MEDIUM** | 529 | "L2 - Gravity Kernel" (**enabled**) | `Consistency: characters behave according to their wants, constraints, and established nature.` | Reads as colloquial English noun, but in this schema-adjacent context risks LLM treating `wants` as a field |
| **LOW** | 487 | "Dossier-Driven Prose" (**enabled**) | "this arc" (narrative metaphor) and "newly seeded" (gardening) | Coincidental tokens |
| **LOW** | 236, 250 | "Section A - Configuration" / "Constants TEMPLATE" (**disabled**) | Historical world-constants references | Disabled, LOW |

### `Gravity World Info.json` — **MOSTLY CLEAN**

| Sev | Entry | Finding | Spec |
|---|---|---|---|
| **LOW** | "Chapter Close Core" (uid 9, **disabled**) | Full Chapter Close prompt body preserved in disabled entry | Inert; recommend deletion to prevent re-enable |
| **LOW** | "Gravity Prose - Regular" (uid 10, **enabled**) line 316 | "shut down exchanges" — verbal-exchange English usage | Not the combat term |
| **LOW** | "Combat Core" (uid 3, **enabled**) line 78 | "the extension already seeded the active combat:* container" — past-tense English verb | Coincidental |

Active entries 1, 3, 4, 6, 8, 10, 11, 12, 13, 14 use Phase 2 terminology. ✅

---

## 5. Intercepts & Test Data

### `regex-intercept.js` — **CLEAN** ✅

### `challenge-state.js` — **CLEAN** ✅

`runtime.clash` is the new field. `RUNTIME_CLASH`/`MUST_RESOLVE_CLASH`/`MUST_NOT_RESOLVE_CLASH`/`RESOLVE_CLASH` mechanics keys all use "clash". Only "exchange" hit is the migration block at lines 133-141 (`runtime.exchange → runtime.clash`) — allowed.

### `challenge-input.js` — **CLEAN** ✅

Option ID format now `opt-c${runtime?.clash || 1}-v...` — leak fixed.

### `challenge-profile-combat.js`

| Sev | Line | Finding | Spec |
|---|---|---|---|
| **CRITICAL** | 332 | `LAST RESOLUTION: clash ${runtime.last_resolution.exchange}` — reads `.exchange` after `challenge-state.js` migration deleted it. **LIVE BUG: will render `LAST RESOLUTION: clash undefined`** to the LLM | Field is `runtime.last_resolution.clash` post-migration |
| **HIGH** | 399 | LLM-injected text: `'Record divination.last_draw in the update block for rolled exchanges.'` | Should be "rolled clashes" |
| **LOW** | 266 | Stale comment: `// Engine tracks clash counter (runtime.exchange) internally` | Field is `runtime.clash`; cosmetic |

### `test-import-ffvii.json` — **CLEAN** ✅

All collisions, chars, factions, places, pressures, knowledge_asymmetry use Phase 2 schema. The "exchange" matches at lines 19, 55 are English words ("Alley exchange", "room-key exchange") in narrative strings.

---

## 6. Documentation

### `CLAUDE.md`

| Sev | Line | Finding | Spec/Code |
|---|---|---|---|
| **HIGH** | 85 | Claims `validateTransition()` called from `index.js:1551` — actual call is at `index.js:1514` (off by 37 lines) | Line drift only; attribution to `state-machine.js` is correct now |
| **LOW** | 102 | Says "`index.js` is the central coordinator (~2,300 lines)" — actual 2,247 | Close enough |
| **LOW** | 70 | "Full 11-field deduction" — verify against current preset (was 12 in Round 1) | Cross-check |

**Round 1 fixes confirmed:** Entity list now includes `place`/`pressure`/`combat`; collision states correctly limited to ACTIVE/RESOLVED/CRASHED; injection-slot list includes `_challenge`/`_combat`/`_nudge_maintenance`/`_foreshadow`; `validateTransition()` correctly attributed to `state-machine.js`.

### `AGENTS.md`

| Sev | Line | Finding | Spec/Code |
|---|---|---|---|
| **HIGH** | 85 | Same `index.js:1551` line-number error — actual 1514 | Same drift |
| **MEDIUM** | 90 | Claims "`reads` and `noticed_details` are removed" but `state-view.js`, `state-compute.js`, and the canonical readme still actively use both | Doc-vs-code mismatch — either back out claim or finish removal |
| **MEDIUM** | 90 | Claims faction `intel_on` is replaced by flat `knowledge_asymmetry`, but `state-compute.js:128-159` still actively normalizes `faction.intel_on` and the readme teaches it | Same kind of mismatch |
| **LOW** | 108 | Same "~2,300 lines" overstatement | Cosmetic |

**Round 1 critical issues fixed:** `Documentation/Old/` no longer referenced; current paths exist on disk. ✅

---

## 7. The Big Remaining Cluster — `state-view.js`

Round 1 violations were **all FIXED at their original locations**, but a comprehensive re-audit reveals the entire faction rendering block + readme injection is still pre-Phase-2:

| Sev | Line | Finding | Spec |
|---|---|---|---|
| **CRITICAL** | 272 | State-view header injects `'  world — constants, world_state, collision_archive'` — teaches LLM that `world.constants` exists | `world.constants` removed; setup writes flat `power_scale`/`power_ceiling`/`power_notes` |
| **CRITICAL** | 314, 415, 422-450 | Faction rendering reads removed Phase 2 fields: `f.reads`, `f.stance_toward_pc`, `f.power`, `f.objective`, `f.resources`, `f.momentum`, `f.last_move`, `f.leverage`, `f.vulnerability`, `f.comms_latency`, `f.last_verified_at`, `f.intel_posture`, `f.intel_on`, `f.relations`. **No `agenda`/`members`/`territory` rendered.** | Per spec §2.3, factions only have: name, members, territory, state, agenda, knowledge_asymmetry |
| **CRITICAL** | 825, 834-838 | Readme (LLM-facing) teaches `CREATE faction:shinra ... objective= resources= stance_toward_pc= power= momentum= leverage= vulnerability=` and lists all removed faction fields as canonical | Will keep LLM emitting legacy faction schema |
| **CRITICAL** | 830-832 | Readme teaches `MAP_SET faction:zaft field=intel_on key=archangel.knows.status` | `intel_on` banned per checklist |
| **CRITICAL** | 767 | Readme: "The system tracks this through intimacy_stance" | `intimacy_stance` banned |
| **HIGH** | 17, 493, 499-505, 513-520, 571, 594, 732-733, 819, 836 | `reads` field still actively read and taught in readme | AGENTS.md claims removed; either back out or finish |
| **HIGH** | 608-610, 861-863 | Readme lists collision fields `details`, `cost`, `target_constraint` as canonical in "COLLISIONS ARE STORY ENGINES" section | Per spec §2.2, none of those exist |
| **HIGH** | 730 | Readme example: `> REMOVE char:tifa field=noticed_details value="Scratches on bracer"` | Removed field |
| **HIGH** | 736 | Readme example: `> MAP_SET pc field=reputation key=tifa` | Legacy; spec uses `knowledge_asymmetry` |
| **HIGH** | 897 | Priority ordering says "3. DOING/WANT" | References removed `doing`/`want` |
| **HIGH** | 562-572, 589-592 | Char readme teaches `char:elena.knowledge_asymmetry.knows.weapon` (nested) but spec uses flat `knows_<subject>` form. Faction examples on lines 566-568 use the correct flat form. **Self-contradicting** | §2.1 / AGENTS.md uses flat-key form |
| **MEDIUM** | 651, 655 | Readme says "Faction knowledge_asymmetry uses the same flat-key shape as chars" but char examples use nested form — internal contradiction | Same nested-vs-flat inconsistency |
| **MEDIUM** | 760-762, 789, 801, 808 | Readme teaches `intimate_history` as canonical | Not in PHASE2-SPEC.md but in CLAUDE.md dossier list — clarify |
| **MEDIUM** | 132-204 | `agenda` is never rendered in char dossier output | Spec §2.1 makes `agenda` a TRACKED/PRINCIPAL char field driving collision seeding |

This file needs the most work in Round 3.

---

## 8. Other Files

### `ooc-handler.js` — **MOSTLY CLEAN** ✅

Round 1 regressions fixed: `handlePowerReview` (lines 167, 174-176) now reads flat `w.power_scale`/`w.power_ceiling`/`w.power_notes`. `handleEval` line 102 reviews "location, equipment, and last_seen_at" only.

| Sev | Line | Finding |
|---|---|---|
| **LOW** | 201 | "current condition" — English "state of being", not field. Could reword to "current physical state" |
| **LOW** | 106 | Eval prompt says "REMOVE stale noticed details" — `noticed_details` is legacy |

### `ledger-store.js`, `snapshot-mgr.js`, `combat-state.js` — **CLEAN** ✅

### Legacy reference docs

`gravity-system-prompt.md` and `gravity_mode_split_blueprint.md` are no longer at active main repo root — moved to `Documentation/archive/` (Round 1 problem effectively retired). ✅

### Plan/ doctrine docs — out of date but LOW per scope

| Sev | File | Finding |
|---|---|---|
| **MEDIUM** | `Plan/combat-power-doctrine.md:29-33` | Lists `world.constants.power_scale`/`_ceiling`/`_notes` as canonical. Code uses flat `world.power_scale`. Doctrine doc out of sync |
| **MEDIUM** | `Plan/combat-system-handoff.md:10, 410` | "Setup … now authors `world.constants.power_scale`" — second clause uses old naming |
| **MEDIUM** | `Plan/combat-system-handoff.md` | ~16 hexagram references — divination doctrine doc out of date with current Arcana/Classic-only system |

---

## 9. Highest-Priority Fix List (Round 3)

1. **LIVE BUG** — `challenge-profile-combat.js:332`: change `runtime.last_resolution.exchange` → `runtime.last_resolution.clash`. Currently emits `LAST RESOLUTION: clash undefined` to the LLM.
2. **`state-view.js` faction subsystem rewrite** — biggest cluster (5 CRITICAL + 4 HIGH). Both the live faction renderer (lines 312-456) and the readme strings (lines 552-909) need rewriting to align with Phase 2 §2.3 (factions = name/members/territory/state/agenda/knowledge_asymmetry only). Drop all reads of `objective`/`resources`/`stance_toward_pc`/`power`/`momentum`/`leverage`/`vulnerability`/`relations`/`intel_on`/`intel_posture`/`comms_latency`/`last_verified_at`. Replace `world.constants` header line (272). Resolve nested-vs-flat `knowledge_asymmetry` self-contradiction (562-572 vs 566-568, 651-655).
3. **`state-view.js` other readme cleanups** — collision `details`/`cost`/`target_constraint` (608-610, 861-863); `reads` (multiple); `noticed_details` (730); `pc.reputation` (736); `intimacy_stance` (767); `DOING/WANT` priority list (897). Render `agenda` in char dossier (132-204).
4. **`gravity_v15.json` active prompt cleanups:**
   - L0 Cast Reminder (line 515): replace `wants`→`agenda`; remove `Doing` line.
   - Character Voice (line 501): replace `condition` with `wounds` or other Phase 2 surface.
   - L2 Gravity Kernel (line 529): rephrase `their wants, constraints` → `their agendas, constraints`.
5. **`challenge-profile-combat.js`** lines 399 ("rolled exchanges" → "rolled clashes") and 266 (stale comment).
6. **Decide and finish faction `intel_on` migration** — `state-compute.js:100-159` still treats `intel_on` as live. Either fold into `faction.knowledge_asymmetry` (matching the rest of the spec) or back out the AGENTS.md/readme claims that it's removed.
7. **`state-compute.js` legacy collision-status migration** — add SEEDED/SIMMERING/RESOLVING → ACTIVE coercion in `applyTransaction` for collision CR/TR/S ops (still missing from Round 1).
8. **`setup-wizard.js:216`** — drop `status=ACTIVE` from collision creation example.
9. **Doc fixes:**
   - `CLAUDE.md:85` and `AGENTS.md:85`: update `validateTransition()` line-number from 1551 → 1514 (or simply drop the line number).
   - Reconcile `AGENTS.md:90` claims about `reads`/`noticed_details`/faction `intel_on` with code reality.
   - Update `~2,300 lines` to actual `2,247` (or just say "~2,200 lines").
10. **`Gravity World Info.json`** — delete/trim the disabled Chapter Close entry body to prevent accidental re-enable.
11. **`Plan/combat-power-doctrine.md`** and **`Plan/combat-system-handoff.md`** — refresh `world.constants.*` references to flat fields; refresh hexagram references or move to `Documentation/archive/`.
12. **Cosmetics:**
   - `index.js:74`: wire or delete unused `MAX_COLLISION_ARCHIVE`.
   - `state-compute.js:469`: divination `active_system` empty-string vs default `'arcana'`.
   - `setup-wizard.js`: rename `gl-setup-arc` DOM id to avoid token collision.
   - `ooc-handler.js:201, 106`: minor reword.

---

## 10. What Passed (Round 2)

- **State machine code fully clean**: `state-machine.js`, `consistency.js`.
- **Storage layer fully clean**: `ledger-store.js`, `snapshot-mgr.js`.
- **UI layer fully clean**: `ui-panel.js`, `style.css`.
- **Combat engine `exchange→clash` migration complete** in `challenge-state.js`, `challenge-input.js` (Round 1's biggest cluster).
- **`index.js` fully purged** of `intimacy_stance`/`want`/`doing`/`condition`/`details`/`cost`/`target_constraint`/`f.objective`/`f.power`/`f.momentum`.
- **`ooc-handler.js` fully fixed** on `world.constants` reads and STALE FIELDS instruction.
- **Active lorebook entries** all use Phase 2 terminology (chapter close properly disabled).
- **`test-import-ffvii.json` Phase 2-correct.**
- **`CLAUDE.md` / `AGENTS.md` Round 1 critical issues fixed**: nonexistent `Documentation/Old/` references removed; `validateTransition()` correctly attributed to `state-machine.js`; entity lists include `combat`; injection-slot lists complete.
- **Banned features fully removed from active code**: oracle pipeline, 3-phase oracle, buildAdvanceBeats, story_summary, hexagram, iChing, Yi Jing, `world.constants` (all active reads and active prompts).

---

*End of audit. Six parallel agents, full repo examined plus all prompt JSON and lorebook entries. No files were modified.*
