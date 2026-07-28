import * as path from 'node:path';
import { env } from 'node:process';
import { parseObsidianVersions, obsidianBetaAvailable } from 'wdio-obsidian-service';
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

export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',

    specs: ['./test/specs/**/*.e2e.ts'],
    exclude: ['./test/specs/live/**/*.e2e.ts'],

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
     */
    async onPrepare() {
        const port = Number(env.E2E_MOCK_PORT ?? 43194);
        await startMockServer(port);
        env.E2E_MOCK_PORT = String(port);
        await writeMockedDataJson(vault, port);
        // eslint-disable-next-line no-console
        console.log(`[wdio.conf] mock SSE/NDJSON server listening on http://localhost:${port}/v1`);
    },

    onComplete() {
        stopMockServer();
    }
};

// Keep `obsidianBetaAvailable` referenced so the import isn't elided in case a
// future revision wants to gate beta testing on credentials being available.
void obsidianBetaAvailable;
