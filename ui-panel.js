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

const PANEL_ID = 'gravity-ledger-panel';
const TOGGLE_ID = 'gravity-ledger-toggle';

let _onExport = null;
let _onImport = null;
let _onNew = null;

function setCallbacks({ onExport, onImport, onNew }) {
    _onExport = onExport;
    _onImport = onImport;
    _onNew = onNew;
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

    // No top-level tab switching — all sections render at once

    initDrag(panel, document.getElementById('gl-drag-handle'));
    console.log('[GravityLedger] Panel created.');
}

let _lastState = null;
let _lastTurn = 0;

function renderAllSections() {
    const container = document.getElementById('gl-all-sections');
    if (!container || !_lastState) return;

    const sections = [
        { id: 'characters', icon: 'fa-users', title: 'Cast', html: renderCharacters(_lastState) },
        { id: 'world', icon: 'fa-globe', title: 'Factions & World', html: renderWorld(_lastState) },
        { id: 'collisions', icon: 'fa-burst', title: 'Collisions', html: renderCollisions(_lastState) },
        { id: 'arc', icon: 'fa-book-open', title: 'Arc & Chapters', html: renderArc(_lastState) },
        { id: 'divination', icon: 'fa-star', title: 'Divination', html: renderDivination(_lastState) },
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
}

// ─── Update Panel ───────────────────────────────────────────────────────────────

function updatePanel(state, turn) {
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

    _lastState = state;
    _lastTurn = turn;

    if (statusEl) statusEl.textContent = 'active';
    if (turnEl) turnEl.textContent = `Turn ${turn}`;
    if (txEl) txEl.textContent = `TX ${state.lastTxId ?? 0}`;

    renderAllSections();
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

    // Demonstrated traits — detailed narrative entries
    const traits = toArr(pc.demonstrated_traits);
    if (traits.length) {
        parts.push(`<div class="gl-d-section"><b>Demonstrated Traits:</b></div>`);
        for (const t of traits) {
            parts.push(`<div class="gl-trait-block">- ${esc(t)}</div>`);
        }
    }

    // Reputation — per-entity narrative blocks
    const rep = toObj(pc.reputation);
    if (Object.keys(rep).length) {
        parts.push(`<div class="gl-d-section"><b>Reputation:</b></div>`);
        for (const [who, r] of Object.entries(rep)) {
            const hist = getFieldHistory(state, 'pc', '_', `reputation.${who}`);
            parts.push(`<div class="gl-read-block">`);
            parts.push(`<div class="gl-read-target">${esc(who)}:</div>`);
            parts.push(`<div class="gl-read-text">${esc(r)}</div>`);
            if (hist.length > 1) {
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
        parts.push(`<div class="gl-d-section"><b>Timeline:</b></div>`);
        for (const t of timeline) {
            parts.push(`<div class="gl-moment">${esc(t)}</div>`);
        }
    }

    return parts.join('');
}

function renderCharDossier(char, state) {
    const parts = [];

    parts.push(`<div class="gl-dossier-header"><b>${esc(char.name || char.id)}</b> ${badge(char.tier)}</div>`);

    if (char.want) parts.push(`<div class="gl-d-row"><b>WANT:</b> ${esc(char.want)}</div>`);
    if (char.doing) parts.push(`<div class="gl-d-row"><b>DOING:</b> ${esc(char.doing)}${char.cost ? ` | <b>COST:</b> ${esc(char.cost)}` : ''}</div>`);
    if (char.stance_toward_pc) parts.push(`<div class="gl-d-row"><b>Stance toward PC:</b> ${esc(char.stance_toward_pc)}</div>`);

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

            if (c.prevents) parts.push(`<div class="gl-d-detail"><b>Prevents:</b> ${esc(c.prevents)}</div>`);
            if (c.threshold) parts.push(`<div class="gl-d-detail"><b>Threshold:</b> ${esc(c.threshold)}</div>`);
            if (c.replacement) parts.push(`<div class="gl-d-detail"><b>Replacement (if breached):</b> ${esc(c.replacement)}${c.replacement_type ? ` <i>(${esc(c.replacement_type)})</i>` : ''}</div>`);
            if (c.current_pressure) parts.push(`<div class="gl-d-pressure"><b>Current pressure:</b> ${esc(c.current_pressure)}</div>`);

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
        parts.push(`<div class="gl-d-section"><b>Key Moments:</b></div>`);
        for (const m of moments) {
            parts.push(`<div class="gl-d-row gl-moment">${esc(m)}</div>`);
        }
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
            if (f.objective) parts.push(`<div class="gl-d-detail">Objective: ${esc(f.objective)}</div>`);
            if (f.resources) parts.push(`<div class="gl-d-detail">Resources: ${esc(f.resources)}</div>`);
            if (f.stance_toward_pc) parts.push(`<div class="gl-d-detail">Stance: ${esc(f.stance_toward_pc)}</div>`);
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
            parts.push(`<div class="gl-collision-name">Ch${ch.number || '?'}: ${esc(ch.title || ch.focus || '?')} ${badge(ch.status)}</div>`);
            if (ch.arc) parts.push(`<div class="gl-d-detail"><b>Arc:</b> ${esc(ch.arc)}</div>`);
            if (ch.central_tension) parts.push(`<div class="gl-d-detail"><b>Tension:</b> ${esc(ch.central_tension)}</div>`);
            const targets = toArr(ch.target_collisions);
            if (targets.length) parts.push(`<div class="gl-d-detail"><b>Target collisions:</b> ${targets.map(t => esc(t)).join(', ')}</div>`);
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
        parts.push(`<div class="gl-d-section"><b>Story Summary:</b></div>`);
        for (const s of summary) {
            const text = typeof s === 'object' ? s.text : s;
            const time = typeof s === 'object' ? (s.t || s.chapter || '') : '';
            parts.push(`<div class="gl-d-row">${time ? `<span class="gl-history-time">[${esc(time)}]</span> ` : ''}${esc(text)}</div>`);
        }
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No chapters or story data</div>';
}

// ─── Tab 5: Divination ──────────────────────────────────────────────────────────

function renderDivination(state) {
    const div = state.divination || {};
    const parts = [];

    if (div.active_system) {
        parts.push(`<div class="gl-d-row"><b>Active System:</b> ${esc(div.active_system)}</div>`);
    } else {
        parts.push(`<div class="gl-d-row"><b>Active System:</b> Not set</div>`);
    }

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
        for (const r of readings.slice().reverse()) {
            const rd = typeof r === 'object' ? r : { value: r };
            parts.push(`<div class="gl-d-row">${esc(rd.value || '?')} — ${esc(rd.reading || '')} <span class="gl-history-time">${esc(rd.t || rd.timestamp || '')}</span></div>`);
        }
    }

    return parts.length ? parts.join('') : '<div class="gl-empty">No divination data</div>';
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

export { createPanel, updatePanel, setCallbacks, setBookName, PANEL_ID };
