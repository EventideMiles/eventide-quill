import { App, Modal, Setting, SuggestModal } from 'obsidian';
import { TONE_OPTIONS, ToneOption } from '../ai/transform';

/**
 * Modal that prompts the user for a freeform transformation instruction,
 * e.g. "Rewrite this from the antagonist's perspective."
 */
export class TransformModal extends Modal {
    private instruction = '';

    constructor(
        app: App,
        private selectedText: string,
        private onSubmit: (instruction: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Custom transformation' });

        contentEl.createEl('p', {
            text: `Selected ${this.selectedText.split(/\s+/).filter(Boolean).length} words. Enter your instruction below.`,
            cls: 'quill-transform-modal-hint',
        });

        new Setting(contentEl)
            .setName('Instruction')
            .setDesc('Describe how you want the selected passage rewritten.')
            .addTextArea((textarea) => {
                textarea
                    .setPlaceholder('E.g. Rewrite this from the antagonist\'s perspective')
                    .onChange((value) => {
                        this.instruction = value;
                    });
                textarea.inputEl.rows = 4;
                textarea.inputEl.cols = 50;
                textarea.inputEl.addClass('quill-transform-textarea');
            });

        const buttonRow = contentEl.createEl('div', { cls: 'quill-transform-modal-actions' });

        buttonRow.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => this.close());

        const submitBtn = buttonRow.createEl('button', {
            text: 'Transform',
            cls: 'mod-cta',
        });
        submitBtn.addEventListener('click', () => {
            if (!this.instruction.trim()) return;
            this.close();
            this.onSubmit(this.instruction.trim());
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Suggest modal for choosing a tone when using the "Change tone" action.
 */
export class ToneSuggestModal extends SuggestModal<ToneOption> {
    constructor(
        app: App,
        private onChoose: (tone: ToneOption) => void,
    ) {
        super(app);
        this.setPlaceholder('Choose a tone...');
        this.limit = 10;
    }

    getSuggestions(_query: string): ToneOption[] {
        return [...TONE_OPTIONS];
    }

    renderSuggestion(tone: ToneOption, el: HTMLElement): void {
        el.createEl('div', { text: tone });
    }

    onChooseSuggestion(tone: ToneOption): void {
        this.onChoose(tone);
    }
}
