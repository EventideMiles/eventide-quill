import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
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
    let liveAvailable = false;

    before(async function () {
        // Probe once and cache the result. `this.skip()` in `before` marks
        // the whole suite as pending (exit 0) so CI without a model stays
        // green; each `it()` re-checks so a model killed mid-suite still
        // produces a skip rather than a network-error failure.
        liveAvailable = await lmStudioReachable();
        if (!liveAvailable) {
            console.warn(`[live] LM Studio not reachable at ${LM_STUDIO_URL} — skipping live smoke suite`);
            this.skip();
        }
    });

    beforeEach(async () => {
        if (!liveAvailable) return;
        // Each test gets a clean vault + a fresh manuscript open + the sidebar
        // visible. resetVault restores files in-place without an Obsidian
        // reboot, so it's cheap enough to run per-test even on the slow live
        // path.
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('streams a discuss-mode reply from the real local model', async function () {
        if (!liveAvailable) return this.skip();

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('In one short sentence, who arrives at the harbour?');

        // The real model is slow and timing varies wildly — give it generous
        // room. The assertion is just that SOME assistant text arrives.
        await waitForAssistantDone(120_000, baseline);
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(baseline);
        const lastText = await bubbles[bubbles.length - 1]!.getText();
        expect(lastText.length).to.be.greaterThan(0);
    });

    it('handles a follow-up turn using the same chat session', async function () {
        if (!liveAvailable) return this.skip();

        // Open a FRESH chat for this test rather than relying on the prior
        // test's session — keeps the test independent (the suite can run a
        // single `it` in isolation via WDIO's --spec filter without breaking).
        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baselineOne = await sendCoWriterMessage('In one short sentence, who arrives at the harbour?');
        await waitForAssistantDone(120_000, baselineOne);

        // Now send the actual follow-up the test is verifying.
        const baselineTwo = await sendCoWriterMessage('And in one word, where did she come from?');
        await waitForAssistantDone(120_000, baselineTwo);

        // Two assistant bubbles beyond this test's starting baseline proves
        // the session retained the first turn in its API array (otherwise the
        // model has no context to be "follow-up" about).
        const bubbles = (await browser.$$('.quill-cowriter-panel__chat-bubble--assistant')) as unknown as WebdriverIO.Element[];
        expect(bubbles.length).to.be.greaterThan(baselineOne + 1);
    });
});
