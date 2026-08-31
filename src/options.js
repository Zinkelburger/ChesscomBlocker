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
    breakUntil: null,
    paused: false,
    blocked: false
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
    return extensionApi.storage.sync.set(patch)
        .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
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

// ============ Formatting ============

function resetLabel() {
    const remaining = state.nextReset ? state.nextReset - Date.now() : 0;
    if (settings.resetMode === 'midnight') {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        return `Resets at ${midnight.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    return remaining > 0 ? `Resets in ${formatCountdown(remaining)}` : '';
}

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
    return 'never (no limits set)';
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

function renderStatus() {
    const onBreak = state.breakUntil && state.breakUntil > Date.now();
    const status = $('status');
    status.classList.toggle('paused', state.paused);
    status.classList.toggle('blocked', !state.paused && state.blocked);

    let text = 'Active';
    if (state.paused) {
        text = 'Paused';
    } else if (onBreak) {
        text = `On break · ${formatCountdown(state.breakUntil - Date.now())}`;
    } else if (state.blocked) {
        text = 'Blocked';
    }
    $('status-text').textContent = text;

    $('pause-icon').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
    $('pause-label').textContent = state.paused ? 'Resume' : 'Pause';
    $('pause-btn').classList.toggle('primary', state.paused);

    $('break-btn').textContent = onBreak ? 'End break' : 'Block after this game';
    $('break-btn').disabled = state.paused;
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

function renderSettings() {
    $('v-username').textContent = settings.username || 'Not set';
    $('v-block').textContent = blockSummary();
    $('v-reset').textContent = settings.resetMode === 'midnight' ? 'At midnight' : 'Every 24h';
    $('v-pause').textContent = settings.unpauseOnRestart ? 'Unpause on restart' : 'Stays paused';
    $('v-games').textContent = gamesSummary();

    $$('[data-username]').forEach((input) => {
        if (document.activeElement !== input) {
            input.value = settings.username;
        }
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
        ? 'Midnight on this computer\'s clock'
        : 'Each game stops counting 24 hours after it ended';

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

// How long to wait after the last keystroke before asking chess.com. Without
// it every character fires a request, and a half-typed name shows a cross
// while the user is still in the middle of writing it.
const USERNAME_DEBOUNCE_MS = 400;

let usernameCheck = 0;
let usernameTimer = null;

function showUsernameStatus(kind, title) {
    $$('[data-username-status]').forEach((icon) => {
        icon.dataset.kind = kind ?? '';
        icon.title = title ?? '';
        icon.replaceChildren();
        if (kind) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'icon small');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', kind === 'ok' ? '#i-check' : '#i-x');
            svg.append(use);
            icon.append(svg);
        }
    });
}

// Ask chess.com whether the username exists, and show a tick or a cross
async function verifyUsername(name) {
    const token = ++usernameCheck;

    if (!name) {
        showUsernameStatus(null);
        $('start-btn').disabled = true;
        return;
    }
    try {
        const response = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(name.toLowerCase())}`);
        if (token !== usernameCheck) {
            return;
        }
        const found = response.ok;
        showUsernameStatus(found ? 'ok' : 'bad', found ? 'Found on chess.com' : 'Not found on chess.com');
        $('start-btn').disabled = !found;
    } catch (error) {
        if (token === usernameCheck) {
            showUsernameStatus(null, '');
            $('start-btn').disabled = false; // Offline: let them through anyway
        }
    }
}

// The same check, held back until the user stops typing. The icon is cleared
// straight away so a result about an older, shorter name cannot sit there
// contradicting what is now in the box.
function verifyUsernameSoon(name) {
    clearTimeout(usernameTimer);
    usernameCheck++; // Retire any in-flight request: it is about an older name
    showUsernameStatus(null);
    $('start-btn').disabled = true;
    if (!name) {
        return;
    }
    usernameTimer = setTimeout(() => verifyUsername(name), USERNAME_DEBOUNCE_MS);
}

$$('[data-username]').forEach((input) => {
    input.addEventListener('input', () => verifyUsernameSoon(input.value.trim()));
    input.addEventListener('change', () => saveSettings({ username: input.value.trim() }));
});

$('start-btn').addEventListener('click', () => {
    const input = document.querySelector('[data-view="setup"] [data-username]');
    saveSettings({ username: input.value.trim() }).then(() => showView('main'));
});

// ============ Limit and modes ============

// The number inputs echo the normalized value straight back, because
// renderSettings deliberately leaves a focused input alone and a `change`
// event can fire while the field still has focus. Without this, a rejected
// value ("abc") stays on screen while the stored setting says something else.
$$('[data-max-games]').forEach((input) => {
    input.addEventListener('change', () => {
        const maxGames = normalizeMaxGames(input.value);
        input.value = maxGames;
        saveSettings({ maxGames }).then(render);
    });
});

$$('[name="block-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            saveSettings({ blockMode: normalizeBlockMode(radio.value) }).then(render);
        }
    });
});

$('rating-floor').addEventListener('change', () => {
    const ratingFloor = normalizeRatingBound($('rating-floor').value);
    $('rating-floor').value = ratingFloor ?? '';
    saveSettings({ ratingFloor }).then(render);
});
$('rating-ceiling').addEventListener('change', () => {
    const ratingCeiling = normalizeRatingBound($('rating-ceiling').value);
    $('rating-ceiling').value = ratingCeiling ?? '';
    saveSettings({ ratingCeiling }).then(render);
});

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

// ============ Pause and break ============

$('pause-btn').addEventListener('click', () => {
    sendToBackground({ action: 'setPaused', paused: !state.paused });
});

$('break-btn').addEventListener('click', () => {
    const onBreak = state.breakUntil && state.breakUntil > Date.now();
    sendToBackground({ action: onBreak ? 'endBreak' : 'startBreak' });
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
    state.paused = state.paused === true;
    state.blocked = state.blocked === true;
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
    showView(settings.username ? 'main' : 'setup');
    if (settings.username) {
        verifyUsername(settings.username);
    }
});
