function debounce(func, wait) {
    let timeout;

    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };

        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Save options to browser.storage
function save_options() {
    let maxGames = document.getElementById('max-games').value;
    let username = document.getElementById('username').value;
    browser.storage.sync.set({
        maxGames: maxGames,
        username: username
    });
    // query the api
    browser.runtime.sendMessage({
        action: "checkGamesPlayed"
    });
}

// Listen for changes to the num-losses
browser.storage.onChanged.addListener(function(changes, namespace) {
    // Check if the "losses" value has changed
    if (changes.losses) {
        // If so, update the number of losses displayed on the page
        document.getElementById('num-losses').textContent = changes.losses.newValue;
    }
});

let debouncedSave = debounce(function() {
    save_options();
}, 1000);

window.addEventListener('beforeunload', function() {
    save_options();
});

document.getElementById('max-games').addEventListener('input', debouncedSave);
document.getElementById('username').addEventListener('input', debouncedSave);

// Set the form to values from browser.storage
browser.storage.sync.get({
    maxGames: 5,
    username: '',
    losses: 0
}, function(items) {
    document.getElementById('max-games').value = items.maxGames;
    document.getElementById('username').value = items.username;
    document.getElementById('num-losses').textContent = items.losses;
});