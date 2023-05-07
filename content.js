chrome.storage.onChanged.addListener(function(changes, namespace) {
  // Check if the "blocked" value has changed
  if (changes.blocked) {
    if (changes.blocked.newValue === true && window.location.href === 'https://www.chess.com/play/online') {
      document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of games allowed.</h1>';
    }
    }
 });

chrome.storage.sync.get({ blocked: false }, function(items) {
  // If blocked is true, update the page accordingly
  if (items.blocked === true && window.location.href === 'https://www.chess.com/play/online') {
  document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of games allowed.</h1>';
  }
 });