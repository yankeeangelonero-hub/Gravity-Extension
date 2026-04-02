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
    const hasChapter = Object.keys(state.chapters || {}).length > 0;
    if (hasChars && hasChapter) {
        _active = false;
        console.log(`${LOG_PREFIX} Setup complete - characters and chapter detected.`);
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
                    <p style="color:#999;font-size:12px;margin:4px 0 0">Set the opening arc and combat power doctrine. Leave anything blank for the LLM to derive from the character card, scenario, and genre.</p>
                </div>
                <div class="gl-setup-form">
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Opening Arc <span class="gl-setup-hint">What's the story about?</span></label>
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
                arc: document.getElementById('gl-setup-arc').value.trim(),
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

    if (answers.arc) filled.push(`Opening arc: ${answers.arc}`);
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

EMIT ALL OF THE FOLLOWING in one ---LEDGER--- block:

1. WORLD SETUP:
${answers.power_scale ? '> MAP_SET world field=constants key=power_scale value="[power ladder summary]" -- What each combat rating means in this story\n' : ''}${answers.power_ceiling ? '> MAP_SET world field=constants key=power_ceiling value=[highest_rating] -- Highest credible direct-combat level in this setting\n' : ''}${answers.power_notes ? '> MAP_SET world field=constants key=power_notes value="[caveats about range, magic, armor, or combat realism]" -- World combat caveats\n' : ''}> SET world field=world_state value="[macro reality]" -- World state

2. FACTIONS (at least 2 with opposing objectives):
> CREATE faction:name name="[Name]" objective="[goal]" resources="[resources]" stance_toward_pc="[stance]" power="[rising/stable/declining]" momentum="[current action]" leverage="[power source]" vulnerability="[weakness]"
> MAP_SET faction:name field=relations key=[other-faction-id] value="[stance]"

3. CHAPTER:
> CREATE chapter:ch1-slug number=1 title="[focus]" status=OPEN arc="[central question]" central_tension="[forced choice]"

4. COLLISIONS (at least 1 active or simmering; each must be a compact narrative thread, not just a label):
> CREATE collision:slug name="[name]" forces="force1,force2" status=SIMMERING distance=8 details="[what is converging, who is caught in it, how it is already surfacing, what forced choice is looming]" cost="[what engagement, delay, or failure costs]" target_constraint="[constraint-id if this is pressing a tracked defense]"

5. PRESSURE POINTS (2-3 seams where the world is about to break; short seeds, not full collisions):
> APPEND world field=pressure_points value="[seam that could later tighten into a collision]"

6. PRINCIPAL CHARACTER (from scenario/character card):
> CREATE char:name name="[Full Name]" tier=PRINCIPAL want="[core want from card/scenario]" doing="[action]" cost="[risk]"
> SET char:name field=intimacy_stance value="[initial stance]"
If this character is combat-capable or likely to become a direct physical threat, also assign:
> SET char:name field=power_base value=[earned_rating]
> SET char:name field=power value=[current_effective_rating]
> SET char:name field=power_basis value="[why this rating is justified]"
> APPEND char:name field=abilities value="[combat-relevant ability, training, gear edge, or limitation]"
Build 3-4 constraints:
> CREATE constraint:c1-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=regression shedding_order=1
> CREATE constraint:c2-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=displacement shedding_order=2
> CREATE constraint:c3-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=depth_shift shedding_order=3

7. PC:
> SET pc field=name value="{{user}}"
> APPEND pc field=demonstrated_traits value="[from persona card]"
${answers.pc_power_base ? `> SET pc field=power_base value=${answers.pc_power_base} -- Normal earned combat level when healthy\n> SET pc field=power value=${answers.pc_power_base} -- Current effective combat level starts at base unless setup establishes impairment or a boost` : ''}${answers.pc_power_basis ? '\n> SET pc field=power_basis value="[why the PC deserves this rating]" -- Narrative justification for the rating' : ''}${answers.pc_abilities ? '\n> APPEND pc field=abilities value="[combat-relevant ability, training, gear edge, or limitation]" -- Repeat 2-4 times as needed' : ''}

8. Any scenario NPCs as KNOWN:
> CREATE char:npc-slug name="[NPC Name]" tier=KNOWN
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
