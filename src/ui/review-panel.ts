import { App, MarkdownRenderer, normalizePath, Notice, TFile } from 'obsidian';
import { FEEDBACK_PERSONAS } from '../ai/feedback';
import { ANALYSIS_MODES, type AnalysisMode, type AnalysisScope } from '../ai/analysis';
import {
    MANUSCRIPT_ANALYSIS_MODES,
    getManuscriptAnalysisModeById,
    type ManuscriptAnalysisMode,
    type ManuscriptScope
} from '../ai/manuscript-analysis';
import type { CompactionStrategy } from '../ai/manuscript-compaction';
import type EventideQuillPlugin from '../main';
import { buildFileLabel, formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { FileMentionSuggest } from './file-mention-suggest';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';
import { buildEmbedFolderPath, embedFolderLabel, parseEmbedFolderPath, resolveAtMentions } from '../utils/vault-files';
import { FilenameModal } from './filename-modal';
import { ChatContextFiles } from './chat-context-files';
import { feedbackQueueBadgeCount, renderFeedbackQueue, type FeedbackQueueHandlers } from './feedback-queue-panel';

/** Sub-tabs within the Review tab. */
type ReviewSubtab = 'create' | 'results' | 'queue';

/** State of the results sub-tab. */
type ResultsState = 'idle' | 'loading' | 'complete' | 'error';

/** Which review engine the Create tab is configuring. */
type ReviewEngine = 'editorial' | 'critical' | 'manuscript';

/** Scope picker value for the critical engine; `'auto'` defers to the plugin. */
export type ScopeChoice = AnalysisScope | 'auto';

/**
 * Unified Review panel — merges editorial feedback (persona-driven, multi-file),
 * critical analysis (mode-driven, selection/scene/document), and manuscript
 * analysis (full-manuscript structural diagnostics) into a single sidebar tab
 * with an engine picker at the top of the Create sub-tab.
 *
 * All engines share the same Results sub-tab (streaming report + follow-up
 * chat + compaction + context files). The plugin keeps separate conversation
 * state per engine; this panel dispatches callbacks based on `activeEngine`,
 * which is set when the writer clicks Generate.
 */
export class ReviewPanel extends AbstractChatPanel {
    private subtab: ReviewSubtab = 'create';
    private resultsState: ResultsState = 'idle';
    /** Monotonic counter incremented on every render start. Used by
     *  renderResultsTab to bail out after an await if a newer render
     *  has superseded it — prevents stale async renders from appending
     *  duplicate DOM elements (e.g. multiple chat input bars). */
    private renderToken = 0;
    /** Whether to show "full embed" folder options in the file picker. Set by sidebar from plugin settings. */
    private showFullEmbed = false;
    /** Top-K chunk count for embed folder token estimation. Set by sidebar from plugin settings. */
    private embeddingsTopK = 10;
    /** Per-folder top-K overrides. Set by sidebar from plugin settings. */
    private folderTopKOverrides: Record<string, number> = {};

    /** Set whether the "full embed" folder option should appear in file pickers. */
    setShowFullEmbed(value: boolean): void {
        this.showFullEmbed = value;
    }

    /** Set the embeddings top-K chunk count for folder token estimation. */
    setEmbeddingsTopK(value: number): void {
        this.embeddingsTopK = value;
        void this.refreshEmbedContextTokenEstimates();
    }

    /** Set the per-folder top-K overrides map. */
    setFolderTopKOverrides(overrides: Record<string, number>): void {
        this.folderTopKOverrides = overrides;
        void this.refreshEmbedContextTokenEstimates();
    }

    // --- Engine selection ---
    /** Which engine the Create tab is currently configuring. */
    private engine: ReviewEngine = 'critical';
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

    // --- Manuscript state ---
    private currentManuscriptMode: ManuscriptAnalysisMode | '' = '';
    private currentManuscriptScope: ManuscriptScope = { kind: 'full' };
    private currentCompactionStrategy: CompactionStrategy = 'embed';
    private manuscriptTokenEstimate: { estimated: number; max: number } | null = null;
    /** Monotonic counter incremented on every manuscript scope/compaction change.
     *  Used by setManuscriptTokenEstimate to discard stale promise results. */
    private manuscriptSettingsVersion = 0;

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
    private onManuscriptGenerate:
        | ((
              mode: ManuscriptAnalysisMode,
              scope: ManuscriptScope,
              compaction: CompactionStrategy,
              customInstruction?: string
          ) => void)
        | null = null;
    private onChatMessage: ((message: string) => void) | null = null;

    /** Plugin reference (for the Queue subtab to read jobs + provider state). */
    private plugin: EventideQuillPlugin | null = null;
    /** When true, Generate/persona actions queue a job instead of running interactively. */
    private queueMode = false;
    /** Cached Create sub-tab scroll position — preserved across option-change re-renders
     *  (reset only when the Review type/engine changes, since that restructures the form). */
    private createScrollTop = 0;
    /** Cached Queue sub-tab badge element (live-updated without a full re-render). */
    private queueBadgeEl: HTMLElement | null = null;
    /** Queued-editorial handler (mirrors onEditorialGenerate but routes to the queue). */
    private onEditorialQueue: ((personaId: string, customInstruction?: string) => void) | null = null;
    /** Queued-critical handler (mirrors onCriticalGenerate but routes to the queue). */
    private onCriticalQueue: ((mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void) | null =
        null;
    /** Queued-manuscript handler (mirrors onManuscriptGenerate but routes to the queue). */
    private onManuscriptQueue:
        | ((
              mode: ManuscriptAnalysisMode,
              scope: ManuscriptScope,
              compaction: CompactionStrategy,
              customInstruction?: string
          ) => void)
        | null = null;
    private queueHandlers: FeedbackQueueHandlers | null = null;

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

    setManuscriptGenerateHandler(
        handler: (
            mode: ManuscriptAnalysisMode,
            scope: ManuscriptScope,
            compaction: CompactionStrategy,
            customInstruction?: string
        ) => void
    ): void {
        this.onManuscriptGenerate = handler;
    }

    /** Provide the plugin reference (used by the Queue subtab). */
    setPlugin(plugin: EventideQuillPlugin): void {
        this.plugin = plugin;
    }

    /** Handler for editorial feedback queued (not run interactively) from the Create sub-tab. */
    setEditorialQueueHandler(handler: (personaId: string, customInstruction?: string) => void): void {
        this.onEditorialQueue = handler;
    }

    /** Handler for critical analysis queued from the Create sub-tab. */
    setCriticalQueueHandler(
        handler: (mode: AnalysisMode, scope: ScopeChoice, customInstruction?: string) => void
    ): void {
        this.onCriticalQueue = handler;
    }

    /** Handler for manuscript analysis queued from the Create sub-tab. */
    setManuscriptQueueHandler(
        handler: (
            mode: ManuscriptAnalysisMode,
            scope: ManuscriptScope,
            compaction: CompactionStrategy,
            customInstruction?: string
        ) => void
    ): void {
        this.onManuscriptQueue = handler;
    }

    /** Handlers for the Queue sub-tab's per-job actions + manual run. */
    setQueueHandlers(handlers: FeedbackQueueHandlers): void {
        this.queueHandlers = handlers;
    }

    /** Refresh the Queue sub-tab live, or just the badge if another sub-tab is active. */
    feedbackQueueChanged(): void {
        if (this.subtab === 'queue' && this.containerEl) {
            this.render();
            return;
        }
        // On other sub-tabs, a full re-render would disturb the custom-instruction
        // textarea — update only the cached badge element.
        this.updateQueueBadge();
    }

    /** Update the pre-generation token estimate display for the manuscript engine.
     *  Discards the update if a newer scope/compaction request has superseded it. */
    setManuscriptTokenEstimate(estimate: { estimated: number; max: number } | null): void {
        if (this.manuscriptSettingsVersion !== this._manuscriptEstimateRequestVersion) return;
        this.manuscriptTokenEstimate = estimate;
        if (this.engine === 'manuscript' && this.subtab === 'create' && this.containerEl) this.render();
    }

    /** Internal version tracker for stale-promise protection in setManuscriptTokenEstimate. */
    private _manuscriptEstimateRequestVersion = 0;

    /** Request a fresh token estimate.
     *  Increments the settings version so in-flight older promises are discarded.
     *  Call this after manuscript scope or compaction changes.
     *  The caller is responsible for calling render() to update the UI. */
    refreshManuscriptTokenEstimate(): void {
        this.manuscriptSettingsVersion++;
        this._manuscriptEstimateRequestVersion = this.manuscriptSettingsVersion;
        // The sidebar's setManuscriptTokenEstimate callback is the single source
        // of truth for fetching estimates.  Trigger a re-render so the sidebar
        // fires the async estimate request.
        if (this.containerEl && this.engine === 'manuscript' && this.subtab === 'create') {
            this.render();
        }
    }

    /** Whether the manuscript engine is the currently selected engine on the Create tab. */
    isManuscriptEngineActive(): boolean {
        return this.engine === 'manuscript' && this.subtab === 'create';
    }

    /** Get the current manuscript scope selection. */
    getManuscriptScope(): ManuscriptScope {
        return this.currentManuscriptScope;
    }

    /** Get the current compaction strategy selection. */
    getManuscriptCompaction(): CompactionStrategy {
        return this.currentCompactionStrategy;
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

    private async estimateEmbedFolderTokens(parsed: {
        folderPath: string;
        mode: 'top-k' | 'full';
    }): Promise<number | null> {
        const cachePath = normalizePath(`${parsed.folderPath}/quill-embeddings.json`);
        const entries: { chunkText?: string }[] = [];
        try {
            const exists = await this.app.vault.adapter.exists(cachePath);
            if (exists) {
                const raw = await this.app.vault.adapter.read(cachePath);
                const data = JSON.parse(raw) as { entries?: { chunkText?: string }[] };
                if (data && Array.isArray(data.entries)) {
                    entries.push(...data.entries);
                }
            }
        } catch {
            // Best-effort
        }

        let totalChars = 0;
        if (parsed.mode === 'full' || entries.length === 0) {
            for (const entry of entries) {
                totalChars += (entry.chunkText ?? '').length;
            }
        } else {
            let avgChars = 0;
            for (const entry of entries) {
                avgChars += (entry.chunkText ?? '').length;
            }
            avgChars = Math.ceil(avgChars / entries.length);
            const topK = this.folderTopKOverrides[parsed.folderPath] ?? this.embeddingsTopK;
            totalChars = avgChars * Math.min(topK, entries.length);
        }

        return Math.ceil(totalChars / 4);
    }

    async addContextFile(filePath: string): Promise<void> {
        if (this.contextFilePaths.includes(filePath)) return;
        this.contextFilePaths.push(filePath);
        try {
            const parsed = parseEmbedFolderPath(filePath);
            if (parsed) {
                const tokens = await this.estimateEmbedFolderTokens(parsed);
                if (tokens !== null && this.contextFilePaths.includes(filePath)) {
                    this.contextFileTokens.set(filePath, tokens);
                }
            } else {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    const content = await this.app.vault.cachedRead(file);
                    if (this.contextFilePaths.includes(filePath)) {
                        this.contextFileTokens.set(filePath, Math.ceil(content.length / 4));
                    }
                }
            }
        } catch {
            if (this.contextFilePaths.includes(filePath)) {
                this.contextFileTokens.set(filePath, 0);
            }
        }
        if (this.containerEl) this.render();
    }

    removeContextFile(filePath: string): void {
        this.contextFilePaths = this.contextFilePaths.filter((p) => p !== filePath);
        this.contextFileTokens.delete(filePath);
        if (this.containerEl) this.render();
    }

    /** Recalculate token estimates for all embed-folder context files. */
    private async refreshEmbedContextTokenEstimates(): Promise<void> {
        for (const filePath of this.contextFilePaths) {
            const parsed = parseEmbedFolderPath(filePath);
            if (parsed) {
                const tokens = await this.estimateEmbedFolderTokens(parsed);
                if (tokens !== null) {
                    this.contextFileTokens.set(filePath, tokens);
                }
            }
        }
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
        const parsed = parseEmbedFolderPath(filePath);
        if (parsed) {
            const tokens = await this.estimateEmbedFolderTokens(parsed);
            if (tokens !== null) {
                this.chatContextFiles.setTokenOverride(filePath, tokens);
            }
        }
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

    /**
     * Load a completed report into the Results sub-tab for follow-up discussion.
     * Like {@link startLoading} but skips the loading state — the report is
     * already complete. The plugin seeds the conversation messages separately.
     */
    loadReportForDiscussion(engine: ReviewEngine, headerLabel: string, reportText: string): void {
        this.activeEngine = engine;
        this.headerLabel = headerLabel;
        this.subLabel = 'follow-up discussion';
        this.resultsState = 'complete';
        this.reportText = reportText;
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
            } else {
                // Stream can fail before any assistant chunk exists (or after a
                // user turn). Push a fresh assistant message so the error is
                // always surfaced rather than silently dropped.
                this.chatHistory.push({ role: 'assistant', content: `Error: ${message}` });
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
        const isManuscript = this.activeEngine === 'manuscript';
        const defaultName = `${
            isCritical ? 'quill-analysis' : isManuscript ? 'quill-manuscript-analysis' : 'quill-conversation'
        }-${timestamp}.md`;
        const title = isCritical
            ? 'Save analysis report'
            : isManuscript
              ? 'Save manuscript analysis'
              : 'Save conversation';
        new FilenameModal(
            this.app,
            defaultName,
            async (path: string) => {
                const normalizedPath = normalizePath(path.endsWith('.md') ? path : `${path}.md`);
                const lines: string[] = [];
                lines.push(
                    isCritical
                        ? '# Quill critical analysis'
                        : isManuscript
                          ? '# Quill manuscript analysis'
                          : '# Quill feedback conversation'
                );
                lines.push('');
                lines.push(`*Saved on ${new Date().toLocaleString()}*`);
                if (isCritical || isManuscript) {
                    lines.push(`*Mode: ${this.headerLabel}*`);
                }
                lines.push('');

                if (this.reportText) {
                    lines.push(isCritical || isManuscript ? '## Report' : '## Initial feedback');
                    lines.push('');
                    lines.push(this.reportText);
                    lines.push('');
                }
                if (this.chatHistory.length > 0) {
                    lines.push(isCritical || isManuscript ? '## Follow-up discussion' : '## Conversation');
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
            // Critical engine: the override already covers the analysis
            // conversation. Editorial manuscript tokens (totalContextTokens)
            // are not part of a critical request, so only the override plus
            // shared chat reference files count here.
            const totalTokens = this.contextTokenOverride + this.getChatContextTokens();
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
        const token = ++this.renderToken;
        this.renderPending = true;
        this.unloadAndClearContainer();
        this.renderSubtabBar();
        if (this.subtab === 'create') {
            this.renderCreateTab();
            if (token === this.renderToken) this.renderPending = false;
        } else if (this.subtab === 'queue') {
            this.renderQueueTab();
            if (token === this.renderToken) this.renderPending = false;
        } else {
            void this.renderResultsTab(token);
        }
    }

    private renderSubtabBar(): void {
        if (!this.containerEl) return;
        const bar = this.containerEl.createDiv({ cls: 'quill-sidebar__subtab-bar' });
        this.queueBadgeEl = null;
        const tabs: { id: ReviewSubtab; label: string }[] = [
            { id: 'create', label: 'New review' },
            { id: 'results', label: 'Results' },
            { id: 'queue', label: 'Queue' }
        ];
        for (const tab of tabs) {
            const btn = bar.createEl('button', {
                cls: `quill-sidebar__subtab${this.subtab === tab.id ? ' quill-sidebar__subtab--active' : ''}`
            });
            btn.createEl('span', { text: tab.label });
            if (tab.id === 'queue') {
                this.queueBadgeEl = btn.createEl('span', { cls: 'quill-sidebar__subtab-badge' });
            }
            this.renderEvents.registerDomEvent(btn, 'click', () => {
                this.subtab = tab.id;
                this.render();
            });
        }
        this.updateQueueBadge();
    }

    /** Update the cached badge element's text/visibility without a full re-render. */
    private updateQueueBadge(): void {
        if (!this.queueBadgeEl) return;
        const count = this.plugin ? feedbackQueueBadgeCount(this.plugin.getFeedbackJobs()) : 0;
        if (count > 0) {
            this.queueBadgeEl.setText(String(count));
            this.queueBadgeEl.show();
        } else {
            this.queueBadgeEl.hide();
        }
    }

    // ========================================================================
    // Create sub-tab
    // ========================================================================

    private renderCreateTab(): void {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar__content-plain' });
        // Track scroll so option-change re-renders preserve position (only the
        // Review-type/engine picker resets it — it restructures the whole form).
        this.renderEvents.registerDomEvent(scroll, 'scroll', () => {
            this.createScrollTop = scroll.scrollTop;
        });

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
        } else if (this.engine === 'critical') {
            this.renderModeSection(scroll);
            this.renderScopeSection(scroll);
        } else {
            this.renderManuscriptModeSection(scroll);
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
        this.renderEvents.registerDomEvent(customArea, 'input', () => {
            this.customInstruction = customArea.value;
        });

        // Queue-mode toggle (all engines). When on, persona clicks + Generate
        // route to the async queue instead of running interactively, and stay on
        // Create so the writer can queue several.
        const toggleWrap = scroll.createDiv({ cls: 'quill-feedback-queue__toggle' });
        const queueToggle = toggleWrap.createEl('input', { attr: { type: 'checkbox' } });
        queueToggle.checked = this.queueMode;
        toggleWrap.createEl('span', { text: 'Queue instead of running' });
        this.renderEvents.registerDomEvent(queueToggle, 'change', () => {
            this.queueMode = queueToggle.checked;
            if (this.containerEl) this.render();
        });

        const buttonLabel = this.queueMode
            ? this.engine === 'editorial'
                ? 'Add feedback to queue'
                : 'Add analysis to queue'
            : this.engine === 'editorial'
              ? 'Generate feedback'
              : this.engine === 'critical'
                ? 'Run analysis'
                : 'Run manuscript analysis';

        const generateBtn = scroll.createEl('button', {
            cls: 'quill-form__submit mod-cta',
            text: buttonLabel
        });
        this.renderEvents.registerDomEvent(generateBtn, 'click', () => this.triggerGenerate());

        // Restore the preserved scroll position now that all content is laid out.
        scroll.scrollTop = this.createScrollTop;
    }

    // ========================================================================
    // Queue sub-tab
    // ========================================================================

    private renderQueueTab(): void {
        if (!this.containerEl) return;
        const scroll = this.containerEl.createDiv({ cls: 'quill-sidebar__content-plain quill-feedback-queue' });
        if (!this.plugin || !this.queueHandlers) {
            scroll.createEl('p', { cls: 'quill-feedback-queue__empty', text: 'Queue unavailable.' });
            return;
        }
        renderFeedbackQueue(scroll, this.plugin, this.renderEvents, this.queueHandlers);
    }

    private renderEnginePicker(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Review type' });

        const engines: { id: ReviewEngine; label: string; desc: string }[] = [
            { id: 'critical', label: 'Critical analysis', desc: 'Targeted consistency checks with line refs.' },
            { id: 'editorial', label: 'Editor feedback', desc: 'Persona-driven review of selected manuscripts.' },
            { id: 'manuscript', label: 'Manuscript analysis', desc: 'Full-manuscript structural diagnostics.' }
        ];

        const row = container.createDiv({ cls: 'quill-option-picker' });
        for (const eng of engines) {
            const btn = row.createEl('button', { cls: 'quill-option-picker__option' });
            if (this.engine === eng.id) btn.addClass('quill-option-picker__option--active');
            btn.createEl('span', { cls: 'quill-option-picker__name', text: eng.label });
            btn.createEl('span', { cls: 'quill-option-picker__desc', text: eng.desc });
            this.renderEvents.registerDomEvent(btn, 'click', () => {
                this.engine = eng.id;
                // The engine picker restructures the entire form — reset scroll.
                this.createScrollTop = 0;
                if (this.containerEl) this.render();
            });
        }
    }

    // --- Editorial sections ---

    private renderManuscriptsSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Additional manuscripts' });

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
                text: 'The active document is always reviewed. Add additional files here for more context.',
                cls: 'quill-empty-hint'
            });
        } else {
            for (const filePath of this.contextFilePaths) {
                const tokens = this.contextFileTokens.get(filePath) ?? 0;
                const item = list.createDiv({ cls: 'quill-review-panel__file-item' });
                const parsed = parseEmbedFolderPath(filePath);
                const name = parsed
                    ? embedFolderLabel(parsed.folderPath, parsed.mode)
                    : (filePath.split('/').pop() ?? filePath);
                item.createEl('span', { cls: 'quill-review-panel__file-name', text: name });
                item.createEl('span', { cls: 'quill-review-panel__file-tokens', text: `~${tokens} tokens` });
                const remove = item.createEl('button', { cls: 'quill-review-panel__file-remove', text: '\u00d7' });
                this.renderEvents.registerDomEvent(remove, 'click', () => this.removeContextFile(filePath));
            }
        }

        const addBtn = section.createEl('button', {
            cls: 'quill-review-panel__file-add',
            text: '+ add file'
        });
        this.renderEvents.registerDomEvent(addBtn, 'click', () => {
            const exclude = [...this.contextFilePaths, ...this.chatContextFiles.getFiles()];
            new VaultFileSuggestModal(
                this.app,
                (item) => {
                    const path =
                        item.kind === 'file' ? item.file.path : buildEmbedFolderPath(item.folderPath, item.mode);
                    void this.addContextFile(path);
                },
                exclude,
                'Select a manuscript to include as context...',
                this.showFullEmbed
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
            this.renderEvents.registerDomEvent(btn, 'click', () => {
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
            this.renderEvents.registerDomEvent(btn, 'click', () => {
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
            this.renderEvents.registerDomEvent(btn, 'click', () => {
                this.currentScope = scope.id;
                if (this.containerEl) this.render();
            });
        }
    }

    // --- Manuscript mode section ---

    private renderManuscriptModeSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Analysis mode' });

        const modes = container.createDiv({ cls: 'quill-option-picker' });
        for (const mode of MANUSCRIPT_ANALYSIS_MODES) {
            const btn = modes.createEl('button', { cls: 'quill-option-picker__option' });
            if (this.currentManuscriptMode === mode.id) btn.addClass('quill-option-picker__option--active');
            btn.createEl('span', { cls: 'quill-option-picker__name', text: mode.label });
            btn.createEl('span', { cls: 'quill-option-picker__desc', text: mode.description });
            this.renderEvents.registerDomEvent(btn, 'click', () => {
                this.currentManuscriptMode = mode.id;
                // Big-picture modes only make sense over a full manuscript;
                // force scope off "Surrounding chapters" when one is selected.
                if (mode.fullManuscriptOnly) {
                    this.currentManuscriptScope = { kind: 'full' };
                    this.refreshManuscriptTokenEstimate();
                }
                if (this.containerEl) this.render();
            });
        }

        this.renderManuscriptScopeSection(container);
        this.renderManuscriptCompactionSection(container);
        this.renderManuscriptTokenEstimate(container);
    }

    private renderManuscriptScopeSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Scope' });

        // Big-picture modes (subplots, theme, genre) only make sense over a
        // full manuscript. Lock the scope to "Full" and disable the alternative.
        const fullOnly =
            this.currentManuscriptMode !== '' &&
            getManuscriptAnalysisModeById(this.currentManuscriptMode)?.fullManuscriptOnly === true;

        const scopeRow = container.createDiv({ cls: 'quill-review-panel__scope-row' });
        const isFull = fullOnly || this.currentManuscriptScope.kind === 'full';

        const fullBtn = scopeRow.createEl('button', {
            cls: `quill-review-panel__scope-btn${isFull ? ' quill-review-panel__scope-btn--active' : ''}`,
            text: 'Full manuscript',
            title: 'Analyze the entire manuscript (all chapters).'
        });
        this.renderEvents.registerDomEvent(fullBtn, 'click', () => {
            this.currentManuscriptScope = { kind: 'full' };
            this.refreshManuscriptTokenEstimate();
        });

        const surrBtn = scopeRow.createEl('button', {
            cls: `quill-review-panel__scope-btn${this.currentManuscriptScope.kind === 'surrounding' ? ' quill-review-panel__scope-btn--active' : ''}`,
            text: 'Surrounding chapters',
            title: fullOnly
                ? 'Big-picture modes (subplots, theme, genre) require the full manuscript.'
                : 'Chapter at Cursor plus n chapters before and after.'
        });
        if (fullOnly) {
            surrBtn.disabled = true;
            surrBtn.addClass('quill-review-panel__scope-btn--disabled');
        } else {
            this.renderEvents.registerDomEvent(surrBtn, 'click', () => {
                this.currentManuscriptScope = { kind: 'surrounding', count: 1 };
                this.refreshManuscriptTokenEstimate();
            });
        }

        if (!fullOnly && this.currentManuscriptScope.kind === 'surrounding') {
            const countRow = section.createDiv({ cls: 'quill-review-panel__scope-row' });
            countRow.createEl('span', { cls: 'quill-form__label', text: 'Chapters before/after:' });

            const count = this.currentManuscriptScope.count;
            const decBtn = countRow.createEl('button', {
                cls: 'quill-review-panel__scope-btn',
                text: '\u2212',
                title: 'Decrease surrounding chapter count'
            });
            this.renderEvents.registerDomEvent(decBtn, 'click', () => {
                this.currentManuscriptScope = { kind: 'surrounding', count: Math.max(1, count - 1) };
                this.refreshManuscriptTokenEstimate();
            });

            countRow.createEl('span', {
                cls: 'quill-review-panel__scope-count',
                text: String(count)
            });

            const incBtn = countRow.createEl('button', {
                cls: 'quill-review-panel__scope-btn',
                text: '+',
                title: 'Increase surrounding chapter count'
            });
            this.renderEvents.registerDomEvent(incBtn, 'click', () => {
                this.currentManuscriptScope = { kind: 'surrounding', count: Math.min(10, count + 1) };
                this.refreshManuscriptTokenEstimate();
            });
        }
    }

    private renderManuscriptCompactionSection(container: HTMLElement): void {
        const section = container.createDiv({ cls: 'quill-form__section' });
        section.createEl('p', { cls: 'quill-form__label', text: 'Text compaction' });

        const strategies: { id: CompactionStrategy; label: string; hint: string; recommended?: boolean }[] = [
            {
                id: 'embed',
                label: 'Embed + retrieve',
                hint: 'Chunk the manuscript, embed each chunk, retrieve the most relevant by similarity.',
                recommended: true
            },
            {
                id: 'compress',
                label: 'Compress with AI',
                hint: 'Use the chat model to summarize each chunk. Slower and less accurate.'
            },
            {
                id: 'full',
                label: 'Full text',
                hint: 'Send the raw manuscript text. Best for small manuscripts or large context windows.'
            }
        ];

        const row = container.createDiv({ cls: 'quill-review-panel__scope-row' });
        for (const strat of strategies) {
            const label = strat.recommended ? `${strat.label} (recommended)` : strat.label;
            const btn = row.createEl('button', {
                cls: `quill-review-panel__scope-btn${this.currentCompactionStrategy === strat.id ? ' quill-review-panel__scope-btn--active' : ''}`,
                text: label,
                title: strat.hint
            });
            this.renderEvents.registerDomEvent(btn, 'click', () => {
                this.currentCompactionStrategy = strat.id;
                this.refreshManuscriptTokenEstimate();
            });
        }

        if (this.currentCompactionStrategy === 'compress') {
            section.createEl('p', {
                cls: 'quill-form__hint',
                text: 'Uses your chat model to compress each chunk — less accurate than embedding. Set up an embed model in settings for better results.'
            });
        }
    }

    private renderManuscriptTokenEstimate(container: HTMLElement): void {
        if (!this.manuscriptTokenEstimate) return;
        const { estimated, max } = this.manuscriptTokenEstimate;
        const pct = max > 0 ? (estimated / max) * 100 : 0;

        let cls = 'quill-review-panel__token-estimate';
        let suffix = '';
        if (pct > 100) {
            cls += ' quill-review-panel__token-estimate--over';
            suffix = ' \u26a0 Exceeds budget \u2014 LLM may trim context or error';
        } else if (pct > 90) {
            cls += ' quill-review-panel__token-estimate--warn';
            suffix = " \u26a0 Approaching model's context window limit";
        }

        const text = `\u2248 ${estimated.toLocaleString()} / ${max.toLocaleString()} tokens (${Math.round(pct)}% of budget)${suffix}`;
        container.createEl('p', { cls, text });
    }

    // --- Generate dispatch ---

    private triggerGenerate(): void {
        if (this.engine === 'editorial') {
            // Editorial requires a manuscript. Persona buttons call triggerEditorial
            // directly; the Generate button is only for custom instructions.
            if (!this.customInstruction.trim()) {
                new Notice('Quill: Enter a custom instruction to generate editorial feedback.');
                return;
            }
            this.triggerEditorial('custom');
        } else if (this.engine === 'critical') {
            this.triggerCritical();
        } else {
            this.triggerManuscript();
        }
    }

    private triggerEditorial(personaId: string): void {
        // No manuscript-count check needed — the active document is always the
        // primary manuscript. The manuscripts list is for ADDITIONAL files only.
        const instruction = personaId === 'custom' ? this.customInstruction : undefined;
        if (this.queueMode) {
            // Queue and stay on Create so the writer can queue several. The Notice +
            // badge update fire from submitFeedbackJob's feedbackQueueChanged.
            this.onEditorialQueue?.(personaId, instruction);
            return;
        }
        this.onEditorialGenerate?.(personaId, instruction);
    }

    private triggerCritical(): void {
        if (!this.currentMode) {
            new Notice('Quill: Pick an analysis mode first.');
            return;
        }
        const instruction = this.customInstruction || undefined;
        if (this.queueMode) {
            this.onCriticalQueue?.(this.currentMode, this.currentScope, instruction);
            return;
        }
        this.onCriticalGenerate?.(this.currentMode, this.currentScope, instruction);
    }

    private triggerManuscript(): void {
        if (!this.currentManuscriptMode) {
            new Notice('Quill: Pick a manuscript analysis mode first.');
            return;
        }
        const instruction = this.customInstruction || undefined;
        if (this.queueMode) {
            this.onManuscriptQueue?.(
                this.currentManuscriptMode,
                this.currentManuscriptScope,
                this.currentCompactionStrategy,
                instruction
            );
            return;
        }
        this.onManuscriptGenerate?.(
            this.currentManuscriptMode,
            this.currentManuscriptScope,
            this.currentCompactionStrategy,
            instruction
        );
    }

    // ========================================================================
    // Results sub-tab (shared, engine-aware header)
    // ========================================================================

    private async rerenderResultsTab(): Promise<void> {
        if (!this.containerEl) return;
        this.renderToken++;
        this.unloadAndClearContainer();
        this.renderSubtabBar();
        await this.renderResultsTab(this.renderToken);
    }

    private async renderResultsTab(token: number): Promise<void> {
        try {
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
                if (token !== this.renderToken) return;

                const controls = scroll.createDiv({ cls: 'quill-review-panel__controls' });
                const newBtn = controls.createEl('button', {
                    cls: 'quill-review-panel__nav-btn',
                    text: 'New review'
                });
                this.renderEvents.registerDomEvent(newBtn, 'click', () => this.resetResults());

                // Chat section — only render when there's history or an in-flight
                // follow-up. Skipping the empty section avoids a stray bordered
                // strip appearing alongside the chat input bar.
                if (this.chatHistory.length > 0 || this.chatLoading) {
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
                                if (token !== this.renderToken) return;
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
                }
            } else if (this.resultsState === 'error') {
                header.createEl('span', { cls: 'quill-review-panel__status', text: 'Failed' });
                scroll.createEl('p', { cls: 'quill-review-panel__error-text', text: this.reportText });
                const controls = scroll.createDiv({ cls: 'quill-review-panel__controls' });
                const retryBtn = controls.createEl('button', {
                    cls: 'quill-review-panel__nav-btn',
                    text: 'Back to create'
                });
                this.renderEvents.registerDomEvent(retryBtn, 'click', () => this.resetResults());
            }

            // Bottom area (chat input) — present from the moment a review starts
            // (loading) so the bar doesn't pop in when streaming ends. Disabled
            // while the initial report is streaming; enabled once complete.
            if (this.resultsState === 'loading' || this.resultsState === 'complete') {
                this.renderChatBottom(scroll, this.resultsState !== 'complete');
            }
        } finally {
            if (token === this.renderToken) {
                this.renderPending = false;
            }
        }
    }

    private renderChatBottom(_scroll: HTMLElement, disabled = false): void {
        if (!this.containerEl) return;
        const bottomArea = this.containerEl.createDiv({ cls: 'quill-chat-panel__bottom' });

        const btnRow = bottomArea.createDiv({ cls: 'quill-chat-panel__btn-row' });
        const addCtxBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u00b1',
            title: 'Add file to context'
        });
        addCtxBtn.disabled = disabled;
        this.renderEvents.registerDomEvent(addCtxBtn, 'click', () => {
            if (disabled) return;
            const exclude =
                this.activeEngine === 'editorial'
                    ? [...this.chatContextFiles.getFiles(), ...this.contextFilePaths]
                    : [...this.chatContextFiles.getFiles()];
            new VaultFileSuggestModal(
                this.app,
                (item) => {
                    const path =
                        item.kind === 'file' ? item.file.path : buildEmbedFolderPath(item.folderPath, item.mode);
                    void this.addChatContextFile(path);
                },
                exclude,
                undefined,
                this.showFullEmbed
            ).open();
        });
        const saveBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\ud83d\udcbe',
            title: 'Save to file'
        });
        saveBtn.disabled = disabled;
        this.renderEvents.registerDomEvent(saveBtn, 'click', () => {
            if (!disabled) this.saveConversation();
        });
        const compactBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn quill-chat-panel__action-btn--compact',
            text: '\u00bb\u00bb',
            title: 'Compact conversation'
        });
        compactBtn.disabled = disabled;
        this.renderEvents.registerDomEvent(compactBtn, 'click', () => {
            if (!disabled) this.onCompact?.();
        });
        const newChatBtn = btnRow.createEl('button', {
            cls: 'quill-chat-panel__action-btn',
            text: '\u2713',
            title: 'New chat'
        });
        newChatBtn.disabled = disabled;
        this.renderEvents.registerDomEvent(newChatBtn, 'click', () => {
            if (!disabled) this.onNewChat?.(false);
        });
        btnRow.createEl('div', { cls: 'quill-chat-panel__btn-spacer' });
        const actionBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-panel__send-btn mod-cta${this.chatLoading ? ' quill-cowriter-panel__send-btn--stop' : ''}`,
            text: disabled ? 'Generating\u2026' : this.chatLoading ? 'Stop' : 'Send'
        });
        actionBtn.disabled = disabled;

        const taRow = bottomArea.createDiv({ cls: 'quill-chat-panel__ta-row' });
        const input = taRow.createEl('textarea', {
            cls: 'quill-chat-panel__input',
            placeholder: disabled ? 'Generating report\u2026' : 'Ask a follow-up\u2026'
        });
        input.disabled = disabled;

        // Inline file-mention autocomplete for @-references
        if (!disabled) {
            new FileMentionSuggest(this.app, input, this.renderEvents);
        }

        const doSend = () => {
            if (this.chatLoading) return;
            let text = input.value.trim();
            if (!text) return;

            // Resolve @-mentioned files and add them to context.
            const { resolvedPaths, cleanedText } = resolveAtMentions(text, this.app.vault);
            for (const path of resolvedPaths) {
                void this.addChatContextFile(path);
            }
            text = cleanedText;

            this.chatHistory.push({ role: 'user', content: text });
            input.value = '';
            this.chatLoading = true;
            this.userScrolledUp = false;

            actionBtn.setText('Stop');
            actionBtn.addClass('quill-cowriter-panel__send-btn--stop');

            let chatSection = this.containerEl?.querySelector('.quill-chat-panel__section');
            if (!chatSection) {
                // First follow-up — chat section hasn't been rendered yet.
                // Create it so the user bubble and streaming ellipsis have
                // a container until the next full rerender.
                const scroll = this.containerEl?.querySelector('.quill-sidebar__content-plain');
                if (scroll) {
                    chatSection = scroll.createDiv({ cls: 'quill-chat-panel__section' });
                }
            }
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
        this.renderEvents.registerDomEvent(actionBtn, 'click', () => {
            if (disabled) return;
            if (this.chatLoading) doStop();
            else doSend();
        });
        this.renderEvents.registerDomEvent(input, 'keydown', (e) => {
            if (disabled || this.chatLoading) return;
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
                    : this.activeEngine === 'manuscript'
                      ? 'manuscript'
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
