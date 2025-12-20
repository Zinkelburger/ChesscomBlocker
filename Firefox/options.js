// Default filters - standard time controls only, standard chess
const DEFAULT_FILTERS = {
    // Time controls
    bullet: true,
    blitz: true,
    rapid: true,
    daily: false,
    // Variants
    chess: true,
    chess960: false,
    bughouse: false,
    crazyhouse: false,
    threecheck: false,
    kingofthehill: false
};

// Save options to browser.storage
function save_options() {
    const maxGames = document.getElementById('max-games').value;
    const username = document.getElementById('username').value;
    
    // In Firefox, browser.storage.sync.set returns a Promise
    browser.storage.sync.set({ 
        maxGames, 
        username 
    }).then(() => {
        // Once saved, re-check games played
        browser.runtime.sendMessage({ action: 'checkGamesPlayed' });
    });
}

// Update the UI to reflect disabled state
function updateDisabledUI(isDisabled) {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const toggle = document.getElementById('session-disable');
    
    toggle.checked = isDisabled;
    
    if (isDisabled) {
        statusDot.classList.add('disabled');
        statusText.textContent = 'Disabled for Session';
    } else {
        statusDot.classList.remove('disabled');
        statusText.textContent = 'Extension Active';
    }
}

// Handle session disable toggle
document.getElementById('session-disable').addEventListener('change', (e) => {
    const isDisabled = e.target.checked;
    
    // Send message to background script to update session state
    browser.runtime.sendMessage({ 
        action: 'SET_SESSION_DISABLED', 
        value: isDisabled 
    }).then((response) => {
        updateDisabledUI(response.sessionDisabled);
    });
});

// Listen for changes to "losses" in storage
browser.storage.onChanged.addListener((changes, namespace) => {
    if (changes.losses) {
        document.getElementById('num-losses').textContent = changes.losses.newValue;
    }
});

// Attach 'change' event listeners to inputs
document.getElementById('max-games').addEventListener('change', save_options);
document.getElementById('username').addEventListener('change', save_options);

// On page load, populate fields from browser.storage
browser.storage.sync.get({ maxGames: 5, username: '', losses: 0 })
    .then(items => {
        document.getElementById('max-games').value = items.maxGames;
        document.getElementById('username').value = items.username;
        document.getElementById('num-losses').textContent = items.losses;
    });

// Load session disable state from background script
browser.runtime.sendMessage({ action: 'GET_SESSION_DISABLED' })
    .then((response) => {
        updateDisabledUI(response.sessionDisabled);
    });

// ============ Settings Panel ============

const gearBtn = document.getElementById('gear-btn');
const mainPanel = document.getElementById('main-panel');
const settingsPanel = document.getElementById('settings-panel');
const toggleAllBtn = document.getElementById('toggle-all-btn');
const filterCheckboxes = document.querySelectorAll('[data-filter]');

// Panel switching
function showSettings() {
    mainPanel.classList.add('hidden');
    settingsPanel.classList.remove('hidden');
    gearBtn.classList.add('active');
}

function showMain() {
    settingsPanel.classList.add('hidden');
    mainPanel.classList.remove('hidden');
    gearBtn.classList.remove('active');
}

gearBtn.addEventListener('click', () => {
    if (settingsPanel.classList.contains('hidden')) {
        showSettings();
    } else {
        showMain();
    }
});

// Save filters to storage
function saveFilters() {
    const filters = {};
    filterCheckboxes.forEach(cb => {
        filters[cb.dataset.filter] = cb.checked;
    });
    
    browser.storage.sync.set({ gameFilters: filters }).then(() => {
        browser.runtime.sendMessage({ action: 'checkGamesPlayed' });
    });
    
    updateToggleAllButton();
}

// Update toggle all button text
function updateToggleAllButton() {
    const allChecked = Array.from(filterCheckboxes).every(cb => cb.checked);
    toggleAllBtn.textContent = allChecked ? 'Deselect All' : 'Select All';
}

// Toggle all filters
toggleAllBtn.addEventListener('click', () => {
    const allChecked = Array.from(filterCheckboxes).every(cb => cb.checked);
    const newState = !allChecked;
    
    filterCheckboxes.forEach(cb => {
        cb.checked = newState;
    });
    
    saveFilters();
});

// Add change listeners to all filter checkboxes
filterCheckboxes.forEach(cb => {
    cb.addEventListener('change', saveFilters);
});

// Load filters from storage
browser.storage.sync.get({ gameFilters: DEFAULT_FILTERS }).then((items) => {
    const filters = items.gameFilters;
    
    filterCheckboxes.forEach(cb => {
        const filterName = cb.dataset.filter;
        // Use saved value if exists, otherwise use default
        cb.checked = filters.hasOwnProperty(filterName) ? filters[filterName] : DEFAULT_FILTERS[filterName];
    });
    
    updateToggleAllButton();
});
