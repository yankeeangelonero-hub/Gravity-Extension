# Collision Pipeline Upgrade Plan

## Goal

Upgrade the collision system from "distance + status + prompt improvisation" into a full narrative lifecycle with:

- richer collision creation
- explicit convergence handling when multiple collisions arrive together
- explicit closure semantics when a collision ends
- lineage tracking from parent collision to successor collision
- better UI/state visibility for auditing drift

This is a design note for later implementation.

## Current Problems

### 1. Collision creation is too thin

The current system allows collisions to be created with only sparse fields like:

- `name`
- `status`
- `distance`
- `tags`

That means the model often reconstructs the actual threat from a label instead of reading a durable story object.

### 2. Live collision phase and closure reason are mixed together

The current runtime uses:

- `SEEDED`
- `SIMMERING`
- `ACTIVE`
- `RESOLVING`
- `CRASHED`
- `RESOLVED`

But `CRASHED` is not really a live phase. It is a closure reason.

### 3. Multiple arrivals do not have a proper convergence model

When multiple collisions hit distance `0` at once, the extension batches them together, but does not explicitly decide whether they:

- arrive in parallel
- trigger each other in a cascade
- combine into a larger composite event

So the model improvises the relationship.

### 4. Collision closure is under-specified

Current prompt language mentions:

- direct resolution
- evolution
- crash
- wreckage spawning a new collision

But the extension does not require a structured closure record. That makes lineage and aftermath drift-prone.

### 5. Closed collisions are discarded too aggressively

Crash flows currently instruct the model to destroy the collision after resolution. That removes useful narrative history and makes it harder to inspect what really happened.

## Target Model

### Collision status should represent live phase only

Use:

- `SEEDED`
- `SIMMERING`
- `ACTIVE`
- `RESOLVING`
- `RESOLVED`

Do not use `CRASHED`, `MERGED`, or `IMPLODED` as statuses.

### Closure reason should be a separate field

Add:

- `outcome_type`

Allowed values:

- `DIRECT`
- `EVOLVED`
- `MERGED`
- `IMPLODED`
- `CRASHED`

This separates:

- where the collision is in play
- how the collision ended

## Required Collision Fields

Every collision should be a compact narrative object, not a label.

### Minimum fields by stage

#### SEEDED

Require:

- `name`
- `forces`
- `details`
- `distance`

Recommend:

- `target_constraint`

#### SIMMERING / ACTIVE

Require:

- `name`
- `forces`
- `details`
- `cost`
- `distance`

Recommend:

- `target_constraint`

#### RESOLVING

Require everything above, plus:

- `last_manifestation`

`last_manifestation` is the concrete current expression of the collision in the scene.

#### RESOLVED

Require:

- `outcome_type`
- `aftermath`

Optional but strongly recommended:

- `successor_collision_ids`
- `parent_collision_ids`

## New Collision Fields

Add these collision fields to the contract:

- `details`
- `cost`
- `target_constraint`
- `last_manifestation`
- `aftermath`
- `outcome_type`
- `parent_collision_ids`
- `successor_collision_ids`

### Intended meaning

#### `details`

The collision's story capsule.

It should answer:

- what is converging
- where this pressure came from
- how it is showing up now
- what kind of arrival or forced choice is looming

#### `cost`

What resolution or engagement will cost.

#### `target_constraint`

Which character surface this collision is pressing on.

#### `last_manifestation`

How the collision most recently entered concrete scene reality.

#### `aftermath`

What changed once the collision left live play.

#### `parent_collision_ids`

Which earlier collisions fed into this one.

#### `successor_collision_ids`

Which new collisions this one generated on closure.

## State Contract Shape

### Normal turn STATE writes

Examples:

```text
collision:shadow-activity.distance: 2
collision:shadow-activity.last_manifestation: "The watcher stops pretending to scavenge and finally looks directly at Autumn."
```

Closure:

```text
collision:shadow-activity.status: RESOLVED
collision:shadow-activity.outcome_type: CRASHED
collision:shadow-activity.aftermath: "The watcher carried confirmation of Arcueid's presence back to its masters before anyone moved to stop it."
```

Evolution:

```text
collision:daemon-prince-convergence.status: RESOLVED
collision:daemon-prince-convergence.outcome_type: EVOLVED
collision:daemon-prince-convergence.aftermath: "The live binding was severed before it could lock, but the failed severance displaced the pressure into the veil itself."
create collision:aftershock-tear name="Aftershock Tear" status=SIMMERING distance=7 forces="district weak points, displaced daemon pressure" cost="If it opens fully, the district becomes a feeding ground" details="The interrupted binding did not end the danger. It redistributed it into the local fabric of the world."
collision:daemon-prince-convergence.successor_collision_ids+: aftershock-tear
collision:aftershock-tear.parent_collision_ids+: daemon-prince-convergence
```

## Convergence Protocol

When two or more collisions hit distance `0` on the same turn, the extension should trigger a convergence protocol.

The protocol must classify the relationship as one of:

- `PARALLEL`
- `CASCADE`
- `COMPOSITE`

### PARALLEL

The collisions arrive at the same time, but remain distinct tensions.

Behavior:

- one may be foregrounded first
- the others remain active in the same scene or immediate next beat
- no forced merge

### CASCADE

One collision becomes the trigger or delivery vehicle for another.

Behavior:

- collision A arrives through or because of collision B
- both remain distinct, but their arrivals are causally linked

### COMPOSITE

The simultaneous arrivals form a larger event.

Behavior:

- the prose should present one coherent converged event
- parent collisions typically close with `MERGED`
- the extension should encourage creating a composite successor collision

### Draw handling

When convergence happens:

- keep each collision's own arrival draw for its local flavor
- add one shared convergence draw for the shape of the combined event

That lets the event feel unified without flattening all collisions into one identical arrival.

## Closure Protocol

Whenever a collision leaves live play, the extension should require a closure audit.

The audit should answer:

1. How did it end?
2. What changed?
3. Did it generate a successor collision?

### Required closure record

At minimum:

- `collision:id.status: RESOLVED`
- `collision:id.outcome_type: ...`
- `collision:id.aftermath: "..."`

Then either:

- one or more `collision:id.successor_collision_ids+`

or:

- an explicit closure note that no successor seam remains

### Outcome types

#### DIRECT

The player engaged and closed the collision directly.

#### EVOLVED

The collision resolved, but exposed a new tension.

#### MERGED

The collision was absorbed into a composite successor event.

#### IMPLODED

The collision collapsed inward under contradiction, failure, betrayal, or self-destruction.

This is not a merge and not a normal crash. It is internal collapse.

#### CRASHED

The player did not engage meaningfully and gravity chose the outcome.

## Crash Handling

Crash should no longer mean "destroy immediately."

Instead:

1. Move collision to `RESOLVED`
2. Set `outcome_type: CRASHED`
3. Record `aftermath`
4. Optionally create successor collision(s)
5. Keep the collision visible until chapter close / maintenance

Only archive or destroy old resolved collisions during structural cleanup, not at the moment of crash.

## Merge and Implosion Semantics

### MERGED

Use when two or more collisions stop being independent engines and become one shared successor event.

Expected record:

- each parent gets `status: RESOLVED`
- each parent gets `outcome_type: MERGED`
- each parent points to the successor collision
- successor collision points back to its parents

### IMPLODED

Use when the collision consumes itself internally instead of being solved externally.

Examples:

- the secret-holder breaks before the confrontation happens
- the faction tears itself apart before reaching the player
- the mask fails and the collision collapses into fallout

Expected record:

- parent gets `status: RESOLVED`
- parent gets `outcome_type: IMPLODED`
- parent gets `aftermath`
- successor collision is optional, not mandatory

## Extension Changes

### 1. Lifecycle normalization

Update the runtime and docs so:

- live status machine ends at `RESOLVED`
- `CRASHED` becomes an `outcome_type`, not a live status

### 2. Collision richness audit

Add a gameplay audit layer for collisions, separate from low-level format validation.

The audit should warn or block on:

- created collision missing required narrative fields
- resolving collision missing `last_manifestation`
- resolved collision missing `outcome_type`
- resolved collision missing `aftermath`
- merged collision with no successor linkage
- evolved collision with no successor linkage

### 3. Convergence injection

At the point where multiple ripe collisions are detected, replace the current generic batch behavior with:

- convergence classification
- shared convergence framing
- explicit instruction to either keep them separate, cascade them, or merge them

### 4. Closure audit injection

When a collision resolves this turn, inject a short reminder:

- every resolved collision must state outcome, aftermath, and successor-or-none

### 5. Legacy compatibility

If old content still emits:

- `status: CRASHED`

the extension should normalize it internally to:

- `status: RESOLVED`
- `outcome_type: CRASHED`

for backward compatibility.

## Prompt and Readme Changes

### Quick reference

Expand collision guidance in the quick reference to include:

- `collision:id.name`
- `collision:id.forces`
- `collision:id.details`
- `collision:id.cost`
- `collision:id.target_constraint`
- `collision:id.last_manifestation`
- `collision:id.outcome_type`
- `collision:id.aftermath`
- `collision:id.parent_collision_ids+`
- `collision:id.successor_collision_ids+`

### Full readme

Replace thin collision examples with full examples that include:

- `details`
- `cost`
- `target_constraint`

### Setup wizard

The default collision setup example should require:

- `details`
- `cost`

### Mode playbooks

Add or update collision-specific guidance so the model treats every collision as:

- a compact narrative object while live
- a recorded causal object when closed

## UI Changes

Collision cards should render more than:

- name
- forces
- distance
- cost

They should also show:

- `details`
- `target_constraint`
- `last_manifestation`
- `outcome_type`
- `aftermath`
- successor references

Resolved collisions should remain inspectable, not just collapse into one-line graves.

## Recommended Implementation Order

### Phase 1: Contract and docs

- normalize the documented lifecycle
- expand collision field guidance
- rewrite examples

### Phase 2: Audit layer

- add collision richness warnings
- add closure audit
- add backward compatibility for old `CRASHED` status

### Phase 3: Runtime behavior

- stop destroying crashed collisions immediately
- add convergence protocol for simultaneous arrivals
- add successor-linking expectations on closure

### Phase 4: UI

- show full collision story data
- show resolved collision aftermath and lineage

## Guiding Principle

A collision must be durable enough that if you read it cold, you understand:

- what is converging
- why it matters
- what it costs
- how it is showing up now
- how it ended
- what it left behind

If the ledger cannot tell that story, the model will improvise it, and drift follows.
