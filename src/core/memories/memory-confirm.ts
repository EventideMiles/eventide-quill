import type { App } from 'obsidian';
import { ConfirmModal } from '../../ui/confirm-modal';

/**
 * Show a confirmation modal and resolve to the writer's choice. Wraps
 * {@link ConfirmModal} in a Promise so async tool execution can `await`
 * explicit writer approval before destructive or non-auto operations.
 *
 * Resolves `true` when the writer clicks the primary confirm button.
 * Resolves `false` when the writer cancels (Cancel button, escape key,
 * or click outside the modal).
 *
 * Used by the memory tools:
 *   - `delete_memory` always confirms (deletes are silent + destructive).
 *   - `save_memory` confirms only when `memoriesAutoSave` is off.
 *
 * This is the v1 stand-in for the fuller change-review-card flow: the
 * design called for `delete_memory` to surface as a pending card in the
 * sidebar's review surface (alongside pending lore edits). The card flow
 * requires new plugin state + a new card type + approve/reject UI; this
 * modal gets us the safety property (writer explicitly approves) without
 * that infrastructure, and is tracked as a follow-up in the planning doc.
 */
export function confirmMemoryAction(
    app: App,
    title: string,
    message: string,
    confirmText = 'Confirm'
): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;
        const modal = new ConfirmModal(
            app,
            title,
            message,
            () => {
                resolved = true;
                resolve(true);
            },
            confirmText
        );
        // ConfirmModal doesn't expose an onCancel hook — intercept onClose
        // to resolve false when the writer dismisses without confirming.
        // onClose fires after the confirm path's resolve(true), so the
        // resolved flag prevents a double-resolve.
        const originalOnClose = modal.onClose.bind(modal);
        modal.onClose = () => {
            originalOnClose();
            if (!resolved) resolve(false);
        };
        modal.open();
    });
}
