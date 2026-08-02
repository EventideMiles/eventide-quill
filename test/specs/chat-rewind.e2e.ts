import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseChatBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantDone, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Chat rewind — right-click a user message → "Rewind to here" discards that
 * message and everything after (display + the model's API array), then
 * pre-fills the input with the discarded text. See "Chat rewind" in
 * AGENTS.md.
 *
 * Covers the v2.1.0 `quillAnchorId`-based API-truncation logic. The deterministic
 * part (anchor stripping) is unit-tested; this spec covers the UI flow +
 * display/API sync that the unit tests can't reach.
 *
 * NOTE: the spec explicitly switches to **discuss mode** before sending.
 * Coach mode (the panel default) doesn't stamp the user message's
 * `quillAnchorId` in the API array, which disables the rewind menu item.
 * Discuss mode stamps anchors correctly and is the primary rewind use case.
 */
describe('Chat rewind', () => {
    beforeEach(async function () {
        if (isMobileEmulation()) return this.skip();
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

    /** Switch the co-writer panel to discuss mode via the mode picker popover. */
    async function switchToDiscussMode(): Promise<void> {
        const modeBtn = await browser.$('.quill-cowriter-panel__mode-btn');
        await modeBtn.waitForDisplayed({ timeout: 10_000 });
        await modeBtn.click();
        await browser.waitUntil(
            async () => {
                const rows = (await browser.$$('.quill-cowriter-panel__mode-row')) as unknown as WebdriverIO.Element[];
                for (const row of rows) {
                    const txt = await row.getText();
                    if (/discuss/i.test(txt)) {
                        await row.click();
                        return true;
                    }
                }
                return false;
            },
            { timeout: 5_000, timeoutMsg: 'Discuss mode row never appeared' }
        );
    }

    /**
     * Right-click the user bubble whose text matches `textPattern`, then click
     * the "Rewind to here" menu item. Matching by text (rather than "last user
     * bubble") is necessary because discuss mode generates an internal
     * options-request user bubble after each turn ("Generate continuation
     * options…") that appears as the last user bubble in the DOM but isn't
     * rewindable (it's never in the model's API array — see AGENTS.md
     * "Chat rewind").
     */
    async function rewindUserBubbleMatching(textPattern: RegExp): Promise<void> {
        // Dispatch the contextmenu event directly on the matching user bubble.
        // WDIO's native right-click goes through the WebDriver action API
        // which is flaky against Obsidian's Menu component; a synthetic
        // contextmenu event is what the panel actually listens for.
        const dispatched = await browser.execute(
            (patternSource: string) => {
                const pattern = new RegExp(patternSource);
                const bubbles = Array.from(document.querySelectorAll('.quill-cowriter-panel__chat-bubble--user'));
                const target = bubbles.find((el) => pattern.test(el.textContent ?? ''));
                if (!target) return false;
                target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                return true;
            },
            textPattern.source
        );
        if (!dispatched) throw new Error(`rewind: no user bubble matched ${textPattern}`);
        // The Obsidian Menu renders async; wait for the menu item to appear
        // and click it by text match.
        await browser.waitUntil(
            async () => {
                const items = (await browser.$$('.menu-item')) as unknown as WebdriverIO.Element[];
                for (const item of items) {
                    const txt = await item.getText();
                    if (/rewind to here/i.test(txt)) {
                        // Skip if disabled (aria-disabled or .is-disabled).
                        const cls = await item.getAttribute('class');
                        const disabled = await item.getAttribute('aria-disabled');
                        if (cls?.includes('is-disabled') || disabled === 'true') {
                            throw new Error('"Rewind to here" is disabled — message is not rewindable');
                        }
                        await item.click();
                        return true;
                    }
                }
                return false;
            },
            { timeout: 5_000, timeoutMsg: '"Rewind to here" menu item never appeared' }
        );
    }

    it('discards the rewound message and everything after, pre-filling the input', async () => {
        // First turn — establishes the anchor that rewind will strip.
        await enqueueMock({ body: sseChatBody(['First assistant reply.']) });
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await switchToDiscussMode();
        const baseline1 = await sendCoWriterMessage('First user message.');
        await waitForAssistantDone(30_000, baseline1);

        // Second turn — must be discarded by the rewind.
        await enqueueMock({ body: sseChatBody(['Second assistant reply.']) });
        const baseline2 = await sendCoWriterMessage('Second user message.');
        await waitForAssistantDone(30_000, baseline2);

        // Capture the pre-rewind counts. Discuss mode generates an internal
        // options-request user bubble after each turn (visible in the DOM as
        // "Generate continuation options…"), so the user-bubble count isn't
        // just `messages sent`. Use relative counts: the rewind should drop
        // exactly one user + one assistant (the rewound pair).
        const userBefore = (await browser.$$('.quill-cowriter-panel__chat-bubble--user')) as unknown as WebdriverIO.Element[];
        const assistantBefore = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];

        // Rewind the SECOND user message. That user message and its assistant
        // reply should drop, and the input should pre-fill with "Second user
        // message." so the writer can edit and resend.
        await rewindUserBubbleMatching(/Second user message\./);

        // Wait for the bubble count to drop (rewind is synchronous but the
        // panel re-renders on the next animation frame). Exactly one user +
        // one assistant bubble should be gone.
        await browser.waitUntil(
            async () => {
                const user = (await browser.$$('.quill-cowriter-panel__chat-bubble--user')) as unknown as WebdriverIO.Element[];
                const assistant = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
                return user.length === userBefore.length - 1 && assistant.length === assistantBefore.length - 1;
            },
            { timeout: 5_000, timeoutMsg: 'bubble count did not drop after rewind' }
        );

        // The rewound user text must be gone from the visible chat. (The
        // first user message's text survives — only the rewound pair drops.)
        const survivingUserText = await browser.execute(() => {
            return Array.from(document.querySelectorAll('.quill-cowriter-panel__chat-bubble--user'))
                .map((el) => el.textContent ?? '')
                .join('\n---\n');
        });
        expect(survivingUserText).to.include('First user message.');
        expect(survivingUserText).to.not.include('Second user message.');

        // Input should contain the discarded text so the writer can edit/resend.
        const input = await browser.$('.quill-cowriter-panel__input');
        const value = await input.getValue();
        expect(value).to.include('Second user message.');
    });

    it('clears the rewound message from the API array (model genuinely forgets)', async () => {
        // Verify the API-truncation by sending a follow-up and inspecting the
        // mock request body — the rewound user/assistant pair should NOT be
        // in the messages array (proving the model "forgot" them).
        await enqueueMock({ body: sseChatBody(['First reply.']) });
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await switchToDiscussMode();
        const baseline1 = await sendCoWriterMessage('KEEP_THIS_MARKER one.');
        await waitForAssistantDone(30_000, baseline1);

        await enqueueMock({ body: sseChatBody(['Second reply.']) });
        const baseline2 = await sendCoWriterMessage('DISCARD_THIS_MARKER two.');
        await waitForAssistantDone(30_000, baseline2);

        await rewindUserBubbleMatching(/DISCARD_THIS_MARKER/);

        // Enqueue a canned response for the follow-up turn and send it.
        const { getMockStats } = await import('../helpers/mock-server.js');
        await clearMocks();
        await enqueueMock({ body: sseChatBody(['Follow-up reply.']) });
        const input = await browser.$('.quill-cowriter-panel__input');
        await input.setValue('What did I just say?');
        await browser.keys('Enter');

        // Wait for the follow-up request to land, then read its body.
        const stats = await browser.waitUntil(
            async () => {
                const s = await getMockStats();
                // The follow-up request is the most recent chat-completions POST.
                const last = s.requests[s.requests.length - 1];
                if (last && last.url.includes('/v1/chat/completions')) return s;
                return false;
            },
            { timeout: 15_000, timeoutMsg: 'follow-up request never reached the mock server' }
        );
        const lastBody = stats.requests[stats.requests.length - 1]!.body;
        // KEEP marker survives, DISCARD marker is gone — proves the API array
        // was actually truncated (not just the display).
        expect(lastBody).to.include('KEEP_THIS_MARKER');
        expect(lastBody).to.not.include('DISCARD_THIS_MARKER');
    });
});
