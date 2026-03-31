# Handoff: Gravity Preset + Modular Lorebook System

## Build Status (as of 2026-03-31)

| Phase | Status | Notes |
|---|---|---|
| Phase 1: Preset + lorebook files | ✅ Done | `Gravity Preset.json`, `Gravity World Info.json`, `lorebook-manager.js` built |
| Phase 2: Rewire `index.js` | ✅ Done | Lorebook activation, `_rules`/`_readme` cleared, preset settings applied on init |
| Prose/word count/divination → preset | ✅ Done | All moved to `Gravity Preset.json` entries managed by `preset-manager.js` |
| Phase 3: Expansion pack template | ❌ Not done | Design documented below; no example expansion built |
| Phase 4: DeepSeek integration | ✅ Done | See HANDOFF-DEEPSEEK-SPLIT.md |

**Deviations from original plan:**
- `rules-engine.js` kept as thin shim (prose settings + `SONNET_ENFORCEMENT` + `buildSettingsLine()`). `buildSettingsLine()` now returns tense + perspective only — word count moved to preset entry.
- Prose style, word count, and divination are **preset entries**, not lorebook entries. `preset-manager.js` (new module) manages them via `window.oai_settings` in-memory.
- `lorebook-manager.js` no longer handles prose at all — `activateProseStyle()` removed entirely, `'prose'` removed from all activation tables.
- `gravity_intimacy_sonnet` stays in lorebook (it's intimacy-mode-specific choice frameworks, not a prose style).
- `annotation-spec.js` was not created — `ANNOTATION_PATTERN` lives in `ledger-agent.js`.

---

## Design Philosophy

Three-layer system:

1. **Preset** (`Gravity Preset.json`) — identity, voice, immutable principles, prose style, word count, divination oracle description
2. **Lorebook** (`Gravity World Info.json` + expansion packs) — turn-mode rules (advance/combat/intimacy/deduction templates, ledger reference), activated by extension per turn mode
3. **Extension** (`index.js` + modules) — computed state, events, feedback, orchestration

The extension is the **orchestrator**. Static rule content lives in the preset and lorebook. The extension injects only dynamic/computed content.

## Preset: `Gravity Preset.json` ✅ Built

### Prompt Order

```
main → worldInfoBefore → charDescription → charPersonality → scenario →
personaDescription → nsfw →
[gravity_prose_bans] → [gravity_prose_<style>] → [gravity_prose_sonnet] →
[gravity_word_count] → [gravity_divination] →
worldInfoAfter → dialogueExamples → chatHistory → jailbreak
```

### Static entries (content never changes)

| Identifier | Description |
|---|---|
| `main` | Gravity identity, principles, knowledge firewall |
| `jailbreak` | Turn sequence anchor, scene header instruction |
| `gravity_prose_bans` | Universal prose bans (always enabled) |

### Dynamically toggled entries (extension enables one at a time)

| Identifier | Default | Notes |
|---|---|---|
| `gravity_prose_noir` | enabled | Noir Realist style |
| `gravity_prose_literary` | disabled | Literary Fiction style |
| `gravity_prose_cinematic` | disabled | Cinematic style |
| `gravity_prose_minimalist` | disabled | Minimalist style |
| `gravity_prose_wuxia` | disabled | Wuxia Chronicle style |
| `gravity_prose_sonnet` | disabled | Sonnet show-don't-tell enforcement |

### Dynamically written entries (extension writes content on every chat load)

| Identifier | Driven by |
|---|---|
| `gravity_word_count` | `chatMetadata['gravity_word_count']` |
| `gravity_divination` | `chatMetadata['gravity_divination_system']` |

## `preset-manager.js` ✅ Built (new module)

All preset entry management. Modifies `window.oai_settings` in-memory — no `saveSettingsDebounced` called. Applied on every `initialize()` and every settings change, so the global preset always reflects the current chat's preferences.

```js
applyAllPresetSettings({ proseStyle, wordCount, divination, sonnetTier })
applyProseStyle(style, sonnetTier)   // toggles gravity_prose_<style> entries
applyWordCount(wordCount)             // writes content to gravity_word_count
applyDivination(system)              // writes content to gravity_divination
```

Called from `index.js`:
- `initialize()` — `applyAllPresetSettings()` after `buildModuleMap()`
- `onSettingsChange` callback — individual apply calls on key change (`gravity_prose_style`, `gravity_model_tier`, `gravity_word_count`, `gravity_divination_system`)

## Lorebook: `Gravity World Info.json` ✅ Built (16 entries)

Prose entries have moved to the preset. The lorebook now contains only turn-mode rule content.

### Module Inventory

| AutomationId | Module | Description |
|---|---|---|
| `gravity_core` (×3) | core | Character tiers, constraint model, collision model |
| `gravity_deduction_regular` | deduction_regular | Regular turn COT template |
| `gravity_deduction_advance` | deduction_advance | Advance turn COT template |
| `gravity_deduction_combat` | deduction_combat | Combat turn COT template |
| `gravity_deduction_intimacy` | deduction_intimacy | Intimacy turn COT template |
| `gravity_advance` | advance | World-moves turn rules |
| `gravity_combat` | combat | Combat turn rules |
| `gravity_combat_scale` | combat_scale | Per-chat power scale (written by setup wizard) |
| `gravity_intimacy` (×2) | intimacy | Intimacy rules + writing guide |
| `gravity_intimacy_sonnet` | intimacy_sonnet | Sonnet choice frameworks (intimacy mode only) |
| `gravity_factions` | factions | Faction political simulation rules |
| `gravity_ledger-core` | ledger-core | Ledger command reference (Opus-writes-ledger mode) |
| `gravity_ledger-full` | ledger-full | Full ledger reference (integration turns) |

## `lorebook-manager.js` ✅ Updated

Prose handling fully removed. Activation tables no longer include `'prose'`.

```js
// MODULE_ACTIVATION (no prose — prose is in preset now)
regular:     ['core', 'deduction_regular', 'ledger-core']
advance:     ['core', 'deduction_advance', 'advance', 'factions', 'ledger-core']
combat:      ['core', 'deduction_combat', 'combat', 'ledger-core']
intimacy:    ['core', 'deduction_intimacy', 'intimacy', 'ledger-core']
integration: ['core', 'advance', 'combat', 'intimacy', 'factions', 'ledger-full']

// MODULE_ACTIVATION_DS (DeepSeek mode)
regular:     ['core']
advance:     ['core', 'advance', 'factions']
combat:      ['core', 'combat']
intimacy:    ['core', 'intimacy']
integration: ['core', 'advance', 'combat', 'intimacy', 'factions']
```

`activateModules(mode, { deepseekEnabled, sonnetTier })` — `proseStyle` option removed. `sonnetTier` still activates `intimacy_sonnet`.

Exports: `buildModuleMap`, `activateModules`, `writeModuleContent`, `getExpansionModules`, `disableAll`.

## Turn Mode Activation Summary

| Mode | Lorebook modules | Preset entries active |
|---|---|---|
| regular | core, deduction_regular, ledger-core | prose_bans, prose_<style>, word_count, divination |
| advance | core, deduction_advance, advance, factions, ledger-core | same |
| combat | core, deduction_combat, combat, ledger-core | same |
| intimacy | core, deduction_intimacy, intimacy, ledger-core | same + intimacy_sonnet if Sonnet |
| integration | core, advance, combat, intimacy, factions, ledger-full | same |
| any (DS on) | core only (no deduction/ledger) | same |

## What the Extension Still Injects at Depth 0

| Injection | Reason |
|---|---|
| `_state` — state view | Computed from transactions every turn. `prose` mode when DS on, `slim` for regular, `full` for integration |
| `_nudge` — turn nudge | Tense + perspective (per-chat, too short for preset slot); mode reminder; annotation format when DS on |
| `_inject` — corrections/reinforcement | Feedback loop from previous turn |
| `_ooc` — OOC/button injection | Advance prompt, combat setup, intimacy context |
| `_arrival` — collision arrival | Event-driven, includes divination draw |
| `_stale` — stale collision warning | Computed |
| `_dist_warn` — distance warnings | Computed |
| `_intimacy` — stance enforcement | Computed from character state |
| `_faction` — faction heartbeat (every 10 turns) | Computed |
| `_dormant` — dormant characters | Computed from transaction gaps |
| `_exemplars` — style exemplars | User-curated |
| `_setup` — setup wizard phase | Setup flow state |
| `_rules` | CLEARED (PROMPT_NONE) |
| `_readme` | CLEARED (PROMPT_NONE) |

## Files Summary

### Created ✅
| File | Status |
|---|---|
| `Gravity Preset.json` | Built — identity, jailbreak, 9 prose/settings entries, samplers |
| `Gravity World Info.json` | Built — 16 entries, all turn-mode rule modules |
| `lorebook-manager.js` | Built — module map, activation (no prose) |
| `preset-manager.js` | Built — prose toggle, word count write, divination write |

### Modified ✅
| File | Change |
|---|---|
| `index.js` | `applyAllPresetSettings()` on init; `onSettingsChange` calls preset-manager; lorebook activation without `proseStyle`; ledger status display |
| `rules-engine.js` | Thin shim — prose settings + `SONNET_ENFORCEMENT` + `buildSettingsLine()` (tense/perspective only, word count removed) |
| `state-view.js` | `prose` mode added |
| `ui-panel.js` | DeepSeek dedicated section; `showLedgerStatus()` export; prose dropdown hardcoded 5 styles |

### Unchanged
`state-compute.js`, `ledger-store.js`, `consistency.js`, `regex-intercept.js`, `snapshot-mgr.js`, `memory-tier.js`, `ooc-handler.js`, `setup-wizard.js`

## Phase 3: Expansion Pack System (NOT YET BUILT)

### What needs to be built for expansion support

1. **`lorebook-manager.js`**: Read `gravity_activation` metadata from expansion JSON files on `buildModuleMap()`. Add expansion-declared modes to the activation tables.

2. **`ui-panel.js`**: Make the prose style dropdown dynamic — call `getExpansionModules()` to detect expansion prose styles (any module matching `prose_*` pattern), render as additional options in the Settings section. Currently the dropdown is hardcoded to the 5 built-in styles.

3. **Dynamic UI buttons**: Read `gravity_activation.ui_button` from expansion JSON metadata and register additional input bar buttons. Clicking sets `_pendingDeductionType` to the expansion mode.

4. **One example expansion**: `Gravity Expansion - Investigation.json` as proof of concept.

### Adding a new prose style (current path)

Add a world info entry with `automationId: gravity_prose_<name>`. Import into the world info book. The `lorebook-manager.js` will detect it in `getExpansionModules()`. **Currently**: the ui-panel.js dropdown is hardcoded — a new style won't appear in the UI without editing the dropdown HTML, but `preset-manager.js` would need a similar approach (adding a preset entry for the new style). Prose styles probably belong in the preset for new additions too.
