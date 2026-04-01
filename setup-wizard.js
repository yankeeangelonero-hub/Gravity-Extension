/**
 * setup-wizard.js — Setup via popup questionnaire.
 *
 * Replaces the old 3-phase wizard with a single popup form.
 * User fills in what they want, leaves the rest blank for LLM to fill.
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
 * No-op — the popup handles everything in one shot.
 * Kept for backward compatibility with index.js calls.
 */
function checkPhaseCompletion(committedTxns, state) {
    // Auto-complete setup after first successful commit with characters
    if (!_active) return;
    const hasChars = Object.keys(state.characters || {}).length > 0;
    const hasChapter = Object.keys(state.chapters || {}).length > 0;
    if (hasChars && hasChapter) {
        _active = false;
        console.log(`${LOG_PREFIX} Setup complete — characters and chapter detected.`);
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
                    <p style="color:#999;font-size:12px;margin:4px 0 0">Leave fields blank for the LLM to fill from the character card and scenario.</p>
                </div>
                <div class="gl-setup-form">
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Story Kind <span class="gl-setup-hint">What kind of story is this?</span></label>
                        <input type="text" id="gl-setup-story-kind" class="gl-setup-input" placeholder="e.g. a gritty fugitive thriller where trust is expensive and every shelter has a cost">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Opening Arc <span class="gl-setup-hint">What's the story about?</span></label>
                        <input type="text" id="gl-setup-arc" class="gl-setup-input" placeholder="e.g. Escape the city before the faction finds us">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Motivation <span class="gl-setup-hint">What drives the player character?</span></label>
                        <input type="text" id="gl-setup-motivation" class="gl-setup-input" placeholder="e.g. Find the truth about what happened that night">
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Objective <span class="gl-setup-hint">Immediate goal?</span></label>
                        <input type="text" id="gl-setup-objective" class="gl-setup-input" placeholder="e.g. Meet the contact at the docks before midnight">
                    </div>
                    <div class="gl-setup-row">
                        <div class="gl-setup-section gl-setup-half">
                            <label class="gl-setup-label">Role</label>
                            <select id="gl-setup-role" class="gl-setup-input">
                                <option value="">Auto</option>
                                <option value="Roleplayer">Roleplayer</option>
                                <option value="Game Master">Game Master</option>
                                <option value="Writer">Writer</option>
                            </select>
                        </div>
                        <div class="gl-setup-section gl-setup-half">
                            <label class="gl-setup-label">Length</label>
                            <select id="gl-setup-length" class="gl-setup-input">
                                <option value="">Auto</option>
                                <option value="under 150 words">Under 150</option>
                                <option value="150-300 words">150-300</option>
                                <option value="1000-1500 words">1000-1500</option>
                                <option value="flexible">Flexible</option>
                            </select>
                        </div>
                        <div class="gl-setup-section gl-setup-half">
                            <label class="gl-setup-label">Guidelines</label>
                            <select id="gl-setup-guidelines" class="gl-setup-input">
                                <option value="">Auto</option>
                                <option value="SFW">SFW</option>
                                <option value="NSFW">NSFW</option>
                            </select>
                        </div>
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">Combat Rules <span class="gl-setup-hint">Optional — power scale, combat tone, world capabilities</span></label>
                        <textarea id="gl-setup-combat" class="gl-setup-input gl-setup-textarea" rows="3" placeholder="e.g. Power 1=civilian, 3=soldier, 5=dragon. Combat is gritty and lethal. Magic is rare."></textarea>
                    </div>
                    <div class="gl-setup-section">
                        <label class="gl-setup-label">PC Starting Power <span class="gl-setup-hint">Optional — numeric combat power level</span></label>
                        <input type="number" id="gl-setup-pc-power" class="gl-setup-input" placeholder="e.g. 2" min="1" style="width:80px">
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
                story_kind: document.getElementById('gl-setup-story-kind').value.trim(),
                arc: document.getElementById('gl-setup-arc').value.trim(),
                motivation: document.getElementById('gl-setup-motivation').value.trim(),
                objective: document.getElementById('gl-setup-objective').value.trim(),
                role: document.getElementById('gl-setup-role').value,
                length: document.getElementById('gl-setup-length').value,
                guidelines: document.getElementById('gl-setup-guidelines').value,
                combat_rules: document.getElementById('gl-setup-combat').value.trim(),
                pc_power: document.getElementById('gl-setup-pc-power').value.trim(),
            };
            overlay.remove();
            resolve(answers);
        });

        // Focus first input
        setTimeout(() => document.getElementById('gl-setup-story-kind')?.focus(), 100);
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

    if (answers.story_kind) filled.push(`Story kind: ${answers.story_kind}`);
    else blank.push('story kind (derive from scenario genre, dramatic promise, and recurring pressure)');

    if (answers.arc) filled.push(`Opening arc: ${answers.arc}`);
    else blank.push('opening arc and central question (derive from scenario)');

    if (answers.motivation) filled.push(`PC motivation: ${answers.motivation}`);
    else blank.push('PC motivation (derive from character card)');

    if (answers.objective) filled.push(`PC objective: ${answers.objective}`);
    else blank.push('PC short-term objective (derive from scenario opening)');

    if (answers.role) filled.push(`Role: ${answers.role}`);
    else blank.push('role (default: Roleplayer)');

    if (answers.length) filled.push(`Length: ${answers.length}`);
    else blank.push('length (default: 150-300 words)');

    if (answers.guidelines) filled.push(`Guidelines: ${answers.guidelines}`);
    else blank.push('guidelines (default: SFW)');

    if (answers.combat_rules) filled.push(`Combat rules: ${answers.combat_rules}`);
    if (answers.pc_power) filled.push(`PC starting power: ${answers.pc_power}`);

    return `[GRAVITY SETUP — Single-shot initialization. Build the complete game state in one response.

${filled.length ? 'PLAYER PROVIDED:\n' + filled.map(f => `  ${f}`).join('\n') : ''}
${blank.length ? '\nAUTO-FILL (derive from character card, scenario, and genre):\n' + blank.map(b => `  - ${b}`).join('\n') : ''}

EMIT ALL OF THE FOLLOWING in one ---LEDGER--- block:

1. WORLD SETUP:
> MAP_SET world field=constants key=story_kind value="[story kind]" -- What kind of story this is
> MAP_SET world field=constants key=role value="[role]" -- Role
> MAP_SET world field=constants key=length value="[length]" -- Length
> MAP_SET world field=constants key=guidelines value="[guidelines]" -- Guidelines
> MAP_SET world field=constants key=motivation value="[motivation]" -- Motivation
> MAP_SET world field=constants key=objective value="[objective]" -- Objective
> SET world field=world_state value="[macro reality]" -- World state

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
> CREATE char:name name="[Full Name]" tier=PRINCIPAL want="[motivation]" doing="[action]" cost="[risk]"
> SET char:name field=intimacy_stance value="[initial stance]"
Build 3-4 constraints:
> CREATE constraint:c1-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=regression shedding_order=1
> CREATE constraint:c2-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=displacement shedding_order=2
> CREATE constraint:c3-slug name="[Name]" owner_id=name integrity=STABLE prevents="[what]" threshold="[breaks when]" replacement="[new defense]" replacement_type=depth_shift shedding_order=3

7. PC:
> SET pc field=name value="{{user}}"
> APPEND pc field=demonstrated_traits value="[from persona card]"
${answers.pc_power ? `> SET pc field=power value=${answers.pc_power} -- Starting power` : ''}

8. Any scenario NPCs as KNOWN:
> CREATE char:npc-slug name="[NPC Name]" tier=KNOWN

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
