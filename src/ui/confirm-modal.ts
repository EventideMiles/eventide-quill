import { App, Modal } from 'obsidian';

/** A secondary action rendered as an additional button alongside the primary confirm. */
export interface SecondaryAction {
    text: string;
    handler: () => void | Promise<void>;
}

/**
 * A reusable confirmation modal with Cancel, an optional secondary action,
 * and a primary confirm button.
 */
export class ConfirmModal extends Modal {
    private readonly confirmText: string;
    private readonly message: string;
    private readonly onConfirm: () => void | Promise<void>;
    private readonly secondaryAction: SecondaryAction | null;

    /**
     * Create a confirmation modal.
     *
     * @param app            The Obsidian app instance.
     * @param title          The modal title.
     * @param message        The confirmation message to display.
     * @param onConfirm      Callback invoked when the primary button is pressed.
     * @param confirmText    Label for the primary button (default: "Confirm").
     * @param secondaryAction Optional second action button rendered before the primary.
     */
    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: () => void | Promise<void>,
        confirmText = 'Confirm',
        secondaryAction: SecondaryAction | null = null
    ) {
        super(app);
        this.titleEl.setText(title);
        this.message = message;
        this.onConfirm = onConfirm;
        this.confirmText = confirmText;
        this.secondaryAction = secondaryAction;
    }

    onOpen(): void {
        const content = this.contentEl.createDiv();
        content.createEl('p', { text: this.message });

        const btnRow = content.createDiv({ cls: 'quill-confirm-btn-row' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        if (this.secondaryAction) {
            const secondaryBtn = btnRow.createEl('button', { text: this.secondaryAction.text });
            secondaryBtn.addEventListener('click', () => {
                Promise.resolve(this.secondaryAction!.handler())
                    .then(() => this.close())
                    .catch((err: unknown) => {
                        console.error('Quill: Secondary action failed.', err);
                    });
            });
        }

        const confirmBtn = btnRow.createEl('button', { text: this.confirmText, cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            Promise.resolve(this.onConfirm())
                .then(() => this.close())
                .catch((err: unknown) => {
                    console.error('Quill: Confirm action failed.', err);
                });
        });
    }
}
