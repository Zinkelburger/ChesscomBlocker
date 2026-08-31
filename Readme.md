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
Click the extension and enter your chess.com username (a tick confirms it exists). The main panel shows how many losses you have against your limit; change the limit right there. Once you reach it, the chess.com game and play pages are blocked, and stay blocked until you no longer have that many losses in the current window.

### Block modes
**Block when** under Settings (the gear) picks what trips the block:

+ **Losses** (default) — N losses in the current window.
+ **Games** — N games of any result in the current window.
+ **Rating** — your current rating (from chess.com's stats) falls to or below a floor, or rises to or above a ceiling. Either bound can be left empty. The range applies to every tracked time control, there is no window and nothing to reset: the block lifts when the rating is back inside the range or you change the bounds.

### Pausing
**Pause** on the main panel switches the extension off without uninstalling it; **Resume** turns it back on. By default a pause ends when the browser restarts; turn off **Unpause on restart** under Settings › Pause to keep it paused.

### Ending a session early
**Block after this game** blocks the play pages for one hour, no matter how many losses you have. If a game is running when you click it, the block waits for that game to finish. Click **End break** to lift it early.

### When the counter resets
**Resets** under Settings has two choices:

+ **Every 24h** (default) — a rolling window. Each loss stops counting 24 hours after that game ended, so the counter drains gradually.
+ **At midnight** — the counter covers the current calendar day and clears at 00:00.

Midnight is read from your computer's clock, so it follows whatever timezone the machine is set to (and handles daylight saving changes on its own). The popup shows a countdown to the next reset.

Either way the extension schedules an alarm for the moment the window rolls over, so a block lifts by itself instead of waiting for you to click something; an open chess.com tab showing the block notice reloads on its own.

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
The model is one sentence: *within the current window, block once the chosen limit is reached*. To evaluate it, I:
+ Work out where the counting window starts (24 hours ago, or local midnight)
+ Fetch the user's monthly game archives from the chess.com API for every month the window touches (usually one, two right after a month boundary), using ETags so unchanged archives are not re-downloaded
+ Count the games and the losses inside that window (`countLosses` in `lossCounter.js`)
+ Compare the count the block mode cares about against the limit

In **Rating** mode there is no window: the current ratings come from the `/stats` endpoint instead, and the block is on while any tracked rating is outside the floor/ceiling range (`ratingsOutOfRange`).

This check is triggered after a game ends, when a chess.com game or play page is opened, and from the popup whenever a setting changes.

If the limit is reached, the game page content is replaced with a notice.

An alarm is also set for the moment the window rolls over — the next local midnight, or 24 hours after the oldest counted loss (oldest counted game, in **Games** mode) — so the counts are refreshed and the block lifts without any user action.

There is also the case where your game ends but the chess.com api hasn't updated yet. I handle it by using a mutation observer on `.player-component.player-bottom`. I look for the player game over component, and parse the `.rating-score-change` class. The background adds that game to the last counts it computed (`recordProvisionalGame`) and, if that reaches the limit, blocks immediately rather than waiting for the chess.com API to update.

## License
This project uses the GPL3 License (LICENSE.md).
