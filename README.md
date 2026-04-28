# Gravity-Extension

Repository for the **Gravity Ledger** project — a deterministic state-tracking system for narrative roleplay. This repo holds:

- The original SillyTavern extension (`ST/`)
- Cross-cutting design specs and plans (`docs/superpowers/`)
- User-facing preset and lorebook deliverables (`gravity_v15.json`, `Gravity World Info.json`)
- Per-area orientation in `CLAUDE.md` files (root + `ST/`)

The active Marinara Engine port lives in a **separate repository** (a fork of upstream Marinara) and is referenced from this repo as a gitignored subdirectory at `Marinara Engine/Marinara-Engine/`.

## Setup

To work on the full system (outer repo + Marinara port), clone both:

```bash
# 1. Clone the outer repo (specs, plans, ST extension, deliverables)
git clone -b mari-integration https://github.com/yankeeangelonero-hub/Gravity-Extension.git
cd Gravity-Extension

# 2. Clone the Marinara fork into the gitignored subdirectory
git clone -b gravity-integration https://github.com/yankeeangelonero-hub/Marinara-Engine.git "Marinara Engine/Marinara-Engine"

# 3. Add upstream Marinara as a remote in the fork (for future updates)
cd "Marinara Engine/Marinara-Engine"
git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine.git

# 4. Install and initialize Marinara
pnpm install
pnpm db:push
pnpm dev
```

After step 2 the layout matches the development setup:

```
Gravity-Extension/                    (outer repo, branch: mari-integration)
├── ST/                               SillyTavern extension
├── Marinara Engine/
│   └── Marinara-Engine/              fork of Pasta-Devs/Marinara-Engine
│                                     branch: gravity-integration
│                                     (gitignored from outer repo)
├── docs/superpowers/                 specs and plans
├── gravity_v15.json                  preset deliverable
└── Gravity World Info.json           lorebook deliverable
```

## What lives where

- **Outer repo** (this repo): documentation, the standalone SillyTavern extension, design specs, and the user-facing JSON deliverables.
- **Marinara fork** (`Marinara Engine/Marinara-Engine/`): the actual integration code — Gravity engine, agents, server routes, client UI, DB schema. Tracks upstream Marinara via the `upstream` remote.

The two repos are independent — `git push`/`pull` in one does not affect the other. The outer repo's `.gitignore` excludes `Marinara Engine/` to keep the histories clean.

## Pulling upstream Marinara updates

The fork tracks `Pasta-Devs/Marinara-Engine` via the `upstream` remote. To pull in new vanilla Marinara commits:

```bash
cd "Marinara Engine/Marinara-Engine"
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin gravity-integration
```

Conflicts may surface at the integration touch-points (agent registration, route registration, schema re-exports, drawer mount). The fork's diff is deliberately narrow to keep these manageable.

## Standalone SillyTavern extension

The `ST/` directory is a fully working SillyTavern extension that does not depend on the Marinara port. See `ST/CLAUDE.md` for its architecture and `ST/Documentation/` for usage documentation.

## License

The SillyTavern extension and design materials in this repo are licensed under the project's terms (see individual files for details). The Marinara fork is licensed under **AGPL-3.0**, matching upstream — see `Marinara Engine/Marinara-Engine/LICENSE` and `Marinara Engine/Marinara-Engine/GRAVITY-INTEGRATION.md` for the fork's license terms.

## Relationship to upstream Marinara

The Marinara fork at `yankeeangelonero-hub/Marinara-Engine` is a courtesy fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine). The fork's `main` branch mirrors upstream; the `gravity-integration` branch carries this project's additions. AGPL-3.0 license terms apply.
