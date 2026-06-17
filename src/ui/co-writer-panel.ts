import { App, MarkdownRenderer, TFile } from 'obsidian';
import type EventideQuillPlugin from '../main';
import type { DraftState, CoWriterChatMessage, CoWriterOption, GuidancePhase } from '../ai/co-writer';
import { buildFileLabel, formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { ConfirmModal } from './confirm-modal';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';

type InputMode = 'direct' | 'discuss' | 'guidance';

/** Extract a display name from a vault path. */
function fileNameFromPath(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dotIdx = fileName.lastIndexOf('.');
    return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

/**
 * Renders the Co-writer tab in the Quill sidebar.
 *
 * Layout (pinned bottom like the feedback tab):
 *   containerEl [flex column]
 *     ├── thought section   [shrink]
 *     ├── scroll container  [grow, overflow-y: auto]
 *     │   ├── initialize prompt (when no history)
 *     │   └── chat messages
 *     └── bottom area       [shrink, pinned]
 *         ├── draft status (accept/revert when applicable)
 *         ├── context pills
 *         └── input row (mode toggle + textarea + send)
 *
 * Extends AbstractChatPanel for shared chat infrastructure.
 */
export class CoWriterPanel extends AbstractChatPanel {
    private plugin: EventideQuillPlugin;

    private draftState: DraftState = 'idle';
    private thoughtContent = '';
    private thoughtExpanded = false;
    private chatHistory: CoWriterChatMessage[] = [];
    private currentOptions: CoWriterOption[] = [];
    private optionsLoading = false;
    private inputMode: InputMode = 'direct';
    /** Preserved textarea value across re-renders so user-typed content survives generation. */
    private inputValue = '';
    /** Whether the last message is streaming (in-progress assistant response). */
    private discussStreaming = false;
    /** Current guidance phase, if guidance mode is active. */
    private guidancePhase: GuidancePhase = 'discern';
    /** Whether guidance mode is currently active. */
    private guidanceActive = false;

    private onSendMessage: ((direction: string) => void) | null = null;
    private onDiscussMessage: ((message: string) => void) | null = null;
    private onGenerateOptions: ((direction: string) => void) | null = null;
    private onApplyOption: ((index: number) => void) | null = null;
    private onAccept: (() => void) | null = null;
    private onRevert: (() => void) | null = null;
    private onAddContextFile: ((filePath: string) => void) | null = null;
    private onRemoveContextFile: ((filePath: string) => void) | null = null;
    private onRefreshSuggestions: (() => void) | null = null;
    private onGuidanceMessage: ((message: string, phase: GuidancePhase) => void) | null = null;
    private onGuidanceToOptions: (() => void) | null = null;
    private onEndGuidance: (() => void) | null = null;
    private onAcceptPlan: (() => void) | null = null;
    private onGuidanceWrite: (() => void) | null = null;

    /**
     * Conversation token estimate pushed from the plugin layer.
     * Contains only system prompt + context heads + chat turns.
     * Vault context item tokens are added separately in computeTotalTokens().
     */
    private contextEstimate = 0;

    /**
     * Token estimate for additional context files (added via the ± button).
     * Pushed from the plugin layer when files are added or removed.
     */
    private additionalContextTokens = 0;

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app);
        this.plugin = plugin;
    }

    setContainer(containerEl: HTMLElement): void {
        this.containerEl = containerEl;
        this.render();
        containerEl.addEventListener('keydown', (e: KeyboardEvent) => {
            this.handleKeydown(e);
        });
    }

    setSendMessageHandler(handler: (direction: string) => void): void {
        this.onSendMessage = handler;
    }

    setDiscussMessageHandler(handler: (message: string) => void): void {
        this.onDiscussMessage = handler;
    }

    setGenerateOptionsHandler(handler: (direction: string) => void): void {
        this.onGenerateOptions = handler;
    }

    setApplyOptionHandler(handler: (index: number) => void): void {
        this.onApplyOption = handler;
    }

    setAcceptHandler(handler: () => void): void {
        this.onAccept = handler;
    }

    setRevertHandler(handler: () => void): void {
        this.onRevert = handler;
    }

    setAddContextFileHandler(handler: (filePath: string) => void): void {
        this.onAddContextFile = handler;
    }

    setRemoveContextFileHandler(handler: (filePath: string) => void): void {
        this.onRemoveContextFile = handler;
    }

    setRefreshSuggestionsHandler(handler: () => void): void {
        this.onRefreshSuggestions = handler;
    }

    setGuidanceMessageHandler(handler: (message: string, phase: GuidancePhase) => void): void {
        this.onGuidanceMessage = handler;
    }

    setGuidanceToOptionsHandler(handler: () => void): void {
        this.onGuidanceToOptions = handler;
    }

    setEndGuidanceHandler(handler: () => void): void {
        this.onEndGuidance = handler;
    }

    setAcceptPlanHandler(handler: () => void): void {
        this.onAcceptPlan = handler;
    }

    setGuidanceWriteHandler(handler: () => void): void {
        this.onGuidanceWrite = handler;
    }

    /** Set the current guidance phase. */
    setGuidancePhase(phase: GuidancePhase): void {
        this.guidancePhase = phase;
        this.render();
    }

    /** Set whether guidance mode is active. */
    setGuidanceActive(active: boolean): void {
        this.guidanceActive = active;
        this.render();
    }

    /**
     * Set the conversation token estimate for the token indicator.
     * Called from the plugin layer with conversation-only tokens
     * (system prompt + context heads + chat turns). Vault context item
     * tokens are added on top by computeTotalTokens().
     */
    setContextTokenEstimate(tokens: number): void {
        this.contextEstimate = tokens;
        this.updateTokenIndicator();
    }

    /**
     * Set the additional context file token estimate for the token indicator.
     * Called from the plugin layer when files are added or removed.
     */
    setAdditionalContextTokens(tokens: number): void {
        this.additionalContextTokens = tokens;
        this.updateTokenIndicator();
    }

    setDraftState(state: DraftState): void {
        this.draftState = state;
        if (state === 'idle') {
            this.thoughtContent = '';
            this.thoughtExpanded = false;
        }
        this.scheduleRender();
    }

    setThoughtContent(thought: string): void {
        this.thoughtContent = thought;
        if (thought && this.plugin.settings.enableCoWriterThought) {
            this.thoughtExpanded = true;
            this.scheduleRender();
        }
    }

    setChatHistory(history: CoWriterChatMessage[]): void {
        this.chatHistory = history;
        this.scheduleRender();
    }

    setCurrentOptions(options: CoWriterOption[]): void {
        this.currentOptions = options;
        this.scheduleRender();
    }

    setOptionsLoading(loading: boolean): void {
        this.optionsLoading = loading;
        this.scheduleRender();
    }

    /** Mark the discuss response as starting to stream. */
    discussStartStreaming(): void {
        this.discussStreaming = true;
        this.userScrolledUp = false; // Resume auto-follow on new stream
        // Add a placeholder assistant message
        const last = this.chatHistory[this.chatHistory.length - 1];
        if (!last || last.role !== 'assistant') {
            this.chatHistory.push({ role: 'assistant', content: '' });
        }
        this.scheduleRender();
    }

    /** Append a text chunk to the streaming discuss response. */
    discussAppendChunk(text: string): void {
        let last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.content += text;
        } else {
            this.chatHistory.push({ role: 'assistant', content: text });
            last = this.chatHistory[this.chatHistory.length - 1];
        }
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-cowriter-chat-streaming');
        if (el) el.setText(last?.content ?? '');
        // Auto-scroll only if the user hasn't scrolled up
        if (!this.userScrolledUp) {
            this.scrollToBottom();
        }
    }

    /** Mark the discuss response as complete; re-render with markdown. */
    async discussFinished(): Promise<void> {
        this.discussStreaming = false;
        this.scheduleRender();
    }

    /** Show an error in the last discuss response. */
    async discussError(message: string): Promise<void> {
        this.discussStreaming = false;
        const last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.content = `Error: ${message}`;
        }
        this.scheduleRender();
    }

    private getContextFiles(): string[] {
        return this.plugin.coWriterSession?.getContextFiles() ?? [];
    }

    /** File paths already included via the context tab (vault context assembly). */
    private getVaultContextFiles(): string[] {
        return (this.plugin.currentAssembly?.contextItems ?? []).map((item) => item.filePath);
    }

    /** Full rebuild of the panel DOM. */
    render(): void {
        if (!this.containerEl) return;

        // Save scroll positions and textarea focus before destroying DOM
        const savedThoughtScroll = this.containerEl.querySelector('.quill-cowriter-thought-content')?.scrollTop ?? 0;
        const textareaHadFocus =
            this.containerEl.querySelector('.quill-cowriter-input') === window.activeDocument.activeElement;

        this.unloadAndClearContainer();

        // Thought section during generation (options or draft streaming)
        if ((this.draftState === 'generating' || this.optionsLoading) && this.plugin.settings.enableCoWriterThought) {
            this.renderThoughtSection();
        }

        // Scrollable chat area
        this.renderChatArea();

        // Pinned bottom area
        this.renderBottomArea();

        // Restore thought section scroll position
        if (savedThoughtScroll > 0) {
            const newThoughtContent = this.containerEl.querySelector('.quill-cowriter-thought-content');
            if (newThoughtContent) {
                newThoughtContent.scrollTop = savedThoughtScroll;
            }
        }

        // Restore textarea focus if the user was typing when generation completed
        if (textareaHadFocus) {
            const newTextarea = this.containerEl.querySelector<HTMLTextAreaElement>('.quill-cowriter-input');
            if (newTextarea) {
                newTextarea.focus();
            }
        }
    }

    /** Render the thought channel section (only during draft generation). */
    private renderThoughtSection(): void {
        const section = this.containerEl!.createEl('div', { cls: 'quill-cowriter-section' });

        const toggle = section.createEl('div', { cls: 'quill-cowriter-thought-toggle' });
        toggle.createEl('span', {
            cls: 'quill-cowriter-thought-icon',
            text: this.thoughtExpanded ? '\u25bc' : '\u25b6'
        });
        toggle.createEl('span', { text: 'AI reasoning' });

        if (this.thoughtContent) {
            this.renderEvents.registerDomEvent(toggle, 'click', () => {
                this.thoughtExpanded = !this.thoughtExpanded;
                this.scheduleRender();
            });

            if (this.thoughtExpanded) {
                const content = section.createEl('div', { cls: 'quill-cowriter-thought-content' });
                content.setText(this.thoughtContent);
            }
        } else {
            toggle.createEl('span', { text: ' (Thinking...)' });
        }
    }

    /** Render the scrollable chat area with messages or initialize prompt. */
    private renderChatArea(): void {
        const scroll = this.containerEl!.createEl('div', { cls: 'quill-sidebar-content-plain' });

        if (this.chatHistory.length === 0 && !this.optionsLoading) {
            this.renderInitializePrompt(scroll);
        } else {
            for (const msg of this.chatHistory) {
                if (msg.role === 'user') {
                    const bubble = scroll.createEl('div', {
                        cls: 'quill-cowriter-chat-bubble quill-cowriter-chat-user'
                    });
                    bubble.setText(msg.content);
                } else if (msg.role === 'assistant') {
                    const bubble = scroll.createEl('div', {
                        cls: 'quill-cowriter-chat-bubble quill-cowriter-chat-assistant'
                    });

                    // Per-message thought/reasoning — start expanded
                    if (msg.thought && this.plugin.settings.enableCoWriterThought) {
                        const thoughtToggle = bubble.createEl('div', { cls: 'quill-cowriter-message-thought-toggle' });
                        thoughtToggle.createEl('span', { cls: 'quill-cowriter-thought-icon', text: '\u25bc' });
                        thoughtToggle.createEl('span', { text: 'AI reasoning' });
                        const thoughtContent = bubble.createEl('div', {
                            cls: 'quill-cowriter-message-thought-content',
                            text: msg.thought
                        });
                        this.renderEvents.registerDomEvent(thoughtToggle, 'click', () => {
                            const collapsed = thoughtContent.hasClass('quill-cowriter-thought-collapsed');
                            if (collapsed) {
                                thoughtContent.removeClass('quill-cowriter-thought-collapsed');
                                thoughtToggle.querySelector('.quill-cowriter-thought-icon')!.textContent = '\u25bc';
                            } else {
                                thoughtContent.addClass('quill-cowriter-thought-collapsed');
                                thoughtToggle.querySelector('.quill-cowriter-thought-icon')!.textContent = '\u25b6';
                            }
                        });
                    }

                    if (msg.options && msg.options.length > 0) {
                        bubble.createEl('div', { cls: 'quill-cowriter-options-intro', text: msg.content });
                        const optionsContainer = bubble.createEl('div', { cls: 'quill-cowriter-options' });
                        for (let i = 0; i < msg.options.length; i++) {
                            this.renderOptionCard(optionsContainer, msg.options[i]!, i);
                        }
                    } else {
                        // Render completed discuss responses as markdown
                        const isStreaming =
                            msg === this.chatHistory[this.chatHistory.length - 1] && this.discussStreaming;
                        const responseEl = bubble.createEl('div', { cls: 'quill-cowriter-response-text' });
                        if (isStreaming) {
                            responseEl.addClass('quill-cowriter-chat-streaming');
                            responseEl.setText(msg.content || '\u2026');
                        } else {
                            void MarkdownRenderer.render(
                                this.app,
                                normalizeParagraphBreaks(msg.content),
                                responseEl,
                                '',
                                this.renderEvents
                            );
                        }
                    }

                    // Accept button for plan revision
                    if (msg.showAccept) {
                        const acceptBtn = bubble.createEl('button', {
                            cls: 'quill-cowriter-plan-accept mod-cta',
                            text: 'Accept plan and generate options'
                        });
                        this.renderEvents.registerDomEvent(acceptBtn, 'click', () => {
                            this.onAcceptPlan?.();
                        });
                    }
                }
            }

            if (this.optionsLoading) {
                const bubble = scroll.createEl('div', {
                    cls: 'quill-cowriter-chat-bubble quill-cowriter-chat-assistant quill-cowriter-chat-streaming'
                });
                bubble.setText('Thinking...');
            }
        }

        // Scroll listener: if user scrolls up during streaming, stop auto-follow
        this.registerScrollListener(scroll);

        // Auto-scroll to bottom
        scroll.scrollTop = scroll.scrollHeight;
    }

    /** Render the initialize prompt with a big button. */
    private renderInitializePrompt(container: HTMLElement): void {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            const prompt = container.createEl('div', { cls: 'quill-cowriter-init' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-init-desc',
                text: 'Open a manuscript to use the co-writer.'
            });
            return;
        }

        const prompt = container.createEl('div', { cls: 'quill-cowriter-init' });
        prompt.createEl('div', { cls: 'quill-cowriter-init-icon', text: '\u270e' });
        prompt.createEl('div', { cls: 'quill-cowriter-init-heading', text: 'Co-writer' });
        prompt.createEl('div', {
            cls: 'quill-cowriter-init-desc',
            text: 'Let the AI read your scene and suggest 3 possible directions to continue.'
        });
        const initBtn = prompt.createEl('button', {
            cls: 'quill-cowriter-init-btn mod-cta',
            text: 'Initialize from scene'
        });
        this.renderEvents.registerDomEvent(initBtn, 'click', () => {
            if (this.optionsLoading || this.draftState === 'generating') return;
            this.optionsLoading = true;
            // Immediate disable — no rAF delay
            initBtn.disabled = true;
            this.scheduleRender();
            this.onGenerateOptions?.('');
        });
    }

    /** Render a single option card with label, description, and Apply button. */
    private renderOptionCard(container: HTMLElement, option: CoWriterOption, index: number): void {
        const expired = !this.currentOptions[index];
        const card = container.createEl('div', {
            cls: `quill-cowriter-option-card${expired ? ' quill-cowriter-option-expired' : ''}`
        });
        card.createEl('div', { cls: 'quill-cowriter-option-label', text: option.label });
        card.createEl('div', { cls: 'quill-cowriter-option-desc', text: option.description });

        if (expired) {
            card.createEl('span', { cls: 'quill-cowriter-option-expired-label', text: 'No longer available' });
            return;
        }

        const applyBtn = card.createEl('button', {
            cls: 'quill-cowriter-option-apply mod-cta',
            text: this.draftState !== 'idle' ? 'Generating\u2026' : 'Apply'
        });
        if (this.draftState !== 'idle') {
            applyBtn.addClass('quill-cowriter-option-applying');
        }
        const idx = index;
        this.renderEvents.registerDomEvent(applyBtn, 'click', () => {
            if (this.draftState !== 'idle') return;
            this.draftState = 'generating';
            this.scheduleRender();
            this.onApplyOption?.(idx);
        });
    }

    /** Render the pinned bottom area (draft status, context pills, input row). */
    private renderBottomArea(): void {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile && this.chatHistory.length === 0) return;

        const bottom = this.containerEl!.createEl('div', { cls: 'quill-cowriter-bottom' });

        // Draft status (accept/revert) — only when applicable
        if (this.draftState === 'draft') {
            const status = bottom.createEl('div', { cls: 'quill-cowriter-status-bar' });
            status.createEl('span', { text: 'Draft ready \u2014 ' });
            const acceptBtn = status.createEl('button', {
                cls: 'quill-cowriter-status-btn quill-cowriter-accept-btn',
                text: 'Accept'
            });
            this.renderEvents.registerDomEvent(acceptBtn, 'click', () => {
                this.onAccept?.();
            });
            status.createEl('span', { text: ' ' });
            const revertBtn = status.createEl('button', {
                cls: 'quill-cowriter-status-btn quill-cowriter-revert-btn',
                text: 'Revert'
            });
            this.renderEvents.registerDomEvent(revertBtn, 'click', () => {
                this.onRevert?.();
            });
        }

        // Guidance mode UI
        if (this.inputMode === 'guidance') {
            const guidanceBar = bottom.createEl('div', { cls: 'quill-cowriter-guidance-bar' });

            // Phase indicator
            const phaseLabel = guidanceBar.createEl('span', { cls: 'quill-cowriter-guidance-phase' });
            const phaseNames: Record<GuidancePhase, string> = {
                discern: 'Phase 1: Analyzing intent...',
                clarify: 'Phase 2: Clarifying questions...',
                plan: 'Phase 3: Building plan...',
                direction: 'Phase 4: Executable direction'
            };
            phaseLabel.setText(
                this.guidanceActive ? phaseNames[this.guidancePhase] : 'Guide mode \u2014 AI will analyze your passage'
            );

            // End guidance button
            if (this.guidanceActive) {
                guidanceBar.createEl('span', { text: ' ' });
                const endBtn = guidanceBar.createEl('button', {
                    cls: 'quill-cowriter-guidance-end-btn',
                    text: 'End guidance'
                });
                this.renderEvents.registerDomEvent(endBtn, 'click', () => {
                    this.onEndGuidance?.();
                });

                // Write guidance button (available at any phase)
                guidanceBar.createEl('span', { text: ' ' });
                const writeBtn = guidanceBar.createEl('button', {
                    cls: 'quill-cowriter-guidance-options-btn',
                    text: 'Write guidance'
                });
                this.renderEvents.registerDomEvent(writeBtn, 'click', () => {
                    this.onGuidanceWrite?.();
                });

                // Generate options button (if guidance is complete)
                if (this.guidancePhase === 'direction') {
                    guidanceBar.createEl('span', { text: ' ' });
                    const optionsBtn = guidanceBar.createEl('button', {
                        cls: 'quill-cowriter-guidance-options-btn',
                        text: 'Generate options'
                    });
                    this.renderEvents.registerDomEvent(optionsBtn, 'click', () => {
                        this.onGuidanceToOptions?.();
                    });
                }
            }
        }

        // Context file pills
        const contextFiles = this.getContextFiles();
        if (contextFiles.length > 0) {
            const ctxRow = bottom.createEl('div', { cls: 'quill-cowriter-ctx-row' });
            for (const filePath of contextFiles) {
                const pill = ctxRow.createEl('span', { cls: 'quill-cowriter-ctx-pill' });
                pill.createEl('span', { text: fileNameFromPath(filePath) });
                const removeBtn = pill.createEl('button', {
                    cls: 'quill-cowriter-ctx-remove',
                    text: '\u00d7'
                });
                this.renderEvents.registerDomEvent(removeBtn, 'click', () => {
                    this.onRemoveContextFile?.(filePath);
                });
            }
        }

        // Input row
        this.renderInputRow(bottom);

        // Token indicator — below the input, reflects what the AI sees
        if (this.maxAllowedTokens > 0) {
            const totalTokens = this.computeTotalTokens();
            const vaultContextCount = this.getVaultContextFiles().length;
            const label = buildFileLabel(contextFiles.length, vaultContextCount);
            bottom.createEl('div', {
                cls: 'quill-cowriter-token-indicator',
                text: formatTokenIndicatorText(label, totalTokens, this.maxAllowedTokens)
            });
        }
    }

    /** Render the input row with mode toggle, textarea, and send button. */
    private renderInputRow(container: HTMLElement): void {
        const generating = this.optionsLoading || this.draftState === 'generating';

        // Buttons row — mode toggle, add context, refresh, send/stop
        const btnRow = container.createEl('div', { cls: 'quill-cowriter-btn-row' });

        const modeBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-mode-btn${this.inputMode === 'guidance' ? ' quill-cowriter-mode-guidance' : this.inputMode === 'discuss' ? ' quill-cowriter-mode-discuss' : ''}`,
            text:
                this.inputMode === 'direct'
                    ? '\u2192 Direct'
                    : this.inputMode === 'discuss'
                      ? '\u2194 Discuss'
                      : '\u2728 Guide',
            title:
                this.inputMode === 'direct'
                    ? 'Direct: AI suggests 3 continuation options'
                    : this.inputMode === 'discuss'
                      ? 'Discuss: AI responds with thoughts and analysis'
                      : 'Guide: AI helps you figure out what to do next'
        });
        if (generating) modeBtn.disabled = true;
        this.renderEvents.registerDomEvent(modeBtn, 'click', () => {
            if (generating) return;
            const modes: InputMode[] = ['direct', 'discuss', 'guidance'];
            const currentIndex = modes.indexOf(this.inputMode);
            const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % modes.length : 0;
            const nextMode = modes[nextIndex];
            if (nextMode) {
                this.inputMode = nextMode;
                this.scheduleRender();
            }
        });

        const addCtxBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-ctx-add',
            text: '\u00b1',
            title: 'Add file to context'
        });
        if (generating) addCtxBtn.disabled = true;
        this.renderEvents.registerDomEvent(addCtxBtn, 'click', () => {
            if (generating) return;
            const activeFile = this.app.workspace.getActiveFile();
            new VaultFileSuggestModal(
                this.app,
                (file: TFile) => {
                    this.onAddContextFile?.(file.path);
                },
                [activeFile?.path ?? '', ...this.getContextFiles(), ...this.getVaultContextFiles()]
            ).open();
        });

        const refreshBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-refresh-btn',
            text: '\u21bb',
            title: 'Refresh suggestions'
        });
        if (generating) refreshBtn.disabled = true;
        this.renderEvents.registerDomEvent(refreshBtn, 'click', () => {
            if (this.optionsLoading || this.draftState === 'generating') return;
            this.optionsLoading = true;
            refreshBtn.disabled = true;
            actionBtn.setText('Stop');
            actionBtn.addClass('quill-cowriter-stop-btn');
            this.scheduleRender();
            this.onGenerateOptions?.('');
        });

        // Compact button
        const compactBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-compact-btn',
            text: '\u00bb\u00bb',
            title: 'Compact conversation'
        });
        if (generating) compactBtn.disabled = true;
        this.renderEvents.registerDomEvent(compactBtn, 'click', () => {
            this.onCompact?.();
        });

        // New chat button
        const newChatBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-new-chat-btn',
            text: '\u2713',
            title: 'New chat'
        });
        if (generating) newChatBtn.disabled = true;
        this.renderEvents.registerDomEvent(newChatBtn, 'click', () => {
            new ConfirmModal(
                this.app,
                'New chat',
                'Start a new chat? The conversation will be cleared. Manuscript and vault context files will be kept.',
                () => {
                    this.onNewChat?.(false);
                },
                'Keep context',
                {
                    text: 'Clear context too',
                    handler: () => {
                        this.onNewChat?.(true);
                    }
                }
            ).open();
        });

        // Spacer to push send/stop to the right
        btnRow.createEl('div', { cls: 'quill-cowriter-btn-spacer' });

        const actionBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-send-btn mod-cta${generating ? ' quill-cowriter-stop-btn' : ''}`,
            text: generating ? 'Stop' : 'Send'
        });

        // Textarea row — below the buttons, ~10 lines tall
        const taRow = container.createEl('div', { cls: 'quill-cowriter-ta-row' });
        const input = taRow.createEl('textarea', {
            cls: 'quill-cowriter-input',
            placeholder:
                this.inputMode === 'direct'
                    ? 'Describe what should happen next\u2026'
                    : this.inputMode === 'guidance'
                      ? "Describe your intent or answer the AI's questions\u2026"
                      : 'Discuss the scene, ask questions, brainstorm\u2026'
        });
        input.value = this.inputValue;

        // Track value changes for persistence across re-renders
        this.renderEvents.registerDomEvent(input, 'input', () => {
            this.inputValue = input.value;
        });

        const doSend = () => {
            if (this.optionsLoading || this.draftState === 'generating') return;
            const text = input.value.trim();
            if (!text) return;
            this.userScrolledUp = false; // Resume auto-follow on new message
            this.inputValue = '';
            input.value = '';
            if (this.inputMode === 'direct') {
                this.draftState = 'generating';
            } else {
                this.optionsLoading = true;
            }
            actionBtn.setText('Stop');
            actionBtn.addClass('quill-cowriter-stop-btn');
            refreshBtn.disabled = true;
            this.scheduleRender();
            if (this.inputMode === 'direct') {
                this.onSendMessage?.(text);
            } else if (this.inputMode === 'guidance') {
                this.onGuidanceMessage?.(text, this.guidancePhase);
            } else {
                this.onDiscussMessage?.(text);
            }
        };

        const doStop = () => {
            this.onCancelGeneration?.();
        };

        this.renderEvents.registerDomEvent(actionBtn, 'click', () => {
            if (generating) {
                doStop();
            } else {
                doSend();
            }
        });

        this.renderEvents.registerDomEvent(input, 'keydown', (e: KeyboardEvent) => {
            if (this.optionsLoading || this.draftState === 'generating') return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                doSend();
            }
        });
    }

    /** Handle Escape key globally within the panel. */
    handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && (this.optionsLoading || this.draftState === 'generating')) {
            e.preventDefault();
            this.onCancelGeneration?.();
        }
    }

    /** Recompute the context indicator text in-place (without full re-render). */
    private updateTokenIndicator(): void {
        if (!this.containerEl) return;
        const indicator = this.containerEl.querySelector('.quill-cowriter-token-indicator');
        if (!indicator) return;
        if (this.maxAllowedTokens <= 0) return;
        const contextFiles = this.getContextFiles();
        const vaultContextCount = this.getVaultContextFiles().length;
        const label = buildFileLabel(contextFiles.length, vaultContextCount);
        const totalTokens = this.computeTotalTokens();
        indicator.setText(formatTokenIndicatorText(label, totalTokens, this.maxAllowedTokens));
    }

    /**
     * Compute the total token estimate for the context indicator.
     * Combines conversation tokens, additional context file tokens, and
     * vault context item tokens so the full context window usage is shown.
     */
    private computeTotalTokens(): number {
        let total = this.contextEstimate + this.additionalContextTokens;
        const assembly = this.plugin.currentAssembly;
        if (assembly) {
            for (const item of assembly.contextItems) {
                total += item.tokenEstimate;
            }
        }
        return total;
    }
}
