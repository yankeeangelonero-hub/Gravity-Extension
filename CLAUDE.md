# CLAUDE.md — Repo Root

This repo holds the Gravity Ledger project plus the in-progress port to Marinara Engine. The layout below is the orientation map; per-area guidance lives in subdirectory CLAUDE.md files (Claude Code auto-loads those when you work under those paths).

## Top-level layout

```
Gravity-Extension/                    (repo root — you are here)
├── ST/                               SillyTavern extension — all extension code lives here
│   └── CLAUDE.md                     extension-specific guidance (read when editing extension code)
├── Marinara Engine/
│   └── Marinara-Engine/              cloned reference monorepo (READ-ONLY — do not modify, gitignored)
├── docs/
│   └── superpowers/                  cross-cutting design specs and plans
│       ├── specs/                    architecture specs (current direction: 2026-04-26-gravity-marinara-embedded-design.md)
│       └── plans/                    multi-step implementation plans
├── gravity_v15.json                  preset asset (deliverable)
└── Gravity World Info.json           lorebook asset (deliverable)
```

## What's where

- **ST/** is the active SillyTavern extension. Pure JS, no build step, runs in ST's browser context. See `ST/CLAUDE.md` for architecture, conventions, validation commands.
- **Marinara Engine/Marinara-Engine/** is a clone of the Marinara Engine monorepo (`marinara-engine` v1.5.5, AGPL-3.0). It exists as **read-only reference** for the embedded port — types, agent pipeline, provider interface. Gitignored; never commit changes inside it. The actual Marinara fork happens later, in a separate clone.
- **docs/superpowers/** holds cross-cutting design work that spans both the extension and the Marinara port. The current selected direction for the port is `docs/superpowers/specs/2026-04-26-gravity-marinara-embedded-design.md` (embedded path; the standalone-service alternative at `2026-04-21-gravity-marinara-port-design.md` was rejected).
- **Root JSON files** (`gravity_v15.json`, `Gravity World Info.json`) are the user-facing deliverables — installable in SillyTavern directly.

## Active work

- Branch: `mari-integration` (branched from `director-prototype` on 2026-04-26).
- Goal: port the Gravity engine into Marinara as two built-in agents (`gravity-ledger-inject` pre_generation, `gravity-ledger-director` post_processing) sharing a TS-ported engine module. See the embedded spec for the coupling surface and migration sequence.
- Per the spec's §11, step 1 (engine extraction in this repo, host-agnostic) happens before any Marinara fork.

## Conventions for this repo root

- Don't put extension code at the root. It belongs in `ST/`.
- Don't edit anything under `Marinara Engine/` — treat it like vendored source.
- Specs and plans go under `docs/superpowers/`. Per-area handoffs and architecture docs stay under their owning area (e.g., `ST/Documentation/`).
- Use `git log --follow` when tracing the history of files moved during the 2026-04-26 reorg.
