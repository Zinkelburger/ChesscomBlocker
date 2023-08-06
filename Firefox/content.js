// Check the current value of "blocked" in chrome.storage when the content script is first injected into the page
browser.storage.sync.get({ blocked: false }, function(items) {
        console.log('Received blocked value from chrome.storage:', items.blocked);
        // If blocked is true, update the page accordingly
        if (items.blocked === true && /https?:\/\/.*chess\.com\/(game|play\/online)/.test(window.location.href)) {
                document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of losses allowed.</h1>';
        }
});
   
// Listen for changes to the "blocked" value in chrome.storage
browser.storage.onChanged.addListener(function(changes, namespace) {
        // Check if the "blocked" value has changed
        if (changes.blocked) {
                console.log('Received blocked change:', changes.blocked.newValue);
                // If so, update the page accordingly
                if (changes.blocked.newValue === true && /https?:\/\/.*chess\.com\/(game|play\/online)/.test(window.location.href)) {
                        document.body.innerHTML = '<h1 style="color: white; background-color: black;">Chess.com has been blocked because you have exceeded the maximum number of losses allowed.</h1>';
                }
        }
});

// Find the first element whose id attribute contains the string "placeholder-"
let attempts = 0;
let targetNode;
const intervalId = setInterval(() => {
        // Find the first element whose id attribute contains the string "placeholder-"
        targetNode = document.querySelector("[id*='placeholder-']");
        if (targetNode) {
                console.log("Found target node:", targetNode);
                clearInterval(intervalId);
                observer.observe(targetNode, config);
        } else {
                attempts++;
                console.log(`Attempt ${attempts}: target node not found`);
                if (attempts >= 100) {
                        console.log("Max attempts reached, stopping search");
                        clearInterval(intervalId);
                }
        }
}, 5000);

// Options for the observer (which mutations to observe)
const config = { attributes: true, childList: true, subtree: true };

// Callback function to execute when mutations are observed
const callback = (mutationList, observer) => {
        // wait a bit, do it a few times
        setTimeout(() => {
                browser.runtime.sendMessage({ action: "checkGamesPlayed" });
        }, 1500);
        setTimeout(() => {
                browser.runtime.sendMessage({ action: "checkGamesPlayed" });
        }, 5000);
        setTimeout(() => {
                browser.runtime.sendMessage({ action: "checkGamesPlayed" });
        }, 10000);
};

// Create an observer instance linked to the callback function
const observer = new MutationObserver(callback);





