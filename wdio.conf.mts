import * as path from 'node:path';
import * as fs from 'node:fs';
import { env } from 'node:process';
import { parseObsidianVersions } from 'wdio-obsidian-service';
import { startMockServer, writeMockedDataJson, stopMockServer } from './test/helpers/mock-server.js';

/**
 * WebdriverIO configuration for the Eventide Quill E2E suite.
 *
 * Drives a real, sandboxed Obsidian via `wdio-obsidian-service`. The mocked
 * suite (default) is hermetic: an in-process mock SSE/NDJSON server stands in
 * for the AI provider so the suite runs without an LM Studio. The optional
 * live suite under test/specs/live hits a real LM Studio at localhost:1234
 * and self-skips when unreachable.
 *
 * Run:
 *   npm run test:e2e        mocked suite (default)
 *   npm run test:e2e:live   only the live LM Studio smoke
 *
 * Two test frameworks coexist (Vitest for tests/test.ts, Mocha+WDIO for
 * test/e2e.ts). See .planning/test-harness-methodology.md.
 */
const cacheDir = path.resolve('.obsidian-cache');

// Test against the configured `minAppVersion` (earliest) and `latest` Obsidian.
// In CI this is overridden via OBSIDIAN_VERSIONS; locally we keep it to the
// latest stable so the dev loop is fast.
const defaultVersions = 'latest/latest';
const desktopVersions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? defaultVersions, { cacheDir });

if (env.CI) {
    // Logged so the workflow can use it as a cache key (see .github/workflows/e2e.yml).
    console.log('obsidian-cache-key:', JSON.stringify(desktopVersions));
}

const vault = 'test/vaults/simple';

/**
 * Live mode: when `--spec test/specs/live/**` (or `E2E_LIVE=1`) is in play,
 * skip the mock server entirely and rewrite `data.json` to point at the real
 * LM Studio at localhost:1234 using whatever model is actually loaded.
 *
 * The mocked suite MUST stay hermetic; the live suite is the only place real
 * network calls are allowed. Detecting live mode here (rather than via a
 * separate wdio config) keeps the runner surface to a single file.
 */
const isLive = env.E2E_LIVE === '1' || process.argv.some((a) => a.includes('test/specs/live'));

async function resolveLmStudioModel(): Promise<string> {
    const res = await fetch('http://localhost:1234/v1/models');
    if (!res.ok) throw new Error(`LM Studio /v1/models returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const first = body.data?.[0]?.id;
    if (!first) throw new Error('LM Studio /v1/models returned no models');
    return first;
}

function rewriteDataJsonForLive(modelId: string): void {
    // Read the committed example, swap the endpoint + model id to point at the
    // real LM Studio with the actually-loaded model, then write the working
    // `data.json` (gitignored).
    const pluginDir = path.join(vault, '.obsidian', 'plugins', 'eventide-quill');
    const examplePath = path.join(pluginDir, 'data.json.example');
    const dataPath = path.join(pluginDir, 'data.json');
    const template = JSON.parse(fs.readFileSync(examplePath, 'utf8')) as Record<string, unknown>;
    const providers = Array.isArray(template.aiProviders)
        ? [...(template.aiProviders as object[])]
        : [];
    providers[0] = {
        ...(providers[0] as object),
        name: 'LM Studio (live E2E)',
        endpoint: 'http://localhost:1234/v1',
        models: [{ id: modelId, role: 'both', model: modelId }]
    };
    template.aiProviders = providers;
    const providerId = (providers[0] as { id: string }).id;
    template.aiDefaultChatProvider = `${providerId}/${modelId}`;
    template.aiDefaultEmbedProvider = `${providerId}/${modelId}`;
    fs.writeFileSync(dataPath, JSON.stringify(template, null, 4) + '\n', 'utf8');
}

export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',

    specs: isLive ? ['./test/specs/live/**/*.e2e.ts'] : ['./test/specs/**/*.e2e.ts'],
    exclude: isLive ? [] : ['./test/specs/live/**/*.e2e.ts'],

    // Sequential by default: the mocked suite shares one mock server and one
    // vault, so parallel instances would race on response registration. CI
    // bumps this to 2 since the matrix is single-version anyway and the live
    // suite is excluded.
    maxInstances: Number(env.WDIO_MAX_INSTANCES ?? 1),

    capabilities: desktopVersions.map(([appVersion, installerVersion]) => ({
        browserName: 'obsidian',
        'wdio:obsidianOptions': {
            appVersion,
            installerVersion,
            plugins: ['.'],
            vault
        }
    })) as WebdriverIO.Capabilities[],

    services: ['obsidian'],

    reporters: ['obsidian'],

    mochaOpts: {
        ui: 'bdd',
        timeout: 60_000
    },
    waitforInterval: 250,
    waitforTimeout: 5_000,
    logLevel: (env.WDIO_LOG_LEVEL ?? 'warn') as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent',

    cacheDir,

    injectGlobals: false,

    /**
     * Start the mock SSE/NDJSON server before any worker launches, then rewrite
     * the test vault's `data.json` so the plugin's configured provider points
     * at it. The port is published via `E2E_MOCK_PORT` so specs (and the live
     * suite's reachability probe) can read it. Stopped in `onComplete`.
     *
     * In live mode (E2E_LIVE=1 or --spec test/specs/live/**), skip the mock
     * entirely and instead rewrite data.json to point at the real LM Studio
     * with whatever model is currently loaded (queried via /v1/models).
     */
    async onPrepare() {
        if (isLive) {
            const modelId = await resolveLmStudioModel();
            rewriteDataJsonForLive(modelId);
            // eslint-disable-next-line no-console
            console.log(`[wdio.conf] live mode — data.json pointed at LM Studio model "${modelId}"`);
            return;
        }
        const port = Number(env.E2E_MOCK_PORT ?? 43194);
        await startMockServer(port);
        env.E2E_MOCK_PORT = String(port);
        await writeMockedDataJson(vault, port);
        // eslint-disable-next-line no-console
        console.log(`[wdio.conf] mock SSE/NDJSON server listening on http://localhost:${port}/v1`);
    },

    onComplete() {
        if (!isLive) stopMockServer();
    }
};
