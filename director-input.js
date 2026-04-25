// director-input.js
// Pure helper: assemble the payload sent to the director model.
// Kept separate from index.js so it's node-testable without
// importing SillyTavern globals.
//
// IMPORTANT: `mode`, `reasonMode`, and `deductionType` MUST be
// snapshots taken BEFORE onMessageReceived() resets the live
// state fields (index.js:1512-1514). Reading the live fields
// after reset would classify every advance/combat/intimacy turn
// as `regular` and produce the wrong stateView mode argument.

export function buildDirectorInput({
    snappedInjectMode, snappedReasonMode, snappedDeductionType,
    userMessage, assistantMessage, stateView,
    recentLedgerTail, pendingCorrections, recentTurns,
    lastDirectorFailed,
} = {}) {
    return {
        mode: snappedInjectMode || 'regular',
        reasonMode: snappedReasonMode || 'regular',
        deductionType: snappedDeductionType || null,
        userMessage: userMessage || '',
        assistantMessage: assistantMessage || '',
        stateView: stateView || '',
        recentLedgerTail: Array.isArray(recentLedgerTail) ? recentLedgerTail : [],
        pendingCorrections: pendingCorrections || null,
        recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
        lastDirectorFailed: !!lastDirectorFailed,
    };
}
