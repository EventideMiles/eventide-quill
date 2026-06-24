import { App, Component, MarkdownRenderer } from 'obsidian';
import { normalizeParagraphBreaks } from './chat-panel';
import type { ProposedEdit } from '../core/change-set';

/** Handlers invoked when the user approves/rejects an edit from a change card. */
export interface ChangeCardHandlers {
    onApprove?: (id: number) => void;
    onReject?: (id: number) => void;
}

/** Render a bulk action bar (Approve all / Reject all) when there are pending edits. */
export function renderChangeBulkBar(
    container: HTMLElement,
    pendingCount: number,
    events: Component,
    handlers: { onApproveAll?: () => void; onRejectAll?: () => void }
): void {
    if (pendingCount <= 0) return;
    const bulk = container.createEl('div', { cls: 'quill-change-bulk' });
    const approveAllBtn = bulk.createEl('button', {
        cls: 'quill-change-bulk__btn mod-cta',
        text: `Approve all (${pendingCount})`
    });
    events.registerDomEvent(approveAllBtn, 'click', () => handlers.onApproveAll?.());
    bulk.createEl('span', { text: ' ' });
    const rejectAllBtn = bulk.createEl('button', {
        cls: 'quill-change-bulk__btn',
        text: 'Reject all'
    });
    events.registerDomEvent(rejectAllBtn, 'click', () => handlers.onRejectAll?.());
}

/**
 * Render a single proposed-edit review card into `container`.
 *
 * @param oldText  The text being replaced (rendered in the red "removed" block).
 *   Pass null for a pure insertion (no red block).
 */
export function renderChangeCard(
    container: HTMLElement,
    edit: ProposedEdit,
    oldText: string | null,
    app: App,
    events: Component,
    handlers: ChangeCardHandlers
): Promise<void> | undefined {
    const card = container.createEl('div', {
        cls: `quill-change-card quill-change-card--${edit.state}`
    });
    if (edit.label) {
        card.createEl('div', { cls: 'quill-change-card__label', text: edit.label });
    }

    // Removed (red) — only when there is old text to show.
    if (oldText && oldText.length > 0) {
        const removed = card.createEl('div', { cls: 'quill-change-card__removed' });
        removed.setText(oldText);
    }

    // Added (green)
    let renderPromise: Promise<void> | undefined;
    if (edit.newText.length > 0) {
        const added = card.createEl('div', { cls: 'quill-change-card__added' });
        renderPromise = MarkdownRenderer.render(app, normalizeParagraphBreaks(edit.newText), added, '', events);
    }

    const statusText =
        edit.state === 'approved'
            ? 'Approved \u2014 change applied'
            : edit.state === 'rejected'
              ? 'Rejected \u2014 no change'
              : edit.state === 'generating'
                ? 'Generating\u2026'
                : '';
    if (statusText) {
        card.createEl('div', { cls: 'quill-change-card__status', text: statusText });
    }

    if (edit.state === 'pending') {
        const btns = card.createEl('div', { cls: 'quill-change-card__btns' });
        const approveBtn = btns.createEl('button', {
            cls: 'quill-change-card__btn mod-cta',
            text: 'Approve'
        });
        events.registerDomEvent(approveBtn, 'click', () => handlers.onApprove?.(edit.id));
        btns.createEl('span', { text: ' ' });
        const rejectBtn = btns.createEl('button', {
            cls: 'quill-change-card__btn',
            text: 'Reject'
        });
        events.registerDomEvent(rejectBtn, 'click', () => handlers.onReject?.(edit.id));
    }

    return renderPromise;
}
