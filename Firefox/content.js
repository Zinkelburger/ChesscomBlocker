// Check the current value of "blocked" in chrome.storage when the content script is first injected into the page
browser.storage.sync.get({ blocked: false }, function(items) {
    console.log('Received blocked value from chrome.storage:', items.blocked);
    // If blocked is true, update the page accordingly
    if (items.blocked === true && /https?:\/\/.*chess\.com\/(game|play\/online)/.test(window.location.href)) {
        document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of games allowed.</h1>';
    }
   });
   
   // Listen for changes to the "blocked" value in chrome.storage
   browser.storage.onChanged.addListener(function(changes, namespace) {
    // Check if the "blocked" value has changed
    if (changes.blocked) {
    console.log('Received blocked change:', changes.blocked.newValue);
    // If so, update the page accordingly
    if (changes.blocked.newValue === true && window.location.href === 'https://www.chess.com/play/online') {
    document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of games allowed.</h1>';
    }
    }
   });
