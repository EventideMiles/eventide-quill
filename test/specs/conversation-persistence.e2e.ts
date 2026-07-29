import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseChatBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantDone, openQuillSidebar } from '../helpers/obsidian-helpers.js';
import { isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Conversation persistence — snapshot the co-writer session to a sidecar,
 * start a new chat (wiping the display), then restore the saved session and
 * verify the chat reappears with the correct content.
 *
 * Tests the full round-trip: `snapshotCoWriterSession` → sidecar write →
 * `restoreCoWriterSession` → `restoreState` → panel rebind. The deterministic
 * part (`SerializedCoWriterState` serialization) is unit-tested in
 * `tests/ai/conversation-store.test.ts`; this spec covers the plugin lifecycle
 * + UI repaint that the unit tests can't reach.
 */
describe('Conversation persistence', () => {
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

    it('snapshots, clears, and restores a co-writer chat session', async () => {
        // 1. Establish a chat with a recognisable marker.
        await enqueueMock({ body: sseChatBody(['The answer to everything is 42.']) });
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('What is the answer?');
        await waitForAssistantDone(30_000, baseline);

        // Confirm the marker is visible before snapshotting.
        let bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(baseline);
        const beforeText = await bubbles[bubbles.length - 1]!.getText();
        expect(beforeText).to.include('42');

        // 2. Snapshot the session.
        const saved = await browser.execute(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as any).app.plugins.plugins['eventide-quill'];
            const ok = await plugin.snapshotCoWriterSession();
            return JSON.stringify({ ok, id: plugin.currentCoWriterSessionId });
        });
        const { ok, id } = JSON.parse(saved) as { ok: boolean; id: string };
        expect(ok).to.equal(true);
        expect(id).to.be.a('string');

        // 3. Start a new chat — the display should clear.
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as any).app.plugins.plugins['eventide-quill'];
            plugin?.resetCoWriterChat?.(true);
        });
        await browser.pause(500);
        bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.equal(0);

        // 4. Restore the saved session.
        const restored = await browser.execute(async (restoreId: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as any).app.plugins.plugins['eventide-quill'];
            return plugin.restoreCoWriterSession(restoreId);
        }, id);
        expect(restored).to.equal(true);

        // 5. The chat should reappear with the restored content.
        await browser.pause(500);
        bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(0);
        const restoredText = await bubbles[bubbles.length - 1]!.getText();
        expect(restoredText).to.include('42');
    });
});
