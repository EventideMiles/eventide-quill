/**
 * Sidebar width keeper — pure decision logic for the defensive fix behind
 * issue #67 ("the sidebar resets to the default size when navigating back to
 * the main document").
 *
 * The plugin never writes sidebar geometry, and core Obsidian exposes no
 * public width API on `WorkspaceSidedock`/`WorkspaceSplit` — the width lives
 * on the sidedock's container element, which core itself sizes when the
 * divider is dragged. This module is deliberately free of Obsidian imports:
 * it classifies width observations (user drag vs un-commanded reset vs
 * window-resize-correlated), clamps remembered widths to sane bounds, and
 * shapes the sidecar payload. The DOM/persistence wiring lives in
 * `quill-sidebar.ts` and is desktop-only (a complete no-op on mobile, where
 * sidebars are full-width overlays).
 */

/** Sidecar filename under the plugin data directory (settings schema untouched). */
export const SIDEBAR_WIDTH_FILE_NAME = 'sidebar-state.json';

/** Sidecar schema version for the width keeper payload. */
export const SIDEBAR_WIDTH_STATE_VERSION = 1;

/** Widths below this are never remembered or restored (px). */
export const SIDEBAR_MIN_WIDTH_PX = 200;

/** Minimum room left for the editor when a restore is applied (px). */
export const MIN_EDITOR_ROOM_PX = 300;

/** Width deltas at or below this are measurement noise, not changes (px). */
export const WIDTH_EPSILON_PX = 2;

/** A single-step width drop larger than this is a reset candidate (px). */
export const RESET_DROP_PX = 50;

/** Widths at or below this are treated as collapsed/hidden and ignored (px). */
export const COLLAPSED_WIDTH_PX = 5;

/** Width changes within this window of a window resize are legitimate (ms). */
export const WINDOW_RESIZE_CORRELATION_MS = 300;

/**
 * The width must have been still at least this long before a large
 * single-step drop counts as an un-commanded reset rather than the first
 * step of a fast drag (ms).
 */
export const DRAG_STILL_MS = 1500;

/** Debounce for sidecar writes while widths settle (ms). */
export const SIDEBAR_WIDTH_SAVE_DEBOUNCE_MS = 500;

/** One sidedock width observation. */
export interface WidthSample {
    /** Measured sidedock width (px). */
    width: number;
    /** Sample timestamp (epoch ms). */
    atMs: number;
}

/** Facts about the environment for a single observation, resolved by the wiring. */
export interface WidthObserveContext {
    /** Current window inner width, used for clamping (px). */
    windowWidth: number;
    /** Epoch ms of the last window resize event, or null when none is recent. */
    lastWindowResizeMs: number | null;
    /**
     * False while the active leaf sits inside the sidebar (the writer owns
     * the divider then) — large single-step drops count as legitimate intent
     * and are adopted instead of restored.
     */
    resetAllowed: boolean;
}

/** How a width observation was classified. */
export type WidthChangeKind =
    /** First usable sample of a session. */
    | 'initial'
    /** Delta within the epsilon — measurement noise. */
    | 'stable'
    /** Incremental, drag-like change — adopt as the new remembered width. */
    | 'drag'
    /** Change correlated with a window resize — adopt. */
    | 'window-resize'
    /** Large single-step drop after stillness with focus outside the sidebar. */
    | 'reset-drop'
    /** Collapsed or otherwise unusable sample — ignored entirely. */
    | 'collapsed';

/** Outcome of one width observation. */
export interface WidthDecision {
    /** How the observation was classified. */
    kind: WidthChangeKind;
    /** Previous observed width, or null before the first sample (for logs). */
    fromWidth: number | null;
    /** The remembered width after this observation, or null when none. */
    rememberedWidth: number | null;
    /** Non-null when the remembered width should be re-applied to the DOM now. */
    restoreWidth: number | null;
    /** True when the (possibly new) remembered width should be persisted. */
    persist: boolean;
}

/** Shape of the persisted sidecar payload. */
export interface SidebarWidthState {
    version: number;
    /** Remembered sidedock width (px). */
    width: number;
}

/**
 * Whether the width keeper should run at all. Desktop-only: on mobile the
 * sidebars are full-width overlays and any width write would fight the app.
 */
export function sidebarWidthKeeperEnabled(isMobile: boolean): boolean {
    return !isMobile;
}

/**
 * Clamp a width to sane sidebar bounds: at least {@link SIDEBAR_MIN_WIDTH_PX},
 * and small enough to leave at least {@link MIN_EDITOR_ROOM_PX} for the
 * editor. An unknown/zero window width skips the window-relative max.
 */
export function clampSidebarWidth(width: number, windowWidth: number): number {
    const rounded = Math.round(width);
    if (!Number.isFinite(windowWidth) || windowWidth <= 0) {
        return Math.max(rounded, SIDEBAR_MIN_WIDTH_PX);
    }
    const max = Math.max(SIDEBAR_MIN_WIDTH_PX, windowWidth - MIN_EDITOR_ROOM_PX);
    return Math.min(Math.max(rounded, SIDEBAR_MIN_WIDTH_PX), max);
}

/**
 * The width a restore may apply for the given remembered width and window,
 * or null when no restore is safe (unknown window, or the window is too
 * small to honor the minimum sidebar width plus editor room).
 */
export function restorableWidth(remembered: number | null, windowWidth: number): number | null {
    if (remembered === null || !Number.isFinite(remembered)) return null;
    if (!Number.isFinite(windowWidth) || windowWidth <= 0) return null;
    if (windowWidth - MIN_EDITOR_ROOM_PX < SIDEBAR_MIN_WIDTH_PX) return null;
    return clampSidebarWidth(remembered, windowWidth);
}

/**
 * Width to apply when the Quill view opens, or null when nothing should be
 * applied: no remembered width, the sidebar is collapsed, or the current
 * width already matches the remembered one within the epsilon.
 */
export function restoreWidthForOpen(
    remembered: number | null,
    currentWidth: number,
    windowWidth: number
): number | null {
    if (currentWidth <= COLLAPSED_WIDTH_PX) return null;
    const restored = restorableWidth(remembered, windowWidth);
    if (restored === null) return null;
    if (Math.abs(currentWidth - restored) <= WIDTH_EPSILON_PX) return null;
    return restored;
}

/**
 * Classify one width change against the previous sample. Exported pure so
 * the keeper's per-step decision is table-testable.
 *
 * - At or below {@link WIDTH_EPSILON_PX}: `stable` (noise).
 * - Within {@link WINDOW_RESIZE_CORRELATION_MS} of a window resize:
 *   `window-resize` (checked before the drop test — a narrowed window looks
 *   like a large drop).
 * - A drop over {@link RESET_DROP_PX} that arrives after the width has been
 *   still for {@link DRAG_STILL_MS}, with focus outside the sidebar:
 *   `reset-drop`. Large *increases* are never resets (expanding a collapsed
 *   sidebar is one big step and is always the user's or core's intent).
 * - Everything else: `drag` (adopt).
 *
 * `msSinceLastChange` is null when the previous change time is unknown,
 * which counts as still.
 */
export function classifyWidthChange(
    prev: WidthSample,
    next: WidthSample,
    context: Pick<WidthObserveContext, 'lastWindowResizeMs' | 'resetAllowed'>,
    msSinceLastChange: number | null
): WidthChangeKind {
    if (Math.abs(next.width - prev.width) <= WIDTH_EPSILON_PX) return 'stable';
    if (context.lastWindowResizeMs !== null && next.atMs - context.lastWindowResizeMs <= WINDOW_RESIZE_CORRELATION_MS) {
        return 'window-resize';
    }
    const drop = prev.width - next.width;
    if (drop > RESET_DROP_PX && context.resetAllowed) {
        const still = msSinceLastChange === null || msSinceLastChange >= DRAG_STILL_MS;
        if (still) return 'reset-drop';
    }
    return 'drag';
}

/**
 * Stateful keeper: consumes width observations and decides what to remember,
 * when to persist, and when an observed change is an un-commanded reset that
 * should be countered by re-applying the remembered width. Pure state — no
 * DOM, no Obsidian, no timers.
 */
export class SidebarWidthKeeper {
    private remembered: number | null = null;
    private lastSample: WidthSample | null = null;
    private lastChangeMs: number | null = null;

    /** The currently remembered width, or null when nothing is remembered yet. */
    get rememberedWidth(): number | null {
        return this.remembered;
    }

    /**
     * Seed the remembered width from persistence. Lenient: non-finite or
     * collapsed values are dropped; bounds are re-checked at restore time.
     */
    seedRemembered(width: number | null): void {
        this.remembered = width !== null && Number.isFinite(width) && width > COLLAPSED_WIDTH_PX ? width : null;
    }

    /**
     * Record the first sample of a session and adopt the current width when
     * nothing was seeded (fresh installs). The restore-on-open decision is
     * the wiring's job via {@link restoreWidthForOpen}; this only baselines
     * the sample stream.
     */
    begin(currentWidth: number, atMs: number, context: WidthObserveContext): WidthDecision {
        this.lastSample = { width: currentWidth, atMs };
        this.lastChangeMs = atMs;
        if (this.remembered !== null || currentWidth <= COLLAPSED_WIDTH_PX) {
            return {
                kind: 'initial',
                fromWidth: null,
                rememberedWidth: this.remembered,
                restoreWidth: null,
                persist: false
            };
        }
        this.remembered = clampSidebarWidth(currentWidth, context.windowWidth);
        return {
            kind: 'initial',
            fromWidth: null,
            rememberedWidth: this.remembered,
            restoreWidth: null,
            persist: true
        };
    }

    /**
     * Observe a sidedock width and classify the change. Collapsed samples are
     * ignored entirely (they do not touch the sample baseline, so expanding a
     * collapsed sidebar later compares against the pre-collapse width).
     */
    observe(width: number, atMs: number, context: WidthObserveContext): WidthDecision {
        if (!Number.isFinite(width) || width <= COLLAPSED_WIDTH_PX) {
            return {
                kind: 'collapsed',
                fromWidth: null,
                rememberedWidth: this.remembered,
                restoreWidth: null,
                persist: false
            };
        }
        const prev = this.lastSample;
        if (!prev) {
            // Defensively adopt when begin() was never called.
            if (this.remembered === null) this.remembered = clampSidebarWidth(width, context.windowWidth);
            return {
                kind: 'initial',
                fromWidth: null,
                rememberedWidth: this.remembered,
                restoreWidth: null,
                persist: true
            };
        }
        this.lastSample = { width, atMs };
        const msSinceLastChange = this.lastChangeMs === null ? null : atMs - this.lastChangeMs;
        const kind = classifyWidthChange(prev, { width, atMs }, context, msSinceLastChange);
        if (kind === 'stable') {
            return {
                kind,
                fromWidth: prev.width,
                rememberedWidth: this.remembered,
                restoreWidth: null,
                persist: false
            };
        }
        if (kind === 'reset-drop') {
            this.lastChangeMs = atMs;
            const restore = this.remembered === null ? null : restorableWidth(this.remembered, context.windowWidth);
            const restoreWidth = restore !== null && Math.abs(width - restore) > WIDTH_EPSILON_PX ? restore : null;
            return { kind, fromWidth: prev.width, rememberedWidth: this.remembered, restoreWidth, persist: false };
        }
        // 'drag' | 'window-resize' — the observed width is the new truth.
        this.remembered = clampSidebarWidth(width, context.windowWidth);
        this.lastChangeMs = atMs;
        return { kind, fromWidth: prev.width, rememberedWidth: this.remembered, restoreWidth: null, persist: true };
    }
}

/** Build the sidecar payload for a remembered width. */
export function sidebarWidthState(width: number): SidebarWidthState {
    return { version: SIDEBAR_WIDTH_STATE_VERSION, width };
}

/**
 * Parse the sidecar payload into a remembered width, or null on miss,
 * corruption, version drift, or a collapsed/invalid width.
 */
export function parseSidebarWidthState(raw: string): number | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        if (record.version !== SIDEBAR_WIDTH_STATE_VERSION) return null;
        const width = record.width;
        if (typeof width !== 'number' || !Number.isFinite(width) || width <= COLLAPSED_WIDTH_PX) return null;
        return width;
    } catch {
        return null;
    }
}

/**
 * Find the sidedock element that hosts the given view container. Obsidian
 * marks the right sidedock with `.workspace-split.mod-right-split`; walking
 * up from the view's own container stays inside the correct window/document
 * (popout-safe) and never guesses from a global root.
 */
export function resolveSidedockElement(from: HTMLElement): HTMLElement | null {
    return from.closest('.workspace-split.mod-right-split');
}

/**
 * Read the sidedock's current width, or null when the element is missing or
 * not laid out (collapsed sidebars report zero and are ignored upstream).
 */
export function readSidedockWidth(el: HTMLElement | null): number | null {
    if (!el) return null;
    const width = el.getBoundingClientRect().width;
    return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Whether the active leaf lives inside the given container (the writer's
 * focus is in the sidebar). Resolved against the container's own document,
 * so popout windows answer correctly.
 */
export function isLeafActiveInside(container: HTMLElement): boolean {
    const active = container.ownerDocument.querySelector('.workspace-leaf.mod-active');
    return active instanceof HTMLElement && container.contains(active);
}

/** Apply a restored width as an inline style — no `!important`, so the writer's own drag-resizing keeps working. */
export function applySidebarWidth(el: HTMLElement, width: number): void {
    el.style.width = `${Math.round(width)}px`;
}
