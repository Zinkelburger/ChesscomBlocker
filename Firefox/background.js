// Function to check the chess.com API for the number of games played
async function checkGamesPlayed() {
    // Get the maximum number of games and username from chrome.storage
    let items = await browser.storage.sync.get({
      maxGames: 5,
      username: ''
    });
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
    let response = await fetch(url);
    let data = await response.json();
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
    await browser.storage.sync.set({ losses: losses });
  
    // Check if the user has exceeded the maximum number of losses allowed
    if (losses > maxGames) {
      // Set blocked to true in chrome.storage
      console.log('Setting blocked to true in chrome.storage');
      await browser.storage.sync.set({ blocked: true });
    }
  }
  
  // Check the number of games played every 60 seconds
  setInterval(checkGamesPlayed, 60000);
  
  // Run checkGamesPlayed when the extension is clicked
  browser.action.onClicked.addListener((tab) => {
   checkGamesPlayed();
  });
  
  // Run checkGamesPlayed when the current site is chess.com
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
   if (changeInfo.url && changeInfo.url.startsWith("https://www.chess.com/")) {
   checkGamesPlayed();
   }
  });
  
  browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
   if (request.action === 'checkGamesPlayed') {
   checkGamesPlayed();
   }
  });