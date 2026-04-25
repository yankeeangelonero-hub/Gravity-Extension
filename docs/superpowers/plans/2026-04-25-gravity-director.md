# Gravity Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `---LEDGER---` / `---STATE---` parsing with a separate API call to a director model that proposes ledger transactions in JSON, while keeping deterministic validation and commit authority in the SillyTavern extension.

**Architecture:** Browser-side `fetch` from the extension to a configurable provider (Anthropic or OpenAI). New `director-client.js` (provider abstraction + structured-output enforcement) and `director-prompt.js` (system prompt + JSON op vocabulary). Existing `onMessageReceived` seam in `index.js` swaps `extractUpdateBlock()` for `proposeTransactions()`. Pre-validation pipeline (mode snapshot, duplicate-challenge rewrite) preserved exactly. Reinforcement split by audience: challenge corrections stay on prose-side via `_pendingReinforcement`, director-failure flows to director-side via `lastDirectorFailed`. Preset and `formatReadme()` content migrate into `director-prompt.js` with examples reissued in JSON tx form. Reference: `docs/superpowers/specs/2026-04-25-gravity-director-design.md`.

**Tech Stack:** JavaScript ES modules (extension code, browser context), Node.js + CommonJS (tests, mirroring `scripts/test-relationship.js`), Anthropic Messages API (tool_use), OpenAI Chat Completions API (response_format json_schema).

---

## File Structure

**New files:**
- `director-client.js` — provider abstraction, fetch wrapper, structured-output enforcement. Exposes `proposeTransactions(input)`.
- `director-prompt.js` — system prompt + op vocabulary readme for director. Absorbs `formatReadme()` semantic content with all examples reissued as JSON tx objects.
- `director-input.js` — pure helper: snap mode + assemble director payload. Kept separate from `index.js` so it's node-testable.
- `scripts/test-director.js` — node-runnable test harness mirroring `scripts/test-relationship.js`.
- `scripts/spike-director-fetch.html` — pre-prototype CORS / direct-browser-fetch spike.
- `docs/superpowers/plans/2026-04-25-baseline-metrics.md` — pre-prototype baseline output.

**Modified files:**
- `index.js` — seam swap; mode snapshot; reinforcement audience split; `_readme` slot removal; settings drawer registration; pendingCorrections rewire; lastDirectorFailed state.
- `regex-intercept.js` — add `stripUpdateBlock()`; replace `buildCorrectionInjection()` with `buildDirectorCorrectionPayload()`; keep `stripLedgerBlock` (backward-compat) and `extractUpdateBlock` (debug-only export).
- `state-view.js` — delete `formatReadme()`, `formatReadmeCore()`, `formatReadmeFull()`. `formatStateView()` untouched.
- `gravity_v15.json` — disable/rewrite "Gravity - Anchor" entry, disable "L4 - Phase 2 Commands" entry, audit other entries for ledger-emit references.
- `ui-panel.js` — disabled-mode banner + director-failed badge surfaces.
- `Documentation/system_architecture_reference.md` — add `director-prompt` and `director-client` to maintenance checklist; flag director-prompt as a doc-drift hotspot.
- `Documentation/project_memory.md` — note the architectural shift.
- `CLAUDE.md` — remove `_readme` from injection-slots list; add brief director note.

**Untouched:** `consistency.js`, `state-machine.js`, `state-compute.js`, `snapshot-mgr.js`, `ledger-store.js`, all challenge modules.

---

## Phase 0 — Pre-Prototype Gates

Two hard gates from spec §12. If either fails, stop and revisit the spec before continuing.

### Task 0.1: Capture parser-path baseline metrics

**Files:**
- Create: `docs/superpowers/plans/2026-04-25-baseline-metrics.md`

- [ ] **Step 1: Pick the turn set**

Pick N ≥ 20 turns from exported chats in `Tests/`. Pick a mix of regular, advance, combat, and intimacy turns from real play sessions. Record source chat name and message indices in the metrics doc.

- [ ] **Step 2: Add temporary instrumentation**

In `index.js` `onMessageReceived()`, immediately after `const extraction = extractUpdateBlock(message.mes);` (line 1527), add:

```js
const __t0 = performance.now();
console.log(`[BASELINE] turn=${_turnCounter} extracted=${extraction.transactions?.length || 0} found=${extraction.found} format=${extraction.format || 'none'}`);
```

After the `validateBatch` loop completes (around line 1700+ where `committedTxns` is final), add:

```js
const __dt = performance.now() - __t0;
console.log(`[BASELINE] turn=${_turnCounter} committed=${committedTxns.length} rejected=${validationErrors.length} dt_ms=${__dt.toFixed(1)}`);
```

- [ ] **Step 3: Replay the picked turns**

Load each chat in SillyTavern, replay/swipe through the picked turns with the instrumentation active, capture the console output.

- [ ] **Step 4: Subjective miss assessment**

For each turn, judge: *did the prose imply a structural update that the ledger missed?* Record yes/no.

- [ ] **Step 5: Aggregate metrics**

Write `docs/superpowers/plans/2026-04-25-baseline-metrics.md` with:

```markdown
# Parser Baseline Metrics

Captured: <date>
Turn set: N=<count>, sourced from <chat list>

## Per-session aggregates

| Metric | Value |
|---|---|
| Avg committed txs / turn | |
| Avg rejected txs / turn | |
| % turns with no block found | |
| % turns with subjective missed update | |
| Latency p50 (ms) | |
| Latency p95 (ms) | |

## Per-turn data

| Turn | Mode | Committed | Rejected | Found | Subjective miss | Latency ms |
|---|---|---|---|---|---|---|
```

- [ ] **Step 6: Remove instrumentation, commit metrics doc only**

Revert the two `console.log` insertions in `index.js`. Verify with `node -c index.js`.

```bash
git add docs/superpowers/plans/2026-04-25-baseline-metrics.md
git commit -m "docs: capture parser-path baseline metrics for director comparison"
```

### Task 0.2: Browser-fetch feasibility spike

**Files:**
- Create: `scripts/spike-director-fetch.html`

- [ ] **Step 1: Write the spike page**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gravity Director — fetch spike</title></head>
<body style="font-family: system-ui; max-width: 720px; margin: 2em auto;">
<h2>Anthropic / OpenAI direct-browser-fetch spike</h2>
<p>Goal: confirm both providers accept direct browser fetch from a SillyTavern extension page context.</p>
<input id="anth-key" type="password" placeholder="Anthropic API key" style="width:100%;margin:.5em 0;" />
<button onclick="testAnth()">Test Anthropic (claude-sonnet-4-6)</button>
<input id="openai-key" type="password" placeholder="OpenAI API key" style="width:100%;margin:.5em 0;" />
<button onclick="testOpenAI()">Test OpenAI (gpt-4o-mini)</button>
<pre id="out" style="background:#222;color:#eee;padding:1em;white-space:pre-wrap;"></pre>
<script>
async function testAnth() {
  const key = document.getElementById('anth-key').value.trim();
  const out = document.getElementById('out');
  out.textContent = 'Calling Anthropic...';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with the JSON {"ok":true} and nothing else.' }]
      })
    });
    out.textContent = `Anthropic HTTP ${r.status}\n\n` + await r.text();
  } catch (e) { out.textContent = 'Anthropic ERROR: ' + e.message + '\n(likely CORS)'; }
}
async function testOpenAI() {
  const key = document.getElementById('openai-key').value.trim();
  const out = document.getElementById('out');
  out.textContent = 'Calling OpenAI...';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with the JSON {"ok":true} and nothing else.' }],
        response_format: { type: 'json_object' }
      })
    });
    out.textContent = `OpenAI HTTP ${r.status}\n\n` + await r.text();
  } catch (e) { out.textContent = 'OpenAI ERROR: ' + e.message + '\n(likely CORS)'; }
}
</script>
</body>
</html>
```

- [ ] **Step 2: Serve the spike from the extension directory**

Place the file at `scripts/spike-director-fetch.html`. Open it in the browser via SillyTavern's static-file path (typically `/scripts/extensions/third-party/<ext-name>/scripts/spike-director-fetch.html`). The same-origin trust posture matches what the real director call will face.

- [ ] **Step 3: Run both providers**

Use a real key for each. Record outcome. Required: HTTP 200 with valid JSON body for both.

- [ ] **Step 4: Decide gate**

- Both PASS → continue plan.
- Either FAIL → STOP. Document failure in the metrics doc. Spec must be revisited (likely flips "no relay" decision).

- [ ] **Step 5: Commit the spike file**

```bash
git add scripts/spike-director-fetch.html
git commit -m "spike: confirm Anthropic + OpenAI direct browser fetch from extension context"
```

---

## Phase 1 — Foundation Helpers

Pure-function helpers, fully node-testable. Lay the test harness first.

### Task 1.1: Test harness scaffold

**Files:**
- Create: `scripts/test-director.js`

- [ ] **Step 1: Write the harness file**

Mirror `scripts/test-relationship.js` exactly. Reuse `test`, `group`, `assert`, `assertEqual`, `assertDeep`.

```js
// scripts/test-director.js
// Unit tests for the director helper layer (stripUpdateBlock,
// buildDirectorCorrectionPayload, director-input builder).
//
// Usage: node scripts/test-director.js
// Exit code: 0 if all pass, 1 if any fail.

'use strict';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        failed++; failures.push({ name, err });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function group(name, fn) { console.log(`\n${name}`); fn(); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label || 'assertEqual'}: expected ${e}, got ${a}`);
}

// ─── Tests added by subsequent tasks ──────────────────────────────────────────

group('harness sanity', () => {
    test('1+1=2', () => { assertEqual(1 + 1, 2); });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.name}: ${f.err.stack || f.err.message}`);
    process.exit(1);
}
process.exit(0);
```

- [ ] **Step 2: Run it**

```bash
node scripts/test-director.js
```

Expected: `1 passed, 0 failed`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-director.js
git commit -m "test: add director helper test harness scaffold"
```

### Task 1.2: `stripUpdateBlock()` — strip both LEDGER and STATE blocks

**Files:**
- Modify: `regex-intercept.js`
- Modify: `scripts/test-director.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-director.js` (replace the placeholder `harness sanity` group later — for now, add a new group):

```js
// Note: regex-intercept.js uses ES module exports. For node-CommonJS tests,
// we import the patterns directly via the file's exports if it provides
// CommonJS-compatible exports, or we mirror the pattern definitions here.
// Mirror approach used to keep tests independent of module-system mismatch.

const LEDGER_BLOCK_PATTERN = /[-—–]{2,3}\s*LEDGER\s*(?:BLOCK)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*LEDGER\s*[-—–]{2,3}/i;
const STATE_BLOCK_PATTERN = /[-—–]{2,3}\s*STATE\s*(?:DELTA)?\s*[-—–]{2,3}([\s\S]*?)[-—–]{2,3}\s*END\s*STATE\s*[-—–]{2,3}/i;

function stripUpdateBlock(message) {
    if (!message) return message;
    return message
        .replace(LEDGER_BLOCK_PATTERN, '')
        .replace(STATE_BLOCK_PATTERN, '')
        .trim();
}

group('stripUpdateBlock', () => {
    test('strips ---LEDGER--- block', () => {
        const msg = 'prose before\n---LEDGER---\nCR char:elena\n---END LEDGER---\nprose after';
        assertEqual(stripUpdateBlock(msg), 'prose before\n\nprose after');
    });
    test('strips ---STATE--- block', () => {
        const msg = 'prose\n---STATE---\nat: [Day 1 - 12:00]\n---END STATE---\ntail';
        assertEqual(stripUpdateBlock(msg), 'prose\n\ntail');
    });
    test('strips both LEDGER and STATE in the same message', () => {
        const msg = '---STATE---\nfoo\n---END STATE---\nmid\n---LEDGER---\nCR a\n---END LEDGER---';
        assertEqual(stripUpdateBlock(msg), 'mid');
    });
    test('returns input unchanged if no block present', () => {
        assertEqual(stripUpdateBlock('plain prose'), 'plain prose');
    });
    test('handles null/undefined', () => {
        assertEqual(stripUpdateBlock(null), null);
        assertEqual(stripUpdateBlock(undefined), undefined);
    });
});
```

- [ ] **Step 2: Run tests and confirm they pass**

The test mirrors the implementation inline (since the test file is node-CommonJS and `regex-intercept.js` is ES module). The tests confirm the *behavior contract* the production code must match.

```bash
node scripts/test-director.js
```

Expected: `stripUpdateBlock` group all pass.

- [ ] **Step 3: Add `stripUpdateBlock()` to `regex-intercept.js`**

Insert immediately after `stripLedgerBlock` (line 686), before the `export {` block (line 688):

```js
/**
 * Strip both LEDGER and STATE update blocks from a message.
 * Used by the director input pipeline (assistantMessage cleaning,
 * recentTurns cleaning) and display cleaning. Migration chats
 * frequently contain ---STATE--- blocks that stripLedgerBlock misses.
 * @param {string} message
 * @returns {string}
 */
function stripUpdateBlock(message) {
    if (!message) return message;
    return message
        .replace(LEDGER_BLOCK_PATTERN, '')
        .replace(STATE_BLOCK_PATTERN, '')
        .trim();
}
```

Add `stripUpdateBlock` to the export list at line 688:

```js
export {
    extractUpdateBlock,
    extractLedgerBlock,
    parseLine,
    parseKeyValues,
    parseStateLine,
    parseStateScalar,
    getReinforcement,
    buildCorrectionInjection,
    stripLedgerBlock,
    stripUpdateBlock,
    getComplianceScore,
    LEDGER_BLOCK_PATTERN,
    STATE_BLOCK_PATTERN,
};
```

(Also export `STATE_BLOCK_PATTERN` since it's now part of the public surface.)

- [ ] **Step 4: Verify with node -c**

```bash
node -c regex-intercept.js
```

Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add regex-intercept.js scripts/test-director.js
git commit -m "feat(regex-intercept): add stripUpdateBlock covering LEDGER and STATE patterns"
```

### Task 1.3: `buildDirectorCorrectionPayload()` — structured corrections for director input

**Files:**
- Modify: `regex-intercept.js`
- Modify: `scripts/test-director.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-director.js`:

```js
// Mirror the implementation contract for node-CommonJS testing.
function buildDirectorCorrectionPayload(failedLines) {
    if (!failedLines || failedLines.length === 0) return null;
    return {
        kind: 'director_corrections',
        items: failedLines.map(fl => ({
            tx: fl.raw || null,
            error: fl.error || '',
            fix: fl.fix || null,
            attempts: fl.attempts || 0,
        })),
    };
}

group('buildDirectorCorrectionPayload', () => {
    test('returns null on empty input', () => {
        assertEqual(buildDirectorCorrectionPayload([]), null);
        assertEqual(buildDirectorCorrectionPayload(null), null);
        assertEqual(buildDirectorCorrectionPayload(undefined), null);
    });
    test('shapes a single failure', () => {
        const out = buildDirectorCorrectionPayload([
            { raw: '[char:elena tier]', error: 'invalid transition', fix: 'use TRACKED', attempts: 1 }
        ]);
        assertEqual(out, {
            kind: 'director_corrections',
            items: [{ tx: '[char:elena tier]', error: 'invalid transition', fix: 'use TRACKED', attempts: 1 }]
        });
    });
    test('handles missing optional fields', () => {
        const out = buildDirectorCorrectionPayload([{ error: 'oops' }]);
        assertEqual(out.items[0], { tx: null, error: 'oops', fix: null, attempts: 0 });
    });
});
```

- [ ] **Step 2: Run tests, confirm pass**

```bash
node scripts/test-director.js
```

- [ ] **Step 3: Add `buildDirectorCorrectionPayload()` to `regex-intercept.js`**

Insert after `buildCorrectionInjection` (line 676), before `stripLedgerBlock`:

```js
/**
 * Build a structured corrections payload for the director.
 * Replaces buildCorrectionInjection() in the director path —
 * that function emits prose-side text instructing the prose
 * model to resubmit blocks, which is dead under cutover.
 * @param {Array} failedLines - { lineNum, error, raw, fix, attempts }
 * @returns {object|null}
 */
function buildDirectorCorrectionPayload(failedLines) {
    if (!failedLines || failedLines.length === 0) return null;
    return {
        kind: 'director_corrections',
        items: failedLines.map(fl => ({
            tx: fl.raw || null,
            error: fl.error || '',
            fix: fl.fix || null,
            attempts: fl.attempts || 0,
        })),
    };
}
```

Add to the export list:

```js
export {
    // ... existing exports
    buildDirectorCorrectionPayload,
    // ...
};
```

- [ ] **Step 4: node -c verify**

```bash
node -c regex-intercept.js
```

- [ ] **Step 5: Commit**

```bash
git add regex-intercept.js scripts/test-director.js
git commit -m "feat(regex-intercept): add buildDirectorCorrectionPayload for director-bound corrections"
```

### Task 1.4: `director-input.js` — pure payload builder

**Files:**
- Create: `director-input.js`
- Modify: `scripts/test-director.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-director.js`:

```js
// Mirror the contract; production module is loaded when CommonJS-bridge added in step 3.
function buildDirectorInput({
    snappedInjectMode, snappedReasonMode, snappedDeductionType,
    userMessage, assistantMessage, stateView,
    recentLedgerTail, pendingCorrections, recentTurns,
    lastDirectorFailed
}) {
    return {
        mode: snappedInjectMode || 'regular',
        reasonMode: snappedReasonMode || 'regular',
        deductionType: snappedDeductionType || null,
        userMessage: userMessage || '',
        assistantMessage: assistantMessage || '',
        stateView: stateView || '',
        recentLedgerTail: Array.isArray(recentLedgerTail) ? recentLedgerTail : [],
        pendingCorrections: pendingCorrections || null,
        recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
        lastDirectorFailed: !!lastDirectorFailed,
    };
}

group('buildDirectorInput', () => {
    test('all fields default cleanly when input is sparse', () => {
        const out = buildDirectorInput({});
        assertEqual(out, {
            mode: 'regular', reasonMode: 'regular', deductionType: null,
            userMessage: '', assistantMessage: '', stateView: '',
            recentLedgerTail: [], pendingCorrections: null, recentTurns: [],
            lastDirectorFailed: false,
        });
    });
    test('passes through full payload', () => {
        const out = buildDirectorInput({
            snappedInjectMode: 'advance', snappedReasonMode: 'combat',
            snappedDeductionType: 'combat',
            userMessage: 'u', assistantMessage: 'a', stateView: 's',
            recentLedgerTail: [{ op: 'CR' }], pendingCorrections: { kind: 'director_corrections', items: [] },
            recentTurns: [{ user: 'u1', assistant: 'a1' }],
            lastDirectorFailed: true,
        });
        assertEqual(out.mode, 'advance');
        assertEqual(out.reasonMode, 'combat');
        assertEqual(out.deductionType, 'combat');
        assertEqual(out.lastDirectorFailed, true);
        assertEqual(out.recentLedgerTail.length, 1);
    });
});
```

- [ ] **Step 2: Run, confirm pass**

```bash
node scripts/test-director.js
```

- [ ] **Step 3: Create `director-input.js`**

```js
// director-input.js
// Pure helper: assemble the payload sent to the director model.
// Kept separate from index.js so it's node-testable without
// importing SillyTavern globals.
//
// IMPORTANT: `mode`, `reasonMode`, and `deductionType` MUST be
// snapshots taken BEFORE onMessageReceived() resets the live
// state fields (index.js:1512-1514). Reading the live fields
// after reset would classify every advance/combat/intimacy turn
// as `regular` and produce the wrong stateView mode argument.

export function buildDirectorInput({
    snappedInjectMode, snappedReasonMode, snappedDeductionType,
    userMessage, assistantMessage, stateView,
    recentLedgerTail, pendingCorrections, recentTurns,
    lastDirectorFailed,
} = {}) {
    return {
        mode: snappedInjectMode || 'regular',
        reasonMode: snappedReasonMode || 'regular',
        deductionType: snappedDeductionType || null,
        userMessage: userMessage || '',
        assistantMessage: assistantMessage || '',
        stateView: stateView || '',
        recentLedgerTail: Array.isArray(recentLedgerTail) ? recentLedgerTail : [],
        pendingCorrections: pendingCorrections || null,
        recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
        lastDirectorFailed: !!lastDirectorFailed,
    };
}
```

- [ ] **Step 4: node -c**

```bash
node -c director-input.js
```

- [ ] **Step 5: Commit**

```bash
git add director-input.js scripts/test-director.js
git commit -m "feat: add director-input.js pure payload builder"
```

---

## Phase 2 — Director Prompt

The director system prompt + JSON op vocabulary. Migrates `formatReadme()` semantic content but reissues every example as JSON tx objects.

### Task 2.1: `director-prompt.js` skeleton — role framing + behavioral priorities

**Files:**
- Create: `director-prompt.js`

- [ ] **Step 1: Create the file with role framing + priorities only**

```js
// director-prompt.js
// System prompt and op vocabulary readme for the Gravity director model.
// The director is a state-delta operator, not a prose model. It reads
// the current state + new turn + corrections and proposes ledger
// transactions in JSON. Deterministic extension code remains the only
// thing allowed to commit.
//
// DOC-DRIFT HOTSPOT: when schema, state-machine rules, op vocabulary,
// or entity types change, this file MUST update alongside the code.
// See Documentation/system_architecture_reference.md.

const ROLE = `You are the Gravity Director.

Your job: given the current ledger-derived state, the latest turn, and any pending corrections, decide what ledger transactions should commit. You DO NOT write prose. The prose model has already written the visible response. You only output structured JSON transactions.

Behavioral priorities (in order):
1. Structural integrity — never propose transactions that violate state-machine rules.
2. Causal continuity — every change must follow from something that actually happened in the accepted turn.
3. Earned change — prefer no update over speculative update. Empty transaction sets are a first-class outcome.
4. Conservative mutation — when in doubt, do less.
5. Validator compatibility — your output goes through deterministic validators that reject illegal transitions, so write txs that will pass.

You should EXPLICITLY NOT optimize for:
- Literary quality
- Style matching
- Visible response quality
- Recap completeness

Those belong to the prose model and the host extension.`;

export function buildDirectorSystemPrompt() {
    // Subsequent tasks append op vocabulary, state-machine rules, and examples.
    return ROLE;
}
```

- [ ] **Step 2: node -c**

```bash
node -c director-prompt.js
```

- [ ] **Step 3: Commit**

```bash
git add director-prompt.js
git commit -m "feat(director-prompt): add role framing + behavioral priorities skeleton"
```

### Task 2.2: Migrate op vocabulary, entity types, state-machine rules

**Files:**
- Modify: `director-prompt.js`

- [ ] **Step 1: Read the current readme content**

Read `state-view.js` lines 754-end (`formatReadme`, `formatReadmeCore`, `formatReadmeFull`). This is the source content. You will rewrite each `---STATE---` / `---LEDGER---` example as a JSON tx object. Rules and field contracts carry over verbatim where possible.

- [ ] **Step 2: Append op vocabulary section to `director-prompt.js`**

Add below `ROLE`:

```js
const OP_VOCABULARY = `## Transaction Operations

Every transaction is a JSON object. The fields:

- "op": one of CR, S, TR, A, R, MS, MR, D, SNAP, ROLL, AMEND
- "e":  entity type (char, constraint, collision, combat, faction, place, pressure, world, pc, divination, relationship)
- "id": entity id (kebab-case slug)
- "d":  op-specific data
- "r":  one-sentence reason for the change

### CR — Create entity
{ "op": "CR", "e": "char", "id": "elena", "d": { "name": "Elena Cross", "tier": "TRACKED", "tags": ["smuggler","archangel-contact"] }, "r": "Player named her this turn." }

### S — Set field
{ "op": "S", "e": "char", "id": "elena", "d": { "f": "location", "value": "place:medbay" }, "r": "Followed PC into the medbay." }

### TR — Transition (state-machine governed)
{ "op": "TR", "e": "collision", "id": "bridge-confrontation", "d": { "f": "status", "from": "ACTIVE", "to": "RESOLVED" }, "r": "PC forced the confrontation on-screen and it completed." }

### A — Append to a list field
{ "op": "A", "e": "world", "id": null, "d": { "f": "collision_archive", "value": "[collision] Bridge Confrontation [resolution] direct [hook] residue [aftermath] change" }, "r": "Archive the resolved collision." }

### R — Remove from a list (capped at 3 outside eval turns; combine R/MR/D)
{ "op": "R", "e": "pc", "id": null, "d": { "f": "scene_cast", "value": "char:athrun" }, "r": "Athrun left the scene." }

### MS — Map set (object/dict field, e.g., knowledge_asymmetry)
{ "op": "MS", "e": "char", "id": "elena", "d": { "f": "knowledge_asymmetry", "key": "knows_evidence", "value": "Has seen the documents." }, "r": "She just read them." }

### MR — Map del
{ "op": "MR", "e": "char", "id": "elena", "d": { "f": "knowledge_asymmetry", "key": "hiding_employer" }, "r": "Cover blown — secret no longer hidden." }

### D — Destroy entity (capped at 3 outside eval turns)
{ "op": "D", "e": "pressure", "id": "trade-tension", "r": "Consumed into a collision." }

### Other ops
- SNAP, ROLL, AMEND — operator-only ops. The director does not propose these.

## Cleanup cap

Outside eval turns, the engine drops R/MR/D ops past the 3rd. Don't propose more than 3 cleanup ops per turn unless an eval is active.
`;
```

- [ ] **Step 3: Append entity types + state-machine rules**

```js
const ENTITIES_AND_STATE_MACHINES = `## Entity types

char, constraint, collision, combat, faction, place, pressure, world, pc, divination, relationship.

## State machines

### Char tier: KNOWN → TRACKED → PRINCIPAL (one-way, no demotion in normal play).
### Constraint integrity: UNTESTED → STRESSED → STRAINED → BROKEN (one-way; HELD is a terminal state for tested-and-survived).
### Collision status: ACTIVE → RESOLVED | CRASHED. No SEEDED/SIMMERING/RESOLVING.
### Combat status: handled by the challenge runtime — do not propose combat status transitions directly; use combat-entity ops only when the runtime explicitly emits them.

## Distance categories (collision creation)

IMMEDIATE (1, fires on creation), SHORT (10), MEDIUM (20), LONG (50). The engine owns the \`distance\` field — do not set it. Set \`distance_category\` and \`cost\` on creation.

## Relationship rules

PC ↔ TRACKED+ char/faction. id format \`relationship:pc-<other_id>\`. \`status\` is engine-written — never propose. Every content change MUST occur inside a resolving relational collision (the same tx batch that contains the collision TR).

## Knowledge asymmetry keys

Four prefixes: \`knows_\`, \`unknown_\`, \`hiding_\`, \`misreading_\`. Cap: 20 entries combined across all four.
`;
```

- [ ] **Step 4: Wire into the system prompt builder**

Update `buildDirectorSystemPrompt()`:

```js
export function buildDirectorSystemPrompt() {
    return [ROLE, OP_VOCABULARY, ENTITIES_AND_STATE_MACHINES].join('\n\n');
}
```

- [ ] **Step 5: node -c**

```bash
node -c director-prompt.js
```

- [ ] **Step 6: Commit**

```bash
git add director-prompt.js
git commit -m "feat(director-prompt): add op vocabulary, entity types, state-machine rules"
```

### Task 2.3: Add full-turn JSON example + tests

**Files:**
- Modify: `director-prompt.js`
- Modify: `scripts/test-director.js`

- [ ] **Step 1: Append a realistic full-turn example**

Append to `director-prompt.js`:

```js
const FULL_TURN_EXAMPLE = `## Full-turn example

Imagine an advance turn in which the PC took a week to recover, a constraint was tested and held, and a new pressure point seeded. Output:

{
  "transactions": [
    { "op": "S", "e": "world", "id": null, "d": { "f": "timeskip_scale", "value": "WEEKS" }, "r": "PC took a week to recover." },
    { "op": "TR", "e": "constraint", "id": "c1", "d": { "f": "integrity", "from": "STRESSED", "to": "HELD" }, "r": "PC held the line under pressure." },
    { "op": "CR", "e": "pressure", "id": "lacus-distance", "d": { "name": "Lacus growing distant", "source": "Her silence after the medbay scene." }, "r": "New tension surfaced this advance." }
  ],
  "notes": "Conservative — no collision changes this advance.",
  "confidence": "high"
}

## Output contract

Always return exactly this JSON shape:

{
  "transactions": [ /* zero or more tx objects */ ],
  "notes": "optional free-text reasoning, ignored by extension",
  "confidence": "high" | "medium" | "low"
}

Empty transactions is a valid, encouraged outcome when nothing structural happened.
`;
```

Update the builder:

```js
export function buildDirectorSystemPrompt() {
    return [ROLE, OP_VOCABULARY, ENTITIES_AND_STATE_MACHINES, FULL_TURN_EXAMPLE].join('\n\n');
}
```

- [ ] **Step 2: Add a sanity test**

Append to `scripts/test-director.js`:

```js
// CommonJS bridge: dynamic-import the ES module
const { pathToFileURL } = require('url');
const path = require('path');
async function loadDirectorPrompt() {
    const url = pathToFileURL(path.resolve(__dirname, '..', 'director-prompt.js')).href;
    return await import(url);
}

group('director-prompt', () => {
    test('buildDirectorSystemPrompt returns non-empty string with key sections', async () => {
        const mod = await loadDirectorPrompt();
        const sys = mod.buildDirectorSystemPrompt();
        assert(typeof sys === 'string' && sys.length > 1000, 'expected substantial system prompt');
        assert(sys.includes('director'), 'role mentioned');
        assert(sys.includes('"op": "TR"'), 'TR JSON example present');
        assert(sys.includes('"transactions"'), 'output contract present');
    });
});
```

NOTE: Tests in this harness using async require special handling — wrap in an async runner. Simpler: instead of dynamic-import, read the file as text and assert against substrings. Replace the test with:

```js
const fs = require('fs');
group('director-prompt', () => {
    test('director-prompt.js contains required sections', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'director-prompt.js'), 'utf8');
        assert(src.includes('You are the Gravity Director'), 'role framing present');
        assert(src.includes('"op": "TR"'), 'TR JSON example present');
        assert(src.includes('"transactions"'), 'output contract present');
        assert(src.includes('Behavioral priorities'), 'priorities section present');
        assert(src.includes('State machines'), 'state machines section present');
    });
});
```

(`path` is needed; require it once at the top: `const path = require('path');`.)

- [ ] **Step 3: Run tests**

```bash
node scripts/test-director.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add director-prompt.js scripts/test-director.js
git commit -m "feat(director-prompt): full-turn example + content sanity test"
```

---

## Phase 3 — Director Client

Provider-agnostic client. Browser fetch, structured-output enforcement, normalized failure modes.

### Task 3.1: `director-client.js` entry + provider dispatch

**Files:**
- Create: `director-client.js`

- [ ] **Step 1: Write the entry-point module**

```js
// director-client.js
// Provider-abstracted client for the Gravity director model.
// Browser-side fetch, structured-output enforcement, normalized
// failure modes. Single async function: proposeTransactions(input).
//
// Spec: docs/superpowers/specs/2026-04-25-gravity-director-design.md §3.1.

import { buildDirectorSystemPrompt } from './director-prompt.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * @param {object} input  director payload (see director-input.js)
 * @param {object} config { provider, model, apiKey }
 * @returns {Promise<{ok:true, transactions, notes, confidence, model, durationMs}
 *                 | {ok:false, reason, raw, model?, durationMs?}>}
 */
export async function proposeTransactions(input, config) {
    if (!config || !config.provider || config.provider === 'disabled') {
        return { ok: false, reason: 'disabled', raw: 'Director provider not configured.' };
    }
    if (!config.apiKey) {
        return { ok: false, reason: 'auth', raw: 'No API key configured.' };
    }
    if (config.provider === 'anthropic') return callAnthropic(input, config);
    if (config.provider === 'openai') return callOpenAI(input, config);
    return { ok: false, reason: 'unknown_provider', raw: `Unknown provider: ${config.provider}` };
}

// callAnthropic and callOpenAI defined in subsequent tasks.
async function callAnthropic(input, config) {
    return { ok: false, reason: 'unimplemented', raw: 'callAnthropic not yet implemented' };
}
async function callOpenAI(input, config) {
    return { ok: false, reason: 'unimplemented', raw: 'callOpenAI not yet implemented' };
}
```

- [ ] **Step 2: node -c**

```bash
node -c director-client.js
```

- [ ] **Step 3: Commit**

```bash
git add director-client.js
git commit -m "feat(director-client): module skeleton with provider dispatch"
```

### Task 3.2: Anthropic provider — tool_use enforcement

**Files:**
- Modify: `director-client.js`

- [ ] **Step 1: Replace the `callAnthropic` stub**

```js
const TX_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        transactions: {
            type: 'array',
            items: { type: 'object' },
        },
        notes: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['transactions'],
};

async function callAnthropic(input, config) {
    const t0 = performance.now();
    const userPrompt = renderUserPrompt(input);
    const body = {
        model: config.model || 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: buildDirectorSystemPrompt(),
        tools: [{
            name: 'commit_transactions',
            description: 'Propose ledger transactions to commit for this turn.',
            input_schema: TX_INPUT_SCHEMA,
        }],
        tool_choice: { type: 'tool', name: 'commit_transactions' },
        messages: [{ role: 'user', content: userPrompt }],
    };

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        res = await fetch(ANTHROPIC_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network',
                 raw: e.message, durationMs: performance.now() - t0 };
    }

    const text = await res.text();
    if (!res.ok) {
        const reason = res.status === 401 || res.status === 403 ? 'auth'
                     : res.status === 429 ? 'ratelimit'
                     : 'http_error';
        return { ok: false, reason, raw: `HTTP ${res.status}: ${text.slice(0, 500)}`,
                 durationMs: performance.now() - t0 };
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'invalid_json', raw: text.slice(0, 500),
                          durationMs: performance.now() - t0 }; }

    const toolBlock = (parsed.content || []).find(b => b.type === 'tool_use' && b.name === 'commit_transactions');
    if (!toolBlock) {
        return { ok: false, reason: 'schema_mismatch', raw: 'No tool_use block in response.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    const out = toolBlock.input || {};
    if (!Array.isArray(out.transactions)) {
        return { ok: false, reason: 'schema_mismatch', raw: 'transactions field missing or not array.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    return {
        ok: true,
        transactions: out.transactions,
        notes: out.notes || '',
        confidence: out.confidence || 'medium',
        model: parsed.model,
        durationMs: performance.now() - t0,
    };
}

function renderUserPrompt(input) {
    return [
        `MODE: ${input.mode}${input.deductionType ? ' (' + input.deductionType + ')' : ''}`,
        `REASON_MODE: ${input.reasonMode}`,
        '',
        '=== CURRENT STATE VIEW ===',
        input.stateView,
        '',
        '=== RECENT LEDGER TAIL (last committed txs) ===',
        JSON.stringify(input.recentLedgerTail, null, 2),
        '',
        '=== RECENT TURNS (last 3 user/assistant pairs) ===',
        input.recentTurns.map(t => `USER: ${t.user}\nASSISTANT: ${t.assistant}`).join('\n---\n'),
        '',
        '=== USER MESSAGE THIS TURN ===',
        input.userMessage,
        '',
        '=== ASSISTANT RESPONSE THIS TURN (prose only) ===',
        input.assistantMessage,
        '',
        input.pendingCorrections
            ? '=== PENDING CORRECTIONS (your previous proposed txs were rejected) ===\n' +
              JSON.stringify(input.pendingCorrections, null, 2)
            : '',
        input.lastDirectorFailed
            ? '=== NOTE: last turn the director call FAILED. Be aware of possible unfinished business. ==='
            : '',
        '',
        'Propose the transactions that should commit for THIS turn.',
    ].filter(Boolean).join('\n');
}
```

- [ ] **Step 2: node -c**

```bash
node -c director-client.js
```

- [ ] **Step 3: Commit**

```bash
git add director-client.js
git commit -m "feat(director-client): Anthropic tool_use provider implementation"
```

### Task 3.3: OpenAI provider — response_format json_schema

**Files:**
- Modify: `director-client.js`

- [ ] **Step 1: Replace the `callOpenAI` stub**

```js
async function callOpenAI(input, config) {
    const t0 = performance.now();
    const userPrompt = renderUserPrompt(input);
    const body = {
        model: config.model || 'gpt-4o',
        messages: [
            { role: 'system', content: buildDirectorSystemPrompt() },
            { role: 'user', content: userPrompt },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'commit_transactions',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        transactions: { type: 'array', items: { type: 'object' } },
                        notes: { type: 'string' },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    },
                    required: ['transactions', 'notes', 'confidence'],
                },
            },
        },
    };

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        res = await fetch(OPENAI_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network',
                 raw: e.message, durationMs: performance.now() - t0 };
    }

    const text = await res.text();
    if (!res.ok) {
        const reason = res.status === 401 || res.status === 403 ? 'auth'
                     : res.status === 429 ? 'ratelimit'
                     : 'http_error';
        return { ok: false, reason, raw: `HTTP ${res.status}: ${text.slice(0, 500)}`,
                 durationMs: performance.now() - t0 };
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'invalid_json', raw: text.slice(0, 500),
                          durationMs: performance.now() - t0 }; }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        return { ok: false, reason: 'schema_mismatch', raw: 'No message.content string.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    let out;
    try { out = JSON.parse(content); }
    catch (e) { return { ok: false, reason: 'invalid_json', raw: content.slice(0, 500),
                          model: parsed.model, durationMs: performance.now() - t0 }; }

    if (!Array.isArray(out.transactions)) {
        return { ok: false, reason: 'schema_mismatch', raw: 'transactions field missing or not array.',
                 model: parsed.model, durationMs: performance.now() - t0 };
    }
    return {
        ok: true,
        transactions: out.transactions,
        notes: out.notes || '',
        confidence: out.confidence || 'medium',
        model: parsed.model,
        durationMs: performance.now() - t0,
    };
}
```

- [ ] **Step 2: node -c**

```bash
node -c director-client.js
```

- [ ] **Step 3: Commit**

```bash
git add director-client.js
git commit -m "feat(director-client): OpenAI response_format json_schema provider"
```

### Task 3.4: Renderer-shape test

**Files:**
- Modify: `scripts/test-director.js`

- [ ] **Step 1: Test the renderer outputs all sections**

Since `director-client.js` is browser-context (uses `fetch`, `performance`, `AbortController`), we can't fully exercise it from node. We *can* test the user-prompt renderer by extracting it as a standalone export.

Modify `director-client.js`: change `function renderUserPrompt(input)` → `export function renderUserPrompt(input)`.

Append test:

```js
group('renderUserPrompt', () => {
    test('renders all sections of a populated input', () => {
        const fs2 = require('fs');
        const src = fs2.readFileSync(path.resolve(__dirname, '..', 'director-client.js'), 'utf8');
        // Smoke check: the renderer mentions every key payload section.
        for (const marker of [
            'CURRENT STATE VIEW', 'RECENT LEDGER TAIL', 'RECENT TURNS',
            'USER MESSAGE THIS TURN', 'ASSISTANT RESPONSE THIS TURN',
            'PENDING CORRECTIONS', 'last turn the director call FAILED',
        ]) {
            assert(src.includes(marker), `renderer missing section marker: ${marker}`);
        }
    });
});
```

- [ ] **Step 2: Run tests**

```bash
node scripts/test-director.js
```

- [ ] **Step 3: Commit**

```bash
git add director-client.js scripts/test-director.js
git commit -m "test(director-client): renderer section presence smoke test"
```

---

## Phase 4 — Settings Drawer

Independent of seam swap. Can land in any order before Phase 5. Persists director provider/model/key in `extension_settings[MODULE_NAME]`.

### Task 4.1: Settings HTML + persistence helpers

**Files:**
- Create: `director-settings.html` (HTML fragment)
- Modify: `index.js`

- [ ] **Step 1: Create the HTML fragment**

```html
<!-- director-settings.html -->
<div class="gravity-director-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Gravity — Director</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label>Provider
        <select id="gd_provider">
          <option value="disabled">disabled</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>
      <label>Model
        <input type="text" id="gd_model" placeholder="claude-sonnet-4-6" />
      </label>
      <label>API key
        <input type="password" id="gd_api_key" />
      </label>
      <label>Recent ledger tail size
        <input type="number" id="gd_tail_size" value="20" min="0" max="100" />
      </label>
      <button id="gd_test_btn">Test director call</button>
      <div id="gd_test_result" style="margin-top:.5em;font-family:monospace;"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add persistence helpers to `index.js`**

Add near the other state declarations (after line 60):

```js
// Director config — persisted globally in extension_settings[MODULE_NAME].
function getDirectorConfig() {
    const settings = SillyTavern.getContext().extensionSettings || {};
    const ours = settings[MODULE_NAME] || {};
    return {
        provider: ours.directorProvider || 'disabled',
        model: ours.directorModel || 'claude-sonnet-4-6',
        apiKey: ours.directorApiKey || '',
        tailSize: typeof ours.directorTailSize === 'number' ? ours.directorTailSize : 20,
    };
}
function setDirectorConfig(patch) {
    const ctx = SillyTavern.getContext();
    const settings = ctx.extensionSettings || {};
    if (!settings[MODULE_NAME]) settings[MODULE_NAME] = {};
    Object.assign(settings[MODULE_NAME], patch);
    ctx.saveSettingsDebounced?.();
}
```

(NOTE: SillyTavern's settings APIs may live under different names depending on host version. Verify by reading SillyTavern's docs or grepping its public bundle for `extensionSettings` / `extension_settings` / `saveSettingsDebounced`. Adjust the helper accordingly without changing the call shape.)

- [ ] **Step 3: node -c**

```bash
node -c index.js
```

- [ ] **Step 4: Commit**

```bash
git add director-settings.html index.js
git commit -m "feat(settings): director provider/model/key persistence helpers"
```

### Task 4.2: Settings drawer registration + bind

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add drawer-mount function**

Add to `index.js`:

```js
async function mountDirectorSettings() {
    const ctx = SillyTavern.getContext();
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        console.warn(`${LOG_PREFIX} extensions_settings container not found; director settings drawer not mounted.`);
        return;
    }
    const url = new URL('director-settings.html', import.meta.url).toString();
    let html;
    try { html = await (await fetch(url)).text(); }
    catch (e) { console.warn(`${LOG_PREFIX} failed to load director-settings.html`, e); return; }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    container.appendChild(wrapper);

    const cfg = getDirectorConfig();
    const $provider = document.getElementById('gd_provider');
    const $model = document.getElementById('gd_model');
    const $key = document.getElementById('gd_api_key');
    const $tail = document.getElementById('gd_tail_size');

    $provider.value = cfg.provider;
    $model.value = cfg.model;
    $key.value = cfg.apiKey;
    $tail.value = String(cfg.tailSize);

    $provider.addEventListener('change', e => setDirectorConfig({ directorProvider: e.target.value }));
    $model.addEventListener('change', e => setDirectorConfig({ directorModel: e.target.value }));
    $key.addEventListener('change', e => setDirectorConfig({ directorApiKey: e.target.value }));
    $tail.addEventListener('change', e => setDirectorConfig({ directorTailSize: Number(e.target.value) || 20 }));
}
```

- [ ] **Step 2: Wire `mountDirectorSettings` into `initialize()`**

Find the `initialize` function (search for `async function initialize`). At an appropriate spot near the end of the initialization sequence (after panel/setup wiring), add:

```js
await mountDirectorSettings();
```

- [ ] **Step 3: node -c**

```bash
node -c index.js
```

- [ ] **Step 4: Manual smoke**

Reload SillyTavern with the extension. Open the extensions settings panel. Confirm the "Gravity — Director" drawer appears, fields persist after change + reload.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(settings): mount director settings drawer + persist on change"
```

### Task 4.3: "Test director call" button

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Wire the test button**

Inside `mountDirectorSettings`, after the field bindings, add:

```js
const $testBtn = document.getElementById('gd_test_btn');
const $testRes = document.getElementById('gd_test_result');
$testBtn.addEventListener('click', async () => {
    $testRes.textContent = 'Calling…';
    const { proposeTransactions } = await import('./director-client.js');
    const config = getDirectorConfig();
    const minimal = {
        mode: 'regular', reasonMode: 'regular', deductionType: null,
        userMessage: 'smoke test', assistantMessage: '(no prose; smoke test)',
        stateView: '(empty)', recentLedgerTail: [],
        pendingCorrections: null, recentTurns: [], lastDirectorFailed: false,
    };
    const result = await proposeTransactions(minimal, config);
    if (result.ok) {
        $testRes.textContent = `OK — model=${result.model} dt=${Math.round(result.durationMs)}ms txs=${result.transactions.length} confidence=${result.confidence}`;
    } else {
        $testRes.textContent = `FAIL (${result.reason}) — ${String(result.raw).slice(0, 200)}`;
    }
});
```

- [ ] **Step 2: node -c**

```bash
node -c index.js
```

- [ ] **Step 3: Manual smoke**

Configure provider + key, click "Test director call". Expect either OK with a model name and tx count (probably 0 — no real state) or a clean FAIL with a specific reason.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(settings): test director call button"
```

---

## Phase 5 — Seam Swap in `index.js`

The heart of the change. This phase must land before Phase 6 (preset cleanup) — until the preset is cleaned, the prose model still emits ledger blocks that the director path simply ignores. That transient overlap is fine.

### Task 5.1: Snapshot mode/reasonMode/deductionType before reset

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Replace the reset block in `onMessageReceived`**

Current (lines 1505-1514):

```js
async function onMessageReceived(messageId) {
    if (!_initialized) await initialize();
    _injectFingerprint++;
    _lastCompletedMode = _currentInjectMode;
    _currentInjectMode = 'regular';
    _currentReasonMode = 'regular';
    _pendingDeductionType = null;
    const context = SillyTavern.getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(`${MODULE_NAME}_ooc`, '', PROMPT_NONE, 0);
    }
```

Replace with:

```js
async function onMessageReceived(messageId) {
    if (!_initialized) await initialize();
    _injectFingerprint++;

    // Snap pre-reset mode fields. The director needs the snapshots
    // because the reset below would otherwise classify every
    // advance/combat/intimacy turn as `regular`.
    const snappedInjectMode = _currentInjectMode;
    const snappedReasonMode = _currentReasonMode;
    const snappedDeductionType = _pendingDeductionType;

    _lastCompletedMode = _currentInjectMode;
    _currentInjectMode = 'regular';
    _currentReasonMode = 'regular';
    _pendingDeductionType = null;
    const context = SillyTavern.getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(`${MODULE_NAME}_ooc`, '', PROMPT_NONE, 0);
    }
```

- [ ] **Step 2: node -c**

```bash
node -c index.js
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(director-seam): snap mode/reasonMode/deductionType before reset"
```

### Task 5.2: Replace `extractUpdateBlock` with director call (success path)

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add imports near the top of `index.js`**

After existing `import { extractUpdateBlock, getReinforcement, buildCorrectionInjection } from './regex-intercept.js';` (line 15), add:

```js
import { stripUpdateBlock, buildDirectorCorrectionPayload } from './regex-intercept.js';
import { buildDirectorInput } from './director-input.js';
import { proposeTransactions } from './director-client.js';
```

Also add module-state for the director-failed flag, near other flags (after line 90):

```js
let _lastDirectorFailed = false;
```

- [ ] **Step 2: Replace the extraction call**

Current (lines 1526-1552):

```js
    // Extract update block (compact STATE or canonical LEDGER)
    const extraction = extractUpdateBlock(message.mes);
    const cleanedAssistantMessage = extraction.found ? extraction.cleanedMessage : message.mes;

    // No block found
    if (!extraction.found) {
        // ...
    }

    let extractedTransactions = extraction.transactions || [];
    let duplicateChallengeCreateRewriteCount = 0;
    const extractionErrors = [...(extraction.errors || [])];

    if (extraction.format === 'state') {
        const compiled = compileStateEntries(extraction.stateEntries || [], _currentState);
        extractedTransactions = compiled.transactions;
        extractionErrors.push(...compiled.errors);
    }
```

Replace with:

```js
    // Director path replaces parser extraction.
    const cleanedAssistantMessage = stripUpdateBlock(message.mes);

    const stateViewMode = getStateViewMode(
        snappedInjectMode === 'regular',
        snappedInjectMode === 'advance',
        snappedInjectMode === 'integration',
        !!getChallengeRuntime?.(),
        snappedReasonMode,
    );
    const stateViewForDirector = formatStateView(_currentState, stateViewMode, true);

    const recentLedgerTail = getLedger().slice(-getDirectorConfig().tailSize);
    const recentTurns = (context.chat || [])
        .slice(-7) // up to 3 user+assistant pairs + the current
        .filter(m => m && m !== message)
        .map(m => ({
            user: m.is_user ? stripUpdateBlock(m.mes || '') : null,
            assistant: !m.is_user ? stripUpdateBlock(m.mes || '') : null,
        }))
        .reduce((acc, m) => {
            if (m.user) acc.push({ user: m.user, assistant: '' });
            else if (acc.length && !acc[acc.length-1].assistant) acc[acc.length-1].assistant = m.assistant;
            return acc;
        }, [])
        .slice(-3);

    const userMessage = (context.chat || []).slice().reverse().find(m => m && m.is_user)?.mes || '';

    const directorInput = buildDirectorInput({
        snappedInjectMode, snappedReasonMode, snappedDeductionType,
        userMessage,
        assistantMessage: cleanedAssistantMessage,
        stateView: stateViewForDirector,
        recentLedgerTail,
        pendingCorrections: buildDirectorCorrectionPayload(_pendingCorrections),
        recentTurns,
        lastDirectorFailed: _lastDirectorFailed,
    });

    _turnCounter++;

    const result = await proposeTransactions(directorInput, getDirectorConfig());

    let extractedTransactions = [];
    const extractionErrors = [];
    let challengeCorrection = null;

    if (!result.ok) {
        console.error(`${LOG_PREFIX} director call failed: ${result.reason} — ${String(result.raw).slice(0, 500)}`);
        _lastDirectorFailed = true;
        // Still run challenge processing on the cleaned prose.
        challengeCorrection = await processChallengeAssistantTurn(_currentState, [], cleanedAssistantMessage);
        if (challengeCorrection) {
            _pendingReinforcement = _pendingReinforcement
                ? `${_pendingReinforcement}\n${challengeCorrection}`
                : challengeCorrection;
        }
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
        return;
    }
    _lastDirectorFailed = false;
    extractedTransactions = result.transactions;
    console.log(`${LOG_PREFIX} director ok — model=${result.model} dt=${Math.round(result.durationMs)}ms txs=${extractedTransactions.length} confidence=${result.confidence}`);
```

- [ ] **Step 3: Move duplicate-challenge rewrite (already pre-validation today) — verify ordering**

Verify the existing block at lines 1554-1556 is *still* before the validateBatch loop (line 1598). It should be, since we replaced extraction-only code above. The order remains: director result → rewriteDuplicate → cleanup cap → validateBatch loop. No change needed beyond removing dead code.

Remove the now-dead `extraction.format === 'state'` branch (the parser-only state-format compile is dead under cutover).

- [ ] **Step 4: Drop the dead `if (!extraction.found)` early return**

The block at lines 1530-1542 is dead — there's no `extraction` variable anymore. Remove that block entirely.

- [ ] **Step 5: Replace the no-tx early return**

The current block at lines 1559-1570 (`if (extractedTransactions.length === 0 && extractionErrors.length === 0)`) handled "block found but empty." Under director, an empty `transactions: []` is a legit no-op. Replace with:

```js
    if (extractedTransactions.length === 0) {
        // Legit no-op outcome from director. Still process challenge state on cleaned prose.
        challengeCorrection = await processChallengeAssistantTurn(_currentState, [], cleanedAssistantMessage);
        if (challengeCorrection) {
            _pendingReinforcement = _pendingReinforcement
                ? `${_pendingReinforcement}\n${challengeCorrection}`
                : challengeCorrection;
        }
        injectPrompt();
        updatePanel(_currentState, _turnCounter);
        return;
    }
```

- [ ] **Step 6: node -c**

```bash
node -c index.js
```

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(director-seam): swap extractUpdateBlock for director call"
```

### Task 5.3: pendingCorrections rewire — drop from prose-side `_inject`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Edit the corrections injection in `injectPrompt`**

Current (lines 1234-1243):

```js
        // Corrections + reinforcement
        let injection = '';
        if (_pendingCorrections.length > 0) {
            injection = buildCorrectionInjection(_pendingCorrections) || '';
        }
        if (_pendingReinforcement) {
            injection = injection ? injection + '\n' + _pendingReinforcement : _pendingReinforcement;
        }
        _setPrompt(`${MODULE_NAME}_inject`, injection || '');
```

Replace with:

```js
        // Reinforcement (prose-side only — challenge corrections etc.).
        // _pendingCorrections no longer flows through this slot; it's
        // routed into the next director call via buildDirectorCorrectionPayload.
        _setPrompt(`${MODULE_NAME}_inject`, _pendingReinforcement || '');
```

- [ ] **Step 2: Remove `buildCorrectionInjection` from imports**

Edit line 15:

```js
import { extractUpdateBlock, getReinforcement, stripUpdateBlock, buildDirectorCorrectionPayload } from './regex-intercept.js';
```

(`buildCorrectionInjection` removed.)

- [ ] **Step 3: node -c**

```bash
node -c index.js
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(director-seam): drop pendingCorrections from prose-side _inject slot"
```

### Task 5.4: Reinforcement audience split — drop parser-compliance reinforcement

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Find `getReinforcement` call sites**

```bash
node -e "console.log(require('fs').readFileSync('index.js','utf8').split('\n').map((l,i)=>l.includes('getReinforcement')?[i+1,l]:null).filter(Boolean).map(([n,l])=>n+': '+l).join('\n'))"
```

Each call site corresponds to the no-block / empty-tx early-return paths from the parser era. After Task 5.2 most have been removed. Anything left is dead code.

- [ ] **Step 2: Delete remaining `_pendingReinforcement = getReinforcement(...)` lines**

Search for `getReinforcement(extraction` — delete the assignment line. Keep the surrounding `processChallengeAssistantTurn` calls and their `challengeCorrection` propagation into `_pendingReinforcement` — those carry the prose-side challenge recovery instructions and must be preserved.

- [ ] **Step 3: Drop `getReinforcement` from imports**

Edit line 15:

```js
import { extractUpdateBlock, stripUpdateBlock, buildDirectorCorrectionPayload } from './regex-intercept.js';
```

- [ ] **Step 4: node -c**

```bash
node -c index.js
```

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(director-seam): drop parser-compliance reinforcement; preserve challenge corrections"
```

### Task 5.5: lastDirectorFailed UI badge

**Files:**
- Modify: `ui-panel.js`
- Modify: `index.js`

- [ ] **Step 1: Add a badge slot to ui-panel**

Open `ui-panel.js`. Locate the panel render function (search for `updatePanel`). Add an element to the panel header reflecting director status. Pseudocode:

```js
// In updatePanel(state, turnCounter):
const headerStatusEl = panel.querySelector('.gravity-director-status') || (() => {
    const el = document.createElement('span');
    el.className = 'gravity-director-status';
    el.style.marginLeft = '.5em';
    panel.querySelector('.panel-header').appendChild(el);
    return el;
})();
const status = window.__gravityDirectorStatus || 'unknown';
if (status === 'failed') {
    headerStatusEl.textContent = '⚠ director failed last turn';
    headerStatusEl.style.color = '#e55';
} else if (status === 'disabled') {
    headerStatusEl.textContent = '⚠ director disabled — read-only session';
    headerStatusEl.style.color = '#fa3';
} else {
    headerStatusEl.textContent = '';
}
```

(Adjust selector for `.panel-header` to match the actual panel structure in `ui-panel.js`. If the panel has no header element, append the status element to the panel root and set `display:block; padding:.25em .5em;`.)

- [ ] **Step 2: Update the global status flag from `index.js`**

After the director result branch (Task 5.2), set:

```js
window.__gravityDirectorStatus = _lastDirectorFailed ? 'failed'
    : (getDirectorConfig().provider === 'disabled' ? 'disabled' : 'ok');
```

Place this right before each `updatePanel(...)` call in `onMessageReceived`.

- [ ] **Step 3: node -c**

```bash
node -c index.js
node -c ui-panel.js
```

- [ ] **Step 4: Manual smoke**

- With provider configured + working: panel shows no badge.
- With provider `disabled`: panel shows orange "read-only session" badge.
- With network disabled: panel shows red "director failed last turn" badge after the next turn.

- [ ] **Step 5: Commit**

```bash
git add index.js ui-panel.js
git commit -m "feat(director-seam): director status badge in panel"
```

---

## Phase 6 — Preset and Prompt Cleanup

Must land AFTER Phase 5 (director seam is live and committing). Until this phase lands, the prose model is still emitting ledger blocks that director simply ignores — bloated but harmless.

### Task 6.1: Remove `_readme` prompt slot

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Delete the `_readme` slot population**

Lines 1204-1206:

```js
        // Format readme — core on regular/advance, full on integration
        const readme = formatReadme(isIntegration ? 'full' : 'core');
        _setPrompt(`${MODULE_NAME}_readme`, readme);
```

Delete those three lines.

- [ ] **Step 2: Remove `formatReadme` from the `state-view.js` imports**

Search for `formatReadme` in `index.js` imports. Remove from the import list.

- [ ] **Step 3: Clear any lingering `_readme` slot at startup**

In `initialize()`, where slots are cleared, add:

```js
context.setExtensionPrompt?.(`${MODULE_NAME}_readme`, '', PROMPT_NONE, 0);
```

(Idempotent cleanup so older sessions with stale slots get cleared.)

- [ ] **Step 4: node -c**

```bash
node -c index.js
```

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(preset): remove _readme prompt slot — content now lives in director-prompt"
```

### Task 6.2: Delete `formatReadme*` from `state-view.js`

**Files:**
- Modify: `state-view.js`

- [ ] **Step 1: Delete the three functions**

Delete lines 754-end of `formatReadmeFull` (whichever is last) — search for `formatReadme`, `formatReadmeCore`, `formatReadmeFull` and delete each function body.

- [ ] **Step 2: Remove from exports**

Find the `export {` block in `state-view.js`, remove `formatReadme`, `formatReadmeCore`, `formatReadmeFull`.

- [ ] **Step 3: node -c**

```bash
node -c state-view.js
```

- [ ] **Step 4: Verify nothing else imports them**

```bash
node -e "const fs=require('fs');for (const f of ['index.js','regex-intercept.js','consistency.js','ledger-store.js','snapshot-mgr.js','state-compute.js','state-machine.js','ui-panel.js','ooc-handler.js','setup-wizard.js']) { if (fs.readFileSync(f,'utf8').includes('formatReadme')) console.log('STILL REFERENCED:',f); }"
```

Expected: no output. If a file still references `formatReadme`, fix that import and re-run.

- [ ] **Step 5: Commit**

```bash
git add state-view.js
git commit -m "feat(state-view): delete formatReadme* — content migrated to director-prompt"
```

### Task 6.3: gravity_v15.json — disable "Gravity - Anchor" rules that mandate ledger emission

**Files:**
- Modify: `gravity_v15.json`

- [ ] **Step 1: Locate the entry**

The "| Gravity - Anchor" entry begins around line 580. Find it by `name: "| Gravity - Anchor"`.

- [ ] **Step 2: Rewrite the `content` field**

Remove rule 5 ("STATE BLOCK EVERY NORMAL TURN") and the entire "Turn Sequence" section that mandates `---STATE---` / `---LEDGER---` emission. Renumber remaining rules. The director now owns ledger emission, so this preset entry only needs to carry prose-side directives. Surgically: delete the substring matching:

- "5. STATE BLOCK EVERY NORMAL TURN. ..." through the end of that paragraph
- "### Turn Sequence ... full ---LEDGER--- block." (the entire turn-sequence block)
- The "What Not To Do" bullet referencing `---STATE---` / `---LEDGER---` block timestamps

Rewritten content should preserve rules 1-4 (Gravity advocacy, bound by logic, one beat per turn, honor active CoT) and rules 6-10 (read state, constraint evidence, story identity, collisions activate cast, persist material change), with renumbering 5→4 etc. as needed.

- [ ] **Step 3: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"
```

Expected: no error.

- [ ] **Step 4: Commit**

```bash
git add gravity_v15.json
git commit -m "feat(preset): strip ledger-emit rules from Gravity Anchor entry"
```

### Task 6.4: gravity_v15.json — disable "L4 - Phase 2 Commands" entry

**Files:**
- Modify: `gravity_v15.json`

- [ ] **Step 1: Locate the entry**

Search for `"name": "| L4 - Phase 2 Commands"` (around line 594).

- [ ] **Step 2: Set `enabled: false`**

Change `"enabled": true` to `"enabled": false` for that entry. Do not delete — leaving it disabled makes rollback trivial if the experiment is killed.

- [ ] **Step 3: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"
```

- [ ] **Step 4: Commit**

```bash
git add gravity_v15.json
git commit -m "feat(preset): disable L4 Phase 2 Commands entry — content owned by director-prompt"
```

### Task 6.5: gravity_v15.json — audit remaining ledger-emit references

**Files:**
- Modify: `gravity_v15.json` (only if findings)

- [ ] **Step 1: Grep for ledger-emit references**

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'));(j.prompts||j.entries||[]).forEach((e,i)=>{const c=String(e.content||'');if(c.includes('---STATE---')||c.includes('---LEDGER---')||c.match(/STATE\\s+BLOCK/i)||c.match(/LEDGER\\s+BLOCK/i))console.log('HIT',i,e.name,'enabled='+e.enabled);});"
```

- [ ] **Step 2: For each hit, decide**

- If the entry is already `enabled: false`: leave it (dead).
- If enabled and refers to ledger emission as something the prose model does: disable it OR rewrite the references out (whichever is cheaper).
- If enabled but only mentions ledger blocks descriptively (e.g., "Gravity tracks state via collisions"): leave it.

- [ ] **Step 3: Validate JSON, commit any fixes**

```bash
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"
git add gravity_v15.json
git commit -m "feat(preset): audit and disable remaining ledger-emit references"
```

(If no fixes needed, skip the commit and note the audit was clean.)

---

## Phase 7 — Disabled-Mode Banner

Light task — covered partly in Task 5.5 (the badge). This phase formalizes the user-facing banner for hard-off state.

### Task 7.1: Disabled-mode panel banner

**Files:**
- Modify: `ui-panel.js`

- [ ] **Step 1: Add a banner element**

In the panel render path, when `window.__gravityDirectorStatus === 'disabled'`, render a prominent banner above the entity registry:

```js
const bannerEl = panel.querySelector('.gravity-disabled-banner') || (() => {
    const el = document.createElement('div');
    el.className = 'gravity-disabled-banner';
    el.style.cssText = 'background:#fa3;color:#000;padding:.5em;font-weight:bold;text-align:center;';
    panel.insertBefore(el, panel.firstChild);
    return el;
})();
if (window.__gravityDirectorStatus === 'disabled') {
    bannerEl.textContent = 'Director not configured — Gravity is read-only this session. No structural updates are being committed.';
    bannerEl.style.display = 'block';
} else {
    bannerEl.style.display = 'none';
}
```

- [ ] **Step 2: node -c**

```bash
node -c ui-panel.js
```

- [ ] **Step 3: Manual smoke**

Set provider to `disabled` in settings → reload → confirm the orange banner appears at the top of the Gravity panel.

- [ ] **Step 4: Commit**

```bash
git add ui-panel.js
git commit -m "feat(ui-panel): disabled-mode banner"
```

---

## Phase 8 — Documentation

### Task 8.1: Update `Documentation/system_architecture_reference.md`

**Files:**
- Modify: `Documentation/system_architecture_reference.md`

- [ ] **Step 1: Add director files to the architecture map**

Find the "Active Architecture Split" or equivalent module list. Add:

```markdown
- **Director call (post-prose, replaces parser path)**: `director-client.js`, `director-prompt.js`, `director-input.js`
```

- [ ] **Step 2: Add to maintenance checklist**

Find the cross-system update checklist. Add an entry along the lines of:

```markdown
- [ ] When op vocabulary, entity types, state-machine rules, or field contracts change, update `director-prompt.js` alongside `consistency.js`, `state-machine.js`, `state-view.js`, and the operator-facing readmes. **director-prompt.js is a doc-drift hotspot** — failure to update it lets the director propose ops the validators reject, surfacing as elevated rejection counts.
```

- [ ] **Step 3: Commit**

```bash
git add Documentation/system_architecture_reference.md
git commit -m "docs(architecture): add director modules to checklist + flag director-prompt as doc-drift hotspot"
```

### Task 8.2: Update `Documentation/project_memory.md` and `CLAUDE.md`

**Files:**
- Modify: `Documentation/project_memory.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a project_memory entry**

Append a "Director architecture (2026-04-25)" section noting:
- The director-call architecture is live.
- `formatReadme()` content has migrated to `director-prompt.js`.
- `_readme` injection slot is removed.
- `_pendingCorrections` no longer flows to prose-side `_inject` — it routes to next director call.
- Disabled-mode is hard off (banner + no commits).

- [ ] **Step 2: Update `CLAUDE.md` injection-slots list**

Find the "Injection Modes" / "Injection slots" section. Remove the `_readme` bullet. Add a brief note:

```markdown
- The director (configured via extensions settings) owns ledger emission. The prose model writes prose only. See `docs/superpowers/specs/2026-04-25-gravity-director-design.md` and `director-prompt.js`.
```

- [ ] **Step 3: Commit**

```bash
git add Documentation/project_memory.md CLAUDE.md
git commit -m "docs: note director architecture in project memory + CLAUDE.md"
```

---

## Phase 9 — Acceptance Smoke

### Task 9.1: End-to-end smoke across turn modes

**Files:** none (manual exercise)

- [ ] **Step 1: Regular turn smoke**

Open a configured chat. Set provider to Anthropic with a valid key. Take 5 regular prose turns. Watch the console for `[GravityLedger] director ok ...` lines. Confirm the panel updates reflect committed transactions. Confirm no `---STATE---` / `---LEDGER---` blocks appear in the rendered prose.

- [ ] **Step 2: Advance turn smoke**

Click "Advance". Take an advance turn. Confirm director sees `mode: advance`. Verify timeskip + collision-tick behavior matches expectations.

- [ ] **Step 3: Combat turn smoke**

Trigger a combat session. Take 3 combat beats. Confirm director sees `mode: regular, deductionType: combat` (or whichever submode flag is correct). Verify combat ledger updates land.

- [ ] **Step 4: Intimacy turn smoke**

Trigger an intimacy turn. Same checks.

- [ ] **Step 5: Document findings**

Append observations to `docs/superpowers/plans/2026-04-25-baseline-metrics.md` under a new "Director smoke" heading. Note any regressions vs baseline.

- [ ] **Step 6: Commit observations**

```bash
git add docs/superpowers/plans/2026-04-25-baseline-metrics.md
git commit -m "docs: director smoke observations"
```

### Task 9.2: Director-failure smoke

**Files:** none

- [ ] **Step 1: Disable network or use a bad key**

Set the API key to garbage. Take a turn.

- [ ] **Step 2: Verify failure UX**

- Console shows `director call failed: auth ...`.
- Panel shows red "director failed last turn" badge.
- No new transactions committed.
- Challenge processing still ran (e.g., if a challenge was active, recovery instructions appear in `_pendingReinforcement` and inject on next turn).
- Restore the key. Take next turn. Director input includes `lastDirectorFailed: true` (verify by adding a one-time `console.log` of `directorInput.lastDirectorFailed` if needed — remove after).

- [ ] **Step 3: Document, commit**

Append to baseline-metrics doc.

```bash
git add docs/superpowers/plans/2026-04-25-baseline-metrics.md
git commit -m "docs: director-failure smoke observations"
```

### Task 9.3: Comparison to parser baseline

**Files:** Modify `docs/superpowers/plans/2026-04-25-baseline-metrics.md`

- [ ] **Step 1: Replay the same N turns from baseline capture under director**

Use the same chat exports + turn ranges from Task 0.1. Re-run with director enabled.

- [ ] **Step 2: Capture per-turn metrics**

Same instrumentation pattern as Task 0.1, but log director result fields:

```js
console.log(`[DIRECTOR] turn=${_turnCounter} mode=${snappedInjectMode} txs=${result.transactions?.length || 0} confidence=${result.confidence} dt_ms=${Math.round(result.durationMs || 0)}`);
```

- [ ] **Step 3: Build comparison table**

Append to the baseline doc:

```markdown
## Director vs parser comparison

| Metric | Parser baseline | Director | Δ |
|---|---|---|---|
| Avg committed txs / turn | | | |
| Avg rejected txs / turn | | | |
| % turns missed updates (subjective) | | | |
| Latency p50 (ms) | | | |
| Latency p95 (ms) | | | |
| Cost / 100 turns ($) | n/a | | |
```

- [ ] **Step 4: Decision**

Per spec §11 acceptance bar:
- If 2+ of "missed updates / rejected / latency" regress → write a "Kill" recommendation in the doc and stop.
- Otherwise → write an "Accept" recommendation with notes.

- [ ] **Step 5: Commit and remove instrumentation**

```bash
node -c index.js
git add docs/superpowers/plans/2026-04-25-baseline-metrics.md
git commit -m "docs: director vs parser comparison + decision"
```

---

## Self-Review Checklist (run after plan execution)

- [ ] All node-testable helpers (`stripUpdateBlock`, `buildDirectorCorrectionPayload`, `buildDirectorInput`, director-prompt content presence, director-client renderer presence) pass `node scripts/test-director.js`.
- [ ] All modified `.js` files pass `node -c <file>`.
- [ ] `gravity_v15.json` parses cleanly.
- [ ] No file imports `formatReadme*` (Task 6.2 step 4).
- [ ] No file imports `getReinforcement` from `regex-intercept.js` other than for migration tools/debug.
- [ ] No file imports `buildCorrectionInjection` from `regex-intercept.js` (replaced by `buildDirectorCorrectionPayload`).
- [ ] `_readme` slot is no longer set in `injectPrompt` (Task 6.1).
- [ ] `_pendingCorrections` no longer renders into prose-side `_inject` (Task 5.3).
- [ ] `_pendingReinforcement` still receives `processChallengeAssistantTurn` output (Task 5.2 + 5.4).
- [ ] Mode/reasonMode/deductionType are snapped before reset in `onMessageReceived` (Task 5.1).
- [ ] `rewriteDuplicateActiveChallengeCreate` still runs *before* `validateBatch` loop (Task 5.2 step 3).
- [ ] Settings drawer renders, persists, and the test button works (Tasks 4.2, 4.3).
- [ ] Disabled-mode banner + director-failed badge surface correctly (Tasks 5.5, 7.1).
- [ ] Documentation reflects new architecture (Tasks 8.1, 8.2).
- [ ] Acceptance comparison vs baseline written (Task 9.3) and decision recorded.
