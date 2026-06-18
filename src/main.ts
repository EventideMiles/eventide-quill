import { Editor, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, EventideQuillSettings, EventideQuillSettingTab } from './settings';
import { lint } from './core/linter/linter';
import { getLintExtension, setLintResults, toggleLintActive } from './core/linter/decorations';
import { QUILL_VIEW_TYPE, QuillSidebarView } from './ui/quill-sidebar';
import { LintResult, FIXABLE_RULES } from './core/linter/types';
import { FIXES } from './core/linter/fixes';
import { applyReplacement } from './core/linter/apply-fix';
import { findEditorView } from './utils/find-editor';
import { extractScene } from './utils/text-analysis';
import { AiProvider } from './ai/provider';
import { createProvider, parseProviderKey } from './ai/provider-registry';
import { applyTransformation, TRANSFORM_ACTIONS } from './ai/transform';
import { ToneSuggestModal, TransformModal } from './ui/transform-modal';
import { FixWithAiModal } from './ui/fix-with-ai-modal';
import { ContextCache } from './core/context-engine';
import { extractAllEntities, analyzeVoice, assembleContext } from './core/context-engine';
import type { ContextAssembly, ContextItem, ExtractedEntity, EntityType } from './core/context-engine/types';
import {
    loadQuillContextData,
    writeQuillContextData,
    buildQuillContextData,
    setPlotMap,
    entityFromId
} from './utils/frontmatter';
import { buildFeedbackMessages, getPersonaById, getFeedback } from './ai/feedback';
import {
    getAnalysis,
    buildAnalysisMessages,
    ANALYSIS_MODES,
    type AnalysisMode,
    type AnalysisScope
} from './ai/analysis';
import type { ChatMessage } from './ai/provider';

import { CoWriterSession, loadAdditionalContext } from './ai/co-writer';
import { compactConversation } from './ai/compaction';
import { estimateTokens } from './utils/tokens';
import { readVaultFileText } from './utils/vault-files';
import { parseDirectives } from './utils/directives';
import {
    getChangeDiffExtension,
    clearDiffEdits,
    diffEditsField,
    setDiffEdits,
    syncChangeSetPositions
} from './ui/change-diff-extension';
import { ChangeSet } from './core/change-set';
import { readVaultFiles } from './utils/vault-files';

/** Generate a content-based fingerprint for a lint result. Uses the flagged
 *  text plus the line it appears on to distinguish multiple instances of the
 *  same rule on different lines, while remaining resilient to position shifts. */
function lintFingerprint(result: LintResult, lineText?: string): string {
    const text = lineText ?? '';
    return `${result.rule}::${result.column}::${text}`;
}

/** Apply persisted entity modifications (pins, removals, manual adds) to freshly extracted entities. */
function applyEntityMods(
    entities: ExtractedEntity[],
    mods: Map<string, { pinned: boolean; removed: boolean; manual: boolean; entity: ExtractedEntity }>
): void {
    for (const [id, mod] of mods) {
        if (mod.removed) {
            const entity = entities.find((e) => e.id === id);
            if (entity) entity.removed = true;
            continue;
        }
        if (mod.manual) {
            if (!entities.some((e) => e.id === id)) {
                entities.push({ ...mod.entity });
            }
        }
        const entity = entities.find((e) => e.id === id);
        if (entity && mod.pinned) {
            entity.pinned = true;
        }
    }
}

/** Apply persisted context item modifications (pins, removals) to freshly assembled items. */
function applyContextItemMods(items: ContextItem[], pinnedPaths: Set<string>, removedPaths: Set<string>): void {
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (removedPaths.has(item.filePath)) {
            items.splice(i, 1);
        }
    }
    for (const item of items) {
        if (pinnedPaths.has(item.filePath)) {
            item.pinned = true;
        }
    }
}

export default class EventideQuillPlugin extends Plugin {
    settings!: EventideQuillSettings;
    private lintPanel: QuillSidebarView | null = null;
    /** Abort controller for the current feedback request, if any. */
    private feedbackAbort: AbortController | null = null;
    /** Full message history (system + context heads + chat turns) for continued chat.
     *  Manuscript and reference file content is NOT stored here — it is injected
     *  fresh as system messages on every API call so it always survives compaction
     *  and never double-counts in token estimates. */
    private feedbackCurrentMessages: ChatMessage[] = [];
    /** Abort controller for the current analysis request, if any. */
    private analysisAbort: AbortController | null = null;
    /** Full message history for the analysis conversation (system + context heads + chat turns). */
    private analysisCurrentMessages: ChatMessage[] = [];
    private lintActive = false;
    lintActiveFile: string | null = null;
    /** File path for the currently assembled context. Tracked separately from lintActiveFile. */
    contextActiveFile: string | null = null;
    private currentResults: LintResult[] = [];
    private providerMap = new Map<string, AiProvider>();
    /** True while a selection transformation is being processed. Used to gate the context menu. */
    transformInProgress = false;
    /** Abort controller for an in-flight transform, so Escape can cancel it. */
    transformAbortController: AbortController | null = null;

    /** Cancel an in-flight transform (called on Escape). */
    cancelTransform(): void {
        this.transformAbortController?.abort();
        this.transformAbortController = null;
    }
    /** Dismissed lint fingerprints for the current session. Cleared when the linter is deactivated. */
    private dismissedFingerprints = new Set<string>();
    /** Context cache for extracted entities and voice markers. */
    private contextCache = new ContextCache();
    /** Current context assembly for the active document. */
    currentAssembly: ContextAssembly | null = null;
    /** Path of the plot map note linked to the active document, or null when none is linked. */
    currentPlotMap: string | null = null;
    /** Path of the document currentPlotMap was loaded from (staleness guard). */
    private plotMapFile: string | null = null;
    /** User modifications to entities (pins, removals, manual adds) keyed by entity ID. */
    private entityMods = new Map<
        string,
        { pinned: boolean; removed: boolean; manual: boolean; entity: ExtractedEntity }
    >();
    /** Paths of context items the user has pinned. */
    private pinnedContextPaths = new Set<string>();
    /** Paths of context items the user has removed. */
    removedContextPaths = new Set<string>();
    /** Manual context items added by the user (not auto-discovered). */
    private manualContextItems: ContextItem[] = [];
    /** Co-writer session for the collaborative drafting feature. */
    coWriterSession: CoWriterSession = new CoWriterSession();
    /** Proposed transform edit awaiting inline review (one at a time). */
    transformChangeSet: ChangeSet = new ChangeSet();

    /** Plugin entry point: register commands, views, extensions, and event handlers. */
    async onload() {
        await this.loadSettings();
        this.rebuildProviders();

        this.registerEditorExtension(
            getLintExtension(
                (text: string) => this.runLint(text),
                (results: LintResult[]) => {
                    this.currentResults = results;
                    this.lintPanel?.setResults(results);
                },
                (result, view) => this.openInlineAiFix(result, view),
                (result, view) => this.dismissResult(result, view),
                () => {
                    if (!this.settings.enableLinterAiFixes) return false;
                    const chat = this.getDefaultChatProvider();
                    return !!chat.provider;
                }
            )
        );

        // Track whether an inline directive is active at the cursor so the
        // co-writer panel can show its "Directive active" badge. Reactive
        // (fires on cursor/doc changes) and lifecycle-safe (auto-removed on unload).
        this.registerEditorExtension(
            EditorView.updateListener.of((update) => {
                if (!this.settings.enableInlineDirectives) return;
                if (!update.selectionSet && !update.docChanged) return;
                const pos = update.state.selection.main.head;
                const textBeforeCursor = update.state.sliceDoc(Math.max(0, pos - 4000), pos);
                const active = parseDirectives(textBeforeCursor).length > 0;
                this.lintPanel?.coWriterSetDirectiveActive(active);
            })
        );

        // Inline change-diff (red removals / green additions) for proposed edits
        // from Fulfill, Transform, and (later) Co-writer direct. Registered once,
        // globally; it only renders when a snapshot is pushed to a given editor.
        this.registerEditorExtension(
            getChangeDiffExtension({
                onApprove: (owner: string, id: number) => {
                    if (owner === 'fulfill') this.approveCoWriterFulfill(id);
                    else if (owner === 'transform') this.approveTransformChange(id);
                    else if (owner === 'direct') this.approveDirectChange(id);
                },
                onReject: (owner: string, id: number) => {
                    if (owner === 'fulfill') this.rejectCoWriterFulfill(id);
                    else if (owner === 'transform') this.rejectTransformChange(id);
                    else if (owner === 'direct') this.rejectDirectChange(id);
                }
            })
        );

        // Escape cancels an in-flight transform.
        this.registerEditorExtension(
            EditorView.domEventHandlers({
                keydown: (event: KeyboardEvent) => {
                    if (event.key === 'Escape' && this.transformInProgress) {
                        this.cancelTransform();
                    }
                    return false;
                }
            })
        );

        this.registerView(QUILL_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
            const view = new QuillSidebarView(leaf, this);
            this.lintPanel = view;
            return view;
        });

        // Context is not auto-loaded on startup.
        // User must explicitly refresh via right-click, command palette, or transform.

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                const activeFile = this.app.workspace.getActiveFile();

                // Linter: reset when the tracked linter file changes
                const lintFileChange = activeFile?.path !== this.lintActiveFile;
                if (lintFileChange) {
                    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
                        if (leaf.view instanceof MarkdownView) {
                            const cm = this.getCmView(leaf.view.editor);
                            if (cm) {
                                cm.dispatch({ effects: toggleLintActive.of(false) });
                            }
                        }
                    }
                    this.lintActive = false;
                    this.lintActiveFile = null;
                    this.currentResults = [];
                    this.dismissedFingerprints.clear();
                    this.lintPanel?.setResults([]);
                }

                // Context: only reset when the context file is no longer open.
                // Does NOT auto-scan on leaf focus changes — user must explicitly
                // refresh via right-click, command palette, or a transform operation.
                if (this.contextActiveFile) {
                    const stillOpen = this.app.workspace.getLeavesOfType('markdown').some((leaf) => {
                        if (leaf.view instanceof MarkdownView) {
                            return leaf.view.file?.path === this.contextActiveFile;
                        }
                        return false;
                    });
                    if (!stillOpen) {
                        this.currentAssembly = null;
                        this.contextActiveFile = null;
                        this.entityMods.clear();
                        this.pinnedContextPaths.clear();
                        this.removedContextPaths.clear();
                        this.manualContextItems = [];
                        this.currentPlotMap = null;
                        this.plotMapFile = null;
                        this.lintPanel?.setContextAssembly(null);
                    }
                }

                // Co-writer: clear voice profile when the manuscript changes
                if (this.coWriterSession.manuscriptPath && activeFile?.path !== this.coWriterSession.manuscriptPath) {
                    this.coWriterSession.clearVoiceProfile();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file: TAbstractFile) => {
                if (file instanceof TFile) {
                    this.contextCache.invalidate(file.path);
                }

                if (!this.lintActive || !this.settings.lintOnSave || file !== this.app.workspace.getActiveFile())
                    return;

                const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!markdownView) return;

                const text = markdownView.editor.getValue();
                const results = this.runLint(text);
                this.currentResults = results;

                const cm = this.getCmView(markdownView.editor);
                if (!cm) return;

                cm.dispatch({
                    effects: setLintResults.of(results)
                });

                this.lintPanel?.setResults(results);
            })
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
                menu.addItem((item) => {
                    item.setTitle('Quill: Toggle prose linter')
                        .setIcon('checkmark')
                        .onClick(() => {
                            this.toggleLint(editor);
                        });
                });

                menu.addItem((item) => {
                    item.setTitle('Quill: Refresh context')
                        .setIcon('refresh-cw')
                        .onClick(() => {
                            // Find the file for the editor that was right-clicked.
                            // In split view, getActiveFile() returns the focused leaf's file,
                            // which may differ from the leaf where the right-click occurred.
                            // Walk all leaves to find the one whose editor matches.
                            let targetFile: TFile | null = null;
                            for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
                                if (leaf.view instanceof MarkdownView) {
                                    const viewEditor = leaf.view.editor;
                                    if (viewEditor === editor) {
                                        targetFile = leaf.view.file;
                                        break;
                                    }
                                }
                            }
                            if (targetFile) {
                                this.scanContext(editor.getValue(), targetFile.path);
                                void this.assembleDocumentContext(editor.getValue(), targetFile.path);
                            }
                        });
                });

                menu.addItem((item) => {
                    item.setTitle('Quill: Insert inline directive')
                        .setIcon('quote')
                        .onClick(() => {
                            this.insertInlineDirective(editor);
                        });
                });

                // Feedback menu item
                menu.addSeparator();
                menu.addItem((item) => {
                    item.setTitle('Quill: Get AI feedback')
                        .setIcon('message-square')
                        .onClick(() => {
                            void this.openReviewPanel();
                        });
                });

                // Analysis submenu: jump straight to a mode
                if (this.settings.enableCriticalAnalysis) {
                    menu.addSeparator();
                    menu.addItem((item) => {
                        item.setTitle('Quill: Analyze').setIcon('search');
                        // setSubmenu exists at runtime but isn't in the obsidian type defs.
                        const sub = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
                        sub.addItem((s) => {
                            s.setTitle('Plot logic').onClick(async () => {
                                await this.openReviewPanel();
                                await this.requestAnalysis('plot-logic', 'auto');
                            });
                        });
                        sub.addItem((s) => {
                            s.setTitle('Character consistency').onClick(async () => {
                                await this.openReviewPanel();
                                await this.requestAnalysis('character-consistency', 'auto');
                            });
                        });
                        sub.addItem((s) => {
                            s.setTitle('Continuity').onClick(async () => {
                                await this.openReviewPanel();
                                await this.requestAnalysis('continuity', 'auto');
                            });
                        });
                        sub.addItem((s) => {
                            s.setTitle('Voice drift').onClick(async () => {
                                await this.openReviewPanel();
                                await this.requestAnalysis('voice-drift', 'auto');
                            });
                        });
                    });
                }

                // Co-writer submenu: jump straight to a mode
                menu.addSeparator();
                menu.addItem((item) => {
                    item.setTitle('Quill: Co-writer').setIcon('feather');
                    // setSubmenu exists at runtime but isn't in the obsidian type defs.
                    const sub = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
                    sub.addItem((s) => {
                        s.setTitle('Direct').onClick(async () => {
                            await this.openCoWriterPanel();
                            this.lintPanel?.coWriterSetMode('direct');
                        });
                    });
                    sub.addItem((s) => {
                        s.setTitle('Discuss').onClick(async () => {
                            await this.openCoWriterPanel();
                            this.lintPanel?.coWriterSetMode('discuss');
                        });
                    });
                    sub.addItem((s) => {
                        s.setTitle('Coach').onClick(async () => {
                            await this.openCoWriterPanel();
                            this.lintPanel?.coWriterSetMode('coach');
                        });
                    });
                    sub.addItem((s) => {
                        s.setTitle('Fulfill \u2014 run sweep').onClick(async () => {
                            await this.openCoWriterPanel();
                            this.lintPanel?.coWriterSetMode('fulfill');
                            await this.runCoWriterFulfill('');
                        });
                    });
                });

                // Linter fix items
                if (this.lintActive && this.currentResults.length > 0) {
                    const cursor = editor.getCursor();
                    const cursorLine = cursor.line + 1;
                    const cursorCh = cursor.ch;

                    const fixableAtCursor = this.currentResults.filter((r) => {
                        if (!FIXABLE_RULES.has(r.rule)) return false;
                        if (r.line !== cursorLine) return false;
                        return cursorCh >= r.column && cursorCh <= r.column + r.length;
                    });

                    if (fixableAtCursor.length > 0) {
                        menu.addSeparator();

                        for (const result of fixableAtCursor) {
                            const fix = FIXES[result.rule];
                            if (!fix) continue;
                            menu.addItem((item) => {
                                item.setTitle(`Quill: ${fix.description}`)
                                    .setIcon('wrench')
                                    .onClick(() => {
                                        const text = editor.getValue();
                                        const replacement = fix.apply(text, result.line, result.column, result.length);
                                        if (replacement === null) return;
                                        applyReplacement(editor, result, replacement);
                                    });
                            });
                        }
                    }
                }

                // Selection transformation items — hidden while one is in flight
                const selection = editor.getSelection();
                if (selection && !this.transformInProgress) {
                    const fullText = editor.getValue();

                    // Find the file for the editor where the right-click occurred.
                    let targetFile: TFile | null = null;
                    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
                        if (leaf.view instanceof MarkdownView) {
                            const viewEditor = leaf.view.editor;
                            if (viewEditor === editor) {
                                targetFile = leaf.view.file;
                                break;
                            }
                        }
                    }

                    const filePath = targetFile?.path;

                    menu.addSeparator();

                    for (const action of TRANSFORM_ACTIONS) {
                        if (action.id === 'change-tone') {
                            menu.addItem((item) => {
                                item.setTitle(`Quill: ${action.label}`)
                                    .setIcon(action.icon)
                                    .onClick(() => {
                                        new ToneSuggestModal(this.app, (tone) => {
                                            void applyTransformation(
                                                this,
                                                editor,
                                                'change-tone',
                                                selection,
                                                fullText,
                                                tone,
                                                filePath
                                            );
                                        }).open();
                                    });
                            });
                        } else if (action.id === 'custom') {
                            menu.addItem((item) => {
                                item.setTitle(`Quill: ${action.label}`)
                                    .setIcon(action.icon)
                                    .onClick(() => {
                                        new TransformModal(this.app, selection, (instruction) => {
                                            void applyTransformation(
                                                this,
                                                editor,
                                                'custom',
                                                selection,
                                                fullText,
                                                instruction,
                                                filePath
                                            );
                                        }).open();
                                    });
                            });
                        } else {
                            menu.addItem((item) => {
                                item.setTitle(`Quill: ${action.label}`)
                                    .setIcon(action.icon)
                                    .onClick(() => {
                                        void applyTransformation(
                                            this,
                                            editor,
                                            action.id,
                                            selection,
                                            fullText,
                                            undefined,
                                            filePath
                                        );
                                    });
                            });
                        }
                    }
                }
            })
        );

        this.addRibbonIcon('feather', 'Eventide quill sidebar', () => {
            this.openLintPanelNoAsync();
        });

        this.addCommand({
            id: 'scan-document-context',
            name: 'Quill: Scan document context',
            editorCallback: (editor) => {
                const file = this.app.workspace.getActiveFile();
                this.scanContext(editor.getValue(), file?.path ?? '');
                void this.assembleDocumentContext(editor.getValue());
            }
        });

        this.addCommand({
            id: 'lint-active-document',
            name: 'Quill: Toggle prose linter',
            editorCallback: (editor) => {
                this.toggleLint(editor);
            }
        });

        this.addCommand({
            id: 'quill-feedback-open',
            name: 'Quill: Get AI feedback',
            callback: () => {
                void this.openReviewPanel();
            }
        });

        this.addCommand({
            id: 'quill-cowriter-open',
            name: 'Quill: Open co-writer',
            callback: () => {
                void this.openCoWriterPanel();
            }
        });

        this.addCommand({
            id: 'quill-analysis-open',
            name: 'Quill: Open critical analysis',
            callback: () => {
                void this.openReviewPanel();
            }
        });

        this.addCommand({
            id: 'quill-analyze-plot-logic',
            name: 'Quill: Analyze plot logic',
            editorCallback: async (editor) => {
                await this.openReviewPanel();
                await this.requestAnalysis('plot-logic', 'auto');
            }
        });

        this.addCommand({
            id: 'quill-analyze-character-consistency',
            name: 'Quill: Analyze character consistency',
            editorCallback: async (editor) => {
                await this.openReviewPanel();
                await this.requestAnalysis('character-consistency', 'auto');
            }
        });

        this.addCommand({
            id: 'quill-analyze-continuity',
            name: 'Quill: Analyze continuity',
            editorCallback: async (editor) => {
                await this.openReviewPanel();
                await this.requestAnalysis('continuity', 'auto');
            }
        });

        this.addCommand({
            id: 'quill-analyze-voice-drift',
            name: 'Quill: Analyze voice drift',
            editorCallback: async (editor) => {
                await this.openReviewPanel();
                await this.requestAnalysis('voice-drift', 'auto');
            }
        });

        this.addCommand({
            id: 'quill-insert-directive',
            name: 'Quill: Insert inline directive',
            editorCallback: (editor) => {
                this.insertInlineDirective(editor);
            }
        });

        this.addSettingTab(new EventideQuillSettingTab(this.app, this));
    }

    /** Clean up resources when the plugin is unloaded. */
    onunload() {}

    /** Retrieve the CodeMirror EditorView from an Obsidian Editor instance. */
    private getCmView(editor: Editor): EditorView | undefined {
        return (editor as unknown as { cm: EditorView }).cm;
    }

    /** Insert an inline `<!-- quill:  -->` directive at the cursor and place the
     *  caret between 'quill: ' and ' -->' so the writer can type the instruction. */
    private insertInlineDirective(editor: Editor): void {
        const cursor = editor.getCursor();
        const base = editor.posToOffset(cursor);
        editor.replaceRange('<!-- quill:  -->', cursor);
        editor.setCursor(editor.offsetToPos(base + '<!-- quill: '.length));
    }

    /** Toggle the prose linter on or off for the active editor, dispatching state to CodeMirror. */
    private toggleLint(editor: Editor) {
        const cm = this.getCmView(editor);
        if (!cm) return;

        this.lintActive = !this.lintActive;

        if (!this.lintActive) {
            cm.dispatch({
                effects: toggleLintActive.of(false)
            });
            this.lintActiveFile = null;
            this.currentResults = [];
            this.dismissedFingerprints.clear();
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
            effects: [toggleLintActive.of(true), setLintResults.of(results)]
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
                `(${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info)`
        );
    }

    /** Run the linter against `text` using the current settings and mode, filtering out dismissed results. */
    private runLint(text: string): LintResult[] {
        const mode = this.settings.linterMode;
        const prose = mode === 'all' || mode === 'prose';
        const ai = mode === 'all' || mode === 'ai';

        const rawResults = lint(text, {
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
            enableAiWrapUps: ai && this.settings.enableAiWrapUps
        });

        const lines = text.split('\n');

        return rawResults.filter((r) => {
            const lineText = lines[r.line - 1] ?? '';
            return !this.dismissedFingerprints.has(lintFingerprint(r, lineText));
        });
    }

    /** Generate a fingerprint for a lint result: rule + column + line content. */
    lintFingerprint(result: LintResult): string | null {
        const view = findEditorView(this.app, this.lintActiveFile);
        if (!view) return null;

        const lineText = view.editor.getLine(result.line - 1);
        return lintFingerprint(result, lineText ?? '');
    }

    /** Dismiss a lint result for the current session. It will reappear after reactivation. */
    dismissResult(result: LintResult, _view?: EditorView): void {
        const view = findEditorView(this.app, this.lintActiveFile);
        if (!view) return;

        const lineText = view.editor.getLine(result.line - 1);
        this.dismissedFingerprints.add(lintFingerprint(result, lineText));
        // Re-lint with the dismissal applied
        const text = view.editor.getValue();
        const results = this.runLint(text);
        this.currentResults = results;

        const cm = this.getCmView(view.editor);
        if (cm) {
            cm.dispatch({ effects: setLintResults.of(results) });
        }

        this.lintPanel?.setResults(results);
    }

    /** Load persisted settings, merging with defaults. */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<EventideQuillSettings>);
    }

    /**
     * Persist current settings to disk, rebuild the provider map, and re-lint
     * the active document if the linter is active.
     */
    async saveSettings() {
        await this.saveData(this.settings);
        this.rebuildProviders();
        if (!this.lintActive) return;

        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!markdownView) return;

        const cm = this.getCmView(markdownView.editor);
        if (!cm) return;

        const text = markdownView.editor.getValue();
        const results = this.runLint(text);
        this.currentResults = results;

        cm.dispatch({
            effects: setLintResults.of(results)
        });

        this.lintPanel?.setResults(results);
    }

    /** Rebuild the provider map from current settings. Call after loading or saving settings. */
    private rebuildProviders(): void {
        this.providerMap.clear();
        for (const config of this.settings.aiProviders) {
            try {
                const provider = createProvider(config);
                this.providerMap.set(config.id, provider);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`Failed to create provider "${config.id}": ${msg}`);
            }
        }
    }

    /**
     * Get an AI provider by its config ID.
     * Returns null if the provider is not found or failed to initialize.
     */
    getProvider(providerId: string): AiProvider | null {
        return this.providerMap.get(providerId) ?? null;
    }

    /**
     * Get the default chat provider and model based on settings.
     * Returns { provider, modelId } or { provider: null } if not configured.
     */
    getDefaultChatProvider(): { provider: AiProvider | null; modelId?: string } {
        const key = parseProviderKey(this.settings.aiDefaultChatProvider);
        if (!key) return { provider: null };
        const provider = this.getProvider(key.providerId);
        return { provider, modelId: key.modelId || undefined };
    }

    /** Get the default embed provider based on settings. Returns null if not configured. */
    getDefaultEmbedProvider(): AiProvider | null {
        const key = parseProviderKey(this.settings.aiDefaultEmbedProvider);
        if (!key) return null;
        return this.getProvider(key.providerId);
    }

    /** Open the Fix with AI modal for a lint result triggered from an in-editor tooltip. */
    private openInlineAiFix(result: LintResult, _view: EditorView): void {
        const view = findEditorView(this.app, this.lintActiveFile);
        if (!view) return;

        const editorText = view.editor.getValue();

        // Capture the original span at lint time so we can validate it later.
        const lines = editorText.split('\n');
        const lineIndex = result.line - 1;
        const line = lines[lineIndex];
        if (line === undefined) return;
        const originalSpan = line.slice(result.column, result.column + result.length);

        new FixWithAiModal(this.app, this, result, editorText, (replacement: string) => {
            // Validate that the span is still accurate before applying.
            const currentLine = view.editor.getLine(lineIndex);
            if (currentLine === undefined) return;
            const currentSpan = currentLine.slice(result.column, result.column + result.length);
            if (currentSpan !== originalSpan) {
                new Notice('Quill: Text has changed since this suggestion was generated.');
                return;
            }

            applyReplacement(view.editor, result, replacement);
        }).open();
    }

    /** Open or reveal the Quill sidebar panel. */
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

    /** Fire-and-forget wrapper around `openLintPanel`. */
    private openLintPanelNoAsync() {
        void this.openLintPanel();
    }

    /** Extract entities and voice markers from the active document and cache the results. */
    scanContext(text: string, filePath: string): void {
        const entities = extractAllEntities(text);
        const voice = analyzeVoice(text);
        this.contextCache.set(filePath, { entities, voice });
    }

    /** Run full context assembly including vault search. Applies any
     *  user modifications (pins, removals, manual adds) from entityMods
     *  and pinnedContextPaths/removedContextPaths/manualContextItems.
     *  On first assembly for a file, loads persisted mods from frontmatter. */
    async assembleDocumentContext(text: string, filePath?: string): Promise<ContextAssembly> {
        const path = filePath ?? this.contextActiveFile ?? '';
        if (path !== this.contextActiveFile && this.contextActiveFile !== null) {
            this.entityMods.clear();
            this.pinnedContextPaths.clear();
            this.removedContextPaths.clear();
            this.manualContextItems = [];
        }
        let cached = this.contextCache.get(path);
        if (!cached) {
            this.scanContext(text, path);
            cached = this.contextCache.get(path);
            if (!cached) {
                return {
                    entities: [],
                    voice: {
                        pov: 'unknown',
                        tense: 'unknown',
                        avgSentenceLength: 0,
                        dialogueRatio: 0,
                        descriptionRatio: 1
                    },
                    contextItems: [],
                    totalTokens: 0,
                    tokenBudget: this.settings.contextTokenBudget,
                    budgetExceeded: false,
                    compacted: false
                };
            }
        }

        if (
            this.entityMods.size === 0 &&
            this.pinnedContextPaths.size === 0 &&
            this.removedContextPaths.size === 0 &&
            this.manualContextItems.length === 0
        ) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                this.loadModsFromFrontmatter(file);
            }
        }

        const activeEntities = cached.entities.filter((e) => !e.removed);
        const assembly = await assembleContext(this.app.vault, text, activeEntities, cached.voice, {
            tokenBudget: this.settings.contextTokenBudget,
            compactAtPercent: this.settings.contextCompactAtPercent,
            includeVaultContext: this.settings.contextIncludeVaultContext,
            maxVaultFiles: this.settings.contextMaxVaultFiles,
            maxCharsPerFile: this.settings.contextMaxCharsPerFile
        });

        applyEntityMods(assembly.entities, this.entityMods);
        applyContextItemMods(assembly.contextItems, this.pinnedContextPaths, this.removedContextPaths);

        for (const item of this.manualContextItems) {
            if (!assembly.contextItems.some((i) => i.filePath === item.filePath)) {
                if (!item.excerpt) {
                    const mf = this.app.vault.getAbstractFileByPath(item.filePath);
                    if (mf instanceof TFile) {
                        const content = await this.app.vault.cachedRead(mf);
                        item.excerpt = content.slice(0, this.settings.contextMaxCharsPerFile);
                        item.tokenEstimate = Math.ceil(item.excerpt.length / 4);
                    }
                }
                assembly.contextItems.push(item);
                assembly.totalTokens += item.tokenEstimate;
            }
        }

        this.currentAssembly = assembly;
        this.contextActiveFile = path;
        this.lintPanel?.setContextAssembly(assembly);
        return assembly;
    }

    /** Load persisted context modifications from the file's frontmatter
     *  into in-memory tracking structures. Only runs when those
     *  structures are still empty (first assembly for this file). */
    loadModsFromFrontmatter(file: TFile): void {
        const fm = loadQuillContextData(this.app, file);

        for (const id of fm.pinnedEntities ?? []) {
            this.entityMods.set(id, { pinned: true, removed: false, manual: false, entity: entityFromId(id) });
        }
        for (const id of fm.removedEntities ?? []) {
            this.entityMods.set(id, { pinned: false, removed: true, manual: false, entity: entityFromId(id) });
        }
        for (const id of fm.addedEntities ?? []) {
            this.entityMods.set(id, { pinned: true, removed: false, manual: true, entity: entityFromId(id) });
        }

        for (const p of fm.pinnedFiles ?? []) {
            this.pinnedContextPaths.add(p);
        }
        for (const p of fm.removedFiles ?? []) {
            this.removedContextPaths.add(p);
        }

        for (const fp of fm.addedFiles ?? []) {
            if (!this.manualContextItems.some((i) => i.filePath === fp)) {
                this.manualContextItems.push({
                    filePath: fp,
                    excerpt: '',
                    matchedEntities: [],
                    tokenEstimate: 0,
                    pinned: true,
                    relevanceScore: 10,
                    manual: true
                });
            }
        }

        this.currentPlotMap = fm.plotMap ?? null;
        this.plotMapFile = file.path;
    }

    /** Sync current in-memory mods to the document's frontmatter.
     *  Fire-and-forget — errors are logged, not thrown. */
    syncQuillFrontmatter(): void {
        if (!this.contextActiveFile) return;
        const file = this.app.vault.getAbstractFileByPath(this.contextActiveFile);
        if (!(file instanceof TFile)) return;
        const data = buildQuillContextData({
            entityMods: this.entityMods,
            pinnedContextPaths: this.pinnedContextPaths,
            removedContextPaths: this.removedContextPaths,
            manualContextItems: this.manualContextItems
        });
        writeQuillContextData(this.app, file, data).catch((err) => {
            console.warn('Quill: failed to sync context data', err);
        });
    }

    /** Refresh currentPlotMap from the active file's frontmatter if it is stale.
     *  Cheap (metadata cache read). Safe to call repeatedly. */
    refreshPlotMap(): void {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
            this.currentPlotMap = null;
            this.plotMapFile = null;
            return;
        }
        if (active.path === this.plotMapFile) return;
        const fm = loadQuillContextData(this.app, active);
        this.currentPlotMap = fm.plotMap ?? null;
        this.plotMapFile = active.path;
    }

    /** Link a plot map note to the active manuscript. Persists to frontmatter. */
    async setPlotMapLink(path: string): Promise<void> {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
            new Notice('Quill: Open a manuscript to link a plot map.');
            return;
        }
        this.currentPlotMap = path;
        this.plotMapFile = active.path;
        await setPlotMap(this.app, active, path);
        this.lintPanel?.coWriterSetPlotMap(path);
        await this.updateCoWriterPlotMapTokens();
    }

    /** Unlink the plot map from the active manuscript. Persists to frontmatter. */
    async clearPlotMapLink(): Promise<void> {
        const active = this.app.workspace.getActiveFile();
        if (!active) return;
        this.currentPlotMap = null;
        this.plotMapFile = active.path;
        await setPlotMap(this.app, active, null);
        this.lintPanel?.coWriterSetPlotMap(null);
        await this.updateCoWriterPlotMapTokens();
    }

    /** Toggle the pinned state of an entity. Persists across re-assemblies and to frontmatter. */
    toggleEntityPin(entityId: string): void {
        if (!this.currentAssembly) return;
        const entity = this.currentAssembly.entities.find((e) => e.id === entityId);
        if (entity) {
            entity.pinned = !entity.pinned;
            this.entityMods.set(entityId, {
                pinned: entity.pinned,
                removed: entity.removed,
                manual: entity.manual,
                entity
            });
            this.lintPanel?.setContextAssembly(this.currentAssembly);
            this.syncQuillFrontmatter();
        }
    }

    /** Remove an entity from the current context. Persists across re-assemblies and to frontmatter. */
    removeEntity(entityId: string): void {
        if (!this.currentAssembly) return;
        const entity = this.currentAssembly.entities.find((e) => e.id === entityId);
        if (entity) {
            entity.removed = true;
            this.entityMods.set(entityId, { pinned: entity.pinned, removed: true, manual: entity.manual, entity });
            this.lintPanel?.setContextAssembly(this.currentAssembly);
            this.syncQuillFrontmatter();
        }
    }

    /** Add a manual entity to the current context. Persists across re-assemblies and to frontmatter. */
    addManualEntity(name: string, type: EntityType): void {
        if (!this.currentAssembly) return;
        const id = `${type}:${name.toLowerCase().replace(/\s+/g, '-')}`;
        const entity: ExtractedEntity = {
            id,
            type,
            name,
            occurrences: 0,
            lines: [],
            aliases: [],
            pinned: true,
            removed: false,
            manual: true
        };
        this.currentAssembly.entities.push(entity);
        this.entityMods.set(id, { pinned: true, removed: false, manual: true, entity });
        this.lintPanel?.setContextAssembly(this.currentAssembly);
        this.syncQuillFrontmatter();
    }

    /** Toggle the pinned state of a context item. Persists across re-assemblies and to frontmatter. */
    toggleContextItemPin(filePath: string): void {
        if (!this.currentAssembly) return;
        const item = this.currentAssembly.contextItems.find((i) => i.filePath === filePath);
        if (item) {
            item.pinned = !item.pinned;
            if (item.pinned) {
                this.pinnedContextPaths.add(filePath);
            } else {
                this.pinnedContextPaths.delete(filePath);
            }
            this.lintPanel?.setContextAssembly(this.currentAssembly);
            this.syncQuillFrontmatter();
        }
    }

    /** Remove a context item from the assembly. Persists across re-assemblies and to frontmatter. */
    removeContextItem(filePath: string): void {
        if (!this.currentAssembly) return;
        const idx = this.currentAssembly.contextItems.findIndex((i) => i.filePath === filePath);
        if (idx !== -1) {
            this.currentAssembly.contextItems.splice(idx, 1);
            this.removedContextPaths.add(filePath);
            this.pinnedContextPaths.delete(filePath);
            this.manualContextItems = this.manualContextItems.filter((i) => i.filePath !== filePath);
            this.lintPanel?.setContextAssembly(this.currentAssembly);
            this.syncQuillFrontmatter();
        }
    }

    /** Add a vault file as a manual context item. Reads the file content for the excerpt. Persists to frontmatter. */
    async addManualContextItem(filePath: string): Promise<void> {
        if (!this.currentAssembly) return;
        if (this.removedContextPaths.has(filePath)) {
            this.removedContextPaths.delete(filePath);
        }
        if (this.currentAssembly.contextItems.some((i) => i.filePath === filePath)) {
            return;
        }
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        const content = await this.app.vault.cachedRead(file);
        const excerpt = content.slice(0, this.settings.contextMaxCharsPerFile);
        const tokenEstimate = Math.ceil(excerpt.length / 4);
        const item: ContextItem = {
            filePath,
            excerpt,
            matchedEntities: [],
            tokenEstimate,
            pinned: true,
            relevanceScore: 10,
            manual: true
        };
        this.manualContextItems.push(item);
        this.pinnedContextPaths.add(filePath);
        this.currentAssembly.contextItems.push(item);
        this.currentAssembly.totalTokens += tokenEstimate;
        this.lintPanel?.setContextAssembly(this.currentAssembly);
        this.syncQuillFrontmatter();
    }

    /** Check whether any entities or context items have been removed. */
    hasRemovedItems(): boolean {
        if (this.removedContextPaths.size > 0) return true;
        for (const [, mod] of this.entityMods) {
            if (mod.removed) return true;
        }
        return false;
    }

    /** Restore all removed entities and context items, then re-assemble. */
    async restoreRemovedItems(text?: string, filePath?: string): Promise<void> {
        this.removedContextPaths.clear();
        const removedEntries = [...this.entityMods.entries()].filter(([, m]) => m.removed);
        for (const [id] of removedEntries) {
            this.entityMods.delete(id);
        }
        const target = filePath ?? this.contextActiveFile;
        if (target) {
            this.contextCache.invalidate(target);
            this.syncQuillFrontmatter();
            if (text) {
                this.scanContext(text, target);
                await this.assembleDocumentContext(text, target);
            } else {
                const view = findEditorView(this.app, target);
                if (view) {
                    this.scanContext(view.editor.getValue(), target);
                    await this.assembleDocumentContext(view.editor.getValue(), target);
                }
            }
        }
    }

    /** Wire up the co-writer session's callbacks to the sidebar panel. */
    private wireCoWriterPanel(): void {
        const session = this.coWriterSession;
        session.onThought = (thought: string) => {
            this.lintPanel?.coWriterSetThoughtContent(thought);
        };
        session.onChatUpdate = () => {
            if (this.lintPanel) {
                this.lintPanel.coWriterSetChatHistory(session.chatHistory);
                this.lintPanel.coWriterSetCurrentOptions(session.currentOptions);
                this.lintPanel.coWriterSetOptionsLoading(session.optionsLoading);
                this.lintPanel.coWriterSetCoachPhase(session.coachSession?.phase ?? 'discern');
                this.lintPanel.coWriterSetCoachActive(session.coachActive);
            }
        };
        session.onOptionsLoading = (loading: boolean) => {
            this.lintPanel?.coWriterSetOptionsLoading(loading);
        };
        session.onTokenEstimate = (conversationTokens: number, maxTokens: number) => {
            this.lintPanel?.coWriterSetContextTokenEstimate(conversationTokens);
            this.lintPanel?.coWriterSetMaxAllowedTokens(maxTokens);
        };
        session.onDiscussChunk = (text: string) => {
            this.lintPanel?.coWriterDiscussAppendChunk(text);
        };
        session.onDiscussFinished = () => {
            void this.lintPanel?.coWriterDiscussFinished();
        };
        session.onDiscussError = (message: string) => {
            void this.lintPanel?.coWriterDiscussError(message);
        };
        session.onDraftAccepted = () => {
            // Auto-regenerate fresh options after accepting a draft
            void this.sendCoWriterOptions('');
        };
        session.onCoachDirectionReady = () => {
            // Auto-generate continuation options when plan/direction is reached
            void this.coWriterSession.coachToOptions(this, '');
        };
        session.onFulfillUpdate = () => {
            this.lintPanel?.coWriterSetFulfillState(session.fulfillChanges.edits, session.fulfillActive);
        };
    }

    /**
     * Send a direction to the co-writer in Direct mode.
     * Streams the continuation directly into the editor at the cursor position.
     */
    async sendCoWriterMessage(direction: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.generateDirect(this, direction);
    }

    /**
     * Generate 3 continuation options from the cursor position (Initialize / Refresh).
     */
    async sendCoWriterOptions(direction: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.generateOptions(this, direction);
    }

    /**
     * Apply a selected co-writer option, streaming the full continuation
     * into the editor at the cursor position.
     */
    async applyCoWriterOption(editor: Editor, optionIndex: number): Promise<void> {
        this.wireCoWriterPanel();
        await this.coWriterSession.applyOption(this, editor, optionIndex);
    }

    /**
     * Send a discussion message to the co-writer (brainstorming mode, no options).
     */
    async sendCoWriterDiscussion(message: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.sendDiscussion(this, message);
    }

    /**
     * Send a coach message to the co-writer.
     * The AI analyzes the passage and guides the writer through a structured process.
     */
    async sendCoWriterCoach(message: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.sendCoach(this, message);
    }

    /**
     * Transition from coach mode to option generation.
     */
    async coWriterCoachToOptions(): Promise<void> {
        await this.coWriterSession.coachToOptions(this, '');
    }

    /**
     * End the current coach session.
     */
    endCoWriterCoach(): void {
        this.coWriterSession.endCoachSession();
        this.lintPanel?.coWriterSetCoachActive(false);
        this.lintPanel?.coWriterSetCoachPhase('discern');
    }

    /**
     * Write a prose continuation based on the current coach session state.
     */
    async coWriterCoachWrite(): Promise<void> {
        await this.coWriterSession.coachWrite(this);
    }

    /**
     * Run a Fulfill sweep over every inline directive in the active document.
     * @param globalInstruction  Optional overall direction prepended to every directive's prompt.
     */
    async runCoWriterFulfill(globalInstruction?: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        // Set fulfillActive BEFORE openCoWriterPanel so that the panel re-sync
        // inside switchToCoWriterTab doesn't reset the button to its idle state.
        this.coWriterSession.fulfillActive = true;
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.fulfillDirectives(this, globalInstruction);
    }

    /** Approve one Fulfill section: consume its directive comment and insert the prose. */
    approveCoWriterFulfill(id: number): void {
        this.coWriterSession.approveFulfillSection(this, id);
    }

    /** Reject one Fulfill section: leave the directive comment in place. */
    rejectCoWriterFulfill(id: number): void {
        this.coWriterSession.rejectFulfillSection(id);
    }

    /** Approve every pending Fulfill section in document order. */
    approveAllCoWriterFulfill(): void {
        this.coWriterSession.approveAllFulfill(this);
    }

    /** Reject every pending Fulfill section. */
    rejectAllCoWriterFulfill(): void {
        this.coWriterSession.rejectAllFulfill();
    }

    /** Approve the pending Direct continuation: commit it at the cursor. */
    approveDirectChange(id: number): void {
        this.coWriterSession.approveDirectChange(this, id);
    }

    /** Reject the pending Direct continuation: discard it (nothing was written). */
    rejectDirectChange(id: number): void {
        this.coWriterSession.rejectDirectChange(id);
    }

    /** Resolve the CodeMirror view of the active markdown editor, if any. */
    private getActiveCm(): EditorView | undefined {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return undefined;
        return (view.editor as unknown as { cm: EditorView }).cm;
    }

    /** Approve the pending transform edit: commit the rewrite and clear the diff. */
    approveTransformChange(id: number): void {
        const cm = this.getActiveCm();
        if (!cm) return;
        syncChangeSetPositions(cm, this.transformChangeSet, 'transform');
        const change = this.transformChangeSet.approve(id);
        if (!change) return;
        const preserved = cm.state.field(diffEditsField).filter((s) => s.owner !== 'transform');
        cm.dispatch({
            changes: change,
            effects: setDiffEdits.of(preserved),
            selection: { anchor: change.from + change.insert.length }
        });
    }

    /** Reject the pending transform edit: leave the original passage and clear the diff. */
    rejectTransformChange(id: number): void {
        void id;
        this.transformChangeSet.rejectAll();
        const cm = this.getActiveCm();
        if (cm) clearDiffEdits(cm, 'transform');
    }

    /** Cancel the current feedback generation request. */
    cancelFeedbackGeneration(): void {
        this.feedbackAbort?.abort();
    }

    /**
     * Compact the co-writer conversation history and refresh options.
     */
    async compactCoWriter(): Promise<void> {
        await this.coWriterSession.compactNow(this);
        await this.sendCoWriterOptions('');
    }

    /**
     * Reset the co-writer chat while keeping manuscript and vault context.
     *
     * @param clearContext When true, also clears additional chat context files.
     */
    resetCoWriterChat(clearContext: boolean): void {
        this.coWriterSession.resetChat(clearContext);
        this.lintPanel?.coWriterSetCoachActive(false);
        this.lintPanel?.coWriterSetCoachPhase('discern');
        this.lintPanel?.coWriterSetContextTokenEstimate(0);
        if (clearContext) {
            this.lintPanel?.coWriterSetAdditionalContextTokens(0);
        }
        this.lintPanel?.coWriterRefresh();
    }

    /**
     * Reset the feedback chat and return to the Create feedback subtab.
     */
    resetFeedbackChat(): void {
        this.feedbackAbort?.abort();
        this.feedbackCurrentMessages = [];
        this.lintPanel?.reviewResetResults();
    }

    /**
     * Compact the feedback chat conversation history.
     */
    async compactFeedback(): Promise<void> {
        if (this.feedbackCurrentMessages.length <= 1) return;

        const chat = this.getDefaultChatProvider();
        if (!chat.provider) return;

        const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));

        try {
            const result = await compactConversation(chat.provider, this.feedbackCurrentMessages, sentenceCount);
            if (result) {
                this.feedbackCurrentMessages = result.messages;
                this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            console.warn('Quill: Feedback manual compaction failed.', err);
        }
    }

    // --- Critical Analysis / Continuity Engine (Feature 11) ---

    /** Cancel the current analysis request. */
    cancelAnalysisGeneration(): void {
        this.analysisAbort?.abort();
    }

    /** Reset the analysis conversation and return to the New analysis subtab. */
    resetAnalysisChat(): void {
        this.analysisAbort?.abort();
        this.analysisCurrentMessages = [];
        this.lintPanel?.reviewResetResults();
    }

    /** Manually compact the analysis conversation. */
    async compactAnalysis(): Promise<void> {
        if (this.analysisCurrentMessages.length <= 1) return;

        const chat = this.getDefaultChatProvider();
        if (!chat.provider) return;

        const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));

        try {
            const result = await compactConversation(chat.provider, this.analysisCurrentMessages, sentenceCount);
            if (result) {
                this.analysisCurrentMessages = result.messages;
                this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            console.warn('Quill: Analysis manual compaction failed.', err);
        }
    }

    /**
     * Resolve the editor + active file + scoped text for an analysis request.
     * Returns null if no markdown editor is active.
     */
    private resolveAnalysisScope(scope: AnalysisScope | 'auto'): {
        text: string;
        scope: AnalysisScope;
        lineStart?: number;
        lineEnd?: number;
        fileName?: string;
    } | null {
        // Use the same pattern as the co-writer: getActiveFile() for the path
        // (reliable even when the sidebar has focus), then findEditorView() to
        // locate the editor by searching all markdown leaves. The naive
        // getActiveViewOfType(MarkdownView) returns null when the sidebar tab
        // has stolen focus, which made "Run analysis" fail after clicking in
        // the panel.
        const activeFile = this.app.workspace.getActiveFile();
        const view = findEditorView(this.app, activeFile?.path ?? null);
        if (!view || !view.file) return null;
        const editor = view.editor;
        const fileName = view.file.name;
        const fullText = editor.getValue();
        if (!fullText.trim()) return null;

        // Resolve "auto".
        let resolvedScope: AnalysisScope = scope === 'auto' ? 'scene' : scope;
        if (scope === 'auto') {
            const sel = editor.getSelection();
            resolvedScope = sel && sel.length > 0 ? 'selection' : 'scene';
        }

        if (resolvedScope === 'selection') {
            const sel = editor.getSelection();
            if (!sel) {
                // Fall back to scene if the user picked selection but has none.
                resolvedScope = 'scene';
            } else {
                const from = editor.getCursor('from');
                const to = editor.getCursor('to');
                return {
                    text: sel,
                    scope: 'selection',
                    lineStart: from.line + 1, // 0-based → 1-based
                    lineEnd: to.line + 1,
                    fileName
                };
            }
        }

        if (resolvedScope === 'scene') {
            const offset = editor.posToOffset(editor.getCursor('from'));
            const scene = extractScene(fullText, offset);
            return {
                text: scene.text,
                scope: 'scene',
                lineStart: scene.lineStart,
                lineEnd: scene.lineEnd,
                fileName
            };
        }

        // document
        const lineCount = fullText.split('\n').length;
        return {
            text: fullText,
            scope: 'document',
            lineStart: 1,
            lineEnd: lineCount,
            fileName
        };
    }

    /**
     * Request critical analysis of the active document with the given mode and scope.
     * Streams the response into the Results sub-tab.
     */
    async requestAnalysis(
        mode: AnalysisMode,
        scope: AnalysisScope | 'auto',
        customInstruction?: string
    ): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        const resolved = this.resolveAnalysisScope(scope);
        if (!resolved) {
            new Notice('Quill: Open a Markdown document with text before running analysis.');
            this.lintPanel?.reviewError('No active document to analyze.');
            return;
        }

        console.warn(
            `[Quill Analysis] scope resolved: requested="${scope}" → actual="${resolved.scope}", ` +
                `file="${resolved.fileName}", lines ${resolved.lineStart}\u2013${resolved.lineEnd}, ` +
                `${resolved.text.length} chars`,
            '\n--- text ---\n',
            resolved.text,
            '\n--- end text ---'
        );

        // Cancel any in-flight analysis request.
        this.analysisAbort?.abort();
        this.analysisAbort = new AbortController();
        const myAnalysisAbort = this.analysisAbort;

        const modeMeta = ANALYSIS_MODES.find((m) => m.id === mode);
        this.lintPanel?.reviewStartLoading(
            'critical',
            modeMeta?.label ?? mode,
            scope === 'auto' ? 'auto scope' : scope
        );

        // Collect deterministic signal from the context engine.
        // Guard against stale context: if the assembly was built for a different
        // file than the one we're about to analyze, ignore it — the characters /
        // voice marker / plot threads would belong to the wrong manuscript.
        const activePath = this.app.workspace.getActiveFile()?.path;
        const assembly = activePath && this.contextActiveFile === activePath ? this.currentAssembly : null;
        const characters = assembly?.entities.filter((e) => e.type === 'character' && !e.removed) ?? [];
        const plotThreads =
            assembly?.entities.filter((e) => e.type === 'plot-thread' && !e.removed).map((e) => e.name) ?? [];
        const voiceMarker = assembly?.voice;

        // Vault context — same best-effort extraction as feedback.
        const contextParts: string[] = [];
        try {
            if (assembly && assembly.contextItems.length > 0) {
                for (const item of assembly.contextItems) {
                    if (item.excerpt) {
                        contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                    }
                }
            }
        } catch {
            // Vault context is best-effort.
        }
        const vaultContext = contextParts.length > 0 ? contextParts.join('\n\n') : '';

        const initialMessages = buildAnalysisMessages(mode, {
            text: resolved.text,
            scope: resolved.scope,
            lineStart: resolved.lineStart,
            lineEnd: resolved.lineEnd,
            fileName: resolved.fileName,
            vaultContext,
            voiceMarker,
            characters,
            plotThreads,
            customInstruction
        });
        this.analysisCurrentMessages = [...initialMessages];

        console.warn(
            `[Quill Analysis] sending to AI — mode="${mode}", ` +
                `characters=${characters.length} (${characters.map((c) => c.name).join(', ') || 'none'}), ` +
                `plotThreads=${plotThreads.length} (${plotThreads.join(', ') || 'none'}), ` +
                `voiceMarker=${voiceMarker ? `${voiceMarker.pov}/${voiceMarker.tense}/${voiceMarker.avgSentenceLength}w` : 'none'}, ` +
                `vaultContext=${vaultContext.length} chars`,
            '\n--- messages ---\n',
            this.analysisCurrentMessages
                .map(
                    (m) =>
                        `[${m.role}]\n${m.content.slice(0, 500)}${m.content.length > 500 ? `\u2026 (+${m.content.length - 500} more)` : ''}`
                )
                .join('\n\n'),
            '\n--- end messages ---'
        );

        try {
            const stream = getAnalysis(chat.provider, mode, {
                text: resolved.text,
                scope: resolved.scope,
                lineStart: resolved.lineStart,
                lineEnd: resolved.lineEnd,
                fileName: resolved.fileName,
                vaultContext,
                voiceMarker,
                characters,
                plotThreads,
                model: chat.modelId,
                signal: this.analysisAbort.signal,
                customInstruction,
                existingMessages: initialMessages
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.analysisCurrentMessages.push({ role: 'assistant', content: fullResponse });
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.analysisCurrentMessages));
                    await this.lintPanel?.reviewFinished();
                } else {
                    fullResponse += chunk.text;
                    this.lintPanel?.reviewAppendChunk(chunk.text);
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            const msg = err instanceof Error ? err.message : String(err);
            this.lintPanel?.reviewError(msg);
            new Notice('Quill: Analysis request failed.');
        } finally {
            if (this.analysisAbort === myAnalysisAbort) {
                this.analysisAbort = null;
            }
        }
    }

    /**
     * Send a follow-up chat message in the analysis conversation.
     * Mirrors sendFeedbackChatMessage: compacts when near the token budget,
     * appends the user message after any compaction, then streams a reply.
     */
    async sendAnalysisChatMessage(message: string): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured.');
            return;
        }

        this.analysisAbort?.abort();
        this.analysisAbort = new AbortController();
        const myAnalysisAbort = this.analysisAbort;

        this.lintPanel?.reviewChatStartLoading();

        // Chat context files (reference material added mid-conversation) are
        // injected fresh as system messages on every call, mirroring feedback.
        // They are NOT stored in analysisCurrentMessages so they survive compaction.
        const chatContextPaths = this.lintPanel?.reviewChatContextFiles() ?? [];
        const referenceMessages = await readVaultFiles(
            this.app.vault,
            chatContextPaths,
            'Reference file',
            this.settings.contextMaxCharsPerFile
        );
        const injectedTokens = estimateTokens(referenceMessages);

        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settings.contextCompactAtPercent)) / 100;

        // Hypothetical total INCLUDING reference files + new user message.
        const hypothetical = [...this.analysisCurrentMessages, { role: 'user' as const, content: message }];
        const conversationTokens = estimateTokens(hypothetical) + injectedTokens;

        this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.analysisCurrentMessages));

        if (conversationTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.analysisCurrentMessages, sentenceCount, {
                    signal: this.analysisAbort.signal
                });
                if (result) {
                    this.analysisCurrentMessages = result.messages;
                    this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.analysisCurrentMessages));
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.warn('Quill: Analysis compaction failed, continuing without compaction.', err);
            }
        }

        // Append the user message after compaction so it stays below any new context head.
        this.analysisCurrentMessages.push({ role: 'user', content: message });

        // Build the full API payload: system prompt + injected reference context + conversation.
        const baseMessages: ChatMessage[] = [
            this.analysisCurrentMessages[0]!, // system prompt
            ...referenceMessages,
            ...this.analysisCurrentMessages.slice(1) // context heads + chat turns
        ];

        try {
            const stream = chat.provider.chatCompletion({
                messages: baseMessages,
                model: chat.modelId,
                temperature: this.settings.analysisTemperature,
                maxTokens: this.settings.analysisMaxOutputTokens,
                signal: this.analysisAbort.signal
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.analysisCurrentMessages.push({ role: 'assistant', content: fullResponse });
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.analysisCurrentMessages));
                    await this.lintPanel?.reviewChatFinished();
                } else {
                    fullResponse += chunk.text;
                    this.lintPanel?.reviewChatAppendChunk(chunk.text);
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                await this.lintPanel?.reviewChatFinished();
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            await this.lintPanel?.reviewChatError(msg);
            new Notice('Quill: Analysis chat failed.');
        } finally {
            if (this.analysisAbort === myAnalysisAbort) {
                this.analysisAbort = null;
            }
        }
    }

    /** Add a context file to the co-writer session. */
    async addCoWriterContextFile(filePath: string): Promise<void> {
        this.coWriterSession.addContextFile(filePath);
        await this.updateCoWriterAdditionalTokens();
        this.lintPanel?.coWriterRefresh();
    }

    /** Remove a context file from the co-writer session. */
    async removeCoWriterContextFile(filePath: string): Promise<void> {
        this.coWriterSession.removeContextFile(filePath);
        await this.updateCoWriterAdditionalTokens();
        this.lintPanel?.coWriterRefresh();
    }

    /**
     * Compute token estimates for additional context files and push to the panel.
     */
    private async updateCoWriterAdditionalTokens(): Promise<void> {
        const files = this.coWriterSession.getContextFiles();
        if (files.length === 0) {
            this.lintPanel?.coWriterSetAdditionalContextTokens(0);
            return;
        }
        const messages = await loadAdditionalContext(this, files);
        this.lintPanel?.coWriterSetAdditionalContextTokens(estimateTokens(messages));
    }

    /**
     * Compute the linked plot map's token estimate and push it to the co-writer
     * panel. Reads the plot map note text (capped) and estimates its token cost.
     */
    async updateCoWriterPlotMapTokens(): Promise<void> {
        const path = this.currentPlotMap;
        if (!path) {
            this.lintPanel?.coWriterSetPlotMapTokens(0);
            return;
        }
        const text = await readVaultFileText(this.app.vault, path, this.settings.contextMaxCharsPerFile);
        // Discard stale results if the linked plot map changed during the read.
        if (path !== this.currentPlotMap) return;
        this.lintPanel?.coWriterSetPlotMapTokens(text ? estimateTokens(text) : 0);
    }

    /** Open the sidebar and switch to the Co-writer tab. */
    async openCoWriterPanel(): Promise<void> {
        await this.openLintPanel();
        this.lintPanel?.switchToCoWriterTab();
    }

    /** Open the sidebar and switch to the Review tab. Auto-adds the active
     *  document to the editorial manuscripts list if one is open. */
    async openReviewPanel(): Promise<void> {
        await this.openLintPanel();
        this.lintPanel?.switchToReviewTab();
        // Auto-add the active document to manuscripts (used by editorial engine)
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            this.lintPanel?.reviewAddContextFile(activeFile.path);
        }
    }

    /**
     * Request AI feedback on the context manuscripts with the selected persona.
     * Streams the response into the Results sub-tab.
     *
     * Manuscript content is injected as system messages on every API call, not
     * stored in feedbackCurrentMessages, so it always survives compaction and
     * never pollutes token counts.
     */
    async requestFeedback(personaId: string, customInstruction?: string): Promise<void> {
        const persona = personaId === 'custom' ? undefined : getPersonaById(personaId);
        if (personaId !== 'custom' && !persona) {
            new Notice('Quill: Unknown feedback persona.');
            return;
        }

        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        // Cancel any in-flight feedback request
        this.feedbackAbort?.abort();
        this.feedbackAbort = new AbortController();

        // Start loading state in the Review tab
        this.lintPanel?.reviewStartLoading('editorial', persona?.name ?? 'Custom');

        // Capture the controller for this specific request so we can guard its cleanup.
        const myFeedbackAbort = this.feedbackAbort;

        const feedbackContextPaths = this.lintPanel?.reviewContextFiles() ?? [];
        if (feedbackContextPaths.length === 0) {
            new Notice('Quill: Add manuscripts to the feedback tab before requesting analysis.');
            this.lintPanel?.reviewError('No manuscripts selected.');
            return;
        }

        // Include context engine items (vault auto-scan) as reference context
        // in the system prompt, not in the user message.
        const contextParts: string[] = [];
        try {
            const assembly = this.currentAssembly;
            if (assembly && assembly.contextItems.length > 0) {
                for (const item of assembly.contextItems) {
                    if (item.excerpt) {
                        contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                    }
                }
            }
        } catch {
            // Vault context is best-effort
        }

        // Read manuscript files and inject them as system messages.
        // They are NOT stored in feedbackCurrentMessages — injected fresh on
        // every API call so they always survive compaction.
        const manuscriptMessages = await readVaultFiles(this.app.vault, feedbackContextPaths, 'Manuscript');

        if (manuscriptMessages.length === 0) {
            new Notice('Quill: Could not read any content from the selected manuscripts.');
            this.lintPanel?.reviewError('Could not read manuscript content.');
            return;
        }

        const vaultContext = contextParts.length > 0 ? contextParts.join('\n\n') : '';

        // Build and store the initial conversation messages (system prompt + user
        // instruction only — no manuscript content).
        const initialMessages = buildFeedbackMessages(persona, {
            vaultContext,
            narrativePreset: this.settings.narrativeVoicePreset,
            customInstruction
        });
        this.feedbackCurrentMessages = [...initialMessages];

        // Build the full API payload: system prompt + manuscripts + user instruction.
        const apiMessages: ChatMessage[] = [
            this.feedbackCurrentMessages[0]!, // system prompt
            ...manuscriptMessages,
            this.feedbackCurrentMessages[1]! // user instruction
        ];

        try {
            const stream = getFeedback(chat.provider, persona, {
                vaultContext,
                narrativePreset: this.settings.narrativeVoicePreset,
                model: chat.modelId,
                temperature: this.settings.analysisTemperature,
                maxTokens: this.settings.analysisMaxOutputTokens,
                signal: this.feedbackAbort.signal,
                customInstruction,
                existingMessages: apiMessages
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.feedbackCurrentMessages.push({ role: 'assistant', content: fullResponse });
                    // Push conversation-only tokens to the panel. The panel
                    // adds manuscript and reference file tokens on top so the
                    // indicator updates immediately when files change.
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.feedbackCurrentMessages));
                    await this.lintPanel?.reviewFinished();
                } else {
                    fullResponse += chunk.text;
                    this.lintPanel?.reviewAppendChunk(chunk.text);
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            const msg = err instanceof Error ? err.message : String(err);
            this.lintPanel?.reviewError(msg);
            new Notice('Quill: Feedback request failed.');
        } finally {
            // Only clear feedbackAbort if it still matches our controller,
            // so a newer request's controller is not accidentally cleared.
            if (this.feedbackAbort === myFeedbackAbort) {
                this.feedbackAbort = null;
            }
        }
    }

    /**
     * Send a follow-up chat message in the current feedback conversation.
     * Manuscripts and reference files are injected fresh as system messages on
     * every API call — they are never stored in feedbackCurrentMessages, so they
     * always survive compaction and never double-count in token estimates.
     *
     * Compaction strategy (rolling context head):
     *  - When the token budget (conversation + files + new message) meets or
     *    exceeds the compaction threshold as a percentage of the context window,
     *    the older portion of the conversation is summarized by the AI.
     *  - The generated summary replaces the older turns as a system "context head".
     *  - The new user message is always preserved below the context head.
     *  - On the next compaction, the previous context head is included in what
     *    gets summarized (rolling forward), producing a new consolidated head.
     */
    async sendFeedbackChatMessage(message: string): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured.');
            return;
        }

        this.feedbackAbort?.abort();
        this.feedbackAbort = new AbortController();

        // Capture the controller for this specific request so we can guard its cleanup.
        const myFeedbackAbort = this.feedbackAbort;

        this.lintPanel?.reviewChatStartLoading();

        // Manuscripts and reference files are always injected fresh as system
        // messages. They are NOT stored in feedbackCurrentMessages, so they
        // survive compaction and never pollute the conversation history.
        const manuscriptPaths = this.lintPanel?.reviewContextFiles() ?? [];
        const chatContextFilePaths = this.lintPanel?.reviewChatContextFiles() ?? [];

        const manuscriptMessages = await readVaultFiles(this.app.vault, manuscriptPaths, 'Manuscript');
        const referenceMessages = await readVaultFiles(
            this.app.vault,
            chatContextFilePaths,
            'Reference file',
            this.settings.contextMaxCharsPerFile
        );

        const injectedContext: ChatMessage[] = [...manuscriptMessages, ...referenceMessages];

        const injectedTokens = estimateTokens(injectedContext);
        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settings.contextCompactAtPercent)) / 100;

        // Compute total tokens INCLUDING the new message to decide whether to
        // compact. The new message is part of the context the AI must process.
        const hypotheticalConversation = [...this.feedbackCurrentMessages, { role: 'user' as const, content: message }];
        const conversationTokens = estimateTokens(hypotheticalConversation);
        const totalTokens = conversationTokens + injectedTokens;

        // Push conversation-only tokens (without new message) to the panel.
        // The panel adds manuscript and reference file tokens on top.
        this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.feedbackCurrentMessages));

        // --- AI-powered compaction ---
        // Compact if the total (conversation + files + new message) meets or
        // exceeds the threshold percentage of the context window.
        if (totalTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.feedbackCurrentMessages, sentenceCount, {
                    signal: this.feedbackAbort.signal
                });
                if (result) {
                    this.feedbackCurrentMessages = result.messages;
                    this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.feedbackCurrentMessages));
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.warn('Quill: Compaction summarization failed, continuing without compaction.', err);
            }
        }

        // Append the user message after compaction so it's always below any
        // new context head.
        this.feedbackCurrentMessages.push({ role: 'user', content: message });

        // Build the full API payload: system prompt + injected context + conversation.
        const baseMessages: ChatMessage[] = [
            this.feedbackCurrentMessages[0]!, // system prompt
            ...injectedContext,
            ...this.feedbackCurrentMessages.slice(1) // context heads + chat turns (including new message)
        ];

        try {
            const stream = chat.provider.chatCompletion({
                messages: baseMessages,
                model: chat.modelId,
                temperature: this.settings.analysisTemperature,
                maxTokens: this.settings.analysisMaxOutputTokens,
                signal: this.feedbackAbort.signal
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.feedbackCurrentMessages.push({ role: 'assistant', content: fullResponse });
                    // Push conversation-only tokens. The panel adds file tokens on top.
                    this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.feedbackCurrentMessages));
                    await this.lintPanel?.reviewChatFinished();
                } else {
                    fullResponse += chunk.text;
                    this.lintPanel?.reviewChatAppendChunk(chunk.text);
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                await this.lintPanel?.reviewChatFinished();
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            await this.lintPanel?.reviewChatError(msg);
            new Notice('Quill: Chat response failed.');
        } finally {
            // Only clear feedbackAbort if it still matches our controller,
            // so a newer request's controller is not accidentally cleared.
            if (this.feedbackAbort === myFeedbackAbort) {
                this.feedbackAbort = null;
            }
        }
    }
}
