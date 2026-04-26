# Deduction CoT Architecture

**Date:** 2026-04-02 01:08 SGT  
**Branch:** `codex-v13-state-delta`

## Purpose

This document explains the current hidden-reasoning path for Gravity deduction.

The important design change is that deduction is no longer wrapped or structured by extension-side prompt text. The preset now owns the reasoning wrapper, ordering, and mode-specific protocols, while the extension only injects runtime flags and the visible-output contract.

## Current Ownership Split

### Preset: `gravity_v14.json`

The preset owns the hidden reasoning protocol.

- The legacy `| CoT Triggers (Gem/Claude)` helper still exists in the preset file, but it is currently disabled.
- `| Gravity CoT` is the active Gravity thinking entry. It explicitly opens with "Before anything else you must perform a strategic analysis," carries a literal `<think>...</think>` block, includes a short handoff reminding the model to obey the active preset prose style plus any active mode prose lorebook entry, then closes with `(output final narrative response. DON'T WRITE THE STRATEGIC ANALYSIS AGAIN)`.
- Prompt order places `| Gravity CoT` before the main Gravity kernel so the reasoning step is asked for first.
- `show_thoughts` is intentionally left `true` by user preference. Do not assume the duplicated-CoT fix is "turn it off" without explicit direction.

### Extension: `index.js`

The extension now supplies content, not the wrapper.

- `_nudge` injects the active reasoning mode for the current turn using `GRAVITY_REASON_MODE`.
- `_nudge` also states the required post-thinking visible-output order.
- Mode handlers still decide which deduction template is active: `regular`, `combat`, `advance`, or `intimacy`.
- `formatDrawInstruction()` still keeps divination card HTML in visible output rather than reasoning.

## Execution Order

On a fresh turn, the intended flow is:

1. The preset opens `<think>` before any visible output.
2. `Gravity CoT` reads `Gravity_State_View` first.
3. The model reads `GRAVITY_REASON_MODE` from `_nudge`.
4. The preset CoT entry selects the matching built-in protocol.
5. The model processes that protocol once.
6. The model closes `</think>`.
7. Visible output begins.
8. If present, divination card HTML renders first in visible output.
9. Prose follows.
10. Choices render when the active mode asks for them.
11. The response ends with `---STATE---` or `---LEDGER---`.

## Why This Split Exists

This mirrors the Lucid Loom pattern more closely than the older Gravity design.

Old approach:

- `_nudge` told the model to open `<think>`, reason, close `</think>`, then write prose.
- This made the extension responsible for both the wrapper and the deduction schema.

Current approach:

- The preset is the single source of truth for reasoning order.
- The extension only provides the active mode flag and output contract.
- This makes the reasoning step more reusable and less likely to drift between modes.

## Key Rules

The current system expects these rules to hold:

- Deduction happens inside reasoning, not in visible prose.
- Deduction must happen first on a fresh turn.
- Deduction runs exactly once per turn.
- The model should not restart or repeat deduction later in reasoning.
- The model should never emit a visible `---DEDUCTION---` block.
- Divination card HTML, when requested, belongs in visible output, not inside reasoning.
- Continuations should not open a new `<think>` block.

## Related Prompt Pieces

These components work together:

- `gravity_v14.json`
  - CoT trigger prompt
  - Gravity CoT prompt
  - continue nudge telling the model not to restart `<think>`
- `index.js`
  - `GRAVITY_REASON_MODE` injection
  - `_nudge` runtime flags
  - mode-specific OOC injections
  - divination card render instructions
- `Gravity World Info.json`
  - prose layers for `regular`, `combat`, `intimacy`, and `advance`
  - mode-specific length guidance

## What Changed Compared To Earlier v14

The current live contract differs from the earlier prose rollout in a few ways:

- Deduction is no longer described as an extension-owned wrapper.
- The preset now carries a dedicated Lucid Loom-style CoT trigger and a separate Gravity CoT prompt.
- `_nudge` no longer tells the model to open `<think>` itself or carries the checklist structure.
- The extension no longer emits or expects a visible deduction block.

## Current Wrapper Note

The active `Gravity CoT` entry now uses the stronger strategic-analysis wrapper directly.

Current live expectations:

- before anything visible, the model is told to perform a strategic analysis
- the analysis must use the explicit one-pass template inside `<think>`
- after `</think>`, the prompt explicitly tells the model to output the final narrative response and not repeat the strategic analysis

This wording should be preserved unless live testing proves it causes a regression.

## Known Limits

- This depends on the model honoring prompt order and hidden-reasoning instructions.
- Provider/back-end behavior can still vary with `show_thoughts: true`, so live verification still matters.
- Timeskip and chapter-close still use the Prose Kernel rather than dedicated prose WI entries.
- `pc.knowledge_gaps` is still only an `OOC: eval` hint and is not part of this reasoning architecture.

## If You Change This Later

If deduction behavior changes again, update all of these together:

- `gravity_v14.json`
- `index.js`
- `Documentation/project_memory.md`
- this file

If reasoning starts leaking into prose again, check these first:

1. CoT prompt order in `gravity_v14.json`
2. `show_thoughts` behavior in the target backend
3. `_nudge` wording in `index.js`
4. any mode-specific prompt that may be reintroducing visible planning language
