import { App, MarkdownRenderer, Modal, Notice, TFile } from 'obsidian';
import { FEEDBACK_PERSONAS } from '../ai/feedback';
import { buildFileLabel, formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';

/** Sub-tabs within the Feedback tab. */
type FeedbackSubtab = 'create' | 'results';

/** State of the results sub-tab. */
type ResultsState = 'idle' | 'loading' | 'complete' | 'error';

/** Simple modal that prompts for a filename and calls back with the path. */
class FilenameModal extends Modal {
    private onChoose: (path: string) => void | Promise<void>;
    private defaultName: string;

    constructor(app: App, defaultName: string, onChoose: (path: string) => void | Promise<void>) {
        super(app);
        this.defaultName = defaultName;
        this.onChoose = onChoose;
    }

    onOpen(): void {
        this.titleEl.setText('Save conversation');
        const content = this.contentEl.createDiv();
        content.createEl('label', { text: 'File path:', cls: 'quill-save-label' });
        const input = content.createEl('input', {
            type: 'text',
            cls: 'quill-save-input',
            value: this.defaultName
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void this.onChoose(input.value.trim() || this.defaultName);
                this.close();
            }
        });
        const btnRow = content.createDiv({ cls: 'quill-save-btn-row' });
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

/** Truncate the middle of a filename if it exceeds maxWidth characters. */
function truncateFileName(name: string, maxWidth: number = 24): string {
    if (name.length <= maxWidth) return name;
    const half = Math.floor((maxWidth - 1) / 2);
    return name.slice(0, half) + '\u2026' + name.slice(name.length - half);
}

/**
 * Renders the Feedback tab in the Quill sidebar with two sub-tabs:
 * "Create feedback" and "Results".
 * Extends AbstractChatPanel for shared chat infrastructure.
 */
export class FeedbackPanel extends AbstractChatPanel {
    private subtab: FeedbackSubtab = 'create';
    private resultsState: ResultsState = 'idle';

    private contextFilePaths: string[] = [];
    private contextFileTokens: Map<string, number> = new Map();

    /**
     * Conversation token estimate from the plugin layer. Contains only
     * system prompt + context heads + chat turns. The panel adds manuscript
     * and reference file tokens on top so adding/removing files updates
     * the indicator immediately.
     */
    private contextTokenOverride: number | null = null;

    private reportText = '';
    private currentPersonaId = '';
    private customInstruction = '';

    /** Callback invoked when feedback should be generated. */
    private onGenerate: ((personaId: string, customInstruction?: string) => void) | null = null;

    /** Follow-up chat messages after the initial report. */
    private chatHistory: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

    private onChatMessage: ((message: string) => void) | null = null;

    /** Files added as persistent context for the entire chat conversation. */
    private chatContextFiles: string[] = [];
    private chatContextFileTokens: Map<string, number> = new Map();

    constructor(app: App) {
        super(app);
    }

    /** Register the callback for when feedback should be generated. */
    setGenerateHandler(handler: (personaId: string, customInstruction?: string) => void): void {
        this.onGenerate = handler;
    }

    /**
     * Override the conversation token estimate shown in the context indicator.
     * Called from the plugin layer with conversation tokens only (system prompt
     * + context heads + chat turns). The panel adds manuscript and reference
     * file tokens on top so the indicator updates immediately when files change.
     */
    setContextTokenEstimate(tokens: number): void {
        this.contextTokenOverride = tokens;
        this.updateChatCtxIndicator();
    }

    /**
     * Export the current conversation (report + chat history) to a markdown
     * file in the vault. Prompts the user for a filename.
     */
    saveConversation(): void {
        const timestamp = new Date().toISOString().slice(0, 10);
        const defaultName = `quill-conversation-${timestamp}.md`;
        new FilenameModal(this.app, defaultName, async (path: string) => {
            const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
            const lines: string[] = [];
            lines.push('# Quill feedback conversation');
            lines.push('');
            lines.push(`*Saved on ${new Date().toLocaleString()}*`);
            lines.push('');
            if (this.reportText) {
                lines.push('## Initial feedback');
                lines.push('');
                lines.push(this.reportText);
                lines.push('');
            }
            if (this.chatHistory.length > 0) {
                lines.push('## Conversation');
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
                new Notice(`Saved conversation to ${normalizedPath}`);
            } catch (err) {
                new Notice(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
            }
        }).open();
    }

    /** Add a context file path and estimate its token count. */
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

    /** Remove a context file path. */
    removeContextFile(filePath: string): void {
        this.contextFilePaths = this.contextFilePaths.filter((p) => p !== filePath);
        this.contextFileTokens.delete(filePath);
        if (this.containerEl) this.render();
    }

    /** Get selected context file paths. */
    getContextFilePaths(): string[] {
        return [...this.contextFilePaths];
    }

    // --- Streaming lifecycle (called from plugin) ---

    startLoading(personaId: string): void {
        this.currentPersonaId = personaId;
        this.resultsState = 'loading';
        this.reportText = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        this.subtab = 'results';
        // Clear conversation-scoped chat context files for a fresh start.
        this.chatContextFiles = [];
        this.chatContextFileTokens.clear();
        if (this.containerEl) this.render();
    }

    appendChunk(text: string): void {
        this.reportText += text;
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-feedback-report');
        if (el) el.setText(this.reportText);
    }

    async finishLoading(): Promise<void> {
        this.resultsState = 'complete';
        await this.rerenderResultsTab();
        // Scroll to top when the initial report finishes
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
        this.customInstruction = '';
        this.chatHistory = [];
        this.chatLoading = false;
        this.contextTokenOverride = null;
        // Clear conversation-scoped chat context files when resetting results.
        this.chatContextFiles = [];
        this.chatContextFileTokens.clear();
        if (this.containerEl) this.render();
    }

    /** Full reset including context files. */
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
        // Clear conversation-scoped chat context files when resetting all state.
        this.chatContextFiles = [];
        this.chatContextFileTokens.clear();
        if (this.containerEl) this.render();
    }

    // --- Chat lifecycle (follow-up conversation after the initial report) ---

    /** Register the callback for when a chat message is sent. */
    setChatMessageHandler(handler: (message: string) => void): void {
        this.onChatMessage = handler;
    }

    /** Get the list of follow-up chat messages (including system context heads). */
    getChatHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return this.chatHistory;
    }

    /** Append a system message to the chat history (e.g. compaction notice) and re-render. */
    appendChatSystemMessage(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        if (this.containerEl) void this.rerenderResultsTab();
    }

    /**
     * Append a system message to chat history and render it in-place
     * without a full DOM rebuild. Used during streaming to avoid flicker.
     * The context head div is inserted before any streaming bubble so the
     * visual order is preserved until the next full re-render.
     */
    appendChatSystemMessageInPlace(content: string): void {
        this.chatHistory.push({ role: 'system', content });
        const chatSection = this.containerEl?.querySelector('.quill-feedback-chat-section');
        if (!chatSection) return;
        const el = chatSection.createDiv({
            cls: 'quill-feedback-chat-context-head',
            text: content
        });
        const streaming = chatSection.querySelector('.quill-feedback-chat-streaming');
        if (streaming) {
            chatSection.insertBefore(el, streaming);
        }
        this.updateChatCtxIndicator();
    }

    /** Replace chat history with a compacted version (called after compaction). */
    replaceChatHistory(history: { role: 'user' | 'assistant' | 'system'; content: string }[]): void {
        this.chatHistory = history;
        if (this.containerEl) this.render();
    }

    /** Get the chat context file paths. */
    getChatContextFiles(): string[] {
        return [...this.chatContextFiles];
    }

    /** Get the total estimated tokens for chat context files. */
    getChatContextTokens(): number {
        let total = 0;
        for (const t of this.chatContextFileTokens.values()) total += t;
        return total;
    }

    /** Add a file as persistent chat context. */
    async addChatContextFile(filePath: string): Promise<void> {
        if (this.chatContextFiles.includes(filePath)) return;
        this.chatContextFiles.push(filePath);
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const content = await this.app.vault.cachedRead(file);
                this.chatContextFileTokens.set(filePath, Math.ceil(content.length / 4));
            }
        } catch {
            this.chatContextFileTokens.set(filePath, 0);
        }
        this.updateChatCtxUI();
    }

    /** Remove a file from persistent chat context. */
    removeChatContextFile(filePath: string): void {
        this.chatContextFiles = this.chatContextFiles.filter((p) => p !== filePath);
        this.chatContextFileTokens.delete(filePath);
        this.updateChatCtxUI();
    }

    /** Update the chat context pills and indicator in-place without a full re-render. */
    private updateChatCtxUI(): void {
        const bottomArea = this.containerEl?.querySelector('.quill-feedback-chat-bottom');
        if (!bottomArea) return;

        // Rebuild context pill bar — insert before the input row so it stays on top
        const oldCtxBar = bottomArea.querySelector('.quill-feedback-chat-ctx-bar');
        if (oldCtxBar) oldCtxBar.remove();

        const inputRow = bottomArea.querySelector('.quill-feedback-chat-btn-row');

        if (this.chatContextFiles.length > 0) {
            const ctxBar = bottomArea.createDiv({ cls: 'quill-feedback-chat-ctx-bar' });
            for (const filePath of this.chatContextFiles) {
                const pill = ctxBar.createDiv({ cls: 'quill-feedback-chat-ctx-pill' });
                const name = truncateFileName(filePath.split('/').pop() ?? filePath);
                pill.createEl('span', { text: name });
                const removeBtn = pill.createEl('button', {
                    cls: 'quill-feedback-chat-ctx-remove',
                    text: '\u00d7',
                    title: filePath
                });
                removeBtn.addEventListener('click', () => this.removeChatContextFile(filePath));
            }
            if (inputRow) {
                bottomArea.insertBefore(ctxBar, inputRow);
            }
        }

        // Update indicator text (counts from last context head forward)
        const { totalTokens, maxTokens } = this.computeContextTokens();
        const label = buildFileLabel(this.contextFilePaths.length, this.chatContextFiles.length);
        const indicator = bottomArea.querySelector('.quill-feedback-chat-ctx-indicator');
        if (indicator) {
            indicator.setText(formatTokenIndicatorText(label, totalTokens, maxTokens));
        }
    }

    /**
     * Recompute the context indicator text in-place (without full re-render).
     * Tokens are counted from the last context head forward, so users see
     * the window clear after compaction.
     */
    private updateChatCtxIndicator(): void {
        const bottomArea = this.containerEl?.querySelector('.quill-feedback-chat-bottom');
        if (!bottomArea) return;
        const indicator = bottomArea.querySelector('.quill-feedback-chat-ctx-indicator');
        if (!indicator) return;
        const { totalTokens, maxTokens } = this.computeContextTokens();
        const label = buildFileLabel(this.contextFilePaths.length, this.chatContextFiles.length);
        indicator.setText(formatTokenIndicatorText(label, totalTokens, maxTokens));
    }

    /**
     * Compute token totals for the context indicator.
     * When the plugin layer provides an override, it contains conversation
     * tokens only (system prompt + context heads + chat turns). Manuscripts
     * and reference files are tracked by the panel and added on top so the
     * indicator updates immediately when files are added or removed.
     * Otherwise, fall back to a local estimate from chat history plus files.
     */
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

    /** Start loading state for a chat follow-up. State is already set by doSend. */
    chatStartLoading(): void {
        super.chatStartLoading();
    }

    /** Append a chunk of text to the streaming chat response. */
    chatAppendChunk(text: string): void {
        let last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.content += text;
        } else {
            this.chatHistory.push({ role: 'assistant', content: text });
            // Update `last` to the newly added assistant message so we render its content.
            last = this.chatHistory[this.chatHistory.length - 1];
        }
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-feedback-chat-streaming');
        if (el) el.setText(last?.content ?? '');
        // Auto-scroll only if the user hasn't scrolled up
        if (!this.userScrolledUp) {
            this.scrollToBottom();
        }
    }

    /** Re-render the results tab and wait for async rendering (markdown, etc.) to complete. */
    private async rerenderResultsTab(): Promise<void> {
        if (!this.containerEl) return;
        this.unloadAndClearContainer();
        this.renderSubtabBar();
        await this.renderResultsTab();
    }

    /** Mark the current chat response as complete. Re-renders to show markdown. */
    async chatFinished(): Promise<void> {
        await this.withScrollRestore(async () => {
            this.chatLoading = false;
            await this.rerenderResultsTab();
        });
    }

    /** Show an error in the chat response. */
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

    // --- Token budget computation ---

    private totalContextTokens(): number {
        let total = 0;
        for (const t of this.contextFileTokens.values()) total += t;
        return total;
    }

    /** Estimated tokens consumed by the system prompt overhead (shown in the
     *  Create tab so users know that space is already reserved). */
    private static readonly SYSTEM_PROMPT_OVERHEAD = 2600;

    /** Estimate tokens for the Create tab budget bar.
     *  Always uses the fixed system prompt overhead plus manuscript tokens,
     *  since this display is for pre-generation planning, not the live
     *  conversation indicator. */
    private totalEstimatedTokens(): number {
        return FeedbackPanel.SYSTEM_PROMPT_OVERHEAD + this.totalContextTokens();
    }

    private budgetPercent(): number {
        if (this.maxAllowedTokens <= 0) return 0;
        return Math.min(100, (this.totalEstimatedTokens() / this.maxAllowedTokens) * 100);
    }

    private isOverBudget(): boolean {
        return this.maxAllowedTokens > 0 && this.totalEstimatedTokens() > this.maxAllowedTokens;
    }

    // --- Main render ---

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
        const bar = this.containerEl.createDiv({ cls: 'quill-sidebar-subtab-bar' });
        const tabs: { id: FeedbackSubtab; label: string }[] = [
            { id: 'create', label: 'Create feedback' },
            { id: 'results', label: 'Results' }
        ];
        for (const tab of tabs) {
            const btn = bar.createEl('button', {
                cls: `quill-sidebar-subtab${this.subtab === tab.id ? ' quill-sidebar-subtab-active' : ''}`,
                text: tab.label
            });
            btn.addEventListener('click', () => {
                this.subtab = tab.id;
                this.render();
            });
        }
    }

    // --- Create feedback tab ---

    private renderCreateTab(): void {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar-content-plain' });

        this.renderManuscriptsSection(scroll);
        this.renderPersonaSection(scroll);
    }

    private renderManuscriptsSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-feedback-section' });
        section.createEl('p', { cls: 'quill-feedback-section-label', text: 'Manuscripts' });

        // Budget bar
        if (this.maxAllowedTokens > 0) {
            const pct = this.budgetPercent();
            const over = this.isOverBudget();
            const budget = section.createDiv({ cls: 'quill-feedback-budget' });
            budget.createEl('span', {
                cls: 'quill-feedback-budget-text',
                text: `${this.totalEstimatedTokens()} / ${this.maxAllowedTokens} tokens (system + source + context)`
            });
            const bar = budget.createDiv({ cls: 'quill-feedback-budget-bar' });
            const fill = bar.createDiv({
                cls: `quill-feedback-budget-fill${over ? ' quill-feedback-budget-over' : ''}`
            });
            fill.style.width = `${Math.min(pct, 100)}%`;
            if (over) {
                budget.createEl('span', {
                    cls: 'quill-feedback-budget-warn',
                    text: `Exceeds provider context limit by ~${this.totalEstimatedTokens() - this.maxAllowedTokens} tokens.`
                });
            }
        }

        // Selected files
        const list = section.createDiv({ cls: 'quill-feedback-file-list' });
        if (this.contextFilePaths.length === 0) {
            list.createEl('p', {
                text: 'Add one or more manuscripts to analyze. Feedback is generated from the content of these files.',
                cls: 'quill-feedback-hint'
            });
        } else {
            for (const filePath of this.contextFilePaths) {
                const tokens = this.contextFileTokens.get(filePath) ?? 0;
                const item = list.createDiv({ cls: 'quill-feedback-file-item' });
                const name = filePath.split('/').pop() ?? filePath;
                item.createEl('span', { cls: 'quill-feedback-file-name', text: name });
                item.createEl('span', { cls: 'quill-feedback-file-tokens', text: `~${tokens} tokens` });
                const remove = item.createEl('button', { cls: 'quill-feedback-file-remove', text: '\u00d7' });
                remove.addEventListener('click', () => this.removeContextFile(filePath));
            }
        }

        const addBtn = section.createEl('button', {
            cls: 'quill-feedback-file-add',
            text: '+ add file'
        });
        addBtn.addEventListener('click', () => {
            const exclude = [...this.contextFilePaths, ...this.chatContextFiles];
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
        const section = container.createDiv({ cls: 'quill-feedback-section' });
        section.createEl('p', { cls: 'quill-feedback-section-label', text: 'Feedback type' });

        const personas = container.createDiv({ cls: 'quill-feedback-personas' });

        for (const persona of FEEDBACK_PERSONAS) {
            const btn = personas.createEl('button', {
                cls: 'quill-feedback-persona-btn'
            });
            const name = btn.createEl('span', { cls: 'quill-feedback-persona-name', text: persona.name });
            name.title = persona.description;
            btn.createEl('span', { cls: 'quill-feedback-persona-desc', text: persona.description });
            btn.addEventListener('click', () => {
                this.triggerFeedback(persona.id);
            });
        }

        // Custom feedback
        section.createEl('hr', { cls: 'quill-feedback-divider' });
        container.createEl('p', { cls: 'quill-feedback-section-label', text: 'Custom' });

        const customArea = container.createEl('textarea', {
            cls: 'quill-feedback-custom-input',
            placeholder: 'Describe what kind of feedback you want...'
        });
        customArea.value = this.customInstruction;
        customArea.addEventListener('input', () => {
            this.customInstruction = customArea.value;
        });

        const generateBtn = container.createEl('button', {
            cls: 'quill-feedback-generate-btn',
            text: 'Generate feedback'
        });
        generateBtn.addEventListener('click', () => {
            if (!this.customInstruction.trim()) {
                return;
            }
            this.triggerFeedback('custom');
        });
    }

    private triggerFeedback(personaId: string): void {
        if (this.contextFilePaths.length === 0) {
            new Notice('Quill: Add at least one manuscript file to analyze.');
            return;
        }
        if (!this.onGenerate) {
            new Notice('Quill: Feedback engine not initialized. Try reopening the sidebar.');
            return;
        }
        this.onGenerate(personaId, personaId === 'custom' ? this.customInstruction : undefined);
    }

    // --- Results tab ---

    private async renderResultsTab(): Promise<void> {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar-content-plain' });

        if (this.resultsState === 'idle') {
            scroll.createEl('p', {
                text: 'No feedback results yet. Use the create feedback tab to generate a report.',
                cls: 'quill-feedback-hint'
            });
            return;
        }

        // Header
        const header = scroll.createDiv({ cls: 'quill-feedback-header' });
        const persona = FEEDBACK_PERSONAS.find((p) => p.id === this.currentPersonaId);
        if (persona) {
            header.createEl('span', { cls: 'quill-feedback-persona', text: persona.name });
        }

        if (this.resultsState === 'loading') {
            header.createEl('span', { cls: 'quill-feedback-status', text: 'Analyzing...' });
            const report = scroll.createDiv({ cls: 'quill-feedback-report' });
            report.setText('');
        } else if (this.resultsState === 'complete') {
            header.createEl('span', { cls: 'quill-feedback-status quill-feedback-status-done', text: 'Done' });
            const report = scroll.createDiv({ cls: 'quill-feedback-report-rendered' });
            await MarkdownRenderer.render(
                this.app,
                normalizeParagraphBreaks(this.reportText),
                report,
                '',
                this.renderEvents
            );
            const controls = scroll.createDiv({ cls: 'quill-feedback-controls' });
            const newBtn = controls.createEl('button', {
                cls: 'quill-feedback-nav-btn',
                text: 'New feedback'
            });
            newBtn.addEventListener('click', () => this.resetResults());

            // Chat section (scrollable — contains message bubbles)
            const chatSection = scroll.createDiv({ cls: 'quill-feedback-chat-section' });
            if (this.chatHistory.length > 0) {
                for (const msg of this.chatHistory) {
                    if (msg.role === 'system') {
                        chatSection.createDiv({
                            cls: 'quill-feedback-chat-context-head',
                            text: msg.content
                        });
                    } else {
                        const bubble = chatSection.createDiv({
                            cls: `quill-feedback-chat-bubble quill-feedback-chat-${msg.role}`
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
            }
            if (this.chatLoading) {
                chatSection.createDiv({
                    cls: 'quill-feedback-chat-bubble quill-feedback-chat-assistant quill-feedback-chat-streaming',
                    text: '\u2026'
                });
            }
        } else if (this.resultsState === 'error') {
            header.createEl('span', { cls: 'quill-feedback-status', text: 'Failed' });
            scroll.createEl('p', { cls: 'quill-feedback-error-text', text: this.reportText });
            const controls = scroll.createDiv({ cls: 'quill-feedback-controls' });
            const retryBtn = controls.createEl('button', {
                cls: 'quill-feedback-nav-btn',
                text: 'Back to create'
            });
            retryBtn.addEventListener('click', () => this.resetResults());
        }

        // Chat input — pinned to bottom, outside the scroll container
        if (this.resultsState === 'complete') {
            const bottomArea = this.containerEl.createDiv({ cls: 'quill-feedback-chat-bottom' });

            // Context file pills
            if (this.chatContextFiles.length > 0) {
                const ctxBar = bottomArea.createDiv({ cls: 'quill-feedback-chat-ctx-bar' });
                for (const filePath of this.chatContextFiles) {
                    const pill = ctxBar.createDiv({ cls: 'quill-feedback-chat-ctx-pill' });
                    const name = truncateFileName(filePath.split('/').pop() ?? filePath);
                    pill.createEl('span', { text: name });
                    const removeBtn = pill.createEl('button', {
                        cls: 'quill-feedback-chat-ctx-remove',
                        text: '\u00d7',
                        title: filePath
                    });
                    removeBtn.addEventListener('click', () => this.removeChatContextFile(filePath));
                }
            }

            // Buttons row — context add, save, send/stop
            const btnRow = bottomArea.createDiv({ cls: 'quill-feedback-chat-btn-row' });
            const addCtxBtn = btnRow.createEl('button', {
                cls: 'quill-feedback-chat-ctx-add',
                text: '\u00b1', // ± symbol as add-file icon
                title: 'Add file to context'
            });
            addCtxBtn.addEventListener('click', () => {
                const exclude = [...this.chatContextFiles, ...this.contextFilePaths];
                new VaultFileSuggestModal(
                    this.app,
                    (file) => {
                        void this.addChatContextFile(file.path);
                    },
                    exclude
                ).open();
            });
            const saveBtn = btnRow.createEl('button', {
                cls: 'quill-feedback-chat-save',
                text: '\ud83d\udcbe', // 💾 floppy disk
                title: 'Save conversation to file'
            });
            saveBtn.addEventListener('click', () => this.saveConversation());
            const compactBtn = btnRow.createEl('button', {
                cls: 'quill-feedback-chat-compact',
                text: '\u00bb\u00bb', // »» compact icon
                title: 'Compact conversation'
            });
            compactBtn.addEventListener('click', () => this.onCompact?.());
            const newChatBtn = btnRow.createEl('button', {
                cls: 'quill-feedback-chat-new-chat',
                text: '\u2713', // ✓ checkmark / new icon
                title: 'New chat'
            });
            newChatBtn.addEventListener('click', () => this.onNewChat?.(false));
            btnRow.createEl('div', { cls: 'quill-feedback-chat-btn-spacer' });
            const actionBtn = btnRow.createEl('button', {
                cls: `quill-cowriter-send-btn mod-cta${this.chatLoading ? ' quill-cowriter-stop-btn' : ''}`,
                text: this.chatLoading ? 'Stop' : 'Send'
            });

            // Textarea row — below the buttons, ~10 lines tall
            const taRow = bottomArea.createDiv({ cls: 'quill-feedback-chat-ta-row' });
            const input = taRow.createEl('textarea', {
                cls: 'quill-feedback-chat-input',
                placeholder: 'Ask a follow-up about the feedback\u2026'
            });
            const doSend = () => {
                if (this.chatLoading) return;

                const text = input.value.trim();
                if (!text) return;
                this.chatHistory.push({ role: 'user', content: text });
                input.value = '';
                this.chatLoading = true;
                this.userScrolledUp = false;

                // Immediate DOM updates
                actionBtn.setText('Stop');
                actionBtn.addClass('quill-cowriter-stop-btn');

                // Add user bubble + streaming assistant bubble directly to DOM
                const chatSection = this.containerEl?.querySelector('.quill-feedback-chat-section');
                if (chatSection) {
                    chatSection.createDiv({
                        cls: 'quill-feedback-chat-bubble quill-feedback-chat-user',
                        text: text
                    });
                    chatSection.createDiv({
                        cls: 'quill-feedback-chat-bubble quill-feedback-chat-assistant quill-feedback-chat-streaming',
                        text: '\u2026'
                    });
                }
                this.scrollToBottom();
                this.onChatMessage?.(text);
            };
            const doStop = () => {
                this.onCancelGeneration?.();
            };
            actionBtn.addEventListener('click', () => {
                if (this.chatLoading) {
                    doStop();
                } else {
                    doSend();
                }
            });
            input.addEventListener('keydown', (e) => {
                if (this.chatLoading) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    doSend();
                }
            });

            // Context indicator — reflects what the AI sees (from last context head)
            const ctxIndicator = bottomArea.createDiv({ cls: 'quill-feedback-chat-ctx-indicator' });
            const setIndicatorText = () => {
                const { totalTokens, maxTokens } = this.computeContextTokens();
                const label = buildFileLabel(this.contextFilePaths.length, this.chatContextFiles.length);
                ctxIndicator.setText(formatTokenIndicatorText(label, totalTokens, maxTokens));
            };
            setIndicatorText();

            // Scroll listener: if user scrolls up during streaming, stop auto-follow
            const scrollC = this.getScrollContainer();
            if (scrollC) {
                this.registerScrollListener(scrollC);
            }
        }
    }
}
