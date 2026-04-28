# CLAUDE.md — Repo Root

This repo holds the Gravity Ledger project plus the in-progress port to Marinara Engine. The layout below is the orientation map; per-area guidance lives in subdirectory CLAUDE.md files (Claude Code auto-loads those when you work under those paths).

## Top-level layout

```
Gravity-Extension/                    (repo root — you are here)
├── ST/                               SillyTavern extension — all extension code lives here
│   └── CLAUDE.md                     extension-specific guidance (read when editing extension code)
├── Marinara Engine/
│   └── Marinara-Engine/              active Marinara fork (gitignored from outer repo; tracks its own commits on `gravity-integration`)
├── docs/
│   └── superpowers/                  cross-cutting design specs and plans
│       ├── specs/                    architecture specs (current direction: 2026-04-26-gravity-marinara-embedded-design.md)
│       └── plans/                    multi-step implementation plans
├── gravity_v15.json                  preset asset (deliverable)
└── Gravity World Info.json           lorebook asset (deliverable)
```

## What's where

- **ST/** is the active SillyTavern extension. Pure JS, no build step, runs in ST's browser context. See `ST/CLAUDE.md` for architecture, conventions, validation commands.
- **Marinara Engine/Marinara-Engine/** is the **active Marinara fork** for the embedded port (`marinara-engine` v1.5.5, AGPL-3.0; origin = `Pasta-Devs/Marinara-Engine`). Working branch: `gravity-integration`. Gitignored from the outer Gravity-Extension repo, but it has its own `.git/` and tracks its own commits. All Marinara-side integration work (Tasks 2–13 of the embedded plan) happens here. There is no separate fork clone — this directory is the fork.
- **docs/superpowers/** holds cross-cutting design work that spans both the extension and the Marinara port. The current selected direction for the port is `docs/superpowers/specs/2026-04-26-gravity-marinara-embedded-design.md` (embedded path; the standalone-service alternative at `2026-04-21-gravity-marinara-port-design.md` was rejected).
- **Root JSON files** (`gravity_v15.json`, `Gravity World Info.json`) are the user-facing deliverables — installable in SillyTavern directly.

## Active work

- Outer repo branch: `mari-integration` (branched from `director-prototype` on 2026-04-26) — holds engine extraction (Task 1, complete), specs, plans, handoff docs.
- Fork branch: `gravity-integration` inside `Marinara Engine/Marinara-Engine/` (off main, created 2026-04-26) — holds Tasks 2–13 (agent registration, DB schema, TS engine port, agent dispatch, etc.).
- Goal: port the Gravity engine into Marinara as two built-in agents (`gravity-ledger-inject` pre_generation, `gravity-ledger-director` post_processing) sharing a TS-ported engine module. See the embedded spec for the coupling surface and migration sequence.

## Conventions for this repo root

- Don't put extension code at the root. It belongs in `ST/`.
- `Marinara Engine/Marinara-Engine/` is the active fork — edit it freely, but its commits land in its own `.git/` (separate from the outer repo). Run `pnpm check` in that dir after each Marinara-side task. Stay on the `gravity-integration` branch unless the user says otherwise.
- Specs and plans go under `docs/superpowers/`. Per-area handoffs and architecture docs stay under their owning area (e.g., `ST/Documentation/`).
- Use `git log --follow` when tracing the history of files moved during the 2026-04-26 reorg.
