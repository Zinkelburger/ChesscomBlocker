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

// Count the losses inside the window. Every game is looked at: the archive
// comes back oldest-first in practice, but chess.com does not promise that,
// and the archives are small once slimmed, so nothing is gained by stopping
// early and a game out of order would be silently dropped.
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

    for (const game of games) {
        // A game we cannot place in time cannot be counted
        if (typeof game.end_time !== 'number' || game.end_time < windowStart) {
            continue;
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
        oldestCountedGame = earlierTime(oldestCountedGame, game.end_time);

        const lost = (playedAsWhite && game.black.result === 'win') || (playedAsBlack && game.white.result === 'win');
        if (lost) {
            losses++;
            oldestCountedLoss = earlierTime(oldestCountedLoss, game.end_time);
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

// How many rated games the stats endpoint has on record per tracked pool:
// { bullet: 20414, blitz: 45466, ... }, with an entry only for pools the
// player has a record in. Two of these, taken at different times, say how
// many rated games each pool gained in between - which is what places a
// game the last-game time alone cannot (see classifyLocalGames).
function poolTotals(stats) {
    const totals = {};
    for (const timeClass of RATED_TIME_CLASSES) {
        const record = stats?.[`chess_${timeClass}`]?.record;
        if (!record || typeof record !== 'object') {
            continue;
        }
        const total = [record.win, record.loss, record.draw]
            .reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
        totals[timeClass] = total;
    }
    return totals;
}

// Which rated pool each record was played in, as an array lining up with
// `localGames`: a time class, or null for a record no pool accounts for. Only
// standard chess has per-time-control ratings on the stats endpoint, so a
// match also means the game was standard chess.
//
// Two things in the stats response place a game:
//
// 1. Each pool's last-game time. It names exactly one game, so it goes to the
//    record nearest to it and no other. Without that, a game chess.com
//    publishes no rating for (a variant, or an unrated game) played a couple
//    of minutes after a tracked one would borrow the tracked pool's timestamp
//    and be counted as one of its games.
//
// 2. Each pool's game total, compared with the total seen at the previous
//    check (`previousTotals`). The last-game time can only ever place the most
//    recent game in a pool: two bullet games in a row, with the first still
//    unplaced when the second ends (the stats endpoint lags a moment, or a
//    check did not fall between them), would leave the first with no pool to
//    claim it. The totals say how many games the pool gained since the last
//    look. Games the last-game time already placed are subtracted; whatever
//    is left over goes to the still-unplaced records, newest first, since a
//    session tends to stick to one time control and the newest records sit
//    nearest the pool's last game. When more than one pool gained games, the
//    most recently active pool is served first.
//
// A game played elsewhere (chess.com's app, say) moves the totals too, so a
// leftover can land on a record that was really unrated or a variant. That
// over-counts until the archive publishes the record, at which point it is
// dropped and the archive counts it under its true rules - the safe way to be
// wrong for a blocker, and one that corrects itself.
function classifyLocalGames(localGames, stats, previousTotals = null) {
    const placed = localGames.map(() => null);
    const lastDates = {};
    for (const timeClass of RATED_TIME_CLASSES) {
        const date = stats?.[`chess_${timeClass}`]?.last?.date;
        if (typeof date !== 'number') {
            continue;
        }
        lastDates[timeClass] = date;
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
    const byLastDate = placed.map((entry) => (entry === null ? null : entry.timeClass));

    if (!previousTotals || typeof previousTotals !== 'object') {
        return byLastDate;
    }

    // Games each pool gained since the previous look, less the ones the
    // last-game time has just placed (a record that already had its time class
    // was counted at an earlier check, when the totals last moved for it)
    const totals = poolTotals(stats);
    const spare = {};
    for (const timeClass of Object.keys(totals)) {
        if (typeof previousTotals[timeClass] !== 'number') {
            continue;
        }
        const justPlaced = localGames.filter(
            (game, index) => !game.timeClass && byLastDate[index] === timeClass
        ).length;
        spare[timeClass] = Math.max(totals[timeClass] - previousTotals[timeClass] - justPlaced, 0);
    }

    // Unplaced records, newest first
    const candidates = localGames
        .map((game, index) => ({ game, index }))
        .filter(({ game, index }) => !game.timeClass && byLastDate[index] === null)
        .sort((a, b) => b.game.endTime - a.game.endTime);
    // Pools with games to give away, most recently active first
    const pools = Object.keys(spare)
        .filter((timeClass) => spare[timeClass] > 0)
        .sort((a, b) => (lastDates[b] ?? 0) - (lastDates[a] ?? 0));

    const result = [...byLastDate];
    for (const timeClass of pools) {
        for (let n = 0; n < spare[timeClass] && candidates.length > 0; n++) {
            result[candidates.shift().index] = timeClass;
        }
    }
    return result;
}

// Fill in the time control of records that do not have one yet. `stats` is
// null when the endpoint could not be reached, in which case nothing is
// decided: an unclassified record must not be written off as untracked just
// because we could not ask. `previousTotals` is what poolTotals gave for the
// stats seen at the previous check, or null if there was none.
function resolveLocalGames(localGames, stats, nowSeconds, previousTotals = null) {
    if (!stats) {
        return localGames;
    }
    const placed = classifyLocalGames(localGames, stats, previousTotals);
    return localGames.map((game, index) => {
        if (game.timeClass) {
            return game;
        }
        if (placed[index] !== null) {
            return { ...game, timeClass: placed[index] };
        }
        // `>=`: the alarm that brings a check here fires at the deadline
        // itself, and "now" is rounded to the second
        if (nowSeconds - game.endTime >= LOCAL_CLASSIFY_GRACE_SECONDS) {
            return { ...game, timeClass: UNTRACKED_TIME_CLASS };
        }
        return game;
    });
}

// The records the archive has caught up with, as a set of indices into
// `localGames`. Each archived game accounts for one record and one only, the
// nearest in time: two bullet games end within the tolerance of each other,
// and when the archive publishes the first, the second must not be dropped
// along with it - it would go uncounted until the archive published it too.
function publishedRecords(localGames, apiGames) {
    const pairs = [];
    localGames.forEach((game, index) => {
        apiGames.forEach((apiGame, apiIndex) => {
            if (typeof apiGame.end_time !== 'number') {
                return;
            }
            const gap = Math.abs(apiGame.end_time - game.endTime);
            if (gap <= LOCAL_PUBLISH_TOLERANCE_SECONDS) {
                pairs.push({ index, apiIndex, gap });
            }
        });
    });
    pairs.sort((a, b) => a.gap - b.gap);

    const published = new Set();
    const taken = new Set();
    for (const { index, apiIndex, gap } of pairs) {
        if (!published.has(index) && !taken.has(apiIndex)) {
            published.add(index);
            taken.add(apiIndex);
        }
    }
    return published;
}

// Records still worth keeping: recent, well-formed, and not yet in the archive.
// Once the archive publishes a game, countLosses counts it from there and the
// record would be the same game twice.
function pruneLocalGames(localGames, apiGames, nowSeconds) {
    const recent = localGames.filter((game) => typeof game?.endTime === 'number'
        && nowSeconds - game.endTime <= LOCAL_GAME_MAX_AGE_SECONDS);
    const published = publishedRecords(recent, apiGames);
    return recent.filter((game, index) => !published.has(index));
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

// ============ The verdict ============
//
// Everything a check decides once the counting is done, kept apart from the
// fetching and the storage so it can be tested: whether the limit is hit,
// whether chess.com is blocked right now, and when to wake up next.

// How long to wait before trying again when the API could not be reached
const RETRY_DELAY_MS = 5 * 60000;

// Rating mode has no reset window, so it re-checks on this interval instead
const RATING_POLL_MS = 15 * 60000;

// Earliest of the given times, ignoring nulls; null if there are none
function earliest(...times) {
    const valid = times.filter((time) => typeof time === 'number');
    return valid.length ? Math.min(...valid) : null;
}

// A time that has not arrived yet, or null. Waking up for one that has already
// passed is not a wake-up at all: the alarm can only be clamped to a moment
// from now, and the check that follows re-arms it just the same. That matters
// during an API outage, where the reset carried over from the last good count
// ages out and would otherwise turn a five-minute retry into a wake-up a
// minute for as long as the outage lasts.
function upcoming(time, nowMs) {
    return typeof time === 'number' && time > nowMs ? time : null;
}

// Whether a count trips the limit, for the two counting modes. Rating mode
// has no count and is decided from the stats endpoint instead.
function outOfCountingRange(blockMode, counted, maxGames) {
    if (blockMode === 'losses') {
        return counted.losses >= maxGames;
    }
    if (blockMode === 'games') {
        return counted.games >= maxGames;
    }
    return false;
}

// When the next unclassified record's grace period runs out, in local
// milliseconds, or null. A record the stats endpoint has not placed yet counts
// provisionally and is written off once its grace runs out - but only a check
// does the writing off, so one has to run at that moment, or a provisional
// block from an unrated or variant game would outlive its five minutes by the
// rest of the window. Record times are on chess.com's clock (see
// recordGameOver in background.js), so the skew is taken back out, and a
// second is added so the check lands past the deadline, not on it.
function classifyDeadline(localGames, clockSkewMs) {
    return earliest(...localGames
        .filter((game) => !game.timeClass)
        .map((game) => (game.endTime + LOCAL_CLASSIFY_GRACE_SECONDS + 1) * 1000 - clockSkewMs));
}

// The decision. Takes what the check gathered and returns what to store and
// when to wake up:
//   limitHit   whether the counter (or the rating range) is tripping the block
//   nextReset  when the counter next changes on its own, for the popup
//   ratings    the current ratings, or null to leave the stored ones alone
//   blocked    whether the play pages are blocked right now
//   wakeAt     when the next check should run on its own, or null
function decideBlock({
    nowMs, blockMode, maxGames, resetMode, filters, ratingFloor, ratingCeiling,
    counted, outage, stats, lastLimitHit, localGames, clockSkewMs,
    paused, hourBlockUntil, hourBlockPendingUntil
}) {
    // The window only matters for the counting modes; in rating mode there is
    // nothing to reset, so no alarm is needed for it either
    let limitHit = outOfCountingRange(blockMode, counted, maxGames);
    let nextReset = null;
    // Only rating mode fetches ratings to compare, so the other modes leave the
    // last known ones in place rather than blanking the popup's rating list
    let ratings = null;
    if (blockMode === 'losses') {
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedLoss);
    } else if (blockMode === 'games') {
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedGame);
    } else if (!stats) {
        // Rating mode with no ratings to compare: hold the last verdict
        limitHit = lastLimitHit === true;
    } else {
        ratings = currentRatings(stats, filters);
        limitHit = ratingsOutOfRange(ratings, ratingFloor, ratingCeiling).length > 0;
    }

    const blocked = !paused && (limitHit || hourBlockUntil !== null || hourBlockPendingUntil !== null);

    // Rating mode has no window to reset, so nothing else would ever re-arm
    // the alarm: once a bound is crossed the block would have to be lifted by
    // opening a chess.com game page, which is exactly what is blocked. Poll
    // instead, so a rating that moves back into range clears the block.
    const ratingPoll = blockMode === 'rating' ? nowMs + RATING_POLL_MS : null;
    // A consumed alarm would otherwise leave a block from stale data with
    // nothing to lift it, so an outage always leaves a retry armed
    const retry = outage || (blockMode === 'rating' && !stats) ? nowMs + RETRY_DELAY_MS : null;
    const wakeAt = earliest(
        upcoming(nextReset, nowMs),
        upcoming(hourBlockUntil, nowMs),
        ratingPoll,
        retry,
        upcoming(classifyDeadline(localGames, clockSkewMs), nowMs),
        // A pending 1-hour block expires too, and needs a check to notice
        // when no chess.com page is open to convert it
        hourBlockPendingUntil
    );

    return { limitHit, nextReset, ratings, blocked, wakeAt };
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
        poolTotals,
        classifyLocalGames,
        resolveLocalGames,
        publishedRecords,
        pruneLocalGames,
        localGameMatchesFilters,
        hasUnclassifiedLocalGames,
        countLocalGames,
        RETRY_DELAY_MS,
        RATING_POLL_MS,
        earliest,
        upcoming,
        outOfCountingRange,
        classifyDeadline,
        decideBlock
    };
}
