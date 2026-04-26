# Phase 2 Deep-Audit — Remediation Fixes

**Source audit:** `PHASE2-DEEP-AUDIT.md` (second-pass findings)
**Spec:** `PHASE2-SPEC.md`
**Target:** project root, post-merge (commit `e18bcf3`). All paths below are `G:\My Drive\AI RPG\Gravity 2\<file>` unless otherwise noted.
**Scope:** every D-item from the deep audit except D0 (already resolved by the merge) and D18 (no-finding callout, nothing to do).

Apply order summary at the end. The doc is designed for a coding agent to open and work through mechanically — old/new code blocks are verbatim, line numbers verified against post-merge root.

---

## F-D1 — Closure audit misfires on MERGED collisions (P1)

**Finding:** MERGED collisions get absorbed into a survivor; `successor_collision_ids` belongs on EVOLVED only. Requiring it on MERGED produces a false-positive correction for every correctly-executed merge.

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 1230–1232

**Old code (exact):**

```javascript
                if ((col.outcome_type === 'EVOLVED' || col.outcome_type === 'MERGED') && !col.successor_collision_ids) {
                    closureWarnings.push(`"${col.name || id}" has outcome_type: ${col.outcome_type} but no successor_collision_ids — link or explain why no successor seam remains`);
                }
```

**New code:**

```javascript
                if (col.outcome_type === 'EVOLVED' && !col.successor_collision_ids) {
                    closureWarnings.push(`"${col.name || id}" has outcome_type: EVOLVED but no successor_collision_ids — link the new collision this evolved into.`);
                }
```

**Rationale:** Spec §2.2 field table — `successor_collision_ids` is documented as "If EVOLVED — new collisions this spawned"; `parent_collision_ids` is "If MERGED — prior collisions that fused into this" and lives on the *survivor*, not the absorbed collision. Spec §4.2 merge example (ledger block at lines 856–861 of `PHASE2-SPEC.md`) shows the MERGED collision ends with no successor field.

**Ordering:** Independent. Apply any time.

**Verification:**
- `node -c index.js` passes.
- Manual: commit a merge (`TR collision:X status ACTIVE→RESOLVED; S collision:X outcome_type MERGED; A collision:Y parent_collision_ids X`). Closure audit on next turn must NOT warn about `collision:X` needing `successor_collision_ids`.

---

## F-D2.A — Add `MERGED` to v15 preset L4 outcome_type enum (P1)

**Finding:** `gravity_v15.json` L4 Phase 2 Commands lists `DIRECT | EVOLVED | DISSOLVED | IMPLODED | CRASHED` (5 values). Spec §2.2 has 6; missing MERGED. LLM reading the preset strictly won't emit MERGED even though it's valid everywhere else.

**File:** `G:\My Drive\AI RPG\Gravity 2\gravity_v15.json`
**Line:** 599 (single long JSON string — search for the exact sentence below; it occurs once).

**Old code (exact substring inside the L4 entry's `"content"` string):**

```
`outcome_type` values: `DIRECT | EVOLVED | DISSOLVED | IMPLODED | CRASHED`.
```

**New code (substring replacement):**

```
`outcome_type` values: `DIRECT | EVOLVED | MERGED | DISSOLVED | IMPLODED | CRASHED`.
```

**Rationale:** Spec §2.2 field table lists all 6 outcome_type values. Spec §4.2 describes the merge flow using MERGED.

**Ordering:** Independent of F-D1 but logically paired with F-D2.B and F-D2.C (all three normalize the enum to the spec's 6-value set).

**Verification:**
- `node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"` passes — JSON still parses after the substring edit.
- `grep -n "DIRECT | EVOLVED | MERGED | DISSOLVED | IMPLODED | CRASHED" gravity_v15.json` returns exactly 1 match.
- `grep -c "MERGED" gravity_v15.json` is ≥ 1 (was 0 before).

---

## F-D2.B — Add `DISSOLVED` line to `formatReadmeFull` closure section (P1)

**Finding:** `state-view.js` closure section lists `DIRECT, EVOLVED, MERGED, IMPLODED, CRASHED` (5 values). Missing DISSOLVED. LLM reading the full readme at integration/timeskip turns won't see DISSOLVED as valid even though `buildArrivalBlock` uses it in the OFF-SCREEN DISSOLVE branch.

**File:** `G:\My Drive\AI RPG\Gravity 2\state-view.js`
**Line range:** 828–836 (inside `formatReadmeFull` template string)

**Old code (exact):**

```javascript
COLLISION CLOSURE (required on every RESOLVED transition):
  Every collision that reaches RESOLVED must record three fields:
  > SET collision:id field=outcome_type value=DIRECT     -- Player engaged and shaped the result
  > SET collision:id field=outcome_type value=EVOLVED    -- Resolution revealed a deeper tension
  > SET collision:id field=outcome_type value=MERGED     -- Multiple parent collisions fused into a composite successor event
  > SET collision:id field=outcome_type value=IMPLODED   -- Collision collapsed internally (betrayal, self-destruction, internal failure before it reached the player)
  > SET collision:id field=outcome_type value=CRASHED    -- Player ignored it; gravity resolved it; worst outcome
  > SET collision:id field=aftermath value="What changed. What was lost. What it left behind."
  For EVOLVED or MERGED: add successor_collision_ids and link parent_collision_ids on the new collision.
```

**New code:**

```javascript
COLLISION CLOSURE (required on every RESOLVED transition):
  Every collision that reaches RESOLVED must record three fields:
  > SET collision:id field=outcome_type value=DIRECT     -- Player engaged and shaped the result
  > SET collision:id field=outcome_type value=EVOLVED    -- Resolution revealed a deeper tension; a successor collision spawned
  > SET collision:id field=outcome_type value=MERGED     -- This collision was absorbed into another active collision
  > SET collision:id field=outcome_type value=DISSOLVED  -- Off-screen end with no successor; forces dispersed quietly
  > SET collision:id field=outcome_type value=IMPLODED   -- Collision collapsed internally (betrayal, self-destruction, internal failure before it reached the player)
  > SET collision:id field=outcome_type value=CRASHED    -- Player ignored it; gravity resolved it; worst outcome
  > SET collision:id field=aftermath value="What changed. What was lost. What it left behind."
  For EVOLVED: add successor_collision_ids on this collision; add parent_collision_ids on the new successor.
  For MERGED: add parent_collision_ids on the surviving (still-ACTIVE) collision pointing back to this one. No successor_collision_ids on the merged collision — it was absorbed, not spawned.
  For DISSOLVED / IMPLODED / CRASHED: no successor/parent linkage.
```

**Rationale:** Spec §2.2 field table (all 6 values) + §3.5 arrival gate (uses DISSOLVED explicitly in the OFF-SCREEN DISSOLVE branch) + §4.2 merge flow (parent on survivor, not successor on merged). The replacement also resolves D16 (state-view.js:836 ambiguous EVOLVED/MERGED instruction) by splitting the guidance per outcome type.

**Ordering:** Independent of F-D1 but paired with F-D2.A and F-D2.C. Applying this subsumes F-D16 (see below — F-D16 is marked "already covered by F-D2.B" in the P3 section).

**Verification:**
- `node -c state-view.js` passes.
- `grep -c "DISSOLVED" state-view.js` is ≥ 2 (was 0 before; 1 from this fix + 1 from path reference at line 582).
- Load extension, trigger integration turn, confirm readme rendered to injection slot includes the DISSOLVED line.

---

## F-D2.C — Add `DISSOLVED` to closure-audit warning text (P1)

**Finding:** `index.js:1228` warning lists `DIRECT / EVOLVED / MERGED / IMPLODED / CRASHED` (5 values). When a collision lands at outcome_type=DISSOLVED (legitimate per spec), the warning text misrepresents the valid set. The check itself works (just tests truthy), but the advisory message lies.

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line:** 1228

**Old code (exact):**

```javascript
                if (!col.outcome_type) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing outcome_type (DIRECT / EVOLVED / MERGED / IMPLODED / CRASHED)`);
```

**New code:**

```javascript
                if (!col.outcome_type) closureWarnings.push(`"${col.name || id}" is RESOLVED but missing outcome_type (DIRECT / EVOLVED / MERGED / DISSOLVED / IMPLODED / CRASHED)`);
```

**Rationale:** Spec §2.2 — 6 values. `AGENTS.md:87` already matches spec. Aligns index.js with it.

**Ordering:** Independent of F-D1. Paired with F-D2.A and F-D2.B.

**Verification:**
- `node -c index.js` passes.
- `grep -n "DIRECT / EVOLVED / MERGED / DISSOLVED / IMPLODED / CRASHED" index.js` returns 1 match.

---

## F-D3 — `key_moments` readme reconciliation (P1)

**Finding:** `state-view.js:632` reads "key_moments are permanent; do not remove them." This contradicts spec §2.1 which caps at 100 with LLM-side trimming. Line 700 in the same file actually has a REMOVE example ("Prune after consolidation") which contradicts the "permanent" assertion.

**File:** `G:\My Drive\AI RPG\Gravity 2\state-view.js`
**Line ranges:** 632 (core readme DISCIPLINE block) and 696–700 (full readme REMOVE example)

### F-D3.A — Update DISCIPLINE line to the spec's 100-cap rule

**Old code (exact — line 632):**

```javascript
  key_moments are permanent; do not remove them.
```

**New code:**

```javascript
  key_moments are permanent under 100 entries per character. When a character's key_moments list hits 100, drop the oldest or least load-bearing entry with a full-array SET (not a partial REMOVE) before adding a new one. This is infrequent given the high cap.
```

### F-D3.B — Update the REMOVE example in full readme to be consolidation-only

**Old code (exact — lines 696–700):**

```javascript
APPEND — add to an array field
  > APPEND char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud about memories at the well." -- Pivotal scene
  > APPEND world field=collision_archive value="[collision] Ada betrayal [resolution] on-screen — PC caught her at the handoff [hook] the flash drive she dropped; eye contact [aftermath] trust cracked" -- Resolved collision

REMOVE — remove from an array field
  > REMOVE char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud at the well." -- Prune after consolidation
```

**New code:**

```javascript
APPEND — add to an array field
  > APPEND char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud about memories at the well." -- Pivotal scene
  > APPEND world field=collision_archive value="[collision] Ada betrayal [resolution] on-screen — PC caught her at the handoff [hook] the flash drive she dropped; eye contact [aftermath] trust cracked" -- Resolved collision

REMOVE — remove from an array field
  > REMOVE faction:shinra field=members value="char:tseng" -- Member departed
  (key_moments are only trimmed via full-array SET at the 100-cap boundary; no partial REMOVE.)
```

**Rationale:** Spec §2.1 (Characters — Key moments) — "Cap is 100 entries; when full, the LLM drops the oldest or least load-bearing entry before adding. To drop: use `S char:<id> field=key_moments value=[...]` with the full array minus the removed entry. This is infrequent given the high cap, but the technique is explicit — no partial-edit operations exist for arrays."

**Ordering:** F-D3.A before F-D3.B to keep the edits in file order. Both independent of everything else.

**Verification:**
- `node -c state-view.js` passes.
- `grep -n "key_moments are permanent" state-view.js` returns 0 matches (old string gone).
- `grep -n "100 entries per character" state-view.js` returns 1 match.
- `grep -n "REMOVE char:tifa field=key_moments" state-view.js` returns 0 matches (old example gone).

---

## F-D4 — Remove chapter_close entry from World Info JSON (P1)

**Finding:** `Gravity World Info.json` entry uid 9 is a disabled stub for `gravity_mode_chapter_close_core`. Spec §2.7 strips chapters entirely; the entry shouldn't exist at all.

**File:** `G:\My Drive\AI RPG\Gravity 2\Gravity World Info.json`
**Line range:** 274–308 (the closing brace of entry 8 through the closing brace of entry 9, plus the comma between them)

**Decision:** delete the entry entirely. UID gaps (9 missing, 10 present) are tolerated by SillyTavern — the WI loader doesn't require contiguous UIDs. Re-numbering 10→9, 11→10, … would touch every subsequent entry and risk breaking any external reference to a specific UID (lorebook trigger keys reference `gravity_mode_*` keys, not UIDs, so key-based triggers are unaffected).

**Old code (exact — starting at the closing `}` of entry 8, includes the comma, full entry 9 block, and trailing comma before entry 10):**

```javascript
      "automationId": ""
    },
    "9": {
      "uid": 9,
      "key": [
        "gravity_mode_chapter_close_core"
      ],
      "keysecondary": [],
      "comment": "Gravity Mode - Chapter Close Core [DISABLED — chapters removed in Phase 2]",
      "content": "(DISABLED — chapter-close logic removed in Phase 2; entry retained only so legacy uid 9 resolves.)",
      "constant": false,
      "vectorized": false,
      "selective": false,
      "selectiveLogic": 0,
      "addMemo": false,
      "order": 100,
      "position": 0,
      "disable": true,
      "excludeRecursion": true,
      "preventRecursion": true,
      "matchWholeWords": false,
      "caseSensitive": true,
      "matchPersonaDescription": false,
      "matchCharacterDescription": false,
      "matchCharacterPersonality": false,
      "matchCharacterDepthPrompt": false,
      "matchScenario": false,
      "matchCreatorNotes": false,
      "delayUntilRecursion": false,
      "scanDepth": null,
      "useProbability": false,
      "probability": 100,
      "depth": 4,
      "role": 0,
      "automationId": ""
    },
    "10": {
```

**New code (entry 8 closes, entry 10 follows directly):**

```javascript
      "automationId": ""
    },
    "10": {
```

(Result: the `entries` object goes from `"8": {...}, "9": {...}, "10": {...}, ...` to `"8": {...}, "10": {...}, ...`. The numeric key gap is intentional and harmless.)

**Rationale:** Spec §2.7 — "**Chapters** — removed entirely. No `chapter` entity, no chapter state machine (`PLANNED → OPEN → CLOSING → CLOSED`), no chapter-close prompts, no chapter injection slot."

**Ordering:** Independent. Apply any time.

**Verification:**
- `node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8'))"` passes — JSON parses after removal.
- `grep -n "gravity_mode_chapter_close" Gravity World Info.json` returns 0 matches.
- `grep -in "chapter" Gravity World Info.json` returns 0 matches (sanity check — no lingering chapter references).

---

## F-D5 — Agenda-on-promotion audit (P2)

**Finding:** A character promoted to TRACKED or PRINCIPAL with no agenda set can wait ~28 regular turns for the `agenda_check` nudge slot to cycle to it. Spec §2.1 says agenda is "Set on creation or tier promotion."

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Insertion location:** inside `onMessageReceived`, immediately after the distance-ownership audit (`line 1581`, after the closing `}` of the `for (const tx of committedTxns)` loop). Add a new loop that keys off the just-committed TR transactions.

**Old code (exact — lines 1567–1582):**

```javascript
    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Add distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR — the engine resolves the numeric distance.`,
                attempts: 0,
            });
        }
    }

    // ── Archive presence check (§2.2.1) ────────────────────────────────────────
```

**New code:**

```javascript
    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Add distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR — the engine resolves the numeric distance.`,
                attempts: 0,
            });
        }
    }

    // ── Agenda-on-promotion audit (§2.1) ──────────────────────────────────────
    // When a char is promoted to TRACKED or PRINCIPAL in this turn, require an
    // agenda. Fires once per promoted character; relies on the rotating
    // agenda_check nudge to catch drift after that.
    for (const tx of committedTxns) {
        if (tx.op !== 'TR' || tx.e !== 'char' || tx.d?.f !== 'tier') continue;
        const toTier = String(tx.d?.to || '').toUpperCase();
        if (toTier !== 'TRACKED' && toTier !== 'PRINCIPAL') continue;
        const char = _currentState?.characters?.[tx.id];
        if (!char || (typeof char.agenda === 'string' && char.agenda.trim())) continue;
        _pendingCorrections.push({
            text: `char:${tx.id} was promoted to ${toTier} but has no agenda. Set: S char:${tx.id} field=agenda value="..." — what this character is working toward.`,
            attempts: 0,
        });
    }

    // ── Archive presence check (§2.2.1) ────────────────────────────────────────
```

**Rationale:** Spec §2.1 Characters — Agenda: "Set on creation or tier promotion." This fires exactly once per promotion TR and only if the character still lacks agenda after the turn's commits (in case the LLM both promoted and set agenda in the same block, it's a no-op).

**Ordering:** Independent. Apply after F-D4.

**Verification:**
- `node -c index.js` passes.
- Manual: `TR char:x tier KNOWN→TRACKED` without a paired `S char:x agenda`. Next turn's correction injection must include "was promoted to TRACKED but has no agenda."
- Manual: `TR char:y tier KNOWN→TRACKED` PAIRED with `S char:y field=agenda value="..."` in the same ledger block. No correction should fire for `y`.

---

## F-D6 — Fix `getStateMachineField` arg-count mismatch (P2)

**Finding:** `index.js:191` calls `getStateMachineField(tx.e, field)` (2 args). `state-machine.js:167` defines `getStateMachineField(entityType)` (1 arg). Extra arg silently ignored → `rewriteDuplicateActiveChallengeCreate` generates TR ops for non-state-machine fields, polluting ledger op semantics (state ends up correct, but `outcome` / `aftermath` / `primary_enemy` assignments land as TR instead of S).

**Decision: fix the callee (state-machine.js).** Rationale:

1. The spec places authority in `state-machine.js` (§6.1 key-file table). Adding field-aware semantics to the canonical API keeps the semantics owned by the state machine.
2. One change point vs updating every caller (current callers: `index.js:191, 696`; both have different needs).
3. Preserves backward compatibility — 1-arg callers still work (returns the machine field unconditionally). 2-arg callers get the tightened semantic.

### F-D6.A — Extend `getStateMachineField` signature

**File:** `G:\My Drive\AI RPG\Gravity 2\state-machine.js`
**Line range:** 162–175

**Old code (exact):**

```javascript
/**
 * Get the state machine field name for an entity type.
 * @param {string} entityType
 * @returns {string|null}
 */
function getStateMachineField(entityType) {
    const fields = {
        char: 'tier',
        constraint: 'integrity',
        collision: 'status',
        combat: 'status',
    };
    return fields[entityType] || null;
}
```

**New code:**

```javascript
/**
 * Get the state machine field name for an entity type.
 * Two call modes:
 *   1-arg — return the machine field (or null) for this entity type.
 *   2-arg — return the machine field ONLY if `field` matches it; otherwise null.
 * The 2-arg form is convenient for callers that want "is this TX targeting the
 * state-machine field?" — answer is truthy iff this entity has a machine AND
 * the caller's field matches.
 *
 * @param {string} entityType
 * @param {string} [field] - if provided, gate return on `field === machineField`
 * @returns {string|null}
 */
function getStateMachineField(entityType, field) {
    const fields = {
        char: 'tier',
        constraint: 'integrity',
        collision: 'status',
        combat: 'status',
    };
    const machineField = fields[entityType] || null;
    if (field === undefined) return machineField;
    return machineField === field ? machineField : null;
}
```

### F-D6.B — Verify callers (no code change needed)

Callers at `index.js:191` and `index.js:696` continue working:

- `index.js:191` `getStateMachineField(tx.e, field)` — now gets the field only if it matches the machine field. The surrounding `if (stateField)` branch will only fire for true state-machine fields. `rewriteDuplicateActiveChallengeCreate` will now correctly route non-machine fields (e.g. `outcome`, `aftermath`) through the `else` branch → `op: 'S'`. **This is the intended behavior.**
- `index.js:696` `getStateMachineField(entry.entityType)` — 1-arg call, unchanged behavior.

**Rationale:** Spec §6.1 — state machine transitions are the single enforcement point. The 2-arg form lets `rewriteDuplicateActiveChallengeCreate` correctly classify field updates as SET vs TR, preserving ledger op semantics (TR = state-machine transition only).

**Ordering:** Independent. Apply after F-D5.

**Verification:**
- `node -c state-machine.js` passes.
- `node -c index.js` passes.
- Manual: trigger `rewriteDuplicateActiveChallengeCreate` (LLM tries to re-CR an already-active combat entity with `{status: 'ACTIVE', outcome: '...'}`). In the resulting rewritten TX array, `outcome` should land as `op: 'S'`, not `op: 'TR'`. `status` should land as `op: 'TR'` if it differs from current.

---

## F-D7 — Delete legacy preset JSONs at root (P2)

**Finding:** Root contains `Gravity_v11.json`, `gravity_v13_c.json`, `gravity_v13_c_split.json`, `gravity_v14.json` — all pre-Phase 2 presets. `gravity_v14.json` explicitly carries Phase 1 content that contradicts Phase 2 (chapter law, intel_on, wants). `Gravity_v11.json` and the `v13_c*` variants are even older. `CLAUDE.md` names `gravity_v15.json` as canonical.

**Decision: delete.** Rationale:

- Spec §2.7 strips chapters entirely; the Phase 1 presets emit chapter transitions the engine now silently drops. A user loading v14 would get a preset that disagrees with the extension.
- Git history preserves them — `git log --diff-filter=D -- Gravity_v11.json` will always find them if archival access is needed.
- Renaming to `.archive` keeps them on disk as file ghosts (ST's import picker may still offer them). Delete is cleaner.
- Gutting is worst — partial files confuse future auditors.
- User's own direction is cleanup (they just removed two obsolete worktrees); delete matches that trajectory.

**Files to delete (from project root only — do NOT touch the copies inside `.claude/worktrees/*`; those are branch-local artifacts and git will reconcile when the worktrees are pruned):**

- `G:\My Drive\AI RPG\Gravity 2\Gravity_v11.json`
- `G:\My Drive\AI RPG\Gravity 2\gravity_v13_c.json`
- `G:\My Drive\AI RPG\Gravity 2\gravity_v13_c_split.json`
- `G:\My Drive\AI RPG\Gravity 2\gravity_v14.json`

**Keep:** `gravity_v15.json` (canonical).

**Rationale reference:** Spec §1 Out of Scope explicitly lists what Phase 2 keeps/strips. CLAUDE.md at root: "The current preset is `gravity_v15.json`."

**Ordering:** Independent of everything else. Apply any time.

**Verification:**
- `ls G:\My Drive\AI RPG\Gravity 2\*.json` should show only: `Gravity World Info.json`, `gravity_v15.json`, `manifest.json`.
- `git status` shows four deletions staged.
- Load SillyTavern, confirm the ST preset picker doesn't list v11/v13/v14 at the project root anymore (v15 remains).

---

## F-D8 — Remove stale `intelligent-lovelace-9b7c54` worktree (P2)

**Finding:** `PHASE2-FINAL-AUDIT.md` in worktree `intelligent-lovelace-9b7c54` records ~30 findings against a pre-fix code state. All "critical" findings there are stale against the current post-merge root (spot-checked: `intimacy_stance`, `col.details`, `f.objective`, `char.want` — zero matches at root). The worktree has no unique assets beyond the audit doc and the pre-fix code clones it carries.

**Decision: delete the whole worktree directory.** Rationale:

- The worktree contains a full clone of pre-fix source (50+ files). Keeping only `PHASE2-FINAL-AUDIT.md` would leave a single orphaned doc pointing at a deleted code tree — confusing.
- The user already cleaned up `sharp-yalow-c99a88` and `romantic-kowalevski-05ced4` (post-fix worktree dupes). Same treatment here.
- If the audit findings have any lasting value, they're already reflected in the newer `PHASE2-COMPLIANCE-AUDIT.md` + `PHASE2-DEEP-AUDIT.md` at root. Git history preserves the file if archaeology is needed.

**Directory to remove:**

- `G:\My Drive\AI RPG\Gravity 2\.claude\worktrees\intelligent-lovelace-9b7c54\` — entire tree, including `.git`, `Documentation/`, `Plan/`, all `.js` files, all JSON files.

**Procedure:** if the worktree was created via `git worktree add`, use `git worktree remove G:\My Drive\AI RPG\Gravity 2\.claude\worktrees\intelligent-lovelace-9b7c54` for clean removal (prunes git metadata). If that fails (e.g. worktree is no longer registered), `rm -rf` the directory.

**Fallback if deleting the worktree is undesirable:** keep the code tree but delete just `PHASE2-FINAL-AUDIT.md`, and add a `SUPERSEDED.md` in its place with a single line pointing readers at the current audits.

**Ordering:** Independent. Apply any time.

**Verification:**
- `ls G:\My Drive\AI RPG\Gravity 2\.claude\worktrees\` does not list `intelligent-lovelace-9b7c54`.
- `git worktree list` does not include it.
- No broken references — `grep -rn "intelligent-lovelace" G:\My Drive\AI RPG\Gravity 2\ --exclude-dir=.claude` returns 0 matches.

---

## P3 Fixes — apply if time allows, skip otherwise

The following are polish. Each is low-impact on behavior but fixing them improves code health or LLM-experience quality. Order is file-based for minimal context switching.

### F-D9 — Remove dead exports (P3)

**Findings:** state-compute.js exports `diffStates`, `getPhonebook`, `getArrayFieldHistory` with zero external imports. state-machine.js exports `getValidNextStates`, `isTerminal` with zero external imports (module comment claims they're used by "OOC eval and the prompt layer" — not true). state-view.js exports `formatCollisionArchive` used only internally.

**Option A (conservative):** leave them as public API surface for future OOC eval work. Do nothing.

**Option B (clean):** drop the unused exports from the `export { }` blocks. Functions remain in the module so they're re-exportable if needed.

If applying Option B:

**File 1:** `G:\My Drive\AI RPG\Gravity 2\state-compute.js` lines 599–612

**Old:**

```javascript
export {
    CATEGORY_DISTANCES,
    createEmptyState,
    applyTransaction,
    computeState,
    diffStates,
    getPhonebook,
    getCollectionName,
    validateTravel,
    getFieldHistory,
    getArrayFieldHistory,
    getArrayItemHistory,
    getEntityHistory,
};
```

**New:**

```javascript
export {
    CATEGORY_DISTANCES,
    createEmptyState,
    applyTransaction,
    computeState,
    getCollectionName,
    validateTravel,
    getFieldHistory,
    getArrayItemHistory,
    getEntityHistory,
};
```

**File 2:** `G:\My Drive\AI RPG\Gravity 2\state-machine.js` lines 11, 177–190

**Old (line 11 docstring):**
```javascript
 * 3. Utility helpers (getValidNextStates, isTerminal) used by OOC eval and the
 *    prompt layer for documentation
```

**New:**
```javascript
 * 3. Utility helpers (getValidNextStates, isTerminal) for future OOC eval work
```

**Old (export block):**

```javascript
export {
    CHARACTER_TIERS,
    CHARACTER_TRANSITIONS,
    CONSTRAINT_LEVELS,
    CONSTRAINT_TRANSITIONS,
    COLLISION_STATES,
    COLLISION_TRANSITIONS,
    COMBAT_STATES,
    COMBAT_TRANSITIONS,
    validateTransition,
    getValidNextStates,
    isTerminal,
    getStateMachineField,
};
```

**New:**

```javascript
export {
    CHARACTER_TIERS,
    CHARACTER_TRANSITIONS,
    CONSTRAINT_LEVELS,
    CONSTRAINT_TRANSITIONS,
    COLLISION_STATES,
    COLLISION_TRANSITIONS,
    COMBAT_STATES,
    COMBAT_TRANSITIONS,
    validateTransition,
    getStateMachineField,
};
```

**File 3:** `G:\My Drive\AI RPG\Gravity 2\state-view.js` lines 876–881

**Old:**

```javascript
export {
    formatStateView,
    formatReadme,
    formatCollisionArchive,
    computeArchiveVersion,
};
```

**New:**

```javascript
export {
    formatStateView,
    formatReadme,
    computeArchiveVersion,
};
```

**Recommendation:** apply Option B (the diff above). Clean exports make future dependency analysis sharper.

**Verification:** `node -c` each changed file.

### F-D10 — Remove stale "Stub" comment on `buildArrivalBlock` (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line:** 781

**Old:**
```javascript
// Stub: full sanity-check template implemented in PR-D (Task 7)
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
```

**New:**
```javascript
// Build the single-turn arrival sanity-check block injected via the _arrival slot (§3.5).
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
```

**Rationale:** the function at lines 782–830 is the full spec §3.5 template (ON-SCREEN / OFF-SCREEN REFRAME / OFF-SCREEN DISSOLVE / IMPLODE + CRASHED). The "Stub" label is a planning-phase artifact.

**Ordering:** Independent.

**Verification:** `grep -n "Stub:" index.js` returns 0 matches.

### F-D11 — Add advance-button timeout fallback (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 1899–1910

**Old code (exact):**

```javascript
    // Lock DOM button immediately; re-enable on next MESSAGE_RECEIVED
    const advBtn = document.getElementById('gl-input-advance');
    let reenableAdvBtn;
    if (advBtn) {
        advBtn.disabled = true;
        reenableAdvBtn = () => {
            advBtn.disabled = false;
            _advanceLocked = false;
            eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
    }
```

**New code:**

```javascript
    // Lock DOM button immediately; re-enable on next MESSAGE_RECEIVED OR after
    // a 2-minute timeout (covers silent LLM failures, stream stalls, etc.).
    const advBtn = document.getElementById('gl-input-advance');
    let reenableAdvBtn;
    if (advBtn) {
        advBtn.disabled = true;
        let timeoutId = null;
        reenableAdvBtn = () => {
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            advBtn.disabled = false;
            _advanceLocked = false;
            eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
        };
        timeoutId = setTimeout(() => {
            console.warn(`${LOG_PREFIX} Advance button timeout — re-enabling after 2min of no MESSAGE_RECEIVED.`);
            reenableAdvBtn();
        }, 120000);
        eventSource.on(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
    }
```

**Rationale:** Without a timeout, a network failure or silent LLM error leaves the Advance button disabled until page reload. The 2-minute window is long enough to cover typical LLM generation (most complete in < 60s) while short enough to recover from a dead call.

**Ordering:** Independent.

**Verification:** `node -c index.js` passes. Manual: disconnect network, click Advance, observe button re-enables after ~2 minutes with the console warning.

### F-D12 — Extend NESCIENCE coverage in the core readme (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\state-view.js`
**Line range:** 625–626 (inside `formatReadmeCore` DISCIPLINE block)

Current readme covers ~3 of the 8 NESCIENCE points in spec §2.8. Add the missing 5.

**Old code (exact — lines 625–626):**

```javascript
  Use faction knowledge_asymmetry for remote awareness — flat-key shape: knows_<subject>, unknown_<subject>, hiding_<subject>, misreading_<subject> (cap 20 across all four). Update after plausible intel events; do not globally synchronize.
  No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them.
```

**New code:**

```javascript
  Use faction knowledge_asymmetry for remote awareness — flat-key shape: knows_<subject>, unknown_<subject>, hiding_<subject>, misreading_<subject> (cap 20 across all four). Update after plausible intel events; do not globally synchronize.
  No provenance, no knowledge: distant factions and characters do not know live scene truth unless it plausibly reached them.
  NESCIENCE discipline (Theory of Mind — each character/faction knows only what they realistically observed, heard, deduced from evidence they have access to, or were told via a plausible channel). Avoid "Sherlock Holmes" leaps — explore obliviousness as much as insight. News and rumors travel on channels with latency and distortion; absence from a scene means absence of knowledge until a plausible report arrives. Communication-media rule: only the originator or recipient of a message knows its contents. Before updating knowledge_asymmetry, check past turns — do not contradict established knowledge states without explicit revelation.
```

**Rationale:** Spec §2.8 enumerates 8 NESCIENCE points. Current readme covers 1, 4, 5 loosely. The new sentence compactly covers Theory of Mind framing (point 0), Sherlock Holmes warning (point 3), observation/hearing realism (point 1), communication-media rule (point 6), and past-message analysis (point 7). Point 2 (maintain hidden info) and point 8 (factions obey same rules) were already present elsewhere in the DISCIPLINE block.

**Ordering:** Independent. Apply after F-D3.A (both edit the same DISCIPLINE block; avoid conflict by doing F-D3.A first since it touches line 632, and F-D12 touches 625–626).

**Verification:** `node -c state-view.js` passes. Manual: render readme core, confirm the new sentence is present.

### F-D13 — Flesh out timeskip WI entry (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\Gravity World Info.json`
**Line:** 248 (entry uid 8, `content` field)

The timeskip_core WI entry doesn't name `timeskip_scale` or enumerate the HOURS/DAYS/WEEKS/MONTHS values. It relies on the L4 preset entry for that. Duplicating the key info in the WI entry makes the mode lorebook self-contained.

**Old code (exact — look for the `"content"` of entry uid 8, single long JSON string):**

```
Timeskip should usually produce character agenda, location, or wounds changes; faction state and knowledge_asymmetry updates; collision clock ticks and any arrivals; pressure point seeding or FIFO clearance (WEEKS/MONTHS auto-clears all); and a new or updated opening scene.
```

**New code (substring replacement):**

```
Timeskip should usually produce character agenda, location, or wounds changes; faction state and knowledge_asymmetry updates; collision clock ticks and any arrivals; pressure point seeding or FIFO clearance (WEEKS/MONTHS auto-clears all); and a new or updated opening scene.\n\nDeclare the timescale in the ledger block: S world field=timeskip_scale value=HOURS|DAYS|WEEKS|MONTHS (default HOURS). HOURS ticks collisions by 1, DAYS by 3, WEEKS by 10 (+ pressure clear), MONTHS by 20 (+ pressure clear).
```

(Note: `\n\n` is literal escaped newline-escape pairs inside the JSON string — the WI loader renders them as blank line + next paragraph.)

**Rationale:** Spec §3.2 (timeskip classification) and spec §3.5 (advance turn directive). The LLM reading just this WI entry shouldn't have to cross-reference L4 to know what to emit.

**Ordering:** Independent.

**Verification:** `node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8'))"` parses.

### F-D14 — Remove unused `to` field from `findMissingArchiveEntries` return (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\consistency.js`
**Line range:** 229, 232, 239

**Old code (exact — line 229):**

```javascript
        .map(tx => ({ id: tx.id, to: tx.d.to }));
```

**New code:**

```javascript
        .map(tx => ({ id: tx.id }));
```

**Old code (exact — line 232):**

```javascript
    for (const { id: colId, to } of terminals) {
```

**New code:**

```javascript
    for (const { id: colId } of terminals) {
```

**Old code (exact — line 239):**

```javascript
        if (!matched) missing.push({ id: colId, name: nameToken, to });
```

**New code:**

```javascript
        if (!matched) missing.push({ id: colId, name: nameToken });
```

**Rationale:** `to` is in the returned objects but the caller (`index.js:1601`) destructures `{ id: colId, name: nameToken }`. Dead payload field — removing it simplifies the function contract.

**Ordering:** Independent.

**Verification:**
- `node -c consistency.js` passes.
- `grep -n ", to }" consistency.js` returns 0 matches.

### F-D15 — Fix late-archive counter-increment edge case (P3 → but promote to P2 if you want auto-fallback to actually fire)

**Finding on closer inspection:** today's archive-presence check only increments `_archiveCorrectionAttempts` on a turn where a terminal TR is in `committedTxns`. A collision that resolves on turn N with no archive gets `counter = 1` on turn N. If the LLM never adds the archive:

- Turn N+1: no terminal TR in the batch → `allTerminalIds` empty → `findMissingArchiveEntries` returns [] → counter stays at 1.
- Turn N+2 onward: same.
- The `attempts > MAX_CORRECTION_ATTEMPTS` branch (auto-fallback) never fires because `attempts` is stuck at 1.

This is a real gap — the auto-fallback mechanism the spec promises (§2.2.1 "Dropped correction fallback") is effectively dead.

**Fix:** detect missing archive from **current state**, not from the current batch's terminal TRs. The counter should increment every turn a RESOLVED/CRASHED collision remains unarchived.

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 1583–1621

**Old code (exact):**

```javascript
    // ── Archive presence check (§2.2.1) ────────────────────────────────────────
    // Pure detection lives in consistency.js::findMissingArchiveEntries.
    // This block owns the stateful side effects (correction queue, attempt
    // counter, auto-fallback append on drop).
    if (committedTxns.length > 0) {
        const allTerminalIds = committedTxns
            .filter(tx => tx.op === 'TR' && tx.e === 'collision'
                && (tx.d?.to === 'RESOLVED' || tx.d?.to === 'CRASHED'))
            .map(tx => tx.id);
        const missingList = findMissingArchiveEntries(committedTxns, _currentState);
        const missingIds = new Set(missingList.map(m => m.id));

        // Clear the counter for terminals that now have a matching archive entry
        // (e.g. late archive arrived on turn N+1).
        for (const id of allTerminalIds) {
            if (!missingIds.has(id)) _archiveCorrectionAttempts.delete(id);
        }

        for (const { id: colId, name: nameToken } of missingList) {
            const col = _currentState.collisions?.[colId];
            const attempts = (_archiveCorrectionAttempts.get(colId) || 0) + 1;
            if (attempts > MAX_CORRECTION_ATTEMPTS) {
                if (col) {
                    const fallback = `[collision] ${col.name || colId} [resolution] ${col.outcome_type || col.status} — auto-generated (archive missing after ${MAX_CORRECTION_ATTEMPTS} attempts) [hook] none [aftermath] ${col.aftermath || 'unknown'}`;
                    try {
                        const autoTxns = await append([{ op: 'A', e: 'world', id: '_', d: { f: 'collision_archive', v: fallback }, r: 'system:archive:auto-fallback' }]);
                        _currentState = computeState(_currentState, autoTxns);
                    } catch (_) { /* non-critical */ }
                }
                _archiveCorrectionAttempts.delete(colId);
            } else {
                _archiveCorrectionAttempts.set(colId, attempts);
                queueCorrections([{
                    raw: `[collision:${colId} archive]`,
                    error: `Missing archive entry for resolved collision ${colId}. Add: A world field=collision_archive value="[collision] ${col?.name || nameToken || colId} ... [resolution] ... [hook] ... [aftermath] ..."`,
                }]);
            }
        }
    }
```

**New code:**

```javascript
    // ── Archive presence check (§2.2.1) ────────────────────────────────────────
    // Scan ALL RESOLVED/CRASHED collisions each turn (not just TRs from this
    // turn). The counter increments every turn the archive remains missing so
    // the auto-fallback path (§2.2.1) actually fires after MAX_CORRECTION_ATTEMPTS.
    if (_currentState) {
        const archive = Array.isArray(_currentState.world?.collision_archive) ? _currentState.world.collision_archive : [];
        const archiveText = archive.map(e => String(e || '')).join('\n');

        for (const [colId, col] of Object.entries(_currentState.collisions || {})) {
            const status = (col?.status || '').toUpperCase();
            if (status !== 'RESOLVED' && status !== 'CRASHED') continue;

            const nameToken = col?.name ? String(col.name) : '';
            const matched = archiveText.includes(colId) || (nameToken && archiveText.includes(nameToken));

            if (matched) {
                _archiveCorrectionAttempts.delete(colId);
                continue;
            }

            const attempts = (_archiveCorrectionAttempts.get(colId) || 0) + 1;
            if (attempts > MAX_CORRECTION_ATTEMPTS) {
                const fallback = `[collision] ${col.name || colId} [resolution] ${col.outcome_type || col.status} — auto-generated (archive missing after ${MAX_CORRECTION_ATTEMPTS} attempts) [hook] none [aftermath] ${col.aftermath || 'unknown'}`;
                try {
                    const autoTxns = await append([{ op: 'A', e: 'world', id: '_', d: { f: 'collision_archive', v: fallback }, r: 'system:archive:auto-fallback' }]);
                    _currentState = computeState(_currentState, autoTxns);
                } catch (_) { /* non-critical */ }
                _archiveCorrectionAttempts.delete(colId);
            } else {
                _archiveCorrectionAttempts.set(colId, attempts);
                queueCorrections([{
                    raw: `[collision:${colId} archive]`,
                    error: `Missing archive entry for resolved collision ${colId}. Add: A world field=collision_archive value="[collision] ${col.name || colId} ... [resolution] ... [hook] ... [aftermath] ..."`,
                }]);
            }
        }
    }
```

**Rationale:** Spec §2.2.1 — "Engine queues correction ... cleared when the append is received. Dropped correction fallback: If the archive correction is dropped after MAX_CORRECTION_ATTEMPTS (3), the engine auto-generates a minimal archive entry ... and appends it." That mechanism requires the counter to actually reach MAX_CORRECTION_ATTEMPTS, which requires per-turn increment.

**Side benefit:** `findMissingArchiveEntries` from consistency.js (imported at `index.js:12`) is no longer used in this block. Either keep the import for future callers or remove it.

**Ordering:** Apply after F-D14 (both touch consistency.js and would otherwise conflict).

**Verification:**
- `node -c index.js` passes.
- Manual: resolve a collision without an archive entry. Watch `_archiveCorrectionAttempts` grow turn over turn. After turn 4, auto-fallback should fire and append a system-generated archive entry. Correction should stop appearing.

### F-D16 — Already covered by F-D2.B (P3)

The state-view.js:836 ambiguous "For EVOLVED or MERGED: add successor_collision_ids..." line is rewritten by F-D2.B into a per-outcome guidance block. No separate edit.

### F-D17 — Warn when LLM sets `created_at_tx` on pressure CR (P3)

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 1567–1581 (inside the existing per-tx audit loop added in F10)

**Old code (exact):**

```javascript
    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Add distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR — the engine resolves the numeric distance.`,
                attempts: 0,
            });
        }
    }
```

**New code:**

```javascript
    // ── Engine-owned field audit — warn if LLM sets engine-managed fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Add distance_category=IMMEDIATE|SHORT|MEDIUM|LONG on CR — the engine resolves the numeric distance.`,
                attempts: 0,
            });
        }
        if (tx.op === 'CR' && tx.e === 'pressure' && tx.d?.created_at_tx !== undefined) {
            _pendingCorrections.push({
                text: `Pressure ${tx.id} was created with created_at_tx in the payload. Do not set this field — the engine stamps it from tx.tx. Remove it from future pressure CRs.`,
                attempts: 0,
            });
        }
    }
```

**Rationale:** Spec §2.5 Pressure Points — "`created_at_tx` | number | Engine-set on CR ... **LLM must not set this field.**" Currently silently overwritten; LLM gets no feedback.

**Ordering:** Independent.

**Verification:** `node -c index.js` passes. Manual: emit `CR pressure:x name="..." source="..." created_at_tx=5`. Next turn's correction injection should include the warning.

---

## Residual Risks and Judgment Points

Points where the spec is ambiguous, the fix is a judgment call, or there's known unclarity that the user should resolve before shipping. These are NOT fix instructions — they're flags.

### R1 — MERGED pointer-integrity check is absent

Spec §2.2.1: "Resolved collision entities persist in the ledger — they are not deleted. ... Pointer integrity (e.g. parent_collision_ids, successor_collision_ids) depends on the entity remaining." Spec does not explicitly require the engine to validate that a MERGED collision's id appears in some surviving collision's `parent_collision_ids`. Today: no such check. If the LLM sets `outcome_type=MERGED` but forgets to append to the survivor's `parent_collision_ids`, the link is silently broken and future archive-seeding may orphan the reference. Consider adding a closure-audit check for this — but only if the user decides pointer integrity is worth enforcing engine-side.

### R2 — key_moments 100-cap is LLM-enforced only

Spec §2.1 puts the 100-cap on the LLM to self-trim. Today the engine emits no warning when `key_moments.length > 100`. This matches spec strictly. If you want engine-side safety, mirror the existing `ARRAY_SIZE_LIMITS` pattern at `index.js:1311–1326`. That is NOT a spec requirement, just a robustness add.

### R3 — agenda-on-promotion (F-D5) may fire too often

F-D5 emits a correction every time a promotion TR lands without a paired agenda SET. If the LLM is slow to respond, the correction will re-queue on subsequent turns (via the existing MAX_CORRECTION_ATTEMPTS churn) until either the LLM sets it or the attempt counter drops it. If this feels noisy in practice, gate the warning behind a `_agendaPromotionWarned` Set (one warning per character per session), or demote the correction to a one-time `_pendingReinforcement` append.

### R4 — F-D7 deletion vs archive preservation

Deleting `Gravity_v11.json`, `gravity_v13_c*.json`, `gravity_v14.json` removes legacy presets from user import pickers. If any user workflow depends on them (e.g. someone running an old chat that expects v14 reasoning), the deletion breaks that workflow. Judgment call: delete (recommended) trades preservation for cleanliness. If the user runs any active chats still loaded against v14, rename-to-`.archive` is the safer move.

### R5 — F-D8 worktree deletion loses `PHASE2-FINAL-AUDIT.md` archaeology

Deleting the whole `intelligent-lovelace-9b7c54` worktree removes the audit doc. Its findings were stale against post-fix code, but may have referenced legitimate issues that the newer audits missed. Before deleting, optionally grep the doc for "CRITICAL" and "HIGH" findings and cross-check against the current post-merge root. If every finding there is either (a) already in our audits or (b) stale, proceed with deletion.

### R6 — F-D11 advance-button timeout is arbitrary

120000ms (2 min) is a heuristic. LLM responses can legitimately take longer on large contexts; can also fail in <5s. If the user has telemetry on typical response times, tune accordingly. If a conservative value is preferred, use 300000ms (5 min). If they want aggressive recovery, 60000ms (1 min).

### R7 — F-D15 changes archive-check semantics

The old logic only incremented the counter on turns where a terminal TR was in the commit. The new logic increments every turn the archive remains missing. This means:

- Auto-fallback will now actually fire (previously effectively dead).
- The corrections queue may spam for 3 consecutive turns if the LLM doesn't add the archive quickly. That may feel noisy.

If this spam is undesirable, add a once-per-turn cap — only warn about ONE missing archive per turn, not all of them.

### R8 — spec §2.5 transient-pressure WEEKS/MONTHS ambiguity

In a WEEKS advance turn, the LLM might CR new pressures representing tensions that arose during the timeskip. The current engine clears ALL pressure on WEEKS/MONTHS, including the LLM's just-committed ones (fine per spec §2.5, but the LLM wastes a CR). The preset warns against this. If it turns out LLMs routinely re-seed anyway, consider delaying the WEEKS/MONTHS clear until AFTER the commit that includes pressure CRs on the advance turn — but spec §2.5 doesn't demand this and the warning mechanism may be sufficient.

---

## Apply Order

Recommended sequence (strict dependencies marked; others flexible):

1. **F-D1** — trivial one-line fix, wins the most correctness per effort.
2. **F-D2.A** → **F-D2.B** → **F-D2.C** — enum alignment, can go in any inner order but all three needed to consider this finding closed.
3. **F-D3.A** → **F-D3.B** — file-order edits within state-view.js.
4. **F-D4** — WI entry deletion, independent.
5. **F-D5** — agenda-on-promotion audit.
6. **F-D6.A** — getStateMachineField signature extension (F-D6.B has no code change, just behavioral verification).
7. **F-D7** — delete four legacy preset files at root.
8. **F-D8** — delete `intelligent-lovelace-9b7c54` worktree.
9. **F-D9** — (optional Option B) drop dead exports.
10. **F-D10** — stub comment cleanup.
11. **F-D11** — advance-button timeout.
12. **F-D12** — NESCIENCE extension. Must run after F-D3.A (both touch DISCIPLINE block in state-view.js).
13. **F-D13** — WI timeskip entry flesh-out.
14. **F-D14** — drop unused `to`. Must run before F-D15 (F-D15 removes the `findMissingArchiveEntries` callsite — you want F-D14 to land first so it's captured in the rewritten block via the function still being called).
15. **F-D15** — archive-presence rewrite. Removes the F-D14 callsite but F-D14's change to `consistency.js` still stands (and is still correct — just unused by the new code in index.js).
16. **F-D16** — no action (subsumed by F-D2.B).
17. **F-D17** — created_at_tx warning.

---

## Post-remediation Verification Checklist

Run after every batch, but especially after landing all P1 fixes:

1. `node -c index.js` — must pass.
2. `node -c state-compute.js` — must pass.
3. `node -c state-machine.js` — must pass.
4. `node -c consistency.js` — must pass.
5. `node -c state-view.js` — must pass.
6. `node -c snapshot-mgr.js` — must pass.
7. `node -c setup-wizard.js` — must pass.
8. `node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"` — must pass.
9. `node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8'))"` — must pass.
10. `grep -c "MERGED" gravity_v15.json` — must be ≥ 1 (F-D2.A).
11. `grep -c "DISSOLVED" state-view.js` — must be ≥ 2 (F-D2.B + line 582 path reference).
12. `grep -n "DIRECT / EVOLVED / MERGED / DISSOLVED / IMPLODED / CRASHED" index.js` — must return 1 match (F-D2.C).
13. `grep -in "chapter" "Gravity World Info.json"` — must return 0 matches (F-D4).
14. `ls G:\My Drive\AI RPG\Gravity 2\*.json` — must list only `Gravity World Info.json`, `gravity_v15.json`, `manifest.json` (F-D7).
15. `ls G:\My Drive\AI RPG\Gravity 2\.claude\worktrees\` — must not include `intelligent-lovelace-9b7c54` (F-D8).
16. `grep -n "Stub: full sanity-check" index.js` — must return 0 matches (F-D10).
17. `grep -n "key_moments are permanent;" state-view.js` — must return 0 matches (F-D3.A).
18. `grep -n "was promoted to" index.js` — must return 1 match inside the new agenda audit block (F-D5).

### Functional smoke tests (post-all-fixes)

**Smoke 1 — merge correctness:** Create two collisions `A` and `B`. Transition `A` to RESOLVED with `outcome_type=MERGED`. Append `parent_collision_ids=A` to `B`. Next turn, verify the closure audit does NOT warn about `A` missing `successor_collision_ids`.

**Smoke 2 — agenda-on-promotion:** Commit `TR char:npc tier KNOWN→TRACKED` without a paired `S char:npc agenda`. Verify the correction fires on the next turn's injection. Then in the next response, commit `S char:npc agenda value="..."`. Verify the correction clears.

**Smoke 3 — DISSOLVED flow:** Trigger an arrival. LLM commits the OFF-SCREEN DISSOLVE ledger block (sets `outcome_type=DISSOLVED`). Verify the closure audit does NOT fire a "missing outcome_type" warning. The warning text should match the 6-value enum.

**Smoke 4 — archive auto-fallback:** Resolve a collision without an archive entry. Over three subsequent turns, the LLM must NOT commit the archive. On turn 4 (attempt 4), the engine should emit the auto-fallback archive entry with reason `system:archive:auto-fallback`.

**Smoke 5 — pressure created_at_tx warning:** Emit `CR pressure:t name="..." source="..." created_at_tx=99`. Verify the correction injection on the next turn mentions "Do not set this field — the engine stamps it."

**Smoke 6 — advance button timeout:** Click Advance. Disconnect network before LLM response. Wait 2 minutes. Button should auto-re-enable with a `[GravityLedger] Advance button timeout` console warning.

---

## What this doc does NOT cover

- Anything already listed in `PHASE2-COMPLIANCE-AUDIT.md` or `PHASE2-FIXES.md`. That work is landed (verified at root post-merge).
- Pre-Phase 3 exploratory work (constraint bidirectional framing per the user's memory entry — still deferred to post-Phase 2 per spec §1).
- Lorebook content quality (subjective polish).
- The non-`gravity_v15.json` presets' internal consistency (those files are deleted in F-D7).
- Plugin manifest changes, versioning, changelog entries — assume those are the user's workflow.
