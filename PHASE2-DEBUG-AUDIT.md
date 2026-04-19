# Phase 2 — Export & Debuggability Audit

**Audit date:** post-merge, commit `9d29420`
**Repo state:** all Phase 2 fixes (6046ea4) + all deep-audit fixes (F-D1–F-D17) landed at root.
**Scope:** what can someone debugging a live SillyTavern session actually extract from (a) the export button and (b) the console logs?
**Not in scope:** anything covered by prior audits that's already remediated.

---

## TL;DR

The export is a **partial snapshot** — it captures the ledger transactions and snapshots that live under `chatMetadata['gravity_ledger']`, and nothing else. It does not include nine sibling `chatMetadata` keys that the engine reads/writes every turn (nudge counters, challenge runtime, exemplars, cold memory) or any of the ~15 module-scoped runtime maps (`_firedCollisionArrivals`, `_foreshadowedCollisions`, `_archiveCorrectionAttempts`, `_archiveInjectedVersion`, `_turnCounter`, nudge cached text, etc.). The round-trip is asymmetric on purpose: `handleImportData` actively deletes the sibling keys before importing, so even if you could round-trip them, the import path would strip them.

The console-log surface is thin and biased toward lifecycle events. **12 of the project's 19 .js files produce zero console output** — including the entire challenge subsystem, `state-compute.js`, `state-machine.js`, `consistency.js`, `regex-intercept.js`, `ooc-handler.js`. The logging that exists is mostly `console.log` for "this happened" and `console.error` for exception branches; there's no structured logging of decisions (why was this TR rejected? why was the archive re-injected? why did the nudge fire slot 3 instead of slot 2?). No debug flag, no `window.__gravity`, no runtime inspection API.

Against the 8 concrete failure-mode scenarios the user asked about, **6 of 8 cannot be diagnosed from logs + export alone** and require source-level debugging. The top three fixes (detailed at end) would move that to 2 of 8.

---

## A. Export gaps

The export pipeline:

```
ui-panel.js:1223 handleExport
  └─ index.js:2170 handleExportData
       └─ ledger-store.js:234 exportData() → returns chatMetadata['gravity_ledger']
```

`exportData()` is a one-liner: `return getLedgerData();` where `getLedgerData()` returns the `gravity_ledger` key content: `{ transactions, snapshots, lastTxId, createdAt, updatedAt }`. That's it. Everything else in `chatMetadata` is invisible to the exporter, and everything in JS module scope is invisible by definition.

### A1 — Export omits 9 sibling `chatMetadata` keys (P1)

**Evidence:** `handleNewLedger` (index.js:2145–2168) enumerates every sibling key the extension touches — it deletes each on new-ledger creation. `handleImportData` (index.js:2174–2195) deletes the same set before restoring. Those 9 keys are:

- `gravity_cold` — cold memory storage
- `gravity_cold_watermarks` — cold-memory sync markers
- `gravity_combat_runtime` — legacy combat runtime (migrated to challenge)
- `gravity_combat_settings` — combat settings (difficulty, thresholds)
- `gravity_challenge_runtime` — current challenge session state (`CHALLENGE_RUNTIME_KEY` at `challenge-state.js:48`)
- `gravity_challenge_settings` — challenge settings
- `gravity_exemplars` — user-flagged good-prose paragraphs (read at index.js:1142, written at 2047)
- `gravity_nudge_counter` — `NUDGE_COUNTER_KEY`, index.js:84
- `gravity_nudge_slot` — `NUDGE_SLOT_KEY`, index.js:85
- `gravity_nudge_rotation_index` — `NUDGE_ROTATION_INDEX_KEY`, index.js:86

None of these are in the export. A session with, say, 40 turns of play under `NUDGE_COUNTER = 37`, `NUDGE_SLOT = 2`, a live challenge runtime, 12 saved exemplars, and a populated cold memory — exports with none of that surviving. Re-importing means the engine starts from `NUDGE_COUNTER = -3` (the fresh-chat default at index.js:925), the challenge session is gone, the exemplar pool is empty, cold memory is blank.

**Severity:** P1. This is a genuine round-trip defect, not just a debug gap. Anyone using export/import to move a session between machines or branches loses real state.

**Fix direction:** wrap the ledger data in an envelope:

```
{
  schema_version: 2,
  gravity_ledger: { ... },       // what's exported today
  gravity_exemplars: [...],
  gravity_challenge_runtime: {...},
  gravity_challenge_settings: {...},
  gravity_nudge_counter: N,
  gravity_nudge_slot: N,
  gravity_nudge_rotation_index: N,
  gravity_cold: {...},
  gravity_cold_watermarks: {...},
}
```

`handleImportData` already knows the full key list (it deletes them) — the same list drives a symmetric restore. Keep backward compatibility by detecting the envelope shape: if `data.transactions` is at top level, treat as a v1 export (current shape); if `data.schema_version === 2`, restore from the keyed fields.

### A2 — Export omits `_turnCounter` (P1)

**Evidence:** `_turnCounter` is a module-scoped `let` at index.js:45. It increments at `onMessageReceived` (index.js:1408). It resets to 0 in `initialize` (index.js:1344), which is called on chat change and on import completion. It is never persisted to `chatMetadata` and never included in the export.

**Downstream effect:** faction heartbeat (index.js:1154 `_turnCounter % 10 === 0`) and dormant-character check (index.js:1174 `_turnCounter % 15 === 0`) depend on it. After an import, these periodic checks restart from 0, which means a session imported at turn 38 may skip a scheduled faction heartbeat that was about to fire. Not a session-breaker, but measurable cadence drift.

**Severity:** P1 because the bug is unambiguously lost state, not just debug info.

**Fix direction:** either persist `_turnCounter` under a new `chatMetadata` key and load it in `initialize()`, or derive it at init time as `allTransactions.filter(tx => tx.e !== 'system').length` (approximate — not every regular turn emits a TX). The persisted approach is cleaner. Include it in the A1 envelope.

### A3 — Export omits all module-scoped runtime maps (P2)

**Evidence:** index.js declares ~15 module-scoped `let`s (lines 43–81). None are exported. On import, `handleImportData` (index.js:2187–2193) resets `_pendingCorrections`, `_pendingReinforcement`, `_firedCollisionArrivals`, `_foreshadowedCollisions`, `_arrivalLastFiredTurn`, `_archiveCorrectionAttempts`, `_archiveInjectedVersion` — explicitly acknowledging they exist but wiping them.

**The ones that measurably matter:**

- `_firedCollisionArrivals` Set — tracks which collision IDs have already triggered the arrival sanity-check gate. If a session is exported mid-arrival-decision and re-imported, those collisions can re-fire. Spec §3.5 says `_firedCollisionArrivals` is the one-shot dedup for the sanity-check gate. After import: empty set → potential duplicate arrivals.
- `_foreshadowedCollisions` Map — tracks which foreshadow levels (APPROACHING/IMMINENT/CONVERGING) have already fired per collision. Spec §3.4. After import: empty map → potential duplicate foreshadows.
- `_archiveCorrectionAttempts` Map — the attempt counter for the F-D15 auto-fallback mechanism. If a collision has been waiting 2 turns for an archive entry and the session is exported + imported, the counter resets to 0. The auto-fallback clock restarts.
- `_archiveInjectedVersion` — dedup hash for the archive state-view injection. After import: `null` → redundant archive re-injection on the first post-import turn (harmless but wasteful; spec §2.2.1 explicitly notes this behavior around page reload).
- `_turnCounter` — covered by A2.

**The ones that are correctly not exported** (session-local, no meaning across boundaries):

- `_pendingCorrections`, `_pendingReinforcement`, `_pendingOOCInjection`, `_pendingNudgeText` — turn-scoped injection queues. OK to reset.
- `_currentInjectMode`, `_currentReasonMode`, `_lastCompletedMode`, `_pendingDeductionType`, `_pendingManualDivination` — per-turn mode flags. OK to reset.
- `_uncappedTurn`, `_advanceLocked`, `_autoSnapshotInterval` — UI/lock state. OK to reset.

**Severity:** P2. The behavior is "mostly works, with small observable drift." Spec §2.2.1 already documents the archive dedup reset on page reload as acceptable, which sets a precedent: transient dedup maps can rebuild. But the F-D15 auto-fallback counter losing its progress on import is a harder pill — it means a stubborn LLM that refused to archive for 3 turns pre-export gets 3 fresh attempts post-import, and the auto-fallback never fires.

**Fix direction:** persist the critical dedup maps (`_firedCollisionArrivals`, `_foreshadowedCollisions`, `_archiveCorrectionAttempts`) into a new `chatMetadata['gravity_runtime']` key. Load them in `initialize()`. Reset only on `handleNewLedger`, not on `handleImportData`. The less-critical ones (`_archiveInjectedVersion`) can stay transient. Update the A1 envelope to include the new key.

### A4 — Export format has no schema version (P2)

**Evidence:** `exportData()` returns `chatMetadata['gravity_ledger']` verbatim. The shape is `{ transactions, snapshots, lastTxId, createdAt, updatedAt }` — no `schema_version`, no `gravity_version`, no `phase: 2` marker.

`handleImport` in ui-panel.js:1244–1267 validates only that `data.transactions` is an array. If a Phase 1 export (which has the same basic shape but different transaction semantics — `chapter`, `story_summary`, SEEDED/SIMMERING/RESOLVING collision statuses) is loaded, it parses as valid and imports silently. `state-compute.js` DOES silently migrate some of this (line 265 drops `chapter`/`summary`; line 282 migrates SEEDED/SIMMERING/RESOLVING → ACTIVE), but the user has no indication that a legacy file was imported.

**Severity:** P2. Not a failure mode most users will hit, but when it happens the diagnosis is painful.

**Fix direction:** on export, stamp `schema_version: 2` and `phase: 'phase-2'` into the envelope. On import, check the version and either (a) warn if missing/older, or (b) emit a console log and a toastr info showing what was imported. The real win isn't hard enforcement — it's telling the developer at a glance which schema they're looking at.

### A5 — Snapshot-cap behavior asymmetric with handleImportData expectations (P3)

**Evidence:** `saveSnapshot` at ledger-store.js:200–210 caps snapshots at 5. Export serializes whatever's there. Import just writes `data` into `chatMetadata[METADATA_KEY]` verbatim — no cap enforcement. If a developer hand-crafts an import JSON with 20 snapshots, the engine accepts them and the 5-cap only reasserts itself on the next `saveSnapshot` call.

**Severity:** P3. No practical impact. Flag it for documentation.

**Fix direction:** either enforce the cap at import time (`data.snapshots = (data.snapshots || []).slice(-5)` before the assign), or document the asymmetry.

### A6 — Export filename uses `_currentBookName` which may be stale (P3)

**Evidence:** ui-panel.js:1233 — `a.download = \`${_currentBookName || 'gravity-ledger'}.json\``. `_currentBookName` is set via `setBookName()` (ui-panel.js), which `index.js:1371` calls with the SillyTavern `chatId` after init. If the user changes chat and exports before another init fires, the filename could be wrong.

**Severity:** P3.

**Fix direction:** read the chat name fresh from `SillyTavern.getContext().chatId` at export time, not from the cached variable.

### A7 — No sensitive-data audit at export time (P3, informational)

**Evidence:** the export is `chatMetadata['gravity_ledger']` — which is what SillyTavern persists per-chat. It does not include API keys, auth tokens, or user identity. Transactions contain prose (scene descriptions, character names, agendas) that the user explicitly typed or had the LLM generate about the chat, which the user obviously knows is in their session. The `gravity_cold` cold-memory key (if populated) may contain longer-form extracted story memory, but again that's session-generated.

**Severity:** P3 — no action required, but worth noting that the export does NOT leak any credential data, only the gameplay state the user created.

---

## B. Logging gaps

### B0 — Inventory

| File | `console.*` calls | `toastr.*` calls |
|---|---|---|
| index.js | 21 | 9 |
| ui-panel.js | 1 | 10 |
| ledger-store.js | 2 | 0 |
| snapshot-mgr.js | 2 | 0 |
| state-view.js | 2 | 0 |
| setup-wizard.js | 1 | 0 |
| **Total** | **29** | **19** |

**Files with zero log output:**

- `challenge-state.js` (~1500 lines)
- `challenge-profile-combat.js`
- `challenge-profiles.js`
- `challenge-mechanics.js`
- `challenge-shared.js`
- `challenge-input.js`
- `combat-state.js`
- `consistency.js` (the validation surface wired into every commit)
- `state-machine.js` (where every TR rejection originates)
- `state-compute.js` (where all transactions get applied and migrated)
- `ooc-handler.js` (every `OOC:` command passes through here)
- `regex-intercept.js` (ledger-block extraction from LLM output)

**That's 12 of 19 .js files with zero console surface.** Every rejected TR, every silent migration, every OOC command — all pass through these files invisibly. What reaches the console is only the high-level lifecycle: `Initialized for chat X`, `Committed N TX, M errors`, `Chat changed`, `Persisted`, `Loaded`.

No debug flag (`window.__gravity_debug`, `DEBUG_GRAVITY`, or similar) exists. Grep returns zero matches for `__gravity`, `gravity_debug`, `DEBUG`, `window\.__`. There's no documented knob to turn up verbosity.

### B1 — `validateTransition` rejections are counted, not explained (P1)

**Evidence:** In `consistency.js::validateTransitions` (lines 254–279), every rejected TR produces a structured error object with `{lineNum, error, fix, raw, tx}`. That error is pushed into `validationErrors`. At index.js:1538, the count is logged:

```javascript
console.warn(`${LOG_PREFIX} ${allErrors.length} errors queued for correction.`);
```

That's it. The individual error messages, the `from→to` pair that failed, the entity IDs — none of that reaches the console. The full detail is only visible to the LLM via the next-turn correction injection.

**Scenario cost:** developer reports "my character got stuck in a state-machine dead-end." Opens DevTools. Sees `4 errors queued for correction.` Can't tell which entity, which field, which transition. Has to either inspect the ledger export, open the next turn's injection payload, or add a `console.log` in validateTransitions.

**Severity:** P1.

**Fix direction:** log one line per rejection at `console.warn` with `{entityType, id, field, from, to}`. Example:

```
[GravityLedger] TR rejected: collision:c1 status RESOLVED→ACTIVE — terminal state, no transitions allowed
```

Low spam (TR rejections are rare) and every one is a real signal.

### B2 — Archive injection decision is invisible (P1)

**Evidence:** index.js:1079–1084:

```javascript
const archiveVersion = computeArchiveVersion(_currentState);
const includeArchive = archiveVersion !== _archiveInjectedVersion;
const stateViewMode = getStateViewMode(...);
const stateView = formatStateView(_currentState, stateViewMode, includeArchive);
setExtensionPrompt(`${MODULE_NAME}_state`, stateView, PROMPT_IN_CHAT, 0);
if (includeArchive) _archiveInjectedVersion = archiveVersion;
```

No log. If the archive is expected to surface on turn 40 (pool went thin) and the user reports "the archive injection stopped working," there's no way to tell from logs whether:

- `computeArchiveVersion` changed from prior value (should inject)
- It matched prior value (was correctly suppressed)
- The formatter returned empty because pool wasn't actually thin
- Something upstream failed silently

**Severity:** P1.

**Fix direction:** one log line per turn when `includeArchive` is true:

```
[GravityLedger] Archive inject fired: version=${archiveVersion}, entries=${n}, pool=thin
```

And a single log on skip (at `console.log` debug level) noting the dedup hit.

### B3 — Snapshot rollback has no top-level log (P1)

**Evidence:** `snapshot-mgr.js::rollback` (lines 102–122) appends a ROLL transaction and fires `_rollbackListeners`. It does NOT log the fact that a rollback happened. The only console line is a `console.warn` if a listener throws. The OOC rollback handler (ooc-handler.js:61–65) returns an LLM-facing injection but doesn't log.

**Scenario:** user reports "rollback happened but some runtime maps weren't cleared." The listener registered in index.js:2207 DOES clear the five runtime maps. If something ELSE (like a lingering UI state, or a runtime variable the listener forgets) is stale, the developer has no console signal that rollback ran, let alone when.

**Severity:** P1.

**Fix direction:** `console.log(\`${LOG_PREFIX} Rolled back to snapshot #${id} (${listenerCount} listeners fired)\`)` in `snapshot-mgr.js::rollback` after the listener loop. Also log each listener's index as it fires (silent-on-success, warn-on-throw).

### B4 — Corrections queue lifecycle is opaque (P2)

**Evidence:** `queueCorrections` (index.js:550–566) increments attempts per-item and logs only when dropping after 3 attempts (line 558). New corrections go in silently. The queue is drained by `clearMatchedCorrections` (not grepped here but presumably exists) and by the injection path. An LLM that consistently fixes corrections on turn N+1 leaves no trace; one that never fixes leaves a single "dropped after 3 attempts" line per stuck item.

**F-D15 territory:** the rewritten archive-presence check (index.js:1613–1639) calls `queueCorrections` every turn a RESOLVED/CRASHED collision remains unarchived. That's exactly the behavior F-D15 was designed for — but from the console, all you see is `N errors queued for correction.` You can't tell if the same correction has been queued 3 times or if 3 different corrections were queued once each.

**Severity:** P2.

**Fix direction:** log per-item when the `attempts` counter hits 1, 2, 3. Example:

```
[GravityLedger] correction attempt 2/3 for [collision:c1 archive]
```

Also log when auto-fallback fires (F-D15's archive auto-append) — currently that path at index.js:1628–1631 has an empty `catch (_) {}` but no success log either.

### B5 — Silent catches hide real failures (P2)

**Evidence:** three empty catches in index.js:

- Line 1631: archive auto-fallback append — swallows any failure. If `append` throws (ledger-store persist error), the auto-fallback silently never lands.
- Line 1652: `saveChatDebounced` — swallows any failure. The visible-ledger HTML injection may fail to persist.
- Line 1726: pressure FIFO drop append — swallows any failure. Pressure overflow is silently not recorded.

Each is labelled `/* non-critical */` but none logs on failure.

**Severity:** P2 — genuinely likely to fail only in weird states, but when they do they're hard to diagnose.

**Fix direction:** replace each `catch (_) { /* non-critical */ }` with `catch (err) { console.warn(\`${LOG_PREFIX} <operation> failed (non-critical):\`, err); }`. Keeps the non-fatal semantics but leaves a breadcrumb.

### B6 — Nudge rotation is invisible (P2)

**Evidence:** `maybeComputeNudge` (index.js:999–1036) silently advances the counter, picks a slot, may or may not emit text based on eligibility (e.g. slot 0 `agenda_check` skips if no TRACKED/PRINCIPAL chars). On any turn, there's no way to tell from the console whether:

- A nudge was supposed to fire but was suppressed (empty eligible list)
- The slot advanced but the handler returned null (pressure_scan with empty pool)
- The nudge fired and is waiting in `_pendingNudgeText`

**Scenario:** user reports "an agenda was never requested from the LLM for a TRACKED character" — the F-D5 on-promotion audit plus the F-D5 rotation both fire agenda-related prompts. If neither fired, the developer can't tell which gate blocked: is the slot rotation at slot 3 (collision_health) right now? Did `eligible.length === 0`?

**Severity:** P2.

**Fix direction:** one log line per turn when nudge actually fires:

```
[GravityLedger] nudge slot ${slot}=${slotName} fired (counter=${counter}, rotIdx=${rotIdx})
```

And on slot-advance-with-no-emit:

```
[GravityLedger] nudge slot ${slot}=${slotName} skipped (no eligible chars | empty pool | etc)
```

### B7 — Foreshadow decisions are invisible (P2)

**Evidence:** `buildForeshadowingInjection` (index.js:886–916) is pure — it iterates collisions, checks the `_foreshadowedCollisions` Map, picks a level, fires. No logging. If a collision is expected to foreshadow at IMMINENT (pct ≤ 0.50) but doesn't, the developer can't tell whether:

- The collision is IMMEDIATE (skipped, line 889)
- Status isn't ACTIVE (skipped, line 890)
- distance math returned NaN (skipped, line 894)
- Level already fired (subsumption check, line 896–902)
- computeArchiveVersion cached a stale state

**Severity:** P2.

**Fix direction:** when a foreshadow fires, log `[GravityLedger] foreshadow <level> for collision:${id} (dist ${current}/${start}, pct ${pct.toFixed(2)})`. Skip the log for the "no new level to fire" branch (that's the common case). One or two lines per advance turn at most.

### B8 — IMMEDIATE vs post-tick arrival distinction is invisible (P2)

**Evidence:** `buildAndInjectArrivals` (index.js:832–867) logs `Collision arrival injection: ${blocks.length} block(s)` on success. It's called from three places:

- `onMessageReceived` for IMMEDIATE collisions (index.js:1699)
- `applyAdvanceTick` for post-tick arrivals (index.js:1905)
- (In theory) from rollback paths — but not currently

The log doesn't distinguish these paths. A developer seeing `arrival injection: 2 block(s)` can't tell if those are IMMEDIATEs, post-tick arrivals, or a mix.

**Severity:** P2.

**Fix direction:** parameterize `buildAndInjectArrivals` with a `source` string ('immediate' | 'advance_tick' | 'rollback') and include it in the log. Or log from the three callsites individually with their context.

### B9 — `applyAdvanceTick` operation sequence is opaque (P2)

**Evidence:** `applyAdvanceTick` (index.js:1858–1911) performs the whole post-tick pipeline — read scale, tick distances, clear pressure on WEEKS/MONTHS, reset timeskip_scale, detect arrivals, fire collision_health nudge. No logging at any step.

**Scenario:** user reports "the extension is silently not advancing timeskip." Is the issue:

- Wrong `_lastCompletedMode` (tick didn't run at all)?
- `_currentState.world.timeskip_scale` null / missing (defaulted to HOURS)?
- No ACTIVE collisions (tick found nothing to tick)?
- All ACTIVE collisions are IMMEDIATE (skipped)?
- Something threw and was caught?

None of those distinctions are visible.

**Severity:** P2.

**Fix direction:** log one summary line at the end of `applyAdvanceTick`:

```
[GravityLedger] advance tick: scale=${scale}, delta=${tickDelta}, ticked=${tickTxns.length} collisions, pressureCleared=${pressureClearedCount}, newArrivals=${newArrivalIds.length}
```

### B10 — Consistency validation failures have no per-tx log (P2)

**Evidence:** `validateBatch` / `validateFormat` (consistency.js) produces structured violations; they're used by the format-check layer. On the caller side (index.js:1500+ area, inside the per-tx loop), rejected transactions are pushed into `validationErrors` silently. At index.js:1539 there's the `${allErrors.length} errors queued` log — same blind spot as B1.

**Severity:** P2 (same class as B1, different site).

**Fix direction:** paired with B1 — one unified helper `logValidationFailure(kind, tx, error)` that formats each rejection consistently whether it comes from format or transition validation.

### B11 — Challenge subsystem is fully silent (P2)

**Evidence:** grep returns zero `console.*` or `toastr.*` calls in `challenge-state.js`, `challenge-profile-combat.js`, `challenge-profiles.js`, `challenge-mechanics.js`, `challenge-shared.js`, `challenge-input.js`. These files implement the entire combat (and future persuasion/racing) session model — including lifecycle, input parsing, assistant-turn processing, action resolution.

**Scenario:** "combat session appears locked but no options are rendering." The diagnosis requires source-level inspection or adding logs.

**Severity:** P2. The challenge system is outside Phase 2's primary scope but is the most complex subsystem without log coverage.

**Fix direction:** at minimum, log challenge session start/end with `{kind, entity_id, phase}`. If `processChallengeAssistantTurn` emits a correction, log what triggered it. Reserve verbose per-action logs behind a debug flag (see B12).

### B12 — No debug flag (P3)

**Evidence:** grep returns no matches for `window.__gravity`, `DEBUG_GRAVITY`, `gravity_debug`, or any similar toggle. All logging is unconditional: every chat change fires a log, every persist fires a log. There's no way to dial up verbosity for debugging without editing the source.

**Severity:** P3 — informational.

**Fix direction:** introduce `const DEBUG = () => !!window.__gravity_debug;` and gate the verbose logs (per-TR rejection, per-foreshadow, per-nudge-slot) behind `if (DEBUG()) console.log(...)`. Document the toggle in AGENTS.md. Keep lifecycle logs (init, chat change, persist) always-on.

### B13 — `console.log` used for things that might merit `warn` (P3)

**Evidence:**

- index.js:2134 — "Message swiped — ledger may be stale." This is actually a concerning state (the LLM's output no longer matches state) yet uses `console.log`. The UI actually fires `toastr.warning` for the user, but the console says `log` (wrong severity).
- index.js:2139 — same for "Message deleted — ledger may be stale."
- ui-panel.js:589 — `toastr.warning('Message swiped/deleted — ledger may be out of sync. Run Eval to check.')` — this one IS warn. Good example of what the console pair should match.

**Severity:** P3.

**Fix direction:** demote the two "may be stale" logs to `console.warn`.

### B14 — `toastr` alerts that rapidly auto-dismiss can be missed (P3, UX)

**Evidence:** `toastr.info`, `toastr.success` in index.js and ui-panel.js fire for events like combat difficulty change, setup complete, exemplar saved. If a user runs multiple OOC commands rapidly (snapshot → rollback → eval), toastr messages stack and auto-dismiss. Without the console record, there's no audit trail of what the user did.

**Severity:** P3.

**Fix direction:** every `toastr.info`, `toastr.success`, `toastr.warning` should be paired with `console.log` (info/success) or `console.warn` at the same site. `toastr.error` should be paired with `console.error` including the underlying `err` object.

---

## C. Debuggability gaps — the 8 failure-mode scenarios

For each scenario: can a developer diagnose from (a) console logs + (b) export JSON, without source-level debugging? Summary at the top.

| # | Scenario | Diagnosable today? |
|---|---|---|
| 1 | Character stuck in state-machine dead-end | ✗ |
| 2 | Archive injection stopped working after turn 40 | ✗ |
| 3 | Agenda never requested for a TRACKED character | ✗ |
| 4 | Rollback happened but runtime maps weren't cleared | ✗ |
| 5 | Collision foreshadowed at wrong distance category | ✗ |
| 6 | Extension silently not advancing timeskip | ✗ |
| 7 | LLM emitted DISSOLVED and something went wrong downstream | Partial |
| 8 | `getStateMachineField` arg-count bug (pre-F-D6) | ✗ |

6 of 8 require source-level debugging. Detail:

### C1 — Character stuck in state-machine dead-end (FAIL)

**What's visible:** if the LLM keeps trying to `TR char:x tier FOO→BAR` where FOO is already terminal or BAR isn't adjacent, `validateTransitions` rejects. Index.js logs only `N errors queued for correction.` No entity, field, or from/to information.

**What's missing:** the specific `{entityType, id, field, from, to, error}` for each rejection. Fixing B1 closes this.

**Export check:** the ledger has the rejected TRs' correction entries (via `_pendingCorrections` persistence — actually no, corrections are NOT persisted — they're module-scope. See A3). So even the export doesn't tell you what the LLM tried.

**Root gap:** B1 (per-rejection log) + A3 (persist `_pendingCorrections` OR at least log each on push).

### C2 — Archive injection stopped working after turn 40 (FAIL)

**What's visible:** nothing directly. `_archiveInjectedVersion` changes silently; `formatCollisionArchive` returns empty string if pool isn't thin, with no log.

**Export check:** export has `world.collision_archive` (visible) and all collisions with status (can compute pool size). Developer could run:

```javascript
const archive = data.transactions.reduce(/*replay*/).world.collision_archive.length;
const activeCount = Object.values(state.collisions).filter(c => c.status === 'ACTIVE').length;
```

to confirm pool is/isn't thin. But that's a lot of hand-replay, and tells them nothing about _why_ the injection dedup fired.

**Root gap:** B2 (archive inject decision log) closes it.

### C3 — Agenda never requested for TRACKED character (FAIL)

**What's visible:** nothing. F-D5 adds a correction if tier→TRACKED/PRINCIPAL fires without agenda. If the promotion TR was rejected (for whatever reason) the F-D5 audit never runs. If the nudge rotation was on a different slot and the character's rotation index hadn't come up, no nudge fires.

**Export check:** the export will show the character's current tier and whether `agenda` is set. Developer can see "char:x is TRACKED, no agenda" — but can't tell from the ledger alone when the promotion TR landed, which turns the nudge rotation hit, or whether F-D5's correction ever fired. The correction queue isn't persisted.

**Root gap:** B1 (per-rejection log — tells you if the TR landed or was rejected) + B6 (nudge rotation log — tells you which slot fired when) + persist correction queue (from A3) for post-hoc diagnosis.

### C4 — Rollback happened but runtime maps weren't cleared (FAIL)

**What's visible:** the ROLL transaction is in the ledger. No console log of rollback firing. No console log of listener firing. If the listener silently threw, there's a single `[Snapshot] rollback listener threw` warning — but if the listener ran fine and you suspect a map wasn't cleared, there's no positive evidence that clearing ran.

**Export check:** the ledger shows the ROLL tx. Nothing about runtime maps.

**Root gap:** B3 (rollback top-level log + per-listener log) closes it.

### C5 — Foreshadow at wrong distance category (FAIL)

**What's visible:** the injected prompt contains the level (APPROACHING/IMMINENT/CONVERGING) and ticks-remaining. If the user complains about the level, the injection content is the only evidence — but by then the `_foreshadowedCollisions` Map has already marked it fired, so inspecting post-hoc shows it as fired correctly from the engine's view.

**Export check:** export has all collisions with current `distance` and `distance_category`. Developer can compute expected pct and check boundary — but can't see what pct the engine actually computed at the moment of firing (because distances tick every advance turn).

**Root gap:** B7 (foreshadow fire log with pct) closes it. Would also benefit from persisting `_foreshadowedCollisions` (A3) so historical levels are visible across sessions.

### C6 — Extension silently not advancing timeskip (FAIL)

**What's visible:** the Advance button fires `injectPrompt('advance')` and inserts the chat marker. F-D2's `applyAdvanceTick` runs in `onMessageReceived` when `_lastCompletedMode === 'advance'`. Nothing logs any of this.

**Scenarios that silently fail:**

- `_lastCompletedMode` captured wrong mode (maybe user typed a normal message that pre-empted the advance)
- `_currentState.world.timeskip_scale` is null (HOURS default; looks like "only 1 tick" but no log confirms)
- No ACTIVE collisions to tick (nothing happens; no log)
- All collisions are IMMEDIATE (skipped per line 1871)

**Export check:** export has the scale value committed by the LLM. Developer can tell what the LLM declared. But can't tell which tick path fired.

**Root gap:** B9 (applyAdvanceTick summary log) closes it.

### C7 — LLM emitted DISSOLVED and something went wrong downstream (PARTIAL)

**What's visible:** the `S collision:X outcome_type value=DISSOLVED` lands in the ledger (export has it). The closure audit at index.js:1228 warns only if `outcome_type` is missing — DISSOLVED passes. Post-F-D15, the archive-presence check scans state for unarchived RESOLVED/CRASHED, catches missing archive, queues correction, auto-fallbacks after 3 attempts. The `[GravityLedger] ... errors queued for correction.` log fires — but doesn't name DISSOLVED specifically.

The `[SIMULTANEOUS ARRIVALS]` path: if two arrivals fire at once and the LLM picks DISSOLVED for both (instead of exactly one ON-SCREEN), nothing logs the constraint violation. The correction injection from the `_arrival` slot tells the LLM "only one gets ON-SCREEN" but there's no server-side audit that the instruction was followed.

**Export check:** export has all collisions. Developer can see `outcome_type=DISSOLVED` on two simultaneous arrivals and flag it manually.

**Root gap:** partial coverage exists (archive presence catches missing archives). What's missing: a log when multiple arrivals in one turn both get non-ON-SCREEN resolutions. Low priority; this is a spec-compliance violation the LLM can fix on the next correction round.

### C8 — `getStateMachineField` arg-count bug, pre-F-D6 (FAIL)

**What's visible:** before F-D6, calling `getStateMachineField(tx.e, field)` returned the machine field regardless of `field`. `rewriteDuplicateActiveChallengeCreate` at index.js:189–209 then routed every field through the `if (stateField)` branch → `op: 'TR'`. A developer inspecting the resulting ledger would see TR ops for `outcome`, `aftermath`, `primary_enemy` fields — technically invalid (TR should be state-machine transitions only) but state still ends up correct (because state-compute.js:322 TR handler just does `target[field] = to`).

**Post F-D6:** the bug no longer exists. But imagine an analogous bug surfaces later.

**What's missing generically:** no log in `rewriteDuplicateActiveChallengeCreate` saying "I rewrote N fields, M as TR, K as S." A single summary log at line 211 (just before returning) would surface this.

**Root gap:** no general logging around the challenge-CR rewrite path. Part of B11 (challenge subsystem silent).

---

## D. Prioritized 1-hour fix list

If you had one hour and wanted the maximum "when something goes wrong, we can tell what" gain, in order:

**Minute 0–10 — F-Log1: per-rejection log for validateTransitions (closes C1, C8 class, half of C7).**

In `consistency.js::validateTransitions`, after the `errors.push(...)` inside the invalid-transition branch (line 269–275), add:

```javascript
console.warn(`${LOG_PREFIX} TR rejected: ${tx.e}:${tx.id} ${tx.d?.f} ${tx.d?.from}→${tx.d?.to} — ${result.error}`);
```

The `LOG_PREFIX` import needs to be added at the top of consistency.js (today it has zero logs). Use `'[GravityLedger:Consistency]'` to match the snapshot-mgr pattern.

**Minute 10–20 — F-Log2: archive inject + rollback logs (closes C2, C4).**

index.js:1079–1084, log `includeArchive` decision with version and pool size. In `snapshot-mgr.js::rollback` (line 119), add a log line before `return snapshot.state`: `console.log('[GravityLedger:Snapshot] Rolled back to #' + targetSnapshotId + ' (' + _rollbackListeners.size + ' listeners fired)');`.

**Minute 20–35 — F-Log3: advance tick + nudge rotation summary (closes C3, C6).**

One log at end of `applyAdvanceTick` with `{scale, delta, tickedCount, pressureClearedCount, newArrivalsCount}`. One log inside `maybeComputeNudge` when a slot actually fires with `{counter, slot, slotName, rotIdx, fired: boolean}`.

**Minute 35–50 — F-Export1: envelope the export (closes A1, A2 partially).**

Rewrite `exportData()` in ledger-store.js:234 to return an envelope:

```javascript
function exportData() {
    const { chatMetadata } = SillyTavern.getContext();
    return {
        schema_version: 2,
        exported_at: new Date().toISOString(),
        gravity_ledger: chatMetadata[METADATA_KEY] || null,
        gravity_exemplars: chatMetadata['gravity_exemplars'] || null,
        gravity_challenge_runtime: chatMetadata['gravity_challenge_runtime'] || null,
        gravity_challenge_settings: chatMetadata['gravity_challenge_settings'] || null,
        gravity_nudge_counter: chatMetadata['gravity_nudge_counter'] ?? null,
        gravity_nudge_slot: chatMetadata['gravity_nudge_slot'] ?? null,
        gravity_nudge_rotation_index: chatMetadata['gravity_nudge_rotation_index'] ?? null,
        gravity_cold: chatMetadata['gravity_cold'] || null,
        gravity_cold_watermarks: chatMetadata['gravity_cold_watermarks'] || null,
    };
}
```

Corresponding `importData()` must detect the envelope: if `data.schema_version === 2`, restore each key; if `data.transactions` is top-level (v1 format), treat as legacy.

`handleImportData` in index.js:2174 then only deletes keys that aren't being restored (today it deletes all of them before importing).

**Minute 50–60 — F-Log4: replace empty catches with logged catches (closes B5, feeds C6 and C7).**

Three sites in index.js (lines 1631, 1652, 1726) — replace each `catch (_) { /* non-critical */ }` with:

```javascript
} catch (err) {
    console.warn(`${LOG_PREFIX} <operation> failed (non-critical):`, err);
}
```

where `<operation>` is specific: "archive auto-fallback append", "saveChatDebounced", "pressure FIFO drop".

**At minute 60:** stop. The remaining gaps (B4 correction-queue detail, B7 foreshadow, B8 arrival source, B11 challenge logs, B13 log-level fixes, A3 runtime map persistence, A4 schema version warnings) are worth doing but not in the first hour.

### What you get after the 1-hour fix pass

Of the 8 scenarios:

- **C1, C2, C3, C4, C6 — diagnosable from logs alone.**
- **C7 — still partial (needs the multi-arrival audit log, ~30 min more).**
- **C5 — still source-level (needs B7, ~15 min more).**
- **C8 — no longer exists (F-D6 fixed it).**

Export-side: A1 + A2 fixed (envelope + nudge counter preserved). A3 (runtime map persistence) still pending — but is secondary once the logs tell the story in real-time.

---

## Residual judgment points (not fixes — questions to decide)

- **Schema version strategy:** once you introduce `schema_version: 2`, do you commit to forward compatibility? Implies an import-time migrator. If the user's workflow is "export at milestones, re-import rarely," a simpler "warn on version mismatch, refuse to import if major-version differs" policy is fine.
- **Runtime map persistence (A3):** the spec explicitly calls out `_archiveInjectedVersion` as in-memory only (§2.2.1). Persisting it would require a spec addendum. `_firedCollisionArrivals` and `_foreshadowedCollisions` are documented as reset on rollback (§8 step 8b) but not on import — so persisting them across import is legitimate but not spec-mandated. `_archiveCorrectionAttempts` has the strongest argument for persistence (the F-D15 auto-fallback mechanism depends on attempt counting across turns; export/import shouldn't reset that counter).
- **Challenge subsystem logging (B11):** the subsystem was designed to be "thin" in the ledger per spec §7.2. The silence at runtime mirrors that design intent. If you add logs, they should be debug-gated so they don't flood the console in combat-heavy sessions.
- **Debug flag (B12):** most extensions don't have one. Adding it is standard-practice but also adds a documentation burden. Worth doing once you have enough verbose logs to warrant gating.
