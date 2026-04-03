/**
 * challenge-mechanics.js — Generic category, threshold, and roll helpers.
 */

import {
    clone,
    normalizeText,
    coerceNumber,
    stripNarrativeForcing,
} from './challenge-shared.js';

function getCategoryAliasEntries(profile) {
    const aliases = Array.isArray(profile?.categoryAliases) ? profile.categoryAliases : [];
    return aliases
        .map(alias => {
            if (!alias || !alias.phrase || !alias.category) return null;
            return {
                phrase: normalizeText(alias.phrase),
                category: alias.category,
            };
        })
        .filter(Boolean);
}

function normalizeCategoryForProfile(value, profile) {
    const text = normalizeText(value)
        .toLowerCase()
        .replace(/[()[\]:.,!?]/g, ' ')
        .replace(/\bdifficulty\b/g, ' ')
        .replace(/\bdc\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text || !profile) return null;

    for (const cat of profile.categories || []) {
        if (cat.toLowerCase() === text) return cat;
    }

    for (const alias of getCategoryAliasEntries(profile)) {
        if (alias.phrase.toLowerCase() === text) {
            for (const cat of profile.categories || []) {
                if (cat === alias.category) return cat;
            }
        }
    }

    if (text === 'auto success' || text === 'auto-success') return profile.autoSuccess;
    if (text === 'auto fail' || text === 'auto-fail') return profile.autoFail;

    return null;
}

function extractCategoryFromText(value, profile) {
    const exact = normalizeCategoryForProfile(value, profile);
    if (exact) return exact;

    const text = normalizeText(value).toLowerCase();
    if (!text || !profile) return null;

    const candidates = [];
    for (const category of profile.categories || []) {
        candidates.push({ resolved: category, phrase: category });
    }
    for (const alias of getCategoryAliasEntries(profile)) {
        candidates.push({ resolved: alias.category, phrase: alias.phrase });
    }

    candidates.sort((a, b) => b.phrase.length - a.phrase.length);
    for (const candidate of candidates) {
        const escaped = candidate.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const pattern = new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i');
        if (pattern.test(text)) return candidate.resolved;
    }

    return null;
}

function categoryStepForProfile(category, profile) {
    if (!category || !profile) return null;
    const normalized = normalizeCategoryForProfile(category, profile);
    if (!normalized) return null;
    const idx = (profile.categories || []).indexOf(normalized);
    return idx >= 0 ? idx : null;
}

function categoryFromStepForProfile(step, profile) {
    if (!Number.isFinite(step) || !profile) return null;
    const safe = Math.max(0, Math.min((profile.categories || []).length - 1, Math.round(step)));
    return profile.categories[safe];
}

function buildDcTable(mode, profile, customDcs = null) {
    if (!profile) return {};
    const defaultTable = profile.thresholdTables[profile.defaultMode]
        ? clone(profile.thresholdTables[profile.defaultMode])
        : {};

    if (mode === 'Custom') {
        const merged = { ...defaultTable };
        for (const [rawCategory, rawValue] of Object.entries(customDcs || {})) {
            const category = normalizeCategoryForProfile(rawCategory, profile);
            const dc = coerceNumber(rawValue);
            if (!category || dc == null) continue;
            if (category === profile.autoSuccess || category === profile.autoFail) continue;
            merged[category] = dc;
        }
        return merged;
    }

    const table = profile.thresholdTables[mode];
    if (table) return clone(table);
    return defaultTable;
}

function describeDcTable(table) {
    return Object.entries(table)
        .map(([cat, dc]) => `${cat}=${dc}+`)
        .join(' | ');
}

function describeSuccessThreshold(category, dc, profile) {
    if (!profile) {
        if (dc == null) return 'no threshold';
        return `${dc}+ on d20`;
    }
    const normalized = normalizeCategoryForProfile(category, profile);
    if (!normalized) return 'no threshold';
    if (normalized === profile.autoSuccess) return 'auto-success';
    if (normalized === profile.autoFail) return 'auto-fail';
    return dc != null ? `${dc}+ on d20` : 'no threshold';
}

function summarizeDrawForMechanics(draw) {
    if (!draw) return 'NONE';
    const reading = stripNarrativeForcing(draw.reading)
        .split('\n')
        .map(part => normalizeText(part))
        .filter(Boolean)[0];
    return normalizeText(reading || draw.label || 'NONE') || 'NONE';
}

function getRollStateLabel(roll) {
    if (!roll) return 'NONE';
    if (roll.challenge_pending) return 'PENDING_REASSESSMENT';
    if (roll.skip) return roll.reason === 'absolute' ? 'AUTO_SUCCESS' : 'AUTO_FAIL';
    return 'ROLLED';
}

function buildRoll(drawFn) {
    const d20 = Math.floor(Math.random() * 20) + 1;
    return { d20, draw: clone(drawFn()) };
}

function resolveRolledOutcome(d20, dc, profile) {
    if (!Number.isFinite(d20) || !Number.isFinite(dc)) {
        return { success: null, critical: null, resolution: null };
    }
    const labels = profile?.resultLabels || {
        success: 'SUCCESS',
        fail: 'TRANSFORM',
        critSuccess: 'CRITICAL_SUCCESS',
        critFail: 'CRITICAL_TRANSFORM',
    };
    if (d20 === 20) return { success: true, critical: 'success', resolution: labels.critSuccess };
    if (d20 === 1) return { success: false, critical: 'transform', resolution: labels.critFail };
    return d20 >= dc
        ? { success: true, critical: null, resolution: labels.success }
        : { success: false, critical: null, resolution: labels.fail };
}

function buildRollPayload(category, dcTable, drawFn, profile) {
    const normalized = normalizeCategoryForProfile(category, profile);
    if (normalized === profile?.autoSuccess) {
        return { skip: true, reason: 'absolute', category: normalized };
    }
    if (normalized === profile?.autoFail) {
        return { skip: true, reason: 'impossible', category: normalized };
    }
    const base = buildRoll(drawFn);
    const dc = dcTable[normalized];
    const outcome = resolveRolledOutcome(base.d20, dc, profile);
    return {
        category: normalized,
        dc,
        d20: base.d20,
        draw: base.draw,
        success: outcome.success,
        critical: outcome.critical,
        resolution: outcome.resolution,
    };
}

function buildChallengeRoll(drawFn) {
    const base = buildRoll(drawFn);
    return {
        challenge_pending: true,
        d20: base.d20,
        draw: base.draw,
        dc: null,
        category: null,
        success: null,
        critical: base.d20 === 20 ? 'success' : base.d20 === 1 ? 'transform' : null,
        resolution: 'PENDING_REASSESSMENT',
    };
}

function formatRollSummary(roll) {
    if (!roll) return '(none)';
    if (roll.skip) {
        return `No roll — ${roll.reason === 'absolute' ? 'auto-success' : 'auto-fail'} (${roll.category})`;
    }
    const parts = [`d20 ${roll.d20}`];
    if (roll.dc != null) parts.push(`target ${roll.dc}+ on d20`);
    if (roll.category) parts.push(roll.category);
    if (roll.resolution) parts.push(roll.resolution);
    else if (roll.success != null) parts.push(roll.success ? 'SUCCESS' : 'TRANSFORM');
    if (roll.critical && !String(roll.resolution || '').startsWith('CRITICAL_')) {
        parts.push(`critical ${roll.critical}`);
    }
    if (roll.challenge_pending) parts.push('awaiting reassessment');
    return parts.join(' | ');
}

export {
    normalizeCategoryForProfile,
    extractCategoryFromText,
    categoryStepForProfile,
    categoryFromStepForProfile,
    buildDcTable,
    describeDcTable,
    describeSuccessThreshold,
    summarizeDrawForMechanics,
    getRollStateLabel,
    resolveRolledOutcome,
    buildRollPayload,
    buildChallengeRoll,
    formatRollSummary,
};
