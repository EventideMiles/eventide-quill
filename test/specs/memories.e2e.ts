import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, getMockStats, sseChatBody, sseToolCallBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantDone, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Memories round-trip — the v2.2.0 memory system end-to-end against real
 * Obsidian and the mock provider. Covers the four behaviors the unit suite
 * can't prove in composition:
 *
 *   1. `save_memory` tool call → memory lands in the vault as writer-editable
 *      markdown with a stable `^quill-mem-NNN` block ID (scope = the active
 *      manuscript's top-level folder, so `manuscript/Chapter 01.md` →
 *      `Memories/manuscript.memories.md`).
 *   2. The saved memory is auto-injected into the NEXT co-writer request as
 *      an index (heading + id preview + recall_memory hint).
 *   3. The Lorebook → Memories sub-tab lists the saved memory card.
 *   4. `delete_memory` ALWAYS shows a confirm modal — cancel keeps the
 *      entry, confirm removes it.
 *   5. The raw-edit guard: `edit_note` refuses to touch files under the
 *      memories folder (the model can't bypass save/delete and clobber
 *      block IDs).
 *
 * The test vault ships `memoriesEnabled: true` + `memoriesAutoSave: true`
 * (see data.json.example), so saves land directly without a modal — the
 * delete modal is the only interactive gate exercised here.
 */
describe('Memories (save / inject / delete round-trip)', () => {
    beforeEach(function () {
        if (isMobileEmulation()) return this.skip();
    });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        // Reset the co-writer session so chat state from a prior test doesn't
        // leak in (resetVault restores files, not in-memory session state).
        await browser.execute(() => {
            const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { resetCoWriterChat?: (clearContext: boolean) => void }> } } }).app.plugins.plugins['eventide-quill'];
            plugin?.resetCoWriterChat?.(true);
        });
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    /** Vault path of the active manuscript scope's memory file. */
    const MEMORY_FILE = 'Memories/manuscript.memories.md';

    /** Read a vault file; returns null when it doesn't exist yet. */
    async function readVaultOrNull(path: string): Promise<string | null> {
        return browser.execute(
            async (p) => {
                const app = (window as unknown as { app: { vault: { getFileByPath: (p: string) => unknown; read: (f: unknown) => Promise<string> } } }).app;
                const file = app.vault.getFileByPath(p);
                if (!file) return null;
                return app.vault.read(file);
            },
            path
        );
    }

    /**
     * Drive one discuss turn whose response is a `save_memory` tool call,
     * followed by the tool-result continuation round (a plain text reply).
     * Waits for the turn to finish and returns the send baseline.
     */
    async function saveMemoryViaToolCall(heading: string, content: string): Promise<void> {
        await enqueueMock(
            {
                body: sseToolCallBody([
                    {
                        id: 'call_save_memory',
                        name: 'save_memory',
                        arguments: JSON.stringify({ heading, content, scope: 'auto' })
                    }
                ])
            },
            { body: sseChatBody(['Noted — I will remember that for future sessions.']) }
        );

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        const baseline = await sendCoWriterMessage('Remember this preference for later.');
        await waitForAssistantDone(30_000, baseline);
    }

    it('save_memory persists a memory to the manuscript scope with a block ID', async () => {
        await saveMemoryViaToolCall(
            'Prefers concrete sensory beats',
            'The writer prefers concrete sensory detail over abstract description in harbour scenes.'
        );

        // The memory must land in the manuscript-scope file (top-level folder
        // of the active file), not the global pool.
        const content = await browser.waitUntil(
            async () => {
                const text = await readVaultOrNull(MEMORY_FILE);
                return text !== null ? text : false;
            },
            { timeout: 10_000, timeoutMsg: 'memory file was not created in the manuscript scope' }
        );

        // Writer-editable markdown: a section heading + body + stable block ID.
        expect(content).to.include('Prefers concrete sensory beats');
        expect(content).to.match(/concrete sensory detail/i);
        expect(content).to.match(/\^quill-mem-\d+/);
        // The global pool must NOT have been used for an `auto`-scope save.
        expect(await readVaultOrNull('Memories/_global.memories.md')).to.equal(null);
    });

    it('injects the saved memory index into the next co-writer request', async () => {
        await saveMemoryViaToolCall(
            'Avoid nautical jargon',
            'The writer asked to avoid unexplained nautical jargon in draft prose.'
        );
        // Wait for the file to exist before the next send — the index is
        // built per-send, so the memory must already be on disk.
        await browser.waitUntil(
            async () => (await readVaultOrNull(MEMORY_FILE)) !== null,
            { timeout: 10_000, timeoutMsg: 'memory file never appeared before index-injection send' }
        );

        await enqueueMock({ body: sseChatBody(['Understood — the memory is in context for this reply.']) });
        const secondQuestion = 'What do you remember about my preferences?';
        const baseline = await sendCoWriterMessage(secondQuestion);
        await waitForAssistantDone(30_000, baseline);

        // The panel fires a display-only "options" request AFTER the turn
        // finishes (continuation proposals) — that request has its own prompt
        // and no injected context, and it lands last in the mock log. Assert
        // on the discuss request itself: the last log entry whose body
        // carries the writer's question.
        const stats = await getMockStats();
        const discussReq = [...stats.requests]
            .reverse()
            .find((r) => r.body.includes(secondQuestion));
        expect(discussReq, 'the discuss request must appear in the mock log').to.not.equal(undefined);
        // The discuss request must carry the memory index: the heading, the
        // block-ID handle, and the recall hint.
        expect(discussReq?.url).to.match(/\/v1\/chat\/completions$/);
        expect(discussReq?.body).to.include('Avoid nautical jargon');
        expect(discussReq?.body).to.match(/quill-mem-\d+/);
        expect(discussReq?.body).to.include('recall_memory');
    });

    it('lists the saved memory in the Lorebook Memories sub-tab', async () => {
        await saveMemoryViaToolCall(
            'Slow pacing is intentional',
            'The slow middle chapters are intentional pacing — do not flag them as sagging.'
        );
        await browser.waitUntil(
            async () => (await readVaultOrNull(MEMORY_FILE)) !== null,
            { timeout: 10_000, timeoutMsg: 'memory file never appeared before sub-tab check' }
        );

        // Sidebar: Lorebook top tab → Memories sub-tab. Dismiss any Notice
        // toasts first — the save confirmation (and the one-time first-save
        // advisory, 10s) renders as an overlay at the top of the sidebar and
        // physically intercepts clicks on the tab bar.
        await browser.execute(() => {
            document.querySelectorAll('.notice-message, .notice').forEach((n) => n.remove());
        });
        const lorebookTab = await browser.$('.quill-sidebar__tab[aria-label="Lorebook"]');
        await lorebookTab.waitForDisplayed({ timeout: 10_000 });
        await lorebookTab.click();
        // Click the Memories sub-tab via native DOM. The sidebar re-renders on
        // notices/token ticks, which races WDIO element handles mid-waitUntil;
        // a native click on the freshly-queried node is immune to that.
        const clicked = await browser.waitUntil(
            async () =>
                browser.execute(() => {
                    const buttons = Array.from(document.querySelectorAll('.quill-sidebar__subtab'));
                    const target = buttons.find((b) => /memories/i.test(b.textContent ?? ''));
                    if (!target) return false;
                    (target as HTMLElement).click();
                    return true;
                }),
            { timeout: 5_000, timeoutMsg: 'Memories sub-tab button never appeared' }
        );
        expect(clicked).to.equal(true);

        // The card should render the heading, the block ID, and a body preview.
        const card = await browser.$('.quill-memories-panel__card');
        await card.waitForDisplayed({ timeout: 10_000 });
        const cardText = await card.getText();
        expect(cardText).to.include('Slow pacing is intentional');
        expect(cardText).to.match(/quill-mem-\d+/);
        expect(cardText).to.match(/intentional pacing/i);
    });

    /** Save one memory, then drive a delete_memory tool call for its ID. */
    async function seedMemoryThenRequestDelete(): Promise<void> {
        await saveMemoryViaToolCall(
            'Temporary memory',
            'A placeholder memory whose deletion the writer will be asked to confirm.'
        );
        const fileText = await browser.waitUntil(
            async () => {
                const text = await readVaultOrNull(MEMORY_FILE);
                return text !== null ? text : false;
            },
            { timeout: 10_000, timeoutMsg: 'memory file never appeared before delete' }
        );
        const match = fileText.match(/\^quill-mem-(\d+)/);
        expect(match, 'seeded memory file must carry a block ID').to.not.equal(null);

        // The delete tool call blocks on the confirm modal, so its follow-up
        // response is only consumed AFTER the writer clicks — enqueue both.
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_delete_memory',
                    name: 'delete_memory',
                    arguments: JSON.stringify({ id: `quill-mem-${match![1]}` })
                }
            ])
        });
        await enqueueMock({ body: sseChatBody(['Done — the memory was handled as you asked.']) });

        const baseline = await sendCoWriterMessage('Forget that memory.');
        // Don't await done yet — the caller interacts with the modal first.
        void baseline;
    }

    it('delete_memory confirm modal: cancel keeps the memory', async () => {
        await seedMemoryThenRequestDelete();

        // The confirm modal must appear (deletes always require approval).
        const cancelBtn = await browser.$('.quill-confirm-modal__btn-row button:not(.mod-cta)');
        await cancelBtn.waitForDisplayed({ timeout: 15_000 });

        // Wait for the turn to be in flight before cancelling — otherwise a
        // fast cancel can land before the tool call reaches the modal.
        await browser.pause(1000);
        await cancelBtn.click();

        // Let the tool-result continuation round finish.
        await browser.waitUntil(
            async () => {
                const streaming = (await browser.$$('.quill-cowriter-panel__chat-bubble--streaming')) as unknown as WebdriverIO.Element[];
                return streaming.length === 0;
            },
            { timeout: 30_000, timeoutMsg: 'assistant turn never finished after cancel' }
        );

        const text = await readVaultOrNull(MEMORY_FILE);
        expect(text).to.not.equal(null);
        expect(text).to.include('Temporary memory');
    });

    it('delete_memory confirm modal: confirm removes the memory', async () => {
        await seedMemoryThenRequestDelete();

        const deleteBtn = await browser.$('.quill-confirm-modal__btn-row button.mod-cta');
        await deleteBtn.waitForDisplayed({ timeout: 15_000 });
        await browser.pause(1000);
        await deleteBtn.click();

        await browser.waitUntil(
            async () => {
                const streaming = (await browser.$$('.quill-cowriter-panel__chat-bubble--streaming')) as unknown as WebdriverIO.Element[];
                return streaming.length === 0;
            },
            { timeout: 30_000, timeoutMsg: 'assistant turn never finished after confirm' }
        );

        // The entry (heading + block ID) must be gone from the file. The file
        // itself may remain (title/intro preserved) or be trimmed to empty —
        // assert on the section, not the file's existence.
        await browser.waitUntil(
            async () => {
                const text = await readVaultOrNull(MEMORY_FILE);
                return text === null || !text.includes('Temporary memory');
            },
            { timeout: 10_000, timeoutMsg: 'memory entry was not removed from the file after confirm' }
        );
    });

    it('raw-edit guard: edit_note refuses to modify the memories file', async () => {
        await saveMemoryViaToolCall(
            'Guarded memory',
            'This memory must survive an edit_note attempt on the raw file.'
        );
        const before = await browser.waitUntil(
            async () => {
                const text = await readVaultOrNull(MEMORY_FILE);
                return text !== null ? text : false;
            },
            { timeout: 10_000, timeoutMsg: 'memory file never appeared before raw-edit attempt' }
        );

        // Attempt to edit the raw memories file via the generic editing tool.
        // The guard must refuse BEFORE the confirm-modal / write path.
        await enqueueMock(
            {
                body: sseToolCallBody([
                    {
                        id: 'call_edit_note',
                        name: 'edit_note',
                        arguments: JSON.stringify({
                            path: MEMORY_FILE,
                            old_text: 'Guarded memory',
                            new_text: 'Tampered heading'
                        })
                    }
                ])
            },
            { body: sseChatBody(['I could not edit that file directly.']) }
        );
        const baseline = await sendCoWriterMessage('Edit the memories file directly.');
        await waitForAssistantDone(30_000, baseline);

        // The file content must be byte-identical to before the attempt.
        const after = await readVaultOrNull(MEMORY_FILE);
        expect(after).to.equal(before);
    });
});
