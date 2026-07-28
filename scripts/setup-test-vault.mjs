#!/usr/bin/env node
/**
 * Seed the test vault's plugin `data.json` from the committed template and
 * validate the template against the current `DEFAULT_SETTINGS` schema.
 *
 * Usage:
 *   node scripts/setup-test-vault.mjs                # default: copy + validate
 *   node scripts/setup-test-vault.mjs --vault simple # pick a vault (default: simple)
 *   node scripts/setup-test-vault.mjs --check        # validate only, don't write
 *
 * What it does:
 *   - Extracts the set of top-level keys defined in `DEFAULT_SETTINGS` by
 *     reading `src/settings.ts` and brace-matching the object literal (no
 *     runtime import — the module pulls in Obsidian UI classes that don't
 *     resolve under Node). The extraction walks the literal tracking brace /
 *     bracket / string depth so only depth-1 `identifier:` keys outside
 *     strings are collected. This keeps the validation in sync with schema
 *     changes automatically (no manual sync).
 *   - Compares the keys in `data.json.example` against `DEFAULT_SETTINGS`:
 *       * missing keys → warning (template will inherit defaults at runtime,
 *         but the template should be self-describing so this is flagged)
 *       * extra keys → error (template carries a field the schema dropped)
 *   - Copies `data.json.example` → `data.json` (the gitignored working copy
 *     that Obsidian loads). `--check` skips the copy.
 *
 * What it does NOT do: build the plugin, write `main.js`/`manifest.json`/
 * `styles.css` into the vault (obsidian-launcher's `--plugin .` and WDIO's
 * plugin-copy handle that), or accept cloud-provider credentials. The test
 * vault is LM-Studio-only by convention (see `.planning/test-harness-methodology.md`).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const vaultArg = args[args.indexOf('--vault') + 1];
const VAULT_NAME = vaultArg && !vaultArg.startsWith('--') ? vaultArg : 'simple';
const VAULT_DIR = join(ROOT, 'test', 'vaults', VAULT_NAME);
const PLUGIN_DIR = join(VAULT_DIR, '.obsidian', 'plugins', 'eventide-quill');
const EXAMPLE_PATH = join(PLUGIN_DIR, 'data.json.example');
const DATA_PATH = join(PLUGIN_DIR, 'data.json');

if (!existsSync(EXAMPLE_PATH)) {
    console.error(`setup-test-vault: template not found at ${EXAMPLE_PATH}`);
    console.error('Expected a committed data.json.example. Create one first.');
    process.exit(1);
}

/**
 * Extract the set of top-level keys defined in `DEFAULT_SETTINGS` from
 * `src/settings.ts`.
 *
 * The settings module imports Obsidian UI classes (Modal, SuggestModal,
 * Setting) and a few const references (`DEFAULT_IMAGE_PROXY_PROMPT`) that
 * don't resolve under Node, so a runtime `import` is impractical without a
 * heavy stub. Instead we read the source, find the `DEFAULT_SETTINGS`
 * object literal by brace matching, and scan it for top-level
 * `identifier:` keys (those at brace depth 1). Comparing the resulting key
 * set against the template catches schema drift (added/removed/renamed
 * fields) without ever evaluating the literal — which would pull in
 * transitive const references and TS casts.
 */
function loadDefaultSettingsKeys() {
    const settingsSrc = readFileSync(join(ROOT, 'src', 'settings.ts'), 'utf8');
    const decl = settingsSrc.match(/export\s+const\s+DEFAULT_SETTINGS\s*:[^{]*=\s*\{/);
    if (!decl) throw new Error('setup-test-vault: could not find DEFAULT_SETTINGS declaration in src/settings.ts');
    const start = (decl.index ?? 0) + decl[0].length; // index just after the opening `{`
    let depth = 1;
    let end = -1;
    for (let i = start; i < settingsSrc.length; i++) {
        const ch = settingsSrc[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0) throw new Error('setup-test-vault: DEFAULT_SETTINGS literal is unbalanced');
    const literal = settingsSrc.slice(start, end);

    // Walk the literal tracking brace/bracket/quote state. A "top-level key"
    // is an `identifier:` whose `:` appears while brace depth == 1 and bracket
    // depth == 0 and we're not inside a string. This skips keys inside nested
    // objects (e.g., provider config inside `aiProviders`) and colon characters
    // inside strings (e.g., URLs in default values).
    const keys = new Set();
    let braceDepth = 1;
    let bracketDepth = 0;
    let inString = false;
    let stringChar = '';
    for (let i = 0; i < literal.length; i++) {
        const ch = literal[i];
        const prev = literal[i - 1];
        if (inString) {
            if (ch === stringChar && prev !== '\\') inString = false;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
            continue;
        }
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
        else if (ch === ':' && braceDepth === 1 && bracketDepth === 0) {
            // Look backward for an identifier ending at i (skipping whitespace).
            let j = i - 1;
            while (j >= 0 && /\s/.test(literal[j])) j--;
            let k = j;
            while (k >= 0 && /[\w$]/.test(literal[k])) k--;
            const ident = literal.slice(k + 1, j + 1);
            if (ident && !keys.has(ident)) keys.add(ident);
        }
    }
    return keys;
}

const schemaKeys = loadDefaultSettingsKeys();

const template = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));

const templateKeys = new Set(Object.keys(template));

const missing = [...schemaKeys].filter((k) => !templateKeys.has(k));
const extra = [...templateKeys].filter((k) => !schemaKeys.has(k));

let failed = false;

if (missing.length > 0) {
    console.warn(
        `setup-test-vault: WARN — data.json.example is missing ${missing.length} key(s) from DEFAULT_SETTINGS:`
    );
    for (const k of missing) console.warn(`  - ${k}`);
    console.warn('  The template should be self-describing. Add the missing keys.');
}

if (extra.length > 0) {
    console.error(
        `setup-test-vault: FAIL — data.json.example has ${extra.length} key(s) not in DEFAULT_SETTINGS:`
    );
    for (const k of extra) console.error(`  - ${k}`);
    console.error('  These keys are no longer part of the schema. Remove them from the template.');
    failed = true;
}

if (failed) process.exit(1);

console.log(`setup-test-vault: schema OK — ${schemaKeys.size} keys present in data.json.example`);

if (CHECK_ONLY) {
    console.log('setup-test-vault: --check set, skipping data.json write');
    process.exit(0);
}

if (!existsSync(PLUGIN_DIR)) mkdirSync(PLUGIN_DIR, { recursive: true });
writeFileSync(DATA_PATH, JSON.stringify(template, null, 4) + '\n', 'utf8');
console.log(`setup-test-vault: wrote ${DATA_PATH.replace(ROOT + '/', '')}`);
