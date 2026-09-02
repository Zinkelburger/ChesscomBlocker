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

Either way, if a chess.com game or play tab was already open, reload it once — a tab loaded before the extension existed has no content script in it (see [Tabs that were already open](#tabs-that-were-already-open)).

## Usage
Click the extension and enter your chess.com username. If you have a chess.com game or play page open, the name you are logged in as is filled in for you, ready to accept. The name is checked against chess.com when you commit it — with **Start Chess Blocker** on the first run, or by leaving the field afterwards — and one chess.com has no player for is not stored: it says so instead, and the field goes back to the name being tracked. The main panel shows how many losses you have against your limit; change the limit right there. Once you reach it, the chess.com game and play pages are blocked, and stay blocked until you no longer have that many losses in the current window.

### Three things can block chess.com
They are separate, and each is named on its own:

| Name in the UI | What it is | How it ends |
| --- | --- | --- |
| **Paused** | The master switch: the **Pause extension** / **Resume extension** pill in the panel at the top. Paused means chess.com is never blocked, whatever the counter says. | You press **Resume extension**, or the browser restarts (see below). |
| **Your limit** | The counter doing its job: enough losses or games, or a rating out of range. | The counter resets, or your rating comes back into range. |
| **A 1-hour block** | One you start by hand with the button at the bottom of the panel, regardless of the counter. | After an hour, or when you press **End the 1-hour block now**. |

The status panel at the top always says which of these is in force, and what it means for chess.com right now. It offers one button, and while a 1-hour block is running or waiting that button is the way out of the block rather than the pause switch: you cannot pause your way out of an hour you asked for, and pausing is back the moment the block is gone. The button at the bottom only starts an hour, and only appears when there is an hour to start - so there is never a greyed-out control with no explanation.

### Block modes
**Block when** under Settings (the gear) picks what trips the block:

+ **Losses** (default) — N losses in the current window.
+ **Games** — N games of any result in the current window.
+ **Rating** — your current rating (from chess.com's stats) falls to or below a floor, or rises to or above a ceiling. Either bound can be left empty. The range applies to every tracked time control, there is no window and nothing to reset: the block lifts when the rating is back inside the range or you change the bounds.

### Pausing
**Pause extension** at the top of the main panel switches the extension off without uninstalling it; the panel then reads **Extension is paused** and the pill reads **Resume extension**. While a 1-hour block is running or waiting there is no **Pause extension**: that pill ends the block instead, and pausing comes back once it has. By default the blocker resumes when the browser restarts; turn off **Resume when the browser restarts** under Settings › Pausing to keep it paused.

### Blocking chess.com for an hour
**Block chess.com for 1 hour**, at the bottom of the panel, blocks the play pages for one hour, no matter how many losses you have. The hour starts when you press it, unless a game is running in some open chess.com tab: then the block waits for that game to finish, and the hour starts when it does, so a long game does not eat most of it. Until then the panel reads **1-hour block is waiting** and the game page shows a banner saying the block is coming. A board that is merely on screen with no game underway (the play page before you start one) does not count as a running game, and neither does a chess.com tab that was open before the extension was installed (it has no content script to ask): in both cases the hour starts at once.

From then on the block is the status panel's business: its pill reads **Cancel the 1-hour block** while the block is still waiting, and **End the 1-hour block now** once the hour is running, which lifts it early.

When the limit has already blocked chess.com, the bottom button is not shown: an hour on top of a block that is already up would mean nothing.

### When the counter resets
**Counter resets** under Settings has two choices:

+ **Rolling 24h** (default) — each loss stops counting 24 hours after that game ended, so the counter drains gradually.
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

`src/detectUsername.js` is the one file that runs in the chess.com page's own scope rather than the extension's, so it is deliberately tiny — see [Reading the username off the page](#reading-the-username-off-the-page).

`src/lossCounter.js` holds the counting rules and the verdict a check reaches from them (`decideBlock`: whether the limit is hit, whether chess.com is blocked right now, and when to wake up next), with no browser dependencies, so the tests exercise exactly the code the extension runs. `src/gameResult.js` is the same idea for the content script: it reads a game-over card described as plain strings, so the tests can feed it chess.com's markup without a DOM. `test/background.test.js` goes one step further and runs the real `background.js` inside a Node `vm` context against stand-ins for storage, alarms, tabs and `fetch`, so the orchestration (outages, backoff surviving a service-worker restart, the 1-hour block, storage migration) is covered end to end. The build test also loads the generated manifests and checks that every file they reference exists.

The version number lives only in `package.json`; bump it there and rebuild.

## How the code works
The model is one sentence: *within the current window, block once the chosen limit is reached*. To evaluate it, I:
+ Work out where the counting window starts (24 hours ago, or local midnight)
+ Fetch the user's monthly game archives from the chess.com API for every month the window touches (usually one, two right after a month boundary), using ETags so unchanged archives are not re-downloaded
+ Count the games and the losses inside that window (`countLosses` in `lossCounter.js`)
+ Compare the count the block mode cares about against the limit (`decideBlock`)

In **Rating** mode there is no window: the current ratings come from the `/stats` endpoint instead, and the block is on while any tracked rating is outside the floor/ceiling range (`ratingsOutOfRange`).

This check is triggered after a game ends, when a chess.com game or play page is opened, and from the popup whenever a setting changes.

If the limit is reached, the game page content is replaced with a notice.

An alarm is also set for the moment the window rolls over — the next local midnight, or 24 hours after the oldest counted loss (oldest counted game, in **Games** mode) — so the counts are refreshed and the block lifts without any user action.

### Reading the username off the page
Chess.com renders the logged-in session into a page global, `window.context.user`. Reading it saves the user from typing a name the browser is already looking at, and it is the same name the public API answers to.

An extension cannot see page globals from a content script, and the two browsers get there differently:

+ **Chrome (MV3)** declares `detectUsername.js` with `"world": "MAIN"`, which runs it in the page's own scope. Having no access to the extension APIs from there, it posts the name back to `content.js` over `window.postMessage`.
+ **Firefox (MV2)** needs no injection at all: Xray vision lets `content.js` read `window.wrappedJSObject.context.user.username` directly.

Both paths run only on the game and play pages the extension already matches, so **the detection adds no permissions at all**.

Only the username crosses the boundary. The same object carries a token with the account's email address in it, a CSRF token and the user's IP, none of which the extension has any use for; a test asserts `detectUsername.js` never mentions them. The name is validated by `normalizeUsername` before it is stored, and is only ever a *suggestion* — it lands in `detectedUsername` in local storage and is filled into the username field, but it becomes the tracked account only when the user commits it, since the account someone is logged into is not necessarily the one they want blocked.

### Tabs that were already open
A content script declared in the manifest only reaches pages loaded *after* the extension was installed. A chess.com game tab that was already open when you installed (or updated) the extension has nothing of ours in it — no detected username, no game-over reporting, no block — until you reload it once by hand. The same goes for a tab that reaches a game page purely through chess.com's in-page navigation from a page the extension does not match, such as the home page.

Runtime injection could close both gaps, but it costs the `scripting` permission and a pile of machinery (querying open tabs, pinging for live copies, racing the manifest's own injection). One manual reload after installing is a fair price for keeping the extension's footprint at its minimum: nothing beyond the game and play pages, ever.

### Games the archive has not published yet
The public archive at `/pub/player/<name>/games/YYYY/MM` can lag hours behind the games it is meant to list — a rated game shows up in `/stats` immediately while the archive still returns `{"games":[]}`. Counting from the archive alone therefore misses exactly the games that matter, the ones just played, and the block never fires.

So the extension keeps its own ledger. A mutation observer watches for the game-over modal (or the older game-over card in the player box) and reads the result off it (`gameResult.js`); every game it sees is written to `localGames` and counted alongside the archive until the archive catches up with it:

+ **Placing the game.** A local record does not say which time control it was, so the `/stats` endpoint is asked (`classifyLocalGames`), and the answer also settles the variant, since only standard chess has per-time-control ratings there. Two things in that response place a game. Each pool's last-game time names exactly one game, so it goes to the record nearest to it and no other — otherwise a Chess960 game played a minute after a blitz one would borrow the blitz pool's timestamp and be counted as blitz. And each pool's game total, compared with the total seen at the previous check, says how many games the pool gained in between — which is what places the *earlier* of two bullet games played back to back, since the last-game time only ever names the most recent one. Whatever the totals cannot account for is left to the last-game time; whatever is left over goes to the still-unplaced records, newest first. While a record is waiting to be placed the stats response is revalidated on every check rather than reused from the one-minute cache, since a minute-old copy cannot show the totals moving. Until it is placed the record counts anyway — over-counting for a few minutes is the safe direction for a blocker — and a record that is still unplaced after five minutes was an unrated or variant game, so it stops counting. Games played elsewhere (chess.com's app) move the totals too and can lend a pool to a record that was really unrated; that over-counts until the archive publishes the record, at which point it is counted under its true rules.
+ **Not counting it twice.** Once the archive lists a game within three minutes of a record's end time, the record is dropped and the archive counts it from then on (`pruneLocalGames`). Each archived game accounts for one record and one only, the nearest in time: two bullet games end within three minutes of each other, and when the archive publishes the first, the second is still the ledger's to count.
+ **Outages.** With the archive unreachable, the archive's share of the last successful count is reused and the ledger is still counted on top of it, so a game played during an outage blocks on its own. A rate limit or server error backs the extension off the API for a growing interval; the deadline is kept in storage, since on Chrome the background is a service worker that is shut down after half a minute of quiet and would otherwise forget it by the time the retry came round.

## License
This project uses the GPL3 License (LICENSE.md).
