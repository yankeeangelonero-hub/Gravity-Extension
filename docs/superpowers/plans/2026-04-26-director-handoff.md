# Gravity Director — Tonight's Handoff

Session ended 2026-04-26.

Status: **architecture validated**, **calibration in progress**, **ready to keep iterating**.

---

## TL;DR

The Gravity Director architecture is alive and committing real ledger updates from a separate API call. After ~5 hours of build + ~2 hours of smoke debugging:

- ✅ Browser-side OpenRouter calls work (Phase 0.2 spike + production usage)
- ✅ Seam swap is sound (`onMessageReceived` → director → validate → commit)
- ✅ Director-prompt is calibrated; commit threshold tracks Gravity's actual update rhythm
- ✅ Validation catches real mistakes (one engine-owned-field violation caught + fix pushed)
- ✅ Last good turn: **8/9 commits clean** on a substantive advance turn (`45537ce`)

Open: setup wizard still broken (deferred), preset/lorebook deduction templates still tell prose model to do director-side thinking, diagnostic logging still in place.

---

## Where Things Are

### Branch state
- Local + remote branch: **`director-prototype`** (https://github.com/yankeeangelonero-hub/Gravity-Extension/tree/director-prototype).
- Worktree: `G:\My Drive\AI RPG\Gravity 2\.worktrees\director-prototype`.
- Main is untouched; the branch is 38 commits ahead of `origin/main`.
- Local main has 5 doc commits (specs/plans) + dirty unrelated work (state-compute.js, AGENTS.md, character JSONs, deleted Documentation/archive entries) that has nothing to do with the director.

### SillyTavern junction
A directory junction in your SillyTavern third-party folder points at the worktree (mounted as a separate extension, e.g. `Gravity-Director-Test`). Your existing main-branch Gravity install was disabled in the ST UI to avoid two enabled extensions fighting over `chatMetadata['gravity_ledger']`.

### Remote pushes tonight
| SHA | What |
|---|---|
| `cb034ea` | OpenRouter pivot (spec + plan) |
| `8f63b29` | Test harness scaffold |
| `a187957` | `stripUpdateBlock` |
| `724fd44` | `buildDirectorCorrectionPayload` |
| `0c3971f` | `director-input.js` |
| `7d1ae80` / `69c8bee` / `897e3ac` | director-prompt.js (skeleton, op vocab, full-turn example) |
| `e5cd151` / `8f51303` / `f472094` | director-client.js (skeleton, OpenRouter call, renderer test) |
| `480c428` / `d25c007` / `0e45a29` | settings drawer |
| `1e7ae81` | mode/reasonMode/deductionType snapshot |
| `d66ee73` | seam swap (the big one) |
| `ad264cf` / `e7e7428` | corrections rewire + reinforcement audience split |
| `ba23f1d` | director status badge |
| `ff0ce24` … `40da718` | preset cleanup pass 1 (Phase 6) |
| `022b206` | disabled-mode banner |
| `413f0bb` / `1953108` | architecture/project_memory/CLAUDE.md docs |
| `72db80c` | **debug logging** — input shape + notes + previews |
| `3adab98` | first prompt recalibration (commit threshold tier) |
| `43e3ff0` | **prompt fix** — replaced contradictory abstract priorities ("earned change / conservative mutation") with concrete priorities ("track what happened / causal continuity / validator compatibility"); added `max_tokens: 4096` |
| `5d33719` | content sanity test fix |
| `bc1f105` | **client fix** — switched from strict json_schema to json_object (Bedrock Claude bug) |
| `fbf57b4` | debug logging — first 5 validation errors with rejected tx |
| `79bdf38` | **field-name fix** — director-prompt examples now use `v`/`k` (not `value`/`key`); tolerant JSON extraction added |
| `45537ce` | **engine-owned fields warning** — explicit do-not-write list (collision.distance, char.last_active_tx, relationship.status, world.timeskip_scale) |

---

## What Tonight Proved

### The architecture works

A separate director-model API call, fed compact derived state + recent ledger tail + recent turns, can correctly identify Gravity-relevant state changes from prose and emit valid transactions. The deterministic extension code remains the only thing committing. The hypothesis from the original director handoff — "one narrow model owns structural ledger judgment, while deterministic code remains the source of truth" — is supported.

### What broke during smoke (and what fixed it)

| Symptom | Root cause | Fix |
|---|---|---|
| `txs=0` on every turn, `confidence=high` | Self-contradictory system prompt: abstract priorities said "be conservative" while new threshold section said "don't over-rotate" | Replaced abstract priorities with concrete priorities (`43e3ff0`). dt rose from 3s → 6-23s, model started reasoning substantively. |
| `notes: "Ugh wait"` artifact + `txs=0` | Same as above — model bailing on conflict | Same fix. |
| `invalid_json` with thousands of empty `{}` entries | Strict json_schema + permissive `items: {type: object}` schema → Bedrock Claude found degenerate "satisfy by emitting empty objects" path | Switched to `response_format: {type: 'json_object'}` (`bc1f105`). |
| 8/9 txs failing validation | Director-prompt examples used long-form field names (`value`, `key`); validator requires short forms (`v`, `k`) | Updated all six op examples + added explicit warning at top of vocabulary (`79bdf38`). |
| `invalid_json` with prose prefix ("Looking at the corrections, the issue is clear…") | json_object mode allows prose-prefixed JSON | Added `extractJSON()` tolerant parser; also added "first character must be `{`" prompt directive (`79bdf38`). |
| `S collision.distance v=6` rejected | Director didn't internalize that distance is engine-tick-driven | Added explicit "Engine-owned fields — NEVER write these" section to prompt (`45537ce`). |

### Last good turn baseline (advance turn)

```
[GravityLedger] director ok — model=anthropic/claude-4.6-sonnet-20260217 dt=21936ms txs=9 confidence=high
[GravityLedger] [DBG] input shape: mode=advance reason=advance deduction=null stateView=23082ch ledgerTail=20 recentTurns=3 userMsg=51ch assistantMsg=6236ch pendingCorr=0
[GravityLedger] Committed 8 TX, 1 errors. Turn 2.
```

Director's notes:
> "Key commits this turn: BSAA call is complete and irrevocable (both chars now know), search pattern has adjusted south (faction + Ada knowledge), collision road-pursuit ticked closer. Ada's demonstrated traits updated for operational vigilance during rest and unconscious physical intimacy. Divination updated to The Star. Timeskip set to HOURS for the dawn-to-nightfall rest. Did not resolve road-pursuit yet — the collision is tighter but the safehouse is still undiscovered."

That's a fully coherent advance-turn director output. **The model is working correctly** under this prompt.

---

## Open Todos

### High priority — feature gaps

#### 1. Preset + lorebook cleanup pass 2 (Task #37)
Phase 6 stripped the *explicit ledger-emit instructions* but the **deduction templates** in `Gravity World Info.json` (and possibly leftover bits of `gravity_v15.json`) still ask the prose model to think about ledger-side concerns:

- regular: 11-field deduction including collisions, constraints, factions, divination, updates
- advance: focus, what moves, divination, **collision tracking**
- combat: power assessment, distance, etc.
- intimacy: divination, etc.

The director owns all of these now. The prose model should still **read** state (it does, via `_state` slot) and write prose that respects collisions/constraints — but it shouldn't be **deciding** updates.

Audit + rewrite plan:
1. Read `Gravity World Info.json` mode entries line by line.
2. For each "decide/update/tick/propose" framing → rewrite as "read state and respect it."
3. Drop divination/collision-tracking sections from prose-side deductions entirely.
4. Keep prose-side beats: intent, story, scene, plan, character voice.
5. Same audit on any remaining mode-related entries in `gravity_v15.json`.

Estimated ~half a session of focused work. Can dispatch as a subagent task once spec'd.

#### 2. Setup wizard fix (deferred from Phase 6)
The setup wizard's `buildSetupPrompt` (in `setup-wizard.js`) emits a long prose-side prompt instructing the prose model to "EMIT ALL OF THE FOLLOWING in one ---LEDGER--- block:" with ~50 lines of structured instructions. Under cutover this fails:

1. Prose model gets contradictory instructions (Anchor entry tells it not to emit blocks; setup tells it to).
2. The wizard's structured `answers` (opening situation, power scale, PC base, abilities, etc.) flow ONLY into the prose-side `_pendingOOCInjection`. The director's input pipeline doesn't see them.

**Fix shape:** rewrite `buildSetupPrompt` to inject the wizard answers as a structured payload into the director-input pipeline (e.g., `directorInput.setupAnswers`). Add a setup-mode section to `director-prompt.js` telling the director: "if `setupAnswers` is present, emit the corresponding CR txs for PC, principal, factions, places, collisions, constraints." Same fix probably applies to timeskip (also `mode: integration`).

Estimated ~2-3 hours focused work.

### Medium priority — cleanup before merge

#### 3. Remove diagnostic logging
Two debug-log blocks added during smoke debugging:
- `index.js` ~line 1673: `[DBG] input shape`, director notes, stateView preview, assistantMsg preview (commit `72db80c`)
- `index.js` ~line 1929: `[DBG] error N`, rejected tx (commit `fbf57b4`)

Both are bracketed with `── DEBUG (remove after smoke) ──` comment markers. Easy revert. Keep them around until you're confident in the calibration; remove before merging to main.

#### 4. SillyTavern `extensionSettings` API verification
The settings persistence path uses `SillyTavern.getContext().extensionSettings` and `ctx.saveSettingsDebounced?.()`. The existing `index.js` code never accesses these directly — it uses `chatMetadata` for per-chat persistence. These global names are SillyTavern conventional but not verified against your specific ST version. **Symptom if broken:** settings don't persist after reload; "Test director call" returns `FAIL (auth)` even with key entered.

If observed, the fix is to import directly from SillyTavern's known paths:
```js
import { extension_settings } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
```

### Low priority — nice-to-have

#### 5. Take 5-10 more turns of varied content
Confirm consistency across regular / advance / combat / intimacy modes. One good turn is signal; ten is confidence. The smoke is going well; this just builds trust.

#### 6. Phase 0.1 baseline capture (Task #9)
Skipped during initial smoke. Required for the spec's quantitative success comparison (Task 9.3): "missed updates per session < parser baseline." Without it, "better than parser" is hand-wavy. Half-hour exercise documented in `docs/superpowers/plans/2026-04-25-gravity-director.md` Task 0.1.

#### 7. Eventually merge to main
Via `superpowers:finishing-a-development-branch`. Don't do until at least #3 (diagnostic removal) is done; ideally also #1 and #2.

---

## How to Resume

1. **Open this worktree:** `cd "G:\My Drive\AI RPG\Gravity 2\.worktrees\director-prototype"` (or work via your editor pointed at that dir).
2. **Pull latest:** `git pull` (in case you pushed from another machine).
3. **Run helper tests:** `node scripts/test-director.js` — should be 14/14.
4. **For prompt edits:** `director-prompt.js`. Hard-reload SillyTavern after every change.
5. **For preset/lorebook cleanup (Task #37):** Read `Gravity World Info.json` first to see actual current content. Then plan the rewrite.
6. **For setup wizard fix:** `setup-wizard.js` (specifically `buildSetupPrompt`) + `director-prompt.js` (add setup-mode handling) + `index.js` (route `answers` into director-input).

### Useful files
- **Spec:** `docs/superpowers/specs/2026-04-25-gravity-director-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-25-gravity-director.md`
- **Architecture map:** `Documentation/system_architecture_reference.md` (updated with director files + doc-drift hotspot note)
- **Project memory:** `Documentation/project_memory.md` (has director architecture section)

### Useful commands
```bash
# Full validation across all changed JS files
for f in index.js ui-panel.js state-view.js regex-intercept.js \
         director-client.js director-prompt.js director-input.js; do
    node -c "$f" && echo "$f: ok"
done

# JSON sanity
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8'))"

# Helper tests
node scripts/test-director.js
```

### What to watch for during smoke
- `[GravityLedger] director ok — model=… dt=Xms txs=N confidence=…`
- `dt` should be 5-25s for substantive turns. <5s with `txs=0` = director bailing.
- `txs > 0` on substantive turns. Persistent `txs=0` = prompt calibration issue (already fixed once tonight).
- `Committed N TX, M errors`. `M=0` is the goal; `M=1-2` is acceptable; `M>3` means a calibration issue worth investigating.
- `[DBG] error N: …` lines tell you exactly what the director got wrong.

---

## Architectural Lessons (for future reference)

1. **OpenRouter > direct provider SDKs** for prototypes. One auth, one URL, free model swapping. The 5% markup is trivially worth the simplification.
2. **`response_format: json_object` > strict `json_schema`** for non-trivial JSON outputs going through Bedrock-routed Claude. Strict mode triggers degenerate "satisfy schema with empty objects" loops.
3. **Tolerant parsers > strict parsers** when the output is structured-ish. Models occasionally prefix prose; `extractJSON` handles it.
4. **Concrete priority lists > abstract priorities.** "Track what happened / causal continuity / validator compatibility" works; "earned change / conservative mutation" produces stuck models.
5. **Field-name docs must match the validator's actual API.** Long-form aliases (`value`, `key`) read fine to humans but get rejected — the director's prompt has to teach the *exact* short forms (`v`, `k`).
6. **Engine-owned fields need explicit do-not-write lists.** The director will reach for any field that "represents" a real state change, even if the engine owns the actual update path.
7. **The correction loop saves the day.** Even when the director gets fields wrong, the existing self-correcting feedback loop routes errors back into the next director call. The prompt iteration is just to reduce the rate; the system is robust to occasional mistakes.

---

End of handoff.
