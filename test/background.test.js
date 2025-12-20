/**
 * Tests for the loss-counting logic in background.js
 * Run with: node test/background.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Load mock data
const mockData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-games-response.json'), 'utf8')
);

// Default filters (mirrors background.js)
const DEFAULT_FILTERS = {
    bullet: true,
    blitz: true,
    rapid: true,
    daily: false,
    chess: true,
    chess960: false,
    bughouse: false,
    crazyhouse: false,
    threecheck: false,
    kingofthehill: false
};

/**
 * Check if a game matches the active filters.
 * This mirrors the logic in background.js
 */
function gameMatchesFilters(game, filters) {
    const timeClass = game.time_class || 'unknown';
    const rules = game.rules || 'chess';
    
    const timeEnabled = filters[timeClass] === true;
    const rulesEnabled = filters[rules] === true;
    
    return timeEnabled && rulesEnabled;
}

/**
 * Counts losses in the last 24 hours for a given username.
 * This mirrors the logic in background.js
 */
function countLosses(games, username, currentTime, filters = DEFAULT_FILTERS) {
    const lowerUsername = username.toLowerCase();
    let losses = 0;
    
    // Iterate from end (most recent) to beginning
    for (let i = games.length - 1; i >= 0; i--) {
        const game = games[i];
        
        // Stop if game is older than 24 hours
        if (currentTime - game.end_time > 86400) {
            break;
        }
        
        // Only count games that match filters
        if (!gameMatchesFilters(game, filters)) {
            continue;
        }
        
        // Check if this is a loss for our user
        if (game.white.username.toLowerCase() === lowerUsername && game.black.result === 'win') {
            losses++;
        } else if (game.black.username.toLowerCase() === lowerUsername && game.white.result === 'win') {
            losses++;
        }
    }
    
    return losses;
}

/**
 * Test helpers
 */
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        testsPassed++;
    } catch (err) {
        console.error(`✗ ${name}`);
        console.error(`  ${err.message}`);
        testsFailed++;
    }
}

// ============ TESTS ============

console.log('\n--- Loss Counting Tests ---\n');

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
    
    const losses = countLosses(mockData.games, 'BigManArkhangelsk', currentTime);
    
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
    
    const losses1 = countLosses(mockData.games, 'bigmanarkhangelsk', currentTime);
    const losses2 = countLosses(mockData.games, 'BIGMANARKHANGELSK', currentTime);
    const losses3 = countLosses(mockData.games, 'BigManArkhangelsk', currentTime);
    
    assert.strictEqual(losses1, losses2, 'Lowercase should match');
    assert.strictEqual(losses2, losses3, 'Mixed case should match');
});

test('games older than 24 hours are not counted', () => {
    // Set current time to more than 24 hours after the most recent game
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 86401; // 24 hours + 1 second after last game
    
    const losses = countLosses(mockData.games, 'BigManArkhangelsk', currentTime);
    
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
    const losses = countLosses(mockData.games, 'BigManArkhangelsk', currentTime);
    assert.strictEqual(losses, 1, `Expected 1 loss in partial window, got ${losses}`);
});

test('returns 0 losses for empty games array', () => {
    const losses = countLosses([], 'BigManArkhangelsk', Date.now());
    assert.strictEqual(losses, 0, 'Empty games should have 0 losses');
});

test('returns 0 losses for unknown user', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    const losses = countLosses(mockData.games, 'unknownuser12345', currentTime);
    assert.strictEqual(losses, 0, 'Unknown user should have 0 losses');
});

// ============ FILTER TESTS ============

console.log('\n--- Filter Tests ---\n');

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
    const losses = countLosses(mockData.games, 'BigManArkhangelsk', currentTime, noBlitzFilters);
    assert.strictEqual(losses, 0, 'Disabling blitz should exclude all blitz games');
});

test('countLosses with all filters enabled counts all losses', () => {
    const mostRecentGame = mockData.games[mockData.games.length - 1];
    const currentTime = mostRecentGame.end_time + 100;
    
    // With default filters (blitz + chess enabled), should get 3 losses
    const losses = countLosses(mockData.games, 'BigManArkhangelsk', currentTime, DEFAULT_FILTERS);
    assert.strictEqual(losses, 3, 'Default filters should count all blitz chess losses');
});

// ============ SUMMARY ============

console.log('\n--- Summary ---');
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);

process.exit(testsFailed > 0 ? 1 : 0);

