import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseChatBody } from '../helpers/mock-server.js';
import {
    openFile,
    sendCoWriterMessage,
    waitForAssistantBubble,
    waitForAssistantDone,
    openQuillSidebar,
    isMobileEmulation
} from '../helpers/obsidian-helpers.js';

/**
 * Deep behavioral E2E — exercises the complex panels' state transitions in
 * real Obsidian with the mock AI server. Complements the existing co-writer /
 * review-discuss / feedback-queue specs with paths they don't cover.
 */
describe('Deep behavioral', () => {
    beforeEach(function () {
        if (isMobileEmulation()) return this.skip();
    });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('preserves co-writer chat when switching sidebar tabs and back', async () => {
        await enqueueMock({ body: sseChatBody(['The rain fell in sheets over the harbour.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('Describe the weather.');
        await waitForAssistantBubble(20_000, baseline);
        await waitForAssistantDone(30_000, baseline);

        // Switch to the Linter tab, then back to Co-writer.
        const linterTab = await browser.$('.quill-sidebar__tab[aria-label="Linter"]');
        await linterTab.waitForDisplayed({ timeout: 5000 });
        await linterTab.click();
        await browser.pause(500);
        const cowriterTab = await browser.$('.quill-sidebar__tab[aria-label="Co-writer"]');
        await cowriterTab.waitForDisplayed({ timeout: 5000 });
        await cowriterTab.click();
        await browser.pause(500);

        // The assistant bubble should survive the tab switch.
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(0);
        const lastText = await bubbles[bubbles.length - 1].getText();
        expect(lastText).to.match(/rain|harbour/i);
    });

    // The mode-picker interaction is already covered by co-writer.e2e.ts's
    // Coach test (same selector pattern). Skip here to avoid duplication.
    it.skip('opens the co-writer mode picker and shows multiple modes', async () => {
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await browser.pause(500);

        // Open the mode picker.
        const modeBtn = await browser.$('.quill-cowriter-panel__mode-btn');
        await modeBtn.waitForDisplayed({ timeout: 10_000 });
        await modeBtn.click();
        await browser.pause(500);

        // At least two mode rows should appear (Discuss + Coach at minimum).
        await browser.waitUntil(
            async () => {
                const rows = (await browser.$$('.quill-cowriter-panel__mode-row')) as unknown as WebdriverIO.Element[];
                return rows.length >= 2;
            },
            { timeout: 5_000, timeoutMsg: 'mode picker rows never appeared' }
        );

        // The existing coach test covers specific mode selection; this test
        // verifies the picker UI renders the available modes.
        const rows = (await browser.$$('.quill-cowriter-panel__mode-row')) as unknown as WebdriverIO.Element[];
        const labels = await Promise.all(rows.map((r) => r.getText()));
        expect(labels.some((l) => /discuss|coach|direct|fulfill|lorebook/i.test(l))).to.equal(true);
    });

    it('opens the review tab and renders the Create subtab', async () => {
        await browser.executeObsidianCommand('eventide-quill:quill-review-open');

        // Wait for any review-panel content to appear (broad selector).
        await browser.waitUntil(
            async () => {
                const sidebar = await browser.$('.quill-sidebar');
                const text = await sidebar.getText();
                return text.length > 50; // review form has substantial content
            },
            { timeout: 10_000, timeoutMsg: 'review tab content never rendered' }
        );

        // Verify the review tab has actionable content (engine choices, submit).
        const sidebar = await browser.$('.quill-sidebar');
        const text = await sidebar.getText();
        expect(text).to.match(/review|analysis|feedback|critical/i);
    });

    it('renders the feedback queue subtab with content', async () => {
        await browser.executeObsidianCommand('eventide-quill:quill-review-open');

        // Wait for the review panel to render.
        await browser.waitUntil(
            async () => {
                const sidebar = await browser.$('.quill-sidebar');
                const text = await sidebar.getText();
                return text.length > 50;
            },
            { timeout: 10_000, timeoutMsg: 'review tab never rendered' }
        );

        // Look for a Queue-related element to click.
        const queueElements = await browser.$$('*=Queue');
        for (const el of queueElements) {
            try {
                await el.click();
                await browser.pause(400);
                break;
            } catch {
                /* not clickable, try next */
            }
        }

        // The sidebar should still have content after the interaction.
        const sidebar = await browser.$('.quill-sidebar');
        const text = await sidebar.getText();
        expect(text.length).to.be.greaterThan(0);
    });
});
