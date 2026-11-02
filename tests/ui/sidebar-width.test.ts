// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    COLLAPSED_WIDTH_PX,
    MIN_EDITOR_ROOM_PX,
    SIDEBAR_DIVIDER_STRIP_PX,
    SIDEBAR_MIN_WIDTH_PX,
    WIDTH_EPSILON_PX,
    SIDEBAR_WIDTH_STATE_VERSION,
    SidebarWidthKeeper,
    applySidebarWidth,
    classifyWidthChange,
    clampSidebarWidth,
    isSidebarDividerGrab,
    parseSidebarWidthState,
    readSidedockWidth,
    resolveSidedockElement,
    restoreWidthForOpen,
    restorableWidth,
    sidedockHasKeyboardFocus,
    sidebarWidthKeeperEnabled,
    sidebarWidthState
} from '../../src/ui/sidebar-width';
import type { WidthChangeKind, WidthObserveContext, WidthSample } from '../../src/ui/sidebar-width';

/** A desktop observation context: no recent window resize, focus outside the sidebar. */
function ctx(overrides?: Partial<WidthObserveContext>): WidthObserveContext {
    return { windowWidth: 1600, lastWindowResizeMs: null, resetAllowed: true, ...overrides };
}

/** Build a width sample at a given timestamp. */
function at(width: number, atMs: number): WidthSample {
    return { width, atMs };
}

/** Stub an element's measured rect width (happy-dom reports zeros by default). */
function withMeasuredWidth(el: HTMLElement, width: number): HTMLElement {
    el.getBoundingClientRect = () => ({ width } as DOMRect);
    return el;
}

describe('sidebarWidthKeeperEnabled', () => {
    it('runs on desktop and is a complete no-op on mobile', () => {
        expect(sidebarWidthKeeperEnabled(false)).toBe(true);
        expect(sidebarWidthKeeperEnabled(true)).toBe(false);
    });
});

describe('clampSidebarWidth', () => {
    it('clamps to the min bound, the window-relative max, and rounds', () => {
        const cases: Array<{ width: number; windowWidth: number; expected: number }> = [
            { width: 150, windowWidth: 1600, expected: SIDEBAR_MIN_WIDTH_PX }, // below min
            { width: 300, windowWidth: 1600, expected: 300 }, // in band, unchanged
            { width: 425.6, windowWidth: 1600, expected: 426 }, // fractional → rounded
            { width: 2000, windowWidth: 1600, expected: 1600 - MIN_EDITOR_ROOM_PX }, // above window max
            { width: 450, windowWidth: 500, expected: SIDEBAR_MIN_WIDTH_PX }, // max < min → min wins
            { width: 400, windowWidth: 0, expected: 400 } // unknown window → min-clamp only
        ];
        for (const c of cases) {
            expect(clampSidebarWidth(c.width, c.windowWidth)).toBe(c.expected);
        }
    });
});

describe('restorableWidth', () => {
    it('returns null when nothing is remembered or the window is unusable', () => {
        expect(restorableWidth(null, 1600)).toBeNull();
        expect(restorableWidth(450, 0)).toBeNull();
        expect(restorableWidth(450, Number.NaN)).toBeNull();
    });

    it('returns null when the window cannot fit min width plus editor room', () => {
        expect(restorableWidth(450, MIN_EDITOR_ROOM_PX + SIDEBAR_MIN_WIDTH_PX - 1)).toBeNull();
        // At the exact boundary the clamp still has room; the remembered width is clamped down to it.
        expect(restorableWidth(450, MIN_EDITOR_ROOM_PX + SIDEBAR_MIN_WIDTH_PX)).toBe(200);
    });

    it('clamps the remembered width into the safe band', () => {
        const cases: Array<{ remembered: number; windowWidth: number; expected: number }> = [
            { remembered: 450, windowWidth: 1600, expected: 450 }, // fits as-is
            { remembered: 150, windowWidth: 1600, expected: SIDEBAR_MIN_WIDTH_PX }, // below min
            { remembered: 2000, windowWidth: 1600, expected: 1600 - MIN_EDITOR_ROOM_PX } // above max
        ];
        for (const c of cases) {
            expect(restorableWidth(c.remembered, c.windowWidth)).toBe(c.expected);
        }
    });
});

describe('restoreWidthForOpen', () => {
    it('does nothing without a remembered width', () => {
        expect(restoreWidthForOpen(null, 300, 1600)).toBeNull();
    });

    it('ignores collapsed sidebars entirely', () => {
        expect(restoreWidthForOpen(450, 0, 1600)).toBeNull();
        expect(restoreWidthForOpen(450, COLLAPSED_WIDTH_PX, 1600)).toBeNull();
    });

    it('treats widths within the epsilon as already matching', () => {
        expect(restoreWidthForOpen(450, 450 + WIDTH_EPSILON_PX, 1600)).toBeNull();
        expect(restoreWidthForOpen(450, 450 - WIDTH_EPSILON_PX - 0.5, 1600)).toBe(450);
    });

    it('restores the remembered width when the current one drifted (the issue #67 scenario)', () => {
        expect(restoreWidthForOpen(450, 300, 1600)).toBe(450);
    });

    it('clamps the restore when the window shrank across sessions', () => {
        expect(restoreWidthForOpen(450, 250, 600)).toBe(600 - MIN_EDITOR_ROOM_PX);
    });
});

describe('classifyWidthChange', () => {
    it('classifies single width changes', () => {
        // [prevWidth, nextWidth, atMs, lastWindowResizeMs, resetAllowed, msSinceLastChange, expected]
        const cases: Array<[number, number, number, number | null, boolean, number | null, WidthChangeKind]> = [
            [300, 301, 10_000, null, true, 5_000, 'stable'], // noise
            [300, 300 + WIDTH_EPSILON_PX, 10_000, null, true, 5_000, 'stable'], // exactly epsilon
            [300, 200, 10_000, 9_900, true, 5_000, 'window-resize'], // correlated w/ resize despite the drop
            [300, 200, 10_000, 9_700, true, 5_000, 'window-resize'], // exactly at the correlation edge (300ms)
            [300, 200, 10_000, 9_699, true, 5_000, 'reset-drop'], // 1ms past the correlation window
            [450, 300, 10_000, null, true, 5_000, 'reset-drop'], // the reported reset
            [450, 300, 10_000, 8_000, true, 5_000, 'reset-drop'], // stale resize does not correlate
            [450, 300, 10_000, null, true, null, 'reset-drop'], // unknown last-change time counts as still
            [450, 399, 10_000, null, true, 5_000, 'reset-drop'], // drop of 51, just over the threshold
            [450, 400, 10_000, null, true, 5_000, 'drag'], // drop of exactly 50 → drag
            [450, 401, 10_000, null, true, 5_000, 'drag'], // medium drop (49px) → drag
            [450, 300, 10_000, null, true, 400, 'drag'], // big drop mid-drag-burst → drag
            [450, 300, 10_000, null, false, 5_000, 'drag'], // focus inside the sidebar → user intent
            [300, 450, 10_000, null, true, 5_000, 'drag'], // large increases are never resets
            [300, 290, 10_000, null, true, 5_000, 'drag'] // small drop after stillness → drag
        ];
        for (const [prevWidth, nextWidth, atMs, lastWindowResizeMs, resetAllowed, msSinceLastChange, expected] of cases) {
            const kind = classifyWidthChange(at(prevWidth, atMs - 1000), at(nextWidth, atMs), { lastWindowResizeMs, resetAllowed }, msSinceLastChange);
            expect(kind).toBe(expected);
        }
    });
});

describe('SidebarWidthKeeper', () => {
    it('adopts the current width on a fresh session and persists it', () => {
        const keeper = new SidebarWidthKeeper();
        const decision = keeper.begin(300.4, 1000, ctx());
        expect(decision.kind).toBe('initial');
        expect(decision.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(300);
    });

    it('keeps the seeded width over the current one at begin', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(450);
        const decision = keeper.begin(300, 1000, ctx());
        expect(decision.persist).toBe(false);
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('drops non-finite and collapsed seeds', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(Number.NaN);
        expect(keeper.rememberedWidth).toBeNull();
        keeper.seedRemembered(COLLAPSED_WIDTH_PX);
        expect(keeper.rememberedWidth).toBeNull();
        keeper.seedRemembered(380);
        expect(keeper.rememberedWidth).toBe(380);
    });

    it('adopts drag-like incremental changes', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(300, 1000, ctx());
        const decision = keeper.observe(320, 1100, ctx());
        expect(decision.kind).toBe('drag');
        expect(decision.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(320);
    });

    it('detects an un-commanded reset, restores the remembered width, and keeps it', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(450, 1000, ctx());
        // A stable re-observation (within the epsilon) leaves the change
        // baseline untouched — stillness since begin is what arms the reset.
        keeper.observe(448, 2000, ctx());
        const decision = keeper.observe(300, 30_000, ctx());
        expect(decision.kind).toBe('reset-drop');
        expect(decision.fromWidth).toBe(448);
        expect(decision.restoreWidth).toBe(450);
        // The epsilon-stable sample never adopted 448, so the memory is still the begin width.
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('re-adopts the restored width on the following sample without loop', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(450, 1000, ctx());
        keeper.observe(300, 30_000, ctx({ resetAllowed: true }));
        const afterRestore = keeper.observe(450, 30_050, ctx());
        expect(afterRestore.kind).toBe('drag'); // large increase → adopt, not restore
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('ignores collapsed samples entirely', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(450, 1000, ctx());
        const collapsed = keeper.observe(0, 2000, ctx());
        expect(collapsed.kind).toBe('collapsed');
        expect(collapsed.persist).toBe(false);
        expect(keeper.rememberedWidth).toBe(450);
        // The pre-collapse sample stays the baseline, so the expand below is a
        // small change rather than a large increase.
        const expanded = keeper.observe(451, 3000, ctx());
        expect(expanded.kind).toBe('stable');
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('adopts window-resize-correlated changes', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(400, 1000, ctx());
        const decision = keeper.observe(320, 5000, ctx({ lastWindowResizeMs: 4950 }));
        expect(decision.kind).toBe('window-resize');
        expect(decision.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(320);
    });

    it('treats large drops with focus inside the sidebar as user intent', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(450, 1000, ctx());
        const decision = keeper.observe(300, 30_000, ctx({ resetAllowed: false }));
        expect(decision.kind).toBe('drag');
        expect(decision.restoreWidth).toBeNull();
        expect(keeper.rememberedWidth).toBe(300);
    });

    it('yields no restore when nothing is remembered or the window is too small', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.begin(450, 1000, ctx());
        const noWindow = keeper.observe(300, 30_000, ctx({ windowWidth: 400 }));
        expect(noWindow.kind).toBe('reset-drop');
        expect(noWindow.restoreWidth).toBeNull();
    });

    it('adopts defensively when observe runs before begin', () => {
        const keeper = new SidebarWidthKeeper();
        const decision = keeper.observe(312.4, 1000, ctx());
        expect(decision.kind).toBe('initial');
        expect(decision.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(312);
    });

    it('baselines on the first observe so later changes classify without begin', () => {
        const keeper = new SidebarWidthKeeper();
        const first = keeper.observe(300, 1000, ctx());
        expect(first.kind).toBe('initial');
        const second = keeper.observe(320, 1100, ctx());
        expect(second.kind).toBe('drag');
        expect(second.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(320);
    });

    it('carries a first-observe restore intent when a seeded width differs', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(450);
        const decision = keeper.observe(300, 1000, ctx());
        expect(decision.kind).toBe('initial');
        expect(decision.restoreWidth).toBe(450);
        expect(decision.persist).toBe(false);
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('re-adopts the restored width on the sample after a first-visible restore', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(450);
        const first = keeper.observe(300, 1000, ctx());
        expect(first.restoreWidth).toBe(450);
        const afterRestore = keeper.observe(450, 1050, ctx());
        expect(afterRestore.kind).toBe('drag');
        expect(afterRestore.persist).toBe(true);
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('skips the first-observe restore when the observed width matches within the epsilon', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(450);
        const decision = keeper.observe(450 + WIDTH_EPSILON_PX, 1000, ctx());
        expect(decision.kind).toBe('initial');
        expect(decision.restoreWidth).toBeNull();
        expect(decision.persist).toBe(false);
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('skips the first-observe restore when the remembered width does not fit the window', () => {
        const keeper = new SidebarWidthKeeper();
        keeper.seedRemembered(450);
        const decision = keeper.observe(300, 1000, ctx({ windowWidth: 400 }));
        expect(decision.restoreWidth).toBeNull();
        expect(keeper.rememberedWidth).toBe(450);
    });

    it('never carries a first-observe restore when nothing is seeded', () => {
        const keeper = new SidebarWidthKeeper();
        const decision = keeper.observe(300, 1000, ctx());
        expect(decision.restoreWidth).toBeNull();
        expect(decision.persist).toBe(true); // the defensive fresh-install adopt
        expect(keeper.rememberedWidth).toBe(300);
    });
});

describe('sidebar width sidecar payload', () => {
    it('round-trips through sidebarWidthState + parseSidebarWidthState', () => {
        const parsed = parseSidebarWidthState(JSON.stringify(sidebarWidthState(437)));
        expect(parsed).toBe(437);
    });

    it('rejects malformed payloads', () => {
        const cases: Array<[string, unknown]> = [
            ['not json', null],
            [JSON.stringify({ version: SIDEBAR_WIDTH_STATE_VERSION + 1, width: 400 }), null], // version drift
            [JSON.stringify({ version: SIDEBAR_WIDTH_STATE_VERSION }), null], // missing width
            [JSON.stringify({ version: SIDEBAR_WIDTH_STATE_VERSION, width: '400' }), null], // wrong type
            [JSON.stringify({ version: SIDEBAR_WIDTH_STATE_VERSION, width: Number.NaN }), null],
            [JSON.stringify({ version: SIDEBAR_WIDTH_STATE_VERSION, width: 0 }), null], // collapsed
            [JSON.stringify([400]), null], // array
            ['null', null]
        ];
        for (const [raw, expected] of cases) {
            expect(parseSidebarWidthState(raw)).toBe(expected);
        }
    });
});

describe('sidebar width DOM helpers', () => {
    /** A minimal fake right-sidedock with a Quill leaf inside. */
    function buildSidedock(): { sidedock: HTMLElement; leaf: HTMLElement } {
        const sidedock = createDiv();
        sidedock.className = 'workspace-split mod-right-split';
        const leaf = createDiv();
        leaf.className = 'workspace-leaf mod-active';
        sidedock.appendChild(leaf);
        document.body.appendChild(sidedock);
        return { sidedock, leaf };
    }

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('resolveSidedockElement finds the sidedock ancestor and null when absent', () => {
        const { sidedock, leaf } = buildSidedock();
        expect(resolveSidedockElement(leaf)).toBe(sidedock);
        const orphan = createDiv();
        expect(resolveSidedockElement(orphan)).toBeNull();
    });

    it('readSidedockWidth reads the measured width and ignores zero', () => {
        const el = createDiv();
        expect(readSidedockWidth(null)).toBeNull();
        expect(readSidedockWidth(withMeasuredWidth(el, 0))).toBeNull();
        expect(readSidedockWidth(withMeasuredWidth(el, 312.2))).toBe(312.2);
    });

    it('sidedockHasKeyboardFocus follows actual keyboard focus, not the active leaf', () => {
        // buildSidedock marks its leaf `.mod-active` — the post-Discuss state
        // (setActiveLeaf(leaf, { focus: false }) marks the Quill leaf active
        // while keyboard focus stays in the editor). Focus is on the body:
        // outside the dock, so the dock does NOT have keyboard focus despite
        // carrying the active leaf.
        const { sidedock } = buildSidedock();
        expect(sidedockHasKeyboardFocus(sidedock)).toBe(false);
        // Focus moves into the dock (the writer clicks into the sidebar).
        const inside = createDiv();
        sidedock.appendChild(inside);
        inside.focus();
        expect(sidedockHasKeyboardFocus(sidedock)).toBe(true);
        // Focus moves back outside (into the editor).
        const outside = createDiv();
        document.body.appendChild(outside);
        outside.focus();
        expect(sidedockHasKeyboardFocus(sidedock)).toBe(false);
    });

    it('applySidebarWidth writes a rounded inline width without !important', () => {
        const el = createDiv();
        applySidebarWidth(el, 412.6);
        expect(el.style.width).toBe('413px');
        expect(el.style.getPropertyPriority('width')).toBe('');
    });
});

describe('isSidebarDividerGrab', () => {
    /** A fake right-sidedock with one plain child, positioned at left=800px. */
    function buildDock(): { sidedock: HTMLElement; child: HTMLElement; left: number } {
        const sidedock = createDiv();
        sidedock.className = 'workspace-split mod-right-split';
        const child = createDiv();
        child.className = 'workspace-tabs';
        sidedock.appendChild(child);
        document.body.appendChild(sidedock);
        const left = 800;
        sidedock.getBoundingClientRect = () => ({ left, width: 400 } as DOMRect);
        return { sidedock, child, left };
    }

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('hits the left-edge strip (the divider side of the right sidebar)', () => {
        const { sidedock, child, left } = buildDock();
        // A few px inside the edge...
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 5, target: child })).toBe(true);
        // ...exactly at the strip bound...
        expect(isSidebarDividerGrab(sidedock, { clientX: left + SIDEBAR_DIVIDER_STRIP_PX, target: child })).toBe(true);
        // ...and slightly negative (Obsidian's handle straddles the boundary).
        expect(isSidebarDividerGrab(sidedock, { clientX: left - 3, target: child })).toBe(true);
    });

    it('misses far from the divider edge', () => {
        const { sidedock, child, left } = buildDock();
        expect(isSidebarDividerGrab(sidedock, { clientX: left + SIDEBAR_DIVIDER_STRIP_PX + 1, target: child })).toBe(false);
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 200, target: child })).toBe(false);
    });

    it('matches the resize-handle class anywhere inside the dock', () => {
        const { sidedock, left } = buildDock();
        const handle = createDiv();
        handle.className = 'workspace-leaf-resize-handle';
        sidedock.appendChild(handle);
        // Deep inside the dock (the strip misses) — the class still qualifies.
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 200, target: handle })).toBe(true);
    });

    it('misses on the wrong side, on uncontained targets, and on non-elements', () => {
        const { sidedock, child, left } = buildDock();
        // Just past the negative tolerance — not the divider side.
        expect(isSidebarDividerGrab(sidedock, { clientX: left - SIDEBAR_DIVIDER_STRIP_PX - 1, target: child })).toBe(false);
        // A resize-classed element outside the dock subtree never qualifies.
        const stranger = createDiv();
        stranger.className = 'workspace-leaf-resize-handle';
        document.body.appendChild(stranger);
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 5, target: stranger })).toBe(false);
        // Non-element and absent targets bail out.
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 5, target: null })).toBe(false);
        expect(isSidebarDividerGrab(sidedock, { clientX: left + 5, target: 'div' })).toBe(false);
    });
});
