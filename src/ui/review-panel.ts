import { App, MarkdownRenderer, Notice, TFile } from 'obsidian';
import { FEEDBACK_PERSONAS } from '../ai/feedback';
import { ANALYSIS_MODES, type AnalysisMode, type AnalysisScope } from '../ai/analysis';
import { buildFileLabel, formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';
import { FilenameModal } from './filename-modal';
import { ChatContextFiles } from './chat-context-files';

/** Sub-tabs within the Review tab. */
type ReviewSubtab = 'create' | 'results';

/** State of the results sub-tab. */
type ResultsState = 'idle' | 'loading' | 'complete' | 'error';

/** Which review engine the Create tab is configuring. */
type ReviewEngine = 'editorial' | 'critical';

/** Scope picker value for the critical engine; `'auto'` defers to the plugin. */
export type ScopeChoice = AnalysisScope | 'auto';

/**
 * Unified Review panel — merges editorial feedback (persona-driven, multi-file)
 * and critical analysis (mode-driven, selection/scene/document) into a single
 * sidebar tab with an engine picker at the top of the Create sub-tab.
 *
 * Both engines share the same Results sub-tab (streaming report + follow-up
 * chat + compaction + context files). The plugin keeps separate conversation
 * state per engine (`feedbackCurrentMessages` / `analysisCurrentMessages`);
 * this panel dispatches callbacks based on `activeEngine`, which is set when
 * the writer clicks Generate.
 */
export class ReviewPanel extends AbstractChatPanel {
    private subtab: ReviewSubtab = 'create';
    private resultsState: ResultsState = 'idle';

    // --- Engine selection ---
    /** Which engine the Create tab is currently configuring. */
    private engine: ReviewEngine = 'editorial';
    /** Which engine produced the current Results. Set by startLoading. Public
     *  so the sidebar's callback closures can dispatch to the right plugin
     *  method (cancelFeedbackGeneration vs cancelAnalysisGeneration, etc.). */
    activeEngine: ReviewEngine = 'editorial';

    // --- Editorial state ---
    private contextFilePaths: string[] = [];
    private contextFileTokens: Map<string, number> = new Map();
    private currentPersonaId = '';

    // --- Critical state ---
    private currentMode: AnalysisMode | '' = '';
    private currentScope: ScopeChoice = 'auto';

    // --- Shared state ---
    private reportText = '';
    private customInstruction = '';
    private chatHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
    private contextTokenOverride: number | null = null;
    private chatContextFiles: ChatContextFiles;

    /** Labels for the Results header (set by startLoading). */
    private headerLabel = '';
    private subLabel = '';

    // --- Handlers ---
    private onEditorialGenerate: ((personaId: string, customInstruction?: string) => void) | null = null;
    private onCriticalGenerate: ((mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void) | null =
        null;
    private onChatMessage: ((message: string) => void) | null = null;

    constructor(app: App) {
        super(app);
        this.chatContextFiles = new ChatContextFiles(app, 'quill-chat-panel', () => this.updateReviewIndicator());
    }

    // ========================================================================
    // Handler registration
    // ========================================================================

    setEditorialGenerateHandler(handler: (personaId: string, customInstruction?: string) => void): void {
        this.onEditorialGenerate = handler;
    }

    setCriticalGenerateHandler(
        handler: (mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void
    ): void {
        this.onCriticalGenerate = handler;
    }

    setChatMessageHandler(handler: (message: string) => void): void {
        this.onChatMessage = handler;
    }

    setContextTokenEstimate(tokens: number): void {
        this.contextTokenOverride = tokens;
        this.updateReviewIndicator();
    }

    // ========================================================================
    // Manuscript context files (editorial engine only)
    // ========================================================================

    async addContextFile(filePath: string): Promise<void> {
        if (this.contextFilePaths.includes(filePath)) return;
        this.contextFilePaths.push(filePath);
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const content = await this.app.vault.cachedRead(file);
                this.contextFileTokens.set(filePath, Math.ceil(content.length / 4));
            }
        } catch {
            this.contextFileTokens.set(filePath, 0);
        }
        if (this.containerEl) this.render();
    }

    removeContextFile(filePath: string): void {
        this.contextFilePaths = this.contextFilePaths.filter((p) => p !== filePath);
        this.contextFileTokens.delete(filePath);
        if (this.containerEl) this.render();
    }

    getContextFilePaths(): string[] {
        return [...this.contextFilePaths];
    }

    // ========================================================================
    // Chat context files (shared — reference material for follow-up chat)
    // ========================================================================

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

    // ========================================================================
    // Streaming lifecycle (called from plugin via sidebar passthroughs)
    // ========================================================================

    /**
     * Begin a new review: switch to Results tab, reset prior state.
     * The plugin calls this after validating the request.
     */
    startLoading(engine: ReviewEngine, headerLabel: string, subLabel?: string): void {
        this.activeEngine = engine;
        this.headerLabel = headerLabel;
        this.subLabel = subLabel ?? '';
        this.resultsState = 'loading';
        this.reportText = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        this.chatContextFiles.clear();
        this.subtab = 'results';
        if (this.containerEl) this.render();
    }

    appendChunk(text: string): void {
        this.reportText += text;
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-review-panel__report');
        if (el) el.setText(this.reportText);
    }

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

    resetResults(): void {
        this.subtab = 'create';
        this.resultsState = 'idle';
        this.reportText = '';
        this.currentPersonaId = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        this.chatContextFiles.clear();
        if (this.containerEl) this.render();
    }

    /** Full reset including manuscript context files. */
    resetAll(): void {
        this.subtab = 'create';
        this.resultsState = 'idle';
        this.contextFilePaths = [];
        this.contextFileTokens.clear();
        this.reportText = '';
        this.contextTokenOverride = null;
        this.currentPersonaId = '';
        this.customInstruction = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.chatContextFiles.clear();
        if (this.containerEl) this.render();
    }

    // ========================================================================
    // Chat lifecycle (follow-up conversation after the initial report)
    // ========================================================================

    getChatHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return [...this.chatHistory];
    }

    appendChatSystemMessage(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        if (this.containerEl) void this.rerenderResultsTab();
    }

    appendChatSystemMessageInPlace(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        if (!this.containerEl) return;
        const chatSection = this.containerEl.querySelector('.quill-chat-panel__section');
        if (!chatSection) return;
        const streaming = chatSection.querySelector('.quill-chat-panel__bubble--streaming');
        const el = chatSection.createDiv({ cls: 'quill-chat-panel__context-head', text: content });
        if (streaming) {
            chatSection.insertBefore(el, streaming);
        }
        this.updateReviewIndicator();
    }

    replaceChatHistory(history: { role: 'user' | 'assistant' | 'system'; content: string }[]): void {
        this.chatHistory = [...history];
        if (this.containerEl) void this.rerenderResultsTab();
    }

    chatStartLoading(): void {
        super.chatStartLoading();
    }

    chatAppendChunk(text: string): void {
        let last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.content += text;
        } else {
            this.chatHistory.push({ role: 'assistant', content: text });
            last = this.chatHistory[this.chatHistory.length - 1];
        }
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-chat-panel__bubble--streaming');
        if (el) el.setText(last?.content ?? '');
        if (!this.userScrolledUp) this.scrollToBottom();
    }

    async chatFinished(): Promise<void> {
        await this.withScrollRestore(async () => {
            this.chatLoading = false;
            await this.rerenderResultsTab();
        });
    }

    async chatError(message: string): Promise<void> {
        await this.withScrollRestore(async () => {
            this.chatLoading = false;
            const last = this.chatHistory[this.chatHistory.length - 1];
            if (last && last.role === 'assistant') {
                last.content = `Error: ${message}`;
            }
            await this.rerenderResultsTab();
        });
    }

    // ========================================================================
    // Save conversation (engine-aware header)
    // ========================================================================

    saveConversation(): void {
        const timestamp = new Date().toISOString().slice(0, 10);
        const isCritical = this.activeEngine === 'critical';
        const defaultName = `${isCritical ? 'quill-analysis' : 'quill-conversation'}-${timestamp}.md`;
        const title = isCritical ? 'Save analysis report' : 'Save conversation';
        new FilenameModal(
            this.app,
            defaultName,
            async (path: string) => {
                const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
                const lines: string[] = [];
                lines.push(isCritical ? '# Quill critical analysis' : '# Quill feedback conversation');
                lines.push('');
                lines.push(`*Saved on ${new Date().toLocaleString()}*`);
                if (isCritical) {
                    lines.push(`*Mode: ${this.headerLabel}*`);
                }
                lines.push('');

                if (this.reportText) {
                    lines.push(isCritical ? '## Report' : '## Initial feedback');
                    lines.push('');
                    lines.push(this.reportText);
                    lines.push('');
                }
                if (this.chatHistory.length > 0) {
                    lines.push(isCritical ? '## Follow-up discussion' : '## Conversation');
                    lines.push('');
                    for (const msg of this.chatHistory) {
                        if (msg.role === 'system') {
                            lines.push(`> **Context head:** ${msg.content}`);
                        } else if (msg.role === 'user') {
                            lines.push(`**You:** ${msg.content}`);
                        } else {
                            lines.push(`**Assistant:** ${msg.content}`);
                        }
                        lines.push('');
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
                    new Notice(`Saved to ${normalizedPath}`);
                } catch (err) {
                    new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
            title
        ).open();
    }

    // ========================================================================
    // Token computation (engine-aware)
    // ========================================================================

    /** Recompute the context indicator in-place (no full re-render). */
    private updateReviewIndicator(): void {
        if (!this.updateIndicatorFn) return;
        this.updateIndicatorFn();
    }

    /** Set by renderChatBottom; called when tokens change. */
    private updateIndicatorFn: (() => void) | null = null;

    private totalContextTokens(): number {
        let total = 0;
        for (const t of this.contextFileTokens.values()) total += t;
        return total;
    }

    private static readonly SYSTEM_PROMPT_OVERHEAD = 2600;

    private totalEstimatedTokens(): number {
        return ReviewPanel.SYSTEM_PROMPT_OVERHEAD + this.totalContextTokens();
    }

    private budgetPercent(): number {
        if (this.maxAllowedTokens <= 0) return 0;
        return Math.min(100, (this.totalEstimatedTokens() / this.maxAllowedTokens) * 100);
    }

    private isOverBudget(): boolean {
        return this.maxAllowedTokens > 0 && this.totalEstimatedTokens() > this.maxAllowedTokens;
    }

    private computeContextTokens(): { totalTokens: number; maxTokens: number } {
        if (this.contextTokenOverride !== null) {
            const totalTokens = this.contextTokenOverride + this.totalContextTokens() + this.getChatContextTokens();
            return { totalTokens, maxTokens: this.maxAllowedTokens };
        }
        let fromIndex = 0;
        for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            if (this.chatHistory[i]?.role === 'system') {
                fromIndex = i;
                break;
            }
        }
        const relevantHistory = this.chatHistory.slice(fromIndex);
        const historyTokens = relevantHistory.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
        const totalTokens =
            this.totalContextTokens() +
            this.getChatContextTokens() +
            Math.ceil((this.reportText ?? '').length / 4) +
            historyTokens;
        return { totalTokens, maxTokens: this.maxAllowedTokens };
    }

    // ========================================================================
    // Main render
    // ========================================================================

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
        const tabs: { id: ReviewSubtab; label: string }[] = [
            { id: 'create', label: 'New review' },
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

    // ========================================================================
    // Create sub-tab
    // ========================================================================

    private renderCreateTab(): void {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar__content-plain' });

        // Document gate — both engines need a document open.
        const doc = this.requireActiveDocument(scroll, 'review');
        if (!doc) return;
        this.renderDocumentHeader(scroll, doc);

        // Engine picker — two buttons at the top.
        this.renderEnginePicker(scroll);

        // Engine-specific sections.
        if (this.engine === 'editorial') {
            this.renderManuscriptsSection(scroll);
            this.renderPersonaSection(scroll);
        } else {
            this.renderModeSection(scroll);
            this.renderScopeSection(scroll);
        }

        // Shared: custom instruction + generate.
        scroll.createEl('hr', { cls: 'quill-form__divider' });
        scroll.createEl('p', { cls: 'quill-form__label', text: 'Custom instruction (optional)' });

        const customArea = scroll.createEl('textarea', {
            cls: 'quill-form__textarea',
            placeholder:
                this.engine === 'editorial'
                    ? 'Describe what kind of feedback you want...'
                    : 'e.g. "Focus on whether the protagonist\'s change of heart is earned."'
        });
        customArea.value = this.customInstruction;
        customArea.addEventListener('input', () => {
            this.customInstruction = customArea.value;
        });

        const generateBtn = scroll.createEl('button', {
            cls: 'quill-form__submit mod-cta',
            text: this.engine === 'editorial' ? 'Generate feedback' : 'Run analysis'
        });
        generateBtn.addEventListener('click', () => this.triggerGenerate());
    }

    private renderEnginePicker(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Review type' });

        const engines: { id: ReviewEngine; label: string; desc: string }[] = [
            { id: 'editorial', label: 'Editor feedback', desc: 'Persona-driven review of selected manuscripts.' },
            { id: 'critical', label: 'Critical analysis', desc: 'Targeted consistency checks with line refs.' }
        ];

        const row = container.createDiv({ cls: 'quill-option-picker' });
        for (const eng of engines) {
            const btn = row.createEl('button', { cls: 'quill-option-picker__option' });
            if (this.engine === eng.id) btn.addClass('quill-option-picker__option--active');
            btn.createEl('span', { cls: 'quill-option-picker__name', text: eng.label });
            btn.createEl('span', { cls: 'quill-option-picker__desc', text: eng.desc });
            btn.addEventListener('click', () => {
                this.engine = eng.id;
                if (this.containerEl) this.render();
            });
        }
    }

    // --- Editorial sections ---

    private renderManuscriptsSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Manuscripts' });

        // Budget bar
        if (this.maxAllowedTokens > 0) {
            const pct = this.budgetPercent();
            const over = this.isOverBudget();
            const budget = section.createDiv({ cls: 'quill-review-panel__budget' });
            budget.createEl('span', {
                cls: 'quill-review-panel__budget-text',
                text: `${this.totalEstimatedTokens()} / ${this.maxAllowedTokens} tokens (system + source + context)`
            });
            const bar = budget.createDiv({ cls: 'quill-review-panel__budget-bar' });
            const fill = bar.createDiv({
                cls: `quill-review-panel__budget-fill${over ? ' quill-review-panel__budget-fill--over' : ''}`
            });
            fill.style.width = `${Math.min(pct, 100)}%`;
            if (over) {
                budget.createEl('span', {
                    cls: 'quill-review-panel__budget-warn',
                    text: `Exceeds provider context limit by ~${this.totalEstimatedTokens() - this.maxAllowedTokens} tokens.`
                });
            }
        }

        // Selected files
        const list = section.createDiv({ cls: 'quill-review-panel__file-list' });
        if (this.contextFilePaths.length === 0) {
            list.createEl('p', {
                text: 'Add one or more manuscripts to analyze. The active document is auto-included when you open this tab.',
                cls: 'quill-empty-hint'
            });
        } else {
            for (const filePath of this.contextFilePaths) {
                const tokens = this.contextFileTokens.get(filePath) ?? 0;
                const item = list.createDiv({ cls: 'quill-review-panel__file-item' });
                const name = filePath.split('/').pop() ?? filePath;
                item.createEl('span', { cls: 'quill-review-panel__file-name', text: name });
                item.createEl('span', { cls: 'quill-review-panel__file-tokens', text: `~${tokens} tokens` });
                const remove = item.createEl('button', { cls: 'quill-review-panel__file-remove', text: '\u00d7' });
                remove.addEventListener('click', () => this.removeContextFile(filePath));
            }
        }

        const addBtn = section.createEl('button', {
            cls: 'quill-review-panel__file-add',
            text: '+ add file'
        });
        addBtn.addEventListener('click', () => {
            const exclude = [...this.contextFilePaths, ...this.chatContextFiles.getFiles()];
            new VaultFileSuggestModal(
                this.app,
                (file) => {
                    void this.addContextFile(file.path);
                },
                exclude,
                'Select a manuscript to include as context...'
            ).open();
        });
    }

    private renderPersonaSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Feedback type' });

        const personas = container.createDiv({ cls: 'quill-option-picker' });
        for (const persona of FEEDBACK_PERSONAS) {
            const btn = personas.createEl('button', { cls: 'quill-option-picker__option' });
            const name = btn.createEl('span', { cls: 'quill-option-picker__name', text: persona.name });
            name.title = persona.description;
            btn.createEl('span', { cls: 'quill-option-picker__desc', text: persona.description });
            btn.addEventListener('click', () => {
                this.triggerEditorial(persona.id);
            });
        }
    }

    // --- Critical sections ---

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

        const scopeRow = container.createDiv({ cls: 'quill-review-panel__scope-row' });
        for (const scope of scopes) {
            const btn = scopeRow.createEl('button', {
                cls: `quill-review-panel__scope-btn${this.currentScope === scope.id ? ' quill-review-panel__scope-btn--active' : ''}`,
                text: scope.label,
                title: scope.hint
            });
            btn.addEventListener('click', () => {
                this.currentScope = scope.id;
                if (this.containerEl) this.render();
            });
        }
    }

    // --- Generate dispatch ---

    private triggerGenerate(): void {
        if (this.engine === 'editorial') {
            // Editorial requires a manuscript. Persona buttons call triggerEditorial
            // directly; the Generate button is only for custom instructions.
            if (!this.customInstruction.trim()) return;
            this.triggerEditorial('custom');
        } else {
            this.triggerCritical();
        }
    }

    private triggerEditorial(personaId: string): void {
        if (this.contextFilePaths.length === 0) {
            new Notice('Quill: Add at least one manuscript file to review.');
            return;
        }
        this.onEditorialGenerate?.(personaId, personaId === 'custom' ? this.customInstruction : undefined);
    }

    private triggerCritical(): void {
        if (!this.currentMode) {
            new Notice('Quill: Pick an analysis mode first.');
            return;
        }
        this.onCriticalGenerate?.(this.currentMode, this.currentScope, this.customInstruction || undefined);
    }

    // ========================================================================
    // Results sub-tab (shared, engine-aware header)
    // ========================================================================

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
                text: 'No results yet. Use the new review tab to generate a report.',
                cls: 'quill-empty-hint'
            });
            return;
        }

        // Header — engine-aware
        const header = scroll.createDiv({ cls: 'quill-review-panel__header' });
        header.createEl('span', { cls: 'quill-review-panel__persona', text: this.headerLabel });
        if (this.subLabel) {
            header.createEl('span', { cls: 'quill-review-panel__scope-tag', text: this.subLabel });
        }

        if (this.resultsState === 'loading') {
            header.createEl('span', { cls: 'quill-review-panel__status', text: 'Analyzing...' });
            scroll.createDiv({ cls: 'quill-review-panel__report' }).setText('');
        } else if (this.resultsState === 'complete') {
            header.createEl('span', {
                cls: 'quill-review-panel__status quill-review-panel__status--done',
                text: 'Done'
            });
            const report = scroll.createDiv({ cls: 'quill-review-panel__report-rendered' });
            await MarkdownRenderer.render(
                this.app,
                normalizeParagraphBreaks(this.reportText),
                report,
                '',
                this.renderEvents
            );

            const controls = scroll.createDiv({ cls: 'quill-review-panel__controls' });
            const newBtn = controls.createEl('button', {
                cls: 'quill-review-panel__nav-btn',
                text: 'New review'
            });
            newBtn.addEventListener('click', () => this.resetResults());

            // Chat section
            const chatSection = scroll.createDiv({ cls: 'quill-chat-panel__section' });
            for (const msg of this.chatHistory) {
                if (msg.role === 'system') {
                    chatSection.createDiv({ cls: 'quill-chat-panel__context-head', text: msg.content });
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
            header.createEl('span', { cls: 'quill-review-panel__status', text: 'Failed' });
            scroll.createEl('p', { cls: 'quill-review-panel__error-text', text: this.reportText });
            const controls = scroll.createDiv({ cls: 'quill-review-panel__controls' });
            const retryBtn = controls.createEl('button', {
                cls: 'quill-review-panel__nav-btn',
                text: 'Back to create'
            });
            retryBtn.addEventListener('click', () => this.resetResults());
        }

        // Bottom area (chat input) — only when complete
        if (this.resultsState === 'complete') {
            this.renderChatBottom(scroll);
        }
    }

    private renderChatBottom(_scroll: HTMLElement): void {
        if (!this.containerEl) return;
        const bottomArea = this.containerEl.createDiv({ cls: 'quill-chat-panel__bottom' });

        const btnRow = bottomArea.createDiv({ cls: 'quill-chat-panel__btn-row' });
        const addCtxBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u00b1',
            title: 'Add file to context'
        });
        addCtxBtn.addEventListener('click', () => {
            const exclude =
                this.activeEngine === 'editorial'
                    ? [...this.chatContextFiles.getFiles(), ...this.contextFilePaths]
                    : [...this.chatContextFiles.getFiles()];
            new VaultFileSuggestModal(this.app, (file) => void this.addChatContextFile(file.path), exclude).open();
        });
        const saveBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\ud83d\udcbe',
            title: 'Save to file'
        });
        saveBtn.addEventListener('click', () => this.saveConversation());
        const compactBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn quill-chat-panel__action-btn--compact',
            text: '\u00bb\u00bb',
            title: 'Compact conversation'
        });
        compactBtn.addEventListener('click', () => this.onCompact?.());
        const newChatBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u2713',
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
            placeholder: 'Ask a follow-up\u2026'
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
                chatSection.createDiv({ cls: 'quill-chat-panel__bubble quill-chat-panel__bubble--user', text });
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

        // Token indicator
        const ctxIndicator = bottomArea.createDiv({ cls: 'quill-chat-panel__indicator' });
        const setIndicatorText = () => {
            const { totalTokens, maxTokens } = this.computeContextTokens();
            const label =
                this.activeEngine === 'editorial'
                    ? buildFileLabel(this.contextFilePaths.length, this.chatContextFiles.fileCount())
                    : 'analysis';
            ctxIndicator.setText(formatTokenIndicatorText(label, totalTokens, maxTokens));
        };
        setIndicatorText();
        this.updateIndicatorFn = setIndicatorText;

        this.chatContextFiles.attach(bottomArea);

        const scrollC = this.getScrollContainer();
        if (scrollC) this.registerScrollListener(scrollC);
    }
}
