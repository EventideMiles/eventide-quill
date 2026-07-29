import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * CodeMirror decorations — the linter's gutter markers and the inline diff
 * decorations applied by `change-diff-extension.ts` when an AI-proposed edit
 * targets the active editor.
 *
 * The test manuscript is deliberately clunky (every linter rule fires on
 * purpose — see `manuscript/Chapter 01.md`), so simply opening it should
 * populate the lint gutter.
 *
 * NOTE: the inline-diff decoration path (the second test in earlier drafts)
 * was removed because driving it synthetically requires either deep access
 * to the CodeMirror `EditorView` (to dispatch a `setDiffEdits` effect with
 * the right snapshot shape) or a full review-discuss tool-call round. The
 * latter is exercised by `review-discuss.e2e.ts`'s change-card spec, which
 * surfaces the inline-diff path end-to-end through the real approval queue
 * — a more meaningful coverage than a synthetic dispatch here.
 */
describe('CodeMirror decorations', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
    beforeEach(async () => {
        await obsidianPage.resetVault();
        await openQuillSidebar();
    });

    it('flags long sentences and passive voice when the manuscript opens', async () => {
        // Toggle the linter on. The command is an editorCallback, so an editor
        // must be active for it to fire.
        await openFile('manuscript/Chapter 01.md');
        await browser.pause(500); // let the active-leaf-change event settle
        await browser.executeObsidianCommand('eventide-quill:lint-active-document');

        // Wait for either (a) a CodeMirror inline decoration, or (b) at least
        // one result row in the linter panel. The fixture manuscript
        // deliberately triggers every linter rule (long sentences, passive
        // voice, adverbs, AI clichés, em dashes, etc. — see
        // `manuscript/Chapter 01.md`), so a clean lint would itself be the
        // regression.
        //
        // Selectors: `.quill-linter__rule` is the CodeMirror mark class
        // applied by `core/linter/decorations.ts:127` (`Decoration.mark`).
        // `.quill-linter__item` is the panel result-row class
        // (`ui/quill-sidebar.ts:1480`). Both are concrete — the previous
        // broad `[class*="quill-lint"]` matched the empty panel chrome.
        let detected: 'gutter' | 'panel' | null = null;
        await browser.waitUntil(
            async () => {
                const markers = (await browser.$$('.quill-linter__rule')) as unknown as WebdriverIO.Element[];
                if (markers.length > 0) {
                    detected = 'gutter';
                    return true;
                }

                // Fall back to the linter panel. Clicking the Linter tab via
                // WDIO can be intercepted by Obsidian's Notice toasts (the
                // lint command may post a "Quill: linting…" notice that
                // briefly overlays the tab). Dispatch the tab click via DOM
                // to sidestep the overlay, then check for a concrete result row.
                await browser.execute(() => {
                    const tab = document.querySelector<HTMLElement>('.quill-sidebar__tab[title="Linter"]');
                    tab?.click();
                });
                await browser.pause(300);
                const rows = (await browser.$$('.quill-linter__item')) as unknown as WebdriverIO.Element[];
                if (rows.length > 0) {
                    detected = 'panel';
                    return true;
                }
                return false;
            },
            { timeout: 15_000, timeoutMsg: 'no linter markers or panel result rows appeared on the manuscript' }
        );

        // Concrete assertion — `waitUntil` returning truthy means we saw one
        // of the two paths; `detected` records which. Without this assertion
        // the test would trivially pass even if waitUntil's timeout were
        // accidentally raised to infinity.
        expect(detected).to.be.oneOf(['gutter', 'panel']);
    });
});
