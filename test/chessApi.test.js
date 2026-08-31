// Tests for the pure parts of the chess.com API wrapper in src/chessApi.js
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    API_BASE,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    archivePath,
    statsPath,
    profilePath,
    userAgent,
    backoffDelay,
    retryAfterMs,
    slimGame,
    slimArchive
} = require('../src/chessApi.js');

const mockData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-games-response.json'), 'utf8')
);

test('paths are built under the PubAPI base', () => {
    assert.strictEqual(API_BASE, 'https://api.chess.com/pub');
    assert.strictEqual(archivePath('hikaru', '2026/08'), '/player/hikaru/games/2026/08');
    assert.strictEqual(statsPath('hikaru'), '/player/hikaru/stats');
    assert.strictEqual(profilePath('hikaru'), '/player/hikaru');
});

test('the user agent carries a name and a way to make contact', () => {
    const agent = userAgent();
    assert.match(agent, /^ChesscomBlocker\/\d+\.\d+\.\d+ /);
    assert.match(agent, /contact: \S+/);
});

test('backoff doubles per failure and stops at the cap', () => {
    assert.strictEqual(backoffDelay(1, null), BACKOFF_BASE_MS);
    assert.strictEqual(backoffDelay(2, null), BACKOFF_BASE_MS * 2);
    assert.strictEqual(backoffDelay(3, null), BACKOFF_BASE_MS * 4);
    assert.strictEqual(backoffDelay(50, null), BACKOFF_MAX_MS);
});

test('a Retry-After longer than the backoff wins', () => {
    assert.strictEqual(backoffDelay(1, BACKOFF_BASE_MS * 10), BACKOFF_BASE_MS * 10);
    assert.strictEqual(backoffDelay(1, 1000), BACKOFF_BASE_MS);
});

// A minimal stand-in for the Response the wrapper reads Retry-After from
function withRetryAfter(value) {
    return { headers: { get: (name) => (name === 'Retry-After' && value !== null ? value : null) } };
}

test('Retry-After is read as seconds or as an HTTP date', () => {
    assert.strictEqual(retryAfterMs(withRetryAfter('30')), 30000);
    assert.strictEqual(retryAfterMs(withRetryAfter(null)), null);
    assert.strictEqual(retryAfterMs(withRetryAfter('not a delay')), null);

    const inTenSeconds = retryAfterMs(withRetryAfter(new Date(Date.now() + 10000).toUTCString()));
    assert.ok(inTenSeconds > 8000 && inTenSeconds <= 10000, `${inTenSeconds} should be about 10s`);

    // A date that has already passed asks for no wait at all, not a negative one
    assert.strictEqual(retryAfterMs(withRetryAfter(new Date(Date.now() - 60000).toUTCString())), 0);
});

test('a cached game keeps only what the counter reads', () => {
    const slim = slimGame(mockData.games[0]);
    assert.deepStrictEqual(Object.keys(slim).sort(), ['black', 'end_time', 'rules', 'time_class', 'white']);
    assert.deepStrictEqual(Object.keys(slim.white).sort(), ['result', 'username']);
    assert.strictEqual(slim.pgn, undefined);
    assert.strictEqual(slim.fen, undefined);
    assert.strictEqual(slim.uuid, undefined);
});

test('a cached game keeps the fields the counter reads', () => {
    const game = mockData.games[0];
    const slim = slimGame(game);
    assert.strictEqual(slim.end_time, game.end_time);
    assert.strictEqual(slim.time_class, game.time_class);
    assert.strictEqual(slim.rules, game.rules);
    assert.strictEqual(slim.white.username, game.white.username);
    assert.strictEqual(slim.white.result, game.white.result);
    assert.strictEqual(slim.black.username, game.black.username);
    assert.strictEqual(slim.black.result, game.black.result);
});

test('a game missing a player still yields a string username to compare', () => {
    const slim = slimGame({ end_time: 1, time_class: 'blitz', rules: 'chess' });
    assert.strictEqual(slim.white.username, '');
    assert.strictEqual(slim.black.username, '');
    assert.doesNotThrow(() => slim.white.username.toLowerCase());
});

test('slimming an archive survives a response with no games', () => {
    assert.deepStrictEqual(slimArchive({}), []);
    assert.deepStrictEqual(slimArchive(null), []);
    assert.deepStrictEqual(slimArchive({ games: 'nope' }), []);
    assert.strictEqual(slimArchive(mockData).length, mockData.games.length);
});

test('slimming is a large saving on a real archive', () => {
    const full = JSON.stringify(mockData.games).length;
    const slim = JSON.stringify(slimArchive(mockData)).length;
    assert.ok(slim < full / 2, `slim ${slim} should be well under half of ${full}`);
});
