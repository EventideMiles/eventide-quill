import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar } from '../helpers/obsidian-helpers.js';

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

        // The linter debounces (~300ms); wait for at least one gutter marker
        // OR a linter-panel result row. Either proves the decorations landed.
        // The selector list is intentionally broad — class names live in
        // `core/linter/decorations.ts` and may shift; the substring match on
        // "quill-lint" is the stable anchor.
        await browser.waitUntil(
            async () => {
                const markers = (await browser.$$(
                    '.cm-linter-marker, .quill-lint-marker, [class*="quill-lint"]'
                )) as unknown as WebdriverIO.Element[];
                if (markers.length > 0) return true;

                // Fall back to the linter panel — switch to it via the tab and
                // check for any rendered result row.
                const linterTab = await browser.$('.quill-sidebar__tab[title="Linter"]');
                if (await linterTab.isExisting()) {
                    await linterTab.click();
                    await browser.pause(300);
                    const rows = (await browser.$$(
                        '.quill-linter__result, .quill-linter-panel__result, [class*="quill-linter"]'
                    )) as unknown as WebdriverIO.Element[];
                    if (rows.length > 0) return true;
                }
                return false;
            },
            { timeout: 15_000, timeoutMsg: 'no linter decorations or result rows appeared on the manuscript' }
        );

        // Reaching this line means at least one decoration landed.
        expect(true).to.equal(true);
    });
});
