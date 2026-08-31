const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { build, layer, TARGETS } = require('../scripts/build.js');
const pkg = require('../package.json');
const manifests = { base: require('../manifests/base.json') };

// Every file the manifest points at, relative to the extension root
function referencedFiles(manifest) {
    const files = [];
    if (manifest.background?.service_worker) files.push(manifest.background.service_worker);
    if (manifest.background?.scripts) files.push(...manifest.background.scripts);
    for (const cs of manifest.content_scripts ?? []) files.push(...cs.js);
    const action = manifest.action ?? manifest.browser_action;
    if (action) files.push(action.default_icon, action.default_popup);
    if (manifest.options_ui) files.push(manifest.options_ui.page);
    files.push(...Object.values(manifest.icons ?? {}));
    return files;
}

// The <script src> tags in an HTML file, in order
function scriptTags(html) {
    return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chesscom-blocker-'));
const built = build(outDir);
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

test('builds every target', () => {
    assert.deepStrictEqual(Object.keys(built).sort(), [...TARGETS].sort());
});

for (const target of TARGETS) {
    const dir = built[target];
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

    test(`${target}: manifest version comes from package.json`, () => {
        assert.strictEqual(manifest.version, pkg.version);
        assert.notStrictEqual(manifest.version, '0.0.0');
    });

    test(`${target}: every file the manifest references exists`, () => {
        for (const file of referencedFiles(manifest)) {
            assert.ok(fs.existsSync(path.join(dir, file)), `${file} missing from ${target} build`);
        }
    });

    test(`${target}: content script loads shared.js first`, () => {
        // A "world": "MAIN" script runs in the page's scope, where shared.js
        // neither belongs nor would work
        for (const cs of manifest.content_scripts.filter((cs) => cs.world !== 'MAIN')) {
            assert.strictEqual(cs.js[0], 'shared.js');
        }
    });

    test(`${target}: popup loads its dependencies before options.js`, () => {
        const popup = manifest.action?.default_popup ?? manifest.browser_action.default_popup;
        const html = fs.readFileSync(path.join(dir, popup), 'utf8');
        // chessApi.js is not among them: the popup asks the background script
        // to reach chess.com, so that there is one request queue and not two
        assert.deepStrictEqual(scriptTags(html), ['shared.js', 'lossCounter.js', 'options.js']);
    });

    test(`${target}: every script parses`, () => {
        const { execFileSync } = require('child_process');
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
            execFileSync(process.execPath, ['--check', path.join(dir, file)]);
        }
    });
}

test('chrome: the username is read in the page\'s own world', () => {
    const pageWorld = JSON.parse(fs.readFileSync(path.join(built.chrome, 'manifest.json'), 'utf8'))
        .content_scripts.filter((cs) => cs.world === 'MAIN');
    assert.strictEqual(pageWorld.length, 1);
    assert.deepStrictEqual(pageWorld[0].js, ['detectUsername.js']);
    // It runs on the same pages as the rest of the extension, and no others
    assert.deepStrictEqual(pageWorld[0].matches, manifests.base.content_scripts[0].matches);
});

test('firefox: nothing is injected into the page (wrappedJSObject instead)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(built.firefox, 'manifest.json'), 'utf8'));
    for (const cs of manifest.content_scripts) {
        assert.ok(!cs.js.includes('detectUsername.js'));
    }
});

// The page world has no extension APIs, and window.context carries an
// email-bearing token, a CSRF token and an IP alongside the username. This
// file is the boundary: it must not reach for either side of that.
test('the page-world script touches neither the extension APIs nor the rest of the session', () => {
    const source = fs.readFileSync(path.join(built.chrome, 'detectUsername.js'), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['extensionApi', 'chrome.', 'browser.', 'intercom', 'csrf', 'email']) {
        assert.ok(!code.includes(forbidden), `detectUsername.js should not mention ${forbidden}`);
    }
    // The only field it may read off the page, and the only origin it may post to
    assert.match(code, /window\.context\?\.user\?\.username/);
    assert.match(code, /window\.postMessage\([^)]*window\.location\.origin\)/);
});

// The detection logging names the chess.com account it found, on the page of
// whoever is playing. Leaving it on is a mistake worth failing the build over,
// not one to notice in a review.
test('debug logging is off in every build', () => {
    for (const target of TARGETS) {
        for (const file of ['shared.js', 'detectUsername.js']) {
            const source = fs.readFileSync(path.join(built[target], file), 'utf8');
            assert.match(source, /const DEBUG = false;/, `${target}/${file} ships with logging on`);
        }
    }
});

// Only content_scripts uses the append rule today, and objects can never
// collide; a shared `permissions` array one day could.
test('layering appends arrays without repeating what both sides list', () => {
    assert.deepStrictEqual(
        layer(
            { permissions: ['storage'], content_scripts: [{ js: ['shared.js'] }] },
            { permissions: ['storage', 'alarms'], content_scripts: [{ js: ['detectUsername.js'] }] }
        ),
        {
            permissions: ['storage', 'alarms'],
            content_scripts: [{ js: ['shared.js'] }, { js: ['detectUsername.js'] }]
        }
    );
});

// Content scripts come only from the manifest - nothing is injected at
// runtime - so no browser needs the scripting permission
test('no browser asks for the scripting permission', () => {
    for (const target of TARGETS) {
        const manifest = JSON.parse(fs.readFileSync(path.join(built[target], 'manifest.json'), 'utf8'));
        assert.ok(!manifest.permissions.includes('scripting'), `${target} asks for scripting`);
    }
});

test('chrome: service worker pulls in its own dependencies', () => {
    const background = fs.readFileSync(path.join(built.chrome, 'background.js'), 'utf8');
    assert.match(background, /importScripts\('shared\.js', 'lossCounter\.js', 'chessApi\.js'\)/);
});

test('firefox: background scripts list dependencies before background.js', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(built.firefox, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.background.scripts, ['shared.js', 'lossCounter.js', 'chessApi.js', 'background.js']);
});
