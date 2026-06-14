import { App, Modal, Notice } from 'obsidian';
import { LintResult, RULE_INFO } from '../core/linter/types';
import { suggestLintFix } from '../ai/linter-ai';
import type EventideQuillPlugin from '../main';

/**
 * Callback invoked when the user accepts an AI-suggested fix.
 * Receives the replacement text to insert at the flagged position.
 */
export type AiFixAcceptHandler = (replacement: string) => void;

/** Internal state tracking for the modal. */
type ModalView = 'loading' | 'default-result' | 'custom-input';

/**
 * A modal that shows a diff preview of an AI-suggested lint fix.
 *
 * Two modes:
 * - Default: AI automatically suggests the best fix for the rule type.
 * - Custom: User types freeform instructions, then gets an AI suggestion.
 *
 * Both modes show a before/after diff with Accept/Reject buttons.
 */
export class FixWithAiModal extends Modal {
    private plugin: EventideQuillPlugin;
    private result: LintResult;
    private editorText: string;
    private onAccept: AiFixAcceptHandler;
    private viewState: ModalView = 'loading';
    private suggestion: string | null = null;
    private customInstruction = '';
    private currentAbort: AbortController | null = null;

    /** The line text containing the flagged span, used for the diff display. */
    private lineText: string;

    constructor(
        app: App,
        plugin: EventideQuillPlugin,
        result: LintResult,
        editorText: string,
        onAccept: AiFixAcceptHandler,
        initialCustom?: string,
    ) {
        super(app);
        this.plugin = plugin;
        this.result = result;
        this.editorText = editorText;
        this.onAccept = onAccept;
        this.customInstruction = initialCustom ?? '';
        this.viewState = initialCustom != null ? 'custom-input' : 'loading';

        const lines = editorText.split('\n');
        this.lineText = lines[result.line - 1] ?? '';

        this.titleEl.setText(this.getTitle());
    }

    /** Build the modal title from the rule name. */
    private getTitle(): string {
        const info = RULE_INFO[this.result.rule];
        return `Fix with AI — ${info?.name ?? this.result.rule}`;
    }

    /** Open the modal and begin loading. */
    onOpen(): void {
        this.render();
        if (this.viewState === 'loading') {
            void this.fetchSuggestion();
        }
    }

    /** Clean up the abort controller on close. */
    onClose(): void {
        this.currentAbort?.abort();
        this.contentEl.empty();
    }

    /** Render the appropriate view based on the current state. */
    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.removeClass(
            'quill-fix-ai-loading',
            'quill-fix-ai-diff',
            'quill-fix-ai-custom',
        );

        switch (this.viewState) {
            case 'loading':
                this.renderLoading();
                break;
            case 'default-result':
                this.renderDiff();
                break;
            case 'custom-input':
                this.renderCustomInput();
                break;
        }
    }

    /** Show a spinner while the AI is processing. */
    private renderLoading(): void {
        const { contentEl } = this;
        contentEl.addClass('quill-fix-ai-loading');
        contentEl.createEl('p', {
            text: 'Asking the AI for a suggestion...',
        });
    }

    /** Render the diff preview with Accept/Reject buttons. */
    private renderDiff(): void {
        const { contentEl } = this;
        contentEl.addClass('quill-fix-ai-diff');

        const info = RULE_INFO[this.result.rule];

        if (info) {
            contentEl.createEl('p', {
                cls: 'quill-fix-ai-rule-desc',
                text: info.description,
            });
        }

        const flaggedText = this.lineText.slice(
            this.result.column,
            this.result.column + this.result.length,
        );

        // Show what will be removed
        const removeLabel = contentEl.createEl('p', { cls: 'quill-fix-ai-label' });
        removeLabel.setText('Remove');

        const removeBlock = contentEl.createEl('div', {
            cls: 'quill-fix-ai-block quill-fix-ai-removed',
        });
        removeBlock.createEl('span', {
            cls: 'quill-fix-ai-highlight-removed',
            text: flaggedText,
        });

        // Show what will be inserted (or "(deleted)" if empty)
        const insertLabel = contentEl.createEl('p', { cls: 'quill-fix-ai-label' });
        insertLabel.setText('Replace with');

        const insertBlock = contentEl.createEl('div', {
            cls: 'quill-fix-ai-block quill-fix-ai-inserted',
        });

        if (this.suggestion) {
            insertBlock.createEl('span', {
                cls: 'quill-fix-ai-highlight-added',
                text: this.suggestion,
            });
        } else {
            insertBlock.createEl('span', {
                cls: 'quill-fix-ai-highlight-added',
                text: '(Removed)',
            });
        }

        // Show the result in context — the full line with the replacement applied
        if (this.suggestion !== null) {
            const contextLabel = contentEl.createEl('p', { cls: 'quill-fix-ai-label' });
            contextLabel.setText('In context');

            const contextBlock = contentEl.createEl('div', {
                cls: 'quill-fix-ai-block quill-fix-ai-context',
            });

            const revised = this.lineText.slice(0, this.result.column)
                + this.suggestion
                + this.lineText.slice(this.result.column + this.result.length);

            contextBlock.createEl('span', { text: revised });
        }

        // Buttons
        const buttonRow = contentEl.createEl('div', { cls: 'quill-fix-ai-actions' });

        const customBtn = buttonRow.createEl('button', {
            cls: 'quill-fix-ai-custom-btn',
            text: 'Custom instruction',
        });
        customBtn.addEventListener('click', () => {
            this.viewState = 'custom-input';
            this.render();
        });

        const acceptBtn = buttonRow.createEl('button', {
            cls: 'quill-fix-ai-accept-btn mod-cta',
            text: 'Accept',
        });
        acceptBtn.addEventListener('click', () => {
            if (this.suggestion !== null) {
                this.onAccept(this.suggestion);
            }
            this.close();
        });

        const rejectBtn = buttonRow.createEl('button', {
            cls: 'quill-fix-ai-reject-btn',
            text: 'Reject',
        });
        rejectBtn.addEventListener('click', () => {
            this.close();
        });
    }

    /** Render the custom instruction input view. */
    private renderCustomInput(): void {
        const { contentEl } = this;
        contentEl.addClass('quill-fix-ai-custom');

        const info = RULE_INFO[this.result.rule];
        if (info) {
            contentEl.createEl('p', {
                cls: 'quill-fix-ai-rule-desc',
                text: info.description,
            });
        }

        contentEl.createEl('p', {
            cls: 'quill-fix-ai-label',
            text: 'Custom instruction',
        });

        const textarea = contentEl.createEl('textarea', {
            cls: 'quill-fix-ai-textarea',
            attr: {
                rows: '3',
                placeholder: 'E.g.: Replace with a stronger word for this context',
            },
        });
        textarea.value = this.customInstruction;

        const buttonRow = contentEl.createEl('div', { cls: 'quill-fix-ai-actions' });

        const backBtn = buttonRow.createEl('button', {
            cls: 'quill-fix-ai-back-btn',
            text: 'Back to default',
        });
        backBtn.addEventListener('click', () => {
            this.viewState = 'default-result';
            this.suggestion = this.suggestionBackup;
            this.render();
        });

        const suggestBtn = buttonRow.createEl('button', {
            cls: 'quill-fix-ai-suggest-btn mod-cta',
            text: 'Get AI suggestion',
        });
        suggestBtn.addEventListener('click', () => {
            this.customInstruction = textarea.value.trim();
            if (!this.customInstruction) {
                new Notice('Please enter a custom instruction.');
                return;
            }
            this.viewState = 'loading';
            this.render();
            void this.fetchSuggestion(this.customInstruction);
        });
    }

    /** Backup of the default suggestion so we can restore it when user clicks "Back to default". */
    private suggestionBackup: string | null = null;

    /**
     * Call suggestLintFix and update the view with the result.
     * Stores the default suggestion before making a custom request.
     */
    private async fetchSuggestion(customInstruction?: string): Promise<void> {
        const provider = this.plugin.getDefaultChatProvider();
        if (!provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            this.close();
            return;
        }

        this.currentAbort?.abort();
        this.currentAbort = new AbortController();

        try {
            const result = await suggestLintFix(
                this.result,
                this.editorText,
                provider,
                {
                    temperature: this.plugin.settings.linterTemperature,
                    maxTokens: this.plugin.settings.linterMaxOutputTokens,
                    signal: this.currentAbort.signal,
                },
                customInstruction,
            );

            if (result === null) {
                new Notice('AI could not suggest a fix for this issue.');
                this.close();
                return;
            }

            // Save the default suggestion before switching to custom.
            if (!customInstruction && !this.suggestionBackup) {
                this.suggestionBackup = result;
            }

            this.suggestion = result;
            this.viewState = 'default-result';
            this.render();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`AI fix failed: ${msg}`);
            this.close();
        }
    }
}
