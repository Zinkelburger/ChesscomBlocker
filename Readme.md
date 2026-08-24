# Chess.com Blocker

A Chrome and Firefox extension that calculates a player's number of losses in the past day on chess.com. If this is greater than the maxGames number input by the user, the [chess.com/play/online](chess.com/play/online) page is blocked.

## Links to download

https://chrome.google.com/webstore/detail/chesscom-blocker/pacoipifgdogfclpkfmjomngfleabgfn/

https://addons.mozilla.org/en-US/firefox/addon/chess-com-blocker/

## Installation
**Chrome**

1. Download the repository as a ZIP file and extract it to a folder on your computer.

2. Open Chrome and go to `chrome://extensions`.

3. Enable "Developer mode" by clicking on the toggle switch in the top right corner.

4. Click on "Load unpacked" and select the extracted folder.

**Firefox**
1. Download the Firefox repository as a ZIP file and extract it to a folder on your computer.

2. Open Firefox and go to `about:debugging`.

3. Click on "This Firefox" and then on "Load Temporary Add-on".

4. Select the `manifest.json` file from the extracted folder.

## Usage
Click the extension. Input your username and the max number of games you wish to play. Once you exceed the number of games played, the chess.com/play/online page will be blocked. 

It is blocked until you no longer have have X losses in the current window.

### When the counter resets
The gear menu has a **Counter Reset** setting with two choices:

+ **Last 24 hours** (default) — a rolling window. Each loss stops counting 24 hours after that game ended, so the counter drains gradually.
+ **At midnight** — the counter covers the current calendar day and clears at 00:00.

Midnight is read from your computer's clock, so it follows whatever timezone the machine is set to (and handles daylight saving changes on its own). The popup shows which timezone it resolved to, plus a countdown to the next reset.

Either way the extension schedules an alarm for the moment the window rolls over, so a block lifts by itself instead of waiting for you to click something. Reload the chess.com tab to see the unblocked page.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request if you have any suggestions or improvements.

## Image Source
I use the knook image obtained from reddit.com/r/anarchychess/wiki

![The Knook](Firefox/knook.png)

## How the code works
To get the number of losses, I:
+ Get the user's games for the current month with the chess.com API
+ Work out where the counting window starts (24 hours ago, or local midnight)
+ Count the number of losses inside that window

The counting rules live in `lossCounter.js`, which is loaded by the background script, the popup, and the tests, so all three agree. `Chrome/lossCounter.js` and `Firefox/lossCounter.js` are copies of the same file.

This loss check is triggered after a game ends, 

If the number of losses is above the maxGames, some html is injected into the page instead of the normal content.

An alarm is also set for the moment the window rolls over — the next local midnight, or 24 hours after the oldest loss that is still being counted — so the losses are re-counted and the block lifts without any user action.

There is also the case where your game ends but the chess.com api hasn't updated yet. I handle it by using a mutation observer on `.player-component.player-bottom`. I look for the player game over component, and specifically parse the `.rating-score-change` class. If `current # of losses` + 1 > `maxGames` then the user is blocked immediately, and I don't have to wait for the chess.com API to update.

## License
This project uses the GPL3 License (LICENSE.md).
