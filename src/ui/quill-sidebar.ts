import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { LintResult, RULE_INFO, FIXABLE_RULES } from '../core/linter/types';
import { FIXES } from '../core/linter/fixes';

export const QUILL_VIEW_TYPE = 'quill-sidebar';

type TabId = 'results' | 'details';

export class QuillSidebarView extends ItemView {
    private results: LintResult[] = [];
    private selectedResult: LintResult | null = null;
    private activeTab: TabId = 'results';
    private container!: HTMLElement;
    private tabBar!: HTMLElement;
    private content!: HTMLElement;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return QUILL_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Quill';
    }

    getIcon(): string {
        return 'feather';
    }

    async onOpen() {
        this.container = this.contentEl.createDiv({ cls: 'quill-sidebar' });
        this.tabBar = this.container.createDiv({ cls: 'quill-sidebar-tab-bar' });
        this.content = this.container.createDiv({ cls: 'quill-sidebar-content' });
        this.render();
    }

    setResults(results: LintResult[]) {
        this.results = results;
        if (this.activeTab === 'results') {
            this.render();
        }
    }

    showResultDetail(result: LintResult) {
        this.selectedResult = result;
        this.activeTab = 'details';
        this.render();
        this.jumpToResult(result);
    }

    private getMarkdownView(): MarkdownView | null {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (leaf.view instanceof MarkdownView) {
                return leaf.view;
            }
        }
        return null;
    }

    private jumpToResult(result: LintResult) {
        const markdownView = this.getMarkdownView();
        if (!markdownView) return;

        const editor = markdownView.editor;
        const line = result.line - 1;
        const col = result.column;

        editor.setCursor({ line, ch: col });
        editor.scrollIntoView({ from: { line, ch: col }, to: { line, ch: col } }, true);
    }

    private applyFix(result: LintResult) {
        const fix = FIXES[result.rule];
        if (!fix) return;

        const markdownView = this.getMarkdownView();
        if (!markdownView) return;

        const editor = markdownView.editor;
        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) return;

        const doc = cm.state.doc;
        const from = doc.line(result.line).from + result.column;
        const to = Math.min(from + result.length, doc.length);
        const text = doc.toString();
        const replacement = fix.apply(text, result.line, result.column, result.length);
        if (replacement === null) return;

        cm.dispatch({ changes: { from, to, insert: replacement } });
    }

    private getContextLine(result: LintResult): { text: string; offsetInLine: number } | null {
        const markdownView = this.getMarkdownView();
        if (!markdownView) return null;

        const lineText = markdownView.editor.getLine(result.line - 1);
        if (lineText === undefined) return null;

        return { text: lineText, offsetInLine: result.column };
    }

    private switchTab(tab: TabId) {
        this.activeTab = tab;
        this.render();
    }

    private render() {
        this.tabBar.empty();
        this.content.empty();

        this.renderTabBar();
        if (this.activeTab === 'results') {
            this.renderResultsTab();
        } else {
            this.renderDetailsTab();
        }
    }

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
            btn.addEventListener('click', () => this.switchTab(tab.id));
        }
    }

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
            item.addEventListener('click', () => this.showResultDetail(result));

            const badge = item.createEl('span', { cls: 'quill-lint-badge' });
            badge.setText(result.severity);

            const rule = item.createEl('span', { cls: 'quill-lint-rule-name' });
            rule.setText(info?.name ?? result.rule);

            const message = item.createEl('span', { cls: 'quill-lint-message' });
            message.setText(result.message);

            const location = item.createEl('span', { cls: 'quill-lint-location' });
            location.setText(`Ln ${result.line}, Col ${result.column}`);
        }
    }

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
        backBtn.addEventListener('click', () => this.switchTab('results'));

        const ruleEl = header.createEl('span', { cls: 'quill-details-rule-name' });
        ruleEl.setText(ruleName);

        const severityEl = header.createEl('span', { cls: `quill-lint-badge quill-lint-${result.severity}` });
        severityEl.setText(result.severity);

        const context = this.getContextLine(result);
        if (context !== null) {
            const ctxLabel = this.content.createEl('p', { cls: 'quill-details-label' });
            ctxLabel.setText('In text');

            const ctxBlock = this.content.createEl('div', { cls: 'quill-details-context' });
            const before = ctxBlock.createEl('span', { cls: 'quill-details-context-before' });
            before.setText(context.text.slice(0, context.offsetInLine));

            const highlight = ctxBlock.createEl('span', { cls: 'quill-details-context-highlight' });
            highlight.setText(context.text.slice(context.offsetInLine, context.offsetInLine + result.length));

            const after = ctxBlock.createEl('span', { cls: 'quill-details-context-after' });
            after.setText(context.text.slice(context.offsetInLine + result.length));
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
                fixBtn.addEventListener('click', () => {
                    this.applyFix(result);
                    this.switchTab('results');
                });
            }
        }

        const locationEl = this.content.createEl('p', { cls: 'quill-details-location' });
        locationEl.setText(`At line ${result.line}, column ${result.column}`);

        const msgEl = this.content.createEl('p', { cls: 'quill-details-message' });
        msgEl.setText(result.message);
    }
}
