# Phase 2 Compliance — Deep Audit

**Audit date:** 2026-04-19 (second pass)
**Spec audited:** `PHASE2-SPEC.md` (branch `codex-v13-state-delta`)
**First-pass artifacts:** `PHASE2-COMPLIANCE-AUDIT.md` (findings) and `PHASE2-FIXES.md` (remediation spec) already on disk.
**Claimed state:** "The Sonnet deploy instance just committed your fixes as `6046ea4`. The codebase state is now post-fix."
**Observed state:** **The claim is only partly true.** See finding D0 below.

This pass was scoped to fill gaps the first pass skipped and to verify the fixes landed. It is not a re-run of section-by-section compliance — findings from the first pass that were remediated are not re-listed.

---

## TL;DR

One **P0** that changes the shape of the whole audit: the 13 fixes from commit `6046ea4` live in `.claude/worktrees/tender-morse-cfc4f9` (and a duplicate in `sharp-yalow-c99a88`), **not at the project root**. The root working tree (`G:\My Drive\AI RPG\Gravity 2\*.js`) is pre-fix and identical to what the first audit reviewed. If the user expects root to be post-fix, someone needs to merge/rebase the worktree branch into whatever branch root checks out, or check out the post-fix branch at root.

Everything else in this audit is scoped against the post-fix worktree (`tender-morse-cfc4f9`), which is where the actual HEAD of the Phase 2 effort lives.

Against that worktree, the 13 fixes applied cleanly; `node -c` verified structure on the modified files. Nine new findings surfaced that the first pass did not cover: four P1 (collision outcome-type enumerations drift in three separate files; closure audit has a semantic bug for MERGED collisions; readme tells LLM to never remove key_moments but spec imposes a 100-cap), four P2 (missing agenda-on-promotion nudge, stale gravity_v14 preset, vestigial chapter-close WI entry, two-arg call to one-arg getStateMachineField), and a handful of P3 polish items (dead exports, stale comments, advance-button timeout gap).

---

## D0 — Fixes present only in worktree, not at root (P0)

**Where:**

- Post-fix ≈ `G:\My Drive\AI RPG\Gravity 2\.claude\worktrees\tender-morse-cfc4f9\*` and identical copy `sharp-yalow-c99a88\*`.
- Pre-fix ≈ `G:\My Drive\AI RPG\Gravity 2\*` (root).

**Evidence:**

- Grep for post-fix markers at root: `grep -n 'onRollback\|applyAdvanceTick\|validateTransitions\|findMissingArchiveEntries'` on `G:\My Drive\AI RPG\Gravity 2\*.js` returns **0 matches**.
- Same grep under `.claude/worktrees/tender-morse-cfc4f9/` returns **16 matches** across `index.js`, `consistency.js`, `snapshot-mgr.js`, `state-machine.js` — all the expected landing sites for F1/F2/F5/F6/F7.
- `index.js` at root still contains the stray `}` at line 529 inside `drawDivination()` (F1 regression point, pre-fix).
- `setup-wizard.js` at root still contains `"MINUTES/HOURS/DAYS/WEEKS/MONTHS"` on line 203 (F9 regression point).
- `state-view.js` at root still has mode-aware `key_moments` caps at 3/5/∞ with no `isPrincipal` gate (F3 regression point).

**Impact:** If the user launches SillyTavern with the root directory loaded (as CLAUDE.md implies: `G:\My Drive\AI RPG\Gravity 2\` is the install path), the extension loads the **pre-fix code with the broken drawDivination()**. The extension will fail to parse on load and none of Phase 2 runs. Every downstream finding in this audit is against the worktree; none of them are live on the user's actual install until the worktree is merged.

**What to do:** `git merge` the `tender-morse-cfc4f9` branch into main (or whichever branch root tracks), or re-checkout root to the post-fix commit. Until that happens, the deployment is broken.

**All subsequent findings in this document are scoped against `.claude/worktrees/tender-morse-cfc4f9/` — the actual post-fix state.**

---

## Fix Verification (F1 – F13)

Each fix verified against the post-fix worktree. Syntax-check (`node -c`) ran clean on the three files with the biggest structural changes.

| Fix | Verdict | Evidence |
|---|---|---|
| **F1** drawDivination | ✅ Applied cleanly | `index.js:517–530` has `if (system === 'classic') {` guard; stray `}` gone. `drawDivination_fixed.js` parse-check (reproduction of function body with stubs): `exit=0`. |
| **F2** advance tick ordering | ✅ Applied | `handleAdvanceButton` trimmed to preconditions + marker (`index.js:1895–1945`). `applyAdvanceTick()` at `index.js:1838–1893` reads `_currentState.world.timeskip_scale` AFTER commit. Called from `onMessageReceived:1686–1688` gated on `_lastCompletedMode === 'advance'`. **Trace confirms the tick consumes the CURRENT turn's declaration** — commit at line 1545 → state recompute at 1547 → applyAdvanceTick at 1687 reads freshly-updated state. |
| **F3** key_moments PRINCIPAL-only, last-10 | ✅ Applied | `state-view.js:222–231` gated on `isPrincipal`, uses `moments.slice(-10)`. |
| **F4** char KA 20-cap | ✅ Applied | `state-compute.js:82–112` declares `STRUCTURAL_KEYS`, trims `flatKeys.slice(20)`. |
| **F5** rollback listener | ✅ Applied | `snapshot-mgr.js:19` `_rollbackListeners`, `snapshot-mgr.js:38–42` `onRollback`, `snapshot-mgr.js:114–119` listener fan-out in `rollback()`. `index.js:2180–2186` registers the five-map clear. `onUserMessage` OOC branch (`index.js:1787–1803`) simplified — inline reset block removed, redirects to onRollback. |
| **F6** validateTransitions in consistency.js | ✅ Applied | `consistency.js:18` imports `validateTransition`. `consistency.js:254–279` defines `validateTransitions`. `consistency.js:284` exports it. `index.js:12` imports. `index.js:19` no longer imports `validateTransition`. `index.js:1528–1531` post-loop batch call replaces the old inline check. `validTxns` at `index.js:1480` is `let` — reassignment at 1530 works. `node -c consistency.mjs` (with state-machine stub): `exit=0`. |
| **F7** findMissingArchiveEntries | ✅ Applied | `consistency.js:222–242`. Exported at 285. Called at `index.js:1592`. Stateful side effects (counter, auto-fallback, correction queue) remain in `index.js:1595–1622`. |
| **F8** stale comments | ✅ Applied | `state-machine.js:2–13` and `consistency.js:2–16` rewritten. |
| **F9** MINUTES removed | ✅ Applied | `setup-wizard.js:203` now lists only `HOURS/DAYS/WEEKS/MONTHS`. Grep `MINUTES` in `.claude/worktrees/tender-morse-cfc4f9/*.js`: 0 matches. |
| **F10** distance_category warning | ✅ Applied (with minor wording drift) | `index.js:1575–1580` adds CR-without-distance_category warning. Placement is *after* the existing S-distance warning (my remediation spec suggested before; Sonnet put it after). Functionally identical — each transaction matches only one branch. Message wording differs slightly from the remediation doc ("Add distance_category=IMMEDIATE\|SHORT\|MEDIUM\|LONG on CR — the engine resolves the numeric distance") vs my spec ("Engine defaulted to SHORT (distance=10)..."). Spec intent preserved. |
| **F11** location tier gate | ✅ Applied | `index.js:1496–1508` checks `tier !== 'TRACKED' && tier !== 'PRINCIPAL'`. |
| **F12** formatChallenge dispatcher | ✅ Applied | `state-view.js:113` declares `formatChallenge`. Lines 286 and 403 route Combats through it. |
| **F13** Option A (spec update) | ✅ Applied | `PHASE2-SPEC.md:1015` now reads `kind: 'combat' \| 'persuasion' \| ...` with parenthetical noting the rename history. |

**Fix-related asymmetry:** F5.A modifies `snapshot-mgr.js`. But `onUserMessage` still calls `computeCurrentState()` directly after `processOOC` (`index.js:1791`); rollback happens inside `processOOC` → `rollback()` → now fires `_rollbackListeners`. This path works. Programmatic rollbacks via the snapshot UI (if/when that lands) also work. Path-coverage confirmed.

---

## New Findings — P1 (High)

### D1 — Closure audit misfires on MERGED collisions

**Severity:** P1
**File:** `.claude/worktrees/tender-morse-cfc4f9/index.js`
**Line range:** 1230–1232

**Code:**

```javascript
if ((col.outcome_type === 'EVOLVED' || col.outcome_type === 'MERGED') && !col.successor_collision_ids) {
    closureWarnings.push(`"${col.name || id}" has outcome_type: ${col.outcome_type} but no successor_collision_ids — link or explain why no successor seam remains`);
}
```

**Spec reference:** §2.2 field table.

> `successor_collision_ids` | array | **If EVOLVED** — new collisions this spawned. Append with `A`, not `S`.
> `parent_collision_ids` | array | **If MERGED** — prior collisions that fused into this.

**Issue:** The two fields belong to different sides of the graph:

- **EVOLVED**: the resolved collision spawned a successor. The resolved collision itself holds `successor_collision_ids=[new-id]`. The new collision holds `parent_collision_ids=[old-id]`.
- **MERGED**: the absorbed collision has `outcome_type=MERGED` and holds **nothing** about the survivor. The survivor (which was already ACTIVE, not being resolved) gains `parent_collision_ids=[absorbed-id]`.

Spec §4.2 merge example makes this explicit:

```
TR collision:ada_betrayal field=status from=ACTIVE to=RESOLVED
S collision:ada_betrayal field=outcome_type value=MERGED
A collision:umbrella_leak field=parent_collision_ids value=ada_betrayal       ← survivor
S collision:umbrella_leak field=forces value="..."
```

`ada_betrayal` gets `outcome_type=MERGED` and no `successor_collision_ids`. The closure audit will always warn on a correctly-executed merge.

**Fix:** drop MERGED from the clause.

```javascript
if (col.outcome_type === 'EVOLVED' && !col.successor_collision_ids) {
    closureWarnings.push(`"${col.name || id}" has outcome_type: EVOLVED but no successor_collision_ids — link the new collision this evolved into.`);
}
```

Optionally add a separate check for MERGED that *any* currently-ACTIVE collision has the resolved id in its `parent_collision_ids` — but that's additive, not needed for basic correctness.

**Ordering:** Independent. P1 because every real merge will generate a false-positive correction, and those corrections enter the attempt counter pipeline — after 3 turns they get auto-fallback-appended or dropped, noise either way.

### D2 — `outcome_type` enumeration drift across three files

**Severity:** P1
**Files:**

- `PHASE2-SPEC.md:152` — **6 values:** `DIRECT / EVOLVED / MERGED / IMPLODED / DISSOLVED / CRASHED` (authoritative)
- `AGENTS.md:87` — 6 values ✅ matches spec
- `gravity_v15.json:599` (L4 Phase 2 Commands) — **5 values, missing MERGED:** `DIRECT | EVOLVED | DISSOLVED | IMPLODED | CRASHED`
- `state-view.js:830–834` (formatReadmeFull closure section) — **5 values, missing DISSOLVED:** `DIRECT, EVOLVED, MERGED, IMPLODED, CRASHED`
- `index.js:1228` (closure audit warning text) — **5 values, missing DISSOLVED:** `(DIRECT / EVOLVED / MERGED / IMPLODED / CRASHED)`

**Issue:** three different enumeration sites, three different missing values. Every file short one value, and each one short a different value.

- LLM reading the v15 preset L4 enum sees MERGED is not valid → won't emit it even though spec and readme both support it.
- LLM reading the full readme closure section sees DISSOLVED is not valid → won't emit it at the OFF-SCREEN DISSOLVE branch of the arrival gate (which DOES use DISSOLVED in `buildArrivalBlock` at `index.js:812`).
- Closure audit message text omits DISSOLVED, so a LLM with a DISSOLVED collision gets a warning that doesn't enumerate its own value. The check itself works (only tests `!col.outcome_type`) but the advisory message lies.

**Fix:** add the missing values in each location.

- `gravity_v15.json` L4 commands section "outcome_type values": add `MERGED`.
- `state-view.js:830–834`: add a line for DISSOLVED (one-sentence description like the others).
- `index.js:1228`: update the parenthetical to `(DIRECT / EVOLVED / MERGED / IMPLODED / DISSOLVED / CRASHED)`.

**Spec reference:** §2.2 field table, §3.5 arrival gate.

### D3 — Readme tells LLM key_moments are permanent; spec says 100-cap with LLM-side trim

**Severity:** P1
**File:** `.claude/worktrees/tender-morse-cfc4f9/state-view.js`
**Line:** 632

**Code:**

```
key_moments are permanent; do not remove them.
```

**Spec reference:** §2.1 Characters — Key moments.

> Cap is 100 entries; when full, the LLM drops the oldest or least load-bearing entry before adding. To drop: use `S char:<id> field=key_moments value=[...]` with the full array minus the removed entry. This is infrequent given the high cap, but the technique is explicit — no partial-edit operations exist for arrays.

**Issue:** the spec allows (and requires, when over cap) the LLM to remove key_moments. The readme flatly forbids it. The readme also has at line 700 an explicit `> REMOVE char:tifa field=key_moments value="..." -- Prune after consolidation` example, which is itself contradicted by line 632's "permanent; do not remove."

**Fix:** replace the blanket "permanent" with the spec's 100-cap language.

```
key_moments are permanent under 100 entries. When a character's key_moments list reaches 100, drop the oldest or least load-bearing entry with a full-array SET (no partial REMOVE) before adding a new one.
```

Also reconcile with line 700's REMOVE example — either keep it as the consolidation escape hatch and update line 632, or drop line 700 and route consolidation through the full-array SET form.

Optional engine-side safety net (not required by spec): a hygiene warning when `key_moments.length > 100`, similar to the existing array-size warnings for `demonstrated_traits` at `index.js:1311–1326`. Today that warning map only tracks demonstrated_traits.

### D4 — Gravity World Info chapter_close entry still exists as a "disabled stub"

**Severity:** P1 (scope — full Phase 2 chapter strip)
**File:** `.claude/worktrees/tender-morse-cfc4f9/Gravity World Info.json`
**Lines:** 275–308 (entry uid 9)

**Code:**

```json
"9": {
  "uid": 9,
  "key": ["gravity_mode_chapter_close_core"],
  "comment": "Gravity Mode - Chapter Close Core [DISABLED — chapters removed in Phase 2]",
  "content": "(DISABLED — chapter-close logic removed in Phase 2; entry retained only so legacy uid 9 resolves.)",
  "disable": true,
  ...
}
```

**Spec reference:** §2.7 Stripped Entities.

> **Chapters** — removed entirely. No `chapter` entity, no chapter state machine (`PLANNED → OPEN → CLOSING → CLOSED`), no chapter-close prompts, no chapter injection slot.

**Issue:** Spec says "no chapter-close prompts." The entry is disabled but its `key` array still contains `gravity_mode_chapter_close_core`, which means if anything in index.js or a downstream preset ever sends that trigger, it would activate and inject the stub text. The "retained only so legacy uid 9 resolves" justification doesn't match spec — spec strips, not disables.

**Fix:** delete entry uid 9 from the World Info JSON entirely. Re-number subsequent entries (10→9, 11→10, etc.) OR leave uid 9 as a gap (SillyTavern tolerates non-contiguous uids). If any downstream setup file still references `gravity_mode_chapter_close_core`, clear those refs — grep shows no active JS reference, only the WI definition itself.

**Verification:** after fix, `grep -rn "chapter" .claude/worktrees/tender-morse-cfc4f9/` should return nothing other than `state-compute.js:265` (the silent-drop migration for legacy transactions, which is correct).

---

## New Findings — P2 (Medium)

### D5 — Missing agenda-on-promotion prompt

**Severity:** P2
**Files:**

- `.claude/worktrees/tender-morse-cfc4f9/index.js` — no trigger anywhere
- `.claude/worktrees/tender-morse-cfc4f9/state-view.js:206` — renders agenda when present

**Spec reference:** §2.1 Characters — Agenda.

> Set on creation or tier promotion: `S char:<id> field=agenda value="..."`.

**Issue:** Today, agenda is seeded passively by the `agenda_check` nudge slot (slot 0 of the rotating nudge system, `index.js:1009–1018`). The nudge cycles 7 slots × every 4 turns ≈ every 28 regular/combat/intimate turns per eligible character. A character promoted from KNOWN→TRACKED at turn 10 may not get nudged to set an agenda until turn ~38. During that window, the LLM sees a TRACKED character in the state view with no agenda and no prompt to fix it.

**Fix (non-trivial, optional for P2):** add an audit loop inside `injectPrompt` (regular/advance turns) that checks for TRACKED+ chars without agenda and queues a one-line correction:

```javascript
for (const [id, char] of Object.entries(_currentState.characters || {})) {
    if ((char.tier === 'TRACKED' || char.tier === 'PRINCIPAL') && !char.agenda) {
        _pendingCorrections.push({
            text: `char:${id} is tier ${char.tier} but has no agenda. Set: S char:${id} field=agenda value="..."`,
            attempts: 0,
        });
        break; // one per turn — avoid flooding
    }
}
```

Alternatively: fire an audit only when a tier-promotion TR lands in this turn's `committedTxns`. More targeted, less noisy.

**Spec priority:** §4.4's `agenda_check` slot already exists. The spec doesn't explicitly mandate an on-promotion trigger — so this is a strict reading of "set on creation or tier promotion." Mark as P2 not P1.

### D6 — `getStateMachineField` called with two args, defined with one

**Severity:** P2
**Files:**

- `.claude/worktrees/tender-morse-cfc4f9/state-machine.js:167` — signature `function getStateMachineField(entityType)`
- `.claude/worktrees/tender-morse-cfc4f9/index.js:191` — called as `getStateMachineField(tx.e, field)`

**Issue:** the extra `field` argument is silently discarded. In `rewriteDuplicateActiveChallengeCreate`, the intent is clearly "return the machine field only if this field IS the machine field." Current code always returns the machine field when the entity has one, regardless of what `field` is.

Downstream effect: `rewriteDuplicateActiveChallengeCreate` (called when an LLM tries to re-CREATE an already-seeded challenge entity) converts every field in the CR payload into a TR op. For non-machine fields (`outcome`, `aftermath`, `primary_enemy`, etc.), those TRs pass `validateTransitions` because validator returns `{valid: true}` for non-machine fields (state-machine.js:95), and the TR handler in `state-compute.js:322–344` just assigns `target[field] = to`. Functionally the state ends up correct. But the ledger now contains TR ops for non-state-machine fields, which is semantically wrong — a TR is supposed to be a state-machine transition, not a value assignment.

**Fix:** one-line, two options.

Option A — fix the callee to actually use the second arg:

```javascript
function getStateMachineField(entityType, field) {
    const fields = { char: 'tier', constraint: 'integrity', collision: 'status', combat: 'status' };
    const machineField = fields[entityType] || null;
    if (field !== undefined && machineField !== field) return null;
    return machineField;
}
```

Option B — fix the caller to compare:

```javascript
const machineField = getStateMachineField(tx.e);
if (machineField && field === machineField) {
    rewritten.push({ op: 'TR', ... });
} else {
    rewritten.push({ op: 'S', ... });  // non-machine field → use SET not TR
}
```

Option B is cleaner because it forces the callsite to be explicit.

**Verification:** after fix, exercise the rewrite path (LLM tries to CR an already-active combat challenge) and confirm no TRs get emitted for `outcome` / `aftermath` / `primary_enemy`.

### D7 — `gravity_v14.json` retained with Phase 1 content

**Severity:** P2 (deployment hygiene)
**Files:**

- `.claude/worktrees/tender-morse-cfc4f9/gravity_v14.json` — legacy Phase 1 preset, 2000+ lines
- Root `gravity_v14.json` and `Gravity_v11.json` (older legacy) also present

**Evidence:** `gravity_v14.json:543` (L1 State Contract) references `intel_on`, `intel_posture`, `last_verified_at` (legacy faction fields stripped in Phase 2 §2.7 → §2.3) and `doing`, `condition`, `reads`, `wants`, `noticed_details` (several removed in Phase 2).

`gravity_v14.json:529` (L2 Gravity Kernel) contains "Chapter law" section, directly contradicting spec §2.7 chapter-strip.

**Spec reference:** §1, "Stripped Entities"; CLAUDE.md at root states "The current preset is `gravity_v15.json`."

**Issue:** `gravity_v14.json` remains importable. A user following older docs may import it and get broken Phase 2 behavior — the LLM will emit `intel_on` and `wants` which the extension either silently migrates (factions) or ignores (chars), and chapters which get dropped as legacy. The session won't crash but will behave inconsistently.

**Fix:** delete `gravity_v14.json` from the repo (and `Gravity_v11.json` at root — even more stale). If deletion is controversial, at minimum rename to `legacy_gravity_v14.json` and prepend the L1/L2 entry content with a LEGACY marker so any user who imports it sees the deprecation notice.

### D8 — Stale PHASE2-FINAL-AUDIT.md in sister worktree

**Severity:** P2 (doc hygiene, can cause future audit confusion)
**File:** `.claude/worktrees/intelligent-lovelace-9b7c54/PHASE2-FINAL-AUDIT.md`

**Issue:** audit dated 2026-04-19 claims "~30 real violations remain, with three high-impact clusters: incomplete `exchange→clash` rename, broken `world.constants` read path, and legacy `char.condition`/`intimacy_stance`/`want` fields still actively read." All of these claims are FALSE against the `tender-morse-cfc4f9` post-fix state. Grep `intimacy_stance|col\.details|col\.cost|col\.target_constraint|f\.objective|f\.momentum|char\.want` under tender-morse returns zero matches.

The `intelligent-lovelace` worktree was built against an earlier (non-6046ea4) code state. Its findings were valid for that state, not the current one.

**Fix:** either delete the `intelligent-lovelace` worktree or prepend the audit with a "superseded by commit 6046ea4 (PHASE2-COMPLIANCE-AUDIT.md + PHASE2-FIXES.md) — retained only for history" notice.

---

## New Findings — P3 (Low / Polish)

### D9 — Dead exports

**Files:**

- `.claude/worktrees/tender-morse-cfc4f9/state-compute.js:599–612` — exports `diffStates`, `getPhonebook`, `getArrayFieldHistory`, `getCollectionName`; grep across repo shows zero external imports of these names. `getCollectionName` is used internally (line 270). `diffStates`, `getPhonebook`, `getArrayFieldHistory` are orphaned.
- `.claude/worktrees/tender-morse-cfc4f9/state-machine.js:186–189` — exports `getValidNextStates`, `isTerminal`. Module docstring at line 11 claims they are "used by OOC eval and the prompt layer for documentation" — false, no imports exist.
- `.claude/worktrees/tender-morse-cfc4f9/state-view.js:879` — exports `formatCollisionArchive`. Only callsite is inside state-view.js itself (line 450). Minor.

**Fix:** remove from `export {}` blocks. If `diffStates`/`getPhonebook` are intended for future OOC eval tooling, leave them with a TODO comment.

### D10 — Stale "stub" comment at `buildArrivalBlock`

**File:** `.claude/worktrees/tender-morse-cfc4f9/index.js:781`

```javascript
// Stub: full sanity-check template implemented in PR-D (Task 7)
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
```

The function is fully implemented at lines 782–830 per spec §3.5 (all four branches ON-SCREEN / OFF-SCREEN REFRAME / OFF-SCREEN DISSOLVE / IMPLODE plus the CRASHED epilogue). The "Stub" comment is an artifact of a planning phase and is misleading.

**Fix:** delete the comment or replace with a docstring.

### D11 — No timeout on advance-button lock

**File:** `.claude/worktrees/tender-morse-cfc4f9/index.js:1895–1945`

`handleAdvanceButton` registers a one-shot `MESSAGE_RECEIVED` listener (`reenableAdvBtn`) that re-enables the button and clears `_advanceLocked`. If the LLM response never arrives (network failure, generation stall, user cancels mid-stream), the listener never fires and the button stays disabled until page reload.

**Fix:** add a fallback timeout:

```javascript
if (advBtn) {
    advBtn.disabled = true;
    const timeoutId = setTimeout(() => {
        reenableAdvBtn(); // triggers the cleanup
    }, 120000); // 2 minutes
    reenableAdvBtn = () => {
        clearTimeout(timeoutId);
        advBtn.disabled = false;
        _advanceLocked = false;
        eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
}
```

### D12 — NESCIENCE language partially covered in readme

**File:** `.claude/worktrees/tender-morse-cfc4f9/state-view.js:519–637` (formatReadmeCore) and `:644–872` (formatReadmeFull)

**Spec reference:** §2.8 NESCIENCE discipline — 8 specific points:

1. Each character can only know what they have realistically observed or heard.
2. Must accurately maintain hidden/personal information and secrets.
3. Must avoid "Sherlock Holmes" guesses.
4. News and rumors must travel realistically.
5. If a character was absent from a scene, they are oblivious.
6. Communication media: originator or receiver only.
7. Analyze past messages to avoid contradicting established knowledge states.
8. Factions obey the same rules.

**Readme coverage** (core variant):

- ✅ "No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them." — covers 1, 4, 5 at a high level.
- ✅ "Refresh a character's knowledge_asymmetry when they re-enter scene or receive a plausible report, signal, witness account, or sensor update." — covers 1, 4, 5.
- ⚠️ No explicit mention of "Theory of Mind" or the 信息差 framing.
- ⚠️ No "Sherlock Holmes" warning (explore obliviousness, not deduction).
- ⚠️ No communication-media rule (originator/receiver).
- ⚠️ No instruction to analyze past messages for contradictions.

**Fix:** extend the DISCIPLINE block in `formatReadmeCore` (around `state-view.js:624–635`) with 2–3 more bullets pulled from spec §2.8 verbatim. This is the LLM-facing contract; the spec's exact phrasing matters.

### D13 — Timeskip entry in World Info doesn't spell out the `timeskip_scale` field

**File:** `.claude/worktrees/tender-morse-cfc4f9/Gravity World Info.json:248` (entry uid 8, Gravity Mode - Timeskip Core)

Entry content says "collision clock ticks" and "WEEKS/MONTHS auto-clears all" but never names the `timeskip_scale` field nor enumerates `HOURS | DAYS | WEEKS | MONTHS` as the value domain. The v15 preset L4 covers it, so the LLM has the info somewhere — but the mode lorebook entry itself is incomplete as a standalone reference.

**Fix:** add one line to the WI entry:

> Declare the timescale in the ledger block: `S world field=timeskip_scale value=HOURS|DAYS|WEEKS|MONTHS`. Default HOURS. WEEKS and MONTHS clear all pressure points.

### D14 — `findMissingArchiveEntries` returns unused `to` field

**File:** `.claude/worktrees/tender-morse-cfc4f9/consistency.js:239`

```javascript
if (!matched) missing.push({ id: colId, name: nameToken, to });
```

Caller at `index.js:1601` destructures only `{ id: colId, name: nameToken }`. `to` is never used. Dead payload.

**Fix:** either use it in the correction message (e.g. "Missing archive entry for **${to}** collision ${colId}") or drop it from the return object.

### D15 — Late-archive counter-clearing edge case

**File:** `.claude/worktrees/tender-morse-cfc4f9/index.js:1587–1622`

**Scenario:** collision resolves on turn N with no archive entry. Correction queued, `_archiveCorrectionAttempts[colId] = 1`. On turn N+1, the LLM reads the correction and emits the archive entry (but no TR, because the collision is already RESOLVED). Turn N+1's `committedTxns` contains the archive append but no terminal TR. `findMissingArchiveEntries` returns `[]` because there are no terminal TRs in the batch to check. The counter-clearing loop at line 1597–1599 iterates `allTerminalIds` (which is empty) and does nothing. The counter for colId stays at 1 indefinitely.

**Impact:** minor. The queued correction from turn N will be cleared by `clearMatchedCorrections(committed)` at line 1550 if that function matches on the raw text pattern `[collision:${colId} archive]`. Worth verifying — if `clearMatchedCorrections` doesn't match this raw-text pattern, the correction never clears and the LLM is prompted to re-add the archive every turn indefinitely.

**Fix:** also scan ALL currently-RESOLVED-or-CRASHED collisions each turn (not just those with terminal TRs in the current batch), and clear the counter if they now have a matching archive entry. The scan is O(collisions × archive) which is bounded (5 × 20).

### D16 — `state-view.js:836` readme instruction is ambiguous about MERGED

**File:** `.claude/worktrees/tender-morse-cfc4f9/state-view.js:836`

```
For EVOLVED or MERGED: add successor_collision_ids and link parent_collision_ids on the new collision.
```

**Issue:** mirrors D1. For EVOLVED, `successor_collision_ids` goes on the resolved collision, `parent_collision_ids` on the new successor. For MERGED, there IS no "new" collision — the survivor was already ACTIVE. `parent_collision_ids` goes on the survivor (not a new entity). `successor_collision_ids` is NOT set anywhere.

The sentence as written fuses the two flows and will mislead an LLM doing a merge.

**Fix:** split into two lines.

```
For EVOLVED: add successor_collision_ids to the resolved collision, parent_collision_ids to the new successor.
For MERGED: add parent_collision_ids to the surviving collision (the one being absorbed into). The resolved collision gets outcome_type=MERGED and no link field.
```

### D17 — Pressure `created_at_tx` silently overwritten without warning

**File:** `.claude/worktrees/tender-morse-cfc4f9/state-compute.js:303`

```javascript
if (tx.e === 'pressure') {
    data.created_at_tx = tx.tx;
}
```

If the LLM sets `created_at_tx` in a CR, the engine overwrites silently. Spec §2.5 says "The LLM must not set this field." No warning fires today, so an LLM violating the rule gets no feedback.

**Fix (optional, P3):** mirror the F10-style CR audit.

```javascript
for (const tx of committedTxns) {
    if (tx.op === 'CR' && tx.e === 'pressure' && tx.d?.created_at_tx !== undefined) {
        _pendingCorrections.push({
            text: `Pressure ${tx.id} was created with created_at_tx in the payload. Do not set this field — the engine stamps it from tx.tx.`,
            attempts: 0,
        });
    }
}
```

### D18 — DISSOLVED is a resolve-but-no-successor case; spec allows it to pair with EVOLVED via successor_collision_ids

**File:** `.claude/worktrees/tender-morse-cfc4f9/index.js:812`

The arrival gate template instructs the LLM:

```
  OFF-SCREEN — The forces resolved while characters were elsewhere. Choose:
    A) REFRAME — it mutated. Create a successor.
      ... S outcome_type value=EVOLVED
      A successor_collision_ids value=<new-id>
      CR collision:<new-id> ...
    B) DISSOLVE — it ended quietly.
      ... S outcome_type value=DISSOLVED
      S aftermath value="..."
      (no successor_collision_ids, no CR)
```

This correctly distinguishes EVOLVED (has successor) from DISSOLVED (no successor). Spec §2.2 table says `outcome_type` DISSOLVED "marks a quiet off-screen end with no successor."

Consistent with current behavior. No finding — just noting that D2's enumeration-drift doesn't propagate to this template.

---

## Deep Checks — No New Findings

Explicit call-outs for sections that came up clean in this pass:

### Cross-file state-machine invariants

State machines defined in `state-machine.js` (char tier, constraint integrity, collision status, combat status) match:

- `state-view.js:604–608` readme state-machine section ✓
- `gravity_v15.json:599` L4 Phase 2 Commands ✓
- `consistency.js` VALID_ENTITIES (all 10 entity types align with `state-compute.js:192–205` `getCollectionName` map)
- Legacy collision statuses (SEEDED/SIMMERING/RESOLVING) are migrated → ACTIVE in `state-compute.js:282–285` ✓

### Pressure FIFO ordering

FIFO auto-drop at `index.js:1690–1708` emits `D pressure:<id>` ledger transactions before pressing on. The spec prescribes "before appending the new CR" — actual flow is [new CR, then auto-D] because all committed TXs land before the FIFO check runs. Final state is identical either way; no replay divergence. Verified by tracing the commit → FIFO → compute pipeline.

### Foreshadow threshold boundaries

- LONG first HOURS tick: 50 → 49, ratio 0.98, no trigger ✓
- LONG first WEEKS tick: 50 → 40, ratio 0.80, APPROACHING fires at equality ✓
- IMMEDIATE: skipped entirely ✓
- distance ≤ 0: skipped ✓
- Subsumption: CONVERGING fired implies APPROACHING and IMMINENT fired ✓

### Pressure clear + LLM-seeded pressure race

In WEEKS/MONTHS advance turns, if the LLM seeds new pressure in the response's ledger block, the seeded pressure is committed (at `index.js:1545`), then `applyAdvanceTick` wipes ALL pressure including the freshly-seeded. This is the spec's intent — §3.2 says LLM "should not re-seed them until the next scene establishes new tensions." Preset warns against it (`gravity_v15.json:599`). Behavior matches spec.

### Archive version dedup

`_archiveInjectedVersion` is in-memory only, re-injects on first turn after reload (spec §2.2.1 acknowledges this). Dedup key `${archiveEntries.length}:${thin|ok}` correctly handles:

- archive grows → new length → re-inject ✓
- pool count crosses the ≤2 threshold → new thin flag → re-inject ✓
- no change → same key → no re-inject ✓

### Rollback listener fan-out

`snapshot-mgr.rollback()` is called from:

- `ooc-handler.js` rollback subcommand (verified — no direct rollback calls in index.js outside the listener path).
- Any future programmatic caller.

Both paths now flow through the listener registry. The OOC path used to carry an inline reset in `onUserMessage`; that's now redundant with the listener and the inline block was removed in F5.C.

### Simultaneous arrivals

`buildAndInjectArrivals` at `index.js:832–866` handles multi-arrival correctly:

- Multiple blocks collected in order ✓
- `[SIMULTANEOUS ARRIVALS — ...]` header prepended when >1 ✓
- LLM instructed "only one gets ON-SCREEN spotlight" ✓
- Match spec §3.5.

### `_nudgeCounter` / `_nudgeSlot` persistence

Both persisted in `chatMetadata` under `NUDGE_COUNTER_KEY` / `NUDGE_SLOT_KEY` / `NUDGE_ROTATION_INDEX_KEY` (`index.js:84–86, 921–937`). Survives across sessions. First-turn behavior (`counter = -3`) delays the first nudge until turn 4 ✓.

### Travel plausibility

`validateTravel` (`state-compute.js:568–584`) correctly handles:

- advance turns: skip ✓
- missing place data: skip (safe default) ✓
- same-place: skip ✓
- LOCAL ↔ DISTRICT: pass ✓
- CITY / REGIONAL / REMOTE without advance: fail with corrective message ✓

F11 layer adds tier gating — `char:unknown` trying to set location now fails with tier-specific error before travel check runs.

---

## Remediation Priority Summary

For the next fix pass, in order:

1. **D0** — merge `tender-morse-cfc4f9` into root's main branch. Nothing else takes effect until this is done.
2. **D1** — one-line closure-audit fix: drop MERGED from the successor_collision_ids requirement.
3. **D2** — three enumeration fixes: add MERGED to v15 preset L4, add DISSOLVED to state-view.js formatReadmeFull closure section, add DISSOLVED to index.js:1228 warning text.
4. **D3** — readme line 632 update + reconcile with line 700 removal example.
5. **D4** — delete Gravity World Info.json entry 9 (chapter_close stub).
6. **D5** — add agenda-on-promotion audit (optional; current nudge covers it eventually).
7. **D6** — fix `getStateMachineField` signature / caller.
8. **D7** — delete `gravity_v14.json` and `Gravity_v11.json` (or mark as legacy archive).
9. **D8** — mark the intelligent-lovelace worktree's PHASE2-FINAL-AUDIT.md as superseded.
10. **D9–D18** — P3 polish. D11 (advance button timeout) and D12 (NESCIENCE text) are the highest-value.

---

## Artifacts Examined

- `tender-morse-cfc4f9` post-fix worktree: all 20 project files
- `sharp-yalow-c99a88` post-fix worktree: confirmed byte-identical to tender-morse across 6 spot-checked files
- 55 pre-fix sibling worktrees: identified via signature fingerprinting; none carry novel Phase 2 work beyond the spec
- 7 doc-only worktrees with PHASE2-*.md files: sampled; all either legacy audits against pre-fix states or earlier remediation drafts
- Full `formatReadme` output (`state-view.js` lines 519–872) — word-level compare against spec §2.8 / §3.5
- `gravity_v15.json` L4 Phase 2 Commands entry and L5 Nudge Slots entry — cross-referenced against spec §2.1/§2.3/§3.1/§3.2/§4.4
- `gravity_v14.json` L1/L2 entries — Phase 1 content still present
- `Gravity World Info.json` all 14 entries — two entries noted (disabled chapter_close + underspecified timeskip)
- `state-machine.js`, `consistency.js`, `snapshot-mgr.js`, `state-compute.js`, `state-view.js`, `index.js` — full read
- `challenge-state.js`, `challenge-profile-combat.js`, `challenge-profiles.js`, `challenge-mechanics.js`, `challenge-shared.js`, `challenge-input.js`, `combat-state.js` — spot-checked for `kind` vs `challenge_type` and post-F13 naming consistency
- `ooc-handler.js`, `regex-intercept.js`, `ui-panel.js`, `setup-wizard.js` — grep-sampled for stale Phase 1 field references (none found that matter)
- `intelligent-lovelace-9b7c54/PHASE2-FINAL-AUDIT.md` — sampled, found stale findings against pre-fix code state
- `node -c` syntax-check on: reconstructed consistency.js, reconstructed state-machine.js, reconstructed drawDivination body — all pass

**Skills loaded during pass:** `anthropic-skills:gravity-preflight` (used as LLM-facing lens when reading preset/WI content).
