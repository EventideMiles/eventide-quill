import { Component, ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { LintResult, RULE_INFO, FIXABLE_RULES } from '../core/linter/types';
import { FIXES } from '../core/linter/fixes';
import { applyReplacement } from '../core/linter/apply-fix';
import { findEditorView } from '../utils/find-editor';
import { FixWithAiModal } from './fix-with-ai-modal';
import type EventideQuillPlugin from '../main';

export const QUILL_VIEW_TYPE = 'quill-sidebar';

type TabId = 'results' | 'details';

export class QuillSidebarView extends ItemView {
    private results: LintResult[] = [];
    private selectedResult: LintResult | null = null;
    private activeTab: TabId = 'results';
    private container!: HTMLElement;
    private tabBar!: HTMLElement;
    private content!: HTMLElement;
    private renderEvents: Component | null = null;
    private plugin: EventideQuillPlugin;
    /** Captured at lint time so the passage context is available even when the sidebar has focus. */
    private cachedEditorText: string | null = null;

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
    }

    /** Update the stored results and cache the editor text for passage context. */
    setResults(results: LintResult[]) {
        this.results = results;
        const view = this.getEditorView();
        if (view) {
            this.cachedEditorText = view.editor.getValue();
        }
        if (this.activeTab === 'results') {
            this.render();
        }
    }

    /** Switch to the details tab for the given result and scroll the editor to it. */
    showResultDetail(result: LintResult) {
        this.selectedResult = result;
        this.activeTab = 'details';
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
                this.switchTab('results');
            },
            customInstruction,
        ).open();
    }

    /** Get the full paragraph (contiguous non-blank lines) containing the lint result. */
    private getPassageContext(result: LintResult): {
        lines: { text: string; index: number; isFlagged: boolean }[];
        flaggedStart: number;
        flaggedEnd: number;
    } | null {
        const view = this.getEditorView();
        const editorText = view
            ? view.editor.getValue()
            : this.cachedEditorText;

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
                isFlagged: i === lineIndex,
            });
        }

        return { lines, flaggedStart, flaggedEnd };
    }

    /** Switch the active tab and re-render the sidebar. */
    private switchTab(tab: TabId) {
        this.activeTab = tab;
        this.render();
    }

    /** Tear down event listeners and rebuild the sidebar DOM for the current tab. */
    private render() {
        this.renderEvents?.unload();
        this.renderEvents = new Component();
        this.addChild(this.renderEvents);

        this.tabBar.empty();
        this.content.empty();

        this.renderTabBar();
        if (this.activeTab === 'results') {
            this.renderResultsTab();
        } else {
            this.renderDetailsTab();
        }
    }

    /** Render the tab bar with Results and Details buttons. */
    private renderTabBar() {
        const tabs: { id: TabId; label: string }[] = [
            { id: 'results', label: 'Results' },
            { id: 'details', label: 'Details' },
        ];

        for (const tab of tabs) {
            const btn = this.tabBar.createEl('button', {
                cls: `quill-sidebar-tab${this.activeTab === tab.id ? ' quill-sidebar-tab-active' : ''}`,
                text: tab.label,
            });
            this.renderEvents!.registerDomEvent(btn, 'click', () => this.switchTab(tab.id));
        }
    }

    /** Render the list of lint results with severity badges and location info. */
    private renderResultsTab() {
        if (this.results.length === 0) {
            this.content.createEl('p', {
                text: 'No issues found.',
                cls: 'quill-lint-empty',
            });
            return;
        }

        const header = this.content.createEl('div', { cls: 'quill-lint-header' });
        header.createEl('span', {
            text: `${this.results.length} issue${this.results.length !== 1 ? 's' : ''} found`,
        });

        const list = this.content.createEl('ul', { cls: 'quill-lint-list' });

        for (const result of this.results) {
            const info = RULE_INFO[result.rule];
            const item = list.createEl('li', {
                cls: `quill-lint-item quill-lint-${result.severity}`,
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
        const result = this.selectedResult;
        if (!result) {
            this.content.createEl('p', {
                text: 'Click a lint result to see details about its rule.',
                cls: 'quill-details-empty',
            });
            return;
        }

        const info = RULE_INFO[result.rule];
        const ruleName = info?.name ?? result.rule;

        const header = this.content.createEl('div', { cls: 'quill-details-header' });

        const backBtn = header.createEl('button', {
            cls: 'quill-details-back',
            text: 'Back',
        });
        this.renderEvents!.registerDomEvent(backBtn, 'click', () => this.switchTab('results'));

        const ruleEl = header.createEl('span', { cls: 'quill-details-rule-name' });
        ruleEl.setText(ruleName);

        const severityEl = header.createEl('span', { cls: `quill-lint-badge quill-lint-${result.severity}` });
        severityEl.setText(result.severity);

        const passage = this.getPassageContext(result);
        if (passage !== null) {
            const ctxLabel = this.content.createEl('p', { cls: 'quill-details-label' });
            ctxLabel.setText('In text');

            const ctxBlock = this.content.createEl('div', { cls: 'quill-details-context' });

            for (const lineInfo of passage.lines) {
                const lineEl = ctxBlock.createEl('div', { cls: 'quill-details-context-line' });

                const lineNum = lineEl.createEl('span', { cls: 'quill-details-context-linenum' });
                lineNum.setText(String(lineInfo.index) + ' ');

                if (lineInfo.isFlagged) {
                    lineEl.createEl('span', { cls: 'quill-details-context-before' })
                        .setText(lineInfo.text.slice(0, passage.flaggedStart));

                    lineEl.createEl('span', { cls: 'quill-details-context-highlight' })
                        .setText(lineInfo.text.slice(passage.flaggedStart, passage.flaggedEnd));

                    lineEl.createEl('span', { cls: 'quill-details-context-after' })
                        .setText(lineInfo.text.slice(passage.flaggedEnd));
                } else {
                    lineEl.createEl('span', { cls: 'quill-details-context-text' })
                        .setText(lineInfo.text);
                }
            }
        }

        if (info) {
            const desc = this.content.createEl('p', { cls: 'quill-details-description' });
            desc.setText(info.description);

            const exampleLabel = this.content.createEl('p', { cls: 'quill-details-label' });
            exampleLabel.setText('Example');

            const example = this.content.createEl('p', { cls: 'quill-details-example' });
            example.setText(info.example);
        }

        if (FIXABLE_RULES.has(result.rule)) {
            const fix = FIXES[result.rule];
            if (fix) {
                const fixBtn = this.content.createEl('button', {
                    cls: 'quill-details-fix-btn',
                    text: fix.description,
                });
                this.renderEvents!.registerDomEvent(fixBtn, 'click', () => {
                    this.applyFix(result);
                    this.switchTab('results');
                });
            }
        }

        if (
            this.plugin.settings.enableLinterAiFixes &&
            this.plugin.getDefaultChatProvider()
        ) {
            const aiFixBtn = this.content.createEl('button', {
                cls: 'quill-details-fix-btn quill-details-ai-fix-btn',
                text: 'Fix with AI',
            });
            this.renderEvents!.registerDomEvent(aiFixBtn, 'click', () => {
                this.openFixWithAiModal(result);
            });

            const aiCustomBtn = this.content.createEl('button', {
                cls: 'quill-details-fix-btn quill-details-ai-custom-btn',
                text: 'Fix with AI (custom)',
            });
            this.renderEvents!.registerDomEvent(aiCustomBtn, 'click', () => {
                this.openFixWithAiModal(result, '');
            });
        }

        const dismissBtn = this.content.createEl('button', {
            cls: 'quill-details-dismiss-btn',
            text: 'Dismiss',
        });
        this.renderEvents!.registerDomEvent(dismissBtn, 'click', () => {
            this.plugin.dismissResult(result);
            this.switchTab('results');
        });

        const locationEl = this.content.createEl('p', { cls: 'quill-details-location' });
        locationEl.setText(`At line ${result.line}, column ${result.column + 1}`);

        const msgEl = this.content.createEl('p', { cls: 'quill-details-message' });
        msgEl.setText(result.message);
    }
}
