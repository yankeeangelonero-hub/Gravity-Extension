# Version 14 — Prose Architecture Overhaul

**Date:** 2026-04-01 ~18:30 UTC
**Branch:** `codex-v13-state-delta`
**Commits:** `8efd548` → `cf8d112`

## What Changed

The prose system was monolithic: one heavy Prose Kernel, one heavy Noir Realist style, and thin prose subsections buried inside gameplay mode entries. This caused three problems: Sonnet defaulted to safe flat prose because instructions were too generic, all modes sounded the same, and instruction language leaked into prose ("one beat," "C2 is cracking," "I'm staying").

The overhaul adopted Lucid Loom's modular philosophy — stackable, swappable prose layers — while leveraging Gravity's unique advantage: structured character dossiers.

## Architecture After Changes

```
ALWAYS ON (preset):
  Prose Kernel (quality floor — categorized bans, instruction leak guard,
    sensory rotation, universal establishing/character/dialogue craft,
    anti-superiority, trauma guards)

ENABLED BY DEFAULT (preset):
  Group 5 Prose Style — Noir Realist (aesthetic register only)
  Character Voice (vocabulary prison, stress decay, observation filter,
    syntactic fingerprint, organic friction)
  Dossier-Driven Prose (reads as misreads, constraints as body language
    with flaw-first decision, noticed details as callbacks, key moments
    as emotional gravity, doing-cost as scene pressure, collision distance
    as atmospheric pressure)

MODE-SPECIFIC (lorebook, fired by extension per mode):
  gravity_prose_regular — emotional deflections, suggestion, negative space, slow-burn
  gravity_prose_combat — anti-camp, compression, adrenal degradation, rendering
  gravity_prose_intimacy — impermanence, psychic opacity, multisensory, intimacy dynamics
  gravity_prose_intimacy (NSFW layer, order 130) — explicit permission, physical realism, mishaps
  gravity_prose_advance — cynicism, counterweight, jo-ha-kyu rhythm, rendering

LENGTH (lorebook, per mode — no preset-side length guidance):
  Regular: 350-600 / 500-900 / 800-1200 (dialogue / scene / establishing)
  Combat: 300-500 / 500-750 (exchange / with entrance)
  Intimacy: 450-750 / 700-1000 (standard / discovery)
  Advance: 600-1000 / 900-1500 (focused / broad)
  Timeskip: 700-1200
  Chapter close: 200-400 audit / 300-500 opening (spend tokens on LEDGER)
```

## Files Modified

### `gravity_v14.json` (preset)

- **Prose Kernel** (`072d4755`): Restructured with categorized bans (explaining, throat-clearing, borrowed language, inflation, AI fingerprints) each with a "door out" redirect. Added instruction leakage guard, sensory rotation, anti-superiority, trauma guards. Absorbed generalized establishing space/character/dialogue craft from Noir Realist.
- **Noir Realist** (`pr0se000-0001`): Slimmed from ~2500 to ~886 chars. Keeps core charge + line-level method only.
- **Glass Nerve, Lyrical Ruin, Street Voltage**: Same treatment — core charge + line method only.
- **Character Voice** (`v01ce000-0001`): New toggle, enabled by default. Vocabulary prison, stress decay, observation filter, syntactic fingerprint, organic friction — all connected to dossier fields.
- **Dossier-Driven Prose** (`d0551e00-0001`): Added flaw-first decision to Constraints as Body Language section.
- **Anchor** (`05d1145b`): Disabled in prompt_order. Removed word budget rule. Remaining rules overlap with Gravity Kernel and State Contract.
- **Group 6 word count entries**: Removed entirely. Length now lives in lorebook.

### `Gravity World Info.json` (lorebook)

- **4 new prose entries** at order 120, depth 4: `gravity_prose_regular`, `gravity_prose_combat`, `gravity_prose_intimacy`, `gravity_prose_advance`. Each carries mode-specific technique instructions and length guidance.
- **1 new NSFW layer** at order 130: shares `gravity_prose_intimacy` key, fires alongside base intimacy. Disable in WI to remove explicit content.
- **5 existing gameplay entries** stripped of prose subsections. Advance, combat, and intimacy entries now say "Prose modulation for this mode is provided by the active prose lorebook entry." Timeskip and chapter close do not reference prose entries (they fall back to Prose Kernel).

### `index.js` (extension)

- **`MODE_LOREBOOK_KEYS`**: Added `proseRegular`, `proseCombat`, `proseIntimacy`, `proseAdvance`.
- **`handleAdvanceButton`**: Fires `proseAdvance` alongside advance gameplay keys.
- **`handleCombatButton`**: Fires `proseCombat` alongside combat gameplay keys.
- **`handleIntimacyButton`**: Fires `proseIntimacy` alongside intimacy gameplay keys (both base and NSFW entries activate via same key).
- **Nudge slot**: Appends `gravity_prose_regular` trigger on regular turns only (`isRegular` guard prevents double-firing).
- **`_lastCompletedMode`**: New variable — snapshots `_currentInjectMode` before `onMessageReceived` resets it to `'regular'`, so `handleGoodTurnButton` preserves the real turn mode for exemplar flagging.

## How It Works

1. Extension injects lorebook trigger keywords into the prompt (via `_ooc` for mode turns, via `_nudge` for regular turns).
2. SillyTavern scans the full assembled prompt for WI key matches.
3. Matching WI entries inject at depth 4 (before chat history).
4. Only one mode's prose entries fire per turn — the paths are mutually exclusive.
5. The NSFW layer shares its key with the base intimacy entry, so both fire together when intimacy mode is active.

## Token Budget

- Active preset content: ~15,250 chars
- Lorebook per mode (only one set fires at a time):
  - Regular: ~1,475 chars
  - Combat: ~1,330 + 738 gameplay = ~2,068
  - Intimacy: ~1,728 + 725 gameplay + 1,556 NSFW = ~4,009
  - Advance: ~1,430 + 1,206 gameplay = ~2,636

## How to Swap Prose Personalities

Import a different `Gravity World Info.json` with entries using the same trigger keys. Zero code changes. The extension fires the keywords; the lorebook decides what prose guidance to inject.

## Verification

- All three files pass syntax checks (`node -c index.js`, JSON.parse on both JSONs).
- No residual length instructions in preset or extension.
- No prose subsections remaining in gameplay WI entries.
- Anchor disabled in prompt_order, no duplication with Prose Kernel.
- Exemplar mode tagging now uses `_lastCompletedMode` snapshot.

## Known Limits

- Timeskip and chapter-close modes have no mode-specific prose entry — they fall back to the Prose Kernel. This is intentional (structural turns, not prose-heavy).
- The NSFW layer always fires with intimacy. To disable, the user must manually disable the WI entry.
- Exemplar mode classification still partially relies on text heuristics (`inferExemplarCategory`) as a fallback when `_lastCompletedMode` is `'regular'` but the content is clearly combat/intimacy.

## Suggested Next Focus

- Test each mode with Sonnet to verify prose differentiation actually lands.
- If prose styles beyond the current four are added, consider style-specific exemplar banks.
- The NSFW layer could be extended with additional stacking entries (e.g., kink-specific layers) using the same shared-key pattern.
- Consider adding a `gravity_prose_timeskip` entry if timeskip prose quality is too generic.
