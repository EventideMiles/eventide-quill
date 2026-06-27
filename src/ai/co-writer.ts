import { App, Editor, Notice, Platform } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type EventideQuillPlugin from '../main';
import { type VoiceProfile } from '../types';
import { findEditorView } from '../utils/find-editor';
import { AiProvider, type ChatMessage, type ToolCallRequest, type ToolDefinition } from './provider';
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
    type ActiveSteering
} from './prompts';
import { compactConversation } from './compaction';
import { estimateTokens } from '../utils/tokens';
import { readVaultFiles, readVaultFileText } from '../utils/vault-files';
import { parseDirectives, parseAllDirectives } from '../utils/directives';
import { EmbeddingCache, rankBySimilarity } from './embedding-cache';
import { parseProviderKey } from './provider-registry';
import { parseEmbedFolderPath, loreFolderEmbedPaths } from '../utils/vault-files';
import { ChangeSet } from '../core/change-set';
import type { LoreEntryType, LoreDraftEntry } from '../core/dashboard/lorebook-types';
import { createInternalToolRegistry, createLoreCoachToolRegistry, type ToolContext, type ToolRegistry } from './tools';
import {
    clearDiffEdits,
    diffEditsField,
    pushDiffEdits,
    setDiffEdits,
    syncChangeSetPositions,
    toDiffSnapshots
} from '../ui/change-diff-extension';

/** Replace em dashes (—) with a comma+space for prose that shouldn't use them.
 *  Preserves content inside wiki links ([[...]]) so linked targets are not broken. */
function sanitizeProse(text: string): string {
    return text.replace(/\[\[[^\]]*\]\]|\u2014/g, (match) => (match.startsWith('[[') ? match : ', '));
}

/**
 * Produce a short human-readable summary of a tool call's arguments for the
 * chat indicator ("Used manuscript_mentions("Sarah Connor")"). The raw
 * arguments are a JSON string from the model; this extracts the most
 * relevant field (varies by tool) and truncates for display.
 */
function summarizeToolArgs(toolName: string, argumentsJson: string): string {
    try {
        const args = argumentsJson.trim().length === 0 ? {} : (JSON.parse(argumentsJson) as Record<string, unknown>);
        // Pick the most descriptive field based on common tool arg names.
        const value =
            (typeof args.name === 'string' && args.name) ||
            (typeof args.path === 'string' && args.path) ||
            (typeof args.query === 'string' && args.query) ||
            (typeof args.type === 'string' && args.type) ||
            '';
        if (!value) return '';
        return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    } catch {
        return '';
    }
}

/**
 * Parse stopping point instructions from a direction string.
 * Supports patterns like:
 *   - "stop at next period"
 *   - "stop after 2 paragraphs"
 *   - "stop at [marker]"
 *   - "continue until [condition]"
 * @param direction - The direction string from the user.
 * @returns A stopping point spec or null if none found.
 */
function parseStoppingPoint(direction: string): { instruction: string; isExplicit: boolean } | null {
    const lower = direction.toLowerCase();

    // "stop at next period" or similar natural language (checked before the
    // generic "stop at [marker]" pattern so it takes precedence)
    const naturalStopMatch = lower.match(/stop\s+at\s+(?:the\s+)?(next\s+(?:period|sentence|paragraph|line))/);
    if (naturalStopMatch?.[1]) {
        return { instruction: `Stop at the next ${naturalStopMatch[1].replace('next ', '')}.`, isExplicit: true };
    }

    // "stop at [marker]" pattern
    const stopAtMatch = lower.match(/stop\s+at\s+(.+?)(?:\.\s*$|$)/);
    if (stopAtMatch?.[1]) {
        return { instruction: `Stop exactly at: ${stopAtMatch[1].trim()}`, isExplicit: true };
    }

    // "stop after N paragraphs" pattern
    const stopAfterMatch = lower.match(/stop\s+after\s+(\d+)\s+paragraphs?/);
    if (stopAfterMatch?.[1]) {
        return { instruction: `Write exactly ${stopAfterMatch[1]} paragraph(s), then stop.`, isExplicit: true };
    }

    // "continue until [condition]" pattern
    const continueUntilMatch = lower.match(/continue\s+until\s+(.+?)(?:\.\s*$|$)/);
    if (continueUntilMatch?.[1]) {
        return { instruction: `Continue writing until: ${continueUntilMatch[1].trim()}`, isExplicit: true };
    }

    return null;
}

/**
 * Check if generated content respects the stopping point.
 * Returns true if content appears to have stopped at the right place.
 */
function respectsStoppingPoint(content: string, instruction: string): boolean {
    const lower = content.toLowerCase().trim();

    // Check for paragraph count constraint
    const paraMatch = instruction.match(/write\s+exactly\s+(\d+)\s+paragraph/);
    if (paraMatch?.[1]) {
        const expectedCount = parseInt(paraMatch[1], 10);
        const actualCount = (content.match(/\n\s*\n/g) ?? []).length + 1;
        return actualCount === expectedCount;
    }

    // Check for natural stop instructions produced by parseStoppingPoint
    // (e.g., "Stop at the next period."). Counts the relevant boundary in the
    // generated content; respected means no more than one boundary unit.
    const naturalMatch = instruction.match(/Stop at the next (period|sentence|paragraph|line)\b/);
    if (naturalMatch?.[1]) {
        switch (naturalMatch[1]) {
            case 'period':
                return (content.match(/\./g) ?? []).length <= 1;
            case 'sentence':
                return (content.match(/[.!?]/g) ?? []).length <= 1;
            case 'paragraph':
                return (content.match(/\n\s*\n/g) ?? []).length === 0;
            case 'line':
                return (content.match(/\n/g) ?? []).length === 0;
        }
    }

    // Check for "stop at" markers
    if (instruction.includes('Stop exactly at')) {
        // Content should end near the specified marker
        const marker = instruction.replace('Stop exactly at: ', '').trim();
        const lastPara = lower.split(/\n\s*\n/).pop() ?? lower;
        return lastPara.includes(marker) || lower.endsWith(marker);
    }

    // Check for "continue until" conditions
    if (instruction.includes('Continue writing until')) {
        // Content should contain or approach the condition
        const condition = instruction.replace('Continue writing until: ', '').trim();
        return lower.includes(condition);
    }

    return true; // Default: assume it's fine
}

/**
 * Truncate content to respect the stopping point.
 * Returns the truncated content.
 */
function truncateToStoppingPoint(content: string, instruction: string): string {
    const lower = content.toLowerCase();

    // Handle paragraph count constraint
    const paraMatch = instruction.match(/write\s+exactly\s+(\d+)\s+paragraph/);
    if (paraMatch?.[1]) {
        const expectedCount = parseInt(paraMatch[1], 10);
        const paragraphs = content.split(/\n\s*\n/);
        const truncated = paragraphs.slice(0, expectedCount).join('\n\n');
        return truncated;
    }

    // Handle natural stop instructions produced by parseStoppingPoint
    // (e.g., "Stop at the next period."). Cut at the first matching boundary
    // and include the boundary character(s) where it makes sense.
    const naturalMatch = instruction.match(/Stop at the next (period|sentence|paragraph|line)\b/);
    if (naturalMatch?.[1]) {
        switch (naturalMatch[1]) {
            case 'period': {
                const idx = content.search(/\./);
                return idx >= 0 ? content.slice(0, idx + 1) : content;
            }
            case 'sentence': {
                const idx = content.search(/[.!?]/);
                return idx >= 0 ? content.slice(0, idx + 1) : content;
            }
            case 'paragraph': {
                const idx = content.search(/\n\s*\n/);
                return idx >= 0 ? content.slice(0, idx).replace(/\s+$/, '') : content;
            }
            case 'line': {
                const idx = content.search(/\n/);
                return idx >= 0 ? content.slice(0, idx) : content;
            }
        }
    }

    // Handle "stop at" markers
    if (instruction.includes('Stop exactly at')) {
        const marker = instruction.replace('Stop exactly at: ', '').trim().toLowerCase();
        const index = lower.indexOf(marker);
        if (index >= 0) {
            // Find the end of the sentence/paragraph containing the marker
            const afterMarker = content.slice(index);
            const sentenceEnd = afterMarker.search(/[.!?]/);
            if (sentenceEnd >= 0) {
                return content.slice(0, index + sentenceEnd + 1);
            }
            // If no sentence end found, truncate at marker
            return content.slice(0, index);
        }
    }

    // Handle "continue until" - truncate at the condition
    if (instruction.includes('Continue writing until')) {
        const condition = instruction.replace('Continue writing until: ', '').trim().toLowerCase();
        const index = lower.indexOf(condition);
        if (index >= 0) {
            const afterCondition = content.slice(index);
            const sentenceEnd = afterCondition.search(/[.!?]/);
            if (sentenceEnd >= 0) {
                return content.slice(0, index + sentenceEnd + 1);
            }
            return content.slice(0, index + condition.length);
        }
    }

    // Default: return content as-is
    return content;
}

/**
 * Build a user prompt for the co-writer in direct mode.
 * Includes stopping point handling if specified in the direction.
 */

/**
 * Build a vault context string from context items.
 * Formats each item as `--- filePath ---\nexcerpt` and joins with double newlines.
 * @param contextItems - The context items to format.
 * @returns A formatted vault context string, or empty string if no items have excerpts.
 */
export function buildVaultContext(contextItems: Array<{ filePath: string; excerpt?: string }>): string {
    const contextParts: string[] = [];
    for (const item of contextItems) {
        if (item.excerpt) {
            contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
        }
    }
    return contextParts.join('\n\n');
}

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
            const charLimit = maxChars ?? 10000;
            const truncated = content.length > charLimit ? content.slice(0, charLimit) + '...' : content;
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
    return [...embedMessages, ...fileMessages];
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
export type { LoreDraftEntry } from '../core/dashboard/lorebook-types';

/** A single continuation option suggested by the AI. */
export interface CoWriterOption {
    label: string;
    description: string;
}

/** A chat message displayed in the co-writer panel. */
export interface CoWriterChatMessage {
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
    toolUses?: { name: string; argsSummary: string }[];
}

/**
 * Manages a co-writer session with a chat-like interface.
 * The writer sends a direction → AI suggests 3 options → writer picks one
 * → full continuation streams into the editor with accept/revert.
 */
export class CoWriterSession {
    /** Path of the manuscript being worked on. */
    manuscriptPath: string | null = null;
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

    /** Pending thought content accumulated during generation. */
    thoughtBuffer = '';

    /** Chat message history for the panel display. */
    chatHistory: CoWriterChatMessage[] = [];

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
    /** Called after a draft is accepted, to trigger fresh options. */
    onDraftAccepted: (() => void) | null = null;
    /** Called when the discuss-mode token estimate changes (conversation tokens only;
     * the panel adds vault context item tokens on top to compute the total). */
    onTokenEstimate: ((conversationTokens: number, maxTokens: number) => void) | null = null;
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
    /** Called when lorebook coach state changes (phase advance, end coach). */
    onLoreCoachUpdate: (() => void) | null = null;
    /** Called when a new lore draft is ready for the review card. */
    onLoreDraftReady: (() => void) | null = null;

    /** Proposed note edit (from edit_note / append_to_note tools), one at a time. */
    loreEditChanges: ChangeSet = new ChangeSet();
    /** Path of the note whose edit is pending review, or null when none. */
    loreEditPath: string | null = null;
    /** Called when a lore edit is proposed, approved, or rejected. */
    onLoreEditUpdate: (() => void) | null = null;

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

        // For initialize (empty direction), move cursor to end so AI reads the full document
        let fullText: string;
        let proseForOptions: string;
        if (!direction) {
            fullText = editor.getValue();
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
            proseForOptions = fullText.slice(-4000);
        } else {
            const cursor = editor.getCursor();
            fullText = editor.getValue();
            const cursorOffset = editor.posToOffset(cursor);
            const textBeforeCursor = fullText.slice(0, cursorOffset);
            proseForOptions = textBeforeCursor.slice(-4000);
        }

        // Add user's message to chat history
        this.chatHistory.push({
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

            this.chatHistory.push({
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

    /**
     * Stream one round of chat completion with tool-call fragment accumulation.
     * Handles text + thought streaming, the reasoning-clear-on-first-thought
     * pattern (discards draft text emitted before `<think>`), and tool-call
     * fragment accumulation. Does NOT handle multi-round looping, chat history,
     * or tool execution — the caller orchestrates those.
     *
     * @returns Accumulated response text, thought, and materialized tool calls.
     */
    private async streamToolAwareRound(
        provider: AiProvider,
        options: {
            messages: ChatMessage[];
            model?: string;
            maxTokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            tools?: ToolDefinition[];
        },
        callbacks: {
            onChunk: (text: string) => void;
            onThoughtChange: (thought: string) => void;
            onClear: () => void;
        }
    ): Promise<{ response: string; thought: string; toolCalls: ToolCallRequest[] }> {
        let response = '';
        let thought = '';
        let sawReasoning = false;
        const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();

        const stream = provider.chatCompletion({
            ...options,
            toolChoice: options.tools && options.tools.length > 0 ? 'auto' : undefined
        });

        for await (const chunk of stream) {
            if (chunk.done) break;

            if (chunk.thought) {
                if (!sawReasoning) {
                    sawReasoning = true;
                    response = '';
                    callbacks.onClear();
                }
                thought += chunk.thought;
                this.thoughtBuffer = thought;
                callbacks.onThoughtChange(thought);
            }

            if (chunk.text) {
                response += chunk.text;
                callbacks.onChunk(chunk.text);
            }

            if (chunk.toolCalls) {
                for (const frag of chunk.toolCalls) {
                    const existing = fragmentBuffer.get(frag.index);
                    if (existing) {
                        if (frag.id !== undefined) existing.id = frag.id;
                        if (frag.name !== undefined) existing.name = frag.name;
                        if (frag.arguments !== undefined) existing.arguments += frag.arguments;
                    } else {
                        fragmentBuffer.set(frag.index, {
                            id: frag.id,
                            name: frag.name,
                            arguments: frag.arguments ?? ''
                        });
                    }
                }
            }
        }

        const toolCalls: ToolCallRequest[] = [...fragmentBuffer.entries()]
            .sort(([a], [b]) => a - b)
            .map(([idx, acc]) => ({
                id: acc.id ?? `call_${idx}`,
                name: acc.name ?? '',
                arguments: acc.arguments
            }));

        return { response, thought, toolCalls };
    }

    /**
     * Execute one tool call with JSON argument parsing, result truncation,
     * and full error containment. Never throws — failures surface to the
     * model as an error string so it can recover.
     */
    private async executeToolCallSafely(
        call: ToolCallRequest,
        registry: ToolRegistry,
        ctx: ToolContext
    ): Promise<string> {
        const tool = registry.get(call.name);
        if (!tool) return `Error: tool "${call.name}" is not registered.`;

        let parsedArgs: Record<string, unknown>;
        try {
            parsedArgs =
                call.arguments.trim().length === 0 ? {} : (JSON.parse(call.arguments) as Record<string, unknown>);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error: invalid JSON arguments: ${msg}`;
        }

        try {
            if (ctx.signal?.aborted) return 'Error: aborted before tool execution.';
            const result = await tool.execute(parsedArgs, ctx);
            const maxChars = tool.maxResultTokens * 4;
            if (result.length > maxChars) {
                return result.slice(0, maxChars) + `\n\n...[result truncated at ${tool.maxResultTokens} tokens]`;
            }
            return result;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error executing tool "${call.name}": ${msg}`;
        }
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
    async sendDiscussion(plugin: EventideQuillPlugin, message: string): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        // Use the active file if available; fall back to stored manuscriptPath
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: Open a manuscript to discuss the scene.');
            return;
        }
        this.manuscriptPath = filePath;

        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
            new Notice('Quill: Open a manuscript editor to discuss the scene.');
            return;
        }
        const editor = markdownView.editor;

        // Populate context engine so the context tab shows data
        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        this.lockEditor();

        // Add user's message to display-only chat history
        this.chatHistory.push({ role: 'user', content: message });

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
        const cursorOffset = editor.posToOffset(cursor);
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseForContext = textBeforeCursor.slice(-4000);

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
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        injectedContext.push(...additionalContextMessages);
        const discussPlotMap = await buildPlotMapMessage(plugin);
        if (discussPlotMap) {
            injectedContext.push(discussPlotMap);
        }
        const discussDirective = buildDirectiveMessage(plugin, proseForContext);
        if (discussDirective) {
            injectedContext.push(discussDirective);
        }

        const prompt = getCoWriterDiscussPrompt(proseForContext || '(empty document)', message);

        // Initialize discussCurrentMessages on first call: system prompt + first user message
        if (this.discussCurrentMessages.length === 0) {
            const systemPrompt: ChatMessage = {
                role: 'system',
                content:
                    'You are a thoughtful, knowledgeable editor assisting a novelist in a discussion about their work. Respond with specific, craft-focused observations. Ask clarifying questions when helpful. Do not generate prose unless explicitly asked.'
            };
            this.discussCurrentMessages = [systemPrompt];
        }

        const injectedTokens = estimateTokens(injectedContext);
        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;

        // Compute total tokens INCLUDING the new message to decide whether to compact
        const hypotheticalConversation = [...this.discussCurrentMessages, { role: 'user' as const, content: prompt }];
        const conversationTokens = estimateTokens(hypotheticalConversation);
        const totalTokens = conversationTokens + injectedTokens;

        // Push conversation-only token estimate to the panel.
        // The panel adds vault context item tokens on top to get the total.
        this.onTokenEstimate?.(conversationTokens, maxTokens);

        // --- AI-powered compaction ---
        if (totalTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.discussCurrentMessages, sentenceCount, {
                    signal: this.abortController?.signal
                });
                if (result) {
                    this.discussCurrentMessages = result.messages;
                    this.onTokenEstimate?.(
                        estimateTokens([...this.discussCurrentMessages, { role: 'user' as const, content: prompt }]),
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

        // Append the user message after compaction so it's always below any new context head
        this.discussCurrentMessages.push({ role: 'user', content: prompt });

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
        // round in the chat and consumes a model turn.
        const toolsEnabled = plugin.settings.coWriterToolsEnabled;
        const registry = toolsEnabled ? createInternalToolRegistry() : null;
        const toolDefs = registry?.toToolDefinitions();
        const ctx: ToolContext = { plugin };
        const MAX_TOOL_ROUNDS = 5;

        try {
            this.abortController = new AbortController();
            ctx.signal = this.abortController.signal;

            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                // Rebuild baseMessages each round — discussCurrentMessages may
                // have grown with tool-call + tool-result messages.
                const roundBaseMessages: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...this.discussCurrentMessages.slice(1)
                ];

                // Push a fresh draft before discussStartStreaming so the
                // panel's placeholder-check (last message already assistant?)
                // is a no-op — we own the message we'll replace post-stream.
                this.chatHistory.push({ role: 'assistant', content: '' });
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                const result = await this.streamToolAwareRound(
                    chat.provider,
                    {
                        messages: roundBaseMessages,
                        model: chat.modelId,
                        temperature: plugin.settings.coWriterTemperature,
                        maxTokens: 1024,
                        signal: this.abortController.signal,
                        tools: toolDefs
                    },
                    {
                        onChunk: (text) => this.onDiscussChunk?.(text),
                        onThoughtChange: (thought) => this.onThought?.(thought),
                        onClear: () => this.onDiscussClear?.()
                    }
                );

                // Replace the draft with the finalized message (never push a
                // second assistant message — the draft and final would both
                // render and duplicate the response text).
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    this.chatHistory[lastIdx] = {
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
                    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined
                });

                // Update token estimate so the indicator reflects tool-result
                // growth — tool results stay in the conversation and keep
                // getting re-sent, so the user needs to see their cost.
                this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);

                // No tools called (or tools disabled) → this round is final.
                if (result.toolCalls.length === 0 || !registry) break;

                // Execute tools and push role:'tool' result messages.
                for (const call of result.toolCalls) {
                    const toolResult = await this.executeToolCallSafely(call, registry, ctx);
                    this.discussCurrentMessages.push({
                        role: 'tool',
                        content: toolResult,
                        toolCallId: call.id,
                        name: call.name
                    });
                }

                // Re-estimate after tool results were appended.
                this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);
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
    async sendCoach(plugin: EventideQuillPlugin, message: string): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }

        // Use the active file if available; fall back to stored manuscriptPath
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

        // Populate context engine
        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);
        this.lockEditor();

        // Add user message to display history (same as sendDiscussion)
        this.chatHistory.push({ role: 'user', content: message });

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
        const cursorOffset = editor.posToOffset(cursor);
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseForContext = textBeforeCursor.slice(-4000);

        // Build injected context
        const injectedContext: ChatMessage[] = [];
        const vaultContext =
            plugin.settings.coWriterVaultContext && plugin.currentAssembly
                ? buildVaultContext(plugin.currentAssembly.contextItems)
                : '';
        if (vaultContext) {
            injectedContext.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths, fullText);
        injectedContext.push(...additionalContextMessages);
        const coachPlotMap = await buildPlotMapMessage(plugin);
        if (coachPlotMap) {
            injectedContext.push(coachPlotMap);
        }
        const coachDirective = buildDirectiveMessage(plugin, proseForContext);
        if (coachDirective) {
            injectedContext.push(coachDirective);
        }

        // Initialize coach session on first call
        if (!this.coachSession || (this.coachSession.phase === 'discern' && message)) {
            const prompt = getCoWriterCoachPrompt(proseForContext || '(empty document)', message);
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
                    'You are a thoughtful writing coach guiding a novelist through what to do next in their scene. Your job is to ASK QUESTIONS — at least 2-3 clarifying questions in every response until you have enough information to provide a plan. Do NOT just analyze or discuss the passage without asking questions. Follow the phased structure: discern intent, ask questions, plan, direct. Do not write prose for the writer.'
            };

            this.discussCurrentMessages = [systemPrompt, { role: 'user', content: prompt }];
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
                this.discussCurrentMessages.push({ role: 'user', content: revisionPrompt });
            } else {
                // Normal follow-up (discern or clarify phase)
                const followUpPrompt = getCoWriterCoachFollowUp(
                    proseForContext || '(empty document)',
                    message,
                    phase === 'discern' ? 1 : 2,
                    this.coachSession.clarifyRound
                );
                this.discussCurrentMessages.push({ role: 'user', content: followUpPrompt });
            }
        }

        const injectedTokens = estimateTokens(injectedContext);
        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;

        const conversationTokens = estimateTokens(this.discussCurrentMessages);
        const totalTokens = conversationTokens + injectedTokens;

        this.onTokenEstimate?.(conversationTokens, maxTokens);

        // Compaction (same as discuss mode)
        if (totalTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.discussCurrentMessages, sentenceCount, {
                    signal: this.abortController?.signal
                });
                if (result) {
                    this.discussCurrentMessages = result.messages;
                    this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);
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

        // Tool setup: same internal tools as discuss mode.
        const toolsEnabled = plugin.settings.coWriterToolsEnabled;
        const registry = toolsEnabled ? createInternalToolRegistry() : null;
        const toolDefs = registry?.toToolDefinitions();
        const ctx: ToolContext = { plugin };
        const MAX_TOOL_ROUNDS = 5;

        let response = '';

        try {
            this.abortController = new AbortController();
            ctx.signal = this.abortController.signal;

            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                const roundBaseMessages: ChatMessage[] = [
                    this.discussCurrentMessages[0]!,
                    ...injectedContext,
                    ...this.discussCurrentMessages.slice(1)
                ];

                this.chatHistory.push({ role: 'assistant', content: '' });
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                const result = await this.streamToolAwareRound(
                    chat.provider,
                    {
                        messages: roundBaseMessages,
                        model: chat.modelId,
                        temperature: plugin.settings.coWriterTemperature,
                        maxTokens: 1024,
                        signal: this.abortController.signal,
                        tools: toolDefs
                    },
                    {
                        onChunk: (text) => this.onDiscussChunk?.(text),
                        onThoughtChange: (t) => this.onThought?.(t),
                        onClear: () => this.onDiscussClear?.()
                    }
                );

                response = result.response;

                // Replace the draft with the finalized message.
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    this.chatHistory[lastIdx] = {
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
                    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined
                });

                this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);

                if (result.toolCalls.length === 0 || !registry) break;

                for (const call of result.toolCalls) {
                    const toolResult = await this.executeToolCallSafely(call, registry, ctx);
                    this.discussCurrentMessages.push({
                        role: 'tool',
                        content: toolResult,
                        toolCallId: call.id,
                        name: call.name
                    });
                }

                this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);
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

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
        const cursorOffset = editor.posToOffset(cursor);
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseForOptions = textBeforeCursor.slice(-4000);

        const coachSummary = this.buildCoachSummary();
        const prompt = getCoWriterCoachToOptions(proseForOptions || '(empty document)', coachSummary, direction);

        this.chatHistory.push({
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

            this.chatHistory.push({
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
    async sendLoreCoach(plugin: EventideQuillPlugin, message: string): Promise<void> {
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) {
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        if (plugin.settings.lorebookFolders.length === 0) {
            new Notice('Quill: Add at least one lorebook folder in settings → lorebook first.');
            return;
        }

        this.cancelGeneration();
        this.app = plugin.app;
        this.currentOptions = [];
        this.optionsLoading = true;
        this.onOptionsLoading?.(true);

        // Add user message to display history.
        this.chatHistory.push({ role: 'user', content: message });

        // Initialize session on first turn.
        if (!this.loreCoachSession) {
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
                { role: 'user', content: getLoreCoachUserPrompt(message) }
            ];
        } else {
            this.loreCoachSession.rounds++;
            this.loreCoachMessages.push({ role: 'user', content: getLoreCoachUserPrompt(message) });
        }

        const toolsEnabled = plugin.settings.coWriterToolsEnabled;
        const registry = toolsEnabled ? createLoreCoachToolRegistry() : null;
        const toolDefs = registry?.toToolDefinitions();
        const ctx: ToolContext = { plugin };

        const maxTokens = chat.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.settingsOrDefault(plugin).contextCompactAtPercent)) / 100;
        const conversationTokens = estimateTokens(this.loreCoachMessages);
        this.onTokenEstimate?.(conversationTokens, maxTokens);

        if (conversationTokens / maxTokens >= compactPct) {
            const sentenceCount = Math.max(1, Math.min(20, this.settingsOrDefault(plugin).compactSummarySentences));
            try {
                const result = await compactConversation(chat.provider, this.loreCoachMessages, sentenceCount);
                if (result) {
                    this.loreCoachMessages = result.messages;
                    this.onTokenEstimate?.(estimateTokens(this.loreCoachMessages), maxTokens);
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
                toolsEnabled,
                conversationTokens: estimateTokens(this.loreCoachMessages),
                maxTokens
            });
        }

        const MAX_TOOL_ROUNDS = 5;

        try {
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                this.abortController = new AbortController();
                ctx.signal = this.abortController.signal;

                // Push a fresh placeholder for this round BEFORE calling
                // discussStartStreaming. The panel's discussStartStreaming
                // checks "is the last message already assistant?" and skips
                // its own push when so — by pre-pushing our own draft we
                // prevent a duplicate placeholder and own the message we'll
                // finalize in place after the stream.
                this.chatHistory.push({ role: 'assistant', content: '' });
                this.thoughtBuffer = '';
                this.onDiscussStartStreaming?.();
                this.onDiscussChunk?.('');

                let response = '';
                let thought = '';
                let sawReasoning = false;
                const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();

                const stream = chat.provider.chatCompletion({
                    messages: this.loreCoachMessages,
                    model: chat.modelId,
                    temperature: 0.7,
                    maxTokens: 2048,
                    signal: this.abortController.signal,
                    tools: toolDefs,
                    toolChoice: toolDefs ? 'auto' : undefined
                });

                for await (const chunk of stream) {
                    if (chunk.done) break;

                    if (chunk.thought) {
                        // Reasoning models sometimes emit a "draft" response
                        // before their reasoning block, then repeat it verbatim
                        // after. Discard any text accumulated before the first
                        // reasoning chunk so the two copies don't concatenate
                        // into a duplicated block.
                        if (!sawReasoning) {
                            sawReasoning = true;
                            response = '';
                            this.onDiscussClear?.();
                        }
                        thought += chunk.thought;
                        this.thoughtBuffer = thought;
                        this.onThought?.(thought);
                    }

                    if (chunk.text) {
                        response += chunk.text;
                        this.onDiscussChunk?.(chunk.text);
                    }

                    if (chunk.toolCalls) {
                        for (const frag of chunk.toolCalls) {
                            const existing = fragmentBuffer.get(frag.index);
                            if (existing) {
                                if (frag.id !== undefined) existing.id = frag.id;
                                if (frag.name !== undefined) existing.name = frag.name;
                                if (frag.arguments !== undefined) existing.arguments += frag.arguments;
                            } else {
                                fragmentBuffer.set(frag.index, {
                                    id: frag.id,
                                    name: frag.name,
                                    arguments: frag.arguments ?? ''
                                });
                            }
                        }
                    }
                }

                // Materialize accumulated tool-call fragments into complete calls.
                const toolCalls = [...fragmentBuffer.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([idx, acc]) => ({
                        id: acc.id ?? `call_${idx}`,
                        name: acc.name ?? '',
                        arguments: acc.arguments
                    }));

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
                const draftForMessage = this.currentLoreDraft;
                const lastIdx = this.chatHistory.length - 1;
                if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                    this.chatHistory[lastIdx] = {
                        role: 'assistant',
                        content: response,
                        thought: thought || undefined,
                        loreDraft: draftForMessage ?? undefined,
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
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
                });

                // No tools called (or tools disabled) → this round is final.
                if (toolCalls.length === 0 || !registry) {
                    break;
                }

                // Execute each tool and push a role:'tool' result to the API
                // history. No separate chat entries — tool calls are already
                // visible as `toolUses` annotations on the assistant message.
                for (const call of toolCalls) {
                    const tool = registry.get(call.name);
                    let resultText: string;
                    if (!tool) {
                        resultText = `Error: tool "${call.name}" is not registered.`;
                    } else {
                        let parsedArgs: Record<string, unknown>;
                        try {
                            parsedArgs =
                                call.arguments.trim().length === 0
                                    ? {}
                                    : (JSON.parse(call.arguments) as Record<string, unknown>);
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            resultText = `Error: invalid JSON arguments: ${msg}`;
                            this.loreCoachMessages.push({
                                role: 'tool',
                                content: resultText,
                                toolCallId: call.id,
                                name: call.name
                            });
                            continue;
                        }
                        try {
                            if (ctx.signal?.aborted) {
                                resultText = 'Error: aborted before tool execution.';
                            } else {
                                resultText = await tool.execute(parsedArgs, ctx);
                                const maxChars = tool.maxResultTokens * 4;
                                if (resultText.length > maxChars) {
                                    resultText =
                                        resultText.slice(0, maxChars) +
                                        `\n\n...[result truncated at ${tool.maxResultTokens} tokens]`;
                                }
                            }
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            resultText = `Error executing tool "${call.id}": ${msg}`;
                        }
                    }
                    this.loreCoachMessages.push({
                        role: 'tool',
                        content: resultText,
                        toolCallId: call.id,
                        name: call.name
                    });
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
                this.onTokenEstimate?.(estimateTokens(this.loreCoachMessages), maxTokens);
                this.onChatUpdate?.();

                // Continue to next round — the model will see its tool_calls
                // and the tool results and continue the conversation.
            }

            this.onDiscussFinished?.();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onTokenEstimate?.(estimateTokens(this.loreCoachMessages), maxTokens);
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
                    'Your prose must flow naturally into the text that follows it. Write in the established voice and perspective. Output only the prose — no labels, no explanations.',
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
                this.fulfillChanges.add({
                    from: range.start,
                    to: range.end,
                    newText: sanitizeProse(prose).trim(),
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
        const preserved = cm.state.field(diffEditsField).filter((s) => s.owner !== 'fulfill');
        cm.dispatch({
            changes: change,
            effects: setDiffEdits.of([...preserved, ...toDiffSnapshots(this.fulfillChanges, 'fulfill')]),
            selection: { anchor: change.from + change.insert.length }
        });
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
        const preserved = cm.state.field(diffEditsField).filter((s) => s.owner !== 'direct');
        cm.dispatch({
            changes: change,
            effects: setDiffEdits.of(preserved),
            selection: { anchor: change.from + change.insert.length }
        });
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

    // ── Lore edit (edit_note / append_to_note tools) ─────────────────────

    /**
     * Approve the pending lore edit: commit the ChangeSet edit to the target
     * note's editor and clear the diff. The editor handles saving via
     * Obsidian's normal auto-save.
     */
    approveLoreEdit(id: number): void {
        if (!this.app || !this.loreEditPath) return;
        const view = findEditorView(this.app, this.loreEditPath);
        if (!view) return;
        const cm = (view.editor as unknown as { cm: EditorView }).cm;
        if (!cm) return;

        const change = this.loreEditChanges.approve(id);
        if (!change) return;

        const preserved = cm.state.field(diffEditsField).filter((s) => s.owner !== 'lore_edit');
        cm.dispatch({
            changes: change,
            effects: setDiffEdits.of(preserved),
            selection: { anchor: change.from + change.insert.length }
        });

        this.loreEditChanges.clear();
        this.loreEditPath = null;
        this.onLoreEditUpdate?.();
    }

    /** Reject the pending lore edit: discard the diff without writing. */
    rejectLoreEdit(): void {
        if (this.app && this.loreEditPath) {
            const view = findEditorView(this.app, this.loreEditPath);
            if (view) {
                const cm = (view.editor as unknown as { cm: EditorView }).cm;
                if (cm) clearDiffEdits(cm, 'lore_edit');
            }
        }
        this.loreEditChanges.clear();
        this.loreEditPath = null;
        this.onLoreEditUpdate?.();
    }

    /** Clear lore edit state (e.g., on reset / new chat). */
    clearLoreEdit(): void {
        if (this.app && this.loreEditPath) {
            const view = findEditorView(this.app, this.loreEditPath);
            if (view) {
                const cm = (view.editor as unknown as { cm: EditorView }).cm;
                if (cm) clearDiffEdits(cm, 'lore_edit');
            }
        }
        this.loreEditChanges.clear();
        this.loreEditPath = null;
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
                this.onTokenEstimate?.(estimateTokens(this.discussCurrentMessages), maxTokens);
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

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
        const cursorOffset = editor.posToOffset(cursor);

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

        const userMessage = [
            `Continue the passage from the cursor position following this direction: ${option.label} — ${option.description}`,
            '',
            'Write the next paragraph or paragraphs in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation — no labels, no explanations.',
            '',
            '--- Current document up to cursor ---',
            textBeforeCursor.slice(-8000)
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
            ? new Notice('Quill: Continuing (mobile \u2014 this may take a moment)...', 0)
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
        // When direction is empty, the continuation is appended at EOF, so the
        // generation context must be built from the full document — not from
        // the (possibly mid-document) cursor position. Move the cursor now and
        // derive cursorOffset from the insertion point so voice/steering/prose
        // context all match the eventual edit location.
        if (!direction) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
        }
        const cursor = editor.getCursor();
        const cursorOffset = editor.posToOffset(cursor);

        this.chatHistory.push({
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

        // Parse stopping point from direction
        const stoppingPoint = direction ? parseStoppingPoint(direction) : null;
        const stoppingPointInstruction = stoppingPoint?.instruction ?? '';

        const userMessage = direction
            ? [
                  `Continue the passage from the cursor position following this direction: ${direction}`,
                  stoppingPointInstruction ? `\n${stoppingPointInstruction}` : '',
                  'Write the next paragraph or paragraphs in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation \u2014 no labels, no explanations.',
                  '',
                  '--- Current document up to cursor ---',
                  proseForContext
              ].join('\n')
            : [
                  'Continue the passage naturally from the cursor position.',
                  '',
                  'Read the document up to the cursor and continue writing in the same voice, maintaining the established narrative perspective and tense. Advance the scene naturally. Output only the continuation \u2014 no labels, no explanations.',
                  '',
                  '--- Current document up to cursor ---',
                  proseForContext
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
            ? new Notice('Quill: Continuing (mobile \u2014 this may take a moment)...', 0)
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
                    console.warn('[Quill Co-writer] Content exceeded stopping point, truncating');
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

    /** Reset the entire session including coach and context. */
    reset(): void {
        this.unlockEditor();
        this.cancelGeneration();
        this.endCoachSession();
        this.endLoreCoachSession();
        this.clearFulfill();
        this.clearDirect();
        this.clearLoreEdit();
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
}
