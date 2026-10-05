// @vitest-environment happy-dom
import '../helpers/ui-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    await vi.waitFor(() => expect(container.textContent).to.include('Last scanned'));
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
});
