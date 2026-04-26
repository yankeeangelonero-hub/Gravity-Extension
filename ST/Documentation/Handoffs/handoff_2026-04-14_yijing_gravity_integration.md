# Handoff: Yijing Relationship Resolver For Gravity

Date: 2026-04-14

## Current Recommendation

Keep Gravity as the narrative engine.

Use the Yijing work as a relationship and semantic challenge resolver inside Gravity, not as a replacement runtime.

Gravity already owns the reliable infrastructure:
- append-only ledger state
- replay, rollback, and snapshots
- prompt injection
- compact state deltas
- collision pressure
- constraints
- challenge sessions
- prose stack
- correction loop
- SillyTavern UI and chat metadata persistence

The Yijing design's strongest piece is narrower and valuable: a grammar for whether an action fits its timing, position, and relationship field.

## Why This Direction

The standalone Yijing engine is trying to build persistence, scene lifecycle, chapter structure, state validation, prompt assembly, and narration from scratch. Gravity already has those.

The part Gravity does not have yet is a strong relationship adjudicator. It stores good relationship residue through `reads`, `noticed_details`, `key_moments`, `knowledge_asymmetry`, `intimacy_stance`, `intimate_history`, constraints, collisions, and summaries, but the decision about whether a relationship actually moved is still mostly prompt-side judgment.

That is where Yijing fits.

Use Yijing to answer:
- Did this move fit the moment?
- Did this character speak from a position they had earned?
- Did the action accord with, strain, violate, or bypass the other person?
- Did the relationship continue, change a focal condition, invert, reverse perspective, or reveal hidden structure?

Then store the result in normal Gravity fields.

## Corrected Repo Facts

Some prior planning language should be kept precise:

- There is no `challenge-profile-intimacy.js` in the current repo. Only `challenge-profile-combat.js` is registered.
- Combat now uses the generic challenge engine and `_challenge` prompt slot. `combat-state.js` is a compatibility facade.
- Gravity's relationship state is not a canonical trust number. The live model is qualitative and distributed across reads, noticed details, knowledge asymmetry, intimacy stance/history, constraints, collisions, and summaries.
- The thin part is adjudication, not storage.

## Minimal Integration Shape

Start with no new runtime state machine.

Add a Yijing relational audit to hidden reasoning for relationship-significant turns:

```text
YIJING RELATIONAL AUDIT
Timing: fitting | premature | belated | evasive | mixed
Position: fitting | overreaching | under-occupying | displaced | ambiguous
Relation: accords | strains | violates | bypasses | ambiguous
Transformation flavor: ben | zhi | cuo | zong | hu
Quality: opening | strained_opening | boundary_held | boundary_violated | misread_deepened | reversal | inner_structure_revealed | residue_only
State consequence: reads / noticed_details / knowledge_asymmetry / intimacy_stance / intimate_history / constraint / collision / summary
```

The audit should never appear in visible prose.

The visible state update remains normal Gravity:

```state
---STATE---
at: [Day N - HH:MM]
char:tifa.reads.pc: "Believes the apology was real, but still hears control in the timing."
char:tifa.noticed_details+: "He apologized before she named the wound."
constraint:c1-guilt.integrity: STRESSED
collision:trust-vs-duty.distance: 3
summary+: "The apology opened a door and exposed the frame around it: he wanted forgiveness before she had room to decide whether trust was possible."
---END STATE---
```

## Mapping Yijing To Gravity

| Yijing concept | Gravity surface | Notes |
|---|---|---|
| shi / timing | collision distance, chapter phase, scene pressure, prior summaries | The same action can be premature at distance 8 and necessary at distance 1. |
| wei / position | character tier, constraints, intimacy stance, social role, power asymmetry | A character acting as if they occupy unearned closeness or authority is overreaching. |
| ren / relation | reads, knowledge asymmetry, noticed details, intimate history | This is the heart of the integration. |
| ben | no structural relational shift | The relationship continues as itself, possibly with fresh residue. |
| zhi | focal condition changed | One concrete condition of the relationship moves. |
| cuo | counter-current asserted | The opposite dynamic surfaces: trust attempt becomes control, apology becomes pressure, refusal becomes care. |
| zong | perspective or role reversal | The scene flips who is asking, yielding, judging, withholding, or exposed. |
| hu | hidden inner structure revealed | The scene uncovers what the relationship was secretly organized around. |

Use English enum values in code. Keep Chinese terms in docs/prompt explanation where useful, but do not make runtime parsing depend on non-ASCII labels.

## Relationship Challenge Profile

After the prompt-only audit proves useful, add a new generic challenge profile:

```text
challenge-profile-relation.js
```

Suggested profile shape:

```js
kind: 'relation'
displayName: 'Relation'
inputPrefix: 'rel'
deductionType: 'relation'
entityType: 'collision'
usesD20: false
usesDraws: true
```

Player flow:

```text
rel:
rel:2
rel: tell her the truth before she asks
rel: apologize without defending myself
```

The profile should use Gravity's existing challenge phases where possible:
- `setup_opening`: establish the relational threshold and participants
- `awaiting_choice`: present 3-4 relational moves
- `awaiting_resolution`: resolve the chosen move through the Yijing audit
- `cleanup_grace`: write lasting relationship residue and release the lock

Non-dice challenge support may need a small cleanup in `challenge-state.js`. The current packet builder already branches on `usesD20`, but several generic names still assume category/threshold language. A relation profile should be allowed to supply custom mechanics/context lines.

## Result Contract

Do not use success/failure as the primary vocabulary.

Use relationship consequence labels:

```text
opening
strained_opening
boundary_held
boundary_violated
misread_deepened
trust_shift
reversal
inner_structure_revealed
residue_only
```

Possible mapping:

| Audit shape | Consequence |
|---|---|
| fitting + fitting + accords | opening / trust_shift |
| mixed timing or strains | strained_opening |
| overreaching + violates | boundary_violated |
| under-occupying + bypasses | residue_only / misread_deepened |
| cuo flavor | reversal or counter-current complication |
| zong flavor | role/perspective reversal |
| hu flavor | inner structure revealed |

This should remain advisory. The final durable state is still expressed through normal Gravity fields.

## Persistence Rule

Do not put one global `pc.current_gua` on the PC as the main model.

Relationships are local. The PC can be in one pattern with one person, another with a faction, and another with an enemy.

Prefer one of these if persistent Yijing state becomes useful:

```state
char:tifa.yijing_pc.current_gua: "gen"
char:tifa.yijing_pc.palace_stage: "er_shi"
char:tifa.yijing_pc.last_quality: "hui"
char:tifa.yijing_pc.pattern: "Trust grows through restraint, not demand."
```

or attach the Yijing result to the active personal collision:

```state
collision:trust-vs-duty.yijing_mode: "hu"
collision:trust-vs-duty.yijing_quality: "strained_opening"
collision:trust-vs-duty.aftermath: "The exchange did not resolve the lie; it revealed the structure underneath it."
```

Do not add this persistent surface until prompt-only testing proves the values stay compact and useful.

## What Not To Import Yet

Do not import the full standalone Yijing engine in v1:

- no mandatory Tian/Di/Ren cascade
- no 384-slot line-packet dependency for every scene
- no closure claim gate for every scene
- no separate seed/gate/tick API call chain
- no per-turn requirement that every meaningful action changes a hexagram

Those ideas can remain research assets. Gravity does not need them to benefit from Yijing.

## Suggested Rollout

### Phase 1: Prompt-Only Audit

Add a hidden Yijing relational audit to the preset and/or intimacy/regular mode playbooks.

Trigger only when the turn touches:
- `reads`
- `knowledge_asymmetry`
- `intimacy_stance`
- `intimate_history`
- a personal constraint
- a personal collision
- apology, confession, betrayal, negotiation, boundary, repair, desire, or trust

No JS changes required beyond docs unless the audit needs a dedicated injection.

### Phase 2: State Delta Discipline

Teach the prompt to convert audit outcomes into existing Gravity updates:
- `char:id.reads.target`
- `char:id.noticed_details+`
- `char:id.knowledge_asymmetry`
- `char:id.intimacy_stance`
- `char:id.intimate_history.key`
- `constraint:id.integrity`
- `constraint:id.current_pressure`
- `collision:id.distance`
- `collision:id.last_manifestation`
- `summary+`

Success criterion: relationship turns feel less arbitrary without adding visible machinery.

### Phase 3: Relation Challenge Profile

Add `challenge-profile-relation.js` only after Phase 1 proves useful.

The profile should use:
- no dice
- optional divination draw
- relation-specific categories
- 3-4 options
- Yijing audit as the resolution rubric
- normal Gravity state updates as output

### Phase 4: Optional Per-Dyad Memory

Only add persistent Yijing fields if repeated play shows the audit needs compact continuity.

Prefer per-dyad or per-collision fields over global PC fields.

## Open Questions

- Should relation challenges be player-triggered only (`rel:`), auto-triggered from hot personal collisions, or both?
- Should intimacy become its own challenge profile first, or should relation subsume intimacy as one domain?
- Should divination draws seed the relation challenge, or should they only color resolution after the audit?
- How much Yijing terminology should be visible to the user, if any?
- Does the relation profile need a durable `relation:*` entity, or are `char:*` plus `collision:*` sufficient?

## Current Cleanup In This Branch

- Documentation now names `_challenge` as the live generic challenge prompt slot and notes that `_combat` is legacy-cleared.
- `READ` / `UNREAD` shorthand in `regex-intercept.js` now defaults to the `reads` map instead of producing a map operation with an empty field.

## Files To Touch In A Future Implementation

- `gravity_v14.json` for hidden Yijing relational audit language
- `Gravity World Info.json` for optional relation/intimacy mode playbooks
- `challenge-profiles.js` to register a relation profile
- `challenge-profile-relation.js` for profile-specific relation behavior
- `challenge-state.js` if non-dice profile packet customization is needed
- `state-view.js` if persistent per-dyad Yijing fields become real
- `ui-panel.js` if relation challenge state needs panel visibility
- `Documentation/project_memory.md` and component docs whenever behavior changes

