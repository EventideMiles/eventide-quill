import { Component, ItemView, MarkdownView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { LintResult, RULE_INFO, FIXABLE_RULES } from '../core/linter/types';
import { FIXES } from '../core/linter/fixes';
import { renderChangeCard, renderChangeBulkBar } from './change-card';
import { applyReplacement } from '../core/linter/apply-fix';
import { findEditorView } from '../utils/find-editor';
import { FixWithAiModal } from './fix-with-ai-modal';
import { renderContextTab } from './context-panel';
import { ReviewPanel } from './review-panel';
import { CoWriterPanel } from './co-writer-panel';
import { renderDashboardTab, renderDashboardSettingsTab } from './dashboard-panel';
import { renderLorebookTab } from './lorebook-panel';
import type { InputMode } from './co-writer-panel';
import type { CoWriterChatMessage, CoWriterOption, DraftState, CoachPhase, LoreCoachPhase } from '../ai/co-writer';
import type { SubagentView } from '../ai/subagent-session';
import type { ProposedEdit } from '../core/change-set';
import type EventideQuillPlugin from '../main';
import type { ContextAssembly } from '../core/context-engine/types';

export const QUILL_VIEW_TYPE = 'quill-sidebar';

type TopTab = 'linter' | 'context' | 'review' | 'cowriter' | 'dashboard' | 'lorebook';
type LinterSubTab = 'results' | 'details' | 'pending';

/** Allow-list of valid TopTab values, used to validate persisted settings. */
const VALID_TOP_TABS: ReadonlySet<TopTab> = new Set<TopTab>([
    'linter',
    'context',
    'review',
    'cowriter',
    'dashboard',
    'lorebook'
]);

export class QuillSidebarView extends ItemView {
    private results: LintResult[] = [];
    private selectedResult: LintResult | null = null;
    private activeTopTab: TopTab = 'linter';
    private activeLinterSubTab: LinterSubTab = 'results';
    private dashboardSubTab: 'overview' | 'pending' | 'settings' = 'overview';
    private lorebookSubTab: 'document' | 'manuscript' = 'document';
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
    private resizeObserver: ResizeObserver | null = null;

    /** Create the sidebar view for the given workspace leaf. */
    constructor(leaf: WorkspaceLeaf, plugin: EventideQuillPlugin) {
        super(leaf);
        this.plugin = plugin;
        // Apply the user's preferred default tab, validating the persisted value
        // against the allow-list rather than trusting it blindly (older saves or
        // hand-edited data.json may hold invalid strings).
        const stored = plugin.settings.defaultTab;
        this.activeTopTab = VALID_TOP_TABS.has(stored) ? stored : 'linter';
    }

    /** Whether the Dashboard tab is currently active. */
    isDashboardActive(): boolean {
        return this.activeTopTab === 'dashboard';
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

        // Observe the content element for width changes to toggle responsive modes.
        // Thresholds account for six top-level tabs (~75px each with icon + label):
        //   >= 540px → normal (icon + label side by side)
        //   440-540px → watermark (icon behind text as ghost, no layout space)
        //   < 440px  → compact (icons only, labels hidden)
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const width = entry.contentRect.width;
                const compact = width < 440;
                const watermark = !compact && width < 540;
                this.container.classList.toggle('quill-sidebar--compact', compact);
                this.container.classList.toggle('quill-sidebar--watermark', watermark);
            }
        });
        this.resizeObserver.observe(this.contentEl);

        // Re-render context, co-writer, and review tabs when the active file
        // changes (each shows the active document header / derives from it).
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (
                    this.activeTopTab === 'context' ||
                    this.activeTopTab === 'cowriter' ||
                    this.activeTopTab === 'review' ||
                    this.activeTopTab === 'dashboard' ||
                    this.activeTopTab === 'lorebook'
                ) {
                    this.render();
                    // The Document subtab matches against the active document's
                    // text, so it must re-compute on file switch (the Manuscript
                    // subtab uses cached manuscript-wide data and is stable).
                    if (this.activeTopTab === 'lorebook' && this.lorebookSubTab === 'document') {
                        void this.plugin.refreshLorebookDocumentCoverage();
                    }
                }
            })
        );
    }

    /** Clean up the ResizeObserver when the view is destroyed. */
    onunload() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
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

    /** Switch the active top-level tab. Clears handled batch edits when leaving the pending view. */
    private switchTopTab(tab: TopTab) {
        this.clearBatchIfHandled();
        this.activeTopTab = tab;
        if (tab === 'linter') {
            this.activeLinterSubTab = 'results';
        }
        this.render();
    }

    /** Switch the active linter sub-tab. Clears handled batch edits when leaving pending. */
    private switchLinterSubTab(tab: LinterSubTab) {
        if (this.activeLinterSubTab === 'pending' && tab !== 'pending') {
            this.clearBatchIfHandled();
        }
        this.activeLinterSubTab = tab;
        this.render();
    }

    /**
     * Clear the batch ChangeSet if all edits have been handled (no pending).
     * Called when the user navigates away from the pending subtab so that
     * old approved/rejected entries don't persist into the next batch.
     */
    private clearBatchIfHandled(): void {
        if (
            !this.plugin.batchFixInProgress &&
            this.plugin.lintBatchChangeSet.edits.length > 0 &&
            this.plugin.lintBatchChangeSet.pendingCount === 0
        ) {
            this.plugin.lintBatchChangeSet.clear();
        }
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
            this.renderHeader();
            if (this.activeLinterSubTab === 'results') {
                this.renderResultsTab();
            } else if (this.activeLinterSubTab === 'pending') {
                this.renderPendingTab();
            } else {
                this.renderDetailsTab();
            }
        } else if (this.activeTopTab === 'context') {
            this.renderHeader();
            const ctxScroll = this.content.createDiv({ cls: 'quill-context-panel__scroll' });
            renderContextTab(ctxScroll, this.currentAssembly, this.plugin, this.renderEvents);
        } else if (this.activeTopTab === 'dashboard') {
            this.renderDashboardSubTabBar();
            this.renderHeader();
            if (this.dashboardSubTab === 'pending') {
                this.renderPendingTab();
            } else if (this.dashboardSubTab === 'settings') {
                const settingsScroll = this.content.createDiv({ cls: 'quill-dashboard-panel__scroll' });
                renderDashboardSettingsTab(settingsScroll, this.plugin, this.renderEvents);
            } else {
                const dashScroll = this.content.createDiv({ cls: 'quill-dashboard-panel__scroll' });
                renderDashboardTab(dashScroll, this.plugin, this.renderEvents);
            }
        } else if (this.activeTopTab === 'cowriter') {
            this.renderHeader();
            this.renderCoWriterTab();
        } else if (this.activeTopTab === 'lorebook') {
            this.renderHeader();
            this.renderLorebookSubTabBar();
            const loreScroll = this.content.createDiv({ cls: 'quill-lorebook-panel__scroll' });
            renderLorebookTab(loreScroll, this.plugin, this.renderEvents, this.lorebookSubTab);
        } else {
            this.renderHeader();
            this.renderReviewTab();
        }
    }

    /** Render the top-level tab bar with icons, labels, and hover tooltips. */
    private renderTopTabBar() {
        const tabs: { id: TopTab; label: string; icon: string }[] = [
            { id: 'dashboard', label: 'Dashboard', icon: 'gauge' },
            { id: 'lorebook', label: 'Lorebook', icon: 'book-open' },
            { id: 'linter', label: 'Linter', icon: 'list-checks' },
            { id: 'context', label: 'Context', icon: 'file-stack' },
            { id: 'review', label: 'Review', icon: 'message-square-text' },
            { id: 'cowriter', label: 'Co-writer', icon: 'feather' }
        ];

        for (const tab of tabs) {
            const btn = this.tabBar.createEl('button', {
                cls: `quill-sidebar__tab${this.activeTopTab === tab.id ? ' quill-sidebar__tab--active' : ''}`,
                attr: { title: tab.label, 'aria-label': tab.label }
            });
            const iconEl = btn.createEl('span', { cls: 'quill-sidebar__tab-icon' });
            setIcon(iconEl, tab.icon);
            btn.createEl('span', { cls: 'quill-sidebar__tab-label', text: tab.label });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchTopTab(tab.id));
        }
    }

    /** Render a persistent header showing the current tab name below the subtab bar. */
    private renderHeader(): void {
        const labels: Record<TopTab, string> = {
            dashboard: 'Dashboard',
            lorebook: 'Lorebook',
            linter: 'Linter',
            context: 'Context',
            review: 'Review',
            cowriter: 'Co-writer'
        };
        const el = this.content.createDiv({ cls: 'quill-sidebar__header' });
        el.setText(labels[this.activeTopTab]);
    }

    /** Render the dashboard sub-tab bar (Overview | Settings | Pending). */
    private renderDashboardSubTabBar() {
        const subTabBar = this.content.createDiv({ cls: 'quill-sidebar__subtab-bar' });

        const tabs: { id: 'overview' | 'pending' | 'settings'; label: string }[] = [
            { id: 'overview', label: 'Overview' },
            { id: 'settings', label: 'Settings' }
        ];

        // Show Pending conditionally.
        const showPending =
            this.plugin.batchFixSource === 'dashboard' &&
            (this.plugin.batchFixInProgress ||
                this.plugin.lintBatchChangeSet.edits.length > 0 ||
                this.dashboardSubTab === 'pending');

        if (showPending) {
            const pendingCount = this.plugin.lintBatchChangeSet.pendingCount;
            if (this.plugin.batchFixInProgress) {
                tabs.push({ id: 'pending', label: 'Generating...' });
            } else if (pendingCount > 0) {
                tabs.push({ id: 'pending', label: `Pending (${pendingCount})` });
            } else if (this.dashboardSubTab === 'pending') {
                tabs.push({ id: 'pending', label: 'Pending' });
            }
        } else if (this.dashboardSubTab === 'pending') {
            this.dashboardSubTab = 'overview';
        }

        for (const tab of tabs) {
            const btn = subTabBar.createEl('button', {
                cls: `quill-sidebar__subtab${this.dashboardSubTab === tab.id ? ' quill-sidebar__subtab--active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => {
                if (this.dashboardSubTab === 'pending' && tab.id !== 'pending') {
                    this.clearBatchIfHandled();
                }
                this.dashboardSubTab = tab.id;
                this.render();
            });
        }
    }

    /** Render the Lorebook sub-tab bar (Document / Manuscript). */
    private renderLorebookSubTabBar() {
        const subTabBar = this.content.createDiv({ cls: 'quill-sidebar__subtab-bar' });

        const tabs: { id: 'document' | 'manuscript'; label: string }[] = [
            { id: 'document', label: 'Document' },
            { id: 'manuscript', label: 'Manuscript' }
        ];

        for (const tab of tabs) {
            const btn = subTabBar.createEl('button', {
                cls: `quill-sidebar__subtab${this.lorebookSubTab === tab.id ? ' quill-sidebar__subtab--active' : ''}`,
                text: tab.label
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => {
                this.lorebookSubTab = tab.id;
                this.render();
                if (tab.id === 'manuscript') {
                    void this.plugin.refreshLorebookManuscriptCoverage(true);
                } else {
                    void this.plugin.refreshLorebookDocumentCoverage();
                }
            });
        }
    }

    /** Render the linter sub-tab bar (Results / Details). */
    private renderLinterSubTabBar() {
        const subTabBar = this.content.createDiv({ cls: 'quill-sidebar__subtab-bar' });

        const tabs: { id: LinterSubTab; label: string }[] = [
            { id: 'results', label: 'Results' },
            { id: 'details', label: 'Details' }
        ];

        // Show "Pending" subtab when batch fixes are in progress or edits exist.
        const showPending =
            this.plugin.batchFixSource === 'linter' &&
            (this.plugin.batchFixInProgress ||
                this.plugin.lintBatchChangeSet.edits.length > 0 ||
                this.activeLinterSubTab === 'pending');

        if (showPending) {
            const pendingCount = this.plugin.lintBatchChangeSet.pendingCount;
            if (this.plugin.batchFixInProgress) {
                tabs.push({ id: 'pending', label: 'Generating...' });
            } else if (pendingCount > 0) {
                tabs.push({ id: 'pending', label: `Pending (${pendingCount})` });
            } else if (this.activeLinterSubTab === 'pending') {
                tabs.push({ id: 'pending', label: 'Pending' });
            }
        }

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
            this.reviewPanel.setManuscriptGenerateHandler((mode, scope, compaction, customInstruction) => {
                void this.plugin.requestManuscriptAnalysis(mode, scope, compaction, customInstruction);
            });
            this.reviewPanel.setChatMessageHandler((message) => {
                // Dispatch to the right engine's chat handler.
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    void this.plugin.sendFeedbackChatMessage(message);
                } else if (this.reviewPanel?.activeEngine === 'manuscript') {
                    void this.plugin.sendManuscriptAnalysisChatMessage(message);
                } else {
                    void this.plugin.sendAnalysisChatMessage(message);
                }
            });
            this.reviewPanel.setCancelGenerationHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    this.plugin.cancelFeedbackGeneration();
                } else if (this.reviewPanel?.activeEngine === 'manuscript') {
                    this.plugin.cancelManuscriptAnalysisGeneration();
                } else {
                    this.plugin.cancelAnalysisGeneration();
                }
            });
            this.reviewPanel.setCompactHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    void this.plugin.compactFeedback();
                } else if (this.reviewPanel?.activeEngine === 'manuscript') {
                    void this.plugin.compactManuscriptAnalysis();
                } else {
                    void this.plugin.compactAnalysis();
                }
            });
            this.reviewPanel.setNewChatHandler(() => {
                if (this.reviewPanel?.activeEngine === 'editorial') {
                    this.plugin.resetFeedbackChat();
                } else if (this.reviewPanel?.activeEngine === 'manuscript') {
                    this.plugin.resetManuscriptAnalysisChat();
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

        // Sync full-embed picker option from settings.
        this.reviewPanel.setShowFullEmbed(this.plugin.settings.enableFullEmbedPickerOption);

        // Sync embeddings top-K for folder token estimation.
        this.reviewPanel.setEmbeddingsTopK(this.plugin.settings.embeddingsTopKChunks);

        // Sync per-folder top-K overrides for folder token estimation.
        this.reviewPanel.setFolderTopKOverrides(this.plugin.settings.folderTopKOverrides);

        // Trigger token estimate refresh for the manuscript engine.
        // The actual async fetch is initiated by ReviewPanel's render path;
        // the sidebar's setManuscriptTokenEstimate callback acts as a stale-
        // state guard — the version check in ReviewPanel discards any
        // estimate whose scope/compaction request was superseded.
        if (this.reviewPanel.isManuscriptEngineActive()) {
            this.reviewPanel.refreshManuscriptTokenEstimate();
        }
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

    /** Switch to the Lorebook tab. */
    switchToLorebookTab(): void {
        this.activeTopTab = 'lorebook';
        this.render();
    }

    /** Re-render the Dashboard panel if it's the active tab. */
    refreshDashboardPanel(): void {
        if (this.activeTopTab === 'dashboard') {
            this.render();
        }
    }

    /** Re-render the Lorebook panel if it's the active tab. */
    refreshLorebookPanel(): void {
        if (this.activeTopTab === 'lorebook') {
            this.render();
        }
    }

    /** Re-render the linter results tab if it's active. */
    refreshResultsTab(): void {
        if (this.activeTopTab === 'linter' && this.activeLinterSubTab === 'results') {
            this.render();
        }
    }

    /** Re-render the pending subtab if it's active on either the linter or dashboard tab. */
    refreshPendingTab(): void {
        if (
            (this.activeTopTab === 'linter' && this.activeLinterSubTab === 'pending') ||
            (this.activeTopTab === 'dashboard' && this.dashboardSubTab === 'pending')
        ) {
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
            this.coWriterPanel.setDiscussMessageHandler((message: string, images?: string[]) => {
                void this.plugin.sendCoWriterDiscussion(message, images);
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
            this.coWriterPanel.setModeSwitchHandler(() => {
                this.plugin.clearCoWriterSubagents();
            });
            this.coWriterPanel.setCoachMessageHandler((message: string, images?: string[]) => {
                void this.plugin.sendCoWriterCoach(message, images);
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
            this.coWriterPanel.setApproveDirectHandler((id: number) => {
                this.plugin.approveDirectChange(id);
            });
            this.coWriterPanel.setRejectDirectHandler((id: number) => {
                this.plugin.rejectDirectChange(id);
            });
            this.coWriterPanel.setLoreCoachMessageHandler((message: string, images?: string[]) => {
                void this.plugin.sendCoWriterLoreCoach(message, images);
            });
            this.coWriterPanel.setEndLoreCoachHandler(() => {
                this.plugin.endCoWriterLoreCoach();
            });
            this.coWriterPanel.setDiscardLoreDraftHandler((draft) => {
                this.plugin.discardLoreDraft(draft);
            });
            this.coWriterPanel.setApproveLoreEditHandler((filePath, id) => {
                this.plugin.approveLoreEdit(filePath, id);
            });
            this.coWriterPanel.setRejectLoreEditHandler((filePath, id) => {
                this.plugin.rejectLoreEdit(filePath, id);
            });
            this.coWriterPanel.setNavigateToSubagentHandler((id) => {
                this.plugin.coWriterSession.navigateToSubagent(id);
            });
            this.coWriterPanel.setNavigateToParentHandler(() => {
                this.plugin.coWriterSession.navigateToParent();
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
            this.coWriterPanel.setLoreCoachPhase(session.loreCoachSession?.phase ?? 'discover');
            this.coWriterPanel.setLoreCoachActive(session.loreCoachActive);
            this.coWriterPanel.setFulfillState(session.fulfillChanges.edits, session.fulfillActive);
            this.coWriterPanel.setDirectChange(session.directChanges.edits[0] ?? null);
            const loreEditsList = [...session.loreEdits.entries()].flatMap(([filePath, entry]) =>
                entry.changeSet.edits
                    .filter((e) => e.state === 'pending')
                    .map((edit) => ({ edit, filePath, fileBasename: entry.fileBasename }))
            );
            this.coWriterPanel.setLoreEdits(loreEditsList);
            this.coWriterPanel.setSubagents(session.getSubagentViews());
            this.coWriterPanel.setActiveSubagent(session.activeSubagentId);
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

    reviewStartLoading(engine: 'editorial' | 'critical' | 'manuscript', headerLabel: string, subLabel?: string): void {
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

    reviewSetManuscriptTokenEstimate(estimate: { estimated: number; max: number } | null): void {
        this.reviewPanel?.setManuscriptTokenEstimate(estimate);
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

    /** Push the Regime B "describing image…" indicator state to the Co-writer panel. */
    coWriterSetDescribingImages(active: boolean): void {
        this.coWriterPanel?.setDescribingImages(active);
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

    /** Clear the streaming text (discard draft text emitted before reasoning). */
    coWriterDiscussClearStreaming(): void {
        this.coWriterPanel?.discussClearStreaming();
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

    /** Set the lorebook coach phase. */
    coWriterSetLoreCoachPhase(phase: LoreCoachPhase): void {
        this.coWriterPanel?.setLoreCoachPhase(phase);
    }

    /** Set whether lorebook coach mode is active. */
    coWriterSetLoreCoachActive(active: boolean): void {
        this.coWriterPanel?.setLoreCoachActive(active);
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

    /** Push the current Direct continuation edit (or null) to the co-writer panel. */
    coWriterSetDirectChange(edit: ProposedEdit | null): void {
        this.coWriterPanel?.setDirectChange(edit);
    }

    /** Push the pending lore edits to the co-writer panel. */
    coWriterSetLoreEdits(edits: { edit: ProposedEdit; filePath: string; fileBasename: string }[]): void {
        this.coWriterPanel?.setLoreEdits(edits);
    }

    /** Push the spawned subagent list (status cards + drill-down state). */
    coWriterSetSubagents(list: SubagentView[]): void {
        this.coWriterPanel?.setSubagents(list);
    }

    /** Push which subagent is drilled-in (null = parent view). */
    coWriterSetActiveSubagent(id: string | null): void {
        this.coWriterPanel?.setActiveSubagent(id);
    }

    /** Switch to the pending subtab on whichever tab initiated the batch fix. */
    switchToPendingTab(): void {
        if (this.plugin.batchFixSource === 'dashboard') {
            this.activeTopTab = 'dashboard';
            this.dashboardSubTab = 'pending';
        } else {
            this.activeTopTab = 'linter';
            this.activeLinterSubTab = 'pending';
        }
        this.render();
    }

    /** Render the pending batch-fix edits as review cards with Accept/Reject. */
    private renderPendingTab() {
        const container = this.content.createDiv({ cls: 'quill-linter__pending' });
        const edits = this.plugin.lintBatchChangeSet.edits;

        // Loading indicator while AI is generating.
        if (this.plugin.batchFixInProgress) {
            container.createEl('div', {
                cls: 'quill-linter__pending-loading',
                text: 'Generating fixes\u2026'
            });
        }

        if (edits.length === 0 && !this.plugin.batchFixInProgress) {
            container.createEl('p', {
                text: 'No pending changes.',
                cls: 'quill-linter__empty'
            });
            return;
        }

        // Bulk action bar (only when there are pending edits).
        if (this.plugin.lintBatchChangeSet.pendingCount > 0) {
            renderChangeBulkBar(container, this.plugin.lintBatchChangeSet.pendingCount, this.renderEvents!, {
                onApproveAll: () => {
                    this.plugin.approveAllLintBatch();
                    this.render();
                },
                onRejectAll: () => {
                    this.plugin.rejectAllLintBatch();
                    this.render();
                }
            });
        }

        // Individual change cards.
        const scroll = container.createEl('div', { cls: 'quill-linter__pending-list' });
        for (const edit of edits) {
            void renderChangeCard(scroll, edit, edit.originalText ?? null, this.app, this.renderEvents!, {
                onApprove: (id: number) => {
                    this.plugin.approveLintBatchChange(id);
                    this.render();
                },
                onReject: (id: number) => {
                    this.plugin.rejectLintBatchChange(id);
                    this.render();
                }
            });
        }
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
                    const activeFile = this.app.workspace.getActiveFile();
                    if (!activeFile || activeFile.extension !== 'md') return;
                    const view = findEditorView(this.app, activeFile.path);
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
