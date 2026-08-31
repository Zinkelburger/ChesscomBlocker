const test = require('node:test');
const assert = require('node:assert');

const { GAME_PAGE_PATTERN } = require('../src/shared.js');

test('game and play/online pages are blockable', () => {
    for (const url of [
        'https://www.chess.com/game/live/123456',
        'https://www.chess.com/game/daily/1',
        'https://www.chess.com/play/online',
        'https://www.chess.com/play/online/new',
        'https://chess.com/play/online',
        'http://www.chess.com/game/1'
    ]) {
        assert.ok(GAME_PAGE_PATTERN.test(url), url);
    }
});

test('other pages are left alone', () => {
    for (const url of [
        'https://www.chess.com/',
        'https://www.chess.com/home',
        'https://www.chess.com/puzzles',
        'https://www.chess.com/play/computer',
        'https://api.chess.com/pub/player/x/games/2024/05',
        'https://example.com/game',
        'https://notchess.com/game/1',
        'https://evil.com/https://www.chess.com/game/1'
    ]) {
        assert.ok(!GAME_PAGE_PATTERN.test(url), url);
    }
});

const { formatCountdown, BREAK_DURATION_MS } = require('../src/shared.js');

test('countdowns read naturally', () => {
    assert.strictEqual(formatCountdown(0), 'under a minute');
    assert.strictEqual(formatCountdown(12 * 60000), '12m');
    assert.strictEqual(formatCountdown(BREAK_DURATION_MS), '1h 0m');
    assert.strictEqual(formatCountdown(5 * 3600000 + 12 * 60000), '5h 12m');
});

const { normalizeUsername } = require('../src/shared.js');

test('usernames are lowercased and trimmed', () => {
    assert.strictEqual(normalizeUsername('  Hikaru  '), 'hikaru');
    assert.strictEqual(normalizeUsername('Big_Man-99'), 'big_man-99');
    assert.strictEqual(normalizeUsername('altaccountq'), 'altaccountq');
});

test('a username that could not be one is rejected outright', () => {
    for (const bad of ['', '   ', 'a/b', '../../pub', 'name with spaces', 'ünicode', null, undefined, 'x'.repeat(65)]) {
        assert.strictEqual(normalizeUsername(bad), null, `${bad} should be rejected`);
    }
});

// Whatever the page hands over goes through this before it is stored, so a
// page global that is missing, renamed or replaced cannot put junk in storage
test('anything the page could offer that is not a username is dropped', () => {
    for (const bad of [{}, [], { username: 'x' }, 'a'.repeat(100), '<script>']) {
        assert.strictEqual(normalizeUsername(bad), null);
    }
    // A name that is all digits is a real chess.com username, not junk
    assert.strictEqual(normalizeUsername(12345), '12345');
});
