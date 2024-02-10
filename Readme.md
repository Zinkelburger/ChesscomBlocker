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

It is blocked until you no longer have have X losses in the last 24 hours.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request if you have any suggestions or improvements.

## Image Source
I use the knook image obtained from reddit.com/r/anarchychess/wiki

![The Knook](Firefox/knook.png)

## How the code works
To get the number of losses, I:
+ Get the user's games from the past day with the chess.com API
+ Count the number of losses

This loss check is triggered after a game ends, 

If the number of losses is above the maxGames, some html is injected into the page instead of the normal content.

There is also the case where your game ends but the chess.com api hasn't updated yet. I handle it by using a mutation observer on `.player-component.player-bottom`. I look for the player game over component, and specifically parse the `.rating-score-change` class. If `current # of losses` + 1 > `maxGames` then the user is blocked immediately, and I don't have to wait for the chess.com API to update.

## License
This project uses the GPL3 License (LICENSE.md).
