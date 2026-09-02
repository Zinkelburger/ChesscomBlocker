// Tests for the pure loss-counting rules in src/lossCounter.js
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    DEFAULT_FILTERS,
    DEFAULT_RESET_MODE,
    DEFAULT_MAX_GAMES,
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
    countLosses
} = require('../src/lossCounter.js');

// Load mock data
const mockData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-games-response.json'), 'utf8')
);

// The tests below were written against a countLosses that returned a plain
// number; unwrap the result so they stay readable.
function lossesIn(games, username, windowStart, filters = DEFAULT_FILTERS) {
    return countLosses(games, username, windowStart, filters).losses;
}

// Convenience: the rolling window that ends at `currentTime` (Unix seconds)
function rollingWindow(currentTime) {
    return getWindowStart(currentTime * 1000, 'rolling');
}

test('mock data has expected number of games', () => {
    assert.strictEqual(mockData.games.length, 5, 'Expected 5 games in mock data');
});

test('all games are within expected time range', () => {
    // All games should have end_time values
    for (const game of mockData.games) {
        assert.ok(game.end_time, 'Game should have end_time');
        assert.ok(typeof game.end_time === 'number', 'end_time should be a number');
    }
});

test('correctly identifies BigManArkhangelsk losses', () => {
    // Use a time that makes all games "within 24 hours"
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100; // Just after most recent game
    
    const losses = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime));
    
    // From our mock data:
    // Game 1: Black wins (BigManArkhangelsk) - NOT a loss
    // Game 2: White wins (Nelson2021a), Black is BigManArkhangelsk - LOSS
    // Game 3: Black wins (Roi-Reveur), White is BigManArkhangelsk - LOSS  
    // Game 4: White wins (BigManArkhangelsk) - NOT a loss
    // Game 5: White wins (Bobby_Luna), Black is BigManArkhangelsk - LOSS
    assert.strictEqual(losses, 3, `Expected 3 losses, got ${losses}`);
});

test('username matching is case-insensitive', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    const losses1 = lossesIn(mockData.games, 'bigmanarkhangelsk', rollingWindow(currentTime));
    const losses2 = lossesIn(mockData.games, 'BIGMANARKHANGELSK', rollingWindow(currentTime));
    const losses3 = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime));
    
    assert.strictEqual(losses1, losses2, 'Lowercase should match');
    assert.strictEqual(losses2, losses3, 'Mixed case should match');
});

test('games older than 24 hours are not counted', () => {
    // Set current time to more than 24 hours after the most recent game
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 86401; // 24 hours + 1 second after last game
    
    const losses = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime));
    
    // All games should now be outside the 24-hour window
    assert.strictEqual(losses, 0, 'Should have 0 losses when all games are older than 24h');
});

test('partial 24-hour window counts correctly', () => {
    // Set time to just after game 3, making games 4 and 5 "in the future" (not counted)
    // But actually the algorithm stops at > 24h, so let's test differently
    
    // Set time to make only the last 2 games within 24 hours
    const game3 = mockData.games[2];
    const game4 = mockData.games[3];
    
    // Time that puts game 3 outside 24h but game 4 and 5 inside
    const currentTime = game3.end_time + 86401;
    
    // Only games 4 and 5 should be in window
    // Game 4: White wins (BigManArkhangelsk) - NOT a loss
    // Game 5: White wins (Bobby_Luna), Black is BigManArkhangelsk - LOSS
    const losses = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime));
    assert.strictEqual(losses, 1, `Expected 1 loss in partial window, got ${losses}`);
});

test('returns 0 losses for empty games array', () => {
    const losses = lossesIn([], 'BigManArkhangelsk', rollingWindow(Math.round(Date.now() / 1000)));
    assert.strictEqual(losses, 0, 'Empty games should have 0 losses');
});

test('returns 0 losses for unknown user', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    const losses = lossesIn(mockData.games, 'unknownuser12345', rollingWindow(currentTime));
    assert.strictEqual(losses, 0, 'Unknown user should have 0 losses');
});

// ============ Filters ============

test('gameMatchesFilters correctly matches blitz chess', () => {
    const game = { time_class: 'blitz', rules: 'chess' };
    assert.strictEqual(gameMatchesFilters(game, DEFAULT_FILTERS), true);
});

test('gameMatchesFilters rejects daily games by default', () => {
    const game = { time_class: 'daily', rules: 'chess' };
    assert.strictEqual(gameMatchesFilters(game, DEFAULT_FILTERS), false);
});

test('gameMatchesFilters rejects chess960 by default', () => {
    const game = { time_class: 'blitz', rules: 'chess960' };
    assert.strictEqual(gameMatchesFilters(game, DEFAULT_FILTERS), false);
});

test('gameMatchesFilters works with custom filters', () => {
    const customFilters = { ...DEFAULT_FILTERS, daily: true, chess960: true };
    
    const dailyGame = { time_class: 'daily', rules: 'chess' };
    const chess960Game = { time_class: 'blitz', rules: 'chess960' };
    
    assert.strictEqual(gameMatchesFilters(dailyGame, customFilters), true);
    assert.strictEqual(gameMatchesFilters(chess960Game, customFilters), true);
});

test('gameMatchesFilters requires BOTH time and rules to match', () => {
    // Enable daily but not chess960
    const filters = { ...DEFAULT_FILTERS, daily: true };
    
    // Daily chess960 should NOT match because chess960 is disabled
    const game = { time_class: 'daily', rules: 'chess960' };
    assert.strictEqual(gameMatchesFilters(game, filters), false);
});

test('countLosses respects filters', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    // All mock games are blitz chess, so disabling blitz should yield 0 losses
    const noBlitzFilters = { ...DEFAULT_FILTERS, blitz: false };
    const losses = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime), noBlitzFilters);
    assert.strictEqual(losses, 0, 'Disabling blitz should exclude all blitz games');
});

test('countLosses with all filters enabled counts all losses', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    // With default filters (blitz + chess enabled), should get 3 losses
    const losses = lossesIn(mockData.games, 'BigManArkhangelsk', rollingWindow(currentTime), DEFAULT_FILTERS);
    assert.strictEqual(losses, 3, 'Default filters should count all blitz chess losses');
});

// ============ Reset modes ============
//
// These build Date objects with the local-time constructor, so they assert the
// same thing no matter what timezone the machine running them is set to.

const seconds = (date) => Math.floor(date.getTime() / 1000);

// A finished blitz game that `username` lost
function lostGameAt(date, username = 'me') {
    return {
        end_time: seconds(date),
        time_class: 'blitz',
        rules: 'chess',
        white: { username: 'opponent', result: 'win' },
        black: { username, result: 'checkmated' }
    };
}

test('default reset mode is the original rolling window', () => {
    assert.strictEqual(DEFAULT_RESET_MODE, 'rolling');
});

test('midnight window starts at local midnight of the same day', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const expected = seconds(new Date(2024, 4, 15, 0, 0, 0, 0));

    assert.strictEqual(getWindowStart(now.getTime(), 'midnight'), expected);
});

test('midnight window start is midnight even just before midnight', () => {
    const now = new Date(2024, 4, 15, 23, 59, 59, 0);
    const expected = seconds(new Date(2024, 4, 15, 0, 0, 0, 0));

    assert.strictEqual(getWindowStart(now.getTime(), 'midnight'), expected);
});

test('rolling window start is exactly 24 hours back', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const expected = seconds(now) - DAY_SECONDS;

    assert.strictEqual(getWindowStart(now.getTime(), 'rolling'), expected);
});

test('midnight mode drops yesterday evening, rolling mode keeps it', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const games = [
        lostGameAt(new Date(2024, 4, 14, 23, 30, 0, 0)),
        lostGameAt(new Date(2024, 4, 15, 0, 30, 0, 0)),
        lostGameAt(new Date(2024, 4, 15, 9, 0, 0, 0))
    ];

    const midnight = countLosses(games, 'me', getWindowStart(now.getTime(), 'midnight'));
    const rolling = countLosses(games, 'me', getWindowStart(now.getTime(), 'rolling'));

    assert.strictEqual(midnight.losses, 2, 'midnight mode counts only today');
    assert.strictEqual(rolling.losses, 3, 'rolling mode still reaches back into yesterday');
});

test('a game exactly on the window boundary is counted', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const windowStart = getWindowStart(now.getTime(), 'rolling');
    const onBoundary = [{
        end_time: windowStart,
        time_class: 'blitz',
        rules: 'chess',
        white: { username: 'opponent', result: 'win' },
        black: { username: 'me', result: 'checkmated' }
    }];

    assert.strictEqual(countLosses(onBoundary, 'me', windowStart).losses, 1);
});

test('a game one second before the window is not counted', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const windowStart = getWindowStart(now.getTime(), 'rolling');
    const justOutside = [{
        end_time: windowStart - 1,
        time_class: 'blitz',
        rules: 'chess',
        white: { username: 'opponent', result: 'win' },
        black: { username: 'me', result: 'checkmated' }
    }];

    assert.strictEqual(countLosses(justOutside, 'me', windowStart).losses, 0);
});

test('countLosses reports the oldest loss still inside the window', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const oldest = new Date(2024, 4, 15, 0, 30, 0, 0);
    const games = [
        lostGameAt(new Date(2024, 4, 14, 23, 30, 0, 0)),
        lostGameAt(oldest),
        lostGameAt(new Date(2024, 4, 15, 9, 0, 0, 0))
    ];

    const result = countLosses(games, 'me', getWindowStart(now.getTime(), 'midnight'));
    assert.strictEqual(result.oldestCountedLoss, seconds(oldest));
});

test('oldestCountedLoss is null when nothing is counted', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const games = [lostGameAt(new Date(2024, 4, 14, 23, 30, 0, 0))];

    const result = countLosses(games, 'me', getWindowStart(now.getTime(), 'midnight'));
    assert.strictEqual(result.oldestCountedLoss, null);
});

test('next reset in midnight mode is the upcoming local midnight', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const expected = new Date(2024, 4, 16, 0, 0, 0, 0).getTime();

    assert.strictEqual(getNextReset(now.getTime(), 'midnight', null), expected);
});

test('next reset in midnight mode ignores the oldest loss', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const oldest = seconds(new Date(2024, 4, 15, 0, 30, 0, 0));
    const expected = new Date(2024, 4, 16, 0, 0, 0, 0).getTime();

    assert.strictEqual(getNextReset(now.getTime(), 'midnight', oldest), expected);
});

test('next reset in rolling mode is when the oldest loss ages out', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const oldest = seconds(new Date(2024, 4, 15, 0, 30, 0, 0));

    assert.strictEqual(
        getNextReset(now.getTime(), 'rolling', oldest),
        (oldest + DAY_SECONDS + 1) * 1000
    );
});

test('next reset in rolling mode is null with no counted losses', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);

    assert.strictEqual(getNextReset(now.getTime(), 'rolling', null), null);
});

test('midnight mode still respects game filters', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const dailyLoss = lostGameAt(new Date(2024, 4, 15, 9, 0, 0, 0));
    dailyLoss.time_class = 'daily';

    const windowStart = getWindowStart(now.getTime(), 'midnight');
    assert.strictEqual(countLosses([dailyLoss], 'me', windowStart).losses, 0,
        'daily is off by default');
    assert.strictEqual(
        countLosses([dailyLoss], 'me', windowStart, { ...DEFAULT_FILTERS, daily: true }).losses, 1,
        'counted once daily is enabled');
});

test('a game with no end_time is skipped without ending the walk', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const windowStart = getWindowStart(now.getTime(), 'midnight');
    const broken = lostGameAt(new Date(2024, 4, 15, 9, 0, 0, 0));
    delete broken.end_time;
    const games = [
        lostGameAt(new Date(2024, 4, 15, 1, 0, 0, 0)),
        broken,
        lostGameAt(new Date(2024, 4, 15, 9, 30, 0, 0))
    ];

    const result = countLosses(games, 'me', windowStart);
    assert.strictEqual(result.losses, 2);
    assert.strictEqual(result.oldestCountedLoss, seconds(new Date(2024, 4, 15, 1, 0, 0, 0)));
});

// ============ Settings normalisation ============

test('normalizeMaxGames accepts positive whole numbers, as numbers or strings', () => {
    assert.strictEqual(normalizeMaxGames(3), 3);
    assert.strictEqual(normalizeMaxGames('3'), 3);
    assert.strictEqual(normalizeMaxGames(' 12 '), 12);
});

test('normalizeMaxGames falls back for an empty field, zero, negatives and junk', () => {
    for (const bad of ['', '0', 0, -1, 'abc', null, undefined, NaN, '1.5x']) {
        assert.strictEqual(normalizeMaxGames(bad), DEFAULT_MAX_GAMES, `input: ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(normalizeMaxGames('', 7), 7, 'custom fallback');
});

test('normalizeResetMode keeps known modes and defaults the rest', () => {
    assert.strictEqual(normalizeResetMode('rolling'), 'rolling');
    assert.strictEqual(normalizeResetMode('midnight'), 'midnight');
    assert.strictEqual(normalizeResetMode('weekly'), DEFAULT_RESET_MODE);
    assert.strictEqual(normalizeResetMode(undefined), DEFAULT_RESET_MODE);
});

test('unknown reset mode behaves like rolling everywhere', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0).getTime();
    assert.strictEqual(getWindowStart(now, 'weekly'), getWindowStart(now, 'rolling'));
    assert.strictEqual(getNextReset(now, 'weekly', null), null);
});

// ============ Monthly archives ============
//
// chess.com archives are keyed by UTC month, so these use Date.UTC.

test('a window inside one month needs one archive', () => {
    const now = Date.UTC(2024, 4, 15, 10, 30);
    const windowStart = Math.floor(Date.UTC(2024, 4, 14, 10, 30) / 1000);
    assert.deepStrictEqual(archiveMonths(windowStart, now), ['2024/05']);
});

test('a window that started last month needs both archives, oldest first', () => {
    const now = Date.UTC(2024, 5, 1, 0, 30);
    const windowStart = Math.floor(Date.UTC(2024, 5, 1, 0, 30) / 1000) - DAY_SECONDS;
    assert.deepStrictEqual(archiveMonths(windowStart, now), ['2024/05', '2024/06']);
});

test('archives roll over the year boundary', () => {
    const now = Date.UTC(2025, 0, 1, 5, 0);
    const windowStart = Math.floor(now / 1000) - DAY_SECONDS;
    assert.deepStrictEqual(archiveMonths(windowStart, now), ['2024/12', '2025/01']);
});

test('archive months are zero-padded', () => {
    const now = Date.UTC(2024, 0, 20);
    assert.deepStrictEqual(archiveMonths(Math.floor(now / 1000) - DAY_SECONDS, now), ['2024/01']);
});

test('a midnight window starting in the previous UTC month still fetches it', () => {
    // Local midnight can be in the previous UTC month for zones ahead of UTC
    const now = Date.UTC(2024, 5, 1, 2, 0);
    const windowStart = Math.floor(Date.UTC(2024, 4, 31, 22, 0) / 1000);
    assert.deepStrictEqual(archiveMonths(windowStart, now), ['2024/05', '2024/06']);
});

// ============ Games count ============

test('countLosses also counts every game the user played in the window', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const result = countLosses(mockData.games, 'BigManArkhangelsk', rollingWindow(mostRecentGame.end_time + 100));
    assert.strictEqual(result.games, 5);
    assert.strictEqual(result.losses, 3);
    assert.strictEqual(result.oldestCountedGame, mockData.games[0].end_time);
});

test('games count ignores games the user did not play', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const result = countLosses(mockData.games, 'someoneelse', rollingWindow(mostRecentGame.end_time + 100));
    assert.strictEqual(result.games, 0);
    assert.strictEqual(result.oldestCountedGame, null);
});

// ============ Block modes and ratings ============

test('normalizeBlockMode keeps known modes and defaults the rest', () => {
    assert.strictEqual(normalizeBlockMode('games'), 'games');
    assert.strictEqual(normalizeBlockMode('rating'), 'rating');
    assert.strictEqual(normalizeBlockMode('elo'), 'losses');
    assert.strictEqual(normalizeBlockMode(undefined), 'losses');
});

test('normalizeRatingBound treats blanks and junk as no bound', () => {
    assert.strictEqual(normalizeRatingBound('2200'), 2200);
    assert.strictEqual(normalizeRatingBound(1500), 1500);
    assert.strictEqual(normalizeRatingBound(''), null);
    assert.strictEqual(normalizeRatingBound(null), null);
    assert.strictEqual(normalizeRatingBound(0), null);
    assert.strictEqual(normalizeRatingBound('abc'), null);
});

const stats = {
    chess_bullet: { last: { rating: 1900 } },
    chess_blitz: { last: { rating: 2163 } },
    chess_rapid: { last: { rating: 2150 } },
    chess_daily: { last: { rating: 1700 } },
    chess960_daily: { last: { rating: 1600 } }
};

test('currentRatings picks the tracked time controls out of the stats response', () => {
    assert.deepStrictEqual(currentRatings(stats, DEFAULT_FILTERS), { bullet: 1900, blitz: 2163, rapid: 2150 });
    assert.deepStrictEqual(currentRatings(stats, { ...DEFAULT_FILTERS, bullet: false, daily: true }), {
        blitz: 2163, rapid: 2150, daily: 1700
    });
});

test('currentRatings copes with an empty or partial stats response', () => {
    assert.deepStrictEqual(currentRatings({}, DEFAULT_FILTERS), {});
    assert.deepStrictEqual(currentRatings(null, DEFAULT_FILTERS), {});
    assert.deepStrictEqual(currentRatings({ chess_blitz: {} }, DEFAULT_FILTERS), {});
});

test('a rating is out of range only beyond either bound, never on it', () => {
    assert.strictEqual(ratingOutOfRange(2163, 2150, 2200), false);
    // The bounds themselves are allowed, matching "Falls below" / "Rises above"
    assert.strictEqual(ratingOutOfRange(2150, 2150, 2200), false);
    assert.strictEqual(ratingOutOfRange(2200, 2150, 2200), false);
    assert.strictEqual(ratingOutOfRange(2149, 2150, 2200), true);
    assert.strictEqual(ratingOutOfRange(2201, 2150, 2200), true);
    assert.strictEqual(ratingOutOfRange(1000, null, 2200), false);
    assert.strictEqual(ratingOutOfRange(3000, 2150, null), false);
    assert.strictEqual(ratingOutOfRange(3000, null, null), false);
});

test('ratingsOutOfRange lists the time controls that tripped', () => {
    // bullet 1900, blitz 2163, rapid 2150
    const ratings = currentRatings(stats, DEFAULT_FILTERS);
    assert.deepStrictEqual(ratingsOutOfRange(ratings, 2150, 2200), ['bullet']);
    assert.deepStrictEqual(ratingsOutOfRange(ratings, 1800, 2160), ['blitz']);
    assert.deepStrictEqual(ratingsOutOfRange(ratings, null, 2000), ['blitz', 'rapid']);
    assert.deepStrictEqual(ratingsOutOfRange(ratings, null, null), []);
});

// ============ Locally recorded games ============
//
// chess.com's archive can lag hours behind the games it lists, so the content
// script records games as they end and they are counted until the archive
// catches up. These tests cover that ledger.

const {
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
    hasUnclassifiedLocalGames,
    countLocalGames
} = require('../src/lossCounter.js');

const NOW = 1764800000;
const statsAt = (timeClass, date) => ({ [`chess_${timeClass}`]: { last: { rating: 1000, date } } });

test('a locally recorded loss is counted while the archive has not published it', () => {
    const ledger = [{ endTime: NOW - 60, lost: true, timeClass: 'blitz' }];
    const counted = countLocalGames(ledger, NOW - DAY_SECONDS, DEFAULT_FILTERS);
    assert.strictEqual(counted.losses, 1);
    assert.strictEqual(counted.games, 1);
    assert.strictEqual(counted.oldestCountedLoss, NOW - 60);
});

test('a record is dropped once the archive publishes the same game', () => {
    const ledger = [{ endTime: NOW - 60, lost: true, timeClass: 'blitz' }];
    const kept = pruneLocalGames(ledger, [{ end_time: NOW - 75 }], NOW);
    assert.deepStrictEqual(kept, []);
});

test('a record is kept when the archive holds only other games', () => {
    const ledger = [{ endTime: NOW - 60, lost: true, timeClass: 'blitz' }];
    const kept = pruneLocalGames(ledger, [{ end_time: NOW - 5000 }], NOW);
    assert.strictEqual(kept.length, 1);
});

test('records age out of the ledger', () => {
    const ledger = [{ endTime: NOW - 3 * DAY_SECONDS, lost: true, timeClass: 'blitz' }];
    assert.deepStrictEqual(pruneLocalGames(ledger, [], NOW), []);
});

test('a game outside the window is not counted', () => {
    const ledger = [{ endTime: NOW - DAY_SECONDS - 10, lost: true, timeClass: 'blitz' }];
    assert.strictEqual(countLocalGames(ledger, NOW - DAY_SECONDS, DEFAULT_FILTERS).losses, 0);
});

test('a repeat of the same game end is not added twice', () => {
    const first = appendLocalGame([], { endTime: NOW, lost: true, timeClass: null });
    const second = appendLocalGame(first, { endTime: NOW + LOCAL_DUPLICATE_SECONDS - 1, lost: true, timeClass: null });
    assert.strictEqual(second.length, 1);
    const third = appendLocalGame(second, { endTime: NOW + LOCAL_DUPLICATE_SECONDS + 1, lost: true, timeClass: null });
    assert.strictEqual(third.length, 2);
});

test('stats place a game in the pool whose last game moved with it', () => {
    const ledger = [{ endTime: NOW, lost: true, timeClass: null }];
    assert.deepStrictEqual(classifyLocalGames(ledger, statsAt('bullet', NOW - 3)), ['bullet']);
    assert.deepStrictEqual(classifyLocalGames(ledger, statsAt('bullet', NOW - 5000)), [null]);
    assert.deepStrictEqual(classifyLocalGames(ledger, {}), [null]);
});

test('the closest pool wins when two moved', () => {
    const stats = { ...statsAt('bullet', NOW - 100), ...statsAt('blitz', NOW - 2) };
    assert.deepStrictEqual(classifyLocalGames([{ endTime: NOW, timeClass: null }], stats), ['blitz']);
});

test('a pool already accounted for is not lent to the game after it', () => {
    // A rated blitz game, then a Chess960 game a minute later. chess.com
    // publishes no rating for Chess960, so nothing in stats moved for it and
    // the blitz pool's last game is still the first one - which is the game
    // that gets to keep it.
    const ledger = [
        { endTime: NOW - 60, lost: true, timeClass: null },
        { endTime: NOW, lost: true, timeClass: null }
    ];
    assert.deepStrictEqual(classifyLocalGames(ledger, statsAt('blitz', NOW - 62)), ['blitz', null]);
    // The same, once the first game has been classified by an earlier check
    const settled = [{ ...ledger[0], timeClass: 'blitz' }, ledger[1]];
    assert.deepStrictEqual(classifyLocalGames(settled, statsAt('blitz', NOW - 62)), ['blitz', null]);
});

test('a game no pool accounts for stops counting once its grace runs out', () => {
    const ledger = [
        { endTime: NOW - 60, lost: true, timeClass: null },
        { endTime: NOW, lost: true, timeClass: null }
    ];
    const later = NOW + LOCAL_CLASSIFY_GRACE_SECONDS + 10;
    const settled = resolveLocalGames(ledger, statsAt('blitz', NOW - 62), later);
    assert.deepStrictEqual(settled.map((game) => game.timeClass), ['blitz', UNTRACKED_TIME_CLASS]);
    assert.strictEqual(countLocalGames(settled, later - DAY_SECONDS, DEFAULT_FILTERS).losses, 1);
});

test('an unclassified record counts, then stops once stats write it off', () => {
    const filters = { ...DEFAULT_FILTERS };
    const fresh = [{ endTime: NOW - 10, lost: true, timeClass: null }];

    // Nothing in stats moved: still inside the grace period, so it counts
    const withinGrace = resolveLocalGames(fresh, {}, NOW);
    assert.strictEqual(withinGrace[0].timeClass, null);
    assert.strictEqual(countLocalGames(withinGrace, NOW - DAY_SECONDS, filters).losses, 1);

    // Past the grace period it is an unrated or variant game, and stops counting
    const later = NOW + LOCAL_CLASSIFY_GRACE_SECONDS + 10;
    const settled = resolveLocalGames(fresh, {}, later);
    assert.strictEqual(settled[0].timeClass, UNTRACKED_TIME_CLASS);
    assert.strictEqual(countLocalGames(settled, later - DAY_SECONDS, filters).losses, 0);
});

test('unreachable stats leave a record unclassified rather than writing it off', () => {
    const old = [{ endTime: NOW - 10 * LOCAL_CLASSIFY_GRACE_SECONDS, lost: true, timeClass: null }];
    assert.strictEqual(resolveLocalGames(old, null, NOW)[0].timeClass, null);
    assert.ok(hasUnclassifiedLocalGames(old));
    assert.ok(!hasUnclassifiedLocalGames([{ endTime: NOW, lost: true, timeClass: 'blitz' }]));
});

test('a classified record obeys the time control filters', () => {
    const ledger = [{ endTime: NOW - 60, lost: true, timeClass: 'daily' }];
    // daily is off by default
    assert.strictEqual(countLocalGames(ledger, NOW - DAY_SECONDS, DEFAULT_FILTERS).losses, 0);
    const withDaily = { ...DEFAULT_FILTERS, daily: true };
    assert.strictEqual(countLocalGames(ledger, NOW - DAY_SECONDS, withDaily).losses, 1);
});

test('a classified record is skipped when standard chess is filtered out', () => {
    const ledger = [{ endTime: NOW - 60, lost: true, timeClass: 'blitz' }];
    const noStandard = { ...DEFAULT_FILTERS, chess: false };
    assert.strictEqual(countLocalGames(ledger, NOW - DAY_SECONDS, noStandard).losses, 0);
});

test('draws and wins count as games but not as losses', () => {
    const ledger = [
        { endTime: NOW - 120, lost: false, timeClass: 'blitz' },
        { endTime: NOW - 60, lost: true, timeClass: 'blitz' }
    ];
    const counted = countLocalGames(ledger, NOW - DAY_SECONDS, DEFAULT_FILTERS);
    assert.strictEqual(counted.games, 2);
    assert.strictEqual(counted.losses, 1);
    assert.strictEqual(counted.oldestCountedGame, NOW - 120);
    assert.strictEqual(counted.oldestCountedLoss, NOW - 60);
});

test('archive and ledger counts add up, keeping the earlier reset time', () => {
    const archive = { losses: 2, games: 3, oldestCountedLoss: NOW - 1000, oldestCountedGame: NOW - 1200 };
    const local = { losses: 1, games: 1, oldestCountedLoss: NOW - 60, oldestCountedGame: NOW - 60 };
    assert.deepStrictEqual(mergeCounts(archive, local), {
        losses: 3,
        games: 4,
        oldestCountedLoss: NOW - 1000,
        oldestCountedGame: NOW - 1200
    });
    assert.deepStrictEqual(
        mergeCounts({ losses: 0, games: 0, oldestCountedLoss: null, oldestCountedGame: null }, local),
        { losses: 1, games: 1, oldestCountedLoss: NOW - 60, oldestCountedGame: NOW - 60 }
    );
});

test('the same game is never counted from both the archive and the ledger', () => {
    const endTime = NOW - 60;
    const archiveGames = [{
        end_time: endTime,
        time_class: 'blitz',
        rules: 'chess',
        white: { username: 'me', result: 'checkmated' },
        black: { username: 'them', result: 'win' }
    }];
    const ledger = pruneLocalGames([{ endTime: endTime + 4, lost: true, timeClass: 'blitz' }], archiveGames, NOW);
    const windowStart = NOW - DAY_SECONDS;
    const counted = mergeCounts(
        countLosses(archiveGames, 'me', windowStart, DEFAULT_FILTERS),
        countLocalGames(ledger, windowStart, DEFAULT_FILTERS)
    );
    assert.strictEqual(counted.losses, 1);
    assert.strictEqual(counted.games, 1);
});

// ============ Placing games by pool totals ============
//
// The last-game time per pool can only ever place the most recent game in
// that pool. The totals say how many games the pool gained since the previous
// check, which places the ones before it.

const statsWith = (pools) => {
    const stats = {};
    for (const [timeClass, { date, total }] of Object.entries(pools)) {
        stats[`chess_${timeClass}`] = { last: { rating: 1000, date }, record: { win: total, loss: 0, draw: 0 } };
    }
    return stats;
};

test('poolTotals sums wins, losses and draws per tracked pool', () => {
    const stats = {
        chess_bullet: { record: { win: 10, loss: 5, draw: 1 } },
        chess_blitz: { record: { win: 2 } },
        chess960_daily: { record: { win: 100, loss: 100, draw: 100 } }
    };
    assert.deepStrictEqual(poolTotals(stats), { bullet: 16, blitz: 2 });
    assert.deepStrictEqual(poolTotals({}), {});
    assert.deepStrictEqual(poolTotals(null), {});
});

test('two games in one pool are both placed when the totals say the pool gained two', () => {
    // Bullet loss at T, bullet loss at T+80; neither was placed before the
    // second ended. The pool's last game names the second; the totals name
    // the first.
    const ledger = [
        { endTime: NOW, lost: true, timeClass: null },
        { endTime: NOW + 80, lost: true, timeClass: null }
    ];
    const before = { bullet: 100 };
    const after = statsWith({ bullet: { date: NOW + 80, total: 102 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, before), ['bullet', 'bullet']);

    const later = NOW + 80 + LOCAL_CLASSIFY_GRACE_SECONDS + 10;
    const settled = resolveLocalGames(ledger, after, later, before);
    assert.strictEqual(countLocalGames(settled, later - DAY_SECONDS, DEFAULT_FILTERS).losses, 2);
});

test('without previous totals only the last-game time places anything', () => {
    const ledger = [
        { endTime: NOW, lost: true, timeClass: null },
        { endTime: NOW + 80, lost: true, timeClass: null }
    ];
    const after = statsWith({ bullet: { date: NOW + 80, total: 102 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, null), [null, 'bullet']);
});

test('a game the last-game time placed is not handed out again from the totals', () => {
    // One bullet game, seen by the totals and by the last-game time alike:
    // an unrated game a minute earlier must not inherit the pool from it
    const ledger = [
        { endTime: NOW - 60, lost: true, timeClass: null },
        { endTime: NOW, lost: true, timeClass: null }
    ];
    const after = statsWith({ bullet: { date: NOW, total: 101 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, { bullet: 100 }), [null, 'bullet']);
});

test('a record classified at an earlier check does not eat the new spare', () => {
    // The first game was placed last time (its game was in the previous
    // totals). This time the pool gained one more game, which is the second.
    const ledger = [
        { endTime: NOW - 60, lost: true, timeClass: 'bullet' },
        { endTime: NOW, lost: true, timeClass: null }
    ];
    // Stats lag: the last-game time still names the first game
    const after = statsWith({ bullet: { date: NOW - 60, total: 101 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, { bullet: 100 }), ['bullet', 'bullet']);
});

test('spare games go to the newest unplaced records first', () => {
    // Three records, the pool gained two: the oldest is the odd one out
    const ledger = [
        { endTime: NOW - 200, lost: true, timeClass: null },
        { endTime: NOW - 100, lost: true, timeClass: null },
        { endTime: NOW, lost: true, timeClass: null }
    ];
    const after = statsWith({ blitz: { date: NOW, total: 52 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, { blitz: 50 }), [null, 'blitz', 'blitz']);
});

test('when two pools gained games the most recently active one is served first', () => {
    const ledger = [
        { endTime: NOW - 400, lost: true, timeClass: null },
        { endTime: NOW - 300, lost: true, timeClass: null }
    ];
    // Neither last-game time is within the tolerance of a record
    const after = statsWith({
        blitz: { date: NOW - 1000, total: 51 },
        rapid: { date: NOW - 900, total: 21 }
    });
    assert.deepStrictEqual(
        classifyLocalGames(ledger, after, { blitz: 50, rapid: 20 }),
        ['blitz', 'rapid']
    );
});

test('a pool with no previous total gives nothing away', () => {
    const ledger = [{ endTime: NOW - 500, lost: true, timeClass: null }];
    const after = statsWith({ bullet: { date: NOW - 5000, total: 7 } });
    assert.deepStrictEqual(classifyLocalGames(ledger, after, { blitz: 3 }), [null]);
});

test('the grace period is over at the deadline itself, not a second later', () => {
    const fresh = [{ endTime: NOW, lost: true, timeClass: null }];
    const atDeadline = resolveLocalGames(fresh, {}, NOW + LOCAL_CLASSIFY_GRACE_SECONDS);
    assert.strictEqual(atDeadline[0].timeClass, UNTRACKED_TIME_CLASS);
    const justBefore = resolveLocalGames(fresh, {}, NOW + LOCAL_CLASSIFY_GRACE_SECONDS - 1);
    assert.strictEqual(justBefore[0].timeClass, null);
});

// ============ Pruning against the archive ============

test('an archived game accounts for one record only', () => {
    // Two bullet games 100s apart; the archive has published only the first
    const ledger = [
        { endTime: NOW - 100, lost: true, timeClass: 'bullet' },
        { endTime: NOW, lost: true, timeClass: 'bullet' }
    ];
    const kept = pruneLocalGames(ledger, [{ end_time: NOW - 104 }], NOW);
    assert.deepStrictEqual(kept, [ledger[1]]);
});

test('each archived game takes the record nearest to it', () => {
    const ledger = [
        { endTime: NOW - 100, lost: true, timeClass: 'bullet' },
        { endTime: NOW, lost: true, timeClass: 'bullet' }
    ];
    // Both published: both records go
    assert.deepStrictEqual(pruneLocalGames(ledger, [{ end_time: NOW - 3 }, { end_time: NOW - 103 }], NOW), []);
    // Two archived games a minute apart but only one record: one is left over
    assert.strictEqual(publishedRecords([ledger[1]], [{ end_time: NOW - 3 }, { end_time: NOW - 60 }]).size, 1);
});

test('countLosses does not stop at a game that is out of order', () => {
    const now = new Date(2024, 4, 15, 10, 30, 0, 0);
    const windowStart = getWindowStart(now.getTime(), 'midnight');
    const games = [
        lostGameAt(new Date(2024, 4, 15, 9, 0, 0, 0)),
        lostGameAt(new Date(2024, 4, 14, 9, 0, 0, 0)), // yesterday, listed after today
        lostGameAt(new Date(2024, 4, 15, 9, 30, 0, 0))
    ];
    assert.strictEqual(countLosses(games, 'me', windowStart).losses, 2);
});

// ============ The verdict ============

const {
    RETRY_DELAY_MS,
    RATING_POLL_MS,
    classifyDeadline,
    decideBlock
} = require('../src/lossCounter.js');

const NOW_MS = NOW * 1000;
const noCount = { losses: 0, games: 0, oldestCountedLoss: null, oldestCountedGame: null };

function decide(overrides = {}) {
    return decideBlock({
        nowMs: NOW_MS,
        blockMode: 'losses',
        maxGames: 5,
        resetMode: 'rolling',
        filters: DEFAULT_FILTERS,
        ratingFloor: null,
        ratingCeiling: null,
        counted: noCount,
        outage: false,
        stats: {},
        lastLimitHit: false,
        localGames: [],
        clockSkewMs: 0,
        paused: false,
        hourBlockUntil: null,
        hourBlockPendingUntil: null,
        ...overrides
    });
}

test('the limit blocks in losses mode and wakes when the oldest loss ages out', () => {
    const counted = { losses: 5, games: 7, oldestCountedLoss: NOW - 1000, oldestCountedGame: NOW - 2000 };
    const verdict = decide({ counted });
    assert.strictEqual(verdict.limitHit, true);
    assert.strictEqual(verdict.blocked, true);
    assert.strictEqual(verdict.nextReset, (NOW - 1000 + DAY_SECONDS + 1) * 1000);
    assert.strictEqual(verdict.wakeAt, verdict.nextReset);
    assert.strictEqual(verdict.ratings, null);
});

test('games mode counts every game and resets off the oldest game', () => {
    const counted = { losses: 1, games: 5, oldestCountedLoss: NOW - 1000, oldestCountedGame: NOW - 2000 };
    const verdict = decide({ counted, blockMode: 'games' });
    assert.strictEqual(verdict.limitHit, true);
    assert.strictEqual(verdict.nextReset, (NOW - 2000 + DAY_SECONDS + 1) * 1000);
});

test('paused means never blocked, whatever else is going on', () => {
    const counted = { losses: 9, games: 9, oldestCountedLoss: NOW - 10, oldestCountedGame: NOW - 10 };
    const verdict = decide({ counted, paused: true, hourBlockUntil: NOW_MS + 1000 });
    assert.strictEqual(verdict.limitHit, true);
    assert.strictEqual(verdict.blocked, false);
});

test('a 1-hour block blocks on its own and wakes when it ends', () => {
    const verdict = decide({ hourBlockUntil: NOW_MS + 30 * 60000 });
    assert.strictEqual(verdict.limitHit, false);
    assert.strictEqual(verdict.blocked, true);
    assert.strictEqual(verdict.wakeAt, NOW_MS + 30 * 60000);
});

test('a pending 1-hour block blocks and wakes when its request expires', () => {
    const verdict = decide({ hourBlockPendingUntil: NOW_MS + 40 * 60000 });
    assert.strictEqual(verdict.blocked, true);
    assert.strictEqual(verdict.wakeAt, NOW_MS + 40 * 60000);
});

test('an outage arms a retry and never a wake-up for a reset that has passed', () => {
    const counted = { losses: 5, games: 5, oldestCountedLoss: NOW - 2 * DAY_SECONDS, oldestCountedGame: NOW - 2 * DAY_SECONDS };
    const verdict = decide({ counted, outage: true });
    assert.strictEqual(verdict.blocked, true);
    assert.strictEqual(verdict.wakeAt, NOW_MS + RETRY_DELAY_MS);
});

test('rating mode compares the tracked ratings and polls', () => {
    const stats = { chess_blitz: { last: { rating: 1490 } }, chess_bullet: { last: { rating: 1600 } } };
    const verdict = decide({ blockMode: 'rating', stats, ratingFloor: 1500 });
    assert.deepStrictEqual(verdict.ratings, { bullet: 1600, blitz: 1490 });
    assert.strictEqual(verdict.limitHit, true);
    assert.strictEqual(verdict.nextReset, null);
    assert.strictEqual(verdict.wakeAt, NOW_MS + RATING_POLL_MS);
});

test('rating mode holds the last verdict while the stats endpoint is unreachable', () => {
    assert.strictEqual(decide({ blockMode: 'rating', stats: null, lastLimitHit: true }).limitHit, true);
    assert.strictEqual(decide({ blockMode: 'rating', stats: null, lastLimitHit: false }).limitHit, false);
    // and retries sooner than the poll
    assert.strictEqual(decide({ blockMode: 'rating', stats: null }).wakeAt, NOW_MS + RETRY_DELAY_MS);
    // while an unreachable stats endpoint in losses mode is not an outage
    assert.strictEqual(decide({ stats: null }).wakeAt, null);
});

test('an unclassified record wakes the check a second past its grace, on the local clock', () => {
    const localGames = [{ endTime: NOW, lost: true, timeClass: null }];
    const expected = (NOW + LOCAL_CLASSIFY_GRACE_SECONDS + 1) * 1000;
    assert.strictEqual(classifyDeadline(localGames, 0), expected);
    // chess.com's clock 30s ahead: the record's time is 30s ahead of ours
    assert.strictEqual(classifyDeadline(localGames, 30000), expected - 30000);
    assert.strictEqual(classifyDeadline([{ endTime: NOW, timeClass: 'blitz' }], 0), null);
    assert.strictEqual(decide({ localGames }).wakeAt, expected);
});

test('the earliest of the wake-up reasons wins', () => {
    const counted = { losses: 5, games: 5, oldestCountedLoss: NOW - 1000, oldestCountedGame: NOW - 1000 };
    const verdict = decide({ counted, hourBlockUntil: NOW_MS + 60000 });
    assert.strictEqual(verdict.wakeAt, NOW_MS + 60000);
});
