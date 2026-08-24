// Runs on chess.com game and play pages: swaps the page for a "take a break"
// notice when the loss limit is hit, and tells the background script about
// losses as soon as they happen so the block does not wait on the API.

// Rating changes below this are treated as a loss rather than a draw
const LOSS_RATING_CHANGE = -4;

// How long to wait after a game ends before the chess.com API is likely to
// know about it
const API_CATCH_UP_DELAY_MS = 15000;

function showBlockedPage() {
    const heading = document.createElement('h1');
    heading.textContent = 'Chess.com Blocker: Daily game limit reached. Please take a well-deserved break.';
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

// chess.com navigates in-page, so re-check the URL rather than trusting the
// manifest's content_scripts match alone
function blockIfNeeded(blocked) {
    if (blocked === true && GAME_PAGE_PATTERN.test(window.location.href)) {
        showBlockedPage();
    }
}

// Ask for a fresh count, and apply whatever the last one decided in the meantime
sendToBackground({ action: 'checkGamesPlayed' });
extensionApi.storage.sync.get({ blocked: false }).then((items) => blockIfNeeded(items.blocked));

extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.blocked) {
        blockIfNeeded(changes.blocked.newValue);
    }
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
