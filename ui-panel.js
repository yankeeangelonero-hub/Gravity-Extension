/**
 * ui-panel.js — Floating popup panel for Gravity Ledger.
 *
 * 4 top-level tabs:
 * 1. Characters — sub-tabs per character with full dossiers
 * 2. Factions & World — factions, world state, timeskip scale, collision archive
 * 3. Collisions — ACTIVE with distance, plus RESOLVED/CRASHED archive
 * 4. Divination — active system, last draw, reading history
 */

import { getFieldHistory, getEntityHistory, getArrayItemHistory, CATEGORY_DISTANCES } from './state-compute.js';
import {
    buildDcTable,
    getChallengeEntity,
    getChallengeRuntime,
    getChallengeSettings,
    setChallengeCustomDcs,
    setChallengeDifficultyMode,
} from './challenge-state.js';
import { getProfile } from './challenge-profiles.js';

const combatProfile = getProfile('combat');

const PANEL_ID = 'gravity-ledger-panel';
const TOGGLE_ID = 'gravity-ledger-toggle';

let _onExport = null;
let _onImport = null;
let _onNew = null;
let _onSetup = null;
let _onTimeskip = null;
let _onRegister = null;
let _onAdvance = null;
let _onRevertTurn = null;
let _onGoodTurn = null;
let _onCombat = null;
let _onPowerReview = null;
let _onDivinationChange = null;
let _onIntimacy = null;

function getCombatThresholdTable(settings) {
    return buildDcTable(settings.mode, combatProfile, settings.custom_dcs);
}

function renderCombatModeOptions(selectedMode) {
    return [
        'Cinematic',
        'Gritty',
        'Heroic',
        'Survival',
        'Custom',
    ].map(mode => `<option value="${mode}"${selectedMode === mode ? ' selected' : ''}>${mode}</option>`).join('');
}

function syncCombatDifficultyControls() {
    const settings = getChallengeSettings('combat');
    const thresholds = getCombatThresholdTable(settings);
    const commandSelect = document.getElementById('gl-cmd-combat-mode');
    if (commandSelect) commandSelect.value = settings.mode;
    const summary = document.getElementById('gl-cmd-combat-thresholds');
    if (summary) {
        summary.textContent = `HL ${thresholds['Highly likely']}+ | Avg ${thresholds.Average}+ | HU ${thresholds['Highly unlikely']}+`;
    }
}

function setCallbacks({ onExport, onImport, onNew, onSetup, onTimeskip, onRegister, onAdvance, onRevertTurn, onGoodTurn, onCombat, onPowerReview, onDivinationChange, onIntimacy }) {
    _onExport = onExport;
    _onImport = onImport;
    _onNew = onNew;
    _onSetup = onSetup;
    _onTimeskip = onTimeskip;
    _onRegister = onRegister;
    _onAdvance = onAdvance;
    _onRevertTurn = onRevertTurn;
    _onGoodTurn = onGoodTurn;
    _onCombat = onCombat;
    _onPowerReview = onPowerReview;
    _onDivinationChange = onDivinationChange;
    _onIntimacy = onIntimacy;
}

let _currentBookName = '';

function setBookName(name) {
    _currentBookName = name || '';
    const label = document.getElementById('gl-chat-label');
    if (label) label.textContent = name || 'No chat';
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatCardName(slug) {
    if (!slug || typeof slug !== 'string') return '';
    return slug.split('-').map(w => {
        if (w.length <= 2) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
}

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Resolve {{user}} and {{char}} macros from SillyTavern context. */
function resolveMacros(str) {
    if (!str || typeof str !== 'string') return str;
    if (!str.includes('{{')) return str;
    try {
        const ctx = SillyTavern.getContext();
        const userName = ctx.name1 || 'User';
        const charName = ctx.name2 || 'Character';
        return str.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);
    } catch (_) {
        return str;
    }
}

function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.includes(',') ? v.split(',').map(s => s.trim()) : [v];
    return [String(v)];
}

function toObj(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return {};
}

// Reads live as an append log (array of entries). Return the latest entry as a string.
function latestRead(v) {
    if (Array.isArray(v)) return v.length ? String(v[v.length - 1]) : '';
    return v ? String(v) : '';
}

function renderPowerLabel(entity) {
    const hasCurrent = entity?.power != null;
    const hasBase = entity?.power_base != null;
    if (!hasCurrent && !hasBase) return '';
    if (hasCurrent && hasBase) {
        return entity.power === entity.power_base
            ? String(entity.power)
            : `${entity.power} (base ${entity.power_base})`;
    }
    return hasCurrent ? String(entity.power) : `base ${entity.power_base}`;
}

function inferExemplarCategory(text, modeHint = 'regular') {
    const sample = String(text || '').toLowerCase();
    if (!sample) return modeHint;
    if (/\b(kiss|kissed|mouth|breath|touch|touched|thigh|hip|waist|shoulder|skin|leaned in|leaned against)\b/.test(sample)) return 'intimacy';
    if (/\b(blood|blade|gun|shot|shots|strike|struck|wound|wounds|cover|impact|lunged|swung|knife|rifle|fist)\b/.test(sample)) return 'combat';
    if (/\b(door|threshold|arrived|arrival|walked in|came in|entered|stepped in|stepped through)\b/.test(sample)) return 'arrival';
    if (/\b(meanwhile|elsewhere|off-screen|offscreen|by the time|later|outside|down the street|radio|rumor|order)\b/.test(sample)) return 'advance';
    if (/["“”]/.test(text)) return 'dialogue';
    if (/\b(smell|sound|light|air|floor|wall|window|room|rain|heat|cold|dust|taste)\b/.test(sample)) return 'scene';
    return modeHint;
}

function inferExemplarStrengths(text) {
    const sample = String(text || '').toLowerCase();
    const strengths = [];
    if (/\b(smell|sound|light|air|heat|cold|texture|dust|taste|floor|wall|window)\b/.test(sample)) strengths.push('concrete detail');
    if (/["“”]/.test(text)) strengths.push('dialogue leverage');
    if (/\b(stop|stopped|pause|paused|hesitate|hesitated|recalculation|leaned|pulled back|after)\b/.test(sample)) strengths.push('aftereffect');
    if (/\b(door|arrived|entered|walked in|came in|threshold)\b/.test(sample)) strengths.push('entrance framing');
    if (/\b(blood|wound|impact|cover|breath|strike|shot|blade|gun)\b/.test(sample)) strengths.push('kinetic consequence');
    if (strengths.length === 0) strengths.push('beat control');
    return strengths.slice(0, 2);
}

function normalizeExemplarRecord(exemplar) {
    const source = (typeof exemplar === 'object' && exemplar !== null) ? exemplar : { text: exemplar };
    const text = String(source.text || '').trim();
    if (!text) return null;
    const modeHint = source.mode_hint || source.category || 'regular';
    return {
        text,
        category: source.category || inferExemplarCategory(text, modeHint),
        strengths: Array.isArray(source.strengths) && source.strengths.length
            ? source.strengths.filter(Boolean).slice(0, 2)
            : inferExemplarStrengths(text),
        mode_hint: modeHint,
        turn: source.turn || 0,
        _ts: source._ts || 0,
    };
}

function badge(value) {
    return value ? `<span class="gl-badge gl-badge-${esc(value)}">${esc(value)}</span>` : '';
}

function historyLine(h) {
    return `<span class="gl-history-entry">${esc(h.from || '?')} → ${esc(h.to || '?')} <span class="gl-history-time">${esc(h.t)} ${h.r ? '— ' + esc(h.r) : ''}</span></span>`;
}

function arrayHistoryLine(h) {
    const action = h.to !== undefined ? 'added' : 'removed';
    const value = h.to !== undefined ? h.to : h.from;
    return `<span class="gl-history-entry">${action}: ${esc(value || '?')} <span class="gl-history-time">${esc(h.t)} ${h.r ? '— ' + esc(h.r) : ''}</span></span>`;
}

/**
 * Render a list with only the last N items visible, rest collapsed.
 * @param {string[]} htmlItems - Pre-rendered HTML strings for each item
 * @param {number} visibleCount - How many to show from the end
 * @param {string} label - Label for the "show more" toggle (e.g. "older entries")
 * @returns {string} HTML
 */
function collapsibleList(htmlItems, visibleCount, label = 'older') {
    if (htmlItems.length <= visibleCount) return htmlItems.join('');
    const hidden = htmlItems.slice(0, -visibleCount);
    const visible = htmlItems.slice(-visibleCount);
    return `<div class="gl-collapse-toggle">${hidden.length} ${label} ▸</div><div class="gl-collapse-body" style="display:none">${hidden.join('')}</div>${visible.join('')}`;
}

// ─── Panel Scaffold ─────────────────────────────────────────────────────────────

function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu) {
        const toggleBtn = document.createElement('div');
        toggleBtn.id = TOGGLE_ID;
        toggleBtn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
        toggleBtn.tabIndex = 0;
        toggleBtn.innerHTML = '<i class="fa-solid fa-book"></i> Gravity Ledger';
        toggleBtn.addEventListener('click', () => {
            const panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.toggle('gl-hidden');
        });
        extensionsMenu.appendChild(toggleBtn);
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('gl-hidden');
    panel.innerHTML = `
        <div class="gl-popup-header" id="gl-drag-handle">
            <span class="gl-popup-title">Gravity Ledger</span>
            <span class="gl-status" id="gl-status">not initialized</span>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-new" title="New ledger"><i class="fa-solid fa-plus"></i></button>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-import" title="Import"><i class="fa-solid fa-file-import"></i></button>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-export" title="Export"><i class="fa-solid fa-file-export"></i></button>
            <button class="gl-popup-close" id="gl-close-btn" title="Close">&times;</button>
        </div>
        <div class="gl-cmd-bar" id="gl-cmd-bar">
            <button class="gl-cmd-btn" data-cmd="setup" title="New game setup (or cancel in-progress)"><i class="fa-solid fa-wand-magic-sparkles"></i> Setup</button>
            <button class="gl-cmd-btn" data-cmd="timeskip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
            <button class="gl-cmd-btn" data-cmd="register" title="Register/promote NPC"><i class="fa-solid fa-user-plus"></i> Register</button>
            <button class="gl-cmd-btn" data-cmd="advance" title="Yield initiative — let the world move"><i class="fa-solid fa-play"></i> Advance</button>
            <button class="gl-cmd-btn" data-cmd="combat" title="Initiate combat — fight this"><i class="fa-solid fa-burst"></i> Combat</button>
            <label class="gl-d-row" style="display:inline-flex;align-items:center;gap:6px;margin:0 6px;" title="Combat difficulty mode">
                <span style="font-size:11px;opacity:.8;">Difficulty</span>
                <select class="gl-div-select" id="gl-cmd-combat-mode" style="height:26px;padding:2px 6px;">
                    ${renderCombatModeOptions(getChallengeSettings('combat').mode)}
                </select>
                <span class="gl-history-time" id="gl-cmd-combat-thresholds"></span>
            </label>
            <button class="gl-cmd-btn" data-cmd="power_review" title="Request an OOC review of current combat power"><i class="fa-solid fa-scale-balanced"></i> Power Review</button>
            <button class="gl-cmd-btn" data-cmd="intimacy" title="Initiate intimate scene"><i class="fa-solid fa-heart"></i> Intimacy</button>
            <button class="gl-cmd-btn" data-cmd="good_turn" title="Flag good prose — paste exemplar"><i class="fa-solid fa-thumbs-up"></i> Good</button>
        </div>
        <div class="gl-setup-indicator gl-hidden" id="gl-setup-indicator">
            <span id="gl-setup-label"></span>
            <button class="gl-cmd-btn gl-cancel-btn" id="gl-setup-cancel">Cancel</button>
        </div>
        <div class="gl-popup-body" id="gl-all-sections"></div>
        <div class="gl-footer">
            <span id="gl-turn">Turn 0</span>
            <span id="gl-tx">TX 0</span>
        </div>
        <div id="gl-debug-summary" style="display:none;flex-shrink:0;font-size:10px;color:#aaa;padding:1px 10px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('gl-close-btn').addEventListener('click', () => panel.classList.add('gl-hidden'));
    document.getElementById('gl-btn-new').addEventListener('click', handleNew);
    document.getElementById('gl-btn-import').addEventListener('click', handleImport);
    document.getElementById('gl-btn-export').addEventListener('click', handleExport);
    document.getElementById('gl-cmd-combat-mode')?.addEventListener('change', async (e) => {
        const value = e.target.value;
        await setChallengeDifficultyMode('combat', value);
        syncCombatDifficultyControls();
        renderAllSections();
        toastr.info(`Combat difficulty: ${value}`);
    });

    // Command buttons
    document.getElementById('gl-cmd-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('.gl-cmd-btn');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (!cmd) return;

        switch (cmd) {
            case 'setup': if (_onSetup) _onSetup(); break;
            case 'timeskip': if (_onTimeskip) _onTimeskip(); break;
            case 'register': if (_onRegister) _onRegister(); break;
            case 'advance': if (_onAdvance) _onAdvance(); break;
            case 'combat': if (_onCombat) _onCombat(); break;
            case 'power_review': if (_onPowerReview) _onPowerReview(); break;
            case 'intimacy': if (_onIntimacy) _onIntimacy(); break;
            case 'good_turn': if (_onGoodTurn) _onGoodTurn(); break;
        }
    });

    // Setup cancel button
    document.getElementById('gl-setup-cancel')?.addEventListener('click', () => {
        if (_onSetup) _onSetup(); // toggles cancel
    });

    initDrag(panel, document.getElementById('gl-drag-handle'));
    console.log('[GravityLedger] Panel created.');
}

let _lastState = null;
let _prevState = null;
let _lastTurn = 0;
let _changedKeys = new Set();
let _staleWarning = false;
let _lastCommitTxns = [];
let _lastCommitTxIds = [];

function renderAllSections() {
    const container = document.getElementById('gl-all-sections');
    if (!container || !_lastState) return;

    const sections = [
        { id: 'characters', icon: 'fa-users', title: 'Cast', html: renderCharacters(_lastState) },
        { id: 'world', icon: 'fa-globe', title: 'Factions & World', html: renderWorld(_lastState) },
        { id: 'collisions', icon: 'fa-burst', title: 'Collisions', html: renderCollisions(_lastState) },
        { id: 'pressures', icon: 'fa-fire-flame-simple', title: 'Pressures', html: renderPressures(_lastState) },
        { id: 'combat', icon: 'fa-crosshairs', title: 'Combat', html: renderCombat(_lastState) },
        { id: 'places', icon: 'fa-map-location-dot', title: 'Places', html: renderPlaces(_lastState) },
        { id: 'divination', icon: 'fa-star', title: 'Divination', html: renderDivination(_lastState) },
        { id: 'exemplars', icon: 'fa-thumbs-up', title: 'Style Exemplars', html: renderExemplars() },
    ];

    container.innerHTML = sections.filter(s => s.html).map(s => `
        <div class="gl-section" data-section="${s.id}">
            <div class="gl-section-header" data-toggle="${s.id}">
                <i class="fa-solid ${s.icon}"></i>
                <span>${s.title}</span>
                <span class="gl-section-arrow">&#9660;</span>
            </div>
            <div class="gl-section-body" data-body="${s.id}">${s.html}</div>
        </div>
    `).join('');

    // Section collapse/expand
    container.querySelectorAll('.gl-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.gl-section');
            section.classList.toggle('gl-section-collapsed');
        });
    });

    // Character sub-tab clicks
    container.querySelectorAll('.gl-char-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const id = tab.dataset.charid;
            const parent = tab.closest('.gl-section-body');
            if (!parent) return;
            parent.querySelectorAll('.gl-char-tab').forEach(t => t.classList.remove('gl-tab-active'));
            parent.querySelectorAll('.gl-char-panel').forEach(p => p.style.display = 'none');
            tab.classList.add('gl-tab-active');
            const panel = parent.querySelector(`[data-charpanel="${id}"]`);
            if (panel) panel.style.display = 'block';
        });
    });

    // History toggles
    container.querySelectorAll('.gl-history-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const target = toggle.nextElementSibling;
            if (target) target.style.display = target.style.display === 'none' ? 'block' : 'none';
            toggle.classList.toggle('open');
        });
    });

    // Collapsible list toggles
    container.querySelectorAll('.gl-collapse-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const target = toggle.nextElementSibling;
            if (target) target.style.display = target.style.display === 'none' ? 'block' : 'none';
            toggle.classList.toggle('open');
        });
    });

    // Divination system selector
    const divSelect = container.querySelector('#gl-divination-select');
    if (divSelect) {
        divSelect.addEventListener('change', () => {
            if (_onDivinationChange) _onDivinationChange(divSelect.value);
        });
    }

    const combatModeSelect = container.querySelector('#gl-combat-mode');
    if (combatModeSelect) {
        combatModeSelect.addEventListener('change', async () => {
            await setChallengeDifficultyMode('combat', combatModeSelect.value);
            syncCombatDifficultyControls();
            renderAllSections();
            toastr.info(`Combat difficulty: ${combatModeSelect.value}`);
        });
    }

    container.querySelectorAll('.gl-combat-custom-dc').forEach(input => {
        input.addEventListener('change', async () => {
            const kind = input.dataset.kind;
            const value = Number(input.value);
            if (!kind || !Number.isFinite(value)) return;
            const patch = {};
            patch[kind] = value;
            await setChallengeCustomDcs('combat', patch);
            syncCombatDifficultyControls();
            renderAllSections();
            toastr.info('Custom combat threshold updated');
        });
    });

    // Exemplar edit/remove buttons
    container.querySelectorAll('.gl-exemplar-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const { chatMetadata, saveMetadata, Popup } = SillyTavern.getContext();
            const exemplars = chatMetadata?.['gravity_exemplars'] || [];
            if (idx < 0 || idx >= exemplars.length) return;
            const currentRecord = normalizeExemplarRecord(exemplars[idx]);
            if (!currentRecord) return;
            const current = currentRecord.text;
            const newText = await Popup.show.input('Edit Exemplar', 'Edit the exemplar text:', current);
            if (newText === null || newText === undefined) return;
            const updated = normalizeExemplarRecord({ ...currentRecord, text: newText.trim() });
            if (!updated) return;
            exemplars[idx] = updated;
            await saveMetadata();
            renderAllSections();
            toastr.success('Exemplar updated');
        });
    });
    container.querySelectorAll('.gl-exemplar-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const { chatMetadata, saveMetadata } = SillyTavern.getContext();
            const exemplars = chatMetadata?.['gravity_exemplars'] || [];
            if (idx < 0 || idx >= exemplars.length) return;
            exemplars.splice(idx, 1);
            await saveMetadata();
            renderAllSections();
            toastr.info('Exemplar removed');
        });
    });

    syncCombatDifficultyControls();

    // Memorial section — archived relationships
    const archived = Object.entries(_lastState.relationships || {}).filter(([, r]) => r.status === 'archived');
    if (archived.length > 0) {
        let memHtml = `<details class="gl-memorials"><summary>Memorials (${archived.length})</summary>`;
        for (const [relId, r] of archived) {
            const pair = r.display_name || relId.replace(/^pc-/, '');
            const finalShift = r.last_shift?.reason ? ` (${esc(r.last_shift.reason.slice(0, 80))})` : '';
            memHtml += `<div class="gl-memorial">${esc(pair)} &middot; ${esc(formatCardName(r.card))} ${esc(r.orientation)}${finalShift}</div>`;
        }
        memHtml += '</details>';
        container.insertAdjacentHTML('beforeend', memHtml);
    }
}

// ─── Update Panel ───────────────────────────────────────────────────────────────

function renderDebugSummary() {
    const el = document.getElementById('gl-debug-summary');
    if (!el) return;
    if (!_lastCommitTxns || _lastCommitTxns.length === 0) {
        el.style.display = 'none';
        return;
    }

    // TX range
    const first = _lastCommitTxns[0].tx;
    const last  = _lastCommitTxns[_lastCommitTxns.length - 1].tx;
    const txRange = first === last ? `TX ${first}` : `TX ${first}–${last}`;

    // Op counts sorted highest-frequency first
    const opCounts = {};
    for (const tx of _lastCommitTxns) opCounts[tx.op] = (opCounts[tx.op] || 0) + 1;
    const opStr = Object.entries(opCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([op, n]) => `${op}\xd7${n}`)
        .join(' \xb7 ');

    // Unique non-empty entity IDs, max 5
    const ids = [...new Set(_lastCommitTxns.map(tx => tx.id).filter(Boolean))];
    const MAX_IDS = 5;
    const idsStr = ids.length === 0
        ? ''
        : ' — ' + (ids.length > MAX_IDS
            ? ids.slice(0, MAX_IDS).join(' \xb7 ') + ' …'
            : ids.join(' \xb7 '));

    el.textContent = `Last turn: ${txRange} \xb7 ${opStr}${idsStr}`;
    el.style.display = '';
}

function updatePanel(state, turn, committedTxns) {
    if (!document.getElementById(PANEL_ID)) createPanel();

    const statusEl = document.getElementById('gl-status');
    const turnEl = document.getElementById('gl-turn');
    const txEl = document.getElementById('gl-tx');

    if (!state) {
        if (statusEl) statusEl.textContent = 'no chat';
        const container = document.getElementById('gl-all-sections');
        if (container) container.innerHTML = '<div class="gl-empty">No active chat</div>';
        _lastCommitTxns = [];
        _lastCommitTxIds = [];
        return;
    }

    // Compute changed keys by comparing prev and current state
    _changedKeys = new Set();
    if (_prevState && _lastTurn !== turn) {
        computeChangedKeys(_prevState, state, '');
    }

    _prevState = _lastState ? structuredClone(_lastState) : null;
    _lastState = state;
    _lastTurn = turn;
    if (committedTxns && committedTxns.length) {
        _lastCommitTxns = committedTxns;
        _lastCommitTxIds = committedTxns.map(t => t.tx);
    }

    if (statusEl) statusEl.textContent = _staleWarning ? 'stale — eval recommended' : 'active';
    if (turnEl) turnEl.textContent = `Turn ${turn}`;
    if (txEl) txEl.textContent = `TX ${state.lastTxId ?? 0}`;

    // Director status badge
    const directorStatus = (typeof window !== 'undefined' && window.__gravityDirectorStatus) || 'ok';
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
        const headerStatusEl = panel.querySelector('.gravity-director-status') || (() => {
            const el = document.createElement('span');
            el.className = 'gravity-director-status';
            el.style.marginLeft = '.5em';
            const header = panel.querySelector('.gl-popup-header') || panel;
            header.appendChild(el);
            return el;
        })();
        if (directorStatus === 'failed') {
            headerStatusEl.textContent = '⚠ director failed last turn';
            headerStatusEl.style.color = '#e55';
        } else if (directorStatus === 'disabled') {
            headerStatusEl.textContent = '⚠ director disabled — read-only session';
            headerStatusEl.style.color = '#fa3';
        } else {
            headerStatusEl.textContent = '';
        }
    }

    renderDebugSummary();

    renderAllSections();

    // Apply change highlights after render
    if (_changedKeys.size > 0) {
        applyChangeHighlights();
        showRevertButton(true);
        // Auto-clear highlights after 8 seconds
        setTimeout(() => {
            document.querySelectorAll('.gl-changed').forEach(el => el.classList.remove('gl-changed'));
            showRevertButton(false);
        }, 8000);
    }
}

function computeChangedKeys(prev, curr, prefix) {
    if (!prev || !curr) return;
    for (const collection of ['characters', 'constraints', 'collisions', 'combats', 'factions', 'places', 'pressures']) {
        const pc = prev[collection] || {};
        const cc = curr[collection] || {};
        for (const id of new Set([...Object.keys(pc), ...Object.keys(cc)])) {
            if (!pc[id]) { _changedKeys.add(`${collection}.${id}`); continue; }
            if (!cc[id]) { _changedKeys.add(`${collection}.${id}`); continue; }
            for (const f of new Set([...Object.keys(pc[id] || {}), ...Object.keys(cc[id] || {})])) {
                if (JSON.stringify(pc[id]?.[f]) !== JSON.stringify(cc[id]?.[f])) {
                    _changedKeys.add(`${collection}.${id}.${f}`);
                    _changedKeys.add(`${collection}.${id}`);
                }
            }
        }
    }
    for (const s of ['world', 'pc', 'divination']) {
        const ps = prev[s] || {};
        const cs = curr[s] || {};
        for (const f of new Set([...Object.keys(ps), ...Object.keys(cs)])) {
            if (f === '_history') continue;
            if (JSON.stringify(ps[f]) !== JSON.stringify(cs[f])) {
                _changedKeys.add(`${s}.${f}`);
            }
        }
    }
}

function applyChangeHighlights() {
    // Highlight character tabs that changed
    document.querySelectorAll('.gl-char-tab').forEach(tab => {
        const id = tab.dataset.charid;
        if (_changedKeys.has(`characters.${id}`) || (id === 'pc' && [..._changedKeys].some(k => k.startsWith('pc.')))) {
            tab.classList.add('gl-changed');
        }
    });
    // Highlight section headers that have changes
    document.querySelectorAll('.gl-section').forEach(section => {
        const sid = section.dataset.section;
        let hasChanges = false;
        if (sid === 'characters') hasChanges = [..._changedKeys].some(k => k.startsWith('characters.') || k.startsWith('constraints.') || k.startsWith('pc.'));
        if (sid === 'world') hasChanges = [..._changedKeys].some(k => k.startsWith('world.') || k.startsWith('factions.'));
        if (sid === 'collisions') hasChanges = [..._changedKeys].some(k => k.startsWith('collisions.'));
        if (sid === 'combat') hasChanges = [..._changedKeys].some(k => k.startsWith('combats.'));
        if (sid === 'places') hasChanges = [..._changedKeys].some(k => k.startsWith('places.'));
        if (sid === 'pressures') hasChanges = [..._changedKeys].some(k => k.startsWith('pressures.'));
        if (sid === 'divination') hasChanges = [..._changedKeys].some(k => k.startsWith('divination.'));
        if (hasChanges) section.querySelector('.gl-section-header')?.classList.add('gl-changed');
    });
    // Highlight constraint cards that changed
    document.querySelectorAll('.gl-constraint-card').forEach(card => {
        const id = card.dataset.id;
        if (!id) return;
        for (const key of _changedKeys) {
            if (key === `constraints.${id}` || key.startsWith(`constraints.${id}.`)) {
                card.classList.add('gl-changed');
                break;
            }
        }
    });
    // Highlight collision/place/pressure cards whose own id changed this turn
    document.querySelectorAll('.gl-collision-card').forEach(card => {
        const kind = card.dataset.kind;
        const id = card.dataset.id;
        if (!kind || !id) return;
        const prefix = kind === 'collision' ? 'collisions.' : kind === 'place' ? 'places.' : null;
        if (!prefix) return;
        for (const key of _changedKeys) {
            if (key === `${prefix}${id}` || key.startsWith(`${prefix}${id}.`)) {
                card.classList.add('gl-changed');
                break;
            }
        }
    });
    // Pressures now render as <li>, not .gl-collision-card
    document.querySelectorAll('.gl-pressure-item').forEach(el => {
        const id = el.dataset.id;
        if (!id) return;
        for (const key of _changedKeys) {
            if (key === `pressures.${id}` || key.startsWith(`pressures.${id}.`)) {
                el.classList.add('gl-changed');
                break;
            }
        }
    });
}

function showRevertButton(show) {
    let btn = document.getElementById('gl-revert-btn');
    if (show && !btn) {
        btn = document.createElement('button');
        btn.id = 'gl-revert-btn';
        btn.className = 'gl-revert-btn';
        btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Revert Turn';
        btn.addEventListener('click', () => {
            if (_onRevertTurn) _onRevertTurn(_lastCommitTxIds);
        });
        const footer = document.querySelector(`#${PANEL_ID} .gl-footer`);
        if (footer) footer.appendChild(btn);
    } else if (!show && btn) {
        btn.remove();
    }
}

function setStaleWarning(stale) {
    _staleWarning = stale;
    const statusEl = document.getElementById('gl-status');
    if (statusEl) statusEl.textContent = stale ? 'stale — eval recommended' : 'active';
    if (stale) toastr.warning('Message swiped/deleted — ledger may be out of sync. Run Eval to check.');
}

// ─── Tab 1: Characters ──────────────────────────────────────────────────────────

function renderCharacters(state) {
    const pc = state.pc;
    const pcName = resolveMacros(pc.name);
    const chars = Object.values(state.characters).filter(c => c.tier !== 'UNKNOWN');

    if (!pcName && chars.length === 0) return '<div class="gl-empty">No characters tracked</div>';

    // Build sub-tabs: PC first, then Principal, Tracked, Known
    const allChars = [];
    if (pcName) allChars.push({ _isPC: true, id: 'pc', name: pcName, tier: 'PC', ...pc, name: pcName });
    const principal = chars.filter(c => c.tier === 'PRINCIPAL');
    const tracked = chars.filter(c => c.tier === 'TRACKED');
    const known = chars.filter(c => c.tier === 'KNOWN');
    allChars.push(...principal, ...tracked, ...known);

    const tabs = allChars.map((c, i) => {
        const active = i === 0 ? ' gl-tab-active' : '';
        const shortName = (c.name || c.id || '?').substring(0, 10);
        const tierClass = c._isPC ? 'PC' : c.tier;
        return `<div class="gl-char-tab${active}" data-charid="${esc(c.id)}" title="${esc(c.name || c.id)}">${esc(shortName)} ${badge(tierClass)}</div>`;
    }).join('');

    const panels = allChars.map((c, i) => {
        const display = i === 0 ? '' : ' style="display:none"';
        const content = c._isPC ? renderPCDossier(state) : renderCharDossier(c, state);
        return `<div class="gl-char-panel" data-charpanel="${esc(c.id)}"${display}>${content}</div>`;
    }).join('');

    return `<div class="gl-char-tabs-bar">${tabs}</div>${panels}`;
}

function renderPCDossier(state) {
    const pc = state.pc;
    const pcName = resolveMacros(pc.name);
    const parts = [];
    parts.push(`<div class="gl-dossier-header"><b>${esc(pcName)}</b> ${badge('PC')}</div>`);

    // Status fields
    if (pc.power != null || pc.power_base != null) {
        parts.push(`<div class="gl-d-row"><b>Power:</b> ${esc(renderPowerLabel(pc))}</div>`);
        if (pc.power_base != null && pc.power != null && pc.power !== pc.power_base) {
            parts.push(`<div class="gl-d-row"><b>Base Power:</b> ${esc(String(pc.power_base))}</div>`);
        }
    }
    if (pc.power_basis) parts.push(`<div class="gl-d-row"><b>Power Basis:</b> ${esc(pc.power_basis)}</div>`);
    const pcAbilities = toArr(pc.abilities);
    if (pcAbilities.length) {
        parts.push(`<div class="gl-d-section"><b>Combat Abilities:</b></div>`);
        for (const ability of pcAbilities) {
            parts.push(`<div class="gl-d-detail">${esc(ability)}</div>`);
        }
    }
    if (pc.location) parts.push(`<div class="gl-d-row"><b>Location:</b> ${esc(pc.location)}</div>`);
    const pcWounds = toObj(pc.wounds);
    if (Object.keys(pcWounds).length) {
        parts.push(`<div class="gl-d-section"><b>Wounds:</b></div>`);
        for (const [k, v] of Object.entries(pcWounds)) {
            parts.push(`<div class="gl-d-detail">${esc(k)}: ${esc(v)}</div>`);
        }
    }

    // PC Constraints
    const pcNameLower = (pc.name || '').toLowerCase();
    const pcConstraints = Object.values(state.constraints).filter(c =>
        c.owner_id === 'pc' ||
        (pcNameLower && (c.owner_id || '').toLowerCase() === pcNameLower)
    );
    const pcSorted = [...pcConstraints].sort((a, b) => (Number(a.shedding_order) || 99) - (Number(b.shedding_order) || 99));
    if (pcSorted.length > 1) {
        const order = pcSorted.map(c => esc(c.name || c.id)).join(' first → ') + ' last';
        parts.push(`<div class="gl-d-row gl-shedding-order"><b>Shedding Order:</b> ${order}</div>`);
    }
    for (const c of pcSorted) {
        const history = getFieldHistory(state, 'constraint', c.id, 'integrity');
        const integrityDesc = c.integrity === 'STABLE' ? 'holding' : c.integrity === 'STRESSED' ? 'destabilized' : c.integrity === 'CRITICAL' ? 'approaching breach' : c.integrity === 'BREACHED' ? 'breached' : '';
        parts.push(`<div class="gl-constraint-card" data-id="${esc(c.id)}">`);
        parts.push(`<div class="gl-constraint-title"><b>${esc(c.name)}</b> ${badge(c.integrity)}${integrityDesc ? ` <span class="gl-integrity-desc">— ${esc(integrityDesc)}</span>` : ''}</div>`);
        if (c.profile) {
            parts.push(`<div class="gl-d-detail">${esc(c.profile)}</div>`);
        } else {
            if (c.prevents) parts.push(`<div class="gl-d-detail"><b>Prevents:</b> ${esc(c.prevents)}</div>`);
            if (c.threshold) parts.push(`<div class="gl-d-detail"><b>Threshold:</b> ${esc(c.threshold)}</div>`);
            if (c.replacement) parts.push(`<div class="gl-d-detail"><b>Replacement (if breached):</b> ${esc(c.replacement)}${c.replacement_type ? ` <i>(${esc(c.replacement_type)})</i>` : ''}</div>`);
            if (c.current_pressure) parts.push(`<div class="gl-d-pressure"><b>Current pressure:</b> ${esc(c.current_pressure)}</div>`);
        }
        if (history.length > 0) {
            parts.push(`<div class="gl-history-toggle">Integrity history (${history.length})</div>`);
            parts.push(`<div class="gl-history-list" style="display:none">${history.map(historyLine).join('<br>')}</div>`);
        }
        parts.push(`</div>`);
    }

    // Demonstrated traits — detailed narrative entries
    const traits = toArr(pc.demonstrated_traits);
    if (traits.length) {
        parts.push(`<div class="gl-d-section"><b>Demonstrated Traits (${traits.length}):</b></div>`);
        const traitItems = traits.map(t => `<div class="gl-trait-block">- ${esc(t)}</div>`);
        parts.push(collapsibleList(traitItems, 5, 'older traits'));
    }

    // How others see PC — sourced from each character's knowledge_asymmetry flat keys that mention the PC.
    // Falls back to all flat KA leaves when no PC-specific subset is detectable (Phase 2: KA is the source of truth).
    const pcNameLowerKA = (pc.name || '').toLowerCase();
    const pcReads = [];
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        const ka = char.knowledge_asymmetry;
        if (!ka || typeof ka !== 'object' || Array.isArray(ka)) continue;
        const pcEntries = [];
        const allEntries = [];
        for (const [k, v] of Object.entries(ka)) {
            if (typeof v !== 'string' || !v) continue;
            allEntries.push({ k, v });
            if (k.endsWith('_pc') || k.includes('_pc_') || (pcNameLowerKA && k.toLowerCase().includes(pcNameLowerKA))) {
                pcEntries.push({ k, v });
            }
        }
        const entries = pcEntries.length ? pcEntries : allEntries;
        if (entries.length) pcReads.push({ who: char.name || char.id, entries, id: char.id });
    }
    if (pcReads.length) {
        parts.push(`<div class="gl-d-section"><b>How Others See PC:</b></div>`);
        for (const { who, entries, id } of pcReads) {
            parts.push(`<div class="gl-read-block">`);
            parts.push(`<div class="gl-read-target">${esc(who)}:</div>`);
            for (const { k, v } of entries) {
                const hist = getFieldHistory(state, 'char', id, `knowledge_asymmetry.${k}`);
                parts.push(`<div class="gl-read-text"><b>${esc(k)}:</b> ${esc(v)}</div>`);
                if (hist && hist.length > 1) {
                    parts.push(`<div class="gl-history-toggle">History (${hist.length})</div>`);
                    parts.push(`<div class="gl-history-list" style="display:none">${hist.map(historyLine).join('<br>')}</div>`);
                }
            }
            parts.push(`</div>`);
        }
    } else {
        parts.push(`<div class="gl-d-section"><b>How Others See PC:</b> <span class="gl-d-empty">—</span></div>`);
    }

    // Intimate history
    const intimate = toObj(pc.intimate_history);
    if (Object.keys(intimate).length) {
        parts.push(`<div class="gl-d-section"><b>Intimate History:</b></div>`);
        for (const [key, val] of Object.entries(intimate)) {
            parts.push(`<div class="gl-d-row"><b>${esc(key)}:</b> ${esc(val)}</div>`);
        }
    }

    return parts.join('');
}

function renderCharDossier(char, state) {
    const parts = [];

    parts.push(`<div class="gl-dossier-header"><b>${esc(char.name || char.id)}</b> ${badge(char.tier)}</div>`);

    if (char.power != null || char.power_base != null) {
        parts.push(`<div class="gl-d-row"><b>Power:</b> ${esc(renderPowerLabel(char))}</div>`);
        if (char.power_base != null && char.power != null && char.power !== char.power_base) {
            parts.push(`<div class="gl-d-row"><b>Base Power:</b> ${esc(String(char.power_base))}</div>`);
        }
    }
    if (char.power_basis) parts.push(`<div class="gl-d-row"><b>Power Basis:</b> ${esc(char.power_basis)}</div>`);
    const charAbilities = toArr(char.abilities);
    if (charAbilities.length) {
        parts.push(`<div class="gl-d-row"><b>Abilities:</b> ${charAbilities.map(ability => esc(ability)).join(', ')}</div>`);
    }
    if (char.location) parts.push(`<div class="gl-d-row"><b>Location:</b> ${esc(char.location)}</div>`);

    // Tags
    if (Array.isArray(char.tags) && char.tags.length > 0) {
        parts.push(`<div class="gl-d-row gl-tags">Tags: [${char.tags.map(t => esc(t)).join(', ')}]</div>`);
    }

    // Relationship block (before agenda)
    const rel = state.relationships?.[`pc-${char.id}`];
    if (rel && rel.status === 'active') {
        const orientClass = rel.orientation === 'reversed' ? 'gl-tarot-reversed' : 'gl-tarot-upright';
        parts.push(`<div class="gl-d-row gl-relationship ${orientClass}">&#9829; <b>${esc(formatCardName(rel.card))}</b> &middot; ${esc(rel.orientation)}</div>`);
        if (typeof rel.distance === 'string' && typeof rel.intensity === 'string') {
            parts.push(`<div class="gl-d-row gl-relationship-stage">${esc(rel.distance)} &middot; ${esc(rel.intensity)}</div>`);
        }
        if (rel.nuance) {
            parts.push(`<div class="gl-d-row gl-relationship-nuance">"${esc(rel.nuance)}"</div>`);
        }
    }

    if (char.agenda) parts.push(`<div class="gl-d-row gl-agenda"><b>Agenda:</b> ${esc(char.agenda)}</div>`);
    const ka = char.knowledge_asymmetry;
    if (ka && typeof ka === 'object' && !Array.isArray(ka)) {
        const kaItems = [];
        for (const [k, v] of Object.entries(ka)) {
            const m = /^(knows|unknown|hiding|misreading)_(.+)$/.exec(k);
            if (m) {
                const label = m[1].charAt(0).toUpperCase() + m[1].slice(1);
                const subject = m[2].replace(/_/g, ' ');
                kaItems.push(`<li><span class="gl-ka-bucket">${esc(label)}</span> <b>${esc(subject)}:</b> ${esc(String(v))}</li>`);
            } else {
                // Semantic flat keys (e.g. weapon_concealed, archangel_status) — render under "Other"
                const label = k.replace(/_/g, ' ');
                kaItems.push(`<li><span class="gl-ka-bucket">Other</span> <b>${esc(label)}:</b> ${esc(String(v))}</li>`);
            }
        }
        if (kaItems.length) {
            parts.push(`<div class="gl-d-row"><b>Knowledge:</b><ul class="gl-d-kalist">${kaItems.join('')}</ul></div>`);
        }
    }
    // Reads PC as — sourced from knowledge_asymmetry keys. Checks misreads_pc_as_<stance>
    // first (stance encoded in the key), then falls back to knows_pc_<fact>.
    let stanceDisplay = null;
    if (char.knowledge_asymmetry && typeof char.knowledge_asymmetry === 'object') {
        const kaKeys = Object.keys(char.knowledge_asymmetry);
        const misreadsKey = kaKeys.find(k => /^misreads_pc_as_(.+)$/.test(k));
        if (misreadsKey) {
            stanceDisplay = misreadsKey.replace(/^misreads_pc_as_/, '').replace(/_/g, ' ');
        } else {
            const knowsPcKey = kaKeys.find(k => k.startsWith('knows_pc_'));
            if (knowsPcKey) {
                stanceDisplay = knowsPcKey.replace(/^knows_pc_/, '').replace(/_/g, ' ') || String(char.knowledge_asymmetry[knowsPcKey]);
            }
        }
    }
    if (stanceDisplay) parts.push(`<div class="gl-d-row"><b>Reads PC as:</b> ${esc(stanceDisplay)}</div>`);
    const charWounds = toObj(char.wounds);
    if (Object.keys(charWounds).length) {
        parts.push(`<div class="gl-d-row"><b>Wounds:</b> ${Object.entries(charWounds).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(', ')}</div>`);
    }

    // Shedding order — match by id or name to handle LLM owner_id variations
    const charNameLower = (char.name || '').toLowerCase();
    const constraints = Object.values(state.constraints).filter(c =>
        c.owner_id === char.id ||
        (charNameLower && (c.owner_id || '').toLowerCase() === charNameLower)
    );
    const sorted = [...constraints].sort((a, b) => (Number(a.shedding_order) || 99) - (Number(b.shedding_order) || 99));
    if (sorted.length > 1) {
        const order = sorted.map(c => esc(c.name || c.id)).join(' first → ') + ' last';
        parts.push(`<div class="gl-d-row gl-shedding-order"><b>Shedding Order:</b> ${order}</div>`);
    }

    // Constraints — full dossier format
    if (constraints.length) {
        for (const c of sorted) {
            const history = getFieldHistory(state, 'constraint', c.id, 'integrity');
            const integrityDesc = c.integrity === 'STABLE' ? 'holding' : c.integrity === 'STRESSED' ? 'destabilized' : c.integrity === 'CRITICAL' ? 'approaching breach' : c.integrity === 'BREACHED' ? 'breached' : '';

            parts.push(`<div class="gl-constraint-card" data-id="${esc(c.id)}">`);
            parts.push(`<div class="gl-constraint-title"><b>${esc(c.name)}</b> ${badge(c.integrity)}${integrityDesc ? ` <span class="gl-integrity-desc">— ${esc(integrityDesc)}</span>` : ''}</div>`);

            if (c.profile) {
                parts.push(`<div class="gl-d-detail">${esc(c.profile)}</div>`);
            } else {
                if (c.prevents) parts.push(`<div class="gl-d-detail"><b>Prevents:</b> ${esc(c.prevents)}</div>`);
                if (c.threshold) parts.push(`<div class="gl-d-detail"><b>Threshold:</b> ${esc(c.threshold)}</div>`);
                if (c.replacement) parts.push(`<div class="gl-d-detail"><b>Replacement (if breached):</b> ${esc(c.replacement)}${c.replacement_type ? ` <i>(${esc(c.replacement_type)})</i>` : ''}</div>`);
                if (c.current_pressure) parts.push(`<div class="gl-d-pressure"><b>Current pressure:</b> ${esc(c.current_pressure)}</div>`);
            }

            if (history.length > 0) {
                parts.push(`<div class="gl-history-toggle">Integrity history (${history.length})</div>`);
                parts.push(`<div class="gl-history-list" style="display:none">${history.map(historyLine).join('<br>')}</div>`);
            }
            parts.push(`</div>`);
        }
    }

    // Structured relationships map (spec §2.1)
    const relationships = toObj(char.relationships);
    if (Object.keys(relationships).length) {
        parts.push(`<div class="gl-d-section"><b>Relationships:</b></div>`);
        for (const [target, descriptor] of Object.entries(relationships)) {
            parts.push(`<div class="gl-d-row"><b>${esc(target)}:</b> ${esc(String(descriptor))}</div>`);
        }
    }

    // Intimate history
    const intimate = toObj(char.intimate_history);
    if (Object.keys(intimate).length) {
        parts.push(`<div class="gl-d-section"><b>Intimate History:</b></div>`);
        for (const [key, val] of Object.entries(intimate)) {
            parts.push(`<div class="gl-d-row"><b>${esc(key)}:</b> ${esc(val)}</div>`);
        }
    }

    // Key moments — timestamped
    const moments = toArr(char.key_moments);
    if (moments.length) {
        parts.push(`<div class="gl-d-section"><b>Key Moments (${moments.length}):</b></div>`);
        const momentItems = moments.map(m => `<div class="gl-d-row gl-moment">${esc(m)}</div>`);
        parts.push(collapsibleList(momentItems, 3, 'older moments'));
    }

    return parts.join('');
}

// ─── Tab 2: Factions & World ────────────────────────────────────────────────────

function renderWorld(state) {
    const parts = [];
    const liveCollisions = Object.values(state.collisions || {}).filter(c => c.status === 'ACTIVE');

    // World state
    if (state.world.world_state) {
        parts.push(`<div class="gl-d-section"><b>World State:</b></div>`);
        parts.push(`<div class="gl-d-row">${esc(state.world.world_state)}</div>`);
        const hist = getFieldHistory(state, 'world', '_', 'world_state');
        if (hist.length > 1) {
            parts.push(`<div class="gl-history-toggle">History (${hist.length})</div>`);
            parts.push(`<div class="gl-history-list" style="display:none">${hist.map(historyLine).join('<br>')}</div>`);
        }
    }

    // Timeskip scale (spec §2.6)
    if (state.world.timeskip_scale) {
        parts.push(`<div class="gl-d-row"><b>Timeskip scale:</b> ${esc(state.world.timeskip_scale)}</div>`);
    }

    // Collision archive (spec §2.6 / entry template §2.2.1) — surfaced so dormant threads stay visible
    const archive = toArr(state.world.collision_archive);
    if (archive.length) {
        parts.push(`<div class="gl-d-section"><b>Collision Archive (${archive.length}):</b></div>`);
        const archItems = archive.map(entry => {
            if (typeof entry === 'string') return `<div class="gl-d-row">${esc(entry)}</div>`;
            const name = entry.name || entry.id || '?';
            const resolution = entry.resolution || entry.reason || '';
            const hook = entry.hook || '';
            const aftermath = entry.aftermath || '';
            const tx = entry.archived_at_tx ?? entry.tx ?? '';
            const txTag = tx !== '' ? ` <span class="gl-history-time">[tx ${esc(tx)}]</span>` : '';
            const entryParts = [`<b>${esc(name)}</b>`];
            if (resolution) entryParts.push(`<i>resolution:</i> ${esc(resolution)}`);
            if (hook) entryParts.push(`<i>hook:</i> ${esc(hook)}`);
            if (aftermath) entryParts.push(`<i>aftermath:</i> ${esc(aftermath)}`);
            return `<div class="gl-archive-entry">${entryParts.join(' — ')}${txTag}</div>`;
        });
        parts.push(collapsibleList(archItems, 3, 'older archived collisions'));
    }

    // Factions (spec §2.3)
    const factions = Object.values(state.factions);
    if (factions.length) {
        parts.push(`<div class="gl-d-section"><b>Factions:</b></div>`);
        for (const f of factions) {
            parts.push(`<div class="gl-faction-card">`);
            parts.push(`<b>${esc(f.name || f.id)}</b>${f.state ? ` ${badge(f.state)}` : ''}`);
            if (f.agenda) parts.push(`<div class="gl-d-detail gl-agenda"><b>Agenda:</b> ${esc(f.agenda)}</div>`);
            const members = toArr(f.members);
            if (members.length) parts.push(`<div class="gl-d-detail"><b>Members:</b> ${members.map(m => {
                const id = String(m).replace(/^char:/, '');
                const ch = state.characters?.[id];
                return esc(ch?.name || m);
            }).join(', ')}</div>`);
            const territory = toArr(f.territory);
            if (territory.length) parts.push(`<div class="gl-d-detail"><b>Territory:</b> ${territory.map(t => esc(t)).join(', ')}</div>`);
            // knowledge_asymmetry — spec §2.3, flat <category>_<subject> map
            const ka = (f.knowledge_asymmetry && typeof f.knowledge_asymmetry === 'object')
                     ? f.knowledge_asymmetry
                     : null;
            if (ka && Object.keys(ka).length) {
                const items = [];
                for (const [k, v] of Object.entries(ka)) {
                    const m = /^(knows|unknown|hiding|misreading)_(.+)$/.exec(k);
                    if (m) {
                        const label = m[1].charAt(0).toUpperCase() + m[1].slice(1);
                        const subject = m[2].replace(/_/g, ' ');
                        items.push(`<li><span class="gl-ka-bucket">${esc(label)}</span> <b>${esc(subject)}:</b> ${esc(String(v))}</li>`);
                    } else {
                        // Semantic flat keys — render under "Other" so no key is silently dropped
                        const label = k.replace(/_/g, ' ');
                        items.push(`<li><span class="gl-ka-bucket">Other</span> <b>${esc(label)}:</b> ${esc(String(v))}</li>`);
                    }
                }
                if (items.length) {
                    parts.push(`<div class="gl-d-detail"><b>Knowledge:</b><ul class="gl-d-kalist">${items.join('')}</ul></div>`);
                }
            }
            parts.push(`</div>`);
        }
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No world data</div>';
}

// ─── Tab 3: Collisions ──────────────────────────────────────────────────────────

function renderCollisions(state) {
    const all = Object.values(state.collisions);
    const active = all.filter(c => c.status === 'ACTIVE');
    const resolved = all.filter(c => c.status === 'RESOLVED' || c.status === 'CRASHED');

    if (all.length === 0) return '<div class="gl-empty">No collisions</div>';

    const parts = [];

    for (const col of active) {
        const forces = Array.isArray(col.forces) ? col.forces.map(f => typeof f === 'object' ? f.name || f : f).join(' vs ') : String(col.forces || '');
        const dist = col.distance != null ? Number(col.distance) : null;
        const distBar = dist != null ? renderDistanceBar(dist, col.distance_category) : '';
        const parents = toArr(col.parent_collision_ids);

        parts.push(`<div class="gl-collision-card" data-kind="collision" data-id="${esc(col.id)}">`);
        parts.push(`<div class="gl-collision-name">${esc(col.name || col.id)} ${badge(col.status)}</div>`);
        if (forces) parts.push(`<div class="gl-d-detail"><b>Forces:</b> ${esc(forces)}</div>`);
        const involved = toArr(col.involved_chars);
        if (involved.length) {
            parts.push(`<div class="gl-d-detail"><b>Involved:</b> ${involved.map(c => {
                const id = String(c).replace(/^char:/, '');
                return esc(state.characters?.[id]?.name || c);
            }).join(', ')}</div>`);
        }
        if (col.location) {
            const placeId = String(col.location).replace(/^place:/, '');
            const placeName = state.places?.[placeId]?.name || col.location;
            parts.push(`<div class="gl-d-detail"><b>Location:</b> ${esc(placeName)}</div>`);
        }
        if (distBar) parts.push(distBar);
        if (parents.length) parts.push(`<div class="gl-d-detail"><b>From:</b> ${parents.map(p => esc(p)).join(', ')}</div>`);

        const distHist = getFieldHistory(state, 'collision', col.id, 'distance');
        const statusHist = getFieldHistory(state, 'collision', col.id, 'status');
        const allHist = [...distHist, ...statusHist].sort((a, b) => (a.tx || 0) - (b.tx || 0));
        if (allHist.length) {
            parts.push(`<div class="gl-history-toggle">History (${allHist.length})</div>`);
            parts.push(`<div class="gl-history-list" style="display:none">${allHist.map(historyLine).join('<br>')}</div>`);
        }
        parts.push(`</div>`);
    }

    if (resolved.length) {
        parts.push(`<div class="gl-d-section"><b>Resolved:</b></div>`);
        for (const col of resolved) {
            const outcomeLabel = col.outcome_type ? ` [${col.outcome_type}]` : '';
            const forces = Array.isArray(col.forces) ? col.forces.map(f => typeof f === 'object' ? f.name || f : f).join(' vs ') : String(col.forces || '');
            const parents = toArr(col.parent_collision_ids);
            const successors = toArr(col.successor_collision_ids);
            parts.push(`<div class="gl-collision-card gl-resolved" data-kind="collision" data-id="${esc(col.id)}">`);
            parts.push(`<div class="gl-collision-name">${esc(col.name || col.id)}${outcomeLabel}</div>`);
            if (forces) parts.push(`<div class="gl-d-detail"><b>Forces:</b> ${esc(forces)}</div>`);
            const involved = toArr(col.involved_chars);
            if (involved.length) {
                parts.push(`<div class="gl-d-detail"><b>Involved:</b> ${involved.map(c => {
                    const id = String(c).replace(/^char:/, '');
                    return esc(state.characters?.[id]?.name || c);
                }).join(', ')}</div>`);
            }
            if (col.location) {
                const placeId = String(col.location).replace(/^place:/, '');
                const placeName = state.places?.[placeId]?.name || col.location;
                parts.push(`<div class="gl-d-detail"><b>Location:</b> ${esc(placeName)}</div>`);
            }
            if (col.aftermath) parts.push(`<div class="gl-d-detail"><b>Aftermath:</b> ${esc(col.aftermath)}</div>`);
            if (parents.length) parts.push(`<div class="gl-d-detail"><b>From:</b> ${parents.map(p => esc(p)).join(', ')}</div>`);
            if (successors.length) parts.push(`<div class="gl-d-detail"><b>Spawned:</b> ${successors.map(s => esc(s)).join(', ')}</div>`);
            parts.push(`</div>`);
        }
    }

    return parts.join('');
}

function renderCombat(state) {
    const runtime = getChallengeRuntime();
    const settings = getChallengeSettings('combat');
    const thresholds = getCombatThresholdTable(settings);
    const combat = runtime ? getChallengeEntity(state, runtime) : null;
    const baseline = runtime && combatProfile ? combatProfile.getBaseline(state, combat) : null;
    const parts = [];

    parts.push(`<div class="gl-d-row"><b>Difficulty:</b>
        <select class="gl-div-select" id="gl-combat-mode">
            ${renderCombatModeOptions(settings.mode)}
        </select>
    </div>`);
    parts.push(`<div class="gl-d-row gl-history-time">Thresholds: Highly likely ${esc(thresholds['Highly likely'])}+ | Average ${esc(thresholds.Average)}+ | Highly unlikely ${esc(thresholds['Highly unlikely'])}+</div>`);

    if (settings.mode === 'Custom') {
        const custom = settings.custom_dcs || {};
        parts.push(`<div class="gl-d-row"><b>Custom thresholds:</b></div>`);
        parts.push(`<div class="gl-d-row">Highly likely <input class="gl-combat-custom-dc" data-kind="Highly likely" type="number" value="${esc(custom['Highly likely'] ?? 3)}" style="width:64px;margin-left:8px"></div>`);
        parts.push(`<div class="gl-d-row">Average <input class="gl-combat-custom-dc" data-kind="Average" type="number" value="${esc(custom.Average ?? 7)}" style="width:64px;margin-left:8px"></div>`);
        parts.push(`<div class="gl-d-row">Highly unlikely <input class="gl-combat-custom-dc" data-kind="Highly unlikely" type="number" value="${esc(custom['Highly unlikely'] ?? 12)}" style="width:64px;margin-left:8px"></div>`);
    }

    if (!runtime) {
        parts.push(`<div class="gl-empty">No active combat runtime</div>`);
        return parts.join('');
    }

    parts.push(`<div class="gl-d-section"><b>Runtime:</b></div>`);
    parts.push(`<div class="gl-d-row"><b>Combat ID:</b> ${esc(runtime.combat_id)}</div>`);
    parts.push(`<div class="gl-d-row"><b>Lock:</b> ${esc(runtime.locked ? 'engaged' : 'released')}</div>`);
    parts.push(`<div class="gl-d-row"><b>Phase:</b> ${esc(runtime.phase || '?')}</div>`);
    parts.push(`<div class="gl-d-row"><b>Clash:</b> ${esc(runtime.clash ?? '?')}</div>`);
    if (baseline) {
        parts.push(`<div class="gl-d-row"><b>Baseline:</b> ${esc(baseline.category)}${baseline.gap != null ? ` (gap ${esc(baseline.gap)})` : ''}</div>`);
        if (baseline.category === 'Highly likely' || baseline.category === 'Average' || baseline.category === 'Highly unlikely') {
            parts.push(`<div class="gl-d-row"><b>Baseline threshold:</b> ${esc(thresholds[baseline.category])}+ on d20</div>`);
        }
        if (baseline.primary_enemy) {
            parts.push(`<div class="gl-d-row"><b>Primary Enemy:</b> ${esc(baseline.primary_enemy.name || baseline.primary_enemy.id || '?')}${baseline.primary_enemy.power != null ? ` [power ${esc(baseline.primary_enemy.power)}]` : ''}</div>`);
        }
    }

    if (combat) {
        parts.push(`<div class="gl-d-section"><b>Combat Entity:</b></div>`);
        parts.push(`<div class="gl-d-row"><b>Status:</b> ${esc(combat.status || 'ACTIVE')}</div>`);
        if (combat.primary_enemy) parts.push(`<div class="gl-d-row"><b>Primary enemy:</b> ${esc(typeof combat.primary_enemy === 'object' ? combat.primary_enemy.name || combat.primary_enemy.id || '?' : combat.primary_enemy)}</div>`);
        if (combat.opened_from) parts.push(`<div class="gl-d-row"><b>Opened from:</b> collision:${esc(combat.opened_from)}</div>`);
        if (combat.outcome) parts.push(`<div class="gl-d-row"><b>Outcome:</b> ${esc(combat.outcome)}</div>`);
        if (combat.aftermath) parts.push(`<div class="gl-d-row"><b>Aftermath:</b> ${esc(combat.aftermath)}</div>`);
    } else {
        parts.push(`<div class="gl-d-row"><b>Combat Entity:</b> not created yet</div>`);
    }

    if (runtime.pending_action) {
        parts.push(`<div class="gl-d-section"><b>Pending Action:</b></div>`);
        parts.push(`<div class="gl-d-row">${esc(runtime.pending_action.intent || '')}</div>`);
        if (runtime.pending_action.declared_category) parts.push(`<div class="gl-d-row"><b>Declared:</b> ${esc(runtime.pending_action.declared_category)}</div>`);
        if (runtime.pending_action.effective_category) parts.push(`<div class="gl-d-row"><b>Effective:</b> ${esc(runtime.pending_action.effective_category)}</div>`);
    }

    if (runtime.pending_roll || runtime.last_resolution?.roll) {
        const roll = runtime.pending_roll || runtime.last_resolution?.roll;
        parts.push(`<div class="gl-d-section"><b>${runtime.pending_roll ? 'Pending Roll' : 'Last Roll'}:</b></div>`);
        if (roll.skip) {
            parts.push(`<div class="gl-d-row">${esc(roll.reason === 'absolute' ? 'Auto-success' : 'Auto-fail')} (${esc(roll.category)})</div>`);
        } else {
            if (roll.d20 != null) parts.push(`<div class="gl-d-row"><b>d20:</b> ${esc(roll.d20)}</div>`);
            if (roll.dc != null) parts.push(`<div class="gl-d-row"><b>Threshold:</b> ${esc(roll.dc)}+ on d20</div>`);
            if (roll.category) parts.push(`<div class="gl-d-row"><b>Category:</b> ${esc(roll.category)}</div>`);
            if (roll.resolution || roll.success != null) {
                const label = roll.resolution || (roll.success ? 'SUCCESS' : 'TRANSFORM');
                const criticalNote = roll.critical && !String(label).startsWith('CRITICAL_')
                    ? ` (critical ${esc(roll.critical)})`
                    : '';
                parts.push(`<div class="gl-d-row"><b>Result:</b> ${esc(label)}${criticalNote}</div>`);
            }
            if (roll.challenge_pending) parts.push(`<div class="gl-d-row"><b>State:</b> awaiting reassessment</div>`);
            if (roll.draw?.label) parts.push(`<div class="gl-d-row"><b>Draw:</b> ${esc(roll.draw.label)}</div>`);
        }
    }

    const options = Array.isArray(runtime.options) ? runtime.options : [];
    if (options.length) {
        parts.push(`<div class="gl-d-section"><b>Stored Options:</b></div>`);
        for (const option of options) {
            parts.push(`<div class="gl-d-row">${esc(option.index)}. ${esc(option.label || option.intent)} <span class="gl-history-time">[${esc(option.category)}]</span></div>`);
        }
    }

    return parts.join('');
}

function renderDistanceBar(dist, category) {
    const max = CATEGORY_DISTANCES[category] || 10;
    // IMMEDIATE is always "about to arrive" — paint the bar full-red regardless of dist.
    if (category === 'IMMEDIATE') {
        const catLabel = ` [${category}]`;
        return `<div class="gl-dist-bar"><div class="gl-dist-fill" style="width:100%;background:#f66"></div><span class="gl-dist-label">dist: ${dist}${catLabel}</span></div>`;
    }
    const pct = Math.max(0, Math.min(100, (dist / max) * 100));
    // Threshold colors are relative to max — red at ≤30%, yellow at ≤60%, green otherwise.
    const color = dist <= max * 0.3 ? '#f66' : dist <= max * 0.6 ? '#da6' : '#6a6';
    const catLabel = category ? ` [${category}]` : '';
    return `<div class="gl-dist-bar"><div class="gl-dist-fill" style="width:${pct}%;background:${color}"></div><span class="gl-dist-label">dist: ${dist}${catLabel}</span></div>`;
}

// ─── Tab: Places ────────────────────────────────────────────────────────────────

function renderPlaces(state) {
    const places = Object.values(state.places || {});
    if (!places.length) return '<div class="gl-empty">No places recorded</div>';

    const parts = [];
    for (const p of places) {
        parts.push(`<div class="gl-place-card" data-kind="place" data-id="${esc(p.id)}">`);
        parts.push(`<div class="gl-collision-name">${esc(p.name || p.id)} ${badge(p.state || 'unknown')}</div>`);
        parts.push(`<div class="gl-d-detail"><b>Reach:</b> ${badge(p.reach || 'LOCAL')} <span class="gl-history-time">id ${esc(p.id)}</span></div>`);
        if (p.description) parts.push(`<div class="gl-d-detail">${esc(p.description)}</div>`);
        parts.push(`</div>`);
    }
    return parts.join('');
}

// ─── Tab: Pressures ─────────────────────────────────────────────────────────────

function renderPressures(state) {
    const pressures = Object.values(state.pressures || {});
    if (!pressures.length) return ''; // spec §9/step 11: omit when empty

    const parts = [`<ul class="gl-pressure-list">`];
    for (const p of pressures) {
        const related = Array.isArray(p.related_to) && p.related_to.length
            ? ` <span class="gl-history-time">→ ${esc(p.related_to.join(', '))}</span>`
            : '';
        const source = p.source ? ` <span class="gl-history-time">(${esc(p.source)})</span>` : '';
        parts.push(`<li class="gl-pressure-item" data-kind="pressure" data-id="${esc(p.id)}"><b>${esc(p.name || p.id)}</b>${source}${related}</li>`);
    }
    parts.push(`</ul>`);
    return parts.join('');
}

// ─── Tab: Divination ────────────────────────────────────────────────────────────

function renderDivination(state) {
    const div = state.divination || {};
    const { chatMetadata } = SillyTavern.getContext();
    const activeSystem = chatMetadata?.['gravity_divination_system'] || div.active_system || 'arcana';
    const parts = [];

    // Dropdown selector
    parts.push(`<div class="gl-d-row"><b>System:</b>
        <select class="gl-div-select" id="gl-divination-select">
            <option value="arcana"${activeSystem === 'arcana' ? ' selected' : ''}>Major Arcana (d22)</option>
            <option value="classic"${activeSystem === 'classic' || activeSystem === '2d10' ? ' selected' : ''}>Classic Entropy (2d10)</option>
        </select>
    </div>`);

    if (div.last_draw) {
        parts.push(`<div class="gl-d-section"><b>Last Draw:</b></div>`);
        const ld = typeof div.last_draw === 'object' ? div.last_draw : { value: div.last_draw };
        if (ld.value) parts.push(`<div class="gl-d-row"><b>Value:</b> ${esc(ld.value)}</div>`);
        if (ld.reading) parts.push(`<div class="gl-d-row"><b>Reading:</b> ${esc(ld.reading)}</div>`);
        if (ld.timestamp || ld.t) parts.push(`<div class="gl-d-row gl-history-time">${esc(ld.timestamp || ld.t)}</div>`);
    }

    const readings = toArr(div.readings);
    if (readings.length) {
        parts.push(`<div class="gl-d-section"><b>Reading History (${readings.length}):</b></div>`);
        const readItems = readings.slice().reverse().map(r => {
            const rd = typeof r === 'object' ? r : { value: r };
            return `<div class="gl-d-row">${esc(rd.value || '?')} — ${esc(rd.reading || '')} <span class="gl-history-time">${esc(rd.t || rd.timestamp || '')}</span></div>`;
        });
        parts.push(collapsibleList(readItems, 3, 'older readings'));
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No divination data</div>';
}

function renderExemplars() {
    const { chatMetadata } = SillyTavern.getContext();
    const exemplars = chatMetadata?.['gravity_exemplars'] || [];
    if (exemplars.length === 0) {
        return '<div class="gl-empty">No exemplars saved. Click Good to paste prose you liked.</div>';
    }
    const parts = [];
    for (let i = 0; i < exemplars.length; i++) {
        const ex = normalizeExemplarRecord(exemplars[i]);
        if (!ex) continue;
        const text = ex.text;
        const truncated = text.length > 200 ? text.substring(0, 200) + '…' : text;
        const metaBits = [
            ex.category ? `Category: ${ex.category}` : '',
            ex.strengths?.length ? `Strengths: ${ex.strengths.join(', ')}` : '',
            ex.turn ? `Saved on turn ${ex.turn}` : '',
        ].filter(Boolean);
        parts.push(`<div class="gl-exemplar-card" data-idx="${i}">
            <div class="gl-exemplar-text">${esc(truncated)}</div>
            ${metaBits.length ? `<div class="gl-history-time">${esc(metaBits.join(' | '))}</div>` : ''}
            <div class="gl-exemplar-actions">
                <button class="gl-exemplar-btn gl-exemplar-edit" data-idx="${i}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="gl-exemplar-btn gl-exemplar-remove" data-idx="${i}" title="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`);
    }
    parts.push('<div class="gl-d-row" style="opacity:.5;font-size:10px;">Mode-matched exemplars are injected as technique targets for the current turn.</div>');
    return parts.join('');
}

// ─── Toolbar Handlers ───────────────────────────────────────────────────────────

async function handleNew() {
    if (!_onNew) return;
    try {
        const { Popup } = SillyTavern.getContext();
        const result = await Popup.show.confirm('New Ledger', 'Clear all ledger data for this chat and start fresh?');
        if (!result) return;
        await _onNew();
        toastr.success('New ledger created.');
    } catch (err) {
        toastr.error('Failed: ' + err.message);
    }
}

async function handleExport() {
    try {
        if (!_onExport) return;
        const data = await _onExport();
        if (!data) { toastr.warning('No data.'); return; }
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${_currentBookName || 'gravity-ledger'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toastr.success('Exported.');
    } catch (err) {
        toastr.error('Export failed: ' + err.message);
    }
}

async function handleImport() {
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.transactions || !Array.isArray(data.transactions)) {
                toastr.error('Invalid file — missing transactions.');
                return;
            }
            if (_onImport) {
                await _onImport(data);
                toastr.success(`Imported ${data.transactions.length} TX.`);
            }
        });
        input.click();
    } catch (err) {
        toastr.error('Import failed: ' + err.message);
    }
}

// ─── Drag Logic ─────────────────────────────────────────────────────────────────

function initDrag(panel, handle) {
    let isDragging = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.gl-popup-close')) return;
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.transition = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = (e.clientX - offsetX) + 'px';
        panel.style.top = (e.clientY - offsetY) + 'px';
        panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { isDragging = false; panel.style.transition = ''; });
}

function showSetupPhase(label) {
    const indicator = document.getElementById('gl-setup-indicator');
    const labelEl = document.getElementById('gl-setup-label');
    if (!indicator) return;
    if (label) {
        indicator.classList.remove('gl-hidden');
        if (labelEl) labelEl.textContent = label;
    } else {
        indicator.classList.add('gl-hidden');
    }
}

export { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning, PANEL_ID };
