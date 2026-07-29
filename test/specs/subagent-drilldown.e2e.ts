import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseToolCallBody, sseChatBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Subagent drill-down — when the co-writer calls `run_lorebook_batch`, a
 * `SubagentSession` spawns with its own isolated context and tool loop. The
 * parent chat shows an inline status card; clicking "View" drills into the
 * subagent's internal conversation; "← Back" returns to the parent chat.
 * See "Subagents" in AGENTS.md.
 *
 * This is the most complex UI flow in the codebase (parent tool round →
 * subagent spawn → subagent tool loop → inline card render → view switch →
 * back-navigation). The mock server's FIFO queue serves the parent's
 * tool-call response first, then the subagent's text reply.
 */
describe('Subagent drill-down', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as any).app.plugins.plugins['eventide-quill'];
            plugin?.resetCoWriterChat?.(true);
        });
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('renders a subagent card, drills into its conversation, and returns to the parent', async function () {
        // The subagent's synchronous tool loop can run for 60-90s against the
        // mock. Bump the per-test timeout well above the default 60s.
        this.timeout(180_000);

        // Enqueue in FIFO order:
        // 1. Parent's response: a run_lorebook_batch tool call.
        // 2-6. Subagent's responses: plain text (no tools) so the subagent
        //      finishes after a few rounds. The subagent may loop trying to
        //      call editing tools; each no-tool-call response moves it closer
        //      to giving up and returning a summary. Five responses covers
        //      the typical loop depth.
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_batch_1',
                    name: 'run_lorebook_batch',
                    arguments: JSON.stringify({
                        goal: 'SUBAGENT_GOAL_MARKER: flesh out the Harbourmaster',
                        paths: ['lore/characters/Magda Vos.md']
                    })
                }
            ])
        });
        for (let i = 0; i < 5; i++) {
            await enqueueMock({ body: sseChatBody([`SUBAGENT_REPLY_MARKER: round ${i} complete.`]) });
        }

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await sendCoWriterMessage('Edit the Magda Vos lore entry.');

        // Don't waitForAssistantDone or wait for terminal status — the
        // subagent's tool loop can run indefinitely against the mock
        // (coWriterMaxToolRounds: 0 means unlimited). The CARD renders as
        // soon as the SubagentSession spawns (status: running), and the
        // "Watch" button (shown while running) drives the same drill-down
        // as "View." This tests the card-render + view-switch + back-
        // navigation paths without depending on the subagent completing.
        const card = await browser.$('.quill-cowriter-panel__subagent-card');
        await card.waitForDisplayed({ timeout: 30_000 });

        // Verify the card shows the goal + a "Watch" button (running status).
        const goalText = await browser.$('.quill-cowriter-panel__subagent-goal').getText();
        expect(goalText).to.include('SUBAGENT_GOAL_MARKER');
        const viewBtn = await browser.$('.quill-cowriter-panel__subagent-view');
        expect(await viewBtn.getText()).to.match(/watch|view/i);

        // Click "Watch" to drill into the subagent's live conversation.
        await viewBtn.click();

        // The drill-down view renders a "← Back" bar. Wait for it.
        const backBtn = await browser.$('.quill-cowriter-panel__subagent-back');
        await backBtn.waitForDisplayed({ timeout: 10_000 });
        expect(await backBtn.isDisplayed()).to.equal(true);

        // The subagent's conversation should be rendering. The drill-down
        // replaces the parent chat content, so any chat bubbles visible
        // alongside the back button are the subagent's. Assert on the
        // bubble count rather than a broad `[class*="subagent"]` match
        // (which would also match the status card / View button in the
        // parent view).
        const drillDownBubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble')) as unknown as WebdriverIO.Element[];
        expect(drillDownBubbles.length).to.be.greaterThan(0);

        // Click "← Back" and verify the parent chat is preserved.
        await backBtn.click();
        await browser.pause(500);

        // The parent chat should still have the original user message.
        const parentUserText = await browser.execute(() => {
            return Array.from(document.querySelectorAll('.quill-cowriter-panel__chat-bubble--user'))
                .map((el) => el.textContent ?? '')
                .join('\n');
        });
        expect(parentUserText).to.include('Edit the Magda Vos lore entry.');
    });
});
