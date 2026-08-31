// Runs on chess.com game and play pages: swaps the page for a blocked notice
// when the limit is reached (or a 1-hour block was started from the popup),
// and tells the background script about games as soon as they end so the
// block does not wait on the API.

// When only a rating change is available, changes below this are treated as
// a loss rather than a draw
const LOSS_RATING_CHANGE = -4;

// How long to wait after a game ends before the chess.com API is likely to
// know about it
const API_CATCH_UP_DELAY_MS = 15000;

// chess.com's game-over card, and the rating change inside it. Each selector
// pairs the pre-2026 markup with the "v6" game-over modal, since chess.com
// rolls redesigns out gradually.
const BOARD_SELECTOR = '.player-component.player-bottom';
// The pre-2026 card is nothing but the player box's rating summary - no
// result text at all - and chess.com renders it when a finished game is
// merely *opened* from the archive, not only when one ends. It is believed
// only on a URL whose game was seen being played (liveGameSeenHere below);
// anywhere else its delta describes some other game, or nothing.
const OLD_CARD_SELECTOR = '.player-game-over-component';
// When a game ends live, chess.com renders BOTH: the old card in the player
// box and the v6 modal over the page, and the old card tends to land first.
// Whichever one trips the observer, the modal is what gets read whenever it
// is up (see reportGameOver) - it states the result, the card never does.
const MODAL_SELECTOR = '.game-over-modal-shell-content';
const GAME_OVER_SELECTOR = `${OLD_CARD_SELECTOR}, ${MODAL_SELECTOR}`;
const RATING_CHANGE_SELECTOR =
    '.rating-score-change, .game-over-stat-card-rating .game-over-stat-card-delta.game-over-stat-card-deltaRevealed';

// The v6 modal states the result outright: the header carries a class like
// "game-over-modal-header-userWon" and the title reads "You Won!" - but only
// for a win. A loss names the winner by colour instead ("White Won", header
// class game-over-modal-header-whiteWon). The colour never needs translating
// into a side of the board: the user's own win is always phrased as "You
// Won!", so on the user's own game a winner named by colour can only be the
// opponent.
const RESULT_HEADER_SELECTOR = '.game-over-modal-header-component';
const RESULT_TITLE_SELECTOR = '.game-over-modal-title-component';

// Present in the card only when the finished game was a rated game of ours
const RATED_GAME_SELECTOR = '.rating-score-change, .game-over-stat-card-rating';

// The v6 modal reveals the rating delta with an animation, so poll for it
// instead of reading it only at insertion time. The modal stays up until the
// user acts, so waiting a while longer costs nothing and rides out a slow
// reveal. The game is reported under the time its card appeared rather than
// the time the delta finally showed up, so however long the reveal takes, the
// record still lines up with the end time the archive will publish.
const RATING_POLL_INTERVAL_MS = 500;
const RATING_POLL_ATTEMPTS = 30;

// Ignore a repeat of the game-over card this soon after the last one. Both
// this and the background's own duplicate window (LOCAL_DUPLICATE_SECONDS)
// are deliberately short: two quick bullet games can end barely a minute
// apart, and a window wide enough to swallow one of those would let a real
// game through. Counting the same game twice is the safe way to be wrong for
// a blocker, and the archive settles it either way within hours.
const GAME_OVER_DEBOUNCE_MS = 10000;

// Signs that a new game has begun: moves being added to the move list, or
// move highlights appearing on the board. chess.com starts a rematch without
// changing the URL, so these are what re-arm the wait-for-game-end guard
// after a game has already ended here - and what gameInProgress requires
// before it lets a block wait at all, so an untouched board cannot hold one
// back. Matching too eagerly is the safe direction: it only makes a block
// wait for a game end, which the next game-over card or navigation delivers
// either way.
const NEW_GAME_ACTIVITY_SELECTOR =
    'vertical-move-list .node, wc-simple-move-list .node, [class*="move-list"] .node, .highlight';

// Present only while a game is live: the sidebar's Resign/Draw buttons, and
// the clock-player-turn class chess.com puts on the clock of the side to
// move. A finished game visited later has a full move list but none of
// these, and must not hold a block back either. If chess.com renames every
// one of them, gameInProgress errs toward blocking right away - for a
// blocker, the safe way to be wrong.
const LIVE_GAME_SELECTOR =
    '.resign-button-component, .draw-button-component, .clock-player-turn';

// How often the blocked page redraws its countdown
const BLOCK_COUNTDOWN_INTERVAL_MS = 30000;

let blockPageShown = false;

// When the game-over card was last handled, so one game end is reported once
let lastGameOverAt = 0;

// Set when a block arrived in the middle of a game; applied once it ends
let blockAfterGame = false;

// Whether the game on this URL has already ended. Closing the game-over modal
// leaves the board on screen with no card, which would otherwise look like a
// game still being played and hold a block back until the next navigation.
let gameOverSeenHere = false;

// Whether this URL's game was ever seen live (resign/draw buttons, a ticking
// clock). Checked at injection and once a second by urlWatch - the controls
// are up for a game's whole length, so the tick cannot miss them. This is
// what separates a game ending here from a finished game merely being looked
// at, where the only game-over markup is the bare old card. The v6 modal is
// not held to this: it only appears when a game actually ends, and gating it
// on selectors chess.com could rename would fail toward losses never being
// counted - the wrong direction for a blocker.
let liveGameSeenHere = false;

// The deadline the popup's 1-hour block runs to, or null if this block is the
// limit instead. A 1-hour block asked for in the popup stays pending until the
// block is actually on screen - which is now - so this is where its hour starts.
async function breakDeadline() {
    const { breakUntil, breakPending } = await extensionApi.storage.local.get({
        breakUntil: null,
        breakPending: false
    });
    // Older builds stored the pending block as a flag, current ones as the
    // time of the click
    if (breakPending === true || typeof breakPending === 'number') {
        const deadline = await askBackground({ action: 'beginBreak' });
        if (typeof deadline === 'number') {
            return deadline;
        }
        // No answer (the background was mid-restart): better a countdown that
        // runs a touch long than calling this a limit block. The background
        // expires the pending state on its own alarm regardless.
        return Date.now() + BREAK_DURATION_MS;
    }
    return typeof breakUntil === 'number' && breakUntil > Date.now() ? breakUntil : null;
}

// The single headline this page has always shown; it still says which of the
// two blocks did it (the 1-hour block counts down, the limit does not)
function blockedHeadline(breakUntil) {
    return typeof breakUntil === 'number'
        ? `Chess Blocker: Chess.com is blocked for another ${formatCountdown(breakUntil - Date.now())}.`
        : 'Chess Blocker: Daily game limit reached. Please take a well-deserved break.';
}

async function showBlockedPage() {
    if (blockPageShown) {
        return;
    }
    blockPageShown = true;

    // Nothing on this page is worth watching any more: the body is about to
    // become a single heading, and the block lifting reloads the tab
    observer.disconnect();
    clearInterval(urlWatch);

    const breakUntil = await breakDeadline();

    const heading = document.createElement('h1');
    heading.textContent = blockedHeadline(breakUntil);
    Object.assign(heading.style, {
        color: 'white',
        textShadow: '2px 2px 4px rgba(0, 0, 0, 0.5)',
        fontFamily: 'Arial, sans-serif',
        textAlign: 'center',
        marginTop: '40px'
    });

    Object.assign(document.body.style, {
        display: 'flex',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: 'rgb(48, 46, 43)',
        padding: '0'
    });
    document.body.replaceChildren(heading);

    // The heading is the whole page, so nothing else is going to keep its
    // countdown honest for the hour it runs
    if (typeof breakUntil === 'number') {
        const countdown = setInterval(() => {
            if (Date.now() >= breakUntil) {
                clearInterval(countdown);
                // The background lifts the block on its own alarm; asking now
                // covers a service worker that was asleep when it fired
                sendToBackground({ action: 'checkGamesPlayed' });
                return;
            }
            heading.textContent = blockedHeadline(breakUntil);
        }, BLOCK_COUNTDOWN_INTERVAL_MS);
    }
}

// A live game the block should wait for: a board whose game has begun and
// not yet ended. The move/highlight check tells a live game from a board that
// is merely on screen (the idle play page renders the board and player boxes
// before any game starts), and the live-controls check tells it from a
// finished game visited later, which keeps its move list. Waiting on either
// of those boards would hold the block back for a game-over that never comes.
function gameInProgress() {
    return !gameOverSeenHere
        && document.querySelector(BOARD_SELECTOR) !== null
        && document.querySelector(GAME_OVER_SELECTOR) === null
        && document.querySelector(NEW_GAME_ACTIVITY_SELECTOR) !== null
        && document.querySelector(LIVE_GAME_SELECTOR) !== null;
}

// The notice shown while a block waits for the current game to end, so the
// wait never looks like the popup's button not working. showBlockedPage
// replaces the whole body, banner included, so only the block lifting while
// the game is still running needs to take it down by hand.
const PENDING_BANNER_ID = 'chesscom-blocker-pending';

function showPendingBanner() {
    if (document.getElementById(PENDING_BANNER_ID) !== null) {
        return;
    }
    const banner = document.createElement('div');
    banner.id = PENDING_BANNER_ID;
    banner.textContent = 'Chess Blocker: Chess.com will be blocked after this game ends.';
    Object.assign(banner.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: '2147483647',
        backgroundColor: 'rgb(48, 46, 43)',
        color: 'white',
        textAlign: 'center',
        padding: '8px',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.5)'
    });
    document.body.appendChild(banner);
}

function removePendingBanner() {
    document.getElementById(PENDING_BANNER_ID)?.remove();
}

// chess.com navigates in-page, so re-check the URL rather than trusting the
// manifest's content_scripts match alone
function blockIfNeeded(blocked, { waitForGameEnd = false } = {}) {
    if (blocked !== true || !GAME_PAGE_PATTERN.test(window.location.href)) {
        return;
    }
    if (waitForGameEnd && gameInProgress()) {
        // A block that arrived mid-game: let the current game finish first
        blockAfterGame = true;
        showPendingBanner();
        return;
    }
    showBlockedPage();
}

// A reload in the middle of a game: the controls are already up when the
// script arrives, before the first urlWatch tick looks for them
liveGameSeenHere = document.querySelector(LIVE_GAME_SELECTOR) !== null;

// Ask for a fresh count, and apply whatever the last one decided in the meantime
sendToBackground({ action: 'checkGamesPlayed' });
extensionApi.storage.local.get({ blocked: false }).then((items) => blockIfNeeded(items.blocked));

extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.blocked) {
        return;
    }
    if (changes.blocked.newValue === false) {
        blockAfterGame = false;
        removePendingBanner();
        if (blockPageShown) {
            // The counter reset, or the 1-hour block ended; bring the page back
            window.location.reload();
        }
        return;
    }
    // A block that arrives while a game is running waits for it to end
    blockIfNeeded(changes.blocked.newValue, { waitForGameEnd: true });
});

// The game-over card, if this node is it or contains it. chess.com re-arranges
// its markup from time to time, so match the node itself and its descendants
// rather than assuming the card is added as the node we are handed.
function gameOverCard(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return null;
    }
    return node.matches(GAME_OVER_SELECTOR) ? node : node.querySelector(GAME_OVER_SELECTOR);
}

// Watch for the game-over card. This runs for every node chess.com adds to a
// busy single-page app - clock ticks, move-list rows, animations - so the one
// comparison that rules out the whole batch comes before any selector work.
// Game activity after this URL's game already ended means a new game began
// here without a navigation
function newGameActivity(node) {
    return node.nodeType === Node.ELEMENT_NODE
        && (node.matches(NEW_GAME_ACTIVITY_SELECTOR)
            || node.querySelector(NEW_GAME_ACTIVITY_SELECTOR) !== null);
}

function handleMutations(mutationsList) {
    // One game end can render the card more than once
    const debounced = Date.now() - lastGameOverAt < GAME_OVER_DEBOUNCE_MS;
    if (debounced && !gameOverSeenHere) {
        return;
    }
    for (const mutation of mutationsList) {
        if (mutation.type !== 'childList') {
            continue;
        }
        for (const addedNode of mutation.addedNodes) {
            // Only once the game-over modal is gone: while it is up, replaying
            // the finished game inside it must not look like a new one
            if (gameOverSeenHere && newGameActivity(addedNode)
                && document.querySelector(GAME_OVER_SELECTOR) === null) {
                // A new game is being played on this same URL (a rematch), so
                // a block arriving mid-game must wait for its end again
                // rather than replacing a live board
                gameOverSeenHere = false;
                continue;
            }
            if (debounced) {
                continue;
            }
            const card = gameOverCard(addedNode);
            if (card !== null) {
                handleGameOver(card);
                return;
            }
        }
    }
}

// A game just ended. Report it to the background right away, with whether the
// rating change says we lost; either way ask for a recount once the API has
// caught up. A block that was waiting for this game goes up once it is in.
function handleGameOver(card) {
    lastGameOverAt = Date.now();
    gameOverSeenHere = true;
    debugLog('game over: card appeared', card.className);

    // The bare old card on a page whose game was never live is a finished
    // game being viewed, not a game ending: opening one from the archive
    // renders the same card, and reporting it would record a phantom game
    // timed now - which the archive can never reconcile, since the real game
    // ended long ago. gameOverSeenHere stays set: the game here is indeed
    // over, so a block must not wait on it.
    if (card.matches(OLD_CARD_SELECTOR) && !liveGameSeenHere) {
        debugLog('game over: ignoring the bare card - no game was ever live'
            + ' on this URL, so this is a finished game being viewed');
        return;
    }

    const reported = reportGameOver(card, lastGameOverAt);
    setTimeout(() => sendToBackground({ action: 'checkGamesPlayed' }), API_CATCH_UP_DELAY_MS);

    if (!blockAfterGame) {
        return;
    }
    // The block waits for the game to be recorded: the result can only be read
    // off a card that is still on screen, and showBlockedPage replaces the page
    // it is on. Blocking without it would leave the last game of the day
    // uncounted until the archive published it, hours later. `blockAfterGame`
    // stays set until then, so starting another game meanwhile still blocks.
    reported.then(() => {
        blockAfterGame = false;
        showBlockedPage();
    });
}

// Whether the finished game was lost: true or false once the card says, or
// null while it does not say yet. No rating element at all means this is not
// a rated game of the bottom player's, so it is not ours to count.
function readRatingChange(card) {
    const ratingChangeElement = card.querySelector(RATING_CHANGE_SELECTOR);
    if (ratingChangeElement === null) {
        return null;
    }
    const ratingChange = Number.parseInt(ratingChangeElement.textContent.trim(), 10);
    return Number.isFinite(ratingChange) ? ratingChange : null;
}

function detectLoss(card, lastTry = false) {
    if (card.querySelector(RATED_GAME_SELECTOR) === null) {
        return null;
    }

    // Prefer the stated result; a draw counts as not lost, matching how the
    // background classifies games from the API archive
    const headerClass = card.querySelector(RESULT_HEADER_SELECTOR)?.className ?? '';
    const title = card.querySelector(RESULT_TITLE_SELECTOR)?.textContent ?? '';
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
    // rated-game marker above says this is the user's own game, their own win
    // is always phrased "You Won!", and a draw was caught as "Draw" - so the
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
    // result, appear and outrank this card (see reportGameOver). Only once
    // the polling is exhausted is a mild delta taken at face value.
    const ratingChange = readRatingChange(card);
    if (ratingChange === null) {
        return null;
    }
    if (ratingChange < LOSS_RATING_CHANGE) {
        return true;
    }
    return lastTry ? false : null;
}

// Tell the background a game just ended, timing it at `seenAt` - when its card
// appeared - rather than at whatever moment the result became readable. The
// background keeps its own record of the game, because chess.com's public
// archive can take hours to publish one.
//
// Parts of the card can render after the card itself, so retry a few times; if
// a result never shows up, the game is not counted. chess.com re-renders the
// modal, so a poll whose node was swapped out picks up the live one rather
// than giving up. Resolves once the game has been reported or given up on, so
// a block waiting on it knows when the card has been read for the last time.
function reportGameOver(card, seenAt, attempt = 0) {
    // The modal outranks the old card even when the card is what tripped the
    // observer: rechecked on every poll, so a modal that renders moments
    // after the card is still the one that gets read.
    const modal = document.querySelector(MODAL_SELECTOR);
    const current = modal ?? (card.isConnected ? card : (document.querySelector(GAME_OVER_SELECTOR) ?? card));
    const lost = detectLoss(current, attempt >= RATING_POLL_ATTEMPTS);
    if (lost === null) {
        if (attempt >= RATING_POLL_ATTEMPTS) {
            debugLog('game over: gave up after', attempt + 1, 'attempts - no result or'
                + ' rating change could be read from the card, so this game is NOT counted.'
                + ' Card at the end:', current.outerHTML.slice(0, 500));
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            setTimeout(
                () => resolve(reportGameOver(current, seenAt, attempt + 1)),
                RATING_POLL_INTERVAL_MS
            );
        });
    }
    debugLog(`game over: reporting lost=${lost} after ${attempt + 1} attempt(s)`);
    return sendToBackground({
        action: 'GAME_OVER',
        lost,
        endTime: Math.round(seenAt / 1000)
    });
}

// Watch the whole document: the old game-over card rendered inside the player
// box, but the v6 modal is an overlay mounted elsewhere in the page, so
// narrowing the observer to the board would miss it.
const observer = new MutationObserver(handleMutations);
observer.observe(document.body, { childList: true, subtree: true });

// ============ Detecting the chess.com username ============
//
// The popup offers whatever lands here as a one-click alternative to typing a
// username. It is only ever a suggestion: nothing is counted or blocked
// against it until the user picks it, because the account they are logged into
// is not necessarily the one they want tracked.

// What detectUsername.js tags its messages with
const DETECT_MESSAGE_SOURCE = 'chesscom-blocker-username';

// How long to keep looking for the page global before giving up (Firefox; on
// Chrome detectUsername.js does its own waiting)
const DETECT_POLL_INTERVAL_MS = 500;
const DETECT_POLL_ATTEMPTS = 10;

// The last name written, so navigating between games does not rewrite it
let lastDetected = null;

function rememberDetectedUsername(name) {
    const username = normalizeUsername(name);
    if (username === null) {
        debugLog('detection: ignoring a name that is not a chess.com username:', name);
        return;
    }
    if (username === lastDetected) {
        debugLog(`detection: "${username}" is already stored, leaving it alone`);
        return;
    }
    lastDetected = username;
    extensionApi.storage.local.set({ detectedUsername: username }).then(() => {
        debugLog(`detection: stored "${username}" - the popup can now offer it`);
    }).catch((error) => {
        console.warn('Could not store the detected chess.com username:', error);
    });
}

// Firefox (Manifest V2): Xray vision lets a content script reach the page's
// own globals directly, so no injected script is involved. `wrappedJSObject`
// does not exist on Chrome, which is what keeps this from running there.
function detectFromPageGlobals(attempt = 0) {
    const pageWindow = window.wrappedJSObject;
    if (!pageWindow) {
        if (attempt === 0) {
            debugLog('detection: no wrappedJSObject here, so this is Chrome -'
                + ' waiting for detectUsername.js to post the name instead');
        }
        return;
    }
    let username = null;
    try {
        username = pageWindow.context?.user?.username ?? null;
    } catch (error) {
        // The page will not let us look; the popup keeps its text field
        debugLog('detection: the page would not let us read window.context:', error);
        return;
    }
    if (username === null) {
        debugLog(`detection: attempt ${attempt + 1}/${DETECT_POLL_ATTEMPTS + 1},`
            + ' window.context.user.username is not there yet');
        if (attempt < DETECT_POLL_ATTEMPTS) {
            setTimeout(() => detectFromPageGlobals(attempt + 1), DETECT_POLL_INTERVAL_MS);
        } else {
            debugLog('detection: gave up. If you are logged in, chess.com has'
                + ' probably moved window.context.user.username.');
        }
        return;
    }
    rememberDetectedUsername(username);
}

debugLog('content script running on', window.location.href);
detectFromPageGlobals();

// Chrome (Manifest V3): detectUsername.js runs in the page's world and posts
// the name here. Anything on the page can post a message, so take only our
// own, from this window, on this origin - and hand it to normalizeUsername
// before it is stored either way.
window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
        return;
    }
    if (event.data?.source !== DETECT_MESSAGE_SOURCE) {
        return;
    }
    debugLog('detection: the page-world script posted', event.data.username);
    rememberDetectedUsername(event.data.username);
});

// chess.com is a single-page app: it swaps the board and changes the URL
// without reloading. This tick follows the URL, and stops a pending block from
// being dodged by starting a new game in-page.
let lastHref = window.location.href;
const urlWatch = setInterval(() => {
    if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        // A new URL is a new game: let its card be handled afresh, and let it
        // prove it is live all over again
        gameOverSeenHere = false;
        lastGameOverAt = 0;
        liveGameSeenHere = false;
        if (blockAfterGame) {
            blockAfterGame = false;
            blockIfNeeded(true);
        }
    }
    if (!liveGameSeenHere && document.querySelector(LIVE_GAME_SELECTOR) !== null) {
        liveGameSeenHere = true;
        debugLog('a live game is being played on this URL');
    }
}, 1000);
