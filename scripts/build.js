#!/usr/bin/env node
// Assemble loadable extensions from the single source tree.
//
//   src/                    -> copied verbatim into every target
//   manifests/base.json     -> manifest keys shared by every browser
//   manifests/<target>.json -> keys that differ per browser, layered on top
//                              (top-level keys replace, they do not merge)
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

function build(outDir = path.join(ROOT, 'dist')) {
    const { version } = readJson(path.join(ROOT, 'package.json'));
    const base = readJson(path.join(MANIFEST_DIR, 'base.json'));
    const built = {};

    for (const target of TARGETS) {
        const targetDir = path.join(outDir, target);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.cpSync(SRC_DIR, targetDir, { recursive: true });

        const manifest = { ...base, ...readJson(path.join(MANIFEST_DIR, `${target}.json`)), version };
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

module.exports = { build, TARGETS };
