# Gravity Ledger — Phase 2 Implementation Plan

> **Companion to:** `PHASE2-SPEC.md`
> **Branch:** `codex-v13-state-delta`
> **Audience:** A developer who has read the spec and needs concrete per-task guidance.
> **Style:** Code-level. Every task names the file(s), the function(s), and the conceptual diff. Complexity tagged **S** (≤ 30 min), **M** (≤ 2 h), **L** (half-day or more).
>
> The spec says WHAT. This plan says HOW, in what order, and how to verify.

---

## 0. Preflight — Environment & Conventions

- **No tests, no lint, no CI.** Validation = `node -c <file>.js` (syntax) + live `node -c` after every edit + manual play-through in SillyTavern with the Phase 2 preset (`gravity_v14.json` or a new `gravity_v15.json` once the spec lands in the preset).
- **Every task ends with a commit.** Small, focused commits; `feat(phase2): ...`, `refactor(phase2): ...`, `chore(phase2): ...`. Never squash across task boundaries — the commit log is the only audit trail.
- **All edits run on `codex-v13-state-delta`.** Do not merge to main until Phase 2 is complete and the preset is updated. Use snapshots (`OOC: snapshot`) before destructive work (chapter strip, resolution tracker removal).
- **When `node -c` passes, move on.** Do not try to run tests that do not exist. Do not add a build step.

## 0.1 Spec-Level Decisions The Implementer Must Make Up Front

These are underspecified or contradict the existing code. Resolve before touching code so later tasks are not invalidated.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Spec §2 table uses `state.chars` but the codebase has `state.characters` (and `getCollectionName` maps `char` → `characters`). | (a) Full rename `characters` → `chars` everywhere. (b) Keep existing `characters` collection; only new types (`places`, `pressures`) get new collections. | **(b).** The rename is a ~200-line cross-cut with high regression risk and no behavioural payoff. Treat the spec's `state.chars` wording as shorthand; keep `state.characters`. Document this deviation in a short comment in `state-compute.js` near `getCollectionName`. |
| **D2** | Combat exchange: spec §7.2 says "removed from the ledger." Codebase writes `combat.exchange` from `challenge-state.js` (lines 1008–1123) and reads it in `state-view.js` (L246, L394). Player-visible. | (a) Strip exchange entirely. (b) Keep as in-memory runtime field only; never emit `S combat.exchange` tx. | **(b).** Leave the runtime field; remove only the `S combat:...field=exchange` transactions. Delete the display in `state-view.js`. This matches "ledger exchange bookkeeping removed" without gutting runtime state. |
| **D3** | Rename of the existing `world.pressure_points` (array on `world`) vs. new `pressure` entity collection. The old field and the new entity collide semantically. | (a) Keep both, bridge during Phase 2. (b) Strip the old `world.pressure_points` field as part of the pressure-entity migration. | **(b).** Strip the old field when the new `pressure:<id>` entity goes in (§4.1 step). Back-compat replay: `state-compute` drops `world.pressure_points` silently. See Task 11.3. |
| **D4** | Where `validateTransition()` is called. Spec §6.1 code shows `const { validateTransition } = require('./state-machine.js');` but this is ESM, not CJS. | Keep ESM `import`. Call from the per-tx validation loop inside `onMessageReceived` **before** `await append(validTxns)`, not from `consistency.js` (keeps consistency as pure-format validation). | Call from `onMessageReceived` (index.js L1670-L1681 block), add a second-pass reject that queues a correction. Leave `consistency.js` untouched for this concern. Update the spec note accordingly. |
| **D5** | `_foreshadowedCollisions` persistence. Spec §3.4 says "Reset on snapshot rollback." Doesn't specify if it persists across reload. | In-memory only (same model as `_resolutionTracker` today). | In-memory. Reloading replays foreshadow one extra time at worst; cheap. |
| **D6** | Archive auto-generation fallback format when dropped after 3 attempts (§2.2.1). Spec gives the concept but not the template. | Template: `[collision] ${name} [resolution] ${outcome_type} — auto-generated (archive missing after 3 attempts) [hook] none [aftermath] ${aftermath || 'unknown'}`. | Use this exact template in Task 10.3. |
| **D7** | Nudge frequency counter starts at `-3`. Persistence key names in `chatMetadata`. | Use: `gravity_nudge_counter`, `gravity_nudge_slot`, `gravity_nudge_rotation_index`. | Lock these names in Task 14. |
| **D8** | Simultaneous IMMEDIATE + regular arrivals on an advance turn — which prompt is emitted first? | Emit in one `_arrival` block: IMMEDIATE first (newest), then distance-0 arrivals, separated by `\n\n`. | Matches spec §3.5 simultaneous-arrivals language. |
| **D9** | Knowledge asymmetry schema: spec §2.1 shows two lists (`secrets_held`, `blind_spots`) but commit 997a31f already restructured to four maps (`knows`, `unknown`, `hiding`, `misreading`) with per-subject keys. | (a) Revert to two-list schema per spec. (b) Keep four-map schema; update spec and all nudge/readme references to match. | **(b).** Four-map schema already ships in state-compute/state-view/preset. Reverting is a ~150-line backslide with no gameplay gain. **Spec §2.1 is being updated to match.** All tasks/nudges in this plan that mention `secrets_held` or `blind_spots` should reference the four maps instead — see Task 14's `collision_health` prompt and readme update in Task 3/11. |

**Do not start Task 1 until D1–D9 are settled in writing** (a short note at the top of your working branch's first commit is fine).

---

## 1. File-by-File Ownership Map

This map is the contract for what each file is responsible for after Phase 2. Use it as a cross-check when touching a file: if you're adding logic that doesn't fit its row, you're in the wrong file.

| File | Phase 2 Responsibility |
|---|---|
| [index.js](index.js) | Turn lifecycle (advance/regular/integration), injection orchestration, runtime Maps/Sets (`_firedCollisionArrivals`, `_foreshadowedCollisions`), constants (`MAX_PRESSURE_POINTS`, `MAX_COLLISIONS`, `MAX_COLLISION_ARCHIVE`, `CATEGORY_DISTANCES`, `TICK`), `handleAdvanceButton()`, `onMessageReceived()`, `buildAndInjectArrivals()`, `buildForeshadowingInjection()`, nudge rotation. |
| [state-compute.js](state-compute.js) | `createEmptyState()` shape, `applyTransaction()` CR defaults for `place`/`pressure`/`collision`, `pressure.created_at_tx` stamped from `tx.tx`, collision_archive auto-trim. (Four-map `knowledge_asymmetry` normalization is already in place per commit 997a31f — no new work.) |
| [state-machine.js](state-machine.js) | Simplified transition tables (remove chapter, simplify collision to `ACTIVE→RESOLVED/CRASHED`), `validateTransition()` untouched internally. |
| [consistency.js](consistency.js) | Format validation only — add `place`/`pressure` to `VALID_ENTITIES`, remove `chapter` and `summary`. No transition validation. |
| [state-view.js](state-view.js) | New sections: `PLACES`, `PRESSURE POINTS` (compact), `KEY MOMENTS` per-PRINCIPAL (last 10), `COLLISION ARCHIVE` when `activePool ≤ 2`. Remove chapter rendering. Remove `combat.exchange` display. Rewrite readme for the new command vocabulary. |
| [challenge-state.js](challenge-state.js) | Remove `S combat:id field=exchange` tx emission (keep `runtime.exchange` as runtime-only). No other changes. |
| [regex-intercept.js](regex-intercept.js) | Add `place`/`pressure` to recognized entity prefixes in the STATE parser. Remove `chapter` entity paths from STATE shorthand. |
| [snapshot-mgr.js](snapshot-mgr.js) | No functional change. Callers in `index.js` must reset `_firedCollisionArrivals`/`_foreshadowedCollisions`/`_archiveInjectedVersion` on rollback. |
| [ui-panel.js](ui-panel.js) | Remove Chapter tab / "Close Ch." button. Leave divination picker. |
| [setup-wizard.js](setup-wizard.js) | Remove chapter-requirement from `checkPhaseCompletion()`. |
| [ooc-handler.js](ooc-handler.js) | Remove any `chapter` OOC branches; leave all else. |
| [ledger-store.js](ledger-store.js) | No change. |

---

## 2. PR / Commit Grouping

Work delivers as **7 logical PRs** (6 code + 1 preset). Each is independently testable via `node -c` + a SillyTavern smoke run. Do not ship PRs out of order — later PRs depend on earlier scaffolding. PR-G (preset) is the last and cannot merge until all code PRs land.

| PR | Title | Covers Tasks | Complexity | Risk |
|---|---|---|---|---|
| **PR-A** | Divination cleanup & chapter strip | 1, 2 | M | Low — pure deletion, replay safe (legacy tx silently dropped) |
| **PR-B** | Place entity + travel plausibility | 3 | M | Low — additive |
| **PR-C** | Distance categories + timeskip multipliers + IMMEDIATE | 4, 5, 6 | L | **Medium-high** — touches the hottest path (`handleAdvanceButton`, `onMessageReceived`) |
| **PR-D** | Arrival redesign + foreshadowing + rollback resets | 7, 8, 8b | L | **High** — replaces `_resolutionTracker` entirely; 8b requires rollback-callsite audit |
| **PR-E** | validateTransition wiring + combat ephemeral | 9, 10 | M | Low-medium |
| **PR-F** | Pressure entities + collision pool cap + archive + rotating nudge | 11, 12, 13, 14 | **XL** | Medium-high — Task 11 strips ~500 lines of tier/ignition code alongside the additive pressure entity |
| **PR-G** | Preset vocabulary update | 15 | M | Low — isolated JSON; cannot merge before PR-A through PR-F are all in |

Each PR is a standalone merge to `codex-v13-state-delta`. Main stays untouched until all 7 PRs (A–G) merge.

---

## 3. Task Breakdown

### Task 1 (§5.1): Strip Yi Jing / I Ching — **S**

**Why first:** Simplifies `drawDivination()` so the arrival and foreshadowing tasks can call it without branching.

**Files touched:**
- [index.js](index.js): L588–L590 (`ICHING_TRIGRAMS`), L725–L770 (manual iching parser block), L800–L821 (iching branch in `drawDivination`)
- [ui-panel.js](ui-panel.js): L1212 (option element)

**Conceptual diff:**

1. In `index.js`:
   - Delete `ICHING_TRIGRAMS` constant.
   - Delete the three `1d64` / `d64` regex patterns inside `parseManualDivinationOverride()` and the subsequent `system: 'iching'` return object (L725–L770 block).
   - Delete the `manual?.system === 'iching'` branch in `drawDivination()` (L800–L802).
   - Delete the entire `if (system === 'iching' || ...)` block (L812–L821).
   - Grep for any stragglers: `grep -n -iE "iching|yi jing|hexagram|1d64"`.

2. In `ui-panel.js`:
   - Remove the `<option value="iching">易経 I Ching (d64)</option>` line from the divination system `<select>` (L1212).
   - Verify the surrounding `<select>` still has `arcana` and `classic` options.

3. Back-compat: if `chatMetadata['gravity_divination_system'] === 'iching'`, fall through to arcana. Add this one line in `getActiveDivinationSystem()` (index.js around L660):
   ```javascript
   const stored = chatMetadata?.['gravity_divination_system'];
   if (stored === 'iching' || stored === 'i_ching' || stored === 'i ching') return 'arcana';
   return stored || (_currentState?.divination?.active_system || 'arcana').toLowerCase();
   ```

**Verify:**
- `node -c index.js && node -c ui-panel.js` both succeed.
- Grep for `iching|ICHING_|1d64|hexagram` in every `.js` returns zero hits.
- Loading an old chat with `active_system: 'iching'` set does not throw; falls back to arcana.

**Commit:** `chore(phase2): strip yi jing / i ching divination (§5.1)`

---

### Task 2 (§2.7): Strip Chapters — **M**

**Why second:** Clears the biggest single deletion before additive work begins. Several later tasks become smaller once chapter rendering is gone.

**Files touched:**
- [state-compute.js](state-compute.js): `createEmptyState()` (L49–L75), `diffStates()` (L476), `getCollectionName()` (L166).
- [state-machine.js](state-machine.js): `CHAPTER_STATES`, `CHAPTER_TRANSITIONS`, the `chapter:` entry in `validateTransition`'s `machines` object, `getStateMachineField`, exports.
- [consistency.js](consistency.js): `VALID_ENTITIES` (L16) — remove `'chapter'`.
- [state-view.js](state-view.js): Two render blocks — the active-chapters registry (L258–L265) and the "CHAPTER" current-state block (L334–L345). Remove both.
- [ui-panel.js](ui-panel.js): L232 (Close Ch. button), L281 (`chapter_close` case), L1165/L1197 (any render of chapter data). Remove the entire chapter panel/tab if present.
- [setup-wizard.js](setup-wizard.js): L33–L41 — drop the `hasChapter` requirement in `checkPhaseCompletion` (accept setup-complete on `hasChars` alone).
- [ooc-handler.js](ooc-handler.js): Grep for `chapter` — remove any OOC branch that references chapter state or emits chapter transactions.
- [challenge-state.js](challenge-state.js): L234 in `getEntityCollection`'s `collectionMap` — remove `chapter: 'chapters'`.
- [regex-intercept.js](regex-intercept.js): Any entity prefix allow-list that includes `chapter` → remove.

**Conceptual diff:**

1. `createEmptyState()`: remove `chapters: {},` line.
2. `diffStates()`: remove `'chapters'` from the collection iteration array.
3. `getCollectionName`: remove `chapter: 'chapters'` row.
4. `state-machine.js`: delete `CHAPTER_STATES`, `CHAPTER_TRANSITIONS`, the `chapter:` entry in `validateTransition`'s `machines`, and the matching entries in `getStateMachineField` and `getValidNextStates`. Drop them from the exports list.
5. `consistency.js`: `VALID_ENTITIES = [..., 'faction', 'world', 'pc', 'divination', 'summary']` — drop `'chapter'`. (Leave `'summary'` for now; back-compat replay.)
6. `state-view.js`: delete chapter registry block AND "CHAPTER" current-state block. Keep `--- CURRENT STATE ---` header.
7. `ui-panel.js`: delete the Close Ch. button entirely, drop the `chapter_close` command case and the `_onChapterClose` hook, and strip the tab that renders `state.chapters`.
8. `setup-wizard.js` `checkPhaseCompletion`:
   ```javascript
   if (!_active) return;
   const hasChars = Object.keys(state.characters || {}).length > 0;
   if (hasChars) {
       _active = false;
       ...
   }
   ```
9. `index.js`:
   - Remove `handleChapterCloseButton` function AND its listener registration.
   - Remove the `chapterCloseCore` lorebook key trigger (reference at L117).
   - Grep `_onChapterClose` — delete the callback wire.
10. `ooc-handler.js`: grep `chapter` — remove offending branches.
11. `challenge-state.js` L234: remove chapter line from collectionMap.
12. `regex-intercept.js`: scan any `VALID_ENTITIES` or prefix list; drop `chapter`.

**Back-compat for replay:** existing chats' `CR chapter:...` transactions currently replay into `state.chapters`. After the strip, `getCollectionName('chapter')` returns `'chapter'` (fallthrough), so `state['chapter']` is written — a noisy ghost key but harmless. Add a silent-drop early return in `applyTransaction` (mirror the existing `'summary'` handler at L243–L247):
```javascript
if (tx.e === 'chapter') {
    state.lastTxId = tx.tx;
    return state;
}
```

**Verify:**
- `node -c` on every touched file.
- Grep `chapter|chapters` in all JS → only the silent-drop line should match (and any legitimate uses like variable name `chapter` inside a function that isn't about the entity — scrub carefully).
- Load an old chat with chapter tx; UI shows no chapter panel and no error.

**Commit:** `feat(phase2): strip chapter entity and state machine (§2.7)`

---

### Task 3 (§2.4): Add `place` Entity Type — **M**

**Why now:** Needed by Task 4 (collision uses `location`) and Task 7 (arrival proximity check).

**3a. Schema & storage**

- `consistency.js`: add `'place'` to `VALID_ENTITIES`.
- `state-compute.js`:
  - Add `places: {},` to `createEmptyState()`.
  - Add `place: 'places'` to `getCollectionName`'s map.
  - In `applyTransaction`, `case 'CR'` for `place`: after the generic assignment, normalize `reach`:
    ```javascript
    if (tx.e === 'place') {
        if (!data.reach) data.reach = 'LOCAL';
        if (!data.state) data.state = 'unknown';
    }
    ```
  - `diffStates`: add `'places'` to the iterated collections list.

**3b. Travel plausibility check**

- Add a new exported function `validateTravel(charId, fromPlaceId, toPlaceId, state, turnMode)` in `state-compute.js` (or a new `travel.js` if you prefer — the spec's §2.4 code block is reproducible verbatim). Use the **exact code** from spec §2.4, replicated below for convenience:

```javascript
const TRAVEL_REACH_ORDER = ['LOCAL', 'DISTRICT', 'CITY', 'REGIONAL', 'REMOTE'];
const ON_FOOT_MAX = 'DISTRICT';

function validateTravel(charId, fromPlaceId, toPlaceId, state, turnMode) {
    if (turnMode === 'advance') return { valid: true };
    const fromPlace = state.places?.[fromPlaceId];
    const toPlace = state.places?.[toPlaceId];
    if (!fromPlace || !toPlace) return { valid: true };
    if (fromPlaceId === toPlaceId) return { valid: true };
    const fromIdx = TRAVEL_REACH_ORDER.indexOf(fromPlace.reach || 'LOCAL');
    const toIdx = TRAVEL_REACH_ORDER.indexOf(toPlace.reach || 'LOCAL');
    const maxIdx = TRAVEL_REACH_ORDER.indexOf(ON_FOOT_MAX);
    if (toIdx > maxIdx || fromIdx > maxIdx) {
        return {
            valid: false,
            error: `Travel from "${fromPlace.name}" (${fromPlace.reach}) to "${toPlace.name}" (${toPlace.reach}) is implausible in a 15-minute scene window.`,
            fix: `Use an ADVANCE turn to timeskip travel, or add a narrative justification (vehicle, special transport) before the location change.`,
        };
    }
    return { valid: true };
}
```

**3c. Wire into the turn pipeline**

**Fold the travel check into the existing per-tx validation loop** — do not add a second iteration pass. The index.js loop at L1670–L1681 (replaced in its final form by Task 10b) walks `extractedTransactions` once, calling `validateBatch([tx])`, and pushing to `validTxns` on success. Insert the travel check inside that same loop body, before the `validTxns.push(tx)` line:

```javascript
for (let i = 0; i < extractedTransactions.length; i++) {
    const tx = extractedTransactions[i];
    const formatResult = validateBatch([tx]);
    if (!formatResult.valid) { /* existing error path */ continue; }

    // ─── Travel plausibility (Task 3c) ─────────────────────────────
    if (tx.op === 'S' && tx.e === 'char' && tx.d?.f === 'location') {
        const charBefore = _currentState.characters?.[tx.id];
        const fromPlaceId = charBefore?.location;
        const travel = validateTravel(tx.id, fromPlaceId, tx.d.v, _currentState, _currentInjectMode);
        if (!travel.valid) {
            validationErrors.push({ lineNum: i, error: travel.error, fix: travel.fix, raw: `[char:${tx.id} location]` });
            continue;  // don't push to validTxns
        }
    }
    // ──────────────────────────────────────────────────────────────

    // (Task 10b adds the validateTransition check here for TR ops)

    validTxns.push(tx);
}
```

One loop, all validations. This keeps the validation pipeline readable and avoids the `validTxns.splice` dance.

**Task 10b will extend this same loop** with the `validateTransition` check for TR ops. When implementing Task 10b, keep the travel check above it so format/travel failures short-circuit before the transition check.

**3d. State view formatter**

In `state-view.js`, add a `PLACES` section between `Factions:` and the `--- CURRENT STATE ---` header. Only show places that are anchors for active collisions or hold a TRACKED+ character's location (otherwise the registry inflates fast):

```javascript
const placeEntities = Object.values(state.places || {});
if (placeEntities.length) {
    lines.push('');
    lines.push('Places:');
    for (const p of placeEntities) {
        lines.push(`  ${p.name || p.id} [${p.state || 'unknown'}] (${p.reach || 'LOCAL'}) → id: ${p.id}`);
        if (p.description) lines.push(`    ${p.description}`);
    }
}
```

**3e. UI panel wiring**

`ui-panel.js` iterates `state[collection]` to render each entity tab. For the new `places` collection to appear in the panel:
- In the collection iteration loop (grep `Object.entries(state).forEach` or the tab-map definition around L1165/L1197), add a `places` entry: label `"Places"`, iterate `state.places`, render each place with fields `name`, `state`, `reach`, `description`.
- Follow the existing character/collision tab template — this is an additive tab, not a refactor.
- Verify the tab appears only when `Object.keys(state.places).length > 0` (mirror the existing collapse-when-empty pattern).

**3f. Readme update**

In `state-view.js` `formatReadmeCore()`, add under COMMON PATHS:
```
  place:id.name
  place:id.state
  place:id.reach
  place:id.description
```
And a CREATE example:
```
> CREATE place:warehouse-district name="Warehouse District" state=contested reach=DISTRICT description="Industrial sprawl south of the river. Quiet during daylight." -- New anchor
```

**Verify:**
- `node -c state-compute.js index.js consistency.js state-view.js`.
- Manual: Create a place via `CR place:test name="Test" reach=CITY`. Then try `S char:<id> field=location value=test` on a regular turn → correction queued. On advance turn → commits.

**Commit:** `feat(phase2): add place entity + travel plausibility (§2.4)`

---

### Task 4 (§3.1): Distance Category Field — **M**

**Why now:** Task 5 and Task 6 both depend on `distance_category` and its canonical starting values.

**Files touched:** `state-compute.js`, `index.js`, `state-view.js` (readme only).

**4a. Add the constant and CR normalization**

In `state-compute.js`, near the top-level constants, add:

```javascript
const CATEGORY_DISTANCES = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
```

Inside `applyTransaction`, `case 'CR'`, after the existing legacy-CRASHED normalization (L256–L264), and BEFORE the generic assignment to `state[collection][tx.id]`:

```javascript
if (tx.e === 'collision') {
    if (data.distance_category) {
        data.distance = CATEGORY_DISTANCES[data.distance_category] ?? 10;
    } else {
        // Old tx without category — default to SHORT
        data.distance_category = 'SHORT';
        if (data.distance == null) data.distance = 10;
    }
    if (!data.status) data.status = 'ACTIVE';
}
```

Export `CATEGORY_DISTANCES` so `index.js` can import it (used by foreshadowing %-threshold math).

**4b. Remove legacy `tier` default**

The current `state-compute.js` L262–L264 defaults collision tier to `'arc'` for back-compat. Phase 2 collision tiering is gone (replaced by `distance_category`). Leave the back-compat line for now (legacy tx still compute cleanly), but add a comment: `// Legacy field — Phase 2 uses distance_category instead.`

**4c. Audit warning in handleAdvanceButton**

In `index.js`, before the tick loop, add a warning-emit pass: if any committed tx in this turn is `S collision:... field=distance` or a `CR collision` missing `distance_category`, push a correction. Use the existing `_pendingCorrections` / `_pendingReinforcement` channel (not errors — corrections).

```javascript
// Somewhere near the start of onMessageReceived's post-commit block:
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

**4d. UI panel — distance_category display**

In `ui-panel.js`, find the collision card renderer (grep `collision.distance` or the block that writes the distance number onto each collision row). Display `distance_category` alongside the numeric distance:
- Format: `SHORT (7)` — category tag first, live distance in parens.
- If `distance_category` is missing (legacy collision), fall back to just the number.
- IMMEDIATE collisions: render the category tag with visual emphasis (CSS class or bold) since they fire same-turn and shouldn't be scrolled past.

This is a small change — one template-literal replacement per collision card render. Do not restructure the card layout.

**4e. Readme update**

In both `formatReadmeCore` and `formatReadmeFull`, replace the old `collision:id.distance` write-path documentation with:
- Keep `collision:id.distance_category` writable on CR.
- Mark `collision:id.distance` as engine-owned (read-only from LLM's perspective).
- New CR example:
  ```
  > CREATE collision:ada-betrayal name="Ada Betrayal" distance_category=MEDIUM forces="..." location=warehouse involved_chars=[ada,leon] -- New collision
  ```
- State machines block: simplify collision states to `ACTIVE → RESOLVED / CRASHED`.

**Verify:**
- `node -c`.
- Manual: `CR collision:t1 name="T" distance_category=SHORT forces="a"` — state view shows `dist:10`.

**Commit:** `feat(phase2): distance_category field + engine-owned distance (§3.1)`

---

### Task 5 (§3.2): Timeskip Multipliers — **M**

**Files touched:** `index.js` only.

> **Existing-commit context:** Commit `aea6598` (feat(collision): engine-side distance compression on Advance) already landed the tx-based compression flow in `handleAdvanceButton` — the `compressed[]` audit array, `tickTxns` batch append, and `_currentState` recompute are in place. **This task MODIFIES that flow to add timeskip-scale multipliers, advance preconditions, and the button lock.** It does NOT write the tick loop from scratch. Before editing, read the current `handleAdvanceButton` body and diff against the code below; the skeleton will look familiar — only the multiplier lookup, the WEEKS/MONTHS pressure clear, and the preconditions are new.

> **Spike before implementing (5a step — 15 min):** The reset line `S world field=timeskip_scale value=null` is fragile. In `applyTransaction` `case 'S'`, verify whether a JavaScript `null` round-trips through `ledgerStore.append()` → JSON serialization → replay as actual `null`, or as the string `"null"`. Test: append one manual `{op:'S', e:'world', id:'_', d:{f:'timeskip_scale', v:null}}`, reload the chat, inspect `state.world.timeskip_scale`. If it's string `"null"`, replace the reset with `{d:{f:'timeskip_scale', v:''}}` (empty string) AND update the `scale` resolution in 5a to treat `''` or `'HOURS'` as the default. This spike is blocking for 5a.

**5a. Replace fixed `-1` compression**

Current `handleAdvanceButton` (index.js L1978 onward, per commit aea6598) decrements every ACTIVE collision by 1 via `tickTxns`. **Modify** (do not rewrite) to make the decrement timeskip-scale-aware and add the WEEKS/MONTHS pressure clear.

Add near existing constants (around L70 with the other runtime constants):
```javascript
const TICK = { HOURS: 1, DAYS: 3, WEEKS: 10, MONTHS: 20 };
```

Rewrite the compression block inside `handleAdvanceButton`:

```javascript
// After committing the LLM's ledger block for this advance turn
// (i.e. after whatever commit happens in the current handleAdvanceButton code):

const state = _currentState;
const scale = (state.world?.timeskip_scale || 'HOURS').toUpperCase();
const tickDelta = TICK[scale] ?? 1;

const tickTxns = [];
const compressed = [];
for (const [id, col] of Object.entries(state.collisions || {})) {
    if ((col.status || '').toUpperCase() !== 'ACTIVE') continue;
    if (col.distance_category === 'IMMEDIATE') continue;
    const dist = parseFloat(col.distance);
    if (isNaN(dist) || dist <= 0) continue;
    const newDist = Math.max(0, dist - tickDelta);
    if (newDist !== dist) {
        tickTxns.push({ op: 'S', e: 'collision', id, d: { f: 'distance', v: newDist }, r: 'system:advance:tick' });
        compressed.push({ id, name: col.name || id, oldDist: dist, newDist });
    }
}

// WEEKS / MONTHS clears pressure points
if (scale === 'WEEKS' || scale === 'MONTHS') {
    for (const id of Object.keys(state.pressures || {})) {
        tickTxns.push({ op: 'D', e: 'pressure', id, r: `system:advance:${scale.toLowerCase()}-clear-pressure` });
    }
}

if (tickTxns.length) {
    await append(tickTxns);
    _currentState = computeCurrentState();
}

// Reset timeskip_scale
if (state.world?.timeskip_scale) {
    await append([{ op: 'S', e: 'world', id: '_', d: { f: 'timeskip_scale', v: null }, r: 'system:advance:reset-timeskip' }]);
    _currentState = computeCurrentState();
}
```

**5b. Advance preconditions (§3.2 §3.7 step 3 & 4)**

Before the tick loop:

```javascript
// Unresolved-arrival hard-block
const unresolved = Object.values(_currentState.collisions || {}).find(col =>
    (col.status || '').toUpperCase() === 'ACTIVE' &&
    parseFloat(col.distance) <= 0
);
if (unresolved) {
    toastr.error(`Unresolved arrival: "${unresolved.name}" has arrived (distance 0). Resolve it before advancing.`);
    return;
}

// PC safety advisory
const pcInCombat = Object.values(_currentState.combats || {}).some(c => (c.status || '').toUpperCase() === 'ACTIVE');
if (pcInCombat) {
    toastr.warning('PC is not in a safe position to timeskip. Consider resolving the current situation before advancing.');
    // Non-blocking
}
```

**5c. Advance button lock (§3.2)**

Wrap `handleAdvanceButton`:
```javascript
let _advanceLocked = false;
async function handleAdvanceButton() {
    if (_advanceLocked) return;
    _advanceLocked = true;
    try {
        // ... existing body ...
    } finally {
        _advanceLocked = false;
    }
}
```

Unlock also needs to happen on `MESSAGE_RECEIVED` completion — register a one-shot listener that sets `_advanceLocked = false` on the next received message. Simplest: keep the lock only for the duration of the handler, AND lock the button's DOM state (`.disabled = true`) until the chat receives the next assistant message. The DOM-level lock is done at the `click`-handler level:

```javascript
const btn = document.getElementById('gl-input-advance');
btn.disabled = true;
// ...
// Register a one-shot re-enable on MESSAGE_RECEIVED
const reenable = () => { btn.disabled = false; eventSource.off(event_types.MESSAGE_RECEIVED, reenable); };
eventSource.on(event_types.MESSAGE_RECEIVED, reenable);
```

**5d. Readme updates**

In `formatReadmeCore`:
- Add under COMMON PATHS:
  ```
  world.timeskip_scale    (advance turns only: HOURS|DAYS|WEEKS|MONTHS)
  ```
- Add to the advance-turn guidance:
  ```
  On advance turns, emit:
    S world field=timeskip_scale value=HOURS|DAYS|WEEKS|MONTHS
  Default: HOURS. WEEKS and MONTHS clear all pressure points.
  ```

**Verify:**
- `node -c index.js`.
- Manual: advance with `world.timeskip_scale=DAYS`, watch a SHORT (10) collision drop to 7. Advance with `MONTHS`, watch it drop to 0 AND all pressure entities get destroyed.

**Commit:** `feat(phase2): timeskip multipliers + advance preconditions (§3.2)`

---

### Task 6 (§3.3): IMMEDIATE Same-Turn Firing — **M**

**Files touched:** `index.js`.

**6a. Extract `buildAndInjectArrivals(ids, state)`**

This function is called from both `onMessageReceived` (for IMMEDIATEs created this turn) and `handleAdvanceButton` (for distance-0 arrivals after the tick). Place it near the existing arrival logic (currently at index.js L1232–L1441).

Signature and body (placeholder — Task 7 fills in the sanity-check payload):

```javascript
function buildAndInjectArrivals(ids, state) {
    const blocks = [];
    for (const id of ids) {
        if (_firedCollisionArrivals.has(id)) continue;
        _firedCollisionArrivals.add(id);
        const col = state.collisions[id];
        if (!col) continue;
        const draw = drawDivination();
        const proximity = checkProximity(col, state);
        const involvedSummary = buildInvolvedCharsSummary(col, state);
        const placeName = col.location
            ? (state.places?.[col.location]?.name || col.location)
            : null;
        const proximityLine = {
            'on-screen-plausible': 'Involved characters are at this location.',
            'off-screen-likely': 'Involved characters are currently elsewhere.',
            'unknown': 'Character locations relative to this collision are unknown.',
        }[proximity];
        blocks.push(buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine));
    }
    if (blocks.length > 0) {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(`${MODULE_NAME}_arrival`, blocks.join('\n\n'), PROMPT_IN_CHAT, 0);
    }
}
```

`checkProximity`, `buildInvolvedCharsSummary`, and `buildArrivalBlock` are stubbed in this task and fully implemented in Task 7.

**6b. Call from `onMessageReceived` for new IMMEDIATEs**

After the commit of `validTxns` and `computeState` refresh (index.js L1696), add:

```javascript
const immediateArrivals = committedTxns
    .filter(tx => tx.op === 'CR' && tx.e === 'collision'
        && tx.d?.distance_category === 'IMMEDIATE')
    .map(tx => tx.id)
    .filter(id => !_firedCollisionArrivals.has(id));
if (immediateArrivals.length > 0) {
    buildAndInjectArrivals(immediateArrivals, _currentState);
}
```

**6c. Guard non-IMMEDIATE checks to advance turns only**

The current `injectPrompt` function (index.js L1232+) runs arrival/resolution logic on EVERY call. Guard the distance-0 detection so it only fires inside `handleAdvanceButton`'s post-tick block (moved there as part of Task 7). In `injectPrompt`, remove the new-arrival detection loop entirely (L1249–L1269) — arrival is now event-driven, not every-inject.

**Verify:**
- Manual: regular turn with `CR collision:x distance_category=IMMEDIATE` — arrival prompt fires same turn.
- Regular turn with `CR collision:y distance_category=SHORT` — no arrival prompt, only foreshadowing (after Task 8).

**Commit:** `feat(phase2): IMMEDIATE same-turn collision firing (§3.3)`

---

### Task 7 (§3.5): Arrival Sanity-Check Gate — **L**

**Why now:** Eliminates the `_resolutionTracker` multi-turn machinery and replaces it with the single-shot sanity check from §3.5.

**Files touched:** `index.js` only.

**7a. Remove `_resolutionTracker` and phase constants**

Delete:
- `let _resolutionTracker = new Map();` (L68)
- `const RESOLUTION_PRESSURE_TURNS = 2;`, `RESOLUTION_INTRUSION_TURNS`, `RESOLUTION_CRASH_TURNS` (L70–L72)
- All reset sites: L1543, L2275, L2296 — just delete them.
- The entire "Resolution escalation" block inside `injectPrompt` (L1272–L1326) and the "RESOLVING but not in tracker" branch (L1328–L1336).
- The `═══ COLLISION ARRIVAL` legacy block construction (L1357–L1407) — will be replaced by `buildAndInjectArrivals`.
- Inside `handleAdvanceButton`, the `_resolutionTracker.set(...)` call (L2031–L2035) — delete.

**Keep:** `_firedCollisionArrivals` Set. Still one-shot dedupe.

**7b. Implement `checkProximity`**

```javascript
function checkProximity(col, state) {
    if (!col.location) return 'unknown';
    const involvedChars = (col.involved_chars || [])
        .map(id => state.characters[id])
        .filter(Boolean);
    if (involvedChars.length === 0) return 'unknown';
    const atLocation = involvedChars.filter(c => c.location === col.location);
    if (atLocation.length > 0) return 'on-screen-plausible';
    return 'off-screen-likely';
}
```

Note: uses `state.characters` per D1.

**7c. Implement `buildInvolvedCharsSummary`**

```javascript
function buildInvolvedCharsSummary(col, state) {
    const ids = Array.isArray(col.involved_chars) ? col.involved_chars : [];
    if (ids.length === 0) return 'no tracked characters';
    return ids.map(id => {
        const c = state.characters[id];
        if (!c) return id;
        const locName = c.location ? (state.places?.[c.location]?.name || c.location) : null;
        return locName ? `${c.name || id} @ ${locName}` : (c.name || id);
    }).join(', ');
}
```

**7d. Implement `buildArrivalBlock`**

Use the exact template from spec §3.5. Render as one template-literal string:

```javascript
function buildArrivalBlock(col, draw, involvedSummary, placeName, proximityLine) {
    const immediateNote = col.distance_category === 'IMMEDIATE'
        ? '\nThis collision arrives immediately — brief, sharp, decisive. Resolve in this scene.'
        : '';
    return `[GRAVITY — COLLISION ARRIVED: "${col.name || col.id}"]
Draw: ${draw.label} — ${draw.reading}

Forces: ${col.forces || '(unspecified)'}
Involved: ${involvedSummary}
Anchored at: ${placeName || 'unspecified'}
${proximityLine}${immediateNote}

SANITY CHECK — commit one of these NOW:

  ON-SCREEN — The collision's forces are present in this scene. Make it the central beat.
    Write it arriving. Then in the ledger:
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DIRECT
      S collision:${col.id} field=aftermath value="<what permanently changed>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] on-screen — <how> [hook] <handles> [aftermath] <change>"

  OFF-SCREEN — The forces resolved while characters were elsewhere. Choose:
    A) REFRAME — it mutated. Create a successor.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=EVOLVED
      A collision:${col.id} field=successor_collision_ids value=<new-id>
      CR collision:<new-id> name="..." distance_category=SHORT forces="..." ...
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] off-screen — mutated into <new-id> [hook] <handles> [aftermath] <change>"
    B) DISSOLVE — it ended quietly.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=DISSOLVED
      S collision:${col.id} field=aftermath value="<one sentence: what changed off-screen>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] off-screen — dissolved [hook] <any residue> [aftermath] <change>"

  IMPLODE — The narrative has moved completely past this.
      TR collision:${col.id} field=status from=ACTIVE to=RESOLVED
      S collision:${col.id} field=outcome_type value=IMPLODED
      S collision:${col.id} field=aftermath value="Imploded — narrative moved on."
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] imploded — <why> [hook] none [aftermath] n/a"

CRASHED status — if distance hits 0 and the scene does not engage:
      TR collision:${col.id} field=status from=ACTIVE to=CRASHED
      S collision:${col.id} field=outcome_type value=CRASHED
      S collision:${col.id} field=aftermath value="<consequence of being ignored>"
      A world field=collision_archive value="[collision] ${col.name || col.id} [resolution] crashed — ignored [hook] <consequence threads> [aftermath] <change>"

No multi-turn delay. This collision is decided this turn.`;
}
```

**7e. Fire arrivals in `handleAdvanceButton` after the tick**

Replace the existing ripe-collision detection block (L2021–L2043) with:

```javascript
// After tick + transition txns are committed
const newArrivals = [];
for (const [id, col] of Object.entries(_currentState.collisions || {})) {
    const status = (col.status || '').toUpperCase();
    const dist = parseFloat(col.distance);
    if (status === 'ACTIVE' && !isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
        newArrivals.push(id);
    }
}
if (newArrivals.length > 0) {
    buildAndInjectArrivals(newArrivals, _currentState);
}
```

**7f. Simultaneous arrivals (§3.5)**

When `newArrivals.length > 1`, the spec says LLM picks the most dramatic for ON-SCREEN and the rest must be OFF-SCREEN/IMPLODE. Implement by appending one extra header block to the injection:

```javascript
if (newArrivals.length > 1) {
    const names = newArrivals.map(id => `"${_currentState.collisions[id].name || id}"`).join(', ');
    blocks.unshift(`[SIMULTANEOUS ARRIVALS — ${newArrivals.length} collisions have arrived this turn: ${names}. ONLY ONE may resolve ON-SCREEN. Apply rule of cool — pick the most dramatically compelling. Resolve the rest OFF-SCREEN (REFRAME or DISSOLVE) or IMPLODE. Every arrived collision must be committed this turn.]`);
}
```

Do this inside `buildAndInjectArrivals` before the final `blocks.join('\n\n')`.

**Verify:**
- Manual: create two collisions, tick both to 0 with WEEKS advance → single `_arrival` block with the `SIMULTANEOUS ARRIVALS` header.
- Old chat with `_resolutionTracker` state in memory — delete ledger, reload, should not throw.

**Commit:** `feat(phase2): arrival sanity-check gate — remove multi-turn escalation (§3.5)`

---

### Task 8 (§3.4): Foreshadowing Threshold Injection — **M**

**Files touched:** `index.js`.

**8a. Runtime map**

Near `_firedCollisionArrivals`:
```javascript
let _foreshadowedCollisions = new Map(); // id → Set<'APPROACHING'|'IMMINENT'|'CONVERGING'>
```

Reset sites: everywhere `_firedCollisionArrivals = new Set()` appears (L1542, L2275, L2296). Mirror the reset.

**8b. `buildForeshadowingInjection(state)`**

Paste the spec §3.4 code verbatim. Use the exported `CATEGORY_DISTANCES` from `state-compute.js`. `buildForeshadowBlock` implementation:

```javascript
function buildForeshadowBlock(col, level) {
    const placeName = col.location ? (_currentState.places?.[col.location]?.name || col.location) : 'unspecified';
    const involved = buildInvolvedCharsSummary(col, _currentState);
    const guidance = {
        APPROACHING: 'A distant rumble. An offhand remark. Plant the seed.',
        IMMINENT: 'Someone moves differently. A name surfaces. The collision\'s forces are near.',
        CONVERGING: 'The forces are visibly in motion. Every other beat should carry their weight.',
    }[level];
    return `[FORESHADOW — ${level}]
"${col.name || col.id}" is drawing closer (${Math.round(parseFloat(col.distance))} ticks remaining).
Anchored at: ${placeName} | Involved: ${involved}
${guidance}
Weave its approach into the scene without making it the focus.`;
}
```

**8c. Inject slot**

Add near the end of `injectPrompt`:

```javascript
if (isRegular || isAdvance) {
    const foreshadow = _currentState ? buildForeshadowingInjection(_currentState) : null;
    if (foreshadow) {
        setExtensionPrompt(`${MODULE_NAME}_foreshadow`, foreshadow, PROMPT_IN_CHAT, 0);
    } else {
        setExtensionPrompt(`${MODULE_NAME}_foreshadow`, '', PROMPT_NONE, 0);
    }
}
```

Place after the existing `_nudge` set (L1484) so depth ordering is consistent.

**Verify:**
- Manual: create LONG collision (distance=50). Advance with HOURS 10 times (distance → 40) → APPROACHING fires. Continue to 25 → IMMINENT. Continue to 10 → CONVERGING. Each level fires once.

**Commit:** `feat(phase2): foreshadowing threshold injection (§3.4)`

---

### Task 8b (§8 step 8b): Rollback Resets — **M**

**Files touched:** `index.js` (and possibly `ooc-handler.js` + `snapshot-mgr.js` for a callback hook).

> **Complexity elevation rationale:** This is not a trivial wire-up. Rollback in this codebase goes `ooc-handler.rollback()` → `snapshot-mgr.rollback()` → mutates `chatMetadata.gravity_ledger` → re-runs replay. There is **no single callsite in `index.js`** that fires after rollback completes — the state recompute happens as a side effect inside `snapshot-mgr`. Before editing, audit the full call graph:
> 1. Grep for every call to `rollback(` across `ooc-handler.js`, `snapshot-mgr.js`, `index.js`, and `ui-panel.js`.
> 2. Identify whether `snapshot-mgr.rollback()` exposes a completion return/callback, or if callers already re-invoke `computeCurrentState()` afterward.
> 3. Decide the reset location: (a) add a new `onRollbackComplete` callback argument to `snapshot-mgr.rollback()` and invoke it from `index.js`'s OOC handler after the rollback call returns; OR (b) wrap every existing call site individually. Option (a) is cleaner if there are 2+ call sites.
>
> Once the callsite is nailed down, the actual reset is the three lines below.

Find the rollback call site (`ooc-handler.js` → `rollback()` → `snapshot-mgr.js`). After rollback completes in `index.js` (search for where `computeCurrentState` is re-called after rollback), add:

```javascript
_firedCollisionArrivals = new Set();
_foreshadowedCollisions = new Map();
_archiveInjectedVersion = null;   // see Task 13
```

If there is no single rollback-completion callsite in `index.js`, add one. Search `ooc-handler.js` for `rollback` — the OOC handler delegates to snapshot-mgr. The state recompute happens in `_currentState = computeCurrentState()` after the OOC. Wrap that in `index.js` wherever the handler's result lands.

**Verify:** Create a collision, advance several times until foreshadowed, then `OOC: rollback` — foreshadow fires again on next advance.

**Commit:** `fix(phase2): reset arrival/foreshadow maps on rollback (§8 step 8b)`

---

### Task 9 (§7.2): Combat Ephemeral — **S**

**Files touched:** `challenge-state.js`, `state-view.js`.

> **Existing-commit context:** Commit `0928d88` (feat(combat): thin combat entity to engine stats only) already removed most narrative fields from combat ledger writes. **What's left for this task:** confirm `exchange` is the last field still written as a ledger tx (grep `challenge-state.js` for `exchange:` inside `d:{...}` payloads), and strip just that field + its state-view display. Do NOT re-thin the entity wholesale — most of that work is done. If grep shows `exchange` is already gone from tx payloads, this task collapses to state-view display removal + readme cleanup only. Verify before editing.

**9a. Stop emitting `combat.exchange` transactions**

In `challenge-state.js`, grep for `exchange:` inside transaction payloads (L1008–L1123). Two spots currently write `combat.exchange` as committed state:
- The runtime-update tx path that sets `exchange: Math.max((runtime.exchange || 1) + 1, ...)`.
- The auto-seed `exchange: 1` in `seedFields` (check `challenge-profile-combat.js` for the seed — if present there, remove).

Remove both from the transaction payload while **keeping** `runtime.exchange` updated in `gravity_challenge_runtime` metadata (runtime-only, not a ledger tx).

Concretely: delete the `exchange` key from the `d:` object passed to `append([{...}])` in those two locations.

**9b. Remove exchange from state-view registry and detail**

In `state-view.js` L246 and L394:
```javascript
if (combat.exchange != null) combatLine += ` exch:${combat.exchange}`;
```
Delete both lines.

**9c. Readme**

In `formatReadmeCore` COMMON PATHS, remove `combat:id.exchange`. Keep `combat:id.status`, `primary_enemy`, `opened_from`, `outcome`, `aftermath`.

**Verify:** Start a combat challenge; cycle exchanges; state view never shows `exch:` and ledger never shows `combat.exchange` transactions.

**Commit:** `refactor(phase2): combat exchange is ephemeral — removed from ledger (§7.2)`

---

### Task 10 (§6.1): Wire `validateTransition()` — **M**

**Per D4:** wire from `index.js`, not `consistency.js`.

**Files touched:** `index.js`, `state-machine.js`.

**10a. Simplify collision state machine**

In `state-machine.js`, replace `COLLISION_STATES` and `COLLISION_TRANSITIONS`:

```javascript
const COLLISION_STATES = ['ACTIVE', 'RESOLVED', 'CRASHED'];

const COLLISION_TRANSITIONS = {
    ACTIVE:   { resolve: 'RESOLVED', crash: 'CRASHED' },
    RESOLVED: {},
    CRASHED:  {},
};
```

Remove `SEEDED`, `SIMMERING`, `RESOLVING` from the flow. Any old tx targeting those states will fail `validateTransition` and be rejected — this is desired after Phase 2.

**Back-compat:** `state-compute.js` L256–L296 already normalizes `CRASHED` on CR/TR/S. Leave it. Legacy `SEEDED`/`SIMMERING`/`RESOLVING` values on existing collisions will stay until the LLM transitions them; for **new** transitions, `validateTransition` will refuse anything that doesn't land in `ACTIVE`/`RESOLVED`/`CRASHED`.

Add a one-time migration in `computeState` final pass (before returning):
```javascript
for (const col of Object.values(state.collisions || {})) {
    const st = (col.status || '').toUpperCase();
    if (['SEEDED', 'SIMMERING', 'RESOLVING'].includes(st)) {
        col.status = 'ACTIVE';
    }
}
```

**10b. Call `validateTransition` in `onMessageReceived`**

Import: `import { validateTransition } from './state-machine.js';` (already imported at index.js L19 — `getStateMachineField` is already there, add `validateTransition`).

**Extend the per-tx validation loop from Task 3c.** By the time Task 10 runs, Task 3c has already converted L1670–L1681 into a single walk over `extractedTransactions` with format + travel checks inline. Add the transition check as a third pre-push guard in that same loop:

```javascript
for (let i = 0; i < extractedTransactions.length; i++) {
    const tx = extractedTransactions[i];
    const formatResult = validateBatch([tx]);
    if (!formatResult.valid) {
        validationErrors.push({
            lineNum: i,
            error: formatResult.errors.map(e => e.message).join('; '),
            raw: `[validated tx ${i}]`,
        });
        continue;
    }

    // Travel check (from Task 3c) sits here — keep it above transition check
    // so travel failures short-circuit before validateTransition.

    if (tx.op === 'TR') {
        const transitionResult = validateTransition(tx.e, tx.d.f, tx.d.from, tx.d.to);
        if (!transitionResult.valid) {
            validationErrors.push({
                lineNum: i,
                error: transitionResult.error,
                fix: transitionResult.fix,
                raw: `[tr ${tx.e}:${tx.id}]`,
            });
            continue;
        }
    }
    validTxns.push(tx);
}
```

Order of checks in the final loop: (1) format, (2) travel, (3) transition. Each failure pushes a correction and `continue`s; only txns that pass all three reach `validTxns.push(tx)`.

**10c. Correction wording**

The correction injection in `regex-intercept.js`'s `buildCorrectionInjection` already emits `fix` text when present. Confirm that `fix` is passed through: search for `err.fix` in the correction path. If missing, add `${err.fix ? ' — ' + err.fix : ''}` to the correction line.

**10d. Archive presence check on terminal collision TR (§2.2.1)**

After committing the tx batch, scan committed tx for terminal collision TR (`TR collision:... from=ACTIVE to=RESOLVED|CRASHED`). For each, check if the same batch also contains an `A world field=collision_archive` append. If not, queue a correction:
```
`Missing archive entry for resolved collision ${id}. Add: A world field=collision_archive value="[collision] ... [resolution] ... [hook] ... [aftermath] ..."`
```
Track attempts per collision id in a new `Map<id, number>` called `_archiveCorrectionAttempts`. On the 4th attempt, auto-generate the fallback per D6:
```javascript
await append([{
    op: 'A', e: 'world', id: '_',
    d: { f: 'collision_archive', v: `[collision] ${col.name} [resolution] ${col.outcome_type} — auto-generated (archive missing after 3 attempts) [hook] none [aftermath] ${col.aftermath || 'unknown'}` },
    r: 'system:archive:auto-fallback',
}]);
_archiveCorrectionAttempts.delete(id);
```

`_archiveCorrectionAttempts` is runtime-only; reset on rollback and on chat change (join the same resets Task 8b added).

**Verify:**
- Manual: try `MOVE collision:x field=status from=ACTIVE to=IMPLODED` → rejected with correction listing `RESOLVED, CRASHED`.
- Manual: `MOVE collision:x field=status from=ACTIVE to=RESOLVED` without an `A world field=collision_archive` append → correction fires. After 3 turns without fix, auto-generated fallback appears.

**Commit:** `feat(phase2): wire validateTransition + archive-presence check (§6.1, §2.2.1)`

---

### Task 11 (§2.5, §4.1): Pressure Entity Type — **L**

**Files touched:** `state-compute.js`, `consistency.js`, `state-view.js`, `index.js`, `ui-panel.js`.

> **Existing-commit context:** Commits `0798552` (pressure ignition engine) and `35706f2` (advance beat engine) added a substantial **flash/arc/saga tier system** and several helper functions on top of the old `world.pressure_points` array model. This task is **not a greenfield entity addition** — it is a migration that simultaneously:
> 1. Introduces the new `pressure:<id>` entity (additive).
> 2. **Strips the tier system** (flash/arc/saga) and every function that reads or writes it.
> 3. Deletes the pressure-ignition and advance-beat-engine code paths that the new rotating nudge (Task 14) replaces.
>
> **Functions to delete in `index.js`** (from the commits above): `buildFlashIgnition`, `buildAdvanceBeats`, `buildPressurePointAudit`, `getPressurePoints`, `getPressurePointAgeTx`, `classifyPressurePointAge`, `scorePressurePointAgainstDraw`, plus the `DIVINATION_THEME_TABLE` table. Also strip any `_flashIgnition*` / `_advanceBeats*` runtime state. Grep `flash|saga|arc_tier|ignition|advance_beat` across all JS and clean up every hit.
>
> **Complexity elevation rationale:** this is why the task is **L** rather than **M** — delete ~500 lines of tier/ignition code, add the entity CR handler, add FIFO drop, add state view, add readme, add ui-panel tab wiring. Budget half a day.

**11a. Schema**

- `consistency.js`: add `'pressure'` to `VALID_ENTITIES`.
- `state-compute.js`:
  - Add `pressures: {},` to `createEmptyState()`.
  - Add `pressure: 'pressures'` to `getCollectionName`.
  - In `applyTransaction`'s `case 'CR'` for `pressure`:
    ```javascript
    if (tx.e === 'pressure') {
        data.created_at_tx = tx.tx;  // engine-set — tx.tx is already monotonic across the ledger
    }
    ```
    LLM-supplied `created_at_tx` gets overwritten — this is intentional. **Do NOT introduce a separate `_txIndex` counter on state** — `tx.tx` (the sequence number assigned by `ledger-store.append()`) is already monotonic and is the right source of truth. The FIFO-drop step in 11b orders pressure entities by `created_at_tx` directly, no separate counter needed.

  - The `diffStates` iterated-collections list gets `'pressures'` added.

**11b. FIFO cap (MAX_PRESSURE_POINTS = 5)**

In `index.js`, constant block:
```javascript
const MAX_PRESSURE_POINTS = 5;
const MAX_COLLISIONS = 5;
const MAX_COLLISION_ARCHIVE = 20;
```

After each `CR pressure:...` commit (inside the same committed-tx processing loop in `onMessageReceived`), check pool size and auto-drop:

```javascript
const pressureIds = Object.keys(_currentState.pressures || {});
if (pressureIds.length > MAX_PRESSURE_POINTS) {
    const sorted = pressureIds
        .map(id => ({ id, created_at_tx: _currentState.pressures[id].created_at_tx ?? 0 }))
        .sort((a, b) => a.created_at_tx - b.created_at_tx);
    const toDrop = sorted.slice(0, sorted.length - MAX_PRESSURE_POINTS);
    const dropTxns = toDrop.map(p => ({
        op: 'D', e: 'pressure', id: p.id,
        r: 'system:pressure:fifo-overflow',
    }));
    if (dropTxns.length) {
        await append(dropTxns);
        _currentState = computeCurrentState();
    }
}
```

This emits real `D pressure:...` transactions so ledger replay stays deterministic.

**11c. Strip old `world.pressure_points` field (D3)**

- `state-compute.js` `createEmptyState()`: remove `pressure_points: []` from `world`.
- Silent-drop in replay: in `applyTransaction`, intercept old `A world field=pressure_points` and `R world field=pressure_points` operations and skip them (same pattern as the `summary` drop). Log at debug level.
- `state-view.js`: remove the old `PRESSURE POINTS` section that reads `state.world.pressure_points` (L460–L476). Replace with the new one (§11d below).
- `index.js`: remove `buildPressurePointAudit`, `getPressurePoints`, `getPressurePointAgeTx`, `classifyPressurePointAge`, `buildFlashIgnition`, `scorePressurePointAgainstDraw`, and `DIVINATION_THEME_TABLE` (L397–L655). These belong to the old pressure-point-on-world model. The new `pressure` entity has its own rotating nudge.
- Remove `ARRAY_SIZE_LIMITS.pressure_points` from `checkArraySizes` (L1493).
- Remove references in `buildAdvanceBeats` (L1943–L1944 write `REMOVE the pressure point from world.pressure_points` — update to use entity form).

**11d. Pressure state-view formatter (compact bullet list, omit when empty)**

In `state-view.js`, after the `Places:` section:

```javascript
const pressureEntities = Object.values(state.pressures || {});
if (pressureEntities.length) {
    lines.push('');
    lines.push('Pressure Points:');
    for (const p of pressureEntities) {
        const related = Array.isArray(p.related_to) && p.related_to.length
            ? ` → ${p.related_to.join(', ')}`
            : '';
        lines.push(`  • ${p.name || p.id} [${p.source || '?'}]${related}`);
    }
}
```

Do NOT inject pressure entities into the current state detail section — compact registry only. The rotating nudge (Task 14) handles maintenance prompts.

**11e. UI panel — pressure tab wiring**

Mirror the `places` tab added in Task 3e:
- In `ui-panel.js`, add a `pressures` entry to the collection iteration / tab map (label `"Pressures"`).
- Render each pressure with fields `name`, `source`, `related_to` (as comma-joined list), and `created_at_tx` (as a small muted annotation like `tx:42` for debuggability).
- Collapse-when-empty — do not show a header-only tab.
- Also strip the **old** `world.pressure_points` rendering if it exists in ui-panel.js (grep `pressure_points` — the old model may have had its own panel block). Delete alongside the state-view strip in 11c.

**11f. Readme update (formatReadmeCore and Full)**

Add under OPERATIONS (or a new PRESSURE POINTS section):
```
> CREATE pressure:border-tension name="Border tension" source="faction:vela" related_to=[char:pc,faction:vela] -- New seam
> DESTROY pressure:border-tension -- Consumed into collision
```

Add to COMMON PATHS:
```
pressure:id.name
pressure:id.source
pressure:id.related_to
```

**Verify:**
- Manual: create 6 pressures rapidly → oldest by `created_at_tx` dropped via auto-D transaction.
- Advance with `timeskip_scale=MONTHS` → all pressures destroyed.

**Commit:** `feat(phase2): pressure entity with FIFO cap + MAX_COLLISIONS constant (§2.5, §4.1)`

---

### Task 12 (§4.2): Collision Pool Cap Enforcement — **S**

**Files touched:** `index.js`.

After each turn's commit, check `MAX_COLLISIONS`:

```javascript
const activeNonImmediate = Object.values(_currentState.collisions || {})
    .filter(c => (c.status || '').toUpperCase() === 'ACTIVE'
        && c.distance_category !== 'IMMEDIATE');
if (activeNonImmediate.length > MAX_COLLISIONS) {
    _pendingCorrections.push({
        text: `Collision pool has ${activeNonImmediate.length} active non-IMMEDIATE collisions (cap ${MAX_COLLISIONS}). Consolidate: merge two with the MERGE flow, or IMPLODE the least relevant one. IMMEDIATE collisions are exempt.`,
        attempts: 0,
    });
}
```

Do not hard-block the CR; just push a correction. FIFO on corrections is the default — they're consumed in insertion order. No code change needed to enforce FIFO beyond using an array (which is the current impl).

**Verify:** Create 6 non-IMMEDIATE collisions → correction appears on the next injection.

**Commit:** `feat(phase2): collision pool cap warning (§4.2)`

---

### Task 13 (§2.2.1, §4.3): Collision Archive + Seeding-When-Empty — **M**

**Files touched:** `state-compute.js`, `state-view.js`, `index.js`.

**13a. Archive append handler and cap**

In `state-compute.js`, `applyTransaction` `case 'A'`, after the existing append logic, add post-append trim specific to `collision_archive`:

```javascript
if (tx.e === 'world' && tx.d?.f === 'collision_archive') {
    const arr = state.world.collision_archive;
    if (Array.isArray(arr) && arr.length > 20) {
        state.world.collision_archive = arr.slice(-20);
    }
}
```

Ensure `createEmptyState().world.collision_archive = []`.

**13b. State view archive injection**

In `state-view.js`, add a helper `formatCollisionArchive(state)`:

```javascript
function formatCollisionArchive(state) {
    const archive = Array.isArray(state.world?.collision_archive) ? state.world.collision_archive : [];
    const active = Object.values(state.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE');
    if (active.length > 2) return null;   // only surface when pool is thin
    const last5 = archive.slice(-5);
    if (last5.length === 0) return null;
    return '\n\nCOLLISION ARCHIVE (recent resolutions — dormant hooks for reseeding):\n' +
        last5.map(entry => `  - ${entry}`).join('\n');
}
```

Call it from `formatStateView` after the collision section. Append result if non-null.

**13c. `_archiveInjectedVersion` dedupe**

In `index.js`, near other runtime maps:
```javascript
let _archiveInjectedVersion = null;
```

Compute version hash as `${state.world?.collision_archive?.length || 0}:${activeCount <= 2 ? 'thin' : 'ok'}`. Only regenerate archive injection when version changes. Reset on rollback (Task 8b).

The simplest place to wire this is inside `injectPrompt` — skip the archive block when `newVersion === _archiveInjectedVersion`, otherwise update and inject.

**13d. `collision_health` seeding prompt**

Part of rotating nudge (Task 14 slot 3). Spec requires the health check to fire **every advance turn** in addition to its rotation slot. Wire in `handleAdvanceButton` after the tick:

```javascript
const pressureCount = Object.keys(_currentState.pressures || {}).length;
const activeCollisions = Object.values(_currentState.collisions || {})
    .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
if (pressureCount === 0 && activeCollisions === 0) {
    setExtensionPrompt(`${MODULE_NAME}_nudge_maintenance`,
        buildCollisionHealthSeedingPrompt(_currentState),
        PROMPT_IN_CHAT, 0);
}
```

`buildCollisionHealthSeedingPrompt` is the slot-3 template from Task 14.

**Verify:** Resolve a collision with an archive append — state view shows ARCHIVE section only when ≤ 2 ACTIVE collisions remain.

**Commit:** `feat(phase2): collision archive trim + archive injection when pool thin (§2.2.1, §4.3)`

---

### Task 14 (§4.4): Rotating Nudge System — **L**

**Files touched:** `index.js` primarily.

> **Existing-commit context:** Commit `8a47eb8` (feat(nudge): simplify per-turn nudge prompt) landed a simplified per-turn nudge into the `_nudge` slot. **This task EXTENDS that work** — it doesn't replace the simplified per-turn nudge; it adds a *second* slot (`_nudge_maintenance`) that rotates through the 7 builder slots every 4 turns with its own counter/slot/rotation-index metadata. Leave the per-turn `_nudge` slot alone. All counter/slot/rotation-index keys in 14a are new metadata — not a rename of anything existing.

**14a. Persistence keys (D7)**

```javascript
const NUDGE_COUNTER_KEY = 'gravity_nudge_counter';
const NUDGE_SLOT_KEY = 'gravity_nudge_slot';
const NUDGE_ROTATION_INDEX_KEY = 'gravity_nudge_rotation_index';
```

Helpers:
```javascript
function getNudgeCounter() {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata?.[NUDGE_COUNTER_KEY] ?? -3;
}
async function setNudgeCounter(n) {
    const ctx = SillyTavern.getContext();
    ctx.chatMetadata[NUDGE_COUNTER_KEY] = n;
    await ctx.saveMetadata?.();
}
// same shape for slot and rotation index
```

**14b. Slot builders**

Seven nudge builders, one per slot. Each returns a string (the `[GRAVITY NUDGE — ...]` block) or `null` if inapplicable.

```javascript
function buildNudge_agendaCheck(state, rotIdx) {
    const candidates = Object.values(state.characters)
        .filter(c => c.tier === 'PRINCIPAL' || c.tier === 'TRACKED');
    if (candidates.length === 0) return null;
    const char = candidates[rotIdx % candidates.length];
    return `[GRAVITY NUDGE — agenda_check]
Review ${char.name || char.id}'s agenda${char.agenda ? ` (current: "${char.agenda}")` : ' (not set)'}. Has this scene or recent events shifted their direction?
If yes: S char:${char.id} field=agenda value="..."
If unchanged, skip.`;
}

function buildNudge_pressureScan(state) {
    return `[GRAVITY NUDGE — pressure_scan]
Identify any new pressure points from this scene. A pressure point is a small tension — unresolved, not yet a collision. If present:
CR pressure:<slug> name="..." source="..."
Cap is 5; oldest auto-drops.`;
}

function buildNudge_consolidationCheck(state) {
    const pressures = Object.values(state.pressures || {});
    if (pressures.length === 0) return null;
    return `[GRAVITY NUDGE — consolidation_check]
Review active pressure points (${pressures.length}). Can any be combined into a collision or fed into an existing one?
- 3+ related seams → CR collision with distance_category; D the consumed pressures.
- Matches an existing collision's forces → S that collision's forces and involved_chars; D the consumed pressures.`;
}

function buildNudge_collisionHealth(state) {
    const pressureCount = Object.keys(state.pressures || {}).length;
    const activeCount = Object.values(state.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
    if (pressureCount > 0 || activeCount > 0) return null;
    return buildCollisionHealthSeedingPrompt(state);
}

function buildCollisionHealthSeedingPrompt(state) {
    const archive = Array.isArray(state.world?.collision_archive) ? state.world.collision_archive.slice(-5) : [];
    const archiveHook = archive.length
        ? `\nRecent archive (dormant hooks):\n${archive.map(a => '  - ' + a).join('\n')}`
        : '';
    return `[GRAVITY NUDGE — collision_health — POOLS EMPTY]
No active collisions AND no pressure points. Nothing is driving the narrative.
Seed from one of: character agendas, faction tensions, unresolved knowledge_asymmetry entries (knows/unknown/hiding/misreading — look for asymmetric awareness between two subjects), constraints at STRESSED+ integrity, recent world state changes.${archiveHook}

Emit at least one CR pressure:... OR one CR collision:... with distance_category.`;
}

function buildNudge_relationshipPulse(state, rotIdx) {
    const candidates = Object.values(state.characters)
        .filter(c => c.tier === 'PRINCIPAL' || c.tier === 'TRACKED');
    if (candidates.length === 0) return null;
    const char = candidates[rotIdx % candidates.length];
    const isPrincipal = char.tier === 'PRINCIPAL';
    return `[GRAVITY NUDGE — relationship_pulse]
Has this scene affected ${char.name || char.id}'s relationship with the PC?${isPrincipal
    ? `\nIf significant, log a key moment: A char:${char.id} field=key_moments value="[moment] ... [hook] ... [weight] ..."`
    : '\nUpdate char:' + char.id + '.relationships.pc if their read of the PC shifted.'}`;
}

function buildNudge_collisionValidity(state) {
    const active = Object.values(state.collisions || {})
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE');
    if (active.length === 0) return null;
    return `[GRAVITY NUDGE — collision_validity]
Review active collisions (${active.length}). Has the narrative made any of them irrelevant, redundant, or impossible?
If yes, IMPLODE:
  TR collision:<id> field=status from=ACTIVE to=RESOLVED
  S collision:<id> field=outcome_type value=IMPLODED
  S collision:<id> field=aftermath value="<one line>"
  A world field=collision_archive value="[collision] ... [resolution] imploded — <why> [hook] none [aftermath] n/a"`;
}

function buildNudge_destroyedCleanup(state) {
    return `[GRAVITY NUDGE — destroyed_cleanup]
Scan for destroyed character IDs still referenced in collision.involved_chars, faction.members, or pressure.related_to. Remove stale references with S (overwrite array) or MR operations. Max 2–3 cleanup ops per turn.`;
}
```

**14c. Slot dispatcher**

```javascript
const NUDGE_BUILDERS = [
    buildNudge_agendaCheck,        // 0
    buildNudge_pressureScan,       // 1
    buildNudge_consolidationCheck, // 2
    buildNudge_collisionHealth,    // 3
    buildNudge_relationshipPulse,  // 4
    buildNudge_collisionValidity,  // 5
    buildNudge_destroyedCleanup,   // 6
];

async function maybeInjectNudge(state, currentMode) {
    if (currentMode === 'integration') return;  // no nudges on setup/chapter-close/timeskip
    const counter = getNudgeCounter();
    const everyFourth = counter % 4 === 0;
    if (!everyFourth) {
        await setNudgeCounter(counter + 1);
        return;
    }
    // Advance slot
    let slot = (SillyTavern.getContext().chatMetadata?.[NUDGE_SLOT_KEY] ?? 0) % 7;
    let rotIdx = SillyTavern.getContext().chatMetadata?.[NUDGE_ROTATION_INDEX_KEY] ?? 0;
    const builder = NUDGE_BUILDERS[slot];
    const nudge = builder(state, rotIdx);
    // Advance counter, slot, and rotation index regardless of skip
    const nextSlot = (slot + 1) % 7;
    const nextRot = (slot === 0 || slot === 4) ? rotIdx + 1 : rotIdx;  // char rotation only on char-related slots
    const ctx = SillyTavern.getContext();
    ctx.chatMetadata[NUDGE_SLOT_KEY] = nextSlot;
    ctx.chatMetadata[NUDGE_ROTATION_INDEX_KEY] = nextRot;
    await ctx.saveMetadata?.();
    await setNudgeCounter(counter + 1);

    if (nudge) {
        ctx.setExtensionPrompt(`${MODULE_NAME}_nudge_maintenance`, nudge, PROMPT_IN_CHAT, 0);
    } else {
        ctx.setExtensionPrompt(`${MODULE_NAME}_nudge_maintenance`, '', PROMPT_NONE, 0);
    }
}
```

**14d. Wire into `onMessageReceived`**

Near the end of `onMessageReceived` (after `_currentState = computeState(...)`), call:
```javascript
await maybeInjectNudge(_currentState, _currentInjectMode);
```

**14e. Advance-turn collision_health override**

In `handleAdvanceButton`, after the tick:
```javascript
const pressureCount = Object.keys(_currentState.pressures || {}).length;
const activeCount = Object.values(_currentState.collisions || {})
    .filter(c => (c.status || '').toUpperCase() === 'ACTIVE').length;
if (pressureCount === 0 && activeCount === 0) {
    setExtensionPrompt(`${MODULE_NAME}_nudge_maintenance`,
        buildCollisionHealthSeedingPrompt(_currentState),
        PROMPT_IN_CHAT, 0);
}
```

This runs regardless of `_nudgeCounter`.

**14f. Cleanup on chat change / reset**

Add to the existing chat-change reset block (index.js L2264 region):
```javascript
delete chatMetadata[NUDGE_COUNTER_KEY];
delete chatMetadata[NUDGE_SLOT_KEY];
delete chatMetadata[NUDGE_ROTATION_INDEX_KEY];
```

**Verify:** Fresh chat → first 3 regular turns emit no nudge; turn 4 → `agenda_check` (or skip to `pressure_scan` if no PRINCIPAL/TRACKED chars). Continue 4 turns → next slot fires. `OOC: advance` with empty pools → `collision_health` fires.

**Commit:** `feat(phase2): rotating nudge system + collision_health seeding (§4.4)`

---

### Task 15 (§2.8): Preset Vocabulary Update — **M**

**Why last:** The preset is the LLM's command grammar. Updating it before the code ships would make the LLM emit commands the engine rejects. Updating it after PR-F means one clean cutover — engine speaks Phase 2, preset speaks Phase 2.

**Files touched:** `gravity_v14.json` (copy to `gravity_v15.json` and edit — never mutate a released preset in place), `Gravity World Info.json` mode playbooks (any that reference stripped vocabulary).

**Scope:** This task produces a **new preset file** (`gravity_v15.json`) that matches the Phase 2 engine. It is a separate PR (**PR-G**) from the code because (a) preset edits have their own review cadence, and (b) the preset cannot ship before the engine code it depends on.

**Checklist — the preset must be updated to include/remove each of these:**

- [ ] **Distance category vocabulary.** All collision examples use `distance_category=IMMEDIATE|SHORT|MEDIUM|LONG` instead of numeric `distance=N` on CR. Document that `distance` is engine-owned (written only as side-effect of timeskip ticks). Remove any guidance that tells the LLM to decrement or set `distance` directly.
- [ ] **Pressure entity vocabulary.** Replace every example that uses `A world field=pressure_points value="..."` with `CR pressure:<slug> name="..." source="..." related_to=[...]`. Add a `D pressure:<slug>` example for consolidation-into-collision. Document the 5-entry cap and the FIFO auto-drop (LLM should know oldest drops silently so it doesn't spam).
- [ ] **Place entity vocabulary.** Document `CR place:<slug> name reach state description`. List the reach enum: `LOCAL|DISTRICT|CITY|REGIONAL|REMOTE`. Document that `S char:<id> field=location` to a place ID triggers the travel plausibility check on non-advance turns.
- [ ] **`world.timeskip_scale`.** Document the advance-turn emission: `S world field=timeskip_scale value=HOURS|DAYS|WEEKS|MONTHS`. Note that the engine auto-resets this after the tick. Note that WEEKS/MONTHS clears all pressure points.
- [ ] **Arrival sanity-check terminology.** Document the `ON-SCREEN | OFF-SCREEN (REFRAME | DISSOLVE) | IMPLODE` commit choices from the arrival prompt. Include the `CRASHED` status case for ignored collisions. Remove any legacy references to multi-turn resolution escalation (atmosphere / intrusion / crash phases).
- [ ] **Chapter command removal.** Strip every `CR chapter:`, `TR chapter:... field=status`, `S chapter:...` example from the preset. Strip chapter-close OOC guidance. Remove the chapter-integration turn-mode prompt if present.
- [ ] **Four-map `knowledge_asymmetry` operations.** Per D9, the ops use `MS char:<id> field=knowledge_asymmetry.<map> key=<subject> value="..."` where `<map>` ∈ `knows|unknown|hiding|misreading`. Remove any references to `secrets_held` / `blind_spots` in the preset. The subject key convention (entity id, or free-form for non-entities) should be documented with at least one example per map.
- [ ] **Yi Jing / I Ching strip.** Remove every reference to `iching`, `yi jing`, `hexagram`, trigrams, or `1d64` draws from divination guidance. The draw system is only `arcana` or `classic` after Phase 2.
- [ ] **Combat `exchange` field.** Remove any LLM-facing instruction to `S combat:<id> field=exchange value=N`. The engine owns exchange as runtime state. If the preset had a combat-turn template referencing exchange counters, rewrite to reference the runtime-displayed value without emitting a tx.
- [ ] **Collision state-machine.** Replace any `TR collision:<id> field=status from=SEEDED to=SIMMERING` (or any path through `SEEDED|SIMMERING|RESOLVING`) with the new `ACTIVE → RESOLVED | CRASHED` flow. Add the `outcome_type` field as part of every TR-to-terminal example.
- [ ] **Collision archive append.** Every example that shows `TR collision:... from=ACTIVE to=RESOLVED|CRASHED` must be paired with an `A world field=collision_archive value="[collision] ... [resolution] ... [hook] ... [aftermath] ..."` append, so the LLM learns the pair-emit pattern.
- [ ] **Rotating nudge slot names.** Document the seven slot names (`agenda_check`, `pressure_scan`, `consolidation_check`, `collision_health`, `relationship_pulse`, `collision_validity`, `destroyed_cleanup`) so the LLM recognizes the injected prompt and responds in kind. Include the rule that `collision_health` may fire off-rotation on advance turns when pools are empty.

**Verification:**
- Import the new preset into a fresh chat. Run a 20-turn smoke playthrough: setup → 3 regular turns → advance DAYS → regular → advance WEEKS. Watch for engine corrections. Zero corrections = preset matches engine.
- Grep the preset JSON for each stripped term (`iching`, `chapter`, `SEEDED`, `SIMMERING`, `RESOLVING`, `exchange`, `secrets_held`, `blind_spots`, `pressure_points`). Zero hits.
- Confirm the preset still passes SillyTavern's own JSON validation (`JSON.parse` it in Node).

**Commit:** `feat(phase2): preset v15 — align vocabulary with Phase 2 engine (§2.8)`

---

## 4. Cross-Cutting Concerns

### 4.1 Back-Compat Replay

Legacy chats on `codex-v13-state-delta` contain:
- `summary` transactions → already silently dropped.
- `chapter` transactions → Task 2 adds silent drop.
- `A world field=pressure_points` → Task 11c adds silent drop.
- Collision `SEEDED/SIMMERING/RESOLVING` states → Task 10a normalizes to `ACTIVE` on replay.

The ledger is append-only. **Never rewrite history.** All back-compat happens at computation time in `state-compute.js` only.

### 4.2 Prompt Slot Summary (Phase 2 end state)

After Phase 2, the active `setExtensionPrompt` slots are:

| Slot | Source |
|---|---|
| `_state` | state-view (every turn) |
| `_readme` | state-view (every turn) |
| `_inject` | corrections + reinforcement |
| `_nudge` | turn-mode flag block |
| `_nudge_maintenance` | Task 14 rotating nudge |
| `_setup` | wizard phase prompt |
| `_ooc` | OOC button injections |
| `_arrival` | Task 7 sanity-check gate |
| `_foreshadow` | Task 8 threshold prompts |
| `_intimacy` | intimacy stance enforcement |
| `_faction` | heartbeat (every 10 turns) |
| `_dormant` | dormant char nudge (every 15 turns) |
| `_exemplars` | style exemplars |
| `_pressure` | **REMOVED** in Task 11c (replaced by rotating nudge) |
| `_challenge` | challenge runtime (combat) |
| `_dist_warn` | **REMOVED** in Task 7 (folded into arrival/correction flow) |

### 4.3 Preset Update — Task 15 / PR-G

Now covered in Task 15 (PR-G). The preset is the last deliverable; the code is useless without it. See Task 15's checklist for the full list of vocabulary that must change.

---

## 5. Testing Strategy

No test framework, no CI. All verification is manual + syntax. For each PR:

### PR-A (Tasks 1–2)
1. `node -c` on every touched file.
2. Open an existing chat (with chapter tx); verify UI does not show chapter panel, no console errors.
3. Switch divination system via UI; verify arcana and classic work, iching option is gone.

### PR-B (Task 3)
1. `node -c`.
2. In a new chat, `CR place:warehouse name="W" state=contested reach=DISTRICT` → state view lists it.
3. `CR char:npc name="X" tier=TRACKED location=warehouse` → works.
4. `S char:npc field=location value=other-city` where other-city has `reach=CITY`, on a regular turn → correction fires and tx rejected.
5. Same move on advance turn → commits.

### PR-C (Tasks 4–6)
1. `CR collision:t name="T" distance_category=SHORT forces="a"` → state view shows `dist:10`.
2. Advance with `S world field=timeskip_scale value=DAYS` → distance drops to 7.
3. Advance with MONTHS → distance drops to 0, all pressures (if any) destroyed.
4. Create `CR collision:imm name="IMM" distance_category=IMMEDIATE forces="now"` on a regular turn → `_arrival` fires the same turn.
5. Try advance while another collision sits at distance 0 ACTIVE → rejected with toast.

### PR-D (Tasks 7–8b)
1. Create MEDIUM collision (dist 20); advance HOURS 5 times → foreshadow APPROACHING fires once at dist ≤ 16.
2. Continue advancing → IMMINENT fires at ≤ 10, CONVERGING at ≤ 4.
3. Tick to 0 → single `_arrival` block with sanity-check gate (no more multi-turn escalation).
4. `OOC: rollback` to before foreshadow → next advance fires APPROACHING again.
5. Create two MEDIUM collisions; tick both to 0 in same advance → single `_arrival` block with `SIMULTANEOUS ARRIVALS` header.

### PR-E (Tasks 9–10)
1. Start a combat challenge; cycle exchanges; state view never shows `exch:`; ledger export shows no `S combat... exchange` tx.
2. `MOVE collision:x field=status from=ACTIVE to=IMPLODED` → correction fires, tx rejected.
3. Resolve a collision without archive append → correction fires on next turn. Fail to fix 3 times → auto-fallback archive appears.

### PR-F (Tasks 11–14)
1. Create 6 pressures rapidly → oldest by `created_at_tx` auto-destroyed.
2. Create 6 non-IMMEDIATE ACTIVE collisions → correction warns about pool cap.
3. Resolve a collision with an `A world field=collision_archive` append; bring active pool to 2 → state view shows ARCHIVE section. Raise pool back above 2 → section disappears.
4. Fresh chat, 4 regular turns → `agenda_check` fires on turn 4. Another 4 → `pressure_scan`. Etc.
5. Advance with both pools empty → `collision_health` fires regardless of counter.
6. **Ledger replay determinism after auto-D pressure drops.** This is the subtle one and easy to miss: the FIFO auto-drop in Task 11b emits real `D pressure:...` transactions into the ledger. If those tx are ordered differently across replays — or if a rollback discards them while the pre-drop `CR pressure` tx survive — replayed state will diverge.
   - **Test sequence:** In a fresh chat, `CR pressure:p1 .. p6` one per regular turn (or in quick batches); watch the auto-D fire for `p1`. Run `OOC: snapshot`. Run `OOC: advance HOURS` (tick, no tx). Run `OOC: rollback` to the pre-advance snapshot. Then `OOC: advance HOURS` again.
   - **Expected:** pressure set after the second advance is identical to after the first (i.e. `p2..p6`). If `p1` reappears, the rollback-truncated-tx path kept the `CR p1` but dropped the `D p1`, and determinism is broken.
   - **Fix if broken:** move the FIFO cap enforcement into `state-compute.js` (stateless, replay-pure) instead of `index.js` (imperative post-commit). Alternative: snapshot the pressure collection at snapshot time and re-apply the D tx on rollback. Flag as a Phase 2 blocker if it shows up.

### PR-G (Task 15)
1. Import `gravity_v15.json` into a fresh chat; run setup + 20 regular/advance turns.
2. Zero engine corrections fired = preset matches engine. Any correction = preset bug.
3. Grep the preset JSON for stripped terms (see Task 15 verification). Zero hits.

Run all six PR-F sequences end-to-end after PR-F. Any regression = back-commit and debug. PR-G is final.

---

## 6. Open Risks

1. **Prompt-injection slot bloat.** After Phase 2 there are ~13 active slots. If the state view plus nudge plus foreshadow plus arrival all fire on one turn, context pressure rises significantly. Watch token counts after PR-D and PR-F.
2. **`_pendingCorrections` queue shape.** Several tasks (4, 10, 12, 13) push corrections. The existing queue shape is `{ text, attempts }` — confirm before extending. If the format differs, align all new pushes.
3. **`S world field=timeskip_scale value=null`** — the current `S` handler accepts any value. Verify the null set doesn't coerce to the string `"null"` in replay; if it does, use `value=""` or delete the field via a different mechanism.
4. **`buildCorrectionInjection` fix-text propagation.** Confirm (before Task 10) that `fix` text already shows in the injected correction. If not, add it in `regex-intercept.js` formatter.
5. **Legacy preset**: until the preset is updated, the LLM will keep emitting old commands (`chapter`, `pressure_points+`, `distance=6`). The engine's back-compat drops + corrections will prevent crashes but the chat will be noisy. Socialize the preset-update ETA before merging PR-A.

---

## 7. Done-Criteria Checklist

A Phase 2 engineer should be able to tick every box before declaring done:

- [ ] All `node -c <file>.js` pass on every JS file in the repo root.
- [ ] Grep `iching|ICHING_|1d64|hexagram` returns 0 hits.
- [ ] Grep `chapter|chapters|CHAPTER_` returns 0 functional hits (only the silent-drop handler remains).
- [ ] `createEmptyState()` has keys: `characters, constraints, collisions, combats, factions, places, pressures, world, pc, divination, lastTxId, _history`. No `chapters`, no `world.pressure_points`.
- [ ] `VALID_ENTITIES` in `consistency.js` = `['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'world', 'pc', 'divination', 'summary']` (summary retained for back-compat).
- [ ] `state-machine.js` collision transitions = `ACTIVE → RESOLVED | CRASHED`. No SEEDED/SIMMERING/RESOLVING.
- [ ] `_resolutionTracker` and phase constants are gone from `index.js`.
- [ ] `_firedCollisionArrivals`, `_foreshadowedCollisions`, `_archiveInjectedVersion`, `_archiveCorrectionAttempts` all reset on rollback and chat change.
- [ ] IMMEDIATE collision created on a regular turn fires arrival in the same turn.
- [ ] Advance turn with `world.timeskip_scale=WEEKS` destroys all pressure entities.
- [ ] `collision_archive` appends are capped at 20, trim from oldest.
- [ ] Rotating nudge advances every 4 normal turns starting from turn 4.
- [ ] Phase 2 preset (out of plan scope) updated and committed separately.

When every box is ticked: cut a final commit `chore(phase2): done-criteria verified`, open a PR from `codex-v13-state-delta` → `main`, and request review.
