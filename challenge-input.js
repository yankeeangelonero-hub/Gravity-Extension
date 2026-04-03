/**
 * challenge-input.js — Generic challenge input and option parsing helpers.
 */

import {
    clone,
    normalizeText,
    decodeHtmlEntities,
} from './challenge-shared.js';
import {
    normalizeCategoryForProfile,
    extractCategoryFromText,
} from './challenge-mechanics.js';

function getChallengeCommandBody(rawText, profile) {
    const text = decodeHtmlEntities(rawText);
    const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^\\*?${escaped}:\\s*(.*?)\\*?$`, 'i'));
    if (!match) return null;
    return normalizeText(match[1]);
}

function parseChallengeOptionValue(value, label, profile) {
    const text = decodeHtmlEntities(value);
    const escaped = profile.optionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const withId = text.match(new RegExp(`^\\*?${escaped}:\\s*option\\s*\\|\\s*([^|]+)\\|\\s*(\\d+)\\s*\\|\\s*([^|]+)\\|\\s*(.+?)\\*?$`, 'i'));
    if (withId) {
        const category = normalizeCategoryForProfile(withId[3], profile);
        if (!category) return null;
        return {
            id: normalizeText(withId[1]),
            index: Number(withId[2]),
            category,
            intent: normalizeText(withId[4]),
            label: normalizeText(decodeHtmlEntities(label)) || normalizeText(withId[4]),
        };
    }
    const legacy = text.match(new RegExp(`^\\*?${escaped}:\\s*option\\s*\\|\\s*(\\d+)\\s*\\|\\s*([^|]+)\\|\\s*(.+?)\\*?$`, 'i'));
    if (!legacy) return null;
    const category = normalizeCategoryForProfile(legacy[2], profile);
    if (!category) return null;
    return {
        id: null,
        index: Number(legacy[1]),
        category,
        intent: normalizeText(legacy[3]),
        label: normalizeText(decodeHtmlEntities(label)) || normalizeText(legacy[3]),
    };
}

function parseChallengeCustomText(rawText, profile, options = {}) {
    const text = decodeHtmlEntities(rawText);
    const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacy = text.match(new RegExp(`^\\*?${escaped}:\\s*custom\\s*\\|\\s*([^|]+)\\|\\s*(.+?)\\*?$`, 'i'));
    if (legacy) {
        const category = normalizeCategoryForProfile(legacy[1], profile);
        if (!category) return null;
        return { category, intent: normalizeText(legacy[2]) };
    }

    const body = getChallengeCommandBody(rawText, profile)
        ?? (options.allowBare ? normalizeText(rawText) : null);
    if (body == null || !body) return null;
    const match = body.match(/^(.+?)\s+dc(?:\s*[:=-])?\s+(.+?)$/i)
        || body.match(/^(.+?)\s*\|\s*(.+?)$/i)
        || body.match(/^(.+?)\s*,\s*(.+?)$/i)
        || body.match(/^(.+?)\s+\((.+?)\)\s*$/i);
    if (!match) return null;
    const category = extractCategoryFromText(match[2], profile);
    if (!category) return null;
    return { category, intent: normalizeText(match[1]) };
}

function parseOptionIndexText(value) {
    const match = normalizeText(value).match(/^\*?option\s+(\d+)(?:[.)])?\*?$/i);
    if (!match) return null;
    return Number(match[1]);
}

function parseBareIndexText(value) {
    const match = normalizeText(value).match(/^\*?(\d+)(?:[.)])?\*?$/);
    if (!match) return null;
    return Number(match[1]);
}

function parseChallengeIndexText(rawText, profile) {
    const body = getChallengeCommandBody(rawText, profile);
    if (body == null || !body) return null;
    const match = body.match(/^(\d+)(?:[.)])?$/);
    if (!match) return null;
    return Number(match[1]);
}

function readHtmlAttribute(source, name) {
    if (!source || !name) return '';
    const match = String(source).match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return normalizeText(decodeHtmlEntities(match?.[1] || match?.[2] || match?.[3] || ''));
}

function hasHtmlClass(source, className) {
    const classes = readHtmlAttribute(source, 'class');
    if (!classes) return false;
    return classes.split(/\s+/).includes(className);
}

function parsePlainNumberedOptions(text, profile) {
    const options = [];
    const seen = new Set();
    const normalizedText = decodeHtmlEntities(String(text || ''))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    const lines = normalizedText.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = normalizeText(rawLine);
        if (!line) continue;
        const match = line.match(/^(\d+)[.)]\s*(.+?)\s*\(([^()]+)\)\s*$/);
        if (!match) continue;
        const category = normalizeCategoryForProfile(match[3], profile);
        if (!category) continue;
        const index = Number(match[1]);
        const intent = normalizeText(match[2]);
        const key = `${index}|${intent}|${category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
            id: null,
            index,
            category,
            intent,
            label: intent,
        });
    }
    return options;
}

function parseChallengeOptionsFromMessage(text, profile) {
    const options = [];
    const seen = new Set();
    const pattern = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
        const attrs = match[1] || '';
        if (!hasHtmlClass(attrs, 'act')) continue;
        const value = readHtmlAttribute(attrs, 'data-value');
        if (!value) continue;
        const parsed = parseChallengeOptionValue(value, match[2], profile);
        if (!parsed) continue;
        const key = `${parsed.id || ''}|${parsed.index}|${parsed.intent}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push(parsed);
    }
    if (!options.length) {
        options.push(...parsePlainNumberedOptions(text, profile));
    }
    return options.sort((a, b) => a.index - b.index);
}

function storeParsedOptions(runtime, options) {
    if (!options?.length) return clone(runtime);
    const nextVersion = (Number(runtime?.option_table_version) || 0) + 1;
    return {
        ...clone(runtime),
        option_table_version: nextVersion,
        options: options.map(option => ({
            ...option,
            id: option.id || `opt-e${runtime?.exchange || 1}-v${nextVersion}-${option.index}`,
            table_version: nextVersion,
        })),
    };
}

function buildInputRecord(rawText, profile, overrides = {}) {
    return {
        raw_message: normalizeText(decodeHtmlEntities(rawText)),
        explicit_prefix: new RegExp(`^\\*?${profile.inputPrefix}:`, 'i').test(String(rawText || '')),
        parsed_source: 'UNKNOWN',
        option_id: null,
        option_index: null,
        option_label: '',
        intent: '',
        declared_category: null,
        assessment_only: false,
        ...overrides,
    };
}

export {
    getChallengeCommandBody,
    parseChallengeOptionValue,
    parseChallengeCustomText,
    parseOptionIndexText,
    parseBareIndexText,
    parseChallengeIndexText,
    parseChallengeOptionsFromMessage,
    storeParsedOptions,
    buildInputRecord,
};
