// Diagnostic (observe-mode) spec for issue #67: does an Obsidian POP-OUT
// window remember its size across focus switches to the main window and back?
//
// This is an observe-mode measurement, wherever it runs: the persistence
// numbers are DATA for the owner's decision, not a pass/fail
// gate. The spec asserts only mechanics we are sure of (popout created, window
// handles enumerable, a resize lever took effect) and logs every size reading
// loudly with a `[popout-smoke]` prefix so the WDIO output carries the numbers
// verbatim. The resize mechanics gate is best-effort, NOT pass/fail: the
// resize levers are environment-sensitive, and when NO lever can move the
// popout's bounds materially the spec SELF-SKIPS (via `this.skip()`) instead
// of failing — the observations logged above the skip stand as the data.
//
// Drive route:
//   1. Open a manuscript in the main window's editor pane + open the Quill
//      sidebar (right sidedock, where `openLintPanel` docks it).
//   2. Mark the main window renderer (`window.__quillPopoutSmokeMain`) so
//      handles can be identified by content later.
//   3. Pop the Quill leaf out via the built-in `workspace:move-to-new-window`
//      command (falls back to `workspace.moveLeafToPopout`, then to re-homing
//      the view into a main-area leaf first — sidedock tabs are not
//      pop-out-able in the Obsidian UI, so a writer would have dragged the tab
//      into the main area before popping the window out).
//   4. Identify the popout among the WebDriver window handles by marker +
//      Quill tab bar presence.
//   5. Resize the popout via `window.resizeTo` in its own renderer. (The
//      WebDriver window/rect commands are unavailable: chromedriver implements
//      them via CDP `Browser.getWindowForTarget`, which Chromium 150 removed.)
//      `window.resizeTo` is inert under virtual/headless displays (Xvfb et
//      al.), so when it moves nothing the spec FALLS BACK to the other
//      lever — main-window-bridge `BrowserWindow#setBounds` (the V2
//      `setBounds` cell's code path) — and recomputes the resize delta from
//      whichever resize took effect. If BOTH levers move nothing, the
//      environment cannot drive popout size and the spec self-skips.
//   6. Click into the main window's editor pane (the reporter's trigger),
//      then raise the main window at the ELECTRON level via the renderer's
//      `window.electron.remote` bridge (`BrowserWindow#focus`), read BOTH
//      windows' `BrowserWindow#isFocused()` + `getBounds()`, return focus to
//      the popout the same way, and read the size again.
//   7. Log before / at-focus-loss / after sizes. Assert only mechanics.
//
// Differential matrix (env-parametrized; resolves the manual-vs-automated
// divergence — the owner manually popped a NOTE pane, dragged its edges, and
// clicked into the main window, and the size KEPT; the automated cell reset):
//   POPOUT_PANE   = sidebar | note        V1 — which leaf is popped out:
//                   the sidedock Quill view (automation original) vs a
//                   markdown editor leaf (what a writer pops). note opens
//                   Chapter 01 in main (click target) + Chapter 02 in a
//                   fresh main-area leaf, and pops THAT.
//   POPOUT_RESIZE = resizeTo | setBounds  V2 — the popout renderer's
//                   `window.resizeTo` vs `BrowserWindow#setBounds` issued
//                   through the MAIN window's remote bridge (closest
//                   automatable analogue to an OS-level drag; bypasses the
//                   popout renderer entirely). Bounds round-trip through
//                   the same authoritative getBounds() reads either way.
//                   The resizeTo cell auto-falls-back to the setBounds path
//                   when resizeTo moves nothing; if no lever moves the
//                   bounds the spec self-skips (environment cannot drive
//                   popout size) rather than hard-failing.
//   POPOUT_FOCUS  = click | click+focus   V3 — CDP click into the main
//                   window's editor alone, vs click + programmatic
//                   `BrowserWindow#focus()` on the main window. NOTE: CDP
//                   input is synthetic and lands in the webContents without
//                   passing through the window manager, so under the
//                   click-only cell the WM focus may never actually move
//                   (the isFocused snapshots are logged either way — read
//                   them before interpreting the persistence data).
//   POPOUT_SIZE   = WIDTHxHEIGHT          resize target override (default
//                   1100x900). The display-size-constraint hypothesis: if
//                   the target exceeds the display, a compositor/Electron
//                   focus-time validation may revert the window; a
//                   fits-in-display cell (e.g. 900x600) discriminates.
//   POPOUT_DWELL_MS = milliseconds       pause between the completed resize
//                   and the focus switch. The timing hypothesis: Obsidian
//                   re-applies SAVED floating-window bounds on focus loss;
//                   a human's multi-second gap lets the debounced layout
//                   save land first, the harness's ~1.5s gap does not.
// Defaults reproduce the original control cell: sidebar + resizeTo +
// click+focus.
// Provenance controls (per run, loud): drive route + whether the popped leaf
// was sidedock- or main-area-derived + the popout's AT-CREATION size before
// any resize + display geometry (screen + avail) with a fits/exceeds marker
// for the resize target + the saved workspace.json floating-window bounds
// read pre-blur and post-blur (bounds the app would re-apply on focus loss).
//
// Size + focus authority: renderer `document.hasFocus()` proved unreliable
// here (both windows report true simultaneously when driven over CDP), so the
// spec reads `electron.remote.BrowserWindow` state as ground truth and logs
// the renderer numbers alongside. If the remote bridge is ever removed, the
// spec degrades to renderer-only metrics (fields logged as null) instead of
// failing.
import { browser } from '@wdio/globals';
import { expect } from 'chai';
import { obsidianPage } from 'wdio-obsidian-service';
import { openFile, openQuillSidebar, isMobileEmulation } from '../helpers/obsidian-helpers.js';

/** Loud log prefix so the run output can be grepped for the numbers. */
const POP = '[popout-smoke]';

/** Differential-matrix cell config (env-driven; defaults = control cell).
 *  See the file header for what each axis isolates. */
const PANE = process.env.POPOUT_PANE === 'note' ? 'note' : 'sidebar';
const RESIZE = process.env.POPOUT_RESIZE === 'setBounds' ? 'setBounds' : 'resizeTo';
const FOCUS = process.env.POPOUT_FOCUS === 'click' ? 'click' : 'click+focus';

/** Resize target override, "WIDTHxHEIGHT" (e.g. "900x600"). Default 1100x900 —
 *  the original instrument size, which may EXCEED the harness display; the
 *  display-size-constraint hypothesis needs a fits-in-display cell to compare. */
function parseSizeEnv(raw: string): { width: number; height: number } | null {
    const m = /^(\d+)x(\d+)$/.exec(raw.trim());
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
const POPOUT_SIZE = parseSizeEnv(process.env.POPOUT_SIZE ?? '') ?? { width: 1100, height: 900 };

/** Dwell time (ms) between the completed resize and the focus switch. Default
 *  0 = the harness's natural ~1.5-2s gap. A long dwell lets Obsidian's
 *  debounced layout save land before the popout loses focus — the
 *  timing-vs-display-constraint discriminator. */
const DWELL_MS = Number(process.env.POPOUT_DWELL_MS ?? '0') || 0;

/** Side-by-side layout cell (owner-specified final run): place main on the
 *  LEFT half and the popout on the RIGHT half via BrowserWindow#setBounds,
 *  zero intersection, so an occlusion ("was it just underneath?") hypothesis
 *  can be tested visually and by bounds math. */
const SPLIT = process.env.POPOUT_LAYOUT === 'split';

/** Greppable label naming the cell's conditions — prepended to RESULT lines. */
const CELL = `pane=${PANE} resize=${RESIZE} focus=${FOCUS} size=${POPOUT_SIZE.width}x${POPOUT_SIZE.height} dwell=${DWELL_MS}ms layout=${SPLIT ? 'split' : 'default'}`;

/** Intersection of two windows' bounds, for the occlusion telemetry. */
function overlapRect(a: ElectronBounds, b: ElectronBounds): string {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) return 'none';
    return `rect ${x1},${y1} ${x2 - x1}x${y2 - y1} (${(x2 - x1) * (y2 - y1)}px2)`;
}

/** Electron `BrowserWindow#getBounds()` shape. */
type ElectronBounds = { x: number; y: number; width: number; height: number };

/** Authoritative per-window Electron state, read through the renderer's
 *  `window.electron.remote` bridge. Null when the bridge is unavailable. */
type ElectronWinInfo = {
    id: number;
    title: string;
    bounds: ElectronBounds;
    isFocused: boolean;
    isMinimized: boolean;
} | null;

/** What a window's renderer reports about itself, plus the Electron truth. */
type WindowReading = {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    hasFocus: boolean;
    visibilityState: string;
    isMarkedMain: boolean;
    screen: { width: number; height: number; availWidth: number; availHeight: number; dpr: number };
    electron: ElectronWinInfo;
};

/** Snapshot of every Electron BrowserWindow (bounds + focus state). */
type AllWindowsSnapshot = Array<ElectronWinInfo>;

/** Minimal slice of the Obsidian App API this spec touches (untyped otherwise). */
type QuillApp = {
    commands: {
        listCommands: () => Array<{ id: string; name: string }>;
        executeCommandById: (id: string) => void;
    };
    vault: {
        getFileByPath: (path: string) => unknown;
        adapter?: { basePath?: string };
    };
    workspace: {
        getLeavesOfType: (type: string) => QuillLeaf[];
        getLeaf: (newLeaf: boolean) => QuillLeaf;
        revealLeaf: (leaf: QuillLeaf) => Promise<void> | void;
        moveLeafToPopout: (leaf: QuillLeaf) => QuillWorkspaceWindow | undefined;
        floatingSplit?: { children?: unknown[] } | null;
    };
};

/** Minimal WorkspaceLeaf slice (view type + container window access). */
type QuillLeaf = {
    view: { getType: () => string };
    setViewState: (state: { type: string; active?: boolean }) => Promise<void>;
    getContainer: () => { win?: Window };
    openFile: (file: unknown) => Promise<void>;
    containerEl?: HTMLElement;
};

/** Minimal WorkspaceWindow slice. */
type QuillWorkspaceWindow = { win: Window };

/** Shape of the `window.electron` bridge Obsidian exposes to renderers. */
type ElectronBridge = {
    remote?: {
        getCurrentWindow?: () => ElectronWindowRef;
        BrowserWindow?: { getAllWindows?: () => ElectronWindowRef[] };
    };
};

/** Minimal BrowserWindow slice used through the remote bridge. */
type ElectronWindowRef = {
    id: number;
    getTitle: () => string;
    getBounds: () => ElectronBounds;
    setBounds: (bounds: ElectronBounds) => void;
    isFocused: () => boolean;
    isMinimized: () => boolean;
    focus: () => void;
};

/** Helper: read the current window's renderer + Electron state. Runs in the
 *  CURRENT window context (browser.switchToWindow picks the context). */
async function readCurrentWindow(): Promise<WindowReading> {
    return browser.execute((): WindowReading => {
        const markedMain = (window as unknown as { __quillPopoutSmokeMain?: boolean }).__quillPopoutSmokeMain === true;
        let electron: ElectronWinInfo = null;
        try {
            const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
            const win = bridge?.remote?.getCurrentWindow?.();
            if (win) {
                electron = {
                    id: win.id,
                    title: win.getTitle(),
                    bounds: win.getBounds(),
                    isFocused: win.isFocused(),
                    isMinimized: win.isMinimized()
                };
            }
        } catch {
            electron = null;
        }
        return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            hasFocus: document.hasFocus(),
            visibilityState: document.visibilityState,
            isMarkedMain: markedMain,
            screen: {
                width: screen.width,
                height: screen.height,
                availWidth: screen.availWidth,
                availHeight: screen.availHeight,
                dpr: window.devicePixelRatio
            },
            electron
        };
    });
}

/** Snapshot every Electron BrowserWindow's bounds + focus state. Runs in any
 *  window context (the bridge enumerates all windows of the app). */
async function snapshotAllWindows(): Promise<AllWindowsSnapshot> {
    return browser.execute((): AllWindowsSnapshot => {
        try {
            const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
            const wins = bridge?.remote?.BrowserWindow?.getAllWindows?.() ?? [];
            return wins.map((w) => ({
                id: w.id,
                title: w.getTitle(),
                bounds: w.getBounds(),
                isFocused: w.isFocused(),
                isMinimized: w.isMinimized()
            }));
        } catch {
            return [];
        }
    });
}

/** Raise + focus a specific Electron BrowserWindow (real window-manager-level
 *  focus, unlike WebDriver target switching which only changes the CDP
 *  context). Returns the target's `isFocused()` afterwards. */
async function focusElectronWindow(winId: number): Promise<boolean | null> {
    return browser.execute((id: number): boolean | null => {
        try {
            const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
            const wins = bridge?.remote?.BrowserWindow?.getAllWindows?.() ?? [];
            const target = wins.find((w) => w.id === id);
            if (!target) return null;
            target.focus();
            return target.isFocused();
        } catch {
            return null;
        }
    }, winId);
}

/** Saved floating-window geometry as it would be re-applied from disk:
 *  reads `<vault>/.obsidian/workspace.json`'s `main.floating` section through
 *  the main renderer's Node bridge, plus the file's mtime (shows whether the
 *  debounced layout save has landed). Observe-only; degrades to an error
 *  marker when `window.require` is unavailable. Runs in the MAIN window
 *  context. */
type SavedBoundsProbe = { ok: true; mtimeMs: number; floating: string } | { ok: false; error: string };

async function readSavedFloatingBounds(): Promise<SavedBoundsProbe> {
    return browser.execute((): SavedBoundsProbe => {
        try {
            const req = (window as unknown as { require?: (id: string) => unknown }).require;
            if (typeof req !== 'function') return { ok: false, error: 'window.require unavailable' };
            const fs = req('fs') as { readFileSync: (p: string, e: string) => string; statSync: (p: string) => { mtimeMs: number } };
            const basePath = (window as unknown as { app?: { vault?: { adapter?: { basePath?: string } } } }).app?.vault?.adapter?.basePath;
            if (!basePath) return { ok: false, error: 'no vault adapter basePath' };
            const p = `${basePath}/.obsidian/workspace.json`;
            const mtimeMs = fs.statSync(p).mtimeMs;
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { main?: { floating?: unknown } };
            return { ok: true, mtimeMs, floating: JSON.stringify(parsed.main?.floating ?? null) };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });
}

/** Drive the popout resize through the MAIN window's electron.remote bridge
 *  (`BrowserWindow#setBounds`, x/y reused from the live bounds read so only
 *  the size changes) — the V2 `setBounds` lever. Shared by the setBounds cell
 *  and the resizeTo-inert fallback. The caller re-reads the resulting window
 *  state itself so every AFTER-resize reading goes through the same
 *  authoritative getBounds()/renderer path. */
async function resizePopoutViaMainBridge(popoutHandle: string, mainHandle: string, popoutWinId: number): Promise<void> {
    await browser.switchToWindow(mainHandle);
    const setBoundsResult = await browser.execute((winId, w, h): { ok: boolean; bounds: ElectronBounds | null; error?: string } => {
        try {
            const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
            const wins = bridge?.remote?.BrowserWindow?.getAllWindows?.() ?? [];
            const target = wins.find((x) => x.id === winId);
            if (!target) return { ok: false, bounds: null, error: 'popout window not found in getAllWindows()' };
            const cur = target.getBounds();
            target.setBounds({ x: cur.x, y: cur.y, width: w, height: h });
            return { ok: true, bounds: target.getBounds() };
        } catch (e) {
            return { ok: false, bounds: null, error: e instanceof Error ? e.message : String(e) };
        }
    }, popoutWinId, POPOUT_SIZE.width, POPOUT_SIZE.height);
    console.log(`${POP} main-window bridge setBounds → ${JSON.stringify(setBoundsResult)}`);
    await browser.switchToWindow(popoutHandle);
    await browser.pause(800);
}

describe('Pop-out window size persistence (issue #67 observe-mode diagnostic)', () => {
    beforeEach(async function () {
        // Pop-out windows are a desktop concept — skip the mobile-emulation
        // capability (popouts cannot exist there; `moveLeafToPopout` throws).
        if (isMobileEmulation()) {
            this.skip();
            return;
        }
        // Full reboot per test: guarantees no popout restored from a previous
        // run's workspace.json contaminates the measurement.
        await obsidianPage.resetVault();
    });

    afterEach(async function () {
        // Best-effort: close any popout windows so workspace.json stays clean
        // for the next capability/test. WebDriver refuses to close the last
        // remaining window, so only extra handles are closed, then park the
        // session back on the first (main) handle.
        try {
            const handles = await browser.getWindowHandles();
            for (const handle of handles.slice(1)) {
                await browser.switchToWindow(handle);
                await browser.closeWindow();
            }
            await browser.switchToWindow(handles[0]!);
        } catch (e) {
            console.log(`${POP} afterEach cleanup note: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Provenance: where did the Quill view land after the popout closed?
        // (destroyed / re-docked in the right sidedock / stranded in main
        // area) — topology drift between runs would poison comparisons.
        try {
            const topology = await browser.execute(() => {
                const a = (window as unknown as { app: QuillApp }).app;
                const quills = a.workspace.getLeavesOfType('quill-sidebar').map((leaf) => {
                    const el = leaf.containerEl;
                    const where = el?.closest('.mod-right-split') || el?.closest('.mod-left-split')
                        ? 'sidedock'
                        : (el ? 'main-area' : 'unknown');
                    return where;
                });
                const markdowns = a.workspace.getLeavesOfType('markdown').length;
                return { quillLeaves: quills, markdownLeaves: markdowns };
            });
            console.log(`${POP} afterEach topology after popout close: ${JSON.stringify(topology)}`);
        } catch (e) {
            console.log(`${POP} afterEach topology note: ${e instanceof Error ? e.message : String(e)}`);
        }
    });

    it('measures pop-out window size before/after a focus switch (observe-only)', async function () {
        // ---- Environment facts -------------------------------------------------
        const env = await browser.execute(() => {
            const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
            return {
                userAgent: navigator.userAgent,
                electronKeys: bridge ? Object.keys(bridge) : 'absent',
                hasRemote: bridge?.remote?.getCurrentWindow !== undefined
            };
        });
        console.log(`${POP} Obsidian version=${await browser.getObsidianVersion()} (requested cap; observe-mode window-geometry diagnostic)`);
        console.log(`${POP} renderer UA: ${env.userAgent}`);
        console.log(`${POP} window.electron bridge keys: ${JSON.stringify(env.electronKeys)} remote-usable=${env.hasRemote}`);

        // ---- 1. Main window setup (V1: pane-type dependent) --------------------
        console.log(`${POP} cell: ${CELL} | Obsidian version=${await browser.getObsidianVersion()}`);
        if (PANE === 'note') {
            // The owner popped out a NOTE pane. Keep Chapter 01 in the main
            // window as the click target; the pop cascade below opens
            // Chapter 02 in a fresh main-area leaf and pops THAT.
            await openFile('manuscript/Chapter 01.md');
            const editorUp = await browser.$('.workspace-leaf.mod-active .workspace-leaf-content[data-type="markdown"] .cm-content');
            await editorUp.waitForDisplayed({ timeout: 10_000 });
        } else {
            await openFile('manuscript/Chapter 01.md');
            await openQuillSidebar();
        }

        // Mark the main window renderer so handles are identifiable by content.
        await browser.execute(() => {
            (window as unknown as { __quillPopoutSmokeMain?: boolean }).__quillPopoutSmokeMain = true;
        });

        // Enumerate window-related built-in commands (data for the report).
        const windowCommands = await browser.execute(() => {
            const a = (window as unknown as { app: QuillApp }).app;
            return a.commands.listCommands().filter((c) => /window/i.test(c.id)).map((c) => ({ id: c.id, name: c.name }));
        });
        console.log(`${POP} built-in window commands: ${JSON.stringify(windowCommands)}`);

        const mainHandle = await browser.getWindowHandle();
        const handlesBefore = await browser.getWindowHandles();
        console.log(`${POP} handles before popout: ${handlesBefore.length} (main=${mainHandle})`);

        // ---- 2. Pop the target leaf out ----------------------------------------
        // V1 note mode restricts the cascade to routes that pop the NOTE leaf;
        // the C routes exist to re-home a SIDEDOCK view into a main-area leaf
        // and have no note-mode meaning.
        const routes = PANE === 'note'
            ? ['A:command', 'B:moveLeafToPopout']
            : ['A:command', 'B:moveLeafToPopout', 'C:main-area-leaf+command', 'C2:main-area-leaf+moveLeafToPopout'];
        let route = '';
        let poppedSource = '';
        for (const candidate of routes) {
            const popped = await browser.execute(async (kind, pane): Promise<{ ok: boolean; source: string; quillLeafCount: number }> => {
                const a = (window as unknown as { app: QuillApp }).app;
                const quillLeafCount = a.workspace.getLeavesOfType('quill-sidebar').length;
                const classify = (leaf: QuillLeaf): string => {
                    const el = leaf.containerEl;
                    if (!el) return 'unknown';
                    if (el.closest('.mod-right-split') || el.closest('.mod-left-split')) return 'sidedock';
                    return 'main-area';
                };
                let leaf: QuillLeaf | undefined;
                let source = '';
                if (pane === 'note') {
                    // A fresh main-area leaf holding Chapter 02 — the note
                    // pane a writer pops. Re-created per attempt so route A
                    // (which acts on the ACTIVE leaf) always has a fresh,
                    // active markdown leaf to pop.
                    const file = a.vault.getFileByPath('manuscript/Chapter 02.md');
                    if (!file) return { ok: false, source: 'missing-file', quillLeafCount };
                    leaf = a.workspace.getLeaf(true);
                    await leaf.openFile(file);
                    source = 'fresh-main-area-leaf';
                } else {
                    const leaves = a.workspace.getLeavesOfType('quill-sidebar');
                    leaf = leaves[leaves.length - 1];
                    if (leaf) source = classify(leaf);
                }
                if (!leaf) return { ok: false, source: 'no-leaf', quillLeafCount };

                if (pane === 'sidebar' && (kind === 'C:main-area-leaf+command' || kind === 'C2:main-area-leaf+moveLeafToPopout')) {
                    // Open a fresh Quill view in a MAIN-AREA leaf and use it.
                    leaf = a.workspace.getLeaf(true);
                    await leaf.setViewState({ type: 'quill-sidebar', active: true });
                    await a.workspace.revealLeaf(leaf);
                    source = 'rehomed-main-area-leaf';
                }

                if (kind.startsWith('A')) {
                    const cmd = a.commands.listCommands().find((c) => c.id === 'workspace:move-to-new-window');
                    if (!cmd) return { ok: false, source: 'no-command', quillLeafCount };
                    a.commands.executeCommandById(cmd.id);
                } else if (kind.startsWith('B') || kind.startsWith('C2')) {
                    const win = a.workspace.moveLeafToPopout(leaf);
                    if (!win) return { ok: false, source: 'moveLeafToPopout-falsey', quillLeafCount };
                }
                return { ok: true, source, quillLeafCount };
            }, candidate, PANE);

            if (!popped.ok) continue;
            poppedSource = popped.source;
            console.log(`${POP} provenance: route=${candidate} popped-leaf-source=${poppedSource} quill-sidebar-leaves-in-window-before-pop=${popped.quillLeafCount}`);
            // Give the new BrowserWindow + its renderer a moment to appear,
            // then look for a NEW handle.
            const appeared = await browser.waitUntil(async () => {
                const handles = await browser.getWindowHandles();
                return handles.length > handlesBefore.length;
            }, { timeout: 8_000 }).then(() => true).catch(() => false);

            if (appeared) {
                route = candidate;
                break;
            }
            console.log(`${POP} route ${candidate} executed but no new window handle appeared`);
        }
        console.log(`${POP} popout route used: ${route || 'NONE — all routes failed'}`);

        // Mechanics assertion 1: the popout exists as a new WebDriver handle.
        const handlesAfter = await browser.getWindowHandles();
        expect(handlesAfter.length, `popout did not produce a new window handle (before=${handlesBefore.length}, after=${handlesAfter.length})`).to.be.greaterThan(handlesBefore.length);
        console.log(`${POP} handles after popout: ${handlesAfter.length} → ${JSON.stringify(handlesAfter)}`);

        // ---- 3. Identify the popout handle (marker + pane-view marker) --------
        let popoutHandle: string | null = null;
        for (const handle of handlesAfter) {
            if (handle === mainHandle) continue;
            await browser.switchToWindow(handle);
            const looksPopout = await browser.execute((pane) => {
                const markedMain = (window as unknown as { __quillPopoutSmokeMain?: boolean }).__quillPopoutSmokeMain === true;
                const hasQuill = document.querySelector('.quill-sidebar__tab-bar') !== null;
                const hasEditor = document.querySelector('.workspace-leaf-content[data-type="markdown"] .cm-content') !== null;
                const looksLikePane = pane === 'note' ? hasEditor : hasQuill;
                return !markedMain && looksLikePane;
            }, PANE);
            if (looksPopout) {
                popoutHandle = handle;
                break;
            }
        }
        expect(popoutHandle, `no handle contained the popped pane (${PANE}) without the main-window marker — popout not found`).to.not.be.null;
        console.log(`${POP} popout handle=${popoutHandle}`);

        // ---- 3b. Creation reading, then (split cell) side-by-side layout ------
        await browser.switchToWindow(popoutHandle!);
        const creation = await readCurrentWindow();
        console.log(`${POP} popout AT CREATION (pre-layout): renderer=${creation.innerWidth}x${creation.innerHeight} electron-bounds=${JSON.stringify(creation.electron?.bounds ?? null)} focused=${creation.electron?.isFocused ?? '?'}`);
        const popoutElectronId = creation.electron!.id;

        if (SPLIT) {
            // Owner-specified layout: main on the LEFT half, popout on the
            // RIGHT half, zero intersection — setBounds on BOTH windows from
            // the main window's bridge.
            await browser.switchToWindow(mainHandle);
            const splitResult = await browser.execute((popId): { ok: boolean; main: ElectronBounds | null; pop: ElectronBounds | null } => {
                try {
                    const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
                    const wins = bridge?.remote?.BrowserWindow?.getAllWindows?.() ?? [];
                    const mainWin = wins.find((x) => x.id !== popId);
                    const popWin = wins.find((x) => x.id === popId);
                    if (!mainWin || !popWin) return { ok: false, main: null, pop: null };
                    mainWin.setBounds({ x: 0, y: 100, width: 940, height: 800 });
                    popWin.setBounds({ x: 960, y: 100, width: 900, height: 800 });
                    return { ok: true, main: mainWin.getBounds(), pop: popWin.getBounds() };
                } catch (e) {
                    console.log(`split layout error: ${e instanceof Error ? e.message : String(e)}`);
                    return { ok: false, main: null, pop: null };
                }
            }, popoutElectronId);
            if (splitResult.ok && splitResult.main && splitResult.pop) {
                console.log(`${POP} split layout: main=${JSON.stringify(splitResult.main)} popout=${JSON.stringify(splitResult.pop)} overlap=${overlapRect(splitResult.main, splitResult.pop)}`);
            } else {
                console.log(`${POP} split layout FAILED: ${JSON.stringify(splitResult)}`);
            }
            await browser.switchToWindow(popoutHandle!);
        }

        // ---- 4. Resize the popout, read back (mechanics assertion) ------------
        // V2 resize lever, cell-selected:
        //   resizeTo  — `window.resizeTo` in the popout's own renderer (the
        //               automation original; wired to BrowserWindow bounds).
        //   setBounds — `BrowserWindow#setBounds` issued through the MAIN
        //               window's remote bridge, bypassing the popout renderer
        //               entirely (closest automatable analogue to an OS-level
        //               drag). x/y are reused from the live getBounds() read so
        //               only the size changes, and the result is verified by a
        //               fresh getBounds() — bounds round-trip through the same
        //               authoritative reads in both cells.
        await browser.switchToWindow(popoutHandle!);
        const beforeResize = await readCurrentWindow();
        console.log(`${POP} popout AT CREATION (pre-resize): renderer=${beforeResize.innerWidth}x${beforeResize.innerHeight} electron-bounds=${JSON.stringify(beforeResize.electron?.bounds ?? null)} focused=${beforeResize.electron?.isFocused ?? '?'}`);
        console.log(`${POP} display (popout renderer): screen=${beforeResize.screen.width}x${beforeResize.screen.height} avail=${beforeResize.screen.availWidth}x${beforeResize.screen.availHeight} dpr=${beforeResize.screen.dpr}`);
        const targetFitsDisplay = POPOUT_SIZE.width <= beforeResize.screen.availWidth && POPOUT_SIZE.height <= beforeResize.screen.availHeight;
        console.log(`${POP} resize target ${POPOUT_SIZE.width}x${POPOUT_SIZE.height} ${targetFitsDisplay ? 'FITS' : 'EXCEEDS'} avail display (${beforeResize.screen.availWidth}x${beforeResize.screen.availHeight})`);
        expect(beforeResize.electron, 'window.electron.remote bridge unavailable — cannot read authoritative window state').to.not.be.null;
        const popoutWinId = beforeResize.electron!.id;

        let resized: WindowReading;
        if (RESIZE === 'setBounds') {
            await resizePopoutViaMainBridge(popoutHandle!, mainHandle, popoutWinId);
            resized = await readCurrentWindow();
            console.log(`${POP} popout AFTER resize via main-bridge BrowserWindow.setBounds: renderer=${resized.innerWidth}x${resized.innerHeight} electron-bounds=${JSON.stringify(resized.electron?.bounds ?? null)} (requested ${POPOUT_SIZE.width}x${POPOUT_SIZE.height})`);
        } else {
            await browser.execute((w, h) => {
                window.resizeTo(w, h);
            }, POPOUT_SIZE.width, POPOUT_SIZE.height);
            await browser.pause(800);
            resized = await readCurrentWindow();
            console.log(`${POP} popout AFTER resize via renderer.window.resizeTo: renderer=${resized.innerWidth}x${resized.innerHeight} electron-bounds=${JSON.stringify(resized.electron?.bounds ?? null)} (requested ${POPOUT_SIZE.width}x${POPOUT_SIZE.height})`);
        }
        // Mechanics assertion 2: the resize lever moved the window materially
        // (on the authoritative Electron bounds). The levers are
        // environment-sensitive — renderer `window.resizeTo` is inert under
        // virtual/headless displays (the OS-level route it relies on never
        // fires) — so when the configured resizeTo lever moved nothing, try
        // the OTHER lever (main-bridge setBounds) before giving up, and
        // recompute the delta from whichever resize took effect.
        let delta = Math.abs((resized.electron!.bounds.width) - beforeResize.electron!.bounds.width)
            + Math.abs((resized.electron!.bounds.height) - beforeResize.electron!.bounds.height);
        if (delta <= 50 && RESIZE === 'resizeTo') {
            console.log(`${POP} resizeTo inert in this environment (delta=${delta}) — falling back to main-bridge setBounds`);
            await resizePopoutViaMainBridge(popoutHandle!, mainHandle, popoutWinId);
            resized = await readCurrentWindow();
            console.log(`${POP} popout AFTER fallback resize via main-bridge BrowserWindow.setBounds: renderer=${resized.innerWidth}x${resized.innerHeight} electron-bounds=${JSON.stringify(resized.electron?.bounds ?? null)} (requested ${POPOUT_SIZE.width}x${POPOUT_SIZE.height})`);
            delta = Math.abs((resized.electron!.bounds.width) - beforeResize.electron!.bounds.width)
                + Math.abs((resized.electron!.bounds.height) - beforeResize.electron!.bounds.height);
        }
        // Neither lever could move the bounds materially: this environment
        // cannot drive popout size at all. Self-skip rather than fail — the
        // observations logged above stand as the data, and a resize-mechanics
        // failure here says nothing about the persistence behavior under
        // measurement.
        if (delta <= 50) {
            console.log(`${POP} environment cannot drive popout size: no resize lever moved the bounds materially (configured lever=${RESIZE}${RESIZE === 'resizeTo' ? ', setBounds fallback tried' : ''}, final delta=${delta} <= 50, bounds=${JSON.stringify(resized.electron?.bounds ?? null)}) — skipping; observations above stand as data`);
            return this.skip();
        }
        expect(delta, `resize lever ${RESIZE} did not take effect (bounds still ${JSON.stringify(resized.electron!.bounds)}) — popout size cannot be driven from this environment`).to.be.greaterThan(50);

        // Dwell axis: give any debounced layout save time to land BEFORE the
        // focus switch (a human's gap is seconds; the harness's is ~1.5s).
        if (DWELL_MS > 0) {
            await browser.pause(DWELL_MS);
            const afterDwell = await readCurrentWindow();
            console.log(`${POP} popout AFTER ${DWELL_MS}ms dwell (no focus change yet): renderer=${afterDwell.innerWidth}x${afterDwell.innerHeight} electron-bounds=${JSON.stringify(afterDwell.electron?.bounds ?? null)}`);
        }
        if (SPLIT) {
            const popNow = await readCurrentWindow();
            const mainNow = (await snapshotAllWindows()).find((w) => w?.id !== popoutElectronId) ?? null;
            console.log(`${POP} WATCH: popout resized — bounds=${JSON.stringify(popNow.electron?.bounds ?? null)} vs main=${JSON.stringify(mainNow?.bounds ?? null)} overlap=${popNow.electron?.bounds && mainNow?.bounds ? overlapRect(popNow.electron.bounds, mainNow.bounds) : 'unknown'} — switching focus in 3s`);
            await browser.pause(3000);
        }

        // ---- 5. Focus the MAIN window: click into the editor pane (both cells),
        //         then raise it at the Electron level ONLY in click+focus cells.
        await browser.switchToWindow(mainHandle);
        const mainReading = await readCurrentWindow();
        const mainWinId = mainReading.electron!.id;
        console.log(`${POP} display (main renderer): screen=${mainReading.screen.width}x${mainReading.screen.height} avail=${mainReading.screen.availWidth}x${mainReading.screen.availHeight} dpr=${mainReading.screen.dpr} main-electron-bounds=${JSON.stringify(mainReading.electron?.bounds ?? null)}`);
        // Saved-state probe BEFORE any focus move: whatever geometry is on
        // disk here is what a focus-loss re-apply would restore.
        const probe0 = await readSavedFloatingBounds();
        console.log(`${POP} saved workspace.json floating (pre-blur): ${JSON.stringify(probe0)}`);
        // The click is the real driver ("navigate away from the sidebar to the
        // main document" — the reporter's trigger). CDP-dispatched input lands
        // in the webContents but is not an OS-level click. Whether the
        // programmatic focus() also fires is the V3 axis: click+focus performs
        // it (what actually moves window-manager focus in automation); click
        // relies on the click alone (closest to the owner's hand, though
        // synthetic input may never move WM focus — the snapshots decide).
        // Click the first DISPLAYED markdown editor in main. Note: Obsidian
        // keeps ONE active leaf across all windows, so after the popout takes
        // focus no main-window leaf carries `mod-active` — and background
        // markdown tabs exist in the DOM at 0x0. Filter by displayed-ness
        // instead of either marker.
        const editors = await browser.$$('.workspace-leaf-content[data-type="markdown"] .cm-content');
        let clicked = false;
        for (const candidate of editors) {
            if (await candidate.isDisplayed()) {
                await candidate.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) throw new Error('no displayed markdown editor found in the main window to click');
        await browser.pause(500);
        let mainFocusAfterClick: boolean | null = null;
        if (FOCUS === 'click+focus') {
            mainFocusAfterClick = await focusElectronWindow(mainWinId);
        }
        await browser.pause(1_500);
        const mainSnap1 = await snapshotAllWindows();
        console.log(`${POP} main window focus method=${FOCUS}: programmatic-focus-result=${mainFocusAfterClick} all-windows=${JSON.stringify(mainSnap1)}`);
        // Saved-state probe AFTER the focus moved: did Obsidian rewrite the
        // floating bounds at blur time, and with which values?
        const probe1 = await readSavedFloatingBounds();
        console.log(`${POP} saved workspace.json floating (post-blur): ${JSON.stringify(probe1)}`);
        if (SPLIT) {
            const popSnap = mainSnap1.find((w) => w?.id === popoutWinId) ?? null;
            const mainSnap = mainSnap1.find((w) => w?.id === mainWinId) ?? null;
            const overlapNow = popSnap?.bounds && mainSnap?.bounds ? overlapRect(popSnap.bounds, mainSnap.bounds) : 'unknown';
            console.log(`${POP} WATCH: focus switched — observe popout on the right. popout=${JSON.stringify(popSnap?.bounds ?? null)} main=${JSON.stringify(mainSnap?.bounds ?? null)} overlap=${overlapNow} popoutIsFocused=${popSnap?.isFocused ?? '?'}`);
            await browser.pause(3000);
        }

        // ---- 5b. Popout at the moment of focus loss ----------------------------
        // A size reset on BLUR would show here already; a reset only on
        // focus-back would show in step 6 instead. Both readings are taken and
        // logged so the owner can tell the two apart.
        const popoutSnapDuringFocus = mainSnap1.find((w) => w?.id === popoutWinId) ?? null;
        console.log(`${POP} popout DURING main-window focus: bounds=${JSON.stringify(popoutSnapDuringFocus?.bounds ?? null)} isFocused=${popoutSnapDuringFocus?.isFocused ?? '?'} minimized=${popoutSnapDuringFocus?.isMinimized ?? '?'}`);

        // ---- 6. Return to the popout (writer clicks back in), read the size ---
        // Mirrors the V3 axis: no programmatic re-focus in click-only cells.
        await browser.switchToWindow(popoutHandle!);
        let popoutFocusBack: boolean | null = null;
        if (FOCUS === 'click+focus') {
            popoutFocusBack = await focusElectronWindow(popoutWinId);
        }
        await browser.pause(1_500);
        const afterSwitch = await readCurrentWindow();
        const mainSnap2 = (await snapshotAllWindows()).find((w) => w?.id === mainWinId) ?? null;
        console.log(`${POP} popout after focus round-trip: isFocused=${popoutFocusBack} renderer=${afterSwitch.innerWidth}x${afterSwitch.innerHeight} electron-bounds=${JSON.stringify(afterSwitch.electron?.bounds ?? null)}`);
        console.log(`${POP} main window at the same moment: bounds=${JSON.stringify(mainSnap2?.bounds ?? null)} isFocused=${mainSnap2?.isFocused ?? '?'}`);
        if (SPLIT && afterSwitch.electron?.bounds && mainSnap2?.bounds) {
            console.log(`${POP} after re-activation: overlap=${overlapRect(afterSwitch.electron.bounds, mainSnap2.bounds)} popoutInner=${afterSwitch.innerWidth}x${afterSwitch.innerHeight}`);
        }

        // ---- 7. The observation (data, NOT a gate) -----------------------------
        const b = (w: ElectronWinInfo): string => (w ? `${w.bounds.width}x${w.bounds.height}` : 'unavailable');
        const snapBefore = resized.electron!;
        const persisted = snapBefore.bounds.width === afterSwitch.electron!.bounds.width
            && snapBefore.bounds.height === afterSwitch.electron!.bounds.height;
        const focusReallySwitched = popoutSnapDuringFocus?.isFocused === false;
        console.log(`${POP} ==========================================================`);
        console.log(`${POP} RESULT cell: ${CELL}`);
        console.log(`${POP} RESULT display: screen=${beforeResize.screen.width}x${beforeResize.screen.height} avail=${beforeResize.screen.availWidth}x${beforeResize.screen.availHeight} — resize target ${POPOUT_SIZE.width}x${POPOUT_SIZE.height} ${targetFitsDisplay ? 'FITS' : 'EXCEEDS'} the display`);
        console.log(`${POP} RESULT popout size before focus switch: ${b(snapBefore)}`);
        console.log(`${POP} RESULT popout size at moment of main-window focus: ${b(popoutSnapDuringFocus)} (popout isFocused=${popoutSnapDuringFocus?.isFocused ?? '?'})`);
        console.log(`${POP} RESULT popout size after  focus round-trip: ${b(afterSwitch.electron)}`);
        console.log(`${POP} RESULT popout size ${persisted ? 'PERSISTED' : 'CHANGED'} across main-window focus round-trip`);
        console.log(`${POP} RESULT focus switch was ${focusReallySwitched ? 'REAL (popout lost focus while main held it)' : 'NOT fully real at the WM level (popout isFocused stayed ' + String(popoutSnapDuringFocus?.isFocused) + ') — interpret persistence data with that caveat'}`);
        // Self-check against a bounds-READ illusion: the renderer metrics below
        // come from the popout's own `window.innerWidth/innerHeight` +
        // `outerWidth/outerHeight` — an independent source from the Electron
        // `getBounds()` numbers above. If the reset is real, it shows in BOTH.
        console.log(`${POP} RESULT (renderer inner: ${resized.innerWidth}x${resized.innerHeight} pre-focus → ${afterSwitch.innerWidth}x${afterSwitch.innerHeight} post-focus; outer: ${resized.outerWidth}x${resized.outerHeight} pre → ${afterSwitch.outerWidth}x${afterSwitch.outerHeight} post)`);
        console.log(`${POP} ==========================================================`);
    });
});
