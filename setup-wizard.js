/**
 * setup-wizard.js - Setup via popup questionnaire.
 *
 * Replaces the old 3-phase wizard with a single popup form.
 * User fills in what they want, leaves the rest blank for the LLM to fill.
 * Produces a single-shot injection prompt with all answers.
 */

const LOG_PREFIX = '[GravityLedger:Setup]';

let _active = false;
let _onPhaseChange = null;

function getPhase() { return _active ? 1 : 0; }
function isActive() { return _active; }
function setPhaseCallback(fn) { _onPhaseChange = fn; }

function startSetup() {
    _active = true;
    if (_onPhaseChange) _onPhaseChange(1);
}

function cancelSetup() {
    _active = false;
    if (_onPhaseChange) _onPhaseChange(0);
}

/**
 * No-op - the popup handles everything in one shot.
 * Kept for backward compatibility with index.js calls.
 */
function checkPhaseCompletion(committedTxns, state) {
    // Auto-complete setup after first successful commit with characters
    if (!_active) return;
    const hasChars = Object.keys(state.characters || {}).length > 0;
    if (hasChars) {
        _active = false;
        console.log(`${LOG_PREFIX} Setup complete - characters detected.`);
        if (_onPhaseChange) _onPhaseChange(0);
    }
}

function getPhasePrompt() {
    // The setup prompt is now set via _pendingOOCInjection in handleSetupButton
    return null;
}

function getPhaseLabel() {
    return _active ? 'Setup in progress' : '';
}

/**
 * Show the setup popup and return the user's answers.
 * @returns {Promise<Object|null>} answers object or null if cancelled
 */
async function showSetupPopup() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'gl-setup-overlay';
        overlay.innerHTML = `
            <div class="gl-setup-popup">
                <div class="gl-setup-header">
                    <h3>New Game Setup</h3>
                    <p style="color:#999;font-size:12px;margin:4px 0 0">Set the opening story direction and combat power doctrine. Leave anything blank for the LLM to derive from the character card, scenario, and genre.</p>
                </div>
                <div class="gl-setup-form">
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Opening Situation <span class="gl-setup-hint">What's the story about?</span></label>
                        <input type="text" id="gl-setup-arc" class="gl-setup-input" placeholder="e.g. Escape the city before the faction finds us">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Power Scale <span class="gl-setup-hint">Optional - what the combat ratings mean in this setting</span></label>
                        <textarea id="gl-setup-power-scale" class="gl-setup-input gl-setup-textarea" rows="3" placeholder="e.g. 1=trained but ordinary, 3=elite specialist, 5=setting-defining monster"></textarea>
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Power Ceiling <span class="gl-setup-hint">Optional - highest credible direct-combat level here</span></label>
                        <input type="number" id="gl-setup-power-ceiling" class="gl-setup-input" placeholder="e.g. 5" min="1" style="width:80px">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Power Notes <span class="gl-setup-hint">Optional - caveats like range dominance, armor realities, or magic cost</span></label>
                        <textarea id="gl-setup-power-notes" class="gl-setup-input gl-setup-textarea" rows="2" placeholder="e.g. Firearms dominate open ground. Magic is rare and needs setup."></textarea>
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Base Power <span class="gl-setup-hint">Optional - earned combat rating when healthy</span></label>
                        <input type="number" id="gl-setup-pc-power-base" class="gl-setup-input" placeholder="e.g. 3" min="0" style="width:80px">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Power Basis <span class="gl-setup-hint">Why does the PC deserve that rating?</span></label>
                        <textarea id="gl-setup-pc-power-basis" class="gl-setup-input gl-setup-textarea" rows="3" placeholder="e.g. Master swordsman with real battlefield experience, disciplined footwork, and strong close-range timing."></textarea>
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Combat Abilities <span class="gl-setup-hint">One per line: training, gear edge, special ability, or limitation</span></label>
                        <textarea id="gl-setup-pc-abilities" class="gl-setup-input gl-setup-textarea" rows="4" placeholder="e.g. Master swordsmanship&#10;Fast draw and counter timing&#10;Weak against multiple shooters in open ground"></textarea>
                    </div>
                </div>
                <div class="gl-setup-footer">
                    <button class="gl-setup-btn gl-setup-cancel">Cancel</button>
                    <button class="gl-setup-btn gl-setup-start">Start Game</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('.gl-setup-cancel').addEventListener('click', () => {
            overlay.remove();
            resolve(null);
        });

        overlay.querySelector('.gl-setup-start').addEventListener('click', () => {
            const answers = {
                opening: document.getElementById('gl-setup-arc').value.trim(),
                power_scale: document.getElementById('gl-setup-power-scale').value.trim(),
                power_ceiling: document.getElementById('gl-setup-power-ceiling').value.trim(),
                power_notes: document.getElementById('gl-setup-power-notes').value.trim(),
                pc_power_base: document.getElementById('gl-setup-pc-power-base').value.trim(),
                pc_power_basis: document.getElementById('gl-setup-pc-power-basis').value.trim(),
                pc_abilities: document.getElementById('gl-setup-pc-abilities').value.trim(),
            };
            overlay.remove();
            resolve(answers);
        });

        // Focus first input
        setTimeout(() => document.getElementById('gl-setup-arc')?.focus(), 100);
    });
}

/**
 * Build the single-shot setup injection prompt from user answers.
 * @param {Object} answers
 * @returns {string}
 */
function buildSetupPrompt(answers) {
    const filled = [];
    const blank = [];

    if (answers.opening) filled.push(`Opening situation: ${answers.opening}`);
    else blank.push('opening arc and central question (derive from scenario)');

    if (answers.power_scale) filled.push(`World power scale: ${answers.power_scale}`);
    else blank.push('world power scale (what each combat rating means in this story)');

    if (answers.power_ceiling) filled.push(`World power ceiling: ${answers.power_ceiling}`);
    else blank.push('world power ceiling');

    if (answers.power_notes) filled.push(`World power notes: ${answers.power_notes}`);

    if (answers.pc_power_base) filled.push(`PC base power: ${answers.pc_power_base}`);
    else blank.push('PC base power');

    if (answers.pc_power_basis) filled.push(`PC power basis: ${answers.pc_power_basis}`);
    else blank.push('why the PC deserves their combat rating');

    if (answers.pc_abilities) {
        const abilityLines = answers.pc_abilities
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => `  - ${line}`)
            .join('\n');
        filled.push(`PC combat abilities:\n${abilityLines}`);
    } else {
        blank.push('PC combat abilities, training, gear edges, and limitations');
    }

    return `[GRAVITY SETUP - Single-shot initialization. Build the complete game state in one response.

${filled.length ? 'PLAYER PROVIDED:\n' + filled.map(f => `  ${f}`).join('\n') : ''}
${blank.length ? '\nAUTO-FILL (derive from character card, scenario, and genre):\n' + blank.map(b => `  - ${b}`).join('\n') : ''}

IMPORTANT: The PC (player character) is {{user}}, derived from the user's persona. The PRINCIPAL is {{char}}, the character card NPC. These are DIFFERENT characters — never merge them.

EMIT ALL OF THE FOLLOWING in one ---LEDGER--- block:

1. PC (the player — {{user}}, from the persona):
> SET pc field=name value="{{user}}"
> APPEND pc field=demonstrated_traits value="[trait from persona description]"
{{personaDescription}}
${answers.pc_power_base ? `> SET pc field=power_base value=${answers.pc_power_base} -- Normal earned combat level when healthy\n> SET pc field=power value=${answers.pc_power_base} -- Current effective combat level starts at base unless setup establishes impairment or a boost` : ''}${answers.pc_power_basis ? '\n> SET pc field=power_basis value="[why the PC deserves this rating]" -- Narrative justification for the rating' : ''}${answers.pc_abilities ? '\n> APPEND pc field=abilities value="[combat-relevant ability, training, gear edge, or limitation]" -- Repeat 2-4 times as needed' : ''}
Read the persona description above. Extract demonstrated_traits (2-4 APPEND lines) from what it says about {{user}}.

2. PRINCIPAL CHARACTER ({{char}} — the character card NPC, NOT the PC):
> CREATE char:name name="[Full Name from character card]" tier=PRINCIPAL
> SET char:name field=agenda value="[narrative compass — what this character is working toward; the direction that will generate collision seeds]"
> SET char:name field=location value=place:[starting-place-id]
> MAP_SET char:name field=knowledge_asymmetry key=knows_[short_topic_slug] value="[fact this character knows — intel they could act on]"
> MAP_SET char:name field=knowledge_asymmetry key=unknown_[short_topic_slug] value="[important blind spot this character has]"
> MAP_SET char:name field=knowledge_asymmetry key=hiding_[short_topic_slug] value="[secret this character actively conceals]"
> MAP_SET char:name field=knowledge_asymmetry key=misreading_[short_topic_slug] value="[false belief this character holds as true]"
If this character is combat-capable or likely to become a direct physical threat, also assign:
> SET char:name field=power_base value=[earned_rating]
> SET char:name field=power value=[current_effective_rating]
> SET char:name field=power_basis value="[why this rating is justified]"
> APPEND char:name field=abilities value="[combat-relevant ability, training, gear edge, or limitation]"
Build 3-4 constraints:
> CREATE constraint:c1-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=regression shedding_order=1
> CREATE constraint:c2-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=displacement shedding_order=2
> CREATE constraint:c3-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=depth_shift shedding_order=3

3. WORLD SETUP:
${answers.power_scale ? '> SET world field=power_scale value="[power ladder summary]" -- What each combat rating means in this story\n' : ''}${answers.power_ceiling ? '> SET world field=power_ceiling value=[highest_rating] -- Highest credible direct-combat level in this setting\n' : ''}${answers.power_notes ? '> SET world field=power_notes value="[caveats about range, magic, armor, or combat realism]" -- World combat caveats\n' : ''}> SET world field=world_state value="[macro reality]" -- World state
> SET world field=timeskip_scale value="HOURS" -- Default tick scale for the first Advance; set to MINUTES/HOURS/DAYS/WEEKS/MONTHS on any turn that yields initiative

4. FACTIONS (at least 2 with opposing agendas):
> CREATE faction:name name="[Name]" state="[active/weakened/ascendant/dormant]"
> SET faction:name field=agenda value="[the overarching direction — a narrative compass, not a task list]"
> APPEND faction:name field=members value=char:[char-id]
> APPEND faction:name field=territory value=place:[place-id]
> MAP_SET faction:name field=knowledge_asymmetry key=knows_[topic] value="[intel they hold and could act on]"
> MAP_SET faction:name field=knowledge_asymmetry key=unknown_[topic] value="[critical gap they haven't detected]"
> MAP_SET faction:name field=knowledge_asymmetry key=hiding_[topic] value="[information the faction is concealing]"
> MAP_SET faction:name field=knowledge_asymmetry key=misreading_[topic] value="[false assumption they operate on]"

5. COLLISIONS (at least 1 ACTIVE; each must be a compact narrative thread with live pressure, not just a label):
> CREATE collision:slug name="[short descriptive label]" status=ACTIVE distance_category=MEDIUM forces="force1 vs force2 — what narrative pressures are driving this collision" involved_chars="pc,char:principal-id" location=place:[place-id]

6. PLACES (at least 1 for the opening scene; more if the PC, PRINCIPAL, or factions are anchored elsewhere):
> CREATE place:[slug] name="[Display name]" reach=LOCAL state="[safe/contested/hostile/unknown]" description="[one or two sentences — what this place is and what makes it notable]"

7. PRESSURE POINTS (2-3 seams where the world is about to break; raw narrative seeds, capped at 5 FIFO):
> CREATE pressure:[slug] name="[seam that could later tighten into a collision]" source="[PC|char:id|faction:id|place:id]" related_to="[collision-id, if it echoes an existing thread]"

8. Any scenario NPCs as KNOWN:
> CREATE char:npc-slug name="[NPC Name]" tier=KNOWN
KNOWN characters inherit context from their faction's knowledge_asymmetry map (§2.3). Do NOT set individual knowledge_asymmetry on KNOWN/UNKNOWN chars — only TRACKED/PRINCIPAL get their own.
If any recurring or important NPC is combat-capable, assign:
> SET char:npc-slug field=power_base value=[earned_rating]
> SET char:npc-slug field=power value=[current_effective_rating]
> SET char:npc-slug field=power_basis value="[why this rating is justified]"
> APPEND char:npc-slug field=abilities value="[combat-relevant ability, training, gear edge, or limitation]"

POWER AUTHORING RULES:
- No naked numbers. Every meaningful combat rating needs a basis and abilities.
- power_base = earned combat level when healthy and fully functional.
- power = current effective combat level.
- Start power equal to power_base unless setup already establishes a wound, impairment, missing gear, or temporary boost.
- Use the world power scale and power ceiling consistently.

After the ledger block, write the OPENING SCENE with full deduction. The story begins.]`;
}

export {
    getPhase,
    isActive,
    startSetup,
    cancelSetup,
    checkPhaseCompletion,
    getPhasePrompt,
    getPhaseLabel,
    setPhaseCallback,
    showSetupPopup,
    buildSetupPrompt,
};
