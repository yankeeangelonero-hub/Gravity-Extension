/**
 * challenge-shared.js — Generic shared helpers for the challenge engine.
 */

function clone(value) {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function toList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value)
        .split(',')
        .map(part => normalizeText(part))
        .filter(Boolean);
}

function coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripNarrativeForcing(reading) {
    const text = String(reading || '').replace(/\r\n/g, '\n');
    const marker = 'NARRATIVE FORCING:';
    const idx = text.indexOf(marker);
    return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

function formatDrawBlock(draw, options = {}) {
    if (!draw) return '(none)';
    const reading = options.stripNarrativeForcing
        ? stripNarrativeForcing(draw.reading)
        : String(draw.reading || '');
    const lines = [`${draw.label}: ${reading}`];
    if (options.guidance) lines.push(options.guidance);
    if (options.includeHtml !== false && draw.html) {
        lines.push(`Render this HTML card reveal before prose when appropriate:\n${draw.html}`);
    }
    return lines.join('\n');
}

function boolText(value) {
    return value ? 'true' : 'false';
}

function mechanicsValue(value) {
    if (value == null || value === '') return 'NONE';
    return String(value).replace(/\s+/g, ' ').trim();
}

export {
    clone,
    normalizeText,
    toList,
    coerceNumber,
    decodeHtmlEntities,
    stripNarrativeForcing,
    formatDrawBlock,
    boolText,
    mechanicsValue,
};
