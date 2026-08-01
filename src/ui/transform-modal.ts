import { App, Modal, Setting, SuggestModal } from 'obsidian';
import { TONE_OPTIONS, ToneOption } from '../ai/transform';

/**
 * Modal that prompts the user for a freeform transformation instruction,
 * e.g. "Rewrite this from the antagonist's perspective."
 */
export class TransformModal extends Modal {
    private instruction = '';

    /** Create the modal with the selected text and a callback for the submitted instruction. */
    constructor(
        app: App,
        private selectedText: string,
        private onSubmit: (instruction: string) => void
    ) {
        super(app);
    }

    /** Render the instruction textarea and the Cancel / Transform buttons. */
    onOpen(): void {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Custom transformation' });

        contentEl.createEl('p', {
            text: `Selected ${this.selectedText.split(/\s+/).filter(Boolean).length} words. Enter your instruction below.`,
            cls: 'quill-transform-modal-hint'
        });

        new Setting(contentEl)
            .setName('Instruction')
            .setDesc('Describe how you want the selected passage rewritten.')
            .addTextArea((textarea) => {
                textarea.setPlaceholder("E.g. Rewrite this from the antagonist's perspective").onChange((value) => {
                    this.instruction = value;
                });
                textarea.inputEl.rows = 4;
                textarea.inputEl.cols = 50;
                textarea.inputEl.addClass('quill-transform-textarea');
            });

        const buttonRow = contentEl.createDiv({ cls: 'quill-transform-modal-actions' });

        buttonRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

        const submitBtn = buttonRow.createEl('button', {
            text: 'Transform',
            cls: 'mod-cta'
        });
        submitBtn.addEventListener('click', () => {
            if (!this.instruction.trim()) return;
            this.close();
            this.onSubmit(this.instruction.trim());
        });
    }

    /** Clear the modal content on close. */
    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Suggest modal for choosing a tone when using the "Change tone" action.
 */
export class ToneSuggestModal extends SuggestModal<ToneOption> {
    /** Create the tone picker with a callback for the chosen tone. */
    constructor(
        app: App,
        private onChoose: (tone: ToneOption) => void
    ) {
        super(app);
        this.setPlaceholder('Choose a tone...');
        this.limit = 10;
    }

    /** Tone options whose name contains the query. */
    getSuggestions(query: string): ToneOption[] {
        const q = query.toLowerCase();
        return TONE_OPTIONS.filter((t) => t.toLowerCase().includes(q));
    }

    /** Render one row with the tone name. */
    renderSuggestion(tone: ToneOption, el: HTMLElement): void {
        el.createDiv({ text: tone });
    }

    /** Hand the chosen tone to the callback. */
    onChooseSuggestion(tone: ToneOption): void {
        this.onChoose(tone);
    }
}
