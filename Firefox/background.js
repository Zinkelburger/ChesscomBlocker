// Function to check the chess.com API for the number of games played
async function checkGamesPlayed() {
    // Get the maximum number of games and username from browser storage
    let items = await browser.storage.sync.get({
        maxGames: 5,
        username: ''
    });
    let maxGames = items.maxGames;
    let username = items.username.toLowerCase();

    if (!username) {
        return; // No username configured, nothing to check
    }

    // Get the current year and month
    let date = new Date();
    let year = date.getFullYear();
    let month = (date.getMonth() + 1).toString().padStart(2, '0');

    // Construct the URL for the API request
    let url = `https://api.chess.com/pub/player/${username}/games/${year}/${month}`;

    // Get cached ETag and games from local storage
    let cache = await browser.storage.local.get({
        cachedEtag: null,
        cachedGames: null,
        cacheUrl: null
    });

    let data;

    try {
        // Build fetch options with ETag if we have one for this URL
        let fetchOptions = {};
        if (cache.cachedEtag && cache.cacheUrl === url) {
            fetchOptions.headers = { 'If-None-Match': cache.cachedEtag };
        }

        let response = await fetch(url, fetchOptions);

        if (response.status === 304) {
            // Data unchanged, use cached games
            data = { games: cache.cachedGames };
        } else if (response.ok) {
            data = await response.json();
            // Cache the new ETag and games
            let newEtag = response.headers.get('ETag');
            await browser.storage.local.set({
                cachedEtag: newEtag,
                cachedGames: data.games || [],
                cacheUrl: url
            });
        } else if (response.status === 404) {
            // User not found or no games this month
            data = { games: [] };
        } else if (response.status === 429) {
            // Rate limited - use cached data if available, otherwise bail
            console.warn('Chess.com API rate limited (429). Using cached data if available.');
            if (cache.cachedGames) {
                data = { games: cache.cachedGames };
            } else {
                return; // No cached data, can't proceed
            }
        } else {
            console.error(`Chess.com API error: ${response.status} ${response.statusText}`);
            // Use cached data as fallback
            if (cache.cachedGames) {
                data = { games: cache.cachedGames };
            } else {
                return;
            }
        }
    } catch (error) {
        console.error('Failed to fetch from Chess.com API:', error);
        // Network error - use cached data if available
        if (cache.cachedGames) {
            data = { games: cache.cachedGames };
        } else {
            return;
        }
    }

    // Check to make sure data.games exists
    if (!data.games || !Array.isArray(data.games) || !data.games.length) {
        await browser.storage.sync.set({
            losses: 0,
            blocked: 0 >= maxGames
        });
        return;
    }

    // Initialize a counter for the number of losses
    let losses = 0;

    // Get the current Unix timestamp
    let now = Math.round(new Date().getTime() / 1000);
    let i = data.games.length - 1;
    let game;
    // Iterate over the games, back to front, stop when we get more than 24 hours away
    do {
        game = data.games[i];
        if (game.white.username.toLowerCase() === username && game.black.result === 'win') {
            losses++;
        } else if (game.black.username.toLowerCase() === username && game.white.result === 'win') {
            losses++;
        }
        i--;
    } while (now - game.end_time <= 86400 && i >= 0);

    // Update the number of losses in browser.storage
    await browser.storage.sync.set({
        losses: losses,
        blocked: losses >= maxGames
    });
}

// Run checkGamesPlayed when the extension is clicked
// firefox uses browserAction, chrome uses action
browser.browserAction.onClicked.addListener((tab) => {
    checkGamesPlayed();
});

// Run checkGamesPlayed when on the game or play pages
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const chessPattern = /https?:\/\/.*chess\.com\/(game|play\/online)/;

    if (changeInfo.url && chessPattern.test(changeInfo.url)) {
        checkGamesPlayed();
    }
});

browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'checkGamesPlayed') {
        checkGamesPlayed();
    } else if (request.action === 'LOSS_DETECTED') {
        // Check losses and maxGames values
        browser.storage.sync.get(['losses', 'maxGames'], function(result) {
            if ((result.losses + 1) >= result.maxGames) {
                // Set 'blocked' to true
                browser.storage.sync.set({
                    blocked: true
                });
            }
        });

    }
});
