import { App, MarkdownRenderer, Notice } from 'obsidian';
import { buildFileLabel, formatTokenIndicatorText } from './token-indicator';
import { AbstractChatPanel, normalizeParagraphBreaks } from './chat-panel';
import { ConfirmModal } from './confirm-modal';
import { VaultFileSuggestModal } from './vault-file-suggest-modal';
import { buildEmbedFolderPath, embedFolderLabel, parseEmbedFolderPath } from '../utils/vault-files';
import { renderChangeBulkBar, renderChangeCard } from './change-card';
import { renderLoreDraftCard } from './lore-entry-review';
import type EventideQuillPlugin from '../main';
import type {
    DraftState,
    CoWriterChatMessage,
    CoWriterOption,
    CoachPhase,
    LoreCoachPhase,
    LoreDraftEntry
} from '../ai/co-writer';
import type { ProposedEdit } from '../core/change-set';

export type InputMode = 'direct' | 'discuss' | 'coach' | 'fulfill' | 'lorebook';

/** The co-writer modes, in cycle/picker order, with icon, label, and a one-line descriptor. */
const COWRITER_MODES: { mode: InputMode; icon: string; label: string; desc: string }[] = [
    { mode: 'direct', icon: '\u2192', label: 'Direct', desc: 'Type a direction and the AI continues from the cursor' },
    { mode: 'discuss', icon: '\u2194', label: 'Discuss', desc: 'AI responds with thoughts and analysis' },
    { mode: 'coach', icon: '\u2728', label: 'Coach', desc: 'AI helps you figure out what to do next' },
    { mode: 'fulfill', icon: '\u2726', label: 'Fulfill', desc: 'Sweep every inline directive and review as a diff' },
    {
        mode: 'lorebook',
        icon: '\u{1f4d6}',
        label: 'Lorebook',
        desc: 'Develop characters and lore entries with AI tools'
    }
];

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
    private inputMode: InputMode = 'coach';
    /** Preserved textarea value across re-renders so user-typed content survives generation. */
    private inputValue = '';
    /** Whether the last message is streaming (in-progress assistant response). */
    private discussStreaming = false;
    /** Current coach phase, if coach mode is active. */
    private coachPhase: CoachPhase = 'discern';
    /** Whether coach mode is currently active. */
    private coachActive = false;
    /** Path of the plot map note linked to the active manuscript, or null when none is linked. */
    private plotMap: string | null = null;
    /** Whether an inline directive is active at the cursor (drives the Direct-mode badge). */
    private directiveActive = false;
    /** Fulfill-mode proposed edits (mirrored from the session), rendered as review cards. */
    private fulfillSections: ProposedEdit[] = [];
    /** Whether a Fulfill sweep is currently generating. */
    private fulfillActive = false;
    /** Direct-mode proposed continuation (mirrored from the session), rendered as a review card. */
    private directChange: ProposedEdit | null = null;
    /** Pending lore edits (from edit_note / append_to_note tools), one card per file. */
    private loreEdits: { edit: ProposedEdit; filePath: string; fileBasename: string }[] = [];
    /** Whether the mode picker is open (replaces the mode-cycle-on-click behavior). */
    private modePickerOpen = false;
    /** Current lorebook coach phase, if lorebook coach mode is active. */
    private loreCoachPhase: LoreCoachPhase = 'discover';
    /** Whether lorebook coach mode is currently active. */
    private loreCoachActive = false;

    private onSendMessage: ((direction: string) => void) | null = null;
    private onDiscussMessage: ((message: string) => void) | null = null;
    private onGenerateOptions: ((direction: string) => void) | null = null;
    private onApplyOption: ((index: number) => void) | null = null;
    private onAddContextFile: ((filePath: string) => void) | null = null;
    private onRemoveContextFile: ((filePath: string) => void) | null = null;
    private onRefreshSuggestions: (() => void) | null = null;
    private onCoachMessage: ((message: string) => void) | null = null;
    private onCoachToOptions: (() => void) | null = null;
    private onEndCoach: (() => void) | null = null;
    private onAcceptPlan: (() => void) | null = null;
    private onCoachWrite: (() => void) | null = null;
    private onLinkPlotMap: ((filePath: string) => void) | null = null;
    private onClearPlotMap: (() => void) | null = null;
    private onRunFulfill: ((globalInstruction: string) => void) | null = null;
    private onApproveFulfillSection: ((id: number) => void) | null = null;
    private onRejectFulfillSection: ((id: number) => void) | null = null;
    private onApproveAllFulfill: (() => void) | null = null;
    private onRejectAllFulfill: (() => void) | null = null;
    private onApproveDirect: ((id: number) => void) | null = null;
    private onRejectDirect: ((id: number) => void) | null = null;
    private onLoreCoachMessage: ((message: string) => void) | null = null;
    private onEndLoreCoach: (() => void) | null = null;
    private onDiscardLoreDraft: ((draft: LoreDraftEntry) => void) | null = null;
    private onApproveLoreEdit: ((filePath: string, id: number) => void) | null = null;
    private onRejectLoreEdit: ((filePath: string) => void) | null = null;

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

    /**
     * Token estimate for the linked plot map note.
     * Pushed from the plugin layer when the plot map link changes.
     */
    private plotMapTokens = 0;

    /** Promises from async MarkdownRenderer.render() calls during the current render cycle. */
    private renderPromises: Promise<void>[] = [];

    /** Monotonic render counter; used to discard stale async finalizations. */
    private renderId = 0;

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app);
        this.plugin = plugin;
    }

    setContainer(containerEl: HTMLElement): void {
        if (this.containerEl && this.keydownHandler) {
            this.containerEl.removeEventListener('keydown', this.keydownHandler);
        }
        this.containerEl = containerEl;
        this.render();
        this.keydownHandler = (e: KeyboardEvent) => {
            this.handleKeydown(e);
        };
        containerEl.addEventListener('keydown', this.keydownHandler);
    }

    /** Set the handler invoked when the user sends a direction in Direct mode. */
    setSendMessageHandler(handler: (direction: string) => void): void {
        this.onSendMessage = handler;
    }

    /** Set the handler invoked when the user sends a discussion (brainstorming) message. */
    setDiscussMessageHandler(handler: (message: string) => void): void {
        this.onDiscussMessage = handler;
    }

    /** Set the handler invoked to generate continuation options from the cursor. */
    setGenerateOptionsHandler(handler: (direction: string) => void): void {
        this.onGenerateOptions = handler;
    }

    /** Set the handler invoked when the user applies (inserts) a continuation option. */
    setApplyOptionHandler(handler: (index: number) => void): void {
        this.onApplyOption = handler;
    }

    /** Set the handler invoked when the user adds a context file to the session. */
    setAddContextFileHandler(handler: (filePath: string) => void): void {
        this.onAddContextFile = handler;
    }

    /** Set the handler invoked when the user removes a context file from the session. */
    setRemoveContextFileHandler(handler: (filePath: string) => void): void {
        this.onRemoveContextFile = handler;
    }

    /** Set the handler invoked to refresh continuation suggestions. */
    setRefreshSuggestionsHandler(handler: () => void): void {
        this.onRefreshSuggestions = handler;
    }

    /** Set the handler invoked when the user submits a coach message. */
    setCoachMessageHandler(handler: (message: string) => void): void {
        this.onCoachMessage = handler;
    }

    /** Set the handler invoked to convert a coach plan into continuation options. */
    setCoachToOptionsHandler(handler: () => void): void {
        this.onCoachToOptions = handler;
    }

    /** Set the handler invoked to end the current coach session. */
    setEndCoachHandler(handler: () => void): void {
        this.onEndCoach = handler;
    }

    /** Set the handler invoked when the user accepts a coach plan. */
    setAcceptPlanHandler(handler: () => void): void {
        this.onAcceptPlan = handler;
    }

    /** Set the handler invoked to trigger a coach-driven write. */
    setCoachWriteHandler(handler: () => void): void {
        this.onCoachWrite = handler;
    }

    /** Set the handler invoked when the user links a plot map note to the manuscript. */
    setLinkPlotMapHandler(handler: (filePath: string) => void): void {
        this.onLinkPlotMap = handler;
    }

    /** Set the handler invoked when the user unlinks the plot map. */
    setClearPlotMapHandler(handler: () => void): void {
        this.onClearPlotMap = handler;
    }

    /** Set the current plot map link path (null = none linked). */
    setPlotMap(path: string | null): void {
        this.plotMap = path && path.length > 0 ? path : null;
        this.scheduleRender();
    }

    /** Set the handler invoked to run a Fulfill sweep. The text is an optional global instruction. */
    setRunFulfillHandler(handler: (globalInstruction: string) => void): void {
        this.onRunFulfill = handler;
    }

    /** Set the handler invoked to approve one Fulfill section by id. */
    setApproveFulfillSectionHandler(handler: (id: number) => void): void {
        this.onApproveFulfillSection = handler;
    }

    /** Set the handler invoked to reject one Fulfill section by id. */
    setRejectFulfillSectionHandler(handler: (id: number) => void): void {
        this.onRejectFulfillSection = handler;
    }

    /** Set the handler invoked to approve all pending Fulfill sections. */
    setApproveAllFulfillHandler(handler: () => void): void {
        this.onApproveAllFulfill = handler;
    }

    /** Set the handler invoked to reject all pending Fulfill sections. */
    setRejectAllFulfillHandler(handler: () => void): void {
        this.onRejectAllFulfill = handler;
    }

    /** Set the handler invoked to approve the pending Direct continuation by id. */
    setApproveDirectHandler(handler: (id: number) => void): void {
        this.onApproveDirect = handler;
    }

    /** Set the handler invoked to reject the pending Direct continuation by id. */
    setRejectDirectHandler(handler: (id: number) => void): void {
        this.onRejectDirect = handler;
    }

    /** Replace the Direct continuation edit (null = none pending) and re-render. */
    setDirectChange(edit: ProposedEdit | null): void {
        this.directChange = edit;
        this.scheduleRender();
    }

    /** Replace the pending lore edits list and re-render. */
    setLoreEdits(edits: { edit: ProposedEdit; filePath: string; fileBasename: string }[]): void {
        this.loreEdits = edits;
        this.scheduleRender();
    }

    /** Set the handler invoked to approve a pending lore edit by file path + id. */
    setApproveLoreEditHandler(handler: (filePath: string, id: number) => void): void {
        this.onApproveLoreEdit = handler;
    }

    /** Set the handler invoked to reject a pending lore edit by file path. */
    setRejectLoreEditHandler(handler: (filePath: string) => void): void {
        this.onRejectLoreEdit = handler;
    }

    /** Replace the Fulfill section list and/or active flag and re-render. */
    setFulfillState(sections: ProposedEdit[], active: boolean): void {
        this.fulfillSections = sections;
        this.fulfillActive = active;
        this.scheduleRender();
    }

    /** Set the active input mode (e.g. from the right-click submenu). */
    setMode(mode: InputMode): void {
        const oldMode = this.inputMode;
        this.inputMode = mode;
        this.modePickerOpen = false;
        // Entering or leaving a stateful mode resets the chat so the new mode
        // starts fresh: fulfill holds its own ChangeSet, lorebook holds its
        // own session state, and neither should inherit the other's history.
        if (
            oldMode !== mode &&
            (oldMode === 'fulfill' || mode === 'fulfill' || oldMode === 'lorebook' || mode === 'lorebook')
        ) {
            this.onNewChat?.(false);
        }
        this.scheduleRender();
    }

    /** Set the current coach phase. */
    setCoachPhase(phase: CoachPhase): void {
        this.coachPhase = phase;
        this.render();
    }

    /** Set whether coach mode is active. */
    setCoachActive(active: boolean): void {
        this.coachActive = active;
        this.render();
    }

    /** Set the handler invoked when the user sends a message in lorebook coach mode. */
    setLoreCoachMessageHandler(handler: (message: string) => void): void {
        this.onLoreCoachMessage = handler;
    }

    /** Set the handler invoked to end the lorebook coach session. */
    setEndLoreCoachHandler(handler: () => void): void {
        this.onEndLoreCoach = handler;
    }

    /** Set the handler invoked when the user discards a proposed lore draft. */
    setDiscardLoreDraftHandler(handler: (draft: LoreDraftEntry) => void): void {
        this.onDiscardLoreDraft = handler;
    }

    /** Replace the lorebook coach phase (drives the bottom-bar indicator). */
    setLoreCoachPhase(phase: LoreCoachPhase): void {
        this.loreCoachPhase = phase;
        this.render();
    }

    /** Set whether lorebook coach mode is active. */
    setLoreCoachActive(active: boolean): void {
        this.loreCoachActive = active;
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

    /** Set the plot map token estimate for the token indicator.
     *  Called from the plugin layer when the plot map link changes. */
    setPlotMapTokens(tokens: number): void {
        this.plotMapTokens = tokens;
        this.updateTokenIndicator();
    }

    /** Set the current draft streaming state (idle, generating, done). */
    setDraftState(state: DraftState): void {
        this.draftState = state;
        if (state === 'idle') {
            this.thoughtContent = '';
            this.thoughtExpanded = false;
        }
        this.scheduleRender();
    }

    /** Update the thought/reasoning content shown during generation. */
    setThoughtContent(thought: string): void {
        this.thoughtContent = thought;
        if (thought && this.plugin.settings.enableCoWriterThought) {
            this.thoughtExpanded = true;
            this.scheduleRender();
        }
    }

    /** Replace the full co-writer chat history and re-render. */
    setChatHistory(history: CoWriterChatMessage[]): void {
        this.chatHistory = history;
        this.scheduleRender();
    }

    /** Replace the current continuation options and re-render. */
    setCurrentOptions(options: CoWriterOption[]): void {
        this.currentOptions = options;
        if (options.length > 0) {
            this.userScrolledUp = false;
        }
        this.scheduleRender();
    }

    /** Set whether continuation options are currently being generated. */
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
        const el = this.containerEl.querySelector('.quill-cowriter-panel__response-text--streaming');
        if (el) {
            el.setText(last?.content ?? '');
        } else if (text) {
            // Streaming element not yet rendered — schedule a full render
            this.scheduleRender();
        }
        // Auto-scroll only if the user hasn't scrolled up.
        // Use rAF so the browser has reflowed with the new content first.
        if (!this.userScrolledUp) {
            window.requestAnimationFrame(() => {
                if (!this.containerEl) return;
                if (this.userScrolledUp) return;
                this.scrollToBottom();
            });
        }
    }

    /**
     * Clear the streaming text display and the last assistant message's
     * accumulated content. Used by the Lorebook Coach to discard "draft" text
     * the model emitted before its reasoning block — reasoning models
     * sometimes preface their `<think>` tag with a partial response that they
     * repeat verbatim after reasoning concludes, and without this clear the
     * two copies concatenate into a duplicated block.
     */
    discussClearStreaming(): void {
        const last = this.chatHistory[this.chatHistory.length - 1];
        if (last && last.role === 'assistant') {
            last.content = '';
        }
        if (!this.containerEl) return;
        const el = this.containerEl.querySelector('.quill-cowriter-panel__response-text--streaming');
        if (el) {
            el.setText('');
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

        // Save scroll state and textarea focus before destroying DOM
        const previousScroll = this.getScrollContainer();
        const savedScrollTop = previousScroll?.scrollTop ?? 0;
        const wasAtBottom = !this.userScrolledUp || (previousScroll ? this.isScrollAtBottom() : true);
        const savedThoughtScroll =
            this.containerEl.querySelector('.quill-cowriter-panel__thought-content')?.scrollTop ?? 0;
        const textareaHadFocus =
            this.containerEl.querySelector('.quill-cowriter-panel__input') ===
            this.containerEl.ownerDocument.activeElement;

        const currentRenderId = ++this.renderId;
        this.renderPending = true;
        this.unloadAndClearContainer();
        this.renderPromises = [];

        // Thought section during generation (options or draft streaming)
        if ((this.draftState === 'generating' || this.optionsLoading) && this.plugin.settings.enableCoWriterThought) {
            this.renderThoughtSection();
        }

        // Scrollable chat area (populates this.renderPromises)
        this.renderChatArea();

        // Pinned bottom area
        this.renderBottomArea();

        // Restore thought section scroll position
        if (savedThoughtScroll > 0) {
            const newThoughtContent = this.containerEl.querySelector('.quill-cowriter-panel__thought-content');
            if (newThoughtContent) {
                newThoughtContent.scrollTop = savedThoughtScroll;
            }
        }

        // Restore textarea focus if the user was typing when generation completed
        if (textareaHadFocus) {
            const newTextarea = this.containerEl.querySelector<HTMLTextAreaElement>('.quill-cowriter-panel__input');
            if (newTextarea) {
                newTextarea.focus();
            }
        }

        // Initial scroll restoration  (before async markdown content resolves)
        if (wasAtBottom) {
            this.scrollToBottom();
        } else if (savedScrollTop > 0) {
            const c = this.getScrollContainer();
            if (c) {
                c.scrollTop = Math.min(savedScrollTop, Math.max(0, c.scrollHeight - c.clientHeight));
            }
        }

        this.renderPending = false;

        // Finalize scroll after all async markdown renders are in the DOM.
        // Using renderId guard so a stale callback can't overwrite a newer render's scroll.
        if (this.renderPromises.length > 0) {
            void Promise.all(this.renderPromises).then(() => {
                if (this.renderId !== currentRenderId) return;
                if (wasAtBottom) {
                    this.scrollToBottom();
                } else if (savedScrollTop > 0) {
                    const c = this.getScrollContainer();
                    if (c) {
                        c.scrollTop = Math.min(savedScrollTop, Math.max(0, c.scrollHeight - c.clientHeight));
                    }
                }
            });
        }
    }

    /** Render the thought channel section (only during draft generation). */
    private renderThoughtSection(): void {
        const section = this.containerEl!.createEl('div', { cls: 'quill-cowriter-panel__section' });

        const toggle = section.createEl('div', { cls: 'quill-cowriter-panel__thought-toggle' });
        toggle.createEl('span', {
            cls: 'quill-cowriter-panel__thought-icon',
            text: this.thoughtExpanded ? '\u25bc' : '\u25b6'
        });
        toggle.createEl('span', { text: 'AI reasoning' });

        if (this.thoughtContent) {
            this.renderEvents.registerDomEvent(toggle, 'click', () => {
                this.thoughtExpanded = !this.thoughtExpanded;
                this.scheduleRender();
            });

            if (this.thoughtExpanded) {
                const content = section.createEl('div', { cls: 'quill-cowriter-panel__thought-content' });
                content.setText(this.thoughtContent);
            }
        } else {
            toggle.createEl('span', { text: ' (Thinking...)' });
        }
    }

    /** Render the scrollable chat area with messages or initialize prompt. */
    private renderChatArea(): void {
        const scroll = this.containerEl!.createEl('div', { cls: 'quill-sidebar__content-plain' });

        if (this.fulfillSections.length > 0) {
            this.renderFulfillSections(scroll);
        } else if (this.chatHistory.length === 0 && !this.optionsLoading) {
            this.renderInitializePrompt(scroll);
        } else {
            for (const msg of this.chatHistory) {
                if (msg.role === 'user') {
                    const bubble = scroll.createEl('div', {
                        cls: 'quill-cowriter-panel__chat-bubble quill-cowriter-panel__chat-bubble--user'
                    });
                    bubble.setText(msg.content);
                } else if (msg.role === 'assistant') {
                    const bubble = scroll.createEl('div', {
                        cls: 'quill-cowriter-panel__chat-bubble quill-cowriter-panel__chat-bubble--assistant'
                    });

                    // Per-message thought/reasoning — start expanded
                    if (msg.thought && this.plugin.settings.enableCoWriterThought) {
                        const thoughtToggle = bubble.createEl('div', {
                            cls: 'quill-cowriter-panel__message-thought-toggle'
                        });
                        thoughtToggle.createEl('span', { cls: 'quill-cowriter-panel__thought-icon', text: '\u25bc' });
                        thoughtToggle.createEl('span', { text: 'AI reasoning' });
                        const thoughtContent = bubble.createEl('div', {
                            cls: 'quill-cowriter-panel__message-thought-content',
                            text: msg.thought
                        });
                        this.renderEvents.registerDomEvent(thoughtToggle, 'click', () => {
                            const collapsed = thoughtContent.hasClass(
                                'quill-cowriter-panel__message-thought-content--collapsed'
                            );
                            if (collapsed) {
                                thoughtContent.removeClass('quill-cowriter-panel__message-thought-content--collapsed');
                                thoughtToggle.querySelector('.quill-cowriter-panel__thought-icon')!.textContent =
                                    '\u25bc';
                            } else {
                                thoughtContent.addClass('quill-cowriter-panel__message-thought-content--collapsed');
                                thoughtToggle.querySelector('.quill-cowriter-panel__thought-icon')!.textContent =
                                    '\u25b6';
                            }
                        });
                    }

                    if (msg.options && msg.options.length > 0) {
                        bubble.createEl('div', { cls: 'quill-cowriter-panel__options-intro', text: msg.content });
                        const optionsContainer = bubble.createEl('div', { cls: 'quill-cowriter-panel__options' });
                        for (let i = 0; i < msg.options.length; i++) {
                            this.renderOptionCard(optionsContainer, msg.options[i]!, i);
                        }
                    } else {
                        // Render completed discuss responses as markdown
                        const isStreaming =
                            msg === this.chatHistory[this.chatHistory.length - 1] && this.discussStreaming;
                        const responseEl = bubble.createEl('div', { cls: 'quill-cowriter-panel__response-text' });
                        if (isStreaming) {
                            responseEl.addClass('quill-cowriter-panel__response-text--streaming');
                            responseEl.setText(msg.content || '\u2026');
                        } else {
                            const p = MarkdownRenderer.render(
                                this.app,
                                normalizeParagraphBreaks(msg.content),
                                responseEl,
                                '',
                                this.renderEvents
                            );
                            void p;
                            this.renderPromises.push(p);
                        }
                    }

                    // Accept button for plan revision
                    if (msg.showAccept) {
                        const acceptBtn = bubble.createEl('button', {
                            cls: 'quill-cowriter-panel__plan-accept mod-cta',
                            text: 'Accept plan and generate options'
                        });
                        this.renderEvents.registerDomEvent(acceptBtn, 'click', () => {
                            this.onAcceptPlan?.();
                        });
                    }

                    // Tool-use indicators — muted entries showing which tools the
                    // model called during this turn. Rendered within the bubble
                    // (below the response text) so they don't interfere with the
                    // streaming-placeholder logic.
                    if (msg.toolUses && msg.toolUses.length > 0) {
                        const toolList = bubble.createEl('div', { cls: 'quill-cowriter-panel__tool-uses' });
                        for (const use of msg.toolUses) {
                            const failed = Boolean(use.error);
                            const entry = toolList.createEl('div', {
                                cls: `quill-cowriter-panel__tool-use${failed ? ' quill-cowriter-panel__tool-use--error' : ''}`,
                                title: failed ? use.error : undefined
                            });
                            entry.createEl('span', {
                                cls: 'quill-cowriter-panel__tool-use-icon',
                                text: failed ? '\u26a0' : '\u29c9'
                            });
                            entry.createEl('span', {
                                cls: 'quill-cowriter-panel__tool-use-name',
                                text: `${failed ? 'Failed' : 'Used'} ${use.name}`
                            });
                            if (use.argsSummary) {
                                entry.createEl('span', {
                                    cls: 'quill-cowriter-panel__tool-use-args',
                                    text: use.argsSummary
                                });
                            }
                            // Right-click failed tool calls to copy the error
                            // reason for bug reporting.
                            if (failed && use.error) {
                                const errorText = use.error;
                                this.renderEvents.registerDomEvent(entry, 'contextmenu', (e: MouseEvent) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void navigator.clipboard.writeText(errorText).then(() => {
                                        new Notice('Copied error to clipboard');
                                    });
                                });
                            }
                        }
                    }

                    // Lorebook coach draft card — rendered under the message
                    // that produced it. Save writes the entry to the vault via
                    // the helper; Discard clears it from the session. Both
                    // clear the message-level draft so resolved cards drop
                    // their actionable Save/Discard (no stale live actions).
                    if (msg.loreDraft) {
                        renderLoreDraftCard(bubble, msg.loreDraft, this.app, this.plugin, this.renderEvents, {
                            onSave: () => {
                                msg.loreDraft = undefined;
                                this.render();
                            },
                            onDiscard: (draft) => {
                                msg.loreDraft = undefined;
                                this.onDiscardLoreDraft?.(draft);
                                this.render();
                            }
                        });
                    }
                }
            }

            if (this.optionsLoading) {
                const bubble = scroll.createEl('div', {
                    cls: 'quill-cowriter-panel__chat-bubble quill-cowriter-panel__chat-bubble--assistant quill-cowriter-panel__chat-bubble--streaming'
                });
                bubble.setText('Thinking...');
            }
        }

        // Scroll listener: if user scrolls up during streaming, stop auto-follow
        this.registerScrollListener(scroll);

        // Direct change card — always rendered when a pending/active Direct
        // continuation exists, independent of chat state (empty prompt, etc.).
        if (this.directChange) {
            this.renderDirectChangeCard(scroll);
        }

        // Lore edit cards — one per pending edit (from edit_note /
        // append_to_note tools). Multiple files can be pending simultaneously
        // so the writer can review a "full lorebook edit" one file at a time.
        for (const entry of this.loreEdits) {
            const p = renderChangeCard(scroll, entry.edit, entry.fileBasename, this.app, this.renderEvents, {
                onApprove: (id: number) => this.onApproveLoreEdit?.(entry.filePath, id),
                onReject: () => this.onRejectLoreEdit?.(entry.filePath)
            });
            if (p) {
                this.renderPromises.push(p);
            }
        }
    }

    /** Render the Direct continuation review card (Approve/Reject), using the
     *  shared change-card component. Mirrors the Fulfill review UI so the user
     *  has a single place to resolve the pending continuation before doing
     *  anything else. */
    private renderDirectChangeCard(container: HTMLElement): void {
        if (!this.directChange) return;
        const p = renderChangeCard(container, this.directChange, null, this.app, this.renderEvents, {
            onApprove: (id: number) => this.onApproveDirect?.(id),
            onReject: (id: number) => this.onRejectDirect?.(id)
        });
        if (p) {
            this.renderPromises.push(p);
        }
    }

    /** Render the Fulfill-mode review cards (one per directive) plus bulk actions,
     *  using the shared change-card component. For Fulfill the removed side is the
     *  directive comment (shown inline as the red diff, not repeated in the card). */
    private renderFulfillSections(container: HTMLElement): void {
        renderChangeBulkBar(
            container,
            this.fulfillSections.filter((s) => s.state === 'pending').length,
            this.renderEvents,
            {
                onApproveAll: () => this.onApproveAllFulfill?.(),
                onRejectAll: () => this.onRejectAllFulfill?.()
            }
        );
        for (const edit of this.fulfillSections) {
            void renderChangeCard(container, edit, null, this.app, this.renderEvents, {
                onApprove: (id: number) => this.onApproveFulfillSection?.(id),
                onReject: (id: number) => this.onRejectFulfillSection?.(id)
            });
        }
    }

    /** Render the initialize prompt with a big button. */
    private renderInitializePrompt(container: HTMLElement): void {
        const prompt = container.createEl('div', { cls: 'quill-cowriter-panel__init' });
        prompt.createEl('div', { cls: 'quill-cowriter-panel__init-icon', text: '\u270e' });

        // Direct and Fulfill need an active file. Show a warning but DON'T
        // bail — the bottom area renders below with a disabled input row so
        // the user can still switch modes.
        const activeFile = this.app.workspace.getActiveFile();
        if ((this.inputMode === 'direct' || this.inputMode === 'fulfill') && !activeFile) {
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-heading',
                text: this.inputMode === 'direct' ? 'Direct' : 'Fulfill'
            });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text:
                    this.inputMode === 'direct'
                        ? 'Open a manuscript file to use Direct mode — the AI continues from your cursor.'
                        : 'Open a manuscript with inline directives to use Fulfill mode.'
            });
            return;
        }

        if (this.inputMode === 'coach') {
            prompt.createEl('div', { cls: 'quill-cowriter-panel__init-heading', text: 'Coach' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text: 'Describe what you want this scene to do. The coach asks clarifying questions and helps you shape a direction before any prose is written.'
            });
            const startBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn mod-cta',
                text: 'Start coaching'
            });
            this.renderEvents.registerDomEvent(startBtn, 'click', () => {
                this.containerEl?.querySelector<HTMLTextAreaElement>('.quill-cowriter-panel__input')?.focus();
            });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-sub',
                text: 'Or, if you\u2019re feeling uninspired, see a few options that might work.'
            });
            const optionsBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn quill-cowriter-panel__init-btn--secondary',
                text: 'Generate options'
            });
            this.renderEvents.registerDomEvent(optionsBtn, 'click', () => {
                if (this.optionsLoading) return;
                this.userScrolledUp = false;
                this.optionsLoading = true;
                optionsBtn.disabled = true;
                this.scheduleRender();
                this.onGenerateOptions?.('');
            });
        } else if (this.inputMode === 'fulfill') {
            prompt.createEl('div', { cls: 'quill-cowriter-panel__init-heading', text: 'Fulfill' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text: 'Sweep every `<!-- quill: -->` directive in this document and review each fulfillment as a diff. Add directives first (right-click → Insert inline directive).'
            });
            const runBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn mod-cta',
                text: this.fulfillActive ? 'Running sweep\u2026' : 'Run sweep'
            });
            if (this.fulfillActive) runBtn.disabled = true;
            this.renderEvents.registerDomEvent(runBtn, 'click', () => {
                if (this.fulfillActive) return;
                this.fulfillActive = true;
                runBtn.textContent = 'Running sweep\u2026';
                runBtn.disabled = true;
                this.scheduleRender();
                // Defer to the next frame so the browser paints the button change
                // before the async sweep work blocks the main thread.
                const timeoutId = window.setTimeout(() => this.onRunFulfill?.(''));
                this.renderEvents.register(() => window.clearTimeout(timeoutId));
            });
        } else if (this.inputMode === 'discuss') {
            prompt.createEl('div', { cls: 'quill-cowriter-panel__init-heading', text: 'Discuss' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text: 'Brainstorm with the AI about your scene. Ask questions, explore ideas, or talk through a stuck passage.'
            });
            const startBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn mod-cta',
                text: 'Start discussing'
            });
            if (this.optionsLoading) startBtn.disabled = true;
            this.renderEvents.registerDomEvent(startBtn, 'click', () => {
                this.containerEl?.querySelector<HTMLTextAreaElement>('.quill-cowriter-panel__input')?.focus();
            });
        } else if (this.inputMode === 'lorebook') {
            prompt.createEl('div', { cls: 'quill-cowriter-panel__init-heading', text: 'Lorebook coach' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text: 'Develop a character, location, faction, or other lore entry. The coach reads your existing lore and manuscript, asks probing questions, and proposes a draft you can save as a note.'
            });
            const startBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn mod-cta',
                text: 'Start coaching'
            });
            this.renderEvents.registerDomEvent(startBtn, 'click', () => {
                this.containerEl?.querySelector<HTMLTextAreaElement>('.quill-cowriter-panel__input')?.focus();
            });
            if (this.plugin.settings.lorebookFolders.length === 0) {
                prompt.createEl('div', {
                    cls: 'quill-cowriter-panel__init-sub quill-cowriter-panel__init-sub--warn',
                    text: 'Configure at least one lorebook folder in settings → lorebook first.'
                });
            }
        } else {
            prompt.createEl('div', { cls: 'quill-cowriter-panel__init-heading', text: 'Direct' });
            prompt.createEl('div', {
                cls: 'quill-cowriter-panel__init-desc',
                text: 'Describe what should happen next, then send.'
            });
            const initBtn = prompt.createEl('button', {
                cls: 'quill-cowriter-panel__init-btn mod-cta',
                text: 'Generate options'
            });
            this.renderEvents.registerDomEvent(initBtn, 'click', () => {
                if (this.optionsLoading) return;
                this.userScrolledUp = false;
                this.optionsLoading = true;
                // Immediate disable — no rAF delay
                initBtn.disabled = true;
                this.scheduleRender();
                this.onGenerateOptions?.('');
            });
        }
    }

    /** Render a single option card with label, description, and Apply button. */
    private renderOptionCard(container: HTMLElement, option: CoWriterOption, index: number): void {
        const expired = !this.currentOptions[index];
        const card = container.createEl('div', {
            cls: `quill-cowriter-panel__option-card${expired ? ' quill-cowriter-panel__option-card--expired' : ''}`
        });
        card.createEl('div', { cls: 'quill-cowriter-panel__option-label', text: option.label });
        card.createEl('div', { cls: 'quill-cowriter-panel__option-desc', text: option.description });

        if (expired) {
            card.createEl('span', { cls: 'quill-cowriter-panel__option-expired-label', text: 'No longer available' });
            return;
        }

        const applying = this.optionsLoading;
        const applyBtn = card.createEl('button', {
            cls: 'quill-cowriter-panel__option-apply mod-cta',
            text: applying ? 'Generating\u2026' : 'Apply'
        });
        applyBtn.disabled = applying;
        if (applying) {
            applyBtn.addClass('quill-cowriter-panel__option-apply--applying');
        }
        const idx = index;
        this.renderEvents.registerDomEvent(applyBtn, 'click', () => {
            if (this.optionsLoading) return;
            this.optionsLoading = true;
            applyBtn.setText('Generating\u2026');
            applyBtn.addClass('quill-cowriter-panel__option-apply--applying');
            applyBtn.disabled = true;
            this.scheduleRender();
            this.onApplyOption?.(idx);
        });
    }

    /** Render the pinned bottom area (draft status, context pills, input row). */
    private renderBottomArea(): void {
        const bottom = this.containerEl!.createEl('div', { cls: 'quill-cowriter-panel__bottom' });

        // Coach mode UI
        if (this.inputMode === 'coach') {
            const coachBar = bottom.createEl('div', { cls: 'quill-cowriter-panel__coach-bar' });
            const generating = this.optionsLoading || this.draftState === 'generating';

            // Phase indicator
            const phaseLabel = coachBar.createEl('span', { cls: 'quill-cowriter-panel__coach-phase' });
            const phaseNames: Record<CoachPhase, string> = {
                discern: 'Phase 1: Analyzing intent...',
                clarify: 'Phase 2: Clarifying questions...',
                plan: 'Phase 3: Building plan...',
                direction: 'Phase 4: Executable direction'
            };
            phaseLabel.setText(
                this.coachActive ? phaseNames[this.coachPhase] : 'Coach mode \u2014 AI will analyze your passage'
            );

            // End coach button
            if (this.coachActive) {
                coachBar.createEl('span', { text: ' ' });
                const endBtn = coachBar.createEl('button', {
                    cls: 'quill-cowriter-panel__coach-end-btn',
                    text: 'End coaching'
                });
                this.renderEvents.registerDomEvent(endBtn, 'click', () => {
                    this.onEndCoach?.();
                });

                // Write coach button (available at any phase)
                coachBar.createEl('span', { text: ' ' });
                const writeBtn = coachBar.createEl('button', {
                    cls: 'quill-cowriter-panel__coach-options-btn',
                    text: 'Write from coaching'
                });
                if (generating) writeBtn.disabled = true;
                this.renderEvents.registerDomEvent(writeBtn, 'click', () => {
                    if (this.optionsLoading || this.draftState === 'generating') return;
                    this.onCoachWrite?.();
                });

                // Generate options button (if coach is complete)
                if (this.coachPhase === 'direction') {
                    coachBar.createEl('span', { text: ' ' });
                    const optionsBtn = coachBar.createEl('button', {
                        cls: 'quill-cowriter-panel__coach-options-btn',
                        text: 'Generate options'
                    });
                    if (generating) optionsBtn.disabled = true;
                    this.renderEvents.registerDomEvent(optionsBtn, 'click', () => {
                        if (this.optionsLoading || this.draftState === 'generating') return;
                        this.onCoachToOptions?.();
                    });
                }
            }
        }

        // Lorebook coach mode UI — phase indicator + end coaching
        if (this.inputMode === 'lorebook') {
            const generating = this.optionsLoading || this.draftState === 'generating';
            const loreBar = bottom.createEl('div', { cls: 'quill-cowriter-panel__lore-bar' });
            const phaseNames: Record<LoreCoachPhase, string> = {
                discover: 'Discovering what to develop\u2026',
                develop: 'Developing the entry\u2026',
                refine: 'Refining the draft\u2026'
            };
            loreBar.createEl('span', {
                cls: 'quill-cowriter-panel__lore-phase',
                text: this.loreCoachActive
                    ? phaseNames[this.loreCoachPhase]
                    : 'Lorebook coach \u2014 describe an entry to develop'
            });

            if (this.loreCoachActive) {
                loreBar.createEl('span', { text: ' ' });
                const endBtn = loreBar.createEl('button', {
                    cls: 'quill-cowriter-panel__lore-end-btn',
                    text: 'End coaching'
                });
                if (generating) endBtn.disabled = true;
                this.renderEvents.registerDomEvent(endBtn, 'click', () => {
                    if (this.optionsLoading) return;
                    this.onEndLoreCoach?.();
                });
            }
        }

        // Plot map link row
        this.renderPlotMapRow(bottom);

        // Directive-active badge (Direct mode only)
        if (this.inputMode === 'direct' && this.directiveActive) {
            bottom.createEl('div', { cls: 'quill-cowriter-panel__directive-badge', text: 'Directive active' });
        }

        // Context file pills
        const contextFiles = this.getContextFiles();
        if (contextFiles.length > 0) {
            const ctxRow = bottom.createEl('div', { cls: 'quill-cowriter-panel__ctx-row' });
            for (const filePath of contextFiles) {
                const pill = ctxRow.createEl('span', { cls: 'quill-cowriter-panel__ctx-pill' });
                const parsed = parseEmbedFolderPath(filePath);
                const label = parsed ? embedFolderLabel(parsed.folderPath, parsed.mode) : fileNameFromPath(filePath);
                pill.createEl('span', { text: label });
                const removeBtn = pill.createEl('button', {
                    cls: 'quill-cowriter-panel__ctx-remove',
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
            const label = this.buildContextLabel(contextFiles.length, vaultContextCount);
            bottom.createEl('div', {
                cls: 'quill-cowriter-panel__token-indicator',
                text: formatTokenIndicatorText(label, totalTokens, this.maxAllowedTokens)
            });
        }
    }

    /** Render the plot map link row: either a link button or a filename pill with unlink. */
    private renderPlotMapRow(container: HTMLElement): void {
        const row = container.createEl('div', { cls: 'quill-cowriter-panel__plotmap-row' });
        row.createEl('span', { cls: 'quill-cowriter-panel__plotmap-label', text: 'Plot map' });

        if (this.plotMap) {
            const plotMapPath = this.plotMap;
            const pill = row.createEl('span', { cls: 'quill-cowriter-panel__plotmap-pill' });
            const nameBtn = pill.createEl('button', {
                cls: 'quill-cowriter-panel__plotmap-name',
                text: fileNameFromPath(plotMapPath),
                title: plotMapPath
            });
            this.renderEvents.registerDomEvent(nameBtn, 'click', () => {
                void this.app.workspace.openLinkText(plotMapPath, '');
            });
            const removeBtn = pill.createEl('button', {
                cls: 'quill-cowriter-panel__plotmap-remove',
                text: '\u00d7',
                title: 'Unlink plot map'
            });
            this.renderEvents.registerDomEvent(removeBtn, 'click', () => {
                this.onClearPlotMap?.();
            });
        } else {
            const linkBtn = row.createEl('button', {
                cls: 'quill-cowriter-panel__plotmap-link',
                text: '+ link',
                title: 'Link a plot map note for this manuscript'
            });
            this.renderEvents.registerDomEvent(linkBtn, 'click', () => {
                const activeFile = this.app.workspace.getActiveFile();
                new VaultFileSuggestModal(
                    this.app,
                    (item) => {
                        if (item.kind === 'file') {
                            this.onLinkPlotMap?.(item.file.path);
                        }
                    },
                    [activeFile?.path ?? ''],
                    undefined,
                    this.plugin.settings.enableFullEmbedPickerOption
                ).open();
            });
        }
    }

    /** Render the mode picker: one row per mode (icon, label, descriptor). Shown
     *  above the button row when the mode button is clicked, so the writer can
     *  jump straight to the mode they want instead of cycling. */
    private renderModePicker(container: HTMLElement): void {
        const list = container.createEl('div', { cls: 'quill-cowriter-panel__mode-picker' });
        for (const m of COWRITER_MODES) {
            const row = list.createEl('div', {
                cls: `quill-cowriter-panel__mode-row${this.inputMode === m.mode ? ' quill-cowriter-panel__mode-row--active' : ''}`,
                attr: { tabindex: '0', role: 'button' }
            });
            row.createEl('span', { cls: 'quill-cowriter-panel__mode-row-icon', text: m.icon });
            const textWrap = row.createEl('div', { cls: 'quill-cowriter-panel__mode-row-text' });
            textWrap.createEl('div', { cls: 'quill-cowriter-panel__mode-row-label', text: m.label });
            textWrap.createEl('div', { cls: 'quill-cowriter-panel__mode-row-desc', text: m.desc });
            const choose = () => {
                this.setMode(m.mode);
            };
            this.renderEvents.registerDomEvent(row, 'click', choose);
            this.renderEvents.registerDomEvent(row, 'keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose();
                }
            });
        }
    }

    /** Render the input row with mode toggle, textarea, and send button. */
    private renderInputRow(container: HTMLElement): void {
        const generating = this.optionsLoading || this.draftState === 'generating' || this.fulfillActive;
        // Direct and Fulfill need an active file. When none is open, disable
        // text entry and submission but leave the mode picker enabled so the
        // user can switch to a mode that doesn't need a file.
        const noActiveFile =
            (this.inputMode === 'direct' || this.inputMode === 'fulfill') && !this.app.workspace.getActiveFile();

        // Mode picker — shown above the button row when open.
        if (this.modePickerOpen) {
            this.renderModePicker(container);
        }

        // Buttons row — mode toggle, add context, refresh, send/stop
        const btnRow = container.createEl('div', { cls: 'quill-cowriter-panel__btn-row' });

        const currentMode = COWRITER_MODES.find((m) => m.mode === this.inputMode);
        const modeBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-panel__mode-btn${this.inputMode === 'coach' ? ' quill-cowriter-panel__mode-btn--coach' : this.inputMode === 'discuss' ? ' quill-cowriter-panel__mode-btn--discuss' : this.inputMode === 'fulfill' ? ' quill-cowriter-panel__mode-btn--fulfill' : ''}`,
            text: `${currentMode?.icon ?? ''} ${currentMode?.label ?? ''} ${this.modePickerOpen ? '\u25b4' : '\u25be'}`,
            title: 'Pick a co-writer mode'
        });
        if (generating) modeBtn.disabled = true;
        this.renderEvents.registerDomEvent(modeBtn, 'click', () => {
            if (generating) return;
            this.modePickerOpen = !this.modePickerOpen;
            this.scheduleRender();
        });

        const addCtxBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-panel__ctx-add',
            text: '\u00b1',
            title: 'Add file to context'
        });
        if (generating) addCtxBtn.disabled = true;
        this.renderEvents.registerDomEvent(addCtxBtn, 'click', () => {
            if (generating) return;
            const activeFile = this.app.workspace.getActiveFile();
            new VaultFileSuggestModal(
                this.app,
                (item) => {
                    const path =
                        item.kind === 'file' ? item.file.path : buildEmbedFolderPath(item.folderPath, item.mode);
                    this.onAddContextFile?.(path);
                },
                [activeFile?.path ?? '', ...this.getContextFiles(), ...this.getVaultContextFiles()],
                undefined,
                this.plugin.settings.enableFullEmbedPickerOption
            ).open();
        });

        const refreshBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-panel__refresh-btn',
            text: '\u21bb',
            title: 'Refresh suggestions'
        });
        if (generating || noActiveFile) refreshBtn.disabled = true;
        this.renderEvents.registerDomEvent(refreshBtn, 'click', () => {
            if (this.optionsLoading || this.draftState === 'generating' || noActiveFile) return;
            this.userScrolledUp = false;
            this.optionsLoading = true;
            this.scheduleRender();
            this.onGenerateOptions?.('');
        });

        // Compact button
        const compactBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-panel__compact-btn',
            text: '\u00bb\u00bb',
            title: 'Compact conversation'
        });
        if (generating) compactBtn.disabled = true;
        this.renderEvents.registerDomEvent(compactBtn, 'click', () => {
            this.onCompact?.();
        });

        // New chat button
        const newChatBtn = btnRow.createEl('button', {
            cls: 'quill-cowriter-panel__new-chat-btn',
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
        btnRow.createEl('div', { cls: 'quill-cowriter-panel__btn-spacer' });

        const actionBtn = btnRow.createEl('button', {
            cls: `quill-cowriter-panel__send-btn mod-cta${generating ? ' quill-cowriter-panel__send-btn--stop' : ''}`,
            text: noActiveFile
                ? 'Open a file'
                : generating
                  ? this.inputMode === 'fulfill'
                      ? 'Running\u2026'
                      : 'Stop'
                  : this.inputMode === 'fulfill'
                    ? 'Run'
                    : 'Send'
        });
        if (noActiveFile) actionBtn.disabled = false;

        // Textarea row — below the buttons, ~10 lines tall
        const taRow = container.createEl('div', { cls: 'quill-cowriter-panel__ta-row' });
        const input = taRow.createEl('textarea', {
            cls: 'quill-cowriter-panel__input',
            placeholder: noActiveFile
                ? 'Open a manuscript file to use this mode\u2026'
                : this.inputMode === 'direct'
                  ? 'Describe what should happen next\u2026'
                  : this.inputMode === 'coach'
                    ? "Describe your intent or answer the AI's questions\u2026"
                    : this.inputMode === 'fulfill'
                      ? 'Not used in Fulfill mode \u2014 use Run sweep'
                      : this.inputMode === 'lorebook'
                        ? 'Describe an entry to develop (e.g. "a character named Sarah")\u2026'
                        : 'Discuss the scene, ask questions, brainstorm\u2026'
        });
        if (this.inputMode === 'fulfill' || noActiveFile) {
            input.disabled = true;
        } else {
            input.value = this.inputValue;
        }

        // Track value changes for persistence across re-renders
        this.renderEvents.registerDomEvent(input, 'input', () => {
            this.inputValue = input.value;
        });

        const doSend = () => {
            if (this.optionsLoading || this.draftState === 'generating' || this.fulfillActive) return;
            const text = input.value.trim();
            // Fulfill runs the sweep; an empty instruction is allowed.
            if (text.length === 0 && this.inputMode !== 'fulfill') return;
            this.userScrolledUp = false; // Resume auto-follow on new message
            this.inputValue = '';
            input.value = '';
            if (this.inputMode === 'direct') {
                this.optionsLoading = true;
            } else if (this.inputMode === 'fulfill') {
                this.fulfillActive = true;
            } else {
                this.optionsLoading = true;
            }
            this.scheduleRender();
            if (this.inputMode === 'direct') {
                this.onSendMessage?.(text);
            } else if (this.inputMode === 'fulfill') {
                const timeoutId = window.setTimeout(() => this.onRunFulfill?.(''));
                this.renderEvents.register(() => window.clearTimeout(timeoutId));
            } else if (this.inputMode === 'coach') {
                this.onCoachMessage?.(text);
            } else if (this.inputMode === 'lorebook') {
                this.onLoreCoachMessage?.(text);
            } else {
                this.onDiscussMessage?.(text);
            }
        };

        const doStop = () => {
            this.onCancelGeneration?.();
        };

        this.renderEvents.registerDomEvent(actionBtn, 'click', () => {
            if (noActiveFile) {
                new VaultFileSuggestModal(
                    this.app,
                    (item) => {
                        if (item.kind === 'file') {
                            void this.app.workspace.openLinkText(item.file.path, '', false);
                        }
                    },
                    [],
                    'Select a manuscript file to open...',
                    false,
                    true
                ).open();
                return;
            }
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
        if (e.key === 'Escape' && this.modePickerOpen) {
            e.preventDefault();
            this.modePickerOpen = false;
            this.scheduleRender();
            return;
        }
        if (e.key === 'Escape' && (this.optionsLoading || this.draftState === 'generating' || this.fulfillActive)) {
            e.preventDefault();
            this.onCancelGeneration?.();
        }
    }

    /** Set whether an inline directive is active at the cursor (drives the Direct-mode badge).
     *  Pushed from the plugin's editor extension on cursor/doc changes. */
    setDirectiveActive(active: boolean): void {
        if (this.directiveActive !== active) {
            this.directiveActive = active;
            this.scheduleRender();
        }
    }

    /** Recompute the context indicator text in-place (without full re-render). */
    private updateTokenIndicator(): void {
        if (!this.containerEl) return;
        const indicator = this.containerEl.querySelector('.quill-cowriter-panel__token-indicator');
        if (!indicator) return;
        if (this.maxAllowedTokens <= 0) return;
        const contextFiles = this.getContextFiles();
        const vaultContextCount = this.getVaultContextFiles().length;
        const label = this.buildContextLabel(contextFiles.length, vaultContextCount);
        const totalTokens = this.computeTotalTokens();
        indicator.setText(formatTokenIndicatorText(label, totalTokens, this.maxAllowedTokens));
    }

    /**
     * Compute the total token estimate for the context indicator.
     * Combines conversation tokens, additional context file tokens, plot map
     * tokens, and vault context item tokens so the full context window usage
     * is shown.
     */
    private computeTotalTokens(): number {
        let total = this.contextEstimate + this.additionalContextTokens + this.plotMapTokens;
        const assembly = this.plugin.currentAssembly;
        if (assembly) {
            for (const item of assembly.contextItems) {
                total += item.tokenEstimate;
            }
        }
        return total;
    }

    /** Build the context label for the token indicator, noting a linked plot map. */
    private buildContextLabel(contextFilesCount: number, vaultContextCount: number): string {
        let label = buildFileLabel(contextFilesCount, vaultContextCount);
        if (this.plotMap) {
            label = label === 'No files in context' ? 'plot map' : `${label} + plot map`;
        }
        return label;
    }
}
