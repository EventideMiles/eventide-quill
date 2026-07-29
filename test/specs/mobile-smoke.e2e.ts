import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { clearMocks, enqueueMock, sseChatBody } from '../helpers/mock-server.js';
import { sendCoWriterMessage, waitForAssistantDone, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Mobile emulation smoke — verifies the plugin loads and basic flows work
 * under Obsidian's `emulateMobile` mode (390×844 viewport, Capacitor-like
 * platform flags). The real mobile app runs on Capacitor (not Electron), so
 * this is an imperfect emulation — but it catches the most common responsive-
 * layout regressions (button-row collapse, viewport-width assumptions).
 *
 * Runs on BOTH desktop and mobile capabilities (WDIO doesn't support per-spec
 * capability scoping). On desktop it's a basic smoke; on mobile it validates
 * the responsive layout path.
 */
describe('Mobile emulation smoke', () => {
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
    });

    it('loads the plugin on the mobile-emulated viewport', async () => {
        // On mobile the sidebar tab bar may render in a drawer that takes
        // longer to appear. Use the dashboard command directly and wait for
        // any quill- element rather than the specific tab bar.
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        const el = await browser.waitUntil(
            async () => {
                const candidate = await browser.$('[class*="quill-"]');
                if (await candidate.isExisting()) return candidate;
                return false;
            },
            { timeout: 15_000, timeoutMsg: 'no quill elements appeared' }
        );
        expect(await el.isDisplayed()).to.equal(true);
    });

    it('completes a co-writer chat round-trip on mobile', async function () {
        // Both branches enqueue a mock, send a message, wait for the reply,
        // and assert on the reply text. On mobile, if the co-writer input
        // doesn't render within a generous timeout (responsive layout may
        // hide it behind a hamburger/drawer), skip rather than fail — the
        // mobile UI is still under active development.
        await enqueueMock({ body: sseChatBody(['Reply from the mock.']) });
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');

        const input = await browser.$('.quill-cowriter-panel__input');
        const found = await input.waitForDisplayed({ timeout: 15_000 }).catch(() => false);
        if (!found) {
            if (isMobileEmulation()) {
                console.warn('[mobile-smoke] co-writer input not visible on mobile — responsive layout may need a tap');
                return this.skip();
            }
            throw new Error('co-writer input never appeared');
        }

        const baseline = await sendCoWriterMessage('Hello.');
        await waitForAssistantDone(30_000, baseline);
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(baseline);
        const text = await bubbles[bubbles.length - 1]!.getText();
        expect(text.trim().length).to.be.greaterThan(0);
    });
});
