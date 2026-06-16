import { App, Editor, Notice, Platform, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type EventideQuillPlugin from '../main';
import type { VoiceProfile } from '../types';
import { findEditorView } from '../utils/find-editor';
import { AiProvider, ChatMessage } from './provider';
import {
    getCoWriterDiscussPrompt,
    getCoWriterGenerationPrompt,
    getCoWriterOptionPrompt,
    getCoWriterVoicePrompt
} from './prompts';

/** Current state of a co-writer drafting session. */
export type DraftState = 'idle' | 'generating' | 'draft';

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
        let vaultContext = '';
        if (plugin.settings.coWriterVaultContext && plugin.currentAssembly) {
            const contextParts: string[] = [];
            for (const item of plugin.currentAssembly.contextItems) {
                if (item.excerpt) {
                    contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                }
            }
            vaultContext = contextParts.join('\n\n');
        }

        const additionalContextMessages: ChatMessage[] = [];
        if (this.contextFilePaths.length > 0) {
            for (const ctxPath of this.contextFilePaths) {
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(ctxPath);
                    if (file instanceof TFile) {
                        const content = await plugin.app.vault.cachedRead(file);
                        const excerpt = content.slice(0, plugin.settings.contextMaxCharsPerFile);
                        additionalContextMessages.push({
                            role: 'system' as const,
                            content: `Reference file (${ctxPath}):\n${excerpt}`
                        });
                    }
                } catch {
                    // Best-effort
                }
            }
        }

        const prompt = getCoWriterOptionPrompt(proseForOptions || '(empty document)', direction);
        const messages: ChatMessage[] = [];
        if (vaultContext) {
            messages.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        messages.push(...additionalContextMessages, { role: 'user', content: prompt });

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
     */
    private parseOptionsResponse(response: string): CoWriterOption[] | null {
        const trimmed = response.trim();
        const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return null;

        try {
            const parsed = JSON.parse(jsonMatch[0]) as unknown[];
            if (!Array.isArray(parsed) || parsed.length !== 3) return null;

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

        // Add user's message to chat history
        this.chatHistory.push({ role: 'user', content: message });

        const cursor = editor.getCursor();
        const fullText = editor.getValue();
        const cursorOffset = editor.posToOffset(cursor);
        const textBeforeCursor = fullText.slice(0, cursorOffset);
        const proseForContext = textBeforeCursor.slice(-4000);

        // Build context — vault + additional files
        let vaultContext = '';
        if (plugin.settings.coWriterVaultContext && plugin.currentAssembly) {
            const contextParts: string[] = [];
            for (const item of plugin.currentAssembly.contextItems) {
                if (item.excerpt) {
                    contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                }
            }
            vaultContext = contextParts.join('\n\n');
        }

        const additionalContextMessages: ChatMessage[] = [];
        if (this.contextFilePaths.length > 0) {
            for (const ctxPath of this.contextFilePaths) {
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(ctxPath);
                    if (file instanceof TFile) {
                        const content = await plugin.app.vault.cachedRead(file);
                        const excerpt = content.slice(0, plugin.settings.contextMaxCharsPerFile);
                        additionalContextMessages.push({
                            role: 'system' as const,
                            content: `Reference file (${ctxPath}):\n${excerpt}`
                        });
                    }
                } catch {
                    // Best-effort
                }
            }
        }

        const prompt = getCoWriterDiscussPrompt(proseForContext || '(empty document)', message);
        const messages: ChatMessage[] = [];
        if (vaultContext) {
            messages.push({ role: 'system', content: `Vault context for reference:\n${vaultContext}` });
        }
        messages.push(...additionalContextMessages, { role: 'user', content: prompt });

        console.warn('[Quill Co-writer] Discuss context', {
            manuscriptExcerptChars: proseForContext.length,
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

            this.chatHistory.push({ role: 'assistant', content: response, thought: thought || undefined });

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
            new Notice(`Quill: Discussion failed — ${err instanceof Error ? err.message : String(err)}`);
            this.unlockEditor();
            this.optionsLoading = false;
            this.onOptionsLoading?.(false);
            this.onChatUpdate?.();
        }
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
        let vaultContext = '';
        if (plugin.settings.coWriterVaultContext && plugin.currentAssembly) {
            const contextParts: string[] = [];
            for (const item of plugin.currentAssembly.contextItems) {
                if (item.excerpt) {
                    contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                }
            }
            vaultContext = contextParts.join('\n\n');
        }

        // Build additional context from user-added files
        const additionalContextMessages: ChatMessage[] = [];
        if (this.contextFilePaths.length > 0) {
            for (const ctxPath of this.contextFilePaths) {
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(ctxPath);
                    if (file instanceof TFile) {
                        const content = await plugin.app.vault.cachedRead(file);
                        const excerpt = content.slice(0, plugin.settings.contextMaxCharsPerFile);
                        additionalContextMessages.push({
                            role: 'system' as const,
                            content: `Reference file (${ctxPath}):\n${excerpt}`
                        });
                    }
                } catch {
                    // Best-effort
                }
            }
        }

        const systemPrompt = getCoWriterGenerationPrompt(
            this.voiceProfile ?? {
                sentenceLengthDistribution: 'unknown',
                dialogueRatio: 0.5,
                vocabularyRegister: 'unknown',
                keyPatterns: []
            },
            plugin.settings.narrativeVoicePreset,
            vaultContext,
            false
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
            { role: 'user', content: userMessage }
        ];

        // Set up streaming
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

                const insertAt = this.insertionStart + this.insertionLength;
                cm.dispatch({
                    changes: {
                        from: insertAt,
                        to: insertAt,
                        insert: chunk.text
                    },
                    selection: { anchor: insertAt + chunk.text.length }
                });
                this.insertionLength += chunk.text.length;
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
    async generateDirect(plugin: EventideQuillPlugin, direction: string): Promise<void> {
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
        let vaultContext = '';
        if (plugin.settings.coWriterVaultContext && plugin.currentAssembly) {
            const contextParts: string[] = [];
            for (const item of plugin.currentAssembly.contextItems) {
                if (item.excerpt) {
                    contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
                }
            }
            vaultContext = contextParts.join('\n\n');
        }

        const additionalContextMessages: ChatMessage[] = [];
        if (this.contextFilePaths.length > 0) {
            for (const ctxPath of this.contextFilePaths) {
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(ctxPath);
                    if (file instanceof TFile) {
                        const content = await plugin.app.vault.cachedRead(file);
                        const excerpt = content.slice(0, plugin.settings.contextMaxCharsPerFile);
                        additionalContextMessages.push({
                            role: 'system' as const,
                            content: `Reference file (${ctxPath}):\n${excerpt}`
                        });
                    }
                } catch {
                    // Best-effort
                }
            }
        }

        const systemPrompt = getCoWriterGenerationPrompt(
            this.voiceProfile ?? {
                sentenceLengthDistribution: 'unknown',
                dialogueRatio: 0.5,
                vocabularyRegister: 'unknown',
                keyPatterns: []
            },
            plugin.settings.narrativeVoicePreset,
            vaultContext,
            false
        );

        const proseForContext = textBeforeCursor.slice(-12000);
        const userMessage = direction
            ? [
                  `Continue the passage from the cursor position following this direction: ${direction}`,
                  '',
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
            { role: 'user', content: userMessage }
        ];

        // Set up streaming
        this.abortController = new AbortController();
        this.thoughtBuffer = '';
        this.insertionStart = cursorOffset;
        this.insertionLength = 0;
        this.originalText = fullText;

        if (!direction) {
            const endPos = editor.offsetToPos(fullText.length);
            editor.setCursor(endPos);
            editor.scrollIntoView({ from: endPos, to: endPos }, true);
            this.insertionStart = fullText.length;
        }

        this.draftState = 'generating';
        this.onStateChange?.('generating');
        this.onChatUpdate?.();
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

                const insertAt = this.insertionStart + this.insertionLength;
                cm.dispatch({
                    changes: {
                        from: insertAt,
                        to: insertAt,
                        insert: chunk.text
                    },
                    selection: { anchor: insertAt + chunk.text.length }
                });
                this.insertionLength += chunk.text.length;
            }

            console.warn('[Quill Co-writer] Direct continuation context', {
                manuscriptExcerptChars: proseForContext.length,
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
            new Notice(`Quill: Continuation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
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

    /** Reset the entire session. */
    reset(): void {
        this.unlockEditor();
        this.cancelGeneration();
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
    }
}
