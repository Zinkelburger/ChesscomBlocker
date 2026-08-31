// Popup. Depends on shared.js and lossCounter.js, which options.html loads
// first. The popup is a stack of fixed-size views (main, settings, and one
// sub-page per setting); everything renders from `settings` (sync storage)
// and `state` (what the background last computed, local storage).

const SETTINGS_DEFAULTS = {
    username: '',
    maxGames: DEFAULT_MAX_GAMES,
    resetMode: DEFAULT_RESET_MODE,
    blockMode: DEFAULT_BLOCK_MODE,
    ratingFloor: null,
    ratingCeiling: null,
    unpauseOnRestart: true,
    gameFilters: DEFAULT_FILTERS
};

const STATE_DEFAULTS = {
    losses: 0,
    games: 0,
    ratings: {},
    nextReset: null,
    // The 1-hour block started by hand from this popup. `breakPending` is the
    // wait for the current game to end; `breakUntil` is the deadline, which
    // only starts once the block is actually on screen.
    breakPending: false,
    breakUntil: null,
    limitHit: false,
    // The master switch, stored inverted: `paused: true` is what the UI calls
    // "blocking is off" - chess.com is never blocked until it is turned on again
    paused: false,
    blocked: false,
    // The username the content script read off a chess.com page. It is filled
    // into an empty username field, but only saved once "Start Chess Blocker" is
    // pressed: the account someone is logged into is not necessarily the one
    // they want tracked, so nothing is counted against it unasked.
    detectedUsername: ''
};

const settings = { ...SETTINGS_DEFAULTS };
const state = { ...STATE_DEFAULTS };

const TIME_CLASS_LABELS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', daily: 'Daily' };
const VARIANT_LABELS = {
    chess: 'Standard', chess960: 'Chess960', bughouse: 'Bughouse',
    crazyhouse: 'Crazyhouse', threecheck: '3-Check', kingofthehill: 'King of the Hill'
};

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// ============ Persistence ============

function saveSettings(patch) {
    Object.assign(settings, patch);
    // The background recounts off the storage write itself (it listens for
    // sync changes), so nothing here has to outlive the popup for a flushed
    // edit to take effect
    return extensionApi.storage.sync.set(patch);
}

// Text and number fields cannot be saved on `change` alone: for these inputs
// `change` only fires on blur or Enter, and a popup is dismissed by clicking
// away from it, which tears it down without ever blurring the field. A value
// typed and then dismissed was simply lost. So edits are queued as they are
// typed and written out only once the field is left or the popup goes away -
// never on a timer, which would store the "2" of a half-typed "2000" and
// block chess.com mid-keystroke.
let pendingPatch = null;

function queueSave(patch) {
    pendingPatch = { ...pendingPatch, ...patch };
}

function flushSave() {
    const patch = pendingPatch;
    pendingPatch = null;
    return patch === null ? Promise.resolve() : saveSettings(patch);
}

// Both of these fire before the popup is torn down, and storage.set hands the
// write to the browser process before it returns, so the last edit still lands.
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        flushSave();
    }
});

// Save `input` to `key` as it is typed. `parse` returns the value to store, or
// undefined for a value that is not worth storing yet (a half-typed number).
// `commit` is the stricter reading used once the user leaves the field: what
// it returns is echoed back into the field, so a rejected value cannot sit on
// screen contradicting what was stored.
function bindField(input, key, parse, commit) {
    input.addEventListener('input', () => {
        const value = parse(input.value);
        if (value !== undefined) {
            queueSave({ [key]: value });
        }
    });
    input.addEventListener('change', () => {
        const value = commit(input.value);
        input.value = value ?? '';
        queueSave({ [key]: value });
        flushSave().then(render);
    });
}

// ============ Navigation ============

function showView(name) {
    $$('.view').forEach((view) => {
        view.hidden = view.dataset.view !== name;
    });
    render();
    const focus = document.querySelector(`.view[data-view="${name}"] input[type="text"]`);
    if (focus) {
        focus.focus();
    }
}

$$('[data-go]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.go));
});

// The "chess.com/play" link in the auto-detect hint. A popup swallows plain
// links, so open the tab ourselves; the URL is one the content script matches,
// so landing there is what detects the username. tabs.create needs no
// permission. The popup closes itself: the browser keeps it open over the new
// tab, and the point of the click was to leave.
$$('[data-open-play]').forEach((button) => {
    button.addEventListener('click', () => {
        extensionApi.tabs.create({ url: 'https://www.chess.com/play/online' });
        window.close();
    });
});

// ============ Formatting ============

function resetLabel() {
    const remaining = state.nextReset ? state.nextReset - Date.now() : 0;
    if (settings.resetMode === 'midnight') {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        return `Counter resets at ${midnight.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    return remaining > 0 ? `Counter resets in ${formatCountdown(remaining)}` : '';
}

// Shown wherever the rating bounds are, so the "no bounds at all" case is a
// named value the status copy can recognise instead of a string to re-match
const NO_RATING_LIMITS = 'never (no limits set)';

function ratingRangeLabel() {
    const { ratingFloor: floor, ratingCeiling: ceiling } = settings;
    if (floor !== null && ceiling !== null) {
        return `below ${floor} · above ${ceiling}`;
    }
    if (floor !== null) {
        return `below ${floor}`;
    }
    if (ceiling !== null) {
        return `above ${ceiling}`;
    }
    return NO_RATING_LIMITS;
}

function blockSummary() {
    if (settings.blockMode === 'rating') {
        const { ratingFloor: floor, ratingCeiling: ceiling } = settings;
        if (floor !== null && ceiling !== null) {
            return `Rating leaves ${floor}–${ceiling}`;
        }
        return `Rating ${ratingRangeLabel()}`;
    }
    return `${settings.maxGames} ${settings.blockMode}`;
}

function gamesSummary() {
    const filters = settings.gameFilters;
    const on = (labels) => Object.keys(labels).filter((key) => filters[key] === true).map((key) => labels[key]);
    const timeControls = on(TIME_CLASS_LABELS);
    const variants = on(VARIANT_LABELS);
    if (!timeControls.length || !variants.length) {
        return 'None';
    }
    return `${timeControls.join(', ')} · ${variants.join(', ')}`;
}

// One row per tracked time control, red when it is outside the range
function renderRatingList(container, colorize) {
    container.replaceChildren();
    const entries = Object.entries(state.ratings);
    if (!entries.length) {
        const empty = document.createElement('span');
        empty.className = 'muted';
        empty.textContent = 'No rated games yet';
        container.append(empty);
        return;
    }
    for (const [timeClass, rating] of entries) {
        const row = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = TIME_CLASS_LABELS[timeClass] ?? timeClass;
        const value = document.createElement('span');
        value.textContent = rating;
        if (colorize && ratingOutOfRange(rating, settings.ratingFloor, settings.ratingCeiling)) {
            value.classList.add('danger');
        }
        row.append(label, value);
        container.append(row);
    }
}

// ============ Main view ============
//
// Three separate things can block chess.com, and each has a name of its own:
//
//   "paused"            the master switch (stored as `paused`). Paused means
//                       chess.com is never blocked, indefinitely.
//   "your limit"        the counter doing its job: enough losses/games, or a
//                       rating out of range, blocks until the counter resets.
//   "a 1-hour block"    the one started by hand (stored as `breakPending`
//                       then `breakUntil`).
//
// The main view offers at most one button for each: the status panel's pill,
// and the button pinned to the bottom. Which is which depends on the state,
// because the two are not independent. Asking for a 1-hour block and then
// pausing would undo it in a single click, so a 1-hour block takes the pill
// over from the master switch for as long as it lasts: while one is up, the
// only thing the panel offers is getting rid of it, and pausing is there
// again the moment it is gone. That leaves the bottom button with just one
// job, starting an hour.

// Which of those is in force right now, most specific first.
const OFF = 'blocking-off';
const HOUR_BLOCK = 'hour-block-running';
const LIMIT_BLOCK = 'limit-reached';
const HOUR_PENDING = 'hour-block-waiting';
const WATCHING = 'blocking-on';

function statusOf() {
    if (state.paused) {
        return OFF;
    }
    if (state.breakUntil && state.breakUntil > Date.now()) {
        return HOUR_BLOCK;
    }
    if (state.limitHit) {
        return LIMIT_BLOCK;
    }
    if (state.breakPending) {
        return HOUR_PENDING;
    }
    return WATCHING;
}

// Why chess.com is blocked, in the words of whichever mode is set
function limitReachedSentence() {
    if (settings.blockMode === 'rating') {
        return `Your rating went ${ratingRangeLabel()}.`;
    }
    return `You reached your limit of ${settings.maxGames} ${settings.blockMode}.`;
}

// Headline plus, where it adds something the headline does not already say, a
// second line. Every headline names what is on or off, so it reads on its own.
function statusLines(phase) {
    if (phase === OFF) {
        return ['Extension is paused', ''];
    }
    if (phase === HOUR_BLOCK) {
        return [
            'Chess.com is blocked',
            `Your 1-hour block ends in ${formatCountdown(state.breakUntil - Date.now())}.`
        ];
    }
    if (phase === LIMIT_BLOCK) {
        return ['Chess.com is blocked', limitReachedSentence()];
    }
    if (phase === HOUR_PENDING) {
        return [
            '1-hour block is waiting',
            'Starts when your current game ends.'
        ];
    }
    // Nothing more to say: "Block at" and the counter under it are the rule,
    // spelled out right there. The exception is rating mode with neither limit
    // filled in, where "Extension is on" would promise a block that never comes.
    const noLimits = settings.blockMode === 'rating' && ratingRangeLabel() === NO_RATING_LIMITS;
    return ['Extension is on', noLimits ? 'No rating limits are set, so nothing gets blocked.' : ''];
}

// The pill inside the status panel: the master switch, except while a 1-hour
// block is up or waiting, when it is the way out of that block instead. Only
// "Resume extension" is styled as the primary action - while paused it is the
// one thing left to do here, whereas a way out of a block one asked for is
// something to have, not something to be nudged towards.
function statusAction(phase) {
    if (phase === HOUR_BLOCK) {
        return { label: 'End the 1-hour block now', icon: '#i-x', action: 'endBreak' };
    }
    if (phase === HOUR_PENDING) {
        return { label: 'Cancel the 1-hour block', icon: '#i-x', action: 'endBreak' };
    }
    if (phase === OFF) {
        return { label: 'Resume extension', icon: '#i-play', action: 'resume', primary: true };
    }
    return { label: 'Pause extension', icon: '#i-pause', action: 'pause' };
}

// The button pinned to the bottom, or null when there is no hour to start.
// Rather than showing a greyed-out button nobody can explain, the button is
// simply not there: the status panel above it already says why. Paused: there
// is nothing to block. Limit already reached, or an hour already running:
// chess.com is blocked already, so an hour on top means nothing.
function hourBlockAction(phase) {
    return phase === WATCHING
        ? { label: 'Block chess.com for 1 hour', action: 'startBreak' }
        : null;
}

function renderStatus() {
    const phase = statusOf();
    const status = $('status');
    status.classList.toggle('off', phase === OFF);
    status.classList.toggle('pending', phase === HOUR_PENDING);
    status.classList.toggle('blocked', phase === HOUR_BLOCK || phase === LIMIT_BLOCK);

    const [headline, detail] = statusLines(phase);
    $('status-text').textContent = headline;
    $('status-detail').textContent = detail;
    $('status-detail').hidden = detail === '';

    // Icon and label spell out the whole action, so the button says what it
    // does without leaning on the headline above it.
    const panelAction = statusAction(phase);
    $('status-label').textContent = panelAction.label;
    $('status-icon').setAttribute('href', panelAction.icon);
    $('status-btn').classList.toggle('primary', panelAction.primary === true);
    $('status-btn').dataset.action = panelAction.action;

    const hourBlock = hourBlockAction(phase);
    $('break-btn').hidden = hourBlock === null;
    if (hourBlock !== null) {
        $('break-btn').textContent = hourBlock.label;
        $('break-btn').dataset.action = hourBlock.action;
    }
}

function renderCard() {
    const rating = settings.blockMode === 'rating';
    const windowLabel = settings.resetMode === 'midnight' ? 'today' : 'last 24h';

    $('limit-count').hidden = rating;
    $('limit-range').hidden = !rating;
    $('limit-range').textContent = ratingRangeLabel();
    $('limit-unit').textContent = settings.blockMode;

    $('card-value').hidden = rating;
    $('card-bar').hidden = rating;
    $('rating-list').hidden = !rating;

    if (rating) {
        $('card-title').textContent = 'Rating';
        renderRatingList($('rating-list'), true);
        $('card-note').textContent = '';
        return;
    }

    const count = settings.blockMode === 'losses' ? state.losses : state.games;
    const max = settings.maxGames;
    $('card-title').textContent = `${settings.blockMode === 'losses' ? 'Losses' : 'Games'} · ${windowLabel}`;
    $('card-value').replaceChildren(String(count), Object.assign(document.createElement('span'), {
        className: 'muted',
        textContent: ` / ${max}`
    }));
    const ratio = Math.min(count / max, 1);
    $('card-fill').style.width = `${ratio * 100}%`;
    $('card-fill').classList.toggle('danger', ratio >= 0.8);
    $('card-note').textContent = count > 0 ? resetLabel() : '';
}

// ============ Settings views ============

// What belongs in the username field. The tracked name if there is one; if
// there is not, the one read off chess.com, filled in ready to be accepted.
// The detected name is still only a suggestion - it is not saved by being
// shown here, only by "Start Chess Blocker" - because the account someone is
// logged into is not necessarily the one they want tracked.
function usernameFieldValue() {
    return settings.username || state.detectedUsername;
}

function renderSettings() {
    $('v-username').textContent = settings.username || 'Not set';
    $('v-block').textContent = blockSummary();
    $('v-reset').textContent = settings.resetMode === 'midnight' ? 'At midnight' : 'Rolling 24h';
    $('v-unblock').textContent = settings.unpauseOnRestart ? 'Resumes at restart' : 'Stays paused';
    $('v-games').textContent = gamesSummary();

    $$('[data-username]').forEach((input) => {
        // Never over the top of what someone is in the middle of typing
        if (document.activeElement === input) {
            return;
        }
        input.value = usernameFieldValue();
    });
    // The only thing that disables "Start Chess Blocker" is having nothing to start on
    $('start-btn').disabled = document
        .querySelector('[data-view="setup"] [data-username]').value.trim() === '';
    // The hint is only there to say how to get a name detected, so it steps
    // aside once one has been
    $$('[data-detect-hint]').forEach((hint) => {
        hint.hidden = state.detectedUsername !== '';
    });
    $$('[data-max-games]').forEach((input) => {
        if (document.activeElement !== input) {
            input.value = settings.maxGames;
        }
    });
    $$('[name="block-mode"]').forEach((radio) => {
        radio.checked = radio.value === settings.blockMode;
    });
    $$('[name="reset-mode"]').forEach((radio) => {
        radio.checked = radio.value === settings.resetMode;
    });

    $('block-count').hidden = settings.blockMode === 'rating';
    $('block-rating').hidden = settings.blockMode !== 'rating';
    $('block-unit').textContent = settings.blockMode === 'games' ? 'games' : 'losses';
    if (document.activeElement !== $('rating-floor')) {
        $('rating-floor').value = settings.ratingFloor ?? '';
    }
    if (document.activeElement !== $('rating-ceiling')) {
        $('rating-ceiling').value = settings.ratingCeiling ?? '';
    }
    renderRatingList($('settings-rating-list'), false);

    $('reset-hint').textContent = settings.resetMode === 'midnight'
        ? 'Resets to zero at midnight, local time.'
        : 'Only count games from the last 24 hours.';

    $('unpause-restart').checked = settings.unpauseOnRestart;

    $$('[data-filter]').forEach((checkbox) => {
        checkbox.checked = settings.gameFilters[checkbox.dataset.filter] === true;
    });
}

function render() {
    renderStatus();
    renderCard();
    renderSettings();
}

// Keep the countdowns honest while the popup stays open
setInterval(() => {
    renderStatus();
    renderCard();
}, 30000);

// ============ Username ============
//
// The name is not checked as it is typed: a half-written username is not
// wrong, it is unfinished, and a cross next to it while someone is still
// mid-word says otherwise. It is checked once, when the name is committed -
// "Start Chess Blocker" on the first run, leaving the field afterwards - and the
// only thing that ever appears is the complaint when the answer is "no".

function showUsernameError(message) {
    $$('[data-username-error]').forEach((line) => {
        line.textContent = message ?? '';
        line.hidden = !message;
    });
}

// Ask chess.com whether the name exists. The background script does the
// asking: it owns the one request queue, so this waits its turn behind an
// archive fetch instead of racing it. Returns whether to accept the name -
// offline, rate limited or a server error says nothing about the username,
// so those let it through rather than blocking on a bad connection.
async function usernameAccepted(name) {
    showUsernameError(null);
    if (!normalizeUsername(name)) {
        showUsernameError(`"${name}" is not a chess.com username.`);
        return false;
    }
    const exists = await askBackground({ action: 'checkUsername', username: name });
    debugLog(`popup: chess.com says "${name}" exists: ${exists}`);
    if (exists === 'no') {
        showUsernameError(`No chess.com player called "${name}".`);
        return false;
    }
    return true;
}

// Leaving the username field is the commit. A name chess.com has no player for
// is not stored - it is left in the field, under the complaint about it, so a
// typo can be fixed rather than retyped; nothing has changed underneath, and
// reopening the popup shows the name still being tracked. Clearing the field
// is a commit too: it stops tracking anyone, which is what the first-run view
// is there to undo.
async function commitUsername(input) {
    const name = input.value.trim();
    if (name === settings.username) {
        showUsernameError(null);
        return;
    }
    if (name === '') {
        showUsernameError(null);
        await saveSettings({ username: '' });
        showView('setup');
        return;
    }
    if (await usernameAccepted(name)) {
        await saveSettings({ username: name });
        render();
    }
}

// Unlike the number fields, this one is not saved as it is typed. Storing a
// name mid-word would store "magn" on the way to "magnus" - a name chess.com
// has no player for, which counts nothing and blocks nothing while the popup
// goes on saying blocking is on. So an edit abandoned by dismissing the popup
// is dropped instead, and the field shows the name actually being tracked the
// next time it is opened.
$$('[data-username]').forEach((input) => {
    // Typing clears a complaint about the name that has just been changed
    input.addEventListener('input', () => {
        showUsernameError(null);
        $('start-btn').disabled = input.value.trim() === '';
    });
    // The first run commits with its button instead. Blurring the field is how
    // that button gets clicked, so committing here too would just ask
    // chess.com the same question twice.
    if (input.closest('[data-view="setup"]') === null) {
        input.addEventListener('change', () => commitUsername(input));
    }
});

// The first run's commit. The check takes a round trip to chess.com, so the
// button says so while it waits instead of sitting there looking ignored.
$('start-btn').addEventListener('click', async () => {
    const input = document.querySelector('[data-view="setup"] [data-username]');
    const name = input.value.trim();

    const label = $('start-btn').textContent;
    $('start-btn').disabled = true;
    $('start-btn').replaceChildren(Object.assign(document.createElement('span'), { className: 'spinner' }));

    const accepted = await usernameAccepted(name);

    $('start-btn').disabled = false;
    $('start-btn').textContent = label;

    if (accepted) {
        await saveSettings({ username: name });
        showView('main');
    }
});

// ============ Limit and modes ============

// An empty or half-typed box is left alone until the user leaves the field:
// normalizeMaxGames' fallback would otherwise store 5 over what they are in
// the middle of typing.
$$('[data-max-games]').forEach((input) => {
    bindField(
        input,
        'maxGames',
        (value) => normalizeMaxGames(value, null) ?? undefined,
        (value) => normalizeMaxGames(value)
    );
});

$$('[name="block-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            saveSettings({ blockMode: normalizeBlockMode(radio.value) }).then(render);
        }
    });
});

// An empty rating bound is meaningful (no limit on that side), so unlike the
// limit box it is stored as typed.
bindField($('rating-floor'), 'ratingFloor', normalizeRatingBound, normalizeRatingBound);
bindField($('rating-ceiling'), 'ratingCeiling', normalizeRatingBound, normalizeRatingBound);

$$('[name="reset-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            // The old countdown belongs to the old mode; drop it until the
            // background reports a fresh one
            state.nextReset = null;
            saveSettings({ resetMode: normalizeResetMode(radio.value) }).then(render);
        }
    });
});

$('unpause-restart').addEventListener('change', () => {
    saveSettings({ unpauseOnRestart: $('unpause-restart').checked }).then(render);
});

$$('[data-filter]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
        const gameFilters = {};
        $$('[data-filter]').forEach((box) => {
            gameFilters[box.dataset.filter] = box.checked;
        });
        saveSettings({ gameFilters }).then(render);
    });
});

// ============ The pause switch and the 1-hour block ============
//
// renderStatus decided what each of these two buttons is offering, and wrote
// it onto the button along with the label that says so. `pause` and `resume`
// are the two ends of the one master switch; the rest are messages by name.

$$('#status-btn, #break-btn').forEach((button) => {
    button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'pause' || action === 'resume') {
            sendToBackground({ action: 'setPaused', paused: action === 'pause' });
        } else if (action) {
            sendToBackground({ action });
        }
    });
});

// ============ Keep the popup in step with storage ============

// The background script (or this same popup) writes to storage; render from
// what actually landed there rather than from what we think we wrote.
extensionApi.storage.onChanged.addListener((changes, areaName) => {
    const [target, defaults] = areaName === 'local'
        ? [state, STATE_DEFAULTS]
        : areaName === 'sync' ? [settings, SETTINGS_DEFAULTS] : [null, null];
    if (!target) {
        return;
    }
    for (const [key, change] of Object.entries(changes)) {
        if (key in target) {
            // A removed key falls back to its default
            target[key] = change.newValue ?? defaults[key];
        }
    }
    normalizeSettings();
    if (DEBUG && 'detectedUsername' in changes) {
        debugLog(`popup: detected username is now "${state.detectedUsername}"`);
    }
    render();
});

function normalizeSettings() {
    settings.maxGames = normalizeMaxGames(settings.maxGames);
    settings.resetMode = normalizeResetMode(settings.resetMode);
    settings.blockMode = normalizeBlockMode(settings.blockMode);
    settings.ratingFloor = normalizeRatingBound(settings.ratingFloor);
    settings.ratingCeiling = normalizeRatingBound(settings.ratingCeiling);
    settings.unpauseOnRestart = settings.unpauseOnRestart !== false;
    settings.gameFilters = { ...DEFAULT_FILTERS, ...(settings.gameFilters ?? {}) };
    settings.username = settings.username ?? '';
    state.detectedUsername = normalizeUsername(state.detectedUsername) ?? '';
    state.paused = state.paused === true;
    state.blocked = state.blocked === true;
    state.limitHit = state.limitHit === true;
    // Stored as true by older builds, as the click's timestamp by current ones
    state.breakPending = state.breakPending === true || typeof state.breakPending === 'number';
    state.ratings = state.ratings ?? {};
}

// ============ Initial load ============

Promise.all([
    extensionApi.storage.sync.get(SETTINGS_DEFAULTS),
    extensionApi.storage.local.get(STATE_DEFAULTS)
]).then(([storedSettings, storedState]) => {
    Object.assign(settings, storedSettings);
    Object.assign(state, storedState);
    normalizeSettings();
    debugLog(`popup: tracking "${settings.username}", detected "${state.detectedUsername}"`);
    showView(settings.username ? 'main' : 'setup');
});
