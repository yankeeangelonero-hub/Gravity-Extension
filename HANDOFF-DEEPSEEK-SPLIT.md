# Handoff: DeepSeek Ledger Agent

## Build Status (as of 2026-03-31)

| Task | Status | Notes |
|---|---|---|
| `ledger-agent.js` — new module | ✅ Done | All functions built; `summarizeTransactions()` added |
| `index.js` — DeepSeek branch in `onMessageReceived` | ✅ Done | Pending status injected before call, done/failed after |
| `index.js` — annotation nudge when DS enabled | ✅ Done | Fires in `injectPrompt()` |
| `index.js` — slim/prose state view for DS mode | ✅ Done | `prose` mode (no entity IDs) |
| `index.js` — `_readme` cleared when DS enabled | ✅ Done | Cleared to `PROMPT_NONE` |
| `ui-panel.js` — DeepSeek dedicated section | ✅ Done | Enable, API key + show/hide, model selector, last-call status |
| `ui-panel.js` — ledger status below response | ✅ Done | `showLedgerStatus()` exported; CSS added |
| `ledger-agent.js` — `summarizeTransactions()` | ✅ Done | Human-readable tx summary for status display |
| `gravity_deepseek_last` write | ⚠️ Gap | `renderDeepSeek()` reads `chatMetadata['gravity_deepseek_last']` but nothing writes it. Need to write `{ ok, tx, ms, err, ts }` after each DS call in `index.js`. |
| `rules-engine.js` — `skipDeduction` param | ✅ Superseded | Deduction templates are lorebook entries; `MODULE_ACTIVATION_DS` drops them |
| Testing | ❌ Not done | See checklist below |

**Deviations from original plan:**
- `callDeepSeek()` does not use `stop` tokens — appends `---END LEDGER---` if missing.
- `rules-engine.js` changes superseded by lorebook migration.
- `annotation-spec.js` not created — `ANNOTATION_PATTERN` in `ledger-agent.js`.
- DS settings save goes through `_onSettingsChange('gravity_deepseek', ...)` path, not `saveDeepSeekSettings()` from the module (both achieve same result).

---

## What this is

Gravity Ledger currently makes the prose model (Opus) output both creative prose AND a structured `---LEDGER---` block. The optimization: Opus writes prose only. A cheap DeepSeek call after Opus finishes handles the ledger. Opus emits `<!-- GRAVITY: ... -->` annotations to guide DeepSeek's state machine decisions.

## Architecture

```
BEFORE (DS off):
  Inject [rules + state + readme + nudge] → Opus → [prose + deduction + ledger] → parse → commit

AFTER (DS enabled):
  Inject [rules + slim state + annotation nudge] → Opus → [prose + annotations]
       ↓
  Extract annotations → Build [prose + full state + readme + annotations] → DeepSeek → [ledger]
       ↓
  Parse → validate → commit → showLedgerStatus(messageId, 'done', summary)
```

## `ledger-agent.js` ✅ Built

### Exports

```js
extractAnnotations(prose)
  → { cleanedProse, annotations[] }

buildLedgerPrompt(prose, annotations, stateView, readme, extras)
  // extras: { divinationDraw, setupContext }
  → Array  // OpenAI messages

callDeepSeek(messages, apiKey, model)
  → Promise<string>  // ---LEDGER--- block; appends ---END LEDGER--- if missing
  // 30s timeout via AbortController; throws on failure

generateLedger(prose, state, options)
  // options: { apiKey, model, stateView, readme, divinationDraw, setupContext }
  // Returns null on failure; caller sets _pendingReinforcement and shows 'failed' status
  → Promise<{ ledgerText, cleanedProse, annotations } | null>

getDeepSeekSettings()
  → { enabled, apiKey, model }  // from chatMetadata['gravity_deepseek']

saveDeepSeekSettings(updates)
  → Promise<void>

summarizeTransactions(txns)
  // e.g. "8 tx — tifa, cloud | rooftop-fight→RESOLVING | c1-detachment→STRESSED | scene · 2× timeline"
  → string | null
```

### DeepSeek system prompt

Instructs DeepSeek to: output ONLY the `---LEDGER---` block; treat annotations as authoritative for state machine transitions; extract location/doing/scene/timeline from prose; update `current_scene` and PC state every turn; use entity IDs from state view; output `(empty)` block if nothing changed.

### API call

```js
{ model, messages, temperature: 0.1, max_tokens: 2000 }
```

No stop tokens — terminator appended if missing.

## `index.js` changes ✅ Built

### Status display flow in `onMessageReceived`

```
DS enabled:
  showLedgerStatus(messageId, 'pending')         // before generateLedger()
  → on result: parse → commit
  → showLedgerStatus(messageId, 'done', summary) // after updatePanel()
  → on null: showLedgerStatus(messageId, 'failed')

Non-DS:
  → after commit: showLedgerStatus(messageId, 'done', summary)
  → on errors only: showLedgerStatus(messageId, 'error', msg)
  → on no txns: showLedgerStatus(messageId, 'empty')
```

### `injectPrompt()` with DS enabled

- State view: `prose` mode (no entity IDs)
- `_readme`: cleared to `PROMPT_NONE`
- Nudge: annotation-only format
- Lorebook: `MODULE_ACTIVATION_DS` (core only per mode, no deduction/ledger entries)

## `ui-panel.js` changes ✅ Built

### DeepSeek section (new)

Dedicated collapsible section in the floating panel (between Settings and Style Exemplars):
- Enable/disable toggle
- API key (password field with show/hide eye button)
- Model selector (deepseek-chat / deepseek-reasoner)
- Last call status: reads `chatMetadata['gravity_deepseek_last']` — shows `{ ok, tx, ms, err, ts }`

**⚠️ Gap**: `gravity_deepseek_last` is read in the UI but never written. To fix: after `generateLedger()` in `index.js`, write to `chatMetadata['gravity_deepseek_last']`:

```js
// After DS call in onMessageReceived:
const { chatMetadata, saveMetadata } = SillyTavern.getContext();
chatMetadata['gravity_deepseek_last'] = {
    ok: result !== null,
    tx: result ? (committed?.length ?? 0) : 0,
    ms: elapsed,
    err: result ? null : 'call failed',
    ts: new Date().toLocaleTimeString(),
};
await saveMetadata();
```

### `showLedgerStatus(messageId, status, summary)`

Injected below `.mes_text` of the target message. Status values:
- `'pending'` → animated spinner "Ledger updating…"
- `'done'` → "✓ Ledger — [summary]"
- `'empty'` → "◦ No ledger changes"
- `'failed'` → "⚠ Ledger unavailable — will retry next turn"
- `'error'` → "⚠ Ledger errors — [detail]"

Finds message by `[mesid="${messageId}"]`, falls back to last `.mes` in `#chat`.

## Unchanged (as planned)

`regex-intercept.js`, `consistency.js`, `state-compute.js`, `ledger-store.js`, `snapshot-mgr.js`, `memory-tier.js`, `ooc-handler.js`, `setup-wizard.js`

## Testing Checklist (NOT YET DONE)

1. **Syntax check:**
   ```bash
   node -c index.js && node -c ledger-agent.js && node -c lorebook-manager.js && node -c preset-manager.js && node -c rules-engine.js && node -c state-view.js && node -c ui-panel.js
   ```

2. **Annotation extraction:** Multiple annotations per response; no annotations; malformed (missing `-->`); annotation at start/end.

3. **Prompt construction:** Log first few DS prompts to verify state view has entity IDs, readme present, annotations listed.

4. **Opus inline-ledger bypass:** If Opus writes `---LEDGER---` despite annotation-only instruction, `generateLedger()` returns it directly. Verify.

5. **Failure fallback:** Kill network mid-turn → status shows 'failed', `_pendingReinforcement` set, chat unblocked.

6. **Toggle mid-chat:** DS off → lorebook switches back to `MODULE_ACTIVATION` (deduction entries re-enabled), `_readme` reappears.

7. **Write `gravity_deepseek_last`:** Implement the gap above, then verify the last-call status panel updates after each turn.

8. **Status display:** Verify spinner appears immediately, updates after commit, renders in correct message.

## Annotation examples Opus should produce

Regular turn:
```
The glass hit the counter harder than she meant. Tifa's hand stayed flat on the bar.
<!-- GRAVITY: constraint:c1-detachment pressure, char:tifa condition-shift -->
"I'm fine," she said, which meant she wasn't.
```

Combat turn:
```
The blade caught his shoulder — not deep, but the armor split along the seam.
<!-- GRAVITY: collision:rooftop-ambush distance=1, pc wounds:left-shoulder="shallow cut through armor seam" -->
```

Advance turn:
```
The door opened and Rufus walked in with six Turks.
<!-- GRAVITY: collision:shinra-reckoning RESOLVING, new-char:rufus-shinra "Rufus Shinra" -->
```

## Edge Cases

1. **Opus includes ledger block anyway**: `generateLedger()` detects `---LEDGER---` in prose, returns it directly, skips DS call. ✅
2. **No annotations**: DS runs regardless — extracts from prose alone. ✅ (shown as "(none — infer all changes from prose)")
3. **DeepSeek hallucinates entities**: `consistency.js` catches invalid types; unknown IDs are no-ops in `state-compute.js`. ⚠️ Pre-commit warning log for unknown IDs would be a useful addition.
4. **Wrong state machine transitions**: DS system prompt instructs it to follow annotations authoritatively. Relies on prompt compliance; no hard enforcement.
5. **Latency**: 30s timeout, AbortController. ✅ Spinner shown while pending.
6. **Setup wizard bulk creation**: `setupContext` extras field available in `buildLedgerPrompt()`. ✅ Wired.
