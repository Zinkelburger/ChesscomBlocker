// Popup / options page. Depends on shared.js and lossCounter.js, which
// options.html loads first.

// Cached copy of what the background script last computed, so the countdowns
// can be re-rendered on a timer without hitting storage again
let currentResetMode = DEFAULT_RESET_MODE;
let currentNextReset = null;
let currentBreakUntil = null;

const maxGamesInput = document.getElementById('max-games');
const usernameInput = document.getElementById('username');
const breakBtn = document.getElementById('break-btn');
const resetModeInputs = document.querySelectorAll('[data-reset-mode]');
const filterCheckboxes = document.querySelectorAll('[data-filter]');

// ============ Username and limit ============

function saveOptions() {
    const maxGames = normalizeMaxGames(maxGamesInput.value);
    // Reflect the value we actually stored, so the field never shows
    // something the extension is not using
    maxGamesInput.value = maxGames;
    document.getElementById('max-losses').textContent = maxGames;

    extensionApi.storage.sync.set({
        maxGames,
        username: usernameInput.value.trim()
    }).then(() => sendToBackground({ action: 'checkGamesPlayed' }));
}

maxGamesInput.addEventListener('change', saveOptions);
usernameInput.addEventListener('change', saveOptions);

// ============ Break ("Block after this game") ============

function renderBreak() {
    const note = document.getElementById('break-note');
    const remaining = currentBreakUntil ? currentBreakUntil - Date.now() : 0;
    const onBreak = remaining > 0;

    breakBtn.textContent = onBreak ? 'End break' : 'Block after this game';
    breakBtn.classList.toggle('secondary', onBreak);
    note.textContent = onBreak ? `On break for ${formatCountdown(remaining)}` : '';
}

breakBtn.addEventListener('click', () => {
    const onBreak = currentBreakUntil && currentBreakUntil > Date.now();
    sendToBackground({ action: onBreak ? 'endBreak' : 'startBreak' });
});

// ============ Session disable ============

document.getElementById('session-disable').addEventListener('change', (event) => {
    // Session storage clears itself when the browser closes
    extensionApi.storage.session.set({ sessionDisabled: event.target.checked })
        .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
});

// ============ Counter reset ============

// One line under the loss count saying when it clears
function renderResetNote() {
    const note = document.getElementById('reset-note');
    const remaining = currentNextReset ? currentNextReset - Date.now() : 0;
    const countdown = remaining > 0 ? formatCountdown(remaining) : null;

    if (currentResetMode === 'midnight') {
        note.textContent = countdown ? `Resets at midnight (${countdown})` : 'Resets at midnight';
    } else {
        note.textContent = countdown ? `Oldest loss clears in ${countdown}` : 'Counts the last 24 hours';
    }
}

function renderResetMode() {
    resetModeInputs.forEach((input) => {
        input.checked = input.dataset.resetMode === currentResetMode;
    });
    renderResetNote();
}

resetModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
        if (!input.checked) {
            return;
        }
        currentResetMode = normalizeResetMode(input.dataset.resetMode);
        // The old countdown belongs to the old mode; drop it until the
        // background script reports a fresh one
        currentNextReset = null;
        renderResetMode();
        extensionApi.storage.sync.set({ resetMode: currentResetMode })
            .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
    });
});

// Keep the countdowns honest while the popup stays open
setInterval(() => {
    renderResetNote();
    renderBreak();
}, 30000);

// ============ Game type filters ============

function saveFilters() {
    const filters = {};
    filterCheckboxes.forEach((checkbox) => {
        filters[checkbox.dataset.filter] = checkbox.checked;
    });
    extensionApi.storage.sync.set({ gameFilters: filters })
        .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
}

filterCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', saveFilters);
});

// ============ Keep the popup in step with storage ============

// The background script (or this same popup) writes to storage; render from
// what actually landed there rather than from what we think we wrote.
extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        if (changes.losses) {
            document.getElementById('num-losses').textContent = changes.losses.newValue;
        }
        if (changes.nextReset) {
            currentNextReset = changes.nextReset.newValue;
            renderResetNote();
        }
        if (changes.breakUntil) {
            currentBreakUntil = changes.breakUntil.newValue ?? null;
            renderBreak();
        }
    } else if (areaName === 'sync' && changes.resetMode) {
        currentResetMode = normalizeResetMode(changes.resetMode.newValue);
        renderResetMode();
    } else if (areaName === 'session' && changes.sessionDisabled) {
        document.getElementById('session-disable').checked = changes.sessionDisabled.newValue;
    }
});

// ============ Initial load ============

// Settings come from sync storage, the computed result from local storage
Promise.all([
    extensionApi.storage.sync.get({
        maxGames: DEFAULT_MAX_GAMES,
        username: '',
        resetMode: DEFAULT_RESET_MODE,
        gameFilters: DEFAULT_FILTERS
    }),
    extensionApi.storage.local.get({ losses: 0, nextReset: null, breakUntil: null })
]).then(([settings, state]) => {
    const maxGames = normalizeMaxGames(settings.maxGames);
    maxGamesInput.value = maxGames;
    document.getElementById('max-losses').textContent = maxGames;
    usernameInput.value = settings.username;
    document.getElementById('num-losses').textContent = state.losses;

    currentResetMode = normalizeResetMode(settings.resetMode);
    currentNextReset = state.nextReset;
    renderResetMode();

    currentBreakUntil = state.breakUntil;
    renderBreak();

    const filters = { ...DEFAULT_FILTERS, ...settings.gameFilters };
    filterCheckboxes.forEach((checkbox) => {
        checkbox.checked = filters[checkbox.dataset.filter] === true;
    });
});

extensionApi.storage.session.get({ sessionDisabled: false })
    .then((items) => {
        document.getElementById('session-disable').checked = items.sessionDisabled;
    });
