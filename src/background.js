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

// Minimum lead time the alarms API accepts; Chrome silently clamps to this
const MIN_ALARM_DELAY_MS = 60000;

// How long to wait before trying again when the API could not be reached
const RETRY_DELAY_MS = 5 * 60000;

// Rating mode has no reset window, so it re-checks on this interval instead
const RATING_POLL_MS = 15 * 60000;

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

// A time that has not arrived yet, or null. Waking up for one that has already
// passed is not a wake-up at all: scheduleResetAlarm can only clamp it to a
// minute from now, and the check that follows re-arms it just the same. That
// matters during an API outage, where the reset carried over from the last
// good count ages out and would otherwise turn a five-minute retry into a
// wake-up a minute for as long as the outage lasts.
function upcoming(time) {
    return typeof time === 'number' && time > Date.now() ? time : null;
}

// The archive's share of the last successful count, kept so an unreachable
// archive does not reset the counter to zero
const EMPTY_COUNT = { losses: 0, games: 0, oldestCountedLoss: null, oldestCountedGame: null };

// Whether a count trips the limit, for the two counting modes. Rating mode
// has no count and is decided from the stats endpoint instead.
function outOfCountingRange(blockMode, counted, maxGames) {
    if (blockMode === 'losses') {
        return counted.losses >= maxGames;
    }
    if (blockMode === 'games') {
        return counted.games >= maxGames;
    }
    return false;
}

// The popup's 1-hour block is a plain deadline in local storage. Once it passes
// it is removed so the popup and content script see it as over. The storage
// keys still say "break" so an existing install keeps its state; the UI calls
// it "a 1-hour block" throughout, to keep it distinct from the limit and from
// the master blocking switch.
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

// Between the click and the block actually appearing, the 1-hour block is only
// a promise to block: the current game has to finish first. The hour starts
// when the block does (beginBreak below), not when the button is clicked, so a
// long game does not eat most of the hour. The promise expires an hour after
// the click: with no chess.com page around to convert it, it would otherwise
// block forever - and greet a visit days later with a fresh hour nobody asked
// for. Returns when the block was asked for, or null.
async function breakPending(nowMs) {
    const stored = await extensionApi.storage.local.get({ breakPending: false });
    // Older builds stored a plain flag; date it from now so it expires too
    const since = stored.breakPending === true ? nowMs : stored.breakPending;
    if (typeof since !== 'number') {
        return null;
    }
    if (nowMs - since >= BREAK_DURATION_MS) {
        await extensionApi.storage.local.remove('breakPending');
        return null;
    }
    if (stored.breakPending === true) {
        await extensionApi.storage.local.set({ breakPending: since });
    }
    return since;
}

// Whether the master switch is off - "paused" in the UI, matching the
// storage key. `unpauseOnRestart` keeps its name too, so an existing install
// keeps its setting. It lives in local storage so it can outlive a browser
// restart when the user wants it to (see onStartup below).
async function isPaused() {
    const { paused } = await extensionApi.storage.local.get({ paused: false });
    return paused === true;
}

// Everything the extension derives is about one account: the ledger of games
// the content script saw, the archive's share of the last count, and the
// ratings the popup shows. Carried across a change of username they would
// count the old account's games under the new name, and - while the new name's
// first fetch is still failing - block on numbers that were never its own. The
// cached API responses are keyed by a path that carries the username, so they
// could never be read back for the wrong account; they go only to save the
// space. The settings themselves are the user's and are left alone.
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
    await extensionApi.storage.local.remove(['archiveCounted', 'apiCache', 'ratings']);
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
    if (!username) {
        // Nothing to count until a username is configured, but a 1-hour
        // block still blocks on its own
        const nowMs = Date.now();
        const breakUntil = await activeBreak(nowMs);
        const pendingSince = await breakPending(nowMs);
        const paused = await isPaused();
        await extensionApi.storage.local.set({
            blocked: !paused && (breakUntil !== null || pendingSince !== null)
        });
        await scheduleResetAlarm(earliest(
            upcoming(breakUntil),
            pendingSince === null ? null : pendingSince + BREAK_DURATION_MS
        ));
        return;
    }
    const maxGames = normalizeMaxGames(settings.maxGames);
    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    const resetMode = normalizeResetMode(settings.resetMode);
    const blockMode = normalizeBlockMode(settings.blockMode);
    const ratingFloor = normalizeRatingBound(settings.ratingFloor);
    const ratingCeiling = normalizeRatingBound(settings.ratingCeiling);

    // The master switch and the 1-hour block are decided locally, so read them
    // before the fetch: they have to take effect even while the API is
    // unreachable.
    const paused = await isPaused();
    const breakUntil = await activeBreak(Date.now());
    const pendingSince = await breakPending(Date.now());

    // The window can only move forward while the fetch is in flight, so the
    // archives chosen now still cover it; the count itself uses a fresh clock.
    // Rating mode needs the stats endpoint; so does placing a locally recorded
    // game in a time control. Asking for it otherwise would double the request
    // rate for nothing.
    const needStats = blockMode === 'rating' || hasUnclassifiedLocalGames(await readLedger());
    const games = await fetchGamesSince(username, getWindowStart(Date.now(), resetMode), Date.now());
    const stats = needStats ? await fetchPlayerStats(username) : {};

    const nowMs = Date.now();
    // The ledger's timestamps live on chess.com's clock (see recordGameOver),
    // so the "now" they are resolved and pruned against does too
    const nowSeconds = Math.round((nowMs + await storedClockSkewMs()) / 1000);
    // Games the archive has published are dropped from the ledger, so they are
    // never counted from both places. With the archive unreachable nothing can
    // be shown to be published, so nothing is dropped.
    const localGames = await updateLedger(
        (current) => pruneLocalGames(resolveLocalGames(current, stats, nowSeconds), games ?? [], nowSeconds)
    ).catch((error) => {
        // A failed rewrite is not an empty ledger: count what is stored,
        // unpruned - briefly over-counting is the safe direction for a blocker
        console.error('Local game ledger update failed:', error);
        return readLedger();
    });
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

    // The window only matters for the counting modes; in rating mode there is
    // nothing to reset, so no alarm is needed for it either
    let limitHit = outOfCountingRange(blockMode, counted, maxGames);
    let nextReset = null;
    // Only rating mode fetches ratings to compare, so the other modes leave the
    // last known ones in place rather than blanking the popup's rating list.
    let ratings = null;
    if (blockMode === 'losses') {
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedLoss);
    } else if (blockMode === 'games') {
        nextReset = getNextReset(nowMs, resetMode, counted.oldestCountedGame);
    } else if (stats === null) {
        // Rating mode with no ratings to compare: hold the last verdict
        const { limitHit: lastLimitHit } = await extensionApi.storage.local.get({ limitHit: false });
        limitHit = lastLimitHit === true;
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
        blocked: !paused && (limitHit || breakUntil !== null || pendingSince !== null)
    });

    // Rating mode has no window to reset, so nothing else would ever re-arm
    // the alarm: once a bound is crossed the block would have to be lifted by
    // opening a chess.com game page, which is exactly what is blocked. Poll
    // instead, so a rating that moves back into range clears the block.
    const ratingPoll = blockMode === 'rating' ? nowMs + RATING_POLL_MS : null;
    // A consumed alarm would otherwise leave a block from stale data with
    // nothing to lift it, so an outage always leaves a retry armed.
    const retry = outage || stats === null ? nowMs + RETRY_DELAY_MS : null;
    // A record the stats endpoint has not placed yet counts provisionally and
    // is written off once its grace period runs out - but only a check does
    // the writing off, so one has to run when that moment comes, or a
    // provisional block from an unrated or variant game would outlive its
    // five minutes by the rest of the window.
    const classifyDeadline = earliest(...localGames
        .filter((game) => !game.timeClass)
        .map((game) => (game.endTime + LOCAL_CLASSIFY_GRACE_SECONDS) * 1000));
    // A pending 1-hour block expires too (see breakPending), and needs a
    // check to notice when no chess.com page is open to convert it
    const pendingExpiry = pendingSince === null ? null : pendingSince + BREAK_DURATION_MS;
    await scheduleResetAlarm(earliest(
        upcoming(nextReset), upcoming(breakUntil), ratingPoll, retry,
        upcoming(classifyDeadline), pendingExpiry
    ));
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

// The master switch, the popup's Pause/Resume pill. The popup does not offer
// to pause while a 1-hour block is up - the pill ends the block instead, and
// only goes back to being the switch once it is gone - so this drops any block
// it finds only to keep a stale popup from leaving one behind to be revived by
// the next Resume.
async function setPaused(paused) {
    await extensionApi.storage.local.set({ paused });
    if (paused) {
        await extensionApi.storage.local.remove(['breakUntil', 'breakPending']);
    }
    await checkGamesPlayed();
}

// "Block chess.com for 1 hour" from the popup. Only the time of the click is
// stored: the content script decides when the block actually appears (right
// away, or once the current game ends) and calls beginBreak at that moment.
async function startBreak() {
    await extensionApi.storage.local.set({ breakPending: Date.now() });
    await checkGamesPlayed();
}

// The block is on screen now, so the hour starts now. Returns the deadline for
// the page to count down from.
async function beginBreak() {
    const nowMs = Date.now();
    const breakUntil = await activeBreak(nowMs);
    const pending = await breakPending(nowMs);
    if (pending === null) {
        return breakUntil;
    }
    const until = nowMs + BREAK_DURATION_MS;
    await extensionApi.storage.local.set({ breakUntil: until, breakPending: false });
    // Answer the waiting page first; the recount (which arms the alarm that
    // lifts the block at `until`) can take a network round trip.
    checkGamesPlayed();
    return until;
}

async function endBreak() {
    await extensionApi.storage.local.remove(['breakUntil', 'breakPending']);
    await checkGamesPlayed();
}

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
    // Tidy up keys from earlier layouts: the caches that predate chessApi.js,
    // and derived state that used to be written to sync. checkGamesPlayed
    // rebuilds both.
    await Promise.all([
        extensionApi.storage.local.remove([
            'cachedEtag', 'cachedGames', 'cacheUrl', 'archiveCache', 'statsCache'
        ]),
        extensionApi.storage.sync.remove(['losses', 'nextReset', 'blocked'])
    ]);
    checkGamesPlayed();
});

// Messages from the popup and the content script. Only checkUsername expects
// a reply; the rest deliberately return nothing.
extensionApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkUsername') {
        // The popup could ask chess.com itself, but its queue would be a
        // separate one: two contexts each fetching serially still add up to
        // parallel access. Answering from here keeps it to one queue.
        fetchPlayerExists(request.username).then(sendResponse, () => sendResponse('unknown'));
        return true; // Chrome needs this to keep the channel open
    }
    if (request.action === 'beginBreak') {
        // The content script waits for the deadline before drawing its
        // countdown, so this one answers
        beginBreak().then(sendResponse, () => sendResponse(null));
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
    } else if (request.action === 'startBreak') {
        startBreak();
    } else if (request.action === 'endBreak') {
        endBreak();
    }
});
