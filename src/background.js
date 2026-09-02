// Background script: fetches the user's games, counts losses, and decides
// whether the chess.com play pages should be blocked.
//
// On Chrome this runs as a Manifest V3 service worker and has to pull in its
// dependencies itself. On Firefox (Manifest V2) the manifest lists shared.js,
// lossCounter.js and chessApi.js ahead of this file, and importScripts does
// not exist.
if (typeof importScripts === 'function') {
    importScripts('shared.js', 'lossCounter.js', 'chessApi.js');
}

// Alarm that re-checks when the counter is due to clear itself
const RESET_ALARM = 'reset-window';

// Minimum lead time the alarms API accepts. Chrome 120 and later allow half a
// minute; earlier versions clamp it to a minute themselves, with a warning.
const MIN_ALARM_DELAY_MS = 30000;

// All of the user's games from the start of the counting window until now,
// oldest first. Fetches every monthly archive the window touches - one, or two
// right after a month boundary - one request at a time. Returns null if some
// archive could not be fetched and had no cached copy.
function fetchGamesSince(username, windowStart, nowMs) {
    return fetchArchivedGames(username, archiveMonths(windowStart, nowMs));
}

// ============ The local game ledger ============
//
// Games the content script saw end, kept until chess.com's archive publishes
// them (see lossCounter.js). Both the content script's appends and the
// resolve/prune pass at the end of a check rewrite the same key, and a check
// spends seconds waiting on the network in between, so every write goes
// through this queue: it re-reads inside the queue, so an append that lands
// mid-check is not overwritten by the check's own write.
let ledgerWrites = Promise.resolve([]);

function updateLedger(update) {
    const write = ledgerWrites.then(async () => {
        const { localGames } = await extensionApi.storage.local.get({ localGames: [] });
        const next = update(Array.isArray(localGames) ? localGames : []);
        await extensionApi.storage.local.set({ localGames: next });
        return next;
    });
    // The queue survives a failed write, but the failure stays the caller's:
    // resolving it to an empty ledger here would count zero local games and
    // could lift a block that ledger-only games were sustaining.
    ledgerWrites = write.catch(() => []);
    return write;
}

async function readLedger() {
    const { localGames } = await extensionApi.storage.local.get({ localGames: [] });
    return Array.isArray(localGames) ? localGames : [];
}

// How far this machine's clock is from chess.com's, as last measured off an
// API response (see chessApi.js); 0 until one has been seen. The ledger
// matches record times against server timestamps within a few minutes, which
// a clock that is minutes off would silently break in both directions.
async function storedClockSkewMs() {
    const { clockSkewMs } = await extensionApi.storage.local.get({ clockSkewMs: 0 });
    return typeof clockSkewMs === 'number' ? clockSkewMs : 0;
}

// Wake up when the window rolls over (or a 1-hour block ends), so a block
// lifts without the user having to click anything
async function scheduleResetAlarm(when) {
    await extensionApi.alarms.clear(RESET_ALARM);
    if (!when) {
        return;
    }
    await extensionApi.alarms.create(RESET_ALARM, {
        when: Math.max(when, Date.now() + MIN_ALARM_DELAY_MS)
    });
}

// The archive's share of the last successful count, kept so an unreachable
// archive does not reset the counter to zero
const EMPTY_COUNT = { losses: 0, games: 0, oldestCountedLoss: null, oldestCountedGame: null };

// ============ The 1-hour block ============
//
// "Block chess.com for 1 hour" in the popup. Two keys in local storage:
//   hourBlockUntil        the deadline, once the block is on screen
//   hourBlockRequestedAt  the click, while a live game is holding the block
//                         back; the hour starts when that game ends
// Only the second exists while a game is running somewhere: with no live game
// the hour starts at the click (requestHourBlock). Both expire on their own.

async function activeHourBlock(nowMs) {
    const { hourBlockUntil } = await extensionApi.storage.local.get({ hourBlockUntil: null });
    if (typeof hourBlockUntil === 'number' && hourBlockUntil > nowMs) {
        return hourBlockUntil;
    }
    if (hourBlockUntil !== null) {
        await extensionApi.storage.local.remove('hourBlockUntil');
    }
    return null;
}

// When the block was asked for, if a game is still holding it back, or null.
// The request expires an hour after the click: the page that would convert it
// may have been closed, and it would otherwise block forever - and greet a
// visit days later with a fresh hour nobody asked for.
async function hourBlockRequestedAt(nowMs) {
    const { hourBlockRequestedAt: since } = await extensionApi.storage.local.get({ hourBlockRequestedAt: null });
    if (typeof since !== 'number') {
        return null;
    }
    if (nowMs - since >= HOUR_BLOCK_MS) {
        await extensionApi.storage.local.remove('hourBlockRequestedAt');
        return null;
    }
    return since;
}

// Whether some open game page has a game running on it. Each page is asked,
// since only the content script there can tell a live board from an idle
// one. A tab with no content script in it (open since before the extension
// was installed) cannot answer and cannot be blocked either, so it counts as
// no game. Querying by URL needs the host permissions the manifest already
// has; should the browser refuse anyway, the answer is no game, which blocks
// right away - the safe way to be wrong.
async function liveGameOpen() {
    let tabs;
    try {
        tabs = await extensionApi.tabs.query({ url: GAME_PAGE_MATCH_PATTERNS });
    } catch (error) {
        return false;
    }
    const answers = await Promise.all(tabs.map((tab) => Promise.resolve()
        .then(() => extensionApi.tabs.sendMessage(tab.id, { action: 'gameInProgress' }))
        .catch(() => false)));
    return answers.some((answer) => answer === true);
}

// The popup's button. With a game running somewhere the block waits for it
// to end (and the hour starts then, so a long game does not eat most of it);
// otherwise the hour starts now.
async function requestHourBlock() {
    if (await liveGameOpen()) {
        await extensionApi.storage.local.set({ hourBlockRequestedAt: Date.now() });
    } else {
        await extensionApi.storage.local.set({ hourBlockUntil: Date.now() + HOUR_BLOCK_MS });
        await extensionApi.storage.local.remove('hourBlockRequestedAt');
    }
    await checkGamesPlayed();
}

// The block is on screen now, so the hour starts now. Returns the deadline for
// the page to count down from.
async function beginHourBlock() {
    const nowMs = Date.now();
    const until = await activeHourBlock(nowMs);
    const requestedAt = await hourBlockRequestedAt(nowMs);
    if (requestedAt === null) {
        return until;
    }
    const deadline = nowMs + HOUR_BLOCK_MS;
    await extensionApi.storage.local.set({ hourBlockUntil: deadline });
    await extensionApi.storage.local.remove('hourBlockRequestedAt');
    // Answer the waiting page first; the recount (which arms the alarm that
    // lifts the block at the deadline) can take a network round trip
    checkGamesPlayed();
    return deadline;
}

async function endHourBlock() {
    await extensionApi.storage.local.remove(['hourBlockUntil', 'hourBlockRequestedAt']);
    await checkGamesPlayed();
}

// ============ The master switch ============

// Whether the master switch is off - "paused" in the UI, matching the
// storage key. `unpauseOnRestart` keeps its name too, so an existing install
// keeps its setting. It lives in local storage so it can outlive a browser
// restart when the user wants it to (see onStartup below).
async function isPaused() {
    const { paused } = await extensionApi.storage.local.get({ paused: false });
    return paused === true;
}

// The popup's Pause/Resume pill. The popup does not offer to pause while a
// 1-hour block is up - the pill ends the block instead, and only goes back to
// being the switch once it is gone - so this drops any block it finds only to
// keep a stale popup from leaving one behind to be revived by the next Resume.
async function setPaused(paused) {
    await extensionApi.storage.local.set({ paused });
    if (paused) {
        await extensionApi.storage.local.remove(['hourBlockUntil', 'hourBlockRequestedAt']);
    }
    await checkGamesPlayed();
}

// ============ The check ============

// Everything the extension derives is about one account: the ledger of games
// the content script saw, the archive's share of the last count, the pool
// totals the ledger is placed against, and the ratings the popup shows.
// Carried across a change of username they would count the old account's
// games under the new name, and - while the new name's first fetch is still
// failing - block on numbers that were never its own. The cached API responses
// are keyed by a path that carries the username, so they could never be read
// back for the wrong account; they go only to save the space. The settings
// themselves are the user's and are left alone.
async function forgetOtherAccount(username) {
    const { trackedUsername } = await extensionApi.storage.local.get({ trackedUsername: null });
    if (trackedUsername === username) {
        return;
    }
    if (trackedUsername === null) {
        // First check since this key existed - an update, or a fresh install.
        // Everything stored was derived for the configured account, so stamp
        // it as theirs rather than wiping it: right after an update, a wipe
        // plus an API outage would lift an active block.
        await extensionApi.storage.local.set({ trackedUsername: username });
        return;
    }
    // Through the queue, so an append that is in flight is not resurrected
    await updateLedger(() => []);
    await extensionApi.storage.local.remove(['archiveCounted', 'apiCache', 'ratings', 'poolTotals']);
    // limitHit is the verdict rating mode holds on to while the API is
    // unreachable, so it is the old account's too
    await extensionApi.storage.local.set({ trackedUsername: username, limitHit: false });
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

    const username = normalizeUsername(settings.username);
    await forgetOtherAccount(username);

    // The master switch and the 1-hour block are decided locally, so read them
    // before any fetch: they have to take effect even while the API is
    // unreachable, and even before a username is configured.
    const paused = await isPaused();
    const hourBlockUntil = await activeHourBlock(Date.now());
    const requestedAt = await hourBlockRequestedAt(Date.now());
    const hourBlockPendingUntil = requestedAt === null ? null : requestedAt + HOUR_BLOCK_MS;

    if (!username) {
        // Nothing to count until a username is configured, but a 1-hour
        // block still blocks on its own
        const nowMs = Date.now();
        await extensionApi.storage.local.set({
            blocked: !paused && (hourBlockUntil !== null || hourBlockPendingUntil !== null)
        });
        await scheduleResetAlarm(earliest(upcoming(hourBlockUntil, nowMs), hourBlockPendingUntil));
        return;
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    const resetMode = normalizeResetMode(settings.resetMode);
    const blockMode = normalizeBlockMode(settings.blockMode);
    const ratingFloor = normalizeRatingBound(settings.ratingFloor);
    const ratingCeiling = normalizeRatingBound(settings.ratingCeiling);

    // The window can only move forward while the fetch is in flight, so the
    // archives chosen now still cover it; the count itself uses a fresh clock.
    // Rating mode needs the stats endpoint; so does placing a locally recorded
    // game in a time control - and for that the copy has to be fresh, since
    // the record is placed by how the totals moved since the last look.
    // Asking otherwise would double the request rate for nothing, so `stats`
    // stays undefined when nothing needs it.
    const unplaced = hasUnclassifiedLocalGames(await readLedger());
    const needStats = blockMode === 'rating' || unplaced;
    const games = await fetchGamesSince(username, getWindowStart(Date.now(), resetMode), Date.now());
    const stats = needStats ? await fetchPlayerStats(username, { fresh: unplaced }) : undefined;

    const nowMs = Date.now();
    const clockSkewMs = await storedClockSkewMs();
    // The ledger's timestamps live on chess.com's clock (see recordGameOver),
    // so the "now" they are resolved and pruned against does too
    const nowSeconds = Math.round((nowMs + clockSkewMs) / 1000);
    // The pool totals the previous stats response carried, against which the
    // new one says how many games each pool gained (see classifyLocalGames)
    const { poolTotals: previousTotals } = await extensionApi.storage.local.get({ poolTotals: null });
    // Games the archive has published are dropped from the ledger, so they are
    // never counted from both places. With the archive unreachable nothing can
    // be shown to be published, so nothing is dropped.
    const localGames = await updateLedger(
        (current) => pruneLocalGames(
            resolveLocalGames(current, stats ?? null, nowSeconds, previousTotals),
            games ?? [],
            nowSeconds
        )
    ).catch((error) => {
        // A failed rewrite is not an empty ledger: count what is stored,
        // unpruned - briefly over-counting is the safe direction for a blocker
        console.error('Local game ledger update failed:', error);
        return readLedger();
    });
    if (stats) {
        await extensionApi.storage.local.set({ poolTotals: poolTotals(stats) });
    }
    const windowStart = getWindowStart(nowMs, resetMode);
    const localCounted = countLocalGames(localGames, windowStart, filters);

    // An unreachable archive falls back to its share of the last successful
    // count rather than guessing. The ledger is still counted on top of it, so
    // a game played during an outage blocks on its own, and the master switch
    // and the 1-hour block still apply.
    const outage = games === null;
    let archiveCounted;
    if (outage) {
        const stored = await extensionApi.storage.local.get({ archiveCounted: EMPTY_COUNT });
        archiveCounted = { ...EMPTY_COUNT, ...stored.archiveCounted };
    } else {
        archiveCounted = countLosses(games, username, windowStart, filters);
        await extensionApi.storage.local.set({ archiveCounted });
    }
    const counted = mergeCounts(archiveCounted, localCounted);

    const { limitHit: lastLimitHit } = await extensionApi.storage.local.get({ limitHit: false });
    const verdict = decideBlock({
        nowMs, blockMode, maxGames, resetMode, filters, ratingFloor, ratingCeiling,
        counted, outage, stats: stats ?? null, lastLimitHit, localGames, clockSkewMs,
        paused, hourBlockUntil, hourBlockPendingUntil
    });

    // Derived state is per-machine (nextReset depends on the local timezone)
    // and rewritten on every check, so it lives in local storage; sync is
    // reserved for the user's settings and has tight write quotas.
    await extensionApi.storage.local.set({
        losses: counted.losses,
        games: counted.games,
        ...(verdict.ratings === null ? {} : { ratings: verdict.ratings }),
        nextReset: verdict.nextReset,
        limitHit: verdict.limitHit,
        blocked: verdict.blocked
    });
    await scheduleResetAlarm(verdict.wakeAt);
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

// The content script saw a game end. chess.com's archive can take hours to
// publish it, so the game goes into the local ledger and is counted from there
// until it does; the check that follows applies the limit to it right away.
async function recordGameOver(lost, endTime) {
    // The content script timed the game on this machine's clock; shift it
    // onto chess.com's, since it will be matched against the archive's and
    // the stats endpoint's timestamps
    const endTimeOnServer = endTime + Math.round(await storedClockSkewMs() / 1000);
    await updateLedger((current) => appendLocalGame(current, {
        endTime: endTimeOnServer,
        lost,
        // Filled in by resolveLocalGames once the stats endpoint says which
        // rated pool moved at this moment
        timeClass: null
    })).catch((error) => console.error('Could not record the finished game:', error));
    await checkGamesPlayed();
}

// ============ Storage from earlier builds ============

// Keys older builds wrote. The 1-hour block used to be stored as `breakUntil`
// and `breakPending` (a plain `true` flag at first, the time of the click
// later); both are carried over so an update does not cut a block short. The
// rest are caches that predate chessApi.js, and derived state that used to be
// written to sync - checkGamesPlayed rebuilds both.
async function migrateStorage() {
    const old = await extensionApi.storage.local.get({ breakPending: null, breakUntil: null });
    const carried = {};
    if (old.breakPending === true) {
        carried.hourBlockRequestedAt = Date.now();
    } else if (typeof old.breakPending === 'number') {
        carried.hourBlockRequestedAt = old.breakPending;
    }
    if (typeof old.breakUntil === 'number') {
        carried.hourBlockUntil = old.breakUntil;
    }
    if (Object.keys(carried).length > 0) {
        await extensionApi.storage.local.set(carried);
    }
    await Promise.all([
        extensionApi.storage.local.remove([
            'breakPending', 'breakUntil',
            'cachedEtag', 'cachedGames', 'cacheUrl', 'archiveCache', 'statsCache'
        ]),
        extensionApi.storage.sync.remove(['losses', 'nextReset', 'blocked'])
    ]);
}

// ============ Triggers ============

// Recount whenever a setting lands in storage. The write is what triggers
// it, not a message from the popup: the popup's last edit is flushed to
// storage as it is torn down, too late for any message to survive. This also
// picks up settings synced in from another machine.
extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
        checkGamesPlayed();
    }
});

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

// After a browser restart, switch blocking back on unless the user asked for
// it to stay off, then make sure an alarm exists
extensionApi.runtime.onStartup.addListener(async () => {
    const { unpauseOnRestart } = await extensionApi.storage.sync.get({ unpauseOnRestart: true });
    if (unpauseOnRestart !== false) {
        await extensionApi.storage.local.set({ paused: false });
    }
    await checkGamesPlayed();
});
extensionApi.runtime.onInstalled.addListener(async () => {
    await migrateStorage();
    checkGamesPlayed();
});

// Messages from the popup and the content script. Only checkUsername and
// beginHourBlock expect a reply; the rest deliberately return nothing.
extensionApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkUsername') {
        // The popup could ask chess.com itself, but its queue would be a
        // separate one: two contexts each fetching serially still add up to
        // parallel access. Answering from here keeps it to one queue.
        fetchPlayerExists(request.username).then(sendResponse, () => sendResponse('unknown'));
        return true; // Chrome needs this to keep the channel open
    }
    if (request.action === 'beginHourBlock') {
        // The content script waits for the deadline before drawing its
        // countdown, so this one answers
        beginHourBlock().then(sendResponse, () => sendResponse(null));
        return true;
    }
    if (request.action === 'checkGamesPlayed') {
        checkGamesPlayed();
    } else if (request.action === 'GAME_OVER') {
        recordGameOver(
            request.lost === true,
            typeof request.endTime === 'number' ? request.endTime : Math.round(Date.now() / 1000)
        );
    } else if (request.action === 'setPaused') {
        setPaused(request.paused === true);
    } else if (request.action === 'requestHourBlock') {
        requestHourBlock();
    } else if (request.action === 'endHourBlock') {
        endHourBlock();
    }
});
