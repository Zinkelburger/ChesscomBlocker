const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { build, TARGETS } = require('../scripts/build.js');
const pkg = require('../package.json');

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
        for (const cs of manifest.content_scripts) {
            assert.strictEqual(cs.js[0], 'shared.js');
        }
    });

    test(`${target}: popup loads its dependencies before options.js`, () => {
        const popup = manifest.action?.default_popup ?? manifest.browser_action.default_popup;
        const html = fs.readFileSync(path.join(dir, popup), 'utf8');
        assert.deepStrictEqual(scriptTags(html), ['shared.js', 'lossCounter.js', 'options.js']);
    });

    test(`${target}: every script parses`, () => {
        const { execFileSync } = require('child_process');
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
            execFileSync(process.execPath, ['--check', path.join(dir, file)]);
        }
    });
}

test('chrome: service worker pulls in its own dependencies', () => {
    const background = fs.readFileSync(path.join(built.chrome, 'background.js'), 'utf8');
    assert.match(background, /importScripts\('shared\.js', 'lossCounter\.js'\)/);
});

test('firefox: background scripts list dependencies before background.js', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(built.firefox, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.background.scripts, ['shared.js', 'lossCounter.js', 'background.js']);
});
