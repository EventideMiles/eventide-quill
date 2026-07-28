import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, writeVaultFile } from '../helpers/obsidian-helpers.js';

/**
 * CodeMirror decorations — the linter's gutter markers and the inline diff
 * decorations applied by `change-diff-extension.ts` when an AI-proposed edit
 * targets the active editor.
 *
 * The test manuscript is deliberately clunky (every linter rule fires on
 * purpose — see `manuscript/Chapter 01.md`), so simply opening it should
 * populate the lint gutter. The inline-diff path requires a pending edit on
 * the active file, which we stage by writing a fake pending edit onto the
 * plugin's session state.
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
        // The linter debounces (~300ms); wait for at least one gutter marker.
        await browser.waitUntil(
            async () => {
                const markers = (await browser.$$(
                    '.cm-linter-marker, .quill-lint-marker, [class*="quill-lint"]'
                )) as unknown as WebdriverIO.Element[];
                return markers.length > 0;
            },
            { timeout: 10_000, timeoutMsg: 'no linter decorations appeared on the manuscript' }
        );
        // Also check the linter panel populated — it shares state.
        await browser.executeObsidianCommand('eventide-quill:quill-dashboard-open');
        // The linter tab is reached by clicking it (there's no command for it).
        const linterTab = await browser.$('.quill-sidebar__tab[title="Linter"]');
        if (await linterTab.isExisting()) {
            await linterTab.click();
            const results = await browser.$('.quill-linter__results, .quill-linter-panel__results, [class*="quill-linter"]');
            // Don't fail if the panel structure has shifted — the gutter
            // assertion above is the load-bearing one. This is a softer check.
            if (await results.isExisting()) {
                expect(await results.getText()).to.have.length.greaterThan(0);
            }
        }
    });

    it('renders inline-diff decorations when a pending edit targets the active file', async () => {
        // The active document is the manuscript. Stage a pending edit on the
        // co-writer session so change-diff-extension paints it inline.
        await openFile('manuscript/Chapter 01.md');
        await browser.pause(500);

        // Use the plugin's ChangeSet API to push a synthetic pending edit. The
        // extension listens to ChangeSet events and re-decorates on change.
        // We target a sentence we know exists in Chapter 01.
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            if (!plugin) throw new Error('plugin not found');
            // The co-writer session's `directChanges` ChangeSet is the one that
            // drives inline diffs on the active manuscript. `add` accepts an
            // Edit shape; see src/core/change-set.ts.
            const session = plugin.coWriterSession;
            if (!session) throw new Error('co-writer session not initialised');
            session.directChanges.add({
                label: 'manuscript/Chapter 01.md',
                filePath: 'manuscript/Chapter 01.md',
                oldText: 'The ship was carried into the harbour',
                newText: 'The ship drifted into the harbour',
                owner: 'discuss'
            });
            // The extension re-decorates on a debounce; force the editor to
            // re-scan by dispatching a no-op transaction via the plugin API.
            if (typeof plugin.refreshChangeDecorations === 'function') {
                void plugin.refreshChangeDecorations();
            }
        });

        // Look for inline-diff decorations. The classes are applied by
        // change-diff-extension.ts via the decoration system; the exact class
        // list lives in styles/_change-review.scss. We assert on a substring
        // so renames don't break the spec.
        await browser.waitUntil(
            async () => {
                const diffs = (await browser.$$(
                    '[class*="quill-change-diff"], [class*="quill-inline-diff"], .cm-quillDiff'
                )) as unknown as WebdriverIO.Element[];
                return diffs.length > 0;
            },
            { timeout: 10_000, timeoutMsg: 'inline-diff decorations never appeared' }
        );
        const decorations = (await browser.$$(
            '[class*="quill-change-diff"], [class*="quill-inline-diff"], .cm-quillDiff'
        )) as unknown as WebdriverIO.Element[];
        expect(decorations.length).to.be.greaterThan(0);
    });
});
