import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { enqueueMock, clearMocks, sseToolCallBody } from '../helpers/mock-server.js';
import { openFile, sendCoWriterMessage, waitForAssistantDone, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/**
 * Lorebook coach + `propose_entry` — the coach mode drafts lore entries from
 * the manuscript. When the model calls `propose_entry`, the draft surfaces as
 * a `.quill-lore-draft-card` review card in the chat flow. The writer must
 * approve before it lands in the vault.
 *
 * This is a DISTINCT code path from the `edit_note` flow covered in
 * `review-discuss.e2e.ts`: `propose_entry` drafts flow through
 * `coWriterSession.currentLoreDraft` (not the `loreEdits` ChangeSet), and the
 * review UI is rendered by `lore-entry-review.ts` (not `change-card.ts`).
 */
describe('Lorebook coach (propose_entry)', () => {
    beforeEach(function () { if (isMobileEmulation()) return this.skip(); });
    beforeEach(async () => {
        await clearMocks();
        await obsidianPage.resetVault();
        // Reset the co-writer session so lore-draft cards from a prior test
        // don't persist into this one (resetVault only restores files, not
        // in-memory chat state).
        await browser.execute(() => {
            const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, { resetCoWriterChat?: (clearContext: boolean) => void }> } } }).app.plugins.plugins['eventide-quill'];
            plugin?.resetCoWriterChat?.(true);
        });
        await openFile('manuscript/Chapter 01.md');
        await openQuillSidebar();
    });

    /** Switch the co-writer panel to lorebook mode via the mode picker. */
    async function switchToLorebookMode(): Promise<void> {
        const modeBtn = await browser.$('.quill-cowriter-panel__mode-btn');
        await modeBtn.waitForDisplayed({ timeout: 10_000 });
        await modeBtn.click();
        await browser.waitUntil(
            async () => {
                const rows = (await browser.$$('.quill-cowriter-panel__mode-row')) as unknown as WebdriverIO.Element[];
                for (const row of rows) {
                    const txt = await row.getText();
                    if (/lorebook/i.test(txt)) {
                        await row.click();
                        return true;
                    }
                }
                return false;
            },
            { timeout: 5_000, timeoutMsg: 'Lorebook mode row never appeared' }
        );
    }

    /** Read a vault file's contents; returns null if the file doesn't exist. */
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

    it('renders a lore draft card when the model calls propose_entry', async () => {
        // Enqueue a tool_call for propose_entry with a new character draft.
        // Use a name that doesn't exist in the test vault so the draft isn't
        // redirected to an edit (the prefer-edit-over-create path).
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_propose_1',
                    name: 'propose_entry',
                    arguments: JSON.stringify({
                        name: 'The Harbourmaster',
                        entry_type: 'character',
                        content: '## Background\n\nThe Harbourmaster watches every ship that enters Saltmere.\n\n## Notes\n\nQuiet, watchful, and far more dangerous than he appears.'
                    })
                }
            ])
        });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await switchToLorebookMode();
        const baseline = await sendCoWriterMessage('Create a lore entry for the Harbourmaster.');
        await waitForAssistantDone(30_000, baseline);

        // The draft card should render inline in the chat flow, anchored to
        // the assistant turn that spawned it.
        const card = await browser.$('.quill-lore-draft-card');
        await card.waitForDisplayed({ timeout: 15_000 });
        const cardText = await card.getText();
        // The card surfaces the entry name + preview of the content.
        expect(cardText).to.match(/Harbourmaster/i);
        expect(cardText).to.match(/Background|watches every ship/i);

        // Verify the entry did NOT auto-save — the writer must approve first.
        // A note for "The Harbourmaster" should not exist anywhere in the vault.
        const vaultText = await readVaultOrNull('lore/characters/The Harbourmaster.md');
        expect(vaultText).to.equal(null);
    });

    it('saves the draft to the vault on writer approval', async () => {
        // Same setup as above — enqueue the propose_entry call.
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_propose_2',
                    name: 'propose_entry',
                    arguments: JSON.stringify({
                        name: 'The Cartographer',
                        entry_type: 'character',
                        content: 'A quiet figure who maps the city by night.'
                    })
                }
            ])
        });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await switchToLorebookMode();
        const baseline = await sendCoWriterMessage('Draft an entry for the Cartographer.');
        await waitForAssistantDone(30_000, baseline);

        // Wait for the draft card and click the Save button.
        const card = await browser.$('.quill-lore-draft-card');
        await card.waitForDisplayed({ timeout: 15_000 });
        const saveBtn = await card.$('.quill-lore-draft-card__save');
        await saveBtn.waitForDisplayed({ timeout: 5_000 });
        await saveBtn.click();

        // After Save, the note should land in the vault (the lorebook folder
        // for characters is `lore/characters/`). The save is async — poll
        // until the file appears and capture its content in the same pass,
        // so there's no second read.
        const content = await browser.waitUntil(
            async () => {
                const text = await readVaultOrNull('lore/characters/The Cartographer.md');
                return text !== null ? text : false;
            },
            { timeout: 10_000, timeoutMsg: 'draft was not saved to the vault on approval' }
        );

        // Verify the content + frontmatter. The plugin adds the `quill-type`
        // frontmatter on save; the body is the draft content (the name
        // becomes the filename, not part of the body).
        expect(content).to.match(/quill-type:\s*character/);
        expect(content).to.match(/quiet figure.*maps the city/i);
    });

    it('discards the draft without writing to the vault on writer reject', async () => {
        await enqueueMock({
            body: sseToolCallBody([
                {
                    id: 'call_propose_3',
                    name: 'propose_entry',
                    arguments: JSON.stringify({
                        name: 'The Beggar King',
                        entry_type: 'character',
                        content: 'A mysterious figure who whispers names in the harbour.'
                    })
                }
            ])
        });

        await browser.executeObsidianCommand('eventide-quill:quill-cowriter-open');
        await switchToLorebookMode();
        const baseline = await sendCoWriterMessage('Draft the Beggar King.');
        await waitForAssistantDone(30_000, baseline);

        const card = await browser.$('.quill-lore-draft-card');
        await card.waitForDisplayed({ timeout: 15_000 });
        const discardBtn = await card.$('.quill-lore-draft-card__discard');
        await discardBtn.waitForDisplayed({ timeout: 5_000 });
        await discardBtn.click();

        // Wait a moment for the discard to process, then verify no file was
        // created.
        await browser.pause(1000);
        const vaultText = await readVaultOrNull('lore/characters/The Beggar King.md');
        expect(vaultText).to.equal(null);
    });
});
