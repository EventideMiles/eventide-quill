import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import {
    DEFAULT_SETTINGS,
    EventideQuillSettings,
    EventideQuillSettingTab,
} from './settings';
import { lint } from './core/linter/linter';
import {
    getLintExtension,
    setLintResults,
    toggleLintActive,
} from './core/linter/decorations';
import { QUILL_VIEW_TYPE, QuillSidebarView } from './ui/quill-sidebar';
import { LintResult, FIXABLE_RULES } from './core/linter/types';
import { FIXES } from './core/linter/fixes';

export default class EventideQuillPlugin extends Plugin {
    settings!: EventideQuillSettings;
    private lintPanel: QuillSidebarView | null = null;
    private lintActive = false;
    private lintActiveFile: string | null = null;
    private currentResults: LintResult[] = [];

    async onload() {
        await this.loadSettings();

        this.registerEditorExtension(
            getLintExtension(
                (text: string) => this.runLint(text),
                (results: LintResult[]) => {
                    this.currentResults = results;
                    this.lintPanel?.setResults(results);
                },
            ),
        );

        this.registerView(
            QUILL_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => {
                const view = new QuillSidebarView(leaf);
                this.lintPanel = view;
                return view;
            },
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile?.path !== this.lintActiveFile) {
                    this.lintActive = false;
                    this.lintActiveFile = null;
                    this.currentResults = [];
                }
            }),
        );

        this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
            if (
                !this.lintActive ||
                !this.settings.lintOnSave ||
                file !== this.app.workspace.getActiveFile()
            ) return;

            const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!markdownView) return;

            const text = markdownView.editor.getValue();
            const results = this.runLint(text);
            this.currentResults = results;

            const cm = this.getCmView(markdownView.editor);
            if (!cm) return;

            cm.dispatch({
                effects: setLintResults.of(results),
            });

            this.lintPanel?.setResults(results);
        }));

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
                menu.addItem((item) => {
                    item
                        .setTitle('Quill: Toggle prose linter')
                        .setIcon('checkmark')
                        .onClick(() => {
                            this.toggleLint(editor);
                        });
                });

                if (!this.lintActive || this.currentResults.length === 0) return;

                const cursor = editor.getCursor();
                const cursorLine = cursor.line + 1;
                const cursorCh = cursor.ch;

                const fixableAtCursor = this.currentResults.filter((r) => {
                    if (!FIXABLE_RULES.has(r.rule)) return false;
                    if (r.line !== cursorLine) return false;
                    return cursorCh >= r.column && cursorCh <= r.column + r.length;
                });

                if (fixableAtCursor.length === 0) return;

                menu.addSeparator();

                for (const result of fixableAtCursor) {
                    const fix = FIXES[result.rule];
                    if (!fix) continue;
                    menu.addItem((item) => {
                        item
                            .setTitle(`Quill: ${fix.description}`)
                            .setIcon('wrench')
                            .onClick(() => {
                                const cm = this.getCmView(editor);
                                if (!cm) return;
                                const doc = cm.state.doc;
                                const from = doc.line(result.line).from + result.column;
                                const to = Math.min(from + result.length, doc.length);
                                const text = doc.toString();
                                const replacement = fix.apply(text, result.line, result.column, result.length);
                                if (replacement === null) return;
                                cm.dispatch({ changes: { from, to, insert: replacement } });
                            });
                    });
                }
            }),
        );

        this.addRibbonIcon('feather', 'Show lint results', () => {
            this.openLintPanelNoAsync();
        });

        this.addCommand({
            id: 'lint-active-document',
            name: 'Quill: Toggle prose linter',
            editorCallback: (editor) => {
                this.toggleLint(editor);
            },
        });

        this.addSettingTab(new EventideQuillSettingTab(this.app, this));
    }

    onunload() {}

    private getCmView(editor: Editor): EditorView | undefined {
        return (editor as unknown as { cm: EditorView }).cm;
    }

    private toggleLint(editor: Editor) {
        const cm = this.getCmView(editor);
        if (!cm) return;

        this.lintActive = !this.lintActive;

        if (!this.lintActive) {
            cm.dispatch({
                effects: toggleLintActive.of(false),
            });
            this.lintActiveFile = null;
            this.currentResults = [];
            this.lintPanel?.setResults([]);
            new Notice('Prose linter: deactivated');
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        this.lintActiveFile = activeFile?.path ?? null;

        const text = editor.getValue();
        const results = this.runLint(text);
        this.currentResults = results;

        cm.dispatch({
            effects: [
                toggleLintActive.of(true),
                setLintResults.of(results),
            ],
        });

        this.lintPanel?.setResults(results);

        const count = results.length;
        if (count === 0) {
            new Notice('Prose linter: activated, no issues found');
            return;
        }

        const bySeverity = { error: 0, warning: 0, info: 0 };
        for (const r of results) bySeverity[r.severity]++;

        new Notice(
            `Prose linter: activated, ${count} issues found ` +
            `(${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info)`,
        );
    }

    private runLint(text: string): LintResult[] {
        const mode = this.settings.linterMode;
        const prose = mode === 'all' || mode === 'prose';
        const ai = mode === 'all' || mode === 'ai';

        return lint(text, {
            enableLongSentences: prose && this.settings.enableLongSentences,
            maxSentenceWords: this.settings.maxSentenceWords,
            enablePassiveVoice: prose && this.settings.enablePassiveVoice,
            enableAdverbCheck: prose && this.settings.enableAdverbCheck,
            enableQualifierCheck: prose && this.settings.enableQualifierCheck,
            enableRepeatedWords: prose && this.settings.enableRepeatedWords,
            minRepeatedWordLength: this.settings.minRepeatedWordLength,
            enableEchoes: prose && this.settings.enableEchoes,
            enableTellingVsShowing: prose && this.settings.enableTellingVsShowing,
            enableDialogueTags: prose && this.settings.enableDialogueTags,
            enableComplexWords: prose && this.settings.enableComplexWords,
            maxSyllablesPerWord: this.settings.maxSyllablesPerWord,
            enableAiCliches: ai && this.settings.enableAiCliches,
            enableAiEmDashes: ai && this.settings.enableAiEmDashes,
            enableAiNegation: ai && this.settings.enableAiNegation,
            enableAiFillerAdverbs: ai && this.settings.enableAiFillerAdverbs,
            enableAiHedging: ai && this.settings.enableAiHedging,
            enableAiWrapUps: ai && this.settings.enableAiWrapUps,
        });
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            (await this.loadData()) as Partial<EventideQuillSettings>,
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
        if (!this.lintActive) return;

        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!markdownView) return;

        const cm = this.getCmView(markdownView.editor);
        if (!cm) return;

        const text = markdownView.editor.getValue();
        const results = this.runLint(text);
        this.currentResults = results;

        cm.dispatch({
            effects: setLintResults.of(results),
        });

        this.lintPanel?.setResults(results);
    }

    private async openLintPanel() {
        const { workspace } = this.app;

        const existingLeaf = workspace.getLeavesOfType(QUILL_VIEW_TYPE)[0];

        if (existingLeaf) {
            void workspace.revealLeaf(existingLeaf);
            this.lintPanel = existingLeaf.view as QuillSidebarView;
            return;
        }

        const leaf = workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: QUILL_VIEW_TYPE, active: true });
        void workspace.revealLeaf(leaf);
        this.lintPanel = leaf.view as QuillSidebarView;
    }

    private openLintPanelNoAsync() {
        void this.openLintPanel();
    }
}
