/**
 * Encapsulated Lorebook "Hygiene" sub-tab renderer: scans the vault's binary
 * image attachments for embedded metadata (Exif, XMP, C2PA content
 * credentials, IPTC, PNG text) and strips it losslessly on explicit
 * confirmation.
 *
 * Pattern: stateless exported renderer (peer of `renderFeedbackQueue`) — DOM
 * events are registered on the caller's render-events `Component` so they tear
 * down with the surrounding panel. The LAST SCAN is held in module state: the
 * scan is a cheap on-demand recomputation, never persisted and never plugin
 * state, but holding it means a sidebar re-render (active-leaf-change)
 * redraws the same results instead of losing them, and
 * {@link loreHygieneFlaggedCount} can feed the sub-tab badge between renders.
 * An in-flight STRIP is likewise module state (`stripping`): while one strip
 * (per-file or strip-all) is running, further strip requests no-op with a
 * Notice instead of racing the same file.
 *
 * Scope honesty: only writer-added binary attachments are scanned — images
 * that enter through the co-writer (paste, tool results) are already
 * metadata-free because the AI paths re-encode through canvas. Notes and
 * frontmatter are never touched.
 */
import { Component, Notice, normalizePath, type TFile } from 'obsidian';
import type EventideQuillPlugin from '../main';
import { IMAGE_EXTENSIONS } from '../core/dashboard/lorebook-scanner';
import {
    inspectAttachmentMetadata,
    stripAttachmentMetadata,
    type AttachmentFinding
} from '../utils/attachment-metadata';
import { ConfirmModal } from './confirm-modal';

/**
 * Hard cap on bytes read per attachment during a scan — larger files are
 * skipped with a visible note rather than pulled into memory. Same ceiling as
 * `MAX_IMAGE_BYTES` in `co-writer-panel.ts` (the OOM guard for decode); here
 * it bounds `adapter.readBinary` on absurdly large attachments.
 */
const MAX_SCAN_BYTES = 50 * 1024 * 1024;

/** Lifecycle of one attachment within a scan. */
type HygieneRowStatus = 'flagged' | 'clean' | 'error' | 'skipped' | 'unchecked';

/** Result row for one attachment in a scan. */
interface HygieneRow {
    file: TFile;
    /** Normalized lowercase extension. */
    ext: string;
    status: HygieneRowStatus;
    findings: AttachmentFinding[];
    /** Total bytes strippable from this file (findings minus kept ICC profiles). */
    removableBytes: number;
    /** Error / skip reason when the status is not flagged/clean. */
    detail: string | null;
}

/** One completed scan. */
interface HygieneScan {
    rows: HygieneRow[];
    scannedAt: number;
}

/** Last completed scan (module state — see the module docstring). */
let lastScan: HygieneScan | null = null;

/**
 * True while a strip operation (per-file or strip-all) is mid-flight (module
 * state — see the module docstring): binary writes bypass Obsidian's file
 * recovery, so a second strip request during one in flight no-ops with a
 * Notice rather than racing it on the same file.
 */
let stripping = false;

/** Flagged-file count from the last scan (0 before the first scan) — drives the Hygiene sub-tab badge. */
export function loreHygieneFlaggedCount(): number {
    if (!lastScan) return 0;
    return lastScan.rows.filter((r) => r.status === 'flagged').length;
}

/** Human-readable byte count (peer of the helper in `settings.ts`, kept local to avoid cross-surface coupling). */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Copy a Uint8Array into an exactly-sized ArrayBuffer for `adapter.writeBinary`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Byte-for-byte equality of two Uint8Arrays (verified-write comparison). */
function bytesMatch(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Sum of removable (non-ICC) finding bytes. */
function removableOf(findings: AttachmentFinding[]): number {
    return findings.filter((f) => f.kind !== 'icc').reduce((sum, f) => sum + f.byteLength, 0);
}

/** Chip label per finding kind. ICC findings can appear on flagged cards (next to strippable kinds) — their detail notes they are kept. */
const KIND_LABEL: Record<AttachmentFinding['kind'], string> = {
    exif: 'Exif',
    xmp: 'XMP',
    c2pa: 'C2PA',
    iptc: 'IPTC',
    comment: 'Comment',
    'png-text': 'PNG text',
    'png-exif-chunk': 'Exif (PNG)',
    'png-timestamp': 'Timestamp',
    icc: 'ICC'
};

/** Inventory the vault's image attachments and inspect each readable one. */
async function runScan(plugin: EventideQuillPlugin): Promise<HygieneScan> {
    const vault = plugin.app.vault;
    const images = vault
        .getFiles()
        .filter((f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()))
        .sort((a, b) => a.path.localeCompare(b.path));

    const rows: HygieneRow[] = [];
    for (const file of images) {
        const ext = file.extension.toLowerCase();
        if (file.stat.size > MAX_SCAN_BYTES) {
            rows.push({
                file,
                ext,
                status: 'skipped',
                findings: [],
                removableBytes: 0,
                detail: `Larger than 50 MB — skipped rather than read into memory.`
            });
            continue;
        }
        try {
            const buffer = await vault.adapter.readBinary(normalizePath(file.path));
            const report = inspectAttachmentMetadata(new Uint8Array(buffer), ext);
            if (!report) {
                rows.push({
                    file,
                    ext,
                    status: 'unchecked',
                    findings: [],
                    removableBytes: 0,
                    detail: `${ext.toUpperCase()} isn't checked yet — only png/jpg/jpeg are scanned.`
                });
                continue;
            }
            const removable = removableOf(report.findings);
            rows.push({
                file,
                ext,
                status: removable > 0 ? 'flagged' : 'clean',
                findings: report.findings,
                removableBytes: removable,
                detail: null
            });
        } catch (err) {
            rows.push({
                file,
                ext,
                status: 'error',
                findings: [],
                removableBytes: 0,
                detail: err instanceof Error ? err.message : 'Read failed.'
            });
        }
    }
    return { rows, scannedAt: Date.now() };
}

/**
 * Render the Hygiene sub-tab into `container`. The caller owns the container
 * lifecycle; `onScanChanged` (optional) fires after every scan or strip so
 * the host can refresh its sub-tab badge without a full re-render.
 */
export function renderLoreHygieneTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    events: Component,
    onScanChanged?: () => void
): void {
    const root = container.createDiv({ cls: 'quill-lore-hygiene' });
    const hintEl = root.createDiv({ cls: 'quill-lore-hygiene__hint' });
    const toolbar = root.createDiv({ cls: 'quill-lore-hygiene__toolbar' });
    const resultsEl = root.createDiv({ cls: 'quill-lore-hygiene__results' });

    const scanBtn = toolbar.createEl('button', { cls: 'quill-lore-hygiene__scan', text: 'Scan attachments' });

    /** Re-render the hint line (scope copy pre-scan, summary post-scan). */
    function renderHint(): void {
        if (!lastScan) {
            hintEl.setText(
                'Scans the image attachments in this vault for embedded metadata — Exif camera data (including GPS), ' +
                    'XMP packets, C2PA content credentials, and PNG text chunks — and strips it losslessly on request: ' +
                    'pixels are untouched and color profiles are preserved. Only binary image attachments are read; ' +
                    'notes and frontmatter are never modified. Images pasted through the co-writer are already ' +
                    'metadata-free (they are re-encoded on arrival), so this targets files you added yourself.'
            );
            return;
        }
        const flagged = lastScan.rows.filter((r) => r.status === 'flagged').length;
        const clean = lastScan.rows.filter((r) => r.status === 'clean').length;
        hintEl.setText(
            `Last scanned ${new Date(lastScan.scannedAt).toLocaleTimeString()} — ` +
                `${flagged} flagged, ${clean} clean. Stripping is lossless; color profiles are kept.`
        );
    }

    /** Render one flagged (or errored/skipped) attachment card with its finding chips + strip action. */
    function renderRow(parent: HTMLElement, row: HygieneRow): void {
        const card = parent.createDiv({
            cls: `quill-lore-hygiene__card quill-lore-hygiene__card--${row.status}`
        });

        const head = card.createDiv({ cls: 'quill-lore-hygiene__card-head' });
        head.createSpan({ cls: 'quill-lore-hygiene__name', text: row.file.path });
        head.createSpan({ cls: 'quill-lore-hygiene__size', text: formatBytes(row.file.stat.size) });

        if (row.status === 'error' || row.status === 'skipped') {
            card.createEl('p', { cls: 'quill-lore-hygiene__note', text: row.detail ?? '' });
            return;
        }

        const chips = card.createDiv({ cls: 'quill-lore-hygiene__chips' });
        for (const finding of row.findings) {
            const chip = chips.createSpan({
                cls: `quill-lore-hygiene__chip${finding.kind === 'c2pa' ? ' quill-lore-hygiene__chip--c2pa' : ''}`,
                text: `${KIND_LABEL[finding.kind]} · ${formatBytes(finding.byteLength)}`
            });
            chip.setAttr('title', finding.detail ?? '');
            if (finding.detail) {
                chip.textContent += ` — ${finding.detail}`;
            }
        }

        if (row.status === 'flagged') {
            const actions = card.createDiv({ cls: 'quill-lore-hygiene__actions' });
            const stripBtn = actions.createEl('button', {
                cls: 'quill-lore-hygiene__strip',
                text: `Strip (${formatBytes(row.removableBytes)})`
            });
            events.registerDomEvent(stripBtn, 'click', () => requestStrip(row));
        }
    }

    /** Re-render the results area from the last scan. */
    function renderResults(): void {
        resultsEl.empty();
        renderHint();
        if (!lastScan) return;

        const rows = lastScan.rows;
        const flagged = rows.filter((r) => r.status === 'flagged');
        const cleanCount = rows.filter((r) => r.status === 'clean').length;
        const uncheckedCount = rows.filter((r) => r.status === 'unchecked').length;

        if (rows.length === 0) {
            resultsEl.createEl('p', {
                cls: 'quill-lore-hygiene__empty',
                text: 'No image attachments found in this vault.'
            });
            return;
        }

        if (flagged.length > 0) {
            const totalBytes = flagged.reduce((sum, r) => sum + r.removableBytes, 0);
            const stripAllBtn = resultsEl.createEl('button', {
                cls: 'quill-lore-hygiene__strip-all',
                text: `Strip all flagged (${flagged.length} file${flagged.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)})`
            });
            events.registerDomEvent(stripAllBtn, 'click', () => requestStripAll(flagged));
        }

        for (const row of flagged) renderRow(resultsEl, row);
        for (const row of rows) {
            if (row.status === 'error' || row.status === 'skipped') renderRow(resultsEl, row);
        }

        // Clean files collapse to one count line; unchecked extensions get their own honest note.
        if (cleanCount > 0) {
            resultsEl.createEl('p', {
                cls: 'quill-lore-hygiene__clean-count',
                text: `${cleanCount} attachment${cleanCount === 1 ? '' : 's'} clean.`
            });
        }
        if (uncheckedCount > 0) {
            resultsEl.createEl('p', {
                cls: 'quill-lore-hygiene__note',
                text: `${uncheckedCount} image${uncheckedCount === 1 ? '' : 's'} not checked (unsupported format — only png/jpg/jpeg are scanned).`
            });
        }
    }

    /** Scan (or rescan) the vault and repaint. */
    async function refresh(): Promise<void> {
        scanBtn.disabled = true;
        scanBtn.setText('Scanning…');
        try {
            lastScan = await runScan(plugin);
        } finally {
            scanBtn.disabled = false;
            scanBtn.setText('Rescan attachments');
            renderResults();
            onScanChanged?.();
        }
    }

    /**
     * Run one strip operation under the module-level in-flight guard — no-ops
     * with a brief Notice when a strip is already running (see `stripping`).
     */
    function runStripExclusive(op: () => Promise<void>): void {
        if (stripping) {
            new Notice('A strip is already running.');
            return;
        }
        stripping = true;
        void op().finally(() => {
            stripping = false;
        });
    }

    /** Strip one file after a ConfirmModal names it (binary writes bypass Obsidian's file recovery, so confirmation is mandatory). */
    function requestStrip(row: HygieneRow): void {
        new ConfirmModal(
            plugin.app,
            'Strip metadata?',
            `Remove ${formatBytes(row.removableBytes)} of embedded metadata from "${row.file.name}"? ` +
                "Pixels are untouched, but binary writes bypass Obsidian's file recovery — this cannot be undone.",
            () => runStripExclusive(() => stripRow(row)),
            'Strip'
        ).open();
    }

    /** Strip every flagged file after one ConfirmModal lists the damage. */
    function requestStripAll(flagged: HygieneRow[]): void {
        const totalBytes = flagged.reduce((sum, r) => sum + r.removableBytes, 0);
        new ConfirmModal(
            plugin.app,
            'Strip all flagged?',
            `Strip embedded metadata from ${flagged.length} file${flagged.length === 1 ? '' : 's'}? ` +
                `About ${formatBytes(totalBytes)} will be removed across them. Pixels are untouched, but binary ` +
                "writes bypass Obsidian's file recovery — this cannot be undone.",
            () =>
                runStripExclusive(async () => {
                    for (const row of flagged) await stripRow(row);
                }),
            'Strip all'
        ).open();
    }

    /**
     * Rewrite one attachment without its strippable metadata, then re-inspect
     * what landed on disk and update the row. Size is re-checked at strip time
     * — the file may have grown past the scan cap between scan and strip — and
     * the write is verified by re-reading before any success is reported.
     * Always repaints, including on the skip/error paths.
     */
    async function stripRow(row: HygieneRow): Promise<void> {
        await stripRowCore(row);
        renderResults();
        onScanChanged?.();
    }

    /** The strip flow proper (repaint owned by `stripRow`): the skip paths return early, local to this flow. */
    async function stripRowCore(row: HygieneRow): Promise<void> {
        const vault = plugin.app.vault;
        const path = normalizePath(row.file.path);
        try {
            // TOCTOU guard: the scan-time size check can be stale by the time the writer confirms the strip.
            const oversizeDetail = 'Grew past the scan limit since scanning — skipped rather than read.';
            const stat = await vault.adapter.stat(path);
            if (!stat) throw new Error('Attachment no longer exists on disk.');
            if (stat.size > MAX_SCAN_BYTES) {
                row.status = 'skipped';
                row.detail = oversizeDetail;
                return;
            }
            const buffer = await vault.adapter.readBinary(path);
            if (buffer.byteLength > MAX_SCAN_BYTES) {
                // Stat can lie or race the read — never hold more than the cap in memory.
                row.status = 'skipped';
                row.detail = oversizeDetail;
                return;
            }
            const result = stripAttachmentMetadata(new Uint8Array(buffer), row.ext);
            const removedBytes = result.stripped.reduce((sum, f) => sum + f.byteLength, 0);
            if (result.stripped.length > 0) {
                // Raw adapter write — TFile.stat.size goes stale until Obsidian re-syncs (cosmetic only).
                await vault.adapter.writeBinary(path, toArrayBuffer(result.bytes));
            }
            const written = new Uint8Array(await vault.adapter.readBinary(path));
            if (result.stripped.length > 0 && !bytesMatch(written, result.bytes)) {
                // Verified write: binary writes bypass Obsidian's file recovery, so confirm the bytes actually landed before claiming success.
                throw new Error('Strip verification failed — the file on disk does not match the stripped bytes.');
            }
            const after = inspectAttachmentMetadata(written, row.ext);
            row.findings = after?.findings ?? [];
            row.removableBytes = after ? removableOf(row.findings) : 0;
            row.status = row.removableBytes > 0 ? 'flagged' : 'clean';
            row.detail = null;
            new Notice(
                result.stripped.length > 0
                    ? `Stripped ${result.stripped.length} finding${result.stripped.length === 1 ? '' : 's'} (${formatBytes(removedBytes)}) from ${row.file.name}.`
                    : `${row.file.name} was already clean.`
            );
        } catch (err) {
            row.status = 'error';
            row.detail = err instanceof Error ? err.message : 'Strip failed.';
        }
    }

    events.registerDomEvent(scanBtn, 'click', () => void refresh());
    renderHint();
    renderResults();
}
