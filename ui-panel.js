/**
 * ui-panel.js — Floating popup panel for Gravity Ledger.
 *
 * 5 top-level tabs:
 * 1. Characters — sub-tabs per character with full dossiers
 * 2. Factions & World — factions, world state, pressure points, constants
 * 3. Collisions — active/simmering with distance
 * 4. Arc & Chapters — chapter lifecycle, story summary
 * 5. Divination — active system, last draw, reading history
 */

import { getFieldHistory, getEntityHistory } from './state-compute.js';
import { fetchOpenRouterModels, testOpenRouterKey } from './ledger-agent.js';

const PANEL_ID = 'gravity-ledger-panel';
const TOGGLE_ID = 'gravity-ledger-toggle';

let _onExport = null;
let _onImport = null;
let _onNew = null;
let _onSetup = null;
let _onTimeskip = null;
let _onChapterClose = null;
let _onRegister = null;
let _onAdvance = null;
let _onRevertTurn = null;
let _onGoodTurn = null;
let _onCombat = null;
let _onCombatSetup = null;
let _onDivinationChange = null;
let _onIntimacy = null;
let _onLengthChange = null;
let _onSettingsChange = null;

function setCallbacks({ onExport, onImport, onNew, onSetup, onTimeskip, onChapterClose, onRegister, onAdvance, onRevertTurn, onGoodTurn, onCombat, onCombatSetup, onDivinationChange, onIntimacy, onLengthChange, onSettingsChange }) {
    _onExport = onExport;
    _onImport = onImport;
    _onNew = onNew;
    _onSetup = onSetup;
    _onTimeskip = onTimeskip;
    _onChapterClose = onChapterClose;
    _onRegister = onRegister;
    _onAdvance = onAdvance;
    _onRevertTurn = onRevertTurn;
    _onGoodTurn = onGoodTurn;
    _onCombat = onCombat;
    _onCombatSetup = onCombatSetup;
    _onDivinationChange = onDivinationChange;
    _onIntimacy = onIntimacy;
    _onLengthChange = onLengthChange;
    _onSettingsChange = onSettingsChange;
}

let _currentBookName = '';

function setBookName(name) {
    _currentBookName = name || '';
    const label = document.getElementById('gl-chat-label');
    if (label) label.textContent = name || 'No chat';
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function badge(value) {
    return value ? `<span class="gl-badge gl-badge-${esc(value)}">${esc(value)}</span>` : '';
}

function historyLine(h) {
    return `<span class="gl-history-entry">${esc(h.from || '?')} → ${esc(h.to || '?')} <span class="gl-history-time">${esc(h.t)} ${h.r ? '— ' + esc(h.r) : ''}</span></span>`;
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
            <button class="gl-cmd-btn" data-cmd="setup" title="Setup Wizard (or cancel)"><i class="fa-solid fa-wand-magic-sparkles"></i> Setup</button>
            <button class="gl-cmd-btn" data-cmd="timeskip" title="Timeskip"><i class="fa-solid fa-forward"></i> Skip</button>
            <button class="gl-cmd-btn" data-cmd="chapter_close" title="Close chapter"><i class="fa-solid fa-flag-checkered"></i> Close Ch.</button>
            <button class="gl-cmd-btn" data-cmd="register" title="Register/promote NPC"><i class="fa-solid fa-user-plus"></i> Register</button>
            <button class="gl-cmd-btn" data-cmd="advance" title="Yield initiative — let the world move"><i class="fa-solid fa-play"></i> Advance</button>
            <button class="gl-cmd-btn" data-cmd="combat_setup" title="Define power scale and combat rules"><i class="fa-solid fa-shield-halved"></i> Combat Setup</button>
            <button class="gl-cmd-btn" data-cmd="combat" title="Initiate combat — fight this"><i class="fa-solid fa-burst"></i> Combat</button>
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
    `;
    document.body.appendChild(panel);

    document.getElementById('gl-close-btn').addEventListener('click', () => panel.classList.add('gl-hidden'));
    document.getElementById('gl-btn-new').addEventListener('click', handleNew);
    document.getElementById('gl-btn-import').addEventListener('click', handleImport);
    document.getElementById('gl-btn-export').addEventListener('click', handleExport);

    // Command buttons
    document.getElementById('gl-cmd-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('.gl-cmd-btn');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (!cmd) return;

        switch (cmd) {
            case 'setup': if (_onSetup) _onSetup(); break;
            case 'timeskip': if (_onTimeskip) _onTimeskip(); break;
            case 'chapter_close': if (_onChapterClose) _onChapterClose(); break;
            case 'register': if (_onRegister) _onRegister(); break;
            case 'advance': if (_onAdvance) _onAdvance(); break;
            case 'combat_setup': if (_onCombatSetup) _onCombatSetup(); break;
            case 'combat': if (_onCombat) _onCombat(); break;
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
let _lastCommitTxIds = [];

function renderAllSections() {
    const container = document.getElementById('gl-all-sections');
    if (!container) return;

    const state = _lastState || {};

    const sections = [
        { id: 'characters', icon: 'fa-users', title: 'Cast', html: renderCharacters(state) },
        { id: 'world', icon: 'fa-globe', title: 'Factions & World', html: renderWorld(state) },
        { id: 'collisions', icon: 'fa-burst', title: 'Collisions', html: renderCollisions(state) },
        { id: 'arc', icon: 'fa-book-open', title: 'Arc & Chapters', html: renderArc(state) },
        { id: 'settings', icon: 'fa-gear', title: 'Settings', html: renderSettings(state) },
        { id: 'deepseek', icon: 'fa-robot', title: 'DeepSeek', html: renderDeepSeek() },
        { id: 'exemplars', icon: 'fa-thumbs-up', title: 'Style Exemplars', html: renderExemplars() },
    ];

    container.innerHTML = sections.map(s => `
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

    // Helper: save setting + trigger re-inject
    const saveSetting = async (key, value, label) => {
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        chatMetadata[key] = value;
        await saveMetadata();
        toastr.info(`${label}: ${value}`);
        if (_onSettingsChange) _onSettingsChange(key, value);
    };

    // Model tier selector
    const tierSelect = container.querySelector('#gl-tier-select');
    if (tierSelect) {
        tierSelect.addEventListener('change', () => saveSetting('gravity_model_tier', tierSelect.value, 'Model tier'));
    }

    // Tense selector
    const tenseSelect = container.querySelector('#gl-tense-select');
    if (tenseSelect) {
        tenseSelect.addEventListener('change', () => saveSetting('gravity_tense', tenseSelect.value, 'Tense'));
    }

    // Perspective selector
    const perspSelect = container.querySelector('#gl-perspective-select');
    if (perspSelect) {
        perspSelect.addEventListener('change', () => saveSetting('gravity_perspective', perspSelect.value, 'Perspective'));
    }

    // Ledger agent (OpenRouter) settings
    const dsEnabledCb = container.querySelector('#gl-ds-enabled');
    const dsApiKeyInput = container.querySelector('#gl-ds-apikey');
    const dsModelEl = container.querySelector('#gl-ds-model');
    const dsKeyToggle = container.querySelector('#gl-ds-key-toggle');
    const dsKeyTest = container.querySelector('#gl-ds-key-test');
    const dsKeyStatus = container.querySelector('#gl-ds-key-status');
    const dsFetchBtn = container.querySelector('#gl-ds-fetch-models');

    const saveDeepSeek = async (label = 'Ledger agent saved') => {
        const { chatMetadata, saveMetadata } = SillyTavern.getContext();
        const existing = chatMetadata['gravity_deepseek'] || {};
        chatMetadata['gravity_deepseek'] = {
            ...existing,
            enabled: dsEnabledCb?.checked === true,
            apiKey: dsApiKeyInput?.value?.trim() || '',
            model: dsModelEl?.value || 'deepseek/deepseek-chat',
        };
        await saveMetadata();
        if (_onSettingsChange) _onSettingsChange('gravity_deepseek', chatMetadata['gravity_deepseek']);
        toastr.info(label);
    };

    if (dsEnabledCb) dsEnabledCb.addEventListener('change', () => saveDeepSeek(`Ledger agent: ${dsEnabledCb.checked ? 'enabled' : 'disabled'}`));
    if (dsApiKeyInput) dsApiKeyInput.addEventListener('blur', () => saveDeepSeek('API key saved'));
    if (dsModelEl) dsModelEl.addEventListener('change', () => saveDeepSeek(`Model: ${dsModelEl.value}`));
    if (dsKeyToggle) {
        dsKeyToggle.addEventListener('click', () => {
            if (!dsApiKeyInput) return;
            const isHidden = dsApiKeyInput.type === 'password';
            dsApiKeyInput.type = isHidden ? 'text' : 'password';
            dsKeyToggle.innerHTML = isHidden
                ? '<i class="fa-solid fa-eye-slash"></i>'
                : '<i class="fa-solid fa-eye"></i>';
        });
    }
    if (dsKeyTest) {
        dsKeyTest.addEventListener('click', async () => {
            const apiKey = dsApiKeyInput?.value?.trim() || '';
            if (!apiKey) { toastr.warning('Enter an OpenRouter API key first.'); return; }
            dsKeyTest.disabled = true;
            dsKeyTest.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            if (dsKeyStatus) dsKeyStatus.textContent = 'Testing…';
            try {
                const result = await testOpenRouterKey(apiKey);
                if (dsKeyStatus) {
                    dsKeyStatus.style.color = '#4caf50';
                    dsKeyStatus.textContent = `✓ ${result.label} — ${result.usage}`;
                }
            } catch (e) {
                if (dsKeyStatus) {
                    dsKeyStatus.style.color = '#f44336';
                    dsKeyStatus.textContent = `✗ ${e.message}`;
                }
            } finally {
                dsKeyTest.disabled = false;
                dsKeyTest.innerHTML = '<i class="fa-solid fa-plug"></i>';
            }
        });
    }
    if (dsFetchBtn) {
        dsFetchBtn.addEventListener('click', async () => {
            const apiKey = dsApiKeyInput?.value?.trim() || '';
            if (!apiKey) { toastr.warning('Enter an OpenRouter API key first.'); return; }
            dsFetchBtn.disabled = true;
            dsFetchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                const models = await fetchOpenRouterModels(apiKey);
                const { chatMetadata, saveMetadata } = SillyTavern.getContext();
                const existing = chatMetadata['gravity_deepseek'] || {};
                chatMetadata['gravity_deepseek'] = { ...existing, apiKey, models };
                await saveMetadata();
                toastr.info(`Fetched ${models.length} models`);
                // Re-render the DeepSeek section
                const body = container.closest('[data-body="deepseek"]') || container.querySelector('[data-body="deepseek"]');
                if (_lastState !== undefined) renderAllSections();
            } catch (e) {
                toastr.error(`Failed to fetch models: ${e.message}`);
            } finally {
                dsFetchBtn.disabled = false;
                dsFetchBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Fetch models';
            }
        });
    }

    // Auto-save textareas — save on blur (click away)
    container.querySelectorAll('.gl-auto-save').forEach(el => {
        el.addEventListener('blur', async () => {
            const key = el.dataset.key;
            if (!key) return;
            const { chatMetadata, saveMetadata } = SillyTavern.getContext();
            chatMetadata[key] = el.value.trim();
            await saveMetadata();
            toastr.info(`Saved: ${key.replace('gravity_', '')}`);
        });
    });

    // Exemplar edit/remove buttons
    container.querySelectorAll('.gl-exemplar-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const { chatMetadata, saveMetadata, Popup } = SillyTavern.getContext();
            const exemplars = chatMetadata?.['gravity_exemplars'] || [];
            if (idx < 0 || idx >= exemplars.length) return;
            const current = typeof exemplars[idx] === 'object' ? exemplars[idx].text : exemplars[idx];
            const newText = await Popup.show.input('Edit Exemplar', 'Edit the exemplar text:', current);
            if (newText === null || newText === undefined) return;
            if (typeof exemplars[idx] === 'object') {
                exemplars[idx].text = newText.trim();
            } else {
                exemplars[idx] = newText.trim();
            }
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
}

// ─── Update Panel ───────────────────────────────────────────────────────────────

function updatePanel(state, turn, committedTxIds) {
    if (!document.getElementById(PANEL_ID)) createPanel();

    const statusEl = document.getElementById('gl-status');
    const turnEl = document.getElementById('gl-turn');
    const txEl = document.getElementById('gl-tx');

    if (!state) {
        if (statusEl) statusEl.textContent = 'no chat';
        const container = document.getElementById('gl-all-sections');
        if (container) container.innerHTML = '<div class="gl-empty">No active chat</div>';
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
    if (committedTxIds) _lastCommitTxIds = committedTxIds;

    if (statusEl) statusEl.textContent = _staleWarning ? 'stale — eval recommended' : 'active';
    if (turnEl) turnEl.textContent = `Turn ${turn}`;
    if (txEl) txEl.textContent = `TX ${state.lastTxId ?? 0}`;

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
    for (const collection of ['characters', 'constraints', 'collisions', 'chapters', 'factions']) {
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
    if (JSON.stringify(prev.story_summary) !== JSON.stringify(curr.story_summary)) {
        _changedKeys.add('story_summary');
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
        if (sid === 'arc') hasChanges = [..._changedKeys].some(k => k.startsWith('chapters.') || k === 'story_summary');
        if (sid === 'divination') hasChanges = [..._changedKeys].some(k => k.startsWith('divination.'));
        if (hasChanges) section.querySelector('.gl-section-header')?.classList.add('gl-changed');
    });
    // Highlight constraint cards that changed
    document.querySelectorAll('.gl-constraint-card').forEach(card => {
        // Try to find constraint id from the card content
        const title = card.querySelector('.gl-constraint-title')?.textContent || '';
        for (const key of _changedKeys) {
            if (key.startsWith('constraints.') && title) {
                card.classList.add('gl-changed');
                break;
            }
        }
    });
    // Highlight collision cards that changed
    document.querySelectorAll('.gl-collision-card').forEach(card => {
        card.classList.add('gl-changed');
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
    const chars = Object.values(state.characters).filter(c => c.tier !== 'UNKNOWN');

    if (!pc.name && chars.length === 0) return '<div class="gl-empty">No characters tracked</div>';

    // Build sub-tabs: PC first, then Principal, Tracked, Known
    const allChars = [];
    if (pc.name) allChars.push({ _isPC: true, id: 'pc', name: pc.name, tier: 'PC', ...pc });
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
    const parts = [];
    parts.push(`<div class="gl-dossier-header"><b>${esc(pc.name)}</b> ${badge('PC')}</div>`);

    // Status fields
    if (pc.power != null) {
        parts.push(`<div class="gl-d-row"><b>Power:</b> ${esc(String(pc.power))}</div>`);
    }
    if (pc.current_scene) parts.push(`<div class="gl-d-row"><b>Scene:</b> ${esc(pc.current_scene)}</div>`);
    if (pc.location) parts.push(`<div class="gl-d-row"><b>Location:</b> ${esc(pc.location)}</div>`);
    if (pc.condition) parts.push(`<div class="gl-d-row"><b>Condition:</b> ${esc(pc.condition)}</div>`);
    if (pc.equipment) parts.push(`<div class="gl-d-row"><b>Equipment:</b> ${esc(pc.equipment)}</div>`);
    const pcWounds = toObj(pc.wounds);
    if (Object.keys(pcWounds).length) {
        parts.push(`<div class="gl-d-section"><b>Wounds:</b></div>`);
        for (const [k, v] of Object.entries(pcWounds)) {
            parts.push(`<div class="gl-d-detail">${esc(k)}: ${esc(v)}</div>`);
        }
    }

    // Demonstrated traits — detailed narrative entries
    const traits = toArr(pc.demonstrated_traits);
    if (traits.length) {
        parts.push(`<div class="gl-d-section"><b>Demonstrated Traits (${traits.length}):</b></div>`);
        const traitItems = traits.map(t => `<div class="gl-trait-block">- ${esc(t)}</div>`);
        parts.push(collapsibleList(traitItems, 5, 'older traits'));
    }

    // How others see PC — merged from character reads[pc] + legacy pc.reputation
    const pcReads = [];
    for (const char of Object.values(state.characters)) {
        if (char.tier === 'UNKNOWN') continue;
        const readOfPc = char.reads?.pc || char.reads?.[pc.name] || char.stance_toward_pc;
        if (readOfPc) pcReads.push({ who: char.name || char.id, read: readOfPc, id: char.id });
    }
    const legacyRep = toObj(pc.reputation);
    for (const [who, r] of Object.entries(legacyRep)) {
        if (!pcReads.some(p => p.who.toLowerCase().includes(who.toLowerCase()))) {
            pcReads.push({ who, read: r, id: who });
        }
    }
    if (pcReads.length) {
        parts.push(`<div class="gl-d-section"><b>How Others See PC:</b></div>`);
        for (const { who, read, id } of pcReads) {
            const hist = getFieldHistory(state, 'char', id, 'reads.pc') || getFieldHistory(state, 'pc', '_', `reputation.${who}`);
            parts.push(`<div class="gl-read-block">`);
            parts.push(`<div class="gl-read-target">${esc(who)}:</div>`);
            parts.push(`<div class="gl-read-text">${esc(read)}</div>`);
            if (hist && hist.length > 1) {
                parts.push(`<div class="gl-history-toggle">History (${hist.length})</div>`);
                parts.push(`<div class="gl-history-list" style="display:none">${hist.map(historyLine).join('<br>')}</div>`);
            }
            parts.push(`</div>`);
        }
    }

    // Intimate history
    const intimate = toObj(pc.intimate_history);
    if (Object.keys(intimate).length) {
        parts.push(`<div class="gl-d-section"><b>Intimate History:</b></div>`);
        for (const [key, val] of Object.entries(intimate)) {
            parts.push(`<div class="gl-d-row"><b>${esc(key)}:</b> ${esc(val)}</div>`);
        }
    }

    // Timeline — timestamped detailed entries
    const timeline = toArr(pc.timeline);
    if (timeline.length) {
        parts.push(`<div class="gl-d-section"><b>Timeline (${timeline.length}):</b></div>`);
        const timeItems = timeline.map(t => `<div class="gl-moment">${esc(t)}</div>`);
        parts.push(collapsibleList(timeItems, 5, 'older entries'));
    }

    return parts.join('');
}

function renderCharDossier(char, state) {
    const parts = [];

    parts.push(`<div class="gl-dossier-header"><b>${esc(char.name || char.id)}</b> ${badge(char.tier)}</div>`);

    if (char.power != null) parts.push(`<div class="gl-d-row"><b>Power:</b> ${esc(String(char.power))}</div>`);
    if (char.location) parts.push(`<div class="gl-d-row"><b>Location:</b> ${esc(char.location)}</div>`);
    if (char.condition) parts.push(`<div class="gl-d-row"><b>Condition:</b> ${esc(char.condition)}</div>`);
    if (char.want) parts.push(`<div class="gl-d-row"><b>WANT:</b> ${esc(char.want)}</div>`);
    // doing now includes cost (merged field)
    if (char.doing) parts.push(`<div class="gl-d-row"><b>DOING:</b> ${esc(char.doing)}${char.cost && !char.doing.includes('Cost:') ? ` | <b>Cost:</b> ${esc(char.cost)}` : ''}</div>`);
    // Stance toward PC: prefer reads[pc], fall back to stance_toward_pc (legacy)
    const stanceTowardPc = (char.reads?.pc) || char.stance_toward_pc;
    if (stanceTowardPc) parts.push(`<div class="gl-d-row"><b>Reads PC as:</b> ${esc(stanceTowardPc)}</div>`);
    const charWounds = toObj(char.wounds);
    if (Object.keys(charWounds).length) {
        parts.push(`<div class="gl-d-row"><b>Wounds:</b> ${Object.entries(charWounds).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(', ')}</div>`);
    }

    // Shedding order
    const constraints = Object.values(state.constraints).filter(c => c.owner_id === char.id);
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

            parts.push(`<div class="gl-constraint-card">`);
            parts.push(`<div class="gl-constraint-title"><b>${esc(c.name)}</b> ${badge(c.integrity)}${integrityDesc ? ` <span class="gl-integrity-desc">— ${esc(integrityDesc)}</span>` : ''}</div>`);

            if (c.profile) {
                // New: single profile paragraph
                parts.push(`<div class="gl-d-detail">${esc(c.profile)}</div>`);
            } else {
                // Legacy: separate fields
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

    // Relationships / Reads
    const reads = toObj(char.reads);
    if (typeof char.reads === 'string') {
        parts.push(`<div class="gl-d-section"><b>Relationships:</b></div>`);
        parts.push(`<div class="gl-d-row">${esc(char.reads)}</div>`);
    } else if (Object.keys(reads).length) {
        parts.push(`<div class="gl-d-section"><b>Relationships:</b></div>`);
        for (const [target, read] of Object.entries(reads)) {
            const hist = getFieldHistory(state, 'char', char.id, `reads.${target}`);
            parts.push(`<div class="gl-read-block">`);
            parts.push(`<div class="gl-read-target">READS ${esc(target.toUpperCase())} AS:</div>`);
            parts.push(`<div class="gl-read-text">${esc(read)}</div>`);
            if (hist.length > 1) {
                parts.push(`<div class="gl-history-toggle">Read history (${hist.length})</div>`);
                parts.push(`<div class="gl-history-list" style="display:none">${hist.map(historyLine).join('<br>')}</div>`);
            }
            parts.push(`</div>`);
        }
    }

    // Intimacy stance
    if (char.intimacy_stance) {
        parts.push(`<div class="gl-d-section"><b>Intimacy Stance:</b></div>`);
        parts.push(`<div class="gl-d-row gl-intimacy-stance">${esc(char.intimacy_stance)}</div>`);
        const stanceHist = getFieldHistory(state, 'char', char.id, 'intimacy_stance');
        if (stanceHist.length > 1) {
            parts.push(`<div class="gl-history-toggle">Stance history (${stanceHist.length})</div>`);
            parts.push(`<div class="gl-history-list" style="display:none">${stanceHist.map(historyLine).join('<br>')}</div>`);
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

    // Noticed details (Chekhov's guns)
    const noticed = toArr(char.noticed_details);
    if (noticed.length) {
        parts.push(`<div class="gl-d-section"><b>Noticed Details:</b></div>`);
        for (const d of noticed) parts.push(`<div class="gl-d-row gl-noticed">- ${esc(d)}</div>`);
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

    // Constants
    const c = toObj(state.world.constants);
    if (Object.keys(c).length) {
        parts.push(`<div class="gl-d-section"><b>Constants:</b></div>`);
        for (const [k, v] of Object.entries(c)) {
            parts.push(`<div class="gl-d-row"><b>${esc(k)}:</b> ${esc(v)}</div>`);
        }
    }

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

    // Factions
    const factions = Object.values(state.factions);
    if (factions.length) {
        parts.push(`<div class="gl-d-section"><b>Factions:</b></div>`);
        for (const f of factions) {
            parts.push(`<div class="gl-d-constraint">`);
            parts.push(`<b>${esc(f.name || f.id)}</b>`);
            if (f.profile) {
                // New: single profile paragraph
                parts.push(`<div class="gl-d-detail">${esc(f.profile)}</div>`);
            } else {
                // Legacy: separate fields
                if (f.objective) parts.push(`<div class="gl-d-detail">Objective: ${esc(f.objective)}</div>`);
                if (f.resources) parts.push(`<div class="gl-d-detail">Resources: ${esc(f.resources)}</div>`);
                const fStance = (f.reads && f.reads.pc) || f.stance_toward_pc;
                if (fStance) parts.push(`<div class="gl-d-detail">Stance toward PC: ${esc(fStance)}</div>`);
                if (f.power) parts.push(`<div class="gl-d-detail">Power: <b>${esc(f.power)}</b></div>`);
                const fMomentum = f.last_move && f.momentum && !f.momentum.includes(f.last_move)
                    ? `${f.momentum}; last: ${f.last_move}` : (f.momentum || f.last_move || '');
                if (fMomentum) parts.push(`<div class="gl-d-detail">Momentum: ${esc(fMomentum)}</div>`);
                if (f.leverage) parts.push(`<div class="gl-d-detail">Leverage: ${esc(f.leverage)}</div>`);
                if (f.vulnerability) parts.push(`<div class="gl-d-detail">Vulnerability: ${esc(f.vulnerability)}</div>`);
            }
            if (f.relations && typeof f.relations === 'object') {
                const relEntries = Object.entries(f.relations);
                if (relEntries.length) {
                    parts.push(`<div class="gl-d-detail"><b>Relations:</b></div>`);
                    for (const [targetId, relation] of relEntries) {
                        parts.push(`<div class="gl-d-detail" style="padding-left:1em">↔ ${esc(targetId)}: ${esc(String(relation))}</div>`);
                    }
                }
            }
            parts.push(`</div>`);
        }
    }

    // Legacy factions in world.factions array
    const legacyFactions = toArr(state.world.factions);
    for (const f of legacyFactions) {
        if (typeof f === 'object' && f.name) {
            parts.push(`<div class="gl-d-constraint"><b>${esc(f.name)}</b>`);
            if (f.objective) parts.push(`<div class="gl-d-detail">${esc(f.objective)}</div>`);
            parts.push(`</div>`);
        } else if (typeof f === 'string') {
            parts.push(`<div class="gl-d-row">${esc(f)}</div>`);
        }
    }

    // Pressure points
    const pp = toArr(state.world.pressure_points);
    if (pp.length) {
        parts.push(`<div class="gl-d-section"><b>Pressure Points:</b></div>`);
        for (const p of pp) parts.push(`<div class="gl-d-row">- ${esc(p)}</div>`);
    }

    // Knowledge asymmetry
    const ka = toObj(state.world.knowledge_asymmetry);
    if (Object.keys(ka).length) {
        parts.push(`<div class="gl-d-section"><b>Knowledge Asymmetry:</b></div>`);
        for (const [who, knows] of Object.entries(ka)) {
            parts.push(`<div class="gl-d-row"><b>${esc(who)}:</b> ${esc(knows)}</div>`);
        }
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No world data</div>';
}

// ─── Tab 3: Collisions ──────────────────────────────────────────────────────────

function renderCollisions(state) {
    const all = Object.values(state.collisions);
    const active = all.filter(c => c.status !== 'RESOLVED');
    const resolved = all.filter(c => c.status === 'RESOLVED');

    if (all.length === 0) return '<div class="gl-empty">No collisions</div>';

    const parts = [];

    for (const col of active) {
        const forces = Array.isArray(col.forces) ? col.forces.map(f => typeof f === 'object' ? f.name || f : f).join(' vs ') : String(col.forces || '');
        const dist = col.distance != null ? Number(col.distance) : null;
        const distBar = dist != null ? renderDistanceBar(dist) : '';

        parts.push(`<div class="gl-collision-card">`);
        parts.push(`<div class="gl-collision-name">${esc(col.name || col.id)} ${badge(col.status)}</div>`);
        parts.push(`<div class="gl-d-detail">${esc(forces)}</div>`);
        if (distBar) parts.push(distBar);
        if (col.cost) parts.push(`<div class="gl-d-detail"><b>Cost:</b> ${esc(col.cost)}</div>`);

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
            parts.push(`<div class="gl-d-row gl-resolved">${esc(col.name || col.id)} — ${esc(col.cost || 'resolved')}</div>`);
        }
    }

    return parts.join('');
}

function renderDistanceBar(dist) {
    const pct = Math.max(0, Math.min(100, (dist / 10) * 100));
    const color = dist <= 3 ? '#f66' : dist <= 6 ? '#da6' : '#6a6';
    return `<div class="gl-dist-bar"><div class="gl-dist-fill" style="width:${pct}%;background:${color}"></div><span class="gl-dist-label">dist: ${dist}</span></div>`;
}

// ─── Tab 4: Arc & Chapters ──────────────────────────────────────────────────────

function renderArc(state) {
    const parts = [];
    const chapters = Object.values(state.chapters);

    // Active chapters
    const active = chapters.filter(ch => ch.status !== 'CLOSED');
    const closed = chapters.filter(ch => ch.status === 'CLOSED');

    if (active.length) {
        for (const ch of active) {
            parts.push(`<div class="gl-collision-card">`);
            if (ch.profile) {
                // New: single profile paragraph
                parts.push(`<div class="gl-collision-name">${badge(ch.status)} ${esc(ch.id)}</div>`);
                parts.push(`<div class="gl-d-detail">${esc(ch.profile)}</div>`);
            } else {
                // Legacy: separate fields
                parts.push(`<div class="gl-collision-name">Ch${ch.number || '?'}: ${esc(ch.title || ch.focus || '?')} ${badge(ch.status)}</div>`);
                if (ch.arc) parts.push(`<div class="gl-d-detail"><b>Arc:</b> ${esc(ch.arc)}</div>`);
                if (ch.central_tension) parts.push(`<div class="gl-d-detail"><b>Tension:</b> ${esc(ch.central_tension)}</div>`);
                const targets = toArr(ch.target_collisions);
                if (targets.length) parts.push(`<div class="gl-d-detail"><b>Target collisions:</b> ${targets.map(t => esc(t)).join(', ')}</div>`);
            }
            parts.push(`</div>`);
        }
    }

    if (closed.length) {
        parts.push(`<div class="gl-d-section"><b>Closed Chapters:</b></div>`);
        for (const ch of closed) {
            parts.push(`<div class="gl-d-row gl-resolved">Ch${ch.number || '?'}: ${esc(ch.title || '?')}</div>`);
        }
    }

    // Story summary
    const summary = toArr(state.story_summary);
    if (summary.length) {
        parts.push(`<div class="gl-d-section"><b>Story Summary (${summary.length}):</b></div>`);
        const sumItems = summary.map(s => {
            const text = typeof s === 'object' ? s.text : s;
            const time = typeof s === 'object' ? (s.t || s.chapter || '') : '';
            return `<div class="gl-d-row">${time ? `<span class="gl-history-time">[${esc(time)}]</span> ` : ''}${esc(text)}</div>`;
        });
        parts.push(collapsibleList(sumItems, 5, 'older entries'));
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No chapters or story data</div>';
}

// ─── Tab 5: Settings ────────────────────────────────────────────────────────────

function renderSettings(state) {
    const div = state.divination || {};
    const { chatMetadata } = SillyTavern.getContext();
    const parts = [];

    // ── Model Tier ──
    const activeTier = chatMetadata?.['gravity_model_tier'] || 'opus';
    parts.push(`<div class="gl-d-section"><b>Model:</b></div>`);
    parts.push(`<div class="gl-d-row">
        <select class="gl-div-select" id="gl-tier-select">
            <option value="opus"${activeTier === 'opus' ? ' selected' : ''}>Opus (principle-based)</option>
            <option value="sonnet"${activeTier === 'sonnet' ? ' selected' : ''}>Sonnet (example-enforced)</option>
        </select>
    </div>`);

    // ── Prose Settings ──
    parts.push(`<div class="gl-d-section"><b>Prose Settings:</b></div>`);
    parts.push(`<div class="gl-d-row" style="font-size:0.8em;color:#888;">Prose style, word count, and divination system are toggled directly in the SillyTavern prompt manager.</div>`);

    // Tense
    const activeTense = chatMetadata?.['gravity_tense'] || 'present';
    parts.push(`<div class="gl-d-row"><b>Tense:</b>
        <select class="gl-div-select" id="gl-tense-select">
            <option value="present"${activeTense === 'present' ? ' selected' : ''}>Present</option>
            <option value="past"${activeTense === 'past' ? ' selected' : ''}>Past</option>
        </select>
    </div>`);

    // Perspective
    const activePerspective = chatMetadata?.['gravity_perspective'] || 'close-third';
    parts.push(`<div class="gl-d-row"><b>Perspective:</b>
        <select class="gl-div-select" id="gl-perspective-select">
            <option value="close-third"${activePerspective === 'close-third' ? ' selected' : ''}>Close Third-Person</option>
            <option value="first"${activePerspective === 'first' ? ' selected' : ''}>First-Person</option>
            <option value="second"${activePerspective === 'second' ? ' selected' : ''}>Second-Person</option>
            <option value="omniscient"${activePerspective === 'omniscient' ? ' selected' : ''}>Omniscient</option>
        </select>
    </div>`);

    // Last draw
    if (div.last_draw) {
        parts.push(`<div class="gl-d-section"><b>Last Draw:</b></div>`);
        const ld = typeof div.last_draw === 'object' ? div.last_draw : { value: div.last_draw };
        if (ld.value) parts.push(`<div class="gl-d-row">${esc(ld.value)}</div>`);
    }

    // Reading history
    const readings = toArr(div.readings);
    if (readings.length) {
        parts.push(`<div class="gl-d-section"><b>Reading History (${readings.length}):</b></div>`);
        const readItems = readings.slice().reverse().map(r => {
            const rd = typeof r === 'object' ? r : { value: r };
            return `<div class="gl-d-row">${esc(rd.value || '?')} — ${esc(rd.reading || '')} <span class="gl-history-time">${esc(rd.t || rd.timestamp || '')}</span></div>`;
        });
        parts.push(collapsibleList(readItems, 3, 'older readings'));
    }

    return parts.join('');
}

function renderDeepSeek() {
    const { chatMetadata } = SillyTavern.getContext();
    const ds = chatMetadata?.['gravity_deepseek'] || {};
    const dsEnabled = ds.enabled === true;
    const dsApiKey = ds.apiKey || '';
    const dsModel = ds.model || 'deepseek/deepseek-chat';
    const dsModels = ds.models || [];

    const parts = [];
    parts.push(`<div class="gl-d-section" style="margin-top:0">
        <span style="font-size:0.8em;color:#888;">Opus writes prose only — a cheap OpenRouter model writes the ledger as a separate call.</span>
    </div>`);

    // Enable toggle
    parts.push(`<div class="gl-d-row" style="display:flex;align-items:center;gap:8px;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="gl-ds-enabled" ${dsEnabled ? 'checked' : ''} />
            <span>Enable ledger agent</span>
        </label>
    </div>`);

    // API key
    parts.push(`<div class="gl-d-section"><b>OpenRouter API Key</b></div>`);
    parts.push(`<div class="gl-d-row" style="display:flex;gap:6px;align-items:center;">
        <input type="password" id="gl-ds-apikey" class="gl-input-field"
            placeholder="sk-or-..." value="${esc(dsApiKey)}"
            style="flex:1;font-family:monospace;font-size:0.85em;" />
        <button class="gl-btn" id="gl-ds-key-toggle" title="Show/hide key" style="flex-shrink:0;padding:2px 8px;">
            <i class="fa-solid fa-eye"></i>
        </button>
        <button class="gl-btn" id="gl-ds-key-test" title="Test key" style="flex-shrink:0;padding:2px 8px;">
            <i class="fa-solid fa-plug"></i>
        </button>
    </div>
    <div id="gl-ds-key-status" style="font-size:0.78em;margin-top:3px;min-height:1em;"></div>`);

    // Model
    parts.push(`<div class="gl-d-section" style="display:flex;align-items:center;justify-content:space-between;">
        <b>Model</b>
        <button class="gl-btn" id="gl-ds-fetch-models" style="padding:2px 8px;font-size:0.8em;">
            <i class="fa-solid fa-rotate"></i> Fetch models
        </button>
    </div>`);

    if (dsModels.length > 0) {
        const options = dsModels.map(m =>
            `<option value="${esc(m.id)}"${m.id === dsModel ? ' selected' : ''}>${esc(m.id)}</option>`
        ).join('');
        parts.push(`<div class="gl-d-row">
            <select class="gl-div-select" id="gl-ds-model">${options}</select>
        </div>`);
    } else {
        parts.push(`<div class="gl-d-row">
            <input type="text" id="gl-ds-model" class="gl-input-field"
                placeholder="deepseek/deepseek-chat" value="${esc(dsModel)}"
                style="width:100%;font-family:monospace;font-size:0.85em;" />
            <div style="font-size:0.75em;color:#666;margin-top:4px;">Enter a model ID or click Fetch models to browse.</div>
        </div>`);
    }

    // Status of last call
    const dsStatus = chatMetadata?.['gravity_deepseek_last'] || {};
    if (dsStatus.ts) {
        const statusIcon = dsStatus.ok ? '✓' : '⚠';
        const statusText = dsStatus.ok
            ? `${dsStatus.tx ?? '?'} tx in ${dsStatus.ms ?? '?'}ms`
            : `failed — ${esc(dsStatus.err || 'unknown error')}`;
        parts.push(`<div class="gl-d-section"><b>Last call</b></div>`);
        parts.push(`<div class="gl-d-row" style="font-size:0.8em;color:#888;">${statusIcon} ${statusText} <span style="margin-left:6px;opacity:0.5;">${esc(dsStatus.ts)}</span></div>`);
    }

    return parts.join('');
}

function renderExemplars() {
    const { chatMetadata } = SillyTavern.getContext();
    const exemplars = chatMetadata?.['gravity_exemplars'] || [];
    if (exemplars.length === 0) {
        return '<div class="gl-empty">No exemplars saved. Click Good to paste prose you liked.</div>';
    }
    const parts = [];
    for (let i = 0; i < exemplars.length; i++) {
        const ex = exemplars[i];
        const text = typeof ex === 'object' ? ex.text : ex;
        const truncated = text.length > 200 ? text.substring(0, 200) + '…' : text;
        parts.push(`<div class="gl-exemplar-card" data-idx="${i}">
            <div class="gl-exemplar-text">${esc(truncated)}</div>
            <div class="gl-exemplar-actions">
                <button class="gl-exemplar-btn gl-exemplar-edit" data-idx="${i}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="gl-exemplar-btn gl-exemplar-remove" data-idx="${i}" title="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`);
    }
    parts.push(`<div class="gl-d-row" style="opacity:.5;font-size:10px;">Last ${Math.min(5, exemplars.length)} injected as style targets each turn.</div>`);
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

/**
 * Inject or update a ledger status block below the specified chat message.
 *
 * @param {number} messageId - Chat message index (0-based, matching SillyTavern's mesid attr)
 * @param {'pending'|'done'|'empty'|'failed'|'error'} status
 * @param {string|null} [summary] - Optional summary string from summarizeTransactions()
 */
function showLedgerStatus(messageId, status, summary = null) {
    // Try to find the message by mesid, fall back to last message
    let mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) {
        const all = document.querySelectorAll('#chat .mes');
        if (all.length) mesEl = all[all.length - 1];
    }
    if (!mesEl) return;

    let statusEl = mesEl.querySelector('.gl-ledger-status');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'gl-ledger-status';
        const mesText = mesEl.querySelector('.mes_text');
        if (mesText) {
            mesText.insertAdjacentElement('afterend', statusEl);
        } else {
            mesEl.appendChild(statusEl);
        }
    }

    if (status === 'pending') {
        statusEl.innerHTML = `<span class="gl-ls-icon gl-ls-spin">⟳</span><span class="gl-ls-text">Ledger updating…</span>`;
    } else if (status === 'done') {
        const detail = summary ? ` <span class="gl-ls-summary">${esc(summary)}</span>` : '';
        statusEl.innerHTML = `<span class="gl-ls-icon gl-ls-ok">✓</span><span class="gl-ls-text">Ledger</span>${detail}`;
    } else if (status === 'empty') {
        statusEl.innerHTML = `<span class="gl-ls-icon gl-ls-dim">◦</span><span class="gl-ls-text gl-ls-dim">No ledger changes</span>`;
    } else if (status === 'failed') {
        statusEl.innerHTML = `<span class="gl-ls-icon gl-ls-warn">⚠</span><span class="gl-ls-text gl-ls-warn">Ledger unavailable — will retry next turn</span>`;
    } else if (status === 'error') {
        const detail = summary ? ` <span class="gl-ls-summary gl-ls-warn">${esc(summary)}</span>` : '';
        statusEl.innerHTML = `<span class="gl-ls-icon gl-ls-warn">⚠</span><span class="gl-ls-text gl-ls-warn">Ledger errors</span>${detail}`;
    }
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

export { createPanel, updatePanel, setCallbacks, setBookName, showSetupPhase, setStaleWarning, showLedgerStatus, PANEL_ID };
