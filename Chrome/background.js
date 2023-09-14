// Function to check the chess.com API for the number of games played
async function checkGamesPlayed() {
    // Get the maximum number of games and username from chrome storage
    let items = await chrome.storage.sync.get({
        maxGames: 5,
        username: ''
    });
    let maxGames = items.maxGames;
    let username = items.username.toLowerCase();

    // Get the current year and month
    let date = new Date();
    let year = date.getFullYear();
    let month = (date.getMonth() + 1).toString().padStart(2, '0');

    // Account for the edge case where it is the first of the month
    if (date.getDate() === 1) {
        month--;
        // first of the year
        if (month === 0) {
            month = 12;
            year--;
        }
    }
    // Construct the URL for the API request
    let url = `https://api.chess.com/pub/player/${username}/games/${year}/${month}`;

    // Fetch data from the chess.com API
    let response = await fetch(url);
    let data = await response.json();

    // Check to make sure data.games exists
    if (!data.games || !Array.isArray(data.games) || !data.games.length) {
        await chrome.storage.sync.set({
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

    // Update the number of losses in chrome.storage
    await chrome.storage.sync.set({
        losses: losses
    });

    // Check if the user has exceeded the maximum number of losses allowed
    if (losses >= maxGames) {
        // Set blocked to true in chrome.storage
        await chrome.storage.sync.set({
            blocked: true
        });
    } else {
        await chrome.storage.sync.set({
            blocked: false
        });
    }
}

// Run checkGamesPlayed when the current site is chess.com
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && changeInfo.url.startsWith("https://www.chess.com/")) {
        checkGamesPlayed();
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'checkGamesPlayed') {
        checkGamesPlayed();
    } else if (request.action === 'LOSS_DETECTED') {
        // Check losses and maxGames values
        chrome.storage.sync.get(['losses', 'maxGames'], function(result) {
            if ((result.losses + 1) >= result.maxGames) {
                // Set 'blocked' to true
                chrome.storage.sync.set({
                    blocked: true
                });
            }
        });

    }
});
