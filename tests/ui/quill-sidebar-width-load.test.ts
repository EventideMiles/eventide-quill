// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { describe, expect, it } from 'vitest';
import { App, WorkspaceLeaf } from 'obsidian';
import { QuillSidebarView } from '../../src/ui/quill-sidebar';
import { sidebarWidthState } from '../../src/ui/sidebar-width';
import type EventideQuillPlugin from '../../src/main';

/**
 * `loadSidebarWidth` mid-await precedence tests. These live in their own file
 * because the module-level pending scheduled width that the load prefers is
 * module state with no reset path — once armed it stays armed for the rest of
 * the file, and `tests/ui/quill-sidebar.test.ts` already leaves it armed. A
 * regression test for the mid-await race (a scheduling arming while the
 * adapter round trip is pending) needs the entry-time "nothing scheduled"
 * state, which vitest's per-file module isolation provides here.
 */

/** Build a minimal `EventideQuillPlugin` stub for sidebar construction. */
function makePlugin(): EventideQuillPlugin {
    return {
        app: new App(),
        settings: { defaultTab: 'linter' } as unknown as EventideQuillPlugin['settings'],
        pluginDataDir: '.plugins/eventide-quill'
    } as unknown as EventideQuillPlugin;
}

/** Build a leaf bound to the given app, mirroring a rebuilt sidebar leaf. */
function makeLeaf(app: App): WorkspaceLeaf {
    return new (WorkspaceLeaf as unknown as new (app?: unknown) => object)(app) as unknown as WorkspaceLeaf;
}

/** Invoke the view's private loadSidebarWidth (tests reach internals pragmatically). */
function loadWidth(view: QuillSidebarView): Promise<number | null> {
    return (view as unknown as { loadSidebarWidth(): Promise<number | null> }).loadSidebarWidth();
}

/** Arm the view's debounced persist (tests reach internals pragmatically). */
function schedulePersist(view: QuillSidebarView): void {
    (view as unknown as { scheduleSidebarWidthPersist(): void }).scheduleSidebarWidthPersist();
}

/** Drain one macrotask so pending adapter continuations run deterministically. */
async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a manually-resolved promise gate (deferred) for stalling adapter awaits. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('sidebar width load mid-await precedence', () => {
    it('still resolves null from a missing sidecar when nothing was scheduled', async () => {
        // Behavior-preservation guard for the miss path AND a premise guard
        // for this file: if the module-level scheduled width were already
        // armed here, the entry check would return it without ever reaching
        // the adapter and the exists assertion below would fail.
        const adapter = {
            /** Number of exists probes (must be exactly one — the entry check fell through). */
            existsCalls: 0,
            /** The sidecar does not exist (fresh install). */
            async exists(): Promise<boolean> {
                this.existsCalls++;
                return false;
            }
        };
        const app = new App();
        (app.vault as unknown as { adapter: unknown }).adapter = adapter;
        const plugin = makePlugin();
        const view = new QuillSidebarView(makeLeaf(app), plugin);

        expect(await loadWidth(view)).toBeNull();
        expect(adapter.existsCalls).toBe(1);
    });

    it('prefers a width scheduled while the sidecar read was pending over the stale disk parse', async () => {
        // The mid-await race: instance B opens with NO pending scheduled
        // width (the entry check falls through to disk), and while B's
        // adapter round trip is in flight, instance A arms a debounced
        // persist. Disk holds a stale width; the intent armed mid-await is
        // newer and must win — otherwise B seeds the stale width and can
        // drive a bogus restore-on-open snap.
        const stalePayload = JSON.stringify(sidebarWidthState(200), null, 2);
        /** Whether B's read has entered its stall (premise: the round trip is mid-flight). */
        let readStarted = false;
        // Sidecar exists on disk with the stale 200; the read stalls
        // (macrotask gate) until the test has armed the newer intent.
        const readGate = deferred();
        const adapter = {
            async exists(): Promise<boolean> {
                return true;
            },
            async read(): Promise<string> {
                readStarted = true;
                await readGate.promise;
                return stalePayload;
            },
            async mkdir(): Promise<void> {},
            async write(): Promise<void> {}
        };

        // Production shape: ONE plugin and ONE vault adapter persist while
        // only the view instance (and its leaf) is rebuilt, so both views
        // share them.
        const app = new App();
        (app.vault as unknown as { adapter: unknown }).adapter = adapter;
        const plugin = makePlugin();
        const viewA = new QuillSidebarView(makeLeaf(app), plugin);
        (viewA as unknown as { widthKeeper: unknown }).widthKeeper = { rememberedWidth: 450 };
        const viewB = new QuillSidebarView(makeLeaf(app), plugin);

        // B's load starts with nothing scheduled; the read enters its stall.
        const loading = loadWidth(viewB);
        await tick();
        expect(readStarted).toBe(true);

        // Mid-stall, instance A arms a debounced persist — arming records
        // width 450 as the module-level pending intent.
        schedulePersist(viewA);

        // The stale disk value must lose to the mid-await intent.
        readGate.resolve();
        expect(await loading).toBe(450);

        // Hygiene: end A's armed debounce so no stray timer outlives the test.
        viewA.onunload();
    });
});
