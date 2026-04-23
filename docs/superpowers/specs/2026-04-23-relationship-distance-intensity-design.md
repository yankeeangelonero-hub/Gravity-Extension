# Relationship Distance & Intensity — Design Spec

**Status:** Approved, ready for implementation planning
**Date:** 2026-04-23

## Problem

The current relationship entity captures the *shape* of a bond (tarot card + orientation + nuance prose) but not where the bond *is* — how developed it is, how charged it currently feels. Two people with the same card (e.g. The Hermit reversed) could be strangers electrified by their first meeting, or old allies drifting apart. The nuance prose carries this context implicitly, but the engine has no structured read on it.

This is a narrative visibility problem, not a gameplay-mechanics problem: we want the engine + panel + LLM to see "where the bond is" at a glance, without adding combat/leveling mechanics.

## Solution

Add two type-neutral axes to the relationship entity:

- **distance** — how developed the bond is (5 values)
- **intensity** — how charged the current connection is (4 values)

Both work for any relationship type (lovers, enemies, family, rivals, allies). The tarot card + nuance continue to carry the *type* of bond; distance/intensity describe *where it is on the curve*.

## Schema

New and modified fields on the `relationship` entity:

```js
{
  id: "pc-ada-wong",                    // unchanged
  card: "the-hermit",                   // unchanged
  orientation: "reversed",              // unchanged
  nuance: "Two people armored...",      // unchanged
  distance: "fresh",                    // NEW — enum, required on CR
  intensity: "electric",                // NEW — enum, required on CR
  status: "active",                     // unchanged, engine-owned
  display_name: "...",                  // unchanged
  last_shift: {                         // EXPANDED shape
    tx: 42,
    collision_id: "first-meeting",
    from: { card, orientation, distance, intensity },
    to:   { card, orientation, distance, intensity },
    reason: "max 200 chars"
  } | null
}
```

## Vocabulary

### Distance (5 values)

Captures how developed the bond is, regardless of whether it's friendly or hostile.

| Value | Meaning |
|-------|---------|
| `fresh` | Recently connected, nothing established |
| `forming` | Patterns taking shape, still shifting |
| `established` | Known quantity, patterns locked in |
| `deep` | Each knows what the other will do |
| `core` | Defines both parties' identities |

### Intensity (4 values)

Captures how charged the current connection is.

| Value | Meaning |
|-------|---------|
| `cold` | Disengaged, on autopilot |
| `simmering` | Subsurface tension or warmth |
| `active` | Engaged, dynamic, present in each other's orbit |
| `electric` | Can't ignore, high stakes |

### Example combinations

- `fresh / electric` — new couple, can't keep hands off; OR first-meeting enemies crackling
- `deep / simmering` — old feud with quiet hatred; OR long marriage in a quiet phase
- `core / cold` — estranged siblings
- `forming / active` — new partnership working things out
- **Autumn/Ada example:** The Hermit reversed · `fresh / electric`

## Validation (consistency.js)

### CR relationship

Existing requirements (unchanged): `card`, `orientation`, `nuance`, `last_shift=null`, `status` must not be set.

New requirements:
- `distance` required, must be one of the 5 enum values
- `intensity` required, must be one of the 4 enum values

Error messages follow the existing pattern (field + message + fix hint).

### S relationship

New allowed fields:
- `SET relationship:<id> field=distance value=<enum>` — validates against enum
- `SET relationship:<id> field=intensity value=<enum>` — validates against enum

Existing fields unchanged.

### last_shift shape

`isValidLastShift(v)` now requires `from` and `to` to each be `{card, orientation, distance, intensity}` — four keys, all strings, all validated against their respective enums (card against MAJOR_ARCANA, orientation against RELATIONSHIP_ORIENTATIONS, distance against the new DISTANCE enum, intensity against the new INTENSITY enum).

`null` remains valid (at birth).

## State view (state-view.js)

The relationship line injected into character dossiers for the LLM:

```
♥ Bond (PC): The Hermit · reversed · fresh / electric
   "Two people armored in self-sufficiency..."
```

The slash `/` separates the two axes. Format: `{Card Name} · {orientation} · {distance} / {intensity}`.

If either `distance` or `intensity` is missing (legacy data), render the line without the ` · {distance} / {intensity}` suffix.

## Panel display (ui-panel.js)

In `renderCharDossier`, the relationship block gains a new row:

```html
<div class="gl-d-row gl-relationship gl-tarot-upright">♥ <b>The Hermit</b> · reversed</div>
<div class="gl-d-row gl-relationship-stage">fresh · active</div>
<div class="gl-d-row gl-relationship-nuance">"Two people armored in self-sufficiency..."</div>
```

The new stage row only renders when both `distance` and `intensity` are present. Uses the same dim styling as `gl-relationship-nuance` (small font, slight opacity).

## Correction injection (index.js)

### Missing-relationship correction (existing, extended)

When a TRACKED+ char/faction has no `relationship:pc-<id>`, the correction message now includes the new fields:

```
CREATE relationship:pc-<id> card="<major-arcana-slug>" orientation="upright|reversed" nuance="<one-sentence>" distance="fresh|forming|established|deep|core" intensity="cold|simmering|active|electric" last_shift=null
```

### Missing-rel-update correction (existing, extended)

When a relational collision resolves without the paired relationship being updated, the correction message now includes SETs for all four axes:

```
SET relationship:<id> field=card value="<slug>"
SET relationship:<id> field=orientation value="upright|reversed"
SET relationship:<id> field=nuance value="<updated expression>"
SET relationship:<id> field=distance value="<enum>"
SET relationship:<id> field=intensity value="<enum>"
SET relationship:<id> field=last_shift value={tx, collision_id:"<id>", from:{card,orientation,distance,intensity}, to:{card,orientation,distance,intensity}, reason}
```

### Missing-stage correction (new)

When an active relationship has no `distance` or no `intensity` (legacy migration case), queue a correction:

```
relationship:<id> is missing distance and/or intensity. Pick current values:
  SET relationship:<id> field=distance value="fresh|forming|established|deep|core"
  SET relationship:<id> field=intensity value="cold|simmering|active|electric"
```

Dedup key: `[missing-stage:<relId>]`. Clears once both fields are set.

## Migration strategy

Existing relationships in saved chats will lack `distance` and `intensity`. Design handles this gracefully:

1. **No auto-default in state-compute.** Missing fields stay `undefined`. Faking values would be misleading.
2. **Panel and state-view render without the stage row when fields are missing.** Old saves look identical to before.
3. **Correction loop fills them in.** The missing-stage correction fires on the next turn; the LLM SETs them; subsequent renders include the new row.
4. **No migration transaction.** The ledger stays pure append-only; legacy relationships just wait for the LLM to populate the new fields via corrections.

## Files touched

| File | Change |
|------|--------|
| `consistency.js` | Add `DISTANCE` and `INTENSITY` enums; extend `validateRelationshipTx` for CR and S; extend `isValidLastShift` to require all four from/to keys |
| `state-view.js` | Relationship line formatter — append ` · {distance} / {intensity}` when both present |
| `ui-panel.js` | `renderCharDossier` — new `gl-relationship-stage` row between card and nuance |
| `index.js` | Extend missing-relationship correction text; extend missing-rel-update correction text; add missing-stage correction loop |
| `state-compute.js` | No logic change — just confirm `last_shift` shape handling remains correct |
| `gravity_v15.json` | Update preset so the LLM knows the new fields and vocabulary exist |
| `Gravity World Info.json` | If any entry references relationship fields, sync |
| `Documentation/system_architecture_reference.md` | Update relationship section with the new fields |

## Non-goals

- **No mechanical gameplay effect.** Distance/intensity don't unlock scenes, modify stats, or gate content. Pure narrative signal.
- **No decay.** Bonds don't automatically drift; the LLM chooses when to update based on narrative.
- **No rank arithmetic.** Enums, not numbers. No "rank 7 friendship."
- **No new entity type.** Relationships stay as they are; we're adding fields, not splitting.

## Open questions

None — design fully specified.
