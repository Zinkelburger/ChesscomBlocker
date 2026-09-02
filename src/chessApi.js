// The only place in the extension that talks to api.chess.com.
//
// Everything the PubAPI asks of a client lives here rather than at the call
// sites: one request at a time, an identifying User-Agent, ETag revalidation,
// and backoff that honours Retry-After. Only the background script loads it,
// which is what keeps the queue to one: the popup asks the background to check
// a username rather than fetching for itself, so its request waits behind the
// archive fetches instead of racing them.
//
// https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it

// `extensionApi` and `normalizeUsername` come from shared.js, which every
// context loads first.
const API_BASE = 'https://api.chess.com/pub';

// Contact the PubAPI docs ask for, so chess.com can reach a human before
// resorting to a block. Swap in an email address if you would rather have one.
const API_CONTACT = 'https://github.com/Zinkelburger/ChesscomBlocker/issues';

// The docs put it plainly: serial access is unlimited, parallel access may be
// rate limited. So requests are queued, and this is the gap left between them.
const REQUEST_GAP_MS = 250;

// After a 429 or a server error, how long to leave the API alone. Doubles per
// consecutive failure up to the cap, and clears on the first success.
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 30 * 60000;

// A cached response younger than this is reused without asking the API at all.
// A check fires on every navigation to a game page, and a game the archive has
// not published yet is counted from the local ledger rather than from here.
const REVALIDATE_AFTER_MS = 60000;

// Two archives and one stats response is the working set; the slack covers a
// month boundary and a username change overlapping.
const MAX_CACHE_ENTRIES = 6;

// What a request came back as. Callers act on these rather than on status
// codes, so the mapping from HTTP lives in one place.
const API_OK = 'ok';
const API_NOT_MODIFIED = 'not-modified';
const API_MISSING = 'missing';
const API_UNAVAILABLE = 'unavailable';

function archivePath(username, month) {
    return `/player/${username}/games/${month}`;
}

function statsPath(username) {
    return `/player/${username}/stats`;
}

function profilePath(username) {
    return `/player/${username}`;
}

// ============ Identifying the client ============

function userAgent() {
    let version = '0.0.0';
    try {
        version = extensionApi.runtime.getManifest().version || version;
    } catch (error) {
        // Not running as an extension (the Node tests); the default will do
    }
    return `ChesscomBlocker/${version} (+https://github.com/Zinkelburger/ChesscomBlocker; contact: ${API_CONTACT})`;
}

// `fetch` cannot send a User-Agent: it is a forbidden header name, so anything
// passed in `headers` is dropped without a word. Setting it means rewriting the
// request at the network layer, which each browser spells differently. Both
// paths are scoped to the PubAPI, and both are best-effort: a browser that
// refuses still gets its own default User-Agent, which is worse but not broken.
const USER_AGENT_RULE_ID = 1;
let userAgentInstall = null;

function installUserAgent() {
    if (!userAgentInstall) {
        userAgentInstall = setUserAgent().catch((error) => {
            console.warn('Could not set the chess.com User-Agent header:', error);
            return false;
        });
    }
    return userAgentInstall;
}

async function setUserAgent() {
    const value = userAgent();

    // Firefox (Manifest V2). Only declared there, so on Chrome this is absent.
    if (extensionApi.webRequest?.onBeforeSendHeaders) {
        extensionApi.webRequest.onBeforeSendHeaders.addListener(
            ({ requestHeaders }) => ({
                requestHeaders: [
                    ...requestHeaders.filter((header) => header.name.toLowerCase() !== 'user-agent'),
                    { name: 'User-Agent', value }
                ]
            }),
            { urls: [`${API_BASE}/*`] },
            ['blocking', 'requestHeaders']
        );
        return true;
    }

    // Chrome (Manifest V3). Session rules live as long as the browser session,
    // which outlives any one wake-up of the service worker.
    if (extensionApi.declarativeNetRequest?.updateSessionRules) {
        await extensionApi.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [USER_AGENT_RULE_ID],
            addRules: [{
                id: USER_AGENT_RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'user-agent', operation: 'set', value }]
                },
                // Both types, because how Chrome classifies a fetch made from
                // a service worker is not something the extension gets to
                // decide: 'xmlhttprequest' is the usual answer and 'other' the
                // fallback, and a rule that names only one of them is a rule
                // that quietly does nothing. Requests to the PubAPI and no
                // others can match it either way.
                condition: {
                    urlFilter: '||api.chess.com/',
                    resourceTypes: ['xmlhttprequest', 'other']
                }
            }]
        });
        return true;
    }

    return false;
}

// ============ The request queue ============

let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run `task` once every other queued request has finished. Nothing in the
// extension ever has two requests to api.chess.com in flight at once, which is
// the difference between unlimited access and a 429.
function enqueue(task) {
    const run = requestQueue.then(async () => {
        const wait = nextRequestAt - Date.now();
        if (wait > 0) {
            await delay(wait);
        }
        try {
            return await task();
        } finally {
            nextRequestAt = Date.now() + REQUEST_GAP_MS;
        }
    });
    requestQueue = run.then(() => {}, () => {});
    return run;
}

// ============ Backing off ============
//
// On Chrome this file lives in a service worker that is shut down after half a
// minute of quiet and started afresh by the next alarm or message. Memory
// alone would forget a 429 by the time the retry came round, so the deadline
// is kept in storage too and read back once per wake-up.

let backoffUntil = 0;
let consecutiveFailures = 0;
let backoffRestored = null;

// How long to stay off the API after `failures` consecutive ones. The server's
// own Retry-After wins whenever it asks for longer than we would have waited.
function backoffDelay(failures, retryAfter) {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), BACKOFF_MAX_MS);
    return Math.max(backoff, retryAfter ?? 0);
}

// Retry-After is either a number of seconds or an HTTP date
function retryAfterMs(response) {
    const header = response.headers?.get('Retry-After');
    if (!header) {
        return null;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return Math.max(seconds * 1000, 0);
    }
    const when = Date.parse(header);
    return Number.isFinite(when) ? Math.max(when - Date.now(), 0) : null;
}

function restoreBackoff() {
    if (!backoffRestored) {
        backoffRestored = (async () => {
            try {
                const { apiBackoff } = await extensionApi.storage.local.get({ apiBackoff: null });
                if (typeof apiBackoff?.until === 'number' && apiBackoff.until > Date.now()) {
                    backoffUntil = Math.max(backoffUntil, apiBackoff.until);
                    consecutiveFailures = Math.max(consecutiveFailures, apiBackoff.failures | 0);
                }
            } catch (error) {
                // Not running as an extension (the Node tests); nothing to restore
            }
        })();
    }
    return backoffRestored;
}

function storeBackoff() {
    try {
        const write = consecutiveFailures === 0
            ? extensionApi.storage.local.remove('apiBackoff')
            : extensionApi.storage.local.set({ apiBackoff: { until: backoffUntil, failures: consecutiveFailures } });
        Promise.resolve(write).catch(() => {});
    } catch (error) {
        // Not running as an extension (the Node tests)
    }
}

function noteSuccess() {
    if (consecutiveFailures === 0) {
        return;
    }
    consecutiveFailures = 0;
    backoffUntil = 0;
    storeBackoff();
}

function noteFailure(retryAfter) {
    consecutiveFailures += 1;
    backoffUntil = Date.now() + backoffDelay(consecutiveFailures, retryAfter);
    storeBackoff();
}

// ============ The server's clock ============

// The API's own Date header, kept as a running measure of how far this
// machine's clock is from chess.com's. The ledger matches locally timed
// records against server timestamps within a few minutes (see lossCounter.js
// and recordGameOver in background.js), which a clock that is minutes off
// would silently break in both directions. Best-effort by design, and written
// only when it has moved by a second or more: the header has one-second
// resolution, and every response would otherwise be a storage write.
let lastStoredSkewMs = null;

function noteServerTime(response) {
    const header = response.headers?.get('Date');
    const serverNow = header ? Date.parse(header) : NaN;
    if (!Number.isFinite(serverNow)) {
        return;
    }
    const clockSkewMs = serverNow - Date.now();
    if (lastStoredSkewMs !== null && Math.abs(clockSkewMs - lastStoredSkewMs) < 1000) {
        return;
    }
    lastStoredSkewMs = clockSkewMs;
    try {
        extensionApi.storage.local.set({ clockSkewMs }).catch(() => {});
    } catch (error) {
        // Not running as an extension (the Node tests); nothing to store into
    }
}

// ============ One request ============

// One PubAPI GET. Never throws: every outcome comes back as a status the
// caller can act on.
function apiRequest(path, etag) {
    return enqueue(async () => {
        await restoreBackoff();
        if (Date.now() < backoffUntil) {
            return { status: API_UNAVAILABLE, reason: 'backoff' };
        }
        await installUserAgent();

        let response;
        try {
            response = await fetch(`${API_BASE}${path}`, {
                headers: etag ? { 'If-None-Match': etag } : {}
            });
        } catch (error) {
            noteFailure(null);
            console.error(`Chess.com API unreachable for ${path}:`, error);
            return { status: API_UNAVAILABLE, reason: 'network' };
        }

        noteServerTime(response);

        if (response.status === 304) {
            noteSuccess();
            return { status: API_NOT_MODIFIED };
        }
        // 404 is a malformed URL or data that is not available; 410 is data
        // that is gone for good. Neither is worth asking about again.
        if (response.status === 404 || response.status === 410) {
            noteSuccess();
            return { status: API_MISSING };
        }
        if (response.ok) {
            let data;
            try {
                data = await response.json();
            } catch (error) {
                noteFailure(null);
                console.error(`Chess.com API sent unreadable JSON for ${path}:`, error);
                return { status: API_UNAVAILABLE, reason: 'parse' };
            }
            noteSuccess();
            return { status: API_OK, data, etag: response.headers.get('ETag') };
        }
        // 429 (rate limited) or a server error: back off before asking again
        noteFailure(retryAfterMs(response));
        console.warn(`Chess.com API returned ${response.status} for ${path}; backing off`);
        return { status: API_UNAVAILABLE, reason: String(response.status) };
    });
}

// ============ The response cache ============
//
// One entry per path: { etag, fetchedAt, value }. Every write re-reads inside
// the same chain, so two cached requests overlapping cannot lose an entry.

let cacheWrites = Promise.resolve();

async function readCache() {
    const { apiCache } = await extensionApi.storage.local.get({ apiCache: {} });
    return apiCache && typeof apiCache === 'object' ? apiCache : {};
}

function writeCache(path, entry) {
    cacheWrites = cacheWrites.then(async () => {
        const cache = await readCache();
        cache[path] = entry;
        // Newest fetch first, so the oldest fall off the end: a month that
        // rolled over or a username that changed drops out on its own rather
        // than accumulating. An entry left by an older build may carry no
        // fetchedAt, and sorts as the oldest thing there.
        const stale = Object.keys(cache)
            .sort((a, b) => (cache[b].fetchedAt ?? 0) - (cache[a].fetchedAt ?? 0))
            .slice(MAX_CACHE_ENTRIES);
        for (const key of stale) {
            delete cache[key];
        }
        await extensionApi.storage.local.set({ apiCache: cache });
    }).catch((error) => {
        console.error('Chess.com API cache write failed:', error);
    });
    return cacheWrites;
}

// Fetch `path`, revalidating against the cached ETag and falling back to the
// cached copy when the API cannot be reached. `reduce` cuts the response down
// to what is worth storing, and `empty` is what a 404/410 means here. With
// `fresh`, a young cached copy is revalidated rather than reused: a 304 is one
// cheap round trip, and the caller has said the age matters. Returns null
// only when there is nothing usable at all.
async function cachedRequest(path, reduce, empty, { fresh = false } = {}) {
    const cache = await readCache();
    const entry = cache[path];

    if (entry && !fresh && Date.now() - entry.fetchedAt < REVALIDATE_AFTER_MS) {
        return entry.value;
    }

    const result = await apiRequest(path, entry?.etag);

    if (result.status === API_OK) {
        const value = reduce(result.data);
        await writeCache(path, { etag: result.etag, fetchedAt: Date.now(), value });
        return value;
    }
    if (result.status === API_NOT_MODIFIED && entry) {
        // Still current, so restart its revalidation clock
        await writeCache(path, { ...entry, fetchedAt: Date.now() });
        return entry.value;
    }
    if (result.status === API_MISSING) {
        await writeCache(path, { etag: null, fetchedAt: Date.now(), value: empty });
        return empty;
    }
    return entry?.value ?? null;
}

// ============ The endpoints the extension uses ============

// The counter reads five fields per game; the archive ships a full PGN, FEN and
// UUID with every one of them. Storing only what is used takes a heavy month
// from megabytes to kilobytes, which matters because the cache shares
// storage.local with everything else the extension keeps.
function slimGame(game) {
    return {
        end_time: game.end_time,
        time_class: game.time_class,
        rules: game.rules,
        white: { username: game.white?.username ?? '', result: game.white?.result },
        black: { username: game.black?.username ?? '', result: game.black?.result }
    };
}

function slimArchive(data) {
    return Array.isArray(data?.games) ? data.games.map(slimGame) : [];
}

// Every game in the given monthly archives ("YYYY/MM"), oldest first. The
// archives are fetched one after another, never together. Returns null if any
// of them could not be fetched and had no cached copy.
async function fetchArchivedGames(username, months) {
    const name = normalizeUsername(username);
    if (!name) {
        return [];
    }
    const games = [];
    for (const month of months) {
        const archive = await cachedRequest(archivePath(name, month), slimArchive, []);
        if (archive === null) {
            return null;
        }
        games.push(...archive);
    }
    return games;
}

// Current ratings, last-game times and game totals per pool. {} for an
// unknown user, null when the API could not be reached and nothing is cached.
// `fresh` asks for a revalidated copy: a game just recorded is placed by how
// these have moved since the last look, which a minute-old copy cannot show.
function fetchPlayerStats(username, { fresh = false } = {}) {
    const name = normalizeUsername(username);
    if (!name) {
        return Promise.resolve({});
    }
    return cachedRequest(statsPath(name), (data) => data ?? {}, {}, { fresh });
}

// Whether the player exists: 'yes', 'no', or 'unknown' when the API could not
// answer. The popup shows a cross only for 'no' - a 429 or an outage is not
// evidence that a username is wrong.
async function fetchPlayerExists(username) {
    const name = normalizeUsername(username);
    if (!name) {
        return 'no';
    }
    const result = await apiRequest(profilePath(name));
    if (result.status === API_OK || result.status === API_NOT_MODIFIED) {
        return 'yes';
    }
    if (result.status === API_MISSING) {
        return 'no';
    }
    return 'unknown';
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        API_BASE,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
        MAX_CACHE_ENTRIES,
        REVALIDATE_AFTER_MS,
        archivePath,
        statsPath,
        profilePath,
        userAgent,
        backoffDelay,
        retryAfterMs,
        slimGame,
        slimArchive
    };
}
