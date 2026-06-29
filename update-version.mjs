#!/usr/bin/env node
/**
 * Dev chore: update the version string everywhere it appears in the repo.
 *
 * Usage:
 *   node update-version.mjs <new-version>             # write changes
 *   node update-version.mjs <new-version> --dry-run   # preview only
 *   npm run set-version -- <new-version>              # same, via npm
 *
 * What it does:
 *   - Reads the current version from package.json.
 *   - Replaces every literal occurrence of the current version with the new
 *     one across source/config files — package.json, manifest.json, and any
 *     source file that embeds it (e.g. the MediaWiki User-Agent string, or any
 *     future agent string). This is the point of the tool: the version now
 *     lives in more places than the three release files.
 *   - versions.json is handled specially: the new version is ADDED as a new
 *     key (with minAppVersion from manifest.json) so the release history is
 *     preserved, rather than overwriting an existing key.
 *
 * What it does NOT do: tag, commit, push, run npm lifecycle hooks, or touch
 * package-lock.json / build outputs (main.js, styles.css). Those are release
 * concerns. This is purely a chore to keep the version string consistent.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes('--dry-run');
const targetVersion = process.argv.slice(2).find((a) => !a.startsWith('--'));

const VERSIONS_JSON = 'versions.json';
const SKIP_DIRS = new Set(['node_modules', '.git', '.planning', 'dist']);
const SKIP_FILES = new Set([
    'package-lock.json',
    'main.js',
    'styles.css',
    'update-version.mjs',
    'version-bump.mjs'
]);
const SCAN_EXT = new Set(['.ts', '.mts', '.mjs', '.js', '.json', '.md', '.scss']);

function fail(msg) {
    console.error(`update-version: ${msg}`);
    process.exit(1);
}

// --- validate args ---

if (!targetVersion) {
    fail('missing version argument. Usage: node update-version.mjs <new-version> [--dry-run]');
}
if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(targetVersion)) {
    fail(`invalid version "${targetVersion}". Expected semver like 0.11.0.`);
}

const currentVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (targetVersion === currentVersion) {
    console.log(`update-version: already at ${currentVersion}, nothing to do.`);
    process.exit(0);
}

const minAppVersion = JSON.parse(readFileSync('manifest.json', 'utf8')).minAppVersion;

// --- blanket replace across source/config files ---

const changed = [];

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const path = join(dir, entry);
        const st = statSync(path);
        if (st.isDirectory()) {
            walk(path);
        } else if (st.isFile()) {
            if (entry === VERSIONS_JSON || SKIP_FILES.has(entry)) continue; // versions.json handled below
            const dot = entry.lastIndexOf('.');
            if (dot < 0 || !SCAN_EXT.has(entry.slice(dot))) continue;
            const original = readFileSync(path, 'utf8');
            const parts = original.split(currentVersion);
            const count = parts.length - 1;
            if (count === 0) continue;
            changed.push({ file: relative(ROOT, path), count });
            if (!DRY_RUN) writeFileSync(path, parts.join(targetVersion));
        }
    }
}

walk('.');

// --- versions.json: add the new key, preserve release history ---

const raw = readFileSync(VERSIONS_JSON, 'utf8');
const versions = JSON.parse(raw);
const versionsAdded = !(targetVersion in versions);
if (versionsAdded) {
    versions[targetVersion] = minAppVersion;
    if (!DRY_RUN) {
        // Preserve the file's existing trailing-newline state.
        const out = JSON.stringify(versions, null, '\t') + (raw.endsWith('\n') ? '\n' : '');
        writeFileSync(VERSIONS_JSON, out);
    }
}

// --- report ---

const verb = DRY_RUN ? 'would update' : 'updated';
console.log(`update-version: ${currentVersion} \u2192 ${targetVersion} (${DRY_RUN ? 'dry run' : 'applied'})`);
for (const c of changed) {
    console.log(`  ${verb} ${c.file} (${c.count} occurrence${c.count === 1 ? '' : 's'})`);
}
if (versionsAdded) {
    console.log(`  ${verb} ${VERSIONS_JSON} (added key "${targetVersion}": "${minAppVersion}")`);
} else {
    console.log(`  ${VERSIONS_JSON} unchanged ("${targetVersion}" already present)`);
}
if (DRY_RUN) {
    console.log('\n(dry run — no files written. Re-run without --dry-run to apply.)');
} else {
    console.log('\nDone. Review with `git diff`, then commit. This tool does not tag or push.');
}
