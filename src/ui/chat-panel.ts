import { App, Component } from 'obsidian';
import { type ActiveDocument, getActiveDocument, renderDocumentHeader } from './document-header';

// Re-export ActiveDocument so existing importers (`import { ActiveDocument } from './chat-panel'`) keep working.
export type { ActiveDocument };

/**
 * Below this panel width (px), chat panels collapse secondary button-row
 * controls (e.g. the co-writer hides Add-context / Refresh behind a hamburger
 * overflow menu). Shared by every chat panel subclass via the
 * {@link AbstractChatPanel} ResizeObserver so the Review tab's results chat
 * gets the same treatment as the co-writer.
 */
const COMPACT_WIDTH_THRESHOLD = 420;

/**
 * Below this panel height (px), the chat textarea collapses from its default
 * ~180px (5+ lines) down to ~2 lines so it stops eating half the visible chat
 * on phones in portrait and on short desktop sidebars. Secondary metadata rows
 * hide too (co-writer: plot map + token indicator). Shared by all chat panels.
 */
const COMPACT_HEIGHT_THRESHOLD = 700;

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

    /** True while render() is mid-execution; scroll events are ignored during this window. */
    protected renderPending = false;

    /**
     * Whether the panel is currently in compact (narrow) mode. Toggled by the
     * shared {@link resizeObserver} and read by subclass render methods to add
     * BEM `--compact` modifiers (e.g. the co-writer's button-row hamburger
     * overflow). Shared so every chat panel responds to width changes the same
     * way without each subclass wiring its own observer.
     */
    protected compactWidth = false;

    /**
     * Whether the panel is short enough that the textarea has collapsed to
     * ~2 lines. Toggled by {@link resizeObserver} (height axis). Independent
     * of {@link compactWidth} — a wide-but-short pane collapses height but not
     * width, and vice versa.
     */
    protected compactHeight = false;

    /**
     * Observes the panel container's width AND height to toggle
     * {@link compactWidth} / {@link compactHeight} and schedule a re-render.
     * Shared by all chat panel subclasses — set up in {@link setContainer},
     * torn down in {@link detach}. Centralized here so the Review tab's
     * results chat gets the same responsive breakpoints as the co-writer
     * (previously the observer lived only in the co-writer subclass).
     */
    private resizeObserver: ResizeObserver | null = null;

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
        this.setupResponsiveObserver(containerEl);
    }

    /**
     * Begin observing the container for width/height changes, toggling
     * {@link compactWidth} / {@link compactHeight} and scheduling a re-render
     * when either crosses its threshold. Idempotent — disconnects any prior
     * observer first. Called from {@link setContainer}; subclasses that
     * override `setContainer` should call this rather than wiring their own
     * observer so every chat panel shares the same breakpoints.
     */
    protected setupResponsiveObserver(containerEl: HTMLElement): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                const compactW = width < COMPACT_WIDTH_THRESHOLD;
                const compactH = height < COMPACT_HEIGHT_THRESHOLD && height > 0;
                if (compactW !== this.compactWidth || compactH !== this.compactHeight) {
                    this.compactWidth = compactW;
                    this.compactHeight = compactH;
                    this.scheduleRender();
                }
            }
        });
        this.resizeObserver.observe(containerEl);
    }

    /** Stop the responsive observer. Safe to call when no observer is active. */
    protected teardownResponsiveObserver(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
    }

    /**
     * Tear down the responsive observer and remove the keydown listener so the
     * panel cannot fire on — or repopulate — another tab's UI after the sidebar
     * clears or reuses the shared content container. Called by the sidebar
     * before every tab switch; {@link setContainer} re-establishes everything
     * when the panel's tab is re-activated.
     */
    detach(): void {
        this.teardownResponsiveObserver();
        if (this.containerEl && this.keydownHandler) {
            this.containerEl.removeEventListener('keydown', this.keydownHandler);
            this.keydownHandler = null;
        }
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
     * Scroll events are ignored during render() to avoid races between
     * scroll-top assignment and the listener.
     */
    protected registerScrollListener(scrollEl: HTMLElement): void {
        this.renderEvents.registerDomEvent(
            scrollEl,
            'scroll',
            () => {
                if (this.renderPending) return;
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
