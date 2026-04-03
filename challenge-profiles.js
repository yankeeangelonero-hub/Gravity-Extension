/**
 * challenge-profiles.js — Profile registry for the challenge engine.
 *
 * Registers all challenge profiles and provides lookup by kind or input prefix.
 */

import combatProfile from './challenge-profile-combat.js';

const PROFILES = Object.freeze({
    combat: combatProfile,
});

function getProfile(kind) {
    return PROFILES[kind] || null;
}

function getProfileByPrefix(prefix) {
    if (!prefix) return null;
    const lower = prefix.toLowerCase();
    return Object.values(PROFILES).find(p => p.inputPrefix.toLowerCase() === lower) || null;
}

function detectChallengePrefix(rawText) {
    const text = String(rawText || '').replace(/^\*/, '');
    for (const profile of Object.values(PROFILES)) {
        const escaped = profile.inputPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^${escaped}:`, 'i').test(text)) {
            return profile;
        }
    }
    return null;
}

function listProfiles() {
    return Object.keys(PROFILES);
}

export {
    getProfile,
    getProfileByPrefix,
    detectChallengePrefix,
    listProfiles,
};
