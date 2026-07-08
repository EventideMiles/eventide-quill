#!/usr/bin/env node
/**
 * Release chore: cut and push an annotated release tag.
 *
 * Usage:
 *   node release.mjs                # full run with confirmation prompt
 *   node release.mjs --dry-run      # preview the plan, change nothing
 *   node release.mjs --yes          # skip the confirmation prompt
 *   npm run release                 # same, via npm
 *
 * Preconditions (enforced, in order):
 *   1. Working tree is clean (on any branch).
 *   2. On `main`, fast-forwarded from origin.
 *   3. manifest.json version differs from the latest git tag — i.e. you
 *      already ran `npm run set-version -- <v>` and merged it to main.
 *   4. build + test + lint + lint:dup all pass.
 *
 * Then: create an annotated tag `<version>` and push main + tag. The tag
 * push triggers .github/workflows/release.yml, which builds and opens a
 * DRAFT GitHub release with main.js, manifest.json, and styles.css attached.
 *
 * What it does NOT do: bump the version string (use `npm run set-version`),
 * commit/merge the version bump (do that via PR as usual), or finalize the
 * GitHub release (release.yml leaves it as a draft for you to review/publish).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(msg) {
    console.error(`\nrelease: ${msg}`);
    process.exit(1);
}

/** Run a command, streaming output to the terminal. Fails the script on non-zero exit. */
function sh(cmd) {
    console.log(`  $ ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch {
        fail(`\`${cmd}\` exited non-zero (see output above).`);
    }
}

/** Capture a command's stdout (stderr still shows on the terminal). */
function shCapture(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    } catch {
        fail(`\`${cmd}\` failed.`);
    }
}

function readManifestVersion() {
    return JSON.parse(readFileSync('manifest.json', 'utf8')).version;
}

function latestVersionTag() {
    return shCapture('git tag --list --sort=-v:refname')
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => VERSION_RE.test(t))[0];
}

async function confirm(prompt) {
    if (SKIP_CONFIRM) {
        console.log(`${prompt} (--yes)`);
        return true;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        const answer = await rl.question(`${prompt} [y/N] `);
        return /^[yY]/.test(answer);
    } finally {
        rl.close();
    }
}

// ── Phase 1: read-only checks (run in every mode) ──────────────────────────

console.log('\nrelease: checking working tree');
if (shCapture('git status --porcelain')) {
    fail('working tree is not clean. Commit or stash first.');
}
console.log('  clean.');

const version = readManifestVersion();
if (!VERSION_RE.test(version)) {
    fail(`manifest.json version "${version}" is not X.Y.Z.`);
}

const latestTag = latestVersionTag();
if (!latestTag) {
    fail('no version tags found — looks like the first release. Tag manually.');
}
if (version === latestTag) {
    fail(
        `manifest.json version (${version}) matches the latest tag (${latestTag}).\n` +
            '  Bump the version first: `npm run set-version -- <new-version>`, then merge to main.'
    );
}
if (shCapture(`git tag -l ${version}`)) {
    fail(`tag ${version} already exists (but is not the latest). Looks like a downgrade — check manifest.json.`);
}
console.log(`  latest tag: ${latestTag}`);
console.log(`  manifest:   ${version}  (disparity ok)`);

if (DRY_RUN) {
    console.log(`
release: DRY RUN — would:
  1. git checkout main
  2. git pull --ff-only origin main
  3. npm run build
  4. npm test
  5. npm run lint
  6. npm run lint:dup
  7. git tag -a ${version} -m ${version}
  8. git push origin main
  9. git push origin ${version}   (triggers release.yml -> draft GitHub release)

(dry run — nothing was changed. Version checked against the current branch;
 the real run re-checks on main after pull.)`);
    process.exit(0);
}

// ── Phase 2: switch to main + pull ─────────────────────────────────────────

console.log('\nrelease: switching to main');
sh('git checkout main');
sh('git pull --ff-only origin main');

// Re-read on main in case the branch we left carried a stale/unmerged bump.
const versionOnMain = readManifestVersion();
if (versionOnMain !== version) {
    fail(
        `manifest.json on main (${versionOnMain}) differs from where we started (${version}).\n` +
            '  The version bump may not be merged to main yet.'
    );
}

// ── Phase 3: preflight ─────────────────────────────────────────────────────

console.log('\nrelease: preflight — build');
sh('npm run build');
console.log('\nrelease: preflight — test');
sh('npm test');
console.log('\nrelease: preflight — lint');
sh('npm run lint');
console.log('\nrelease: preflight — lint:dup');
sh('npm run lint:dup');

// ── Phase 4: confirm + tag + push ──────────────────────────────────────────

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Release ${version}   (previous: ${latestTag})
  Will: create annotated tag, push main + tag.
  release.yml then builds and opens a DRAFT GitHub release.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

const ok = await confirm('\nrelease: proceed?');
if (!ok) {
    console.log('release: aborted. Nothing was changed.');
    process.exit(0);
}

console.log(`\nrelease: creating annotated tag ${version}`);
sh(`git tag -a ${version} -m ${version}`);

console.log('\nrelease: pushing main');
sh('git push origin main');

console.log(`\nrelease: pushing tag ${version}`);
sh(`git push origin ${version}`);

console.log(`\nrelease: done. Tagged ${version} and pushed — release.yml is building the draft release.`);
