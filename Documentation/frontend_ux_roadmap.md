# Frontend UX Roadmap

## Goal

Build more front end only where it increases trust, speed, and inspectability for Gravity Ledger.

The right target is not "our own app."
The right target is a stronger extension-native operator console inside SillyTavern.

## Recommendation

Invest in frontend work, but keep it:

- extension-native
- pure JS
- no build step
- focused on explainability and workflow

Do not build a separate SPA, desktop shell, or backend service unless the extension model itself becomes the bottleneck.

## Why This Is Worth Doing

The repo already has most of the raw ingredients:

- `ui-panel.js` already renders a multi-tab inspection panel and command bar
- `state-compute.js` already stores field-level and array-item history
- `ui-panel.js` already tracks changed keys between turns
- the main open product problem is understanding why state changed, not lack of raw state data

That means the highest-ROI UI work is not a prettier shell.
It is a clearer explanation layer over the state machine.

## Product Thesis

The frontend should answer four questions quickly:

1. What changed this turn?
2. Why does this collision or pressure point exist?
3. What should I do next?
4. Is the ledger healthy or drifting?

If a new UI feature does not help with one of those questions, it is probably not worth building yet.

## Non-Goals

- replacing the SillyTavern chat surface
- adding React, Vite, npm, or a build pipeline
- turning the panel into a full CRUD editor for canonical state
- moving source of truth out of `chatMetadata`
- creating a separate local server or database

## Roadmap

## Phase 1: Explainability First

This is the best first investment.

### 1. Turn Activity Rail

Add a compact "what changed" strip near the top of the panel after each committed turn.

Show:

- created or resolved collisions
- distance changes
- pressure points added, removed, or likely escalated
- major character status changes
- chapter transitions
- stale/eval warning state

Implementation direction:

- reuse `_changedKeys`, `_prevState`, `_lastState`, and `_lastCommitTxIds` from `ui-panel.js`
- add a small formatter that groups low-level field changes into human-readable events
- add jump links from each event to the relevant tab/card

Why it matters:

- reduces hunting across tabs
- makes the ledger feel alive and legible
- gives immediate confidence after a turn lands

### 2. "Why This Exists" Cards

Add an explainability card for collisions and pressure points.

For collisions, show:

- thread
- forces
- cost
- target constraint
- latest manifestation
- recent status and distance history
- parent/successor lineage when present

For pressure points, show:

- age
- add reason
- last seen history
- likely matching collision
- recommendation framing: keep, remove, or escalate

Implementation direction:

- keep this read-only
- use history already exposed by `state-compute.js`
- compute a short explanation block instead of only listing raw fields

Why it matters:

- directly addresses the current trust gap
- helps users understand state logic without reading ledger lines

### 3. Health and Drift Surface

Promote health signals out of hidden or passive UI states.

Add:

- a visible stale/eval banner
- last successful commit summary
- parse/validation warning bucket
- import/export success or failure feedback

Why it matters:

- users should not need to infer whether the system is healthy
- this shortens the time from "something feels off" to "I know what to inspect"

## Phase 2: Guided Workflows

Once explainability is solid, reduce operator friction on the main commands.

### 1. Guided Action Composer

Wrap the highest-friction actions in lightweight guided forms:

- setup
- advance
- chapter close
- combat setup
- combat
- intimacy

These forms should still produce prompt-side actions, not direct state mutation.

Show:

- what the action is for
- what prompt or OOC command will be injected
- what fields are likely to change

Why it matters:

- lowers onboarding cost
- makes advanced features feel intentional instead of "button magic"

### 2. Import / Upgrade Notes

When state model assumptions change, show an inline note in the panel.

Examples:

- collision lifecycle changed
- new expected fields for live collisions
- prose authority moved to presets

Why it matters:

- avoids silent confusion after pulling updates
- makes the extension friendlier to long-lived saves

## Phase 3: Power-User Navigation

Only do this after phases 1 and 2 feel good.

### 1. Search and Filters

Add fast filters across:

- characters
- constraints
- collisions
- pressure points
- factions

Useful filters:

- changed this turn
- unresolved only
- combat only
- stale only

### 2. Focus Mode

Let the user pin a small active subset:

- current collision
- current chapter
- current scene cast

This could become a compact "scene dashboard" view.

### 3. Read-Only Timeline Scrub

Add a historical inspection mode for recent turns or snapshots without enabling arbitrary state edits.

Why it matters:

- helpful for debugging regressions
- safer than adding a general-purpose editor

## First Slice To Build

If we only do one implementation pass, do this:

1. Add a top-of-panel Turn Activity rail
2. Add collision explain cards
3. Add pressure-point explain cards
4. Add a clearer stale/eval health banner

This slice has the best ratio of user value to engineering cost because it reuses data the runtime already computes.

## Likely File Ownership

- `ui-panel.js`: main rendering, interaction, grouping, banners, explain cards
- `state-compute.js`: small helper exports if grouped history or recent-change summaries are needed
- `index.js`: pass any extra diagnostics already known at commit time
- `state-view.js`: no major role unless we want UI and prompt summaries to share formatter logic
- `setup-wizard.js` / `ooc-handler.js`: phase 2 workflow guidance and previews

## Implementation Principles

- prefer read-only and explainable over editable and magical
- use existing state/history plumbing before adding new data stores
- summarize first, then allow drill-down
- keep every UI feature useful on both short chats and very long-running chats
- stay compatible with the repo's no-build-step architecture

## Success Criteria

The frontend investment is working if a user can:

- identify the important state changes from the last turn in under 10 seconds
- explain why a collision or pressure point is present without reading raw ledger output
- tell whether the extension is healthy without guessing
- use setup/advance/combat flows without memorizing internal prompt conventions

## Decision

Yes, there is value in building more of our own frontend for Gravity Ledger.

That value comes from:

- observability
- confidence
- guided workflows

It does not come from building a separate polished app for its own sake.
