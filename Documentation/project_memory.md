# Project Memory

Updated: 2026-04-02 10:38:00 +08:00

Durable working memory for Codex sessions in this repository. Update this file when system behavior, active design decisions, or important constraints change.

## Current State

- Gravity Ledger remains a pure-JS SillyTavern extension with no build step, tests, or CI.
- Validation is still syntax-only: run `node -c` on every modified `.js` file and parse-check modified JSON files.
- `index.js` remains the central coordinator for prompt injection, turn flow, collision resolution, pressure-point audits, and UI wiring.
- `gravity_v14.json` plus `Gravity World Info.json` now own sentence-level prose behavior and mode-specific length guidance.
- Gravity deduction now lives in the model's hidden reasoning/thinking pass. The extension no longer asks for a visible `---DEDUCTION---` block in normal responses.
- `gravity_v14.json` now uses a dedicated `| Gravity CoT` entry with a literal `<think>...</think>` block. The older helper trigger entry is still present in the preset file but currently disabled. On fresh turns the model must open `<think>`, pick the matching mode protocol there, close `</think>`, and only then emit visible output.
- A first-pass duplicated-CoT cleanup is now in place: the kernel no longer restates the CoT output procedure, and convergence prompts no longer ask for an explicit visible declaration before the scene.
- Live verification is still needed because the duplicated-CoT symptom was observed in actual play, not in an in-repo test harness. See `Documentation/handoff_2026-04-02_012931_SGT_cot_followup.md`.
- The live `| Gravity CoT` prompt now explicitly says "Before anything else you must perform a strategic analysis," requires a one-pass fixed template inside `<think>`, and ends with `(output final narrative response. DON'T WRITE THE STRATEGIC ANALYSIS AGAIN)`. Treat that exact wrapper as the active CoT contract.
- User preference: keep `show_thoughts: true`. Do not treat flipping it to `false` as the default CoT fix path unless the user explicitly asks to test that change.
- Setup and runtime state were trimmed aggressively. Live setup now authors the opening arc, optional combat rules, and optional PC starting power. The extension no longer authors `story_kind`, `guidelines`, `voice`, `tone`, `length`, `motivation`, `objective`, or `knowledge_asymmetry`.
- `world.constants.combat_rules` is the only actively surfaced setup-authored world constant in the current extension contract.
- Good-turn exemplar tagging now preserves the real completed turn mode through `_lastCompletedMode`, so combat/intimacy/advance exemplars are not silently recorded as regular.

## Prose Architecture

- Always-on prose authority lives in the preset: Prose Kernel, active Group 5 prose style, Character Voice, and Dossier-Driven Prose.
- The preset now owns the hidden reasoning wrapper, first-step ordering, and all mode-specific deduction protocols. The `_nudge` slot only injects runtime flags such as `GRAVITY_REASON_MODE` plus post-thinking output order.
- Divination HTML card reveals are explicitly instructed to stay in visible output before the prose scene, never inside hidden reasoning.
- Mode-specific prose lives in World Info entries:
  - `gravity_prose_regular`
  - `gravity_prose_combat`
  - `gravity_prose_intimacy`
  - `gravity_prose_advance`
- Timeskip and chapter-close are structural modes and currently fall back to the Prose Kernel rather than using dedicated prose World Info keys.
- Length guidance now lives in World Info mode prose entries rather than extension prompts or preset-side length controls.

## State Modeling Notes

- Collision live statuses are `SEEDED -> SIMMERING -> ACTIVE -> RESOLVING -> RESOLVED`.
- Closure outcomes remain `DIRECT`, `EVOLVED`, `MERGED`, `IMPLODED`, and `CRASHED`.
- Pressure points still live in `world.pressure_points` as short world seams with lifecycle history recorded in `_history`.
- Story identity no longer lives in runtime state. Use scenario/card context, preset guidance, and mode playbooks instead of `world.constants.story_kind`.
- World-level `knowledge_asymmetry` is effectively deprecated. The live system expresses asymmetry through:
  - `char.reads`
  - `noticed_details`
  - summary residue
  - collisions and their costs
- There is no universal `blindspots` field in the current schema.
- `pc.knowledge_gaps` is mentioned by `OOC: eval`, but it is not rendered or reinforced elsewhere yet. Treat it as orphaned guidance until it is either implemented properly or removed.

## UI and Prompt Notes

- `state-view.js` now surfaces only active world constants, which currently means `combat_rules`.
- `ui-panel.js` hides legacy constants from older saves so deprecated setup fields do not keep resurfacing in the interface.
- The world panel no longer renders a `knowledge_asymmetry` section.
- Intimacy prose guidance explicitly uses relational asymmetry and misread via the `reads` map rather than a dedicated knowledge-asymmetry state field.

## Documentation Layout

- Active durable memory file: `Documentation/project_memory.md`
- Archived memory and older planning docs: `Documentation/Old/`
- Existing prose rollout handoff: `Documentation/v14_prose_architecture_handoff.md`
- Current reasoning-flow reference: `Documentation/deduction_cot_architecture.md`

## Important Files

- `index.js` - runtime orchestration, prompt injection, audits, and button flows
- `state-compute.js` - replay logic and history tracking
- `state-view.js` - prompt state and readme output
- `ui-panel.js` - panel rendering and world/collision inspection UI
- `setup-wizard.js` - setup prompt contract
- `ooc-handler.js` - eval/history/consolidate prompts
- `gravity_v14.json` - active preset with prose kernel and dossier-driven layers
- `Gravity World Info.json` - active mode playbooks and prose modulation entries

## Suggested Next Focus

- Decide whether to formalize `pc.knowledge_gaps` as a real feature or remove it from `OOC: eval`.
- If explicit asymmetry tracking is needed, start with PC-only knowledge gaps or optional blindspots for major recurring characters rather than adding blindspots to every character.
- Clean up remaining mojibake in docs and some source comments when it becomes worth a dedicated pass.
- Live-test the duplicated-CoT cleanup and verify every mode path (`regular`, `combat`, `advance`, `intimacy`, and integration flows) enters the preset CoT once with the correct mode.

## Update Rule

When major behavior changes land, update this file in the same change if the new behavior would matter to a future Codex session.
