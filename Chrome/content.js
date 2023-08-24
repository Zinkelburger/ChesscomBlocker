// Check the current value of "blocked" in chrome.storage when the content script is first injected into the page
chrome.storage.sync.get({
    blocked: false
}, function(items) {
    // If blocked is true, update the page accordingly
    if (items.blocked === true && /https?:\/\/.*chess\.com\/(game|play\/online)/.test(window.location.href)) {
        document.body.outerHTML = `
        <body style="display: flex; justify-content: center; height: 100vh; background-color:rgb(48, 46, 43); padding: 0px;">
        <div style="
            display: flex; 
            margin-top: 40px;
            justify-content: center;

        ">
            <h1 style="
                color: white; 
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5); 
                font-family: 'Arial', sans-serif;
                text-align: center;">
                Chess.com Blocker: Daily game limit reached. Please take a well-deserved break.
            </h1>
        </div>
    </body>
    `;

    }
});

// Listen for changes to the "blocked" value in chrome.storage
chrome.storage.onChanged.addListener(function(changes, namespace) {
// Check if the "blocked" value has changed
if (changes.blocked) {
    // If so, update the page accordingly
    if (changes.blocked.newValue === true && /https?:\/\/.*chess\.com\/(game|play\/online)/.test(window.location.href)) {
        document.body.outerHTML = `
    <body style="display: flex; justify-content: center; height: 100vh; background-color:rgb(48, 46, 43); padding: 0px;">
        <div style="
            display: flex; 
            margin-top: 40px;
            justify-content: center;
        ">
            <h1 style="
                color: white; 
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5); 
                font-family: 'Arial', sans-serif;
                text-align: center;">
                Chess.com Blocker: Daily game limit reached. Please take a well-deserved break.
            </h1>
        </div>
    </body>
    `;

    }
}
});

// Function to handle mutations
function handleMutations(mutationsList, observer) {
for (let mutation of mutationsList) {
    if (mutation.type === 'childList') {
        for (let addedNode of mutation.addedNodes) {
            if (addedNode.classList && addedNode.classList.contains('player-game-over-component')) {
                let ratingChangeElement = addedNode.querySelector('.rating-score-change');
                if (ratingChangeElement) {
                    let ratingChange = parseInt(ratingChangeElement.textContent.trim());
                    if (ratingChange < -4) {
                        chrome.runtime.sendMessage({
                            action: 'LOSS_DETECTED'
                        });
                    }
                }
                // call the api after 15 seconds
                setTimeout(function() {
                    chrome.runtime.sendMessage({
                        action: 'checkGamesPlayed'
                    });
                }, 15000);
            }
        }
    }
}
}

// Start observing the DOM
function startObserving() {
    // Target the player-bottom component
    const targetNode = document.querySelector('.player-component.player-bottom');
    if (targetNode) {
        const config = {
            attributes: false,
            childList: true,
            subtree: true
        };
        const observer = new MutationObserver(handleMutations);
        observer.observe(targetNode, config);
    }
}

// Invoke the function to start observing
startObserving();
