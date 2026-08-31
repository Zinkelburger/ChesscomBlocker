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
