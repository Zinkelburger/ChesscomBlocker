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
  