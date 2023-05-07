// Save options to chrome.storage
function save_options() {
  let maxGames = document.getElementById('max-games').value;
  let username = document.getElementById('username').value;
  chrome.storage.sync.set({ maxGames: maxGames, username: username });
}

// Load options from chrome.storage
function load_options() {
  chrome.storage.sync.get({ maxGames: 5, username: '', losses: 0 },
  function(items) {
    document.getElementById('max-games').value = items.maxGames;
    document.getElementById('username').value = items.username;
    document.getElementById('blocked').textContent = items.losses;
  });
}

// Add an event listener to the chrome.storage.onChanged event
chrome.storage.onChanged.addListener(function(changes, namespace) {
  // Check if the "losses" value has changed
  if (changes.losses) {
    // If so, update the number of losses displayed on the page
    document.getElementById('blocked').textContent = changes.losses.newValue;
  }
});

document.getElementById('options-form').addEventListener('submit', function(event) {
  event.preventDefault();
  chrome.runtime.sendMessage({action: 'checkGamesPlayed'});
});

// Add event listeners
document.addEventListener('DOMContentLoaded', load_options);
document.getElementById('options-form').addEventListener('submit', save_options);