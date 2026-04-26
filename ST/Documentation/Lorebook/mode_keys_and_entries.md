# Lorebook Mode Keys And Entries

This file maps the current live World Info keys in `Gravity World Info.json`.

## Entry Groups

| Order | Key | Purpose |
|---|---|---|
| 100 | `gravity_mode_advance_core` | Core advance-mode gameplay guidance |
| 110 | `gravity_mode_advance_optional_examples` | Optional advance examples |
| 100 | `gravity_mode_combat_core` | Core combat-mode gameplay guidance |
| 100 | `gravity_mode_combat_setup_core` | Combat setup guidance |
| 110 | `gravity_mode_combat_optional_examples` | Optional combat examples |
| 100 | `gravity_mode_intimacy_core` | Core intimacy-mode gameplay guidance |
| 110 | `gravity_mode_intimacy_optional_examples` | Optional intimacy examples |
| 100 | `gravity_mode_timeskip_core` | Core timeskip guidance |
| 100 | `gravity_mode_chapter_close_core` | Core chapter-close guidance |
| 120 | `gravity_prose_regular` | Regular-turn prose modulation |
| 120 | `gravity_prose_combat` | Combat prose modulation |
| 120 | `gravity_prose_intimacy` | Intimacy prose modulation |
| 120 | `gravity_prose_advance` | Advance prose modulation |
| 130 | `gravity_prose_intimacy` | Intimacy NSFW stacking layer |

## Structure Rules

- Keep gameplay-mode entries separate from prose entries.
- Keep optional examples separate from core instructions so they can be trimmed or replaced without rewriting the core mode contract.
- The intimacy NSFW layer intentionally shares the `gravity_prose_intimacy` key so it stacks with the base intimacy prose entry.
- Timeskip and chapter-close currently use dedicated gameplay entries but do not have dedicated prose entries.

## Ownership Reminder

- The extension decides which lorebook keys fire.
- The preset provides always-on voice and hidden reasoning.
- The lorebook provides mode-specific modulation once the extension fires the key.

## Change Triggers

If you rename, add, remove, or reorder lorebook entries:

1. Update this file.
2. Update `Documentation/project_memory.md`.
3. Update `Documentation/Shared/prompt_stack.md`.
4. Check `index.js` for matching trigger-key changes.
