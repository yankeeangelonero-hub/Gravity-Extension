# PHASE2-ROUND3-FIXES

Source audit: `PHASE2-VERIFICATION-AUDIT.md` (§9 — 12-item fix list)
Scope: remove remaining Phase 2 violations in runtime code, readme strings, preset, and docs.
Status: **NOT COMMITTED** — apply group-by-group, syntax-check each file, then commit in ordered batches.
Line numbers verified against the main repo at `G:\My Drive\AI RPG\Gravity 2` (branch `codex-v13-state-delta`, post-PHASE2-FINAL-FIXES).

> Normative spec: `gravity_v15.json` L4 §2 (Phase 2 faction schema: `name / members / territory / state / agenda / knowledge_asymmetry`; cap 20 across the four flat KA buckets).
> Banned fields (any runtime file): faction `{objective, resources, stance_toward_pc, power, momentum, leverage, vulnerability, relations, last_move, comms_latency, last_verified_at, intel_posture, intel_on, false_beliefs, blindspots, reads}`; char `{condition, want, doing, intimacy_stance, noticed_details, reads, stance_toward_pc}`; pc `{reputation}`; collision `{details, cost, target_constraint}`; world `{constants.*, story_kind, guidelines, motivation, objective, length}`.

---

## Group 1 — LIVE BUG: `runtime.last_resolution.exchange` → `.clash`

**Severity:** CRITICAL (in-prompt bug). `challenge-state.js` migrates `runtime.exchange` → `runtime.clash` on load, but the combat profile builder still reads `.exchange`, so every locked-combat prompt emits `LAST RESOLUTION: clash undefined`.

**File:** `challenge-profile-combat.js:332`

### 1.1 — The read path

**OLD** (`challenge-profile-combat.js:330-333`):
```js
        if (runtime.last_resolution) {
            lines.push('');
            lines.push(`LAST RESOLUTION: clash ${runtime.last_resolution.exchange} | ${formatActionSummary(runtime.last_resolution.action)}`);
            lines.push(`LAST ROLL: ${formatRollSummary(runtime.last_resolution.roll)}`);
```

**NEW**:
```js
        if (runtime.last_resolution) {
            lines.push('');
            lines.push(`LAST RESOLUTION: clash ${runtime.last_resolution.clash} | ${formatActionSummary(runtime.last_resolution.action)}`);
            lines.push(`LAST ROLL: ${formatRollSummary(runtime.last_resolution.roll)}`);
```

### 1.2 — Stale comment

**OLD** (`challenge-profile-combat.js:266`):
```js
// Engine tracks clash counter (runtime.exchange) internally
```

**NEW**:
```js
// Engine tracks clash counter (runtime.clash) internally
```

### 1.3 — Prose referring to "rolled exchanges"

**OLD** (`challenge-profile-combat.js:399`):
```js
            lines.push('Record divination.last_draw in the update block for rolled exchanges.');
```

**NEW**:
```js
            lines.push('Record divination.last_draw in the update block for rolled clashes.');
```

---

## Group 2 — `state-view.js` faction live renderer rewrite (Phase 2 schema)

**Severity:** HIGH. Two code paths still read the banned faction schema (`reads / stance_toward_pc / power / objective / resources / momentum / leverage / vulnerability / comms_latency / last_verified_at / intel_posture / intel_on / relations`). The Phase 2 canonical faction fields are **`name / members / territory / state / agenda / knowledge_asymmetry`**.

### 2.1 — Singleton line (`state.world.constants` dead mention)

**OLD** (`state-view.js:272`):
```js
    lines.push('  world — constants, world_state, collision_archive');
```

**NEW**:
```js
    lines.push('  world — power_scale, power_ceiling, power_notes, world_state, collision_archive');
```

### 2.2 — Faction summary block (lite / combat / intimacy)

**OLD** (`state-view.js:306-329`):
```js
    // Factions — lite/combat/intimacy: name + stance + power; full: detail section below
    const factionEntities = Object.values(state.factions || {});
    const legacyFactions = Array.isArray(state.world.factions) ? state.world.factions : [];
    if (factionEntities.length || legacyFactions.length) {
        lines.push('');
        lines.push('Factions:');
        for (const f of factionEntities) {
            if (!showFullDetail) {
                const fStance = getLatestRead(f.reads, 'pc') || f.stance_toward_pc || '?';
                const fPower = f.power ? ` [${f.power}]` : '';
                lines.push(`  ${f.name || f.id}${fPower} | Stance: ${fStance} → id: ${f.id}`);
            } else {
                lines.push(`  ${f.name || f.id} → id: ${f.id}`);
            }
        }
        for (const f of legacyFactions) {
            if (typeof f === 'object' && f.name) {
                const alreadyListed = factionEntities.some(fe => fe.name === f.name);
                if (!alreadyListed) lines.push(`  ${f.name}: ${f.objective || ''} | Stance: ${f.stance_toward_pc || '?'}`);
            } else if (typeof f === 'string') {
                lines.push(`  ${f}`);
            }
        }
    }
```

**NEW**:
```js
    // Factions — lite/combat/intimacy: name + territory/state; full: detail section below
    const factionEntities = Object.values(state.factions || {});
    if (factionEntities.length) {
        lines.push('');
        lines.push('Factions:');
        for (const f of factionEntities) {
            const territory = f.territory ? ` @ ${f.territory}` : '';
            const fState = f.state ? ` [${f.state}]` : '';
            lines.push(`  ${f.name || f.id}${territory}${fState} → id: ${f.id}`);
        }
    }
```

Rationale: drops `legacyFactions` fallback (Phase 2 forbids `state.world.factions` array — it was purged from state-compute). Removes `f.reads / f.stance_toward_pc / f.power / f.objective`. Surfaces the canonical `territory` anchor and `state` label.

### 2.3 — Full-mode faction detail block

**OLD** (`state-view.js:405-457`):
```js
    // Factions detail — full mode only
    if (showFullDetail && factionEntities.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of factionEntities) {
            if (f.profile) {
                lines.push(`  ${f.name || f.id}: ${f.profile}`);
            } else {
                let line = `  ${f.name || f.id}: ${f.objective || ''}`;
                line += ` | Resources: ${f.resources || '?'}`;
                const factionStance = getLatestRead(f.reads, 'pc') || f.stance_toward_pc || '?';
                line += ` | Stance: ${factionStance}`;
                if (f.power) line += ` | Power: ${f.power}`;
                const momentum = f.last_move && f.momentum && !f.momentum.includes(f.last_move)
                    ? `${f.momentum}; last: ${f.last_move}` : (f.momentum || f.last_move || '');
                if (momentum) line += ` | Momentum: ${momentum}`;
                lines.push(line);
                if (f.leverage) lines.push(`    Leverage: ${f.leverage}`);
                if (f.vulnerability) lines.push(`    Vulnerability: ${f.vulnerability}`);
                if (f.comms_latency) lines.push(`    Comms latency: ${f.comms_latency}`);
                if (f.last_verified_at) lines.push(`    Last verified at: ${f.last_verified_at}`);
                if (f.intel_posture) lines.push(`    Intel posture: ${f.intel_posture}`);
            }
            if (f.intel_on && typeof f.intel_on === 'object' && Object.keys(f.intel_on).length) {
                lines.push('    Intel on:');
                for (const [subject, si] of Object.entries(f.intel_on)) {
                    if (typeof si !== 'object' || Array.isArray(si)) {
                        lines.push(`      ${subject}: ${si}`);
                        continue;
                    }
                    const siLines = [];
                    for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                        const map = si[bucket];
                        if (map && typeof map === 'object' && Object.keys(map).length) {
                            const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
                            for (const [k, v] of Object.entries(map)) {
                                siLines.push(`        [${label}] ${k}: ${v}`);
                            }
                        }
                    }
                    if (siLines.length) {
                        lines.push(`      ${subject}:`);
                        lines.push(...siLines);
                    }
                }
            }
            if (f.relations && typeof f.relations === 'object') {
                for (const [targetId, relation] of Object.entries(f.relations)) {
                    lines.push(`    ↔ ${targetId}: ${relation}`);
                }
            }
        }
    }
```

**NEW**:
```js
    // Factions detail — full mode only. Phase 2 schema: name/members/territory/state/agenda/knowledge_asymmetry.
    if (showFullDetail && factionEntities.length) {
        lines.push('');
        lines.push('FACTIONS');
        for (const f of factionEntities) {
            const header = [`  ${f.name || f.id}`];
            if (f.territory) header.push(`territory: ${f.territory}`);
            if (f.state) header.push(`state: ${f.state}`);
            lines.push(header.join(' | '));
            if (f.agenda) lines.push(`    Agenda: ${normalizeText(f.agenda)}`);
            const members = toList(f.members);
            if (members.length) lines.push(`    Members: ${members.join(', ')}`);
            const ka = f.knowledge_asymmetry;
            if (ka && typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const [k, v] of Object.entries(ka)) {
                    if (k === 'legacy') continue;
                    if (typeof v === 'string' && v) kaLines.push(`      ${k}: ${v}`);
                }
                if (ka.legacy) kaLines.push(`      [legacy] ${ka.legacy}`);
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            }
        }
    }
```

Rationale: emits the Phase 2 canonical fields only; flat `knowledge_asymmetry` map (keys already carry `knows_/unknown_/hiding_/misreading_` prefix per L4 §2.3); keeps the `legacy` rollup slot from state-compute migrations.

---

## Group 3 — `state-view.js` readme string cleanups

**Severity:** HIGH. The readme strings teach legacy fields to the LLM every turn — they are the primary source of faction/collision/char schema drift.

### 3.1 — Core readme "STANDARD SHAPE" example

**OLD** (`state-view.js:566-572`):
```
faction:zaft.knowledge_asymmetry.knows_archangel_status: "ship escaped damaged"
faction:zaft.knowledge_asymmetry.unknown_archangel_pilot: "Strike pilot identity unknown"
faction:zaft.knowledge_asymmetry.misreading_archangel-identity: "Assumes pilot still unconfirmed"
collision:trust-vs-duty.distance_category: SHORT
constraint:c1.integrity: STRESSED
char:elena.reads.pc: "Cautious ally"
world.collision_archive+: "[collision] ... [resolution] ... [hook] ... [aftermath] ..."
```

**NEW**:
```
faction:zaft.knowledge_asymmetry.knows_archangel_status: "ship escaped damaged"
faction:zaft.knowledge_asymmetry.unknown_archangel_pilot: "Strike pilot identity unknown"
faction:zaft.knowledge_asymmetry.misreading_archangel-identity: "Assumes pilot still unconfirmed"
faction:zaft.agenda: "Recover the N-Jammer cores before the Alliance regroups"
collision:trust-vs-duty.distance_category: SHORT
constraint:c1.integrity: STRESSED
char:elena.knowledge_asymmetry.hiding_trust: "Reads PC as a cautious ally but will not say so"
world.collision_archive+: "[collision] ... [resolution] ... [hook] ... [aftermath] ..."
```

Rationale: removes the `char:id.reads.pc` example (banned Phase 2 field) and adds a `faction:id.agenda` example to match Phase 2 schema.

### 3.2 — Char KA: nested→flat (match faction shape and L4 §2.3)

**OLD** (`state-view.js:588-594`):
```
  char:id.location
  char:id.knowledge_asymmetry.knows.<key>
  char:id.knowledge_asymmetry.unknown.<key>
  char:id.knowledge_asymmetry.hiding.<key>
  char:id.knowledge_asymmetry.misreading.<key>
  char:id.last_seen_at
  char:id.reads.pc
```

**NEW**:
```
  char:id.location
  char:id.knowledge_asymmetry.knows_<subject>
  char:id.knowledge_asymmetry.unknown_<subject>
  char:id.knowledge_asymmetry.hiding_<subject>
  char:id.knowledge_asymmetry.misreading_<subject>
  char:id.last_seen_at
  char:id.agenda
```

Rationale: AGENTS.md:90 declares `reads` is removed; char KA must use the flat form specified in L4 §2.3 so chars and factions share one grammar. The live char renderer at `state-view.js:155-176` already iterates **nested** buckets; see §3.3 for that fix.

### 3.3 — Char-dossier KA renderer: read flat keys

**OLD** (`state-view.js:154-176`):
```js
        // TRACKED+ fields: knowledge_asymmetry, last_seen_at
        const ka = char.knowledge_asymmetry;
        if (ka !== undefined && ka !== null) {
            if (typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                    const map = ka[bucket];
                    if (map && typeof map === 'object' && Object.keys(map).length) {
                        const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
                        for (const [k, v] of Object.entries(map)) {
                            kaLines.push(`      [${label}] ${k}: ${v}`);
                        }
                    }
                }
                if (ka.legacy) kaLines.push(`      [legacy] ${ka.legacy}`);
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            } else if (typeof ka === 'string' && ka) {
                lines.push(`    Knowledge asymmetry: ${normalizeText(ka)}`);
            }
        }
```

**NEW**:
```js
        // TRACKED+ fields: knowledge_asymmetry (flat keys: knows_/unknown_/hiding_/misreading_/legacy), last_seen_at
        const ka = char.knowledge_asymmetry;
        if (ka !== undefined && ka !== null) {
            if (typeof ka === 'object' && !Array.isArray(ka)) {
                const kaLines = [];
                for (const [k, v] of Object.entries(ka)) {
                    if (k === 'legacy') continue;
                    if (typeof v === 'string' && v) kaLines.push(`      ${k}: ${v}`);
                }
                if (ka.legacy) kaLines.push(`      [legacy] ${ka.legacy}`);
                if (kaLines.length) {
                    lines.push('    Knowledge asymmetry:');
                    lines.push(...kaLines);
                }
            } else if (typeof ka === 'string' && ka) {
                lines.push(`    Knowledge asymmetry: ${normalizeText(ka)}`);
            }
        }
```

Rationale: Phase 2 char KA is a flat map keyed by `knows_<subject> / unknown_<subject> / hiding_<subject> / misreading_<subject>`, with `legacy` as a single rollup string slot. This matches the faction shape.

### 3.4 — Char dossier: surface `agenda`

**OLD** (`state-view.js:177-179`):
```js
        if (char.last_seen_at !== undefined && char.last_seen_at !== null && normalizeText(char.last_seen_at)) {
            lines.push(`    Last seen at: ${normalizeText(char.last_seen_at)}`);
        }
```

**NEW**:
```js
        if (char.agenda) lines.push(`    Agenda: ${normalizeText(char.agenda)}`);
        if (char.last_seen_at !== undefined && char.last_seen_at !== null && normalizeText(char.last_seen_at)) {
            lines.push(`    Last seen at: ${normalizeText(char.last_seen_at)}`);
        }
```

Rationale: `agenda` is the Phase 2 replacement for `want / doing`. The preset L1 State Contract expects it to appear on the dossier surface (see `gravity_v15.json` L1 entry).

### 3.5 — Faction paths list (drop legacy intel fields)

**OLD** (`state-view.js:595-601`):
```
  faction:id.comms_latency
  faction:id.last_verified_at
  faction:id.intel_posture
  faction:id.knowledge_asymmetry.knows_<subject>
  faction:id.knowledge_asymmetry.unknown_<subject>
  faction:id.knowledge_asymmetry.hiding_<subject>
  faction:id.knowledge_asymmetry.misreading_<subject>
```

**NEW**:
```
  faction:id.name
  faction:id.territory
  faction:id.state
  faction:id.agenda
  faction:id.members+
  faction:id.knowledge_asymmetry.knows_<subject>
  faction:id.knowledge_asymmetry.unknown_<subject>
  faction:id.knowledge_asymmetry.hiding_<subject>
  faction:id.knowledge_asymmetry.misreading_<subject>
```

### 3.6 — Collision paths (remove `details / cost / target_constraint`)

**OLD** (`state-view.js:606-617`):
```
  collision:id.name
  collision:id.forces
  collision:id.details
  collision:id.cost
  collision:id.target_constraint
  collision:id.distance_category   (set on creation: IMMEDIATE|SHORT|MEDIUM|LONG)
  collision:id.distance             (engine-owned — read only; do not SET)
  collision:id.location
  collision:id.involved_chars
  collision:id.status
  collision:id.outcome_type
  collision:id.aftermath
```

**NEW**:
```
  collision:id.name
  collision:id.forces
  collision:id.distance_category   (set on creation: IMMEDIATE|SHORT|MEDIUM|LONG)
  collision:id.distance             (engine-owned — read only; do not SET)
  collision:id.location
  collision:id.involved_chars
  collision:id.status
  collision:id.outcome_type
  collision:id.aftermath
```

### 3.7 — Full readme: REMOVE example using `noticed_details`

**OLD** (`state-view.js:729-730`):
```
REMOVE — remove from an array field
  > REMOVE char:tifa field=noticed_details value="Scratches on bracer" -- Detail resolved
```

**NEW**:
```
REMOVE — remove from an array field
  > REMOVE char:tifa field=key_moments value="[Day 1 — 22:00] Confronted Cloud at the well." -- Prune after consolidation
```

Rationale: `noticed_details` is removed in Phase 2; `key_moments` is the still-valid char array that can be pruned.

### 3.8 — READ op block (remove; Phase 2 has no `reads` field)

**OLD** (`state-view.js:732-733`):
```
READ — append a read entry (shorthand for MAP_SET on reads; engine caps log at 5, newest wins)
  > READ char:tifa target=cloud "Something wrong with his memories" -- Updated after evasion
```

**NEW**: *(delete both lines)*

### 3.9 — MAP_SET example (remove `pc.reputation`)

**OLD** (`state-view.js:735-736`):
```
MAP_SET — set a key in a map field
  > MAP_SET pc field=reputation key=tifa value="Investor. Unbearable. Has a room now." -- Reputation narrative
```

**NEW**:
```
MAP_SET — set a key in a map field
  > MAP_SET char:elena field=knowledge_asymmetry key=hiding_pc value="Reads PC as cautious but will not say so" -- Flat-key KA
```

Rationale: `pc.reputation` is banned; KA is the canonical "how X sees Y" channel.

### 3.10 — Intimacy guide: drop `intimacy_stance` reference

**OLD** (`state-view.js:767`):
```
The system tracks this through intimacy_stance (where they are) and intimate_history (what happened).
```

**NEW**:
```
The system tracks this through intimate_history (what happened) and knowledge_asymmetry (what they hide or misread about each other).
```

### 3.11 — MAP_DEL example (remove `reads`)

**OLD** (`state-view.js:818-819`):
```
MAP_DEL — remove a key from a map field
  > MAP_DEL char:tifa field=reads key=barret -- No longer relevant
```

**NEW**:
```
MAP_DEL — remove a key from a map field
  > MAP_DEL char:tifa field=knowledge_asymmetry key=hiding_barret -- Reveal no longer relevant
```

### 3.12 — FACTIONS block: replace full legacy example with Phase 2

**OLD** (`state-view.js:824-838`):
```
FACTIONS — create and manage factions with political simulation
  > CREATE faction:shinra name="Shinra Corp" objective="Control the reactors" resources="Military" stance_toward_pc="Hostile" power="stable" momentum="Expanding into Sector 7" leverage="Military force" vulnerability="Public opinion" -- Full political profile
  > SET faction:shinra field=power value="declining" -- Lost reactor control
  > MAP_SET faction:shinra field=relations key=avalanche value="Hostile — active operations against" -- Inter-faction relation
  > SET faction:zaft field=comms_latency value="Ship-to-ship near-real-time; long-range relay delayed by jamming" -- Intel travel speed
  > SET faction:zaft field=last_verified_at value="[Day 4 — 09:20]" -- Last trustworthy refresh
  > MAP_SET faction:zaft field=intel_on key=archangel.knows.status value="Ship escaped damaged" -- Confirmed intel
  > MAP_SET faction:zaft field=intel_on key=archangel.unknown.pilot value="Strike pilot identity" -- Known gap
  > MAP_SET faction:zaft field=intel_on key=archangel.misreading.pilot-identity value="Assumes pilot still unconfirmed" -- False belief

  Faction fields: name, objective, resources, stance_toward_pc, power (rising/stable/declining/collapsed),
  momentum (current action), last_move (last visible action), leverage, vulnerability,
  relations (map: faction_id → stance string). Optional: doctrine, leadership, territory, alliances,
  comms_latency, last_verified_at, intel_posture,
  intel_on (nested map: subject → {knows, unknown, hiding, misreading} — four buckets per subject).
```

**NEW**:
```
FACTIONS — create and manage factions as organizations with territory, agenda, and asymmetric knowledge
  > CREATE faction:shinra name="Shinra Corp" territory="Midgar plate" state="dominant" agenda="Consolidate reactor control before the Wutai investigation lands" -- Phase 2 shape
  > SET faction:shinra field=state value="declining" -- Lost reactor control
  > SET faction:shinra field=agenda value="Recover reactor control before the board meets" -- Agenda shifts with story
  > APPEND faction:shinra field=members value="char:tseng" -- Named member
  > MAP_SET faction:zaft field=knowledge_asymmetry key=knows_archangel_status value="Ship escaped damaged" -- Confirmed intel
  > MAP_SET faction:zaft field=knowledge_asymmetry key=unknown_archangel_pilot value="Strike pilot identity" -- Known gap
  > MAP_SET faction:zaft field=knowledge_asymmetry key=misreading_archangel-identity value="Assumes pilot still unconfirmed" -- False belief

  Faction fields (Phase 2): name, members (array of char: ids or string names), territory, state,
  agenda, knowledge_asymmetry (flat map; keys: knows_<subject> / unknown_<subject> / hiding_<subject> /
  misreading_<subject>; cap 20 across all four categories).
```

### 3.13 — "COLLISIONS ARE STORY ENGINES" block (strip banned field teaching)

**OLD** (`state-view.js:854-863`):
```
COLLISIONS ARE STORY ENGINES, NOT LABELS:
  Every live collision should tell you, cold:
  1. what is converging
  2. who or what is trapped in it
  3. what engagement, delay, or failure costs
  4. how it is showing up in the scene right now
  5. what forced choice is looming
  details           — the story capsule for the collision
  cost              — the price of delay, engagement, or failure
  target_constraint — which tracked defense this pressure is leaning on (if personal)
```

**NEW**:
```
COLLISIONS ARE STORY ENGINES, NOT LABELS:
  Every live collision should tell you, cold:
  1. what is converging (forces)
  2. who is in the line of fire (involved_chars)
  3. where it is landing (location)
  4. how close it is (distance_category → distance)
  5. what status it sits in (ACTIVE → RESOLVED or CRASHED)
  Cost, stakes, and tactical detail live in scene prose and the collision's `forces` string —
  not as separate structured fields.
```

### 3.14 — PRIORITY ORDER block (`DOING/WANT` → Phase 2 equivalent)

**OLD** (`state-view.js:896-898`):
```
PRIORITY ORDER — when near the cap, emit in this order:
  1. State machine transitions  2. Collision distance  3. DOING/WANT  4. World state
  5. Faction updates  6. Summary  7. Moments/details  8. READS  9. PC  10. Intimate history
  11. REMOVEs — always last, 2–3 max
```

**NEW**:
```
PRIORITY ORDER — when near the cap, emit in this order:
  1. State machine transitions  2. Collision distance  3. agenda / knowledge_asymmetry  4. World state
  5. Faction updates  6. Key moments  7. Scene / PC location  8. Intimate history
  9. REMOVEs — always last, 2–3 max
```

### 3.15 — Example in EVOLVED block still uses `cost=` + `details=`

**OLD** (`state-view.js:885`):
```
  > CREATE collision:handler-convergence name="Handler Convergence" status=ACTIVE distance=7 forces="handler network, Arcueid's exposure" cost="If they move first: extraction becomes impossible" details="The watcher's transmission went through. The handler network now has a confirmed sighting. This is not over — it has moved upstream." parent_collision_ids=shadow-activity
```

**NEW**:
```
  > CREATE collision:handler-convergence name="Handler Convergence" distance_category=SHORT forces="handler network advancing on Arcueid; if they move first extraction becomes impossible" location=district-safehouse involved_chars=[pc,arcueid] parent_collision_ids=shadow-activity
```

Rationale: drops `status=ACTIVE` (L4 forbids setting status on creation; engine defaults to ACTIVE), drops `distance=` literal (Phase 2 uses `distance_category` and lets the engine compute `distance`), replaces `cost`/`details` with a richer `forces` string that carries the stakes, and adds the canonical `location`/`involved_chars`.

---

## Group 4 — `state-compute.js` legacy collision-status migration

**Severity:** HIGH. The audit confirmed there is no migration for collisions whose status was written as `SEEDED / SIMMERING / RESOLVING` in earlier chats. On replay they stay non-canonical, which causes `state-view.js` filter `cl.status !== 'RESOLVED' && cl.status !== 'CRASHED'` to keep them live but mis-labelled, and validateTransition to reject follow-on `TR`s.

### 4.1 — Add a helper + call it from CR / TR / S

**OLD** (`state-compute.js:260-319`):
```js
    switch (tx.op) {
        case 'CR': {
            if (isSingleton) {
                Object.assign(state[collection], tx.d);
            } else {
                const data = { id: tx.id, ...tx.d };
                // Normalize place defaults
                if (tx.e === 'place') {
                    if (!data.reach) data.reach = 'LOCAL';
                    if (!data.state) data.state = 'unknown';
                }
                // Pressure entity: engine stamps created_at_tx from tx.tx (LLM-supplied value overwritten)
                if (tx.e === 'pressure') {
                    data.created_at_tx = tx.tx;
                }
                // Phase 2: distance_category → canonical starting distance
                if (tx.e === 'collision') {
                    if (data.distance_category) {
                        data.distance = CATEGORY_DISTANCES[data.distance_category] ?? 10;
                    } else {
                        // Old tx without category — default to SHORT
                        data.distance_category = 'SHORT';
                        if (data.distance == null) data.distance = 10;
                    }
                    if (!data.status) data.status = 'ACTIVE';
                }
                state[collection][tx.id] = data;
            }
            break;
        }

        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                target[tx.d.f] = tx.d.to;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && tx.d.f === 'status' && tx.d.to === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, tx.d.to, tx);
            }
            break;
        }

        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                target[tx.d.f] = tx.d.v;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && tx.d.f === 'status' && tx.d.v === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                if (oldVal !== tx.d.v) {
                    recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, tx.d.v, tx);
                }
            }
            break;
        }
```

**NEW**:
```js
    // Phase 2: legacy collision statuses migrate to ACTIVE (SEEDED/SIMMERING/RESOLVING were
    // removed from the state machine; chats containing them must still replay cleanly).
    const migrateCollisionStatus = (val) => {
        if (val === 'SEEDED' || val === 'SIMMERING' || val === 'RESOLVING') return 'ACTIVE';
        return val;
    };

    switch (tx.op) {
        case 'CR': {
            if (isSingleton) {
                Object.assign(state[collection], tx.d);
            } else {
                const data = { id: tx.id, ...tx.d };
                // Normalize place defaults
                if (tx.e === 'place') {
                    if (!data.reach) data.reach = 'LOCAL';
                    if (!data.state) data.state = 'unknown';
                }
                // Pressure entity: engine stamps created_at_tx from tx.tx (LLM-supplied value overwritten)
                if (tx.e === 'pressure') {
                    data.created_at_tx = tx.tx;
                }
                // Phase 2: distance_category → canonical starting distance
                if (tx.e === 'collision') {
                    if (data.distance_category) {
                        data.distance = CATEGORY_DISTANCES[data.distance_category] ?? 10;
                    } else {
                        // Old tx without category — default to SHORT
                        data.distance_category = 'SHORT';
                        if (data.distance == null) data.distance = 10;
                    }
                    data.status = migrateCollisionStatus(data.status) || 'ACTIVE';
                }
                state[collection][tx.id] = data;
            }
            break;
        }

        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                let toVal = tx.d.to;
                if (tx.e === 'collision' && tx.d.f === 'status') {
                    toVal = migrateCollisionStatus(toVal);
                }
                target[tx.d.f] = toVal;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && tx.d.f === 'status' && toVal === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, toVal, tx);
            }
            break;
        }

        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                let newVal = tx.d.v;
                if (tx.e === 'collision' && tx.d.f === 'status') {
                    newVal = migrateCollisionStatus(newVal);
                }
                target[tx.d.f] = newVal;
                // Phase 2: when collision lands in CRASHED, default outcome_type if absent
                if (tx.e === 'collision' && tx.d.f === 'status' && newVal === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                if (oldVal !== newVal) {
                    recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, newVal, tx);
                }
            }
            break;
        }
```

Rationale: migrates any replay-era tx that targets `collision.status` with a legacy value, so the post-replay state always has `ACTIVE / RESOLVED / CRASHED`.

---

## Group 5 — `state-compute.js`: migrate & drop faction `intel_on` (stop treating it as live)

**Severity:** HIGH. `normalizeFactionIntel` currently **re-initializes** `faction.intel_on = {}` on every replay (line 128) and back-fills `comms_latency / last_verified_at / intel_posture` as empty strings. Phase 2's canonical channel is flat `knowledge_asymmetry`, so these fields should be migrated **once** then left off.

### 5.1 — Replace `normalizeFactionIntel` with a migrate-and-drop pass

**OLD** (`state-compute.js:100-165`):
```js
function ensureIntelSubject(intel_on, subject) {
    if (typeof intel_on[subject] !== 'object' || Array.isArray(intel_on[subject])) {
        intel_on[subject] = {};
    }
    const s = intel_on[subject];
    if (!s.knows || typeof s.knows !== 'object') s.knows = {};
    if (!s.unknown || typeof s.unknown !== 'object') s.unknown = {};
    if (!s.hiding || typeof s.hiding !== 'object') s.hiding = {};
    if (!s.misreading || typeof s.misreading !== 'object') s.misreading = {};
}

function normalizeFactionIntel(state) {
    for (const faction of Object.values(state.factions || {})) {
        if (faction.comms_latency === undefined || faction.comms_latency === null) {
            faction.comms_latency = '';
        }
        if (faction.last_verified_at === undefined || faction.last_verified_at === null) {
            faction.last_verified_at = '';
        }
        if (faction.intel_posture === undefined || faction.intel_posture === null) {
            faction.intel_posture = '';
        }
        // Migrate top-level blindspots string to a display-only legacy slot, then drop.
        if (typeof faction.blindspots === 'string') {
            const topLegacy = faction.blindspots.trim();
            if (topLegacy) faction.blindspots_legacy = topLegacy;
            delete faction.blindspots;
        }
        if (!faction.intel_on || typeof faction.intel_on !== 'object' || Array.isArray(faction.intel_on)) {
            faction.intel_on = {};
        }
        // Migrate legacy intel_on string values to .knows.legacy
        for (const [subject, val] of Object.entries(faction.intel_on)) {
            if (typeof val === 'string') {
                const trimmed = val.trim();
                faction.intel_on[subject] = trimmed
                    ? { knows: { legacy: trimmed }, unknown: {}, hiding: {}, misreading: {} }
                    : { knows: {}, unknown: {}, hiding: {}, misreading: {} };
            } else {
                ensureIntelSubject(faction.intel_on, subject);
            }
        }
        // Fold false_beliefs into intel_on.<subject>.misreading.legacy
        if (faction.false_beliefs && typeof faction.false_beliefs === 'object' && !Array.isArray(faction.false_beliefs)) {
            for (const [subject, belief] of Object.entries(faction.false_beliefs)) {
                if (typeof belief !== 'string' || !belief.trim()) continue;
                if (!faction.intel_on[subject]) ensureIntelSubject(faction.intel_on, subject);
                if (!faction.intel_on[subject].misreading.legacy) {
                    faction.intel_on[subject].misreading.legacy = belief.trim();
                }
            }
        }
        delete faction.false_beliefs;
        // Fold blindspots map (per-subject prose) into intel_on.<subject>.unknown.legacy.
        if (faction.blindspots && typeof faction.blindspots === 'object' && !Array.isArray(faction.blindspots)) {
            for (const [subject, gap] of Object.entries(faction.blindspots)) {
                if (typeof gap !== 'string' || !gap.trim()) continue;
                if (!faction.intel_on[subject]) ensureIntelSubject(faction.intel_on, subject);
                if (!faction.intel_on[subject].unknown.legacy) {
                    faction.intel_on[subject].unknown.legacy = gap.trim();
                }
            }
            delete faction.blindspots;
        }
    }
}
```

**NEW**:
```js
// Phase 2: faction shape is name/members/territory/state/agenda/knowledge_asymmetry.
// Anything else written by legacy chats must migrate INTO knowledge_asymmetry and then
// be dropped from the faction entity — `intel_on`, `blindspots`, `false_beliefs`,
// `comms_latency`, `last_verified_at`, `intel_posture`, `reads`, `stance_toward_pc`,
// `power`, `momentum`, `leverage`, `vulnerability`, `last_move`, `objective`, `resources`,
// `relations` are all removed at load time.
function migrateFactionToPhase2(state) {
    const LEGACY_FACTION_FIELDS = [
        'comms_latency', 'last_verified_at', 'intel_posture', 'reads',
        'stance_toward_pc', 'power', 'momentum', 'leverage', 'vulnerability',
        'last_move', 'objective', 'resources', 'relations', 'doctrine', 'leadership',
        'alliances', 'profile',
    ];

    for (const faction of Object.values(state.factions || {})) {
        if (!faction.knowledge_asymmetry || typeof faction.knowledge_asymmetry !== 'object' || Array.isArray(faction.knowledge_asymmetry)) {
            faction.knowledge_asymmetry = {};
        }
        const ka = faction.knowledge_asymmetry;
        const setKaKey = (key, value) => {
            if (typeof value !== 'string' || !value.trim()) return;
            if (!ka[key]) ka[key] = value.trim();
        };

        // Migrate intel_on (nested subject → {knows, unknown, hiding, misreading}) into flat keys.
        if (faction.intel_on && typeof faction.intel_on === 'object' && !Array.isArray(faction.intel_on)) {
            for (const [subject, si] of Object.entries(faction.intel_on)) {
                if (typeof si === 'string') {
                    setKaKey(`knows_${subject}`, si);
                    continue;
                }
                if (!si || typeof si !== 'object') continue;
                for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                    const map = si[bucket];
                    if (!map || typeof map !== 'object') continue;
                    for (const [k, v] of Object.entries(map)) {
                        if (typeof v !== 'string' || !v.trim()) continue;
                        const flatKey = k === 'legacy' ? `${bucket}_${subject}` : `${bucket}_${subject}_${k}`;
                        setKaKey(flatKey, v);
                    }
                }
            }
        }
        delete faction.intel_on;

        // Migrate false_beliefs (map: subject → belief) into misreading_<subject>.
        if (faction.false_beliefs && typeof faction.false_beliefs === 'object' && !Array.isArray(faction.false_beliefs)) {
            for (const [subject, belief] of Object.entries(faction.false_beliefs)) {
                setKaKey(`misreading_${subject}`, belief);
            }
        }
        delete faction.false_beliefs;

        // Migrate blindspots (string or map) into unknown_<subject> or a rollup legacy key.
        if (typeof faction.blindspots === 'string') {
            setKaKey('legacy', faction.blindspots);
        } else if (faction.blindspots && typeof faction.blindspots === 'object' && !Array.isArray(faction.blindspots)) {
            for (const [subject, gap] of Object.entries(faction.blindspots)) {
                setKaKey(`unknown_${subject}`, gap);
            }
        }
        delete faction.blindspots;
        delete faction.blindspots_legacy;

        // Drop all remaining banned fields.
        for (const field of LEGACY_FACTION_FIELDS) {
            delete faction[field];
        }

        // Cap flat KA at 20 entries (L4 §2.3). Oldest keys win insertion order; drop excess.
        const kaKeys = Object.keys(ka);
        if (kaKeys.length > 20) {
            for (const k of kaKeys.slice(20)) delete ka[k];
        }
    }
}
```

### 5.2 — Update the single call site

Search and replace any call to `normalizeFactionIntel(state)` with `migrateFactionToPhase2(state)`. Confirm only one call exists inside `state-compute.js`.

```bash
# Verify before commit:
grep -n 'normalizeFactionIntel\|migrateFactionToPhase2' state-compute.js
```

Expected: one function definition + one call site, both using the new name.

---

## Group 6 — `gravity_v15.json` preset: purge `want / doing / condition`

**Severity:** HIGH. Preset entries teach the LLM the banned vocabulary every turn. L1 State Contract is already Phase 2 (it says `agenda` + flat KA). Fixes:

### 6.1 — `| Character Voice` (identifier `v01ce000-...`, enabled)

**OLD** (`gravity_v15.json:501`, field `content`, excerpt):
```
The dossier's tier, condition, and background constrain the word ceiling.
```

**NEW**:
```
The dossier's tier, tracked constraints, and background constrain the word ceiling.
```

### 6.2 — `| L0 - Cast Reminder` (identifier `2125f620-...`, enabled)

**OLD** (`gravity_v15.json:515`, field `content`):
```
### Cast Reminder\n\nCharacter tiers:\n- KNOWN: named presence, light tracking.\n- TRACKED: active dossier, wants, reads, constraint pressure.\n- PRINCIPAL: deepest dramatic surface; constraints matter most.\n\nNoticed details are loaded guns.\nReads are active interpretations and may be wrong.\nKnowledge asymmetry is the live firewall: what a character knows, does not know, is hiding, or is misreading.\nIf the protagonist is mirrored as both `pc` and `char:<id>`, keep the `char:<id>` dossier current too; `pc.*` does not replace `char:*` social/knowledge updates.\nDoing should include the present action and its current cost.
```

**NEW**:
```
### Cast Reminder\n\nCharacter tiers:\n- KNOWN: named presence, light tracking.\n- TRACKED: active dossier (agenda + flat knowledge_asymmetry), constraint pressure.\n- PRINCIPAL: deepest dramatic surface; constraints matter most.\n\nAgenda is what the character is currently trying to accomplish — scene-scoped, not a life goal.\nKnowledge asymmetry is the live firewall: flat keys `knows_<subject>`, `unknown_<subject>`, `hiding_<subject>`, `misreading_<subject>` (cap 20 across all four).\nIf the protagonist is mirrored as both `pc` and `char:<id>`, keep the `char:<id>` dossier current too; `pc.*` does not replace `char:*` social/knowledge updates.
```

Rationale: removes `wants / reads / Noticed details / Doing` (all Phase 2 banned), replaces with `agenda + flat knowledge_asymmetry` — matching L1 State Contract and L4 §2.3.

### 6.3 — `| L2 - Gravity Kernel` (identifier `ad5a57b2-...`, enabled)

**OLD** (`gravity_v15.json:529`, field `content`, excerpt):
```
- Consistency: characters behave according to their wants, constraints, and established nature.
```

**NEW**:
```
- Consistency: characters behave according to their agenda, constraints, and established nature.
```

### 6.4 — (No change) `| Dossier-Driven Prose`

Keep as-is — its "this arc" and "newly seeded" language is narrative, not Phase 2 schema.

---

## Group 7 — `setup-wizard.js`: drop `status=ACTIVE` from setup CREATE

**Severity:** MEDIUM. L4 §3.4 forbids setting `status` on collision creation; the engine defaults to `ACTIVE`. The setup readme is teaching the forbidden form.

**OLD** (`setup-wizard.js:216`):
```
> CREATE collision:slug name="..." status=ACTIVE distance_category=MEDIUM ...
```

**NEW**:
```
> CREATE collision:slug name="..." distance_category=MEDIUM forces="..." involved_chars=[pc,...] location=... ...
```

---

## Group 8 — AGENTS.md + CLAUDE.md: correct stale claims

### 8.1 — `validateTransition` call-site line number

**OLD** (`AGENTS.md:85` and `CLAUDE.md:85`, identical text):
```
- **State machines** (char tiers, constraint integrity, collision status, combat status) are documented in `state-machine.js`. `validateTransition()` (state-machine.js:79) is called from `index.js:1551` at commit time to reject invalid TRs.
```

**NEW** (both files):
```
- **State machines** (char tiers, constraint integrity, collision status, combat status) are documented in `state-machine.js`. `validateTransition()` (state-machine.js:79) is called from `index.js:1514` at commit time to reject invalid TRs.
```

### 8.2 — AGENTS.md: reconcile `reads / noticed_details / intel_on` claim with code

**OLD** (`AGENTS.md:90`):
```
- **Knowledge asymmetry**: a first-class Phase 2 field on TRACKED/PRINCIPAL chars and on factions. Use a flat map of `knows_<subject>`, `unknown_<subject>`, `hiding_<subject>`, `misreading_<subject>` keys (cap 20 across all four categories). Mutate via `MS`/`MR` on `field=knowledge_asymmetry`; `reads` and `noticed_details` are removed.
```

**NEW**:
```
- **Knowledge asymmetry**: a first-class Phase 2 field on TRACKED/PRINCIPAL chars and on factions. Use a flat map of `knows_<subject>`, `unknown_<subject>`, `hiding_<subject>`, `misreading_<subject>` keys (cap 20 across all four categories). Mutate via `MS`/`MR` on `field=knowledge_asymmetry`. Legacy fields `reads`, `noticed_details`, `stance_toward_pc`, `pc.reputation`, and faction `intel_on` / `blindspots` / `false_beliefs` are all migrated into `knowledge_asymmetry` by `state-compute.migrateFactionToPhase2()` at load time and then dropped from the faction entity.
```

### 8.3 — `index.js` line-count claim

**OLD** (`CLAUDE.md:102`):
```
- `index.js` is the central coordinator (~2,300 lines). It wires all modules together and handles the turn lifecycle.
```

**NEW**:
```
- `index.js` is the central coordinator (~2,250 lines). It wires all modules together and handles the turn lifecycle.
```

**OLD** (`AGENTS.md:108`):
```
- `index.js` is the central coordinator (~2,300 lines). It wires all modules together and handles the turn lifecycle.
```

**NEW**:
```
- `index.js` is the central coordinator (~2,250 lines). It wires all modules together and handles the turn lifecycle.
```

---

## Group 9 — `state-view.js` PC DOSSIER: remove `char.reads.pc / stance_toward_pc / pc.reputation` reads

**Severity:** MEDIUM. The PC DOSSIER block still reads three banned channels. Phase 2 surfaces PC reputation through `char.knowledge_asymmetry` keys like `hiding_pc / misreading_pc / knows_pc`.

**OLD** (`state-view.js:481-522`):
```js
    // PC dossier — traits & reads (intimacy and full modes)
    if (showIntimacy && state.pc.name) {
        lines.push('');
        lines.push(`PC DOSSIER: ${state.pc.name}`);
        // Traits — intimacy: last 5, full: last 10
        const allTraits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
        const traitCap = isFull ? 10 : 5;
        const traits = allTraits.slice(-traitCap);
        if (traits.length) {
            const traitPrefix = allTraits.length > traitCap ? `  Traits (${allTraits.length} total, showing last ${traitCap}): ` : '  Traits: ';
            lines.push(`${traitPrefix}${traits.join(', ')}`);
        }
        // Reads/reputation — how others see the PC
        const pcReputation = [];
        for (const char of Object.values(state.characters)) {
            if (char.tier === 'UNKNOWN') continue;
            // In intimacy mode, skip KNOWN (their reads are low-fidelity)
            if (isIntimacy && !isFull && char.tier === 'KNOWN') continue;
            const readsLog = char.reads?.pc || char.reads?.[state.pc.name];
            const readsArr = Array.isArray(readsLog) ? readsLog : (readsLog ? [readsLog] : null);
            const readOfPc = readsArr ? readsArr[readsArr.length - 1] : char.stance_toward_pc;
            if (readOfPc) pcReputation.push({ who: char.name || char.id, read: readOfPc, log: readsArr });
        }
        // Legacy pc.reputation entries not covered by character reads
        const legacyRep = (state.pc.reputation && typeof state.pc.reputation === 'object' && !Array.isArray(state.pc.reputation)) ? state.pc.reputation : {};
        for (const [who, r] of Object.entries(legacyRep)) {
            if (!pcReputation.some(p => p.who.toLowerCase().includes(who.toLowerCase()))) {
                pcReputation.push({ who, read: r });
            }
        }
        if (pcReputation.length) {
            lines.push(`  How others see PC:`);
            for (const { who, read, log } of pcReputation) {
                if (isFull && log && log.length > 1) {
                    lines.push(`    ${who} (${log.length} reads):`);
                    for (const entry of log) lines.push(`      - ${entry}`);
                } else {
                    lines.push(`    ${who}: ${read}`);
                }
            }
        }
    }
```

**NEW**:
```js
    // PC dossier — traits & how-others-see-PC (intimacy and full modes).
    // Phase 2: "how X sees PC" lives in X.knowledge_asymmetry — look for keys mentioning pc.
    if (showIntimacy && state.pc.name) {
        lines.push('');
        lines.push(`PC DOSSIER: ${state.pc.name}`);
        const allTraits = Array.isArray(state.pc.demonstrated_traits) ? state.pc.demonstrated_traits : (state.pc.demonstrated_traits ? [String(state.pc.demonstrated_traits)] : []);
        const traitCap = isFull ? 10 : 5;
        const traits = allTraits.slice(-traitCap);
        if (traits.length) {
            const traitPrefix = allTraits.length > traitCap ? `  Traits (${allTraits.length} total, showing last ${traitCap}): ` : '  Traits: ';
            lines.push(`${traitPrefix}${traits.join(', ')}`);
        }
        const pcReads = [];
        for (const char of Object.values(state.characters)) {
            if (char.tier === 'UNKNOWN') continue;
            if (isIntimacy && !isFull && char.tier === 'KNOWN') continue;
            const ka = char.knowledge_asymmetry;
            if (!ka || typeof ka !== 'object' || Array.isArray(ka)) continue;
            const pcEntries = [];
            for (const [k, v] of Object.entries(ka)) {
                if (typeof v !== 'string' || !v) continue;
                if (k === 'legacy') continue;
                if (k.endsWith('_pc') || k.includes('_pc_') || k.toLowerCase().includes(state.pc.name.toLowerCase())) {
                    pcEntries.push(`${k}: ${v}`);
                }
            }
            if (pcEntries.length) pcReads.push({ who: char.name || char.id, entries: pcEntries });
        }
        if (pcReads.length) {
            lines.push(`  How others see PC:`);
            for (const { who, entries } of pcReads) {
                lines.push(`    ${who}:`);
                for (const e of entries) lines.push(`      - ${e}`);
            }
        }
    }
```

Rationale: removes reads of `char.reads`, `char.stance_toward_pc`, and `state.pc.reputation` entirely; surfaces PC-relevant KA keys instead. The Phase 2 data-flow is: "how does X see PC?" → `char:X.knowledge_asymmetry.{knows_pc,hiding_pc,misreading_pc,...}`.

---

## Group 10 — `state-view.js` helper: strip `getCollisionNarrativeLines` reads of banned collision fields

**Severity:** MEDIUM. Verify helper at top of file doesn't still concatenate `col.details / col.cost / col.target_constraint`. The audit flagged lines 35-50.

**OLD** (`state-view.js:35-50` — exact text must be read live by implementer before edit):
The helper currently returns additional lines when any of `col.details / col.cost / col.target_constraint` are truthy.

**NEW**: Remove the three `if (col.details) … / if (col.cost) … / if (col.target_constraint) …` branches. Keep only `col.forces`, `col.location`, `col.involved_chars`, and `col.aftermath` (post-RESOLVED). The narrative render should degrade to just the header line when the collision has no `forces` string.

Pseudocode target:
```js
function getCollisionNarrativeLines(col) {
    const lines = [];
    if (col.forces) lines.push(`Forces: ${col.forces}`);
    if (col.location) lines.push(`Location: ${col.location}`);
    const involved = toList(col.involved_chars);
    if (involved.length) lines.push(`Involved: ${involved.join(', ')}`);
    if (col.aftermath) lines.push(`Aftermath: ${col.aftermath}`);
    return lines;
}
```

Implementer: read `state-view.js:15-55` immediately before editing and preserve the surrounding signature + any helper functions (`normalizeText`, `toList`) that the renderer uses.

---

## Group 11 — `index.js` wire the already-declared `MAX_COLLISION_ARCHIVE`

**Severity:** LOW. `index.js:74` declares `const MAX_COLLISION_ARCHIVE = 20;` but `state-compute.js:337` still uses the literal `20`. Either export or re-declare.

### Option A — re-declare in state-compute (preferred: keep modules independent)

**OLD** (`state-compute.js`, near the top — read live before applying to get exact location):
```js
// (no constant; literal 20 used at line 337)
```

**NEW** (add near the top of `state-compute.js`, after other constants):
```js
const MAX_COLLISION_ARCHIVE = 20;
```

**OLD** (`state-compute.js:337`, around the `world.collision_archive` auto-trim):
```js
                    // Auto-trim collision_archive to MAX_COLLISION_ARCHIVE (20) entries
                    if (tx.e === 'world' && tx.d.f === 'collision_archive' && target[tx.d.f].length > 20) {
                        target[tx.d.f] = target[tx.d.f].slice(-20);
                    }
```

**NEW**:
```js
                    // Auto-trim collision_archive to MAX_COLLISION_ARCHIVE entries
                    if (tx.e === 'world' && tx.d.f === 'collision_archive' && target[tx.d.f].length > MAX_COLLISION_ARCHIVE) {
                        target[tx.d.f] = target[tx.d.f].slice(-MAX_COLLISION_ARCHIVE);
                    }
```

Implementer: verify exact form at `state-compute.js:337` before applying; the literal might appear in one or two places.

---

## Group 12 — Cosmetics / doc rot

These are LOW severity but included because the audit explicitly called them out. Apply last, as a single cleanup commit.

### 12.1 — `index.js:1325` stale tombstone comment

**OLD** (`index.js:1325`):
```js
                // Phase 2 removed noticed_details; nothing per-char to cap here.
```

**NEW**: *(delete the line)*

### 12.2 — `state-compute.js:469` default active_system

**OLD** (`state-compute.js:469`):
```js
        state.divination = { active_system: '', last_draw: null, readings: [] };
```

**NEW**:
```js
        state.divination = { active_system: 'arcana', last_draw: null, readings: [] };
```

### 12.3 — `setup-wizard.js` cosmetic `gl-setup-arc` label

**OLD** (`setup-wizard.js:67-68`):
```html
<label class="gl-setup-label">Opening Situation ...</label>
<textarea id="gl-setup-arc" ...></textarea>
```

**NEW**: rename `id="gl-setup-arc"` → `id="gl-setup-opening"` and update the two downstream references at `setup-wizard.js:112` and `setup-wizard.js:125` the same way. Label text can stay — "Opening Situation" is already Phase 2 language.

```bash
# Verify after edit:
grep -n 'gl-setup-arc\|gl-setup-opening' setup-wizard.js
```

### 12.4 — `ooc-handler.js:106` stale "noticed details" reference

**OLD** (`ooc-handler.js:106`):
```js
    lines.push('6. PRUNE: REMOVE stale noticed details, resolved entries, duplicate fields.');
```

**NEW**:
```js
    lines.push('6. PRUNE: REMOVE stale key_moments (consolidate first), resolved entries, duplicate fields.');
```

### 12.5 — `ooc-handler.js:201` prose cleanup

**OLD** (`ooc-handler.js:201`):
```js
    - Lower power only if current condition, lost gear, fear, exhaustion, or severe wounds materially reduce the real combat ceiling.
```

**NEW**:
```js
    - Lower power only if lost gear, fear, exhaustion, or severe wounds materially reduce the real combat ceiling.
```

### 12.6 — `Gravity World Info.json` chapter-close entry

**OLD** (`Gravity World Info.json:278-282`, `comment: "[DISABLED — chapters removed in Phase 2]"`): entry 9 is disabled but its body still contains ~40 lines of chapter-summary instructions that the LLM never sees. The audit recommends trimming body to a single placeholder line.

**NEW**: set `content` of entry 9 to the single string:
```
(DISABLED — chapter-close logic removed in Phase 2; entry retained only so legacy uid 9 resolves.)
```

### 12.7 — `Plan/combat-power-doctrine.md` + `Plan/combat-system-handoff.md` legacy `world.constants.*` refs

Both docs still reference `world.constants.power_scale` and similar. These are design docs, not runtime, but the audit flagged them for Phase 2 consistency. Do a find-and-replace across both files:

- `world.constants.power_scale` → `world.power_scale`
- `world.constants.power_ceiling` → `world.power_ceiling`
- `world.constants.power_notes` → `world.power_notes`
- Any "I Ching / hexagram" reference (combat-system-handoff.md has ~16) — remove or annotate as "(deprecated — Yi Jing removed; divination now uses Arcana/Classic only)".

```bash
grep -n 'world\.constants\|hexagram\|Yi Jing\|I Ching' Plan/combat-power-doctrine.md Plan/combat-system-handoff.md
```

---

## Application order

Apply in these batches. After each batch, run the listed syntax checks. Do **not** commit across batches; one commit per batch keeps the history reviewable.

### Batch 1 — LIVE BUG (ship first)
- Group 1 (challenge-profile-combat.js — 3 edits)
```bash
node -c challenge-profile-combat.js
```

### Batch 2 — faction subsystem rewrite (runtime)
- Group 2 (state-view.js live faction renderer — singleton line + lite block + full block)
- Group 5 (state-compute.js: replace `normalizeFactionIntel` with `migrateFactionToPhase2`, update call site)
```bash
node -c state-view.js
node -c state-compute.js
```

### Batch 3 — collision status + collision view helper
- Group 4 (state-compute.js: collision status migration helper in CR/TR/S)
- Group 10 (state-view.js: `getCollisionNarrativeLines` strip banned collision fields)
```bash
node -c state-view.js
node -c state-compute.js
```

### Batch 4 — readme + PC dossier + char KA flat shape
- Group 3 (state-view.js readme fixes — 15 edits: 3.1 through 3.15)
- Group 9 (state-view.js PC DOSSIER rewrite)
- Group 3.3 + 3.4 (state-view.js char-dossier KA renderer + agenda line — already grouped above)
```bash
node -c state-view.js
```

### Batch 5 — preset
- Group 6 (gravity_v15.json: Character Voice, L0 Cast Reminder, L2 Gravity Kernel)
```bash
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8')); console.log('ok')"
```

### Batch 6 — setup wizard
- Group 7 (setup-wizard.js: drop `status=ACTIVE` example)
```bash
node -c setup-wizard.js
```

### Batch 7 — MAX_COLLISION_ARCHIVE
- Group 11 (state-compute.js: declare + wire constant)
```bash
node -c state-compute.js
```

### Batch 8 — doc corrections
- Group 8 (AGENTS.md + CLAUDE.md: line numbers, line count, `reads/noticed_details/intel_on` reconciliation)

### Batch 9 — cosmetics (single commit)
- Group 12 (index.js:1325, state-compute.js:469, setup-wizard.js rename, ooc-handler.js:106/201, Gravity World Info.json chapter close, Plan/*.md legacy refs)
```bash
node -c index.js
node -c state-compute.js
node -c setup-wizard.js
node -c ooc-handler.js
node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8')); console.log('ok')"
```

---

## Cross-reference: audit finding → fix group

| Audit ID (§9 item) | Finding | Fix group |
|---|---|---|
| §9.1 | LIVE BUG `runtime.last_resolution.exchange` | Group 1 |
| §9.2 | state-view.js lite/combat faction block uses `reads/stance/power` | Group 2.2 |
| §9.2 | state-view.js full faction block uses `objective/resources/momentum/…/intel_on` | Group 2.3 |
| §9.2 | state-view.js singleton line teaches `world.constants` | Group 2.1 |
| §9.3 | Readme faction CREATE teaches `objective/resources/comms_latency/intel_on` | Group 3.12 |
| §9.3 | Readme core `char:id.reads.pc` + nested char KA | Group 3.1, 3.2 |
| §9.3 | Readme full `REMOVE noticed_details` + `READ` op + `MAP_SET pc.reputation` + `MAP_DEL reads` | Groups 3.7, 3.8, 3.9, 3.11 |
| §9.3 | Readme `intimacy_stance` mention | Group 3.10 |
| §9.3 | Readme collision paths `details/cost/target_constraint` | Groups 3.6, 3.13, 3.15 |
| §9.3 | Readme PRIORITY ORDER `DOING/WANT/READS` | Group 3.14 |
| §9.3 | Char-dossier live renderer still uses nested KA shape | Group 3.3 |
| §9.3 | Char dossier missing `agenda` surface | Group 3.4 |
| §9.3 | Faction paths list still advertises `comms_latency/last_verified_at/intel_posture` | Group 3.5 |
| §9.4 | state-compute.js no SEEDED/SIMMERING/RESOLVING migration | Group 4 |
| §9.4 | state-compute.js re-initializes `intel_on` every replay | Group 5 |
| §9.5 | gravity_v15.json L0 Cast Reminder teaches `wants/Doing/Noticed details` | Group 6.2 |
| §9.5 | gravity_v15.json Character Voice teaches `condition` | Group 6.1 |
| §9.5 | gravity_v15.json L2 Gravity Kernel teaches `wants` | Group 6.3 |
| §9.6 | PC DOSSIER reads `char.reads/stance_toward_pc/pc.reputation` | Group 9 |
| §9.7 | getCollisionNarrativeLines still reads `details/cost/target_constraint` | Group 10 |
| §9.8 | setup-wizard.js creates collision with `status=ACTIVE` | Group 7 |
| §9.9 | `challenge-profile-combat.js:266` comment / :399 "rolled exchanges" | Group 1.2, 1.3 |
| §9.10 | AGENTS.md + CLAUDE.md `index.js:1551` wrong line | Group 8.1 |
| §9.10 | AGENTS.md `reads/noticed_details` removal claim vs code | Group 8.2 |
| §9.10 | CLAUDE.md + AGENTS.md "~2,300 lines" | Group 8.3 |
| §9.11 | `MAX_COLLISION_ARCHIVE` declared unused | Group 11 |
| §9.11 | index.js:1325 stale tombstone comment | Group 12.1 |
| §9.11 | state-compute.js:469 `active_system: ''` default | Group 12.2 |
| §9.11 | setup-wizard.js `gl-setup-arc` id cosmetic | Group 12.3 |
| §9.11 | ooc-handler.js:106 "noticed details" | Group 12.4 |
| §9.11 | ooc-handler.js:201 prose | Group 12.5 |
| §9.11 | Gravity World Info.json disabled chapter entry body | Group 12.6 |
| §9.11 | Plan/*.md legacy `world.constants.*` + hexagram | Group 12.7 |
| §9.12 | Faction KA cap 20 not enforced | Group 5.1 (tail of `migrateFactionToPhase2`) |

---

## Post-apply verification checklist

Run after all 9 batches applied, before committing the final cleanup:

```bash
# 1. Syntax-check every file that changed.
node -c index.js
node -c state-view.js
node -c state-compute.js
node -c challenge-profile-combat.js
node -c setup-wizard.js
node -c ooc-handler.js
node -e "JSON.parse(require('fs').readFileSync('gravity_v15.json','utf8')); console.log('preset ok')"
node -e "JSON.parse(require('fs').readFileSync('Gravity World Info.json','utf8')); console.log('world info ok')"

# 2. No banned fields left in runtime code or readme strings.
grep -nE 'intel_on|stance_toward_pc|comms_latency|last_verified_at|intel_posture|false_beliefs|blindspots|target_constraint|noticed_details|\.reads\.|pc\.reputation|intimacy_stance|world\.constants|story_kind' \
  index.js state-view.js state-compute.js challenge-profile-combat.js ooc-handler.js setup-wizard.js ui-panel.js
# Expected: zero matches (or only inside clearly-labelled migration helpers).

# 3. Preset no longer teaches want/doing/condition.
grep -nE '\bwant(s)?\b|\bdoing\b|\bcondition\b|noticed detail' gravity_v15.json
# Expected: zero matches in `content` bodies of enabled entries.

# 4. No runtime.exchange reads remain.
grep -nE 'runtime\.(last_resolution\.)?exchange' .
# Expected: zero matches.

# 5. Call site of migrateFactionToPhase2 matches declaration.
grep -n 'normalizeFactionIntel\|migrateFactionToPhase2' state-compute.js
# Expected: exactly one declaration + one call, both using the new name.
```

---

## Deliverable status

- **Written to:** `G:\My Drive\AI RPG\Gravity 2\PHASE2-ROUND3-FIXES.md`
- **Committed:** No.
- **Commits per batch:** apply one commit per batch in the Application Order section.
- **Rollback:** every change is local; `git reset --hard HEAD~N` after a batch is safe as long as you have not pushed.
