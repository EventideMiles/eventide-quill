import { App, Modal, Notice } from 'obsidian';
import type { SessionIndexEntry } from '../ai/conversation-store';

/**
 * Lists saved co-writer conversations for the writer to open or delete.
 * Rendered by {@link EventideQuillPlugin.openCoWriterHistory} with entries
 * from {@link listSessions}. Selecting a row closes the modal and hands the id
 * back for {@link restoreCoWriterSession}; deleting removes it via
 * {@link deleteSession} and the row is removed in place.
 */
export class SessionListModal extends Modal {
    private entries: SessionIndexEntry[];
    private readonly onSelect: (id: string) => void;
    private readonly onDelete: (id: string) => Promise<void>;

    constructor(
        app: App,
        entries: SessionIndexEntry[],
        onSelect: (id: string) => void,
        onDelete: (id: string) => Promise<void>
    ) {
        super(app);
        this.entries = entries;
        this.onSelect = onSelect;
        this.onDelete = onDelete;
    }

    onOpen(): void {
        this.titleEl.setText('Conversation history');

        if (this.entries.length === 0) {
            this.contentEl.createEl('p', {
                cls: 'quill-session-list__empty',
                text: 'No saved conversations yet. Starting a new chat or saving a snapshot will keep one here.'
            });
            return;
        }

        const list = this.contentEl.createDiv({ cls: 'quill-session-list' });
        for (const entry of this.entries) {
            const row = list.createDiv({ cls: 'quill-session-list__row' });

            const meta = row.createDiv({ cls: 'quill-session-list__meta' });
            meta.createDiv({ cls: 'quill-session-list__title', text: entry.title });
            const sub = meta.createDiv({ cls: 'quill-session-list__sub' });
            sub.createSpan({ cls: 'quill-session-list__mode', text: entry.mode });
            sub.createSpan({ text: '\u00b7' });
            sub.createSpan({ text: `${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}` });
            sub.createSpan({ text: '\u00b7' });
            sub.createSpan({ cls: 'quill-session-list__time', text: new Date(entry.updatedAt).toLocaleString() });

            const actions = row.createDiv({ cls: 'quill-session-list__actions' });
            const openBtn = actions.createEl('button', { text: 'Open', cls: 'quill-session-list__open' });
            openBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.onSelect(entry.id);
                this.close();
            });
            const delBtn = actions.createEl('button', { text: 'Delete', cls: 'quill-session-list__delete' });
            delBtn.addEventListener('click', (e) => {
                e.preventDefault();
                delBtn.disabled = true;
                void (async () => {
                    try {
                        await this.onDelete(entry.id);
                        row.remove();
                        this.entries = this.entries.filter((en) => en.id !== entry.id);
                        if (this.entries.length === 0) {
                            this.contentEl.empty();
                            this.onOpen();
                        }
                    } catch (err) {
                        console.warn('Quill: failed to delete session', err);
                        new Notice('Could not delete the conversation.');
                    } finally {
                        delBtn.disabled = false;
                    }
                })();
            });
        }
    }
}
