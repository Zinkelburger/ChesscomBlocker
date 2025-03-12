// Save options to chrome.storage
function save_options() {
    let maxGames = document.getElementById('max-games').value;
    let username = document.getElementById('username').value;
    
    chrome.storage.sync.set({
        maxGames: maxGames,
        username: username
    }, () => {
        // Once saved, request an updated check
        chrome.runtime.sendMessage({ action: 'checkGamesPlayed' });
    });
}

// Listen for changes to "losses" in storage and update the page
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (changes.losses) {
        document.getElementById('num-losses').textContent = changes.losses.newValue;
    }
});

// Attach 'change' event listeners to inputs
document.getElementById('max-games').addEventListener('change', save_options);
document.getElementById('username').addEventListener('change', save_options);

// On page load, populate the fields from chrome.storage
chrome.storage.sync.get({
    maxGames: 5,
    username: '',
    losses: 0
}, (items) => {
    document.getElementById('max-games').value = items.maxGames;
    document.getElementById('username').value = items.username;
    document.getElementById('num-losses').textContent = items.losses;
});
