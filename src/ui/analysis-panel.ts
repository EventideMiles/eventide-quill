import { App, MarkdownRenderer, Notice, TFile } from 'obsidian';
import { ANALYSIS_MODES, type AnalysisMode, type AnalysisScope } from '../ai/analysis';
import { formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { FilenameModal } from './filename-modal';
import { ChatContextFiles } from './chat-context-files';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';

type AnalysisSubtab = 'create' | 'results';
type ResultsState = 'idle' | 'loading' | 'complete' | 'error';
/** Scope picker value; `'auto'` defers the decision to the plugin. */
export type ScopeChoice = AnalysisScope | 'auto';

/** Sidebar panel for the Critical Analysis / Continuity Engine (Feature 11). */
export class AnalysisPanel extends AbstractChatPanel {
    private subtab: AnalysisSubtab = 'create';
    private resultsState: ResultsState = 'idle';

    private currentMode: AnalysisMode | '' = '';
    private currentScope: ScopeChoice = 'auto';
    private reportText = '';
    private customInstruction = '';

    private chatHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

    /** Conversation-only token count pushed from the plugin layer. */
    private contextTokenOverride: number | null = null;

    /** Files added as persistent reference context for follow-up chat. */
    private chatContextFiles: ChatContextFiles;

    private onGenerate: ((mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void) | null = null;
    private onChatMessage: ((message: string) => void) | null = null;

    constructor(app: App) {
        super(app);
        this.chatContextFiles = new ChatContextFiles(app, 'quill-chat-panel', () => this.updateAnalysisIndicator());
    }

    // --- Handler registration (called by sidebar wiring) ---

    setGenerateHandler(handler: (mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void): void {
        this.onGenerate = handler;
    }

    setChatMessageHandler(handler: (message: string) => void): void {
        this.onChatMessage = handler;
    }

    /** Push the conversation-only token count from the plugin. */
    setContextTokenEstimate(tokens: number): void {
        this.contextTokenOverride = tokens;
        this.updateAnalysisIndicator();
    }

    // --- Chat context files (reference material added mid-conversation) ---

    getChatContextFiles(): string[] {
        return this.chatContextFiles.getFiles();
    }

    getChatContextTokens(): number {
        return this.chatContextFiles.getTotalTokens();
    }

    async addChatContextFile(filePath: string): Promise<void> {
        await this.chatContextFiles.add(filePath);
    }

    removeChatContextFile(filePath: string): void {
        this.chatContextFiles.remove(filePath);
    }

    // --- Public lifecycle (called from plugin via sidebar passthroughs) ---

    /** Begin a new analysis: switch to Results tab, reset prior state. */
    startLoading(mode: AnalysisMode, scope: ScopeChoice): void {
        this.currentMode = mode;
        this.currentScope = scope;
        this.resultsState = 'loading';
        this.reportText = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        this.chatContextFiles.clear();
        this.subtab = 'results';
        if (this.containerEl) this.render();
    }

    /** Append a streaming chunk to the in-flight report (loading state only). */
    appendChunk(text: string): void {
        this.reportText += text;
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-analysis-panel__report');
        if (el) el.setText(this.reportText);
    }

    /** Mark the initial report complete and re-render to show chat input. */
    async finishLoading(): Promise<void> {
        this.resultsState = 'complete';
        await this.rerenderResultsTab();
        const c = this.getScrollContainer();
        if (c) c.scrollTop = 0;
    }

    showError(message: string): void {
        this.resultsState = 'error';
        this.reportText = message;
        if (this.containerEl) this.render();
    }

    /** Reset to the Create tab, preserving any chosen mode/scope defaults. */
    resetResults(): void {
        this.subtab = 'create';
        this.resultsState = 'idle';
        this.reportText = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        this.chatContextFiles.clear();
        if (this.containerEl) this.render();
    }

    // --- Chat lifecycle ---

    getChatHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return [...this.chatHistory];
    }

    appendChatSystemMessage(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        if (this.containerEl) void this.rerenderResultsTab();
    }

    /** In-place context-head bubble (no full re-render, preserves streaming). */
    appendChatSystemMessageInPlace(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        if (!this.containerEl) return;
        const chatSection = this.containerEl.querySelector('.quill-chat-panel__section');
        if (!chatSection) return;
        // Insert before the streaming assistant bubble if present, else at the end.
        const streaming = chatSection.querySelector('.quill-chat-panel__bubble--streaming');
        const head = activeDocument.createElement('div');
        head.className = 'quill-chat-panel__context-head';
        head.textContent = content;
        if (streaming) {
            chatSection.insertBefore(head, streaming);
        } else {
            chatSection.appendChild(head);
        }
    }

    replaceChatHistory(history: { role: 'user' | 'assistant' | 'system'; content: string }[]): void {
        this.chatHistory = [...history];
        if (this.containerEl) void this.rerenderResultsTab();
    }

    chatStartLoading(): void {
        super.chatStartLoading();
        if (this.containerEl) this.render();
    }

    chatAppendChunk(text: string): void {
        if (this.chatHistory.length === 0 || this.chatHistory[this.chatHistory.length - 1]!.role !== 'assistant') {
            this.chatHistory.push({ role: 'assistant', content: '' });
        }
        this.chatHistory[this.chatHistory.length - 1]!.content += text;

        if (!this.containerEl) return;
        const streaming = this.containerEl.querySelector('.quill-chat-panel__bubble--streaming');
        if (streaming) {
            streaming.setText(this.chatHistory[this.chatHistory.length - 1]!.content);
        }
        if (!this.userScrolledUp) this.scrollToBottom();
    }

    async chatFinished(): Promise<void> {
        this.chatLoading = false;
        if (this.containerEl) await this.withScrollRestore(() => this.rerenderResultsTab());
    }

    async chatError(message: string): Promise<void> {
        this.chatLoading = false;
        if (this.chatHistory.length > 0 && this.chatHistory[this.chatHistory.length - 1]!.role === 'assistant') {
            this.chatHistory[this.chatHistory.length - 1]!.content = `Error: ${message}`;
        }
        if (this.containerEl) await this.withScrollRestore(() => this.rerenderResultsTab());
    }

    // --- Save conversation ---

    saveConversation(): void {
        const timestamp = new Date().toISOString().slice(0, 10);
        const defaultName = `quill-analysis-${timestamp}.md`;
        new FilenameModal(
            this.app,
            defaultName,
            async (path: string) => {
                const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
                const lines: string[] = [];
                lines.push('# Quill critical analysis');
                lines.push('');
                lines.push(`*Saved on ${new Date().toLocaleString()}*`);
                const modeLabel = ANALYSIS_MODES.find((m) => m.id === this.currentMode)?.label ?? this.currentMode;
                lines.push(`*Mode: ${modeLabel}*`);
                lines.push('');

                if (this.reportText) {
                    lines.push('## Report');
                    lines.push('');
                    lines.push(this.reportText);
                    lines.push('');
                }
                if (this.chatHistory.length > 0) {
                    lines.push('## Follow-up discussion');
                    lines.push('');
                    for (const msg of this.chatHistory) {
                        if (msg.role === 'system') {
                            lines.push(`> **Context head:** ${msg.content}`);
                            lines.push('');
                        } else if (msg.role === 'user') {
                            lines.push(`**You:** ${msg.content}`);
                            lines.push('');
                        } else if (msg.role === 'assistant') {
                            lines.push(`**Assistant:** ${msg.content}`);
                            lines.push('');
                        }
                    }
                }
                const content = lines.join('\n');
                try {
                    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
                    if (existing instanceof TFile) {
                        await this.app.vault.modify(existing, content);
                    } else {
                        await this.app.vault.create(normalizedPath, content);
                    }
                    new Notice(`Saved analysis to ${normalizedPath}`);
                } catch (err) {
                    new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
            'Save analysis report'
        ).open();
    }

    // --- Render ---

    render(): void {
        if (!this.containerEl) return;
        this.unloadAndClearContainer();
        this.renderSubtabBar();
        if (this.subtab === 'create') {
            this.renderCreateTab();
        } else {
            void this.renderResultsTab();
        }
    }

    private renderSubtabBar(): void {
        if (!this.containerEl) return;
        const bar = this.containerEl.createDiv({ cls: 'quill-sidebar__subtab-bar' });
        const tabs: { id: AnalysisSubtab; label: string }[] = [
            { id: 'create', label: 'New analysis' },
            { id: 'results', label: 'Results' }
        ];
        for (const tab of tabs) {
            const btn = bar.createEl('button', {
                cls: `quill-sidebar__subtab${this.subtab === tab.id ? ' quill-sidebar__subtab--active' : ''}`,
                text: tab.label
            });
            btn.addEventListener('click', () => {
                this.subtab = tab.id;
                this.render();
            });
        }
    }

    private renderCreateTab(): void {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar__content-plain' });

        // Gate on whether a markdown document is active. Without this, the panel
        // would render the mode/scope pickers but `requestAnalysis` would fail
        // at the plugin layer with no editor to read from.
        const doc = this.getActiveDocument();
        if (this.renderNoDocumentState(scroll, 'analysis')) return;

        // Show which document will be analyzed so the writer can confirm before
        // they switch tabs or run analysis on the wrong chapter.
        this.renderDocumentHeader(scroll, doc);

        this.renderModeSection(scroll);
        this.renderScopeSection(scroll);

        scroll.createEl('hr', { cls: 'quill-form__divider' });
        scroll.createEl('p', { cls: 'quill-form__label', text: 'Custom instruction (optional)' });

        const customArea = scroll.createEl('textarea', {
            cls: 'quill-form__textarea',
            placeholder: 'e.g. "Focus on whether the protagonist\'s change of heart is earned."'
        });
        customArea.value = this.customInstruction;
        customArea.addEventListener('input', () => {
            this.customInstruction = customArea.value;
        });

        const generateBtn = scroll.createEl('button', {
            cls: 'quill-form__submit mod-cta',
            text: 'Run analysis'
        });
        generateBtn.addEventListener('click', () => this.triggerAnalysis());
    }

    private renderModeSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Analysis mode' });

        const modes = container.createDiv({ cls: 'quill-option-picker' });
        for (const mode of ANALYSIS_MODES) {
            const btn = modes.createEl('button', { cls: 'quill-option-picker__option' });
            if (this.currentMode === mode.id) btn.addClass('quill-option-picker__option--active');
            btn.createEl('span', { cls: 'quill-option-picker__name', text: mode.label });
            btn.createEl('span', { cls: 'quill-option-picker__desc', text: mode.description });
            btn.addEventListener('click', () => {
                this.currentMode = mode.id;
                if (this.containerEl) this.render();
            });
        }
    }

    private renderScopeSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Scope' });

        const scopes: { id: ScopeChoice; label: string; hint: string }[] = [
            { id: 'auto', label: 'Auto', hint: 'Selection if text is selected, else scene, else document.' },
            { id: 'selection', label: 'Selection', hint: 'Analyze the active selection.' },
            { id: 'scene', label: 'Scene', hint: 'Analyze the heading-bounded scene at the cursor.' },
            { id: 'document', label: 'Document', hint: 'Analyze the whole document.' }
        ];

        const scopeRow = container.createDiv({ cls: 'quill-analysis-panel__scope-row' });
        for (const scope of scopes) {
            const btn = scopeRow.createEl('button', {
                cls: `quill-analysis-panel__scope-btn${this.currentScope === scope.id ? ' quill-analysis-panel__scope-btn--active' : ''}`,
                text: scope.label,
                title: scope.hint
            });
            btn.addEventListener('click', () => {
                this.currentScope = scope.id;
                if (this.containerEl) this.render();
            });
        }
    }

    private triggerAnalysis(): void {
        if (!this.currentMode) {
            new Notice('Quill: Pick an analysis mode first.');
            return;
        }
        this.onGenerate?.(this.currentMode, this.currentScope, this.customInstruction || undefined);
    }

    private async rerenderResultsTab(): Promise<void> {
        if (!this.containerEl) return;
        this.unloadAndClearContainer();
        this.renderSubtabBar();
        await this.renderResultsTab();
    }

    private async renderResultsTab(): Promise<void> {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar__content-plain' });

        if (this.resultsState === 'idle') {
            scroll.createEl('p', {
                text: 'No analysis yet. Use the new analysis tab to pick a mode and run it.',
                cls: 'quill-empty-hint'
            });
            return;
        }

        // Header
        const header = scroll.createDiv({ cls: 'quill-analysis-panel__header' });
        const modeMeta = ANALYSIS_MODES.find((m) => m.id === this.currentMode);
        if (modeMeta) {
            header.createEl('span', { cls: 'quill-analysis-panel__mode-tag', text: modeMeta.label });
        }
        header.createEl('span', {
            cls: 'quill-analysis-panel__scope-tag',
            text: this.currentScope === 'auto' ? 'auto scope' : `${this.currentScope}`
        });

        if (this.resultsState === 'loading') {
            header.createEl('span', { cls: 'quill-analysis-panel__status', text: 'Analyzing...' });
            scroll.createDiv({ cls: 'quill-analysis-panel__report' }).setText('');
        } else if (this.resultsState === 'complete') {
            header.createEl('span', {
                cls: 'quill-analysis-panel__status quill-analysis-panel__status--done',
                text: 'Done'
            });
            const report = scroll.createDiv({ cls: 'quill-analysis-panel__report-rendered' });
            await MarkdownRenderer.render(
                this.app,
                normalizeParagraphBreaks(this.reportText),
                report,
                '',
                this.renderEvents
            );

            const controls = scroll.createDiv({ cls: 'quill-analysis-panel__controls' });
            const newBtn = controls.createEl('button', {
                cls: 'quill-analysis-panel__nav-btn',
                text: 'New analysis'
            });
            newBtn.addEventListener('click', () => this.resetResults());

            // Chat section
            const chatSection = scroll.createDiv({ cls: 'quill-chat-panel__section' });
            for (const msg of this.chatHistory) {
                if (msg.role === 'system') {
                    chatSection.createDiv({
                        cls: 'quill-chat-panel__context-head',
                        text: msg.content
                    });
                } else {
                    const bubble = chatSection.createDiv({
                        cls: `quill-chat-panel__bubble quill-chat-panel__bubble--${msg.role}`
                    });
                    if (msg.role === 'assistant') {
                        await MarkdownRenderer.render(
                            this.app,
                            normalizeParagraphBreaks(msg.content),
                            bubble,
                            '',
                            this.renderEvents
                        );
                    } else {
                        bubble.setText(msg.content);
                    }
                }
            }
            if (this.chatLoading) {
                chatSection.createDiv({
                    cls: 'quill-chat-panel__bubble quill-chat-panel__bubble--assistant quill-chat-panel__bubble--streaming',
                    text: '\u2026'
                });
            }
        } else if (this.resultsState === 'error') {
            header.createEl('span', { cls: 'quill-analysis-panel__status', text: 'Failed' });
            scroll.createEl('p', { cls: 'quill-analysis-panel__error-text', text: this.reportText });
            const controls = scroll.createDiv({ cls: 'quill-analysis-panel__controls' });
            const retryBtn = controls.createEl('button', {
                cls: 'quill-analysis-panel__nav-btn',
                text: 'Back to create'
            });
            retryBtn.addEventListener('click', () => this.resetResults());
        }

        // Bottom area: pinned chat input + buttons (only when complete)
        if (this.resultsState === 'complete') {
            this.renderChatBottom();
        }
    }

    private renderChatBottom(): void {
        if (!this.containerEl) return;
        const bottomArea = this.containerEl.createDiv({ cls: 'quill-chat-panel__bottom' });

        const btnRow = bottomArea.createDiv({ cls: 'quill-chat-panel__btn-row' });
        const addCtxBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u00b1', // ±
            title: 'Add file to context'
        });
        addCtxBtn.addEventListener('click', () => {
            const exclude = this.chatContextFiles.getFiles();
            new VaultFileSuggestModal(
                this.app,
                (file) => {
                    void this.addChatContextFile(file.path);
                },
                exclude
            ).open();
        });
        const saveBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\ud83d\udcbe', // 💾
            title: 'Save analysis to file'
        });
        saveBtn.addEventListener('click', () => this.saveConversation());
        const compactBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn quill-chat-panel__action-btn--compact',
            text: '\u00bb\u00bb', // »»
            title: 'Compact conversation'
        });
        compactBtn.addEventListener('click', () => this.onCompact?.());
        const newChatBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u2713', // ✓
            title: 'New chat'
        });
        newChatBtn.addEventListener('click', () => this.onNewChat?.(false));
        btnRow.createEl('div', { cls: 'quill-chat-panel__btn-spacer' });
        const actionBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-panel__send-btn mod-cta${this.chatLoading ? ' quill-cowriter-panel__send-btn--stop' : ''}`,
            text: this.chatLoading ? 'Stop' : 'Send'
        });

        const taRow = bottomArea.createDiv({ cls: 'quill-chat-panel__ta-row' });
        const input = taRow.createEl('textarea', {
            cls: 'quill-chat-panel__input',
            placeholder: 'Ask a follow-up about the analysis\u2026'
        });

        const doSend = () => {
            if (this.chatLoading) return;
            const text = input.value.trim();
            if (!text) return;
            this.chatHistory.push({ role: 'user', content: text });
            input.value = '';
            this.chatLoading = true;
            this.userScrolledUp = false;

            actionBtn.setText('Stop');
            actionBtn.addClass('quill-cowriter-panel__send-btn--stop');

            const chatSection = this.containerEl?.querySelector('.quill-chat-panel__section');
            if (chatSection) {
                chatSection.createDiv({
                    cls: 'quill-chat-panel__bubble quill-chat-panel__bubble--user',
                    text: text
                });
                chatSection.createDiv({
                    cls: 'quill-chat-panel__bubble quill-chat-panel__bubble--assistant quill-chat-panel__bubble--streaming',
                    text: '\u2026'
                });
            }
            this.scrollToBottom();
            this.onChatMessage?.(text);
        };
        const doStop = () => this.onCancelGeneration?.();
        actionBtn.addEventListener('click', () => {
            if (this.chatLoading) doStop();
            else doSend();
        });
        input.addEventListener('keydown', (e) => {
            if (this.chatLoading) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                doSend();
            }
        });

        const ctxIndicator = bottomArea.createDiv({ cls: 'quill-chat-panel__indicator' });
        const setIndicatorText = () => {
            const totalTokens = (this.contextTokenOverride ?? 0) + this.chatContextFiles.getTotalTokens();
            ctxIndicator.setText(formatTokenIndicatorText('analysis', totalTokens, this.maxAllowedTokens));
        };
        setIndicatorText();
        // Reference for closure refresh on token updates
        this.updateAnalysisIndicator = setIndicatorText;

        // Attach the chat-context-files pill bar (renders any pre-existing files
        // above the button row). Must happen after btnRow exists.
        this.chatContextFiles.attach(bottomArea);

        const scrollC = this.getScrollContainer();
        if (scrollC) this.registerScrollListener(scrollC);
    }

    private updateAnalysisIndicator: () => void = () => {
        /* overwritten in renderChatBottom */
    };
}
