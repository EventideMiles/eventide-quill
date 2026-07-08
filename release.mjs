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
 *   3. manifest.json version differs from the latest tag on origin — i.e.
 *      you already ran `npm run set-version -- <v>` and merged it to main.
 *      (A local-only tag from a prior failed push is detected and resumed.)
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

/** Latest version-like tag on origin (authoritative — bypasses stale local refs). */
function latestRemoteTag() {
    return shCapture('git ls-remote --tags origin')
        .split('\n')
        .map((line) => line.replace(/^.*refs\/tags\//, '').replace(/\^\{\}$/, '').trim())
        .filter((t) => VERSION_RE.test(t))
        .sort((a, b) => {
            const [a1, a2, a3] = a.split('.').map(Number);
            const [b1, b2, b3] = b.split('.').map(Number);
            return a1 - b1 || a2 - b2 || a3 - b3;
        })
        .pop();
}

/** True if the tag exists on origin (not just locally). Uses ls-remote so a local-only tag from a failed push is distinguishable. */
function tagOnOrigin(tag) {
    return Boolean(shCapture(`git ls-remote origin refs/tags/${tag}`));
}

/** Get the commit a tag points to, or '' if the tag doesn't exist. */
function tagCommit(tag) {
    try {
        return execSync(`git rev-list -n 1 ${tag}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
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

// Query origin directly for authoritative tag state (avoids stale local refs
// and the fetch-tag-clobber problem). Local tags are checked separately for
// the resume case in phase 4.
console.log('\nrelease: checking tags against origin');
const latestTag = latestRemoteTag();
if (!latestTag) {
    fail('no version tags found on origin — looks like the first release. Tag manually.');
}
if (tagOnOrigin(version)) {
    fail(
        `tag ${version} is already on origin — this version was already released.\n` +
            '  Bump the version first: `npm run set-version -- <new-version>`, then merge to main.'
    );
}
const hasLocalTag = Boolean(tagCommit(version));
console.log(`  latest on origin: ${latestTag}`);
console.log(`  manifest:         ${version}${hasLocalTag ? '  (local tag found — will resume)' : ''}`);

if (DRY_RUN) {
    const tagStep = hasLocalTag
        ? `  7. (skip — tag ${version} already exists locally, will resume)`
        : `  7. git tag -a ${version} -m ${version}`;
    console.log(`
release: DRY RUN — would:
  1. git checkout main
  2. git pull --ff-only origin main
  3. npm run build
  4. npm test
  5. npm run lint
  6. npm run lint:dup
${tagStep}
  8. git push origin main
  9. git push origin ${version}   (triggers release.yml -> draft GitHub release)

(dry run — working tree unchanged. Version checked against the current branch;
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

const head = shCapture('git rev-parse HEAD');
const existingTarget = tagCommit(version);
if (existingTarget) {
    if (existingTarget === head) {
        const tagType = shCapture(`git cat-file -t refs/tags/${version}`);
        if (tagType === 'tag') {
            console.log(`\nrelease: tag ${version} already at HEAD (annotated) — skipping creation (resume).`);
        } else {
            console.log(`\nrelease: replacing lightweight tag ${version} with annotated tag.`);
            sh(`git tag -d ${version}`);
            sh(`git tag -a ${version} -m ${version}`);
        }
    } else {
        fail(`tag ${version} exists at ${existingTarget.slice(0, 8)}, not HEAD (${head.slice(0, 8)}). Resolve manually.`);
    }
} else {
    console.log(`\nrelease: creating annotated tag ${version}`);
    sh(`git tag -a ${version} -m ${version}`);
}

console.log('\nrelease: pushing main');
sh('git push origin main');

console.log(`\nrelease: pushing tag ${version}`);
sh(`git push origin ${version}`);

console.log(`\nrelease: done. Tagged ${version} and pushed — release.yml is building the draft release.`);
