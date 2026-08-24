// Counting rules live in lossCounter.js (listed first in the manifest's
// background scripts) so the popup and the tests share them

// Session-only disable flag (resets on browser restart since background is persistent)
let sessionDisabled = false;

// Alarm that re-checks when the counter is due to clear itself
const RESET_ALARM = 'reset-window';

// Persist the result of a check and schedule the next automatic re-check
async function applyResult(losses, nextReset, maxGames) {
    await browser.storage.sync.set({
        losses: losses,
        nextReset: nextReset,
        blocked: sessionDisabled ? false : (losses >= maxGames)
    });
    await scheduleResetAlarm(nextReset);
}

// Wake up when the window rolls over, so a block lifts without the user
// having to click anything
async function scheduleResetAlarm(nextReset) {
    await browser.alarms.clear(RESET_ALARM);
    if (!nextReset) {
        return;
    }
    // Alarms are clamped to at least a minute out, so don't ask for less
    browser.alarms.create(RESET_ALARM, { when: Math.max(nextReset, Date.now() + 60000) });
}

// Function to check the chess.com API for the number of games played
async function checkGamesPlayed() {
    // Get the maximum number of games, username, filters, and reset mode from browser storage
    let items = await browser.storage.sync.get({
        maxGames: 5,
        username: '',
        gameFilters: DEFAULT_FILTERS,
        resetMode: DEFAULT_RESET_MODE
    });
    let maxGames = items.maxGames;
    let username = items.username.toLowerCase();
    let filters = { ...DEFAULT_FILTERS, ...items.gameFilters };
    let resetMode = items.resetMode;

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

    let now = date.getTime();

    // Check to make sure data.games exists
    if (!data.games || !Array.isArray(data.games) || !data.games.length) {
        await applyResult(0, getNextReset(now, resetMode, null), maxGames);
        return;
    }

    let windowStart = getWindowStart(now, resetMode);
    let { losses, oldestCountedLoss } = countLosses(data.games, username, windowStart, filters);

    // Update the number of losses in browser.storage
    // If session is disabled, never block
    await applyResult(losses, getNextReset(now, resetMode, oldestCountedLoss), maxGames);
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

// The window rolled over (midnight passed, or the oldest loss aged out)
browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESET_ALARM) {
        checkGamesPlayed();
    }
});

// Make sure an alarm exists after a browser restart or an update
browser.runtime.onStartup.addListener(checkGamesPlayed);
browser.runtime.onInstalled.addListener(checkGamesPlayed);

browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'checkGamesPlayed') {
        checkGamesPlayed();
    } else if (request.action === 'LOSS_DETECTED') {
        // Don't block if session is disabled
        if (sessionDisabled) {
            return;
        }
        // Check losses and maxGames values
        browser.storage.sync.get(['losses', 'maxGames']).then(function(result) {
            if ((result.losses + 1) >= result.maxGames) {
                browser.storage.sync.set({ blocked: true });
            }
        });
    } else if (request.action === 'SET_SESSION_DISABLED') {
        // Toggle session disable state
        sessionDisabled = request.value;
        sendResponse({ sessionDisabled: sessionDisabled });
        checkGamesPlayed();
    } else if (request.action === 'GET_SESSION_DISABLED') {
        // Return current session disable state
        sendResponse({ sessionDisabled: sessionDisabled });
    }
    return true; // Keep message channel open for async response
});
