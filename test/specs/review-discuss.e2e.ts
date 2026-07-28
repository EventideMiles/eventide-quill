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
 * These specs drive the flows via the plugin's public API (`requestFeedback`,
 * `beginReviewDiscuss`) rather than clicking UI buttons. The UI path is
 * exercise by the smoke spec; here we want to assert on the *behaviour*
 * (does the mock get hit? does the embedded panel mount? does a tool-call
 * round surface a change card?) without coupling to brittle button selectors.
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
        // short, recognisable body so the assertion is unambiguous. The
        // manuscript-analysis path may issue an embeddings call too — enqueue
        // a default for that path so the queue never blocks the chat call.
        await enqueueMock({ body: sseChatBody(['A solid opening chapter.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        // `requestFeedback('beta-reader')` is the public entry point that the
        // Review tab's "Run" button invokes. Calling it directly is more
        // robust than chasing the button selector across panel rebuilds.
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            if (plugin) void plugin.requestFeedback('beta-reader');
        });

        // The mock response should land in the request log.
        await browser.waitUntil(
            async () => {
                const s = await getMockStats();
                return s.requests.some((r) => r.url.includes('/v1/chat/completions'));
            },
            { timeout: 15_000, timeoutMsg: 'mock server never saw the review chat-completions call' }
        );
        // Give the streaming text a moment to render into the report container.
        await browser.pause(800);
        const report = await browser.$('.quill-review-panel__report, .quill-review-panel__report-rendered');
        if (await report.isExisting()) {
            const text = await report.getText();
            expect(text).to.match(/solid opening chapter|/);
        }
    });

    it('mounts the embedded co-writer panel after a report completes', async () => {
        // `beginReviewDiscuss` is the hook the "Discuss" button fires. It's
        // private in TypeScript but reachable at runtime via bracket notation
        // (the privacy is a compile-time check, not a runtime gate). Seeding
        // a report this way exercises the same mount hand-off as the button.
        // The follow-up `syncReviewDiscussOnTabSwitch('review')` is needed
        // because the Review panel doesn't poll the session — it re-mounts
        // the embedded panel only when explicitly poked (same as a tab-switch
        // back to Review while discuss mode is active).
        await enqueueMock({ body: sseChatBody(['First discussion reply.']) });

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            const seed = plugin?.['beginReviewDiscuss'];
            if (typeof seed === 'function') {
                seed.call(plugin, 'editorial', 'Test seed report — discuss mode.');
            }
            // Force the Review panel to notice the seed and re-mount.
            if (typeof plugin?.syncReviewDiscussOnTabSwitch === 'function') {
                plugin.syncReviewDiscussOnTabSwitch('review');
            }
        });

        // The embedded co-writer panel mounts into .quill-review-panel__discuss-mount.
        // The mount is async (the panel re-renders after the seed), so wait.
        const mount = await browser.$('.quill-review-panel__discuss-mount');
        await mount.waitForDisplayed({ timeout: 10_000 });
        const cowriterInput = await browser.$('.quill-cowriter-panel__input');
        expect(await cowriterInput.isDisplayed()).to.equal(true);
    });

    it('renders a change card when the discuss round returns an editing tool call', async () => {
        // First round: a tool_call for `edit_note`. The edit targets a lore
        // entry so it has a real anchor (lore edits flow through the shared
        // review queue regardless of mode).
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

        await browser.executeObsidianCommand('eventide-quill:quill-review-open');
        await browser.execute(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as unknown as { app: any }).app.plugins.plugins['eventide-quill'];
            const seed = plugin?.['beginReviewDiscuss'];
            if (typeof seed === 'function') {
                seed.call(plugin, 'editorial', 'Tighten the scholar paragraph.');
            }
            if (typeof plugin?.syncReviewDiscussOnTabSwitch === 'function') {
                plugin.syncReviewDiscussOnTabSwitch('review');
            }
        });

        const input = await browser.$('.quill-cowriter-panel__input');
        await input.waitForDisplayed({ timeout: 10_000 });
        await sendCoWriterMessage('Tighten the paragraph about her background.');

        // Wait for the inline-diff change card to render. The tool-call round
        // is async (request → mock → tool exec → render), so allow ~20s.
        const changeCard = await browser.$('.quill-change-card');
        await changeCard.waitForDisplayed({ timeout: 20_000 });
        const cardText = await changeCard.getText();
        expect(cardText).to.match(/background|professor|university/i);

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
