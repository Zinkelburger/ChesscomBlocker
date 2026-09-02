// What a finished game's card says about its result. Pure: the content script
// describes the card as plain strings (see describeCard in content.js) and
// this decides, so the tests can feed it strings taken from chess.com's
// markup without a DOM.
//
// Loaded by content.js (after shared.js, see manifests/base.json) and by the
// tests under test/.

// When only a rating change is available, changes below this are treated as
// a loss rather than a draw. A loss to a much stronger opponent can move the
// rating by less than this and read as a draw; only the old card, which
// states no result, ever falls back this far.
const LOSS_RATING_CHANGE = -4;

// "+8", "-8", "−8" (the typographic minus chess.com's markup has been seen
// to use), "0". Null for anything that is not a number.
function parseRatingChange(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const normalized = text.trim().replace(/^[−–—]/, '-');
    const value = Number.parseInt(normalized, 10);
    return Number.isFinite(value) ? value : null;
}

// Whether the finished game was lost: true or false once the card says, or
// null while it does not say yet. The card is described as
//   rated        whether it carries a rating element at all - no rating
//                element means this is not a rated game of the bottom
//                player's, so it is not ours to count
//   headerClass  the class attribute of the v6 modal's header, if any
//   title        the text of the v6 modal's title, if any
//   deltaText    the text of the rating change, if it has rendered
// and `lastTry` says the polling is over and a mild delta must be read at
// face value.
//
// The v6 modal states the result outright: the header carries a class like
// "game-over-modal-header-userWon" and the title reads "You Won!" - but only
// for a win. A loss names the winner by colour instead ("White Won", header
// class game-over-modal-header-whiteWon). The colour never needs translating
// into a side of the board: the user's own win is always phrased as "You
// Won!", so on the user's own game a winner named by colour can only be the
// opponent. The class names are checked before the titles because chess.com
// translates the titles and not the classes.
function readGameResult({ rated, headerClass = '', title = '', deltaText = null }, lastTry = false) {
    if (!rated) {
        return null;
    }

    // Prefer the stated result; a draw counts as not lost, matching how the
    // background classifies games from the API archive
    if (/userwon/i.test(headerClass) || /you won/i.test(title)) {
        return false;
    }
    if (/userlost/i.test(headerClass) || /you lost/i.test(title)) {
        return true;
    }
    if (/draw/i.test(headerClass) || /draw/i.test(title)) {
        return false;
    }

    // A winner named by colour is the user's loss, no delta needed: the
    // rated-game marker says this is the user's own game, their own win is
    // always phrased "You Won!", and a draw was caught as "Draw" - so the
    // colour can only be the opponent's. Skipping the delta also means not
    // waiting out its reveal animation, and not misreading the floored-at-100
    // delta of 0 that a loss leaves behind.
    if (/whitewon|blackwon/i.test(headerClass) || /white won|black won/i.test(title)) {
        return true;
    }

    // No stated result at all: the bare old card offers only the delta. A
    // clearly negative delta is a loss whatever else renders; anything milder
    // is ambiguous - at the 100 floor a loss moves the rating no further than
    // a draw does - so keep polling and let the modal, which states the
    // result, appear and outrank this card. Only once the polling is
    // exhausted is a mild delta taken at face value.
    const ratingChange = parseRatingChange(deltaText);
    if (ratingChange === null) {
        return null;
    }
    if (ratingChange < LOSS_RATING_CHANGE) {
        return true;
    }
    return lastTry ? false : null;
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LOSS_RATING_CHANGE, parseRatingChange, readGameResult };
}
