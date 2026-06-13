import { ItemView, WorkspaceLeaf } from 'obsidian';
import { LintResult } from '../core/linter/types';

export const LINT_VIEW_TYPE = 'quill-lint-results';

export class LintResultsView extends ItemView {
    private results: LintResult[] = [];
    private container!: HTMLElement;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return LINT_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Lint results';
    }

    getIcon(): string {
        return 'checkmark';
    }

    async onOpen() {
        this.container = this.contentEl.createDiv({ cls: 'quill-lint-panel' });
        this.render();
    }

    setResults(results: LintResult[]) {
        this.results = results;
        this.render();
    }

    private render() {
        this.container.empty();

        if (this.results.length === 0) {
            this.container.createEl('p', {
                text: 'No issues found.',
                cls: 'quill-lint-empty',
            });
            return;
        }

        const header = this.container.createEl('div', { cls: 'quill-lint-header' });
        header.createEl('span', {
            text: `${this.results.length} issue${this.results.length !== 1 ? 's' : ''} found`,
        });

        const list = this.container.createEl('ul', { cls: 'quill-lint-list' });

        for (const result of this.results) {
            const item = list.createEl('li', { cls: `quill-lint-item quill-lint-${result.severity}` });

            const badge = item.createEl('span', { cls: 'quill-lint-badge' });
            badge.setText(result.severity);

            const rule = item.createEl('span', { cls: 'quill-lint-rule-name' });
            rule.setText(result.rule);

            const message = item.createEl('span', { cls: 'quill-lint-message' });
            message.setText(result.message);

            const location = item.createEl('span', { cls: 'quill-lint-location' });
            location.setText(`Ln ${result.line}, Col ${result.column}`);
        }
    }
}
