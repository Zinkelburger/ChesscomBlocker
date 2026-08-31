// Pure loss-counting rules: no browser APIs, no network, no DOM.
//
// This file is the single source of truth for the counting rules. It is loaded by
//   - background.js (importScripts on Chrome / the manifest's scripts array on Firefox)
//   - options.html (as a plain <script> before options.js)
//   - the tests under test/ (via require)
// so the tests exercise exactly the code the extension runs.

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
const RESET_MODES = ['rolling', 'midnight'];
const DEFAULT_RESET_MODE = 'rolling';

const DEFAULT_MAX_GAMES = 5;

// What trips the block:
//   'losses' - N losses inside the reset window (the original behaviour)
//   'games'  - N games of any result inside the reset window
//   'rating' - the current rating of any tracked time control leaves the
//              [ratingFloor, ratingCeiling] range; no window involved
const BLOCK_MODES = ['losses', 'games', 'rating'];
const DEFAULT_BLOCK_MODE = 'losses';

// The chess.com stats endpoint keys ratings as chess_<time_class>. Only
// standard chess has per-time-control ratings there, so the rating mode
// tracks the enabled time controls of standard chess.
const RATED_TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'daily'];

const DAY_SECONDS = 86400;

// The popup stores whatever is in the number input, so treat anything that is
// not a positive whole number as "unset" rather than letting `'' >= 0` block
// the user with zero losses.
function normalizeMaxGames(value, fallback = DEFAULT_MAX_GAMES) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function normalizeBlockMode(value) {
    return BLOCK_MODES.includes(value) ? value : DEFAULT_BLOCK_MODE;
}

// A rating bound is optional: anything that is not a positive whole number
// means "no bound on this side".
function normalizeRatingBound(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

// Pull the current ratings out of a /pub/player/<name>/stats response, for
// the time controls the filters track. Returns { blitz: 1234, ... } with an
// entry only for time controls the player actually has a rating in.
function currentRatings(stats, filters = DEFAULT_FILTERS) {
    const ratings = {};
    for (const timeClass of RATED_TIME_CLASSES) {
        if (filters[timeClass] !== true) {
            continue;
        }
        const rating = stats?.[`chess_${timeClass}`]?.last?.rating;
        if (typeof rating === 'number') {
            ratings[timeClass] = rating;
        }
    }
    return ratings;
}

// A rating is out of range if it fell below the floor or rose above the
// ceiling, matching the "Falls below" / "Rises above" wording in the popup:
// the bounds themselves are still allowed. A null bound is ignored.
function ratingOutOfRange(rating, floor, ceiling) {
    return (floor !== null && rating < floor) || (ceiling !== null && rating > ceiling);
}

// The time controls whose rating has left the range, in filter order
function ratingsOutOfRange(ratings, floor, ceiling) {
    return Object.keys(ratings).filter((key) => ratingOutOfRange(ratings[key], floor, ceiling));
}

// A mode written by a newer build (or a corrupted value) falls back to the
// default so every consumer agrees on what it means.
function normalizeResetMode(value) {
    return RESET_MODES.includes(value) ? value : DEFAULT_RESET_MODE;
}

// Check if a game matches the active filters
function gameMatchesFilters(game, filters) {
    const timeClass = game.time_class || 'unknown';
    const rules = game.rules || 'chess';

    // Game must match an enabled time control AND an enabled variant
    return filters[timeClass] === true && filters[rules] === true;
}

// Start of the counting window, as a Unix timestamp in seconds.
// In 'midnight' mode the Date API resolves midnight in whatever timezone the
// computer is set to, so DST shifts and travel are handled for free.
function getWindowStart(nowMs, resetMode) {
    if (normalizeResetMode(resetMode) === 'midnight') {
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
    if (normalizeResetMode(resetMode) === 'midnight') {
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

// The chess.com API publishes games in monthly archives keyed by UTC month.
// Returns the 'YYYY/MM' archive keys, oldest first, that together cover
// everything from `windowStart` (Unix seconds) up to `nowMs`. Usually that is
// one month; just after a month boundary it is two.
function archiveMonths(windowStart, nowMs) {
    const first = new Date(windowStart * 1000);
    const last = new Date(nowMs);
    const months = [];

    let year = first.getUTCFullYear();
    let month = first.getUTCMonth();
    const lastYear = last.getUTCFullYear();
    const lastMonth = last.getUTCMonth();

    while (year < lastYear || (year === lastYear && month <= lastMonth)) {
        months.push(`${year}/${String(month + 1).padStart(2, '0')}`);
        month++;
        if (month === 12) {
            month = 0;
            year++;
        }
    }
    return months;
}

// Count the losses inside the window. Games are ordered oldest-first by the
// chess.com API, so walking backwards lets us stop at the first game that falls
// outside the window.
//
// Returns { losses, games, oldestCountedLoss, oldestCountedGame }, where the
// oldestCounted* fields are the end_time of the earliest loss / game still
// being counted (null if there are none).
function countLosses(games, username, windowStart, filters = DEFAULT_FILTERS) {
    const lowerUsername = username.toLowerCase();
    let losses = 0;
    let played = 0;
    let oldestCountedLoss = null;
    let oldestCountedGame = null;

    for (let i = games.length - 1; i >= 0; i--) {
        const game = games[i];

        // A game we cannot place in time cannot be counted, and must not stop
        // the walk either
        if (typeof game.end_time !== 'number') {
            continue;
        }
        // Stop once we walk off the start of the window
        if (game.end_time < windowStart) {
            break;
        }

        if (!gameMatchesFilters(game, filters)) {
            continue;
        }

        const playedAsWhite = game.white.username.toLowerCase() === lowerUsername;
        const playedAsBlack = game.black.username.toLowerCase() === lowerUsername;
        if (!playedAsWhite && !playedAsBlack) {
            continue;
        }
        played++;
        oldestCountedGame = game.end_time;

        const lost = (playedAsWhite && game.black.result === 'win') || (playedAsBlack && game.white.result === 'win');
        if (lost) {
            losses++;
            oldestCountedLoss = game.end_time;
        }
    }

    return { losses, games: played, oldestCountedLoss, oldestCountedGame };
}

// ============ Locally recorded games ============
//
// chess.com's public game archive can lag well behind the games it is meant to
// list - a rated game can be missing from /games/YYYY/MM for hours while the
// /stats endpoint already knows about it. Counting from the archive alone
// therefore misses exactly the games that matter: the ones just played. The
// content script records each game as it ends, and those records are counted
// alongside the archive until the archive catches up with them.

// How long a local record is kept. Long enough to cover any counting window,
// short enough that the ledger cannot grow without bound.
const LOCAL_GAME_MAX_AGE_SECONDS = 2 * DAY_SECONDS;

// A local record and an archived game this close together are the same game.
// The local time is taken when the game-over card appears, a moment after the
// end_time the API reports.
const LOCAL_PUBLISH_TOLERANCE_SECONDS = 180;

// How close a rated pool's last-game time has to be to a local record for that
// pool to be the one the game was played in
const LOCAL_CLASSIFY_TOLERANCE_SECONDS = 180;

// How long a record is given to be classified before it is written off as
// untracked. Until then it is counted, so stale stats cannot let an extra game
// through; after it, an unrated or variant game stops counting.
const LOCAL_CLASSIFY_GRACE_SECONDS = 300;

// The time control of a record that the stats endpoint could not place in any
// rated pool: an unrated game, or a variant chess.com publishes no rating for.
const UNTRACKED_TIME_CLASS = 'untracked';

// Ignore a second report of a game that ended this recently: one game end can
// reach the background script more than once (chess.com re-renders the
// game-over card, or the tab is restored).
const LOCAL_DUPLICATE_SECONDS = 15;

// The earlier of two optional Unix timestamps
function earlierTime(a, b) {
    if (typeof a !== 'number') {
        return typeof b === 'number' ? b : null;
    }
    return typeof b === 'number' ? Math.min(a, b) : a;
}

// Add the local ledger's count to the archive's, keeping the earlier of the
// two "oldest counted" times so the reset countdown still covers both.
function mergeCounts(a, b) {
    return {
        losses: a.losses + b.losses,
        games: a.games + b.games,
        oldestCountedLoss: earlierTime(a.oldestCountedLoss, b.oldestCountedLoss),
        oldestCountedGame: earlierTime(a.oldestCountedGame, b.oldestCountedGame)
    };
}

// Add a game to the ledger, unless it is a repeat of one already there
function appendLocalGame(localGames, game) {
    const known = localGames.some(
        (entry) => Math.abs(entry.endTime - game.endTime) <= LOCAL_DUPLICATE_SECONDS
    );
    return known ? localGames : [...localGames, game];
}

// Which rated pool each record was played in, as an array lining up with
// `localGames`: a time class, or null for a record no pool accounts for. Only
// standard chess has per-time-control ratings on the stats endpoint, so a
// match also means the game was standard chess.
//
// The endpoint reports one last-game time per pool, and that time names
// exactly one game - so each pool goes to the record it sits closest to, and
// no two records can claim the same one. Without that, a game chess.com
// publishes no rating for (a variant, or an unrated game) played a couple of
// minutes after a tracked one would borrow the tracked pool's timestamp and be
// counted as one of its games.
function classifyLocalGames(localGames, stats) {
    const placed = localGames.map(() => null);
    for (const timeClass of RATED_TIME_CLASSES) {
        const date = stats?.[`chess_${timeClass}`]?.last?.date;
        if (typeof date !== 'number') {
            continue;
        }
        // Which record this pool's last game was. Records that already have a
        // time class are in the running too: one that owns a pool holds on to
        // it, rather than leaving it for a later game to pick up.
        let owner = null;
        localGames.forEach((game, index) => {
            const gap = Math.abs(date - game.endTime);
            if (gap <= LOCAL_CLASSIFY_TOLERANCE_SECONDS && (owner === null || gap < owner.gap)) {
                owner = { index, gap };
            }
        });
        // A record can be the closest to two pools; it was played in the nearer
        if (owner !== null && (placed[owner.index] === null || owner.gap < placed[owner.index].gap)) {
            placed[owner.index] = { timeClass, gap: owner.gap };
        }
    }
    return placed.map((entry) => (entry === null ? null : entry.timeClass));
}

// Fill in the time control of records that do not have one yet. `stats` is
// null when the endpoint could not be reached, in which case nothing is
// decided: an unclassified record must not be written off as untracked just
// because we could not ask.
function resolveLocalGames(localGames, stats, nowSeconds) {
    if (!stats) {
        return localGames;
    }
    const placed = classifyLocalGames(localGames, stats);
    return localGames.map((game, index) => {
        if (game.timeClass) {
            return game;
        }
        if (placed[index] !== null) {
            return { ...game, timeClass: placed[index] };
        }
        if (nowSeconds - game.endTime > LOCAL_CLASSIFY_GRACE_SECONDS) {
            return { ...game, timeClass: UNTRACKED_TIME_CLASS };
        }
        return game;
    });
}

// Has the archive caught up with this record?
function localGamePublished(game, apiGames) {
    return apiGames.some((apiGame) => typeof apiGame.end_time === 'number'
        && Math.abs(apiGame.end_time - game.endTime) <= LOCAL_PUBLISH_TOLERANCE_SECONDS);
}

// Records still worth keeping: recent, well-formed, and not yet in the archive.
// Once the archive publishes a game, countLosses counts it from there and the
// record would be the same game twice.
function pruneLocalGames(localGames, apiGames, nowSeconds) {
    return localGames.filter((game) => typeof game?.endTime === 'number'
        && nowSeconds - game.endTime <= LOCAL_GAME_MAX_AGE_SECONDS
        && !localGamePublished(game, apiGames));
}

// Whether a record counts against the limit under the active filters
function localGameMatchesFilters(game, filters) {
    if (game.timeClass === UNTRACKED_TIME_CLASS) {
        return false;
    }
    // Not classified yet: count it. Over-counting for a few minutes is the
    // safe direction for a blocker, and it corrects itself as soon as either
    // the stats endpoint or the archive catches up.
    if (!game.timeClass) {
        return true;
    }
    return filters[game.timeClass] === true && filters.chess === true;
}

// True while some record still needs the stats endpoint to place it
function hasUnclassifiedLocalGames(localGames) {
    return localGames.some((game) => !game.timeClass);
}

// Count the ledger the same way countLosses counts the archive
function countLocalGames(localGames, windowStart, filters = DEFAULT_FILTERS) {
    let losses = 0;
    let played = 0;
    let oldestCountedLoss = null;
    let oldestCountedGame = null;

    for (const game of localGames) {
        if (game.endTime < windowStart || !localGameMatchesFilters(game, filters)) {
            continue;
        }
        played++;
        oldestCountedGame = earlierTime(oldestCountedGame, game.endTime);
        if (game.lost === true) {
            losses++;
            oldestCountedLoss = earlierTime(oldestCountedLoss, game.endTime);
        }
    }

    return { losses, games: played, oldestCountedLoss, oldestCountedGame };
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_FILTERS,
        RESET_MODES,
        DEFAULT_RESET_MODE,
        DEFAULT_MAX_GAMES,
        BLOCK_MODES,
        DEFAULT_BLOCK_MODE,
        RATED_TIME_CLASSES,
        DAY_SECONDS,
        normalizeMaxGames,
        normalizeResetMode,
        normalizeBlockMode,
        normalizeRatingBound,
        currentRatings,
        ratingOutOfRange,
        ratingsOutOfRange,
        gameMatchesFilters,
        getWindowStart,
        getNextReset,
        archiveMonths,
        countLosses,
        LOCAL_GAME_MAX_AGE_SECONDS,
        LOCAL_PUBLISH_TOLERANCE_SECONDS,
        LOCAL_CLASSIFY_TOLERANCE_SECONDS,
        LOCAL_CLASSIFY_GRACE_SECONDS,
        LOCAL_DUPLICATE_SECONDS,
        UNTRACKED_TIME_CLASS,
        mergeCounts,
        appendLocalGame,
        classifyLocalGames,
        resolveLocalGames,
        pruneLocalGames,
        localGameMatchesFilters,
        hasUnclassifiedLocalGames,
        countLocalGames
    };
}
