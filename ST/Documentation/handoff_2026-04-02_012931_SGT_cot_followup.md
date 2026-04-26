# Handoff: CoT Still Running Twice

**Timestamp:** 2026-04-02 01:29:31 +08:00  
**Branch:** `codex-v13-state-delta`  
**Latest relevant commit:** `0dd66a4` (`Move deduction protocols into preset`)

## Problem

Gravity's deduction protocol was moved into the preset, but the model is still behaving like it has two reasoning passes.

Observed symptom from live use:

- visible planning text appears before the actual `<think>` block
- or the model appears to plan once, then open `<think>` and plan again

Example shape:

- visible text like `Let me run the Gravity deduction pass...`
- then a literal `<think>...</think>` block

That means the "reasoning only once, first, and never in prose" contract is still not holding reliably.

## What Changed Right Before This

The latest refactor moved the mode-specific deduction schema into the preset CoT entry:

- `gravity_v14.json`
  - `| CoT Triggers (Gem/Claude)`
  - `| Gravity CoT`
- `index.js`
  - `_nudge` now injects `GRAVITY_REASON_MODE`
  - extension-side deduction templates were removed

Current design intent:

1. preset opens `<think>`
2. preset reads `GRAVITY_REASON_MODE`
3. preset runs the matching deduction protocol once
4. preset closes `</think>`
5. visible output begins

## Current Suspects

### 1. `show_thoughts` is still `true`

`gravity_v14.json:34`

This may still be causing or encouraging a provider-level thought channel in parallel with the prompt-level `<think>` block.

The user believes this setting should be advisory only, so do not assume this is the sole cause without testing. But it remains an active suspect.

### 2. The preset still has more than one live reasoning instruction source

Relevant places:

- `gravity_v14.json:77`
  - `| Gravity CoT`
  - now owns the real deduction protocol
- `gravity_v14.json:515`
  - `| L2 - Gravity Kernel`
  - still says fresh-turn order is mandatory: open `<think>`, run full deduction, close `</think>`

This may be harmless reinforcement, or it may be encouraging a second planning pass depending on model behavior.

### 3. Runtime prompts still contain leftover reasoning-language hooks

Relevant places in `index.js`:

- `index.js:973`
  - `State your choice explicitly at the start of your reasoning deduction pass`
- `index.js:1585`
  - `After the scene, resume hidden deduction + prose + STATE updates`

The intimacy line is especially suspicious because it explicitly says to resume deduction after the scene.

### 4. Other modes may not be selecting or triggering CoT correctly

Mode flag writes:

- `index.js:1317` - intimacy follow-up
- `index.js:1380` - advance
- `index.js:1478` - combat
- `index.js:1543` - intimacy button

Runtime handoff:

- `index.js:1037` - `GRAVITY_REASON_MODE: ${reasonMode}`

There is not yet a clean confirmation that every mode is actually entering the preset CoT path once, with the expected mode selected.

## Important State Right Now

- Anchor is still disabled in prompt order:
  - `gravity_v14.json:781` -> `05d1145b...` is `enabled: false`
- CoT prompts are active in prompt order:
  - `gravity_v14.json:737`
  - `gravity_v14.json:741`
- `_nudge` is currently just runtime flags plus output order:
  - `index.js:1036`

So the main architecture move succeeded. The unresolved issue is behavioral, not that the old extension checklist is still present.

## Tomorrow's Fix Plan

### 1. Reproduce on a clean regular turn

Use a simple normal scene, not combat or intimacy first.

Goal:

- confirm whether the model is producing:
  - visible preamble before `<think>`
  - two internal planning sections
  - or a provider thought channel plus literal `<think>`

Capture the raw output exactly.

### 2. Inspect the fully assembled prompt if possible

Need to verify whether the final prompt contains multiple active reasoning instructions that read like separate tasks.

Focus on:

- `| CoT Triggers (Gem/Claude)`
- `| Gravity CoT`
- `| L2 - Gravity Kernel`
- `_nudge`
- active mode prompt

### 3. Check all mode paths, not just regular

The user specifically suspects other modes may be broken or may not be calling CoT correctly.

Test at least:

- regular
- combat
- advance
- intimacy
- intimacy clickable follow-up
- collision arrival / convergence advance cases
- chapter close
- timeskip
- setup / integration

For each one, verify:

- does `<think>` appear exactly once?
- does visible output start only after reasoning closes?
- is `GRAVITY_REASON_MODE` the expected value?
- does the model behave like the matching protocol actually ran?

### 4. Remove or soften leftover duplicate triggers

Strong candidates:

- `index.js:1585`
  - remove `resume hidden deduction`
- `index.js:973`
  - remove or rephrase `start of your reasoning deduction pass`
- `gravity_v14.json:515`
  - consider reducing the Gravity Kernel line so the dedicated CoT prompt remains the only explicit owner of the deduction procedure

### 5. Decide whether `show_thoughts` should really stay `true`

The user currently believes it should not matter.

Still, if prompt cleanup alone does not fix the issue, test one comparison pass with:

- `show_thoughts: true`
- `show_thoughts: false`

Do not change it permanently without checking behavior, but keep it in the test matrix.

## Suggested First Patch Tomorrow

If starting with the safest cleanup first, do this order:

1. remove `resume hidden deduction` from intimacy runtime prompt
2. remove `start of your reasoning deduction pass` wording from convergence runtime prompt
3. simplify the Gravity Kernel so only `Gravity CoT` owns the explicit procedure
4. re-test regular, advance, combat, intimacy

If the duplicate thinking persists after that, revisit `show_thoughts`.

## Success Criteria

Tomorrow's fix is done when all of these are true:

- no visible planning text before `<think>`
- only one reasoning pass on fresh turns
- no second reasoning restart after prose begins
- regular/combat/advance/intimacy all select the correct protocol
- integration modes do not silently bypass or break the CoT path

## Files To Start With

- `gravity_v14.json`
- `index.js`
- `Documentation/deduction_cot_architecture.md`
- `Documentation/project_memory.md`
