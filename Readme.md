# Chess.com Blocker

A Firefox and Chrome extension that calculates a player's number of losses in the past day on chess.com. If this is greater than the maxGames number input by the user, the [chess.com/play/online](chess.com/play/online) page is blocked.

## Installation
**Chrome**

1. Download the repository as a ZIP file and extract it to a folder on your computer.

2. Open Chrome and go to `chrome://extensions`.

3. Enable "Developer mode" by clicking on the toggle switch in the top right corner.

4. Click on "Load unpacked" and select the extracted folder.

## Usage
Click the extension. Input your username and the max number of games you wish to play. Once you exceed the number of games played, the chess.com/play/online page will be blocked. 

It is blocked until you no longer have have X losses in the last 24 hours.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request if you have any suggestions or improvements.

## Image Source
I use the knook image obtained from reddit.com/r/anarchychess/wiki

![The Knook](knook.png)

## License

This project uses the MIT License.

Copyright (c) 2023 Zinkelburger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.