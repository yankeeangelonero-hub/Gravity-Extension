# PHASE 2 FINAL — Comprehensive Fix Document

**Source audit:** [PHASE2-FINAL-AUDIT.md](.claude/worktrees/intelligent-lovelace-9b7c54/PHASE2-FINAL-AUDIT.md) (264 lines, 30+ findings, §8 priority fix list)
**Normative spec:** `gravity_v15.json` "L4 Phase 2 Commands" + `PHASE2-AUDIT-CHECKLIST.md`
**Target branch:** `codex-v13-state-delta`
**Verdict being remediated:** NOT YET COMPLIANT — three high-impact clusters: broken `world.constants` read path (functional bug), incomplete `exchange→clash` rename, legacy `char.condition`/`intimacy_stance`/`want` fields still actively read.

All OLD snippets below were verified against current files on `codex-v13-state-delta` (index.js = 2,297 LOC, state-view.js = 941 LOC, ui-panel.js = 1,303 LOC, challenge-state.js = 1,173 LOC). Apply in the order listed in the final section.

---

## GROUP 1 — Functional bug: `world.constants.power_scale` read path

**Severity:** HIGH (functional bug — today both reads return `undefined`)
**Cause:** `setup-wizard.js` writes `world.power_scale` (flat). `state-view.js:361` and `ooc-handler.js:167` read `state.world.constants.power_scale` (nested). Nested never exists → values always blank.
**Resolution chosen:** migrate readers to the flat path (spec-aligned, matches Phase 2 AGENTS.md §"Live setup-authored world fields").

### 1a — `state-view.js:359–370`

**OLD (line 359–370):**
```javascript
    // Constants — combat and full only (internalized after setup, not needed on regular turns)
    if (showConstants) {
        const cn = state.world.constants || {};
        const constantLines = [];
        if (cn.power_scale) constantLines.push(`  Power Scale: ${normalizeText(cn.power_scale)}`);
        if (cn.power_ceiling != null) constantLines.push(`  Power Ceiling: ${cn.power_ceiling}`);
        if (cn.power_notes) constantLines.push(`  Power Notes: ${normalizeText(cn.power_notes)}`);
        if (constantLines.length) {
            lines.push('');
            lines.push('CONSTANTS');
            lines.push(...constantLines);
```

**NEW:**
```javascript
    // Power context — combat and full only (internalized after setup, not needed on regular turns)
    if (showConstants) {
        const w = state.world || {};
        const constantLines = [];
        if (w.power_scale) constantLines.push(`  Power Scale: ${normalizeText(w.power_scale)}`);
        if (w.power_ceiling != null) constantLines.push(`  Power Ceiling: ${w.power_ceiling}`);
        if (w.power_notes) constantLines.push(`  Power Notes: ${normalizeText(w.power_notes)}`);
        if (constantLines.length) {
            lines.push('');
            lines.push('POWER CONTEXT');
            lines.push(...constantLines);
```

### 1b — `ooc-handler.js:167–176`

**OLD (line 167–176):**
```javascript
    const constants = state.world?.constants || {};
    const lines = [];
    lines.push('[GRAVITY POWER REVIEW]');
    lines.push('No prose scene. Re-judge combat power honestly against the established scale and current evidence.');
    if (requestReason) lines.push(`Player request: ${requestReason}`);
    lines.push('');
    lines.push('WORLD POWER CONTEXT:');
    lines.push(`  Power scale: ${constants.power_scale || 'not set - infer a consistent scale from setup and existing state'}`);
    lines.push(`  Power ceiling: ${constants.power_ceiling ?? 'not set'}`);
    if (constants.power_notes) lines.push(`  Power notes: ${constants.power_notes}`);
```

**NEW:**
```javascript
    const w = state.world || {};
    const lines = [];
    lines.push('[GRAVITY POWER REVIEW]');
    lines.push('No prose scene. Re-judge combat power honestly against the established scale and current evidence.');
    if (requestReason) lines.push(`Player request: ${requestReason}`);
    lines.push('');
    lines.push('WORLD POWER CONTEXT:');
    lines.push(`  Power scale: ${w.power_scale || 'not set - infer a consistent scale from setup and existing state'}`);
    lines.push(`  Power ceiling: ${w.power_ceiling ?? 'not set'}`);
    if (w.power_notes) lines.push(`  Power notes: ${w.power_notes}`);
```

### 1c — `state-view.js:750–753` (readme MAP_SET examples leak the nested path to the LLM)

**OLD (line 750–753):**
```
MAP_SET — set a key in a map field
  > MAP_SET pc field=reputation key=tifa value="Investor. Unbearable. Has a room now." -- Reputation narrative
  > MAP_SET world field=constants key=power_scale value="1=trained but ordinary, 3=elite specialist, 5=setting-defining monster" -- Set combat power ladder
  > MAP_SET world field=constants key=power_ceiling value=5 -- Highest credible direct-combat level in this setting
```

**NEW:**
```
MAP_SET — set a key in a map field
  > MAP_SET pc field=reputation key=tifa value="Investor. Unbearable. Has a room now." -- Reputation narrative
  > SET world field=power_scale value="1=trained but ordinary, 3=elite specialist, 5=setting-defining monster" -- Set combat power ladder
  > SET world field=power_ceiling value=5 -- Highest credible direct-combat level in this setting
```

**Rationale:** `power_scale`/`power_ceiling`/`power_notes` are flat scalar fields on `world`, not a map. `SET` is the correct op.

---

## GROUP 2 — `intimacy_stance` purge (4 CRITICAL + 8 HIGH readme leaks)

Phase 2 removes `intimacy_stance` as a char field. Boundary enforcement now lives in prose + `knowledge_asymmetry`/relationships.

### 2a — `index.js:1272–1288` (delete entire intimacy-stance enforcement block)

**OLD (line 1272–1288):**
```javascript
        // Intimacy stance enforcement — surface active stances so the LLM checks before writing
        if (_currentState) {
            const stanceLines = [];
            for (const [id, char] of Object.entries(_currentState.characters || {})) {
                if (!char.intimacy_stance) continue;
                stanceLines.push(`  ${char.name || id}: ${char.intimacy_stance}`);
            }
            if (stanceLines.length > 0) {
                setExtensionPrompt(`${MODULE_NAME}_intimacy`,
                    `[INTIMACY STANCE CHECK — respect these before writing intimate content:\n${stanceLines.join('\n')}\nThe character's stance is the boundary. The player's desire does not override it. If the scene escalates past what the stance allows, the character resists, freezes, or redirects — write THAT. Update the stance via SET only when a constraint shift or significant narrative event earns it.]`,
                    PROMPT_IN_CHAT, 0);
            } else {
                setExtensionPrompt(`${MODULE_NAME}_intimacy`, '', PROMPT_NONE, 0);
            }
        } else {
            setExtensionPrompt(`${MODULE_NAME}_intimacy`, '', PROMPT_NONE, 0);
        }
```

**NEW:**
```javascript
        // Intimacy boundary enforcement is now Phase 2: carried in prose + knowledge_asymmetry
        // (hiding/misreading buckets). No runtime slot injection needed.
        setExtensionPrompt(`${MODULE_NAME}_intimacy`, '', PROMPT_NONE, 0);
```

### 2b — `index.js:1994–2013` (`handleIntimacyButton` — strip stance scraping)

**OLD (line 1994–2013):**
```javascript
function handleIntimacyButton() {
    _pendingDeductionType = 'intimacy';
    const pcName = _currentState?.pc?.name || '{{user}}';

    const stances = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        if (char.tier === 'UNKNOWN' || char.tier === 'KNOWN') continue;
        if (char.intimacy_stance) {
            stances.push(`${char.name || id}: ${char.intimacy_stance}`);
        }
    }

    const histories = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        const ih = char.intimate_history;
        if (ih && typeof ih === 'object' && Object.keys(ih).length) {
            histories.push(`${char.name || id}: ${Object.entries(ih).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
    }

    const intimacyDraw = drawDivination();
```

**NEW:**
```javascript
function handleIntimacyButton() {
    _pendingDeductionType = 'intimacy';
    const pcName = _currentState?.pc?.name || '{{user}}';

    const histories = [];
    for (const [id, char] of Object.entries(_currentState?.characters || {})) {
        const ih = char.intimate_history;
        if (ih && typeof ih === 'object' && Object.keys(ih).length) {
            histories.push(`${char.name || id}: ${Object.entries(ih).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
        }
    }

    const intimacyDraw = drawDivination();
```

Then scrub any subsequent references to `stances` inside this function's prompt build (verify the injected text below line 2013 and remove any `stances.join(...)` interpolation).

### 2c — `state-view.js:199–202` (char render loop)

**OLD (line 199–202):**
```javascript
        // Intimacy fields — only in intimacy/full
        if (showIntimacy && char.intimacy_stance) {
            lines.push(`    Intimacy stance: ${char.intimacy_stance}`);
        }
```

**NEW:** delete these four lines entirely.

### 2d — `state-view.js:117, 121` (mode flag rename — stance no longer the gate)

**OLD (line 117, 121):**
```javascript
    const isIntimacy = (mode === 'intimacy');
...
    const showIntimacy = isIntimacy || isFull;      // intimacy_stance, reads, traits
```

**NEW:**
```javascript
    const isIntimacy = (mode === 'intimacy');
...
    const showIntimacy = isIntimacy || isFull;      // intimate_history, demonstrated_traits
```

(Comment fix only; `showIntimacy` is still used for `intimate_history` gating at line ~215. No logic change.)

### 2e — `state-view.js` readme section (lines 779–790, 817, 826–831)

**OLD (line 779–790):**
```
INTIMACY STANCE — per-character field describing their current sexual/intimate posture toward the PC.
  This is NOT a permission level. It is a living description of where this character is RIGHT NOW:
  what they want, what they fear, what they're using intimacy for, what they don't know yet.
  > SET char:tifa field=intimacy_stance value="Will lean into him, hold his hand, rest against his shoulder — but freezes if it edges toward anything sexual. The guilt is the wall: she feels like wanting him is taking something she hasn't earned." -- Post C1 breach
  > SET char:tifa field=intimacy_stance value="Reciprocates freely but initiates nothing. Needs proof this isn't gratitude before she'll reach first." -- After asymmetry resolved

  The stance shifts when the narrative earns it. Accumulated trust, vulnerability, physical
  history, constraint changes, collision outcomes, quiet moments that land differently — any of
  these can move the wall. The shift must be visible in the prose BEFORE you update the field.
  What CANNOT move the wall: the player demanding it. The character decides, not the player.

  When no intimacy_stance exists on a character, default to: reserved, boundary unknown, must be discovered through interaction.
```

**NEW:** delete entire block (lines 779–790).

**OLD (line 817):**
```
  - After intimacy: UPDATE intimacy_stance, intimate_history, reads, and relevant constraints.
```

**NEW:**
```
  - After intimacy: UPDATE intimate_history, knowledge_asymmetry (hiding/misreading), and relevant constraints.
```

**OLD (line 826–831):**
```
CHECKING THE STANCE:
  Before writing ANY intimate escalation, check the character's intimacy_stance.
  - If the stance says they'd freeze, they freeze. Write the freeze.
  - If the stance says they'd reciprocate but not initiate, they don't initiate.
  - If no stance exists, the character defaults to guarded — boundaries must be discovered.
  - The player's desire does not override the character's stance. The character is a person.
```

**NEW:**
```
CHECKING BOUNDARIES:
  Before writing ANY intimate escalation, consult the character's knowledge_asymmetry
  (what they hide, what they fear, what they misread), their relationships, and their recent
  intimate_history. Write from who they are in the moment:
  - If they would freeze, they freeze. Write the freeze.
  - If they would reciprocate but not initiate, they do not initiate.
  - Default posture when undocumented: guarded — boundaries must be discovered.
  - The player's desire does not override the character's agency.
```

**OLD (line 833–838):** (following block re-anchors to "stance"; scrub)
```
UPDATING THE STANCE:
  The stance shifts when the NARRATIVE earns it — constraint breaches, trust built through
  action (not words), vulnerability reciprocated, time together, conflict survived.
  Never shift because the player pushed. Shift because something real changed.
  The stance can also TIGHTEN — betrayal, trauma, a constraint reforming after breach.
```

**NEW:**
```
UPDATING THE DOSSIER:
  Intimate shifts land on intimate_history (what happened) and knowledge_asymmetry
  (what changed in what they know, hide, or misread). Shifts are earned by narrative —
  constraint breaches, trust built through action (not words), vulnerability reciprocated,
  time together, conflict survived. Never shift because the player pushed.
  A character's guarded posture can also TIGHTEN after betrayal or trauma — capture that
  shift in knowledge_asymmetry (hiding/misreading) and, if a constraint is involved, in its
  integrity TR.
```

**Rationale:** The Intimacy Guide prose stays — it's useful. Only the field name "intimacy_stance" is being replaced with the Phase 2 mechanism (knowledge_asymmetry + intimate_history).

### 2f — `state-view.js:582` (STANDARD SHAPE sample)

The sample at line 571–585 uses `char:elena.condition` and `char:elena.reads.pc` — these are handled in Groups 3 and 6 below. No `intimacy_stance` appears in the sample, so no additional edit needed here.

---

## GROUP 3 — `char.condition` purge

Phase 2 removes `condition` as a char field. Body/mind state lives in prose, wounds (combat), and demonstrated_traits.

### 3a — `state-view.js:181–187` (render block)

**OLD (line 181–187):**
```javascript
        // Condition — PRINCIPAL always, TRACKED only in combat/full
        if (isPrincipal && char.condition) {
            lines.push(`    Condition: ${char.condition}`);
        } else if (isTracked && showPower && char.condition) {
            lines.push(`    Condition: ${char.condition}`);
        }
```

**NEW:** delete all 7 lines.

### 3b — `state-view.js:574` (STANDARD SHAPE sample)

**OLD:** `char:elena.condition: "steady, watchful"`
**NEW:** delete line.

### 3c — `state-view.js:602` (COMMON PATHS)

**OLD:** `  char:id.condition`
**NEW:** delete line.

### 3d — `state-view.js:665` (DISCIPLINE)

**OLD:**
```
  Keep char:id.condition terse — 10-15 words describing body/mind state. Scene prose carries longer description.
```

**NEW:** delete line.

### 3e — `ooc-handler.js:102` (eval instructions)

**OLD (line 102):**
```javascript
    lines.push('2. STALE FIELDS: Review ALL location, condition, equipment, doing fields. Update any that are outdated.');
```

**NEW:**
```javascript
    lines.push('2. STALE FIELDS: Review ALL location, equipment, and last_seen_at fields. Update any that are outdated.');
```

**Rationale:** Removes two banned Phase 2 terms (`condition`, `doing`) from the prompt the LLM sees.

---

## GROUP 4 — `char.want` purge

### 4a — `index.js:1199` (dormant character nudge)

**OLD (line 1199, inside the dormant-char loop at lines 1193–1201):**
```javascript
                if (gap >= DORMANT_THRESHOLD) {
                    dormant.push(`${char.name || id} [${char.tier}] — WANT: ${char.want || '?'} — last activity ${gap} transactions ago`);
                }
```

**NEW:**
```javascript
                if (gap >= DORMANT_THRESHOLD) {
                    dormant.push(`${char.name || id} [${char.tier}] — AGENDA: ${char.agenda || '?'} — last activity ${gap} transactions ago`);
                }
```

### 4b — `index.js:1204` (same block, injected prompt body)

**OLD (line 1204):**
```javascript
                setExtensionPrompt(`${MODULE_NAME}_dormant`,
                    `[DORMANT CHARACTERS — gravity still pulls these characters toward collision:\n${dormant.map(d => '  • ' + d).join('\n')}\nGravity is constant — however weak, it pulls toward collision. Their WANT is a force. Their DOING has consequences. Advance them toward the nearest collision — or spawn a new one from their WANT intersecting the current situation.]`,
                    PROMPT_IN_CHAT, 0);
```

**NEW:**
```javascript
                setExtensionPrompt(`${MODULE_NAME}_dormant`,
                    `[DORMANT CHARACTERS — gravity still pulls these characters toward collision:\n${dormant.map(d => '  • ' + d).join('\n')}\nGravity is constant — however weak, it pulls toward collision. Their AGENDA is a force. Their actions have consequences. Advance them toward the nearest collision — or spawn a new one from their AGENDA intersecting the current situation.]`,
                    PROMPT_IN_CHAT, 0);
```

**Rationale:** Eliminates banned Phase 1 terms `WANT` and `DOING` from an actively-injected prompt.

---

## GROUP 5 — Faction legacy fields (`objective`/`power`/`momentum` → `agenda`)

### 5a — `index.js:1168–1179` (faction heartbeat)

**OLD (line 1168–1179):**
```javascript
        if (isRegular && !challengeSessionLocked && _turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
            const factions = Object.values(_currentState.factions || {});
            if (factions.length > 0) {
                const factionDetails = factions.map(f => {
                    let detail = `${f.name || f.id} (${f.objective || '?'})`;
                    if (f.power) detail += ` [${f.power}]`;
                    if (f.momentum) detail += ` — doing: ${f.momentum}`;
                    return detail;
                }).join('\n  ');
                setExtensionPrompt(`${MODULE_NAME}_faction`,
                    `[FACTION HEARTBEAT — Turn ${_turnCounter}.\n  ${factionDetails}\nFactions execute operations independently based on their MOMENTUM. Leaders command subordinates — show the chain of command. Rising factions expand; declining factions get desperate. Check faction RELATIONS for alliance/rivalry dynamics. You may CUT to a faction scene before cutting back. If no faction has visibly acted in recent turns, one MUST advance NOW — pick the faction whose MOMENTUM most threatens the current scene.]`,
                    PROMPT_IN_CHAT, 0);
```

**NEW:**
```javascript
        if (isRegular && !challengeSessionLocked && _turnCounter > 0 && _turnCounter % 10 === 0 && _currentState) {
            const factions = Object.values(_currentState.factions || {});
            if (factions.length > 0) {
                const factionDetails = factions.map(f => {
                    let detail = `${f.name || f.id} (${f.agenda || '?'})`;
                    if (f.state) detail += ` [${f.state}]`;
                    return detail;
                }).join('\n  ');
                setExtensionPrompt(`${MODULE_NAME}_faction`,
                    `[FACTION HEARTBEAT — Turn ${_turnCounter}.\n  ${factionDetails}\nFactions execute operations independently, driven by their AGENDA. Leaders command subordinates — show the chain of command. Check faction knowledge_asymmetry to keep intel consistent. You may CUT to a faction scene before cutting back. If no faction has visibly acted in recent turns, one MUST advance NOW — pick the faction whose AGENDA most threatens the current scene.]`,
                    PROMPT_IN_CHAT, 0);
```

**Rationale:** Phase 2 faction schema (gravity_v15.json L4) has `agenda`, `state`, `members`, `territory`, `knowledge_asymmetry`. Removed: `objective`, `power`, `momentum`.

---

## GROUP 6 — Collision legacy fields (`details`/`cost`/`target_constraint`)

### 6a — `index.js:363–377` (`buildCollisionStoryCapsule`)

**OLD (line 363–377):**
```javascript
function buildCollisionStoryCapsule(id, col) {
    const lines = [];
    const details = normalizeText(col?.details);
    const forces = getCollisionForcesText(col);
    const cost = normalizeText(col?.cost);
    const targetConstraint = normalizeText(col?.target_constraint);
    if (details) lines.push(`Thread: ${details}`);
    if (forces) lines.push(`Forces: ${forces}`);
    else if (!details) lines.push(`Collision: ${col?.name || id}`);

    if (cost) lines.push(`Cost: ${cost}`);
    if (targetConstraint) lines.push(`Target constraint: ${targetConstraint}`);

    return lines.join('\n');
}
```

**NEW:**
```javascript
function buildCollisionStoryCapsule(id, col) {
    const lines = [];
    const forces = getCollisionForcesText(col);
    const location = normalizeText(col?.location);
    const involvedChars = Array.isArray(col?.involved_chars) ? col.involved_chars.filter(Boolean) : [];
    if (forces) lines.push(`Forces: ${forces}`);
    else lines.push(`Collision: ${col?.name || id}`);
    if (location) lines.push(`Location: ${location}`);
    if (involvedChars.length) lines.push(`Involved: ${involvedChars.join(', ')}`);
    return lines.join('\n');
}
```

### 6b — `index.js:379–408` (thin-details warnings + `buildCollisionNarrativeWarnings`)

**OLD (line 379–408):**
```javascript
function isThinCollisionDetails(details) {
    const clean = normalizeText(details);
    if (!clean) return false;
    const words = clean.split(/\s+/).filter(Boolean);
    return clean.length < 80 || words.length < 12;
}

function buildCollisionNarrativeWarnings(id, col, status) {
    const warnings = [];
    const name = col?.name || id;
    const details = normalizeText(col?.details);
    const cost = normalizeText(col?.cost);
    const forces = getCollisionForcesText(col);

    if (!forces) {
        warnings.push(`"${name}" is ${status} but missing forces — SET collision:${id}.forces so the pressure has named poles.`);
    }

    if (!details) {
        warnings.push(`"${name}" is ${status} but missing details — every live collision needs a narrative thread. SET collision:${id}.details to a compact story capsule naming: what is converging, who or what is caught in it, how it is surfacing now, and the forced choice looming.`);
    } else if (isThinCollisionDetails(details)) {
        warnings.push(`"${name}" details are still too thin — rewrite collision:${id}.details as a fuller story capsule with source pressure, the people or places at risk, the present expression, and the forced choice looming.`);
    }

    if (status === 'ACTIVE' && !cost) {
        warnings.push(`"${name}" is ${status} but missing cost — SET collision:${id}.cost to what engagement, delay, or failure will cost.`);
    }

    return warnings;
}
```

**NEW:**
```javascript
function buildCollisionNarrativeWarnings(id, col, status) {
    const warnings = [];
    const name = col?.name || id;
    const forces = getCollisionForcesText(col);
    const location = normalizeText(col?.location);
    const involvedChars = Array.isArray(col?.involved_chars) ? col.involved_chars.filter(Boolean) : [];

    if (!forces) {
        warnings.push(`"${name}" is ${status} but missing forces — SET collision:${id}.forces so the pressure has named poles.`);
    }
    if (status === 'ACTIVE' && !location) {
        warnings.push(`"${name}" is ${status} but missing location — SET collision:${id}.location so the pressure is grounded in a place.`);
    }
    if (status === 'ACTIVE' && !involvedChars.length) {
        warnings.push(`"${name}" is ${status} but no involved_chars — APPEND collision:${id}.involved_chars so the pressure has a cast.`);
    }

    return warnings;
}
```

**Rationale:** `details`, `cost`, `target_constraint` are banned Phase 2 fields. `isThinCollisionDetails` has no remaining caller. Phase 2 collision schema uses `forces`, `location`, `involved_chars`, plus resolution fields (`outcome_type`/`aftermath`) — those are what we warn about on missing state.

**Also delete any dangling call:** search `index.js` for `isThinCollisionDetails` references; none should remain.

---

## GROUP 7 — `exchange → clash` rename completion

**Scope:** `runtime.exchange` is internal storage AND LLM-facing via mechanics keys, task blocks, and UI rendering. Rename across the board.

### 7a — `challenge-state.js:278` (runtime init)

**OLD (line 278):** `        exchange: 1,`
**NEW:** `        clash: 1,`

### 7b — `challenge-state.js:449` (mechanics block)

**OLD:** `    lines.push(\`RUNTIME_EXCHANGE: ${mechanicsValue(runtime?.exchange)}\`);`
**NEW:** `    lines.push(\`RUNTIME_CLASH: ${mechanicsValue(runtime?.clash)}\`);`

### 7c — `challenge-state.js:493` (task block — mustResolveExchange var + usage on 508/526/533)

**OLD (line 493):** `    const mustResolveExchange = runtime?.phase === 'awaiting_resolution' || mustResolveBuffered;`
**NEW:** `    const mustResolveClash = runtime?.phase === 'awaiting_resolution' || mustResolveBuffered;`

**OLD (line 508):** `        turnObjective = 'RESOLVE_EXCHANGE';`
**NEW:** `        turnObjective = 'RESOLVE_CLASH';`

**OLD (line 524):** `    lines.push(\`MUST_NOT_RESOLVE_EXCHANGE: ${boolText(needsAssessment || runtime?.phase === 'awaiting_choice')}\`);`
**NEW:** `    lines.push(\`MUST_NOT_RESOLVE_CLASH: ${boolText(needsAssessment || runtime?.phase === 'awaiting_choice')}\`);`

**OLD (line 526):** `    lines.push(\`MUST_RESOLVE_EXCHANGE: ${boolText(mustResolveExchange)}\`);`
**NEW:** `    lines.push(\`MUST_RESOLVE_CLASH: ${boolText(mustResolveClash)}\`);`

**OLD (line 533):** `        lines.push(\`MUST_RECORD_LAST_DRAW: ${boolText(!!roll?.draw && !roll?.skip && mustResolveExchange)}\`);`
**NEW:** `        lines.push(\`MUST_RECORD_LAST_DRAW: ${boolText(!!roll?.draw && !roll?.skip && mustResolveClash)}\`);`

### 7d — `challenge-state.js:1004–1018` (last_resolution + next-runtime rebuild)

**OLD (line 1004–1022):**
```javascript
            let next = {
                ...runtime,
                last_resolution: {
                    exchange: runtime.exchange,
                    action: clone(runtime.pending_action),
                    roll: clone(runtime.pending_roll),
                },
            };

            if (resolved) {
                return transitionToCleanupGrace(next, profile, destroyed);
            }

            next = buildAwaitingChoiceRuntime(next, {
                exchange: Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0),
                scene_draw_active: false,
                option_table_version: runtime.option_table_version || 0,
                options: runtime.options || [],
            });
```

**NEW:**
```javascript
            let next = {
                ...runtime,
                last_resolution: {
                    clash: runtime.clash,
                    action: clone(runtime.pending_action),
                    roll: clone(runtime.pending_roll),
                },
            };

            if (resolved) {
                return transitionToCleanupGrace(next, profile, destroyed);
            }

            next = buildAwaitingChoiceRuntime(next, {
                clash: Math.max((runtime.clash || 1) + 1, coerceNumber(entity?.clash) ?? 0),
                scene_draw_active: false,
                option_table_version: runtime.option_table_version || 0,
                options: runtime.options || [],
            });
```

### 7e — `challenge-state.js:1107–1123` (awaiting_resolution branch)

**OLD (line 1107–1123):**
```javascript
        let next = {
            ...runtime,
            last_resolution: {
                exchange: runtime.exchange,
                action: clone(runtime.pending_action),
                roll: clone(runtime.pending_roll),
            },
            correction_attempts: 0,
        };

        if (resolved) {
            return transitionToCleanupGrace(next, profile, destroyed);
        }

        next = buildAwaitingChoiceRuntime(next, {
            exchange: Math.max((runtime.exchange || 1) + 1, coerceNumber(entity?.exchange) ?? 0),
        });
```

**NEW:**
```javascript
        let next = {
            ...runtime,
            last_resolution: {
                clash: runtime.clash,
                action: clone(runtime.pending_action),
                roll: clone(runtime.pending_roll),
            },
            correction_attempts: 0,
        };

        if (resolved) {
            return transitionToCleanupGrace(next, profile, destroyed);
        }

        next = buildAwaitingChoiceRuntime(next, {
            clash: Math.max((runtime.clash || 1) + 1, coerceNumber(entity?.clash) ?? 0),
        });
```

### 7f — `challenge-state.js` — catch-all for any other `runtime.exchange` / `option_id` usage

After the above, grep `challenge-state.js` for `exchange`. Expected remaining: zero (any legacy-resume reads from prior saves should be translated via a one-time migrator if we care; if not, they'll default to `clash: 1`). Add a migration shim at the top of `loadChallengeRuntime` if needed:

```javascript
// Phase 2 rename migration: runtime.exchange → runtime.clash
if (runtime && runtime.exchange !== undefined && runtime.clash === undefined) {
    runtime.clash = runtime.exchange;
    delete runtime.exchange;
}
if (runtime?.last_resolution && runtime.last_resolution.exchange !== undefined && runtime.last_resolution.clash === undefined) {
    runtime.last_resolution.clash = runtime.last_resolution.exchange;
    delete runtime.last_resolution.exchange;
}
```

### 7g — `challenge-input.js:168` (option ID format)

**OLD (line 168):**
```javascript
            id: option.id || `opt-e${runtime?.exchange || 1}-v${nextVersion}-${option.index}`,
```

**NEW:**
```javascript
            id: option.id || `opt-c${runtime?.clash || 1}-v${nextVersion}-${option.index}`,
```

**Rationale:** ID prefix `opt-e<N>` leaks "exchange" into IDs surfaced in UI and stored in transactions. Phase 2 vocabulary uses `opt-c<N>` (clash). Note: this changes ID shape — ensure `challenge-input.js` parse/match routines tolerate both old (`opt-e…`) and new (`opt-c…`) for at least one release cycle. If a parse regex exists, widen it to `opt-[ec]\d+-v\d+-\d+`.

### 7h — `challenge-profile-combat.js:332` (LAST RESOLUTION label interpolation)

**OLD (line 332):**
```javascript
            lines.push(`LAST RESOLUTION: clash ${runtime.last_resolution.exchange} | ${formatActionSummary(runtime.last_resolution.action)}`);
```

**NEW:**
```javascript
            lines.push(`LAST RESOLUTION: clash ${runtime.last_resolution.clash} | ${formatActionSummary(runtime.last_resolution.action)}`);
```

### 7i — `challenge-profile-combat.js:399` (LLM-injected instruction text)

**OLD (line 399):**
```javascript
                    lines.push('Record divination.last_draw in the update block for rolled exchanges.');
```

**NEW:**
```javascript
                    lines.push('Record divination.last_draw in the update block for rolled clashes.');
```

### 7j — `ui-panel.js:1031` (combat dossier UI label)

**OLD (line 1031):**
```javascript
    parts.push(`<div class="gl-d-row"><b>Exchange:</b> ${esc(runtime.exchange ?? '?')}</div>`);
```

**NEW:**
```javascript
    parts.push(`<div class="gl-d-row"><b>Clash:</b> ${esc(runtime.clash ?? '?')}</div>`);
```

### 7k — `Gravity World Info.json` entry 11 (combat prose modulation) line 350

**OLD (inside the combat-prose content string at line 350):**
```
Rendering (Enargeia):\nCould this passage be filmed? If not, it is summary. Place the exchange before the eyes.
```

**NEW:**
```
Rendering (Enargeia):\nCould this passage be filmed? If not, it is summary. Place the clash before the eyes.
```

**Rationale:** The entry body is combat-specific. "Clash" matches Phase 2 combat vocabulary and the rest of this entry (which uses "clash" on adjacent lines for length budgets).

---

## GROUP 8 — Missing legacy collision-status migration in `state-compute.js`

**Finding:** Checklist line 18 requires SEEDED/SIMMERING/RESOLVING → ACTIVE migration on collision CR/TR/S. State-compute.js has no such migration, so any pre-Phase-2 save with these statuses will carry the banned status forward.

### 8a — `state-compute.js:260–289` (CR branch)

**OLD (line 275–286):**
```javascript
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
```

**NEW:**
```javascript
                // Phase 2: distance_category → canonical starting distance; legacy status migration
                if (tx.e === 'collision') {
                    if (data.distance_category) {
                        data.distance = CATEGORY_DISTANCES[data.distance_category] ?? 10;
                    } else {
                        // Old tx without category — default to SHORT
                        data.distance_category = 'SHORT';
                        if (data.distance == null) data.distance = 10;
                    }
                    // Phase 2 legacy status migration: SEEDED/SIMMERING/RESOLVING → ACTIVE
                    if (data.status === 'SEEDED' || data.status === 'SIMMERING' || data.status === 'RESOLVING') {
                        data.status = 'ACTIVE';
                    }
                    if (!data.status) data.status = 'ACTIVE';
                }
                state[collection][tx.id] = data;
```

### 8b — `state-compute.js:291–303` (TR branch)

**OLD (line 291–303):**
```javascript
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
```

**NEW:**
```javascript
        case 'TR': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                let toVal = tx.d.to;
                // Phase 2 legacy collision-status migration
                if (tx.e === 'collision' && tx.d.f === 'status'
                    && (toVal === 'SEEDED' || toVal === 'SIMMERING' || toVal === 'RESOLVING')) {
                    toVal = 'ACTIVE';
                }
                target[tx.d.f] = toVal;
                if (tx.e === 'collision' && tx.d.f === 'status' && toVal === 'CRASHED' && !target.outcome_type) {
                    target.outcome_type = 'CRASHED';
                }
                recordHistory(state, tx.e, tx.id, tx.d.f, oldVal, toVal, tx);
            }
            break;
        }
```

### 8c — `state-compute.js:305–319` (S branch)

**OLD (line 305–319):**
```javascript
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

**NEW:**
```javascript
        case 'S': {
            const target = isSingleton ? state[collection] : state[collection]?.[tx.id];
            if (target && tx.d.f) {
                const oldVal = target[tx.d.f];
                let newVal = tx.d.v;
                // Phase 2 legacy collision-status migration
                if (tx.e === 'collision' && tx.d.f === 'status'
                    && (newVal === 'SEEDED' || newVal === 'SIMMERING' || newVal === 'RESOLVING')) {
                    newVal = 'ACTIVE';
                }
                target[tx.d.f] = newVal;
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

---

## GROUP 9 — `ui-panel.js:1092–1094` CATEGORY_DISTANCES duplication

### 9a — Export from `state-compute.js` (verify at top of file — `CATEGORY_DISTANCES` is defined near line 9; add to exports if not already)

Check the end of `state-compute.js`. If the `export` / `module.exports` list does not include `CATEGORY_DISTANCES`, add it. Example for the codebase's export pattern at the bottom of the file:

```javascript
export { /* existing… */, CATEGORY_DISTANCES };
```

### 9b — `ui-panel.js` import

Add to existing import from state-compute.js at the top of ui-panel.js:

```javascript
import { /* existing imports */, CATEGORY_DISTANCES } from './state-compute.js';
```

### 9c — `ui-panel.js:1092–1094`

**OLD (line 1092–1094):**
```javascript
function renderDistanceBar(dist, category) {
    const MAX_BY_CATEGORY = { IMMEDIATE: 1, SHORT: 10, MEDIUM: 20, LONG: 50 };
    const max = MAX_BY_CATEGORY[category] || 10;
```

**NEW:**
```javascript
function renderDistanceBar(dist, category) {
    const max = CATEGORY_DISTANCES[category] || 10;
```

**Rationale:** Single source of truth. Future category changes (adding DISTANT, etc.) touch one constant.

---

## GROUP 10 — Documentation fixes

### 10a — `CLAUDE.md:27, 81` (validateTransition location)

**OLD (line 27):**
```
2. **Compute Layer** - `state-compute.js` replays all transactions to derive `_currentState`. `state-machine.js` defines valid transitions (documented, not enforced). `consistency.js` validates transaction format only.
```

**NEW:**
```
2. **Compute Layer** - `state-compute.js` replays all transactions to derive `_currentState`. `state-machine.js` defines valid transitions and exposes `validateTransition()`, which `index.js` calls at commit time. `consistency.js` validates transaction shape only.
```

**OLD (line 81):**
```
- **State machines** (char tiers, constraint integrity, collision status) are documented in `state-machine.js` and enforced by `validateTransition()` at commit time in `consistency.js`
```

**NEW:**
```
- **State machines** (char tiers, constraint integrity, collision status, combat status) are documented in `state-machine.js`. `validateTransition()` (state-machine.js:79) is called from `index.js:1551` at commit time to reject invalid TRs.
```

### 10b — `CLAUDE.md:47–59` (injection slots — add missing)

**OLD (line 47–59):**
```
All injections use `setExtensionPrompt()` at depth 0 (in-chat, before user message). Injection slots:
- **`_state`** - Entity registry + dossiers (full state view every turn)
- **`_readme`** - Command format reference (core on regular/advance, full on integration)
- **`_inject`** - Corrections + reinforcement prompts
- **`_nudge`** - Turn format with deduction template (regular/combat/advance/intimacy)
- **`_setup`** - Setup wizard phase prompts (when active)
- **`_ooc`** - OOC command injection (from buttons)
- **`_arrival`** - Collision arrival sanity-check injection (ON-SCREEN / OFF-SCREEN / IMPLODE decision — §3.5)
- **`_dist_warn`** - Distance-increase error corrections
- **`_intimacy`** - Intimacy stance boundary enforcement
- **`_faction`** - Faction heartbeat (every 10 regular turns)
- **`_dormant`** - Dormant character nudge (every 15 regular turns)
- **`_exemplars`** - Last 5 good prose paragraphs for style reference
```

**NEW:**
```
All injections use `setExtensionPrompt()` at depth 0 (in-chat, before user message). Injection slots:
- **`_state`** - Entity registry + dossiers (full state view every turn)
- **`_readme`** - Command format reference (core on regular/advance, full on integration)
- **`_inject`** - Corrections + reinforcement prompts
- **`_nudge`** - Active deduction-mode flag (regular/combat/advance/intimacy)
- **`_nudge_maintenance`** - Array-size hygiene warnings (pressure/collision/etc. over cap)
- **`_setup`** - Setup wizard phase prompts (when active)
- **`_ooc`** - OOC command injection (from buttons)
- **`_arrival`** - Collision arrival sanity-check (ON-SCREEN / OFF-SCREEN / IMPLODE — §3.5)
- **`_dist_warn`** - Distance-increase error corrections
- **`_foreshadow`** - Approaching/imminent/converging collision foreshadow nudge
- **`_intimacy`** - (Phase 2: retained slot, now unused — cleared every turn; boundary lives in prose + knowledge_asymmetry)
- **`_challenge`** - Challenge-session mechanics + task block (when a challenge is locked)
- **`_combat`** - Legacy combat-mode injection
- **`_faction`** - Faction heartbeat (every 10 regular turns)
- **`_dormant`** - Dormant character nudge (every 15 regular turns)
- **`_exemplars`** - Last 5 good prose paragraphs for style reference
```

### 10c — `CLAUDE.md:66` (deduction field count)

**OLD:**
```
- **`regular`** - Full 12-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, tone, contest, scene, plan, updates)
```

**NEW:**
```
- **`regular`** - Full 11-field deduction (intent, story, collisions, constraints, factions, cost overlap, divination, contest, scene, plan, updates)
```

**Rationale:** Reconciled with AGENTS.md:72, which was already 11. "Tone" is not a separate deduction step in the active preset CoT.

### 10d — `CLAUDE.md:80` (entity types — add `combat`)

**OLD:**
```
- **Entity types**: `char`, `constraint`, `collision`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`
```

**NEW:**
```
- **Entity types**: `char`, `constraint`, `collision`, `combat`, `faction`, `place`, `pressure`, `world`, `pc`, `divination`
```

### 10e — `CLAUDE.md:98` (line count)

**OLD:** `- \`index.js\` is the central coordinator (~1,500 lines). It wires all modules together and handles the turn lifecycle.`
**NEW:** `- \`index.js\` is the central coordinator (~2,300 lines). It wires all modules together and handles the turn lifecycle.`

### 10f — `AGENTS.md:26, 106` (nonexistent Documentation/Old/ — CRITICAL)

**Verification:** `ls Documentation/` on main repo returns: `collision_pipeline_upgrade_plan.md`, `combat_runtime_reference.md`, `deduction_cot_architecture.md`, `frontend_ux_roadmap.md`, `gravity_character_card_template.md`, `handoff_2026-04-02_…`, `handoff_2026-04-03_…`, `knowledge_asymmetry_system_handoff.md`, `project_memory.md`, `v14_prose_architecture_handoff.md`. **No `Old/` subdirectory exists.**

**OLD (line 26):**
```
Archived notes and superseded plans live in `Documentation/Old/`.
```

**NEW:**
```
Superseded plans and stale reference docs should be moved to `Documentation/archive/` when added (directory is created on first archival). Current active docs live at the top of `Documentation/`.
```

**OLD (line 106):**
```
- `Documentation/project_memory.md` is the active durable memory file. Archived docs and older planning artifacts live in `Documentation/Old/`.
```

**NEW:**
```
- `Documentation/project_memory.md` is the active durable memory file. Archive stale planning artifacts under `Documentation/archive/` when moved.
```

### 10g — `AGENTS.md:33, 81` (validateTransition location)

Same fixes as 10a. Apply verbatim to the corresponding lines in AGENTS.md.

### 10h — `AGENTS.md:53–65` (injection slots — add missing)

Same additions as 10b. Apply to AGENTS.md.

### 10i — `AGENTS.md:80` (entity types — add `combat`)

Same as 10d.

### 10j — `AGENTS.md:85` (world.constants wording)

The line currently says "`world.constants` and the older framing fields … are removed in Phase 2." This is correct documentation of removal. **Keep as-is** — flagged in audit only out of banned-term abundance of caution.

### 10k — `AGENTS.md:104` (line count)

Same as 10e.

### 10l — `AGENTS.md:105` (preset filenames + casing)

**OLD (line 105):**
```
- `gravity-system-prompt.md` is a legacy reference for the ledger command format. The current preset is `gravity_v15.json`; mode-specific playbooks live in `Gravity World Info.json`. Older presets (`gravity_v11.json`, `gravity_v13_c.json`, `gravity_v14.json`) are kept for archive only. The extension injects runtime state, readmes, nudges, and mode triggers via `setExtensionPrompt()`.
```

**NEW:**
```
- `gravity-system-prompt.md` is a legacy reference for the ledger command format. The current preset is `gravity_v15.json`; mode-specific playbooks live in `Gravity World Info.json`. Older presets (`Gravity_v11.json`, `gravity_v13_c.json`, `gravity_v13_c_split.json`, `gravity_v14.json`) are kept for archive only. The extension injects runtime state, readmes, nudges, and mode triggers via `setExtensionPrompt()`.
```

**Rationale:** Corrects filename casing (`Gravity_v11.json` actually starts with capital G on disk) and includes the previously-omitted `gravity_v13_c_split.json`.

### 10m — `AGENTS.md:107` (v14 handoff authority)

**OLD (line 107):**
```
- `Documentation/v14_prose_architecture_handoff.md` captures the modular prose rollout that moved prose authority into `gravity_v14.json` plus `Gravity World Info.json`.
```

**NEW:**
```
- `Documentation/v14_prose_architecture_handoff.md` is a historical reference for the v14 modular-prose rollout. Current prose authority lives in `gravity_v15.json` plus `Gravity World Info.json`; consult `v15` first, v14 only for rationale.
```

**Rationale:** Marks the v14 handoff as historical rather than authoritative so agents don't apply pre-Phase-2 guidance.

---

## GROUP 11 — Lorebook nit (already handled in 7k)

`Gravity World Info.json` entry 11 "Place the exchange before the eyes" → "Place the clash before the eyes". Covered by **7k**.

---

## GROUP 12 — Disabled "Gravity - Anchor" entry scrub

**Severity:** MEDIUM. Entry is `enabled: false` in `gravity_v15.json` around line 580–585 but body still references `condition` and `summary` as persistable fields. Scrub for hygiene in case the entry is ever re-enabled.

### 12a — `gravity_v15.json:585` (content field, rule 10 + "What Not To Do" list)

**OLD (inside content string around line 585):**
```
10. PERSIST MATERIAL CHANGES, NOT HABIT. Do not restate location, condition, scene, or summary just because a turn happened. Update them when the beat changed them.
```

**NEW:**
```
10. PERSIST MATERIAL CHANGES, NOT HABIT. Do not restate location, scene, or key_moments just because a turn happened. Update them when the beat changed them.
```

**OLD (same content, "What Not To Do" section):**
```
- Rewrite current_scene, location, condition, or summary on autopilot when nothing materially changed
```

**NEW:**
```
- Rewrite current_scene or location on autopilot when nothing materially changed
```

**OLD (same content):**
```
8. STORY IDENTITY LIVES OUTSIDE STATE. Read Gravity_State_View for current facts and pressures. Sentence-level prose rules live in the preset and lorebook.
```

**NEW:** keep as-is (already Phase 2-clean).

**Rationale:** removes last two `condition` and `summary` references from the preset file.

---

## GROUP 13 — Archive or rewrite stale reference docs (RECOMMENDATION)

**Not a direct code fix** — but audit §7 flags two repo-root docs as wholesale pre-Phase-2:

- `gravity-system-prompt.md` — declares `chapter` entity, SEEDED→SIMMERING→ACTIVE→RESOLVING→RESOLVED lifecycle, `world.constants.*` paths, `doing="…"` examples.
- `gravity_mode_split_blueprint.md` — Chapter Close Core section, `char.doing`/`condition` references, "exchange" combat terminology.

**Recommended action:** create `Documentation/archive/` (per 10f), move both files there, and add a one-line `archive-note.md` recording the reason ("retained for historical rationale only; not current Phase 2 spec"). `CLAUDE.md:99` and `AGENTS.md:105` already describe `gravity-system-prompt.md` as "legacy reference" — archiving brings disk layout in line with those docs.

**Do not rewrite** — the Phase 2 spec lives in `gravity_v15.json` L4 + `PHASE2-AUDIT-CHECKLIST.md`; a second copy would drift.

---

## GROUP 14 — `noticed_details` verification (`index.js:1356–1358`)

**Finding:** `checkArraySizes` loops over `char.noticed_details` and warns on >15 entries. `noticed_details` is banned per Phase 2 (checklist §Removed Fields).

### 14a — `index.js:1354–1362`

**OLD (line 1354–1362):**
```javascript
    // Check per-character arrays
    for (const [id, char] of Object.entries(state.characters || {})) {
        const noticed = char.noticed_details;
        if (Array.isArray(noticed) && noticed.length > 15) {
            warnings.push(`${char.name || id} NOTICED_DETAILS: ${noticed.length} entries — REMOVE fired/resolved details.`);
        }
        // key_moments are PERMANENT — never warn about size, never trim.
        // They are the character's lived history.
    }
```

**NEW:**
```javascript
    // Per-character arrays: key_moments are PERMANENT (never warn, never trim).
    // Phase 2 removed noticed_details; nothing per-char to cap here.
```

(Delete the loop body entirely. The outer `for (const [id, char]…)` has no remaining uses in this function — remove it too.)

---

## GROUP 15 — `state-compute.js:100–165` faction `intel_on` normalizer

**Finding:** `ensureIntelSubject` + `normalizeFactionIntel` actively maintain `faction.intel_on`/`false_beliefs`/`blindspots`. Phase 2 unifies all four buckets under `knowledge_asymmetry` on factions — same flat underscore-key shape as chars.

### 15a — Decision

The current normalizer is a **backward-compat migrator** for legacy saves. Keep its migration behavior (fold `false_beliefs` → `misreading.legacy`, `blindspots` → `unknown.legacy`, string-value `intel_on` → `.knows.legacy`), but **do not introduce new `intel_on` data**. Spec-aligned resolution: port the migration output into `knowledge_asymmetry`, then stop maintaining `intel_on` going forward.

### 15b — `state-compute.js:111–164` rewrite

**OLD (line 111–164):** (the full `normalizeFactionIntel` function)

**NEW:**
```javascript
function normalizeFactionIntel(state) {
    // Phase 2: faction knowledge lives in knowledge_asymmetry (flat underscore keys:
    //   knows_<subject>, unknown_<subject>, hiding_<subject>, misreading_<subject>).
    // This function migrates legacy faction.intel_on / false_beliefs / blindspots into
    // the flat knowledge_asymmetry map, once per replay. It writes no new legacy fields.
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
        if (!faction.knowledge_asymmetry || typeof faction.knowledge_asymmetry !== 'object'
            || Array.isArray(faction.knowledge_asymmetry)) {
            faction.knowledge_asymmetry = {};
        }
        const ka = faction.knowledge_asymmetry;

        // Legacy: faction.intel_on (nested per-subject with knows/unknown/hiding/misreading OR raw strings)
        if (faction.intel_on && typeof faction.intel_on === 'object' && !Array.isArray(faction.intel_on)) {
            for (const [subject, val] of Object.entries(faction.intel_on)) {
                if (typeof val === 'string' && val.trim()) {
                    const key = `knows_${subject}`;
                    if (!ka[key]) ka[key] = val.trim();
                } else if (val && typeof val === 'object') {
                    for (const bucket of ['knows', 'unknown', 'hiding', 'misreading']) {
                        const sub = val[bucket];
                        if (!sub || typeof sub !== 'object') continue;
                        for (const [k, v] of Object.entries(sub)) {
                            if (typeof v !== 'string' || !v.trim()) continue;
                            const flatKey = `${bucket}_${subject}_${k}`;
                            if (!ka[flatKey]) ka[flatKey] = v.trim();
                        }
                    }
                }
            }
            delete faction.intel_on;
        }
        // Legacy: faction.false_beliefs (map subject → belief)
        if (faction.false_beliefs && typeof faction.false_beliefs === 'object' && !Array.isArray(faction.false_beliefs)) {
            for (const [subject, belief] of Object.entries(faction.false_beliefs)) {
                if (typeof belief !== 'string' || !belief.trim()) continue;
                const key = `misreading_${subject}`;
                if (!ka[key]) ka[key] = belief.trim();
            }
            delete faction.false_beliefs;
        }
        // Legacy: faction.blindspots (map subject → gap, or plain string)
        if (typeof faction.blindspots === 'string' && faction.blindspots.trim()) {
            const key = 'unknown_legacy';
            if (!ka[key]) ka[key] = faction.blindspots.trim();
            delete faction.blindspots;
        } else if (faction.blindspots && typeof faction.blindspots === 'object' && !Array.isArray(faction.blindspots)) {
            for (const [subject, gap] of Object.entries(faction.blindspots)) {
                if (typeof gap !== 'string' || !gap.trim()) continue;
                const key = `unknown_${subject}`;
                if (!ka[key]) ka[key] = gap.trim();
            }
            delete faction.blindspots;
        }
    }
}
```

Also remove the now-unused helper `ensureIntelSubject` (line 100–109) — no callers remain after this rewrite.

**Rationale:** One-time migration keeps old saves working. New writes go through `knowledge_asymmetry` in the same flat form as chars (spec-aligned). Subsequent replays find nothing to migrate and are no-ops. LLM-facing readme examples that reference `faction.intel_on.*` paths (state-view.js:579–581, 612–615) become stale in Group 16 below.

### 15c — `state-view.js:579–581` (STANDARD SHAPE sample — faction intel paths)

**OLD (line 579–581):**
```
faction:zaft.intel_on.archangel.knows.status: "ship escaped damaged"
faction:zaft.intel_on.archangel.unknown.pilot: "Strike pilot identity unknown"
faction:zaft.intel_on.archangel.misreading.pilot-identity: "Assumes pilot still unconfirmed"
```

**NEW:**
```
faction:zaft.knowledge_asymmetry.knows_archangel_status: "ship escaped damaged"
faction:zaft.knowledge_asymmetry.unknown_archangel_pilot: "Strike pilot identity unknown"
faction:zaft.knowledge_asymmetry.misreading_archangel-identity: "Assumes pilot still unconfirmed"
```

### 15d — `state-view.js:611–615` (COMMON PATHS — faction intel)

**OLD (line 611–615):**
```
  faction:id.intel_posture
  faction:id.intel_on.<subject>.knows.<key>
  faction:id.intel_on.<subject>.unknown.<key>
  faction:id.intel_on.<subject>.hiding.<key>
  faction:id.intel_on.<subject>.misreading.<key>
```

**NEW:**
```
  faction:id.intel_posture
  faction:id.knowledge_asymmetry.knows_<subject>
  faction:id.knowledge_asymmetry.unknown_<subject>
  faction:id.knowledge_asymmetry.hiding_<subject>
  faction:id.knowledge_asymmetry.misreading_<subject>
```

### 15e — `state-view.js:667, 670` (DISCIPLINE — faction intel prose)

**OLD (line 667):**
```
  KNOWN characters inherit knowledge from their faction's intel_on map. Only set individual knowledge_asymmetry keys on a KNOWN character when they learn something their faction does not know yet.
```

**NEW:**
```
  KNOWN characters inherit knowledge from their faction's knowledge_asymmetry. Only set individual knowledge_asymmetry keys on a KNOWN character when they learn something their faction does not know yet.
```

**OLD (line 670):**
```
  Use faction intel fields for remote awareness: comms_latency, last_verified_at, intel_posture, and intel_on. Each intel_on subject has the same four buckets as knowledge_asymmetry: knows, unknown, hiding, misreading.
```

**NEW:**
```
  Use faction fields for remote awareness: comms_latency, last_verified_at, intel_posture, and knowledge_asymmetry. Faction knowledge_asymmetry uses the same flat-key shape as chars (knows_<subject>, unknown_<subject>, hiding_<subject>, misreading_<subject>; cap 20 across all four).
```

---

## Application order

Apply in batches. Syntax-check each modified .js file with `node -c <file>` after its batch. Do not commit until the full sequence is green.

**Batch A — data-path correctness (must go first):**
1. Group 1 (world.constants → world.power_scale flat reads) — **functional bug**
2. Group 8 (state-compute collision-status migration)
3. Group 15 (state-compute faction intel → knowledge_asymmetry migrator + state-view paths)

**Batch B — legacy field purge:**
4. Group 3 (char.condition)
5. Group 4 (char.want)
6. Group 5 (faction legacy fields)
7. Group 6 (collision details/cost/target_constraint)
8. Group 14 (noticed_details)

**Batch C — intimacy refactor (larger surface, test in isolation):**
9. Group 2 (intimacy_stance purge)

**Batch D — clash rename:**
10. Group 7 (exchange → clash across challenge-* + ui-panel + lorebook)

**Batch E — polish:**
11. Group 9 (CATEGORY_DISTANCES import)
12. Group 12 (Anchor entry scrub)

**Batch F — documentation:**
13. Group 10 (CLAUDE.md + AGENTS.md)

**Batch G — optional cleanup:**
14. Group 13 (archive gravity-system-prompt.md + gravity_mode_split_blueprint.md)

### Syntax-check commands

```bash
# Batch A
node -c state-view.js && node -c ooc-handler.js && node -c state-compute.js

# Batch B
node -c state-view.js && node -c ooc-handler.js && node -c index.js

# Batch C
node -c index.js && node -c state-view.js

# Batch D
node -c challenge-state.js && node -c challenge-input.js && node -c challenge-profile-combat.js && node -c ui-panel.js
# JSON check:
python -c "import json; json.load(open('Gravity World Info.json'))"

# Batch E
node -c ui-panel.js && node -c state-compute.js
python -c "import json; json.load(open('gravity_v15.json'))"
```

### UI smoke test (after Batch D)

1. Start a fresh chat with a character card, run setup, drive into a combat challenge.
2. Verify the combat dossier shows **"Clash: N"** (not "Exchange: N").
3. Confirm option IDs begin with `opt-c1-v1-...` in the DOM (DevTools → Elements → search `opt-c`).
4. Confirm no console errors on message commit.

---

## Cross-reference: audit finding → fix group

| Audit ID / Location | Severity | Fix Group |
|---|---|---|
| index.js:1276–1277 | CRITICAL | 2a |
| index.js:2001–2002 | CRITICAL | 2b |
| index.js:365 (col.details) | HIGH | 6a |
| index.js:367 (col.cost) | HIGH | 6a |
| index.js:368 (target_constraint) | HIGH | 6a |
| index.js:373–374 (Cost/Target lines) | HIGH | 6a |
| index.js:379, 389–405 (warnings) | HIGH | 6b |
| index.js:1172 (f.objective) | HIGH | 5a |
| index.js:1173 (f.power) | HIGH | 5a |
| index.js:1174 (f.momentum) | HIGH | 5a |
| index.js:1199 (char.want) | HIGH | 4a |
| index.js:1356–1358 (noticed_details) | MEDIUM | 14a |
| state-compute.js:100–165 (intel normalizer) | MEDIUM | 15b |
| state-compute.js: legacy status migration missing | MEDIUM | 8a/8b/8c |
| state-compute.js:469 (divination default) | LOW | (not addressed — cosmetic; document in memo only) |
| ui-panel.js:1031 (Exchange label) | HIGH | 7j |
| ui-panel.js:1093 (MAX_BY_CATEGORY) | MEDIUM | 9c |
| setup-wizard.js:197–199 (constraint example) | LOW | (spec clarification only — not a code change) |
| setup-wizard.js:184–231 (verbose verbs) | LOW | (style nit — not changing in this pass) |
| setup-wizard.js:222 (pressure related_to) | LOW | (style nit — not changing in this pass) |
| gravity_v15.json:585 (Anchor condition/summary) | MEDIUM | 12a |
| gravity_v15.json:487 ("this arc") | LOW | (narrative prose — ignore) |
| gravity_v15.json:599 (related_to guidance) | LOW | (spec polish — defer) |
| Gravity World Info.json entry 11 ("Place the exchange") | MEDIUM | 7k |
| Gravity World Info.json entry 9 (chapter close, DISABLED) | LOW | (properly disabled — ignore) |
| Gravity World Info.json entry 10 ("shut down exchanges") | LOW | (English usage — ignore) |
| challenge-profile-combat.js:332 (clash N + .exchange) | HIGH | 7h |
| challenge-profile-combat.js:399 (rolled exchanges) | MEDIUM | 7i |
| state-view.js:361 (world.constants) | HIGH | 1a |
| state-view.js:752–753 (readme MAP_SET constants) | HIGH | 1c |
| state-view.js:182–185 (char.condition render) | HIGH | 3a |
| state-view.js:574 (sample line) | HIGH | 3b |
| state-view.js:602 (COMMON PATHS) | HIGH | 3c |
| state-view.js:665 (DISCIPLINE) | HIGH | 3d |
| state-view.js:121 (showIntimacy comment) | HIGH | 2d |
| state-view.js:200–201 (intimacy_stance render) | HIGH | 2c |
| state-view.js:782–790 (INTIMACY STANCE readme block) | HIGH | 2e |
| state-view.js:795, 817, 827 (intimacy_stance in prose) | HIGH | 2e |
| state-view.js:579–581, 612–615, 667, 670 (intel_on readme) | HIGH (promoted from §7) | 15c/15d/15e |
| ooc-handler.js:102 (condition/doing in eval) | HIGH | 3e |
| ooc-handler.js:167, 174–176 (world.constants) | HIGH | 1b |
| challenge-state.js (RUNTIME_EXCHANGE + MUST_*) | HIGH | 7a–7f |
| challenge-input.js:168 (opt-e prefix) | HIGH | 7g |
| CLAUDE.md:27, 81 (validateTransition) | HIGH | 10a |
| CLAUDE.md:47–59 (injection slots) | MEDIUM | 10b |
| CLAUDE.md:66 (12 vs 11 field) | MEDIUM | 10c |
| CLAUDE.md:80 (entity types — combat) | MEDIUM | 10d |
| CLAUDE.md:75 ("cross-chapter arcs" prose) | LOW | (English usage — ignore) |
| CLAUDE.md:98 (1,500 lines) | LOW | 10e |
| AGENTS.md:26, 106 (Documentation/Old/) | CRITICAL | 10f |
| AGENTS.md:33, 81 (validateTransition) | HIGH | 10g |
| AGENTS.md:53–65 (injection slots) | MEDIUM | 10h |
| AGENTS.md:80 (entity types) | MEDIUM | 10i |
| AGENTS.md:85 (world.constants wording) | HIGH | 10j (no change — kept as removal doc) |
| AGENTS.md:87 (pc.knowledge_gaps) | LOW | (verification only — defer) |
| AGENTS.md:104 (1,500 lines) | LOW | 10k |
| AGENTS.md:105 (preset filenames) | MEDIUM | 10l |
| AGENTS.md:107 (v14 handoff) | MEDIUM | 10m |
| gravity-system-prompt.md (wholesale stale) | MEDIUM | 13 (archive) |
| gravity_mode_split_blueprint.md (wholesale stale) | MEDIUM | 13 (archive) |

---

*End of fix document. Do NOT commit until all batches syntax-check clean and the UI smoke test passes.*
