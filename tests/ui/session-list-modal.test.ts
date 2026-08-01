// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import { SessionListModal } from '../../src/ui/session-list-modal';
import type { SessionIndexEntry } from '../../src/ai/conversation-store';

function makeEntry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
    return {
        id: 's1',
        title: 'My session',
        mode: 'discuss',
        messageCount: 5,
        updatedAt: Date.now(),
        size: 1024,
        ...overrides
    } as SessionIndexEntry;
}

describe('session-list-modal', () => {
    it('shows an empty hint when there are no saved sessions', () => {
        const modal = new SessionListModal(new App(), [], () => {}, async () => {});
        modal.onOpen();
        expect(modal.contentEl.textContent).to.include('No saved conversations');
    });

    it('lists sessions with title, mode label, message count + Open/Delete buttons', () => {
        const modal = new SessionListModal(
            new App(),
            [
                makeEntry({ id: 's1', title: 'Chapter brainstorm' }),
                makeEntry({ id: 's2', title: 'Plot review', mode: 'review-discuss' })
            ],
            () => {},
            async () => {}
        );
        modal.onOpen();

        expect(modal.contentEl.textContent).to.include('Chapter brainstorm');
        expect(modal.contentEl.textContent).to.include('Plot review');
        // modeLabel('review-discuss') → 'Review'.
        expect(modal.contentEl.textContent).to.include('Review');
        // Two Open + two Delete buttons.
        const texts = Array.from(modal.contentEl.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(texts.filter((t) => t === 'Open').length).to.equal(2);
        expect(texts.filter((t) => t === 'Delete').length).to.equal(2);
    });

    it('fires onSelect with the session id when Open is clicked', () => {
        let selected: string | null = null;
        const modal = new SessionListModal(
            new App(),
            [makeEntry({ id: 'sX' })],
            (id) => {
                selected = id;
            },
            async () => {}
        );
        modal.onOpen();

        const openBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Open'
        ) as HTMLButtonElement;
        openBtn.click();
        expect(selected).to.equal('sX');
    });

    it('fires onDelete with the session id when Delete is clicked', () => {
        let deleted: string | null = null;
        const modal = new SessionListModal(
            new App(),
            [makeEntry({ id: 'sDel' })],
            () => {},
            async (id) => {
                deleted = id;
            }
        );
        modal.onOpen();

        const deleteBtn = Array.from(modal.contentEl.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Delete'
        ) as HTMLButtonElement;
        deleteBtn.click();
        expect(deleted).to.equal('sDel');
    });
});
