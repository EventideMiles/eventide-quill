// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import { Component, Modal, TFile, type Vault } from 'obsidian';
import { renderLoreHygieneTab } from '../../src/ui/lore-hygiene-panel';
import { inspectAttachmentMetadata } from '../../src/utils/attachment-metadata';
import { makeMemoryVault } from '../helpers/memory-vault';
import type EventideQuillPlugin from '../../src/main';

// The stub Modal.open() is a no-op, so ConfirmModal never renders its buttons
// in tests unless we intercept. Same spy pattern as settings-restore-defaults:
// render each opened modal's DOM and record the instance for clicking.
let modals: Modal[] = [];
/** Restore the pristine stub Modal.open() after a test has captured modals. */
let restoreOpen: () => void;

beforeEach(() => {
    modals = [];
    const spy = vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
        modals.push(this);
        void this.onOpen();
    });
    restoreOpen = (): void => spy.mockRestore();
});

afterEach(() => {
    restoreOpen();
});

// ── Minimal PNG fixture builder (bytes synthesized — see attachment-metadata.test.ts for the full suite) ──

/** CRC-32 table for valid PNG chunk framing. */
const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 of a byte range. */
function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Build a complete PNG from chunk specs (signature + IHDR + given chunks + IEND). */
function buildPng(chunks: Array<{ type: string; data: number[] }>): Uint8Array {
    const all: Array<{ type: string; data: number[] }> = [
        { type: 'IHDR', data: [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0] },
        ...chunks,
        { type: 'IEND', data: [] }
    ];
    const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    for (const chunk of all) {
        const out = new Uint8Array(12 + chunk.data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, chunk.data.length, false);
        for (let i = 0; i < 4; i++) out[4 + i] = chunk.type.charCodeAt(i);
        chunk.data.forEach((b, i) => (out[8 + i] = b));
        view.setUint32(8 + chunk.data.length, crc32(out.subarray(4, 8 + chunk.data.length)), false);
        parts.push(out);
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
    }
    return merged;
}

// ── Fixtures: vault + plugin ─────────────────────────────────────────────────

interface FileSpec {
    path: string;
    /** Declared stat.size (defaults to the seeded byte length). */
    size?: number;
}

/** Build a memory vault seeded with binary attachments + matching TFile entries. */
function makeVault(
    binaries: Record<string, Uint8Array>,
    files: FileSpec[]
): { vault: Vault; store: Map<string, ArrayBuffer> } {
    const vault = makeMemoryVault({ binaries }) as Vault & { __binaries: Map<string, ArrayBuffer> };
    const tfiles = files.map((spec) => {
        const file = new TFile();
        file.path = spec.path;
        file.name = spec.path.split('/').pop() ?? spec.path;
        file.basename = file.name.replace(/\.[^.]+$/, '');
        file.extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : '';
        file.stat = { mtime: 0, ctime: 0, size: spec.size ?? binaries[spec.path]?.length ?? 0 };
        return file;
    });
    (vault as unknown as { getFiles: () => TFile[] }).getFiles = () => tfiles;
    return { vault, store: vault.__binaries };
}

/** Minimal EventideQuillPlugin stub — the hygiene panel touches only `app.vault`. */
function makePlugin(vault: Vault): EventideQuillPlugin {
    return { app: { vault } } as unknown as EventideQuillPlugin;
}

/** Char codes of an ASCII string (chunk-data helper). */
const charCodes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** The one dirty fixture: a PNG with an embedded tEXt chunk. */
const DIRTY_PNG = buildPng([{ type: 'tEXt', data: charCodes('Comment\0a note embedded by an editor') }]);
/** A PNG with no metadata chunks beyond the critical ones. */
const CLEAN_PNG = buildPng([]);

/** Find a button by its trimmed label inside the container. */
function findButton(root: HTMLElement, label: string): HTMLButtonElement | null {
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;
}

/** Find a button whose trimmed label starts with the prefix (Strip buttons embed a byte count). */
function findButtonStartingWith(root: HTMLElement, prefix: string): HTMLButtonElement | null {
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(prefix)) ?? null;
}

/** The most recently opened modal (throws when none opened). */
function lastModal(): Modal {
    const modal = modals.at(-1);
    if (!modal) throw new Error('No confirmation modal was opened');
    return modal;
}

/** Drive one scan to completion on the rendered panel. */
async function scan(container: HTMLElement): Promise<void> {
    findButton(container, 'Scan attachments')!.click();
    // Wait for the finished button state — NOT the 'Last scanned' hint, which
    // module state renders on mount before any scan runs, so it passes
    // instantly on re-scans and would race the scan against the next click.
    // Observing the restored button also guarantees the in-flight guard has
    // been released (released in the same tick's microtask flush).
    await vi.waitFor(() => expect(findButton(container, 'Rescan attachments')?.disabled).toBe(false));
}

describe('renderLoreHygieneTab', () => {
    it('renders the honest-scope empty state before any scan', () => {
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(makeVault({}, []).vault), new Component());
        expect(container.textContent).to.include('metadata');
        expect(container.textContent).to.include('already');
        expect(container.textContent).to.include('frontmatter');
        expect(findButton(container, 'Scan attachments')).not.toBeNull();
    });

    it('lists flagged files with findings, chips, and a collapsed clean count', async () => {
        const { vault } = makeVault(
            {
                'attachments/scene.png': DIRTY_PNG,
                'attachments/portrait.png': CLEAN_PNG
            },
            [{ path: 'attachments/scene.png' }, { path: 'attachments/portrait.png' }]
        );
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        expect(container.textContent).to.include('attachments/scene.png');
        expect(container.textContent).to.include('PNG text');
        expect(container.textContent).to.include('1 attachment clean.');
        expect(findButtonStartingWith(container, 'Strip (')).not.toBeNull();
    });

    it('strips a file through a ConfirmModal naming it, and skips oversized files with a note', async () => {
        const { vault, store } = makeVault(
            {
                'attachments/huge.png': new Uint8Array(64),
                'attachments/scene.png': DIRTY_PNG
            },
            [
                { path: 'attachments/huge.png', size: 60 * 1024 * 1024 },
                { path: 'attachments/scene.png' }
            ]
        );
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        expect(container.textContent).to.include('attachments/huge.png');
        expect(container.textContent).to.include('Larger than 50 MB');

        // Per-file strip goes through a ConfirmModal naming the file.
        findButtonStartingWith(container, 'Strip (')!.click();
        const modal = lastModal();
        expect(modal.contentEl.textContent).to.include('scene.png');
        findButton(modal.contentEl, 'Strip')!.click();

        await vi.waitFor(() => {
            const after = store.get('attachments/scene.png');
            expect(after).toBeDefined();
            expect(inspectAttachmentMetadata(new Uint8Array(after!), 'png')!.findings).toEqual([]);
        });
        await vi.waitFor(() => expect(container.textContent).to.include('1 attachment clean.'));
    });

    it('strip-all opens one ConfirmModal with the count, then cleans every flagged file and updates the badge', async () => {
        const dirty2 = buildPng([{ type: 'tEXt', data: charCodes('Author\0second file') }]);
        const { vault, store } = makeVault(
            {
                'attachments/one.png': DIRTY_PNG,
                'attachments/two.png': dirty2,
                'attachments/fine.png': CLEAN_PNG
            },
            [{ path: 'attachments/one.png' }, { path: 'attachments/two.png' }, { path: 'attachments/fine.png' }]
        );
        const container = createDiv();
        const onChanged = vi.fn();
        renderLoreHygieneTab(container, makePlugin(vault), new Component(), onChanged);
        await scan(container);

        let stripAll: HTMLButtonElement | null = null;
        await vi.waitFor(() => {
            stripAll = findButtonStartingWith(container, 'Strip all flagged (2 files');
            expect(stripAll).not.toBeNull();
        });
        stripAll!.click();

        const modal = lastModal();
        expect(modal.contentEl.textContent).to.include('2 files');
        findButton(modal.contentEl, 'Strip all')!.click();

        await vi.waitFor(() => {
            const one = store.get('attachments/one.png');
            const two = store.get('attachments/two.png');
            expect(one && inspectAttachmentMetadata(new Uint8Array(one), 'png')!.findings).toEqual([]);
            expect(two && inspectAttachmentMetadata(new Uint8Array(two), 'png')!.findings).toEqual([]);
        });
        await vi.waitFor(() => expect(container.textContent).to.include('3 attachments clean.'));
        expect(onChanged).toHaveBeenCalled();
    });

    it('re-renders the last scan from module state on a fresh mount', async () => {
        // The panel holds its last scan in module state so a sidebar re-render
        // (fresh container, no new scan) redraws the same results.
        const { vault } = makeVault({ 'attachments/scene.png': DIRTY_PNG }, [{ path: 'attachments/scene.png' }]);
        const plugin = makePlugin(vault);
        const first = createDiv();
        renderLoreHygieneTab(first, plugin, new Component());
        await scan(first);

        const second = createDiv();
        renderLoreHygieneTab(second, plugin, new Component());
        expect(second.textContent).to.include('attachments/scene.png');
        expect(second.textContent).to.include('Last scanned');
    });

    it('no-ops a second strip request while one is already in flight', async () => {
        const { vault, store } = makeVault({ 'attachments/scene.png': DIRTY_PNG }, [{ path: 'attachments/scene.png' }]);
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        // The mocked obsidian module's Notice is spied (call-through), same
        // pattern as provider-delete — lets the no-op Notice be asserted.
        const noticeSpy = vi.spyOn(obsidian, 'Notice');

        // Gate writeBinary so the first strip parks mid-flight deterministically.
        let writeCalls = 0;
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const adapter = vault.adapter as unknown as {
            writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
        };
        const origWrite = vault.adapter.writeBinary.bind(vault.adapter);
        adapter.writeBinary = async (path, data) => {
            writeCalls++;
            await gated;
            await origWrite(path, data);
        };

        findButtonStartingWith(container, 'Strip (')!.click();
        findButton(lastModal().contentEl, 'Strip')!.click();
        await vi.waitFor(() => expect(writeCalls).toBe(1));

        // Second request while the first is mid-write: own modal, confirm → Notice + no-op.
        findButtonStartingWith(container, 'Strip (')!.click();
        findButton(lastModal().contentEl, 'Strip')!.click();
        await vi.waitFor(() => expect(noticeSpy).toHaveBeenCalledTimes(1));
        // The Notice names the shared scan/strip guard (the arg may be a fragment).
        const noticeArg = noticeSpy.mock.calls[0]?.[0];
        const noticeText = typeof noticeArg === 'string' ? noticeArg : (noticeArg?.textContent ?? '');
        expect(noticeText).to.include('already running');

        release();
        await vi.waitFor(() => {
            const after = store.get('attachments/scene.png');
            expect(after && inspectAttachmentMetadata(new Uint8Array(after), 'png')!.findings).toEqual([]);
        });
        expect(writeCalls).toBe(1); // the second request never wrote

        noticeSpy.mockRestore();
    });

    it('no-ops a scan requested while a strip is mid-flight', async () => {
        const { vault, store } = makeVault({ 'attachments/scene.png': DIRTY_PNG }, [{ path: 'attachments/scene.png' }]);
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        const noticeSpy = vi.spyOn(obsidian, 'Notice');

        // Gate writeBinary so the strip parks mid-flight deterministically, and
        // count reads so a blocked scan provably never touches the files.
        let writeCalls = 0;
        let readCalls = 0;
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const adapter = vault.adapter as unknown as {
            writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
            readBinary: (path: string) => Promise<ArrayBuffer>;
        };
        const origWrite = vault.adapter.writeBinary.bind(vault.adapter);
        const origRead = vault.adapter.readBinary.bind(vault.adapter);
        adapter.writeBinary = async (path, data) => {
            writeCalls++;
            await gated;
            await origWrite(path, data);
        };
        adapter.readBinary = async (path) => {
            readCalls++;
            return origRead(path);
        };

        findButtonStartingWith(container, 'Strip (')!.click();
        findButton(lastModal().contentEl, 'Strip')!.click();
        await vi.waitFor(() => expect(writeCalls).toBe(1));
        const readsWhileParked = readCalls; // the initial scan + the strip's pre-write read

        // A rescan mid-strip must no-op: Notice + zero reads + button untouched.
        findButton(container, 'Rescan attachments')!.click();
        await vi.waitFor(() => expect(noticeSpy).toHaveBeenCalledTimes(1));
        expect(readCalls).toBe(readsWhileParked);
        const scanBtn = findButton(container, 'Rescan attachments');
        expect(scanBtn).not.toBeNull(); // never flipped to 'Scanning…'
        expect(scanBtn!.disabled).toBe(false);

        release();
        await vi.waitFor(() => {
            const after = store.get('attachments/scene.png');
            expect(after && inspectAttachmentMetadata(new Uint8Array(after), 'png')!.findings).toEqual([]);
        });
        await vi.waitFor(() => expect(noticeSpy).toHaveBeenCalledTimes(2)); // blocked scan + strip success — flow fully drained
        expect(writeCalls).toBe(1); // the scan never wrote or repainted over the strip

        noticeSpy.mockRestore();
    });

    it('skips a row whose file grew past the scan cap between scan and strip', async () => {
        const { vault, store } = makeVault({ 'attachments/scene.png': DIRTY_PNG }, [{ path: 'attachments/scene.png' }]);
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        // The file grows (or the scan-time stat went stale) before the strip.
        vault.adapter.stat = async () => ({ type: 'file', ctime: 0, mtime: 0, size: 60 * 1024 * 1024 });

        findButtonStartingWith(container, 'Strip (')!.click();
        findButton(lastModal().contentEl, 'Strip')!.click();

        await vi.waitFor(() => expect(container.textContent).to.include('Grew past the scan limit'));
        // Nothing was read, stripped, or written — the stored bytes are untouched.
        expect(Array.from(new Uint8Array(store.get('attachments/scene.png')!))).toEqual(Array.from(DIRTY_PNG));
    });

    it('marks the row as an error without a success notice when the verified write mismatches', async () => {
        const { vault, store } = makeVault({ 'attachments/scene.png': DIRTY_PNG }, [{ path: 'attachments/scene.png' }]);
        const container = createDiv();
        renderLoreHygieneTab(container, makePlugin(vault), new Component());
        await scan(container);

        const noticeSpy = vi.spyOn(obsidian, 'Notice');
        // Corrupt the write: land bytes that differ from what stripRow asked for.
        const adapter = vault.adapter as unknown as {
            writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
        };
        adapter.writeBinary = async (path, data) => {
            const corrupted = new Uint8Array(data.slice(0));
            corrupted[0] = corrupted[0]! ^ 0xff;
            store.set(path, corrupted.buffer);
        };

        findButtonStartingWith(container, 'Strip (')!.click();
        findButton(lastModal().contentEl, 'Strip')!.click();

        await vi.waitFor(() => expect(container.textContent).to.include('verification failed'));
        expect(container.querySelector('.quill-lore-hygiene__card--error')).not.toBeNull();
        expect(noticeSpy).not.toHaveBeenCalled(); // no success (or any) notice on the failure path

        noticeSpy.mockRestore();
    });

    it('survives a scan that REJECTS — the failure is caught and logged, never unhandled', async () => {
        // `refresh` is try/finally only, so without the catch inside
        // `runExclusive` a failing scan escapes as an unhandledrejection
        // (which Vitest surfaces as a test failure). The panel must repaint
        // and release the in-flight guard instead.
        const { vault } = makeVault({}, []);
        (vault as unknown as { getFiles: () => never[] }).getFiles = () => {
            throw new Error('vault index exploded');
        };
        const container = createDiv();
        const onChanged = vi.fn();
        renderLoreHygieneTab(container, makePlugin(vault), new Component(), onChanged);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        findButton(container, 'Scan attachments')!.click();

        // The finally block restored the button (guard released + repaint ran)…
        await vi.waitFor(() => expect(findButton(container, 'Rescan attachments')?.disabled).toBe(false));
        // …the rejection was routed to the catch, not left unhandled…
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Hygiene'), expect.any(Error));
        // …and the panel survived the failed scan (the finally block completed:
        // `onScanChanged` fires after renderResults in the same finally, so it
        // only lands when the repaint did not throw).
        expect(onChanged).toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});
