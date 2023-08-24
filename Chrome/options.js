// Save options to chrome.storage
function save_options() {
    let maxGames = document.getElementById('max-games').value;
    let username = document.getElementById('username').value;
    chrome.storage.sync.set({
        maxGames: maxGames,
        username: username
    });
    // query the api
    chrome.runtime.sendMessage({
        action: "checkGamesPlayed"
    });
}

// Add an event listener to the chrome.storage.onChanged event
chrome.storage.onChanged.addListener(function(changes, namespace) {
    // Check if the "losses" value has changed
    if (changes.losses) {
        // If so, update the number of losses displayed on the page
        document.getElementById('num-losses').textContent = changes.losses.newValue;
    }
});

document.getElementById('options-form').addEventListener('submit', function(event) {
    event.preventDefault();
    save_options();
    chrome.runtime.sendMessage({
        action: 'checkGamesPlayed'
    });
});

document.getElementById('options-form').addEventListener('submit', save_options);

// Load options from chrome.storage
chrome.storage.sync.get({
    maxGames: 5,
    username: '',
    losses: 0
}, function(items) {
    document.getElementById('max-games').value = items.maxGames;
    document.getElementById('username').value = items.username;
    document.getElementById('num-losses').textContent = items.losses;
});
