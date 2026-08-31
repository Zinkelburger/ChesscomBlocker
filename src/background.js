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

// Rating mode has no reset window, so it re-checks on this interval instead
const RATING_POLL_MS = 15 * 60000;

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

// Current ratings from the stats endpoint, ETag-cached like the archives.
// Returns the parsed stats object, {} for an unknown user, or null when the
// API could not be reached and nothing is cached.
async function fetchStats(username) {
    const url = `https://api.chess.com/pub/player/${username}/stats`;
    const { statsCache } = await extensionApi.storage.local.get({ statsCache: null });
    const cached = statsCache?.url === url ? statsCache : null;

    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    let response;
    try {
        response = await fetch(url, { headers });
    } catch (error) {
        console.error('Chess.com stats unreachable:', error);
        return cached?.stats ?? null;
    }

    if (response.status === 304 && cached) {
        return cached.stats;
    }
    if (response.ok) {
        const stats = await response.json();
        await extensionApi.storage.local.set({ statsCache: { url, etag: response.headers.get('ETag'), stats } });
        return stats;
    }
    if (response.status === 404) {
        return {};
    }
    console.warn(`Chess.com stats returned ${response.status}; using cached data if any`);
    return cached?.stats ?? null;
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

// Pause lives in local storage so it can outlive a browser restart when the
// user wants it to (see the unpauseOnRestart setting and onStartup below)
async function isPaused() {
    const { paused } = await extensionApi.storage.local.get({ paused: false });
    return paused === true;
}

// Recount losses and update the blocked state
async function runCheck() {
    const settings = await extensionApi.storage.sync.get({
        maxGames: DEFAULT_MAX_GAMES,
        username: '',
        gameFilters: DEFAULT_FILTERS,
        resetMode: DEFAULT_RESET_MODE,
        blockMode: DEFAULT_BLOCK_MODE,
        ratingFloor: null,
        ratingCeiling: null
    });

    const username = settings.username.trim().toLowerCase();
    if (!username) {
        // Nothing to count until a username is configured, but a break
        // still blocks on its own
        const nowMs = Date.now();
        const breakUntil = await activeBreak(nowMs);
        const paused = await isPaused();
        await extensionApi.storage.local.set({ blocked: !paused && breakUntil !== null });
        await scheduleResetAlarm(breakUntil);
        return;
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    const resetMode = normalizeResetMode(settings.resetMode);
    const blockMode = normalizeBlockMode(settings.blockMode);
    const ratingFloor = normalizeRatingBound(settings.ratingFloor);
    const ratingCeiling = normalizeRatingBound(settings.ratingCeiling);

    // Pause and breaks are decided locally, so read them before the fetch:
    // they have to take effect even while the API is unreachable.
    const paused = await isPaused();
    const breakUntil = await activeBreak(Date.now());

    // The window can only move forward while the fetch is in flight, so the
    // archives chosen now still cover it; the count itself uses a fresh clock.
    // Only rating mode needs the stats endpoint, and asking for it in the
    // other modes would double the request rate for nothing.
    const [games, stats] = await Promise.all([
        fetchGamesSince(username, getWindowStart(Date.now(), resetMode), Date.now()),
        blockMode === 'rating' ? fetchStats(username) : Promise.resolve({})
    ]);
    if (games === null || stats === null) {
        // Keep the previous count rather than guessing, but still apply the
        // pause and the break, and make sure we come back for another go: a
        // consumed alarm would otherwise leave a block with nothing to lift it.
        const { limitHit: lastLimitHit } = await extensionApi.storage.local.get({ limitHit: false });
        await extensionApi.storage.local.set({
            blocked: !paused && (lastLimitHit === true || breakUntil !== null)
        });
        await scheduleResetAlarm(earliest(Date.now() + RETRY_DELAY_MS, breakUntil));
        return;
    }

    const nowMs = Date.now();
    const windowStart = getWindowStart(nowMs, resetMode);
    const counted = countLosses(games, username, windowStart, filters);

    // The window only matters for the counting modes; in rating mode there is
    // nothing to reset, so no alarm is needed for it either
    let limitHit = false;
    let nextReset = null;
    // Only rating mode fetches stats, so the other modes leave the last known
    // ratings in place rather than blanking the popup's rating list.
    let ratings = null;
    if (blockMode === 'losses') {
        limitHit = counted.losses >= maxGames;
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedLoss);
    } else if (blockMode === 'games') {
        limitHit = counted.games >= maxGames;
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedGame);
    } else {
        ratings = currentRatings(stats, filters);
        limitHit = ratingsOutOfRange(ratings, ratingFloor, ratingCeiling).length > 0;
    }

    // Derived state is per-machine (nextReset depends on the local timezone)
    // and rewritten on every check, so it lives in local storage; sync is
    // reserved for the user's settings and has tight write quotas.
    await extensionApi.storage.local.set({
        losses: counted.losses,
        games: counted.games,
        ...(ratings === null ? {} : { ratings }),
        nextReset,
        limitHit,
        blocked: !paused && (limitHit || breakUntil !== null)
    });

    // Rating mode has no window to reset, so nothing else would ever re-arm
    // the alarm: once a bound is crossed the block would have to be lifted by
    // opening a chess.com game page, which is exactly what is blocked. Poll
    // instead, so a rating that moves back into range clears the block.
    const ratingPoll = blockMode === 'rating' ? nowMs + RATING_POLL_MS : null;
    await scheduleResetAlarm(earliest(nextReset, breakUntil, ratingPoll));
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

// The content script saw a game end before the API has caught up. Block
// immediately if that game would hit the limit, instead of letting the user
// squeeze in another one while we wait for chess.com.
async function recordProvisionalGame(lost) {
    const [settings, state] = await Promise.all([
        extensionApi.storage.sync.get({ maxGames: DEFAULT_MAX_GAMES, blockMode: DEFAULT_BLOCK_MODE }),
        extensionApi.storage.local.get({ losses: 0, games: 0 })
    ]);
    if (await isPaused()) {
        return;
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const blockMode = normalizeBlockMode(settings.blockMode);
    const hit = (blockMode === 'losses' && lost && state.losses + 1 >= maxGames)
        || (blockMode === 'games' && state.games + 1 >= maxGames);
    if (hit) {
        await extensionApi.storage.local.set({ blocked: true });
    }
}

async function setPaused(paused) {
    await extensionApi.storage.local.set({ paused });
    await checkGamesPlayed();
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

// After a browser restart, lift the pause unless the user asked to keep it,
// then make sure an alarm exists
extensionApi.runtime.onStartup.addListener(async () => {
    const { unpauseOnRestart } = await extensionApi.storage.sync.get({ unpauseOnRestart: true });
    if (unpauseOnRestart !== false) {
        await extensionApi.storage.local.set({ paused: false });
    }
    await checkGamesPlayed();
});
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
    } else if (request.action === 'GAME_OVER') {
        recordProvisionalGame(request.lost === true);
    } else if (request.action === 'setPaused') {
        setPaused(request.paused === true);
    } else if (request.action === 'startBreak') {
        startBreak();
    } else if (request.action === 'endBreak') {
        endBreak();
    }
});
