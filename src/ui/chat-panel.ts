import { App, Component } from 'obsidian';
import { type ActiveDocument, getActiveDocument, renderDocumentHeader } from './document-header';

// Re-export ActiveDocument so existing importers (`import { ActiveDocument } from './chat-panel'`) keep working.
export type { ActiveDocument };

/**
 * A single message in a chat conversation within a chat panel.
 * Extended by specific panel message types (e.g., CoWriterChatMessage).
 */
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

/**
 * Collapse 3+ consecutive newlines to 2 so markdown rendering
 * doesn't produce excessive vertical gaps between paragraphs.
 */
export function normalizeParagraphBreaks(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Abstract base class for chat-style panels in the Quill sidebar.
 *
 * Provides shared infrastructure for:
 * - Container lifecycle and escape-key handling
 * - Scroll management (at-bottom detection, auto-follow, scroll listeners)
 * - Loading state management (chatLoading, userScrolledUp)
 * - Debounced re-rendering (scheduleRender)
 * - Token indicator configuration (maxAllowedTokens)
 * - Utility helpers (normalizeParagraphBreaks)
 *
 * Subclasses own their chat history type and rendering logic.
 */
export abstract class AbstractChatPanel {
    protected app: App;
    protected containerEl: HTMLElement | null = null;
    protected renderEvents: Component = new Component();

    protected chatLoading = false;
    protected userScrolledUp = false;
    protected maxAllowedTokens = 0;
    protected onCancelGeneration: (() => void) | null = null;
    protected onCompact: (() => void) | null = null;
    protected onNewChat: ((clearContext: boolean) => void) | null = null;

    /** Stored keydown handler so we can remove it from a previous container. */
    protected keydownHandler: ((e: KeyboardEvent) => void) | null = null;

    /** Debounce guard for scheduleRender(). */
    protected renderScheduled = false;

    constructor(app: App) {
        this.app = app;
    }

    // --- Container lifecycle ---

    /**
     * Attach the panel to a DOM container and render.
     * Also sets up a global escape-key listener for canceling generation.
     */
    setContainer(containerEl: HTMLElement): void {
        if (this.containerEl && this.keydownHandler) {
            this.containerEl.removeEventListener('keydown', this.keydownHandler);
        }
        this.containerEl = containerEl;
        this.render();
        this.keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.chatLoading) {
                e.preventDefault();
                this.onCancelGeneration?.();
            }
        };
        containerEl.addEventListener('keydown', this.keydownHandler);
    }

    /** Each subclass defines its own render logic. */
    abstract render(): void;

    // --- Callback setters ---

    setCancelGenerationHandler(handler: () => void): void {
        this.onCancelGeneration = handler;
    }

    setCompactHandler(handler: () => void): void {
        this.onCompact = handler;
    }

    setNewChatHandler(handler: (clearContext: boolean) => void): void {
        this.onNewChat = handler;
    }

    /** Set the maximum allowed context tokens (from provider config). */
    setMaxAllowedTokens(tokens: number): void {
        this.maxAllowedTokens = tokens;
    }

    // --- Scroll management ---

    /** Find the scrollable content container within the panel. */
    protected getScrollContainer(): HTMLElement | null {
        return this.containerEl?.querySelector('.quill-sidebar__content-plain') ?? null;
    }

    /** True when the scroll container is at or near the bottom (within 60px). */
    protected isScrollAtBottom(): boolean {
        const c = this.getScrollContainer();
        if (!c) return true;
        return c.scrollHeight - c.scrollTop - c.clientHeight < 60;
    }

    /** Scroll the content container to the bottom. */
    protected scrollToBottom(): void {
        const c = this.getScrollContainer();
        if (c) c.scrollTop = c.scrollHeight;
    }

    /**
     * Register a passive scroll listener on the given scroll container
     * to track whether the user has scrolled up (disabling auto-follow).
     */
    protected registerScrollListener(scrollEl: HTMLElement): void {
        this.renderEvents.registerDomEvent(
            scrollEl,
            'scroll',
            () => {
                this.userScrolledUp = !this.isScrollAtBottom();
            },
            { passive: true }
        );
    }

    /**
     * Preserve scroll position, perform an action (typically a re-render),
     * and restore scroll if the user was scrolled up.
     */
    protected async withScrollRestore(action: () => Promise<void>): Promise<void> {
        const wasAtBottom = this.isScrollAtBottom();
        const savedScrollTop = this.getScrollContainer()?.scrollTop ?? 0;
        await action();
        if (wasAtBottom) {
            this.scrollToBottom();
        } else {
            const c = this.getScrollContainer();
            if (c) {
                c.scrollTop = Math.min(savedScrollTop, c.scrollHeight - c.clientHeight);
            }
        }
    }

    // --- Chat loading state ---

    /**
     * Begin loading a new chat response. Resets the user-scrolled-up flag
     * so auto-follow resumes.
     */
    protected chatStartLoading(): void {
        this.chatLoading = true;
        this.userScrolledUp = false;
    }

    // --- Re-render helpers ---

    /** Schedule a full re-render on the next animation frame (debounced). */
    protected scheduleRender(): void {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        window.requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.render();
        });
    }

    /** Unload render events and empty the container for a fresh rebuild. */
    protected unloadAndClearContainer(): void {
        this.renderEvents?.unload();
        this.renderEvents = new Component();
        this.containerEl?.empty();
    }

    // --- Active-document awareness ---
    //
    // Chat panels that operate on the active document (co-writer, analysis) need
    // to know whether a markdown document is active and render an empty state
    // when none is. These helpers standardize that pattern.
    //
    // IMPORTANT: we use workspace.getActiveFile() (NOT getActiveViewOfType)
    // because the sidebar steals focus when the writer clicks a tab.
    // getActiveFile() remembers the active markdown file across focus changes;
    // getActiveViewOfType(MarkdownView) returns null when the sidebar has focus.

    /** Get the active markdown document, or null if no file is active. Delegates to the shared helper. */
    protected getActiveDocument(): ActiveDocument | null {
        return getActiveDocument(this.app);
    }

    /**
     * Require an active document to proceed. Returns the document if one is
     * open; otherwise renders an "Open a document to use {featureName}" message
     * into `container` and returns null.
     *
     * Usage:
     * ```
     * const doc = this.requireActiveDocument(scroll, 'analysis');
     * if (!doc) return;
     * this.renderDocumentHeader(scroll, doc);
     * // ... safe to render the rest of the tab
     * ```
     */
    protected requireActiveDocument(container: HTMLElement, featureName: string): ActiveDocument | null {
        const doc = this.getActiveDocument();
        if (doc) return doc;
        container.createEl('p', {
            cls: 'quill-empty-hint',
            text: `Open a document to use ${featureName}.`
        });
        return null;
    }

    /** Render a document info header (file name + word count). Delegates to the shared helper. */
    protected renderDocumentHeader(container: HTMLElement, doc: ActiveDocument | null): void {
        renderDocumentHeader(container, doc);
    }
}
