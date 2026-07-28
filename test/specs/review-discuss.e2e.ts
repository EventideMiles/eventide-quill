import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, getMockStats, sseChatBody, sseToolCallBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, openQuillSidebar } from '../helpers/obsidian-helpers.js';

/**
 * Review-tab discussion (the v1.4.0 review-discuss mode). After a report
 * streams in, the writer can click "Discuss" and the embedded co-writer panel
 * mounts into the Review tab with editing tools enabled. See
 * `'review-discuss'` mode in AGENTS.md.
 *
 * These specs cover the three behaviours most likely to regress:
 *   1. A queued + completed report renders and offers the Discuss action.
 *   2. Clicking Discuss mounts an embedded co-writer panel that talks to the
 *      mock server.
 *   3. A round-trip that returns a tool call surfaces an inline-diff review
 *      card in the chat flow (the writer still has to approve before it lands
 *      in the vault).
 */
describe('Review-tab discussion (review-discuss)', () => {
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    it('streams a beta-reader review and renders it in the Results sub-tab', async () => {
        // The beta-reader persona uses stream:true chat completions. Enqueue a
        // short, recognisable body so the assertion is unambiguous.
        await enqueueMock({ body: sseChatBody(['A solid opening chapter.', 'The pacing feels steady.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        // Click the "Editorial" engine button if present, then the run button.
        // Selectors are defensive: the Review panel rebuilds frequently.
        const editorialBtn = await browser.$('.quill-review-panel__scope-btn');
        if (await editorialBtn.isExisting()) {
            try {
                await editorialBtn.click();
            } catch {
                // The button may have re-rendered between the existence check and
                // the click; safe to ignore since we just need to be on a scope.
            }
        }
        const submit = await browser.$('.quill-review-panel__submit, .quill-review-panel__run, button[class*="quill-review-panel__submit"]');
        if (await submit.isExisting()) {
            await submit.click();
        }

        // The mock response should land in the request log.
        await browser.waitUntil(
            async () => {
                const s = await getMockStats();
                return s.requests.some((r) => r.url.includes('/v1/chat/completions'));
            },
            { timeout: 15_000, timeoutMsg: 'mock server never saw the review chat-completions call' }
        );
        // And the report text should appear in the panel.
        const report = await browser.$('.quill-review-panel__report, .quill-review-panel__report-rendered');
        await report.waitForDisplayed({ timeout: 20_000, reverse: false });
        const reportText = await report.getText();
        expect(reportText).to.match(/solid opening chapter|pacing feels steady/);
    });

    it('mounts the embedded co-writer panel after the report completes', async () => {
        // Drive the panel into the discuss state via the plugin's session API.
        // This skips the report-streaming step (covered above) and exercises
        // only the mount hand-off — proving the embedded panel renders.
        await enqueueMock({ body: sseChatBody(['First discussion reply.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        // Begin review-discuss directly via the session hook the "Discuss"
        // button normally triggers. (See main.ts beginReviewDiscuss.)
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            if (plugin?.beginReviewDiscuss) {
                void plugin.beginReviewDiscuss('editorial', 'Test seed report — discuss mode.');
            }
        });
        // The embedded co-writer panel mounts into .quill-review-panel__discuss-mount.
        const mount = await browser.$('.quill-review-panel__discuss-mount');
        await mount.waitForDisplayed({ timeout: 10_000 });
        const cowriterInput = await browser.$('.quill-cowriter-panel__input');
        expect(await cowriterInput.isDisplayed()).to.equal(true);
    });

    it('renders an inline-diff card when the discuss round returns an editing tool call', async () => {
        // First round: a tool_call for `edit_note` (the editing tool path that
        // flows through `plugin.coWriterSession.loreEdits` regardless of mode).
        // We target a lore entry (Magda Vos) so the edit has a real anchor.
        await openFile('lore/characters/Magda Vos.md');
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_edit_1',
                    name: 'edit_note',
                    arguments: JSON.stringify({
                        path: 'lore/characters/Magda Vos.md',
                        old_text: 'Once a professor at the university',
                        new_text: 'Once a professor at the southern university'
                    })
                }
            ])
        });

        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            if (plugin?.beginReviewDiscuss) {
                void plugin.beginReviewDiscuss('editorial', 'Tighten the scholar paragraph.');
            }
        });

        const input = await browser.$('.quill-cowriter-panel__input');
        await input.waitForDisplayed({ timeout: 10_000 });
        await sendCoWriterMessage('Tighten the paragraph about her background.');

        // Wait for the inline-diff change card to render. The tool-call round
        // is async (request → mock → tool exec → render), so allow ~15s.
        const changeCard = await browser.$('.quill-change-card');
        await changeCard.waitForDisplayed({ timeout: 20_000 });
        const cardText = await changeCard.getText();
        // The card surfaces both halves of the diff. The "background" line is
        // a sentinel that's robust to formatting.
        expect(cardText).to.match(/background|professor/i);

        // Verify the edit did NOT auto-apply — the writer must approve first.
        const vaultText = await readVaultInline('lore/characters/Magda Vos.md');
        expect(vaultText).to.include('Once a professor at the university');
        expect(vaultText).to.not.include('Once a professor at the southern university');
    });
});

/** Inline read helper — kept local to avoid scope creep in obsidian-helpers. */
async function readVaultInline(path: string): Promise<string> {
    return browser.execute(
        async (p) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as unknown as { app: any }).app;
            const file = app.vault.getAbstractFileByPath(p);
            if (!file) throw new Error(`vault file not found: ${p}`);
            return app.vault.read(file);
        },
        path
    );
}
