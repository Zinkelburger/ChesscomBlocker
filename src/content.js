// Runs on chess.com game and play pages: swaps the page for a "take a break"
// notice when the loss limit is hit (or a break was started from the popup),
// and tells the background script about losses as soon as they happen so the
// block does not wait on the API.

// Rating changes below this are treated as a loss rather than a draw
const LOSS_RATING_CHANGE = -4;

// How long to wait after a game ends before the chess.com API is likely to
// know about it
const API_CATCH_UP_DELAY_MS = 15000;

let blockPageShown = false;

// Set when a block arrived in the middle of a game; applied once it ends
let blockPending = false;

async function showBlockedPage() {
    blockPageShown = true;

    const { breakUntil } = await extensionApi.storage.local.get({ breakUntil: null });
    const onBreak = typeof breakUntil === 'number' && breakUntil > Date.now();

    const heading = document.createElement('h1');
    heading.textContent = onBreak
        ? `Chess.com Blocker: On break for ${formatCountdown(breakUntil - Date.now())}.`
        : 'Chess.com Blocker: Daily game limit reached. Please take a well-deserved break.';
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
}

// A board is on screen and the game-over card has not appeared yet
function gameInProgress() {
    return document.querySelector('.player-component.player-bottom') !== null
        && document.querySelector('.player-game-over-component') === null;
}

// chess.com navigates in-page, so re-check the URL rather than trusting the
// manifest's content_scripts match alone
function blockIfNeeded(blocked, { waitForGameEnd = false } = {}) {
    if (blocked !== true || !GAME_PAGE_PATTERN.test(window.location.href)) {
        return;
    }
    if (waitForGameEnd && gameInProgress()) {
        // "Block after this game": let the current game finish
        blockPending = true;
        return;
    }
    showBlockedPage();
}

// Ask for a fresh count, and apply whatever the last one decided in the meantime
sendToBackground({ action: 'checkGamesPlayed' });
extensionApi.storage.local.get({ blocked: false }).then((items) => blockIfNeeded(items.blocked));

extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.blocked) {
        return;
    }
    if (changes.blocked.newValue === false) {
        blockPending = false;
        if (blockPageShown) {
            // The window rolled over or the break ended; bring the real page back
            window.location.reload();
        }
        return;
    }
    // A block that arrives while a game is running waits for it to end
    blockIfNeeded(changes.blocked.newValue, { waitForGameEnd: true });
});

// Watch for the game-over card. If the rating change says we lost, tell the
// background right away; either way ask for a recount once the API has caught up.
function handleMutations(mutationsList) {
    for (const mutation of mutationsList) {
        if (mutation.type !== 'childList') {
            continue;
        }
        for (const addedNode of mutation.addedNodes) {
            if (!addedNode.classList?.contains('player-game-over-component')) {
                continue;
            }
            if (blockPending) {
                blockPending = false;
                showBlockedPage();
                return;
            }
            const ratingChangeElement = addedNode.querySelector('.rating-score-change');
            if (ratingChangeElement) {
                const ratingChange = Number.parseInt(ratingChangeElement.textContent.trim(), 10);
                if (ratingChange < LOSS_RATING_CHANGE) {
                    sendToBackground({ action: 'LOSS_DETECTED' });
                }
            }
            setTimeout(() => sendToBackground({ action: 'checkGamesPlayed' }), API_CATCH_UP_DELAY_MS);
        }
    }
}

function startObserving() {
    const targetNode = document.querySelector('.player-component.player-bottom');
    if (!targetNode) {
        return; // Not a board page (or chess.com changed its markup)
    }
    new MutationObserver(handleMutations).observe(targetNode, {
        childList: true,
        subtree: true
    });
}

startObserving();

// A pending block must not be dodged by starting a new game in-page: chess.com
// changes the URL without reloading, so watch for that too.
let lastHref = window.location.href;
setInterval(() => {
    if (window.location.href === lastHref) {
        return;
    }
    lastHref = window.location.href;
    if (blockPending) {
        blockPending = false;
        blockIfNeeded(true);
    }
}, 1000);
