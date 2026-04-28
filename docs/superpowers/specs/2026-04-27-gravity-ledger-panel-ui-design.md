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
- `{mostRecentModel}` comes from `history.at(-1)?.model` — blank until the first director run. This intentionally reflects the **last run**, not the configured model: if a fallback (e.g. Haiku → Sonnet on rate limit) kicks in, the badge will switch and that's the signal we want.
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

Pressing a character row opens a **Character Detail modal** (using the existing `Modal.tsx` component). The modal sits at `z-60` (above the drawer's `z-50` and backdrop `z-40`); Escape closes the modal first, then the drawer.

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

Character-to-constraint linkage is resolved server-side: the `/state/:chatId` endpoint includes a `constraintIds: string[]` field on each `CharEntity`. The canonical source is an explicit `charId: string | string[]` field on the constraint entity (multi-character constraints supported as an array). Constraints with no `charId`, or with a `charId` that doesn't match any current character, are returned in `entities.constraints` only and surface in the top-level **CONSTRAINTS** section. Prefix-based id matching is **not** used — too fragile against renames and multi-char constraints. Adding `charId` to constraint entities is an engine-side schema addition tracked separately from this UI work; until that lands, all constraints render in the top-level section.

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

A "Raw" button at the top of the State tab content area (not in the drawer header) switches between the structured entity view and the original `<pre>` stateView text dump, for copy/paste access to the full state. The toggle state is local to the tab and does not persist.

### Empty / loading states

- **`initialized: false`** (no Gravity state for this chat yet): show a centered hint — "Gravity has not initialized for this chat. Send a message to begin." Hide all section headers.
- **`initialized: true` but every section is empty**: show section headers with `(0)` count and a muted "—" placeholder inside each.
- **Loading** (`/state/:chatId` fetch in flight on first open): skeleton rows for the open-by-default sections; do not block the tab itself.
- **Fetch error**: inline error row at the top of the State tab with a retry button. Do not auto-retry on a loop.

---

## Turns Tab

Shows a per-turn timeline of director runs for the current session.

### Empty states

- **History empty (no director runs yet)**: show a centered hint — "No director runs yet. The director fires after the assistant's reply." Plus the session strip header still renders zeros.
- **History truncated (>50 runs)**: show "Showing last 50 of {N} runs" as a muted line above the first row.
- **Director did not fire (skipped due to `runInterval`)**: not shown — these turns produce no `DirectorRun` and never enter `history`.

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
- Confidence dot: green = high, amber = medium, red/dim = low. Confidence is **self-reported by the director model and uncalibrated** — useful as a relative signal across turns within a session, not as an absolute quality score. Surface this caveat as a tooltip on the dot.
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

Op-code abbreviations rendered in the leading column: `S` = SET, `MS` = MERGE_SET, `A` = APPEND, `CR` = CREATE, `TR` = TRANSITION, `D` = DELETE. The full name appears as a tooltip on hover/long-press; the abbreviation stays compact for scanability.

### Rejected transaction dropdown

Expands inline when tapped — shows rejected ops and the validator reason for each rejection.

### Director notes

The director's `notes` field (free-text reasoning placed inside the JSON response) appears as a small italicised block below the expanded transactions when non-empty. Clamped to 3 lines (`line-clamp-3`); a "show more" toggle expands to full text. Whitespace is preserved (`whitespace-pre-wrap`) since notes can span multiple lines for some models.

---

## Export Debug Report

A **Download icon button** in the drawer header calls `GET /gravity/export/:chatId?include_pending=true` (note: snake_case query param — matches the existing route handler in `gravity.routes.ts`).

- Client fetches the JSON response, then assembles a `Blob` using `JSON.stringify(data, null, 2)` (pretty-printed, 2-space indent)
- Auto-downloads as `gravity-debug-{chatId}-{date}.json`
- Button shows a brief spinner while fetching
- On failure (network error, non-2xx response): show a transient inline error tooltip on the button (e.g. "Export failed — see console") and log the error; do not block the UI
- No confirmation modal needed

---

## Data Layer Changes

### 1. Gravity store (`gravity.store.ts`)

Replace `lastDirectorResult` + `totalCommitted` with a `history` array:

```ts
import type { RawTransaction } from "@gravity/engine/types";

interface RejectedTx {
  tx: RawTransaction;
  reason: string;            // validator violation message
}

interface DirectorRun {
  turnSeq: number;
  committed: number;
  rejected: number;
  committedTxs: RawTransaction[];
  rejectedTxs: RejectedTx[];
  newArrivalIds: string[];   // entity ids that crossed distance threshold this turn
  confidence: "high" | "medium" | "low";
  notes: string;
  durationMs: number;
  model: string;
}

const HISTORY_CAP = 50;

interface GravityState {
  history: DirectorRun[];          // session-only, oldest dropped past HISTORY_CAP
  totalCommitted: number;
  totalRejected: number;
  archiveVersion: string | null;

  addDirectorRun: (run: DirectorRun) => void;   // pushes, slices to last HISTORY_CAP, updates totals
  setArchiveVersion: (v: string) => void;
  reset: () => void;                            // clears history + totals + archiveVersion
}
```

`totalCommitted` and `totalRejected` are derived accumulators updated by `addDirectorRun`. They count *all* runs this session, not just the visible window — so a session with 80 runs reports the full total even though only the last 50 are in `history`.

`reset()` is called from the existing chat-switch effect (the same place the chat store clears per-chat state), so switching chats wipes history. There is no cross-session persistence by design (Out of Scope).

The HUD widget badge (committed count) and amber pulse (arrivals) continue to work — `newArrivalIds` is included in `DirectorRun`. Both the HUD widget (`RoleplayHUD.tsx:746`) and the existing panel body (`RoleplayHUDPanels.tsx:1264`) currently read `lastDirectorResult`; both must be updated to read `history[history.length - 1]` (or a `useGravityStore((s) => s.history.at(-1))` selector).

### 2. Agent result event payload

The director agent result (`agent_result` SSE event for `gravity-ledger-director`) currently sends only:
```json
{ "committed": 5, "rejected": 1, "newArrivalIds": [], "durationMs": 1200, "model": "haiku" }
```

Thread `committedTxs`, `rejectedTxs`, `confidence`, and `notes` through to the payload so the store can populate `DirectorRun` fully. **`confidence` and `notes` are not new** — they are already produced by the director and parsed into the `DirectorProposal` type at `packages/server/src/services/gravity/director/client.ts:14-20`. The work here is plumbing existing values out through the agent-result boundary, not adding fields to the engine or director response.

`rejectedTxs` carries the validator's reason string per rejection — the engine's `validateTransaction` already returns violations; the agent currently discards them. Pass them through as `{ tx, reason }` pairs.

This requires changes in:
- `packages/server/src/services/gravity/agents/director-agent.ts` — include `committedTxs`, `rejectedTxs` (with reasons), `confidence`, `notes` in the emitted result
- `packages/client/src/hooks/use-generate.ts` — map the new fields into `addDirectorRun` (replacing the current `setDirectorResult` call)

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
| `gravity.store.ts` | Replace `lastDirectorResult` with `history: DirectorRun[]`; cap at `HISTORY_CAP = 50` inside `addDirectorRun` |
| `use-generate.ts` | Map new agent result fields → `addDirectorRun` (replaces `setDirectorResult`) |
| `gravity.routes.ts` | Add `entities` to `/state/:chatId` response |
| `director-agent.ts` | Pass through `committedTxs`, `rejectedTxs` (with validator reasons), `confidence`, `notes` in the emitted agent result |
| `RoleplayHUD.tsx` | Open drawer instead of WidgetPopover; switch widget badge selector to `history.at(-1)`; keep widget strip layout unchanged |
| `RoleplayHUDPanels.tsx` | Remove the inline `GravityLedgerPanel` body (replaced by the new dedicated drawer); update its remaining `lastDirectorResult` selector at line 1264 |

---

## Accessibility

- **Drawer**: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at the title. Focus moves to the close button on open; on close, focus returns to the HUD widget that opened it.
- **Backdrop click + Escape** both dismiss the drawer.
- **Tab bar**: `role="tablist"` with `role="tab"` children carrying `aria-selected` and `aria-controls`; tab panels use `role="tabpanel"` and `aria-labelledby`. Left/Right arrow keys move between tabs.
- **Character Detail modal**: traps focus while open; Escape closes the modal first, then the drawer (modal at `z-60` over drawer's `z-50`).
- **Collapsibles**: section headers are `<button>` elements with `aria-expanded` reflecting state; the chevron is decorative (`aria-hidden`).
- **Confidence dot**: not a meaningful color-only signal — pair it with `aria-label="confidence: high"` (etc.) and the tooltip text.

## Out of Scope

- The Ops tab (dropped — transaction detail is inline in Turns)
- Turn history persistence across sessions (session-memory only, resets on chat change)
- Editing state from the panel (read-only inspection surface)
- The bold annotation / director input reduction approach (deferred — Haiku on full prose is fast enough)
