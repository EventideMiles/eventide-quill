import { App, Editor, Notice, Platform } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type EventideQuillPlugin from '../main';
import { type VoiceProfile } from '../types';
import { findEditorView } from '../utils/find-editor';
import { AiProvider, type ChatMessage } from './provider';
import {
    getCoWriterDiscussPrompt,
    getCoWriterGenerationPrompt,
    getCoWriterCoachFollowUp,
    getCoWriterCoachPrompt,
    getCoWriterCoachRevision,
    getCoWriterCoachToOptions,
    getCoWriterOptionPrompt,
    getCoWriterVoicePrompt,
    type ActiveSteering
} from './prompts';
import { compactConversation } from './compaction';
import { estimateTokens } from '../utils/tokens';
import { readVaultFiles, readVaultFileText } from '../utils/vault-files';
import { parseDirectives, parseAllDirectives } from '../utils/directives';
import { ChangeSet } from '../core/change-set';
import { clearDiffEdits, pushDiffEdits, setDiffEdits, toDiffSnapshots } from '../ui/change-diff-extension';

/** Replace em dashes (—) with a comma+space for prose that shouldn't use them. */
function sanitizeProse(text: string): string {
    return text.replace(/\u2014/g, ', ');
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
    const naturalStopMatch = lower.match(/stop\s+at\s+(next\s+(?:period|sentence|paragraph|beat|scene|line))/);
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
export async function loadAdditionalContext(
    plugin: EventideQuillPlugin,
    contextFilePaths: string[]
): Promise<ChatMessage[]> {
    return readVaultFiles(plugin.app.vault, contextFilePaths, 'Reference file', plugin.settings.contextMaxCharsPerFile);
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
    onStateChange: ((state: DraftState) => void) | null = null;
    onDraftComplete: (() => void) | null = null;
    onChatUpdate: (() => void) | null = null;
    onOptionsLoading: ((loading: boolean) => void) | null = null;
    /** Called after a draft is accepted, to trigger fresh options. */
    onDraftAccepted: (() => void) | null = null;
    /** Called when the discuss-mode token estimate changes (conversation tokens only;
     * the panel adds vault context item tokens on top to compute the total). */
    onTokenEstimate: ((conversationTokens: number, maxTokens: number) => void) | null = null;
    /** Called when a discuss response chunk arrives during streaming. */
    onDiscussChunk: ((text: string) => void) | null = null;
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

    /** Fulfill-mode proposed edits (one per directive), in document order. */
    fulfillChanges: ChangeSet = new ChangeSet();
    /** Direct-mode proposed continuation (pure insertion at the cursor), awaiting review. */
    directChanges: ChangeSet = new ChangeSet();
    /** Whether a Fulfill sweep is currently in progress. */
    fulfillActive = false;
    /** Called whenever Fulfill edits change (generation progress, approval, rejection). */
    onFulfillUpdate: (() => void) | null = null;

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

        // If a draft exists, revert it before starting fresh
        if (this.draftState === 'draft') {
            this.revertDraft(editor);
        }

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
        let proseForOptions: string;
        if (!direction) {
            const fullText = editor.getValue();
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
            proseForOptions = fullText.slice(-4000);
        } else {
            const cursor = editor.getCursor();
            const fullText = editor.getValue();
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

        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
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

        console.warn('[Quill Co-writer] Option generation context', {
            manuscriptExcerptChars: proseForOptions.length,
            vaultContextChars: vaultContext.length,
            vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
            additionalFiles: this.contextFilePaths
        });

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
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
        injectedContext.push(...additionalContextMessages);
        const discussPlotMap = await buildPlotMapMessage(plugin);
        if (discussPlotMap) {
            injectedContext.push(discussPlotMap);
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

        // Build the full API payload: system prompt + injected context + conversation
        const baseMessages: ChatMessage[] = [
            this.discussCurrentMessages[0]!, // system prompt
            ...injectedContext,
            ...this.discussCurrentMessages.slice(1) // context heads + chat turns
        ];

        console.warn('[Quill Co-writer] Discuss context', {
            manuscriptExcerptChars: proseForContext.length,
            vaultContextChars: vaultContext.length,
            vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
            additionalFiles: this.contextFilePaths,
            discussCurrentMessages: this.discussCurrentMessages.length,
            totalTokens,
            maxTokens
        });

        let thought = '';
        let response = '';

        // Notify panel that streaming is starting
        this.onDiscussChunk?.('');

        try {
            this.abortController = new AbortController();
            const stream = chat.provider.chatCompletion({
                messages: baseMessages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: 1024,
                signal: this.abortController.signal
            });

            for await (const chunk of stream) {
                if (chunk.done) break;
                response += chunk.text;
                if (chunk.text) {
                    this.onDiscussChunk?.(chunk.text);
                }
                if (chunk.thought) {
                    thought += chunk.thought;
                    this.thoughtBuffer = thought;
                    this.onThought?.(thought);
                }
            }

            // Replace the streaming placeholder with the complete message
            const lastIdx = this.chatHistory.length - 1;
            if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                this.chatHistory[lastIdx] = {
                    role: 'assistant',
                    content: response,
                    thought: thought || undefined
                };
            } else {
                this.chatHistory.push({
                    role: 'assistant',
                    content: response,
                    thought: thought || undefined
                });
            }
            this.discussCurrentMessages.push({ role: 'assistant', content: response });

            // Push conversation-only token estimate after response
            const conversationTokens = estimateTokens(this.discussCurrentMessages);
            this.onTokenEstimate?.(conversationTokens, maxTokens);

            // Mark the response as complete (triggers markdown render)
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
    async sendCoach(plugin: EventideQuillPlugin, message: string, currentPhase: CoachPhase = 'discern'): Promise<void> {
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
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
        injectedContext.push(...additionalContextMessages);
        const coachPlotMap = await buildPlotMapMessage(plugin);
        if (coachPlotMap) {
            injectedContext.push(coachPlotMap);
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

        const baseMessages: ChatMessage[] = [
            this.discussCurrentMessages[0]!,
            ...injectedContext,
            ...this.discussCurrentMessages.slice(1)
        ];

        console.warn('[Quill Co-writer] Coach context', {
            manuscriptExcerptChars: proseForContext.length,
            vaultContextChars: vaultContext.length,
            vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
            additionalFiles: this.contextFilePaths,
            phase: this.coachSession?.phase,
            totalTokens,
            maxTokens
        });

        let thought = '';
        let response = '';

        this.onDiscussChunk?.('');

        try {
            this.abortController = new AbortController();
            const stream = chat.provider.chatCompletion({
                messages: baseMessages,
                model: chat.modelId,
                temperature: plugin.settings.coWriterTemperature,
                maxTokens: 1024,
                signal: this.abortController.signal
            });

            for await (const chunk of stream) {
                if (chunk.done) break;
                response += chunk.text;
                if (chunk.text) {
                    this.onDiscussChunk?.(chunk.text);
                }
                if (chunk.thought) {
                    thought += chunk.thought;
                    this.thoughtBuffer = thought;
                    this.onThought?.(thought);
                }
            }

            // Update coach session
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

            // Update chat history
            const lastIdx = this.chatHistory.length - 1;
            if (lastIdx >= 0 && this.chatHistory[lastIdx]?.role === 'assistant') {
                this.chatHistory[lastIdx] = {
                    role: 'assistant',
                    content: response,
                    thought: thought || undefined,
                    showAccept: isRevision || undefined
                };
            } else {
                this.chatHistory.push({
                    role: 'assistant',
                    content: response,
                    thought: thought || undefined,
                    showAccept: isRevision || undefined
                });
            }
            this.discussCurrentMessages.push({ role: 'assistant', content: response });

            const conversationTokens = estimateTokens(this.discussCurrentMessages);
            this.onTokenEstimate?.(conversationTokens, maxTokens);

            this.onDiscussFinished?.();

            // Auto-generate options when plan or direction phase is reached for the first time
            const reachedPlanOrDirection =
                this.coachSession?.phase === 'plan' || this.coachSession?.phase === 'direction';
            const willAutoGenerate = reachedPlanOrDirection && !this.coachOptionsGenerated;
            if (willAutoGenerate) {
                this.coachOptionsGenerated = true;
                this.onCoachDirectionReady?.();
            }

            this.unlockEditor();
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

        if (this.draftState === 'draft') {
            this.revertDraft(editor);
        }

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
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
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
            new Notice('Quill: No AI provider configured. Set one up in settings.');
            return;
        }
        const activeFile = plugin.app.workspace.getActiveFile();
        const filePath = activeFile?.path ?? this.manuscriptPath;
        if (!filePath) {
            new Notice('Quill: Open a manuscript to run fulfill.');
            return;
        }
        this.manuscriptPath = filePath;
        const markdownView = findEditorView(plugin.app, filePath);
        if (!markdownView) {
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
            new Notice('Quill: Could not access editor for fulfill.');
            return;
        }

        const fullText = editor.getValue();
        const ranges = parseAllDirectives(fullText);
        if (ranges.length === 0) {
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
        clearDiffEdits(cm);
        this.onFulfillUpdate?.();

        const notice = new Notice(
            `Quill: Fulfilling ${ranges.length} directive${ranges.length === 1 ? '' : 's'}...`,
            0
        );

        try {
            for (const range of ranges) {
                this.abortController = new AbortController();
                const before = fullText.slice(Math.max(0, range.start - 2000), range.start);
                const after = fullText.slice(range.end, range.end + 1000);
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
                    plotMapText
                );
                const userMessage = [
                    'Fulfill the inline directive at this point in the scene. Write the prose that realizes it, in the established voice and perspective. Output only the prose — no labels, no explanations.',
                    ...(globalInstruction ? ['', `Overall direction for this sweep: ${globalInstruction}`] : []),
                    '',
                    `Directive: "${range.text}"`,
                    '',
                    '--- Prose before the directive ---',
                    before || '(start of document)',
                    '',
                    '--- Prose after the directive (continue into this) ---',
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
        const change = this.fulfillChanges.approve(id);
        if (!change) return;
        const cm = this.getManuscriptCm();
        if (cm) {
            cm.dispatch({
                changes: change,
                effects: setDiffEdits.of(toDiffSnapshots(this.fulfillChanges, 'fulfill')),
                selection: { anchor: change.from + change.insert.length }
            });
        }
        this.onFulfillUpdate?.();
    }

    /** Reject one Fulfill edit: leave the directive comment in place, un-consumed. */
    rejectFulfillSection(id: number): void {
        this.fulfillChanges.reject(id);
        const cm = this.getManuscriptCm();
        if (cm) pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
        this.onFulfillUpdate?.();
    }

    /** Approve every pending edit. Changes dispatch sequentially (offsets remap as each commits). */
    approveAllFulfill(plugin: EventideQuillPlugin): void {
        void plugin;
        const cm = this.getManuscriptCm();
        for (const change of this.fulfillChanges.approveAll()) {
            cm?.dispatch({ changes: change });
        }
        if (cm) pushDiffEdits(cm, toDiffSnapshots(this.fulfillChanges, 'fulfill'));
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
        if (cm) clearDiffEdits(cm);
        this.onFulfillUpdate?.();
    }

    /**
     * Approve the Direct continuation: commit the buffered prose at the cursor
     * and clear the diff. Fires onDraftAccepted so fresh options regenerate
     * (preserving the old accept-a-draft behavior).
     */
    approveDirectChange(plugin: EventideQuillPlugin, id: number): void {
        void plugin;
        const change = this.directChanges.approve(id);
        if (!change) return;
        const cm = this.getManuscriptCm();
        if (cm) {
            cm.dispatch({
                changes: change,
                effects: setDiffEdits.of([]),
                selection: { anchor: change.from + change.insert.length }
            });
        }
        this.onDraftAccepted?.();
    }

    /** Reject the Direct continuation: discard the buffered prose (nothing was
     *  ever written to the document) and clear the diff. */
    rejectDirectChange(id: number): void {
        void id;
        this.directChanges.clear();
        const cm = this.getManuscriptCm();
        if (cm) clearDiffEdits(cm);
    }

    /** Clear Direct change state (e.g., on reset / new chat). */
    clearDirect(): void {
        this.directChanges.clear();
        const cm = this.getManuscriptCm();
        if (cm) clearDiffEdits(cm);
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
        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
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
            plotMapText
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

        // Set up streaming — applyOption
        this.abortController = new AbortController();
        this.thoughtBuffer = '';
        this.insertionStart = cursorOffset;
        this.insertionLength = 0;
        this.originalText = fullText;
        this.draftState = 'generating';
        this.onStateChange?.('generating');
        this.lockEditor();

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            this.unlockEditor();
            this.draftState = 'idle';
            this.onStateChange?.('idle');
            return;
        }

        const notice = Platform.isMobile
            ? new Notice('Quill: Continuing (mobile — this may take a moment)...', 0)
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

                const cleanText = sanitizeProse(chunk.text);
                const insertAt = this.insertionStart + this.insertionLength;
                cm.dispatch({
                    changes: {
                        from: insertAt,
                        to: insertAt,
                        insert: cleanText
                    },
                    selection: { anchor: insertAt + cleanText.length }
                });
                this.insertionLength += cleanText.length;
            }

            console.warn('[Quill Co-writer] Draft continuation context', {
                manuscriptExcerptChars: textBeforeCursor.slice(-8000).length,
                vaultContextChars: vaultContext.length,
                vaultContextFiles: plugin.currentAssembly?.contextItems.length ?? 0,
                additionalFiles: this.contextFilePaths,
                voiceProfile: this.voiceProfile
                    ? {
                          sentenceLengthDistribution: this.voiceProfile.sentenceLengthDistribution,
                          dialogueRatio: this.voiceProfile.dialogueRatio,
                          vocabularyRegister: this.voiceProfile.vocabularyRegister
                      }
                    : null,
                narrativeVoicePreset: plugin.settings.narrativeVoicePreset,
                insertionLength: this.insertionLength
            });
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                notice.hide();
                if (this.insertionLength > 0) {
                    // Keep partial content as draft — user must accept or reject
                    this.draftState = 'draft';
                    this.onStateChange?.('draft');
                } else {
                    this.unlockEditor();
                    this.draftState = 'idle';
                    this.onStateChange?.('idle');
                    this.insertionStart = -1;
                    this.insertionLength = 0;
                }
                return;
            }
            new Notice(`Quill: Continuation failed — ${err instanceof Error ? err.message : String(err)}`);
            notice.hide();
            this.unlockEditor();
            this.draftState = 'idle';
            this.onStateChange?.('idle');
            return;
        }

        notice.hide();

        if (this.insertionLength === 0) {
            new Notice('Quill: Received empty response from the AI provider.');
            this.unlockEditor();
            this.draftState = 'idle';
            this.onStateChange?.('idle');
            return;
        }

        // Append trailing newline if enabled
        if (plugin.settings.coWriterAppendNewline) {
            const endPos = this.insertionStart + this.insertionLength;
            const after = cm.state.sliceDoc(endPos, Math.min(endPos + 2, cm.state.doc.length));
            if (after !== '\n\n') {
                cm.dispatch({
                    changes: { from: endPos, to: endPos, insert: '\n' },
                    selection: { anchor: endPos + 1 }
                });
                this.insertionLength += 1;
            }
        }

        this.draftState = 'draft';
        this.onStateChange?.('draft');
        this.onDraftComplete?.();
        this.onChatUpdate?.();
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

        if (this.draftState === 'draft') {
            this.revertDraft(editor);
        }

        if (!plugin.currentAssembly) {
            await plugin.assembleDocumentContext(editor.getValue(), filePath);
        }

        this.cancelGeneration();
        this.app = plugin.app;
        this.currentOptions = [];

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
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

        const additionalContextMessages = await loadAdditionalContext(plugin, this.contextFilePaths);
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
            plotMapText
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

        if (!direction) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
            directEdit.from = fullText.length;
            directEdit.to = fullText.length;
        }

        this.onOptionsLoading?.(true);
        this.onChatUpdate?.();

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            this.onOptionsLoading?.(false);
            return;
        }
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
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
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
                clearDiffEdits(cm);
            } else {
                pushDiffEdits(cm, toDiffSnapshots(this.directChanges, 'direct'));
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                // Keep partial prose as a pending change for review; clear only if empty.
                if (directEdit.newText.replace(/\s+$/, '').length === 0) {
                    this.directChanges.clear();
                    clearDiffEdits(cm);
                }
            } else {
                new Notice(`Quill: Continuation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
                this.directChanges.clear();
                clearDiffEdits(cm);
            }
        } finally {
            notice.hide();
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
    }

    /** Accept the current draft and reset state to idle. */
    acceptDraft(): void {
        if (this.draftState !== 'draft') return;
        this.unlockEditor();
        this.draftState = 'idle';
        this.insertionStart = -1;
        this.insertionLength = 0;
        this.originalText = '';
        this.thoughtBuffer = '';
        this.onStateChange?.('idle');
        this.onDraftAccepted?.();
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

    /** Revert the current draft by removing the inserted text from the editor. */
    revertDraft(editor: Editor): void {
        if (this.draftState !== 'draft' || this.insertionStart < 0 || this.insertionLength <= 0) return;
        this.unlockEditor();

        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) return;

        cm.dispatch({
            changes: {
                from: this.insertionStart,
                to: this.insertionStart + this.insertionLength,
                insert: ''
            },
            selection: { anchor: this.insertionStart }
        });

        this.draftState = 'idle';
        this.insertionStart = -1;
        this.insertionLength = 0;
        this.originalText = '';
        this.thoughtBuffer = '';
        this.onStateChange?.('idle');
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

    /** Cancel any in-flight API call. */
    cancelGeneration(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
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
        this.clearFulfill();
        this.clearDirect();
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
        this.onStateChange?.('idle');
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
        this.clearFulfill();
        this.clearDirect();
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
        this.onStateChange?.('idle');
        this.onChatUpdate?.();
        this.onOptionsLoading?.(false);
    }
}
