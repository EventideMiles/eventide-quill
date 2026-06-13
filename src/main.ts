import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import {
    DEFAULT_SETTINGS,
    EventideQuillSettings,
    EventideQuillSettingTab,
} from './settings';
import { lint } from './core/linter/linter';
import { getLintExtension, setLintResults } from './core/linter/decorations';
import { LINT_VIEW_TYPE, LintResultsView } from './ui/lint-panel';

export default class EventideQuillPlugin extends Plugin {
    settings!: EventideQuillSettings;
    private lintPanel: LintResultsView | null = null;

    async onload() {
        await this.loadSettings();

        this.registerEditorExtension(getLintExtension());

        this.registerView(
            LINT_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new LintResultsView(leaf),
        );

        this.addRibbonIcon('checkmark', 'Show lint results', () => {
            this.openLintPanelNoAsync();
        });

        this.addCommand({
            id: 'lint-active-document',
            name: 'Lint active document',
            editorCallback: (editor) => {
                const text = editor.getValue();
                const results = lint(text);

                const cm = (editor as unknown as { cm: EditorView }).cm;
                if (cm) {
                    cm.dispatch({
                        effects: setLintResults.of(results),
                    });
                }

                this.lintPanel?.setResults(results);

                if (results.length === 0) {
                    new Notice('Prose linter: no issues found');
                    return;
                }

                const bySeverity = {
                    error: 0,
                    warning: 0,
                    info: 0,
                };

                for (const r of results) {
                    bySeverity[r.severity]++;
                }

                new Notice(
                    `Prose linter: ${results.length} issues found ` +
                    `(${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info)`,
                );
            },
        });

        this.addSettingTab(new EventideQuillSettingTab(this.app, this));
    }

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            (await this.loadData()) as Partial<EventideQuillSettings>,
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async openLintPanel() {
        const { workspace } = this.app;

        const existingLeaf = workspace.getLeavesOfType(LINT_VIEW_TYPE)[0];

        if (existingLeaf) {
            void workspace.revealLeaf(existingLeaf);
            this.lintPanel = existingLeaf.view as LintResultsView;
            return;
        }

        const leaf = workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: LINT_VIEW_TYPE, active: true });
        void workspace.revealLeaf(leaf);
        this.lintPanel = leaf.view as LintResultsView;
    }

    private openLintPanelNoAsync() {
        void this.openLintPanel();
    }
}
