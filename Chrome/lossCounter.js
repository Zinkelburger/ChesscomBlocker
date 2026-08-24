// Shared loss-counting logic.
//
// This file is the single source of truth for the counting rules. It is loaded by:
//   - background.js (via importScripts on Chrome / the scripts array on Firefox)
//   - options.html (as a plain <script> before options.js)
//   - test/background.test.js (via require)
// so the tests exercise the same code the extension runs.

// Default filters - standard time controls, standard chess
const DEFAULT_FILTERS = {
    // Time controls
    bullet: true,
    blitz: true,
    rapid: true,
    daily: false,
    // Variants
    chess: true,
    chess960: false,
    bughouse: false,
    crazyhouse: false,
    threecheck: false,
    kingofthehill: false
};

// How the loss counter clears itself:
//   'rolling'  - a moving window covering the last 24 hours (the original behaviour)
//   'midnight' - the current calendar day, in the computer's local timezone
const DEFAULT_RESET_MODE = 'rolling';

const DAY_SECONDS = 86400;

// Check if a game matches the active filters
function gameMatchesFilters(game, filters) {
    const timeClass = game.time_class || 'unknown';
    const rules = game.rules || 'chess';

    // Game must match an enabled time control AND an enabled variant
    const timeEnabled = filters[timeClass] === true;
    const rulesEnabled = filters[rules] === true;

    return timeEnabled && rulesEnabled;
}

// Start of the counting window, as a Unix timestamp in seconds.
// In 'midnight' mode the Date API resolves midnight in whatever timezone the
// computer is set to, so DST shifts and travel are handled for free.
function getWindowStart(nowMs, resetMode) {
    if (resetMode === 'midnight') {
        const midnight = new Date(nowMs);
        midnight.setHours(0, 0, 0, 0);
        return Math.floor(midnight.getTime() / 1000);
    }
    return Math.round(nowMs / 1000) - DAY_SECONDS;
}

// When the counter will next change on its own, in milliseconds, or null if
// nothing is due to expire. Used to schedule a re-check so a block lifts by
// itself, and to show a countdown in the popup.
function getNextReset(nowMs, resetMode, oldestCountedLoss) {
    if (resetMode === 'midnight') {
        // setHours(24, ...) rolls over to the next day, DST included
        const nextMidnight = new Date(nowMs);
        nextMidnight.setHours(24, 0, 0, 0);
        return nextMidnight.getTime();
    }
    if (typeof oldestCountedLoss !== 'number') {
        return null;
    }
    // The window clears one second after the oldest counted loss ages out
    return (oldestCountedLoss + DAY_SECONDS + 1) * 1000;
}

// Count the losses inside the window. Games are ordered oldest-first by the
// chess.com API, so walking backwards lets us stop at the first game that falls
// outside the window.
//
// Returns { losses, oldestCountedLoss }, where oldestCountedLoss is the
// end_time of the earliest loss still being counted (null if there are none).
function countLosses(games, username, windowStart, filters = DEFAULT_FILTERS) {
    const lowerUsername = username.toLowerCase();
    let losses = 0;
    let oldestCountedLoss = null;

    for (let i = games.length - 1; i >= 0; i--) {
        const game = games[i];

        // Stop once we walk off the start of the window
        if (game.end_time < windowStart) {
            break;
        }

        // Only count games that match the filters
        if (!gameMatchesFilters(game, filters)) {
            continue;
        }

        if (game.white.username.toLowerCase() === lowerUsername && game.black.result === 'win') {
            losses++;
            oldestCountedLoss = game.end_time;
        } else if (game.black.username.toLowerCase() === lowerUsername && game.white.result === 'win') {
            losses++;
            oldestCountedLoss = game.end_time;
        }
    }

    return { losses, oldestCountedLoss };
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_FILTERS,
        DEFAULT_RESET_MODE,
        DAY_SECONDS,
        gameMatchesFilters,
        getWindowStart,
        getNextReset,
        countLosses
    };
}
