import { Component, ItemView, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import { LintResult, RULE_INFO, FIXABLE_RULES } from '../core/linter/types';
import { FIXES } from '../core/linter/fixes';
import { applyReplacement } from '../core/linter/apply-fix';
import { findEditorView } from '../utils/find-editor';
import { FixWithAiModal } from './fix-with-ai-modal';
import { renderContextTab } from './context-panel';
import { FeedbackPanel } from './feedback-panel';
import { CoWriterPanel } from './co-writer-panel';
import type { InputMode } from './co-writer-panel';
import type { CoWriterChatMessage, CoWriterOption, DraftState, CoachPhase } from '../ai/co-writer';
import type { ProposedEdit } from '../core/change-set';
import type EventideQuillPlugin from '../main';
import type { ContextAssembly } from '../core/context-engine/types';

export const QUILL_VIEW_TYPE = 'quill-sidebar';

type TopTab = 'linter' | 'context' | 'feedback' | 'cowriter';
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
    /** Feedback panel for the Feedback tab. */
    private feedbackPanel: FeedbackPanel | null = null;
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
        this.tabBar = this.container.createDiv({ cls: 'quill-sidebar-tab-bar' });
        this.content = this.container.createDiv({ cls: 'quill-sidebar-content' });
        this.render();

        // Re-render context and co-writer tabs when the active file changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.activeTopTab === 'context' || this.activeTopTab === 'cowriter') {
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
            const ctxScroll = this.content.createDiv({ cls: 'quill-context-scroll' });
            renderContextTab(ctxScroll, this.currentAssembly, this.plugin, this.renderEvents);
        } else if (this.activeTopTab === 'cowriter') {
            this.renderCoWriterTab();
        } else {
            this.renderFeedbackTab();
        }
    }

    /** Render the top-level tab bar (Linter / Context / Feedback / Co-writer). */
    private renderTopTabBar() {
        const tabs: { id: TopTab; label: string }[] = [
            { id: 'linter', label: 'Linter' },
            { id: 'context', label: 'Context' },
            { id: 'feedback', label: 'Feedback' },
            { id: 'cowriter', label: 'Co-writer' }
        ];

        for (const tab of tabs) {
            const btn = this.tabBar.createEl('button', {
                cls: `quill-sidebar-tab${this.activeTopTab === tab.id ? ' quill-sidebar-tab-active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchTopTab(tab.id));
        }
    }

    /** Render the linter sub-tab bar (Results / Details). */
    private renderLinterSubTabBar() {
        const subTabBar = this.content.createDiv({ cls: 'quill-sidebar-subtab-bar' });

        const tabs: { id: LinterSubTab; label: string }[] = [
            { id: 'results', label: 'Results' },
            { id: 'details', label: 'Details' }
        ];

        for (const tab of tabs) {
            const btn = subTabBar.createEl('button', {
                cls: `quill-sidebar-subtab${this.activeLinterSubTab === tab.id ? ' quill-sidebar-subtab-active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchLinterSubTab(tab.id));
        }
    }

    /** Render the feedback tab, initializing or re-attaching the FeedbackPanel. */
    private renderFeedbackTab() {
        if (!this.feedbackPanel) {
            this.feedbackPanel = new FeedbackPanel(this.app);
            this.feedbackPanel.setGenerateHandler((personaId: string, customInstruction?: string) => {
                void this.plugin.requestFeedback(personaId, customInstruction);
            });
            this.feedbackPanel.setChatMessageHandler((message: string) => {
                void this.plugin.sendFeedbackChatMessage(message);
            });
            this.feedbackPanel.setCancelGenerationHandler(() => {
                this.plugin.cancelFeedbackGeneration();
            });
            this.feedbackPanel.setCompactHandler(() => {
                void this.plugin.compactFeedback();
            });
            this.feedbackPanel.setNewChatHandler(() => {
                this.plugin.resetFeedbackChat();
            });
        }
        const chat = this.plugin.getDefaultChatProvider();
        if (chat.provider) {
            this.feedbackPanel.setMaxAllowedTokens(chat.provider.config.maxContextTokens);
        }
        this.feedbackPanel.setContainer(this.content);
    }

    /** Switch to the Feedback tab and show the Create sub-tab. */
    switchToFeedbackTab(): void {
        this.activeTopTab = 'feedback';
        this.render();
    }

    /** Switch to the Co-writer tab. */
    switchToCoWriterTab(): void {
        this.activeTopTab = 'cowriter';
        this.render();
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
            this.coWriterPanel.setCoachMessageHandler((message: string, phase: string) => {
                void this.plugin.sendCoWriterCoach(message, phase);
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

    /** Start the loading state in the Feedback panel for the given persona ID. */
    feedbackStartLoading(personaId: string): void {
        this.feedbackPanel?.startLoading(personaId);
    }

    /** Append a chunk of text to the current feedback report. */
    feedbackAppendChunk(text: string): void {
        this.feedbackPanel?.appendChunk(text);
    }

    /** Mark the current feedback report as complete. */
    async feedbackFinished(): Promise<void> {
        await this.feedbackPanel?.finishLoading();
    }

    /** Show an error in the feedback panel. */
    feedbackError(message: string): void {
        this.feedbackPanel?.showError(message);
    }

    /** Get the list of context file paths the user has selected in the Feedback panel. */
    feedbackPanelContextFiles(): string[] {
        return this.feedbackPanel?.getContextFilePaths() ?? [];
    }

    /** Add a file to the manuscript context list in the feedback panel. */
    feedbackPanelAddContextFile(filePath: string): void {
        if (this.feedbackPanel) {
            void this.feedbackPanel.addContextFile(filePath);
        }
    }

    /** Get the chat history from the Feedback panel. */
    feedbackChatHistory(): { role: 'user' | 'assistant' | 'system'; content: string }[] {
        return this.feedbackPanel?.getChatHistory() ?? [];
    }

    /** Append a system message to the feedback panel's chat (e.g. compaction notice). */
    feedbackAppendChatSystemMessage(content: string): void {
        this.feedbackPanel?.appendChatSystemMessage(content);
    }

    /** Append a system message in-place without a full DOM rebuild (avoids flicker during streaming). */
    feedbackAppendChatSystemMessageInPlace(content: string): void {
        this.feedbackPanel?.appendChatSystemMessageInPlace(content);
    }

    /** Replace the chat history in the Feedback panel. */
    replaceChatHistory(history: { role: 'user' | 'assistant' | 'system'; content: string }[]): void {
        this.feedbackPanel?.replaceChatHistory(history);
    }

    /** Reset feedback results and return to the Create feedback subtab. */
    resetFeedbackResults(): void {
        this.feedbackPanel?.resetResults();
    }

    /** Push thought content to the Co-writer panel. */
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

    /** Get the chat context file paths from the Feedback panel. */
    feedbackChatContextFiles(): string[] {
        return this.feedbackPanel?.getChatContextFiles() ?? [];
    }

    /** Get the chat context token count from the Feedback panel. */
    feedbackChatContextTokens(): number {
        return this.feedbackPanel?.getChatContextTokens() ?? 0;
    }

    /** Set the context token estimate from the plugin layer. */
    feedbackSetContextTokenEstimate(tokens: number): void {
        this.feedbackPanel?.setContextTokenEstimate(tokens);
    }

    /** Export the current feedback conversation to a markdown file. */
    feedbackSaveConversation(): void {
        this.feedbackPanel?.saveConversation();
    }

    /** Start loading state for a chat follow-up. */
    chatStartLoading(): void {
        this.feedbackPanel?.chatStartLoading();
    }

    /** Append a chunk of text to the streaming chat response. */
    chatAppendChunk(text: string): void {
        this.feedbackPanel?.chatAppendChunk(text);
    }

    /** Mark the current chat response as complete. */
    async chatFinished(): Promise<void> {
        await this.feedbackPanel?.chatFinished();
    }

    /** Show an error in the chat response. */
    async chatError(message: string): Promise<void> {
        await this.feedbackPanel?.chatError(message);
    }

    /** Render the list of lint results with severity badges and location info. */
    private renderResultsTab() {
        const resultsContainer = this.content.createDiv({ cls: 'quill-linter-results' });

        if (this.results.length === 0) {
            resultsContainer.createEl('p', {
                text: 'No issues found.',
                cls: 'quill-lint-empty'
            });
            return;
        }

        const header = resultsContainer.createEl('div', { cls: 'quill-lint-header' });
        header.createEl('span', {
            text: `${this.results.length} issue${this.results.length !== 1 ? 's' : ''} found`
        });

        const list = resultsContainer.createEl('ul', { cls: 'quill-lint-list' });

        for (const result of this.results) {
            const info = RULE_INFO[result.rule];
            const item = list.createEl('li', {
                cls: `quill-lint-item quill-lint-${result.severity}`
            });
            this.renderEvents!.registerDomEvent(item, 'click', () => this.showResultDetail(result));

            const badge = item.createEl('span', { cls: 'quill-lint-badge' });
            badge.setText(result.severity);

            const rule = item.createEl('span', { cls: 'quill-lint-rule-name' });
            rule.setText(info?.name ?? result.rule);

            const message = item.createEl('span', { cls: 'quill-lint-message' });
            message.setText(result.message);

            const location = item.createEl('span', { cls: 'quill-lint-location' });
            location.setText(`Ln ${result.line}, Col ${result.column + 1}`);
        }
    }

    /** Render the detail view for the currently selected lint result. */
    private renderDetailsTab() {
        const detailsContainer = this.content.createDiv({ cls: 'quill-linter-details' });

        const result = this.selectedResult;
        if (!result) {
            detailsContainer.createEl('p', {
                text: 'Click a lint result to see details about its rule.',
                cls: 'quill-details-empty'
            });
            return;
        }

        const info = RULE_INFO[result.rule];
        const ruleName = info?.name ?? result.rule;

        const header = detailsContainer.createEl('div', { cls: 'quill-details-header' });

        const backBtn = header.createEl('button', {
            cls: 'quill-details-back',
            text: 'Back'
        });
        this.renderEvents!.registerDomEvent(backBtn, 'click', () => this.switchLinterSubTab('results'));

        const ruleEl = header.createEl('span', { cls: 'quill-details-rule-name' });
        ruleEl.setText(ruleName);

        const severityEl = header.createEl('span', { cls: `quill-lint-badge quill-lint-${result.severity}` });
        severityEl.setText(result.severity);

        const passage = this.getPassageContext(result);
        if (passage !== null) {
            const ctxLabel = detailsContainer.createEl('p', { cls: 'quill-details-label' });
            ctxLabel.setText('In text');

            const ctxBlock = detailsContainer.createEl('div', { cls: 'quill-details-context' });

            for (const lineInfo of passage.lines) {
                const lineEl = ctxBlock.createEl('div', { cls: 'quill-details-context-line' });

                const lineNum = lineEl.createEl('span', { cls: 'quill-details-context-linenum' });
                lineNum.setText(String(lineInfo.index) + ' ');

                if (lineInfo.isFlagged) {
                    lineEl
                        .createEl('span', { cls: 'quill-details-context-before' })
                        .setText(lineInfo.text.slice(0, passage.flaggedStart));

                    lineEl
                        .createEl('span', { cls: 'quill-details-context-highlight' })
                        .setText(lineInfo.text.slice(passage.flaggedStart, passage.flaggedEnd));

                    lineEl
                        .createEl('span', { cls: 'quill-details-context-after' })
                        .setText(lineInfo.text.slice(passage.flaggedEnd));
                } else {
                    lineEl.createEl('span', { cls: 'quill-details-context-text' }).setText(lineInfo.text);
                }
            }
        }

        if (info) {
            const desc = detailsContainer.createEl('p', { cls: 'quill-details-description' });
            desc.setText(info.description);

            const exampleLabel = detailsContainer.createEl('p', { cls: 'quill-details-label' });
            exampleLabel.setText('Example');

            const example = detailsContainer.createEl('p', { cls: 'quill-details-example' });
            example.setText(info.example);
        }

        if (FIXABLE_RULES.has(result.rule)) {
            const fix = FIXES[result.rule];
            if (fix) {
                const fixBtn = detailsContainer.createEl('button', {
                    cls: 'quill-details-fix-btn',
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
                cls: 'quill-details-fix-btn quill-details-ai-fix-btn',
                text: 'Fix with AI'
            });
            this.renderEvents!.registerDomEvent(aiFixBtn, 'click', () => {
                this.openFixWithAiModal(result);
            });

            const aiCustomBtn = detailsContainer.createEl('button', {
                cls: 'quill-details-fix-btn quill-details-ai-custom-btn',
                text: 'Fix with AI (custom)'
            });
            this.renderEvents!.registerDomEvent(aiCustomBtn, 'click', () => {
                this.openFixWithAiModal(result, '');
            });
        }

        const dismissBtn = detailsContainer.createEl('button', {
            cls: 'quill-details-dismiss-btn',
            text: 'Dismiss'
        });
        this.renderEvents!.registerDomEvent(dismissBtn, 'click', () => {
            this.plugin.dismissResult(result);
            this.switchLinterSubTab('results');
        });

        const locationEl = detailsContainer.createEl('p', { cls: 'quill-details-location' });
        locationEl.setText(`At line ${result.line}, column ${result.column + 1}`);

        const msgEl = detailsContainer.createEl('p', { cls: 'quill-details-message' });
        msgEl.setText(result.message);
    }
}
