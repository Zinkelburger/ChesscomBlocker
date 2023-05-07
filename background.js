// Function to check the chess.com API for the number of games played
function checkGamesPlayed() {
    // Get the maximum number of games and username from chrome.storage
    chrome.storage.sync.get({
      maxGames: 5,
      username: ''
    }, function(items) {
      let maxGames = items.maxGames;
      let username = items.username.toLowerCase();
      console.log('Username from storage:', username);
  
      // Get the current year and month
      let date = new Date();
      let year = date.getFullYear();
      let month = (date.getMonth() + 1).toString().padStart(2, '0');
  
      // Account for the edge case where it is the first of the month
      if (date.getDate() === 1) {
        month--;
        if (month === 0) {
          month = 12;
          year--;
        }
      }
      // Construct the URL for the API request
      let url = `https://api.chess.com/pub/player/${username}/games/${year}/${month}`;
  
      // Fetch data from the chess.com API
      fetch(url)
        .then(response => response.json())
        .then(data => {
          console.log('Data from chess.com API:', data);
          // Initialize a counter for the number of losses
          let losses = 0;
  
          // Get the current Unix timestamp
          let now = Math.round(new Date().getTime() / 1000);
  
          // Iterate through all of the games
          for (let game of data.games) {
            // Check if this game was played within the last 24 hours
            if (now - game.end_time <= 86400) {
              // Check if the user lost this game
              if (game.white.username.toLowerCase() === username && game.black.result === 'win') {
                losses++;
              } else if (game.black.username.toLowerCase() === username && game.white.result === 'win') {
                losses++;
              }
            }
          }
  
          // Update the number of losses in chrome.storage
          chrome.storage.sync.set({ losses: losses });
  
          // Check if the user has exceeded the maximum number of losses allowed
          if (losses > maxGames) {
            chrome.storage.sync.set({ blocked: true });
          } else {
            chrome.storage.sync.set({ blocked: false });
          }
        });
    });
  }
  // Check the number of games played every 30 seconds
  setInterval(checkGamesPlayed, 30000);
  
  // Run checkGamesPlayed when the extension is clicked
  chrome.action.onClicked.addListener((tab) => {
    checkGamesPlayed();
  });
  
  // Run checkGamesPlayed when the current site is chess.com
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && changeInfo.url.startsWith("https://www.chess.com/")) {
      checkGamesPlayed();
    }
  });
  
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'checkGamesPlayed') {
      checkGamesPlayed();
    }
  });