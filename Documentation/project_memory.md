# Project Memory

Updated: 2026-04-03 16:02:00 +08:00

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
- The active combat loop now supports setup/options/resolution/reassessment/cleanup phases through a `combat:` prefix flow. The Combat button inserts `combat: `, numbered options can be chosen with `combat:2`, and declared actions use `combat: <freeform action> DC <category>`.
- Setup-phase combat clicks are now buffered instead of dropped. If the player commits to an option before the combat entity exists, the next `_combat` prompt now says to finish setup and then resolve the buffered action, rather than restarting setup or reusing the spawn draw as the action roll.
- Combat baseline math now resolves from current `power` in the extension, using difficulty modes plus `d20` and fresh draw payloads for the middle three categories; `Absolute` and `Impossible` are explicit no-roll paths.
- Combat rolls are now framed as `SUCCESS`, `TRANSFORM`, `CRITICAL_SUCCESS`, and `CRITICAL_TRANSFORM`. Low rolls are not ordinary failure states.
- Combat setup no longer inherits the global divination `NARRATIVE_FORCING` instruction. The spawn draw is now stripped and re-framed inside `_combat` to reveal circumstance, leverage, spacing, exposure, and why the opening options sit at their assessed categories.
- Combat resolution now states the mechanical result explicitly in `_combat`. The prompt now says that only the `d20` is compared to the live threshold and the draw is interpretive only.
- Combat difficulty is now framed as extension-owned success thresholds rather than bare prompt-side DC numbers. `_combat` injects the active thresholds and the live action threshold, and the prompt assets now tell the model to trust those injected numbers as canonical.
- `ui-panel.js` now has a dedicated Combat section with runtime visibility plus synced difficulty controls in both the Combat section and the top command bar.
- Combat now runs through the generic challenge engine (`challenge-state.js`) with the combat facade (`combat-state.js`) preserved for UI/backward compatibility.
- The combat prompt contract now uses `CHALLENGE_INPUT`, `CHALLENGE_MECHANICS`, and `CHALLENGE_TASK`. Older `COMBAT_*` packet language in prompt assets was replaced.
- Setup is now split into `setup_opening` and `setup_buffered` in runtime state. Scene draws stay active through setup and expire only once setup successfully exits into live exchange play.
- If the player does not declare a combat difficulty category, the runtime is intentionally assess-first, not resolve-first: the model should convert the move into options and option 1 should capture the player's intent with the assessed category.
- Challenge options now carry stamped ids plus an `option_table_version` internally so the runtime can track option tables more safely across turns.
- Custom combat thresholds now work through challenge settings (`mode = Custom` plus `custom_dcs`) instead of silently falling back to the default table.
- The extension now rewrites duplicate `create` operations targeting the already-seeded active challenge entity into field updates before commit. This protects the seeded combat container from being overwritten if the model tries to recreate it.
- When locked challenge input cannot be resolved to a stored option, the runtime now records the failed input instead of leaving stale `CHALLENGE_INPUT` in prompt state.
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
- The panel command bar now exposes combat difficulty directly, with a live threshold summary (`HL`, `Avg`, `HU`) synced to chat metadata.
- The world panel no longer renders a `knowledge_asymmetry` section.
- Intimacy prose guidance explicitly uses relational asymmetry and misread via the `reads` map rather than a dedicated knowledge-asymmetry state field.
- Player-supplied manual divination rolls are now supported as a one-shot override:
  - `1d22 = 17` / `rolled 17 on 1d22` feeds the next Arcana draw
  - `2d10 = 13` feeds the next Classic draw
  - `1d64 = 37` feeds the next I Ching draw
  - the manual result is consumed by the next `drawDivination()` call and rendered as canonical divination input instead of a fresh extension roll
- Assistant `---STATE---`, `---LEDGER---`, and any visible deduction/debug blocks are no longer stripped from the chat message after parsing.
  - The extension now parses against a cleaned local copy while leaving the raw assistant output visible for debugging.
- Character dossiers now include `knowledge_asymmetry` for KNOWN / TRACKED / PRINCIPAL characters.
  - Use it as the active knowledge firewall: what a character knows, does not know, is hiding, or is misreading right now.
  - `state-view.js` now surfaces it in the prompt-facing character registry and documents `char:id.knowledge_asymmetry` in the quick reference.
  - If the protagonist is mirrored as both `pc` and `char:<id>`, keep the mirrored `char:<id>` dossier current too. `pc.*` is the immediate body/scene surface; `char:<id>.*` is the social/knowledge dossier.
- Lightweight information-propagation support is now in place:
  - important characters also carry `last_seen_at`
  - factions can carry `comms_latency`, `last_verified_at`, `intel_posture`, `blindspots`, `intel_on`, and `false_beliefs`
  - this is intentionally a snapshot model, not a live simulation
  - remote factions/NPCs should only learn things through plausible channels such as witness, report, sensor contact, debrief, or justified inference
  - when a character re-enters scene after time away, refresh their `knowledge_asymmetry` from `last_seen_at`, summary residue, and current faction intel instead of globally synchronizing everyone every turn
- The intel/provenance rule is now injected in both layers:
  - runtime nudge in `index.js`
  - hidden deduction CoT in `gravity_v14.json` for `regular`, `combat`, `advance`, and `intimacy`
  - mode playbooks in `Gravity World Info.json` for `advance`, `combat`, and `intimacy`
  - preset/state guidance now explicitly treats remote factions as delayed, partial, and sometimes wrong rather than live-omniscient

## Challenge Engine Notes

- The generic challenge runtime now has extracted helper modules:
  - `challenge-shared.js` for shared text/clone/draw helpers
  - `challenge-mechanics.js` for categories, thresholds, and roll math
  - `challenge-input.js` for command, option, and custom-action parsing
- `challenge-state.js` remains the orchestrator, but no longer owns the generic parsing/math helper implementations directly.
- Combat-specific category aliases (`likely`, `unlikely`, `standard`, `even`, `auto success`, `auto fail`) now live on the combat profile via `categoryAliases` instead of hard-coded `profile.kind === 'combat'` logic in the engine.
- The challenge task packet is cleaner on resolution turns:
  - `MUST_OUTPUT_OPTIONS` is now reserved for setup/assessment turns
  - `OUTPUT_OPTIONS_IF_CONTINUES` covers follow-up options after a resolved exchange
- `challenge-profile-combat.js` now uses `validateTurn()` conservatively after setup to catch missing `hostiles`, `primary_enemy`, or `situation` on the combat container.
- Stable option ids are now actually honored on selection:
  - the engine resolves option picks against the stored option table by id first
  - stale raw parsed click payloads no longer bypass stored option state
- Profile validation now runs on the main active post-setup paths, including setup exits, awaiting choice, awaiting resolution, and awaiting reassessment.
- Challenge option recovery is now more tolerant when a player picks from an assessed option set:
  - `challenge-input.js` now parses clickable `<span class="act" ...>` options even if attributes are reordered or single-quoted
  - if the model prints plain numbered options like `3. Mark the Blitz (Average)` instead of valid clickable spans, the engine can now recover those as a fallback option table too
  - `challenge-state.js` will rehydrate a missing option table from the latest assistant message before resolving an option pick
  - this prevents assessed actions from getting stuck in `ASSESSMENT_ONLY` just because the prior options rendered but were not stored cleanly
- `challenge-state.js` got one more cleanup pass:
  - duplicated option-selection input record construction now lives in shared helpers
  - repeated “clear pending state and return to awaiting_choice” transitions now use a shared helper
  - repeated “store parsed options, persist runtime, then validate” flow now uses a shared helper
  - behavior should be unchanged; this was a maintainability pass to reduce duplicated logic before adding another profile
- The engine is modular enough for combat-adjacent profiles, but a future second profile should still be used to validate the abstraction before adding a more asymmetric context like intimacy.

## Documentation Layout

- Active durable memory file: `Documentation/project_memory.md`
- Archived memory and older planning docs: `Documentation/Old/`
- Current combat behavior reference: `Documentation/combat_runtime_reference.md`
- Knowledge asymmetry / faction intel handoff: `Documentation/knowledge_asymmetry_system_handoff.md`
- Current challenge-engine implementation spec: `Plan/challenge-engine-implementation-spec.md`
- Challenge-engine cleanliness review gate: `Plan/challenge-engine-implementation-spec.md` (`Cleanliness Checklist`)
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
