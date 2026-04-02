# Project Memory

Updated: 2026-04-03 00:25:06 +08:00

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
- The live `| Gravity CoT` prompt now also includes a short style handoff: visible prose must obey the active preset prose style and any active mode prose lorebook entry for the turn. Keep style-specific policing mostly in the prose layers, not the CoT checklist.
- User preference: keep `show_thoughts: true`. Do not treat flipping it to `false` as the default CoT fix path unless the user explicitly asks to test that change.
- Reason mode now persists across `GENERATION_STARTED` re-injections. This fixes special-turn desync where `[GRAVITY ADVANCE]` / combat / intimacy OOC guidance could still be active while `GRAVITY_REASON_MODE` silently fell back to `regular`.
- Setup and runtime state were trimmed aggressively. Live setup now authors the opening arc plus the combat power doctrine: `world.constants.power_scale`, `world.constants.power_ceiling`, optional `world.constants.power_notes`, and the PC's `power_base`, `power`, `power_basis`, and `abilities`. The extension no longer authors `story_kind`, `guidelines`, `voice`, `tone`, `length`, `motivation`, `objective`, or `knowledge_asymmetry`.
- The old `world.constants.combat_rules` / `gravity_combat_rules` path is retired. Combat power now uses structured state rather than freeform rules text.
- `power` is now the current effective combat rating, `power_base` is the earned healthy rating, `power_basis` explains why the number is justified, and `abilities` describe how that rating manifests in action.
- `OOC: power review pc|char:id|all` is now the supported re-judgment path when injuries, growth, gear changes, or new evidence should change combat power.
- Combat runtime is now live as a chat-metadata state machine in `combat-state.js`, with a dedicated `_combat` injection slot in `index.js`.
- The active combat loop now supports setup/options/resolution/reassessment/cleanup phases, option clicks (`combat: option | ...`), `option N`, and explicit custom actions (`combat: custom | ...`).
- Combat baseline math now resolves from current `power` in the extension, using difficulty modes plus `d20` and fresh draw payloads for the middle three categories; `Absolute` and `Impossible` are explicit no-roll paths.
- `ui-panel.js` now has a dedicated Combat section with runtime visibility and difficulty controls.
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

- `state-view.js` now surfaces active power constants (`power_scale`, `power_ceiling`, `power_notes`) plus power profile fields (`power`, `power_base`, `power_basis`, `abilities`) for the PC and tracked characters.
- `state-view.js` now also documents and surfaces `combat:*` entities in the prompt-facing state contract.
- `ui-panel.js` hides legacy constants from older saves so deprecated setup fields do not keep resurfacing in the interface.
- The world panel no longer renders a `knowledge_asymmetry` section.
- Intimacy prose guidance explicitly uses relational asymmetry and misread via the `reads` map rather than a dedicated knowledge-asymmetry state field.

## Documentation Layout

- Active durable memory file: `Documentation/project_memory.md`
- Archived memory and older planning docs: `Documentation/Old/`
- Existing prose rollout handoff: `Documentation/v14_prose_architecture_handoff.md`
- Current reasoning-flow reference: `Documentation/deduction_cot_architecture.md`
- `Documentation/gravity_character_card_template.md` now includes optional prewrite prompts plus a holistic card/scenario/lorebook split. Keep the card focused on dramatic behavior, the scenario focused on current relationship and structural tension, and the lorebook focused on reference/canon overflow rather than turning the card into a wiki page.

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
