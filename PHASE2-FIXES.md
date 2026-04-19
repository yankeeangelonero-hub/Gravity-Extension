# Phase 2 Compliance — Remediation Fixes

**Source audit:** `PHASE2-COMPLIANCE-AUDIT.md` (2026-04-19)
**Spec:** `PHASE2-SPEC.md`
**Target:** Every P0/P1/P2 finding from the audit. P3 items included as notes at the end.

> This file overwrites an earlier `PHASE2-FIXES.md` that was authored against a different worktree. Treat this as the authoritative remediation plan for the root-level codebase at `G:\My Drive\AI RPG\Gravity 2\`.

This document is self-contained. A coding agent (or developer) should be able to open it, apply the diffs in order, and ship. Old code blocks include surrounding context so find-and-replace is unambiguous on first match. Each fix is tagged with spec section + verification steps.

**Apply order (respect this):**

1. **F1** (P0 drawDivination) — restores parse; everything else depends on it.
2. **F5** (P1 snapshot-rollback callback registration) — introduces a registration primitive used later.
3. **F6** (P2 move validateTransition) — shape-compatible with F7 and related paths.
4. **F7** (P2 move archive presence check) — builds on F6's new `consistency.js` imports.
5. All remaining fixes are independent and may be applied in any order.

Run `node -c <file>` after every edit to catch typos. `node -c index.js` is the single most important check. **F1 was verified locally: the stray `}` at line 529 of `index.js` does in fact break the parse, and reinserting `if (system === 'classic') {` at line 518 restores it.**

---

## F1 — Restore `drawDivination()` structure (P0, CRITICAL)

**Finding ID:** AUDIT §5.1 — `drawDivination()` has a parse-breaking stray `}` left by an incomplete Phase 1 Yi Jing strip.

**Confirmed real:** Yes. Isolated the function with stubs in a temp file and ran `node -c`; result was `SyntaxError: Unexpected token '}'` at what corresponds to line 543 of `index.js`. Adding `if (system === 'classic') {` on line 518 makes the file parse clean (`exit=0`).

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 508–543

**Old code (exact):**

```javascript
function drawDivination() {
    const manual = consumeManualDivinationOverride();
    if (manual?.system === 'classic') {
        return buildClassicDraw(manual.num, 'manual', manual.sourceText);
    }
    if (manual?.system === 'arcana') {
        return buildArcanaDraw(manual.num, 'manual', manual.sourceText);
    }

    const system = getActiveDivinationSystem();

        const d1 = Math.floor(Math.random() * 10) + 1;
        const d2 = Math.floor(Math.random() * 10) + 1;
        const total = d1 + d2;
        return {
            system: 'classic',
            label: 'THE DICE ROLLED',
            num: total,
            reading: `${d1} + ${d2} = ${total}\n${CLASSIC_TABLE}\n${NARRATIVE_FORCING}`,
            html: '',
        };
    }

    // Default: arcana (d22, 0-indexed)
    const num = Math.floor(Math.random() * 22);
    const cardName = ARCANA_TABLE[num].split(' — ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' — ')[1] || '';
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
        reading: `#${num} — ${ARCANA_TABLE[num]}\nUSE THIS EXACT CARD. Do not override or pick a different one.\n${NARRATIVE_FORCING}`,
        html: `<div style="background:linear-gradient(180deg,#0a0a1a 0%,#1a0a2e 100%);border:1px solid #d4af37;border-radius:8px;padding:20px;margin:16px auto;max-width:280px;text-align:center;box-shadow:0 0 15px rgba(212,175,55,0.2);"><div style="color:#d4af37;font-size:0.75em;letter-spacing:3px;text-transform:uppercase;">The Arcana</div><div style="color:#f0e6d3;font-size:1.8em;margin:12px 0 4px 0;font-weight:bold;">${cardName}</div><div style="color:#d4af37;font-size:0.9em;font-style:italic;">${ARCANA_ROMAN[num]}</div><div style="width:40px;height:1px;background:#d4af37;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.4;">${cardMeaning}</div></div>`,
    };
}
```

**New code:**

```javascript
function drawDivination() {
    const manual = consumeManualDivinationOverride();
    if (manual?.system === 'classic') {
        return buildClassicDraw(manual.num, 'manual', manual.sourceText);
    }
    if (manual?.system === 'arcana') {
        return buildArcanaDraw(manual.num, 'manual', manual.sourceText);
    }

    const system = getActiveDivinationSystem();

    if (system === 'classic') {
        const d1 = Math.floor(Math.random() * 10) + 1;
        const d2 = Math.floor(Math.random() * 10) + 1;
        const total = d1 + d2;
        return {
            system: 'classic',
            label: 'THE DICE ROLLED',
            num: total,
            reading: `${d1} + ${d2} = ${total}\n${CLASSIC_TABLE}\n${NARRATIVE_FORCING}`,
            html: '',
        };
    }

    // Default: arcana (d22, 0-indexed)
    const num = Math.floor(Math.random() * 22);
    const cardName = ARCANA_TABLE[num].split(' — ')[0];
    const cardMeaning = ARCANA_TABLE[num].split(' — ')[1] || '';
    return {
        system: 'arcana',
        label: 'THE ARCANA DREW',
        num,
        index: num,
        reading: `#${num} — ${ARCANA_TABLE[num]}\nUSE THIS EXACT CARD. Do not override or pick a different one.\n${NARRATIVE_FORCING}`,
        html: `<div style="background:linear-gradient(180deg,#0a0a1a 0%,#1a0a2e 100%);border:1px solid #d4af37;border-radius:8px;padding:20px;margin:16px auto;max-width:280px;text-align:center;box-shadow:0 0 15px rgba(212,175,55,0.2);"><div style="color:#d4af37;font-size:0.75em;letter-spacing:3px;text-transform:uppercase;">The Arcana</div><div style="color:#f0e6d3;font-size:1.8em;margin:12px 0 4px 0;font-weight:bold;">${cardName}</div><div style="color:#d4af37;font-size:0.9em;font-style:italic;">${ARCANA_ROMAN[num]}</div><div style="width:40px;height:1px;background:#d4af37;margin:12px auto;"></div><div style="color:#a89070;font-size:0.85em;line-height:1.4;">${cardMeaning}</div></div>`,
    };
}
```

**Diff summary:** reflow the classic branch inside an `if (system === 'classic') {` opener on line 518, and drop the stray closing `}` that was left orphaned after the Phase 1 Yi Jing strip. The 8-space-indented classic body collapses back to 8 spaces because it is now inside the restored `if` block.

**Rationale:** Spec §5.1 retains both Arcana (1d22) and Classic (2d10). The Phase 1 strip removed the `if (system === 'iching') { ... } / if (system === 'classic') { ... }` scaffolding imperfectly, leaving an unbalanced brace that kills the module at parse time.

**Ordering:** Apply first. Nothing else matters if the module doesn't load.

**Verification:**
- `node -c index.js` → exit code 0.
- `grep -rn "iching\|yi.*jing\|hexagram\|1d64" *.js` → zero matches.
- Load extension in SillyTavern; trigger a collision arrival; confirm the arrival block renders a tarot card.

---

## F2 — Timeskip scale consumption ordering (P1)

**Finding ID:** AUDIT §3.2 / §3.7 drift — `handleAdvanceButton` ticks before the LLM emits `S world timeskip_scale`, so the tick always lags by one turn.

**File(s):** `G:\My Drive\AI RPG\Gravity 2\index.js`
**Line range:** 1835–1943 (tick block inside `handleAdvanceButton`) and 1672–1722 (post-commit block inside `onMessageReceived`)

**Current flow (undesired):**

```
User clicks Advance
  ↓
handleAdvanceButton()  ← ticks using PREVIOUS turn's timeskip_scale (or HOURS if null)
  ↓ inserts "*pc continues.*" into chat
LLM generates advance response (may include `S world timeskip_scale DAYS`)
  ↓
onMessageReceived() commits TXs, fires IMMEDIATE arrivals, pressure FIFO, etc.
```

**Desired flow (spec §3.7):**

```
User clicks Advance
  ↓
handleAdvanceButton()  ← ONLY locks, runs preconditions, inserts the chat marker
  ↓
LLM generates advance response with `S world timeskip_scale DAYS`
  ↓
onMessageReceived()  ← commits TXs, THEN ticks using the freshly committed scale
```

**Fix:** Split the handler. `handleAdvanceButton` keeps lock, preconditions, PC safety warn, and marker insert. The tick, pressure clear, timeskip reset, arrival detection, and `collision_health` nudge move into a new `applyAdvanceTick()` helper called from `onMessageReceived` when `_lastCompletedMode === 'advance'`.

### F2.A — Trim `handleAdvanceButton`

**Old code (exact — `index.js:1835–1943`):**

```javascript
async function handleAdvanceButton() {
    if (_advanceLocked) return;
    _advanceLocked = true;

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

    try {
    _pendingDeductionType = 'advance';

    // ── Advance preconditions (§3.2) ──────────────────────────────────────────
    if (_currentState) {
        // Hard block: any ACTIVE collision at distance 0 must be resolved first
        const unresolved = Object.values(_currentState.collisions || {}).find(col =>
            (col.status || '').toUpperCase() === 'ACTIVE' &&
            parseFloat(col.distance) <= 0
        );
        if (unresolved) {
            toastr.error(`Unresolved arrival: "${unresolved.name || unresolved.id}" has arrived (distance 0). Resolve it before advancing.`);
            if (reenableAdvBtn) eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
            if (advBtn) { advBtn.disabled = false; }
            _advanceLocked = false;
            return;
        }

        // Advisory: PC in active combat
        const pcInCombat = Object.values(_currentState.combats || {}).some(c => (c.status || '').toUpperCase() === 'ACTIVE');
        if (pcInCombat) {
            toastr.warning('PC is not in a safe position to timeskip. Consider resolving the current situation before advancing.');
        }
    }

    // ── Engine-side distance compression (timeskip-scale-aware, §3.2) ────────
    if (_currentState) {
        const scale = (_currentState.world?.timeskip_scale || 'HOURS').toString().toUpperCase();
        const tickDelta = TICK[scale] ?? 1;

        const tickTxns = [];
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const dist = parseFloat(col.distance);
            const status = (col.status || '').trim().toUpperCase();
            if (status !== 'ACTIVE') continue;
            if (col.distance_category === 'IMMEDIATE') continue;
            if (isNaN(dist) || dist <= 0) continue;
            const newDist = Math.max(0, dist - tickDelta);
            if (newDist !== dist) {
                tickTxns.push({ op: 'S', e: 'collision', id, d: { f: 'distance', v: newDist }, r: 'system:advance:tick' });
            }
        }

        // WEEKS / MONTHS clears pressure points — stale small tensions lapse
        if (scale === 'WEEKS' || scale === 'MONTHS') {
            for (const id of Object.keys(_currentState.pressures || {})) {
                tickTxns.push({ op: 'D', e: 'pressure', id, r: `system:advance:${scale.toLowerCase()}-clear-pressure` });
            }
        }

        if (tickTxns.length > 0) {
            await append(tickTxns);
            _currentState = computeCurrentState();
        }

        // Reset timeskip_scale after consuming
        if (_currentState.world?.timeskip_scale) {
            await append([{ op: 'S', e: 'world', id: '_', d: { f: 'timeskip_scale', v: null }, r: 'system:advance:reset-timeskip' }]);
            _currentState = computeCurrentState();
        }

        updatePanel(_currentState, _turnCounter);
    }

    // ── Arrival detection: fire sanity-check gate for newly arrived collisions ──
    const newArrivalIds = [];
    if (_currentState) {
        for (const [id, col] of Object.entries(_currentState.collisions || {})) {
            const status = (col.status || '').toUpperCase();
            const dist = parseFloat(col.distance);
            if (status === 'ACTIVE' && !isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
                newArrivalIds.push(id);
            }
        }
    }
    if (newArrivalIds.length > 0) {
        buildAndInjectArrivals(newArrivalIds, _currentState);
    }
    // ── Advance collision_health check (§4.4) — fires regardless of nudge counter ──
    const healthNudge = buildNudge_collisionHealth(_currentState);
    if (healthNudge) _pendingNudgeText = healthNudge;

    injectPrompt('advance');
    const pcName = _currentState?.pc?.name || '{{user}}';
    insertChatMessage(`*${pcName} continues.*`);

    } catch (err) {
        console.error(`${LOG_PREFIX} handleAdvanceButton error:`, err);
        if (advBtn) { advBtn.disabled = false; }
        _advanceLocked = false;
    }
}
```

**New code:**

```javascript
async function handleAdvanceButton() {
    if (_advanceLocked) return;
    _advanceLocked = true;

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

    try {
    _pendingDeductionType = 'advance';

    // ── Advance preconditions (§3.2) ──────────────────────────────────────────
    if (_currentState) {
        // Hard block: any ACTIVE collision at distance 0 must be resolved first
        const unresolved = Object.values(_currentState.collisions || {}).find(col =>
            (col.status || '').toUpperCase() === 'ACTIVE' &&
            parseFloat(col.distance) <= 0
        );
        if (unresolved) {
            toastr.error(`Unresolved arrival: "${unresolved.name || unresolved.id}" has arrived (distance 0). Resolve it before advancing.`);
            if (reenableAdvBtn) eventSource.off(event_types.MESSAGE_RECEIVED, reenableAdvBtn);
            if (advBtn) { advBtn.disabled = false; }
            _advanceLocked = false;
            return;
        }

        // Advisory: PC in active combat
        const pcInCombat = Object.values(_currentState.combats || {}).some(c => (c.status || '').toUpperCase() === 'ACTIVE');
        if (pcInCombat) {
            toastr.warning('PC is not in a safe position to timeskip. Consider resolving the current situation before advancing.');
        }
    }

    // Tick consumption + arrival detection + collision_health nudge now run in
    // onMessageReceived() after the LLM commits its `S world timeskip_scale` TX.
    // This matches PHASE2-SPEC §3.7 steps 2→6 — commit first, then tick.

    injectPrompt('advance');
    const pcName = _currentState?.pc?.name || '{{user}}';
    insertChatMessage(`*${pcName} continues.*`);

    } catch (err) {
        console.error(`${LOG_PREFIX} handleAdvanceButton error:`, err);
        if (advBtn) { advBtn.disabled = false; }
        _advanceLocked = false;
    }
}
```

### F2.B — Introduce `applyAdvanceTick()` helper

Insert this helper **immediately above** the `async function handleAdvanceButton()` line (i.e. just before the newly trimmed version above, so put the helper at the old line 1834 position):

```javascript
// ─── Advance Tick Pipeline (§3.7 steps 5–10) ──────────────────────────────────
// Runs from onMessageReceived AFTER the LLM's advance-turn transactions have
// committed. Reads the just-committed world.timeskip_scale, ticks collisions,
// clears pressure on WEEKS/MONTHS, detects new arrivals, fires collision_health.
async function applyAdvanceTick() {
    if (!_currentState) return;

    const scale = (_currentState.world?.timeskip_scale || 'HOURS').toString().toUpperCase();
    const tickDelta = TICK[scale] ?? 1;

    const tickTxns = [];
    for (const [id, col] of Object.entries(_currentState.collisions || {})) {
        const dist = parseFloat(col.distance);
        const status = (col.status || '').trim().toUpperCase();
        if (status !== 'ACTIVE') continue;
        if (col.distance_category === 'IMMEDIATE') continue;
        if (isNaN(dist) || dist <= 0) continue;
        const newDist = Math.max(0, dist - tickDelta);
        if (newDist !== dist) {
            tickTxns.push({ op: 'S', e: 'collision', id, d: { f: 'distance', v: newDist }, r: 'system:advance:tick' });
        }
    }

    // WEEKS / MONTHS clears pressure points — stale small tensions lapse
    if (scale === 'WEEKS' || scale === 'MONTHS') {
        for (const id of Object.keys(_currentState.pressures || {})) {
            tickTxns.push({ op: 'D', e: 'pressure', id, r: `system:advance:${scale.toLowerCase()}-clear-pressure` });
        }
    }

    if (tickTxns.length > 0) {
        await append(tickTxns);
        _currentState = computeCurrentState();
    }

    // Reset timeskip_scale after consuming
    if (_currentState.world?.timeskip_scale) {
        await append([{ op: 'S', e: 'world', id: '_', d: { f: 'timeskip_scale', v: null }, r: 'system:advance:reset-timeskip' }]);
        _currentState = computeCurrentState();
    }

    // Arrival detection — fire sanity-check for distances that hit 0 after tick
    const newArrivalIds = [];
    for (const [id, col] of Object.entries(_currentState.collisions || {})) {
        const status = (col.status || '').toUpperCase();
        const dist = parseFloat(col.distance);
        if (status === 'ACTIVE' && !isNaN(dist) && dist <= 0 && !_firedCollisionArrivals.has(id)) {
            newArrivalIds.push(id);
        }
    }
    if (newArrivalIds.length > 0) {
        buildAndInjectArrivals(newArrivalIds, _currentState);
    }

    // collision_health fires on every advance turn regardless of nudge counter (§4.4)
    const healthNudge = buildNudge_collisionHealth(_currentState);
    if (healthNudge) _pendingNudgeText = healthNudge;

    updatePanel(_currentState, _turnCounter);
}
```

### F2.C — Call `applyAdvanceTick()` from `onMessageReceived`

**Old code (exact — `index.js:1672–1682`, inside `onMessageReceived`):**

```javascript
    // ── IMMEDIATE collision firing (§3.3) — fire on the turn they are created ──
    if (_currentState) {
        const immediateArrivals = Object.entries(_currentState.collisions || {})
            .filter(([id, col]) => col.distance_category === 'IMMEDIATE'
                && col.status === 'ACTIVE'
                && !_firedCollisionArrivals.has(id))
            .map(([id]) => id);
        if (immediateArrivals.length > 0) {
            buildAndInjectArrivals(immediateArrivals, _currentState);
        }
    }
```

**New code:**

```javascript
    // ── IMMEDIATE collision firing (§3.3) — fire on the turn they are created ──
    if (_currentState) {
        const immediateArrivals = Object.entries(_currentState.collisions || {})
            .filter(([id, col]) => col.distance_category === 'IMMEDIATE'
                && col.status === 'ACTIVE'
                && !_firedCollisionArrivals.has(id))
            .map(([id]) => id);
        if (immediateArrivals.length > 0) {
            buildAndInjectArrivals(immediateArrivals, _currentState);
        }
    }

    // ── Advance tick pipeline (§3.7 steps 5–10) ────────────────────────────────
    // Runs AFTER LLM transactions have committed so world.timeskip_scale reflects
    // the current turn's declaration, not the previous one.
    if (_lastCompletedMode === 'advance') {
        await applyAdvanceTick();
    }
```

**Rationale:** Spec §3.7 operation order explicitly puts "commit LLM transactions" (step 2) before "tick clocks" (step 6). The helper collapses steps 5→10 into a single call that runs post-commit.

**Ordering:** Apply after F1. F2.B's helper references `TICK`, `append`, `computeCurrentState`, `buildAndInjectArrivals`, `buildNudge_collisionHealth`, `_currentState`, `_firedCollisionArrivals`, `_pendingNudgeText`, `_turnCounter`, `updatePanel` — all already module-scoped.

**Verification:**
- `node -c index.js` passes.
- Scenario: start a chat, click Advance, confirm the LLM-committed `timeskip_scale = DAYS` causes a 3-tick decrement on the same turn (not the next).
- `grep -n "world\.timeskip_scale" index.js` → reads only inside `applyAdvanceTick` or the preconditions block of `handleAdvanceButton` (the precondition block does not read `timeskip_scale`, so ideally only the helper). No call to `append(…system:advance:tick…)` outside `applyAdvanceTick`.

---

## F3 — Key moments restricted to PRINCIPAL + last-10 cap (P1)

**Finding ID:** AUDIT §2.1 — `key_moments` renders for TRACKED/KNOWN chars; mode-aware caps are 3/5/∞ instead of the spec's "last 10 per PRINCIPAL".

**File:** `G:\My Drive\AI RPG\Gravity 2\state-view.js`
**Line range:** 180–191

**Old code (exact):**

```javascript
        // Key moments — tier-aware capping
        const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
        let momentCap;
        if (isFull) momentCap = Infinity;
        else if (isCombat || isIntimacy) momentCap = isPrincipal ? 5 : 3;
        else momentCap = isPrincipal ? 3 : 1; // lite
        const displayMoments = momentCap === Infinity ? moments : moments.slice(-momentCap);
        if (displayMoments.length) {
            const capNote = moments.length > displayMoments.length ? `, showing last ${displayMoments.length}` : '';
            lines.push(`    Key moments (${moments.length}${capNote}):`);
            for (const m of displayMoments) lines.push(`      - ${m}`);
        }
```

**New code:**

```javascript
        // Key moments — PRINCIPAL only, last 10 per turn (§2.1).
        // TRACKED/KNOWN/UNKNOWN chars omit this section per spec.
        if (isPrincipal) {
            const moments = Array.isArray(char.key_moments) ? char.key_moments : [];
            const displayMoments = moments.slice(-10);
            if (displayMoments.length) {
                const capNote = moments.length > displayMoments.length ? `, showing last ${displayMoments.length}` : '';
                lines.push(`    Key moments (${moments.length}${capNote}):`);
                for (const m of displayMoments) lines.push(`      - ${m}`);
            }
        }
```

**Rationale:** Spec §2.1 — "state-view.js injects the last 10 `key_moments` entries per PRINCIPAL character into the state view each turn. TRACKED/KNOWN/UNKNOWN chars omit this section."

**Ordering:** Independent.

**Verification:**
- `node -c state-view.js` passes.
- Create a TRACKED character with a `key_moments` entry; render state view; confirm no `Key moments:` line appears.
- Create a PRINCIPAL with 12 `key_moments` entries; confirm exactly 10 render.

---

## F4 — Character `knowledge_asymmetry` 20-entry cap (P1)

**Finding ID:** AUDIT §2.1 — 20-entry KA cap enforced for factions, not characters.

**File:** `G:\My Drive\AI RPG\Gravity 2\state-compute.js`
**Line range:** 80–99 (`normalizeCharacterKnowledgeAsymmetry`)

**Old code (exact):**

```javascript
function normalizeCharacterKnowledgeAsymmetry(state) {
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;
        const ka = char.knowledge_asymmetry;
        if (ka === undefined || ka === null || ka === '') {
            char.knowledge_asymmetry = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
        } else if (typeof ka === 'string') {
            char.knowledge_asymmetry = { knows: {}, unknown: {}, hiding: {}, misreading: {}, legacy: ka };
        } else if (typeof ka === 'object' && !Array.isArray(ka)) {
            if (!ka.knows || typeof ka.knows !== 'object') ka.knows = {};
            if (!ka.unknown || typeof ka.unknown !== 'object') ka.unknown = {};
            if (!ka.hiding || typeof ka.hiding !== 'object') ka.hiding = {};
            if (!ka.misreading || typeof ka.misreading !== 'object') ka.misreading = {};
        }
        if (char.last_seen_at === undefined || char.last_seen_at === null) {
            char.last_seen_at = '';
        }
    }
}
```

**New code:**

```javascript
function normalizeCharacterKnowledgeAsymmetry(state) {
    // Nested containers exist for back-compat with legacy writes; they do not
    // count toward the §2.1 "20 entries across all four categories combined" cap.
    const STRUCTURAL_KEYS = new Set(['knows', 'unknown', 'hiding', 'misreading']);
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;
        const ka = char.knowledge_asymmetry;
        if (ka === undefined || ka === null || ka === '') {
            char.knowledge_asymmetry = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
        } else if (typeof ka === 'string') {
            char.knowledge_asymmetry = { knows: {}, unknown: {}, hiding: {}, misreading: {}, legacy: ka };
        } else if (typeof ka === 'object' && !Array.isArray(ka)) {
            if (!ka.knows || typeof ka.knows !== 'object') ka.knows = {};
            if (!ka.unknown || typeof ka.unknown !== 'object') ka.unknown = {};
            if (!ka.hiding || typeof ka.hiding !== 'object') ka.hiding = {};
            if (!ka.misreading || typeof ka.misreading !== 'object') ka.misreading = {};
        }
        if (char.last_seen_at === undefined || char.last_seen_at === null) {
            char.last_seen_at = '';
        }

        // Cap flat KA at 20 entries across all four categories combined (§2.1).
        // Structural containers (knows/unknown/hiding/misreading) and `legacy`
        // do not count. Oldest keys win insertion order; drop excess from the tail.
        const kaObj = char.knowledge_asymmetry;
        if (kaObj && typeof kaObj === 'object' && !Array.isArray(kaObj)) {
            const flatKeys = Object.keys(kaObj).filter(k => k !== 'legacy' && !STRUCTURAL_KEYS.has(k));
            if (flatKeys.length > 20) {
                for (const k of flatKeys.slice(20)) delete kaObj[k];
            }
        }
    }
}
```

**Rationale:** Spec §2.1 — "Cap: 20 entries across all four categories combined. Engine auto-trims by insertion order when exceeded." Mirrors the faction-side logic in `migrateFactionToPhase2` (`state-compute.js:170–174`) but filters the structural containers that exist only for shape compatibility.

**Ordering:** Independent.

**Verification:**
- `node -c state-compute.js` passes.
- Write 25 `MS char:x field=knowledge_asymmetry key=knows_<n> value="..."` transactions; confirm only 20 survive after `computeState` runs.
- Verify the structural containers (`knows`, `unknown`, `hiding`, `misreading`) and `legacy` key remain untouched.

---

## F5 — Snapshot rollback clears runtime state (P1)

**Finding ID:** AUDIT §8 step 8b — `_firedCollisionArrivals` / `_foreshadowedCollisions` / `_archiveInjectedVersion` only reset on the OOC-text rollback path, not on any programmatic `rollback()`.

**Approach:** Add a lightweight "rollback listener" registration to `snapshot-mgr.js`. `index.js` registers its cleanup function at init. Any caller that invokes `rollback()` now fans out through the listeners.

### F5.A — Add listener registry to `snapshot-mgr.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\snapshot-mgr.js`

**Old code (exact — lines 17–28):**

```javascript
let _snapshotCounter = 0;

/**
 * Initialize snapshot manager.
 */
function init() {
    const snapshots = getSnapshots();
    _snapshotCounter = snapshots.length > 0
        ? Math.max(...snapshots.map(s => s.id || 0)) + 1
        : 0;
}
```

**New code:**

```javascript
let _snapshotCounter = 0;
const _rollbackListeners = new Set();

/**
 * Initialize snapshot manager.
 */
function init() {
    const snapshots = getSnapshots();
    _snapshotCounter = snapshots.length > 0
        ? Math.max(...snapshots.map(s => s.id || 0)) + 1
        : 0;
}

/**
 * Register a callback to fire whenever rollback() runs. Use this to clear any
 * in-memory runtime state that references pre-rollback collision/archive data.
 * Matches PHASE2-SPEC §8 step 8b.
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
function onRollback(fn) {
    if (typeof fn !== 'function') return () => {};
    _rollbackListeners.add(fn);
    return () => _rollbackListeners.delete(fn);
}
```

**Old code (exact — `rollback` function at lines 84–101):**

```javascript
/**
 * Rollback to a specific snapshot.
 * @param {number} targetSnapshotId
 * @returns {Promise<Object>} The restored state
 */
async function rollback(targetSnapshotId) {
    const snapshot = getSnapshot(targetSnapshotId);
    if (!snapshot) throw new Error(`Snapshot ${targetSnapshotId} not found`);

    await append([{
        op: 'ROLL',
        e: 'system',
        id: `rollback-to-${targetSnapshotId}`,
        d: { target_snapshot_id: targetSnapshotId },
        r: `Rolled back to snapshot ${targetSnapshotId}: ${snapshot.label}`,
    }]);

    return snapshot.state;
}
```

**New code:**

```javascript
/**
 * Rollback to a specific snapshot.
 * @param {number} targetSnapshotId
 * @returns {Promise<Object>} The restored state
 */
async function rollback(targetSnapshotId) {
    const snapshot = getSnapshot(targetSnapshotId);
    if (!snapshot) throw new Error(`Snapshot ${targetSnapshotId} not found`);

    await append([{
        op: 'ROLL',
        e: 'system',
        id: `rollback-to-${targetSnapshotId}`,
        d: { target_snapshot_id: targetSnapshotId },
        r: `Rolled back to snapshot ${targetSnapshotId}: ${snapshot.label}`,
    }]);

    // Fire runtime-state listeners (PHASE2-SPEC §8 step 8b)
    for (const fn of _rollbackListeners) {
        try { fn(targetSnapshotId, snapshot); } catch (err) {
            console.warn('[GravityLedger:Snapshot] rollback listener threw:', err);
        }
    }

    return snapshot.state;
}
```

**Old code (exact — exports at lines 151–158):**

```javascript
export {
    init as initSnapshots,
    createSnapshot,
    listSnapshots,
    getSnapshot,
    rollback,
    computeCurrentState,
};
```

**New code:**

```javascript
export {
    init as initSnapshots,
    createSnapshot,
    listSnapshots,
    getSnapshot,
    rollback,
    computeCurrentState,
    onRollback,
};
```

### F5.B — Register cleanup listener from `index.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`

**Update the snapshot-mgr import (line 11):**

**Old:**
```javascript
import { initSnapshots, computeCurrentState, createSnapshot } from './snapshot-mgr.js';
```

**New:**
```javascript
import { initSnapshots, computeCurrentState, createSnapshot, onRollback } from './snapshot-mgr.js';
```

**Register the listener inside the `init` IIFE.** Find the IIFE at `index.js:2165`; locate `createPanel();` (around line 2169) and insert the listener registration immediately after it:

**Old code (exact — around lines 2165–2170):**

```javascript
(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    createPanel();
    setCallbacks({
```

**New code:**

```javascript
(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    createPanel();

    // Clear arrival / foreshadow / archive runtime state on every rollback path
    // (OOC text, future programmatic calls, snapshot UI). PHASE2-SPEC §8 step 8b.
    onRollback(() => {
        _firedCollisionArrivals = new Set();
        _foreshadowedCollisions = new Map();
        _arrivalLastFiredTurn = -1;
        _archiveCorrectionAttempts = new Map();
        _archiveInjectedVersion = null;
    });

    setCallbacks({
```

### F5.C — Simplify the OOC-rollback branch (redundancy cleanup)

F5.B's listener now fires on every rollback regardless of path, so the inline reset in `onUserMessage` is redundant. Leaving it as belt-and-suspenders is harmless; removing it is cleaner.

**Old code (exact — `onUserMessage` around `index.js:1787–1803`):**

```javascript
    const result = await processOOC(message.mes);
    if (result.handled && result.injection) {
        _uncappedTurn = /ooc:\s*(eval|cleanup)\b/i.test(message.mes);
        _pendingReinforcement = result.injection;
        _currentState = computeCurrentState();
        // Rollback resets arrival/foreshadow/archive runtime state — rolled-back collisions
        // may re-arrive, and the archive may be shorter post-rollback so we must re-inject.
        if (/ooc:\s*rollback\b/i.test(message.mes)) {
            _firedCollisionArrivals = new Set();
            _foreshadowedCollisions = new Map();
            _arrivalLastFiredTurn = -1;
            _archiveCorrectionAttempts = new Map();
            _archiveInjectedVersion = null;
        }
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
    }
```

**New code:**

```javascript
    const result = await processOOC(message.mes);
    if (result.handled && result.injection) {
        _uncappedTurn = /ooc:\s*(eval|cleanup)\b/i.test(message.mes);
        _pendingReinforcement = result.injection;
        _currentState = computeCurrentState();
        // Rollback runtime-state cleanup is handled by the onRollback listener
        // registered at module init (PHASE2-SPEC §8 step 8b).
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
    }
```

**Rationale:** Spec §8 step 8b — rollback cleanup belongs in `snapshot-mgr.js`. A listener registry satisfies the spec without importing module-private state into `snapshot-mgr.js`.

**Ordering:** F5.A → F5.B → F5.C. Apply F5 before F6 (F6 edits the `consistency.js` import block which is near the snapshot-mgr import block).

**Verification:**
- `node -c snapshot-mgr.js` and `node -c index.js` pass.
- Grep `grep -n "_firedCollisionArrivals = new Set()" index.js` — matches should be: the initial declaration, the listener in F5.B, and the other reset sites (`initialize`, `handleNewLedger`, `handleImportData`). The `onUserMessage` reset should be gone (if F5.C applied).
- Manual test: take a snapshot, fire an IMMEDIATE collision arrival, `OOC: rollback N`, confirm the same collision can re-fire on the next matching turn.

---

## F6 — Move `validateTransition()` call into `consistency.js` (P2)

**Finding ID:** AUDIT §6.1 — spec §9 key-file table puts TR validation in `consistency.js`; wiring is in `index.js:1513`.

### F6.A — Add `validateTransitions` helper to `consistency.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\consistency.js`

**Old code (exact — lines 1–16):**

```javascript
/**
 * consistency.js — Format and structure validation only.
 *
 * The extension validates that ledger transactions are well-formed:
 * correct JSON structure, valid operation codes, required fields present,
 * valid entity type codes, proper data shapes.
 *
 * Gameplay rules (PRINCIPAL count, constraint limits, collision forces,
 * state machine transitions) are NOT enforced here. Those are the LLM's
 * responsibility, audited during OOC: eval.
 */

// ─── Valid Values ──────────────────────────────────────────────────────────────

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'world', 'pc', 'divination'];
```

**New code:**

```javascript
/**
 * consistency.js — Format and structure validation + state-machine transition guard.
 *
 * The extension validates that ledger transactions are well-formed:
 * correct JSON structure, valid operation codes, required fields present,
 * valid entity type codes, proper data shapes.
 *
 * Phase 2 also wires state-machine transition enforcement here (§6.1): every
 * `TR` operation is checked against `state-machine.js::validateTransition()`
 * at commit time, and invalid transitions are rejected while the rest of the
 * batch still commits.
 *
 * Gameplay rules beyond state-machine transitions (PRINCIPAL count, constraint
 * limits, collision forces) remain the LLM's responsibility, audited during
 * OOC: eval.
 */

import { validateTransition } from './state-machine.js';

// ─── Valid Values ──────────────────────────────────────────────────────────────

const VALID_OPS = ['CR', 'TR', 'S', 'A', 'R', 'MS', 'MR', 'D', 'SNAP', 'ROLL', 'AMEND'];
const VALID_ENTITIES = ['char', 'constraint', 'collision', 'combat', 'faction', 'place', 'pressure', 'world', 'pc', 'divination'];
```

**Old code (exact — `formatErrors` through end of file, lines 184–211):**

```javascript
/**
 * Format validation errors into an injection message for the LLM.
 * @param {FormatViolation[]} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (errors.length === 0) return '';

    const lines = [`[LEDGER: FORMAT ERROR — ${errors.length} issue(s):`];
    for (const err of errors.slice(0, 5)) { // Cap at 5 to avoid flooding
        lines.push(`  ${err.message}. Fix: ${err.fix}`);
    }
    if (errors.length > 5) {
        lines.push(`  ...and ${errors.length - 5} more.`);
    }
    lines.push('Resubmit corrected transactions.]');
    return lines.join('\n');
}

export {
    validateBatch,
    validateFormat,
    formatErrors,
    VALID_OPS,
    VALID_ENTITIES,
};
```

**New code:**

```javascript
/**
 * Format validation errors into an injection message for the LLM.
 * @param {FormatViolation[]} errors
 * @returns {string}
 */
function formatErrors(errors) {
    if (errors.length === 0) return '';

    const lines = [`[LEDGER: FORMAT ERROR — ${errors.length} issue(s):`];
    for (const err of errors.slice(0, 5)) { // Cap at 5 to avoid flooding
        lines.push(`  ${err.message}. Fix: ${err.fix}`);
    }
    if (errors.length > 5) {
        lines.push(`  ...and ${errors.length - 5} more.`);
    }
    lines.push('Resubmit corrected transactions.]');
    return lines.join('\n');
}

/**
 * Validate state-machine transitions for a batch of transactions (§6.1).
 * Only `TR` ops are checked; all others pass through untouched.
 * Invalid TRs are pulled out of the `valid` stream and returned as structured
 * errors for the caller's correction queue. Other TXs in the batch still
 * commit (per-tx filtering, not batch abort).
 *
 * @param {Array} transactions
 * @returns {{ valid: Array, errors: Array<{ lineNum: number, error: string, fix: string, raw: string, tx: any }> }}
 */
function validateTransitions(transactions) {
    const valid = [];
    const errors = [];
    if (!Array.isArray(transactions)) return { valid: [], errors: [] };

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx?.op !== 'TR') {
            valid.push(tx);
            continue;
        }
        const result = validateTransition(tx.e, tx.d?.f, tx.d?.from, tx.d?.to);
        if (result.valid) {
            valid.push(tx);
        } else {
            errors.push({
                lineNum: i,
                error: result.error,
                fix: result.fix,
                raw: `[tr ${tx.e}:${tx.id}]`,
                tx,
            });
        }
    }
    return { valid, errors };
}

export {
    validateBatch,
    validateFormat,
    validateTransitions,
    formatErrors,
    VALID_OPS,
    VALID_ENTITIES,
};
```

### F6.B — Replace inline TR validation in `index.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`

**Update the consistency.js import (line 12):**

**Old:**
```javascript
import { validateBatch, formatErrors } from './consistency.js';
```

**New:**
```javascript
import { validateBatch, formatErrors, validateTransitions } from './consistency.js';
```

**Remove the now-unused `validateTransition` import (line 19):**

**Old:**
```javascript
import { getStateMachineField, validateTransition } from './state-machine.js';
```

**New:**
```javascript
import { getStateMachineField } from './state-machine.js';
```

**Replace the inline TR-validation block inside the commit loop.**

**Old code (exact — `index.js:1511–1523`):**

```javascript
        // ── Validate state machine transitions (TR ops only) ─────────────
        if (tx.op === 'TR') {
            const transitionResult = validateTransition(tx.e, tx.d?.f, tx.d?.from, tx.d?.to);
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
        // ─────────────────────────────────────────────────────────────────
```

**New code:**

```javascript
        // State-machine TR validation runs as a post-loop batch call below
        // (consistency.js::validateTransitions, §6.1). Retained stub only to
        // document intent at the per-tx site.
```

**Then splice in the batch call right after the loop closes and `validTxns` is built.**

**Old code (exact — `index.js:1524–1537`, immediately after the per-tx loop):**

```javascript
        validTxns.push(tx);
    }

    // Combine all errors (extraction parse errors + validation errors)
    const allErrors = [...extractionErrors, ...validationErrors];

    // Queue errors for correction on next turn
    if (allErrors.length > 0) {
        queueCorrections(allErrors);
        console.warn(`${LOG_PREFIX} ${allErrors.length} errors queued for correction.`);
    }
```

**New code:**

```javascript
        validTxns.push(tx);
    }

    // ── State-machine TR validation (§6.1, wired in consistency.js) ────────────
    const trResult = validateTransitions(validTxns);
    validTxns = trResult.valid;
    for (const e of trResult.errors) validationErrors.push(e);

    // Combine all errors (extraction parse errors + validation errors)
    const allErrors = [...extractionErrors, ...validationErrors];

    // Queue errors for correction on next turn
    if (allErrors.length > 0) {
        queueCorrections(allErrors);
        console.warn(`${LOG_PREFIX} ${allErrors.length} errors queued for correction.`);
    }
```

**Reassignment gotcha:** If `validTxns` is declared with `const` in the scope above, change it to `let`. Check with `grep -n "const validTxns\|let validTxns" index.js`. If the match is `const validTxns = []`, change to `let validTxns = []`.

**Rationale:** Spec §6.1 + §9 — `consistency.js` is the designated home for TR validation. Batching the check keeps the `index.js` commit loop readable and lets the same helper ship to any future entry point.

**Ordering:** Apply after F5.

**Verification:**
- `node -c consistency.js` and `node -c index.js` pass.
- `grep -n "validateTransition(" index.js` → zero matches. Only `validateTransitions` (the batch helper) should appear in `index.js`.
- `grep -n "validateTransition(" consistency.js` → exactly one call inside `validateTransitions`.
- Trigger `TR collision:c1 field=status from=RESOLVED to=ACTIVE`; confirm correction is queued and the TX is not appended.

---

## F7 — Move collision archive presence check into `consistency.js` (P2)

**Finding ID:** AUDIT §2.2.1 — archive presence check lives in `index.js:1579–1622`; spec §9 puts it in `consistency.js`.

**Approach:** Put the pure detection in `consistency.js`; keep the stateful side effects (correction queue push, attempt counter, auto-fallback append) in `index.js`.

### F7.A — Add `findMissingArchiveEntries` to `consistency.js`

Insert this function in `consistency.js` immediately **above** `validateTransitions` (added in F6.A):

```javascript
/**
 * Identify terminal collision TRs (RESOLVED/CRASHED) in a committed batch that
 * lack a matching `world.collision_archive` entry.
 * §2.2.1 — "engine checks for a world.collision_archive append when processing
 * a terminal collision TR". Pure detection; caller owns the correction-queue
 * side effects.
 *
 * @param {Array} committedTxns — transactions just appended
 * @param {Object} state — post-commit computed state
 * @returns {Array<{ id: string, name: string, to: string }>} missing entries
 */
function findMissingArchiveEntries(committedTxns, state) {
    if (!Array.isArray(committedTxns) || committedTxns.length === 0) return [];
    const archive = Array.isArray(state?.world?.collision_archive) ? state.world.collision_archive : [];

    const terminals = committedTxns
        .filter(tx => tx.op === 'TR' && tx.e === 'collision'
            && (tx.d?.to === 'RESOLVED' || tx.d?.to === 'CRASHED'))
        .map(tx => ({ id: tx.id, to: tx.d.to }));

    const missing = [];
    for (const { id: colId, to } of terminals) {
        const col = state.collisions?.[colId];
        const nameToken = col?.name ? String(col.name) : '';
        const matched = archive.some(entry => {
            const s = String(entry || '');
            return s.includes(colId) || (nameToken && s.includes(nameToken));
        });
        if (!matched) missing.push({ id: colId, name: nameToken, to });
    }
    return missing;
}
```

**Update the exports in `consistency.js`** (after F6.A's export block):

```javascript
export {
    validateBatch,
    validateFormat,
    validateTransitions,
    findMissingArchiveEntries,
    formatErrors,
    VALID_OPS,
    VALID_ENTITIES,
};
```

### F7.B — Replace inline archive check in `index.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`

**Update the consistency.js import (already modified in F6.B):**

**Old (post-F6.B):**
```javascript
import { validateBatch, formatErrors, validateTransitions } from './consistency.js';
```

**New:**
```javascript
import { validateBatch, formatErrors, validateTransitions, findMissingArchiveEntries } from './consistency.js';
```

**Old code (exact — `index.js:1579–1622`):**

```javascript
    // ── Archive presence check (§2.2.1, §6.1) ──────────────────────────────────
    // After each commit, scan for terminal collision TRs without a matching archive entry
    // that references the collision by id or name. Checks full world.collision_archive,
    // not just same-turn commits, so late archives (turn N+1) satisfy earlier terminals.
    if (committedTxns.length > 0) {
        const terminalTxns = committedTxns
            .filter(tx => tx.op === 'TR' && tx.e === 'collision'
                && (tx.d?.to === 'RESOLVED' || tx.d?.to === 'CRASHED'))
            .map(tx => ({ id: tx.id, to: tx.d.to }));

        const archive = Array.isArray(_currentState?.world?.collision_archive)
            ? _currentState.world.collision_archive
            : [];

        for (const { id: colId } of terminalTxns) {
            const col = _currentState.collisions?.[colId];
            const nameToken = col?.name ? String(col.name) : '';
            const matched = archive.some(entry => {
                const s = String(entry || '');
                return s.includes(colId) || (nameToken && s.includes(nameToken));
            });
            if (matched) {
                _archiveCorrectionAttempts.delete(colId);
                continue;
            }
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
                    error: `Missing archive entry for resolved collision ${colId}. Add: A world field=collision_archive value="[collision] ${col?.name || colId} ... [resolution] ... [hook] ... [aftermath] ..."`,
                }]);
            }
        }
    }
```

**New code:**

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

**Rationale:** Spec §9 assigns archive-presence checking to `consistency.js`. Splitting pure detection (there) from stateful enforcement (here) satisfies the spec without pulling `_archiveCorrectionAttempts`, `MAX_CORRECTION_ATTEMPTS`, or `append` into `consistency.js`.

**Ordering:** Apply after F6.

**Verification:**
- `node -c consistency.js` and `node -c index.js` pass.
- Resolve a collision without an archive entry; confirm correction is queued on turns N, N+1, N+2 and an auto-fallback archive entry is appended on turn N+3.
- Append a late archive on turn N+1; confirm the counter clears and no further corrections fire.

---

## F8 — Update stale comments (P2)

**Finding ID:** AUDIT §6.2 — `state-machine.js` and `consistency.js` comment blocks still claim state-machine transitions are not enforced.

### F8.A — `state-machine.js`

**File:** `G:\My Drive\AI RPG\Gravity 2\state-machine.js`

**Old code (exact — lines 1–11):**

```javascript
/**
 * state-machine.js — State machine definitions and reference data.
 *
 * Defines the valid states and transitions for each entity lifecycle.
 * These are NOT enforced by the extension — gameplay rules are the LLM's
 * responsibility, audited during OOC: eval. This module serves as:
 *
 * 1. Reference documentation for the state machines
 * 2. Utility functions the LLM-facing eval can use to describe valid transitions
 * 3. A library the prompt layer references when explaining rules to the LLM
 */
```

**New code:**

```javascript
/**
 * state-machine.js — State machine definitions and transition enforcement.
 *
 * Defines the valid states and transitions for each entity lifecycle.
 * Phase 2 wires `validateTransition()` into the commit pipeline via
 * `consistency.js::validateTransitions()` — invalid TRs are rejected at
 * commit time (§6.1). This module serves as:
 *
 * 1. Authoritative state tables for each entity type
 * 2. `validateTransition()` — the enforcement function called by consistency.js
 * 3. Utility helpers (getValidNextStates, isTerminal) used by OOC eval and the
 *    prompt layer for documentation
 */
```

### F8.B — `consistency.js`

Header already replaced in F6.A. If F6 has not been applied yet, apply F6.A's header replacement now. This entry is a cross-reference, not a separate edit.

**Rationale:** Housekeeping — documentation should match Phase 2 enforcement reality.

**Ordering:** Independent.

**Verification:** Visual inspection only — no runtime impact.

---

## F9 — Remove `MINUTES` from setup-wizard timeskip hint (P2)

**Finding ID:** AUDIT §2.6 — `MINUTES` is not a valid `timeskip_scale` per spec §3.2.

**File:** `G:\My Drive\AI RPG\Gravity 2\setup-wizard.js`
**Line range:** 203

**Old code (exact, single line):**

```javascript
> SET world field=timeskip_scale value="HOURS" -- Default tick scale for the first Advance; set to MINUTES/HOURS/DAYS/WEEKS/MONTHS on any turn that yields initiative
```

**New code:**

```javascript
> SET world field=timeskip_scale value="HOURS" -- Default tick scale for the first Advance; set to HOURS/DAYS/WEEKS/MONTHS on any turn that yields initiative
```

**Rationale:** Spec §3.2 enumerates HOURS/DAYS/WEEKS/MONTHS only. `TICK[scale]` would silently null-coalesce `MINUTES` to 1 (HOURS), masking the error.

**Ordering:** Independent.

**Verification:**
- `node -c setup-wizard.js` passes.
- `grep -n MINUTES setup-wizard.js` → zero matches.
- `grep -rn "MINUTES" *.js` → confirm no other callsite references MINUTES as a `timeskip_scale` value.

---

## F10 — Warn when collision CR omits `distance_category` (P2)

**Finding ID:** AUDIT §3.1 — spec asks for a warning; today the default to SHORT is silent.

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`

**Old code (exact — the distance-ownership audit loop around lines 1563–1572):**

```javascript
    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
```

**New code:**

```javascript
    // ── Distance ownership audit — warn if LLM sets engine-owned distance fields ──
    for (const tx of committedTxns) {
        if (tx.op === 'CR' && tx.e === 'collision' && !tx.d?.distance_category) {
            _pendingCorrections.push({
                text: `Collision ${tx.id} was created without distance_category. Engine defaulted to SHORT (distance=10). Set distance_category=IMMEDIATE/SHORT/MEDIUM/LONG on every CR collision (§3.1).`,
                attempts: 0,
            });
        }
        if (tx.op === 'S' && tx.e === 'collision' && tx.d?.f === 'distance') {
            _pendingCorrections.push({
                text: `Collision distances are engine-owned. Do not SET collision:${tx.id}.distance directly — set distance_category on creation and let the engine tick it.`,
                attempts: 0,
            });
```

**Rationale:** Spec §3.1 — "Warn if `CR collision` is missing `distance_category`." Currently silent.

**Ordering:** Independent.

**Verification:**
- `node -c index.js` passes.
- Emit `CR collision:x name="..." forces="..."` with no `distance_category`; confirm a correction appears on the next turn.

---

## F11 — Gate `char.location` writes to TRACKED/PRINCIPAL (P2)

**Finding ID:** AUDIT §2.1 — engine does not block `S char:<lower-tier> field=location` writes.

**File:** `G:\My Drive\AI RPG\Gravity 2\index.js`

**Old code (exact — `index.js:1494–1508`):**

```javascript
        // ── Travel plausibility (§2.4) ────────────────────────────────────
        if (tx.op === 'S' && tx.e === 'char' && tx.d?.f === 'location') {
            const charBefore = _currentState.characters?.[tx.id];
            const fromPlaceId = charBefore?.location;
            const travel = validateTravel(tx.id, fromPlaceId, tx.d.v, _currentState, _currentInjectMode);
            if (!travel.valid) {
                validationErrors.push({
                    lineNum: i,
                    error: travel.error,
                    fix: travel.fix,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
        }
```

**New code:**

```javascript
        // ── Travel plausibility + tier gate (§2.1, §2.4) ───────────────────
        if (tx.op === 'S' && tx.e === 'char' && tx.d?.f === 'location') {
            const charBefore = _currentState.characters?.[tx.id];
            const tier = String(charBefore?.tier || 'UNKNOWN').toUpperCase();
            if (tier !== 'TRACKED' && tier !== 'PRINCIPAL') {
                validationErrors.push({
                    lineNum: i,
                    error: `char:${tx.id} is tier ${tier}; location is only tracked for TRACKED/PRINCIPAL chars (§2.1). Promote first or omit location.`,
                    fix: `Remove the location SET, or TR this character to TRACKED first.`,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
            const fromPlaceId = charBefore?.location;
            const travel = validateTravel(tx.id, fromPlaceId, tx.d.v, _currentState, _currentInjectMode);
            if (!travel.valid) {
                validationErrors.push({
                    lineNum: i,
                    error: travel.error,
                    fix: travel.fix,
                    raw: `[char:${tx.id} location]`,
                });
                continue;
            }
        }
```

**Rationale:** Spec §2.1 — "Only tracked for TRACKED, PRINCIPAL, and the PC. KNOWN and UNKNOWN chars omit this." PC location uses the `pc` singleton (not a `char:<id>` entity), so gating on character tier is sufficient here.

**Ordering:** Independent.

**Verification:**
- `node -c index.js` passes.
- Emit `S char:unknown-char field=location value=place:x`; confirm rejection + correction on next turn.
- Emit `S char:principal-char field=location value=place:x`; confirm commit and travel check runs.

---

## F12 — `formatChallenge()` dispatcher in `state-view.js` (P2)

**Finding ID:** AUDIT §7.3 rule 3 — spec asks for a type-aware dispatcher.

**File:** `G:\My Drive\AI RPG\Gravity 2\state-view.js`

### F12.A — Add the dispatcher

Insert **immediately above** `function formatStateView(state, mode = 'full', includeArchive = true) {` (around line 104):

```javascript
/**
 * Dispatch challenge entity formatting by type (§7.3 rule 3).
 * Reads `kind` first, falling back to `challenge_type` for spec-matching code paths.
 * Today only `combat` is implemented; future challenge types add their own branch
 * without touching this function's callers.
 * @param {Object} challenge
 * @param {Object} opts — { compact: boolean } compact=true for registry listing
 * @returns {string[]} lines to push into the state view
 */
function formatChallenge(challenge, { compact = false } = {}) {
    const type = challenge?.kind || challenge?.challenge_type || 'combat';
    const lines = [];
    if (type === 'combat') {
        if (compact) {
            let combatLine = `  ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}]`;
            if (challenge.primary_enemy) {
                const pe = typeof challenge.primary_enemy === 'object'
                    ? (challenge.primary_enemy.name || challenge.primary_enemy.id || '?')
                    : challenge.primary_enemy;
                combatLine += ` vs ${pe}`;
            }
            if (challenge.opened_from) combatLine += ` (from collision:${challenge.opened_from})`;
            combatLine += ` → id: ${challenge.id}`;
            lines.push(combatLine);
        } else {
            lines.push(`  ⚔ ${challenge.name || challenge.id} [${challenge.status || 'ACTIVE'}] → id: ${challenge.id}`);
            if (challenge.primary_enemy) {
                const pe = typeof challenge.primary_enemy === 'object'
                    ? (challenge.primary_enemy.name || challenge.primary_enemy.id || '?')
                    : challenge.primary_enemy;
                lines.push(`    Primary enemy: ${pe}`);
            }
            if (challenge.opened_from) lines.push(`    Opened from: collision:${challenge.opened_from}`);
            if (challenge.outcome) lines.push(`    Outcome: ${challenge.outcome}`);
            if (challenge.aftermath) lines.push(`    Aftermath: ${challenge.aftermath}`);
        }
        return lines;
    }
    // Future challenge types slot in here.
    return lines;
}
```

### F12.B — Route the two inline combat renderers through the dispatcher

**Old code (exact — lines 239–254 of `state-view.js`, registry listing):**

```javascript
    // Combats — always show registry if active
    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            let combatLine = `  ${combat.name || combat.id} [${combat.status || 'ACTIVE'}]`;
            if (combat.primary_enemy) {
                const pe = typeof combat.primary_enemy === 'object' ? (combat.primary_enemy.name || combat.primary_enemy.id || '?') : combat.primary_enemy;
                combatLine += ` vs ${pe}`;
            }
            if (combat.opened_from) combatLine += ` (from collision:${combat.opened_from})`;
            combatLine += ` → id: ${combat.id}`;
            lines.push(combatLine);
        }
    }
```

**New code:**

```javascript
    // Combats — always show registry if active (routed through formatChallenge, §7.3 rule 3)
    const activeCombats = Object.values(state.combats || {}).filter(combat => String(combat.status || '').toUpperCase() !== 'RESOLVED');
    if (activeCombats.length) {
        lines.push('');
        lines.push('Combats:');
        for (const combat of activeCombats) {
            lines.push(...formatChallenge(combat, { compact: true }));
        }
    }
```

**Old code (exact — lines 364–378 of `state-view.js`, detail section):**

```javascript
    // Combats detail — combat and full modes
    if (showPower && activeCombats.length) {
        lines.push('');
        lines.push('COMBATS');
        for (const combat of activeCombats) {
            lines.push(`  ⚔ ${combat.name || combat.id} [${combat.status || 'ACTIVE'}] → id: ${combat.id}`);
            if (combat.primary_enemy) {
                const pe = typeof combat.primary_enemy === 'object' ? (combat.primary_enemy.name || combat.primary_enemy.id || '?') : combat.primary_enemy;
                lines.push(`    Primary enemy: ${pe}`);
            }
            if (combat.opened_from) lines.push(`    Opened from: collision:${combat.opened_from}`);
            if (combat.outcome) lines.push(`    Outcome: ${combat.outcome}`);
            if (combat.aftermath) lines.push(`    Aftermath: ${combat.aftermath}`);
        }
    }
```

**New code:**

```javascript
    // Combats detail — combat and full modes (routed through formatChallenge)
    if (showPower && activeCombats.length) {
        lines.push('');
        lines.push('COMBATS');
        for (const combat of activeCombats) {
            lines.push(...formatChallenge(combat, { compact: false }));
        }
    }
```

**Rationale:** Spec §7.3 rule 3 — "`state-view.js` should have a `formatChallenge(challenge)` function dispatching on `challenge_type`." Behavior is identical today; adding persuasion / racing / etc. becomes a pure add.

**Ordering:** Independent.

**Verification:**
- `node -c state-view.js` passes.
- Active combat renders identically in both the registry and detail sections before and after the change.

---

## F13 — Reconcile `kind` vs `challenge_type` naming (P2)

**Finding ID:** AUDIT §7.3 rule 1 — profiles use `kind: 'combat'`; spec names the field `challenge_type`.

**Recommended approach (Option A):** Keep `kind` in code and update the spec. A full rename would ripple through profiles, runtime, and persisted challenge entities without functional gain.

### F13.A — Option A (preferred): update spec

**File:** `G:\My Drive\AI RPG\Gravity 2\PHASE2-SPEC.md`

Search for: `Challenge type is a field, not a code branch.`

**Old code (exact — single line):**

```markdown
1. **Challenge type is a field, not a code branch.** Schema: `challenge_type: 'combat' | 'persuasion' | ...`. Shared fields (`status`, `outcome`, `aftermath`) are base entity fields. Type-specific fields are optional or namespaced.
```

**New code:**

```markdown
1. **Challenge type is a field, not a code branch.** Schema: `kind: 'combat' | 'persuasion' | ...` (the codebase names this field `kind` on the profile and serialized entity; earlier drafts of this spec called it `challenge_type`). Shared fields (`status`, `outcome`, `aftermath`) are base entity fields. Type-specific fields are optional or namespaced.
```

The dispatcher in F12 already accepts both names (`kind` first, then `challenge_type`), so no code change is needed for Option A.

### F13.B — Option B (only if a full rename is committed): code-side

Touchpoints — do not attempt unless fully committing:
- `challenge-profile-combat.js:157` — `kind: 'combat'`
- `challenge-profile-combat.js:201` — `seedFields: Object.freeze({ kind: 'combat', status: 'ACTIVE' })`
- `challenge-state.js:634` — `startChallengeRuntime(profile.kind, drawFn())`
- `challenge-state.js:640` — `getChallengeSettings(profile.kind)`
- `challenge-state.js:133–140` — runtime migration of the legacy `exchange` → `clash` (unrelated but in the same area)
- Any other consumer: `grep -n "profile\.kind\|\.kind ===\|kind:\s*['\"]combat" *.js`

Rename each occurrence of the profile field `kind` to `challenge_type`. This is a multi-file refactor. Prefer Option A unless there's a specific reason to migrate.

**Rationale:** Spec §7.3 rule 1 is a design principle ("type is a field, not a code branch") and the code already satisfies it. The discrepancy is naming only.

**Ordering:** Independent. Pick exactly one option.

**Verification (Option A):** `grep -n "challenge_type" PHASE2-SPEC.md` — matches updated. Code grep unchanged.

---

## P3 Notes (no mechanical fix required)

### N1 — Key moments cap language in spec

F3 aligns the implementation with the spec's "last 10" wording. If mode-aware caps are desired instead, update spec §2.1 to enumerate them (e.g. "last 10 in full mode, last 5 elsewhere") rather than chasing the code back.

### N2 — Readme / preset content audit

Not covered here. A separate pass should diff `formatReadmeCore()` / `formatReadmeFull()` output against spec §2.1 (NESCIENCE), §2.2.2 (collision sources table), §3.5 (arrival prompt template), and §3.6 (15-minute scene cap language).

### N3 — Preset JSON audit

`gravity_v14.json`, `gravity_v15.json`, and `Gravity World Info.json` should be diffed against the spec's readme and gameplay guidance. Out of scope here.

### N4 — Worktree cleanup

`.claude/worktrees/` contains 50+ sibling copies. If any represent stale Phase 2 attempts, prune them so future audits don't get confused by near-duplicate files. Hygienic only.

---

## Post-remediation verification checklist

After applying F1–F13, run in order:

1. `node -c index.js` — must pass.
2. `node -c state-compute.js` — must pass.
3. `node -c state-machine.js` — must pass.
4. `node -c consistency.js` — must pass.
5. `node -c state-view.js` — must pass.
6. `node -c snapshot-mgr.js` — must pass.
7. `node -c setup-wizard.js` — must pass.
8. `grep -n "validateTransition(" index.js` → zero matches (only `validateTransitions` survives as a batch call).
9. `grep -n "world\.timeskip_scale" index.js` → reads only inside `applyAdvanceTick()`.
10. `grep -n "MINUTES" *.js` → zero matches as a `timeskip_scale` value.
11. `grep -rn "iching\|hexagram\|1d64" *.js` → zero matches (sanity check post-F1).
12. Functional smoke test: fresh chat, run through setup wizard → regular turn → click Advance with LLM declaring `timeskip_scale=DAYS` in the response → confirm distances tick by 3 on the same turn.
13. Functional smoke test: OOC rollback after an IMMEDIATE collision arrival → confirm the collision can re-fire on the next matching turn.
14. Functional smoke test: invalid TR (e.g. `TR collision:c1 field=status from=RESOLVED to=ACTIVE`) → correction queued, TX not appended, other TXs in the batch commit normally.
