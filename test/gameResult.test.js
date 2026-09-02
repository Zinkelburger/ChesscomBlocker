// Tests for the game-over card reader in src/gameResult.js
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const { LOSS_RATING_CHANGE, parseRatingChange, readGameResult } = require('../src/gameResult.js');

test('rating changes parse with either kind of minus sign', () => {
    assert.strictEqual(parseRatingChange('+8'), 8);
    assert.strictEqual(parseRatingChange('-8'), -8);
    assert.strictEqual(parseRatingChange('−8'), -8);
    assert.strictEqual(parseRatingChange(' 0 '), 0);
    assert.strictEqual(parseRatingChange(''), null);
    assert.strictEqual(parseRatingChange('…'), null);
    assert.strictEqual(parseRatingChange(null), null);
});

test('a card with no rating element is not ours to count', () => {
    assert.strictEqual(readGameResult({ rated: false, headerClass: 'game-over-modal-header-whiteWon' }), null);
    assert.strictEqual(readGameResult({ rated: false, deltaText: '-20' }, true), null);
});

test('the modal says who won', () => {
    const modal = (headerClass, title) => ({ rated: true, headerClass, title });
    assert.strictEqual(readGameResult(modal('game-over-modal-header-component game-over-modal-header-userWon', 'You Won!')), false);
    assert.strictEqual(readGameResult(modal('game-over-modal-header-component game-over-modal-header-whiteWon', 'White Won')), true);
    assert.strictEqual(readGameResult(modal('game-over-modal-header-component game-over-modal-header-blackWon', 'Black Won')), true);
    assert.strictEqual(readGameResult(modal('game-over-modal-header-component game-over-modal-header-draw', 'Draw')), false);
});

test('the class is enough when the title is in another language', () => {
    assert.strictEqual(readGameResult({ rated: true, headerClass: 'x game-over-modal-header-userWon', title: '¡Ganaste!' }), false);
    assert.strictEqual(readGameResult({ rated: true, headerClass: 'x game-over-modal-header-blackWon', title: 'Las negras ganan' }), true);
});

test('the title is enough when the class says nothing', () => {
    assert.strictEqual(readGameResult({ rated: true, headerClass: '', title: 'You Won!' }), false);
    assert.strictEqual(readGameResult({ rated: true, headerClass: '', title: 'White Won' }), true);
    assert.strictEqual(readGameResult({ rated: true, headerClass: '', title: 'Game Drawn' }), false);
});

test('a stated result outranks the delta', () => {
    assert.strictEqual(readGameResult({ rated: true, title: 'You Won!', deltaText: '-30' }), false);
    assert.strictEqual(readGameResult({ rated: true, title: 'White Won', deltaText: '+30' }), true);
});

test('the old card is read off its delta alone', () => {
    const card = (deltaText) => ({ rated: true, deltaText });
    assert.strictEqual(readGameResult(card('-8')), true);
    assert.strictEqual(readGameResult(card('−8')), true);
    assert.strictEqual(readGameResult(card('+8')), null, 'a mild delta waits for the modal');
    assert.strictEqual(readGameResult(card('+8'), true), false, 'until the polling is over');
    assert.strictEqual(readGameResult(card(String(LOSS_RATING_CHANGE)), true), false);
    assert.strictEqual(readGameResult(card(String(LOSS_RATING_CHANGE - 1))), true);
    assert.strictEqual(readGameResult(card(null)), null, 'no delta yet');
    assert.strictEqual(readGameResult(card(null), true), null, 'never one: not counted');
});
