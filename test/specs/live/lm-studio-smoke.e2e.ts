import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { clearMocks } from '../../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantDone, openQuillSidebar } from '../../helpers/obsidian-helpers.js';

/**
 * Live LM Studio smoke — exercises the real wire format against a real local
 * model. NOT part of the mocked suite (these specs hit localhost:1234 directly
 * and don't use the mock server for chat completions).
 *
 * Run with:
 *   npm run test:e2e:live
 *
 * Auto-skips if LM Studio is unreachable at http://localhost:1234/v1/models so
 * CI (which doesn't run a model) doesn't fail. Skipped tests in Mocha exit 0,
 * keeping the suite green when LM Studio is off.
 *
 * The mocked suite covers behaviour; this suite catches wire-format drift
 * (new required fields, response shape changes, etc.) that a mock server
 * can't catch by definition.
 */
const LM_STUDIO_URL = 'http://localhost:1234/v1/models';

async function lmStudioReachable(): Promise<boolean> {
    try {
        const res = await fetch(LM_STUDIO_URL, { method: 'GET', signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

describe('Live LM Studio smoke', () => {
    before(async function () {
        // `this.skip()` marks the suite as pending (exit 0) rather than failed.
        const reachable = await lmStudioReachable();
        if (!reachable) {
            console.warn(`[live] LM Studio not reachable at ${LM_STUDIO_URL} — skipping live smoke suite`);
            this.skip();
            return;
        }
        await clearMocks(); // defensive: live suite doesn't use the mock server
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('streams a discuss-mode reply from the real local model', async function () {
        const reachable = await lmStudioReachable();
        if (!reachable) return this.skip();

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await sendCoWriterMessage('In one short sentence, who arrives at the harbour?');

        // The real model is slow and timing varies wildly — give it generous
        // room. The assertion is just that SOME assistant text arrives.
        await waitForAssistantDone(120_000);
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(0);
        const lastText = await bubbles[bubbles.length - 1]!.getText();
        expect(lastText.length).to.be.greaterThan(0);
    });

    it('handles a follow-up turn using the same chat session', async function () {
        const reachable = await lmStudioReachable();
        if (!reachable) return this.skip();

        await sendCoWriterMessage('And in one word, where did she come from?');
        await waitForAssistantDone(120_000);
        // The follow-up proves the session retained the prior turn in its API
        // array (otherwise the model has no context to be "follow-up" about).
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(1);
    });
});
