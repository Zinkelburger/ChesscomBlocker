// Tests for the background script's orchestration in src/background.js.
//
// The script is run as-is inside a vm context with stand-ins for the parts of
// the browser it touches - storage, alarms, tabs, runtime messages and fetch -
// so what is exercised is the code the extension ships, end to end: a game is
// reported, the API answers, storage and the alarm come out the other side.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['shared.js', 'lossCounter.js', 'chessApi.js', 'background.js'];
const {
    DAY_SECONDS, LOCAL_CLASSIFY_GRACE_SECONDS, RETRY_DELAY_MS, UNTRACKED_TIME_CLASS
} = require('../src/lossCounter.js');
const { HOUR_BLOCK_MS } = require('../src/shared.js');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// storage.local / storage.sync: get with defaults, set, remove, and the
// shared onChanged that fires only for keys whose value actually changed
function fakeStorage() {
    const listeners = [];
    const fire = (changes, areaName) => listeners.forEach((fn) => fn(changes, areaName));
    const area = (areaName, data) => ({
        data,
        async get(keys) {
            if (typeof keys === 'string') {
                return keys in data ? { [keys]: clone(data[keys]) } : {};
            }
            if (Array.isArray(keys)) {
                return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
            }
            return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in data ? clone(data[k]) : v]));
        },
        async set(items) {
            const changes = {};
            for (const [key, value] of Object.entries(items)) {
                if (value === undefined || JSON.stringify(data[key]) === JSON.stringify(value)) {
                    continue;
                }
                changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
                data[key] = clone(value);
            }
            if (Object.keys(changes).length) {
                fire(changes, areaName);
            }
        },
        async remove(keys) {
            const changes = {};
            for (const key of [].concat(keys)) {
                if (key in data) {
                    changes[key] = { oldValue: clone(data[key]) };
                    delete data[key];
                }
            }
            if (Object.keys(changes).length) {
                fire(changes, areaName);
            }
        }
    });
    return {
        local: area('local', {}),
        sync: area('sync', {}),
        onChanged: { addListener: (fn) => listeners.push(fn) }
    };
}

// An API response the wrapper can read: status, JSON body, a few headers.
// The Date header is stamped by the fetch stub, from the fake clock.
function response(status, body, headers = {}) {
    return { status, headers, body };
}

// Boot the background script against a fresh fake browser. `routes` maps an
// API path (after /pub) to a function returning a response or throwing.
// `serverOffsetMs` is how far chess.com's clock (the Date header) runs ahead of this machine's
function boot({ routes = {}, tabs = [], tabAnswers = {}, storage = fakeStorage(), nowMs = 1764800000000, serverOffsetMs = 0 } = {}) {
    let now = nowMs;
    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }
        static now() {
            return now;
        }
    }
    const alarms = { current: null };
    const handlers = {};
    const fetchCalls = [];
    const errors = [];
    const chrome = {
        storage,
        alarms: {
            async create(name, info) { alarms.current = { name, ...info }; },
            async clear(name) { if (alarms.current?.name === name) alarms.current = null; },
            onAlarm: { addListener: (fn) => { handlers.alarm = fn; } }
        },
        runtime: {
            getManifest: () => ({ version: '0.0.0-test' }),
            onMessage: { addListener: (fn) => { handlers.message = fn; } },
            onStartup: { addListener: (fn) => { handlers.startup = fn; } },
            onInstalled: { addListener: (fn) => { handlers.installed = fn; } }
        },
        tabs: {
            onUpdated: { addListener: (fn) => { handlers.tabUpdated = fn; } },
            async query() { return tabs; },
            async sendMessage(tabId, message) {
                if (!(tabId in tabAnswers)) {
                    throw new Error('no receiver');
                }
                return message.action === 'gameInProgress' ? tabAnswers[tabId] : undefined;
            }
        },
        declarativeNetRequest: { async updateSessionRules() {} }
    };
    const context = vm.createContext({
        chrome,
        Date: FakeDate,
        console: { log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
        setTimeout: (fn) => { Promise.resolve().then(fn); return 0; },
        clearTimeout() {},
        fetch: async (url, options = {}) => {
            const apiPath = url.replace('https://api.chess.com/pub', '');
            fetchCalls.push({ path: apiPath, etag: options.headers?.['If-None-Match'] ?? null });
            const route = routes[apiPath];
            const { status, headers, body } = route ? route(fetchCalls[fetchCalls.length - 1]) : response(404, {});
            const all = { date: new Date(now + serverOffsetMs).toUTCString() };
            for (const [name, value] of Object.entries(headers)) {
                all[name.toLowerCase()] = value;
            }
            return {
                status,
                ok: status >= 200 && status < 300,
                headers: { get: (name) => all[name.toLowerCase()] ?? null },
                json: async () => clone(body)
            };
        }
    });
    for (const file of FILES) {
        vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
    }
    const inFlight = () => vm.runInContext('checkInFlight', context);
    // Every stand-in answers within microtasks, so a macrotask turn lets any
    // fire-and-forget handler reach its check before the drain looks for it
    async function settle() {
        let pending;
        do {
            await new Promise((resolve) => setImmediate(resolve));
            pending = inFlight();
            if (pending !== null) {
                await pending;
            }
        } while (pending !== null);
    }
    return {
        context,
        storage,
        alarms,
        fetchCalls,
        errors,
        handlers,
        setNow: (ms) => { now = ms; },
        // Run a check and wait until no check is in flight. checkGamesPlayed
        // returns the run already under way and queues one more behind it, so
        // the state a test asserts on is the one after the last of them.
        check: async () => {
            await context.checkGamesPlayed();
            await settle();
        },
        settle,
        record: async (lost, endTime) => {
            await context.recordGameOver(lost, endTime);
            await settle();
        },
        // A message with a reply, the way the browser would deliver it
        message: (request) => new Promise((resolve) => {
            const keepOpen = handlers.message(request, {}, resolve);
            if (keepOpen !== true) {
                resolve(undefined);
            }
        })
    };
}

const T = 1764800000; // seconds
const T_MS = T * 1000;
const MONTH = '2025/12'; // the UTC month T falls in

const statsBody = (pools) => Object.fromEntries(Object.entries(pools).map(([timeClass, { date, total, rating = 1500 }]) => [
    `chess_${timeClass}`, { last: { rating, date, rd: 50 }, record: { win: total, loss: 0, draw: 0 } }
]));
const lostGame = (endTime) => ({
    end_time: endTime, time_class: 'bullet', rules: 'chess', rated: true,
    white: { username: 'me', result: 'checkmated' }, black: { username: 'them', result: 'win' }
});

async function configured(app, settings = {}) {
    await app.storage.sync.set({ username: 'me', maxGames: 2, blockMode: 'losses', ...settings });
    await app.settle();
}

test('two bullet games in a row both count while the archive lags', async () => {
    // The stats endpoint lags at the first check and catches up at the second
    let stats = statsBody({ bullet: { date: T - DAY_SECONDS, total: 100 } });
    const app = boot({
        routes: {
            [`/player/me/games/${MONTH}`]: () => response(200, { games: [] }),
            '/player/me/stats': () => response(200, stats)
        },
        nowMs: T_MS
    });
    await configured(app);
    await app.check();

    await app.record(true, T);
    assert.strictEqual(app.storage.local.data.losses, 1, 'the first game counts provisionally');
    assert.strictEqual(app.storage.local.data.blocked, false);
    assert.deepStrictEqual(app.storage.local.data.poolTotals, { bullet: 100 });

    stats = statsBody({ bullet: { date: T + 80, total: 102 } });
    app.setNow((T + 80) * 1000);
    await app.record(true, T + 80);

    assert.deepStrictEqual(app.storage.local.data.localGames.map((game) => game.timeClass), ['bullet', 'bullet']);
    assert.strictEqual(app.storage.local.data.losses, 2);
    assert.strictEqual(app.storage.local.data.blocked, true);
    assert.deepStrictEqual(app.storage.local.data.poolTotals, { bullet: 102 });
    // Both checks asked the stats endpoint afresh: a copy under a minute old
    // is not reused while a record is waiting to be placed
    assert.strictEqual(app.fetchCalls.filter((call) => call.path === '/player/me/stats').length, 2);
});

test('an unrated game stops counting once its grace runs out, on chess.com\'s clock', async () => {
    const app = boot({
        routes: {
            [`/player/me/games/${MONTH}`]: () => response(200, { games: [] }),
            '/player/me/stats': () => response(200, statsBody({ bullet: { date: T - DAY_SECONDS, total: 100 } }))
        },
        nowMs: T_MS,
        // chess.com's clock runs 30s ahead of this machine's
        serverOffsetMs: 30000
    });
    await configured(app, { maxGames: 1 });
    await app.check();
    assert.strictEqual(app.storage.local.data.clockSkewMs, 30000, 'measured off the Date header');

    await app.record(true, T);
    assert.strictEqual(app.storage.local.data.localGames[0].endTime, T + 30, 'recorded on the server clock');
    assert.strictEqual(app.storage.local.data.blocked, true, 'counted until it is placed');
    const deadline = (T + 30 + LOCAL_CLASSIFY_GRACE_SECONDS + 1) * 1000 - 30000;
    assert.strictEqual(app.alarms.current.when, deadline, 'the alarm lands past the grace on the local clock');

    app.setNow(deadline);
    await app.handlers.alarm({ name: 'reset-window' });
    await app.settle();
    assert.strictEqual(app.storage.local.data.localGames[0].timeClass, UNTRACKED_TIME_CLASS);
    assert.strictEqual(app.storage.local.data.losses, 0);
    assert.strictEqual(app.storage.local.data.blocked, false);
    assert.strictEqual(app.alarms.current, null, 'nothing left to wake up for');
});

test('an outage keeps the archive\'s last count and arms a retry', async () => {
    let online = true;
    const app = boot({
        routes: {
            [`/player/me/games/${MONTH}`]: () => {
                if (!online) {
                    throw new TypeError('Failed to fetch');
                }
                return response(200, { games: [lostGame(T - 3000), lostGame(T - 2000)] });
            }
        },
        nowMs: T_MS
    });
    await configured(app);
    await app.check();
    assert.strictEqual(app.storage.local.data.losses, 2);
    assert.strictEqual(app.storage.local.data.blocked, true);

    online = false;
    // No cached copy to fall back on either
    await app.storage.local.remove('apiCache');
    app.setNow(T_MS + 60000);
    await app.check();
    assert.strictEqual(app.storage.local.data.losses, 2, 'the last good count stands');
    assert.strictEqual(app.storage.local.data.blocked, true);
    assert.strictEqual(app.alarms.current.when, T_MS + 60000 + RETRY_DELAY_MS);
});

test('a 429 is remembered across a service worker restart', async () => {
    const storage = fakeStorage();
    const routes = {
        [`/player/me/games/${MONTH}`]: () => response(429, {}, { 'Retry-After': '600' })
    };
    const first = boot({ routes, storage, nowMs: T_MS });
    await configured(first);
    await first.check();
    assert.strictEqual(first.fetchCalls.length, 1);
    assert.ok(first.storage.local.data.apiBackoff?.until >= T_MS + 600000);

    // The worker is shut down and started again a minute later, memory gone
    const second = boot({ routes, storage, nowMs: T_MS + 60000 });
    await second.check();
    assert.strictEqual(second.fetchCalls.length, 0, 'still backing off');
    assert.strictEqual(second.alarms.current.when, T_MS + 60000 + RETRY_DELAY_MS, 'and retrying later');

    const third = boot({ routes, storage, nowMs: T_MS + 601000 });
    await third.check();
    assert.strictEqual(third.fetchCalls.length, 1, 'the backoff has expired');
});

test('the 1-hour block starts at the click when no game is running anywhere', async () => {
    const app = boot({ tabs: [], nowMs: T_MS });
    await configured(app);
    await app.message({ action: 'requestHourBlock' });
    await app.settle();
    assert.strictEqual(app.storage.local.data.hourBlockUntil, T_MS + HOUR_BLOCK_MS);
    assert.strictEqual('hourBlockRequestedAt' in app.storage.local.data, false);
    assert.strictEqual(app.storage.local.data.blocked, true);
    assert.strictEqual(app.alarms.current.when, T_MS + HOUR_BLOCK_MS);

    await app.message({ action: 'endHourBlock' });
    await app.settle();
    assert.strictEqual('hourBlockUntil' in app.storage.local.data, false);
    assert.strictEqual(app.storage.local.data.blocked, false);
});

test('the 1-hour block waits for a live game, and its hour starts when the page shows it', async () => {
    const app = boot({
        tabs: [{ id: 1, url: 'https://www.chess.com/game/live/1' }, { id: 2, url: 'https://www.chess.com/play/online' }],
        tabAnswers: { 1: true, 2: false },
        nowMs: T_MS
    });
    await configured(app);
    await app.message({ action: 'requestHourBlock' });
    await app.settle();
    assert.strictEqual(app.storage.local.data.hourBlockRequestedAt, T_MS);
    assert.strictEqual('hourBlockUntil' in app.storage.local.data, false);
    assert.strictEqual(app.storage.local.data.blocked, true);
    assert.strictEqual(app.alarms.current.when, T_MS + HOUR_BLOCK_MS, 'the request expires on its own');

    // The game ends ten minutes later and the page puts the block up
    app.setNow(T_MS + 10 * 60000);
    const deadline = await app.message({ action: 'beginHourBlock' });
    assert.strictEqual(deadline, T_MS + 10 * 60000 + HOUR_BLOCK_MS);
    await app.settle();
    assert.strictEqual(app.storage.local.data.hourBlockUntil, deadline);
    assert.strictEqual('hourBlockRequestedAt' in app.storage.local.data, false);
});

test('a tab that cannot answer does not hold the block back', async () => {
    const app = boot({ tabs: [{ id: 7, url: 'https://www.chess.com/game/live/7' }], tabAnswers: {}, nowMs: T_MS });
    await configured(app);
    await app.message({ action: 'requestHourBlock' });
    await app.settle();
    assert.strictEqual(app.storage.local.data.hourBlockUntil, T_MS + HOUR_BLOCK_MS);
});

test('an update carries the old build\'s 1-hour block across', async () => {
    const app = boot({ nowMs: T_MS });
    await app.storage.local.set({ breakPending: true, cachedGames: [] });
    await app.handlers.installed({ reason: 'update' });
    assert.strictEqual(app.storage.local.data.hourBlockRequestedAt, T_MS);
    assert.strictEqual('breakPending' in app.storage.local.data, false);
    assert.strictEqual('cachedGames' in app.storage.local.data, false);

    const later = boot({ nowMs: T_MS });
    await later.storage.local.set({ breakPending: T_MS - 5000, breakUntil: T_MS + 5000 });
    await later.handlers.installed({ reason: 'update' });
    assert.strictEqual(later.storage.local.data.hourBlockRequestedAt, T_MS - 5000);
    assert.strictEqual(later.storage.local.data.hourBlockUntil, T_MS + 5000);
});

test('rating mode holds its verdict while the stats endpoint is down', async () => {
    let online = true;
    const app = boot({
        routes: {
            [`/player/me/games/${MONTH}`]: () => response(200, { games: [] }),
            '/player/me/stats': () => {
                if (!online) {
                    throw new TypeError('Failed to fetch');
                }
                return response(200, statsBody({ blitz: { date: T - 100, total: 10, rating: 1400 } }));
            }
        },
        nowMs: T_MS
    });
    await configured(app, { blockMode: 'rating', ratingFloor: 1500 });
    await app.check();
    assert.strictEqual(app.storage.local.data.limitHit, true);
    assert.deepStrictEqual(app.storage.local.data.ratings, { blitz: 1400 });

    online = false;
    await app.storage.local.remove('apiCache');
    app.setNow(T_MS + 20 * 60000);
    await app.check();
    assert.strictEqual(app.storage.local.data.limitHit, true, 'held');
    assert.strictEqual(app.storage.local.data.blocked, true);
    assert.strictEqual(app.alarms.current.when, T_MS + 20 * 60000 + RETRY_DELAY_MS);
});

test('changing the username forgets the other account\'s derived state', async () => {
    const app = boot({
        routes: { [`/player/me/games/${MONTH}`]: () => response(200, { games: [lostGame(T - 3000), lostGame(T - 2000)] }) },
        nowMs: T_MS
    });
    await configured(app);
    await app.check();
    assert.strictEqual(app.storage.local.data.blocked, true);
    await app.record(true, T);
    assert.strictEqual(app.storage.local.data.localGames.length, 1);

    await app.storage.sync.set({ username: 'someoneelse' });
    await app.settle();
    assert.deepStrictEqual(app.storage.local.data.localGames, []);
    assert.strictEqual(app.storage.local.data.trackedUsername, 'someoneelse');
    assert.strictEqual(app.storage.local.data.losses, 0);
    assert.strictEqual(app.storage.local.data.blocked, false);
});

test('pausing lifts every block and drops a 1-hour block', async () => {
    const app = boot({
        routes: { [`/player/me/games/${MONTH}`]: () => response(200, { games: [lostGame(T - 100), lostGame(T - 50)] }) },
        nowMs: T_MS
    });
    await configured(app);
    await app.message({ action: 'requestHourBlock' });
    await app.settle();
    assert.strictEqual(app.storage.local.data.blocked, true);

    await app.message({ action: 'setPaused', paused: true });
    await app.settle();
    assert.strictEqual(app.storage.local.data.blocked, false);
    assert.strictEqual(app.storage.local.data.limitHit, true, 'the counter still says so');
    assert.strictEqual('hourBlockUntil' in app.storage.local.data, false);
});
