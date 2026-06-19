import { App, Modal } from 'obsidian';

/**
 * Simple modal that prompts for a filename and calls back with the path.
 *
 * Used by sidebar panels that export conversations or reports to a markdown file.
 * Caller picks the title (e.g. "Save conversation", "Save analysis report").
 */
export class FilenameModal extends Modal {
    private onChoose: (path: string) => void | Promise<void>;
    private defaultName: string;
    private title: string;

    constructor(
        app: App,
        defaultName: string,
        onChoose: (path: string) => void | Promise<void>,
        title: string = 'Save conversation'
    ) {
        super(app);
        this.defaultName = defaultName;
        this.onChoose = onChoose;
        this.title = title;
    }

    onOpen(): void {
        this.titleEl.setText(this.title);
        const content = this.contentEl.createDiv();
        content.createEl('label', { text: 'File path:', cls: 'quill-save-modal__label' });
        const input = content.createEl('input', {
            type: 'text',
            cls: 'quill-save-modal__input',
            value: this.defaultName
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void this.onChoose(input.value.trim() || this.defaultName);
                this.close();
            }
        });
        const btnRow = content.createDiv({ cls: 'quill-save-modal__btn-row' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
        const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            void this.onChoose(input.value.trim() || this.defaultName);
            this.close();
        });
        input.focus();
        input.select();
    }
}
