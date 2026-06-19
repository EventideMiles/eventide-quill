import { Component, ItemView, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import { LintResult, RULE_INFO, FIXABLE_RULES } from '../core/linter/types';
import { FIXES } from '../core/linter/fixes';
import { applyReplacement } from '../core/linter/apply-fix';
import { findEditorView } from '../utils/find-editor';
import { FixWithAiModal } from './fix-with-ai-modal';
import { renderContextTab } from './context-panel';
import { ReviewPanel } from './review-panel';
import { CoWriterPanel } from './co-writer-panel';
import { renderDashboardTab } from './dashboard-panel';
import type { InputMode } from './co-writer-panel';
import type { CoWriterChatMessage, CoWriterOption, DraftState, CoachPhase } from '../ai/co-writer';
import type { ProposedEdit } from '../core/change-set';
import type EventideQuillPlugin from '../main';
import type { ContextAssembly } from '../core/context-engine/types';

export const QUILL_VIEW_TYPE = 'quill-sidebar';

type TopTab = 'linter' | 'context' | 'review' | 'cowriter' | 'dashboard';
type LinterSubTab = 'results' | 'details';

export class QuillSidebarView extends ItemView {
    private results: LintResult[] = [];
    private selectedResult: LintResult | null = null;
    private activeTopTab: TopTab = 'linter';
    private activeLinterSubTab: LinterSubTab = 'results';
    private container!: HTMLElement;
    private tabBar!: HTMLElement;
    private content!: HTMLElement;
    private renderEvents: Component | null = null;
    private plugin: EventideQuillPlugin;
    /** Captured at lint time so the passage context is available even when the sidebar has focus. */
    private cachedEditorText: string | null = null;
    /** Current context assembly to display in the Context tab. */
    private currentAssembly: ContextAssembly | null = null;
    /** Review panel for the Review tab (editorial feedback + critical analysis). */
    private reviewPanel: ReviewPanel | null = null;
    /** Co-writer panel for the Co-writer tab. */
    private coWriterPanel: CoWriterPanel | null = null;

    /** Create the sidebar view for the given workspace leaf. */
    constructor(leaf: WorkspaceLeaf, plugin: EventideQuillPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    /** Return the unique view type identifier. */
    getViewType(): string {
        return QUILL_VIEW_TYPE;
    }

    /** Return the human-readable view title. */
    getDisplayText(): string {
        return 'Quill';
    }

    /** Return the icon name used in the sidebar tab. */
    getIcon(): string {
        return 'feather';
    }

    /** Initialize the sidebar DOM structure on first open. */
    async onOpen() {
        this.container = this.contentEl.createDiv({ cls: 'quill-sidebar' });
        this.tabBar = this.container.createDiv({ cls: 'quill-sidebar__tab-bar' });
        this.content = this.container.createDiv({ cls: 'quill-sidebar__content' });
        this.render();

        // Re-render context, co-writer, and review tabs when the active file
        // changes (each shows the active document header / derives from it).
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (
                    this.activeTopTab === 'context' ||
                    this.activeTopTab === 'cowriter' ||
                    this.activeTopTab === 'review' ||
                    this.activeTopTab === 'dashboard'
                ) {
                    this.render();
                }
            })
        );
    }

    /** Update the stored results and cache the editor text for passage context. */
    setResults(results: LintResult[]) {
        this.results = results;
        const view = this.getEditorView();
        if (view) {
            this.cachedEditorText = view.editor.getValue();
        }
        if (this.activeTopTab === 'linter' && this.activeLinterSubTab === 'results') {
            this.render();
        }
    }

    /** Update the context assembly for the Context tab. */
    setContextAssembly(assembly: ContextAssembly | null): void {
        this.currentAssembly = assembly;
        this.render();
    }

    /** Switch to the details tab for the given result and scroll the editor to it. */
    showResultDetail(result: LintResult) {
        this.selectedResult = result;
        this.activeTopTab = 'linter';
        this.activeLinterSubTab = 'details';
        const view = this.getEditorView();
        if (view) {
            this.cachedEditorText = view.editor.getValue();
        }
        this.render();
        this.jumpToResult(result);
    }

    /** Find the editor for the linted file, even if the sidebar has focus. */
    private getEditorView(): MarkdownView | null {
        return findEditorView(this.app, this.plugin.lintActiveFile);
    }

    /** Scroll the editor cursor to the position described by `result`. */
    private jumpToResult(result: LintResult) {
        const view = this.getEditorView();
        if (!view) return;

        const editor = view.editor;
        const line = result.line - 1;
        const col = result.column;

        editor.setCursor({ line, ch: col });
        editor.scrollIntoView({ from: { line, ch: col }, to: { line, ch: col } }, true);
    }

    /** Apply the auto-fix associated with `result` to the active editor. */
    private applyFix(result: LintResult) {
        const fix = FIXES[result.rule];
        if (!fix) return;

        const view = this.getEditorView();
        if (!view) return;

        const editor = view.editor;
        const text = editor.getValue();
        const replacement = fix.apply(text, result.line, result.column, result.length);
        if (replacement === null) return;

        applyReplacement(editor, result, replacement);
    }

    /** Retrieve the full text of the active editor document. */
    private getEditorText(): string | null {
        const view = this.getEditorView();
        if (view) return view.editor.getValue();
        return this.cachedEditorText;
    }

    /** Apply an AI-suggested replacement to the flagged span in the editor. */
    private applyAiFix(result: LintResult, replacement: string): void {
        const view = this.getEditorView();
        if (!view) return;

        applyReplacement(view.editor, result, replacement);
    }

    /** Open the Fix with AI modal for a given lint result. */
    private openFixWithAiModal(result: LintResult, customInstruction?: string): void {
        const editorText = this.getEditorText();
        if (!editorText) return;

        new FixWithAiModal(
            this.app,
            this.plugin,
            result,
            editorText,
            (replacement: string) => {
                this.applyAiFix(result, replacement);
                this.activeLinterSubTab = 'results';
                this.render();
            },
            customInstruction
        ).open();
    }

    /** Get the full paragraph (contiguous non-blank lines) containing the lint result. */
    private getPassageContext(result: LintResult): {
        lines: { text: string; index: number; isFlagged: boolean }[];
        flaggedStart: number;
        flaggedEnd: number;
    } | null {
        const view = this.getEditorView();
        const editorText = view ? view.editor.getValue() : this.cachedEditorText;

        if (!editorText) return null;

        const allLines = editorText.split('\n');
        const totalLines = allLines.length;
        const lineIndex = result.line - 1;
        const flaggedStart = result.column;
        const flaggedEnd = result.column + result.length;

        const isBlank = (text: string) => text.trim().length === 0;

        let paraStart = lineIndex;
        while (paraStart > 0) {
            if (isBlank(allLines[paraStart - 1] ?? '')) break;
            paraStart--;
        }

        let paraEnd = lineIndex;
        while (paraEnd < totalLines - 1) {
            if (isBlank(allLines[paraEnd + 1] ?? '')) break;
            paraEnd++;
        }

        const lines: { text: string; index: number; isFlagged: boolean }[] = [];
        for (let i = paraStart; i <= paraEnd; i++) {
            lines.push({
                text: allLines[i] ?? '',
                index: i + 1,
                isFlagged: i === lineIndex
            });
        }

        return { lines, flaggedStart, flaggedEnd };
    }

    /** Switch the active top-level tab. */
    private switchTopTab(tab: TopTab) {
        this.activeTopTab = tab;
        if (tab === 'linter') {
            this.activeLinterSubTab = 'results';
        }
        this.render();
    }

    /** Switch the active linter sub-tab. */
    private switchLinterSubTab(tab: LinterSubTab) {
        this.activeLinterSubTab = tab;
        this.render();
    }

    /** Tear down event listeners and rebuild the sidebar DOM for the current tab. */
    private render() {
        this.renderEvents?.unload();
        this.renderEvents = new Component();
        this.addChild(this.renderEvents);

        this.tabBar.empty();
        this.content.empty();

        this.renderTopTabBar();

        if (this.activeTopTab === 'linter') {
            this.renderLinterSubTabBar();
            if (this.activeLinterSubTab === 'results') {
                this.renderResultsTab();
            } else {
                this.renderDetailsTab();
            }
        } else if (this.activeTopTab === 'context') {
            const ctxScroll = this.content.createDiv({ cls: 'quill-context-panel__scroll' });
            renderContextTab(ctxScroll, this.currentAssembly, this.plugin, this.renderEvents);
        } else if (this.activeTopTab === 'dashboard') {
            const dashScroll = this.content.createDiv({ cls: 'quill-dashboard-panel__scroll' });
            renderDashboardTab(dashScroll, this.plugin, this.renderEvents);
        } else if (this.activeTopTab === 'cowriter') {
            this.renderCoWriterTab();
        } else {
            this.renderReviewTab();
        }
    }

    /** Render the top-level tab bar. */
    private renderTopTabBar() {
        const tabs: { id: TopTab; label: string }[] = [
            { id: 'linter', label: 'Linter' },
            { id: 'context', label: 'Context' },
            { id: 'review', label: 'Review' },
            { id: 'cowriter', label: 'Co-writer' },
            { id: 'dashboard', label: 'Dashboard' }
        ];

        for (const tab of tabs) {
            const btn = this.tabBar.createEl('button', {
                cls: `quill-sidebar__tab${this.activeTopTab === tab.id ? ' quill-sidebar__tab--active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchTopTab(tab.id));
        }
    }

    /** Render the linter sub-tab bar (Results / Details). */
    private renderLinterSubTabBar() {
        const subTabBar = this.content.createDiv({ cls: 'quill-sidebar__subtab-bar' });

        const tabs: { id: LinterSubTab; label: string }[] = [
            { id: 'results', label: 'Results' },
            { id: 'details', label: 'Details' }
        ];

        for (const tab of tabs) {
            const btn = subTabBar.createEl('button', {
                cls: `quill-sidebar__subtab${this.activeLinterSubTab === tab.id ? ' quill-sidebar__subtab--active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchLinterSubTab(tab.id));
        }
    }

    /** Render the Review tab, initializing or re-attaching the ReviewPanel. */
    private renderReviewTab() {
        if (!this.reviewPanel) {
            this.reviewPanel = new ReviewPanel(this.app);
            this.reviewPanel.setEditorialGenerateHandler((personaId, customInstruction) => {
                void this.plugin.requestFeedback(personaId, customInstruction);
            });
            this.reviewPanel.setCriticalGenerateHandler((mode, scope, customInstruction) => {
                void this.plugin.requestAnalysis(mode, scope, customInstruction);
            });
            this.reviewPanel.setChatMessageHandler((message) => {
                // Dispatch to the right engine's chat handler.
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    void this.plugin.sendFeedbackChatMessage(message);
                } else {
                    void this.plugin.sendAnalysisChatMessage(message);
                }
            });
            this.reviewPanel.setCancelGenerationHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    this.plugin.cancelFeedbackGeneration();
                } else {
                    this.plugin.cancelAnalysisGeneration();
                }
            });
            this.reviewPanel.setCompactHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    void this.plugin.compactFeedback();
                } else {
                    void this.plugin.compactAnalysis();
                }
            });
            this.reviewPanel.setNewChatHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    this.plugin.resetFeedbackChat();
                } else {
                    this.plugin.resetAnalysisChat();
                }
            });
        }
        const chat = this.plugin.getDefaultChatProvider();
        if (chat.provider) {
            this.reviewPanel.setMaxAllowedTokens(chat.provider.config.maxContextTokens);
        }
        this.reviewPanel.setContainer(this.content);
    }

    /** Switch to the Review tab. */
    switchToReviewTab(): void {
        this.activeTopTab = 'review';
        this.render();
    }

    /** Switch to the Co-writer tab. */
    switchToCoWriterTab(): void {
        this.activeTopTab = 'cowriter';
        this.render();
    }

    /** Switch to the Dashboard tab. */
    switchToDashboardTab(): void {
        this.activeTopTab = 'dashboard';
        this.render();
    }

    /** Re-render the Dashboard panel if it's the active tab. */
    refreshDashboardPanel(): void {
        if (this.activeTopTab === 'dashboard') {
            this.render();
        }
    }

    /** Re-render the linter results tab if it's active. */
    refreshResultsTab(): void {
        if (this.activeTopTab === 'linter' && this.activeLinterSubTab === 'results') {
            this.render();
        }
    }

    /** Render the co-writer tab, initializing or re-attaching the CoWriterPanel. */
    private renderCoWriterTab(): void {
        if (!this.coWriterPanel) {
            this.coWriterPanel = new CoWriterPanel(this.app, this.plugin);
            this.coWriterPanel.setSendMessageHandler((direction: string) => {
                void this.plugin.sendCoWriterMessage(direction);
            });
            this.coWriterPanel.setDiscussMessageHandler((message: string) => {
                void this.plugin.sendCoWriterDiscussion(message);
            });
            this.coWriterPanel.setApplyOptionHandler((index: number) => {
                const manuscriptPath = this.plugin.coWriterSession.manuscriptPath;
                const view = findEditorView(this.app, manuscriptPath);
                if (view) {
                    void this.plugin.applyCoWriterOption(view.editor, index);
                } else {
                    new Notice('Quill: Open a manuscript to use the co-writer.');
                }
            });
            this.coWriterPanel.setAddContextFileHandler((filePath: string) => {
                void this.plugin.addCoWriterContextFile(filePath);
            });
            this.coWriterPanel.setRemoveContextFileHandler((filePath: string) => {
                void this.plugin.removeCoWriterContextFile(filePath);
            });
            this.coWriterPanel.setGenerateOptionsHandler((direction: string) => {
                void this.plugin.sendCoWriterOptions(direction);
            });
            this.coWriterPanel.setRefreshSuggestionsHandler(() => {
                void this.plugin.sendCoWriterOptions('');
            });
            this.coWriterPanel.setCancelGenerationHandler(() => {
                this.plugin.coWriterSession.cancelGeneration();
            });
            this.coWriterPanel.setCompactHandler(() => {
                void this.plugin.compactCoWriter();
            });
            this.coWriterPanel.setNewChatHandler((clearContext: boolean) => {
                this.plugin.resetCoWriterChat(clearContext);
            });
            this.coWriterPanel.setCoachMessageHandler((message: string) => {
                void this.plugin.sendCoWriterCoach(message);
            });
            this.coWriterPanel.setCoachToOptionsHandler(() => {
                void this.plugin.coWriterCoachToOptions();
            });
            this.coWriterPanel.setEndCoachHandler(() => {
                this.plugin.endCoWriterCoach();
            });
            this.coWriterPanel.setAcceptPlanHandler(() => {
                void this.plugin.coWriterCoachToOptions();
            });
            this.coWriterPanel.setCoachWriteHandler(() => {
                void this.plugin.coWriterCoachWrite();
            });
            this.coWriterPanel.setLinkPlotMapHandler((filePath: string) => {
                void this.plugin.setPlotMapLink(filePath);
            });
            this.coWriterPanel.setClearPlotMapHandler(() => {
                void this.plugin.clearPlotMapLink();
            });
            this.coWriterPanel.setRunFulfillHandler((globalInstruction: string) => {
                void this.plugin.runCoWriterFulfill(globalInstruction);
            });
            this.coWriterPanel.setApproveFulfillSectionHandler((id: number) => {
                this.plugin.approveCoWriterFulfill(id);
            });
            this.coWriterPanel.setRejectFulfillSectionHandler((id: number) => {
                this.plugin.rejectCoWriterFulfill(id);
            });
            this.coWriterPanel.setApproveAllFulfillHandler(() => {
                this.plugin.approveAllCoWriterFulfill();
            });
            this.coWriterPanel.setRejectAllFulfillHandler(() => {
                this.plugin.rejectAllCoWriterFulfill();
            });
        }

        // Sync current state from the session
        const session = this.plugin.coWriterSession;
        if (session) {
            this.coWriterPanel.setDraftState(session.draftState);
            this.coWriterPanel.setThoughtContent(session.thoughtBuffer);
            this.coWriterPanel.setChatHistory(session.chatHistory);
            this.coWriterPanel.setCurrentOptions(session.currentOptions);
            this.coWriterPanel.setOptionsLoading(session.optionsLoading);
            this.coWriterPanel.setCoachPhase(session.coachSession?.phase ?? 'discern');
            this.coWriterPanel.setCoachActive(session.coachActive);
            this.coWriterPanel.setFulfillState(session.fulfillChanges.edits, session.fulfillActive);
        }

        // Sync plot map link from the active manuscript's frontmatter
        this.plugin.refreshPlotMap();
        this.coWriterPanel.setPlotMap(this.plugin.currentPlotMap);
        void this.plugin.updateCoWriterPlotMapTokens();

        // Set provider context limit (same pattern as feedback panel init)
        const chat = this.plugin.getDefaultChatProvider();
        if (chat.provider) {
            this.coWriterPanel.setMaxAllowedTokens(chat.provider.config.maxContextTokens);
        }

        this.coWriterPanel.setContainer(this.content);
    }

    // --- Review tab passthroughs (unified for editorial + critical engines) ---

    reviewStartLoading(engine: 'editorial' | 'critical', headerLabel: string, subLabel?: string): void {
        this.reviewPanel?.startLoading(engine, headerLabel, subLabel);
    }

    reviewAppendChunk(text: string): void {
        this.reviewPanel?.appendChunk(text);
    }

    async reviewFinished(): Promise<void> {
        await this.reviewPanel?.finishLoading();
    }

    reviewError(message: string): void {
        this.reviewPanel?.showError(message);
    }

    reviewResetResults(): void {
        this.reviewPanel?.resetResults();
    }

    // Manuscripts (editorial engine only)

    reviewContextFiles(): string[] {
        return this.reviewPanel?.getContextFilePaths() ?? [];
    }

    reviewAddContextFile(filePath: string): void {
        void this.reviewPanel?.addContextFile(filePath);
    }

    // Chat lifecycle (shared by both engines)

    reviewChatHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return this.reviewPanel?.getChatHistory() ?? [];
    }

    reviewAppendChatSystemMessage(content: string): void {
        this.reviewPanel?.appendChatSystemMessage(content);
    }

    reviewAppendChatSystemMessageInPlace(content: string): void {
        this.reviewPanel?.appendChatSystemMessageInPlace(content);
    }

    reviewReplaceChatHistory(history: { role: 'user' | 'assistant' | 'system'; content: string }[]): void {
        this.reviewPanel?.replaceChatHistory(history);
    }

    reviewSetContextTokenEstimate(tokens: number): void {
        this.reviewPanel?.setContextTokenEstimate(tokens);
    }

    reviewSaveConversation(): void {
        this.reviewPanel?.saveConversation();
    }

    reviewChatStartLoading(): void {
        this.reviewPanel?.chatStartLoading();
    }

    reviewChatAppendChunk(text: string): void {
        this.reviewPanel?.chatAppendChunk(text);
    }

    async reviewChatFinished(): Promise<void> {
        await this.reviewPanel?.chatFinished();
    }

    async reviewChatError(message: string): Promise<void> {
        await this.reviewPanel?.chatError(message);
    }

    // Chat context files (shared)

    reviewChatContextFiles(): string[] {
        return this.reviewPanel?.getChatContextFiles() ?? [];
    }

    reviewChatContextTokens(): number {
        return this.reviewPanel?.getChatContextTokens() ?? 0;
    }

    async reviewAddChatContextFile(filePath: string): Promise<void> {
        await this.reviewPanel?.addChatContextFile(filePath);
    }

    coWriterSetThoughtContent(thought: string): void {
        this.coWriterPanel?.setThoughtContent(thought);
    }

    /** Update draft state in the Co-writer panel. */
    coWriterSetDraftState(state: DraftState): void {
        this.coWriterPanel?.setDraftState(state);
    }

    /** Push chat history to the Co-writer panel. */
    coWriterSetChatHistory(history: CoWriterChatMessage[]): void {
        this.coWriterPanel?.setChatHistory(history);
    }

    /** Push current options to the Co-writer panel. */
    coWriterSetCurrentOptions(options: CoWriterOption[]): void {
        this.coWriterPanel?.setCurrentOptions(options);
    }

    /** Push options loading state to the Co-writer panel. */
    coWriterSetOptionsLoading(loading: boolean): void {
        this.coWriterPanel?.setOptionsLoading(loading);
    }

    /** Trigger a full refresh of the Co-writer panel (e.g., after context file changes). */
    coWriterRefresh(): void {
        if (this.activeTopTab === 'cowriter') {
            this.render();
        }
    }

    /** Set the maximum allowed context tokens for the Co-writer token indicator. */
    coWriterSetMaxAllowedTokens(tokens: number): void {
        this.coWriterPanel?.setMaxAllowedTokens(tokens);
    }

    /** Set the conversation token estimate for the Co-writer token indicator.
     * The panel adds vault context item tokens on top to compute the total. */
    coWriterSetContextTokenEstimate(tokens: number): void {
        this.coWriterPanel?.setContextTokenEstimate(tokens);
    }

    /** Set the additional context file token estimate for the Co-writer token indicator. */
    coWriterSetAdditionalContextTokens(tokens: number): void {
        this.coWriterPanel?.setAdditionalContextTokens(tokens);
    }

    /** Set the plot map token estimate for the Co-writer token indicator. */
    coWriterSetPlotMapTokens(tokens: number): void {
        this.coWriterPanel?.setPlotMapTokens(tokens);
    }

    /** Start streaming a discuss response. */
    coWriterDiscussStartStreaming(): void {
        this.coWriterPanel?.discussStartStreaming();
    }

    /** Append a chunk of text to the streaming discuss response. */
    coWriterDiscussAppendChunk(text: string): void {
        this.coWriterPanel?.discussAppendChunk(text);
    }

    /** Mark the discuss response as complete; re-render with markdown. */
    async coWriterDiscussFinished(): Promise<void> {
        await this.coWriterPanel?.discussFinished();
    }

    /** Show an error in the discuss response. */
    async coWriterDiscussError(message: string): Promise<void> {
        await this.coWriterPanel?.discussError(message);
    }

    /** Set the coach phase in the co-writer panel. */
    coWriterSetCoachPhase(phase: CoachPhase): void {
        this.coWriterPanel?.setCoachPhase(phase);
    }

    /** Set the co-writer panel's active mode (e.g. from the right-click submenu). */
    coWriterSetMode(mode: InputMode): void {
        this.coWriterPanel?.setMode(mode);
    }

    /** Set whether coach mode is active. */
    coWriterSetCoachActive(active: boolean): void {
        this.coWriterPanel?.setCoachActive(active);
    }

    /** Set the plot map link path shown in the co-writer panel. */
    coWriterSetPlotMap(path: string | null): void {
        this.coWriterPanel?.setPlotMap(path);
    }

    /** Set whether an inline directive is active at the cursor (Direct-mode badge). */
    coWriterSetDirectiveActive(active: boolean): void {
        this.coWriterPanel?.setDirectiveActive(active);
    }

    /** Push Fulfill-mode sections and active flag to the co-writer panel. */
    coWriterSetFulfillState(sections: ProposedEdit[], active: boolean): void {
        this.coWriterPanel?.setFulfillState(sections, active);
    }

    /** Render the list of lint results with severity badges and location info. */
    private renderResultsTab() {
        const resultsContainer = this.content.createDiv({ cls: 'quill-linter__results' });

        if (this.results.length === 0) {
            resultsContainer.createEl('p', {
                text: 'No issues found.',
                cls: 'quill-linter__empty'
            });

            // Offer to toggle the linter on if it's not active.
            if (!this.plugin.lintActive) {
                const toggleBtn = resultsContainer.createEl('button', {
                    cls: 'quill-linter__empty-btn',
                    text: 'Toggle prose linter'
                });
                this.renderEvents!.registerDomEvent(toggleBtn, 'click', () => {
                    const view = this.getEditorView();
                    if (view) {
                        this.plugin.toggleLint(view.editor);
                    }
                });
            }

            return;
        }

        const header = resultsContainer.createEl('div', { cls: 'quill-linter__header' });
        header.createEl('span', {
            text: `${this.results.length} issue${this.results.length !== 1 ? 's' : ''} found`
        });

        // "Fix all with AI" button — gated on AI fix setting + chat provider + not already processing.
        if (
            this.plugin.settings.enableLinterAiFixes &&
            this.plugin.getDefaultChatProvider().provider &&
            !this.plugin.batchFixInProgress
        ) {
            const fixAllBtn = header.createEl('button', {
                cls: 'quill-linter__fix-all-btn',
                text: 'Fix all with AI'
            });
            this.renderEvents!.registerDomEvent(fixAllBtn, 'click', () => {
                void this.plugin.fixAllLinterWithAi();
            });
        }

        const list = resultsContainer.createEl('ul', { cls: 'quill-linter__list' });

        for (const result of this.results) {
            const info = RULE_INFO[result.rule];
            const item = list.createEl('li', {
                cls: `quill-linter__item quill-linter__item--${result.severity}`,
                attr: { tabindex: '0', role: 'button' }
            });
            this.renderEvents!.registerDomEvent(item, 'click', () => this.showResultDetail(result));
            // Keyboard support: activate on Enter / Space so the item is reachable
            // without a mouse (it otherwise has no native action behavior as an <li>).
            this.renderEvents!.registerDomEvent(item, 'keydown', (evt: KeyboardEvent) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    this.showResultDetail(result);
                }
            });

            const badge = item.createEl('span', { cls: 'quill-linter__badge' });
            badge.setText(result.severity);

            const rule = item.createEl('span', { cls: 'quill-linter__rule-name' });
            rule.setText(info?.name ?? result.rule);

            const message = item.createEl('span', { cls: 'quill-linter__message' });
            message.setText(result.message);

            const location = item.createEl('span', { cls: 'quill-linter__location' });
            location.setText(`Ln ${result.line}, Col ${result.column + 1}`);
        }
    }

    /** Render the detail view for the currently selected lint result. */
    private renderDetailsTab() {
        const detailsContainer = this.content.createDiv({ cls: 'quill-linter__details' });

        const result = this.selectedResult;
        if (!result) {
            detailsContainer.createEl('p', {
                text: 'Click a lint result to see details about its rule.',
                cls: 'quill-linter-details__empty'
            });
            return;
        }

        const info = RULE_INFO[result.rule];
        const ruleName = info?.name ?? result.rule;

        const header = detailsContainer.createEl('div', { cls: 'quill-linter-details__header' });

        const backBtn = header.createEl('button', {
            cls: 'quill-linter-details__back',
            text: 'Back'
        });
        this.renderEvents!.registerDomEvent(backBtn, 'click', () => this.switchLinterSubTab('results'));

        const ruleEl = header.createEl('span', { cls: 'quill-linter-details__rule-name' });
        ruleEl.setText(ruleName);

        const severityEl = header.createEl('span', {
            cls: `quill-linter__badge quill-linter__item--${result.severity}`
        });
        severityEl.setText(result.severity);

        const passage = this.getPassageContext(result);
        if (passage !== null) {
            const ctxLabel = detailsContainer.createEl('p', { cls: 'quill-linter-details__label' });
            ctxLabel.setText('In text');

            const ctxBlock = detailsContainer.createEl('div', { cls: 'quill-linter-details__context' });

            for (const lineInfo of passage.lines) {
                const lineEl = ctxBlock.createEl('div', { cls: 'quill-linter-details__context-line' });

                const lineNum = lineEl.createEl('span', { cls: 'quill-linter-details__context-linenum' });
                lineNum.setText(String(lineInfo.index) + ' ');

                if (lineInfo.isFlagged) {
                    lineEl
                        .createEl('span', { cls: 'quill-linter-details__context-before' })
                        .setText(lineInfo.text.slice(0, passage.flaggedStart));

                    lineEl
                        .createEl('span', { cls: 'quill-linter-details__context-highlight' })
                        .setText(lineInfo.text.slice(passage.flaggedStart, passage.flaggedEnd));

                    lineEl
                        .createEl('span', { cls: 'quill-linter-details__context-after' })
                        .setText(lineInfo.text.slice(passage.flaggedEnd));
                } else {
                    lineEl.createEl('span', { cls: 'quill-linter-details__context-text' }).setText(lineInfo.text);
                }
            }
        }

        if (info) {
            const desc = detailsContainer.createEl('p', { cls: 'quill-linter-details__description' });
            desc.setText(info.description);

            const exampleLabel = detailsContainer.createEl('p', { cls: 'quill-linter-details__label' });
            exampleLabel.setText('Example');

            const example = detailsContainer.createEl('p', { cls: 'quill-linter-details__example' });
            example.setText(info.example);
        }

        if (FIXABLE_RULES.has(result.rule)) {
            const fix = FIXES[result.rule];
            if (fix) {
                const fixBtn = detailsContainer.createEl('button', {
                    cls: 'quill-linter-details__fix-btn',
                    text: fix.description
                });
                this.renderEvents!.registerDomEvent(fixBtn, 'click', () => {
                    this.applyFix(result);
                    this.switchLinterSubTab('results');
                });
            }
        }

        if (this.plugin.settings.enableLinterAiFixes && this.plugin.getDefaultChatProvider().provider) {
            const aiFixBtn = detailsContainer.createEl('button', {
                cls: 'quill-linter-details__fix-btn quill-linter-details__ai-fix-btn',
                text: 'Fix with AI'
            });
            this.renderEvents!.registerDomEvent(aiFixBtn, 'click', () => {
                this.openFixWithAiModal(result);
            });

            const aiCustomBtn = detailsContainer.createEl('button', {
                cls: 'quill-linter-details__fix-btn quill-linter-details__ai-custom-btn',
                text: 'Fix with AI (custom)'
            });
            this.renderEvents!.registerDomEvent(aiCustomBtn, 'click', () => {
                this.openFixWithAiModal(result, '');
            });
        }

        const dismissBtn = detailsContainer.createEl('button', {
            cls: 'quill-linter-details__dismiss-btn',
            text: 'Dismiss'
        });
        this.renderEvents!.registerDomEvent(dismissBtn, 'click', () => {
            this.plugin.dismissResult(result);
            this.switchLinterSubTab('results');
        });

        const locationEl = detailsContainer.createEl('p', { cls: 'quill-linter-details__location' });
        locationEl.setText(`At line ${result.line}, column ${result.column + 1}`);

        const msgEl = detailsContainer.createEl('p', { cls: 'quill-linter-details__message' });
        msgEl.setText(result.message);
    }
}
