import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseChatBody } from '../helpers/mock-server.js';
import { openFile, openQuillSidebar } from '../helpers/obsidian-helpers.js';
import { isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Async feedback queue — submit a review (editorial / beta-reader persona)
 * to run unattended instead of streaming interactively. The job transitions
 * through queued → running → succeeded, and the completed report auto-saves
 * to the vault under `feedbackReportFolder`. See "Async feedback queue" in
 * AGENTS.md.
 *
 * Timing: the scheduler ticks every 5s (`runNextQueuedFeedbackJob` via
 * `registerInterval`), so after submit the job waits up to ~5s for the next
 * tick. The mock response is instant, so the full submit→run→archive flow
 * takes ~6-8s wall-clock.
 */
describe('Feedback queue', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    /** List files under a vault folder prefix; returns path list. */
    async function listVaultFilesUnder(prefix: string): Promise<string[]> {
        return browser.execute(
            async (p) => {
                const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }> } } }).app;
                return app.vault.getMarkdownFiles()
                    .map((f) => f.path)
                    .filter((path) => path.startsWith(p));
            },
            prefix
        );
    }

    it('submits, runs, and archives a beta-reader report to the vault', async () => {
        // Enqueue a mock response for the feedback's chat-completions call.
        // The feedback flow streams the report; a short recognisable body
        // makes the archive-content assertion unambiguous.
        await enqueueMock({ body: sseChatBody(['QUEUE_TEST_MARKER: the opening chapter is solid.']) });

        // Submit via the plugin's public API (same path the Review tab's
        // "Queue" button triggers).
        await browser.execute(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const plugin = (window as any).app.plugins.plugins['eventide-quill'];
            await plugin.submitFeedbackJob('beta-reader');
        });

        // Wait for the report to land in the vault. The scheduler ticks at
        // 5s, the mock response is instant, and the archive write is async —
        // so allow up to 30s total. The report folder is `eventide-quill-reports`
        // (from DEFAULT_SETTINGS.feedbackReportFolder).
        const reportFiles = await browser.waitUntil(
            async () => {
                const files = await listVaultFilesUnder('eventide-quill-reports/');
                return files.length > 0 ? files : false;
            },
            { timeout: 30_000, timeoutMsg: 'feedback report was never archived to the vault' }
        );

        expect(reportFiles.length).to.be.greaterThan(0);
        // The filename includes a timestamp + persona label — just assert the
        // folder + extension are right.
        expect(reportFiles[0]).to.match(/^eventide-quill-reports\/.+\.md$/);

        // Verify the archived report contains the mock's streamed text.
        const content = await browser.execute(async (path: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const app = (window as any).app;
            const file = app.vault.getFileByPath(path);
            if (!file) return null;
            return app.vault.read(file);
        }, reportFiles[0]!);
        expect(content).to.include('QUEUE_TEST_MARKER');
    });
});
