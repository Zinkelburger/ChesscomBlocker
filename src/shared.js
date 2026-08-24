// Loaded before every other extension script (see manifests/*.json and
// options.html). Nothing in here depends on the DOM or the network, so it is
// safe in the background script, the popup and the content script alike.

// Chrome only exposes the WebExtension API as `chrome`; Firefox exposes it as
// `browser` (Promise-returning) and `chrome` (callback-style). Chrome >= 111
// returns Promises from `chrome.*` when no callback is passed, so picking
// whichever namespace exists lets the rest of the code be written once,
// Promise-style, for both browsers.
const extensionApi = globalThis.browser ?? globalThis.chrome;

// The chess.com pages that are blocked once the loss limit is hit
const GAME_PAGE_PATTERN = /^https?:\/\/([^/]+\.)?chess\.com\/(game|play\/online)/;

// Fire-and-forget message to the background script. The background never
// replies, and the sender (a popup, or a tab being navigated away from) may be
// gone before the browser settles the call, so a rejection here carries no
// information worth surfacing.
function sendToBackground(message) {
    return extensionApi.runtime.sendMessage(message).catch(() => {});
}

// Export for the Node tests; harmless in the browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GAME_PAGE_PATTERN };
}
