# Phase 2 Comprehensive Audit Checklist

Use this checklist to verify every file in the project against PHASE2-SPEC.md. Hand this to any auditor session as a prompt.

## Runtime Logic
- [ ] **index.js** — All handlers, injection builders, tick logic, proximity checks match spec
- [ ] **index.js** — No references to removed features (chapters, arcs, story_summary, iChing, Yi Jing, hexagram, oracle pipeline, buildAdvanceBeats, 3-phase oracle)
- [ ] **index.js** — Collision lifecycle: only ACTIVE → RESOLVED | CRASHED (no SEEDED, SIMMERING, RESOLVING)
- [ ] **index.js** — Foreshadowing system (APPROACHING ≤80%, IMMINENT ≤50%, CONVERGING ≤20%)
- [ ] **index.js** — Nudge rotation: 7 slots cycling every 4 turns
- [ ] **index.js** — Pressure FIFO-5 cap enforcement
- [ ] **index.js** — Archive: 20-entry cap, hookable entries, dedup hash guard
- [ ] **index.js** — Timeskip multipliers (HOURS+1, DAYS+3, WEEKS+10, MONTHS+20)
- [ ] **index.js** — handleAdvanceButton with lock and preconditions
- [ ] **state-compute.js** — Empty state shape includes places and pressures
- [ ] **state-compute.js** — CATEGORY_DISTANCES constant (IMMEDIATE=1, SHORT=10, MEDIUM=20, LONG=50)
- [ ] **state-compute.js** — Collision CR normalization
- [ ] **state-compute.js** — Legacy status migration (SEEDED/SIMMERING/RESOLVING → ACTIVE)
- [ ] **state-compute.js** — validateTravel exported and functional
- [ ] **state-machine.js** — Only ACTIVE → RESOLVED | CRASHED transitions for collisions
- [ ] **state-machine.js** — No chapter states
- [ ] **consistency.js** — VALID_ENTITIES includes 'place' and 'pressure'
- [ ] **consistency.js** — VALID_ENTITIES excludes 'summary'

## UI Layer
- [ ] **ui-panel.js** — Every entity tab renders correct Phase 2 fields
- [ ] **ui-panel.js** — Characters: agenda (not want/doing/condition), relationships, knowledge_asymmetry (knows_X underscore format)
- [ ] **ui-panel.js** — Factions: name, members, territory, state, agenda, knowledge_asymmetry (not objective/resources/power/momentum/leverage/vulnerability/intel_on)
- [ ] **ui-panel.js** — Collisions: location, involved_chars (not details/cost/target_constraint)
- [ ] **ui-panel.js** — World: timeskip_scale, collision_archive displayed
- [ ] **ui-panel.js** — Places tab: reach scale displayed
- [ ] **ui-panel.js** — Pressures tab: compact bullet list, omit when empty
- [ ] **ui-panel.js** — Highlight system: per-card (data-id + data-kind), pressures included
- [ ] **ui-panel.js** — Distance bar uses CATEGORY_DISTANCES denominator
- [ ] **ui-panel.js** — No chapter/arc tab
- [ ] **ui-panel.js** — CRASHED collisions filtered from active pile
- [ ] **ui-panel.js** — Buttons/handlers all wire to live index.js functions
- [ ] **style.css** — Classes exist for pressures, places, archive entities

## Setup & Onboarding
- [ ] **setup-wizard.js** — Generated prompt uses Phase 2 field names only
- [ ] **setup-wizard.js** — Collision examples include location, involved_chars (not details/cost/target_constraint)
- [ ] **setup-wizard.js** — Char examples include agenda (not want/doing/intimacy_stance)
- [ ] **setup-wizard.js** — Faction examples match spec §2.3 schema
- [ ] **setup-wizard.js** — PLACES section present
- [ ] **setup-wizard.js** — Pressure examples present
- [ ] **setup-wizard.js** — knowledge_asymmetry uses underscore keys (knows_X not knows.X)
- [ ] **setup-wizard.js** — No references to removed features

## Prompt Engineering
- [ ] **gravity_v15.json** (or latest preset) — System prompt matches Phase 2 schema
- [ ] **gravity_v15.json** — Command reference includes pressure and place commands
- [ ] **gravity_v15.json** — No chapter/iChing/exchange references
- [ ] **gravity_v15.json** — exchange→clash terminology
- [ ] **Gravity World Info.json** — No hexagram/iChing lorebook entries active
- [ ] **Gravity World Info.json** — Chapter-close entry disabled
- [ ] **Gravity World Info.json** — All active entries use Phase 2 terminology

## Intercepts & Validation
- [ ] **regex-intercept.js** — Correction injection surfaces fix suggestions correctly
- [ ] **regex-intercept.js** — No references to removed features
- [ ] **challenge-profile-combat.js** — exchange removed from seedFields
- [ ] **challenge-profile-combat.js** — No runtime exchange leak
- [ ] **challenge-profile-combat.js** — Uses "clash" not "exchange"

## Test Data
- [ ] **test-import-ffvii.json** — Collisions use Phase 2 schema
- [ ] **test-import-ffvii.json** — pressure_points→pressure entities
- [ ] **test-import-ffvii.json** — No stale fields

## Documentation
- [ ] **CLAUDE.md** — Entity lists match Phase 2
- [ ] **CLAUDE.md** — Collision states: only ACTIVE, RESOLVED, CRASHED
- [ ] **CLAUDE.md** — No oracle pipeline docs
- [ ] **AGENTS.md** — Updated entity types and states
- [ ] **AGENTS.md** — No removed feature references

## Cross-cutting (grep entire project)
- [ ] No "chapter" references (except in git history/changelogs)
- [ ] No "arc" entity references
- [ ] No "story_summary" references
- [ ] No "iChing" or "Yi Jing" or "hexagram" references
- [ ] No "oracle pipeline" or "3-phase oracle" references
- [ ] No "SEEDED" status references (except in migration code)
- [ ] No "SIMMERING" status references (except in migration code)
- [ ] No "RESOLVING" status references (except in migration code)
- [ ] No "exchange" where "clash" is meant (except git history)
- [ ] No "intel_on" (replaced by knowledge_asymmetry)
- [ ] No "want"/"doing" as char fields (replaced by agenda)
- [ ] No "condition" as char field
- [ ] No "intimacy_stance"
- [ ] No "world.constants"
- [ ] No "buildAdvanceBeats"
- [ ] All entity fields match spec §2.1-§2.6
- [ ] All state transitions match spec §5
