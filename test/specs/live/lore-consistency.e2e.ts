import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar } from '../../helpers/obsidian-helpers.js';

/**
 * Live lore-consistency critical-analysis — validates the new (2.2.0) 5th
 * critical mode end-to-end against a real local model: the prompt is accepted,
 * the (possibly tool-augmented + embedding-backed) stream completes, and a
 * non-empty report renders in the Review tab. With a dedicated embed model
 * loaded this also exercises the real embeddings path (lore reference
 * resolution). Auto-skips when LM Studio is unreachable.
 *
 * Run with: npm run test:e2e:live -- --spec test/specs/live/lore-consistency.e2e.ts
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

describe('Live lore-consistency analysis', () => {
    let liveAvailable = false;

    before(async function () {
        liveAvailable = await lmStudioReachable();
        if (!liveAvailable) {
            // eslint-disable-next-line no-console
            console.warn(`[live] LM Studio not reachable at ${LM_STUDIO_URL} — skipping lore-consistency suite`);
            this.skip();
            return;
        }
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('streams a non-empty lore-consistency report from the real local model', async function () {
        if (!liveAvailable) return this.skip();
        // Critical analysis can run tool rounds (vault_lookup / lore_siblings)
        // and an embeddings pass against a real model, so allow generous time.
        this.timeout(180_000);

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        await browser.execute(() => {
            const plugin = (window as unknown as {
                app: { plugins: { plugins: Record<string, { requestAnalysis?: (m: string, s: string) => void }> } };
            }).app.plugins.plugins['eventide-quill'];
            const fn = plugin?.requestAnalysis;
            if (typeof fn === 'function') void fn.call(plugin, 'lore-consistency', 'document');
        });

        // The empty report container exists the moment the analysis enters its
        // loading state, so waitForDisplayed would short-circuit on an empty
        // div. Poll for non-empty text instead, re-querying each iteration: the
        // container is recreated (__report -> __report-rendered) when streaming
        // completes, which would stale the element handle.
        let text = '';
        await browser.waitUntil(
            async () => {
                const r = await browser.$('.quill-review-panel__report, .quill-review-panel__report-rendered');
                if (!(await r.isExisting())) return false;
                const t = (await r.getText()).trim();
                if (t.length > 0) {
                    text = t;
                    return true;
                }
                return false;
            },
            { timeout: 170_000, timeoutMsg: 'lore-consistency report never produced text' }
        );
        // eslint-disable-next-line no-console
        console.log('[live] lore-consistency report: ' + text.slice(0, 200));
        expect(text.length).to.be.greaterThan(0);
    });
});
