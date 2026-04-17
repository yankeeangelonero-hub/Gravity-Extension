# Ledger Scope Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe Gravity Ledger as a pure collision engine + character tracker. Remove the story-summary subsystem (ST's built-in memory extensions own that). Restructure the few fields responsible for most per-turn token bloat (knowledge_asymmetry, reads, collision narrative, combat container) so updates become atomic rather than paragraph rewrites.

**Architecture:** Eight sequential tasks, each commits a self-contained change. Order matters because some tasks remove scaffolding others depend on (e.g. Task 1 deletes auto-summary before Task 4 restructures knowledge fields).

1. **Drop story-summary subsystem** (`summary` entity, `story_summary`, `pc.timeline`, memory-tier, TIMELINE injection, UI story-summary tab, OOC `consolidate`/`archive`/`timeline` commands)
2. **Drop `doing` field** (pc + char) — chat context covers it
3. **Drop `pc.condition` and `collision.last_manifestation`** — scene+prose cover them
4. **Restructure `knowledge_asymmetry`** → four maps (`knows` / `unknown` / `hiding` / `misreading`)
5. **Restructure faction intel** → consolidate `intel_on` / `false_beliefs` / `blindspots` into `intel_on.<subject>.{knows,unknown,hiding,misreading}`
6. **Restructure `reads.<target>`** → engine-capped append log (LLM syntax unchanged; engine appends + caps to 5)
7. **Thin combat entity** to engine stats only (status, exchange, primary_enemy, outcome, aftermath)
8. **Simplify nudge prompt** (drop "State is your COMPLETE memory" + knowledge-firewall duplication)

**Tech Stack:** Pure JS ES modules, no build step, no test harness. Validation per task is `node -c` syntax check + manual QA in SillyTavern against the `Test/Arcueid Brunestud` chat fixture. Commits use conventional style matching recent history (`feat(state-view):`, `fix(ui):`, etc.).

**Companion-extension note:** After this refactor, Gravity requires a separate ST memory extension (Summarize, Vectors, ChromaDB, or similar) for narrative recall. Document this in CLAUDE.md as part of Task 1.

**Reference fixture:** `Test/Arcueid Brunestud - 2026-04-17@17h10m47s297ms.jsonl` — 148-tx Arcueid scenario covering setup → combat → resolution → chapter-closing. Every task's manual QA step should load this chat in ST and verify no regression.

---

## Task 1: Drop Story-Summary Subsystem

**Rationale:** `summary` entity, `story_summary` array, `pc.timeline` array, auto-summary generation, memory-tier hot/cold rotation, TIMELINE injection, OOC `consolidate`/`archive`/`timeline` handlers, and the UI Story Summary section all serve a narrative-recap role that SillyTavern's built-in memory extensions already handle. Removing them eliminates ~900 tokens/turn of bloat (readme TIMELINE guidance + live state-view TIMELINE block + auto-summary transactions that duplicate state).

**Files:**
- Modify: `state-compute.js` — remove story_summary init/normalization/entity handling
- Modify: `state-view.js` — remove TIMELINE section, remove summary+ guidance in both readmes
- Modify: `index.js` — remove `buildAutoSummary`, auto-summary commit block, memory-tier rotation calls
- Modify: `ui-panel.js` — remove Story Summary tab section, PC timeline section, story_summary diff tracking
- Modify: `ooc-handler.js` — remove `consolidate`/`archive`/`timeline` handlers, drop story_summary from eval/power-evidence
- Delete: `memory-tier.js` — no longer imported anywhere after this task
- Modify: `CLAUDE.md` — document that Gravity now requires a companion memory extension
- Modify: `gravity_v14.json`, `gravity_v13_c.json` — remove any `summary+` guidance in preset system prompt (post-validation: keep if already absent)

### Task 1 Steps

- [ ] **Step 1.1: Remove memory-tier imports and callers from `index.js`**

Find and remove:
- The import line referencing `./memory-tier.js` at the top of `index.js`
- The `checkAndRotate(_currentState)` call and its consolidation-prompt block in the post-commit path (around `index.js:1828-1834`)
- The `checkArraySizes` entries for `timeline` and story-related arrays (around `index.js:1569-1573`)

```javascript
// Before (in ARRAY_SIZE_LIMITS):
const ARRAY_SIZE_LIMITS = {
    pressure_points: { path: s => s.world?.pressure_points, label: 'PRESSURE_POINTS', cap: 15 },
    demonstrated_traits: { path: s => s.pc?.demonstrated_traits, label: 'PC TRAITS', cap: 20 },
    timeline: { path: s => s.pc?.timeline, label: 'PC TIMELINE', cap: 30 },
};

// After:
const ARRAY_SIZE_LIMITS = {
    pressure_points: { path: s => s.world?.pressure_points, label: 'PRESSURE_POINTS', cap: 15 },
    demonstrated_traits: { path: s => s.pc?.demonstrated_traits, label: 'PC TRAITS', cap: 20 },
};
```

- [ ] **Step 1.2: Remove `buildAutoSummary` function and its caller from `index.js`**

Delete the entire `buildAutoSummary` function (`index.js:940-975`) and the auto-summary commit block (`index.js:1808-1823`).

The auto-summary block to remove:
```javascript
// ── Auto-summary — mechanical delta replaces LLM-generated summary+ ──────
if (committedTxns.length > 0) {
    const llmWroteSummary = committedTxns.some(tx => tx.e === 'summary' && tx.op === 'A');
    if (!llmWroteSummary) {
        const autoSummary = buildAutoSummary(committedTxns);
        if (autoSummary) {
            try {
                await append([{ op: 'A', e: 'summary', id: '', d: { f: '', v: autoSummary }, r: 'system:auto-summary' }]);
                _currentState = computeCurrentState();
            } catch (err) {
                console.warn(`${LOG_PREFIX} Auto-summary commit failed:`, err);
            }
        }
    }
}
```

Also remove the `summary+` rendering branch from `formatCommittedTxnsHtml` (`index.js:995-997`):
```javascript
// Before:
} else if (tx.op === 'A') {
    if (tx.e === 'summary') {
        lines.push(`summary+ "${String(value).length > 80 ? String(value).slice(0, 80) + '…' : value}"`);
    } else if (field) {
        lines.push(`${entityRef}.${field}+ "${value}"`);
    }
}

// After:
} else if (tx.op === 'A') {
    if (field) {
        lines.push(`${entityRef}.${field}+ "${value}"`);
    }
}
```

Remove the `summary` branch from `getStateTarget` (`index.js:1023`):
```javascript
// Before:
if (entityType === 'summary') return state.story_summary || null;

// After: (delete the line)
```

- [ ] **Step 1.3: Remove story_summary from `state-compute.js`**

In `createEmptyState` (around `state-compute.js:73`):
```javascript
// Before:
story_summary: [],  // append-only: [{ text, timestamp, chapter }]
lastTxId: -1,

// After: (delete the story_summary line)
lastTxId: -1,
```

Also delete the JSDoc `@property {Array} story_summary` line above (`state-compute.js:19`).

In `getCollectionName` (around `state-compute.js:115-128`), remove the summary mapping:
```javascript
// Before:
const map = {
    char: 'characters',
    constraint: 'constraints',
    collision: 'collisions',
    combat: 'combats',
    chapter: 'chapters',
    faction: 'factions',
    world: 'world',
    pc: 'pc',
    divination: 'divination',
    summary: 'story_summary',
};

// After:
const map = {
    char: 'characters',
    constraint: 'constraints',
    collision: 'collisions',
    combat: 'combats',
    chapter: 'chapters',
    faction: 'factions',
    world: 'world',
    pc: 'pc',
    divination: 'divination',
};
```

In `applyTransaction` (around `state-compute.js:188-205`), remove the `isSummary` branch entirely:
```javascript
// Before:
function applyTransaction(state, tx) {
    const collection = getCollectionName(tx.e);
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);
    const isSummary = tx.e === 'summary';

    if (isSummary && tx.op === 'A') {
        state.story_summary.push({ ... });
        state.lastTxId = tx.tx;
        return state;
    }

    switch (tx.op) { ... }
}

// After:
function applyTransaction(state, tx) {
    const collection = getCollectionName(tx.e);
    const isSingleton = ['world', 'pc', 'divination'].includes(tx.e);

    // Silently drop legacy summary transactions on replay of old chats
    if (tx.e === 'summary') {
        state.lastTxId = tx.tx;
        return state;
    }

    switch (tx.op) { ... }
}
```

Remove the `if (!state.story_summary) state.story_summary = [];` line (around `state-compute.js:349`).

Remove `pc.timeline` init if present. Searching `state-compute.js` for `timeline` confirms there's no explicit init — it gets set lazily via APPEND. Leave replay to silently populate `pc.timeline` from legacy chats without explicit init (it's not injected anywhere after Task 1).

- [ ] **Step 1.4: Remove TIMELINE block from `state-view.js`**

Delete the entire TIMELINE section from `formatStateView` (`state-view.js:492-523`):
```javascript
// Remove:
// Timeline — mode-aware entry count
const fullTimeline = Array.isArray(state.story_summary) ? state.story_summary : [];
const { hot: hotTimeline, arcs } = getHotView('story_summary', state);
// ... through ...
lines.push(`  ${time ? time + ' ' : ''}${text}`);
}
}
```

Remove the `getHotView` import (top of `state-view.js`):
```javascript
// Before:
import { getHotView } from './memory-tier.js';

// After: (delete the line)
```

- [ ] **Step 1.5: Remove summary guidance from both readmes in `state-view.js`**

In `formatReadmeCore` (`state-view.js:552-663`), find the `summary+` line under `COMMON PATHS` and delete it:
```
// Before:
  divination.last_draw
  summary+

// After:
  divination.last_draw
```

In the DISCIPLINE block, remove the two lines referencing summaries:
```
// Remove:
  summary+ is auto-generated by the extension on regular turns. Do not write summary+ yourself on regular turns.
  On structural turns (chapter close, timeskip, consolidation): write a narrative arc summary via summary+ that synthesizes meaning, not just facts.
```

In `formatReadmeFull` (`state-view.js:669-934`):

Remove the entire `TIMELINE — the single chronological record...` section (`state-view.js:852-869`).

Remove any APPEND summary examples throughout the full readme. Specifically: search for `> APPEND summary` and delete those lines along with immediate context referencing story summaries.

Remove "APPEND — add to an array field" example line for timeline:
```
// Remove from the APPEND section:
  > APPEND pc field=timeline value="[Day 2 — 06:18] Stood between Barret's gun-arm and Tifa." -- Major action
```

- [ ] **Step 1.6: Remove OOC handlers in `ooc-handler.js`**

Remove patterns from `OOC_PATTERNS` (`ooc-handler.js:13-28`):
```javascript
// Before:
const OOC_PATTERNS = [
    { pattern: /ooc:\s*power\s+review\b/i, handler: handlePowerReview },
    // ... other power/snapshot/rollback/eval/history ...
    { pattern: /ooc:\s*timeline\s+(.+)\s+to\s+(.+)/i, handler: handleTimeline },
    { pattern: /ooc:\s*archive\b/i, handler: handleConsolidate },
    { pattern: /ooc:\s*consolidate\b/i, handler: handleConsolidate },
];

// After: remove the three story-oriented patterns (timeline, archive, consolidate)
```

Delete the `handleTimeline` and `handleConsolidate` functions entirely (search file for their definitions and delete).

In `handleEval` (`ooc-handler.js:71-118`), remove the story_summary stat line and the CONSOLIDATE cleanup instruction:
```javascript
// Remove:
lines.push(`Story summary entries: ${(state.story_summary || []).length}`);
// ... later ...
lines.push('7. CONSOLIDATE: If story_summary exceeds 30 entries, consolidate oldest batches into 3-5 sentence overviews.');
```

Renumber the remaining cleanup steps (CONTINUITY=1, STALE=2, KNOWLEDGE=3, POWER=4, PRESSURE=5, PRUNE=6, FIX=7).

In `buildPowerEvidence` (`ooc-handler.js:381-409`), remove the story_summary lines:
```javascript
// Remove:
const summaries = toArray(state.story_summary).slice(-2);
for (const summary of summaries) lines.push(`Summary: ${typeof summary === 'object' ? summary.text || '' : summary}`);
```

- [ ] **Step 1.7: Remove Story Summary and PC Timeline from `ui-panel.js`**

Remove the story_summary diff-tracking block (`ui-panel.js:504-505`):
```javascript
// Remove:
if (JSON.stringify(prev.story_summary) !== JSON.stringify(curr.story_summary)) {
    _changedKeys.add('story_summary');
}
```

Update the `hasChanges` check (`ui-panel.js:525`):
```javascript
// Before:
if (sid === 'arc') hasChanges = [..._changedKeys].some(k => k.startsWith('chapters.') || k === 'story_summary');

// After:
if (sid === 'arc') hasChanges = [..._changedKeys].some(k => k.startsWith('chapters.'));
```

Remove the PC timeline render section (`ui-panel.js:711-717`):
```javascript
// Remove:
const timeline = toArr(pc.timeline);
if (timeline.length) {
    parts.push(`<div class="gl-d-section"><b>Timeline (${timeline.length}):</b></div>`);
    const timeItems = timeline.map(t => `<div class="gl-moment">${esc(t)}</div>`);
    parts.push(collapsibleList(timeItems, 5, 'older entries'));
}
```

Remove the Story Summary tab block (`ui-panel.js:1156-1166`):
```javascript
// Remove:
// Story summary
const summary = toArr(state.story_summary);
if (summary.length) {
    parts.push(`<div class="gl-d-section"><b>Story Summary (${summary.length}):</b></div>`);
    // ...
    parts.push(collapsibleList(sumItems, 5, 'older entries'));
}
```

Update the tab's empty-state fallback accordingly (the `'<div class="gl-empty">No chapters or story data</div>'` can become `'No chapter data'`).

- [ ] **Step 1.8: Delete `memory-tier.js`**

```bash
rm "G:/My Drive/AI RPG/Gravity-Extension/memory-tier.js"
```

Verify no remaining imports:
```bash
grep -r "memory-tier" "G:/My Drive/AI RPG/Gravity-Extension/" --include="*.js"
```
Expected: no matches.

- [ ] **Step 1.9: Update `CLAUDE.md` companion-extension note**

Add to the "Architecture" section of `CLAUDE.md`, under the Three-Layer Design description, after the existing "Memory Tiering" section (which will also be removed):

Remove the existing Memory Tiering section:
```markdown
### Memory Tiering

`memory-tier.js` rotates hot arrays (`story_summary`, `pc.timeline`, `pc.demonstrated_traits`) to cold storage in `chatMetadata['gravity_cold']` when caps are exceeded. Consolidated batch summaries are injected alongside hot entries.
```

Add at the top of "Architecture":
```markdown
### Scope

Gravity is a **collision engine + character ledger**. It does NOT track narrative summary or story recap — those are the responsibility of a companion SillyTavern memory extension (Summarize, Vectors, or similar). Users running Gravity without a memory extension will lose narrative continuity beyond the ~3-5 messages of chat context.

The ledger tracks: collisions, constraints, combats, chapters, factions, PC state, and per-character dossiers (reads, knowledge_asymmetry, key_moments, intimate_history, demonstrated_traits). It does not track: story summaries, scene-by-scene timelines, or cross-chapter narrative arcs.
```

- [ ] **Step 1.10: Syntax check all modified files**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-compute.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/index.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ooc-handler.js"
```

Expected: no errors.

- [ ] **Step 1.11: Manual QA against fixture**

Load `Test/Arcueid Brunestud - 2026-04-17@17h10m47s297ms.jsonl` in SillyTavern. Verify:
- Chat loads without console errors (legacy `summary` transactions are silently dropped at replay)
- State panel renders Characters / Constraints / Collisions / Chapters / Divination tabs
- Arc tab shows chapter data but no Story Summary section
- PC dossier tab shows demonstrated_traits but no Timeline section
- State view injection (check ST console if available) does not contain a TIMELINE block

- [ ] **Step 1.12: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-compute.js state-view.js index.js ui-panel.js ooc-handler.js CLAUDE.md
git rm memory-tier.js
git commit -m "$(cat <<'EOF'
feat(scope): remove story-summary subsystem

Gravity is a collision engine + character ledger. Narrative recap is the
job of ST's built-in memory extensions. Drops: summary entity,
story_summary state, pc.timeline, memory-tier rotation, TIMELINE
injection block, UI Story Summary tab, OOC consolidate/archive/timeline
handlers. Saves ~900 tok/turn of readme + timeline + auto-summary bloat.

Legacy chats with summary transactions replay safely (silently dropped).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Drop `doing` Field

**Rationale:** `char.doing` and `pc.doing` duplicate what the LLM just wrote in visible prose. Chat context (3-5 recent messages) already carries current-action information. The dormant-character prompt and continue-generation messages have simple fallbacks.

**Files:**
- Modify: `state-view.js` — remove `doing` rendering for chars and pc
- Modify: `index.js` — update dormant prompt, continue-generation message, remove `getMatchingCharDoing`
- Modify: `ui-panel.js` — remove DOING row from char dossier
- Modify: `state-view.js` (readmes) — remove `char:id.doing` and `pc.doing` from COMMON PATHS, drop examples using doing
- Modify: `gravity_v14.json`, `gravity_v13_c.json` — remove doing references in system prompt

### Task 2 Steps

- [ ] **Step 2.1: Remove `doing` rendering from state-view char block**

In `formatStateView` character loop (`state-view.js:127`):
```javascript
// Before:
if (char.doing) lines.push(`    Doing: ${char.doing}`);
if (char.knowledge_asymmetry !== undefined) { ... }

// After: (delete the doing line)
if (char.knowledge_asymmetry !== undefined) { ... }
```

In the PC singleton block (`state-view.js:261`):
```javascript
// Before:
if (state.pc.current_scene) {
    lines.push(`    SCENE: ${state.pc.current_scene}`);
}
if (state.pc.doing) lines.push(`    Doing: ${state.pc.doing}`);

// After: (delete the doing line)
if (state.pc.current_scene) {
    lines.push(`    SCENE: ${state.pc.current_scene}`);
}
```

- [ ] **Step 2.2: Update dormant-character prompt in `index.js`**

In the dormant block (`index.js:1288-1290`):
```javascript
// Before:
if (gap >= DORMANT_THRESHOLD) {
    dormant.push(`${char.name || id} [${char.tier}] — WANT: ${char.want || '?'}, DOING: ${char.doing || '?'} — last activity ${gap} transactions ago`);
}

// After:
if (gap >= DORMANT_THRESHOLD) {
    const lastSeen = char.last_seen_at ? `, last seen ${char.last_seen_at}` : '';
    dormant.push(`${char.name || id} [${char.tier}] — WANT: ${char.want || '?'}${lastSeen} — last tx ${gap} ago`);
}
```

- [ ] **Step 2.3: Remove `getMatchingCharDoing` and its callers**

Delete the function (`index.js:918-931`):
```javascript
// Remove:
function getMatchingCharDoing(state) {
    if (!state?.pc?.name) return null;
    // ...
    return null;
}
```

Update the continue-generation reinforcement message (`index.js:1989, 2158`):
```javascript
// Before (both locations):
const doing = _currentState?.pc?.doing || getMatchingCharDoing(_currentState) || 'what they were doing';
// ...
lines.push(`BEAT 1 — PLAYER: ${pcName} continues (${doing}). Time passes.`);
// and:
insertChatMessage(`*${pcName} continues — ${doing}.*`);

// After:
// Drop the doing lookup entirely. At line 1989-1993:
lines.push(`BEAT 1 — PLAYER: ${pcName} continues the scene. Time passes.`);

// At line 2158:
insertChatMessage(`*${pcName} continues.*`);
```

Also remove the BEAT 1 comment block referring to `pc.doing` (`index.js:1976`):
```javascript
// Before:
 *   Beat 1 — PLAYER RESOLUTION (mandatory): acknowledge pc.doing + time + result

// After:
 *   Beat 1 — PLAYER RESOLUTION (mandatory): acknowledge where the PC was + time + result
```

- [ ] **Step 2.4: Remove DOING row from `ui-panel.js`**

In the character dossier renderer (`ui-panel.js:741`):
```javascript
// Before:
if (char.doing) parts.push(`<div class="gl-d-row"><b>DOING:</b> ${esc(char.doing)}${char.cost && !char.doing.includes('Cost:') ? ` | <b>Cost:</b> ${esc(char.cost)}` : ''}</div>`);

// After: (delete the line entirely)
```

Keep the `char.cost` display if it appears elsewhere; search for other references:
```bash
grep -n "char.cost" "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
```
If `char.cost` is only referenced inside this deleted line, no further change needed. Otherwise preserve external references.

Also update the faction `momentum` line that mentions "doing:" (`index.js:1264`):
```javascript
// Before:
if (f.momentum) detail += ` — doing: ${f.momentum}`;

// After:
if (f.momentum) detail += ` — ${f.momentum}`;
```

- [ ] **Step 2.5: Remove `doing` from both readmes in `state-view.js`**

In `formatReadmeCore` COMMON PATHS (`state-view.js:585-629`):
```
// Remove:
  char:id.doing
```

Also in the standard-shape example near the top of Core readme:
```
// Remove:
char:elena.doing: "steady, watchful"
```
(If absent in current code, skip.) The Core readme example block already does not list `pc.doing` — no change there. Verify by reading.

In `formatReadmeFull` CR/SET examples, remove any `field=doing` examples:
- `> SET char:tifa field=doing value="Investigating the reactor" -- New action` (`state-view.js:714`): remove.

In DISCIPLINE section, remove the line:
```
// Remove (state-view.js:646):
  Keep doing as "action | Cost: what this neglects or risks".
```

- [ ] **Step 2.6: Update preset JSONs**

Search `gravity_v14.json` and `gravity_v13_c.json` for `doing` references in the system prompt:
```bash
grep -n "doing" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json"
```

For each occurrence in the system prompt text fields, remove the doing-specific instruction while preserving surrounding context. Keep edits minimal — remove the smallest phrase that covers the doing directive. If a deduction-template block contains "update pc.doing and char:id.doing", remove those two targets from the template.

Leave `Gravity_v11.json` alone (legacy preset, not actively maintained).

- [ ] **Step 2.7: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/index.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" > /dev/null
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json" > /dev/null
```

Expected: no errors.

- [ ] **Step 2.8: Manual QA**

Load the Arcueid fixture. Send a turn. Verify:
- State-view injection no longer includes `Doing:` lines for chars or pc
- Character dossier tab in UI no longer shows DOING row
- Legacy `doing` values stored in state (from the fixture) are silently unused — no crashes
- Dormant prompt (if it fires) uses WANT + last_seen_at only

- [ ] **Step 2.9: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-view.js index.js ui-panel.js gravity_v14.json gravity_v13_c.json
git commit -m "$(cat <<'EOF'
feat(scope): drop doing field from pc and char

Chat context carries current-action info; dedicated pc.doing/char.doing
fields duplicate visible prose. Dormant prompt uses WANT + last_seen_at.
Continue-generation message simplified.

Legacy doing values in existing state are silently unused on replay.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop `pc.condition` and `collision.last_manifestation`

**Rationale:** `pc.condition` restates what prose conveys. `collision.last_manifestation` requires the LLM to write a per-turn prose restatement of how each active collision is pressing in — the scene field already carries that. Keep `char:id.condition` (off-screen state like "wounded, eyes red" is load-bearing and can't be inferred from scene) but cap it at 10-15 words via readme guidance.

**Files:**
- Modify: `state-view.js` — remove `state.pc.condition` render, remove `last_manifestation` from collision narrative
- Modify: `index.js` — remove `last_manifestation` warnings and prompts in arrival/resolution paths
- Modify: `ui-panel.js` — remove `col.last_manifestation` display, keep char.condition
- Modify: `state-view.js` (readmes) — drop `pc.condition` and `collision:id.last_manifestation` from COMMON PATHS, drop examples, add 10-15 word cap note for char.condition
- Modify: preset JSONs — remove last_manifestation directives

### Task 3 Steps

- [ ] **Step 3.1: Remove `pc.condition` from state-view**

In the PC singleton block (`state-view.js:256-258`):
```javascript
// Before:
if (state.pc.location && !state.pc.current_scene) pcSingleton += ` @ ${state.pc.location}`;
if (state.pc.condition) pcSingleton += ` [${state.pc.condition}]`;
lines.push(pcSingleton);

// After:
if (state.pc.location && !state.pc.current_scene) pcSingleton += ` @ ${state.pc.location}`;
lines.push(pcSingleton);
```

Leave `char.condition` rendering intact (`state-view.js:136-140`).

- [ ] **Step 3.2: Remove `last_manifestation` from collision narrative in state-view**

In `getCollisionNarrativeLines` (`state-view.js:28-47`):
```javascript
// Before:
function getCollisionNarrativeLines(col, options = {}) {
    const lines = [];
    const details = normalizeText(col?.details);
    const forces = getCollisionForcesText(col);
    const cost = normalizeText(col?.cost);
    const targetConstraint = normalizeText(col?.target_constraint);
    const manifestation = normalizeText(col?.last_manifestation);
    const includeForces = options.includeForces !== false;
    const includeManifestation = options.includeManifestation !== false;

    if (details) lines.push(`Thread: ${details}`);
    else if (forces) lines.push(`Forces: ${forces}`);

    if (includeForces && details && forces) lines.push(`Forces: ${forces}`);
    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);
    if (includeManifestation && manifestation) lines.push(`Now: ${manifestation}`);

    return lines;
}

// After:
function getCollisionNarrativeLines(col, options = {}) {
    const lines = [];
    const details = normalizeText(col?.details);
    const forces = getCollisionForcesText(col);
    const cost = normalizeText(col?.cost);
    const targetConstraint = normalizeText(col?.target_constraint);
    const includeForces = options.includeForces !== false;

    if (details) lines.push(`Thread: ${details}`);
    else if (forces) lines.push(`Forces: ${forces}`);

    if (includeForces && details && forces) lines.push(`Forces: ${forces}`);
    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);

    return lines;
}
```

Remove the lite-mode `last_manifestation` display in the collision registry (`state-view.js:215-218`):
```javascript
// Before:
if (isLite) {
    const manifestation = normalizeText(col?.last_manifestation);
    if (manifestation) lines.push(`    Now: ${manifestation}`);
}

// After: (delete entire if block)
```

- [ ] **Step 3.3: Remove `last_manifestation` warnings in `index.js`**

In `buildCollisionNarrativeWarnings` (around `index.js:400`):
```javascript
// Before:
warnings.push(`"${name}" is ${status} but missing last_manifestation — SET collision:${id}.last_manifestation to the concrete way this pressure is entering the scene right now.`);

// After: (delete this entire warning branch — one less per-turn injection)
```

In the collision arrival, resolution, escalation, and crash prompts (`index.js:1359, 1378, 1441, 1477, 2018, 2031`), remove the `SET collision:<id>.last_manifestation` directives:
```javascript
// Before (index.js:1359):
If the collision stays live after this beat, SET collision:${id}.last_manifestation to the concrete way it pressed into the scene.

// After: (delete this sentence)
```

Apply the same removal to the other five sites. In each case, preserve the surrounding instruction and drop only the last_manifestation sentence.

Also update the readme `last_manifestation` mentions in `formatReadmeFull` — search and remove:
```
// state-view.js:655 DISCIPLINE section:
  When a collision presses into the scene, update collision:id.last_manifestation with the concrete current expression.
```
Delete this line.

Collision-store field list in Full readme (`state-view.js:887-888`):
```
// Before:
  last_manifestation — the current concrete expression in scene reality; update it whenever the collision enters or sharpens in-scene

// After: (delete)
```

- [ ] **Step 3.4: Remove `last_manifestation` search + display in `ui-panel.js`**

Search and display sites (`ui-panel.js:939, 985`):
```javascript
// Before (search haystack):
const hay = `${col.name || ''} ${col.details || ''} ${col.forces || ''} ${col.cost || ''} ${col.last_manifestation || ''}`.toLowerCase();

// After:
const hay = `${col.name || ''} ${col.details || ''} ${col.forces || ''} ${col.cost || ''}`.toLowerCase();
```

```javascript
// Before (display):
if (col.last_manifestation) parts.push(`<div class="gl-d-detail"><b>Now:</b> ${esc(col.last_manifestation)}</div>`);

// After: (delete the line)
```

- [ ] **Step 3.5: Update readmes — drop paths, add char.condition cap note**

In `formatReadmeCore` COMMON PATHS (`state-view.js:585-629`), remove:
```
  pc.condition
  collision:id.last_manifestation
```

In `formatReadmeFull`, remove any `field=condition` SET example on pc:
```
// Remove examples like:
  > SET pc field=condition value="..."
```

Add to Core readme DISCIPLINE block:
```
  Keep char:id.condition terse — 10-15 words describing body/mind state (e.g. "wounded left hip, eyes red, drawl gone"). Scene prose carries longer description.
```

- [ ] **Step 3.6: Update preset JSONs**

```bash
grep -n "last_manifestation\|pc\.condition" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json"
```

For each match, remove the smallest phrase covering the directive. Preserve `char:id.condition` directives. Keep backward compat by leaving any field names in lists of "tracked fields" if removing would break sentence structure — prefer editing the surrounding sentence to exclude them naturally.

- [ ] **Step 3.7: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/index.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" > /dev/null
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json" > /dev/null
```

- [ ] **Step 3.8: Manual QA**

Load the Arcueid fixture. Verify:
- State-view no longer shows `[condition]` inline with PC header
- Collision detail sections no longer have `Now:` lines
- Legacy `last_manifestation` values in fixture are silently unused
- Character condition still appears in char registry for PRINCIPALs (e.g. Arcueid "Bleeding slowed by compression...")

- [ ] **Step 3.9: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-view.js index.js ui-panel.js gravity_v14.json gravity_v13_c.json
git commit -m "$(cat <<'EOF'
feat(state-view): drop pc.condition and collision.last_manifestation

Scene prose carries both. Char.condition kept (off-screen body/mind
state not derivable from scene), capped at 10-15 words per readme.

Legacy values silently unused on replay.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Restructure `knowledge_asymmetry` → Four Maps

**Rationale:** The fixture shows `char:arcueid.knowledge_asymmetry` rewritten 5 times as full ~80-word paragraphs, with ~80% overlap between versions. Restructuring into four keyed maps (`knows` / `unknown` / `hiding` / `misreading`) lets updates be atomic MAP_SET/MAP_DEL operations on specific subjects rather than paragraph rewrites.

**Backward compatibility:** On replay, if `knowledge_asymmetry` exists as a string, it's preserved as `knowledge.legacy: "<string>"` for display. New writes use the map structure.

**Files:**
- Modify: `state-compute.js` — normalize knowledge to object-of-maps; preserve legacy string as `.legacy`
- Modify: `state-view.js` — render the four maps compactly
- Modify: `state-view.js` (readmes) — teach new path syntax
- Modify: `ui-panel.js` — render new structure
- Modify: preset JSONs — update knowledge directives

### Task 4 Steps

- [ ] **Step 4.1: Update `normalizeCharacterKnowledgeAsymmetry` in `state-compute.js`**

Replace the existing normalizer (`state-compute.js:79-90`):
```javascript
// Before:
function normalizeCharacterKnowledgeAsymmetry(state) {
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;
        if (char.knowledge_asymmetry === undefined || char.knowledge_asymmetry === null) {
            char.knowledge_asymmetry = '';
        }
        if (char.last_seen_at === undefined || char.last_seen_at === null) {
            char.last_seen_at = '';
        }
    }
}

// After:
function normalizeCharacterKnowledgeAsymmetry(state) {
    for (const char of Object.values(state.characters || {})) {
        const tier = String(char?.tier || '').toUpperCase();
        if (!['KNOWN', 'TRACKED', 'PRINCIPAL'].includes(tier)) continue;

        // Migrate legacy string form to object-of-maps with legacy slot
        const legacy = char.knowledge_asymmetry;
        if (typeof legacy === 'string') {
            const trimmed = legacy.trim();
            char.knowledge_asymmetry = trimmed
                ? { knows: {}, unknown: {}, hiding: {}, misreading: {}, legacy: trimmed }
                : { knows: {}, unknown: {}, hiding: {}, misreading: {} };
        } else if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
            char.knowledge_asymmetry = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
        } else {
            // Object form — ensure all four sub-maps exist
            if (!legacy.knows || typeof legacy.knows !== 'object') legacy.knows = {};
            if (!legacy.unknown || typeof legacy.unknown !== 'object') legacy.unknown = {};
            if (!legacy.hiding || typeof legacy.hiding !== 'object') legacy.hiding = {};
            if (!legacy.misreading || typeof legacy.misreading !== 'object') legacy.misreading = {};
        }

        if (char.last_seen_at === undefined || char.last_seen_at === null) {
            char.last_seen_at = '';
        }
    }
}
```

The existing MS/MR apply logic in `applyTransaction` already handles nested paths generically — MAP_SET on `field=knowledge_asymmetry` with `key=knows.familiar` won't work because the existing MS op only supports one key level. Check `state-compute.js` MS handling and verify. If MS is flat-key-only, introduce dot-path support:

Search `applyTransaction` MS branch in `state-compute.js` and confirm it only supports `target[field][key] = value`. If so, extend it to handle dotted keys:
```javascript
// In the MS case:
case 'MS': {
    const field = tx.d.f;
    const key = tx.d.k;
    // ... existing target resolution ...
    if (!target[field] || typeof target[field] !== 'object') target[field] = {};
    // Support dotted keys for nested maps (e.g. "knows.familiar")
    if (key.includes('.')) {
        const parts = key.split('.');
        let cursor = target[field];
        for (let i = 0; i < parts.length - 1; i++) {
            if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
            cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = tx.d.v;
    } else {
        target[field][key] = tx.d.v;
    }
    // ... record history ...
}
```

Apply the same dotted-key support to MR (map delete). Read the current MS/MR implementation first and adapt precisely; do not guess the exact structure.

- [ ] **Step 4.2: Render new knowledge structure in `state-view.js`**

In the character render block (`state-view.js:128-130`):
```javascript
// Before:
if (char.knowledge_asymmetry !== undefined) {
    lines.push(`    Knowledge asymmetry: ${normalizeText(char.knowledge_asymmetry) || '(unset)'}`);
}

// After:
const ka = char.knowledge_asymmetry;
if (ka && typeof ka === 'object') {
    const sections = [];
    const renderMap = (label, obj) => {
        if (!obj || typeof obj !== 'object') return;
        const entries = Object.entries(obj).filter(([, v]) => v);
        if (entries.length === 0) return;
        sections.push(`${label}: ${entries.map(([k, v]) => `${k}=${normalizeText(v)}`).join('; ')}`);
    };
    renderMap('Knows', ka.knows);
    renderMap('Unknown', ka.unknown);
    renderMap('Hiding', ka.hiding);
    renderMap('Misreading', ka.misreading);
    if (ka.legacy) sections.push(`Legacy: ${normalizeText(ka.legacy)}`);
    if (sections.length) {
        lines.push(`    Knowledge:`);
        for (const s of sections) lines.push(`      ${s}`);
    }
} else if (typeof ka === 'string' && ka.trim()) {
    // Defensive fallback if normalization missed this entry
    lines.push(`    Knowledge: ${normalizeText(ka)}`);
}
```

- [ ] **Step 4.3: Update readmes with new knowledge syntax**

In `formatReadmeCore` standard shape example (`state-view.js:565`):
```
// Before:
char:elena.knowledge_asymmetry: "Knows the PC is armed, does not know who sent them, is hiding that she already warned the owner"

// After:
char:elena.knowledge_asymmetry.knows.pc-armed: "carrying a sidearm"
char:elena.knowledge_asymmetry.unknown.pc-sender: "does not know who sent them"
char:elena.knowledge_asymmetry.hiding.owner-warning: "already warned the owner"
```

Add a brief explainer near COMMON PATHS (`state-view.js:585-629`):
```
KNOWLEDGE ASYMMETRY — four maps per character, keyed by subject/topic:
  char:id.knowledge_asymmetry.knows.<key>       "<fact the character knows>"
  char:id.knowledge_asymmetry.unknown.<key>     "<gap they have>"
  char:id.knowledge_asymmetry.hiding.<key>      "<thing they're concealing>"
  char:id.knowledge_asymmetry.misreading.<key>  "<thing they wrongly believe>"
  Delete with "knowledge_asymmetry.knows.<key>: delete" when resolved.
```

Remove the old single-string mentions of `knowledge_asymmetry` from the discipline block (`state-view.js:647`):
```
// Before:
Keep knowledge_asymmetry current on TRACKED/PRINCIPAL characters when they are active or scene-relevant: what they know, what they do not know, what they are hiding, or what they are misreading right now.

// After:
Keep knowledge_asymmetry current on TRACKED/PRINCIPAL characters: add entries to knows/unknown/hiding/misreading as they learn, reveal, acquire gaps, or form misreadings. Delete entries when resolved.
```

In `formatReadmeFull`, similarly update `SET char:...field=knowledge_asymmetry value=...` examples to `MAP_SET char:...field=knowledge_asymmetry key=knows.<subject> value=...` form. Search:
```bash
grep -n "knowledge_asymmetry" "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
```
And update each in place.

- [ ] **Step 4.4: Update `ui-panel.js` knowledge rendering**

Replace the one-line knowledge display (`ui-panel.js:742`):
```javascript
// Before:
if (char.knowledge_asymmetry) parts.push(`<div class="gl-d-row"><b>Knowledge:</b> ${esc(char.knowledge_asymmetry)}</div>`);

// After:
const ka = char.knowledge_asymmetry;
if (ka && typeof ka === 'object') {
    const section = [];
    const renderKaMap = (label, obj) => {
        if (!obj || typeof obj !== 'object') return;
        const entries = Object.entries(obj).filter(([, v]) => v);
        if (!entries.length) return;
        const items = entries.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('');
        section.push(`<div class="gl-d-subrow"><b>${label}:</b><ul class="gl-d-kalist">${items}</ul></div>`);
    };
    renderKaMap('Knows', ka.knows);
    renderKaMap('Unknown', ka.unknown);
    renderKaMap('Hiding', ka.hiding);
    renderKaMap('Misreading', ka.misreading);
    if (ka.legacy) section.push(`<div class="gl-d-subrow"><b>Legacy:</b> ${esc(ka.legacy)}</div>`);
    if (section.length) {
        parts.push(`<div class="gl-d-row"><b>Knowledge:</b></div>${section.join('')}`);
    }
} else if (typeof ka === 'string' && ka.trim()) {
    parts.push(`<div class="gl-d-row"><b>Knowledge:</b> ${esc(ka)}</div>`);
}
```

Add a companion CSS rule to `style.css`:
```css
.gl-d-kalist { margin: 0 0 0 1em; padding: 0; list-style: disc; }
.gl-d-subrow { margin-top: 0.3em; }
```

- [ ] **Step 4.5: Update preset JSONs**

Search:
```bash
grep -n "knowledge_asymmetry" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json"
```

Replace prose-string directives with the new four-map syntax. Example patch:
```
// Before (in system prompt):
"Update char:id.knowledge_asymmetry whenever the character learns something, forms a false belief, or starts hiding something."

// After:
"Update char:id.knowledge_asymmetry.knows.<key>, .unknown.<key>, .hiding.<key>, or .misreading.<key> — one entry per discrete fact. Delete entries when resolved."
```

- [ ] **Step 4.6: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-compute.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" > /dev/null
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json" > /dev/null
```

- [ ] **Step 4.7: Manual QA**

Load the Arcueid fixture. Verify:
- Arcueid's knowledge_asymmetry string from fixture is migrated to `{ knows:{}, unknown:{}, hiding:{}, misreading:{}, legacy: "<original string>" }` — the Legacy line should appear in state-view
- New turns can emit `MAP_SET char:arcueid field=knowledge_asymmetry key=knows.apostle value="..."` and it renders under "Knows:"
- UI panel shows Legacy + any new entries under the four labels
- Deleting with `MAP_DEL char:id field=knowledge_asymmetry key=knows.<subject>` removes one entry cleanly

- [ ] **Step 4.8: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-compute.js state-view.js ui-panel.js style.css gravity_v14.json gravity_v13_c.json
git commit -m "$(cat <<'EOF'
feat(knowledge): restructure knowledge_asymmetry to four maps

Replaces prose-string field with four keyed maps: knows, unknown,
hiding, misreading. Updates are atomic MAP_SET/MAP_DEL operations on
specific subjects instead of ~80-word paragraph rewrites.

Legacy string values migrate to .legacy slot on replay, still rendered
for continuity until the LLM migrates them forward.

Adds dotted-key support to MS/MR ops for nested map addressing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Restructure Faction Intel → Four-Map Per Subject

**Rationale:** Faction intel currently lives in three parallel fields that share a single concern — what a faction knows, misbelieves, or misses about a subject:
- `faction.intel_on.<subject>` (string: current snapshot)
- `faction.false_beliefs.<subject>` (string: wrong assumption)
- `faction.blindspots` (string or map: subjects the faction is unaware of — inconsistently typed in the fixture vs `normalizeFactionIntel`)

Every update rewrites an ~40-80 word prose string for one subject (see fixture: `faction:death-apostles.intel_on.arcueid` rewritten 3x as full paragraphs, `faction:death-apostles.blindspots.autumn` rewritten 2x as full paragraphs). The semantic distinctions collapse onto the same four-map model we just adopted for characters: `knows` / `unknown` / `hiding` / `misreading`. Consolidating all three fields into `intel_on.<subject>.{knows,unknown,hiding,misreading}` (a) reuses Task 4's dotted-key MS/MR infrastructure, (b) makes updates atomic, and (c) removes two legacy fields that duplicate the asymmetry concept.

**Mapping from legacy fields:**
- `intel_on.<subject>` (prose) → `intel_on.<subject>.legacy` on migration; new writes go to `intel_on.<subject>.knows.<key>`
- `false_beliefs.<subject>` (prose) → `intel_on.<subject>.misreading.legacy` on migration
- `blindspots.<subject>` (prose) → `intel_on.<subject>.unknown.legacy` on migration
- `blindspots` (top-level prose string, if any) → preserved as `faction.blindspots_legacy` for display only

**Files:**
- Modify: `state-compute.js` — rewrite `normalizeFactionIntel` for new shape + legacy migration; rely on dotted-key MS/MR support added in Task 4
- Modify: `state-view.js` — replace the three separate render blocks with one unified intel renderer
- Modify: `state-view.js` (readmes) — update COMMON PATHS + Faction fields explainer + examples
- Modify: `ui-panel.js` — render faction intel (currently not rendered at all) in new structure
- Modify: preset JSONs — update faction intel directives

### Task 5 Steps

- [ ] **Step 5.1: Rewrite `normalizeFactionIntel` in `state-compute.js`**

Replace `state-compute.js:92-113`:
```javascript
// Before:
function normalizeFactionIntel(state) {
    for (const faction of Object.values(state.factions || {})) {
        if (faction.comms_latency === undefined || faction.comms_latency === null) faction.comms_latency = '';
        if (faction.last_verified_at === undefined || faction.last_verified_at === null) faction.last_verified_at = '';
        if (faction.intel_posture === undefined || faction.intel_posture === null) faction.intel_posture = '';
        if (faction.blindspots === undefined || faction.blindspots === null) faction.blindspots = '';
        if (!faction.intel_on || typeof faction.intel_on !== 'object' || Array.isArray(faction.intel_on)) faction.intel_on = {};
        if (!faction.false_beliefs || typeof faction.false_beliefs !== 'object' || Array.isArray(faction.false_beliefs)) faction.false_beliefs = {};
    }
}

// After:
function normalizeFactionIntel(state) {
    for (const faction of Object.values(state.factions || {})) {
        if (faction.comms_latency === undefined || faction.comms_latency === null) faction.comms_latency = '';
        if (faction.last_verified_at === undefined || faction.last_verified_at === null) faction.last_verified_at = '';
        if (faction.intel_posture === undefined || faction.intel_posture === null) faction.intel_posture = '';

        // Migrate top-level blindspots string (if any) to a display-only legacy slot,
        // then drop the field.
        if (typeof faction.blindspots === 'string') {
            const topLegacy = faction.blindspots.trim();
            if (topLegacy) faction.blindspots_legacy = topLegacy;
            delete faction.blindspots;
        }

        if (!faction.intel_on || typeof faction.intel_on !== 'object' || Array.isArray(faction.intel_on)) {
            faction.intel_on = {};
        }

        // Migrate legacy per-subject strings in intel_on to object-of-maps form.
        for (const [subject, value] of Object.entries(faction.intel_on)) {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                faction.intel_on[subject] = trimmed
                    ? { knows: {}, unknown: {}, hiding: {}, misreading: {}, legacy: trimmed }
                    : { knows: {}, unknown: {}, hiding: {}, misreading: {} };
            } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
                faction.intel_on[subject] = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
            } else {
                if (!value.knows || typeof value.knows !== 'object') value.knows = {};
                if (!value.unknown || typeof value.unknown !== 'object') value.unknown = {};
                if (!value.hiding || typeof value.hiding !== 'object') value.hiding = {};
                if (!value.misreading || typeof value.misreading !== 'object') value.misreading = {};
            }
        }

        // Migrate legacy faction.false_beliefs.<subject> (prose) into
        // intel_on.<subject>.misreading.legacy, then drop the field.
        if (faction.false_beliefs && typeof faction.false_beliefs === 'object' && !Array.isArray(faction.false_beliefs)) {
            for (const [subject, belief] of Object.entries(faction.false_beliefs)) {
                if (typeof belief !== 'string' || !belief.trim()) continue;
                if (!faction.intel_on[subject]) {
                    faction.intel_on[subject] = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
                }
                const slot = faction.intel_on[subject].misreading;
                if (slot && typeof slot === 'object' && !slot.legacy) slot.legacy = belief.trim();
            }
        }
        delete faction.false_beliefs;

        // Migrate legacy faction.blindspots.<subject> (prose map) into
        // intel_on.<subject>.unknown.legacy, then drop the field. Only handle
        // the map form here — the string form was converted to blindspots_legacy above.
        if (faction.blindspots && typeof faction.blindspots === 'object' && !Array.isArray(faction.blindspots)) {
            for (const [subject, gap] of Object.entries(faction.blindspots)) {
                if (typeof gap !== 'string' || !gap.trim()) continue;
                if (!faction.intel_on[subject]) {
                    faction.intel_on[subject] = { knows: {}, unknown: {}, hiding: {}, misreading: {} };
                }
                const slot = faction.intel_on[subject].unknown;
                if (slot && typeof slot === 'object' && !slot.legacy) slot.legacy = gap.trim();
            }
            delete faction.blindspots;
        }
    }
}
```

Task 4 added dotted-key support to MS/MR in `applyTransaction`. Confirm that support is in place before starting this task — new writes like `MAP_SET faction:death-apostles field=intel_on key=arcueid.knows.location value="..."` depend on it.

- [ ] **Step 5.2: Replace faction intel render in `state-view.js`**

Replace the three separate blocks (`state-view.js:412-428`):
```javascript
// Before:
if (f.comms_latency) lines.push(`    Comms latency: ${f.comms_latency}`);
if (f.last_verified_at) lines.push(`    Last verified at: ${f.last_verified_at}`);
if (f.intel_posture) lines.push(`    Intel posture: ${f.intel_posture}`);
if (f.blindspots) lines.push(`    Blindspots: ${f.blindspots}`);
// ...
if (f.intel_on && typeof f.intel_on === 'object' && Object.keys(f.intel_on).length) {
    lines.push('    Intel on:');
    for (const [subject, intel] of Object.entries(f.intel_on)) {
        lines.push(`      ${subject}: ${intel}`);
    }
}
if (f.false_beliefs && typeof f.false_beliefs === 'object' && Object.keys(f.false_beliefs).length) {
    lines.push('    False beliefs:');
    for (const [subject, belief] of Object.entries(f.false_beliefs)) {
        lines.push(`      ${subject}: ${belief}`);
    }
}

// After:
if (f.comms_latency) lines.push(`    Comms latency: ${f.comms_latency}`);
if (f.last_verified_at) lines.push(`    Last verified at: ${f.last_verified_at}`);
if (f.intel_posture) lines.push(`    Intel posture: ${f.intel_posture}`);
if (f.blindspots_legacy) lines.push(`    Blindspots (legacy): ${f.blindspots_legacy}`);
// Note: the standalone `if (f.intel_on ...)` and `if (f.false_beliefs ...)` blocks
// are replaced by the unified intel renderer below.
if (f.intel_on && typeof f.intel_on === 'object' && Object.keys(f.intel_on).length) {
    lines.push('    Intel on:');
    for (const [subject, intel] of Object.entries(f.intel_on)) {
        if (!intel || typeof intel !== 'object') continue;
        const sections = [];
        const renderMap = (label, obj) => {
            if (!obj || typeof obj !== 'object') return;
            const entries = Object.entries(obj).filter(([, v]) => v);
            if (entries.length === 0) return;
            sections.push(`${label}: ${entries.map(([k, v]) => `${k}=${normalizeText(v)}`).join('; ')}`);
        };
        renderMap('Knows', intel.knows);
        renderMap('Unknown', intel.unknown);
        renderMap('Hiding', intel.hiding);
        renderMap('Misreading', intel.misreading);
        if (intel.legacy) sections.push(`Legacy: ${normalizeText(intel.legacy)}`);
        if (sections.length === 0) continue;
        lines.push(`      ${subject}:`);
        for (const s of sections) lines.push(`        ${s}`);
    }
}
```

The standalone `f.false_beliefs` block gets deleted entirely — false beliefs now render under `Misreading:` inside each subject's intel block.

- [ ] **Step 5.3: Update readmes with new faction intel syntax**

In `formatReadmeCore` standard shape example (`state-view.js:567-568`):
```
// Before:
faction:zaft.intel_on.archangel: "Believes the ship escaped damaged; does not know who the Strike pilot is"
faction:zaft.false_beliefs.strike-pilot: "Assumes the pilot identity is still unconfirmed"

// After:
faction:zaft.intel_on.archangel.knows.damage: "escaped damaged from the last engagement"
faction:zaft.intel_on.archangel.unknown.pilot-identity: "does not know who the Strike pilot is"
faction:zaft.intel_on.archangel.misreading.pilot-identity: "Assumes the pilot identity is still unconfirmed"
```

In COMMON PATHS (`state-view.js:596-601`):
```
// Before:
  faction:id.comms_latency
  faction:id.last_verified_at
  faction:id.intel_posture
  faction:id.blindspots
  faction:id.intel_on.subject
  faction:id.false_beliefs.subject

// After:
  faction:id.comms_latency
  faction:id.last_verified_at
  faction:id.intel_posture
  faction:id.intel_on.subject.knows.<key>
  faction:id.intel_on.subject.unknown.<key>
  faction:id.intel_on.subject.hiding.<key>
  faction:id.intel_on.subject.misreading.<key>
```

In the `KNOWN characters inherit knowledge from their faction's intel_on and false_beliefs maps.` line (`state-view.js:648`):
```
// Before:
KNOWN characters inherit knowledge from their faction's intel_on and false_beliefs maps. Only set individual knowledge_asymmetry on a KNOWN character when they learn something their faction does not know yet.

// After:
KNOWN characters inherit knowledge from their faction's intel_on maps (knows/unknown/hiding/misreading per subject). Only set individual knowledge_asymmetry on a KNOWN character when they learn something their faction does not know yet.
```

In the remote-awareness line (`state-view.js:651`):
```
// Before:
Use faction intel fields for remote awareness: comms_latency, last_verified_at, intel_posture, blindspots, intel_on, and false_beliefs.

// After:
Use faction intel fields for remote awareness: comms_latency, last_verified_at, intel_posture, and intel_on.<subject> (four keyed maps: knows/unknown/hiding/misreading — one entry per discrete fact).
```

In `formatReadmeFull` faction examples (`state-view.js:833-834`):
```
// Before:
  > MAP_SET faction:zaft field=intel_on key=archangel value="Believes the ship escaped damaged; pilot identity still uncertain" -- Current intel snapshot
  > MAP_SET faction:zaft field=false_beliefs key=strike-pilot value="Assumes the pilot is still unknown" -- Important wrong belief

// After:
  > MAP_SET faction:zaft field=intel_on key=archangel.knows.damage value="escaped damaged from the last engagement" -- Recorded fact
  > MAP_SET faction:zaft field=intel_on key=archangel.unknown.pilot-identity value="does not know who the Strike pilot is" -- Recorded gap
  > MAP_SET faction:zaft field=intel_on key=strike-pilot.misreading.identity value="Assumes the pilot is still unknown" -- Recorded wrong belief
  > MAP_DEL faction:zaft field=intel_on key=archangel.unknown.pilot-identity -- Gap resolved
```

In the Faction fields explainer (`state-view.js:836-840`):
```
// Before:
  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances,
  comms_latency, last_verified_at, intel_posture, blindspots, intel_on (map: subject → belief snapshot),
  false_beliefs (map: subject → important wrong assumption).

// After:
  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances,
  comms_latency, last_verified_at, intel_posture,
  intel_on (map: subject → { knows, unknown, hiding, misreading } — each a keyed map of discrete facts).
  Add a discrete fact with MAP_SET on key="<subject>.<bucket>.<key>"; delete with MAP_DEL on the same path.
```

Search for any remaining mentions of `false_beliefs` or `blindspots` in readmes and remove or rewrite:
```bash
grep -n "false_beliefs\|blindspots" "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
```

- [ ] **Step 5.4: Render faction intel in `ui-panel.js`**

The existing faction block in `ui-panel.js:885-914` does not render `intel_on`, `false_beliefs`, `blindspots`, or `comms_latency`/`last_verified_at`/`intel_posture` at all. Add an intel renderer immediately before the `relations` block (before `ui-panel.js:904`):

```javascript
// Add before the relations block:
if (f.comms_latency) parts.push(`<div class="gl-d-detail">Comms latency: ${esc(f.comms_latency)}</div>`);
if (f.last_verified_at) parts.push(`<div class="gl-d-detail">Last verified at: ${esc(f.last_verified_at)}</div>`);
if (f.intel_posture) parts.push(`<div class="gl-d-detail">Intel posture: ${esc(f.intel_posture)}</div>`);
if (f.blindspots_legacy) parts.push(`<div class="gl-d-detail">Blindspots (legacy): ${esc(f.blindspots_legacy)}</div>`);
if (f.intel_on && typeof f.intel_on === 'object') {
    const subjects = Object.entries(f.intel_on);
    if (subjects.length) {
        parts.push(`<div class="gl-d-detail"><b>Intel on:</b></div>`);
        for (const [subject, intel] of subjects) {
            if (!intel || typeof intel !== 'object') continue;
            const sub = [];
            const renderMap = (label, obj) => {
                if (!obj || typeof obj !== 'object') return;
                const entries = Object.entries(obj).filter(([, v]) => v);
                if (!entries.length) return;
                const items = entries.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('');
                sub.push(`<div class="gl-d-subrow"><b>${label}:</b><ul class="gl-d-kalist">${items}</ul></div>`);
            };
            renderMap('Knows', intel.knows);
            renderMap('Unknown', intel.unknown);
            renderMap('Hiding', intel.hiding);
            renderMap('Misreading', intel.misreading);
            if (intel.legacy) sub.push(`<div class="gl-d-subrow"><b>Legacy:</b> ${esc(intel.legacy)}</div>`);
            if (!sub.length) continue;
            parts.push(`<div class="gl-d-detail" style="padding-left:1em"><b>${esc(subject)}:</b></div>`);
            for (const s of sub) parts.push(`<div style="padding-left:2em">${s}</div>`);
        }
    }
}
```

Reuse the `.gl-d-kalist` / `.gl-d-subrow` CSS added in Task 4 — no new styles needed.

- [ ] **Step 5.5: Update preset JSONs**

Search:
```bash
grep -n "intel_on\|false_beliefs\|blindspots" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json"
```

Replace prose-string directives with the new nested syntax. Example patches:
```
// Before (in system prompt):
"Update faction:id.intel_on.<subject> with the faction's current belief snapshot; use faction:id.false_beliefs.<subject> for important wrong assumptions; use faction:id.blindspots for things the faction is unaware of."

// After:
"Update faction:id.intel_on.<subject>.knows.<key>, .unknown.<key>, .hiding.<key>, or .misreading.<key> — one entry per discrete fact. Delete entries when resolved with MAP_DEL on the same path."
```

Remove any remaining `false_beliefs` or `blindspots` mentions in preset system prompts; these fields are gone.

- [ ] **Step 5.6: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-compute.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" > /dev/null
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json" > /dev/null
```

- [ ] **Step 5.7: Manual QA against the Arcueid fixture**

Load `Test/Arcueid Brunestud - 2026-04-17@17h10m47s297ms.json` in SillyTavern. The fixture contains:
- `faction:death-apostles.intel_on.arcueid` rewritten 3x (prose strings)
- `faction:death-apostles.blindspots.autumn` rewritten 2x (prose strings)
- `faction:death-apostles.blindspots.district` (prose string)

Verify:
- Each `intel_on.<subject>` migrates to `{ knows:{}, unknown:{}, hiding:{}, misreading:{}, legacy: "<final prose>" }` — the Legacy line appears under the subject in state-view and the UI panel.
- Each `blindspots.<subject>` migrates into the corresponding `intel_on.<subject>.unknown.legacy` slot.
- UI faction block now shows "Intel on:" with `arcueid:` and `autumn:` / `district:` subsections, each containing a "Legacy:" line.
- A new turn emitting `MAP_SET faction:death-apostles field=intel_on key=arcueid.knows.location value="last seen at convenience store"` renders under `arcueid:` → `Knows: location=last seen at convenience store`.
- `MAP_DEL faction:death-apostles field=intel_on key=arcueid.knows.location` cleanly removes the one entry without affecting the legacy line or other buckets.
- No stale `False beliefs:` or top-level `Blindspots:` rows appear in state-view.

- [ ] **Step 5.8: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-compute.js state-view.js ui-panel.js gravity_v14.json gravity_v13_c.json
git commit -m "$(cat <<'EOF'
feat(factions): consolidate intel_on/false_beliefs/blindspots to four-map

Unifies three parallel faction intel fields into intel_on.<subject> with
per-subject {knows,unknown,hiding,misreading} keyed maps — same model as
character knowledge_asymmetry. Atomic MAP_SET/MAP_DEL per fact replaces
prose-string rewrites.

Legacy prose values migrate to .legacy slots on replay:
- intel_on.<subject> (string) → intel_on.<subject>.legacy
- false_beliefs.<subject>     → intel_on.<subject>.misreading.legacy
- blindspots.<subject>        → intel_on.<subject>.unknown.legacy
- blindspots (top-level str)  → faction.blindspots_legacy (display-only)

Also adds faction intel rendering to the UI panel, which previously showed
none of these fields.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Engine-Capped `reads.<target>` Append Log

**Rationale:** The fixture shows `char:arcueid.reads.pc` rewritten 7 times in 10 turns, each a full ~40-60 word paragraph. Keep the LLM syntax unchanged (`MAP_SET char:id field=reads key=pc value="..."`) but have the engine treat reads specially: each write appends to a capped list of up to 5 entries per target. Evolution is preserved; churn drops from full rewrites to small appends.

**Backward compatibility:** Legacy single-string reads values migrate to one-entry arrays on replay.

**Files:**
- Modify: `state-compute.js` — intercept MS when `entity=char` and `field=reads`; append-and-cap to array
- Modify: `state-view.js` — render `reads.<target>` as chronological list (latest entry gets prominence)
- Modify: `state-view.js` (readmes) — document the append-and-cap behavior
- Modify: `ui-panel.js` — render reads as list

### Task 6 Steps

- [ ] **Step 6.1: Add reads-append logic in `state-compute.js`**

In `applyTransaction`, in the MS case, add a special branch for char.reads:
```javascript
// Before the general MS handling:
case 'MS': {
    const field = tx.d.f;
    const key = tx.d.k;
    // ... target resolution ...

    // Special: char.reads map — each key's value is an append-capped array of entries
    if (tx.e === 'char' && field === 'reads' && !key.includes('.')) {
        if (!target.reads || typeof target.reads !== 'object') target.reads = {};
        const existing = target.reads[key];
        let arr;
        if (Array.isArray(existing)) {
            arr = existing.slice();
        } else if (typeof existing === 'string' && existing.trim()) {
            arr = [existing];
        } else {
            arr = [];
        }
        const entry = {
            text: tx.d.v,
            t: tx.t || '',
            _ts: tx._ts || '',
            tx: tx.tx,
        };
        arr.push(entry);
        const CAP = 5;
        if (arr.length > CAP) arr.splice(0, arr.length - CAP);
        target.reads[key] = arr;
        recordHistory(state, tx.e, tx.id, `reads.${key}`, existing, tx.d.v, tx);
        state.lastTxId = tx.tx;
        return state;
    }

    // ... existing MS handling continues below (unchanged) ...
}
```

Read the exact existing MS implementation in `state-compute.js` first and splice the append-and-cap branch cleanly at the top of the case block.

- [ ] **Step 6.2: Render reads as list in `state-view.js`**

Where PC reputation is aggregated (`state-view.js:469-490`), adapt to handle array-of-entries:
```javascript
// Before:
const readOfPc = char.reads?.pc || char.reads?.[state.pc.name] || char.stance_toward_pc;
if (readOfPc) pcReputation.push({ who: char.name || char.id, read: readOfPc });

// After:
const readRaw = char.reads?.pc || char.reads?.[state.pc.name] || char.stance_toward_pc;
let readOfPc = '';
if (Array.isArray(readRaw)) {
    const latest = readRaw[readRaw.length - 1];
    readOfPc = typeof latest === 'object' ? latest.text : String(latest || '');
} else {
    readOfPc = readRaw || '';
}
if (readOfPc) pcReputation.push({ who: char.name || char.id, read: readOfPc, history: Array.isArray(readRaw) ? readRaw.slice(0, -1) : [] });
```

In the rendering:
```javascript
// Before:
if (pcReputation.length) {
    lines.push(`  How others see PC:`);
    for (const { who, read } of pcReputation) {
        lines.push(`    ${who}: ${read}`);
    }
}

// After:
if (pcReputation.length) {
    lines.push(`  How others see PC:`);
    for (const { who, read, history } of pcReputation) {
        lines.push(`    ${who}: ${read}`);
        if (showFullDetail && history && history.length) {
            for (const h of history.slice(-2)) {
                const text = typeof h === 'object' ? h.text : String(h);
                const t = typeof h === 'object' && h.t ? h.t + ' ' : '';
                lines.push(`      prior: ${t}${text}`);
            }
        }
    }
}
```

Also update the factions stance rendering where `(f.reads && f.reads.pc)` is used (`state-view.js:295, 403`). Adapt to extract the latest entry text if it's an array:
```javascript
// Helper — add near top of state-view.js:
function latestReadText(reads, key) {
    const raw = reads?.[key];
    if (Array.isArray(raw)) {
        const latest = raw[raw.length - 1];
        return typeof latest === 'object' ? (latest?.text || '') : String(latest || '');
    }
    return typeof raw === 'string' ? raw : '';
}

// Then replace call sites:
const fStance = latestReadText(f.reads, 'pc') || f.stance_toward_pc || '?';
// and
const factionStance = latestReadText(f.reads, 'pc') || f.stance_toward_pc || '?';
```

- [ ] **Step 6.3: Update readmes**

In `formatReadmeCore`, under `char:elena.reads.pc:` line, add a note:
```
// Before:
char:elena.reads.pc: "Cautious ally"

// After:
char:elena.reads.pc: "Cautious ally"   # appends to a capped 5-entry log; older reads preserved for evolution
```

In `formatReadmeFull` under MAP_SET examples for reads, add the same note.

- [ ] **Step 6.4: Update `ui-panel.js` reads display**

In the char dossier reads block (`ui-panel.js:792-795`):
```javascript
// Before:
const reads = toObj(char.reads);
if (typeof char.reads === 'string') {
    // ...legacy handling...
    parts.push(`<div class="gl-d-row">${esc(char.reads)}</div>`);
}

// After:
const readsObj = toObj(char.reads);
if (typeof char.reads === 'string') {
    parts.push(`<div class="gl-d-row">${esc(char.reads)}</div>`);
} else if (readsObj && Object.keys(readsObj).length) {
    for (const [target, entries] of Object.entries(readsObj)) {
        if (Array.isArray(entries) && entries.length) {
            const items = entries.map(e => {
                const text = typeof e === 'object' ? e.text : String(e);
                const t = typeof e === 'object' && e.t ? ` <span class="gl-history-time">[${esc(e.t)}]</span>` : '';
                return `<li>${esc(text)}${t}</li>`;
            }).join('');
            parts.push(`<div class="gl-d-subrow"><b>Reads ${esc(target)}:</b><ul class="gl-d-readlist">${items}</ul></div>`);
        } else if (typeof entries === 'string' && entries.trim()) {
            parts.push(`<div class="gl-d-subrow"><b>Reads ${esc(target)}:</b> ${esc(entries)}</div>`);
        }
    }
}
```

Also update the `stanceTowardPc` extraction nearby (`ui-panel.js:744`):
```javascript
// Before:
const stanceTowardPc = (char.reads?.pc) || char.stance_toward_pc;

// After:
const stanceRaw = char.reads?.pc;
let stanceTowardPc = '';
if (Array.isArray(stanceRaw)) {
    const latest = stanceRaw[stanceRaw.length - 1];
    stanceTowardPc = typeof latest === 'object' ? latest.text : String(latest || '');
} else {
    stanceTowardPc = stanceRaw || char.stance_toward_pc || '';
}
```

Add CSS:
```css
.gl-d-readlist { margin: 0 0 0 1em; padding: 0; list-style: disc; }
```

- [ ] **Step 6.5: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-compute.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
```

- [ ] **Step 6.6: Manual QA**

Load the Arcueid fixture. Verify:
- Arcueid's 7 reads.pc rewrites in the fixture migrate on replay: the latest entry becomes visible, older entries are preserved in the history array (check UI panel shows them)
- State-view shows the latest read under "How others see PC"
- Full mode shows prior reads
- New turn emitting `MAP_SET char:arcueid field=reads key=pc value="..."` appends rather than overwrites
- After 5+ new reads, the array caps at 5

- [ ] **Step 6.7: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-compute.js state-view.js ui-panel.js style.css
git commit -m "$(cat <<'EOF'
feat(reads): engine-capped append log for char.reads.<target>

LLM syntax unchanged (MAP_SET field=reads key=<target> value=...); engine
now appends each write to a capped 5-entry array per target with
timestamps, instead of overwriting. Evolution of a read over time is
preserved without bloating state or requiring bespoke ops.

Legacy string reads migrate to one-entry arrays on replay.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Thin Combat Entity to Engine Stats

**Rationale:** The fixture shows combat-mo31x82z (tx 96-143) carry ~500 tokens of LLM-authored terrain/situation/threat/participants/hostiles prose for ~3 turns before destruction. Those fields duplicate the scene and the spawning collision. Combat becomes an engine-managed tick counter: status (ACTIVE/RESOLVED), exchange (int), primary_enemy (char:id or collision:id ref), opened_from (collision id), outcome (one line on RESOLVED), aftermath (one line).

**Files:**
- Modify: `state-view.js` — slim combat render in both registry and detail
- Modify: `state-view.js` (readmes) — drop participants/hostiles/terrain/situation/threat from CREATE/SET guidance; keep outcome/aftermath
- Modify: `index.js` — ensure challenge-state auto-seeded combats use thin shape; drop deduction-template guidance that inflates combat fields
- Modify: `ui-panel.js` — slim combat render
- Modify: `consistency.js` — if it enforces combat fields, relax
- Modify: preset JSONs — drop fat combat directives from deduction template
- No changes to: `combat-state.js`, `challenge-state.js` (engine internals are already thin; the bloat was LLM-authored prose fields)

### Task 7 Steps

- [ ] **Step 7.1: Audit existing combat handling**

Read:
```bash
grep -n "terrain\|situation\|threat\|hostiles\|participants\|primary_enemy" "G:/My Drive/AI RPG/Gravity-Extension/combat-state.js" "G:/My Drive/AI RPG/Gravity-Extension/challenge-state.js" "G:/My Drive/AI RPG/Gravity-Extension/challenge-profile-combat.js"
```

List every site that sets or reads those fields. Preserve any engine-internal uses; target only the LLM-facing prose guidance.

- [ ] **Step 7.2: Slim combat render in `state-view.js`**

Combat registry block (`state-view.js:223-236`):
```javascript
// Before:
for (const combat of activeCombats) {
    let combatLine = `  ${combat.name || combat.id} [${combat.status || 'ACTIVE'}]`;
    if (combat.exchange != null) combatLine += ` exch:${combat.exchange}`;
    combatLine += ` → id: ${combat.id}`;
    lines.push(combatLine);
    if (combat.primary_enemy) lines.push(`    Primary enemy: ${typeof combat.primary_enemy === 'object' ? combat.primary_enemy.name || combat.primary_enemy.id || '?' : combat.primary_enemy}`);
    if (combat.situation) lines.push(`    Situation: ${combat.situation}`);
    if (combat.terrain) lines.push(`    Terrain: ${combat.terrain}`);
}

// After:
for (const combat of activeCombats) {
    let combatLine = `  ${combat.name || combat.id} [${combat.status || 'ACTIVE'}]`;
    if (combat.exchange != null) combatLine += ` exch:${combat.exchange}`;
    if (combat.primary_enemy) {
        const pe = typeof combat.primary_enemy === 'object' ? (combat.primary_enemy.name || combat.primary_enemy.id || '?') : combat.primary_enemy;
        combatLine += ` vs ${pe}`;
    }
    if (combat.opened_from) combatLine += ` (from collision:${combat.opened_from})`;
    combatLine += ` → id: ${combat.id}`;
    lines.push(combatLine);
}
```

Combat detail block (`state-view.js:372-391`):
```javascript
// Before:
if (showPower && activeCombats.length) {
    lines.push('');
    lines.push('COMBATS');
    for (const combat of activeCombats) {
        lines.push(`  ⚔ ${combat.name || combat.id} [${combat.status || 'ACTIVE'}] exch:${combat.exchange || '?'} → id: ${combat.id}`);
        if (combat.participants) { ... }
        if (combat.hostiles) { ... }
        if (combat.primary_enemy) { ... }
        if (combat.situation) lines.push(`    Situation: ${combat.situation}`);
        if (combat.terrain) lines.push(`    Terrain: ${combat.terrain}`);
        if (combat.threat) lines.push(`    Threat: ${combat.threat}`);
    }
}

// After:
if (showPower && activeCombats.length) {
    lines.push('');
    lines.push('COMBATS');
    for (const combat of activeCombats) {
        lines.push(`  ⚔ ${combat.name || combat.id} [${combat.status || 'ACTIVE'}] exch:${combat.exchange || '?'} → id: ${combat.id}`);
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

- [ ] **Step 7.3: Update readmes**

In `formatReadmeFull`, replace the fat CREATE combat example (`state-view.js:700`):
```
// Before:
> CREATE combat:alley-fight status=ACTIVE exchange=1 participants="pc,tifa,shinra-sweep" hostiles="shinra-sweep" primary_enemy="shinra-sweep" terrain="Narrow service alley..." situation="..." threat="..." -- Active combat container

// After:
> CREATE combat:alley-fight status=ACTIVE exchange=1 primary_enemy="shinra-sweep" opened_from=ambush-trap -- Thin combat container; scene + collision carry the tactical narrative
```

Remove the fat SET examples (`state-view.js:717`) that set terrain/situation/threat. Replace with outcome/aftermath:
```
// Replace:
> SET combat:alley-fight field=exchange value=2 -- New exchange begins
> SET combat:alley-fight field=outcome value="Team broke left, neutralized sweep, runner made the doorway" -- On RESOLVED
> SET combat:alley-fight field=aftermath value="One sweep operative wounded; runner bleeding; cover compromised" -- What remains
```

In COMMON PATHS (Core readme, `state-view.js:613-623`):
```
// Before:
  combat:id.participants
  combat:id.hostiles
  combat:id.primary_enemy
  combat:id.terrain
  combat:id.situation
  combat:id.threat
  combat:id.outcome
  combat:id.aftermath

// After:
  combat:id.status
  combat:id.exchange
  combat:id.primary_enemy
  combat:id.opened_from
  combat:id.outcome
  combat:id.aftermath
```

Add a block in DISCIPLINE or near the combat paths:
```
COMBAT IS A THIN CONTAINER. Scene prose carries terrain and tactical narrative; the spawning collision carries cost and forces. Combat tracks only: who's fighting whom (primary_enemy), which round (exchange), and what ended where (outcome + aftermath on RESOLVED).
```

- [ ] **Step 7.4: Relax `consistency.js` if needed**

```bash
grep -n "terrain\|situation\|threat\|participants\|hostiles" "G:/My Drive/AI RPG/Gravity-Extension/consistency.js"
```

If there are any format-validation rules requiring those fields, remove them. Do not add new enforcement for the new thin shape — consistency.js validates structure, not gameplay.

- [ ] **Step 7.5: Update `ui-panel.js` combat render**

Search:
```bash
grep -n "terrain\|situation\|threat\|participants\|hostiles" "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
```

For each match displaying a combat field, remove the terrain/situation/threat/participants/hostiles rows and replace with outcome/aftermath rows:
```javascript
// Add or preserve:
if (combat.primary_enemy) parts.push(`<div class="gl-d-row"><b>Primary enemy:</b> ${esc(combat.primary_enemy)}</div>`);
if (combat.opened_from) parts.push(`<div class="gl-d-row"><b>Opened from:</b> collision:${esc(combat.opened_from)}</div>`);
if (combat.outcome) parts.push(`<div class="gl-d-row"><b>Outcome:</b> ${esc(combat.outcome)}</div>`);
if (combat.aftermath) parts.push(`<div class="gl-d-row"><b>Aftermath:</b> ${esc(combat.aftermath)}</div>`);
```

- [ ] **Step 7.6: Slim deduction templates and challenge prompts**

Search:
```bash
grep -n "terrain\|situation\|threat" "G:/My Drive/AI RPG/Gravity-Extension/index.js" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json"
```

For each match in deduction templates or combat-mode prompts, remove the instruction to populate those fields. Replace with guidance to write outcome/aftermath on RESOLVED. Preserve any in-prose references to terrain/situation (those are scene content, not state fields).

- [ ] **Step 7.7: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/state-view.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/index.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/ui-panel.js"
node -c "G:/My Drive/AI RPG/Gravity-Extension/consistency.js"
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v14.json" > /dev/null
python -m json.tool "G:/My Drive/AI RPG/Gravity-Extension/gravity_v13_c.json" > /dev/null
```

- [ ] **Step 7.8: Manual QA**

Load the Arcueid fixture. Verify:
- combat-mo31x82z (resolved in fixture) renders in state-view with minimal fields only — primary_enemy, outcome, aftermath visible; no terrain/situation/threat shown even though fixture has them
- Trigger a new combat via the challenge engine. Verify the new combat entity is seeded with only the thin engine fields (status, exchange, primary_enemy, opened_from)
- LLM turn in combat mode no longer emits SET terrain/situation/threat (readme and nudge guidance now omit them)

- [ ] **Step 7.9: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add state-view.js index.js ui-panel.js consistency.js gravity_v14.json gravity_v13_c.json
git commit -m "$(cat <<'EOF'
feat(combat): thin combat entity to engine stats only

Combat tracks: status, exchange, primary_enemy, opened_from, outcome,
aftermath. Terrain/situation/threat/participants/hostiles removed —
scene prose and the spawning collision carry the tactical narrative.

Legacy fat combat fields in existing state are silently unused.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Simplify Nudge Prompt

**Rationale:** The per-turn nudge currently duplicates 100+ tokens of knowledge-firewall/faction-intel/cleanup-cap guidance that's already in the readme. It also tells the LLM "Gravity_State_View is your COMPLETE memory" — no longer true after Task 1, and the framing pressures the LLM to write bloated scene/condition strings trying to carry narrative weight. Reframe: Gravity is a state engine; prose carries narrative; state tracks what prose can't.

**Files:**
- Modify: `index.js` — shrink nudge text

### Task 8 Steps

- [ ] **Step 8.1: Rewrite the nudge block in `index.js`**

Replace the nudge construction (`index.js:1533-1558`):
```javascript
// Before:
const reasonMode = nextReasonMode || 'regular';

let nudgeText = `[SYSTEM: GRAVITY RUNTIME FLAGS
GRAVITY_REASON_MODE: ${reasonMode}

These flags are for hidden reasoning only. Never echo or paraphrase them in visible output.

After the thinking pass closes, visible output is:
1. Divination card HTML ONLY when another injection explicitly requests a draw this turn. ${reasonMode === 'regular' ? 'DIVINATION: none this turn. Do not render a card or reference any prior draw.' : ''}
2. Prose
3. UPDATE block:
- Normal turns: ---STATE--- (compact delta, only material changes)
- Structural turns or explicit cleanup/setup instructions: ---LEDGER--- (full command block, no line limit)${_uncappedTurn ? ' (UNCAPPED - full cleanup allowed)' : ''}

Update current_scene, location, and condition when they materially change or the scene would be hard to reconstruct without them.
Knowledge firewall: characters only act on what their reads, noticed_details, knowledge_asymmetry, faction intel, and plausible information channels make possible. Hidden facts stay hidden until learned, revealed, reported, sensed, or inferred honestly.
Remote factions are not live-omniscient. Use faction comms_latency, last_verified_at, intel_posture, blindspots, intel_on, and false_beliefs to decide what they know right now.
When a character re-enters after time away, use last_seen_at plus summary residue and faction intel to refresh what they plausibly learned, missed, guessed, or got wrong while absent.
CLEANUP (REMOVE/DESTROY): max 3 per regular turn. Save bulk for eval or chapter close.

You have ONLY 3-5 messages of context. Gravity_State_View is your COMPLETE memory.]`;

// After:
const reasonMode = nextReasonMode || 'regular';

let nudgeText = `[SYSTEM: GRAVITY RUNTIME FLAGS
GRAVITY_REASON_MODE: ${reasonMode}

Flags are hidden reasoning only — never echo or paraphrase.

Output order after thinking:
1. Divination card HTML — only if this turn's injections explicitly request a draw. ${reasonMode === 'regular' ? 'DIVINATION: none this turn.' : ''}
2. Prose — carries the narrative.
3. UPDATE block — carries state changes only:
   - Normal turns: ---STATE--- (compact delta, material changes only)
   - Structural turns: ---LEDGER--- (full block, no line limit)${_uncappedTurn ? ' (UNCAPPED)' : ''}

Gravity tracks what prose can't: asymmetries, pressures, distances, reads-over-time. It does not track narrative recap — that belongs to the companion memory extension. Write state deltas for what changed, not restatements of what the prose just described.]`;
```

Leave the world-info-triggers append block (`index.js:1557-1559`) unchanged.

- [ ] **Step 8.2: Syntax check**

```bash
node -c "G:/My Drive/AI RPG/Gravity-Extension/index.js"
```

- [ ] **Step 8.3: Manual QA**

Load the Arcueid fixture. Send a regular turn. In the ST console, inspect the concatenated prompt and verify:
- Nudge is now ~120 words (was ~280)
- No duplication of readme discipline content
- No "COMPLETE memory" framing

- [ ] **Step 8.4: Commit**

```bash
cd "G:/My Drive/AI RPG/Gravity-Extension"
git add index.js
git commit -m "$(cat <<'EOF'
feat(nudge): simplify per-turn nudge prompt

Drops duplication with readme (knowledge firewall, remote factions,
cleanup cap — all already in readme) and the "state is your complete
memory" framing that encouraged the LLM to bloat scene/condition
fields. Reframes Gravity as "state tracks what prose can't".

Saves ~100 tok/turn.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Post-Implementation Validation

After all 7 tasks commit:

- [ ] **Full-chat replay test.** Load `Test/Arcueid Brunestud - 2026-04-17@17h10m47s297ms.jsonl` in a clean SillyTavern install. Replay the chat from turn 0. Verify:
  - No console errors
  - State panel renders all tabs correctly
  - Legacy fields (doing, last_manifestation, pc.condition, summary, story_summary, pc.timeline, fat combat fields, string knowledge_asymmetry, string reads.pc) all migrate or are silently unused without breaking replay
  - Final computed state matches the substance of the fixture's final state (new-shape equivalents of old fields)

- [ ] **Fresh-chat smoke test.** Start a new chat with a fresh persona. Run through setup wizard. Trigger: a collision, a constraint transition, a combat, an intimacy beat, a chapter close. Verify:
  - State-view injection under 4k tokens on regular turns (it was often >5k before)
  - Readme injection is the slimmed Core on regular/advance, Full only on integration
  - No TIMELINE block in injection
  - Knowledge-asymmetry entries accumulate as map entries, not paragraph rewrites
  - Reads.pc evolves as an append log

- [ ] **Token count measurement.** In the ST console with debug logging, capture the total per-turn injection token count for 10 turns of the fresh chat. Compare to pre-refactor baseline (if available from a saved log). Expect 1000-1500 token reduction per regular turn.

- [ ] **Final commit.** If validation passes without issues, tag the branch:
```bash
git tag -a "v15-scope-reduction" -m "Ledger refactor: pure collision engine + character tracker"
```
