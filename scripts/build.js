#!/usr/bin/env node
// Assemble loadable extensions from the single source tree.
//
//   src/                    -> copied verbatim into every target
//   manifests/base.json     -> manifest keys shared by every browser
//   manifests/<target>.json -> keys that differ per browser, layered on top
//                              (a top-level key replaces the one in base,
//                               except arrays, which are appended to)
// The version is stamped from package.json.
//
// Usage: node scripts/build.js [outDir]   (default: dist)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const MANIFEST_DIR = path.join(ROOT, 'manifests');

const TARGETS = ['chrome', 'firefox'];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Layer a target's manifest keys over the shared ones. A key the target sets
// wins outright, except where both hold an array: those are appended, so a
// browser can add a content script of its own without restating the ones every
// browser shares.
function layer(base, target) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(target)) {
        merged[key] = Array.isArray(value) && Array.isArray(base[key])
            ? appendNew(base[key], value)
            : value;
    }
    return merged;
}

// Appended, less anything the target restates: a permission or a host listed
// on both sides means the same thing once, and a manifest that says it twice
// is a review comment waiting to happen. Objects - a content script, say - are
// never equal to one another, so those are simply appended.
function appendNew(base, extra) {
    return [...base, ...extra.filter((item) => !base.includes(item))];
}

function build(outDir = path.join(ROOT, 'dist')) {
    const { version } = readJson(path.join(ROOT, 'package.json'));
    const base = readJson(path.join(MANIFEST_DIR, 'base.json'));
    const built = {};

    for (const target of TARGETS) {
        const targetDir = path.join(outDir, target);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.cpSync(SRC_DIR, targetDir, { recursive: true });

        const manifest = { ...layer(base, readJson(path.join(MANIFEST_DIR, `${target}.json`))), version };
        fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');

        built[target] = targetDir;
    }
    return built;
}

if (require.main === module) {
    const built = build(process.argv[2] && path.resolve(process.argv[2]));
    for (const [target, dir] of Object.entries(built)) {
        console.log(`${target}: ${path.relative(process.cwd(), dir)}`);
    }
}

module.exports = { build, layer, TARGETS };
