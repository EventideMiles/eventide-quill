// Mocha's `describe`/`it`/`before`/`after` are ambient via @types/mocha (with
// `injectGlobals: false` in wdio.conf.mts, WDIO's own `browser`/`$`/`$$`/
// `expect` are imported explicitly from `@wdio/globals`). The mock-server
// helpers run in this (worker) process and reach the parent's listener via
// the env var `onPrepare` publishes.
import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, getMockStats, sseChatBody } from '../helpers/mock-server.js';

/**
 * Smoke spec — verifies the harness end-to-end:
 *   1. Obsidian launches and the plugin loads.
 *   2. The plugin's sidebar view opens (via the registered command).
 *   3. The mock SSE server intercepts an AI call.
 *
 * If this passes, the rest of the suite can rely on all three. If it fails,
 * the failure is infrastructure (download, sandbox, mock server, data.json),
 * not test logic — fix it before chasing spec-specific failures.
 */
describe('Harness smoke', () => {
    before(async () => {
        await clearMocks();
        await browser.reloadObsidian({ vault: 'test/vaults/simple' });
    });

    after(async () => {
        await clearMocks();
    });

    it('loads the plugin and exposes its commands', async () => {
        // The plugin registers commands with `Quill: ` prefix. Asking Obsidian
        // to execute one and seeing the sidebar appear proves onload ran and
        // registered the view + commands.
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        const sidebar = await browser.$('.quill-sidebar__tab-bar');
        await sidebar.waitForDisplayed({ timeout: 10_000 });
        expect(await sidebar.isDisplayed()).to.equal(true);
    });

    it('sees the test vault manuscript', async () => {
        // Open the first chapter so the dashboard has a manuscript to chew on.
        // `browser.execute` runs in the renderer, where `window.app` is the
        // live Obsidian `App` instance.
        await browser.execute(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            const file = app.vault.getAbstractFileByPath('manuscript/Chapter 01.md');
            if (file) await app.workspace.getLeaf(false).openFile(file);
        });
        // Re-open the dashboard command (idempotent — focuses the sidebar view)
        // and give the debounced manuscript scan a moment to land. The dashboard
        // renders into `.quill-dashboard-panel__scroll` (no plain wrapper block).
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        const dashScroll = await browser.$('.quill-dashboard-panel__scroll');
        await dashScroll.waitForDisplayed({ timeout: 15_000 });
        expect(await dashScroll.isDisplayed()).to.equal(true);
    });

    it('routes AI provider calls through the mock server', async () => {
        // Enqueue a canned chat completion, then trigger an AI flow that
        // issues a /v1/chat/completions call. The exact trigger doesn't matter
        // for the smoke test — we just want to see the mock server record at
        // least one data-plane request from inside Obsidian.
        await enqueueMock({ body: sseChatBody(['mock smoke response']) });

        // Open the co-writer tab and send a trivial message. The discuss mode
        // calls chatCompletion on the configured provider, which is pointed at
        // the mock server by onPrepare.
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const input = await browser.$('.quill-cowriter-panel__input');
        await input.waitForDisplayed({ timeout: 10_000 });
        await input.setValue('smoke test message');
        await browser.keys('Enter');

        // The mock response should land within a few seconds.
        const stats = await browser.waitUntil(
            async () => {
                const s = await getMockStats();
                return s.requests.some((r) => r.url.includes('/v1/chat/completions')) ? s : false;
            },
            { timeout: 15_000, timeoutMsg: 'mock server never saw a chat-completions request' }
        );
        expect(stats.requests.some((r) => r.url.includes('/v1/chat/completions'))).to.equal(true);
    });
});
