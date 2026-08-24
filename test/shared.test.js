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
