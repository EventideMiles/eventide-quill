import {
    Editor,
    MarkdownView,
    Menu,
    normalizePath,
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    WorkspaceLeaf
} from 'obsidian';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, EventideQuillSettings, EventideQuillSettingTab } from './settings';
import { lint } from './core/linter/linter';
import { getLintExtension, setLintResults, toggleLintActive } from './core/linter/decorations';
import { QUILL_VIEW_TYPE, QuillSidebarView } from './ui/quill-sidebar';
import { LintResult, FIXABLE_RULES, RULE_INFO } from './core/linter/types';
import { FIXES } from './core/linter/fixes';
import { applyReplacement } from './core/linter/apply-fix';
import { findEditorView } from './utils/find-editor';
import { extractScene, stripFrontmatter } from './utils/text-analysis';
import { AiProvider } from './ai/provider';
import { createProvider, parseProviderKey } from './ai/provider-registry';
import { applyTransformation, TRANSFORM_ACTIONS } from './ai/transform';
import { DEFAULT_SPLIT_BY_HEADING, DEFAULT_INCLUDE_SUBFOLDERS } from './core/dashboard/presets';
import { groupFindingsByPassage, buildBatchLinterPrompt, buildPacingFixPrompt, streamBatchFix } from './ai/batch-fix';
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
import type { LoreDraftEntry } from './ai/co-writer';
import {
    getManuscriptAnalysis,
    getManuscriptAnalysisModeById,
    buildManuscriptAnalysisMessages,
    type ManuscriptAnalysisMode,
    type ManuscriptScope
} from './ai/manuscript-analysis';
import { chunkManuscript, compressChunks, type Chunk, type CompactionStrategy } from './ai/manuscript-compaction';
import { EmbeddingCache, hashString, rankBySimilarity } from './ai/embedding-cache';
import { compactConversation } from './ai/compaction';
import { estimateTokens } from './utils/tokens';
import { readVaultFileText } from './utils/vault-files';
import { parseDirectives } from './utils/directives';
import {
    getChangeDiffExtension,
    clearDiffEdits,
    diffEditsField,
    setDiffEdits,
    syncChangeSetPositions,
    pushDiffEdits,
    toDiffSnapshots
} from './ui/change-diff-extension';
import { ChangeSet } from './core/change-set';
import { parseEmbedFolderPath, readVaultFiles, loreFolderEmbedPaths } from './utils/vault-files';
import type { ManuscriptMetrics, ManuscriptSnapshot, ChapterRange } from './core/dashboard/types';
import { listChaptersInFile, manuscriptMetrics } from './core/dashboard/metrics';
import {
    scanLorebook,
    findLoreFolder,
    computeDocumentCoverage,
    computeManuscriptCoverage,
    parseAliases
} from './core/dashboard/lorebook-scanner';
import type { LoreCoverage, LoreEntryType } from './core/dashboard/lorebook-types';
import {
    loadManuscriptFile,
    saveManuscriptFile,
    setEntityReclassification,
    appendManuscriptSnapshot,
    withFolderLock,
    type ManuscriptFileData
} from './core/dashboard/manuscript-file';

/**
 * Whether a vault file path should be excluded from embedding.
 * Excludes the Obsidian config directory and any hidden directories or files
 * (segments starting with `.`) — these contain internal state, plugin config,
 * or other non-content data, not user writing.
 */
function isExcludedPath(path: string, configDir: string): boolean {
    const configFolder = normalizePath(configDir);
    if (configFolder && (path.startsWith(configFolder + '/') || path.includes('/' + configFolder + '/'))) {
        return true;
    }
    const segments = path.split('/');
    for (const segment of segments) {
        if (segment.startsWith('.')) return true;
    }
    return false;
}

/**
 * Enrich entity display names using vault file basenames.
 *
 * When a vault file's basename contains a richer form of an entity's name
 * (e.g., the manuscript says "Freddy" but a file is named "Freddy Lupin.md"),
 * the entity's display name is updated to the richer form and the original
 * name is kept as an alias for text matching.
 *
 * The entity ID is NOT changed — it stays keyed to the extracted name so
 * that frontmatter reclassification overrides remain stable across
 * enrichment changes.
 *
 * Ambiguity guard: if a word appears in multiple file basenames (e.g.,
 * "Freddy Lupin.md" and "Freddy Jones.md"), it is not used for enrichment.
 *
 * @param entities  Extracted entities (mutated in place).
 * @param files     All markdown files in the vault.
 */
function enrichEntityNamesFromVault(entities: ExtractedEntity[], files: TFile[]): void {
    // Build word → basename index. A word maps to a basename only when it
    // appears unambiguously across all file basenames.
    const wordToBasename = new Map<string, string>();
    const ambiguous = new Set<string>();

    for (const file of files) {
        const words = file.basename.split(/\s+/).filter((w) => w.length > 1);
        for (const word of words) {
            if (wordToBasename.has(word)) {
                ambiguous.add(word);
            } else {
                wordToBasename.set(word, file.basename);
            }
        }
    }
    for (const word of ambiguous) {
        wordToBasename.delete(word);
    }

    for (const entity of entities) {
        if (entity.type !== 'character') continue;

        // Check the entity's primary name and all aliases for component words
        // that map to a richer file basename.
        const namesToCheck = [entity.name, ...entity.aliases];
        let bestRichName: string | null = null;
        let bestWordCount = entity.name.split(/\s+/).length;

        for (const name of namesToCheck) {
            for (const comp of name.split(/\s+/)) {
                if (comp.length <= 1) continue;
                const richName = wordToBasename.get(comp);
                if (!richName) continue;
                const richWordCount = richName.split(/\s+/).length;
                // Only enrich if the file basename is strictly richer.
                if (richWordCount > bestWordCount) {
                    bestRichName = richName;
                    bestWordCount = richWordCount;
                }
            }
        }

        if (bestRichName) {
            // Keep the old display name as an alias for text matching.
            if (!entity.aliases.includes(entity.name)) {
                entity.aliases.push(entity.name);
            }
            entity.name = bestRichName;
            // ID stays unchanged for reclassification stability.
        }
    }
}

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
    /** Abort controller for the current manuscript analysis request, if any. */
    private manuscriptAnalysisAbort: AbortController | null = null;
    /** Full message history for the manuscript analysis conversation. */
    private manuscriptAnalysisCurrentMessages: ChatMessage[] = [];
    /** Debounce timers for per-folder embedding warming. Keyed by folder path. */
    private embeddingWarmingTimers = new Map<string, number>();
    /** Folders currently being warmed, to avoid concurrent warming. */
    private embeddingWarmingActive = new Set<string>();
    lintActive = false;
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
    /** Proposed batch lint-fix edits awaiting inline review. */
    lintBatchChangeSet: ChangeSet = new ChangeSet();
    /** Current dashboard metrics for the active manuscript, or null when not yet computed. */
    currentDashboardMetrics: ManuscriptMetrics | null = null;
    /** Document-scoped lorebook coverage (substring-matching against active doc), or null. */
    currentLoreDocumentCoverage: LoreCoverage | null = null;
    /** Manuscript-scoped lorebook coverage (substring + entity-based), or null. */
    currentLoreManuscriptCoverage: LoreCoverage | null = null;
    /**
     * The just-written lore entry type from `setLoreEntryType`, used to
     * re-render the active-entry dropdown before `metadataCache` catches up.
     * Cleared after the panel consumes it. Null when no pending write.
     */
    pendingLoreEntryType: { path: string; type: LoreEntryType | null } | null = null;
    /** Entities extracted during the last dashboard refresh, retained so the
     *  Lorebook tab can recompute coverage without re-running extraction. */
    currentManuscriptEntities: ExtractedEntity[] = [];
    /** Combined manuscript chapter text from the last dashboard refresh, used for
     *  substring-based lore matching in the Manuscript subtab. */
    currentManuscriptText: string | null = null;
    /** Folder path of the last dashboard refresh, used to detect staleness. */
    currentManuscriptFolder: string | null = null;
    /** Historical snapshots for the active manuscript, or null when not yet loaded. */
    currentDashboardSnapshots: ManuscriptSnapshot[] | null = null;
    /** Per-manuscript dashboard data loaded from the sidecar file, or null when not yet loaded. */
    currentManuscriptFileData: ManuscriptFileData | null = null;
    /** Absolute path to the plugin's data directory (for dashboard snapshot storage). */
    private pluginDataDir = '';

    /** Plugin entry point: register commands, views, extensions, and event handlers. */
    async onload() {
        await this.loadSettings();
        this.rebuildProviders();

        // Resolve the plugin's data directory for dashboard snapshot storage.
        this.pluginDataDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;

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
                    else if (owner === 'lint-batch') this.approveLintBatchChange(id);
                },
                onReject: (owner: string, id: number) => {
                    if (owner === 'fulfill') this.rejectCoWriterFulfill(id);
                    else if (owner === 'transform') this.rejectTransformChange(id);
                    else if (owner === 'direct') this.rejectDirectChange(id);
                    else if (owner === 'lint-batch') this.rejectLintBatchChange(id);
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

                // Dashboard: auto-initialize metrics when a manuscript file is
                // opened and the dashboard tab is active but has no metrics yet.
                if (
                    this.lintPanel?.isDashboardActive() &&
                    !this.currentDashboardMetrics &&
                    activeFile &&
                    activeFile.extension === 'md'
                ) {
                    void this.refreshDashboard();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file: TAbstractFile) => {
                if (file instanceof TFile) {
                    this.contextCache.invalidate(file.path);

                    // Auto-snapshot on save if the dashboard setting is enabled.
                    if (this.settings.dashboardAutoSnapshotOnSave && file.extension === 'md') {
                        void this.refreshDashboard();
                    }

                    // Debounced embedding warming for the file's folder.
                    if (
                        this.settings.enableEmbeddingWarming &&
                        file.extension === 'md' &&
                        this.getDefaultEmbedProvider()
                    ) {
                        const folder = file.parent?.path ?? '';
                        if (folder && !['', '/'].includes(folder)) {
                            this.scheduleEmbeddingWarming(folder);
                        }
                    }
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

        // Periodic dashboard auto-refresh. Uses registerInterval for automatic
        // teardown on plugin unload. 0 disables the timer entirely.
        if (this.settings.dashboardAutoRefreshMinutes > 0) {
            const intervalMs = this.settings.dashboardAutoRefreshMinutes * 60_000;
            this.registerInterval(
                window.setInterval(() => {
                    if (this.lintPanel?.isDashboardActive()) {
                        const activeFile = this.app.workspace.getActiveFile();
                        if (activeFile && activeFile.extension === 'md') {
                            void this.refreshDashboard();
                        }
                    }
                }, intervalMs)
            );
        }

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
                    item.setTitle('Quill: Open review')
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
            id: 'quill-review-open',
            name: 'Quill: Open review',
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
            id: 'quill-dashboard-open',
            name: 'Quill: Open dashboard',
            callback: () => {
                void this.openDashboardPanel();
            }
        });

        this.addCommand({
            id: 'quill-dashboard-refresh',
            name: 'Quill: Refresh dashboard',
            callback: () => {
                void this.refreshDashboard();
            }
        });

        this.addCommand({
            id: 'quill-lorebook-open',
            name: 'Quill: Open lorebook',
            callback: () => {
                void this.openLorebookPanel();
            }
        });

        this.addCommand({
            id: 'quill-lorebook-refresh',
            name: 'Quill: Scan lorebook',
            callback: () => {
                void this.refreshLorebook();
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

        this.addCommand({
            id: 'quill-build-embeddings',
            name: 'Quill: Build embeddings for all folders',
            callback: () => {
                void this.warmAllEmbeddingCaches();
            }
        });

        this.addSettingTab(new EventideQuillSettingTab(this.app, this));

        // Initial embedding cache warming: if an embed provider is configured,
        // warm any folders that don't have a cache yet. Delayed 10s to let
        // Obsidian settle after startup. Fire-and-forget.
        if (this.getDefaultEmbedProvider() && this.settings.enableEmbeddingWarming) {
            // Raw timer: one-shot startup delay. Cleared on unload.
            const startupTimer = window.setTimeout(() => {
                void this.warmAllEmbeddingCaches();
            }, 10_000);
            this.registerInterval(startupTimer);
        }
    }

    /** Clean up resources when the plugin is unloaded. */
    onunload() {
        this.clearEmbeddingWarmingTimers();
    }

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
    toggleLint(editor: Editor) {
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

        // Strip frontmatter so the linter doesn't flag YAML properties.
        const { text: bodyText, strippedLines } = stripFrontmatter(text);

        const rawResults = lint(bodyText, {
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
            enableGremlins: this.settings.enableGremlins,
            enableAggressiveGremlins: this.settings.enableAggressiveGremlins
        });

        const lines = text.split('\n');

        return rawResults
            .map((r) => ({ ...r, line: r.line + strippedLines }))
            .filter((r) => {
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
        const saved = (await this.loadData()) as Record<string, unknown>;
        // Migration: renamed manuscriptAnalysisTopKChunks → embeddingsTopKChunks
        if (saved && 'manuscriptAnalysisTopKChunks' in saved && !('embeddingsTopKChunks' in saved)) {
            saved.embeddingsTopKChunks = saved.manuscriptAnalysisTopKChunks;
            delete saved.manuscriptAnalysisTopKChunks;
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
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

        for (const p of (fm.pinnedFiles ?? []).map(normalizePath)) {
            this.pinnedContextPaths.add(p);
        }
        for (const p of (fm.removedFiles ?? []).map(normalizePath)) {
            this.removedContextPaths.add(p);
        }

        for (const fp of (fm.addedFiles ?? []).map(normalizePath)) {
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

    /** Add an embedded folder as a manual context item. Loads the cache for token estimation. */
    async addFolderContextItem(folderPath: string, mode: 'top-k' | 'full'): Promise<void> {
        if (!this.currentAssembly) return;

        const embedPath = mode === 'full' ? `embed-full:${folderPath}` : `embed:${folderPath}`;
        if (this.removedContextPaths.has(embedPath)) {
            this.removedContextPaths.delete(embedPath);
        }
        if (this.currentAssembly.contextItems.some((i) => i.filePath === embedPath)) {
            return;
        }

        // Estimate tokens from the embedding cache to show a reasonable budget.
        const embedProvider = this.getDefaultEmbedProvider();
        const embedKey = embedProvider ? parseProviderKey(this.settings.aiDefaultEmbedProvider) : null;
        const modelId = embedKey?.modelId ?? '';
        let tokenEstimate = 0;
        if (modelId && folderPath) {
            try {
                const cache = await EmbeddingCache.load(this.app.vault, folderPath, modelId);
                const count = cache.size;
                tokenEstimate = count * this.settings.embeddingChunkTokenSize;
            } catch {
                tokenEstimate = 1000;
            }
        }

        const item: ContextItem = {
            filePath: embedPath,
            excerpt: '',
            matchedEntities: [],
            tokenEstimate,
            pinned: true,
            relevanceScore: 10,
            manual: true,
            folderPath,
            embedMode: mode
        };
        this.manualContextItems.push(item);
        this.pinnedContextPaths.add(embedPath);
        this.currentAssembly.contextItems.push(item);
        this.currentAssembly.totalTokens += tokenEstimate;
        this.lintPanel?.setContextAssembly(this.currentAssembly);
        this.syncQuillFrontmatter();
    }

    /**
     * Resolve all folder context items in the assembly by loading their embedding
     * caches. For top-K mode, embeds the document text as a query and retrieves
     * the most relevant chunks. For full mode, retrieves all chunk texts.
     */
    async resolveFolderContextItems(assembly: ContextAssembly, documentText: string): Promise<void> {
        const folderItems = assembly.contextItems.filter((i) => i.folderPath && i.embedMode);
        if (folderItems.length === 0) return;

        const embedProvider = this.getDefaultEmbedProvider();
        const embedKey = embedProvider ? parseProviderKey(this.settings.aiDefaultEmbedProvider) : null;
        const embedModelId = embedKey?.modelId ?? '';
        if (!embedProvider || !embedModelId) return;

        for (const item of folderItems) {
            try {
                const cache = await EmbeddingCache.load(this.app.vault, item.folderPath!, embedModelId);

                if (item.embedMode === 'full') {
                    // Full mode: include all chunk texts.
                    const allEntries = cache.getAll();
                    const texts = allEntries.map((e) => e.chunkText);
                    const fullText = texts.join('\n\n---\n\n');
                    item.excerpt = fullText;
                    item.tokenEstimate = Math.ceil(fullText.length / 4);
                    item.resolvedChunks = texts;
                } else {
                    // Top-K mode: embed the document as query, rank by similarity.
                    const allEntries = cache.getAll();
                    if (allEntries.length === 0) continue;

                    // Attach embeddings to chunks for ranking.
                    const chunks = allEntries.map((e, i) => ({
                        index: i,
                        text: e.chunkText,
                        tokenEstimate: 0,
                        embedding: e.embedding
                    }));

                    // Embed the document text as a query.
                    const queryResult = await embedProvider.embed({ input: documentText, model: embedModelId });
                    const queryEmbedding = queryResult.embeddings[0];
                    if (!queryEmbedding) continue;

                    const topK = this.settings.embeddingsTopKChunks;
                    const ranked = rankBySimilarity(chunks, queryEmbedding, topK);
                    const texts = ranked.map((c) => c.text);
                    const combined = texts.join('\n\n---\n\n');
                    item.excerpt = combined;
                    item.tokenEstimate = Math.ceil(combined.length / 4);
                    item.resolvedChunks = texts;
                }

                // Recalculate total tokens in the assembly.
                assembly.totalTokens = assembly.contextItems.reduce((sum, ci) => sum + ci.tokenEstimate, 0);
            } catch {
                // Best-effort resolution — keep existing excerpt.
            }
        }
    }

    /**
     * Lorebook folders as `embed:` reference paths, gated on the
     * `reviewLoreContext` setting. Prepended to reference-context resolution
     * for editorial feedback, critical analysis, and manuscript analysis so
     * relevant lore entries ride the same top-K retrieval as manual context.
     * Returns empty when the toggle is off or no folders are configured.
     */
    private loreReferencePaths(): string[] {
        return this.settings.reviewLoreContext ? loreFolderEmbedPaths(this.settings.lorebookFolders) : [];
    }

    /**
     * Resolve lorebook `embed:` reference paths into ChatMessages, gated on the
     * `reviewLoreContext` setting. Used by the initial review/analysis request
     * builders so the first payload — not just follow-up chat — receives lore
     * context. Mirrors the prepend pattern used by the chat follow-up flows.
     * Returns empty when the toggle is off, no folders are configured, or no
     * embed provider is available.
     */
    private async loreReferenceMessages(documentText: string): Promise<ChatMessage[]> {
        const lorePaths = this.loreReferencePaths();
        if (lorePaths.length === 0) return [];
        const { messages } = await this.resolveEmbedPathsToMessages(
            lorePaths,
            'Reference file',
            documentText,
            this.settings.contextMaxCharsPerFile
        );
        return messages;
    }

    /**
     * Resolve embed-prefixed paths into ChatMessages. Regular file paths are
     * returned for the caller to pass to readVaultFiles.
     */
    private async resolveEmbedPathsToMessages(
        paths: string[],
        label: string,
        documentText: string,
        maxChars?: number
    ): Promise<{ regularPaths: string[]; messages: ChatMessage[] }> {
        const regularPaths: string[] = [];
        const messages: ChatMessage[] = [];

        if (!this.getDefaultEmbedProvider()) {
            return { regularPaths: paths, messages };
        }

        const embedKey = parseProviderKey(this.settings.aiDefaultEmbedProvider);
        const embedModelId = embedKey?.modelId ?? '';

        for (const path of paths) {
            const parsed = parseEmbedFolderPath(path);
            if (!parsed) {
                regularPaths.push(path);
                continue;
            }

            try {
                const cache = await EmbeddingCache.load(this.app.vault, parsed.folderPath, embedModelId);
                const allEntries = cache.getAll();
                if (allEntries.length === 0) continue;

                let texts: string[];
                if (parsed.mode === 'full') {
                    texts = allEntries.map((e) => e.chunkText);
                } else {
                    // Top-K: embed document as query, rank by similarity.
                    const topK =
                        this.settings.folderTopKOverrides[parsed.folderPath] ?? this.settings.embeddingsTopKChunks;
                    const chunks = allEntries.map((e, i) => ({
                        index: i,
                        text: e.chunkText,
                        tokenEstimate: Math.ceil(e.chunkText.length / 4),
                        embedding: e.embedding
                    }));
                    const embedProvider = this.getDefaultEmbedProvider()!;
                    const queryResult = await embedProvider.embed({ input: documentText, model: embedModelId });
                    const queryEmbedding = queryResult.embeddings[0];
                    if (!queryEmbedding) continue;

                    const ranked = rankBySimilarity(chunks, queryEmbedding, topK);
                    texts = ranked.map((c) => c.text);
                }

                const safeMax =
                    typeof maxChars === 'number' && maxChars >= 0 && Number.isFinite(maxChars)
                        ? Math.floor(maxChars)
                        : undefined;
                const combined = texts.join('\n\n---\n\n');
                const excerpt = safeMax !== undefined ? combined.slice(0, safeMax) : combined;

                messages.push({
                    role: 'system',
                    content: `${label} (${parsed.folderPath}, ${parsed.mode}):\n${excerpt}`
                });
            } catch {
                // Best-effort — skip failed folder resolution.
            }
        }

        return { regularPaths, messages };
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
                this.lintPanel.coWriterSetLoreCoachPhase(session.loreCoachSession?.phase ?? 'discover');
                this.lintPanel.coWriterSetLoreCoachActive(session.loreCoachActive);
            }
        };
        session.onOptionsLoading = (loading: boolean) => {
            this.lintPanel?.coWriterSetOptionsLoading(loading);
        };
        session.onTokenEstimate = (conversationTokens: number, maxTokens: number) => {
            this.lintPanel?.coWriterSetContextTokenEstimate(conversationTokens);
            this.lintPanel?.coWriterSetMaxAllowedTokens(maxTokens);
        };
        session.onDiscussStartStreaming = () => {
            this.lintPanel?.coWriterDiscussStartStreaming();
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
        session.onDirectChangeUpdate = () => {
            this.lintPanel?.coWriterSetDirectChange(session.directChanges.edits[0] ?? null);
        };
        session.onLoreCoachUpdate = () => {
            if (!this.lintPanel) return;
            this.lintPanel.coWriterSetLoreCoachPhase(session.loreCoachSession?.phase ?? 'discover');
            this.lintPanel.coWriterSetLoreCoachActive(session.loreCoachActive);
        };
        // `onLoreDraftReady` is intentionally a no-op here — the draft card
        // is rendered inline on the chat message that produced it (driven by
        // `onChatUpdate`), so there's nothing to push to the panel separately.
        // The hook exists for future use (e.g., auto-scroll to the draft).
        session.onLoreDraftReady = () => {};
    }

    /**
     * Send a direction to the co-writer in Direct mode.
     * Streams the continuation directly into the editor at the cursor position.
     */
    async sendCoWriterMessage(direction: string): Promise<void> {
        const path = this.app.workspace.getActiveFile()?.path;
        if (path) this.coWriterSession.manuscriptPath = path;
        await this.openCoWriterPanel();
        await this.ensureContextInitialized();
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
        await this.ensureContextInitialized();
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
        await this.ensureContextInitialized();
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
        await this.ensureContextInitialized();
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

    /**
     * Send a message to the Lorebook Coach.
     * The coach uses the pseudo-tool framework to pull manuscript mentions,
     * lore siblings, and vault notes mid-generation, then proposes a draft
     * entry for the writer to review and save as a note.
     */
    async sendCoWriterLoreCoach(message: string): Promise<void> {
        await this.openCoWriterPanel();
        this.wireCoWriterPanel();
        await this.coWriterSession.sendLoreCoach(this, message);
    }

    /** End the current Lorebook Coach session. */
    endCoWriterLoreCoach(): void {
        this.coWriterSession.endLoreCoachSession();
        this.lintPanel?.coWriterSetLoreCoachActive(false);
        this.lintPanel?.coWriterSetLoreCoachPhase('discover');
    }

    /**
     * Discard the pending lore draft. The chat message that produced it
     * stays in history (so the writer can see what was proposed) but the
     * session's `currentLoreDraft` is cleared so the review card's actions
     * no longer fire.
     */
    discardLoreDraft(_draft: LoreDraftEntry): void {
        this.coWriterSession.currentLoreDraft = null;
    }

    /** Resolve the CodeMirror view of the active markdown editor, if any. */
    private getActiveCm(): EditorView | undefined {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return undefined;
        return (view.editor as unknown as { cm: EditorView }).cm;
    }

    /**
     * Find the CodeMirror EditorView for a specific file path.
     *
     * Uses `findEditorView` which searches all open leaves — works even
     * when the sidebar has stolen focus (unlike `getActiveCm` which relies
     * on `getActiveViewOfType(MarkdownView)` and returns null in that case).
     */
    private getCmForFile(filePath: string): EditorView | undefined {
        const view = findEditorView(this.app, filePath);
        if (!view) return undefined;
        return (view.editor as unknown as { cm: EditorView }).cm;
    }

    /**
     * Find the editor + CodeMirror view for a file path.
     *
     * Works even when the sidebar has stolen focus. Returns undefined if no
     * markdown view is open for the given file.
     */
    private getEditorAndCm(filePath: string): { editor: Editor; cm: EditorView } | undefined {
        const view = findEditorView(this.app, filePath);
        if (!view) return undefined;
        const cm = (view.editor as unknown as { cm: EditorView }).cm;
        return { editor: view.editor, cm };
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

    // --- Batch "Fix all with AI" ---

    /** Whether a batch or single AI fix is currently in progress. UI uses this to disable buttons. */
    batchFixInProgress = false;
    /** Which tab initiated the current batch fix — controls where the pending subtab appears. */
    batchFixSource: 'linter' | 'dashboard' | null = null;

    /**
     * Fix all lint findings with AI.
     *
     * Groups findings by paragraph so that multiple issues on the same passage
     * (e.g., "long sentence" + "passive voice") are addressed in one rewrite.
     * Each group produces one `ProposedEdit` in the change-review diff with
     * per-section Approve/Reject.
     */
    async fixAllLinterWithAi(): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: no chat model configured.');
            return;
        }

        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const ec = this.getEditorAndCm(activePath);
        if (!ec) return;
        const { editor, cm } = ec;

        const results = this.currentResults;
        if (results.length === 0) {
            new Notice('Quill: no lint findings to fix.');
            return;
        }

        const editorText = editor.getValue();
        const groups = groupFindingsByPassage(results, editorText);

        // Clear previous batch.
        this.lintBatchChangeSet.clear();
        clearDiffEdits(cm, 'lint-batch');

        this.batchFixInProgress = true;
        this.batchFixSource = 'linter';
        this.lintPanel?.switchToPendingTab();
        new Notice(`Quill: fixing ${groups.length} passage${groups.length !== 1 ? 's' : ''}...`);

        try {
            for (let i = 0; i < groups.length; i++) {
                const group = groups[i]!;
                const { system, user } = buildBatchLinterPrompt(group, this.settings.wikiLinkBehavior);

                try {
                    const response = await streamBatchFix(
                        chat.provider,
                        [
                            { role: 'system', content: system },
                            { role: 'user', content: user }
                        ],
                        {
                            temperature: this.settings.linterTemperature,
                            maxTokens: this.settings.linterMaxOutputTokens,
                            model: chat.modelId
                        }
                    );

                    if (response && response !== group.passageText) {
                        const labels = group.findings.map((f) => RULE_INFO[f.rule]?.name ?? f.rule).join(' + ');
                        this.lintBatchChangeSet.add({
                            from: group.passageStart,
                            to: group.passageEnd,
                            newText: response,
                            label: labels,
                            originalText: group.passageText
                        });
                        pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
                        this.lintPanel?.refreshPendingTab();
                    }
                } catch (err) {
                    // Skip this group on error; continue with remaining groups.
                    const labels = group.findings.map((f) => RULE_INFO[f.rule]?.name ?? f.rule).join(' + ');
                    console.error(
                        `Quill: batch linter fix failed for passage ${i + 1}/${groups.length} (${labels})`,
                        err
                    );
                }
            }

            const count = this.lintBatchChangeSet.edits.length;
            if (count > 0) {
                new Notice(`Quill: ${count} fix${count !== 1 ? 'es' : ''} ready for review.`);
            } else {
                new Notice('Quill: no fixes generated.');
            }
        } finally {
            this.batchFixInProgress = false;
            this.lintPanel?.refreshPendingTab();
        }
    }

    /**
     * Fix all pacing flags in the active file with AI.
     *
     * Each pacing flag produces one `ProposedEdit` that rewrites the flagged
     * passage to vary sentence length. Only flags in the currently active
     * file are processed — switch files and re-run for other chapters.
     */
    async fixAllPacingWithAi(): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: no chat model configured.');
            return;
        }

        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const ec = this.getEditorAndCm(activePath);
        if (!ec) return;
        const { editor, cm } = ec;

        const metrics = this.currentDashboardMetrics;
        if (!metrics) return;

        // Filter to pacing flags in the active file.
        const flags = metrics.pacingFlags.filter((f) => f.filePath === activePath);

        if (flags.length === 0) {
            new Notice('Quill: no pacing flags in the active file.');
            return;
        }

        // Clear previous batch.
        this.lintBatchChangeSet.clear();
        clearDiffEdits(cm, 'lint-batch');

        const editorText = editor.getValue();
        const lines = editorText.split('\n');
        const lineOffsets: number[] = [0];
        for (let i = 0; i < lines.length; i++) {
            lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
        }

        const totalFlags = metrics.pacingFlags.length;
        const skipped = totalFlags - flags.length;
        const scopeNote = skipped > 0 ? ` (${skipped} in other files — switch files to fix those)` : '';

        this.batchFixInProgress = true;
        this.batchFixSource = 'dashboard';
        this.lintPanel?.switchToPendingTab();
        new Notice(`Quill: fixing ${flags.length} pacing flag${flags.length !== 1 ? 's' : ''}${scopeNote}...`);

        try {
            for (const flag of flags) {
                const startOffset = lineOffsets[flag.lineStart - 1] ?? 0;
                const endOffset = (lineOffsets[flag.lineEnd] ?? editorText.length) - 1;
                const passageText = editorText.slice(startOffset, Math.max(startOffset, endOffset));

                const { system, user } = buildPacingFixPrompt(flag, passageText, this.settings.wikiLinkBehavior);

                try {
                    const response = await streamBatchFix(
                        chat.provider,
                        [
                            { role: 'system', content: system },
                            { role: 'user', content: user }
                        ],
                        {
                            temperature: this.settings.transformTemperature,
                            maxTokens: this.settings.transformMaxOutputTokens,
                            model: chat.modelId
                        }
                    );

                    if (response && response !== passageText) {
                        this.lintBatchChangeSet.add({
                            from: startOffset,
                            to: Math.max(startOffset, endOffset),
                            newText: response,
                            label: flag.kind === 'uniform-short' ? 'Vary short sentences' : 'Vary long sentences',
                            originalText: passageText
                        });
                        pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
                        this.lintPanel?.refreshPendingTab();
                    }
                } catch {
                    // Skip this flag on error; continue with remaining flags.
                }
            }

            const count = this.lintBatchChangeSet.edits.length;
            if (count > 0) {
                new Notice(`Quill: ${count} pacing fix${count !== 1 ? 'es' : ''} ready for review.`);
            } else {
                new Notice('Quill: no pacing fixes generated.');
            }
        } finally {
            this.batchFixInProgress = false;
            this.lintPanel?.refreshPendingTab();
        }
    }

    /** Approve a single batch-fix edit: commit the rewrite and update the diff. */
    approveLintBatchChange(id: number): void {
        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const cm = this.getCmForFile(activePath);
        if (!cm) return;
        syncChangeSetPositions(cm, this.lintBatchChangeSet, 'lint-batch');
        const change = this.lintBatchChangeSet.approve(id);
        if (!change) return;
        const preserved = cm.state.field(diffEditsField).filter((s) => s.owner !== 'lint-batch');
        cm.dispatch({
            changes: change,
            effects: setDiffEdits.of([...preserved, ...toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch')]),
            selection: { anchor: change.from + change.insert.length }
        });
    }

    /** Reject a single batch-fix edit: leave the original passage. */
    rejectLintBatchChange(id: number): void {
        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const cm = this.getCmForFile(activePath);
        if (!cm) return;
        this.lintBatchChangeSet.reject(id);
        pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
    }

    /** Approve all pending batch-fix edits in document order. */
    approveAllLintBatch(): void {
        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const cm = this.getCmForFile(activePath);
        if (!cm) return;
        syncChangeSetPositions(cm, this.lintBatchChangeSet, 'lint-batch');
        for (const change of this.lintBatchChangeSet.approveAll()) {
            cm.dispatch({ changes: change });
        }
        pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
    }

    /** Reject all pending batch-fix edits. */
    rejectAllLintBatch(): void {
        const activePath = this.app.workspace.getActiveFile()?.path;
        if (!activePath) return;
        const cm = this.getCmForFile(activePath);
        if (!cm) return;
        this.lintBatchChangeSet.rejectAll();
        pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
    }

    /**
     * Fix a single pacing flag with AI.
     *
     * Extracts the flagged passage, builds a pacing-fix prompt, streams the
     * AI response, and adds a `ProposedEdit` to the change-review diff.
     * Only works on flags in the currently active file.
     */
    async fixSinglePacingFlag(flag: {
        filePath: string;
        lineStart: number;
        lineEnd: number;
        kind: 'uniform-short' | 'uniform-long';
        avgSentenceLength: number;
    }): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: no chat model configured.');
            return;
        }

        const ec = this.getEditorAndCm(flag.filePath);
        if (!ec) {
            new Notice('Quill: open the chapter file containing this flag to fix it.');
            return;
        }
        const { editor, cm } = ec;

        const editorText = editor.getValue();
        const lines = editorText.split('\n');
        const lineOffsets: number[] = [0];
        for (let i = 0; i < lines.length; i++) {
            lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
        }

        const startOffset = lineOffsets[flag.lineStart - 1] ?? 0;
        const endOffset = Math.max(startOffset, (lineOffsets[flag.lineEnd] ?? editorText.length) - 1);
        const passageText = editorText.slice(startOffset, endOffset);

        const { system, user } = buildPacingFixPrompt(flag, passageText, this.settings.wikiLinkBehavior);

        this.batchFixInProgress = true;
        this.batchFixSource = 'dashboard';
        this.lintPanel?.switchToPendingTab();
        new Notice('Quill: generating pacing fix...');

        try {
            const response = await streamBatchFix(
                chat.provider,
                [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ],
                {
                    temperature: this.settings.transformTemperature,
                    maxTokens: this.settings.transformMaxOutputTokens,
                    model: chat.modelId
                }
            );

            if (response && response !== passageText) {
                this.lintBatchChangeSet.add({
                    from: startOffset,
                    to: endOffset,
                    newText: response,
                    label: flag.kind === 'uniform-short' ? 'Vary short sentences' : 'Vary long sentences',
                    originalText: passageText
                });
                pushDiffEdits(cm, toDiffSnapshots(this.lintBatchChangeSet, 'lint-batch'));
                this.lintPanel?.refreshPendingTab();
                new Notice('Quill: pacing fix ready for review.');
            } else {
                new Notice('Quill: no changes suggested.');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Quill: pacing fix failed (${message}).`);
        } finally {
            this.batchFixInProgress = false;
            this.lintPanel?.refreshPendingTab();
        }
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

    // ========================================================================
    // Manuscript Analysis Engine
    // ========================================================================

    cancelManuscriptAnalysisGeneration(): void {
        this.manuscriptAnalysisAbort?.abort();
    }

    resetManuscriptAnalysisChat(): void {
        this.manuscriptAnalysisAbort?.abort();
        this.manuscriptAnalysisCurrentMessages = [];
        this.lintPanel?.reviewResetResults();
    }

    async compactManuscriptAnalysis(): Promise<void> {
        if (this.manuscriptAnalysisCurrentMessages.length <= 1) return;
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) return;
        const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));
        try {
            const result = await compactConversation(
                chat.provider,
                this.manuscriptAnalysisCurrentMessages,
                sentenceCount
            );
            if (result) {
                this.manuscriptAnalysisCurrentMessages = result.messages;
                this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            console.warn('Quill: Manuscript analysis manual compaction failed.', err);
        }
    }

    /**
     * Request manuscript analysis of the active document with the given mode.
     * Streams the response into the Results sub-tab. Always refreshes dashboard
     * metrics for a full-manuscript diagnostic.
     */
    async requestManuscriptAnalysis(
        mode: ManuscriptAnalysisMode,
        scope: ManuscriptScope,
        compaction: CompactionStrategy,
        customInstruction?: string
    ): Promise<void> {
        if (!this.settings.enableManuscriptAnalysis) {
            new Notice('Quill: Manuscript analysis is disabled in settings.');
            return;
        }

        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        await this.ensureContextInitialized();

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            new Notice('Quill: Open a Markdown document to run manuscript analysis.');
            this.lintPanel?.reviewError('No active document.');
            return;
        }

        // Cancel any in-flight request.
        this.manuscriptAnalysisAbort?.abort();
        this.manuscriptAnalysisAbort = new AbortController();
        const myAbort = this.manuscriptAnalysisAbort;

        const modeMeta = getManuscriptAnalysisModeById(mode);

        // Resolve all manuscript files (multi-file support).
        const resolved = await this.resolveManuscriptChapters(activeFile);
        if (!resolved) return;

        let { chapters, entities, msFile } = resolved;

        // Apply user reclassification overrides.
        for (const entity of entities) {
            const newType = msFile.reclassifiedEntities[entity.id];
            if (newType) entity.type = newType;
        }
        const dismissedIds = new Set(msFile.dismissedEntities);

        // --- Scope resolution ---
        let selectedChapters: ChapterRange[] = chapters;
        let scopeLabel = 'full manuscript';

        if (scope.kind === 'surrounding') {
            const idx = this.findCurrentChapterIndex(chapters, activeFile);
            if (idx === null) {
                new Notice('Quill: Could not locate the current chapter. Falling back to full manuscript.');
                selectedChapters = chapters;
            } else {
                const count = scope.count;
                const start = Math.max(0, idx - count);
                const end = Math.min(chapters.length, idx + count + 1);
                selectedChapters = chapters.slice(start, end);
                scopeLabel = `surrounding ${count} chapters (${selectedChapters.length} of ${chapters.length})`;
            }
        }

        const scopeMetrics = manuscriptMetrics(selectedChapters, entities, dismissedIds);
        this.lintPanel?.reviewStartLoading('manuscript', modeMeta?.label ?? mode, scopeLabel);

        // --- Compaction strategy ---
        let manuscriptText: string;
        let compactionNote = '';
        let wasCompacted = false;

        const selectedText = selectedChapters.map((c) => c.text).join('\n\n');

        if (compaction === 'embed') {
            const embedProvider = this.getDefaultEmbedProvider();
            if (!embedProvider) {
                new Notice('Quill: No embed model configured. Sending full text instead.');
                manuscriptText = selectedText;
            } else {
                try {
                    const embedKey = parseProviderKey(this.settings.aiDefaultEmbedProvider);
                    const embedModelId = embedKey?.modelId || '';
                    const chunkOptions = {
                        targetTokenSize: Math.floor(this.settings.embeddingChunkTokenSize * 0.85),
                        overlap: 0.1
                    };

                    // Chunk each chapter individually to preserve file associations.
                    const chunks: Chunk[] = [];
                    for (const chapter of selectedChapters) {
                        const chapterChunks = chunkManuscript(
                            chapter.text,
                            chunkOptions,
                            chapter.filePath,
                            chapter.title
                        );
                        chunks.push(...chapterChunks);
                    }

                    // Attach hashes for cache lookups.
                    for (const chunk of chunks) {
                        chunk.hash = hashString(chunk.text);
                    }

                    // Group chunks by their source folder for cache lookup.
                    const folderGroups = new Map<string, Chunk[]>();
                    for (const chunk of chunks) {
                        if (!chunk.filePath) continue;
                        const folder = chunk.filePath.includes('/')
                            ? chunk.filePath.substring(0, chunk.filePath.lastIndexOf('/'))
                            : '';
                        if (!folderGroups.has(folder)) {
                            folderGroups.set(folder, []);
                        }
                        folderGroups.get(folder)!.push(chunk);
                    }

                    // Load caches per folder and ensure embeddings.
                    const caches: EmbeddingCache[] = [];
                    for (const [folder, folderChunks] of folderGroups) {
                        const cache = await EmbeddingCache.load(this.app.vault, folder, embedModelId);
                        await cache.ensureEmbeddings(embedProvider, folderChunks, embedModelId);
                        await cache.save(this.app.vault);
                        caches.push(cache);
                    }

                    // Embed the query.
                    const modeDesc = modeMeta?.description ?? mode;
                    const query = `${modeMeta?.label ?? mode}: ${modeDesc}${customInstruction ? ` — ${customInstruction}` : ''}`;
                    const queryResult = await embedProvider.embed({ input: query, model: embedModelId });
                    const queryEmbedding = queryResult.embeddings[0]!;

                    // Rank all chunks by similarity.
                    const ranked = rankBySimilarity(chunks, queryEmbedding, this.settings.embeddingsTopKChunks);
                    manuscriptText = ranked
                        .map((c) => {
                            const prefix = c.chapterTitle ? `[${c.chapterTitle}] ` : '';
                            return `${prefix}${c.text}`;
                        })
                        .join('\n\n');
                    compactionNote = ` (embedded: ${ranked.length}/${chunks.length} chunks)`;
                    wasCompacted = true;
                } catch (err: unknown) {
                    if (err instanceof Error && err.name === 'AbortError') {
                        await this.lintPanel?.reviewChatFinished();
                        return;
                    }
                    new Notice('Quill: Embedding failed. Sending full text instead.');
                    manuscriptText = selectedText;
                }
            }
        } else if (compaction === 'compress') {
            try {
                const chunks = chunkManuscript(selectedText, {
                    targetTokenSize: this.settings.manuscriptAnalysisChunkTokenSize,
                    overlap: 0.1
                });
                manuscriptText = await compressChunks(chat.provider, chunks, {
                    model: chat.modelId,
                    signal: this.manuscriptAnalysisAbort.signal
                });
                compactionNote = ` (compressed: ${chunks.length} chunks)`;
                wasCompacted = true;
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return;
                new Notice('Quill: Compression failed. Sending full text instead.');
                manuscriptText = selectedText;
            }
        } else {
            manuscriptText = selectedText;
        }

        // Vault context from context engine (best-effort).
        const assembly = this.contextActiveFile === activeFile.path ? this.currentAssembly : null;
        const contextParts: string[] = [];
        try {
            if (assembly && assembly.contextItems.length > 0) {
                for (const item of assembly.contextItems) {
                    if (item.excerpt) contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                }
            }
        } catch {
            // Vault context is best-effort.
        }
        const vaultContext = contextParts.length > 0 ? contextParts.join('\n\n') : '';

        // Build the initial system + user messages.
        const initialMessages = buildManuscriptAnalysisMessages(mode, {
            mode,
            metrics: scopeMetrics,
            manuscriptText,
            manuscriptName: activeFile.name,
            vaultContext,
            customInstruction,
            temperature: this.settings.manuscriptAnalysisTemperature,
            maxTokens: this.settings.manuscriptAnalysisMaxOutputTokens,
            signal: this.manuscriptAnalysisAbort.signal,
            compacted: wasCompacted
        });
        // Lore reference embeds (gated on reviewLoreContext) injected between the
        // system prompt and user instruction so the first manuscript-analysis
        // payload receives lore context, mirroring the follow-up chat flow.
        const loreReferenceMessages = await this.loreReferenceMessages(manuscriptText);
        const initialWithLore = loreReferenceMessages.length
            ? [initialMessages[0]!, ...loreReferenceMessages, ...initialMessages.slice(1)]
            : initialMessages;
        this.manuscriptAnalysisCurrentMessages = [...initialWithLore];

        try {
            const stream = getManuscriptAnalysis(chat.provider, mode, {
                mode,
                metrics: scopeMetrics,
                manuscriptText,
                manuscriptName: activeFile.name + compactionNote,
                vaultContext,
                customInstruction,
                model: chat.modelId,
                signal: this.manuscriptAnalysisAbort.signal,
                temperature: this.settings.manuscriptAnalysisTemperature,
                maxTokens: this.settings.manuscriptAnalysisMaxOutputTokens,
                existingMessages: initialWithLore,
                compacted: wasCompacted
            });
            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.manuscriptAnalysisCurrentMessages.push({ role: 'assistant', content: fullResponse });
                    this.lintPanel?.reviewSetContextTokenEstimate(
                        estimateTokens(this.manuscriptAnalysisCurrentMessages)
                    );
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
            new Notice('Quill: Manuscript analysis request failed.');
        } finally {
            if (this.manuscriptAnalysisAbort === myAbort) {
                this.manuscriptAnalysisAbort = null;
            }
        }
    }

    /**
     * Resolve all manuscript chapter files for the active document.
     * Reads each file, strips frontmatter, splits into chapters, extracts entities.
     * Returns null (with a Notice) if no chapters are found.
     */
    private async resolveManuscriptChapters(
        activeFile: TFile,
        silent = false
    ): Promise<{
        chapters: ChapterRange[];
        entities: ExtractedEntity[];
        msFile: ManuscriptFileData;
    } | null> {
        const folder = activeFile.parent?.path ?? '';
        let msFile: ManuscriptFileData;
        try {
            msFile = await loadManuscriptFile(this.app.vault, folder);
        } catch {
            msFile = {
                schemaVersion: 1,
                chapterOverrides: { add: [], remove: [] },
                reclassifiedEntities: {},
                dismissedEntities: [],
                snapshots: []
            };
        }
        const includeSubfolders = msFile.includeSubfolders ?? DEFAULT_INCLUDE_SUBFOLDERS;
        const splitByHeading = msFile.splitByHeading ?? DEFAULT_SPLIT_BY_HEADING;
        const chapterFiles = this.resolveManuscriptFiles(folder, activeFile.path, includeSubfolders, msFile);
        if (chapterFiles.length === 0) {
            if (!silent) {
                new Notice('Quill: No manuscript files found for this folder.');
                this.lintPanel?.reviewError('No manuscript files.');
            }
            return null;
        }

        const chapters: ChapterRange[] = [];
        const fullTextParts: string[] = [];
        for (const file of chapterFiles) {
            const raw = await this.app.vault.read(file);
            const { text: bodyText, strippedLines } = stripFrontmatter(raw);
            const ranges = listChaptersInFile(bodyText, file.path, file.basename, splitByHeading);
            for (const range of ranges) {
                range.lineStart += strippedLines;
                range.lineEnd += strippedLines;
            }
            chapters.push(...ranges);
            fullTextParts.push(bodyText);
        }

        if (chapters.length === 0) {
            if (!silent) {
                new Notice('Quill: No chapters found in manuscript files.');
                this.lintPanel?.reviewError('No chapters.');
            }
            return null;
        }

        const fullText = fullTextParts.join('\n\n');
        const entities = extractAllEntities(fullText);

        return { chapters, entities, msFile };
    }

    /**
     * Find the index of the chapter containing the cursor in the active editor.
     * Uses the established `findEditorView` + `getActiveFile` pattern so it
     * works even when the sidebar has focus.
     */
    private findCurrentChapterIndex(chapters: ChapterRange[], activeFile: TFile): number | null {
        const view = findEditorView(this.app, activeFile.path);
        if (!view) return null;

        const cursorLine = view.editor.getCursor().line + 1; // 0-based → 1-based

        // Filter to only this file's chapters, preserving global order.
        let globalIdx = -1;
        for (let i = 0; i < chapters.length; i++) {
            const ch = chapters[i]!;
            if (ch.filePath !== activeFile.path) continue;
            if (cursorLine >= ch.lineStart && cursorLine <= ch.lineEnd) {
                globalIdx = i;
                break;
            }
        }

        if (globalIdx === -1) {
            // Cursor might be in frontmatter or outside any chapter heading.
            // Fall back to the first chapter in the active file.
            globalIdx = chapters.findIndex((c) => c.filePath === activeFile.path);
        }

        return globalIdx === -1 ? null : globalIdx;
    }

    /**
     * Compute a pre-generation token estimate for the manuscript analysis
     * given the current mode and scope. Used by the panel to warn the user
     * before they click Generate.
     */
    async getManuscriptTokenEstimate(
        scope: ManuscriptScope,
        compaction: CompactionStrategy
    ): Promise<{ estimated: number; max: number } | null> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) return null;

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return null;

        const resolved = await this.resolveManuscriptChapters(activeFile, true);
        if (!resolved) return null;

        let { chapters } = resolved;

        // Apply scope.
        let selectedText: string;
        if (scope.kind === 'surrounding') {
            const idx = this.findCurrentChapterIndex(chapters, activeFile);
            if (idx === null) {
                selectedText = chapters.map((c) => c.text).join('\n\n');
            } else {
                const count = scope.count;
                const start = Math.max(0, idx - count);
                const end = Math.min(chapters.length, idx + count + 1);
                selectedText = chapters
                    .slice(start, end)
                    .map((c) => c.text)
                    .join('\n\n');
            }
        } else {
            selectedText = chapters.map((c) => c.text).join('\n\n');
        }

        // Apply compaction estimate.
        let estimatedTextTokens: number;
        if (compaction === 'embed') {
            // Embed compaction: top-K chunks of ~embeddingChunkTokenSize each.
            estimatedTextTokens = this.settings.embeddingsTopKChunks * this.settings.embeddingChunkTokenSize;
        } else if (compaction === 'compress') {
            // Compress: each chunk becomes ~150 tokens of summary.
            const chunkCount = Math.ceil(estimateTokens(selectedText) / this.settings.manuscriptAnalysisChunkTokenSize);
            estimatedTextTokens = chunkCount * 150;
        } else {
            estimatedTextTokens = estimateTokens(selectedText);
        }

        // Add system prompt + metrics overhead (~500 tokens).
        const overhead = 500;
        const estimated = estimatedTextTokens + overhead;
        const max = chat.provider.config.maxContextTokens ?? 8192;

        return { estimated, max };
    }

    // ========================================================================
    // Embedding cache warming
    // ========================================================================

    /** Read a file's text from the vault. Returns empty string on failure. */
    private async getFileText(filePath: string): Promise<string> {
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) return '';
            return await this.app.vault.cachedRead(file);
        } catch {
            return '';
        }
    }

    /**
     * Schedule debounced embedding warming for a folder.
     * Resets the timer on each call so rapid saves don't trigger multiple
     * warming passes. Uses raw setTimeout with a comment — we need
     * per-folder independent timers.
     */
    scheduleEmbeddingWarming(folder: string): void {
        const existing = this.embeddingWarmingTimers.get(folder);
        if (existing !== undefined) window.clearTimeout(existing);

        // Raw timer: per-folder debounce that fires once after the quiet period.
        // Not registered with the Component lifecycle because timers are
        // short-lived and cleared on unload via onunload.
        const delay = Math.max(5, this.settings.embeddingWarmingDebounceSeconds) * 1000;
        const timer = window.setTimeout(() => {
            this.embeddingWarmingTimers.delete(folder);
            void this.warmEmbeddingsForFolder(folder);
        }, delay);
        this.embeddingWarmingTimers.set(folder, timer);
    }

    /**
     * Warm the embedding cache for a single folder. Reads all markdown files
     * directly in the folder (not subfolders — those have their own caches),
     * chunks them, and embeds only chunks whose content hash isn't cached.
     */
    async warmEmbeddingsForFolder(folder: string): Promise<void> {
        if (this.embeddingWarmingActive.has(folder)) return;
        if (!folder || folder === '/' || folder === '') return;

        const embedProvider = this.getDefaultEmbedProvider();
        if (!embedProvider) return;

        const embedKey = parseProviderKey(this.settings.aiDefaultEmbedProvider);
        const modelId = embedKey?.modelId || '';
        if (!modelId) return;

        this.embeddingWarmingActive.add(folder);
        try {
            // Find markdown files directly in this folder (not subfolders).
            // Exclude .obsidian/ and hidden directories — they contain Obsidian
            // internal state, not user content.
            const allMarkdown = this.app.vault.getMarkdownFiles();
            const folderPrefix = folder + '/';
            const folderFiles = allMarkdown.filter(
                (f) =>
                    f.path.startsWith(folderPrefix) &&
                    !f.path.substring(folderPrefix.length).includes('/') &&
                    !isExcludedPath(f.path, this.app.vault.configDir)
            );

            if (folderFiles.length === 0) return;

            // Read and chunk all files in the folder.
            const allChunks: Array<{
                text: string;
                hash: string;
                filePath: string;
                chunkIndex: number;
                embedding?: number[];
            }> = [];

            for (const file of folderFiles) {
                const raw = await this.app.vault.read(file);
                const { text: bodyText } = stripFrontmatter(raw);
                if (!bodyText.trim()) continue;

                // Prepend Obsidian's built-in aliases as a header so the AI
                // can connect nicknames to the character/entry when retrieved
                // via embedding similarity. Without this, "Dripsy" in the
                // manuscript text won't match the "Freddy Lupin" lore chunk.
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const aliases = parseAliases(frontmatter?.['aliases']);
                const textForChunking =
                    aliases.length > 0 ? `Also known as: ${aliases.join(', ')}\n\n${bodyText}` : bodyText;

                const chunks = chunkManuscript(textForChunking, {
                    targetTokenSize: Math.floor(this.settings.embeddingChunkTokenSize * 0.85),
                    overlap: 0.1
                });

                for (let i = 0; i < chunks.length; i++) {
                    const c = chunks[i]!;
                    allChunks.push({
                        text: c.text,
                        hash: hashString(c.text),
                        filePath: file.path,
                        chunkIndex: i
                    });
                }
            }

            if (allChunks.length === 0) return;

            // Load cache and ensure embeddings (incremental).
            const cache = await EmbeddingCache.load(this.app.vault, folder, modelId);
            await cache.ensureEmbeddings(embedProvider, allChunks, modelId);

            // Re-validate model id before persisting — a model change during
            // warming would leave stale embeddings if we save unchecked.
            const currentKey = parseProviderKey(this.settings.aiDefaultEmbedProvider);
            const currentModelId = currentKey?.modelId || '';
            if (currentModelId !== modelId) return;

            await cache.save(this.app.vault);
        } catch {
            // Best-effort warming — failures are non-critical.
        } finally {
            this.embeddingWarmingActive.delete(folder);
        }
    }

    /**
     * Warm embedding caches for all non-root folders containing markdown files.
     * Called after dashboard refresh and available as a manual command.
     */
    async warmAllEmbeddingCaches(): Promise<void> {
        if (!this.getDefaultEmbedProvider()) return;

        const allMarkdown = this.app.vault.getMarkdownFiles();
        const folders = new Set<string>();
        for (const file of allMarkdown) {
            const path = file.path;
            if (isExcludedPath(path, this.app.vault.configDir)) continue;
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash <= 0) continue;
            folders.add(path.substring(0, lastSlash));
        }

        // Warm each folder sequentially to avoid overwhelming the embed API.
        for (const folder of folders) {
            await this.warmEmbeddingsForFolder(folder);
        }
    }

    /** Cancel all pending embedding warming timers (called on unload). */
    private clearEmbeddingWarmingTimers(): void {
        for (const timer of this.embeddingWarmingTimers.values()) {
            window.clearTimeout(timer);
        }
        this.embeddingWarmingTimers.clear();
    }

    /**
     * Delete all embedding cache files in the vault. Called when the embed
     * provider changes, since different models produce different-dimensionality
     * vectors that can't be mixed.
     */
    async invalidateAllEmbeddingCaches(): Promise<void> {
        // Cancel any pending warming timers so they don't fire after
        // invalidation and attempt to persist cache with the old model.
        this.clearEmbeddingWarmingTimers();

        // Wait for in-flight warming operations to finish so they don't
        // recreate stale cache files after deletion. The warmers' own
        // re-validation check (modelId mismatch) provides a safety net.
        while (this.embeddingWarmingActive.size > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }

        const allFiles = this.app.vault.getFiles();
        const cacheFiles = allFiles.filter((f) => f.name === 'quill-embeddings.json');
        for (const file of cacheFiles) {
            try {
                await this.app.fileManager.trashFile(file);
            } catch {
                // Best-effort.
            }
        }
    }

    /**
     * Send a follow-up chat message in the manuscript analysis conversation.
     * Mirrors sendAnalysisChatMessage: compacts when near the token budget,
     * appends the user message, then streams a reply.
     */
    async sendManuscriptAnalysisChatMessage(message: string): Promise<void> {
        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured.');
            return;
        }

        this.manuscriptAnalysisAbort?.abort();
        this.manuscriptAnalysisAbort = new AbortController();
        const myAbort = this.manuscriptAnalysisAbort;

        this.lintPanel?.reviewChatStartLoading();

        // Chat context files are injected fresh as system messages on every call.
        const chatContextPaths = this.lintPanel?.reviewChatContextFiles() ?? [];

        // Get the active document text for embedding queries.
        const activeFile = this.app.workspace.getActiveFile();
        const documentText = activeFile ? await this.getFileText(activeFile.path) : '';

        // Resolve any embed-prefixed paths in chat context files.
        const { regularPaths: resolvedRefPaths, messages: refEmbedMessages } = await this.resolveEmbedPathsToMessages(
            [...this.loreReferencePaths(), ...chatContextPaths],
            'Reference file',
            documentText,
            this.settings.contextMaxCharsPerFile
        );

        // Resolve folder context items in the assembly.
        try {
            if (this.currentAssembly) {
                await this.resolveFolderContextItems(this.currentAssembly, documentText);
            }
        } catch {
            // Best-effort
        }

        const refFileMessages = await readVaultFiles(
            this.app.vault,
            resolvedRefPaths,
            'Reference file',
            this.settings.contextMaxCharsPerFile
        );
        const referenceMessages = [...refEmbedMessages, ...refFileMessages];
        const injectedTokens = estimateTokens(referenceMessages);

        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settings.contextCompactAtPercent)) / 100;

        const hypothetical = [...this.manuscriptAnalysisCurrentMessages, { role: 'user' as const, content: message }];
        const conversationTokens = estimateTokens(hypothetical) + injectedTokens;

        this.lintPanel?.reviewSetContextTokenEstimate(estimateTokens(this.manuscriptAnalysisCurrentMessages));

        if (conversationTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settings.compactSummarySentences));
            try {
                const result = await compactConversation(
                    chat.provider,
                    this.manuscriptAnalysisCurrentMessages,
                    sentenceCount,
                    { signal: this.manuscriptAnalysisAbort.signal }
                );
                if (result) {
                    this.manuscriptAnalysisCurrentMessages = result.messages;
                    this.lintPanel?.reviewAppendChatSystemMessageInPlace(result.summary);
                    this.lintPanel?.reviewSetContextTokenEstimate(
                        estimateTokens(this.manuscriptAnalysisCurrentMessages)
                    );
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.warn('Quill: Manuscript analysis compaction failed, continuing without compaction.', err);
            }
        }

        this.manuscriptAnalysisCurrentMessages.push({ role: 'user', content: message });

        const baseMessages: ChatMessage[] = [
            this.manuscriptAnalysisCurrentMessages[0]!,
            ...referenceMessages,
            ...this.manuscriptAnalysisCurrentMessages.slice(1)
        ];

        if (__DEV__ && this.settings.enableDebugLogging) {
            console.warn('Quill: Manuscript Analysis Chat API payload', JSON.stringify(baseMessages, null, 2));
        }

        try {
            const stream = chat.provider.chatCompletion({
                messages: baseMessages,
                model: chat.modelId,
                temperature: this.settings.manuscriptAnalysisTemperature,
                maxTokens: this.settings.manuscriptAnalysisMaxOutputTokens,
                signal: this.manuscriptAnalysisAbort.signal
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                if (chunk.done) {
                    this.manuscriptAnalysisCurrentMessages.push({
                        role: 'assistant',
                        content: fullResponse
                    });
                    this.lintPanel?.reviewSetContextTokenEstimate(
                        estimateTokens(this.manuscriptAnalysisCurrentMessages)
                    );
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
            new Notice('Quill: Manuscript analysis chat failed.');
        } finally {
            if (this.manuscriptAnalysisAbort === myAbort) {
                this.manuscriptAnalysisAbort = null;
            }
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
        // Critical analysis can be disabled from settings. Guard at this single
        // chokepoint so every entry point (command palette, context menu, Review
        // panel) is covered uniformly.
        if (!this.settings.enableCriticalAnalysis) {
            new Notice('Quill: Critical analysis is disabled in settings.');
            return;
        }

        const chat = this.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        // Auto-initialize context so the deterministic signal (characters, voice
        // marker, plot threads) is available even if the writer never visited
        // the Context tab.
        await this.ensureContextInitialized();

        const resolved = this.resolveAnalysisScope(scope);
        if (!resolved) {
            new Notice('Quill: Open a Markdown document with text before running analysis.');
            this.lintPanel?.reviewError('No active document to analyze.');
            return;
        }

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
        // Lore reference embeds (gated on reviewLoreContext) injected between the
        // system prompt and user instruction so the first analysis payload
        // receives lore context, mirroring the follow-up chat flow.
        const loreReferenceMessages = await this.loreReferenceMessages(resolved.text);
        const initialWithLore = loreReferenceMessages.length
            ? [initialMessages[0]!, ...loreReferenceMessages, ...initialMessages.slice(1)]
            : initialMessages;
        this.analysisCurrentMessages = [...initialWithLore];

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
                temperature: this.settings.analysisTemperature,
                maxTokens: this.settings.analysisMaxOutputTokens,
                existingMessages: initialWithLore
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

        // Get the active document text for embedding queries.
        const activeFile = this.app.workspace.getActiveFile();
        const documentText = activeFile ? await this.getFileText(activeFile.path) : '';

        // Resolve any embed-prefixed paths in chat context files.
        const { regularPaths: resolvedRefPaths, messages: refEmbedMessages } = await this.resolveEmbedPathsToMessages(
            [...this.loreReferencePaths(), ...chatContextPaths],
            'Reference file',
            documentText,
            this.settings.contextMaxCharsPerFile
        );

        // Resolve folder context items in the assembly.
        try {
            if (this.currentAssembly) {
                await this.resolveFolderContextItems(this.currentAssembly, documentText);
            }
        } catch {
            // Best-effort
        }

        const refFileMessages = await readVaultFiles(
            this.app.vault,
            resolvedRefPaths,
            'Reference file',
            this.settings.contextMaxCharsPerFile
        );
        const referenceMessages = [...refEmbedMessages, ...refFileMessages];
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

        if (__DEV__ && this.settings.enableDebugLogging) {
            console.warn('Quill: Analysis Chat API payload', JSON.stringify(baseMessages, null, 2));
        }

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
        // Mirror loadAdditionalContext's combined source (lore embeds + context
        // files) so the emptiness check doesn't skip counting when lore is
        // auto-injected but no manual context files are selected.
        const lorePaths = this.settings.coWriterLoreContext ? loreFolderEmbedPaths(this.settings.lorebookFolders) : [];
        const allPaths = [...lorePaths, ...files];
        if (allPaths.length === 0) {
            this.lintPanel?.coWriterSetAdditionalContextTokens(0);
            return;
        }
        const activeFile = this.app.workspace.getActiveFile();
        const documentText = activeFile ? await this.getFileText(activeFile.path) : '';
        const messages = await loadAdditionalContext(this, files, documentText);
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

    /**
     * Ensure the context engine has been initialized for the active document.
     *
     * If the Context tab hasn't been scanned for the current file (or was scanned
     * for a different file), this triggers a scan so that `currentAssembly`
     * (entities, voice marker, plot threads) is available for AI calls. This is
     * called by requestFeedback, requestAnalysis, and the co-writer session before
     * they read deterministic signal from the context engine.
     *
     * Best-effort: if the scan fails, the AI call proceeds without deterministic
     * signal (the prompts degrade gracefully).
     */
    async ensureContextInitialized(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;
        const activePath = activeFile.path;

        // Already initialized for this file — nothing to do.
        if (this.contextActiveFile === activePath && this.currentAssembly) return;

        // Need to scan. Find the editor for this file (sidebar may have focus).
        const view = findEditorView(this.app, activePath);
        if (!view) return;

        try {
            await this.assembleDocumentContext(view.editor.getValue(), activePath);
            // Push the fresh assembly to the sidebar so the Context tab updates.
            this.lintPanel?.setContextAssembly(this.currentAssembly);
        } catch {
            // Best-effort: AI calls degrade gracefully without context signal.
        }
    }

    /** Open the sidebar and switch to the Review tab. */
    async openReviewPanel(): Promise<void> {
        await this.openLintPanel();
        this.lintPanel?.switchToReviewTab();
    }

    /** Open the sidebar and switch to the Dashboard tab. */
    async openDashboardPanel(): Promise<void> {
        await this.openLintPanel();
        this.lintPanel?.switchToDashboardTab();
    }

    /** Activate the sidebar and switch to the Lorebook tab. */
    async openLorebookPanel(): Promise<void> {
        await this.openLintPanel();
        this.lintPanel?.switchToLorebookTab();
    }

    /**
     * Refresh dashboard metrics for the active manuscript.
     *
     * Loads the manuscript sidecar file (`{folder}/quill-data.json`) for
     * per-manuscript settings, chapter overrides, reclassification, and
     * snapshot history. Then resolves chapter files, computes metrics,
     * appends a snapshot, and stores the results on the plugin for the
     * panel to read.
     */
    async refreshDashboard(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            new Notice('Quill: open a manuscript to refresh the dashboard.');
            return;
        }

        const folder = activeFile.parent?.path ?? '';

        // Refuse to treat a lorebook folder as a manuscript — its files are
        // reference entries, not chapters. Computing metrics from them would
        // contaminate currentManuscriptText and produce meaningless coverage.
        // Silent bail: auto-triggers (save, periodic, open) fire from any
        // markdown file and must not spam notices.
        if (findLoreFolder(activeFile.path, this.settings.lorebookFolders)) {
            return;
        }

        // Load per-manuscript data from the sidecar file.
        const msFile = await loadManuscriptFile(this.app.vault, folder);
        this.currentManuscriptFileData = msFile;

        // Resolve settings: per-manuscript overrides fall back to preset defaults.
        const includeSubfolders = msFile.includeSubfolders ?? DEFAULT_INCLUDE_SUBFOLDERS;
        const splitByHeading = msFile.splitByHeading ?? DEFAULT_SPLIT_BY_HEADING;

        // Resolve chapter files.
        const chapterFiles = this.resolveManuscriptFiles(folder, activeFile.path, includeSubfolders, msFile);
        if (chapterFiles.length === 0) {
            new Notice('Quill: no chapter files found for this manuscript.');
            return;
        }

        try {
            const chapters: ChapterRange[] = [];
            for (const file of chapterFiles) {
                const raw = await this.app.vault.read(file);
                // Strip frontmatter so dashboard metrics ignore YAML properties.
                const { text: bodyText, strippedLines } = stripFrontmatter(raw);
                const ranges = listChaptersInFile(bodyText, file.path, file.basename, splitByHeading);
                // Adjust line numbers back to absolute positions in the file.
                for (const range of ranges) {
                    range.lineStart += strippedLines;
                    range.lineEnd += strippedLines;
                }
                chapters.push(...ranges);
            }

            if (chapters.length === 0) {
                new Notice('Quill: no chapters found in the manuscript files.');
                return;
            }

            // Extract entities from the whole manuscript text.
            const fullText = chapters.map((c) => c.text).join('\n\n');
            const entities = extractAllEntities(fullText);

            // Enrich entity names from vault file basenames.
            enrichEntityNamesFromVault(entities, this.app.vault.getMarkdownFiles());

            // Apply user reclassification overrides from the manuscript file.
            // Only change entity.type — the ID stays stable so the override
            // key remains valid across refreshes.
            for (const entity of entities) {
                const newType = msFile.reclassifiedEntities[entity.id];
                if (newType) {
                    entity.type = newType;
                }
            }

            // Compute metrics — pass dismissed IDs so those entities are
            // excluded from characters/reclassified and listed separately.
            const dismissedIds = new Set(msFile.dismissedEntities);
            const metrics = manuscriptMetrics(chapters, entities, dismissedIds);
            this.currentDashboardMetrics = metrics;

            // Cache the combined manuscript text and folder for the Lorebook
            // Manuscript subtab, which uses substring matching rather than entities.
            this.currentManuscriptText = fullText;
            this.currentManuscriptFolder = folder;

            // Scan lorebook folders and cache entries for the Lorebook tab.
            // The Lorebook tab computes its own coverage per subtab (document
            // or manuscript) when the panel renders, so we only cache entries here.
            this.currentManuscriptEntities = entities;

            // Append snapshot to the manuscript file.
            const snapshot: ManuscriptSnapshot = {
                takenAt: Date.now(),
                totalWords: metrics.totalWords,
                chapterCount: metrics.chapterCount,
                perChapterWords: metrics.chapters.map((c) => ({
                    filePath: c.filePath,
                    title: c.title,
                    wordCount: c.wordCount
                }))
            };
            const updated = await appendManuscriptSnapshot(
                this.app.vault,
                folder,
                snapshot,
                this.settings.dashboardMaxSnapshots
            );
            this.currentDashboardSnapshots = updated.snapshots;
            this.currentManuscriptFileData = updated;

            // Re-render the panel if the Dashboard tab is active.
            this.lintPanel?.refreshDashboardPanel();
            this.lintPanel?.refreshLorebookPanel();

            // Fire-and-forget embedding cache warming for the manuscript folder.
            if (this.settings.enableEmbeddingWarming && folder) {
                void this.warmEmbeddingsForFolder(folder);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Quill: dashboard refresh failed (${message}).`);
        }
    }

    /**
     * Refresh document-scoped lorebook coverage.
     *
     * Reads the active document's text and runs substring matching against
     * all lore entries (excluding the active file if it IS a lore entry).
     * Used by the Document subtab and after `setLoreEntryType`.
     */
    async refreshLorebookDocumentCoverage(): Promise<void> {
        if (this.settings.lorebookFolders.length === 0) {
            this.currentLoreDocumentCoverage = null;
            this.lintPanel?.refreshLorebookPanel();
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        const activePath = activeFile?.path ?? null;
        const docText = activeFile && activeFile.extension === 'md' ? await this.getFileText(activeFile.path) : '';
        // The user may have switched files during the read. Discard the update
        // if the active file no longer matches so stale coverage is never
        // published (the active-leaf-change path can trigger overlapping reads).
        if (activePath !== (this.app.workspace.getActiveFile()?.path ?? null)) return;
        const loreEntries = scanLorebook(this.app, this.settings.lorebookFolders, this.settings.lorebookFolderTypes);
        this.currentLoreDocumentCoverage = computeDocumentCoverage(docText, loreEntries, activePath);
        this.lintPanel?.refreshLorebookPanel();
    }

    /**
     * Refresh manuscript-scoped lorebook coverage.
     *
     * Uses the cached manuscript text and entities from the last dashboard
     * refresh for substring matching + entity-based gap detection. When
     * `autoRefresh` is true and no cached data exists (or the active folder
     * doesn't match), triggers a full dashboard refresh first.
     */
    async refreshLorebookManuscriptCoverage(autoRefresh = true): Promise<void> {
        if (this.settings.lorebookFolders.length === 0) {
            this.currentLoreManuscriptCoverage = null;
            this.lintPanel?.refreshLorebookPanel();
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();

        // Auto-refresh the dashboard when no cached manuscript data exists and
        // we're in a manuscript folder (not a lorebook folder), OR when the
        // active manuscript folder has changed since the last refresh —
        // otherwise switching folders would reuse the previous manuscript's
        // stale coverage.
        const activeFolder = activeFile?.parent?.path ?? '';
        const manuscriptFolderChanged =
            this.currentManuscriptFolder !== null && this.currentManuscriptFolder !== activeFolder;
        if (
            autoRefresh &&
            activeFile &&
            activeFile.extension === 'md' &&
            !findLoreFolder(activeFile.path, this.settings.lorebookFolders) &&
            (!this.currentManuscriptText || !this.currentManuscriptEntities.length || manuscriptFolderChanged)
        ) {
            await this.refreshDashboard();
        }

        const manuscriptText = this.currentManuscriptText ?? '';
        const entities = this.currentManuscriptEntities;
        const dismissedIds = new Set(this.currentManuscriptFileData?.dismissedEntities ?? []);

        if (!manuscriptText || !entities.length) {
            this.currentLoreManuscriptCoverage = null;
            this.lintPanel?.refreshLorebookPanel();
            return;
        }

        const loreEntries = scanLorebook(this.app, this.settings.lorebookFolders, this.settings.lorebookFolderTypes);
        this.currentLoreManuscriptCoverage = computeManuscriptCoverage(
            manuscriptText,
            loreEntries,
            entities,
            // Never exclude by active file — manuscript coverage is about the
            // full manuscript text, independent of which file is open. Baking
            // the active file path in here would make entries vanish when the
            // coverage was last computed while viewing a lore entry.
            null,
            dismissedIds
        );
        this.lintPanel?.refreshLorebookPanel();
    }

    /**
     * General lorebook refresh — delegates to the document-scoped method.
     * Used by the `quill-lorebook-refresh` command and `setLoreEntryType`.
     * The Manuscript subtab manages its own refresh lifecycle.
     */
    async refreshLorebook(): Promise<void> {
        await this.refreshLorebookDocumentCoverage();
    }

    /**
     * Set (or clear) the `quill-type` frontmatter on a lore entry file.
     *
     * Writes the flat `quill-type` key via Obsidian's `processFrontMatter` API
     * (non-destructive — other frontmatter is preserved). Pass `null` to clear
     * the per-file type so the entry inherits its folder's default. Refreshes
     * lorebook coverage so the change is reflected immediately.
     */
    async setLoreEntryType(file: TFile, type: LoreEntryType | null): Promise<void> {
        // Record the value we're about to write so the panel can render it
        // immediately, before the metadataCache propagates the change.
        this.pendingLoreEntryType = { path: file.path, type };
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            if (type === null) {
                delete fm['quill-type'];
            } else {
                fm['quill-type'] = type;
            }
        });
        await this.refreshLorebook();
        // Also refresh manuscript-scoped coverage: typing an entry can move it
        // in/out of the mapped set, changing referenced/orphaned/gaps when the
        // Manuscript subtab is active.
        await this.refreshLorebookManuscriptCoverage();
    }

    /**
     * Reclassify an entity's type and refresh the dashboard.
     *
     * Writes the override to the manuscript sidecar file
     * (`{folder}/quill-data.json`), then re-runs the dashboard refresh so
     * the entity moves to the correct section. Pass `null` as `newType` to
     * revert to the extracted type.
     */
    async reclassifyDashboardEntity(entityId: string, newType: EntityType | null): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        const folder = activeFile.parent?.path ?? '';
        await setEntityReclassification(this.app.vault, folder, entityId, newType);

        const namePart = entityId.split(':').slice(1).join(':').replace(/-/g, ' ');
        if (newType === null) {
            new Notice(`Quill: reverted "${namePart}" to its original type.`);
        } else {
            new Notice(`Quill: reclassified "${namePart}" as ${newType}.`);
        }

        await this.refreshDashboard();
    }

    /**
     * Dismiss an entity entirely from the dashboard.
     *
     * The entity ID is added to the manuscript sidecar file's
     * `dismissedEntities` list and filtered out of all dashboard sections
     * on the next refresh. The entity is not deleted — it can be restored.
     */
    async dismissDashboardEntity(entityId: string): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        const folder = activeFile.parent?.path ?? '';
        await withFolderLock(folder, async () => {
            const data = await loadManuscriptFile(this.app.vault, folder);
            if (!data.dismissedEntities.includes(entityId)) {
                data.dismissedEntities.push(entityId);
                await saveManuscriptFile(this.app.vault, folder, data);
            }
        });

        const namePart = entityId.split(':').slice(1).join(':').replace(/-/g, ' ');
        new Notice(`Quill: dismissed "${namePart}".`);

        await this.refreshDashboard();
    }

    /**
     * Restore a previously dismissed entity.
     *
     * Removes the entity ID from the `dismissedEntities` list in the
     * manuscript sidecar file. The entity reappears in its natural section
     * (characters, reclassified, etc.) on the next refresh.
     */
    async restoreDashboardEntity(entityId: string): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        const folder = activeFile.parent?.path ?? '';
        await withFolderLock(folder, async () => {
            const data = await loadManuscriptFile(this.app.vault, folder);
            data.dismissedEntities = data.dismissedEntities.filter((id) => id !== entityId);
            await saveManuscriptFile(this.app.vault, folder, data);
        });

        const namePart = entityId.split(':').slice(1).join(':').replace(/-/g, ' ');
        new Notice(`Quill: restored "${namePart}".`);

        await this.refreshDashboard();
    }

    /**
     * Update per-manuscript dashboard settings in the sidecar file.
     *
     * Loads the current manuscript file, applies the partial updates, saves,
     * and refreshes the dashboard so the new targets take effect immediately.
     */
    async updateManuscriptSettings(updates: Partial<ManuscriptFileData>): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') return;

        const folder = activeFile.parent?.path ?? '';
        const data = await withFolderLock(folder, async () => {
            const loaded = await loadManuscriptFile(this.app.vault, folder);
            Object.assign(loaded, updates);
            await saveManuscriptFile(this.app.vault, folder, loaded);
            return loaded;
        });
        this.currentManuscriptFileData = data;

        // Structural settings change which files are scanned and how chapters
        // are split — need a full metrics recompute. Target-only changes just
        // need a re-render (metrics don't depend on targets).
        const needsRecompute =
            'splitByHeading' in updates || 'includeSubfolders' in updates || 'chapterOverrides' in updates;
        if (needsRecompute) {
            await this.refreshDashboard();
        } else {
            this.lintPanel?.refreshDashboardPanel();
        }
    }

    /**
     * Open a chapter file and scroll the editor to a specific line.
     *
     * Used by the dashboard's clickable pacing flags to navigate the writer
     * to the flagged passage. Opens the file in the active leaf if it isn't
     * already visible.
     */
    async jumpToDashboardLine(filePath: string, line: number): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        let view = findEditorView(this.app, filePath);
        if (!view) {
            await this.app.workspace.openLinkText(filePath, '', false);
            view = findEditorView(this.app, filePath);
        }
        if (!view) return;

        const editorLine = Math.max(0, line - 1);
        view.editor.setCursor({ line: editorLine, ch: 0 });
        view.editor.scrollIntoView({ from: { line: editorLine, ch: 0 }, to: { line: editorLine, ch: 0 } }, true);
    }

    /**
     * Resolve the list of markdown files belonging to the active manuscript.
     *
     * Starts with the active file's folder (recursive if `includeSubfolders`),
     * applies chapter overrides from the manuscript sidecar file, and always
     * includes the active file.
     */
    private resolveManuscriptFiles(
        folder: string,
        activeFilePath: string,
        includeSubfolders: boolean,
        msFile: ManuscriptFileData
    ): TFile[] {
        const allMarkdown = this.app.vault.getMarkdownFiles();
        const addPaths = msFile.chapterOverrides.add.map(normalizePath);
        const removeSet = new Set(msFile.chapterOverrides.remove.map(normalizePath));

        const result: TFile[] = [];

        // Folder scan.
        const folderPrefix = folder.length > 0 ? folder + '/' : '';
        for (const file of allMarkdown) {
            if (removeSet.has(file.path)) continue;
            const inFolder = includeSubfolders
                ? file.path.startsWith(folderPrefix) || folder === ''
                : file.parent?.path === folder;
            if (inFolder) result.push(file);
        }

        // Add explicit overrides.
        for (const addPath of addPaths.map(normalizePath)) {
            if (removeSet.has(addPath)) continue;
            const file = this.app.vault.getAbstractFileByPath(addPath);
            if (file instanceof TFile && file.extension === 'md' && !result.includes(file)) {
                result.push(file);
            }
        }

        // Ensure the active file is always included.
        const activeFile = this.app.vault.getAbstractFileByPath(activeFilePath);
        if (activeFile instanceof TFile && !result.includes(activeFile)) {
            result.push(activeFile);
        }

        // Sort by path for stable ordering.
        result.sort((a, b) => a.path.localeCompare(b.path));
        return result;
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

        // Auto-initialize context so vault context and deterministic signal
        // are available even if the writer never visited the Context tab.
        await this.ensureContextInitialized();

        // Cancel any in-flight feedback request
        this.feedbackAbort?.abort();
        this.feedbackAbort = new AbortController();

        // Start loading state in the Review tab
        this.lintPanel?.reviewStartLoading('editorial', persona?.name ?? 'Custom');

        // Capture the controller for this specific request so we can guard its cleanup.
        const myFeedbackAbort = this.feedbackAbort;

        // The active document is always the primary manuscript. Additional
        // files from the manuscripts list are layered on top.
        const activeFile = this.app.workspace.getActiveFile();
        const activePath = activeFile && activeFile.extension === 'md' ? activeFile.path : null;
        const additionalPaths = this.lintPanel?.reviewContextFiles() ?? [];
        const manuscriptPaths =
            activePath && !additionalPaths.includes(activePath) ? [activePath, ...additionalPaths] : additionalPaths;

        if (manuscriptPaths.length === 0) {
            new Notice('Quill: Open a Markdown document to review.');
            this.lintPanel?.reviewError('No active document to review.');
            return;
        }

        // Get the active document text for embedding queries.
        const documentText = activeFile ? await this.getFileText(activeFile.path) : '';

        // Resolve any embed-prefixed paths in manuscriptPaths.
        const { regularPaths: resolvedPaths, messages: embedMessages } = await this.resolveEmbedPathsToMessages(
            manuscriptPaths,
            'Manuscript',
            documentText
        );

        // Resolve folder context items in the assembly (context panel flow).
        try {
            if (this.currentAssembly) {
                await this.resolveFolderContextItems(this.currentAssembly, documentText);
            }
        } catch {
            // Best-effort
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
        const fileMessages = await readVaultFiles(this.app.vault, resolvedPaths, 'Manuscript');
        const manuscriptMessages = [...embedMessages, ...fileMessages];

        if (manuscriptMessages.length === 0) {
            new Notice('Quill: Could not read any content from the selected manuscripts.');
            this.lintPanel?.reviewError('Could not read manuscript content.');
            return;
        }

        // Lore reference embeds (gated on reviewLoreContext) — prepended here so
        // the first editorial-review payload receives lore context immediately,
        // mirroring the follow-up chat flow.
        const loreReferenceMessages = await this.loreReferenceMessages(documentText);

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
            ...loreReferenceMessages,
            ...manuscriptMessages,
            this.feedbackCurrentMessages[1]! // user instruction
        ];

        if (__DEV__ && this.settings.enableDebugLogging) {
            console.warn('Quill: Feedback API payload', JSON.stringify(apiMessages, null, 2));
        }

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
        // Mirror requestFeedback: the active document is the primary manuscript,
        // with additional files layered on top — otherwise follow-up chats lose
        // the primary manuscript context.
        const activeFile = this.app.workspace.getActiveFile();
        const activePath = activeFile && activeFile.extension === 'md' ? activeFile.path : null;
        const additionalPaths = this.lintPanel?.reviewContextFiles() ?? [];
        const manuscriptPaths =
            activePath && !additionalPaths.includes(activePath) ? [activePath, ...additionalPaths] : additionalPaths;
        const chatContextFilePaths = this.lintPanel?.reviewChatContextFiles() ?? [];

        // Get the active document text for embedding queries.
        const documentText = activeFile ? await this.getFileText(activeFile.path) : '';

        // Resolve any embed-prefixed paths.
        const { regularPaths: resolvedManuscriptPaths, messages: manuscriptEmbedMessages } =
            await this.resolveEmbedPathsToMessages(manuscriptPaths, 'Manuscript', documentText);
        const { regularPaths: resolvedRefPaths, messages: refEmbedMessages } = await this.resolveEmbedPathsToMessages(
            [...this.loreReferencePaths(), ...chatContextFilePaths],
            'Reference file',
            documentText,
            this.settings.contextMaxCharsPerFile
        );

        // Resolve folder context items in the assembly (context panel flow).
        try {
            if (this.currentAssembly) {
                await this.resolveFolderContextItems(this.currentAssembly, documentText);
            }
        } catch {
            // Best-effort
        }

        const fileMessages = await readVaultFiles(this.app.vault, resolvedManuscriptPaths, 'Manuscript');
        const manuscriptMessages = [...manuscriptEmbedMessages, ...fileMessages];
        const refMessages = await readVaultFiles(
            this.app.vault,
            resolvedRefPaths,
            'Reference file',
            this.settings.contextMaxCharsPerFile
        );
        const referenceMessages = [...refEmbedMessages, ...refMessages];

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

        if (__DEV__ && this.settings.enableDebugLogging) {
            console.warn('Quill: Feedback Chat API payload', JSON.stringify(baseMessages, null, 2));
        }

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
