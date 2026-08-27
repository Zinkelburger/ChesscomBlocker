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

// How long to wait before trying again when the API could not be reached
const RETRY_DELAY_MS = 5 * 60000;

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

// Wake up when the window rolls over (or a break ends), so a block lifts
// without the user having to click anything
async function scheduleResetAlarm(when) {
    await extensionApi.alarms.clear(RESET_ALARM);
    if (!when) {
        return;
    }
    await extensionApi.alarms.create(RESET_ALARM, {
        when: Math.max(when, Date.now() + MIN_ALARM_DELAY_MS)
    });
}

// Earliest of the given times, ignoring nulls; null if there are none
function earliest(...times) {
    const valid = times.filter((time) => typeof time === 'number');
    return valid.length ? Math.min(...valid) : null;
}

// A break ("Block after this game") is a plain deadline in local storage.
// Once it passes it is removed so the popup and content script see it as over.
async function activeBreak(nowMs) {
    const { breakUntil } = await extensionApi.storage.local.get({ breakUntil: null });
    if (typeof breakUntil === 'number' && breakUntil > nowMs) {
        return breakUntil;
    }
    if (breakUntil !== null) {
        await extensionApi.storage.local.remove('breakUntil');
    }
    return null;
}

// Recount losses and update the blocked state
async function runCheck() {
    const settings = await extensionApi.storage.sync.get({
        maxGames: DEFAULT_MAX_GAMES,
        username: '',
        gameFilters: DEFAULT_FILTERS,
        resetMode: DEFAULT_RESET_MODE
    });

    const username = settings.username.trim().toLowerCase();
    if (!username) {
        // Nothing to count until a username is configured, but a break
        // still blocks on its own
        const nowMs = Date.now();
        const breakUntil = await activeBreak(nowMs);
        const { sessionDisabled } = await extensionApi.storage.session.get({ sessionDisabled: false });
        await extensionApi.storage.local.set({ blocked: !sessionDisabled && breakUntil !== null });
        await scheduleResetAlarm(breakUntil);
        return;
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    const resetMode = normalizeResetMode(settings.resetMode);

    // The window can only move forward while the fetch is in flight, so the
    // archives chosen now still cover it; the count itself uses a fresh clock.
    const games = await fetchGamesSince(username, getWindowStart(Date.now(), resetMode), Date.now());
    if (games === null) {
        // Keep the previous result rather than guessing, but make sure we
        // come back for another go: a consumed alarm would otherwise leave a
        // block with nothing to lift it.
        await scheduleResetAlarm(Date.now() + RETRY_DELAY_MS);
        return;
    }

    const nowMs = Date.now();
    const windowStart = getWindowStart(nowMs, resetMode);
    const { sessionDisabled } = await extensionApi.storage.session.get({ sessionDisabled: false });
    const breakUntil = await activeBreak(nowMs);
    const { losses, oldestCountedLoss } = countLosses(games, username, windowStart, filters);
    const nextReset = getNextReset(nowMs, resetMode, oldestCountedLoss);

    // Derived state is per-machine (nextReset depends on the local timezone)
    // and rewritten on every check, so it lives in local storage; sync is
    // reserved for the user's settings and has tight write quotas.
    await extensionApi.storage.local.set({
        losses,
        nextReset,
        blocked: !sessionDisabled && (losses >= maxGames || breakUntil !== null)
    });
    await scheduleResetAlarm(earliest(nextReset, breakUntil));
}

// Checks are triggered from many places (tabs, the popup, alarms, startup)
// and each one reads storage, fetches, writes storage and re-arms the alarm.
// Two of those interleaving can leave storage and the alarm disagreeing, so
// run one at a time; a request that arrives mid-run queues exactly one more.
let checkInFlight = null;
let checkRequested = false;

function checkGamesPlayed() {
    if (checkInFlight) {
        checkRequested = true;
        return checkInFlight;
    }
    checkInFlight = runCheck()
        .catch((error) => console.error('Loss check failed:', error))
        .finally(() => {
            checkInFlight = null;
            if (checkRequested) {
                checkRequested = false;
                checkGamesPlayed();
            }
        });
    return checkInFlight;
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

// "Block after this game" from the popup. The content script decides when
// the block actually appears: right away, or once the current game ends.
async function startBreak() {
    await extensionApi.storage.local.set({ breakUntil: Date.now() + BREAK_DURATION_MS });
    await checkGamesPlayed();
}

async function endBreak() {
    await extensionApi.storage.local.remove('breakUntil');
    await checkGamesPlayed();
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
    } else if (request.action === 'startBreak') {
        startBreak();
    } else if (request.action === 'endBreak') {
        endBreak();
    }
});
