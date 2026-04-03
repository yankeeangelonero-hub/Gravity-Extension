/**
 * combat-state.js — Backward-compatible facade over the challenge engine.
 *
 * This file preserves the original export surface so that ui-panel.js and
 * any other consumers continue to work during the migration to the generic
 * challenge engine. New code should import from challenge-state.js directly.
 */

import {
    CHALLENGE_RUNTIME_KEY,
    CHALLENGE_SETTINGS_KEY,
    getChallengeSettings,
    setChallengeDifficultyMode,
    setChallengeCustomDcs,
    getChallengeRuntime,
    setChallengeRuntime,
    clearChallengeRuntime,
    isChallengeRuntimeActive,
    isChallengeSessionLocked,
    startChallengeRuntime,
    getChallengeEntity,
    getActiveChallengeEntity,
    buildChallengePrompt,
    parseChallengeOptionsFromMessage,
    handleChallengeActionSelection,
    processChallengeAssistantTurn,
    formatRollSummary,
    normalizeCategoryForProfile,
    categoryStepForProfile,
    categoryFromStepForProfile,
    buildDcTable,
} from './challenge-state.js';

import { getProfile } from './challenge-profiles.js';

// ─── Legacy Constants ─────────────────────────────────────────────────────────

const RUNTIME_KEY = CHALLENGE_RUNTIME_KEY;
const SETTINGS_KEY = CHALLENGE_SETTINGS_KEY;

const combatProfile = getProfile('combat');

const CATEGORY_ORDER = combatProfile?.categories || ['Impossible', 'Highly unlikely', 'Average', 'Highly likely', 'Absolute'];
const DEFAULT_DC_TABLES = combatProfile?.thresholdTables || {};

// ─── Legacy Wrappers ──────────────────────────────────────────────────────────

function normalizeCategory(value) {
    return normalizeCategoryForProfile(value, combatProfile);
}

function categoryStep(category) {
    return categoryStepForProfile(category, combatProfile);
}

function categoryFromStep(step) {
    return categoryFromStepForProfile(step, combatProfile);
}

function buildDcTableLegacy(settings) {
    const mode = settings?.mode || combatProfile?.defaultMode || 'Cinematic';
    return buildDcTable(mode, combatProfile);
}

function getCombatSettings() {
    return getChallengeSettings('combat');
}

async function setCombatDifficultyMode(mode) {
    return setChallengeDifficultyMode('combat', mode);
}

async function setCombatCustomDcs(customDcs) {
    return setChallengeCustomDcs('combat', customDcs);
}

function getCombatRuntime() {
    return getChallengeRuntime();
}

async function setCombatRuntime(runtime) {
    return setChallengeRuntime(runtime);
}

async function clearCombatRuntime() {
    return clearChallengeRuntime();
}

function isCombatRuntimeActive() {
    return isChallengeRuntimeActive();
}

function isCombatLocked() {
    return isChallengeSessionLocked();
}

function isCombatReasonModeActive() {
    return isChallengeSessionLocked();
}

async function startCombatSetupRuntime(spawnDraw) {
    return startChallengeRuntime('combat', spawnDraw);
}

function getCombatEntity(state, runtime) {
    return getChallengeEntity(state, runtime);
}

function getActiveCombatEntity(state) {
    return getActiveChallengeEntity(state, 'combat');
}

function getCombatBaseline(state, runtime, combat) {
    const profile = getProfile('combat');
    if (!profile) return { category: 'Average', gap: null, pc_power: null, enemy_power: null, primary_enemy: null };
    const entity = combat || getChallengeEntity(state, runtime);
    return profile.getBaseline(state, entity);
}

function buildCombatPrompt(state) {
    return buildChallengePrompt(state);
}

function parseCombatOptionsFromMessage(text) {
    return parseChallengeOptionsFromMessage(text, combatProfile);
}

async function handleCombatActionSelection(rawText, state, drawFn) {
    return handleChallengeActionSelection(rawText, state, drawFn);
}

async function processCombatAssistantTurn(state, committedTxns, messageText) {
    return processChallengeAssistantTurn(state, committedTxns, messageText);
}

// ─── Exports (matching original surface) ──────────────────────────────────────

export {
    RUNTIME_KEY,
    SETTINGS_KEY,
    CATEGORY_ORDER,
    DEFAULT_DC_TABLES,
    normalizeCategory,
    categoryStep,
    categoryFromStep,
    buildDcTableLegacy as buildDcTable,
    getCombatSettings,
    setCombatDifficultyMode,
    setCombatCustomDcs,
    getCombatRuntime,
    setCombatRuntime,
    clearCombatRuntime,
    isCombatRuntimeActive,
    isCombatLocked,
    isCombatReasonModeActive,
    startCombatSetupRuntime,
    getCombatEntity,
    getActiveCombatEntity,
    getCombatBaseline,
    buildCombatPrompt,
    parseCombatOptionsFromMessage,
    handleCombatActionSelection,
    processCombatAssistantTurn,
    formatRollSummary,
};
