// Popup / options page. Depends on shared.js and lossCounter.js, which
// options.html loads first.

// Cached copy of what the background script last computed, so the countdown
// can be re-rendered on a timer without hitting storage again
let currentResetMode = DEFAULT_RESET_MODE;
let currentNextReset = null;

const maxGamesInput = document.getElementById('max-games');
const usernameInput = document.getElementById('username');
const resetModeInputs = document.querySelectorAll('[data-reset-mode]');
const filterCheckboxes = document.querySelectorAll('[data-filter]');

// ============ Username and limit ============

function saveOptions() {
    const maxGames = normalizeMaxGames(maxGamesInput.value);
    // Reflect the value we actually stored, so the field never shows
    // something the extension is not using
    maxGamesInput.value = maxGames;

    extensionApi.storage.sync.set({
        maxGames,
        username: usernameInput.value.trim()
    }).then(() => sendToBackground({ action: 'checkGamesPlayed' }));
}

maxGamesInput.addEventListener('change', saveOptions);
usernameInput.addEventListener('change', saveOptions);

// ============ Session disable ============

function updateDisabledUI(isDisabled) {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    document.getElementById('session-disable').checked = isDisabled;
    statusDot.classList.toggle('disabled', isDisabled);
    statusText.textContent = isDisabled ? 'Disabled for Session' : 'Extension Active';
}

document.getElementById('session-disable').addEventListener('change', (event) => {
    // Session storage clears itself when the browser closes
    extensionApi.storage.session.set({ sessionDisabled: event.target.checked })
        .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
});

// ============ Counter reset ============

// The timezone the computer is set to, e.g. "Europe/Berlin"
function localTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (error) {
        return '';
    }
}

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

// One line under the loss count saying when it clears
function renderResetNote() {
    const note = document.getElementById('reset-note');
    const remaining = currentNextReset ? currentNextReset - Date.now() : null;
    const countdown = remaining !== null && remaining > 0 ? formatCountdown(remaining) : null;

    if (currentResetMode === 'midnight') {
        note.textContent = countdown ? `Resets at midnight, in ${countdown}` : 'Resets at midnight';
    } else {
        note.textContent = countdown
            ? `Rolling 24h — oldest loss clears in ${countdown}`
            : 'Rolling 24-hour window';
    }
}

// Explanatory line under the two reset-mode chips
function renderResetHint() {
    const hint = document.getElementById('reset-hint');
    if (currentResetMode === 'midnight') {
        const timezone = localTimezone();
        hint.textContent = timezone
            ? `Clears at 00:00 in this computer's timezone (${timezone}).`
            : "Clears at 00:00 in this computer's timezone.";
    } else {
        hint.textContent = 'Each loss stops counting 24 hours after the game ended.';
    }
}

function renderResetMode() {
    resetModeInputs.forEach((input) => {
        input.checked = input.dataset.resetMode === currentResetMode;
    });
    renderResetNote();
    renderResetHint();
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

// Keep the countdown honest while the popup stays open
setInterval(renderResetNote, 30000);

// ============ Game type filters ============

const gearBtn = document.getElementById('gear-btn');
const mainPanel = document.getElementById('main-panel');
const settingsPanel = document.getElementById('settings-panel');
const toggleAllBtn = document.getElementById('toggle-all-btn');

gearBtn.addEventListener('click', () => {
    const showSettings = settingsPanel.classList.contains('hidden');
    mainPanel.classList.toggle('hidden', showSettings);
    settingsPanel.classList.toggle('hidden', !showSettings);
    gearBtn.classList.toggle('active', showSettings);
});

function allFiltersChecked() {
    return Array.from(filterCheckboxes).every((checkbox) => checkbox.checked);
}

function updateToggleAllButton() {
    toggleAllBtn.textContent = allFiltersChecked() ? 'Deselect All' : 'Select All';
}

function saveFilters() {
    const filters = {};
    filterCheckboxes.forEach((checkbox) => {
        filters[checkbox.dataset.filter] = checkbox.checked;
    });
    updateToggleAllButton();

    extensionApi.storage.sync.set({ gameFilters: filters })
        .then(() => sendToBackground({ action: 'checkGamesPlayed' }));
}

toggleAllBtn.addEventListener('click', () => {
    const newState = !allFiltersChecked();
    filterCheckboxes.forEach((checkbox) => {
        checkbox.checked = newState;
    });
    saveFilters();
});

filterCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', saveFilters);
});

// ============ Keep the popup in step with storage ============

// The background script (or this same popup) writes to storage; render from
// what actually landed there rather than from what we think we wrote.
extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
        if (changes.losses) {
            document.getElementById('num-losses').textContent = changes.losses.newValue;
        }
        if (changes.nextReset) {
            currentNextReset = changes.nextReset.newValue;
            renderResetNote();
        }
        if (changes.resetMode) {
            currentResetMode = normalizeResetMode(changes.resetMode.newValue);
            renderResetMode();
        }
    }
    if (areaName === 'session' && changes.sessionDisabled) {
        updateDisabledUI(changes.sessionDisabled.newValue);
    }
});

// ============ Initial load ============

extensionApi.storage.sync.get({
    maxGames: DEFAULT_MAX_GAMES,
    username: '',
    losses: 0,
    resetMode: DEFAULT_RESET_MODE,
    nextReset: null,
    gameFilters: DEFAULT_FILTERS
}).then((items) => {
    maxGamesInput.value = normalizeMaxGames(items.maxGames);
    usernameInput.value = items.username;
    document.getElementById('num-losses').textContent = items.losses;

    currentResetMode = normalizeResetMode(items.resetMode);
    currentNextReset = items.nextReset;
    renderResetMode();

    const filters = { ...DEFAULT_FILTERS, ...items.gameFilters };
    filterCheckboxes.forEach((checkbox) => {
        checkbox.checked = filters[checkbox.dataset.filter] === true;
    });
    updateToggleAllButton();
});

extensionApi.storage.session.get({ sessionDisabled: false })
    .then((items) => updateDisabledUI(items.sessionDisabled));
