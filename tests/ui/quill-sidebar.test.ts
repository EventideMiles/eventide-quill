// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Component, Menu, WorkspaceLeaf } from 'obsidian';
import { QuillSidebarView, loreSubTabBarMode } from '../../src/ui/quill-sidebar';
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
