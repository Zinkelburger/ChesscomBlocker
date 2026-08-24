# Chess.com Blocker

A Chrome and Firefox extension that calculates a player's number of losses in the past day on chess.com. If this is greater than the maxGames number input by the user, the [chess.com/play/online](chess.com/play/online) page is blocked.

## Links to download

https://chrome.google.com/webstore/detail/chesscom-blocker/pacoipifgdogfclpkfmjomngfleabgfn/

https://addons.mozilla.org/en-US/firefox/addon/chess-com-blocker/

## Installation
The extension is built from a single source tree into one folder per browser:

```
npm test     # optional, runs the unit tests
npm run build
```

This produces `dist/chrome` and `dist/firefox`.

**Chrome**

1. Open Chrome and go to `chrome://extensions`.

2. Enable "Developer mode" by clicking on the toggle switch in the top right corner.

3. Click on "Load unpacked" and select the `dist/chrome` folder.

**Firefox**

1. Open Firefox and go to `about:debugging`.

2. Click on "This Firefox" and then on "Load Temporary Add-on".

3. Select `dist/firefox/manifest.json`.

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

![The Knook](src/knook.png)

## Project layout
```
src/          the extension itself - one copy, shared by both browsers
manifests/    base.json (shared keys) plus chrome.json (Manifest V3) and firefox.json (Manifest V2) overrides
scripts/      build.js copies src/ into dist/<browser>/ and stamps the version from package.json
test/         node:test suites, run with `npm test`
docs/         screenshots
```

`src/shared.js` picks whichever of `browser` / `chrome` the browser provides, so everything else is written once in Promise style. Every page loads `shared.js` first (the service worker via `importScripts`, Firefox via the manifest's `scripts` list, the popup via a `<script>` tag).

`src/lossCounter.js` holds the counting rules and has no browser dependencies, so the tests exercise exactly the code the extension runs. The build test also loads the generated manifests and checks that every file they reference exists.

The version number lives only in `package.json`; bump it there and rebuild.

## How the code works
To get the number of losses, I:
+ Work out where the counting window starts (24 hours ago, or local midnight)
+ Fetch the user's monthly game archives from the chess.com API for every month the window touches (usually one, two right after a month boundary), using ETags so unchanged archives are not re-downloaded
+ Count the losses inside that window

This loss check is triggered after a game ends, when a chess.com game or play page is opened, and from the popup whenever a setting changes.

If the number of losses is at or above the max, the game page content is replaced with a notice.

An alarm is also set for the moment the window rolls over — the next local midnight, or 24 hours after the oldest loss that is still being counted — so the losses are re-counted and the block lifts without any user action.

There is also the case where your game ends but the chess.com api hasn't updated yet. I handle it by using a mutation observer on `.player-component.player-bottom`. I look for the player game over component, and specifically parse the `.rating-score-change` class. If `current # of losses` + 1 >= `maxGames` then the user is blocked immediately, and I don't have to wait for the chess.com API to update.

## License
This project uses the GPL3 License (LICENSE.md).
