# Gravity Ledger Panel UI — Design Spec

## Date
`2026-04-27`

## Summary

Redesign the Gravity Ledger HUD panel from a compact WidgetPopover into a full-height Side Drawer with two tabs (State · Turns) that let the user verify Gravity is actively tracking state and assess the quality of the director model's ledgering turn by turn.

---

## Problem

The current `GravityLedgerPanel` is a minimal WidgetPopover: a raw `<pre>` stateView text dump, a last-run committed/rejected count, and a refresh button. It answers "is Gravity initialized?" but not "is Gravity working well?" With Haiku replacing a thinking model as the director, the user needs a proper inspection surface to confirm:

1. The entity state is correct (characters, collisions, pressures, world state)
2. The director committed meaningful transactions each turn
3. Rejected transactions and their reasons are visible
4. The full ledger can be exported for debugging

---

## Shell

### Drawer (replaces WidgetPopover)

The panel is promoted from a `WidgetPopover` to a **Side Drawer** matching the existing `ChatGalleryDrawer` / `ChatFilesDrawer` pattern:

- `absolute right-0 top-0 z-50 flex h-full w-80 max-md:w-full flex-col`
- Border: `border-l border-[var(--border)]`
- Background: `bg-[var(--background)] shadow-2xl`
- Animation: `animate-fade-in-up`
- Backdrop: `absolute inset-0 z-40 bg-black/30 backdrop-blur-[2px]` — dismisses on click
- Mobile safe area: `max-md:pt-[env(safe-area-inset-top)]`

The HUD widget (Network icon in the strip) is unchanged — it now opens the drawer instead of the popover.

### Header (fixed, does not scroll)

Two rows:

**Row 1 — title bar:**
- Left: Network icon + "Gravity Ledger" label + mode badge (REGULAR / ADVANCE, muted mono)
- Right: Export button (Download icon, no label) + Close button (X icon)

**Row 2 — session stats strip:**
- `⚖️ {totalCommitted} committed · {totalRejected} rejected · {mostRecentModel} · seq {nextTxSeq}`
- `{mostRecentModel}` comes from `history[history.length - 1]?.model` — blank until the first director run
- Muted text, tabular-nums, always visible

### Tab bar

Two tabs below the header: **State** and **Turns**. Active tab has an underline indicator. Tab bar does not scroll.

---

## State Tab

Shows the current accepted ledger state as a browsable entity tree.

### Layout

Collapsible sections, one per entity type with entries. Default open: **CHARACTERS**, **COLLISIONS**, **PC**. Others collapsed by default.

Section header format: `▼ CHARACTERS (3)` / `▶ PRESSURES (2)`

### Character rows

Each character is a **button row**:
```
[TRACKED]  Elena Cross          place:medbay
[PRINCIPAL] Kira Yamada         place:bridge
[KNOWN]    Athrun Zala
```

Pressing a character row opens a **Character Detail modal** (using the existing `Modal.tsx` component).

### Character Detail Modal

Shows all fields for that character in a focused overlay:

```
Elena Cross                          [TRACKED]
──────────────────────────────────────────────
Location     place:medbay
Tags         smuggler · archangel-contact

Knowledge
  knows_evidence      Has seen the documents
  hiding_employer     Cover not yet blown
  misreading_kira     Thinks she's unaware

Demonstrated Traits
  · willing to share dangerous info without flinching
  · deflects personal questions with humor

Constraints
  oath-of-silence     [STRAINED]
  trade-agreement     [UNTESTED]
```

Constraints linked to this character appear at the bottom of the modal — they are not shown as a separate top-level section in the State tab. Constraints with no clear character link (if any) get a minimal **CONSTRAINTS** collapsible section in the main State tab.

Character-to-constraint linkage is resolved server-side: the `/state/:chatId` endpoint includes a `constraintIds: string[]` field on each `CharEntity`, populated by convention (constraint id contains the char id as a prefix, e.g. `oath-elena-*`) or by an explicit `charId` field stored on the constraint entity. Unlinked constraints (no matching char) are returned in `entities.constraints` only.

### Other entity sections

All rendered as collapsible inline sections (no modal drill-down):

**COLLISIONS:**
```
bridge-confrontation  [ACTIVE]  SHORT · 8 remaining
  "Kira suspects Elena is hiding something"
```

**PRESSURES:**
```
lacus-distance        "Lacus growing distant"
trade-tension         "Unresolved shipment dispute"
```

**PC:**
Key fields inline — name, scene_cast (comma list), current location.

**WORLD:**
`mode: regular  ·  timeskip: null`

### Raw toggle

A "Raw" button in the tab header switches between the structured entity view and the original `<pre>` stateView text dump, for copy/paste access to the full state.

---

## Turns Tab

Shows a per-turn timeline of director runs for the current session.

### Turn rows

Each row shows one director run:

```
Turn 12   +5 committed ▶   0 rejected   1.2s   ● high
Turn 9    +3 committed ▶   1 rejected ▶  1.8s   ● medium
Turn 6    +0 committed    0 rejected   0.9s   ○ low
Turn 3    +7 committed ▶   0 rejected   2.1s   ● high
```

- Committed count is a **toggle button** — tap to expand/collapse inline transaction list
- Rejected count is a **toggle button** when > 0 — tap to expand/collapse rejected list
- Confidence dot: green = high, amber = medium, red/dim = low
- Turns where the director did not fire (due to `runInterval`) are not shown

### Committed transaction dropdown

Expands inline below the turn row:

```
Turn 12   +5 committed ▼   0 rejected   1.2s   ● high
  ├ S   char · elena        location → place:medbay
  ├ MS  char · elena        knows_evidence: "Has seen the documents"
  ├ A   char · elena        demonstrated_traits: "willing to share…"
  ├ CR  pressure · lacus-distance   "Lacus growing distant"
  └ TR  collision · bridge  ACTIVE → RESOLVED
```

Format per transaction line: `op · entity-type · id · key change or reason`

### Rejected transaction dropdown

Expands inline when tapped — shows rejected ops and the validator reason for each rejection.

### Director notes

The director's `notes` field (free-text reasoning placed inside the JSON response) appears as a small italicised line below the expanded transactions when non-empty.

---

## Export Debug Report

A **Download icon button** in the drawer header calls `GET /gravity/export/:chatId?includePending=true`.

- Client fetches the JSON response, then assembles a `Blob` using `JSON.stringify(data, null, 2)` (pretty-printed, 2-space indent)
- Auto-downloads as `gravity-debug-{chatId}-{date}.json`
- Button shows a brief spinner while fetching
- No confirmation modal needed

---

## Data Layer Changes

### 1. Gravity store (`gravity.store.ts`)

Replace `lastDirectorResult` + `totalCommitted` with a `history` array:

```ts
interface DirectorRun {
  turnSeq: number;
  committed: number;
  rejected: number;
  committedTxs: unknown[];   // full op objects
  rejectedTxs: unknown[];    // rejected op objects with reason
  newArrivalIds: string[];   // entity ids that crossed distance threshold this turn
  confidence: "high" | "medium" | "low";
  notes: string;
  durationMs: number;
  model: string;
}

interface GravityState {
  history: DirectorRun[];          // session-only, capped at 50
  totalCommitted: number;
  totalRejected: number;
  archiveVersion: string | null;

  addDirectorRun: (run: DirectorRun) => void;
  setArchiveVersion: (v: string) => void;
  reset: () => void;
}
```

`totalCommitted` and `totalRejected` are derived accumulators updated by `addDirectorRun`.

The HUD widget badge (committed count) and amber pulse (arrivals) continue to work — `newArrivalIds` is included in `DirectorRun`.

### 2. Agent result event payload

The director agent result (`agent_result` SSE event for `gravity-ledger-director`) currently sends only:
```json
{ "committed": 5, "rejected": 1, "newArrivalIds": [], "durationMs": 1200, "model": "haiku" }
```

Add `committedTxs`, `rejectedTxs`, `confidence`, and `notes` to the payload so the store can populate `DirectorRun` fully.

This requires changes in:
- `packages/server/src/services/gravity/agents/director-agent.ts` — include txs + confidence + notes in the emitted result
- `packages/client/src/hooks/use-generate.ts` — map the new fields into `addDirectorRun`

### 3. `/gravity/state/:chatId` endpoint

Extend response to include a structured `entities` field alongside the existing `stateView` string:

```ts
interface GravityStateResponse {
  initialized: boolean;
  mode: string;
  stateView: string;          // existing raw text (for Raw toggle)
  archiveVersion: string;
  nextTxSeq: number;
  entities: GravityEntities;  // NEW — structured entity map
}

interface GravityEntities {
  chars: CharEntity[];
  collisions: CollisionEntity[];
  pressures: PressureEntity[];
  constraints: ConstraintEntity[];
  places: PlaceEntity[];
  factions: FactionEntity[];
  pc: PcEntity | null;
  world: WorldEntity | null;
}
```

The server builds `entities` from the same DB rows it already reads for `stateView`, serialised as structured JSON instead of formatted text.

---

## Component Inventory

### New / promoted

| Component | File | Notes |
|-----------|------|-------|
| `GravityLedgerDrawer` | `GravityLedgerDrawer.tsx` (new dedicated file, matching `ChatGalleryDrawer.tsx` convention) | Replaces `GravityLedgerPanel` in the WidgetPopover |
| `GravityStateTab` | `GravityLedgerDrawer.tsx` (co-located sub-component) | Entity browser with collapsibles |
| `GravityTurnsTab` | `GravityLedgerDrawer.tsx` (co-located sub-component) | Turn timeline with inline tx dropdowns |
| `CharacterDetailModal` | `GravityLedgerDrawer.tsx` (co-located sub-component) | Modal drill-down for a single character |

### Modified

| File | Change |
|------|--------|
| `gravity.store.ts` | Replace `lastDirectorResult` with `history: DirectorRun[]` |
| `use-generate.ts` | Map new agent result fields → `addDirectorRun` |
| `gravity.routes.ts` | Add `entities` to `/state/:chatId` response |
| `director-agent.ts` | Include `committedTxs`, `rejectedTxs`, `confidence`, `notes` in result |
| `RoleplayHUD.tsx` | Open drawer instead of WidgetPopover; keep widget strip unchanged |

---

## Out of Scope

- The Ops tab (dropped — transaction detail is inline in Turns)
- Turn history persistence across sessions (session-memory only, resets on chat change)
- Editing state from the panel (read-only inspection surface)
- The bold annotation / director input reduction approach (deferred — Haiku on full prose is fast enough)
