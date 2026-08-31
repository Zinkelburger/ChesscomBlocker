// Reads the logged-in chess.com username out of the page, so nobody has to
// type a name the browser is already looking at.
//
// chess.com renders its own session into a page global, `window.context.user`.
// An extension cannot see page globals from a content script, so this file is
// declared with "world": "MAIN" (see manifests/chrome.json) and runs in the
// page's own scope instead. That costs it the extension APIs, so it hands the
// name to content.js by posting it to the page's window.
//
// Only the username is passed on. The same object also carries a token that
// identifies the account, a request-forgery token and the user's IP; none of
// that is the extension's business, and a postMessage is readable by the page
// and by anything else listening on it. Chess.com's own extension posted the
// whole object with a wildcard target origin - this posts one validated
// string, to this origin only.
//
// Firefox does not need this file: a Manifest V2 content script can reach page
// globals through window.wrappedJSObject, which content.js does directly.

// Wrapped, because this runs in the page's own global scope: a bare `const`
// here would be a name chess.com's own code could collide with.
(() => {
    // Kept in step with USERNAME_PATTERN in shared.js. It cannot be shared:
    // shared.js belongs to the extension's world, not the page's.
    const USERNAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

    // content.js matches on this, so a message from the page's own code (or
    // from another extension in this world) is not mistaken for ours
    const MESSAGE_SOURCE = 'chesscom-blocker-username';

    // Its own copy of the flag in shared.js: this file runs in the page's
    // world, where shared.js does not exist. Turn both off together.
    const DEBUG = false;

    function debugLog(...args) {
        if (DEBUG) {
            console.log('[Chess Blocker page]', ...args);
        }
    }

    // `context` is server-rendered into the page, so it is normally there
    // before this runs. Poll briefly rather than assume it: content scripts
    // run at document_idle, and chess.com is a single-page app that has been
    // known to move when things load.
    const POLL_INTERVAL_MS = 500;
    const POLL_ATTEMPTS = 10;

    // Says what the page global looked like on an attempt that found no name,
    // so a chess.com rename shows up as "the object is there, the field is
    // not" rather than as silence. Key names only - no values are logged.
    function describeContext() {
        const context = window.context;
        if (context === undefined || context === null) {
            return 'window.context is not set';
        }
        if (typeof context !== 'object') {
            return `window.context is a ${typeof context}`;
        }
        const user = context.user;
        if (user === undefined || user === null) {
            return `window.context has no .user (its keys: ${Object.keys(context).join(', ')})`;
        }
        return `window.context.user has no usable .username (its keys: ${Object.keys(user).join(', ')})`;
    }

    function postUsername(attempt) {
        const username = String(window.context?.user?.username ?? '').trim().toLowerCase();
        if (!USERNAME_PATTERN.test(username)) {
            debugLog(`attempt ${attempt + 1}/${POLL_ATTEMPTS + 1}: ${describeContext()}`);
            if (attempt < POLL_ATTEMPTS) {
                setTimeout(() => postUsername(attempt + 1), POLL_INTERVAL_MS);
            } else {
                debugLog('gave up looking for the username on', window.location.href,
                    '- if you are logged in, chess.com has probably moved it');
            }
            return;
        }
        debugLog(`found "${username}", posting it to the extension`);
        window.postMessage({ source: MESSAGE_SOURCE, username }, window.location.origin);
    }

    debugLog('page-world detection running on', window.location.href);
    postUsername(0);
})();
