// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Component, Menu, WorkspaceLeaf } from 'obsidian';
import { QuillSidebarView, loreSubTabBarMode } from '../../src/ui/quill-sidebar';
import { DRAG_STILL_MS, parseSidebarWidthState, sidebarWidthState, sidedockHasKeyboardFocus } from '../../src/ui/sidebar-width';
import type EventideQuillPlugin from '../../src/main';

/** Build a minimal `EventideQuillPlugin` stub for sidebar construction. */
function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: {
            defaultTab: 'dashboard',
            enableDashboard: true,
            writingDailyGoal: 0,
            lorebookFolders: []
        } as unknown as EventideQuillPlugin['settings'],
        currentDashboardMetrics: null,
        currentManuscriptFileData: null,
        currentDashboardSnapshots: null,
        currentManuscriptFolder: '',
        writingGoals: { version: 1, lastSeen: {}, todayDate: '', todayWords: 0, days: {}, bestStreak: 0, session: null },
        getDefaultChatProvider: () => ({ provider: null, modelId: '' }),
        getDefaultEmbedProvider: () => ({ provider: null, modelId: '' }),
        getDefaultImageProvider: () => ({ provider: null, modelId: '' }),
        batchFixInProgress: false,
        lintBatchChangeSet: { edits: [], pendingCount: 0, clear: () => {} },
        refreshDashboard: async () => {},
        getFeedbackJobs: () => [],
        refreshLorebookDocumentCoverage: async () => {},
        refreshLorebookManuscriptCoverage: vi.fn(async () => {}),
        refreshLorebookRelationships: () => {},
        coWriterSession: null,
        feedbackAbort: null,
        analysisAbort: null,
        feedbackQueueAbort: null,
        isGenerating: () => false,
        hasInFlightGeneration: () => false,
        currentLoreRelationships: null,
        currentManuscriptEntities: [],
        currentManuscriptText: '',
        lintState: null,
        linterSettings: null
    } as unknown as EventideQuillPlugin;
}

/** The five Lorebook sub-tab labels in bar order. */
const LORE_TAB_LABELS = ['Document', 'Manuscript', 'Relationships', 'Memories', 'Hygiene'];

/** Shape of the obsidian-mock Menu/MenuItem records this test asserts on (the real obsidian types don't expose them). */
interface CapturedMenuItem {
    title: string;
    checked: boolean;
    /** Invoke the recorded onClick handler (property signature — method signatures trip unbound-method on `?.()`). */
    triggerClick: (evt?: MouseEvent) => void;
}
/** Shape of the obsidian-mock Menu instance after `addItem` calls. */
interface CapturedMenu {
    items: CapturedMenuItem[];
}

/** Captured ResizeObserver callback from the last view construction (ui-setup stubs a no-op class — these tests swap in a recording one). */
let resizeCallback: ResizeObserverCallback | null = null;

/** Recording ResizeObserver double — captures the callback so tests can drive width changes. */
class RecordingResizeObserver {
    /** Store the callback for test invocation. */
    constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
    }
    /** No-op. */
    observe(): void {}
    /** No-op. */
    unobserve(): void {}
    /** No-op. */
    disconnect(): void {}
}

/** Build a view, open it, and return it alongside its leaf for DOM queries. */
async function makeOpenedView(plugin: EventideQuillPlugin): Promise<{ view: QuillSidebarView; leaf: WorkspaceLeaf }> {
    const leaf = (new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf;
    const view = new QuillSidebarView(leaf, plugin);
    await view.onOpen();
    return { view, leaf };
}

/** Click a top-level tab button by its aria-label. */
function clickTopTab(leaf: WorkspaceLeaf, label: string): void {
    const btn = (leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelector<HTMLElement>(
        `.quill-sidebar__tab[aria-label="${label}"]`
    );
    if (!btn) throw new Error(`top tab ${label} not found`);
    btn.dispatchEvent(new MouseEvent('click'));
}

/**
 * Click an element with a bubbling MouseEvent. The Lorebook sub-tab bar uses
 * one delegated listener on the bar element, so clicks dispatched on its
 * buttons must propagate to the bar (native user clicks and keyboard
 * Enter/Space activation bubble; a bare `new MouseEvent('click')` does not).
 */
function clickBubbling(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** All Lorebook sub-tab buttons currently in the bar (the More button excluded). */
function loreSubTabs(leaf: WorkspaceLeaf): HTMLElement[] {
    return Array.from(
        (leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelectorAll<HTMLElement>(
            '.quill-sidebar__subtab:not(.quill-sidebar__subtab--more)'
        )
    );
}

/** Fire the captured ResizeObserver callback with the given container width. */
function fireResize(width: number): void {
    if (!resizeCallback) throw new Error('no ResizeObserver callback captured');
    resizeCallback([{ contentRect: { width, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver);
}

/** The compact bar's More (⋯) button, or null when the bar is in full mode. */
function moreButton(leaf: WorkspaceLeaf): HTMLElement | null {
    return (leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelector<HTMLElement>(
        '.quill-sidebar__subtab--more'
    );
}

/** Grab the Nth Menu captured by a `showAtMouseEvent` spy, typed to the mock's recorded shape. */
function capturedMenu(spy: { mock: { instances: unknown[] } }, index: number): CapturedMenu {
    return spy.mock.instances[index] as CapturedMenu;
}

describe('loreSubTabBarMode', () => {
    it('is compact strictly below the 420px shared compact threshold', () => {
        expect(loreSubTabBarMode(0)).to.equal('compact');
        expect(loreSubTabBarMode(390)).to.equal('compact');
        expect(loreSubTabBarMode(419)).to.equal('compact');
        expect(loreSubTabBarMode(419.5)).to.equal('compact');
    });

    it('is full at and above the 420px shared compact threshold', () => {
        expect(loreSubTabBarMode(420)).to.equal('full');
        expect(loreSubTabBarMode(421)).to.equal('full');
        expect(loreSubTabBarMode(800)).to.equal('full');
    });
});

describe('QuillSidebarView', () => {
    beforeEach(() => {
        resizeCallback = null;
        // Replace ui-setup's no-op ResizeObserver with a recording double so
        // tests can drive width changes through the real observer callback.
        (globalThis as Record<string, unknown>).ResizeObserver = RecordingResizeObserver;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('constructs with the correct view type + display text', () => {
        const view = new QuillSidebarView((new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf, makePlugin());
        expect(view.getViewType()).to.include('quill');
        expect(view.getDisplayText()).to.equal('Quill');
    });

    it('defaults to the configured default tab', () => {
        const plugin = makePlugin();
        plugin.settings.defaultTab = 'dashboard';
        const view = new QuillSidebarView((new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf, plugin);
        expect(view.isDashboardActive()).to.equal(true);
    });

    it('renders the top tab bar with six tabs on open', async () => {
        const leaf = (new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf;
        const view = new QuillSidebarView(leaf, makePlugin());
        await view.onOpen();

        const tabLabels = Array.from((leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelectorAll('.quill-sidebar__tab'))
            .map((el: Element) => el.getAttribute('aria-label') ?? '');
        expect(tabLabels).to.include('Dashboard');
        expect(tabLabels).to.include('Linter');
        expect(tabLabels).to.include('Co-writer');
        expect(tabLabels).to.include('Review');
        expect(tabLabels).to.include('Context');
        expect(tabLabels).to.include('Lorebook');
    });

    it('renders all five lorebook sub-tabs in full mode', async () => {
        const { leaf } = await makeOpenedView(makePlugin());
        clickTopTab(leaf, 'Lorebook');

        const subtabs = loreSubTabs(leaf);
        expect(subtabs.map((el) => el.textContent)).to.deep.equal(LORE_TAB_LABELS);
        expect(subtabs[0]?.classList.contains('quill-sidebar__subtab--active')).to.equal(true);
        // No More button in full mode.
        expect((leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelector('.quill-sidebar__subtab--more')).to.equal(null);
    });

    it('switches to compact mode (active label + More) when a narrow width crosses the threshold', async () => {
        const { leaf } = await makeOpenedView(makePlugin());
        clickTopTab(leaf, 'Lorebook');
        expect(loreSubTabs(leaf)).to.have.length(5);

        // Drive the sidebar's real ResizeObserver callback with a 390px
        // container (mobile-emulation width) — the bar re-renders narrowly.
        fireResize(390);

        const subtabs = loreSubTabs(leaf);
        expect(subtabs).to.have.length(1);
        expect(subtabs[0]?.textContent).to.equal('Document');
        expect(subtabs[0]?.classList.contains('quill-sidebar__subtab--active')).to.equal(true);
        const moreBtn = (leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelector<HTMLElement>(
            '.quill-sidebar__subtab--more'
        );
        expect(moreBtn).to.not.equal(null);
        expect(moreBtn?.getAttribute('aria-label')).to.equal('More sub-tabs');
        // Bar carries the compact modifier.
        expect((leaf as unknown as { containerEl: HTMLElement }).containerEl.querySelector('.quill-sidebar__subtab-bar--compact')).to.not.equal(null);
    });

    it('switches back to full mode when the width crosses the threshold upward', async () => {
        const { leaf } = await makeOpenedView(makePlugin());
        clickTopTab(leaf, 'Lorebook');
        fireResize(390);
        expect(loreSubTabs(leaf)).to.have.length(1);

        fireResize(800);
        expect(loreSubTabs(leaf).map((el) => el.textContent)).to.deep.equal(LORE_TAB_LABELS);
    });

    it('keeps the width state across tab switches (compact stays compact after leaving and returning)', async () => {
        const { leaf } = await makeOpenedView(makePlugin());
        fireResize(390);
        clickTopTab(leaf, 'Lorebook');
        // No resize fired while on the lorebook tab — the bar must still open compact.
        expect(loreSubTabs(leaf)).to.have.length(1);
    });

    it('marks the active sub-tab in the More menu and switches sub-tabs from it', async () => {
        const plugin = makePlugin();
        const refreshManuscript = vi.fn(async () => {});
        (plugin as unknown as Record<string, unknown>).refreshLorebookManuscriptCoverage = refreshManuscript;
        const { leaf } = await makeOpenedView(plugin);
        clickTopTab(leaf, 'Lorebook');
        fireResize(390);

        const openSpy = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(() => ({} as Menu));
        clickBubbling(moreButton(leaf)!);
        expect(openSpy).toHaveBeenCalledTimes(1);

        const menu = capturedMenu(openSpy, 0);
        expect(menu.items.map((i) => i.title)).to.deep.equal(LORE_TAB_LABELS);
        // Only the active sub-tab (Document, the default) is check-marked.
        expect(menu.items.map((i) => i.checked)).to.deep.equal([true, false, false, false, false]);

        // Select Manuscript from the menu — state switches, the bar re-renders
        // compact with the new active label, and the coverage refresh fires.
        menu.items[1]?.triggerClick();
        const subtabs = loreSubTabs(leaf);
        expect(subtabs).to.have.length(1);
        expect(subtabs[0]?.textContent).to.equal('Manuscript');
        expect(subtabs[0]?.classList.contains('quill-sidebar__subtab--active')).to.equal(true);
        expect(refreshManuscript).toHaveBeenCalledWith(true);
    });

    it('re-opens the More menu with the new active sub-tab check-marked after a switch', async () => {
        const { leaf } = await makeOpenedView(makePlugin());
        clickTopTab(leaf, 'Lorebook');
        fireResize(390);

        const openSpy = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(() => ({} as Menu));
        clickBubbling(moreButton(leaf)!);
        const menu = capturedMenu(openSpy, 0);
        menu.items[4]?.triggerClick(); // Hygiene

        // The bar re-rendered — grab the fresh More button and open again.
        clickBubbling(moreButton(leaf)!);
        const menu2 = capturedMenu(openSpy, 1);
        expect(menu2.items.map((i) => i.checked)).to.deep.equal([false, false, false, false, true]);
    });

    it('switches sub-tabs from a full-mode button click via the delegated bar listener', async () => {
        const plugin = makePlugin();
        const refreshManuscript = vi.fn(async () => {});
        (plugin as unknown as Record<string, unknown>).refreshLorebookManuscriptCoverage = refreshManuscript;
        const { leaf } = await makeOpenedView(plugin);
        clickTopTab(leaf, 'Lorebook');

        // Click the Manuscript sub-tab button — the listener lives on the bar,
        // so the click must bubble from the button to the bar to be handled.
        const btn = loreSubTabs(leaf).find((el) => el.textContent === 'Manuscript');
        expect(btn).to.not.equal(undefined);
        clickBubbling(btn!);

        const subtabs = loreSubTabs(leaf);
        expect(subtabs.map((el) => el.textContent)).to.deep.equal(LORE_TAB_LABELS);
        expect(subtabs[1]?.classList.contains('quill-sidebar__subtab--active')).to.equal(true);
        expect(subtabs[0]?.classList.contains('quill-sidebar__subtab--active')).to.equal(false);
        expect(refreshManuscript).toHaveBeenCalledWith(true);
    });

    it('registers no new bar listeners across repeated width crossings (delegated listener only)', async () => {
        // Regression guard for the per-button registerDomEvent leak: each bar
        // repopulation used to re-register listeners on renderEvents for
        // freshly-detached buttons, so dragging the divider back and forth
        // across the 420px threshold accumulated dead registrations. The
        // delegated design registers exactly ONE listener when the bar element
        // is created (render(), which also swaps renderEvents) and nothing on
        // repopulation. The count is observable — the obsidian mock's
        // registerDomEvent is a prototype method, spied per call — so no
        // behavioral-only fallback is needed.
        const { leaf } = await makeOpenedView(makePlugin());

        const regSpy = vi.spyOn(Component.prototype, 'registerDomEvent');
        /** Count registerDomEvent calls whose target element is the Lorebook sub-tab bar. */
        const barRegistrations = (): number =>
            regSpy.mock.calls.filter((args) => {
                const el = args[0] as { classList?: { contains(cls: string): boolean } } | undefined;
                return !!el?.classList && el.classList.contains('quill-sidebar__subtab-bar');
            }).length;

        // Entering the Lorebook tab creates the bar → exactly one delegated registration.
        clickTopTab(leaf, 'Lorebook');
        expect(barRegistrations()).to.equal(1);

        // Five alternating crossings across the 420px threshold (divider drag):
        // zero new registrations for the bar across all of them.
        for (const width of [390, 800, 390, 800, 390]) {
            fireResize(width);
        }
        expect(barRegistrations()).to.equal(1);

        // The bar still works after the crossings: currently compact (390) —
        // the More menu opens through the same delegated listener and switches.
        const openSpy = vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(() => ({} as Menu));
        clickBubbling(moreButton(leaf)!);
        expect(openSpy).toHaveBeenCalledTimes(1);
        capturedMenu(openSpy, 0).items[1]?.triggerClick(); // Manuscript
        expect(loreSubTabs(leaf)[0]?.textContent).to.equal('Manuscript');

        // And full mode still switches via delegation after crossing back up.
        fireResize(800);
        const btn = loreSubTabs(leaf).find((el) => el.textContent === 'Hygiene');
        clickBubbling(btn!);
        expect(loreSubTabs(leaf)[4]?.classList.contains('quill-sidebar__subtab--active')).to.equal(true);
    });
});

/**
 * Recording ResizeObserver double for the width-keeper wiring tests: captures
 * EVERY constructed observer's callback (the view builds two — the
 * responsive-mode observer synchronously in onOpen, then the width keeper's
 * after the async sidecar read resolves), so a test can drive the width
 * observer by construction order. The width observer is always last.
 */
class CapturingResizeObserver {
    /** Callbacks from every constructed observer, in construction order. */
    static callbacks: ResizeObserverCallback[] = [];

    /** Record the callback. */
    constructor(cb: ResizeObserverCallback) {
        CapturingResizeObserver.callbacks.push(cb);
    }

    /** No-op. */
    observe(): void {}

    /** No-op. */
    unobserve(): void {}

    /** No-op. */
    disconnect(): void {}
}

describe('sidebar width keeper drag hint (final-sample race)', () => {
    /** Epoch base for the fake clock: the keeper baselines its sample stream at open. */
    const T0 = 1_000_000;
    /** The ResizeObserver global before the capturing double was installed. */
    let originalResizeObserver: unknown;
    /** The still-open view, unloaded in afterEach so keeper teardown runs. */
    let openView: QuillSidebarView | null = null;

    /** The mounted keeper-view fixture returned by {@link makeKeeperView}. */
    interface KeeperViewFixture {
        view: QuillSidebarView;
        sidedock: HTMLElement;
        width: { value: number };
    }

    /**
     * Mount the real sidebar view inside a fabricated right-sidedock whose
     * measured width is stubbed and mutable via the returned cell.
     */
    async function makeKeeperView(): Promise<KeeperViewFixture> {
        const width = { value: 450 };
        const sidedock = createDiv();
        sidedock.className = 'workspace-split mod-right-split';
        document.body.appendChild(sidedock);
        const leaf = (new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf;
        sidedock.appendChild((leaf as unknown as { containerEl: HTMLElement }).containerEl);
        // Production reads the width via getBoundingClientRect (forces layout); the stub IS the layout here.
        sidedock.getBoundingClientRect = () => ({ width: width.value, left: 800 } as DOMRect);
        const plugin = makePlugin();
        Object.assign(plugin, { pluginDataDir: '.plugins/eventide-quill' });
        const view = new QuillSidebarView(leaf, plugin);
        await view.onOpen();
        // Flush the fire-and-forget sidecar read so initSidebarWidthState finishes:
        // the keeper baselines at the current width and the width observer attaches.
        await new Promise((resolve) => setTimeout(resolve, 0));
        openView = view;
        return { view, sidedock, width };
    }

    /** The width-keeper observer callback — the LAST observer the view constructed. */
    function widthSampleCallback(): ResizeObserverCallback {
        const callbacks = CapturingResizeObserver.callbacks;
        const cb = callbacks[callbacks.length - 1];
        if (!cb) throw new Error('width ResizeObserver callback not captured');
        return cb;
    }

    /** The view's width keeper read through the private field (tests reach internals pragmatically). */
    function widthKeeperOf(view: QuillSidebarView): { rememberedWidth: number | null } | null {
        return (view as unknown as { widthKeeper: { rememberedWidth: number | null } | null }).widthKeeper;
    }

    beforeEach(() => {
        CapturingResizeObserver.callbacks = [];
        originalResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
        (globalThis as Record<string, unknown>).ResizeObserver = CapturingResizeObserver;
        // Fake ONLY the wall clock: the keeper's stillness/expiry math is all
        // Date.now, while vitest timers stay real so the setTimeout(0) flush
        // in makeKeeperView still works (the conversation-store suite fakes
        // the same way).
        vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        (globalThis as Record<string, unknown>).ResizeObserver = originalResizeObserver;
        openView?.onunload();
        openView = null;
        document.body.innerHTML = '';
    });

    it('samples the settled width at pointerup so the late ResizeObserver delivery cannot restore', async () => {
        const { view, sidedock, width } = await makeKeeperView();

        // The writer pauses: fill the stillness clock past DRAG_STILL_MS. A
        // post-release sample of the flick below would then — without the
        // pointerup adoption — see a large drop + stillness + no drag hint and
        // classify it as an un-commanded reset.
        vi.setSystemTime(T0 + DRAG_STILL_MS + 500);

        // Grab the divider: a resize-classed handle inside the dock arms the
        // hint. Real pointerdowns bubble, and the obsidian test mock registers
        // listeners without the capture flag, so dispatch a bubbling event.
        const handle = createDiv();
        handle.className = 'workspace-leaf-resize-handle';
        sidedock.appendChild(handle);
        handle.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        // The flick: the final width lands in the DOM, but its ResizeObserver
        // delivery is still batched — nothing has sampled 300 yet.
        width.value = 300;

        // Release: the clear handler must sample the settled width while the
        // hint is still armed — adopting 300 and re-baselining the stream —
        // before nulling the hint.
        window.dispatchEvent(new Event('pointerup'));

        // The hint is cleared and the final width was adopted.
        expect((view as unknown as { sidebarPointerDownAtMs: number | null }).sidebarPointerDownAtMs).toBeNull();
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(300);

        // The late delivery of the batched final observation now reads stable
        // and no-ops: no restore was ever applied to the DOM, and the adopted
        // width survives.
        widthSampleCallback()([], {} as ResizeObserver);
        expect(sidedock.style.width).toBe('');
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(300);
    });

    it('keeps the release handler cheap when no drag is armed', async () => {
        const { view } = await makeKeeperView();
        const sampleSpy = vi.spyOn(view as unknown as { sampleSidedockWidth: () => void }, 'sampleSidedockWidth');
        // Every window pointerup hits the handler; with no armed hint it must
        // bail on the null check without forcing a layout-reading width sample.
        window.dispatchEvent(new Event('pointerup'));
        expect(sampleSpy).not.toHaveBeenCalled();
    });
});

/**
 * Regression for the PR #68 round-8 interaction: desktop
 * `revealQuillSidebar()` calls `workspace.setActiveLeaf(quillLeaf,
 * { focus: false })` after Discuss flows load a report, which moves the
 * document-wide `.workspace-leaf.mod-active` class to the Quill leaf's
 * container WITHOUT moving keyboard focus (focus only gates `focusLeaf`).
 * The reset guard used the active leaf as its "the writer owns the width"
 * proxy, so in exactly that post-Discuss state a qualifying un-commanded
 * width drop (the #67 symptom itself) classified as a drag and was adopted
 * — the keeper's core protection was disabled. The guard must follow actual
 * keyboard focus (`sidedockHasKeyboardFocus`); the divider-drag guard stays
 * a separate arm of the conjunction.
 */
describe('sidebar width keeper reset guard (keyboard focus, not active leaf)', () => {
    /** Epoch base for the fake clock: the keeper baselines its sample stream at open. */
    const T0 = 1_000_000;
    /** The ResizeObserver global before the capturing double was installed. */
    let originalResizeObserver: unknown;
    /** The still-open view, unloaded in afterEach so keeper teardown runs. */
    let openView: QuillSidebarView | null = null;

    /** The mounted fixture returned by {@link makePostDiscussView}. */
    interface PostDiscussFixture {
        view: QuillSidebarView;
        sidedock: HTMLElement;
        width: { value: number };
    }

    /**
     * Mount the real sidebar view inside a fabricated right-sidedock whose
     * measured width is stubbed and mutable, carrying the post-round-8 DOM
     * state: the Quill leaf inside the dock is marked `.mod-active` while
     * keyboard focus sits OUTSIDE the sidedock (in the editor). The sidecar
     * load is stubbed to null so the keeper deterministically adopts the
     * fixture's 450px width at open.
     */
    async function makePostDiscussView(): Promise<PostDiscussFixture> {
        // Window-focus pin: happy-dom derives hasFocus() from activeElement
        // and defaults to true (the body fallback), so this fixture's premise
        // — a FOCUSED window with keyboard focus in the editor, outside the
        // dock — is inherited truthfully, but pin it so a happy-dom behavior
        // change cannot silently flip the fixtures' meaning. The blurred
        // regression below re-stubs to false.
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const width = { value: 450 };
        const sidedock = createDiv();
        sidedock.className = 'workspace-split mod-right-split';
        document.body.appendChild(sidedock);
        const leaf = (new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(new App())) as unknown as WorkspaceLeaf;
        const leafContainer = (leaf as unknown as { containerEl: HTMLElement }).containerEl;
        // Round-8 interaction: setActiveLeaf(leaf, { focus: false }) marks the
        // Quill leaf's container `workspace-leaf mod-active` without moving
        // focus into it.
        leafContainer.classList.add('workspace-leaf', 'mod-active');
        sidedock.appendChild(leafContainer);
        // Keyboard focus stays in the editor, outside the sidedock.
        const editor = createDiv();
        document.body.appendChild(editor);
        editor.focus();
        // Production reads the width via getBoundingClientRect (forces layout); the stub IS the layout here.
        sidedock.getBoundingClientRect = () => ({ width: width.value, left: 800 } as DOMRect);
        const plugin = makePlugin();
        Object.assign(plugin, { pluginDataDir: '.plugins/eventide-quill' });
        const view = new QuillSidebarView(leaf, plugin);
        // Deterministic seed: ignore sidecar/scheduled state — the keeper
        // adopts the fixture's 450px width at open.
        vi.spyOn(view as unknown as { loadSidebarWidth(): Promise<number | null> }, 'loadSidebarWidth').mockResolvedValue(null);
        await view.onOpen();
        // Flush the fire-and-forget sidecar read so initSidebarWidthState
        // finishes: the keeper baselines at the current width and the width
        // observer attaches.
        await new Promise((resolve) => setTimeout(resolve, 0));
        openView = view;
        return { view, sidedock, width };
    }

    /** The width-keeper observer callback — the LAST observer the view constructed. */
    function widthSampleCallback(): ResizeObserverCallback {
        const callbacks = CapturingResizeObserver.callbacks;
        const cb = callbacks[callbacks.length - 1];
        if (!cb) throw new Error('width ResizeObserver callback not captured');
        return cb;
    }

    /** The view's width keeper read through the private field (tests reach internals pragmatically). */
    function widthKeeperOf(view: QuillSidebarView): { rememberedWidth: number | null } | null {
        return (view as unknown as { widthKeeper: { rememberedWidth: number | null } | null }).widthKeeper;
    }

    beforeEach(() => {
        CapturingResizeObserver.callbacks = [];
        originalResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
        (globalThis as Record<string, unknown>).ResizeObserver = CapturingResizeObserver;
        vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        (globalThis as Record<string, unknown>).ResizeObserver = originalResizeObserver;
        openView?.onunload();
        openView = null;
        document.body.innerHTML = '';
    });

    it('classifies a large drop as an un-commanded reset even though the dock carries mod-active', async () => {
        const { view, sidedock, width } = await makePostDiscussView();
        // Open adopted the fixture width as the remembered one.
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(450);

        // The writer pauses: fill the stillness clock past DRAG_STILL_MS so a
        // large single-step drop qualifies as a reset candidate.
        vi.setSystemTime(T0 + DRAG_STILL_MS + 500);

        // The #67 symptom itself: a >=50px single-step drop, no drag armed.
        width.value = 320;
        widthSampleCallback()([], {} as ResizeObserver);

        // RESET, not adopt: the remembered width is restored to the DOM and
        // kept — the mod-active class must not suppress reset handling.
        expect(sidedock.style.width).toBe('450px');
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(450);
    });

    it('still adopts a large drop as a drag when keyboard focus IS inside the sidedock', async () => {
        const { view, sidedock, width } = await makePostDiscussView();

        // The writer pauses past the stillness threshold, then clicks into
        // the sidebar: keyboard focus moves inside the dock.
        vi.setSystemTime(T0 + DRAG_STILL_MS + 500);
        const quillLeaf = sidedock.querySelector('.mod-active');
        expect(quillLeaf).not.toBeNull();
        (quillLeaf as HTMLElement).focus();

        // The same large single-step drop now counts as legitimate intent.
        width.value = 320;
        widthSampleCallback()([], {} as ResizeObserver);

        // Adopted as drag: no restore, the new width is remembered.
        expect(sidedock.style.width).toBe('');
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(320);
    });

    it('restores a large drop when focus is retained in-dock while the window is blurred', async () => {
        const { view, sidedock, width } = await makePostDiscussView();

        // The writer clicks into the sidebar past the stillness threshold:
        // with the window still focused this MUST read as focused-in-dock —
        // proving the blur below is the only discriminator.
        vi.setSystemTime(T0 + DRAG_STILL_MS + 500);
        const quillLeaf = sidedock.querySelector('.mod-active');
        expect(quillLeaf).not.toBeNull();
        (quillLeaf as HTMLElement).focus();
        expect(sidedockHasKeyboardFocus(sidedock)).toBe(true);

        // Then the window loses OS focus (the writer works in an Obsidian
        // popout or another app): `activeElement` is RETAINED in-dock, but
        // the window-focus gate must keep the dock out of "the writer owns
        // the width" — the >=50px single-step drop after stillness
        // classifies as an un-commanded reset and RESTORES. Adopting here
        // (drag) is exactly the round-10 bug.
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        // Retention premise pinned, not implicit: activeElement is still the
        // in-dock leaf despite the blur.
        expect(document.activeElement).toBe(quillLeaf);
        width.value = 320;
        widthSampleCallback()([], {} as ResizeObserver);

        expect(sidedock.style.width).toBe('450px');
        expect(widthKeeperOf(view)?.rememberedWidth).toBe(450);
    });
});

/**
 * Cross-instance serialization tests for the sidebar-width sidecar write
 * chain. The sidecar is one plugin-data file, but each QuillSidebarView
 * instance carries its own debounce/flush path — so an unloading instance's
 * flush must never land its write after a newer instance's save and clobber
 * the sidecar with a stale width (last-writer-wins across instances).
 */
describe('sidebar width sidecar write chain (cross-instance ordering)', () => {
    /** Shape of the recording adapter this suite installs as the shared vault adapter. */
    interface DelayedAdapter {
        /** Payloads handed to write, in completion order (= what the disk ends up holding). */
        writes: string[];
        /** Whether the path exists (always false — every save takes the mkdir branch). */
        exists(path: string): Promise<boolean>;
        /** Create the directory (no-op). */
        mkdir(path: string): Promise<void>;
        /** Read the sidecar (the last completed write, or empty). */
        read(path: string): Promise<string>;
        /** Write the sidecar (records the payload; delayed payloads stall first). */
        write(path: string, data: string): Promise<void>;
    }

    /**
     * Build a recording adapter whose write for `delayedPayload` stalls for
     * `delayTicks` macrotasks first — the controllable delay that models the
     * older instance's write still being in flight while the newer instance's
     * save is enqueued.
     */
    function makeDelayedAdapter(delayedPayload: string, delayTicks: number): DelayedAdapter {
        const writes: string[] = [];
        return {
            writes,
            async exists(_path: string): Promise<boolean> {
                return false;
            },
            async mkdir(_path: string): Promise<void> {},
            async read(_path: string): Promise<string> {
                return writes[writes.length - 1] ?? '';
            },
            async write(_path: string, data: string): Promise<void> {
                if (data.includes(delayedPayload)) {
                    for (let i = 0; i < delayTicks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
                }
                writes.push(data);
            }
        };
    }

    /** Invoke the view's private saveSidebarWidth (tests reach internals pragmatically). */
    function saveWidth(view: QuillSidebarView, width: number): Promise<void> {
        return (view as unknown as { saveSidebarWidth(width: number): Promise<void> }).saveSidebarWidth(width);
    }

    /** Arm the view's debounced persist (tests reach internals pragmatically). */
    function schedulePersist(view: QuillSidebarView): void {
        (view as unknown as { scheduleSidebarWidthPersist(): void }).scheduleSidebarWidthPersist();
    }

    /** Drain macrotasks so the chained adapter work (microtasks between ticks) settles deterministically. */
    async function flushMacrotasks(times: number): Promise<void> {
        for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('lands saves in enqueue order so an unload flush cannot clobber a newer save', async () => {
        // Instance A's write stalls for several macrotasks — long enough that,
        // without cross-instance serialization, instance B's write completes
        // (and would be clobbered) before A's resolves.
        const adapter = makeDelayedAdapter('"width": 300', 3);

        // Production shape: ONE plugin and ONE vault adapter persist while only
        // the view instance (and its leaf) is rebuilt, so both views share them.
        const app = new App();
        (app.vault as unknown as { adapter: unknown }).adapter = adapter;
        const plugin = makePlugin();
        Object.assign(plugin, { pluginDataDir: '.plugins/eventide-quill' });
        /** Build a leaf bound to the shared app, mirroring a rebuilt sidebar leaf. */
        const makeLeaf = () =>
            new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(app) as unknown as WorkspaceLeaf;

        // Neither view is opened: the chain lives inside saveSidebarWidth, and
        // the constructor alone binds each view to the shared app/adapter.
        const viewA = new QuillSidebarView(makeLeaf(), plugin);
        const viewB = new QuillSidebarView(makeLeaf(), plugin);

        // The stale instance (A) issues what would be its unload-flush save;
        // its write hangs in the adapter. The newer instance (B) saves the
        // current width while A's write is still in flight.
        const savingA = saveWidth(viewA, 300);
        const savingB = saveWidth(viewB, 450);

        await flushMacrotasks(6);
        await Promise.all([savingA, savingB]);
        await flushMacrotasks(2);

        // Completion order IS disk order: the stale write landed first and the
        // newer save last — the sidecar's final content is B's width.
        expect(adapter.writes.map((data) => parseSidebarWidthState(data))).toEqual([300, 450]);
    });

    it("an older instance's onunload flush cannot overwrite a newer save", async () => {
        // B's write stalls mid-flight so A's unload flush is enqueued while
        // the newer save is still being written — FIFO serialization alone
        // preserves order, not freshness, and would land A's stale width last.
        const adapter = makeDelayedAdapter('"width": 450', 3);

        // Production shape: ONE plugin and ONE vault adapter persist while
        // only the view instance (and its leaf) is rebuilt, so all views
        // share them.
        const app = new App();
        (app.vault as unknown as { adapter: unknown }).adapter = adapter;
        const plugin = makePlugin();
        Object.assign(plugin, { pluginDataDir: '.plugins/eventide-quill' });
        /** Build a leaf bound to the shared app, mirroring a rebuilt sidebar leaf. */
        const makeLeaf = () =>
            new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(app) as unknown as WorkspaceLeaf;

        // Neither view is opened (the chain lives in the save path); each
        // keeper is stubbed to the width its instance would hold.
        const viewA = new QuillSidebarView(makeLeaf(), plugin);
        const viewB = new QuillSidebarView(makeLeaf(), plugin);
        (viewA as unknown as { widthKeeper: unknown }).widthKeeper = { rememberedWidth: 300 };
        (viewB as unknown as { widthKeeper: unknown }).widthKeeper = { rememberedWidth: 450 };

        // The older instance arms a debounced save (minting its schedule-time
        // revision); the newer instance arms one too, then unloads BEFORE its
        // debounce fires — its teardown flush enqueues the newer write now.
        schedulePersist(viewA);
        schedulePersist(viewB);
        viewB.onunload();
        // Let B's flush enter its adapter stall, THEN unload A: the stale
        // flush is enqueued behind an in-flight newer write.
        await flushMacrotasks(1);
        viewA.onunload();
        await flushMacrotasks(8);

        // The schedule-time revision gate skips A's stale flush: only the
        // newer width reaches disk — not [450, 300] as order-only
        // serialization would land.
        expect(adapter.writes.map((data) => parseSidebarWidthState(data))).toEqual([450]);
    });

    it('seeds a newly opened instance from the pending scheduled width before the debounced write lands', async () => {
        // The read-side twin of the write races above: a rebuilt sidebar view
        // can open while the previous instance's last save is STILL IN FLIGHT
        // (pending debounce, or its unload flush stuck behind a slow write).
        // Reading only the sidecar then seeds the new keeper from a stale
        // width — which can drive a visible restore-on-open snap and becomes
        // the new baseline. Arming a schedule records the width in module
        // state, and the load must prefer it over stale disk.
        const stalePayload = JSON.stringify(sidebarWidthState(200), null, 2);
        const writes: string[] = [];
        // Sidecar already on disk from a prior session (stale 200); the
        // flush's write (300) stalls for several macrotasks first.
        const adapter = {
            async exists(): Promise<boolean> {
                return true;
            },
            async mkdir(): Promise<void> {},
            async read(): Promise<string> {
                return writes[writes.length - 1] ?? stalePayload;
            },
            async write(_path: string, data: string): Promise<void> {
                if (data.includes('"width": 300')) {
                    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
                }
                writes.push(data);
            }
        };

        // Production shape: ONE plugin and ONE vault adapter persist while
        // only the view instance (and its leaf) is rebuilt, so both views
        // share them.
        const app = new App();
        (app.vault as unknown as { adapter: unknown }).adapter = adapter;
        const plugin = makePlugin();
        Object.assign(plugin, { pluginDataDir: '.plugins/eventide-quill' });
        /** Build a leaf bound to the shared app, mirroring a rebuilt sidebar leaf. */
        const makeLeaf = () =>
            new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(app) as unknown as WorkspaceLeaf;

        // Instance A schedules width 300 — arming records the pending intent.
        // The debounce never fires: A unloads first, and its flush write is
        // deliberately stalled in the adapter below.
        const viewA = new QuillSidebarView(makeLeaf(), plugin);
        (viewA as unknown as { widthKeeper: unknown }).widthKeeper = { rememberedWidth: 300 };
        schedulePersist(viewA);
        viewA.onunload();

        // Instance B opens while A's flush is still mid-chain: the disk read
        // would return the stale 200 — the pending intent (300) must win.
        const viewB = new QuillSidebarView(makeLeaf(), plugin);
        /** Invoke the view's private loadSidebarWidth (tests reach internals pragmatically). */
        const loadWidth = (view: QuillSidebarView): Promise<number | null> =>
            (view as unknown as { loadSidebarWidth(): Promise<number | null> }).loadSidebarWidth();
        expect(await loadWidth(viewB)).toBe(300);
        // Prove the flush really was still in flight when B loaded.
        expect(writes).toEqual([]);

        // Once the flush lands, disk and the pending intent agree — a later
        // load resolves the same width through either source.
        await flushMacrotasks(6);
        expect(writes.map((data) => parseSidebarWidthState(data))).toEqual([300]);
        expect(await loadWidth(viewB)).toBe(300);
    });
});
