import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, getMockStats, sseChatBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantBubble, waitForAssistantDone, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Co-writer core — discuss / coach / lorebook modes. Each mode has its own
 * tool loop and system prompt, but the chat surface (input + bubbles) is
 * shared. These specs exercise:
 *   1. discuss mode end-to-end (send → mock → bubble)
 *   2. coach mode (the same loop, different mode picker state)
 *   3. The default-tab "no provider configured" path is NOT covered — the
 *      test vault always has the mock provider pre-configured.
 */
describe('Co-writer chat', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('discuss mode streams an assistant reply', async () => {
        await enqueueMock({ body: sseChatBody(['The chapter opens with the traveller arriving by ship.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('Summarise the opening in one sentence.');

        const bubble = await waitForAssistantBubble(20_000, baseline);
        await waitForAssistantDone(30_000, baseline);
        const text = await bubble.getText();
        expect(text).to.match(/traveller|arrives|ship/i);

        const stats = await getMockStats();
        const last = stats.requests[stats.requests.length - 1];
        expect(last?.url).to.match(/\/v1\/chat\/completions$/);
        // The plugin always sets stream:true on the discuss path.
        expect(last?.body).to.include('"stream":true');
    });

    it('switches to coach mode and responds with a Socratic guiding question', async () => {
        // Coach mode uses the Socratic method — the AI asks questions to
        // help the writer develop the scene, rather than writing prose
        // directly. The test sends a scene prompt and asserts the mock
        // response (a Socratic question) renders correctly.
        await enqueueMock({ body: sseChatBody(['What is the traveller feeling as she steps off the ship? Is she confident about finding the scholar, or does she have doubts?']) });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        // Wait for the panel's button row to render, then click the mode
        // toggle button (`.quill-cowriter-panel__mode-btn`) to open the picker.
        // The picker itself only exists while `modePickerOpen` is true on the
        // panel — it's a popover, not a persistent element.
        const modeBtn = await browser.$('.quill-cowriter-panel__mode-btn');
        await modeBtn.waitForDisplayed({ timeout: 10_000 });
        await modeBtn.click();
        // Now the picker rows are visible. Each row's text is the mode label
        // ("Discuss", "Coach", etc.). Click the Coach row by text match.
        await browser.waitUntil(
            async () => {
                const rows = (await browser.$$('.quill-cowriter-panel__mode-row')) as unknown as WebdriverIO.Element[];
                if (rows.length === 0) return false;
                for (const row of rows) {
                    const txt = await row.getText();
                    if (/coach/i.test(txt)) {
                        await row.click();
                        return true;
                    }
                }
                return false;
            },
            { timeout: 5_000, timeoutMsg: 'coach mode row never appeared in the picker' }
        );

        const baseline = await sendCoWriterMessage('Help me develop the next scene where the traveller arrives at the harbour.');
        const bubble = await waitForAssistantBubble(20_000, baseline);
        await waitForAssistantDone(30_000, baseline);
        const text = await bubble.getText();
        // Coach mode response should be a guiding question (Socratic method).
        expect(text).to.include('?');
        expect(text).to.match(/traveller|feeling|confident|doubt|harbour/i);
    });

    it('preserves chat history across a sidebar close + reopen', async () => {
        await enqueueMock({ body: sseChatBody(['First reply.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('Hello.');
        await waitForAssistantDone(30_000, baseline);

        // Count bubbles before close. There should be at least one user and
        // one assistant bubble.
        const bubblesBefore = await browser.$$('.quill-cowriter-panel__chat-bubble');
        const countBefore = bubblesBefore.length;
        expect(countBefore).to.be.greaterThanOrEqual(2);

        // Switch away to the dashboard and back.
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        await browser.pause(300);
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');

        const bubblesAfter = await browser.$$('.quill-cowriter-panel__chat-bubble');
        expect(bubblesAfter.length).to.equal(countBefore);
    });
});
