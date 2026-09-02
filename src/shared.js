// Loaded before every other extension script (see manifests/*.json and
// options.html). Nothing in here depends on the DOM or the network, so it is
// safe in the background script, the popup and the content script alike.

// Chrome only exposes the WebExtension API as `chrome`; Firefox exposes it as
// `browser` (Promise-returning) and `chrome` (callback-style). Chrome >= 111
// returns Promises from `chrome.*` when no callback is passed, so picking
// whichever namespace exists lets the rest of the code be written once,
// Promise-style, for both browsers.
const extensionApi = globalThis.browser ?? globalThis.chrome;

// ============ Debug logging ============
//
// The username detection reads a global out of chess.com's own page, which is
// theirs to rename without notice, so every step of it can say what it saw in
// the console. It is off in anything that ships - the lines name the account
// they found, which is nobody's business on someone else's page, and
// test/build.test.js fails the build if it is left on. detectUsername.js runs
// in the page's world and cannot see this file, so it carries its own copy of
// the flag; turn the two on and off together.
const DEBUG = false;

// Tagged so the extension's lines can be picked out of chess.com's own noise
function debugLog(...args) {
    if (DEBUG) {
        console.log('[Chess Blocker]', ...args);
    }
}

// The chess.com pages that are blocked once the loss limit is hit
const GAME_PAGE_PATTERN = /^https?:\/\/([^/]+\.)?chess\.com\/(game|play\/online)/;

// The same pages as match patterns, for tabs.query. Kept in step with the
// content_scripts matches in manifests/base.json.
const GAME_PAGE_MATCH_PATTERNS = ['https://*.chess.com/game*', 'https://*.chess.com/play/online*'];

// Chess.com usernames are ASCII letters, digits, underscore and hyphen.
// Anything else is a typo, and interpolating it into a URL unchecked would be
// a path traversal waiting to happen.
const USERNAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

// The username as it goes into a URL, or null if it could never be one
function normalizeUsername(name) {
    const trimmed = String(name ?? '').trim().toLowerCase();
    return USERNAME_PATTERN.test(trimmed) ? trimmed : null;
}

// How long the popup's "Block chess.com for 1 hour" keeps the play pages
// blocked, once the block is on screen
const HOUR_BLOCK_MS = 60 * 60000;

// "5h 12m" / "12m" / "under a minute"
function formatCountdown(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 1) {
        return 'under a minute';
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 1) {
        return `${minutes}m`;
    }
    return `${hours}h ${minutes % 60}m`;
}

// Fire-and-forget message to the background script. The background never
// replies, and the sender (a popup, or a tab being navigated away from) may be
// gone before the browser settles the call, so a rejection here carries no
// information worth surfacing. The try is not redundant with the catch:
// reloading or updating the extension orphans the content scripts in open
// tabs, whose timers keep firing, and sendMessage then throws "Extension
// context invalidated" synchronously instead of rejecting.
function sendToBackground(message) {
    try {
        return Promise.resolve(extensionApi.runtime.sendMessage(message)).catch(() => {});
    } catch {
        return Promise.resolve();
    }
}

// Ask the background script something and wait for its answer. Unlike
// sendToBackground this one has a reply worth having, so a failure - the
// background script gone, the popup closed mid-flight, or this script
// orphaned by an extension reload (see above) - comes back as null for the
// caller to treat as "no answer".
function askBackground(message) {
    try {
        return Promise.resolve(extensionApi.runtime.sendMessage(message)).catch(() => null);
    } catch {
        return Promise.resolve(null);
    }
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GAME_PAGE_PATTERN, GAME_PAGE_MATCH_PATTERNS, HOUR_BLOCK_MS, formatCountdown, normalizeUsername, debugLog };
}
