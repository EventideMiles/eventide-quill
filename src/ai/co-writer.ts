import { App, Editor, MarkdownView, Notice, Platform, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type EventideQuillPlugin from '../main';
import { notifyMobileStreamRisk } from './mobile-watchdog';
import { type VoiceProfile } from '../types';
import { findEditorView } from '../utils/find-editor';
import { type AiProvider, type ChatMessage } from './provider';
import type { TokenBreakdown } from '../ui/token-indicator';
import { buildRequestBreakdown } from '../ui/token-indicator';
import {
    getCoWriterDiscussPrompt,
    getCoWriterGenerationPrompt,
    getCoWriterCoachFollowUp,
    getCoWriterCoachPrompt,
    getCoWriterCoachRevision,
    getCoWriterCoachToOptions,
    getCoWriterOptionPrompt,
    getCoWriterVoicePrompt,
    getLoreCoachSystemPrompt,
    getLoreCoachUserPrompt,
    getResearchSystemPrompt,
    type ActiveSteering
} from './prompts';
import { compactConversation } from './compaction';
import {
    refineProposeEntryOutcome,
    refineLoreEditOutcome,
    refineStaleVaultLookups,
    refineForBudget
} from './context-refinement';
import { estimateTokens } from '../utils/tokens';
import { readVaultFiles, readVaultFileText } from '../utils/vault-files';
import { parseDirectives, parseAllDirectives } from '../utils/directives';
import { EmbeddingCache, rankBySimilarity } from './embedding-cache';
import { parseProviderKey } from './provider-registry';
import { parseEmbedFolderPath, loreFolderEmbedPaths } from '../utils/vault-files';
import { ChangeSet, type ChangeSetJSON, type ProposedEdit } from '../core/change-set';
import type { LoreEntryType, LoreDraftEntry, ProposedImage } from '../core/dashboard/lorebook-types';
import { stripGallerySections } from '../core/dashboard/lorebook-scanner';

/**
 * Strip gallery sections from injected top-K lore chunks (only — see callers
 * in resolveEmbedPathsToMessages). NOT used for active-file proseForContext
 * or vault_lookup output, because the model relies on those views being
 * verbatim to construct anchors for insert_note / edit_note. Stripping at
 * retrieval-time (top-K) is purely a token-budget measure on similarity-
 * matched chunks that the model is browsing, not editing against.
 */
import {
    attachLoreImageTool,
    createReadOnlyToolRegistry,
    createToolRegistry,
    executeToolCall,
    type ToolContext
} from './tools';
import {
    getImageRegime,
    injectImagesIntoMessages,
    prepareUserMessageWithImages,
    type PreparedUserMessage
} from './vision';
import { SubagentSession, type SubagentView, type SubagentConfig } from './subagent-session';
import { resolveNoteFile } from './tools/lore-edit-helpers';
import { CACHE_HIT_MARKER } from './tools/fandom-lookup';
import { tryNudgeTextToolLeak } from './tools';
import { buildInternalToolsMessage, buildNetworkToolsMessage } from './co-writer-tool-prompts';
import { streamToolAwareRound } from './co-writer-streaming';
import {
    sanitizeProse,
    summarizeToolArgs,
    parseStoppingPoint,
    respectsStoppingPoint,
    truncateToStoppingPoint,
    buildVaultContext,
    mergeContextPaths,
    stubDanglingToolCalls,
    editorCursorOffset,
    proseBeforeCursorOrDoc,
    moveCursorToEndIfEarly
} from './co-writer-utils';
import {
    applyApprovedEdit,
    clearDiffEdits,
    pushDiffEdits,
    syncChangeSetPositions,
    toDiffSnapshots
} from '../ui/change-diff-extension';

/**
 * Load additional context files from the vault and build system messages.
 * Best-effort: silently skips files that cannot be read.
 * @param plugin - The plugin instance (for vault access and settings).
 * @param contextFilePaths - Paths to context files to load.
 * @returns An array of ChatMessage system messages for the loaded files.
 */
/**
 * Resolve embed-prefixed paths to ChatMessages using the embedding cache.
 * Returns regular paths (unchanged) and resolved embed messages separately.
 */
async function resolveEmbedPathsToMessages(
    plugin: EventideQuillPlugin,
    paths: string[],
    label: string,
    documentText: string,
    maxChars?: number
): Promise<{ regularPaths: string[]; messages: ChatMessage[] }> {
    const regularPaths: string[] = [];
    const messages: ChatMessage[] = [];

    const embedProvider = plugin.getDefaultEmbedProvider();
    if (!embedProvider) {
        return { regularPaths: paths, messages };
    }

    const embedKey = parseProviderKey(plugin.settings.aiDefaultEmbedProvider);
    const embedModelId = embedKey?.modelId ?? '';

    for (const path of paths) {
        const parsed = parseEmbedFolderPath(path);
        if (!parsed) {
            regularPaths.push(path);
            continue;
        }

        try {
            const cache = await EmbeddingCache.load(plugin.app.vault, parsed.folderPath, embedModelId);
            const allEntries = cache.getAll();
            if (allEntries.length === 0) continue;

            let texts: string[];
            let topK = plugin.settings.embeddingsTopKChunks;
            if (parsed.mode === 'full') {
                // Full mode: include all chunk texts
                texts = allEntries.map((e) => e.chunkText ?? '');
            } else {
                // Top-K mode: retrieve most relevant chunks
                topK = plugin.settings.folderTopKOverrides[parsed.folderPath] ?? plugin.settings.embeddingsTopKChunks;
                const docResult = await embedProvider.embed({ input: documentText, model: embedModelId });
                const ranked = rankBySimilarity(allEntries, docResult.embeddings[0] ?? [], topK);
                texts = ranked.map((e) => e.chunkText ?? '');
            }

            const content = texts.join('\n\n');
            // Strip image-gallery sections at injection time — covers caches
            // built before the chunker learned to strip them. The marker
            // preserves "this entry has images" awareness and points the
            // model at get_lore_image.
            const { stripped: galleryStripped } = stripGallerySections(
                content,
                plugin.settings.loreEntryImageSectionHeaders
            );
            const charLimit = maxChars ?? 10000;
            const truncated =
                galleryStripped.length > charLimit ? galleryStripped.slice(0, charLimit) + '...' : galleryStripped;
            const displayK = parsed.mode === 'full' ? 'all chunks' : `top-${topK}`;
            messages.push({
                role: 'system',
                content: `${label} (${parsed.folderPath}, ${displayK}): ${truncated}`
            });
        } catch (err) {
            console.warn(`Quill: Failed to resolve embed path ${path}:`, err);
        }
    }

    return { regularPaths, messages };
}

export async function loadAdditionalContext(
    plugin: EventideQuillPlugin,
    contextFilePaths: string[],
    documentText?: string
): Promise<ChatMessage[]> {
    // Lore entries auto-inject as embed: sources when the toggle is on. They
    // ride the same top-K retrieval path as manual folder context, so no new
    // resolution logic is needed — only the path list is extended.
    const lorePaths = plugin.settings.coWriterLoreContext ? loreFolderEmbedPaths(plugin.settings.lorebookFolders) : [];
    const allPaths = [...lorePaths, ...contextFilePaths];
    if (!allPaths.length) return [];

    // Resolve embed-prefixed paths (embedded folders) before reading regular files.
    const { regularPaths, messages: embedMessages } = await resolveEmbedPathsToMessages(
        plugin,
        allPaths,
        'Reference file',
        documentText ?? '',
        plugin.settings.contextMaxCharsPerFile
    );

    const fileMessages = await readVaultFiles(
        plugin.app.vault,
        regularPaths,
        'Reference file',
        plugin.settings.contextMaxCharsPerFile
    );
    const messages = [...embedMessages, ...fileMessages];
    // Explicit "already in context" note — without it the model frequently
    // vault_lookup's these same files even though their full text is right above,
    // wasting a round and duplicating content. Listing the paths makes the
    // connection unmistakable.
    if (regularPaths.length > 0) {
        messages.push({
            role: 'system',
            content:
                'The reference files above are already in your context (full text, capped per file). ' +
                'Reuse their content directly rather than vault_lookup-ing or re-reading any of them:\n' +
                regularPaths.map((p) => `- ${p}`).join('\n')
        });
    }
    return messages;
}

/**
 * Load the active manuscript's linked plot map text, if any.
 * Returns empty string when no plot map is linked or it cannot be read.
 * Capped by the `contextMaxCharsPerFile` setting.
 */
async function loadPlotMapText(plugin: EventideQuillPlugin): Promise<string> {
    const plotMapPath = plugin.currentPlotMap;
    if (!plotMapPath) return '';
    const text = await readVaultFileText(plugin.app.vault, plotMapPath, plugin.settings.contextMaxCharsPerFile);
    // The user may have unlinked or swapped the plot map during the read.
    // Drop the result if the active link no longer matches the one we read so
    // stale text from the old note is never sent as AI context.
    if (plugin.currentPlotMap !== plotMapPath) return '';
    if (!text) {
        console.warn('Quill: Linked plot map note could not be read:', plotMapPath);
    }
    return text;
}

/** Build a plot map system message, or null when there is no plot map text. */
async function buildPlotMapMessage(plugin: EventideQuillPlugin): Promise<ChatMessage | null> {
    const text = await loadPlotMapText(plugin);
    if (!text) return null;
    return { role: 'system', content: `Plot map (reference):\n${text}` };
}

/**
 * Build a system message telling the model how many files it can safely
 * read + edit in the current round, based on the remaining context budget
 * and the per-round output token limit. This lets the model BATCH multiple
 * read→edit cycles per round instead of doing one file per round (which is
 * painfully slow on local models where each round = a full inference pass).
 *
 * Returns null when the budget is too small for batching to matter.
 */
function buildContextBudgetMessage(
    plugin: EventideQuillPlugin,
    messages: ChatMessage[],
    maxContextTokens: number
): ChatMessage | null {
    const used = estimateTokens(messages);
    const available = maxContextTokens - used;
    if (available <= 2000) return null;

    // Rough per-file costs:
    //   Input: vault_lookup result (~1500 tokens) + edit_note tool-result (~100) ≈ 2000
    //   Output: edit_note arguments (path + old_text + new_text) ≈ 600
    const perFileContextCost = 2000;
    const perFileOutputCost = 600;
    const maxOutput = plugin.settings.coWriterMaxOutputTokens;

    const contextBatch = Math.max(1, Math.floor(available / perFileContextCost));
    const outputBatch = Math.max(1, Math.floor(maxOutput / perFileOutputCost));
    const batchSize = Math.min(contextBatch, outputBatch);

    if (batchSize <= 1) return null;

    return {
        role: 'system',
        content:
            `Context budget: ${used.toLocaleString()}/${maxContextTokens.toLocaleString()} tokens used, ` +
            `${available.toLocaleString()} available. You can safely read and edit up to ${batchSize} ` +
            `file(s) in this round. Batch your tool calls — read and edit multiple files per response ` +
            `to minimize total rounds.`
    };
}

// Tool-guidance prompt builders (buildNetworkToolsMessage /
// buildInternalToolsMessage) live in `./co-writer-tool-prompts` — extracted
// from this monolith so prompt changes co-locate with the tool-discipline
// text and don't get lost in a 4.8k-line file.

/**
 * Build a system message informing the model which file the writer currently
 * has open. This lets the model distinguish between edits to the active file
 * (where Direct/Fulfill mode provides a streaming live-edit UX) and edits to
 * other notes (where the edit_note / insert_note / append_to_note tools are the right path).
 *
 * Returns null when no markdown file is active.
 */
function buildActiveFileMessage(plugin: EventideQuillPlugin): ChatMessage | null {
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') return null;
    return {
        role: 'system',
        content:
            `The writer currently has "${activeFile.path}" open in the editor.\n` +
            'For edits to THIS file, recommend the writer use Direct or Fulfill mode ' +
            '(which stream changes live into the editor). Use edit_note / insert_note / ' +
            'append_to_note tools for any OTHER note that is not currently open.\n' +
            'Extracted details from this file (characters, locations, etc.) are already in ' +
            'the "Vault context for reference" above — check there first and vault_lookup ' +
            'this file only if you need the full prose beyond those excerpts.'
    };
}

/**
 * Compute active inline-directive steering for the cursor position.
 * Returns one `inline`-source entry per directive in the contiguous trailing
 * run. Empty when directive processing is disabled or no directives are active.
 */
function inlineSteering(plugin: EventideQuillPlugin, textBeforeCursor: string): ActiveSteering[] {
    if (!plugin.settings.enableInlineDirectives) return [];
    return parseDirectives(textBeforeCursor).map((d) => ({ source: 'inline' as const, text: d }));
}

/** Build a system message describing active inline directives, or null when none are active.
 *  Used by the option-generation modes so option cards reflect directive intent. */
function buildDirectiveMessage(plugin: EventideQuillPlugin, textBeforeCursor: string): ChatMessage | null {
    const steering = inlineSteering(plugin, textBeforeCursor);
    if (steering.length === 0) return null;
    const body = steering.map((s) => `- ${s.text}`).join('\n');
    return {
        role: 'system',
        content: `Active inline directives at the cursor:\n${body}\nReflect this intent in your suggestions.`
    };
}

/** Current state of a co-writer drafting session. */
export type DraftState = 'idle' | 'generating' | 'draft';

/** Coach mode phase. */
export type CoachPhase = 'discern' | 'clarify' | 'plan' | 'direction';

/** Legal coach phase values — used to validate a {@link CoWriterChatMessage.phaseSnapshot}. */
const COACH_PHASES: ReadonlySet<string> = new Set(['discern', 'clarify', 'plan', 'direction']);

/** A coach session state. */
export interface CoachSession {
    /** Current phase of the coaching process. */
    phase: CoachPhase;
    /** The AI's analysis or response for the current phase. */
    response: string;
    /** Summary of the coaching for use in option generation. */
    summary: string;
    /** Whether this is the first turn (phase 1: discern intent). */
    isFirstTurn: boolean;
    /** How many rounds of clarifying questions have been asked (0-2, max 3 total). */
    clarifyRound: number;
}

/**
 * Lorebook coach phase — a simpler state machine than the prose coach because
 * the conversation drives the flow. The phase is mostly a UI indicator; the
 * model decides when to ask questions vs. emit a draft.
 *
 *  - `discover` — first turn; the user names what they want to develop.
 *  - `develop` — interactive Q&A; the model uses tools and asks probing questions.
 *  - `refine`  — a draft has been produced; subsequent turns refine it.
 */
export type LoreCoachPhase = 'discover' | 'develop' | 'refine';

/** Legal lorebook phase values — used to validate a {@link CoWriterChatMessage.phaseSnapshot}. */
const LORE_PHASES: ReadonlySet<string> = new Set(['discover', 'develop', 'refine']);

/** A lorebook coach session. */
export interface LoreCoachSession {
    /** Current phase — drives the bottom-bar indicator. */
    phase: LoreCoachPhase;
    /** What the user is working on (the initial scope message). Free-form. */
    scope: string;
    /** Detected/declared entry type, populated when the first draft is produced. */
    entryType: LoreEntryType | null;
    /** Turn counter; bounds the conversation against runaway loops. */
    rounds: number;
}

// Re-export LoreDraftEntry from its canonical home in lorebook-types so
// existing call sites (panel, review UI, main.ts) keep importing from here
// without churn. New code should import from '../core/dashboard/lorebook-types'.
export type { LoreDraftEntry, ProposedImage } from '../core/dashboard/lorebook-types';

/** A single continuation option suggested by the AI. */
export interface CoWriterOption {
    label: string;
    description: string;
}

/** A chat message displayed in the co-writer panel. */
export interface CoWriterChatMessage {
    /**
     * Stable per-session id (e.g. `msg_7`). Reviewable artifacts spawned during
     * this turn — subagent cards, pending lore edits, proposed lore images —
     * anchor to the message via this id so they render inline in the
     * conversation flow at the turn that produced them, instead of stacking at
     * the bottom. Minted by {@link CoWriterSession.pushChatMessage}.
     */
    id: string;
    role: 'user' | 'assistant';
    content: string;
    options?: CoWriterOption[];
    /** AI reasoning/thought content, if any, for this message. */
    thought?: string;
    /** Whether to show an accept button below this message for plan revision. */
    showAccept?: boolean;
    /** Lore draft attached to this message (lorebook coach mode only). */
    loreDraft?: LoreDraftEntry;
    /**
     * Tools the model called during this turn, shown as muted indicators
     * within the assistant bubble (below the response text). Empty for turns
     * where the model didn't call any tools. Stored as an array on the
     * message rather than as separate chat entries so they don't interfere
     * with the panel's streaming-placeholder logic.
     */
    toolUses?: { name: string; argsSummary: string; error?: string; cached?: boolean }[];
    /**
     * Ids of subagents spawned by this turn's tool round
     * ({@link SubagentSession.id}). The panel looks each up in its subagent
     * list to render the status card inline beneath this bubble. Empty/undefined
     * for turns that didn't spawn a subagent.
     */
    subagentIds?: string[];
    /**
     * Base64 JPEG thumbnails (no `data:` prefix) the writer pasted/dropped/
     * attached with this user message. Only set on user messages; rendered as
     * a thumbnail strip beneath the bubble text so the writer sees what they
     * sent. The regime-A/ regime-B routing decision happens in
     * {@link prepareUserMessageWithImages} before the message reaches the API.
     */
    images?: string[];
    /**
     * @-mentioned file paths the writer attached to this user message (discuss
     * / coach modes only). Captured on the message so a regenerate of the
     * response can re-send the same additional context via mergeContextPaths
     * instead of dropping it. Lorebook mode doesn't accept mentions, so this
     * stays undefined there.
     */
    mentionPaths?: string[];
    /**
     * Snapshot of the mode-session phase AFTER this assistant turn settled
     * (coach / lorebook modes only). Used by `rewindToMessage` to restore the
     * exact phase without re-deriving it via heuristic — the live phase
     * advance is authoritative, the heuristic is a fallback for pre-snapshot
     * sidecars. Undefined on user messages, discuss turns (no phase machine),
     * and any sidecar written before this field landed. See
     * {@link reevaluateModePhase}.
     */
    phaseSnapshot?: CoachPhase | LoreCoachPhase;
}

/**
 * Pending lore-edits entry for one file. `anchorMessageId` is the
 * {@link CoWriterChatMessage.id} of the assistant turn that most recently
 * added/modified an edit for this file; the panel renders the card inline
 * beneath that bubble. Re-anchored on each touch (latest semantics).
 */
export interface LoreEditEntry {
    changeSet: ChangeSet;
    fileBasename: string;
    anchorMessageId: string | null;
}

/**
 * Pending lore-image-attachment entry for one file. `anchorMessageId` places
 * the review card inline at the turn that attached the images.
 */
export interface ProposedLoreImageEntry {
    fileBasename: string;
    images: ProposedImage[];
    anchorMessageId: string | null;
}

/**
 * Serialized form of a co-writer session for persistence
 * (see `conversation-store.ts`). Every field is plain JSON-roundtrippable data:
 * {@link ChangeSet} via {@link ChangeSet.toJSON}, subagents as flat
 * {@link SubagentView}s (dormant on restore — their `running` status is forced
 * to `interrupted`). Ephemeral runtime concerns (AbortController, callbacks,
 * editor locks) are intentionally absent and rebind on restore.
 */
export interface SerializedCoWriterState {
    /** Co-writer mode active at snapshot time (`InputMode` as a plain string). */
    mode: string;
    /**
     * For `'review-discuss'` mode: which review engine produced the report
     * this session is following up on. `null` for all other modes (and for
     * review-discuss sessions prior to the field's introduction). Optional on
     * the wire so older sidecars still pass {@link isValidState}.
     */
    reviewEngine?: 'editorial' | 'critical' | 'manuscript' | null;
    chatHistory: CoWriterChatMessage[];
    discussCurrentMessages: ChatMessage[];
    loreCoachMessages: ChatMessage[];
    manuscriptPath: string | null;
    voiceProfile: VoiceProfile | null;
    contextFilePaths: string[];
    recentImages: string[];
    fulfillChanges: ChangeSetJSON;
    directChanges: ChangeSetJSON;
    loreEdits: [string, { changeSet: ChangeSetJSON; fileBasename: string; anchorMessageId: string | null }][];
    proposedLoreImages: [string, { fileBasename: string; images: ProposedImage[]; anchorMessageId: string | null }][];
    subagents: SubagentView[];
    activeSubagentId: string | null;
    coachSession: CoachSession | null;
    coachActive: boolean;
    loreCoachSession: LoreCoachSession | null;
    loreCoachActive: boolean;
    currentLoreDraft: LoreDraftEntry | null;
    currentOptions: CoWriterOption[];
}

/**
 * Manages a co-writer session with a chat-like interface.
 * The writer sends a direction → AI suggests 3 options → writer picks one
 * → full continuation streams into the editor with accept/revert.
 */
export class CoWriterSession {
    /** Path of the manuscript being worked on. */
    manuscriptPath: string | null = null;
    /**
     * For `'review-discuss'` mode: which review engine produced the report
     * this session is following up on. Carries into the saved-session label
     * so the writer can identify the chat in the History modal. `null` in
     * every other mode.
     */
    reviewEngine: 'editorial' | 'critical' | 'manuscript' | null = null;
    /** Full document text at the time an option was applied. */
    originalText = '';
    /** Offset in the document where the AI's insertion begins. */
    insertionStart = -1;
    /** Length of the AI's insertion in characters. */
    insertionLength = 0;
    /** Current draft state for the inserted text. */
    draftState: DraftState = 'idle';

    /** Cached voice profile for the current manuscript session. */
    voiceProfile: VoiceProfile | null = null;
    /** Path of the document the voice profile was extracted from. */
    private voiceProfileFile: string | null = null;

    /** Additional context files added by the user. */
    private contextFilePaths: string[] = [];

    /** Abort controller for the current API call (options or generation). */
    private abortController: AbortController | null = null;

    /**
     * True when an API call (options fetch or generation) is in flight. Read by
     * the plugin's mobile stream watchdog to detect when Obsidian's WebView was
     * suspended mid-run (see {@link MobileStreamWatchdog}).
     */
    get isGenerating(): boolean {
        return this.abortController !== null;
    }

    /** Pending thought content accumulated during generation. */
    thoughtBuffer = '';

    /** Chat message history for the panel display. */
    chatHistory: CoWriterChatMessage[] = [];

    /**
     * Monotonic counter for {@link CoWriterChatMessage.id} within this session.
     * Ids only need to be unique within a session (artifacts anchor to messages
     * by id), so this counter is not persisted — it restarts at 0 on load and
     * any restored messages keep their original ids (which remain unique by
     * construction within the restored set).
     */
    private nextMessageId = 0;

    /**
     * Push a display chat message with a freshly minted stable id. Use this
     * instead of `chatHistory.push(...)` so every message is guaranteed an id
     * that reviewable artifacts (subagent cards, lore edits, lore images) can
     * anchor to. Callers pass the message without an id; it is stamped here.
     */
    private pushChatMessage(msg: Omit<CoWriterChatMessage, 'id'>): void {
        this.chatHistory.push({ ...msg, id: `msg_${++this.nextMessageId}` });
    }

    /**
     * Id of the last message in {@link chatHistory}, or null if empty. Pending
     * lore edits and proposed lore images produced during the current tool round
     * stamp this as their anchor so they render beneath the assistant turn that
     * produced them. Called from tool execution, where the last entry is the
     * in-flight assistant message of this turn.
     */
    currentAnchorMessageId(): string | null {
        const last = this.chatHistory[this.chatHistory.length - 1];
        return last ? last.id : null;
    }

    /**
     * Record that `subagentId` was spawned by the current (last) assistant turn,
     * so its status card renders beneath that bubble. Called at subagent spawn,
     * which always happens during the calling turn's tool round (the last
     * chatHistory entry is that turn's assistant message).
     */
    private attachSubagentToLastMessage(subagentId: string): void {
        const last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.subagentIds = [...(last.subagentIds ?? []), subagentId];
        }
    }

    /**
     * Subagent batch editors spawned via `run_lorebook_batch`, keyed by id.
     * Each runs in its own fresh context (isolated from this conversation) but
     * shares the {@link loreEdits} review queue via the tools' side effects.
     * The stage-2 drill-down UI renders {@link SubagentSession.chatHistory} +
     * {@link SubagentSession.status} from here. Plain serializable state so the
     * deferred conversation-persistence feature can layer on later.
     */
    subagents = new Map<string, SubagentSession>();
    /**
     * Dormant subagent views restored from a saved session (no live
     * {@link SubagentSession} instance behind them). Merged into
     * {@link getSubagentViews} so they render + drill down read-only; their
     * `running` status was forced to `interrupted` at restore time. Cleared on
     * new-chat / mode-switch like the live map.
     */
    restoredSubagentViews: SubagentView[] = [];
    /** Active subagent id for the drill-down view (stage 2); null = parent view. */
    activeSubagentId: string | null = null;

    /**
     * API-level conversation history for the discuss mode.
     * Contains system prompt, context heads (from compaction), and chat turns.
     * Injected context (vault + additional files) is built fresh on each call
     * and never stored here, so it always survives compaction.
     */
    discussCurrentMessages: ChatMessage[] = [];

    /** The 3 current continuation options awaiting the writer's choice. */
    currentOptions: CoWriterOption[] = [];

    /** Whether the AI is currently generating options. */
    optionsLoading = false;

    /** App reference for editor locking. */
    private app: App | null = null;

    // --- Callbacks ---

    onThought: ((thought: string) => void) | null = null;
    onChatUpdate: (() => void) | null = null;
    onOptionsLoading: ((loading: boolean) => void) | null = null;
    /**
     * Fired when the Regime B proxy caption call starts/ends so the panel can
     * show a "Describing image…" state during the round-trip. Only fires under
     * the proxy regime (text-only chat + separate image model configured).
     */
    onDescribingImages: ((active: boolean) => void) | null = null;
    /** Called after a draft is accepted, to trigger fresh options. */
    onDraftAccepted: (() => void) | null = null;
    /** Called when the discuss-mode token estimate changes (conversation tokens only;
     * the panel adds vault context item tokens on top to compute the total). */
    onTokenEstimate: ((breakdown: TokenBreakdown, maxTokens: number) => void) | null = null;
    /**
     * Fixed per-request token overhead of the active mode's tool definitions
     * (the serialized `tools` field). Set when a mode builds its registry so
     * {@link estimateRequestTokens} can fold it into budget math; 0 when no
     * tools are registered.
     */
    private toolTokenOverhead = 0;
    /** Called when a discuss response starts streaming. */
    onDiscussStartStreaming: (() => void) | null = null;
    /** Called when a discuss response chunk arrives during streaming. */
    onDiscussChunk: ((text: string) => void) | null = null;
    /**
     * Called to clear the streaming text display (discard draft text the
     * model emitted before its reasoning block). Used by the Lorebook Coach
     * to prevent duplicated response content around `<think>` tags.
     */
    onDiscussClear: (() => void) | null = null;
    /** Called when the discuss response is complete (triggers markdown render). */
    onDiscussFinished: (() => void) | null = null;
    /** Called when the discuss response encounters an error. */
    onDiscussError: ((message: string) => void) | null = null;
    /** Called when the coach mode reaches the direction phase, to auto-generate options. */
    onCoachDirectionReady: (() => void) | null = null;
    /** Current coach session, if coach mode is active. */
    coachSession: CoachSession | null = null;
    /** Whether coach mode is currently active. */
    coachActive = false;
    /** Whether option cards have been auto-generated for the current coach session. */
    private coachOptionsGenerated = false;

    // ── Lorebook coach state ────────────────────────────────────────────────
    /** Current lorebook coach session, if lorebook coach mode is active. */
    loreCoachSession: LoreCoachSession | null = null;
    /** Whether lorebook coach mode is currently active. */
    loreCoachActive = false;
    /**
     * API-level conversation history for the lorebook coach. Kept separate
     * from {@link discussCurrentMessages} so the two modes don't cross-pollute
     * (system prompts, tool result messages, and phase instructions differ).
     */
    loreCoachMessages: ChatMessage[] = [];
    /** The most recent lore draft produced this session, awaiting review. */
    currentLoreDraft: LoreDraftEntry | null = null;
    /**
     * Ring buffer of recent images the model has seen — from tool results
     * that carried `images` (fandom_image, wikipedia_image, fetch_image_url,
     * get_lore_image) or from user-pasted chat images. The model can't
     * quote bytes it has already seen back into a tool call (they enter the
     * conversation as image content blocks under Regime A, or as proxy
     * captions under Regime B — never as a base64 string), so
     * `propose_entry` and `attach_lore_image` accept a `from_recent`
     * reference (index into this buffer) as the alternative to passing
     * `base64` directly.
     *
     * FIFO with most-recent first; index 0 is always the last image the
     * model saw. Capped to bound memory — each downscaled JPEG is ~50KB,
     * so 12 images ≈ 600KB peak.
     */
    recentImages: string[] = [];
    private static readonly RECENT_IMAGES_CAP = 12;
    /** Called when lorebook coach state changes (phase advance, end coach). */
    onLoreCoachUpdate: (() => void) | null = null;
    /** Called when a new lore draft is ready for the review card. */
    onLoreDraftReady: (() => void) | null = null;

    /**
     * Pending note edits keyed by vault path (from edit_note / insert_note /
     * append_to_note tools). `anchorMessageId` ties the file's review card to
     * the assistant turn that most recently touched it (latest-touch) so the
     * card renders inline beneath that bubble instead of at the panel bottom.
     */
    loreEdits: Map<string, LoreEditEntry> = new Map();
    /**
     * Pending image attachments keyed by vault path (from the
     * `attach_lore_image` tool). Path B of the lore-entry-images feature:
     * the agent attaches images to EXISTING entries (vs. Path A's
     * `propose_entry` images, which travel with a new-entry draft). Each
     * file's images are reviewed individually; on approval the bytes are
     * written to the attachments folder and the `![[file]]` embed is
     * inserted into the entry's gallery section. `anchorMessageId` places the
     * card inline at the turn that produced it (latest-touch on each add).
     */
    proposedLoreImages: Map<string, ProposedLoreImageEntry> = new Map();
    /**
     * Files that the tool opened in a new tab (not previously open). These
     * tabs are closed when the edit is approved or rejected so multi-file
     * edits don't leave a trail of tabs behind. Files the writer already had
     * open are NOT tracked here — their tabs are left alone.
     */
    loreEditOpenedByTool: Set<string> = new Set();
    /**
     * Per-file promise chain serializing closed-file lore-edit writes. A second
     * approval (same edit double-clicked, or a sibling edit) arriving while a
     * `vault.process` write is in flight would otherwise race: offsets aren't
     * remapped until the write's `.then()` runs `ChangeSet.approve`, so a
     * concurrent write could double-apply an edit or land at stale offsets.
     * Chaining ensures each write observes the post-approve remap of the prior.
     */
    private loreEditWriteQueue: Map<string, Promise<void>> = new Map();
    /** Called when a lore edit is proposed, approved, or rejected. */
    onLoreEditUpdate: (() => void) | null = null;
    /** Called when proposed lore images are added, approved, or rejected. */
    onProposedLoreImagesUpdate: (() => void) | null = null;

    /** Fulfill-mode proposed edits (one per directive), in document order. */
    fulfillChanges: ChangeSet = new ChangeSet();
    /** Direct-mode proposed continuation (pure insertion at the cursor), awaiting review. */
    directChanges: ChangeSet = new ChangeSet();
    /** Whether a Fulfill sweep is currently in progress. */
    fulfillActive = false;
    /** Called whenever Fulfill edits change (generation progress, approval, rejection). */
    onFulfillUpdate: (() => void) | null = null;
    /** Called whenever the Direct continuation changes (streaming progress, approval, rejection).
     *  Pushes the current directChanges edits to the panel for in-chat review. */
    onDirectChangeUpdate: (() => void) | null = null;

    /**
     * Analyze the voice of a prose passage using the AI provider.
     * Returns a structured VoiceProfile or null on failure.
     */
    async analyzeVoice(provider: AiProvider, modelId: string | undefined, prose: string): Promise<VoiceProfile | null> {
        const messages: ChatMessage[] = [{ role: 'user', content: getCoWriterVoicePrompt(prose) }];

        let fullResponse = '';
        try {
            const stream = provider.chatCompletion({
                messages,
                model: modelId,
                temperature: 0.3,
                maxTokens: 512
            });

            for await (const chunk of stream) {
                if (chunk.done) break;
                fullResponse += chunk.text;
            }
        } catch {
            return null;
        }

        const trimmed = fullResponse.trim();
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        try {
            const parsed = JSON.parse(jsonMatch[0]) as Partial<VoiceProfile>;
            if (
                typeof parsed.sentenceLengthDistribution !== 'string' ||
                typeof parsed.dialogueRatio !== 'number' ||
                typeof parsed.vocabularyRegister !== 'string' ||
                !Array.isArray(parsed.keyPatterns)
            ) {
                return null;
            }
            return parsed as VoiceProfile;
        } catch {
            return null;
        }
    }

    /**
     * Phase 1: Generate 3 continuation options from the writer's direction.
     * The options are stored in `currentOptions` and the chat history is updated.
     */
    async generateOptions(plugin: EventideQuillPlugin, direction: string): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        // Cancel any in-flight API call
        this.cancelGeneration();
        this.app = plugin.app;

        // Use the active file if available; fall back to stored manuscriptPath
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: Open a manuscript to use the co-writer.');
            return;
        }
        this.manuscriptPath = filePath;

        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
            new Notice('Quill: Open a manuscript editor to use the co-writer.');
            return;
        }
        const editor = markdownView.editor;

        // Populate context engine so the context tab shows data before the API call
        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.manuscriptPath = filePath;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        this.onChatUpdate?.();
        this.lockEditor();

        // Respect the writer's cursor position whether or not a direction was
        // given — only fall back to end-of-document when the cursor is at
        // position 0 (document opened but never clicked into). Previously the
        // empty-direction "initialize" path moved the cursor to end
        // unconditionally, which hijacked a deliberately placed cursor when the
        // writer clicked "Generate options" mid-manususcript. Scroll to the new
        // position only when we actually moved it (so a respected cursor
        // doesn't yank the writer's view away from where they clicked).
        const cursorWasAtZero = moveCursorToEndIfEarly(editor);
        const fullText = editor.getValue();
        if (cursorWasAtZero) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
        }
        const proseForOptions = proseBeforeCursorOrDoc(editor, 4000);

        // Add user's message to chat history
        this.pushChatMessage({
            role: 'user',
            content: direction || 'Continue the passage naturally from the cursor position.'
        });

        // Build context — vault + additional files
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';

        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        const optionsPlotMap = await buildPlotMapMessage(plugin);
        const optionsDirective = buildDirectiveMessage(plugin, proseForOptions);

        const prompt = getCoWriterOptionPrompt(proseForOptions || '(empty document)', direction);
        const messages: ChatMessage[] = [];
        if (vaultContext) {
            messages.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        if (optionsPlotMap) {
            messages.push(optionsPlotMap);
        }
        if (optionsDirective) {
            messages.push(optionsDirective);
        }
        messages.push(...additionalContextMessages, ...this.discussContextMessages(), {
            role: 'user',
            content: prompt
        });

        if (__DEV__ && plugin.settings.enableDebugLogging) {
            console.warn('[Quill Co-writer] Option generation context', {
                manuscriptExcerptChars: proseForOptions.length,
                vaultContextChars: vaultContext.length,
                vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
                additionalFiles: this.contextFilePaths
            });
        }

        let thought = '';

        try {
            this.abortController = new AbortController();
            const stream = chat.provider.chatCompletion({
                messages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: 1024,
                signal: this.abortController.signal
            });

            let response = '';
            for await (const chunk of stream) {
                if (chunk.done) break;
                response += chunk.text;
                if (chunk.thought) {
                    thought += chunk.thought;
                    this.thoughtBuffer = thought;
                    this.onThought?.(thought);
                }
            }

            const parsed = this.parseOptionsResponse(response);
            if (parsed && parsed.length === 3) {
                this.currentOptions = parsed;
            } else {
                // Fallback: create generic options
                this.currentOptions = [
                    {
                        label: 'Continue naturally',
                        description:
                            'Extend the scene forward in the established voice and pacing, advancing action and sensory detail.'
                    },
                    {
                        label: 'Shift focus',
                        description:
                            'Shift the focus to a different sensory dimension — interior thought, environmental detail, or dialogue — while advancing the scene.'
                    },
                    {
                        label: 'Raise tension',
                        description:
                            'Introduce a subtle tension or complication. An unanswered question, an uneasy observation, or a character moment that hints at conflict ahead.'
                    }
                ];
            }

            this.pushChatMessage({
                role: 'assistant',
                content: 'Here are three possible directions:',
                options: this.currentOptions,
                thought: thought || undefined
            });

            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.unlockEditor();
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
                return;
            }
            new Notice(`Quill: Failed to generate options — ${err instanceof Error ? err.message : String(err)}`);
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /**
     * Parse the AI's response into an array of CoWriterOption.
     * Expects a JSON array of { label, description } objects.
     * @param response - The raw model response.
     * @param expectedCount - Required array length. Defaults to 3 (Direct mode);
     *   Coach mode passes 1 since the coaching session already established intent.
     */
    private parseOptionsResponse(response: string, expectedCount = 3): CoWriterOption[] | null {
        const trimmed = response.trim();
        const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return null;

        try {
            const parsed = JSON.parse(jsonMatch[0]) as unknown[];
            if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;

            return parsed.map((item) => {
                const obj = item as Record<string, unknown>;
                return {
                    label: typeof obj.label === 'string' ? obj.label : 'Option',
                    description: typeof obj.description === 'string' ? obj.description : ''
                };
            });
        } catch {
            return null;
        }
    }

    // ── Shared tool-calling helpers (used by discuss, coach, and lorebook) ────
    // streamToolAwareRound lives in `./co-writer-streaming` (extracted so all
    // three modes share one implementation instead of lorebook inlining a
    // duplicate). Callers pass callbacks that update session state.

    /**
     * Conversation token estimate including the active mode's fixed
     * tool-definition overhead ({@link toolTokenOverhead}). Use this anywhere
     * a token estimate drives the panel indicator or a compaction decision so
     * the serialized `tools` field is counted. For raw text that is NOT part
     * of the per-request message set (e.g. measuring injected context on its
     * own), use {@link estimateTokens} directly.
     */
    private estimateRequestTokens(messages: ChatMessage[]): number {
        return this.estimateRequestBreakdown(messages).total;
    }

    /**
     * Per-section breakdown of what's consuming the request's tokens — tool
     * definitions, system prompt, each injected-context source, chat history.
     * Used by the token indicator's hover tooltip so writers can see exactly
     * where the budget is going (the typical surprise is that tool definitions
     * are the largest single chunk). Sibling of {@link estimateRequestTokens}.
     */
    private estimateRequestBreakdown(messages: ChatMessage[]): TokenBreakdown {
        return buildRequestBreakdown(messages, this.toolTokenOverhead);
    }

    /**
     * Annotate the last assistant message's toolUses with error info for
     * failed tool calls, so the panel can render them red and show the
     * reason on hover / right-click copy. Called after the execution loop
     * in each mode.
     */
    private annotateToolUseErrors(results: { failed: boolean; result: string }[]): void {
        const lastMsg = this.chatHistory[this.chatHistory.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.toolUses) return;
        lastMsg.toolUses = lastMsg.toolUses.map((use, i) => {
            const execResult = results[i];
            if (!execResult) return use;
            if (execResult.failed) {
                return { ...use, error: execResult.result };
            }
            // Cache-hit marker — fandom_* cache-first results embed it (see CACHE_HIT_MARKER).
            if (execResult.result.includes(CACHE_HIT_MARKER)) {
                return { ...use, cached: true };
            }
            return use;
        });
    }

    /**
     * Send a discussion message to the AI.
     * Unlike generateOptions, this does not produce continuation options —
     * it returns a normal chat response for brainstorming and discussion.
     *
     * Conversation history tracking:
     *  - `discussCurrentMessages` stores API-level messages (system prompt,
     *    context heads from compaction, and chat turns).
     *  - Injected context (vault + additional files) is built fresh on every
     *    call and never stored in `discussCurrentMessages`, so it always
     *    survives compaction and never double-counts in token estimates.
     *
     * Compaction strategy (rolling context head):
     *  - When the token budget (conversation + files + new message) meets or
     *    exceeds the compaction threshold, the older portion of the
     *    conversation is summarized by the AI into a single context head.
     *  - The new user message is always preserved below the context head.
     */
    async sendDiscussion(
        plugin: EventideQuillPlugin,
        message: string,
        images?: string[],
        mentionPaths?: string[]
    ): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        plugin.warnIfQueueRunning();
        notifyMobileStreamRisk();

        // Use the active file if available; fall back to stored manuscriptPath.
        // Discuss mode works without an active file — the model can gather
        // context via tools (manuscript_mentions, vault_lookup, etc.) instead
        // of from the active document's prose.
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (filePath) this.manuscriptPath = filePath;

        const markdownView = filePath ? findEditorView(plugin.app, filePath) : null;
        const editor = markdownView?.editor ?? null;

        // Populate context engine so the context tab shows data (only when we have an editor).
        if (editor && filePath && !plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        // Create the abort controller early so the image-prep step (Regime B
        // proxy caption call) and compaction can both be cancelled via Stop,
        // not just the streaming loop below.
        this.abortController = new AbortController();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        if (editor) this.lockEditor();

        // Add user's message to display-only chat history
        this.pushChatMessage({
            role: 'user',
            content: message,
            ...(images && images.length > 0 ? { images } : {}),
            ...(mentionPaths && mentionPaths.length > 0 ? { mentionPaths } : {})
        });

        const fullText = editor?.getValue() ?? '';
        const proseForContext = editor ? proseBeforeCursorOrDoc(editor, 4000) : '';

        // Build injected context — vault + additional files.
        // Injected fresh every call; never stored in discussCurrentMessages.
        const injectedContext: ChatMessage[] = [];
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';
        if (vaultContext) {
            injectedContext.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        const additionalContextMessages = await loadAdditionalContext(
            plugin,
            mergeContextPaths(this.contextFilePaths, mentionPaths),
            fullText
        );
        injectedContext.push(...additionalContextMessages);
        const discussPlotMap = await buildPlotMapMessage(plugin);
        if (discussPlotMap) {
            injectedContext.push(discussPlotMap);
        }
        const discussDirective = buildDirectiveMessage(plugin, proseForContext);
        if (discussDirective) {
            injectedContext.push(discussDirective);
        }
        const activeFileMsg = buildActiveFileMessage(plugin);
        if (activeFileMsg) {
            injectedContext.push(activeFileMsg);
        }
        const discussNetworkMsg = buildNetworkToolsMessage(plugin);
        if (discussNetworkMsg) {
            injectedContext.push(discussNetworkMsg);
        }
        const discussInternalMsg = buildInternalToolsMessage(plugin);
        if (discussInternalMsg) {
            injectedContext.push(discussInternalMsg);
        }

        const prompt = getCoWriterDiscussPrompt(proseForContext || '(empty document)', message);

        // Initialize discussCurrentMessages on first call: system prompt + first user message
        if (this.discussCurrentMessages.length === 0) {
            const systemPrompt: ChatMessage = {
                role: 'system',
                content:
                    'You are a thoughtful, knowledgeable editor assisting a novelist in a discussion about their work. Respond with specific, craft-focused observations. Ask clarifying questions when helpful. Keep to analysis and discussion, generating prose only when the writer explicitly asks for it.'
            };
            this.discussCurrentMessages = [systemPrompt];
        }

        // Build the tool registry up front so its fixed per-request overhead
        // (the serialized `tools` field) is known before the budget math below.
        const registry = createToolRegistry(plugin, false, true);
        const toolDefs = registry?.toToolDefinitions();
        this.toolTokenOverhead = registry?.estimateTokens() ?? 0;

        const injectedTokens = estimateTokens(injectedContext);
        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;

        // Compute total tokens INCLUDING the new message to decide whether to compact
        const hypotheticalConversation = [...this.discussCurrentMessages, { role: 'user' as const, content: prompt }];
        const conversationTokens = this.estimateRequestTokens(hypotheticalConversation);
        const totalTokens = conversationTokens + injectedTokens;

        // Push conversation-only token estimate to the panel.
        // The panel adds vault context item tokens on top to get the total.
        this.onTokenEstimate?.(this.estimateRequestBreakdown(hypotheticalConversation), maxTokens);

        // --- Compaction: refine first (deterministic, free), then AI-summarize if still over ---
        let needsCompaction = totalTokens / maxTokens >= compactPct;
        if (needsCompaction) {
            // Compress bulky/stale tool content before falling back to AI
            // summarization. Target the threshold minus the non-message token
            // volume (injected context + this pending user message). Re-measure
            // afterward — it may free enough to skip the AI call entirely.
            this.refineForBudgetIfEnabled(
                plugin,
                this.discussCurrentMessages,
                Math.max(0, Math.ceil(compactPct * maxTokens) - injectedTokens - Math.ceil(prompt.length / 4))
            );
            const refinedTokens =
                this.estimateRequestTokens([
                    ...this.discussCurrentMessages,
                    { role: 'user' as const, content: prompt }
                ]) + injectedTokens;
            if (refinedTokens / maxTokens <= compactPct) {
                needsCompaction = false;
                this.onTokenEstimate?.(
                    this.estimateRequestBreakdown([
                        ...this.discussCurrentMessages,
                        { role: 'user' as const, content: prompt }
                    ]),
                    maxTokens
                );
            }
        }
        if (needsCompaction) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.discussCurrentMessages, sentenceCount, {
                    signal: this.abortController?.signal
                });
                if (result) {
                    this.discussCurrentMessages = result.messages;
                    this.onTokenEstimate?.(
                        this.estimateRequestBreakdown([
                            ...this.discussCurrentMessages,
                            { role: 'user' as const, content: prompt }
                        ]),
                        maxTokens
                    );
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') {
                    this.unlockEditor();
                    this.optionsLoading = false;
                    this.onOptionsLoading?.(false);
                    return;
                }
                console.warn('Quill: Discuss compaction summarization failed, continuing without compaction.', err);
            }
        }

        // Append the user message after compaction so it's always below any new context head.
        // Apply the two vision regimes to the writer's pasted/attached images: under Regime A
        // the images attach to this user message; under Regime B the proxy caption is folded
        // into the text; under unsupported a placeholder note is appended.
        const prepared = await this.prepareImageMessage(plugin, prompt, images, this.abortController?.signal);
        // Guard against an abort race: cancelGeneration may have cleared
        // this.abortController during the Regime B proxy-caption await.
        if (!this.abortController || this.abortController.signal.aborted) {
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            return;
        }
        this.discussCurrentMessages.push({
            role: 'user',
            content: prepared.content,
            ...(prepared.images ? { images: prepared.images } : {}),
            quillAnchorId: this.currentAnchorMessageId() ?? undefined
        });

        if (__DEV__ && plugin.settings.enableDebugLogging) {
            console.warn('[Quill Co-writer] Discuss context', {
                manuscriptExcerptChars: proseForContext.length,
                vaultContextChars: vaultContext.length,
                vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
                additionalFiles: this.contextFilePaths,
                discussCurrentMessages: this.discussCurrentMessages.length,
                totalTokens,
                maxTokens
            });
        }

        // Tool setup: when enabled, the model can call internal tools
        // (manuscript_mentions, lore_siblings, vault_lookup) to look up
        // details mid-conversation. Each tool call produces a visible
        // round in the chat and consumes a model turn. The registry is built
        // above (before the budget math) so its `tools`-field overhead is
        // counted in toolTokenOverhead.
        const ctx: ToolContext = {
            plugin,
            // Live snapshot: sizing tools read this at execution time so their
            // "will it fit" math accounts for the conversation already in context.
            // Mirror the per-round prefix actually sent to the model — system +
            // injected vault/additional-file/plot-map context + the per-round
            // budget message + the conversation — not just the conversation
            // skeleton in discussCurrentMessages, otherwise measure_folder and
            // calculate_file_sizes overestimate the remaining window.
            consumedTokens: () => {
                const budgetMsg = buildContextBudgetMessage(plugin, this.discussCurrentMessages, maxTokens);
                const roundBase: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...(budgetMsg ? [budgetMsg] : []),
                    ...this.discussCurrentMessages.slice(1)
                ];
                return this.estimateRequestTokens(roundBase);
            }
        };
        // 0 = unlimited (the model calls as many rounds as it needs; use Stop
        // to cancel). A positive number caps turn consumption.
        const maxRounds = plugin.settings.coWriterMaxToolRounds > 0 ? plugin.settings.coWriterMaxToolRounds : Infinity;
        let nudgesUsed = 0;

        try {
            ctx.signal = this.abortController.signal;

            for (let round = 0; round < maxRounds; round++) {
                // Rebuild baseMessages each round — discussCurrentMessages may
                // have grown with tool-call + tool-result messages. Inject the
                // context-budget message fresh so the model knows its batch size.
                const budgetMsg = buildContextBudgetMessage(plugin, this.discussCurrentMessages, maxTokens);
                const roundBaseMessages: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...(budgetMsg ? [budgetMsg] : []),
                    ...this.discussCurrentMessages.slice(1)
                ];

                // Push a fresh draft before discussStartStreaming so the
                // panel's placeholder-check (last message already assistant?)
                // is a no-op — we own the message we'll replace post-stream.
                this.pushChatMessage({ role: 'assistant', content: '' });
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                const result = await streamToolAwareRound(
                    chat.provider,
                    {
                        messages: roundBaseMessages,
                        model: chat.modelId,
                        temperature: plugin.settings.coWriterTemperature,
                        maxTokens: plugin.settings.coWriterMaxOutputTokens,
                        signal: this.abortController.signal,
                        tools: toolDefs
                    },
                    {
                        onChunk: (text) => this.onDiscussChunk?.(text),
                        onThoughtChange: (thought) => {
                            this.thoughtBuffer = thought;
                            this.onThought?.(thought);
                        },
                        onClear: () => this.onDiscussClear?.()
                    }
                );

                // Replace the draft with the finalized message (never push a
                // second assistant message — the draft and final would both
                // render and duplicate the response text).
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    const prev = this.chatHistory[lastIdx];
                    this.chatHistory[lastIdx] = {
                        id: prev.id,
                        subagentIds: prev.subagentIds,
                        role: 'assistant',
                        content: result.response,
                        thought: result.thought || undefined,
                        toolUses:
                            result.toolCalls.length > 0
                                ? result.toolCalls.map((c) => ({
                                      name: c.name,
                                      argsSummary: summarizeToolArgs(c.name, c.arguments)
                                  }))
                                : undefined
                    };
                }

                // Push to API-level conversation (with tool_calls so the model
                // sees its prior invocations on the next round).
                this.discussCurrentMessages.push({
                    role: 'assistant',
                    content: result.response,
                    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
                    thinkingBlocks: result.thinkingBlocks,
                    quillAnchorId: this.currentAnchorMessageId() ?? undefined
                });

                // Update token estimate so the indicator reflects tool-result
                // growth — tool results stay in the conversation and keep
                // getting re-sent, so the user needs to see their cost.
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);

                // No structured tool calls this round. Before giving up, check
                // whether the model wrote a tool call as plain text (common with
                // local models) — if so, nudge it to re-issue via the real
                // interface and take another round instead of ending the turn.
                if (result.toolCalls.length === 0 || !registry) {
                    const nudge = tryNudgeTextToolLeak({
                        response: result.response,
                        toolNames: registry ? registry.list().map((t) => t.id) : [],
                        messages: this.discussCurrentMessages,
                        nudgesUsed,
                        onChatUpdate: () => this.onChatUpdate?.()
                    });
                    if (nudge.nudged) {
                        nudgesUsed = nudge.nudgesUsed;
                        continue;
                    }
                    break;
                }

                // Execute tools and push role:'tool' result messages.
                const execResults: { failed: boolean; result: string }[] = [];
                const collectedImages: string[] = [];
                for (const call of result.toolCalls) {
                    const toolResult = await executeToolCall(call, registry, ctx);
                    execResults.push({ failed: toolResult.text.startsWith('Error'), result: toolResult.text });
                    this.discussCurrentMessages.push({
                        role: 'tool',
                        content: toolResult.text,
                        toolCallId: call.id,
                        name: call.name,
                        quillAnchorId: this.currentAnchorMessageId() ?? undefined
                    });
                    if (toolResult.images && toolResult.images.length > 0) {
                        collectedImages.push(...toolResult.images);
                    }
                }
                await injectImagesIntoMessages(plugin, collectedImages, this.discussCurrentMessages, ctx.signal);

                // Annotate toolUses with error info so the panel can style
                // failed calls red and show the reason on hover / right-click copy.
                this.annotateToolUseErrors(execResults);

                // Re-estimate after tool results were appended.
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);

                // Mid-loop compaction: refine first (deterministic, free), then
                // AI-summarize older turns if still over the threshold. Keeps
                // batch sizes high instead of degrading as the conversation grows.
                let needsCompaction = this.estimateRequestTokens(this.discussCurrentMessages) / maxTokens >= compactPct;
                if (needsCompaction) {
                    this.refineForBudgetIfEnabled(
                        plugin,
                        this.discussCurrentMessages,
                        Math.ceil(compactPct * maxTokens)
                    );
                    if (this.estimateRequestTokens(this.discussCurrentMessages) / maxTokens <= compactPct) {
                        needsCompaction = false;
                        this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);
                    }
                }
                if (needsCompaction) {
                    const sc = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
                    try {
                        const cResult = await compactConversation(chat.provider, this.discussCurrentMessages, sc, {
                            signal: this.abortController?.signal
                        });
                        if (cResult) {
                            this.discussCurrentMessages = cResult.messages;
                            this.onTokenEstimate?.(
                                this.estimateRequestBreakdown(this.discussCurrentMessages),
                                maxTokens
                            );
                        }
                    } catch (compErr: unknown) {
                        // Propagate aborts to the outer catch so the normal
                        // loading-state/editor-unlock cleanup runs (don't return
                        // from inside the tool loop, which would skip it).
                        if (compErr instanceof Error && compErr.name === 'AbortError') throw compErr;
                        console.warn('Quill: Mid-loop compaction failed; continuing.', compErr);
                    }
                }

                // Sync chat so the user sees the response + tool indicators.
                this.onChatUpdate?.();
            }

            this.onDiscussFinished?.();
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.unlockEditor();
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            this.onDiscussError?.(msg);
            new Notice(`Quill: Discussion failed — ${msg}`);
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /**
     * Start a coach session with the AI.
     * The AI analyzes the passage, asks clarifying questions, and produces
     * a structured plan with executable direction.
     *
     * Multi-phase flow:
     * 1. Intent discernment — AI proposes what the writer might be trying to achieve
     * 2. Clarifying questions — AI asks targeted questions to narrow down direction
     * 3. Plan — AI creates a structured plan based on clarified intent
     * 4. Direction — AI provides concrete, actionable direction
     */
    async sendCoach(
        plugin: EventideQuillPlugin,
        message: string,
        images?: string[],
        mentionPaths?: string[]
    ): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        plugin.warnIfQueueRunning();
        notifyMobileStreamRisk();

        // Use the active file if available; fall back to stored manuscriptPath.
        // Coach mode works without an active file — same rationale as discuss.
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (filePath) this.manuscriptPath = filePath;

        const markdownView = filePath ? findEditorView(plugin.app, filePath) : null;
        const editor = markdownView?.editor ?? null;

        // Populate context engine (only when we have an editor).
        if (editor && filePath && !plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        // Create the abort controller early so the image-prep step (Regime B
        // proxy caption call) and compaction can both be cancelled via Stop,
        // not just the streaming loop below.
        this.abortController = new AbortController();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        if (editor) this.lockEditor();

        // Add user message to display history (same as sendDiscussion)
        this.pushChatMessage({
            role: 'user',
            content: message,
            ...(images && images.length > 0 ? { images } : {}),
            ...(mentionPaths && mentionPaths.length > 0 ? { mentionPaths } : {})
        });

        const fullText = editor?.getValue() ?? '';
        const proseForContext = editor ? proseBeforeCursorOrDoc(editor, 4000) : '';

        // Build injected context
        const injectedContext: ChatMessage[] = [];
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';
        if (vaultContext) {
            injectedContext.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        const additionalContextMessages = await loadAdditionalContext(
            plugin,
            mergeContextPaths(this.contextFilePaths, mentionPaths),
            fullText
        );
        injectedContext.push(...additionalContextMessages);
        const coachPlotMap = await buildPlotMapMessage(plugin);
        if (coachPlotMap) {
            injectedContext.push(coachPlotMap);
        }
        const coachDirective = buildDirectiveMessage(plugin, proseForContext);
        if (coachDirective) {
            injectedContext.push(coachDirective);
        }
        const coachActiveFileMsg = buildActiveFileMessage(plugin);
        if (coachActiveFileMsg) {
            injectedContext.push(coachActiveFileMsg);
        }
        const coachNetworkMsg = buildNetworkToolsMessage(plugin);
        if (coachNetworkMsg) {
            injectedContext.push(coachNetworkMsg);
        }
        const coachInternalMsg = buildInternalToolsMessage(plugin);
        if (coachInternalMsg) {
            injectedContext.push(coachInternalMsg);
        }

        // Initialize coach session on first call
        if (!this.coachSession || (this.coachSession.phase === 'discern' && message)) {
            const prompt = getCoWriterCoachPrompt(proseForContext || '(empty document)', message);
            const prepared = await this.prepareImageMessage(plugin, prompt, images, this.abortController?.signal);
            this.coachSession = {
                phase: 'discern',
                response: '',
                summary: '',
                isFirstTurn: true,
                clarifyRound: 0
            };
            this.coachActive = true;
            this.coachOptionsGenerated = false;

            const systemPrompt: ChatMessage = {
                role: 'system',
                content:
                    'You are a thoughtful writing coach guiding a novelist through what to do next in their scene. Your job is to ASK QUESTIONS — at least 2-3 clarifying questions in every response until you have enough information to provide a plan. Lead every response with those questions rather than moving straight to analysis or discussion. Follow the phased structure: discern intent, ask questions, plan, direct. Keep your output to coaching, leaving prose writing to the writer.'
            };

            this.discussCurrentMessages = [
                systemPrompt,
                {
                    role: 'user',
                    content: prepared.content,
                    ...(prepared.images ? { images: prepared.images } : {})
                }
            ];
        } else {
            // Subsequent turn
            const phase = this.coachSession.phase;
            if (phase === 'plan' || phase === 'direction') {
                // Revision mode — user gave feedback on an existing plan
                const revisionPrompt = getCoWriterCoachRevision(
                    proseForContext || '(empty document)',
                    message,
                    this.coachSession.response || this.coachSession.summary,
                    phase === 'direction' ? this.coachSession.response : ''
                );
                const prepared = await this.prepareImageMessage(
                    plugin,
                    revisionPrompt,
                    images,
                    this.abortController?.signal
                );
                this.discussCurrentMessages.push({
                    role: 'user',
                    content: prepared.content,
                    ...(prepared.images ? { images: prepared.images } : {}),
                    quillAnchorId: this.currentAnchorMessageId() ?? undefined
                });
            } else {
                // Normal follow-up (discern or clarify phase)
                const followUpPrompt = getCoWriterCoachFollowUp(
                    proseForContext || '(empty document)',
                    message,
                    phase === 'discern' ? 1 : 2,
                    this.coachSession.clarifyRound
                );
                const prepared = await this.prepareImageMessage(
                    plugin,
                    followUpPrompt,
                    images,
                    this.abortController?.signal
                );
                this.discussCurrentMessages.push({
                    role: 'user',
                    content: prepared.content,
                    ...(prepared.images ? { images: prepared.images } : {}),
                    quillAnchorId: this.currentAnchorMessageId() ?? undefined
                });
            }
        }

        // Guard against an abort race: cancelGeneration may have cleared
        // this.abortController during a Regime B proxy-caption await above.
        if (!this.abortController || this.abortController.signal.aborted) {
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            return;
        }

        // Build the tool registry up front so its fixed per-request overhead
        // (the serialized `tools` field) is known before the budget math below.
        const registry = createToolRegistry(plugin, false, true);
        const toolDefs = registry?.toToolDefinitions();
        this.toolTokenOverhead = registry?.estimateTokens() ?? 0;

        const injectedTokens = estimateTokens(injectedContext);
        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;
        const conversationTokens = this.estimateRequestTokens(this.discussCurrentMessages);
        const totalTokens = conversationTokens + injectedTokens;

        this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);

        // Compaction: refine first (deterministic, free), then AI-summarize if still over
        let needsCompaction = totalTokens / maxTokens >= compactPct;
        if (needsCompaction) {
            this.refineForBudgetIfEnabled(
                plugin,
                this.discussCurrentMessages,
                Math.max(0, Math.ceil(compactPct * maxTokens) - injectedTokens)
            );
            const refinedTokens = this.estimateRequestTokens(this.discussCurrentMessages) + injectedTokens;
            if (refinedTokens / maxTokens <= compactPct) {
                needsCompaction = false;
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);
            }
        }
        if (needsCompaction) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.discussCurrentMessages, sentenceCount, {
                    signal: this.abortController?.signal
                });
                if (result) {
                    this.discussCurrentMessages = result.messages;
                    this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') {
                    this.unlockEditor();
                    this.optionsLoading = false;
                    this.onOptionsLoading?.(false);
                    return;
                }
                console.warn('Quill: Coach compaction summarization failed, continuing without compaction.', err);
            }
        }

        if (__DEV__ && plugin.settings.enableDebugLogging) {
            console.warn('[Quill Co-writer] Coach context', {
                manuscriptExcerptChars: proseForContext.length,
                vaultContextChars: vaultContext.length,
                vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
                additionalFiles: this.contextFilePaths,
                phase: this.coachSession?.phase,
                totalTokens,
                maxTokens
            });
        }

        // Tool setup: same internal tools as discuss mode. The registry is
        // built above (before the budget math) so its `tools`-field overhead is
        // counted in toolTokenOverhead.
        const ctx: ToolContext = {
            plugin,
            // Mirror the per-round prefix actually sent to the model (system +
            // injected context + budget message + conversation), not just the
            // conversation skeleton, so sizing tools see the true remaining
            // window. See the discuss path for the same construction.
            consumedTokens: () => {
                const coachBudgetMsg = buildContextBudgetMessage(plugin, this.discussCurrentMessages, maxTokens);
                const roundBase: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...(coachBudgetMsg ? [coachBudgetMsg] : []),
                    ...this.discussCurrentMessages.slice(1)
                ];
                return this.estimateRequestTokens(roundBase);
            }
        };
        const maxRounds = plugin.settings.coWriterMaxToolRounds > 0 ? plugin.settings.coWriterMaxToolRounds : Infinity;
        let nudgesUsed = 0;

        let response = '';

        try {
            ctx.signal = this.abortController.signal;

            for (let round = 0; round < maxRounds; round++) {
                const coachBudgetMsg = buildContextBudgetMessage(plugin, this.discussCurrentMessages, maxTokens);
                const roundBaseMessages: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...(coachBudgetMsg ? [coachBudgetMsg] : []),
                    ...this.discussCurrentMessages.slice(1)
                ];

                this.pushChatMessage({ role: 'assistant', content: '' });
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                const result = await streamToolAwareRound(
                    chat.provider,
                    {
                        messages: roundBaseMessages,
                        model: chat.modelId,
                        temperature: plugin.settings.coWriterTemperature,
                        maxTokens: plugin.settings.coWriterMaxOutputTokens,
                        signal: this.abortController.signal,
                        tools: toolDefs
                    },
                    {
                        onChunk: (text) => this.onDiscussChunk?.(text),
                        onThoughtChange: (thought) => {
                            this.thoughtBuffer = thought;
                            this.onThought?.(thought);
                        },
                        onClear: () => this.onDiscussClear?.()
                    }
                );

                response = result.response;

                // Replace the draft with the finalized message.
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    const prev = this.chatHistory[lastIdx];
                    this.chatHistory[lastIdx] = {
                        id: prev.id,
                        subagentIds: prev.subagentIds,
                        role: 'assistant',
                        content: result.response,
                        thought: result.thought || undefined,
                        toolUses:
                            result.toolCalls.length > 0
                                ? result.toolCalls.map((c) => ({
                                      name: c.name,
                                      argsSummary: summarizeToolArgs(c.name, c.arguments)
                                  }))
                                : undefined
                    };
                }

                this.discussCurrentMessages.push({
                    role: 'assistant',
                    content: result.response,
                    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
                    thinkingBlocks: result.thinkingBlocks,
                    quillAnchorId: this.currentAnchorMessageId() ?? undefined
                });

                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);

                // No structured tool calls. Check for a text-form tool call and
                // nudge the model to re-issue it properly (see discuss mode).
                if (result.toolCalls.length === 0 || !registry) {
                    const nudge = tryNudgeTextToolLeak({
                        response: result.response,
                        toolNames: registry ? registry.list().map((t) => t.id) : [],
                        messages: this.discussCurrentMessages,
                        nudgesUsed,
                        onChatUpdate: () => this.onChatUpdate?.()
                    });
                    if (nudge.nudged) {
                        nudgesUsed = nudge.nudgesUsed;
                        continue;
                    }
                    break;
                }

                const coachExecResults: { failed: boolean; result: string }[] = [];
                const coachCollectedImages: string[] = [];
                for (const call of result.toolCalls) {
                    const toolResult = await executeToolCall(call, registry, ctx);
                    coachExecResults.push({ failed: toolResult.text.startsWith('Error'), result: toolResult.text });
                    this.discussCurrentMessages.push({
                        role: 'tool',
                        content: toolResult.text,
                        toolCallId: call.id,
                        name: call.name,
                        quillAnchorId: this.currentAnchorMessageId() ?? undefined
                    });
                    if (toolResult.images && toolResult.images.length > 0) {
                        coachCollectedImages.push(...toolResult.images);
                    }
                }
                await injectImagesIntoMessages(plugin, coachCollectedImages, this.discussCurrentMessages, ctx.signal);

                this.annotateToolUseErrors(coachExecResults);
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);

                // Mid-loop compaction: refine first (deterministic, free), then AI-summarize if still over.
                let needsCompaction = this.estimateRequestTokens(this.discussCurrentMessages) / maxTokens >= compactPct;
                if (needsCompaction) {
                    this.refineForBudgetIfEnabled(
                        plugin,
                        this.discussCurrentMessages,
                        Math.ceil(compactPct * maxTokens)
                    );
                    if (this.estimateRequestTokens(this.discussCurrentMessages) / maxTokens <= compactPct) {
                        needsCompaction = false;
                        this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);
                    }
                }
                if (needsCompaction) {
                    const sc = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
                    try {
                        const cResult = await compactConversation(chat.provider, this.discussCurrentMessages, sc, {
                            signal: this.abortController?.signal
                        });
                        if (cResult) {
                            this.discussCurrentMessages = cResult.messages;
                            this.onTokenEstimate?.(
                                this.estimateRequestBreakdown(this.discussCurrentMessages),
                                maxTokens
                            );
                        }
                    } catch (compErr: unknown) {
                        // Propagate aborts to the outer catch so the normal
                        // loading-state/editor-unlock cleanup runs.
                        if (compErr instanceof Error && compErr.name === 'AbortError') throw compErr;
                        console.warn('Quill: Mid-loop compaction failed; continuing.', compErr);
                    }
                }

                this.onChatUpdate?.();
            }

            // Update coach session — runs after all tool rounds complete,
            // using the final round's response.
            if (this.coachSession) {
                this.coachSession.response = response;
                this.coachSession.isFirstTurn = false;

                const askedQuestions = response.includes('?');

                // Advance phase
                if (this.coachSession.phase === 'discern') {
                    this.coachSession.phase = 'clarify';
                    this.coachSession.clarifyRound = 1;
                } else if (this.coachSession.phase === 'clarify') {
                    if (askedQuestions && this.coachSession.clarifyRound < 2) {
                        this.coachSession.clarifyRound++;
                    } else {
                        this.coachSession.phase = 'plan';
                    }
                } else if (this.coachSession.phase === 'plan') {
                    this.coachSession.phase = 'direction';
                }

                // Build summary for option generation
                this.coachSession.summary = this.buildCoachSummary();

                // Stamp the post-turn phase on the last assistant message so
                // rewind restores it exactly instead of re-deriving via the
                // heuristic mirror in reevaluateCoachPhase.
                const coachLastIdx = this.chatHistory.length - 1;
                const coachLastMsg = coachLastIdx >= 0 ? this.chatHistory[coachLastIdx] : undefined;
                if (coachLastMsg && coachLastMsg.role === 'assistant') {
                    coachLastMsg.phaseSnapshot = this.coachSession.phase;
                }
            }

            // Determine if this is a revision (plan/direction follow-up after options generated)
            const isRevision =
                this.coachOptionsGenerated &&
                this.coachSession !== null &&
                (this.coachSession.phase === 'plan' || this.coachSession.phase === 'direction') &&
                !this.coachSession.isFirstTurn;

            // Add showAccept to the last assistant message if this is a revision.
            if (isRevision) {
                const lastIdx = this.chatHistory.length - 1;
                const lastMsg = lastIdx >= 0 ? this.chatHistory[lastIdx] : undefined;
                if (lastMsg && lastMsg.role === 'assistant') {
                    lastMsg.showAccept = true;
                }
            }

            this.onDiscussFinished?.();

            // Auto-generate options when plan or direction phase is reached for the first time
            const reachedPlanOrDirection =
                this.coachSession?.phase === 'plan' || this.coachSession?.phase === 'direction';
            const willAutoGenerate = reachedPlanOrDirection && !this.coachOptionsGenerated;

            // Unlock before the callback so coachToOptions (which re-locks) is
            // not immediately unlocked by a deferred unlockEditor call.
            this.unlockEditor();

            if (willAutoGenerate) {
                this.coachOptionsGenerated = true;
                this.onCoachDirectionReady?.();
            }

            if (!willAutoGenerate) {
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
            }
            this.onChatUpdate?.();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.unlockEditor();
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            this.onDiscussError?.(msg);
            new Notice(`Quill: Coaching failed — ${msg}`);
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /**
     * Build a summary of the coaching session for use in option generation.
     */
    private buildCoachSummary(): string {
        if (!this.coachSession) return '';
        return this.coachSession.response.trim().slice(0, 2000);
    }

    /**
     * Transition from coach mode to option generation.
     * Uses the coach summary to generate continuation options.
     */
    async coachToOptions(plugin: EventideQuillPlugin, direction: string): Promise<void> {
        if (!this.coachSession) {
            new Notice('Quill: No active coaching session.');
            return;
        }

        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        this.cancelGeneration();
        this.app = plugin.app;

        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: Open a manuscript to use coaching.');
            return;
        }
        this.manuscriptPath = filePath;

        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
            new Notice('Quill: Open a manuscript editor to use coaching.');
            return;
        }
        const editor = markdownView.editor;

        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        this.onChatUpdate?.();
        this.lockEditor();

        const fullText = editor.getValue();
        // Reuse the discuss/coach context fallback so options generate against
        // the actual prose even when the cursor wasn't placed at a working
        // position (document opened but not clicked into).
        const proseForOptions = proseBeforeCursorOrDoc(editor, 4000);

        const coachSummary = this.buildCoachSummary();
        const prompt = getCoWriterCoachToOptions(proseForOptions || '(empty document)', coachSummary, direction);

        this.pushChatMessage({
            role: 'user',
            content: direction || 'Generate continuation options based on the coaching provided.'
        });

        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        const coachOptionsPlotMap = await buildPlotMapMessage(plugin);
        const coachOptionsDirective = buildDirectiveMessage(plugin, proseForOptions);

        const messages: ChatMessage[] = [];
        if (vaultContext) {
            messages.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        if (coachOptionsPlotMap) {
            messages.push(coachOptionsPlotMap);
        }
        if (coachOptionsDirective) {
            messages.push(coachOptionsDirective);
        }
        messages.push(...additionalContextMessages, { role: 'user', content: prompt });

        let thought = '';

        try {
            this.abortController = new AbortController();
            const stream = chat.provider.chatCompletion({
                messages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: 1024,
                signal: this.abortController.signal
            });

            let response = '';
            for await (const chunk of stream) {
                if (chunk.done) break;
                response += chunk.text;
                if (chunk.thought) {
                    thought += chunk.thought;
                    this.thoughtBuffer = thought;
                    this.onThought?.(thought);
                }
            }

            const parsed = this.parseOptionsResponse(response, 1);
            if (parsed && parsed.length === 1) {
                this.currentOptions = parsed;
            } else {
                this.currentOptions = [
                    {
                        label: 'Continue from coaching',
                        description:
                            'Advance the scene following the coaching plan, in the established voice and pacing.'
                    }
                ];
            }

            this.pushChatMessage({
                role: 'assistant',
                content: 'Here is a continuation option based on the coaching:',
                options: this.currentOptions,
                thought: thought || undefined
            });

            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.unlockEditor();
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
                return;
            }
            new Notice(`Quill: Failed to generate options — ${err instanceof Error ? err.message : String(err)}`);
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /**
     * End the current coach session.
     */
    endCoachSession(): void {
        this.coachSession = null;
        this.coachActive = false;
        this.coachOptionsGenerated = false;
        this.discussCurrentMessages = [];
    }

    // ── Lorebook coach ──────────────────────────────────────────────────────

    /**
     * Send a message to the lorebook coach. Uses the provider's native
     * tool-calling API so the model can invoke `manuscript_mentions`,
     * `lore_siblings`, `vault_lookup`, and `propose_entry` via its own
     * tool-call mechanism.
     *
     * Unlike the prose coach, this method manages the multi-round tool-calling
     * loop ITSELF (not via the transparent `streamWithTools` wrapper) so that:
     *   - Each round is its own chat message with its own reasoning section.
     *   - Tool calls are visible as distinct "Used X" turns in the chat history.
     *   - "Draft" text emitted before a reasoning block is discarded so the
     *     response isn't duplicated around `<think>` tags.
     *
     * Turn off tools via `coWriterToolsEnabled` (settings → lorebook) when
     * the model doesn't support tool calling or to avoid extra turn consumption.
     *
     * Does NOT lock the editor or require an active manuscript — lorebook
     * development is independent of any open chapter. Does require at least
     * one configured lorebook folder.
     */
    async sendLoreCoach(plugin: EventideQuillPlugin, message: string, images?: string[]): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        plugin.warnIfQueueRunning();
        notifyMobileStreamRisk();
        if (plugin.settings.lorebookFolders.length === 0) {
            new Notice('Quill: Add at least one lorebook folder in settings → lorebook first.');
            return;
        }

        this.cancelGeneration();
        // Create the abort controller early so the image-prep step (Regime B
        // proxy caption call) can be cancelled via Stop, not just the
        // streaming loop below.
        this.abortController = new AbortController();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);

        // Add user message to display history.
        this.pushChatMessage({ role: 'user', content: message, ...(images && images.length > 0 ? { images } : {}) });

        // Initialize session on first turn.
        if (!this.loreCoachSession) {
            const prompt = getLoreCoachUserPrompt(message);
            const prepared = await this.prepareImageMessage(plugin, prompt, images, this.abortController?.signal);
            this.loreCoachSession = {
                phase: 'discover',
                scope: message,
                entryType: null,
                rounds: 0
            };
            this.loreCoachActive = true;
            this.currentLoreDraft = null;

            this.loreCoachMessages = [
                { role: 'system', content: getLoreCoachSystemPrompt() },
                {
                    role: 'user',
                    content: prepared.content,
                    ...(prepared.images ? { images: prepared.images } : {})
                }
            ];
        } else {
            this.loreCoachSession.rounds++;
            const prompt = getLoreCoachUserPrompt(message);
            const prepared = await this.prepareImageMessage(plugin, prompt, images, this.abortController?.signal);
            this.loreCoachMessages.push({
                role: 'user',
                content: prepared.content,
                ...(prepared.images ? { images: prepared.images } : {}),
                quillAnchorId: this.currentAnchorMessageId() ?? undefined
            });
        }

        // Guard against an abort race: cancelGeneration may have cleared
        // this.abortController during a Regime B proxy-caption await above.
        if (!this.abortController || this.abortController.signal.aborted) {
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            return;
        }

        const registry = createToolRegistry(plugin, true, true);
        const toolDefs = registry?.toToolDefinitions();
        this.toolTokenOverhead = registry?.estimateTokens() ?? 0;
        const maxTokens = chat.provider.config.maxContextTokens;
        const ctx: ToolContext = {
            plugin,
            // Mirror the per-round prefix actually sent to the model (system +
            // active-file awareness + budget message + network-tools hint +
            // conversation), not just the conversation skeleton, so sizing
            // tools see the true remaining window.
            consumedTokens: () => {
                const injected: ChatMessage[] = [];
                const activeFileMsg = buildActiveFileMessage(plugin);
                if (activeFileMsg) injected.push(activeFileMsg);
                const budgetMsg = buildContextBudgetMessage(plugin, this.loreCoachMessages, maxTokens);
                if (budgetMsg) injected.push(budgetMsg);
                const networkMsg = buildNetworkToolsMessage(plugin);
                if (networkMsg) injected.push(networkMsg);
                const roundBase: ChatMessage[] =
                    this.loreCoachMessages.length > 0
                        ? [this.loreCoachMessages[0]!, ...injected, ...this.loreCoachMessages.slice(1)]
                        : injected;
                return this.estimateRequestTokens(roundBase);
            }
        };

        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;
        const conversationTokens = this.estimateRequestTokens(this.loreCoachMessages);
        this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);

        // Compaction: refine first (deterministic, free), then AI-summarize if still over.
        let needsCompaction = conversationTokens / maxTokens >= compactPct;
        if (needsCompaction) {
            this.refineForBudgetIfEnabled(plugin, this.loreCoachMessages, Math.ceil(compactPct * maxTokens));
            if (this.estimateRequestTokens(this.loreCoachMessages) / maxTokens <= compactPct) {
                needsCompaction = false;
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);
            }
        }
        if (needsCompaction) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.loreCoachMessages, sentenceCount);
                if (result) {
                    this.loreCoachMessages = result.messages;
                    this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') {
                    this.optionsLoading = false;
                    this.onOptionsLoading?.(false);
                    return;
                }
                console.warn('Quill: Lore coach compaction failed; continuing without compaction.', err);
            }
        }

        if (__DEV__ && plugin.settings.enableDebugLogging) {
            console.warn('[Quill Co-writer] Lore coach context', {
                scope: this.loreCoachSession.scope,
                phase: this.loreCoachSession.phase,
                rounds: this.loreCoachSession.rounds,
                toolsEnabled: plugin.settings.coWriterToolsEnabled,
                conversationTokens: this.estimateRequestTokens(this.loreCoachMessages),
                maxTokens
            });
        }

        const maxRounds = plugin.settings.coWriterMaxToolRounds > 0 ? plugin.settings.coWriterMaxToolRounds : Infinity;
        let nudgesUsed = 0;

        try {
            for (let round = 0; round < maxRounds; round++) {
                this.abortController = new AbortController();
                ctx.signal = this.abortController.signal;

                // Push a fresh placeholder for this round BEFORE calling
                // discussStartStreaming. The panel's discussStartStreaming
                // checks "is the last message already assistant?" and skips
                // its own push when so — by pre-pushing our own draft we
                // prevent a duplicate placeholder and own the message we'll
                // finalize in place after the stream.
                this.pushChatMessage({ role: 'assistant', content: '' });
                this.thoughtBuffer = '';
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                // Inject context-budget + active-file awareness fresh each
                // round so the model knows how many files it can batch and
                // which file is open.
                const activeFileMsg = buildActiveFileMessage(plugin);
                const budgetMsg = buildContextBudgetMessage(plugin, this.loreCoachMessages, maxTokens);
                const networkMsg = buildNetworkToolsMessage(plugin);
                const injected: ChatMessage[] = [];
                if (activeFileMsg) injected.push(activeFileMsg);
                if (budgetMsg) injected.push(budgetMsg);
                if (networkMsg) injected.push(networkMsg);
                const messagesForCall =
                    injected.length > 0 && this.loreCoachMessages.length > 0
                        ? [this.loreCoachMessages[0]!, ...injected, ...this.loreCoachMessages.slice(1)]
                        : this.loreCoachMessages;

                const { response, thought, toolCalls, thinkingBlocks } = await streamToolAwareRound(
                    chat.provider,
                    {
                        messages: messagesForCall,
                        model: chat.modelId,
                        temperature: 0.7,
                        maxTokens: plugin.settings.coWriterMaxOutputTokens,
                        signal: this.abortController.signal,
                        tools: toolDefs
                    },
                    {
                        onChunk: (text) => this.onDiscussChunk?.(text),
                        onThoughtChange: (t) => {
                            this.thoughtBuffer = t;
                            this.onThought?.(t);
                        },
                        onClear: () => this.onDiscussClear?.()
                    }
                );

                // Phase advance: discover → develop after the first response
                // (unless propose_entry advanced to 'refine' below).
                if (this.loreCoachSession && this.loreCoachSession.phase === 'discover') {
                    this.loreCoachSession.phase = 'develop';
                }

                // REPLACE the placeholder (last message) with the finalized
                // message — never push a second assistant message, or the
                // placeholder and the final would both render and duplicate
                // the response text. Tool calls are annotated on the message
                // as `toolUses` (rendered within the bubble by the panel).
                // loreDraft is attached AFTER tool execution below, so the
                // draft comes from the post-tool state (propose_entry's
                // output) rather than a pre-tool snapshot.
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    const prev = this.chatHistory[lastIdx];
                    this.chatHistory[lastIdx] = {
                        id: prev.id,
                        subagentIds: prev.subagentIds,
                        role: 'assistant',
                        content: response,
                        thought: thought || undefined,
                        toolUses:
                            toolCalls.length > 0
                                ? toolCalls.map((c) => ({
                                      name: c.name,
                                      argsSummary: summarizeToolArgs(c.name, c.arguments)
                                  }))
                                : undefined
                    };
                }

                this.loreCoachMessages.push({
                    role: 'assistant',
                    content: response,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                    thinkingBlocks,
                    quillAnchorId: this.currentAnchorMessageId() ?? undefined
                });

                // No structured tool calls. Check for a text-form tool call and
                // nudge the model to re-issue it properly (see discuss mode).
                if (toolCalls.length === 0 || !registry) {
                    const nudge = tryNudgeTextToolLeak({
                        response,
                        toolNames: registry ? registry.list().map((t) => t.id) : [],
                        messages: this.loreCoachMessages,
                        nudgesUsed,
                        onChatUpdate: () => this.onChatUpdate?.()
                    });
                    if (nudge.nudged) {
                        nudgesUsed = nudge.nudgesUsed;
                        continue;
                    }
                    break;
                }

                // Execute each tool via the shared helper (handles JSON parse,
                // execution errors, truncation uniformly across all modes).
                const loreExecResults: { failed: boolean; result: string }[] = [];
                const loreCollectedImages: string[] = [];
                for (const call of toolCalls) {
                    const toolResult = await executeToolCall(call, registry, ctx);
                    loreExecResults.push({ failed: toolResult.text.startsWith('Error'), result: toolResult.text });
                    this.loreCoachMessages.push({
                        role: 'tool',
                        content: toolResult.text,
                        toolCallId: call.id,
                        name: call.name,
                        quillAnchorId: this.currentAnchorMessageId() ?? undefined
                    });
                    if (toolResult.images && toolResult.images.length > 0) {
                        loreCollectedImages.push(...toolResult.images);
                    }
                }
                await injectImagesIntoMessages(plugin, loreCollectedImages, this.loreCoachMessages, ctx.signal);

                this.annotateToolUseErrors(loreExecResults);

                // Attach the lore draft from the POST-tool state so the
                // assistant turn that actually invoked propose_entry owns the
                // review card. Only this round's message carries the draft — a
                // later, non-proposing round gets undefined so an outdated
                // actionable card can't resurface.
                const proposedThisRound = toolCalls.some((c) => c.name === 'propose_entry');
                const draftIdx = this.chatHistory.length - 1;
                if (draftIdx >= 0 && this.chatHistory[draftIdx]?.role === 'assistant') {
                    this.chatHistory[draftIdx].loreDraft =
                        proposedThisRound && this.currentLoreDraft ? this.currentLoreDraft : undefined;
                }

                // If propose_entry was called, advance phase and fire the
                // draft-ready callback.
                if (this.currentLoreDraft && this.loreCoachSession) {
                    this.loreCoachSession.entryType = this.currentLoreDraft.entryType;
                    this.loreCoachSession.phase = 'refine';
                    this.onLoreDraftReady?.();
                }

                // Update token estimate so the indicator reflects tool-result
                // growth, then sync the chat so the user sees progress.
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);

                // Mid-loop compaction: refine first (deterministic, free), then
                // AI-summarize older turns if still over the threshold.
                let needsCompaction = this.estimateRequestTokens(this.loreCoachMessages) / maxTokens >= compactPct;
                if (needsCompaction) {
                    this.refineForBudgetIfEnabled(plugin, this.loreCoachMessages, Math.ceil(compactPct * maxTokens));
                    if (this.estimateRequestTokens(this.loreCoachMessages) / maxTokens <= compactPct) {
                        needsCompaction = false;
                        this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);
                    }
                }
                if (needsCompaction) {
                    const sc = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
                    try {
                        const cResult = await compactConversation(chat.provider, this.loreCoachMessages, sc, {
                            signal: this.abortController?.signal
                        });
                        if (cResult) {
                            this.loreCoachMessages = cResult.messages;
                            this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);
                        }
                    } catch (compErr: unknown) {
                        // Propagate aborts to the outer catch so the normal
                        // loading-state cleanup runs.
                        if (compErr instanceof Error && compErr.name === 'AbortError') throw compErr;
                        console.warn('Quill: Mid-loop compaction failed; continuing.', compErr);
                    }
                }

                this.onChatUpdate?.();

                // Continue to next round — the model will see its tool_calls
                // and the tool results and continue the conversation.
            }

            // Stamp the post-turn phase on the last assistant message so rewind
            // restores it exactly instead of re-deriving via the lossy
            // heuristic in reevaluateLoreCoachPhase (which can't distinguish a
            // later-rejected draft from a live one).
            if (this.loreCoachSession) {
                const loreLastIdx = this.chatHistory.length - 1;
                const loreLastMsg = loreLastIdx >= 0 ? this.chatHistory[loreLastIdx] : undefined;
                if (loreLastMsg && loreLastMsg.role === 'assistant') {
                    loreLastMsg.phaseSnapshot = this.loreCoachSession.phase;
                }
            }

            this.onDiscussFinished?.();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onTokenEstimate?.(this.estimateRequestBreakdown(this.loreCoachMessages), maxTokens);
            this.onChatUpdate?.();
            this.onLoreCoachUpdate?.();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.optionsLoading = false;
                this.onOptionsLoading?.(false);
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            this.onDiscussError?.(msg);
            new Notice(`Quill: Lore coach failed — ${msg}`);
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /** Clear lorebook coach session state. Used by the "End coaching" button. */
    endLoreCoachSession(): void {
        this.loreCoachSession = null;
        this.loreCoachActive = false;
        this.loreCoachMessages = [];
        this.currentLoreDraft = null;
        this.onLoreCoachUpdate?.();
    }

    /**
     * Fulfill mode: scan the active document for every `<!-- quill: -->` directive
     * and generate a fulfillment for each, in document order. Each completed
     * fulfillment is added to {@link fulfillChanges} as a proposed edit (replace
     * the comment with prose) and rendered for review via the shared change-diff.
     *
     * @param globalInstruction  Optional overall direction prepended to every directive's prompt.
     */
    async fulfillDirectives(plugin: EventideQuillPlugin, globalInstruction?: string): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
            new Notice('Quill: Open a manuscript to run fulfill.');
            return;
        }
        this.manuscriptPath = filePath;
        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
            new Notice('Quill: Open a manuscript editor to run fulfill.');
            return;
        }
        const editor = markdownView.editor;

        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        this.app = plugin.app;

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
            new Notice('Quill: Could not access editor for fulfill.');
            return;
        }

        const fullText = editor.getValue();
        const ranges = parseAllDirectives(fullText);
        if (ranges.length === 0) {
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
            new Notice('Quill: No inline directives found. Add some with the "insert inline directive" command.');
            return;
        }

        // Voice profile (cached per manuscript)
        if (plugin.settings.coWriterVoiceMatch && (!this.voiceProfile || this.voiceProfileFile !== filePath)) {
            const profile = await this.analyzeVoice(chat.provider, chat.modelId, fullText.slice(-3000));
            if (profile) {
                this.voiceProfile = profile;
                this.voiceProfileFile = filePath;
            }
        }

        const plotMapText = await loadPlotMapText(plugin);

        this.fulfillChanges.clear();
        this.fulfillActive = true;
        clearDiffEdits(cm, 'fulfill');
        this.onFulfillUpdate?.();

        const notice = new Notice(
            `Quill: Fulfilling ${ranges.length} directive${ranges.length === 1 ? '' : 's'}...`,
            0
        );

        try {
            for (const range of ranges) {
                this.abortController = new AbortController();
                // Re-read the editor each iteration: the user may have edited
                // during a prior sequential call, which would shift offsets.
                const currentDoc = editor.getValue();
                // Validate the directive comment is still at the expected
                // offset; skip if it was moved, edited, or removed.
                const currentSlice = currentDoc.slice(range.start, range.end);
                const directiveMatch = currentSlice.match(/<!--\s*quill:\s*([\s\S]*?)\s*-->/);
                if (!directiveMatch || (directiveMatch[1] ?? '').trim() !== range.text) {
                    continue;
                }
                const before = currentDoc.slice(Math.max(0, range.start - 2000), range.start);
                const after = currentDoc.slice(range.end, range.end + 2000);
                const systemPrompt = getCoWriterGenerationPrompt(
                    this.voiceProfile ?? {
                        sentenceLengthDistribution: 'unknown',
                        dialogueRatio: 0.5,
                        vocabularyRegister: 'unknown',
                        keyPatterns: []
                    },
                    plugin.settings.narrativeVoicePreset,
                    undefined,
                    [{ source: 'inline', text: range.text }],
                    plotMapText,
                    plugin.settings.wikiLinkBehavior
                );
                const userMessage = [
                    'Fulfill the inline directive at this point in the scene. Your prose will replace the directive comment and sit between the text above and the text below.',
                    'Read the surrounding prose carefully. Do NOT repeat or rephrase content that already appears before or after the directive — the reader has already seen it.',
                    'Insert exactly what the directive asks for. If it says "a paragraph," write one paragraph. If it asks for a specific detail, action, or description, write only that — not a summary of what is already there.',
                    'Your prose must flow naturally into the text that follows it. Write in the established voice and perspective. Output only the prose, plain and without labels or explanations.',
                    ...(globalInstruction ? ['', `Overall direction for this sweep: ${globalInstruction}`] : []),
                    '',
                    `Directive: "${range.text}"`,
                    '',
                    '--- Prose before the directive ---',
                    before || '(start of document)',
                    '',
                    '--- Prose after the directive (your prose must flow into this) ---',
                    after || '(end of document)'
                ].join('\n');

                let prose = '';
                try {
                    const stream = chat.provider.chatCompletion({
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userMessage }
                        ],
                        model: chat.modelId,
                        temperature: plugin.settings.coWriterTemperature,
                        maxTokens: plugin.settings.coWriterMaxOutputTokens,
                        signal: this.abortController.signal
                    });
                    for await (const chunk of stream) {
                        if (chunk.done) break;
                        prose += chunk.text;
                    }
                } catch (err: unknown) {
                    if (err instanceof Error && err.name === 'AbortError') {
                        return;
                    }
                    // Skip this directive on error; already-completed edits remain reviewable.
                    continue;
                }
                // Empty/whitespace-only response → do NOT stage. Every sibling
                // path (direct, transform, lint-batch, pacing) guards against
                // staging an empty newText; fulfill was the lone holdout, and a
                // non-zero directive range staged with '' is a destructive
                // deletion (approve → the directive comment vanishes with no
                // replacement). Skip the directive and tell the writer.
                const fulfilledProse = sanitizeProse(prose).trim();
                if (fulfilledProse.length === 0) {
                    new Notice('Quill: Received an empty response from the AI provider for a directive; skipping it.');
                    continue;
                }
                this.fulfillChanges.add({
                    from: range.start,
                    to: range.end,
                    newText: fulfilledProse,
                    label: range.text
                });
                pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
                this.onFulfillUpdate?.();
            }
        } finally {
            notice.hide();
            this.fulfillActive = false;
            this.onFulfillUpdate?.();
        }
    }

    /** Resolve the CodeMirror view for the active manuscript, or null. */
    private getManuscriptCm(): EditorView | null {
        if (!this.app || !this.manuscriptPath) return null;
        const markdownView = findEditorView(this.app, this.manuscriptPath);
        return markdownView ? (markdownView.editor as unknown as { cm: EditorView }).cm : null;
    }
    /**
     * Approve one Fulfill edit: replace its directive comment with the generated
     * prose (the comment is consumed). The shared change-diff is updated in the
     * same transaction so there is no flicker. Later edits' offsets are remapped
     * by the ChangeSet.
     */
    approveFulfillSection(plugin: EventideQuillPlugin, id: number): void {
        void plugin;
        const cm = this.getManuscriptCm();
        if (!cm) return;
        syncChangeSetPositions(cm, this.fulfillChanges, 'fulfill');
        const change = this.fulfillChanges.approve(id);
        if (!change) return;
        applyApprovedEdit(cm, change, 'fulfill', toDiffSnapshots(this.fulfillChanges, 'fulfill'));
        this.onFulfillUpdate?.();
    }

    /** Reject one Fulfill edit: leave the directive comment in place, un-consumed. */
    rejectFulfillSection(id: number): void {
        const cm = this.getManuscriptCm();
        if (cm) syncChangeSetPositions(cm, this.fulfillChanges, 'fulfill');
        this.fulfillChanges.reject(id);
        if (cm) pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
        this.onFulfillUpdate?.();
    }

    /** Approve every pending edit. Changes dispatch sequentially (offsets remap as each commits). */
    approveAllFulfill(plugin: EventideQuillPlugin): void {
        void plugin;
        const cm = this.getManuscriptCm();
        if (!cm) return;
        syncChangeSetPositions(cm, this.fulfillChanges, 'fulfill');
        for (const change of this.fulfillChanges.approveAll()) {
            cm.dispatch({ changes: change });
        }
        pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
        this.onFulfillUpdate?.();
    }

    /** Reject every pending edit without touching the document. */
    rejectAllFulfill(): void {
        this.fulfillChanges.rejectAll();
        const cm = this.getManuscriptCm();
        if (cm) pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
        this.onFulfillUpdate?.();
    }

    /** Clear all Fulfill state (e.g., on new chat / reset). */
    clearFulfill(): void {
        this.fulfillChanges.clear();
        this.fulfillActive = false;
        const cm = this.getManuscriptCm();
        if (cm) clearDiffEdits(cm, 'fulfill');
        this.onFulfillUpdate?.();
    }

    /**
     * Approve the Direct continuation: commit the buffered prose at the cursor
     * and clear the diff. Fires onDraftAccepted so fresh options regenerate
     * (preserving the old accept-a-draft behavior).
     */
    approveDirectChange(plugin: EventideQuillPlugin, id: number): void {
        void plugin;
        const cm = this.getManuscriptCm();
        if (!cm) return;
        syncChangeSetPositions(cm, this.directChanges, 'direct');
        const change = this.directChanges.approve(id);
        if (!change) return;
        applyApprovedEdit(cm, change, 'direct', toDiffSnapshots(this.directChanges, 'direct'));
        this.onDirectChangeUpdate?.();
        this.onDraftAccepted?.();
    }

    /** Reject the Direct continuation: discard the buffered prose (nothing was
     *  ever written to the document) and clear the diff. Resets optionsLoading
     *  so the panel re-enables the Apply buttons on the existing option set. */
    rejectDirectChange(id: number): void {
        void id;
        this.directChanges.clear();
        const cm = this.getManuscriptCm();
        if (cm) clearDiffEdits(cm, 'direct');
        this.optionsLoading = false;
        this.onOptionsLoading?.(false);
        this.onDirectChangeUpdate?.();
        this.onChatUpdate?.();
    }

    /** Clear Direct change state (e.g., on reset / new chat). */
    clearDirect(): void {
        this.directChanges.clear();
        const cm = this.getManuscriptCm();
        if (cm) clearDiffEdits(cm, 'direct');
        this.optionsLoading = false;
        this.onOptionsLoading?.(false);
        this.onDirectChangeUpdate?.();
    }

    // ── Lore edit (edit_note / insert_note / append_to_note tools) ──────

    /**
     * Approve one pending lore edit: commit it to the target note. If the file
     * is open in an editor, dispatches via CodeMirror (the normal path) and
     * re-pushes any remaining pending edits as the diff. If the file was closed
     * (the writer tabbed away), falls back to reading + modifying the file
     * directly.
     *
     * Multiple edits may be pending for the same file (e.g. an insert_note plus
     * an edit_note on one character). The entry — and the tab the tool opened —
     * are torn down only when the last pending edit is resolved.
     */
    approveLoreEdit(filePath: string, id: number): Promise<void> {
        const entry = this.loreEdits.get(filePath);
        if (!entry) return Promise.resolve();

        const view = this.app ? findEditorView(this.app, filePath) : null;
        const cm = view ? (view.editor as unknown as { cm: EditorView }).cm : null;

        if (cm) {
            // File is open — reconcile drift, approve this edit, and re-push the
            // remaining pending lore edits as the diff. applyApprovedEdit splits
            // the change dispatch from the snapshot refresh so other owners'
            // pending edits in this editor stay at correct offsets.
            syncChangeSetPositions(cm, entry.changeSet, 'lore_edit');
            const change = entry.changeSet.approve(id);
            if (!change) return Promise.resolve();
            applyApprovedEdit(cm, change, 'lore_edit', toDiffSnapshots(entry.changeSet, 'lore_edit', filePath));
            if (!entry.changeSet.hasPending) {
                this.closeLoreEditTabIfOpenedByTool(filePath);
                this.loreEdits.delete(filePath);
            }
            this.onLoreEditUpdate?.();
            return Promise.resolve();
        }

        // File isn't open — apply the single edit directly via the vault.
        // ChangeSet.approve remaps later edits' offsets, so each one-shot write
        // stays valid against the post-write content. Don't close the tab,
        // delete the entry, or fire updates until the write has actually
        // succeeded, so a failed write keeps the edit reviewable.
        //
        // Writes are serialized per file via loreEditWriteQueue: a second
        // approval arriving while a write is in flight is chained behind it, so
        // it observes the remap from the first write's approve() and can't race
        // the in-flight vault.process (which would double-apply or land at stale
        // offsets). The pending check is re-run inside the chain so a duplicate
        // click on an edit already approved by the prior write becomes a no-op.
        if (this.app) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const run = async (): Promise<void> => {
                    const edit = entry.changeSet.get(id);
                    if (!edit || edit.state !== 'pending') return;
                    await this.app!.vault.process(
                        file,
                        (content) => content.slice(0, edit.from) + edit.newText + content.slice(edit.to)
                    );
                    entry.changeSet.approve(id);
                    if (!entry.changeSet.hasPending) {
                        this.closeLoreEditTabIfOpenedByTool(filePath);
                        this.loreEdits.delete(filePath);
                    }
                    this.onLoreEditUpdate?.();
                };
                const prev = this.loreEditWriteQueue.get(filePath) ?? Promise.resolve();
                const writeResult = prev.then(run);
                const next = writeResult.catch((err: unknown) => {
                    console.warn('Quill: Lore edit write failed; keeping the edit pending.', err);
                    this.onLoreEditUpdate?.();
                });
                this.loreEditWriteQueue.set(filePath, next);
                void next.then(() => {
                    if (this.loreEditWriteQueue.get(filePath) === next) {
                        this.loreEditWriteQueue.delete(filePath);
                    }
                });
                return writeResult;
            }
        }

        // Fallback (no app, no open editor, or file vanished) — approve in-memory only.
        entry.changeSet.approve(id);
        if (!entry.changeSet.hasPending) {
            this.closeLoreEditTabIfOpenedByTool(filePath);
            this.loreEdits.delete(filePath);
        }
        this.onLoreEditUpdate?.();
        return Promise.resolve();
    }

    /**
     * Reject one pending lore edit by id; leave any siblings pending. Tears
     * down the entry (and the tool-opened tab) only when the last pending edit
     * for the file is resolved.
     */
    rejectLoreEdit(filePath: string, id: number): void {
        const entry = this.loreEdits.get(filePath);
        if (!entry) return;

        const view = this.app ? findEditorView(this.app, filePath) : null;
        const cm = view ? (view.editor as unknown as { cm: EditorView }).cm : null;

        if (cm) {
            syncChangeSetPositions(cm, entry.changeSet, 'lore_edit');
            entry.changeSet.reject(id);
            if (entry.changeSet.hasPending) {
                pushDiffEdits(cm, toDiffSnapshots(entry.changeSet, 'lore_edit', filePath));
            } else {
                clearDiffEdits(cm, 'lore_edit');
            }
        } else {
            entry.changeSet.reject(id);
        }

        if (!entry.changeSet.hasPending) {
            this.closeLoreEditTabIfOpenedByTool(filePath);
            this.loreEdits.delete(filePath);
        }
        this.onLoreEditUpdate?.();
    }

    /**
     * Event-driven context refinement: after a lore edit (edit_note /
     * insert_note / append_to_note) is resolved, compress the affected API
     * turns so the model learns the outcome and sheds verbatim now-stale
     * content. Runs over BOTH API arrays (an edit approved in one mode still
     * benefits the other's history if it overlaps). Gated by
     * `contextRefinementEnabled`. Idempotent. See `src/ai/context-refinement.ts`.
     */
    refineOnLoreEditResolved(
        plugin: EventideQuillPlugin,
        filePath: string,
        editId: number,
        outcome: 'approved' | 'rejected'
    ): void {
        if (!plugin.settings.contextRefinementEnabled) return;
        refineLoreEditOutcome(this.discussCurrentMessages, editId, outcome);
        refineLoreEditOutcome(this.loreCoachMessages, editId, outcome);
        if (outcome === 'approved') {
            // The file changed — prior vault_lookups of it are now stale.
            refineStaleVaultLookups(this.discussCurrentMessages, filePath);
            refineStaleVaultLookups(this.loreCoachMessages, filePath);
        }
    }

    /**
     * Event-driven context refinement: after a lore draft (propose_entry) is
     * accepted (saved) or discarded, compress the proposing turn so the verbatim
     * entry markdown leaves the model's context (the regurgitation source for
     * long-context models) and a compact outcome marker takes its place — the
     * durable "move-on" signal. Gated by `contextRefinementEnabled`. Idempotent.
     */
    refineOnLoreDraftResolved(
        plugin: EventideQuillPlugin,
        name: string,
        outcome: 'accepted' | 'discarded',
        savedPath?: string
    ): void {
        if (!plugin.settings.contextRefinementEnabled) return;
        refineProposeEntryOutcome(this.discussCurrentMessages, name, outcome, savedPath);
        refineProposeEntryOutcome(this.loreCoachMessages, name, outcome, savedPath);
    }

    /**
     * Budget-driven refinement pre-stage: when the setting is on, run
     * `refineForBudget` over `messages` targeting the compaction threshold
     * (`targetTokens` = threshold minus `extraTokens` — the token volume not
     * stored in `messages` but counted toward the threshold, e.g. injected
     * context heads + the pending user message at pre-send sites). The caller
     * re-measures afterward and may skip AI compaction entirely. Mutates the
     * array in place; idempotent. No-op when the setting is off.
     */
    refineForBudgetIfEnabled(plugin: EventideQuillPlugin, messages: ChatMessage[], targetTokens: number): void {
        if (!plugin.settings.contextRefinementEnabled) return;
        refineForBudget(messages, (msgs) => this.estimateRequestTokens(msgs), targetTokens);
    }

    /** Clear all pending lore edits (e.g., on reset / new chat). */
    clearLoreEdit(): void {
        if (this.app) {
            for (const filePath of this.loreEdits.keys()) {
                const view = findEditorView(this.app, filePath);
                if (view) {
                    const cm = (view.editor as unknown as { cm: EditorView }).cm;
                    if (cm) clearDiffEdits(cm, 'lore_edit');
                }
                this.closeLoreEditTabIfOpenedByTool(filePath);
            }
        }
        this.loreEdits.clear();
    }

    /**
     * Close the tab for a file IF the tool opened it (not if the writer had
     * it open already). Prevents a "full lorebook edit" from leaving a trail
     * of tabs behind while respecting tabs the writer opened themselves.
     */
    private closeLoreEditTabIfOpenedByTool(filePath: string): void {
        if (!this.app || !this.loreEditOpenedByTool.has(filePath)) return;
        this.loreEditOpenedByTool.delete(filePath);
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath) {
                leaf.detach();
                break;
            }
        }
    }

    /**
     * Get or create a per-file ChangeSet for pending lore edits. Each file
     * tracks its own ChangeSet and may hold MULTIPLE pending edits at once
     * (e.g. an insert_note plus an edit_note on the same character), so the
     * model can compose multi-step changes to one note without clobbering
     * earlier proposals. Edits for different files are independent.
     */
    getOrCreateLoreEdit(filePath: string, fileBasename: string): LoreEditEntry {
        let entry = this.loreEdits.get(filePath);
        if (!entry) {
            entry = { changeSet: new ChangeSet(), fileBasename, anchorMessageId: null };
            this.loreEdits.set(filePath, entry);
        }
        // Re-anchor to the current turn on every touch (latest semantics) so
        // the card follows the most recent edit rather than the first.
        entry.anchorMessageId = this.currentAnchorMessageId();
        return entry;
    }

    /**
     * Get or create a per-file proposed-images entry. Multiple images may
     * accumulate against the same file across rounds (e.g., a multi-form
     * character getting one image per form via separate `attach_lore_image`
     * calls); they share one review card per file.
     */
    getOrCreateProposedLoreImages(filePath: string, fileBasename: string): ProposedLoreImageEntry {
        let entry = this.proposedLoreImages.get(filePath);
        if (!entry) {
            entry = { fileBasename, images: [], anchorMessageId: null };
            this.proposedLoreImages.set(filePath, entry);
        }
        // Re-anchor to the current turn on every touch (latest semantics).
        entry.anchorMessageId = this.currentAnchorMessageId();
        return entry;
    }

    /** Clear all pending lore image attachments (e.g., on reset / new chat). */
    clearProposedLoreImages(): void {
        this.proposedLoreImages.clear();
    }

    /**
     * Push image bytes the model has just seen onto the recent-images ring
     * buffer. Called from the tool loop after every image-bearing tool
     * result and from the chat send paths when the writer pastes. Most-
     * recent first; trims to {@link RECENT_IMAGES_CAP}. No-op when empty.
     */
    pushRecentImages(images: string[]): void {
        if (images.length === 0) return;
        this.recentImages = [...images, ...this.recentImages].slice(0, CoWriterSession.RECENT_IMAGES_CAP);
    }

    /**
     * Resolve a `from_recent.index` reference to actual bytes from the
     * recent-images buffer. Returns null when the index is out of range
     * (the tool surfaces a clear error to the model in that case).
     */
    resolveRecentImage(index: number): string | null {
        return index >= 0 && index < this.recentImages.length ? (this.recentImages[index] ?? null) : null;
    }

    /** Clear the recent-images buffer (e.g., on reset / new chat). */
    clearRecentImages(): void {
        this.recentImages = [];
    }

    /**
     * Spawn and run a lorebook batch subagent. The subagent runs in its own
     * fresh context (isolated from this conversation), edits through the shared
     * {@link loreEdits} review queue via the tools' side effects, and returns a
     * short summary that becomes the `run_lorebook_batch` tool result the parent
     * sees. Registered in {@link subagents} so the stage-2 UI can show status
     * and drill into its internal conversation.
     *
     * Awaits completion — the parent conversation is blocked for the duration.
     * This is intentional and correct for local models (no concurrent
     * inference; the subagent runs serialized as a synchronous tool call), and
     * it's how the tool loop already treats any tool call. Aborts propagate:
     * the parent's signal aborting cancels the subagent's in-flight streams.
     */
    async runLorebookBatch(
        plugin: EventideQuillPlugin,
        provider: AiProvider,
        modelId: string,
        goal: string,
        paths: string[],
        parentSignal?: AbortSignal
    ): Promise<string> {
        const maxTokens = provider.config.maxContextTokens;

        // Resolve + size each file (cached reads). Unresolved paths are reported
        // back so the model/user can see which were skipped.
        const unresolved: string[] = [];
        const sized: { path: string; tokens: number }[] = [];
        for (const query of paths) {
            const file = resolveNoteFile(plugin, query);
            if (!file) {
                unresolved.push(query);
                continue;
            }
            const content = await plugin.app.vault.cachedRead(file);
            sized.push({ path: file.path, tokens: Math.ceil(content.length / 4) });
        }
        if (sized.length === 0) {
            return `Error: none of the requested files were found in the vault.${unresolved.length ? ` Missing: ${unresolved.join(', ')}` : ''}`;
        }

        // Chunk against the SUBAGENT's own fresh context (≈ the full window), NOT
        // the parent's remaining — the batch runs in the subagent, which starts
        // from ~zero. Pack file bodies to CHUNK_TARGET of the window per chunk;
        // the edit rounds (~2× body) plus output fit in the rest, with the
        // subagent's compaction as a safety net. Minimum one file per chunk.
        const CHUNK_TARGET = 0.5;
        const MAX_CHUNKS = 5;
        const chunks: string[][] = [];
        let cur: string[] = [];
        let curTokens = 0;
        for (const s of sized) {
            if (cur.length > 0 && curTokens + s.tokens > maxTokens * CHUNK_TARGET) {
                chunks.push(cur);
                cur = [];
                curTokens = 0;
            }
            cur.push(s.path);
            curTokens += s.tokens;
        }
        if (cur.length > 0) chunks.push(cur);

        const runChunks = chunks.slice(0, MAX_CHUNKS);
        const deferred = chunks.slice(MAX_CHUNKS).flat();

        // Lore batch subagents edit existing files — internal tools only, NO
        // run_lorebook_batch (single-level nesting) and NO propose_entry.
        const registry = createToolRegistry(plugin, false);
        if (registry && plugin.settings.loreEntryImageAttachments) {
            registry.register(attachLoreImageTool);
        }
        const batchSummaries: string[] = [];
        for (let i = 0; i < runChunks.length; i++) {
            const chunkPaths = runChunks[i]!;
            const fileList = `\n\nFiles in this batch (${chunkPaths.length}):\n${chunkPaths.map((p) => `- ${p}`).join('\n')}`;
            const sub = new SubagentSession(
                plugin,
                provider,
                modelId,
                {
                    kind: 'lore',
                    goal,
                    paths: chunkPaths,
                    systemPrompt: getLoreCoachSystemPrompt(),
                    brief: `Task: ${goal}${fileList}\n\nEdit the files in this batch per the rules above. vault_lookup each file, then edit_note / insert_note / append_to_note (revise_edit if you hit an overlap). Keep each edit surgical. End with a one- or two-line summary of what you changed.`,
                    registry
                },
                parentSignal
            );
            // Surface the subagent's per-round + status changes on the parent
            // panel so a drilled-in view streams and the status cards update
            // live (the parent's onChatUpdate push includes subagent state).
            sub.onChatUpdate = () => this.onChatUpdate?.();
            sub.onStatusChange = () => this.onChatUpdate?.();
            this.subagents.set(sub.id, sub);
            // Anchor this subagent's status card to the calling assistant turn
            // so it renders inline in the chat flow instead of stacking at the
            // bottom of the panel.
            this.attachSubagentToLastMessage(sub.id);
            this.onChatUpdate?.();
            const summary = await sub.run(); // throws AbortError on cancel → propagates, skips remaining chunks
            batchSummaries.push(`Batch ${i + 1}/${runChunks.length} (${chunkPaths.length} file(s)): ${summary}`);
            this.onChatUpdate?.();
        }

        const lines: string[] = [
            `Subagent processed ${sized.length} file(s) across ${runChunks.length} batch(es). Every edit is in the review queue for the writer to approve or reject — the cards persist after the subagent closes.`
        ];
        if (unresolved.length > 0) lines.push(`Skipped (not found): ${unresolved.join(', ')}`);
        lines.push(...batchSummaries);
        if (deferred.length > 0) {
            lines.push(
                `\n${deferred.length} file(s) deferred to bound this run. Call run_lorebook_batch again with: ` +
                    deferred.map((p) => `"${p}"`).join(', ')
            );
        }
        return lines.join('\n');
    }

    /**
     * Spawn a research subagent: investigates the vault for a single question
     * in its own fresh context and returns a cited findings report. Read-only —
     * no edits, no review queue. Registered in {@link subagents} so the panel
     * shows its status + drill-down like any subagent. Awaits completion (the
     * parent is blocked). Aborts propagate via the parent signal.
     */
    async runResearch(
        plugin: EventideQuillPlugin,
        provider: AiProvider,
        modelId: string,
        question: string,
        parentSignal?: AbortSignal
    ): Promise<string> {
        const config: SubagentConfig = {
            kind: 'research',
            goal: question,
            systemPrompt: getResearchSystemPrompt(),
            brief: `Question to investigate:\n\n${question}\n\nSearch the vault, gather evidence, and end with a cited findings report. You do not see the conversation that spawned you — work only from the question and the vault.`,
            registry: createReadOnlyToolRegistry(plugin, true)
        };
        return this.runSubagent(plugin, provider, modelId, config, parentSignal);
    }

    /**
     * Shared single-run subagent driver used by the non-chunked kind (research).
     * Creates the session, wires its UI callbacks, registers it,
     * runs it, and returns its summary. Throws AbortError on cancel (propagates
     * to the parent's cleanup); other failures come back as the summary string.
     */
    private async runSubagent(
        plugin: EventideQuillPlugin,
        provider: AiProvider,
        modelId: string,
        config: SubagentConfig,
        parentSignal?: AbortSignal
    ): Promise<string> {
        const sub = new SubagentSession(plugin, provider, modelId, config, parentSignal);
        sub.onChatUpdate = () => this.onChatUpdate?.();
        sub.onStatusChange = () => this.onChatUpdate?.();
        this.subagents.set(sub.id, sub);
        // Anchor this subagent's status card to the calling assistant turn so
        // it renders inline in the chat flow instead of stacking at the bottom.
        this.attachSubagentToLastMessage(sub.id);
        this.onChatUpdate?.();
        const summary = await sub.run();
        this.onChatUpdate?.();
        return summary;
    }

    /** Serializable snapshots of all subagents (status cards + drill-down views). */
    getSubagentViews(): SubagentView[] {
        // Live subagents first (fresh values()), then any restored views merged
        // in. Restored views are dormant (no live SubagentSession instance) —
        // they render + drill down read-only, with `running` forced to
        // `interrupted` at restore time.
        return [...this.subagents.values()].map((s) => s.toView()).concat(this.restoredSubagentViews);
    }

    /** Build the list of pending lore-edit card views (matching LoreEditCardView shape). */
    getLoreEditCardViews(): {
        edit: ProposedEdit;
        filePath: string;
        fileBasename: string;
        anchorMessageId: string | null;
    }[] {
        return [...this.loreEdits.entries()].flatMap(([filePath, entry]) =>
            entry.changeSet.edits
                .filter((e) => e.state === 'pending')
                .map((edit) => ({
                    edit,
                    filePath,
                    fileBasename: entry.fileBasename,
                    anchorMessageId: entry.anchorMessageId
                }))
        );
    }

    /** Build the list of pending lore-image-attachment card views (matching LoreImageCardView shape). */
    getLoreImageCardViews(): {
        filePath: string;
        fileBasename: string;
        images: ProposedImage[];
        anchorMessageId: string | null;
    }[] {
        return [...this.proposedLoreImages.entries()].map(([filePath, entry]) => ({
            filePath,
            fileBasename: entry.fileBasename,
            images: entry.images,
            anchorMessageId: entry.anchorMessageId
        }));
    }

    /** Drill down into a subagent's conversation (panel view switch). No-op if not found. */
    navigateToSubagent(id: string): void {
        if (!this.subagents.has(id)) return;
        this.activeSubagentId = id;
        this.onChatUpdate?.();
    }

    /** Return from a subagent drill-down to the parent conversation. */
    navigateToParent(): void {
        this.activeSubagentId = null;
        this.onChatUpdate?.();
    }

    /**
     * Force an immediate compaction of the conversation history,
     * regardless of the token threshold. Summarizes older turns into
     * a context head and fires updated token estimates.
     */
    async compactNow(plugin: EventideQuillPlugin): Promise<void> {
        if (this.discussCurrentMessages.length <= 1) return;

        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) return;

        const maxTokens = chat.provider.config.maxContextTokens;
        const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));

        try {
            const result = await compactConversation(chat.provider, this.discussCurrentMessages, sentenceCount, {
                signal: this.abortController?.signal
            });
            if (result) {
                this.discussCurrentMessages = result.messages;
                this.onTokenEstimate?.(this.estimateRequestBreakdown(this.discussCurrentMessages), maxTokens);
                this.onChatUpdate?.();
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            console.warn('Quill: Manual compaction failed, continuing without compaction.', err);
        }
    }

    /** Get compaction settings with safe defaults. */
    private settingsOrDefault(plugin: EventideQuillPlugin): {
        contextCompactAtPercent: number;
        compactSummarySentences: number;
    } {
        return {
            contextCompactAtPercent: plugin.settings.contextCompactAtPercent ?? 80,
            compactSummarySentences: plugin.settings.compactSummarySentences ?? 3
        };
    }

    /**
     * Phase 2: Apply a selected option by streaming the full continuation
     * into the editor at the cursor position.
     */
    async applyOption(plugin: EventideQuillPlugin, editor: Editor, optionIndex: number): Promise<void> {
        const option = this.currentOptions[optionIndex];
        if (!option) {
            new Notice('Quill: Invalid option selected.');
            return;
        }

        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        const filePath = this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: No manuscript path set. Try generating options first.');
            return;
        }

        // Cancel any in-flight generation
        this.cancelGeneration();
        this.app = plugin.app;

        // If the cursor sits at position 0 (document opened but not clicked
        // into), move it to the end so the continuation inserts at the end of
        // the written prose — matching the "continue this chapter" intent.
        // Any non-zero cursor position is the writer's intended insertion
        // point and is respected. Scroll to the new position only when we
        // actually moved it, mirroring generateOptions/generateDirect.
        const optionCursorWasAtZero = moveCursorToEndIfEarly(editor);
        const fullText = editor.getValue();
        if (optionCursorWasAtZero) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
        }
        // Read the cursor via editorCursorOffset (CM6 selection state) so an
        // inactive document still reports its real cursor — getCursor() can
        // report {0,0} when the sidebar has focus.
        const cursorOffset = editorCursorOffset(editor);

        // Extract recent prose for voice analysis
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseParts = textBeforeCursor.split(/\n\s*\n/);
        const recentProse: string[] = [];
        let proseLen = 0;
        for (let i = proseParts.length - 1; i >= 0 && proseLen < 3000; i--) {
            const part = proseParts[i]?.trim();
            if (part && part.length > 0) {
                recentProse.unshift(part);
                proseLen += part.length;
            }
        }
        const recentProseText = recentProse.join('\n\n').slice(-3000);

        // Analyze voice if needed
        if (plugin.settings.coWriterVoiceMatch && (!this.voiceProfile || this.voiceProfileFile !== filePath)) {
            const profile = await this.analyzeVoice(chat.provider, chat.modelId, recentProseText);
            if (profile) {
                this.voiceProfile = profile;
                this.voiceProfileFile = filePath;
            }
        }

        // Build vault context
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';

        // Build additional context from user-added files
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        const plotMapText = await loadPlotMapText(plugin);
        const applySteering = inlineSteering(plugin, textBeforeCursor);

        const systemPrompt = getCoWriterGenerationPrompt(
            this.voiceProfile ?? {
                sentenceLengthDistribution: 'unknown',
                dialogueRatio: 0.5,
                vocabularyRegister: 'unknown',
                keyPatterns: []
            },
            plugin.settings.narrativeVoicePreset,
            vaultContext,
            applySteering,
            plotMapText,
            plugin.settings.wikiLinkBehavior
        );

        // When the cursor sits mid-document, the continuation is INSERTED
        // before the prose that follows — surface that following prose so the
        // model can write a continuation that leads into it naturally. Empty
        // (and so omitted) when the cursor is at the end of the document.
        const afterCursor = fullText.slice(cursorOffset).slice(0, 4000).trim();
        const afterCursorSection = afterCursor
            ? [
                  '',
                  '--- Document after the cursor (your continuation will be inserted before this — lead into it naturally) ---',
                  afterCursor
              ].join('\n')
            : '';

        const userMessage = [
            `Continue the passage from the cursor position following this direction: ${option.label} — ${option.description}`,
            '',
            'Write the next paragraph or paragraphs in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation, plain and without labels or explanations.',
            '',
            '--- Current document up to cursor ---',
            textBeforeCursor.slice(-8000),
            afterCursorSection
        ].join('\n');

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...additionalContextMessages,
            ...this.discussContextMessages(),
            { role: 'user', content: userMessage }
        ];

        // Set up streaming — applyOption (preview-diff)
        this.abortController = new AbortController();
        this.thoughtBuffer = '';
        this.directChanges.clear();
        const applyEdit = this.directChanges.add({
            from: cursorOffset,
            to: cursorOffset,
            newText: '',
            label: option.label
        });
        // 'generating' hides Approve/Reject while streaming; flipped to 'pending'
        // once the result is final.
        applyEdit.state = 'generating';
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        this.onChatUpdate?.();

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            this.directChanges.clear();
            this.abortController = null;
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            return;
        }
        syncChangeSetPositions(cm, this.directChanges, 'direct');
        pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));

        const notice = Platform.isMobile
            ? new Notice('Quill: Continuing (mobile \u2014 this may take a moment). Keep the app in focus...', 0)
            : new Notice('Quill: Continuing...', 0);

        try {
            const stream = chat.provider.chatCompletion({
                messages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: plugin.settings.coWriterMaxOutputTokens,
                signal: this.abortController.signal
            });

            for await (const chunk of stream) {
                if (chunk.done) break;
                if (chunk.thought) {
                    this.thoughtBuffer += chunk.thought;
                    this.onThought?.(this.thoughtBuffer);
                }
                if (!chunk.text) continue;
                applyEdit.newText += sanitizeProse(chunk.text);
                syncChangeSetPositions(cm, this.directChanges, 'direct');
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
                this.onDirectChangeUpdate?.();
            }

            if (plugin.settings.coWriterAppendNewline) {
                applyEdit.newText = `${applyEdit.newText.replace(/\s+$/, '')}\n`;
            }

            if (applyEdit.newText.replace(/\s+$/, '').length === 0) {
                new Notice('Quill: Received empty response from the AI provider.');
                this.directChanges.clear();
                clearDiffEdits(cm, 'direct');
            } else {
                applyEdit.state = 'pending';
                syncChangeSetPositions(cm, this.directChanges, 'direct');
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                if (applyEdit.newText.replace(/\s+$/, '').length === 0) {
                    this.directChanges.clear();
                    clearDiffEdits(cm, 'direct');
                } else {
                    applyEdit.state = 'pending';
                    syncChangeSetPositions(cm, this.directChanges, 'direct');
                    pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
                }
            } else {
                new Notice(`Quill: Continuation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
                this.directChanges.clear();
                clearDiffEdits(cm, 'direct');
            }
        } finally {
            notice.hide();
            // If a pending diff remains in the editor, keep optionsLoading true so
            // the Apply buttons stay disabled until the user approves or rejects
            // the continuation. This prevents co-simultaneous apply streams from
            // blending in the editor. approveDirectChange / rejectDirectChange
            // (or the error / empty paths below) are responsible for resetting it.
            const hasPending = applyEdit.state === 'pending';
            this.optionsLoading = hasPending;
            this.onOptionsLoading?.(hasPending);
            this.onDirectChangeUpdate?.();
            this.onChatUpdate?.();
        }
    }

    /**
     * Direct mode: stream a continuation into the editor from the cursor
     * position, following the given direction.  No options phase.
     */
    async generateDirect(
        plugin: EventideQuillPlugin,
        direction: string,
        extraSteering?: ActiveSteering[]
    ): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        notifyMobileStreamRisk();

        // Resolve manuscript file
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: Open a manuscript to use the co-writer.');
            return;
        }
        this.manuscriptPath = filePath;

        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
            new Notice('Quill: Open a manuscript editor to use the co-writer.');
            return;
        }
        const editor = markdownView.editor;

        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        this.app = plugin.app;
        this.currentOptions = [];

        const fullText = editor.getValue();
        // Respect the writer's cursor position whether or not a direction was
        // given — only fall back to end-of-document when the cursor is at
        // position 0 (document opened but never clicked into). Previously the
        // empty-direction path moved the cursor to end unconditionally, which
        // hijacked a deliberately placed cursor. Scroll to the new position
        // only when we actually moved it.
        const directCursorWasAtZero = moveCursorToEndIfEarly(editor);
        if (directCursorWasAtZero) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
        }
        // Read the cursor via editorCursorOffset (CM6 selection state) so an
        // inactive document still reports its real cursor.
        const cursorOffset = editorCursorOffset(editor);

        this.pushChatMessage({
            role: 'user',
            content: direction || 'Continue the passage naturally from the cursor position.'
        });

        // Extract recent prose for voice analysis
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseParts = textBeforeCursor.split(/\n\s*\n/);
        const recentProse: string[] = [];
        let proseLen = 0;
        for (let i = proseParts.length - 1; i >= 0 && proseLen < 3000; i--) {
            const part = proseParts[i]?.trim();
            if (part && part.length > 0) {
                recentProse.unshift(part);
                proseLen += part.length;
            }
        }
        const recentProseText = recentProse.join('\n\n').slice(-3000);

        if (plugin.settings.coWriterVoiceMatch && (!this.voiceProfile || this.voiceProfileFile !== filePath)) {
            const profile = await this.analyzeVoice(chat.provider, chat.modelId, recentProseText);
            if (profile) {
                this.voiceProfile = profile;
                this.voiceProfileFile = filePath;
            }
        }

        // Build vault context
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';

        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        const plotMapText = await loadPlotMapText(plugin);
        const directSteering = [...inlineSteering(plugin, textBeforeCursor), ...(extraSteering ?? [])];

        const systemPrompt = getCoWriterGenerationPrompt(
            this.voiceProfile ?? {
                sentenceLengthDistribution: 'unknown',
                dialogueRatio: 0.5,
                vocabularyRegister: 'unknown',
                keyPatterns: []
            },
            plugin.settings.narrativeVoicePreset,
            vaultContext,
            directSteering,
            plotMapText,
            plugin.settings.wikiLinkBehavior
        );

        const proseForContext = textBeforeCursor.slice(-12000);
        // When the cursor sits mid-document, the continuation is INSERTED
        // before the prose that follows — surface that following prose so the
        // model can lead into it naturally. Empty when the cursor is at EOF.
        const afterCursor = fullText.slice(cursorOffset).slice(0, 4000).trim();
        const afterCursorSection = afterCursor
            ? [
                  '',
                  '--- Document after the cursor (your continuation will be inserted before this — lead into it naturally) ---',
                  afterCursor
              ].join('\n')
            : '';

        // Parse stopping point from direction
        const stoppingPoint = direction ? parseStoppingPoint(direction) : null;
        const stoppingPointInstruction = stoppingPoint?.instruction ?? '';

        const userMessage = direction
            ? [
                  `Continue the passage from the cursor position following this direction: ${direction}`,
                  stoppingPointInstruction ? `\n${stoppingPointInstruction}` : '',
                  'Write the next paragraph or paragraphs in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation, plain and without labels or explanations.',
                  '',
                  '--- Current document up to cursor ---',
                  proseForContext,
                  afterCursorSection
              ].join('\n')
            : [
                  'Continue the passage naturally from the cursor position.',
                  '',
                  'Read the document up to the cursor and continue writing in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation, plain and without labels or explanations.',
                  '',
                  '--- Current document up to cursor ---',
                  proseForContext,
                  afterCursorSection
              ].join('\n');

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...additionalContextMessages,
            ...this.discussContextMessages(),
            { role: 'user', content: userMessage }
        ];

        // Set up streaming — generateDirect (preview-diff)
        this.abortController = new AbortController();
        this.thoughtBuffer = '';
        this.directChanges.clear();
        const directEdit = this.directChanges.add({
            from: cursorOffset,
            to: cursorOffset,
            newText: '',
            label: direction ? `Continue: ${direction.slice(0, 80)}` : 'Continuation'
        });
        // 'generating' hides Approve/Reject until the stream concludes or is
        // cancelled; flipped to 'pending' below once there is a final result.
        directEdit.state = 'generating';

        this.onOptionsLoading?.(true);
        this.onChatUpdate?.();

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            this.directChanges.clear();
            this.abortController = null;
            this.onOptionsLoading?.(false);
            return;
        }
        syncChangeSetPositions(cm, this.directChanges, 'direct');
        pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));

        const notice = Platform.isMobile
            ? new Notice('Quill: Continuing (mobile \u2014 this may take a moment). Keep the app in focus...', 0)
            : new Notice('Quill: Continuing...', 0);

        try {
            const stream = chat.provider.chatCompletion({
                messages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: plugin.settings.coWriterMaxOutputTokens,
                signal: this.abortController.signal
            });

            for await (const chunk of stream) {
                if (chunk.done) break;
                if (chunk.thought) {
                    this.thoughtBuffer += chunk.thought;
                    this.onThought?.(this.thoughtBuffer);
                }
                if (!chunk.text) continue;
                // Stream into the preview widget (the document is not modified
                // during generation). Approve commits; Reject discards.
                directEdit.newText += sanitizeProse(chunk.text);
                syncChangeSetPositions(cm, this.directChanges, 'direct');
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
                this.onDirectChangeUpdate?.();
            }

            // Stopping-point enforcement on the buffered text.
            if (stoppingPoint && directEdit.newText.length > 0) {
                if (!respectsStoppingPoint(directEdit.newText, stoppingPoint.instruction)) {
                    if (__DEV__ && plugin.settings.enableDebugLogging) {
                        console.warn('[Quill Co-writer] Content exceeded stopping point, truncating');
                    }
                    const truncated = truncateToStoppingPoint(directEdit.newText, stoppingPoint.instruction);
                    if (truncated.length < directEdit.newText.length) {
                        directEdit.newText = truncated;
                    }
                }
            }

            if (plugin.settings.coWriterAppendNewline) {
                directEdit.newText = `${directEdit.newText.replace(/\s+$/, '')}\n`;
            }

            if (directEdit.newText.replace(/\s+$/, '').length === 0) {
                new Notice('Quill: Received empty response from the AI provider.');
                this.directChanges.clear();
                clearDiffEdits(cm, 'direct');
            } else {
                directEdit.state = 'pending';
                syncChangeSetPositions(cm, this.directChanges, 'direct');
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                // Keep partial prose as a reviewable change; clear only if empty.
                if (directEdit.newText.replace(/\s+$/, '').length === 0) {
                    this.directChanges.clear();
                    clearDiffEdits(cm, 'direct');
                } else {
                    directEdit.state = 'pending';
                    syncChangeSetPositions(cm, this.directChanges, 'direct');
                    pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
                }
            } else {
                new Notice(`Quill: Continuation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
                this.directChanges.clear();
                clearDiffEdits(cm, 'direct');
            }
        } finally {
            notice.hide();
            const hasPending = this.directChanges.hasPending;
            this.optionsLoading = hasPending;
            this.onOptionsLoading?.(hasPending);
            this.onDirectChangeUpdate?.();
            this.onChatUpdate?.();
        }
    }

    /**
     * Write a prose continuation based on the current coach session state.
     * Skips further Q&A and goes straight to generation, injecting the coaching
     * context (summary, plan, discussion) into the direction.
     */
    async coachWrite(plugin: EventideQuillPlugin): Promise<void> {
        const coachSteering: ActiveSteering[] = this.coachSession
            ? [{ source: 'coach', text: this.coachSession.summary || this.coachSession.response }]
            : [];
        const direction = this.coachSession
            ? this.coachSession.phase === 'direction' || this.coachSession.phase === 'plan'
                ? 'Write the scene following the coaching plan.'
                : 'Write the next part of the scene based on what you know so far.'
            : 'Continue the passage naturally from the cursor position.';

        await this.generateDirect(plugin, direction, coachSteering);
    }

    /**
     * Build context messages from the discussion history for injection
     * into direct/option/generate prompts. When a prior discussion exists,
     * its turns are included as context so the AI can reference what was
     * discussed when generating continuation text.
     */
    private discussContextMessages(): ChatMessage[] {
        if (this.discussCurrentMessages.length <= 1) return [];
        const messages: ChatMessage[] = [];
        for (const msg of this.discussCurrentMessages) {
            if (msg.role === 'system') continue;
            messages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            });
        }
        if (messages.length === 0) return [];
        return [
            {
                role: 'system',
                content:
                    'The following is a discussion the writer had with their editor about the scene they are now continuing. Use this context to inform the continuation.'
            },
            ...messages
        ];
    }

    /** Lock the manuscript editor so the user cannot modify it during generation. */
    private lockEditor(): void {
        if (!this.app || !this.manuscriptPath) return;
        const markdownView = findEditorView(this.app, this.manuscriptPath);
        if (!markdownView) return;
        const cm = (markdownView.editor as unknown as { cm: EditorView }).cm;
        if (!cm) return;
        cm.contentDOM.setAttribute('contenteditable', 'false');
    }

    /** Unlock the manuscript editor after generation completes. */
    private unlockEditor(): void {
        if (!this.app || !this.manuscriptPath) return;
        const markdownView = findEditorView(this.app, this.manuscriptPath);
        if (!markdownView) return;
        const cm = (markdownView.editor as unknown as { cm: EditorView }).cm;
        if (!cm) return;
        cm.contentDOM.setAttribute('contenteditable', 'true');
    }

    /** Cancel any in-flight API call. If no generation is in flight but a pending
     *  Direct continuation is awaiting review, reject it so the panel unlocks. */
    cancelGeneration(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this.directChanges.hasPending) {
            this.directChanges.clear();
            const cm = this.getManuscriptCm();
            if (cm) clearDiffEdits(cm, 'direct');
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onDirectChangeUpdate?.();
            this.onChatUpdate?.();
        }
    }

    /** Add a context file to the session. */
    addContextFile(filePath: string): void {
        if (!this.contextFilePaths.includes(filePath)) {
            this.contextFilePaths.push(filePath);
        }
    }

    /** Remove a context file from the session. */
    removeContextFile(filePath: string): void {
        this.contextFilePaths = this.contextFilePaths.filter((p) => p !== filePath);
    }

    /** Get the list of additional context file paths. */
    getContextFiles(): string[] {
        return [...this.contextFilePaths];
    }

    /** Clear voice profile cache (e.g., on document change). */
    clearVoiceProfile(): void {
        this.voiceProfile = null;
        this.voiceProfileFile = null;
    }

    /**
     * Wrap {@link prepareUserMessageWithImages} with a "describing image…"
     * signal so the panel can show a dedicated state during the Regime B proxy
     * caption call. The signal fires only under the proxy regime (text-only
     * chat model + separate image model), not under native (where pixels just
     * attach to the message with no extra round-trip). The "off" signal fires
     * in a `finally` so the indicator clears even if the proxy call fails or is
     * aborted (in which case prepareUserMessageWithImages returns a placeholder).
     */
    private async prepareImageMessage(
        plugin: EventideQuillPlugin,
        text: string,
        images: string[] | undefined,
        signal: AbortSignal | undefined
    ): Promise<PreparedUserMessage> {
        const imgs = images ?? [];
        if (imgs.length === 0) return { content: text };
        // Buffer the pasted bytes so the model can reference them via
        // `from_recent` in propose_entry / attach_lore_image ("attach the
        // image the writer just pasted"). Done BEFORE regime routing so
        // the buffer holds the original bytes regardless of whether the
        // chat model is vision-native (Regime A) or text-only (Regime B).
        this.pushRecentImages(imgs);
        const proxy = getImageRegime(plugin) === 'proxy';
        if (proxy) this.onDescribingImages?.(true);
        try {
            return await prepareUserMessageWithImages(plugin, text, imgs, signal);
        } finally {
            if (proxy) this.onDescribingImages?.(false);
        }
    }

    /**
     * Drop all subagent sessions and exit any drill-down view. Called from
     * {@link resetChat} (new chat) and on every mode switch (via
     * `clearCoWriterSubagents`), since a subagent queued for one mode shouldn't
     * follow the writer into another. Any in-flight subagent is already
     * aborted by `cancelGeneration` (which the caller has run, or will run);
     * the sessions hold no further resources to release.
     */
    clearSubagents(): void {
        this.subagents.clear();
        this.restoredSubagentViews = [];
        this.activeSubagentId = null;
        // Strip the now-dangling subagent references from chat messages so the
        // panel doesn't keep an inline card slot whose subagent is gone (the
        // card would simply not render, but tidying avoids confusion and keeps
        // a restored/saved history clean).
        for (const msg of this.chatHistory) {
            if (msg.subagentIds?.length) {
                msg.subagentIds = undefined;
            }
        }
        this.onChatUpdate?.();
    }

    /** Reset the entire session including coach and context. */
    reset(): void {
        this.unlockEditor();
        this.cancelGeneration();
        this.endCoachSession();
        this.endLoreCoachSession();
        this.clearFulfill();
        this.clearDirect();
        this.clearLoreEdit();
        this.clearProposedLoreImages();
        this.clearRecentImages();
        this.clearSubagents();
        this.manuscriptPath = null;
        this.originalText = '';
        this.insertionStart = -1;
        this.insertionLength = 0;
        this.draftState = 'idle';
        this.voiceProfile = null;
        this.voiceProfileFile = null;
        this.contextFilePaths = [];
        this.thoughtBuffer = '';
        this.chatHistory = [];
        this.currentOptions = [];
        this.optionsLoading = false;
        this.onChatUpdate?.();
        this.onOptionsLoading?.(false);
    }

    /**
     * Reset only the chat-related state, preserving manuscript path,
     * voice profile, and (optionally) additional context files for reuse.
     *
     * @param clearContext When true, also clears additional context files
     *                     added via the ± button. Defaults to false.
     */
    resetChat(clearContext = false): void {
        this.unlockEditor();
        this.cancelGeneration();
        this.endCoachSession();
        this.endLoreCoachSession();
        this.clearFulfill();
        this.clearDirect();
        this.clearLoreEdit();
        this.clearProposedLoreImages();
        this.clearRecentImages();
        this.clearSubagents();
        this.originalText = '';
        this.insertionStart = -1;
        this.insertionLength = 0;
        this.draftState = 'idle';
        if (clearContext) {
            this.contextFilePaths = [];
        }
        this.thoughtBuffer = '';
        this.chatHistory = [];
        this.currentOptions = [];
        this.optionsLoading = false;
        this.onChatUpdate?.();
        this.onOptionsLoading?.(false);
    }

    /**
     * Snapshot the session's serializable state for persistence. `mode` is the
     * co-writer mode active at snapshot time (the session doesn't own it; the
     * caller passes it in from the panel). Ephemeral runtime concerns
     * (AbortController, callbacks, editor locks, write queues) are omitted.
     * {@link restoreState} is the inverse.
     *
     * Returns a DEEP CLONE: callers fire-and-forget the write (e.g. before
     * `resetChat`), so the returned object must not share references with the
     * live session — a synchronous reset following the snapshot call mutates
     * the live message objects (e.g. `clearSubagents` strips `subagentIds`),
     * which would otherwise corrupt the in-flight serialization.
     */
    snapshotState(mode: string): SerializedCoWriterState {
        const snapshot: SerializedCoWriterState = {
            mode,
            reviewEngine: this.reviewEngine,
            chatHistory: this.chatHistory,
            discussCurrentMessages: this.discussCurrentMessages,
            loreCoachMessages: this.loreCoachMessages,
            manuscriptPath: this.manuscriptPath,
            voiceProfile: this.voiceProfile,
            contextFilePaths: this.contextFilePaths,
            recentImages: this.recentImages,
            fulfillChanges: this.fulfillChanges.toJSON(),
            directChanges: this.directChanges.toJSON(),
            loreEdits: [...this.loreEdits.entries()].map(([filePath, entry]) => [
                filePath,
                {
                    changeSet: entry.changeSet.toJSON(),
                    fileBasename: entry.fileBasename,
                    anchorMessageId: entry.anchorMessageId
                }
            ]),
            proposedLoreImages: [...this.proposedLoreImages.entries()].map(([filePath, entry]) => [
                filePath,
                {
                    fileBasename: entry.fileBasename,
                    images: entry.images,
                    anchorMessageId: entry.anchorMessageId
                }
            ]),
            subagents: this.getSubagentViews(),
            activeSubagentId: this.activeSubagentId,
            coachSession: this.coachSession,
            coachActive: this.coachActive,
            loreCoachSession: this.loreCoachSession,
            loreCoachActive: this.loreCoachActive,
            currentLoreDraft: this.currentLoreDraft,
            currentOptions: this.currentOptions
        };
        // The state is JSON by construction; a JSON round-trip deep-clones it
        // (arrays, plain objects, base64 strings) so later live mutations don't
        // leak into the in-flight persistence write.
        return JSON.parse(JSON.stringify(snapshot)) as SerializedCoWriterState;
    }

    /**
     * Restore serializable state from a snapshot. Overwrites the data fields
     * without invoking the reset/clear methods (which have CM-diff / tab-close
     * / abort side effects). Ephemeral fields (callbacks, AbortController,
     * `app`) are left null/zeroed and rebind via `wireCoWriterPanel()` on the
     * next entry point. Returns the stored mode so the caller can re-apply it
     * to the panel. Subagents are restored as dormant views (no live session);
     * any that were still `running` are forced to `interrupted`.
     */
    restoreState(state: SerializedCoWriterState): string {
        // Drop any in-flight generation before overwriting (no-op if idle).
        this.cancelGeneration();

        this.chatHistory = state.chatHistory;
        // Restart the message-id counter above the highest restored id so a
        // continued conversation doesn't collide with restored anchors.
        this.nextMessageId = this.chatHistory.reduce((max, m) => {
            const n = Number.parseInt(m.id.replace(/^msg_/, ''), 10);
            return Number.isFinite(n) ? Math.max(max, n) : max;
        }, 0);
        this.discussCurrentMessages = stubDanglingToolCalls(state.discussCurrentMessages);
        this.loreCoachMessages = stubDanglingToolCalls(state.loreCoachMessages);
        this.manuscriptPath = state.manuscriptPath;
        this.reviewEngine = state.reviewEngine ?? null;
        this.voiceProfile = state.voiceProfile;
        this.contextFilePaths = state.contextFilePaths;
        this.recentImages = state.recentImages;
        this.fulfillChanges = ChangeSet.fromJSON(state.fulfillChanges);
        this.directChanges = ChangeSet.fromJSON(state.directChanges);
        this.loreEdits = new Map(
            state.loreEdits.map(([filePath, entry]) => [
                filePath,
                {
                    changeSet: ChangeSet.fromJSON(entry.changeSet),
                    fileBasename: entry.fileBasename,
                    anchorMessageId: entry.anchorMessageId
                }
            ])
        );
        this.proposedLoreImages = new Map(
            state.proposedLoreImages.map(([filePath, entry]) => [
                filePath,
                {
                    fileBasename: entry.fileBasename,
                    images: entry.images,
                    anchorMessageId: entry.anchorMessageId
                }
            ])
        );
        // Subagents restore as dormant views; `running` → `interrupted`.
        this.subagents = new Map();
        this.restoredSubagentViews = state.subagents.map((s) =>
            s.status === 'running' ? { ...s, status: 'interrupted' } : s
        );
        this.activeSubagentId = this.restoredSubagentViews.some((s) => s.id === state.activeSubagentId)
            ? state.activeSubagentId
            : null;
        this.coachSession = state.coachSession;
        this.coachActive = state.coachActive;
        this.loreCoachSession = state.loreCoachSession;
        this.loreCoachActive = state.loreCoachActive;
        this.currentLoreDraft = state.currentLoreDraft;
        this.currentOptions = state.currentOptions;
        // Transient — not restored.
        this.optionsLoading = false;
        this.draftState = 'idle';
        this.thoughtBuffer = '';

        this.onChatUpdate?.();
        return state.mode;
    }

    /**
     * Whether a display message can be rewound to. A message is rewindable iff
     * its id still appears as a `quillAnchorId` in the active mode's API array
     * — i.e. the model still holds that turn verbatim. Turns that were folded
     * into a compaction summary lose their anchor id and are NOT rewindable
     * (rewinding them can't unwind the model's summarized memory). The options
     * flow's display messages (never pushed to the API array) are also
     * non-rewindable. Only meaningful for user messages (the only bubbles that
     * offer the action).
     */
    isRewindableMessage(id: string, mode: string): boolean {
        const arr = mode === 'lorebook' ? this.loreCoachMessages : this.discussCurrentMessages;
        return arr.some((m) => m.quillAnchorId === id);
    }

    /**
     * Rewind the conversation to BEFORE the user message with `id` ("undo this
     * send"): discard that message and everything after it from the display
     * (`chatHistory`) and from the model's API array, and drop any reviewable
     * artifacts (subagents, pending lore edits, proposed images, lore draft)
     * anchored to discarded messages. The API array is truncated in lockstep via
     * `quillAnchorId` so the model genuinely forgets the discarded turns (its
     * array ends on the assistant turn before the rewound message — well-formed).
     * Then the mode phase is re-evaluated from the surviving history. The
     * caller pre-fills the input with the discarded message's text so the
     * writer can edit and resend.
     */
    rewindToMessage(id: string, mode: string): void {
        const k = this.chatHistory.findIndex((m) => m.id === id);
        if (k < 0) return;
        const discardedText = this.chatHistory[k]?.content ?? '';
        const kept = this.chatHistory.slice(0, k); // exclusive: drop the target + everything after
        const keptIds = new Set(kept.map((m) => m.id));

        this.chatHistory = kept;
        // Restart the message-id counter above the highest kept id so continued
        // conversation doesn't collide with surviving anchors.
        this.nextMessageId = kept.reduce((max, m) => {
            const n = Number.parseInt(m.id.replace(/^msg_/, ''), 10);
            return Number.isFinite(n) ? Math.max(max, n) : max;
        }, 0);

        // Truncate the model's API array: keep system/context-head messages
        // (no quillAnchorId) + any message anchored to a surviving display turn.
        const truncateApi = (arr: ChatMessage[]): ChatMessage[] =>
            arr.filter((m) => !m.quillAnchorId || keptIds.has(m.quillAnchorId));
        this.discussCurrentMessages = truncateApi(this.discussCurrentMessages);
        this.loreCoachMessages = truncateApi(this.loreCoachMessages);

        // Drop reviewable artifacts anchored to discarded messages.
        // Subagents: keep only those still referenced by a surviving message.
        const referencedSubIds = new Set<string>();
        for (const m of this.chatHistory) {
            for (const sid of m.subagentIds ?? []) referencedSubIds.add(sid);
        }
        for (const sid of [...this.subagents.keys()]) {
            if (!referencedSubIds.has(sid)) this.subagents.delete(sid);
        }
        this.restoredSubagentViews = this.restoredSubagentViews.filter((s) => referencedSubIds.has(s.id));
        if (this.activeSubagentId && !referencedSubIds.has(this.activeSubagentId)) {
            this.activeSubagentId = null;
        }
        // Pending lore edits / proposed images: drop entries anchored to gone messages.
        for (const filePath of [...this.loreEdits.keys()]) {
            const entry = this.loreEdits.get(filePath);
            if (entry?.anchorMessageId && !keptIds.has(entry.anchorMessageId)) {
                this.loreEdits.delete(filePath);
            }
        }
        for (const filePath of [...this.proposedLoreImages.keys()]) {
            const entry = this.proposedLoreImages.get(filePath);
            if (entry?.anchorMessageId && !keptIds.has(entry.anchorMessageId)) {
                this.proposedLoreImages.delete(filePath);
            }
        }
        // Lore draft: re-derive from the last surviving message that carries one.
        this.currentLoreDraft = null;
        for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            if (this.chatHistory[i]?.loreDraft) {
                this.currentLoreDraft = this.chatHistory[i]!.loreDraft ?? null;
                break;
            }
        }

        this.reevaluateModePhase(mode);
        // Prefer the per-turn phase snapshot from the latest surviving
        // assistant message — it's the authoritative post-turn phase, recorded
        // live. The heuristic above rebuilds the surrounding session fields
        // (response, summary, clarifyRound, scope, rounds) but its phase value
        // is a lossy reconstruction (the coach clarify-round replay can drift;
        // the lorebook heuristic can't distinguish a later-rejected draft from
        // a live one). Only the phase is overridden here.
        this.applyPhaseSnapshot(mode);

        this.optionsLoading = false;
        this.thoughtBuffer = '';
        this.onChatUpdate?.();
        this.onLoreEditUpdate?.();
        this.onProposedLoreImagesUpdate?.();
        void discardedText; // returned to caller via main.ts input pre-fill
    }

    /**
     * Re-derive the coach / lorebook mode-session phase from the surviving
     * `chatHistory` after a rewind (the stored phase was advanced past the cut
     * point and is now stale). Mirrors the same heuristics the live flow uses to
     * ADVANCE phase, replayed over the kept assistant turns. Discuss mode has no
     * phase state, so it is a no-op. Run at rewind time so the phase indicator
     * is correct immediately (idempotent if re-run on the next send).
     */
    private reevaluateModePhase(mode: string): void {
        if (mode === 'coach') {
            this.reevaluateCoachPhase();
        } else if (mode === 'lorebook') {
            this.reevaluateLoreCoachPhase();
        }
    }

    /** Replay the coach phase machine over kept assistant turns. */
    private reevaluateCoachPhase(): void {
        const firstUser = this.chatHistory.find((m) => m.role === 'user');
        const assistantTurns = this.chatHistory.filter((m) => m.role === 'assistant');
        if (assistantTurns.length === 0) {
            // No AI response yet → back to the discern/intent phase.
            this.coachSession = firstUser
                ? {
                      phase: 'discern',
                      response: '',
                      summary: '',
                      isFirstTurn: true,
                      clarifyRound: 0
                  }
                : null;
            this.coachActive = !!this.coachSession;
            return;
        }
        // Replay the advance heuristic (mirrors the live flow): start at discern,
        // then for each assistant turn advance per the askedQuestions rule.
        let phase: CoachPhase = 'discern';
        let clarifyRound = 0;
        let lastResponse = '';
        for (const turn of assistantTurns) {
            lastResponse = turn.content;
            const askedQuestions = turn.content.includes('?');
            if (phase === 'discern') {
                phase = 'clarify';
                clarifyRound = 1;
            } else if (phase === 'clarify') {
                if (askedQuestions && clarifyRound < 2) {
                    clarifyRound++;
                } else {
                    phase = 'plan';
                }
            } else if (phase === 'plan') {
                phase = 'direction';
            }
        }
        this.coachSession = {
            phase,
            response: lastResponse,
            summary: phase === 'direction' ? lastResponse : (this.coachSession?.summary ?? ''),
            isFirstTurn: false,
            clarifyRound
        };
        this.coachActive = true;
    }

    /** Re-derive the lorebook coach phase/scope/rounds from kept history. */
    private reevaluateLoreCoachPhase(): void {
        const userTurns = this.chatHistory.filter((m) => m.role === 'user');
        const scope = this.loreCoachSession?.scope ?? userTurns[0]?.content ?? '';
        const rounds = userTurns.length;
        const hasDraft = this.chatHistory.some((m) => m.loreDraft);
        const entryType = hasDraft ? (this.currentLoreDraft?.entryType ?? null) : null;
        const phase: LoreCoachPhase = hasDraft ? 'refine' : rounds > 1 ? 'develop' : 'discover';
        this.loreCoachSession = { phase, scope, entryType, rounds };
        this.loreCoachActive = true;
    }

    /**
     * Override the mode-session phase with the latest surviving assistant
     * turn's {@link CoWriterChatMessage.phaseSnapshot}, if one exists for the
     * current mode. {@link reevaluateModePhase} has already rebuilt the
     * surrounding session object (response, summary, clarifyRound, scope,
     * rounds); only the phase value is corrected here. No-op for discuss
     * mode, for histories with no snapshots (pre-snapshot sidecars / user-only
     * histories → the heuristic phase stands), and when the latest snapshot
     * isn't a legal value for the current mode (defensive — coach and lorebook
     * turns never coexist in one chatHistory because crossing into/out of
     * lorebook resets chat, but the membership check guards against drift).
     */
    private applyPhaseSnapshot(mode: string): void {
        if (mode !== 'coach' && mode !== 'lorebook') return;
        const legal = mode === 'coach' ? COACH_PHASES : LORE_PHASES;
        for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            const msg = this.chatHistory[i];
            const snapshot = msg?.role === 'assistant' ? msg.phaseSnapshot : undefined;
            if (snapshot !== undefined && legal.has(snapshot)) {
                if (mode === 'coach' && this.coachSession) {
                    this.coachSession.phase = snapshot as CoachPhase;
                } else if (mode === 'lorebook' && this.loreCoachSession) {
                    this.loreCoachSession.phase = snapshot as LoreCoachPhase;
                }
                return;
            }
        }
    }
}
