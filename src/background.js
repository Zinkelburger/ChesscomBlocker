// Background script: fetches the user's games, counts losses, and decides
// whether the chess.com play pages should be blocked.
//
// On Chrome this runs as a Manifest V3 service worker and has to pull in its
// dependencies itself. On Firefox (Manifest V2) the manifest lists shared.js
// and lossCounter.js ahead of this file, and importScripts does not exist.
if (typeof importScripts === 'function') {
    importScripts('shared.js', 'lossCounter.js');
}

// Alarm that re-checks when the counter is due to clear itself
const RESET_ALARM = 'reset-window';

// Minimum lead time the alarms API accepts; Chrome silently clamps to this
const MIN_ALARM_DELAY_MS = 60000;

// Fetch one monthly archive, honouring the ETag we cached for it last time.
// Returns { etag, games } on success, the cached entry if the API is
// unreachable and we have one, or null if there is nothing usable.
async function fetchArchive(url, cached) {
    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    let response;
    try {
        response = await fetch(url, { headers });
    } catch (error) {
        console.error(`Chess.com API unreachable for ${url}:`, error);
        return cached ?? null;
    }

    if (response.status === 304 && cached) {
        return cached;
    }
    if (response.ok) {
        const data = await response.json();
        return {
            etag: response.headers.get('ETag'),
            games: Array.isArray(data.games) ? data.games : []
        };
    }
    if (response.status === 404) {
        // Unknown user, or no games at all this month
        return { etag: null, games: [] };
    }
    // 429 (rate limited) or a server error: fall back to whatever we last saw
    console.warn(`Chess.com API returned ${response.status} for ${url}; using cached data if any`);
    return cached ?? null;
}

// All of the user's games from the start of the counting window until now,
// oldest first. Fetches every monthly archive the window touches (one, or two
// right after a month boundary) and keeps a per-URL ETag cache in local storage.
// Returns null if some archive could not be fetched and had no cached copy.
async function fetchGamesSince(username, windowStart, nowMs) {
    const { archiveCache } = await extensionApi.storage.local.get({ archiveCache: {} });

    const urls = archiveMonths(windowStart, nowMs).map(
        (month) => `https://api.chess.com/pub/player/${username}/games/${month}`
    );
    const archives = await Promise.all(urls.map((url) => fetchArchive(url, archiveCache[url])));

    if (archives.some((archive) => archive === null)) {
        return null;
    }

    // Only keep cache entries for the archives currently in use, so the cache
    // does not accumulate old months or old usernames.
    const freshCache = {};
    urls.forEach((url, i) => {
        freshCache[url] = archives[i];
    });
    await extensionApi.storage.local.set({ archiveCache: freshCache });

    return archives.flatMap((archive) => archive.games);
}

// Wake up when the window rolls over, so a block lifts without the user
// having to click anything
async function scheduleResetAlarm(nextReset) {
    await extensionApi.alarms.clear(RESET_ALARM);
    if (!nextReset) {
        return;
    }
    await extensionApi.alarms.create(RESET_ALARM, {
        when: Math.max(nextReset, Date.now() + MIN_ALARM_DELAY_MS)
    });
}

// Recount losses and update the blocked state
async function checkGamesPlayed() {
    const settings = await extensionApi.storage.sync.get({
        maxGames: DEFAULT_MAX_GAMES,
        username: '',
        gameFilters: DEFAULT_FILTERS,
        resetMode: DEFAULT_RESET_MODE
    });

    const username = settings.username.trim().toLowerCase();
    if (!username) {
        return; // Nothing to check until a username is configured
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    const resetMode = normalizeResetMode(settings.resetMode);

    const nowMs = Date.now();
    const windowStart = getWindowStart(nowMs, resetMode);

    const games = await fetchGamesSince(username, windowStart, nowMs);
    if (games === null) {
        return; // Keep the previous result rather than guessing
    }

    const { sessionDisabled } = await extensionApi.storage.session.get({ sessionDisabled: false });
    const { losses, oldestCountedLoss } = countLosses(games, username, windowStart, filters);
    const nextReset = getNextReset(nowMs, resetMode, oldestCountedLoss);

    // Derived state is per-machine (nextReset depends on the local timezone)
    // and rewritten on every check, so it lives in local storage; sync is
    // reserved for the user's settings and has tight write quotas.
    await extensionApi.storage.local.set({
        losses,
        nextReset,
        blocked: !sessionDisabled && losses >= maxGames
    });
    await scheduleResetAlarm(nextReset);
}

// The content script saw a game end in a loss before the API has caught up.
// Block immediately if that loss would hit the limit, instead of letting the
// user squeeze in another game while we wait for chess.com.
async function recordProvisionalLoss() {
    const [{ maxGames }, { losses }, { sessionDisabled }] = await Promise.all([
        extensionApi.storage.sync.get({ maxGames: DEFAULT_MAX_GAMES }),
        extensionApi.storage.local.get({ losses: 0 }),
        extensionApi.storage.session.get({ sessionDisabled: false })
    ]);
    if (sessionDisabled) {
        return;
    }
    if (losses + 1 >= normalizeMaxGames(maxGames)) {
        await extensionApi.storage.local.set({ blocked: true });
    }
}

// Re-check whenever a tab lands on a game or play page. The content script
// also asks on injection; this catches chess.com's in-page navigation, which
// changes the URL without re-injecting anything.
extensionApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url && GAME_PAGE_PATTERN.test(changeInfo.url)) {
        checkGamesPlayed();
    }
});

// The window rolled over (midnight passed, or the oldest loss aged out)
extensionApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESET_ALARM) {
        checkGamesPlayed();
    }
});

// Make sure an alarm exists after a browser restart or an update
extensionApi.runtime.onStartup.addListener(checkGamesPlayed);
extensionApi.runtime.onInstalled.addListener(async () => {
    // Tidy up keys from earlier layouts: the single-URL cache, and derived
    // state that used to be written to sync. checkGamesPlayed rebuilds both.
    await Promise.all([
        extensionApi.storage.local.remove(['cachedEtag', 'cachedGames', 'cacheUrl']),
        extensionApi.storage.sync.remove(['losses', 'nextReset', 'blocked'])
    ]);
    checkGamesPlayed();
});

// Messages from the popup and the content script. None of them expect a
// reply, so the listener deliberately returns nothing.
extensionApi.runtime.onMessage.addListener((request) => {
    if (request.action === 'checkGamesPlayed') {
        checkGamesPlayed();
    } else if (request.action === 'LOSS_DETECTED') {
        recordProvisionalLoss();
    }
});
