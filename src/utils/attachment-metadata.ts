/**
 * Attachment metadata inspection + lossless stripping for binary image
 * attachments (PNG / JPEG). Pure byte-level module — ZERO Obsidian imports —
 * so it unit-tests without mocks.
 *
 * What it finds (and strips):
 * - **PNG** — the `tEXt` / `iTXt` / `zTXt` text chunks (with their key names),
 *   the `eXIf` Exif chunk, and the `tIME` last-modified timestamp. ICC color
 *   profiles (`iCCP`) are REPORTED (kind `'icc'`) but never stripped — color
 *   fidelity is non-negotiable. Everything else (critical chunks, `sRGB`,
 *   `gAMA`, ancillary color chunks) is preserved byte-for-byte, CRC included.
 * - **JPEG** — APP1 segments carrying Exif (`Exif\0\0` header), APP1/APPn
 *   segments carrying Adobe XMP (`ns.adobe.com/xap` / `ns.adobe.com/xmp`
 *   markers in the segment head — generous, covers the APP0-less variants),
 *   APP2 segments carrying C2PA content credentials (JUMBF — detected by a
 *   byte-scan of the segment head for `jumb` / `c2pa` / `urn:iso:` markers),
 *   APP13 Photoshop/IPTC blocks, and `COM` comment segments. APP0 (JFIF),
 *   APP2 ICC profiles (reported as `'icc'`, never stripped), every coding
 *   segment (DQT/SOF/DHT/DRI…), and ALL entropy-coded data from SOS onward
 *   are preserved byte-for-byte — the scan stops at SOS and never reads the
 *   compressed scan.
 *
 * Malformed-input policy: a truncated or structurally invalid file BAILS OUT —
 * inspection reports no findings and stripping returns the original bytes
 * unchanged (as a copy). A half-understood file is never rewritten: if the
 * chunk/segment walk cannot complete cleanly to the end marker, we refuse to
 * touch the file rather than risk emitting a corrupt image. Chunk CRCs and
 * segment contents are preserved verbatim (never revalidated, never
 * recomputed), so a kept region is bit-identical to the input.
 */

/** Kinds of embedded metadata the scanner recognizes. */
export type AttachmentFindingKind =
    'exif' | 'xmp' | 'c2pa' | 'iptc' | 'comment' | 'png-text' | 'png-exif-chunk' | 'png-timestamp' | 'icc';

/** One embedded-metadata finding inside an attachment. */
export interface AttachmentFinding {
    /** What kind of metadata was found. */
    kind: AttachmentFindingKind;
    /** Bytes this finding occupies in the file (what stripping would remove). */
    byteLength: number;
    /** Short human sentence adding context (which keys, what it contains, …). */
    detail?: string;
}

/** Result of inspecting one attachment. */
export interface AttachmentMetadataReport {
    /** Normalized extension the bytes were inspected as (`png` / `jpg` / `jpeg`). */
    ext: string;
    /** Findings in file order. Empty for a well-formed image with no metadata. */
    findings: AttachmentFinding[];
}

/** Result of stripping one attachment. */
export interface AttachmentStripResult {
    /** The (possibly cleaned) image bytes. Always a fresh copy of the input when nothing strips. */
    bytes: Uint8Array;
    /** The findings that were actually removed. Never contains `'icc'`. */
    stripped: AttachmentFinding[];
}

/** Extensions this module can inspect. The panel scopes its inventory wider (all image attachments) and reports the rest as unchecked. */
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg'];

// ── Byte helpers (DataView-based — noUncheckedIndexedAccess-safe) ────────────

/** Decode exactly `len` bytes at `start` as ASCII (non-printables become '.'). */
function asciiFixed(view: DataView, start: number, len: number): string {
    let out = '';
    for (let i = 0; i < len; i++) {
        const b = view.getUint8(start + i);
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    }
    return out;
}

/** Decode ASCII bytes at `start` until a NUL byte or `maxLen` bytes, whichever comes first. */
function asciiToNull(view: DataView, start: number, maxLen: number): string {
    let out = '';
    for (let i = 0; i < maxLen && start + i < view.byteLength; i++) {
        const b = view.getUint8(start + i);
        if (b === 0) break;
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?';
    }
    return out;
}

/** True when the ASCII bytes of `token` appear anywhere in the view range [start, end). */
function containsAscii(view: DataView, start: number, end: number, token: string): boolean {
    const limit = Math.min(end, view.byteLength) - token.length;
    for (let i = start; i <= limit; i++) {
        let matched = true;
        for (let j = 0; j < token.length; j++) {
            if (view.getUint8(i + j) !== token.charCodeAt(j)) {
                matched = false;
                break;
            }
        }
        if (matched) return true;
    }
    return false;
}

/** True when the bytes at `start` begin with the ASCII string `prefix`. */
function startsWithAscii(view: DataView, start: number, prefix: string): boolean {
    if (start + prefix.length > view.byteLength) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (view.getUint8(start + i) !== prefix.charCodeAt(i)) return false;
    }
    return true;
}

/** Zero-pad a number to two digits (timestamp formatting). */
function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

// ── PNG ──────────────────────────────────────────────────────────────────────

/** One walked PNG chunk: byte ranges include the 12-byte length/type/CRC framing. */
interface PngChunk {
    type: string;
    totalStart: number;
    totalEnd: number;
    dataStart: number;
    dataEnd: number;
}

/**
 * Walk PNG chunks from offset 8. The 8 signature bytes are skipped
 * unconditionally — never verified — and are always kept verbatim downstream.
 * Returns null when the file is truncated or has no IEND terminator — the
 * malformed-input bail-out, not an exception.
 */
function walkPngChunks(view: DataView): PngChunk[] | null {
    const chunks: PngChunk[] = [];
    let pos = 8;
    while (pos + 8 <= view.byteLength) {
        const dataLen = view.getUint32(pos, false);
        if (dataLen > 0x7fffffff) return null;
        const dataStart = pos + 8;
        const dataEnd = dataStart + dataLen;
        const totalEnd = dataEnd + 4; // trailing CRC
        if (totalEnd > view.byteLength) return null;
        chunks.push({
            type: asciiFixed(view, pos + 4, 4),
            totalStart: pos,
            totalEnd,
            dataStart,
            dataEnd
        });
        pos = totalEnd;
        if (chunks[chunks.length - 1]!.type === 'IEND') return chunks;
    }
    return null; // ran off the end without IEND
}

/**
 * Walk a PNG: collect metadata findings and, when `strip` is set, the kept
 * byte ranges for rebuild. Returns null on malformed input (bail-out).
 */
function processPng(
    view: DataView,
    strip: boolean
): { findings: AttachmentFinding[]; stripped: AttachmentFinding[]; keptRanges: Array<[number, number]> } | null {
    const chunks = walkPngChunks(view);
    if (!chunks) return null;

    const findings: AttachmentFinding[] = [];
    const stripped: AttachmentFinding[] = [];
    const keptRanges: Array<[number, number]> = [[0, 8]]; // signature

    for (const chunk of chunks) {
        const total = chunk.totalEnd - chunk.totalStart;
        let drop = false;
        let finding: AttachmentFinding | null = null;

        if (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') {
            const key = asciiToNull(view, chunk.dataStart, 80) || '(unnamed)';
            const flavour =
                chunk.type === 'iTXt' ? 'international text' : chunk.type === 'zTXt' ? 'compressed' : 'text';
            finding = { kind: 'png-text', byteLength: total, detail: `Text chunk "${key}" (${flavour}).` };
            drop = true;
        } else if (chunk.type === 'eXIf') {
            finding = { kind: 'png-exif-chunk', byteLength: total, detail: 'Exif metadata chunk.' };
            drop = true;
        } else if (chunk.type === 'tIME') {
            let detail = 'Last-modified timestamp.';
            if (chunk.dataEnd - chunk.dataStart >= 7) {
                const year = view.getUint16(chunk.dataStart, false);
                const month = view.getUint8(chunk.dataStart + 2);
                const day = view.getUint8(chunk.dataStart + 3);
                const hour = view.getUint8(chunk.dataStart + 4);
                const minute = view.getUint8(chunk.dataStart + 5);
                const second = view.getUint8(chunk.dataStart + 6);
                detail = `Last modified ${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)} UTC.`;
            }
            finding = { kind: 'png-timestamp', byteLength: total, detail };
            drop = true;
        } else if (chunk.type === 'iCCP') {
            const name = asciiToNull(view, chunk.dataStart, 80) || '(unnamed)';
            finding = {
                kind: 'icc',
                byteLength: total,
                detail: `ICC color profile "${name}" — kept for color fidelity.`
            };
            drop = false;
        }

        if (finding) findings.push(finding);
        if (finding && drop) {
            stripped.push(finding);
        } else if (strip) {
            keptRanges.push([chunk.totalStart, chunk.totalEnd]);
        }
    }

    return { findings, stripped, keptRanges };
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

/** One walked JPEG segment: byte ranges include the marker + length framing. */
interface JpegSegment {
    marker: number;
    totalStart: number;
    totalEnd: number;
    dataStart: number;
    dataEnd: number;
}

/**
 * Walk JPEG segments from SOI until SOS (or EOI). Returns the segments plus
 * the offset where the preserved tail (SOS + entropy data + EOI) begins.
 * Returns null on any structural surprise — malformed-input bail-out.
 */
function walkJpegSegments(view: DataView): { segments: JpegSegment[]; tailStart: number } | null {
    if (view.byteLength < 4) return null;
    if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null; // no SOI

    const segments: JpegSegment[] = [];
    let pos = 2;
    while (pos < view.byteLength) {
        if (view.getUint8(pos) !== 0xff) return null;
        // Skip fill bytes (any number of 0xFF may precede a marker).
        while (pos < view.byteLength && view.getUint8(pos) === 0xff) pos++;
        if (pos >= view.byteLength) return null;
        const marker = view.getUint8(pos);
        const markerStart = pos - 1; // the 0xFF we skipped into

        if (marker === 0xd9) return { segments, tailStart: markerStart }; // EOI
        if (marker === 0xda) return { segments, tailStart: markerStart }; // SOS — entropy data follows
        // Standalone markers without a length field (TEM, RSTn) and stray SOIs.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
            pos++;
            continue;
        }

        if (pos + 3 > view.byteLength) return null;
        const segLen = view.getUint16(pos + 1, false); // length field follows the marker byte
        if (segLen < 2) return null;
        const dataStart = pos + 3;
        const dataEnd = dataStart + segLen - 2;
        if (dataEnd > view.byteLength) return null;
        segments.push({ marker, totalStart: markerStart, totalEnd: dataEnd, dataStart, dataEnd });
        pos = dataEnd;
    }
    return null; // never reached SOS or EOI — truncated
}

/**
 * Walk a JPEG: collect metadata findings and, when `strip` is set, the kept
 * byte ranges for rebuild. Returns null on malformed input (bail-out).
 */
function processJpeg(
    view: DataView,
    strip: boolean
): { findings: AttachmentFinding[]; stripped: AttachmentFinding[]; keptRanges: Array<[number, number]> } | null {
    const walk = walkJpegSegments(view);
    if (!walk) return null;

    const findings: AttachmentFinding[] = [];
    const stripped: AttachmentFinding[] = [];
    const keptRanges: Array<[number, number]> = [[0, 2]]; // SOI

    for (const seg of walk.segments) {
        const total = seg.totalEnd - seg.totalStart;
        const headEnd = Math.min(seg.dataEnd, seg.dataStart + 256);
        let drop = false;
        let finding: AttachmentFinding | null = null;

        if (seg.marker === 0xfe) {
            const text = asciiToNull(view, seg.dataStart, 48);
            finding = {
                kind: 'comment',
                byteLength: total,
                detail: text ? `JPEG comment: "${text}"` : 'JPEG comment.'
            };
            drop = true;
        } else if (seg.marker === 0xed) {
            const isPhotoshop = startsWithAscii(view, seg.dataStart, 'Photoshop 3.0');
            finding = {
                kind: 'iptc',
                byteLength: total,
                detail: isPhotoshop ? 'Photoshop resources (IPTC) block.' : 'APP13 metadata block.'
            };
            drop = true;
        } else if (seg.marker >= 0xe0 && seg.marker <= 0xef) {
            if (seg.marker === 0xe1 && startsWithAscii(view, seg.dataStart, 'Exif')) {
                finding = {
                    kind: 'exif',
                    byteLength: total,
                    detail: 'Exif metadata — camera, lens, exposure, and possibly GPS coordinates.'
                };
                drop = true;
            } else if (startsWithAscii(view, seg.dataStart, 'ICC_PROFILE')) {
                finding = { kind: 'icc', byteLength: total, detail: 'ICC color profile — kept for color fidelity.' };
                drop = false;
            } else if (
                containsAscii(view, seg.dataStart, headEnd, 'ns.adobe.com/xap') ||
                containsAscii(view, seg.dataStart, headEnd, 'ns.adobe.com/xmp')
            ) {
                finding = { kind: 'xmp', byteLength: total, detail: 'Adobe XMP metadata packet.' };
                drop = true;
            } else if (
                containsAscii(view, seg.dataStart, headEnd, 'jumb') ||
                containsAscii(view, seg.dataStart, headEnd, 'c2pa') ||
                containsAscii(view, seg.dataStart, headEnd, 'urn:iso:')
            ) {
                finding = {
                    kind: 'c2pa',
                    byteLength: total,
                    detail: 'C2PA content credentials (JUMBF manifest) present.'
                };
                drop = true;
            }
        }

        if (finding) findings.push(finding);
        if (finding && drop) {
            stripped.push(finding);
        } else if (strip) {
            keptRanges.push([seg.totalStart, seg.totalEnd]);
        }
    }

    keptRanges.push([walk.tailStart, view.byteLength]);
    return { findings, stripped, keptRanges };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Normalize a user- or file-supplied extension (`'.PNG'` → `'png'`). */
function normalizeExt(ext: string): string {
    return ext.trim().toLowerCase().replace(/^\./, '');
}

/**
 * Inspect attachment bytes for embedded metadata. Returns null for unsupported
 * extensions (anything other than png/jpg/jpeg) — the caller decides how to
 * surface those. Never throws: malformed/truncated input yields a report with
 * no findings (see the module bail-out policy above).
 */
export function inspectAttachmentMetadata(bytes: Uint8Array, ext: string): AttachmentMetadataReport | null {
    const norm = normalizeExt(ext);
    if (!SUPPORTED_EXTENSIONS.includes(norm)) return null;
    if (bytes.length < 12) return { ext: norm, findings: [] };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = norm === 'png' ? processPng(view, false) : processJpeg(view, false);
    return { ext: norm, findings: result ? result.findings : [] };
}

/**
 * Strip strippable metadata from attachment bytes, losslessly: kept regions
 * are copied byte-for-byte (critical chunks, color profiles, entropy-coded
 * data), so the image pixels and rendering are unchanged. Returns the input
 * as a fresh copy with an empty `stripped` list when there is nothing to
 * remove or the input is malformed/unsupported (bail-out — never rewrite a
 * file we could not fully parse).
 */
export function stripAttachmentMetadata(bytes: Uint8Array, ext: string): AttachmentStripResult {
    const norm = normalizeExt(ext);
    /** Fresh copy of the input with nothing removed (bail-out / nothing-to-strip result). */
    const unchanged = (): AttachmentStripResult => ({ bytes: bytes.slice(), stripped: [] });
    if (!SUPPORTED_EXTENSIONS.includes(norm) || bytes.length < 12) return unchanged();

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = norm === 'png' ? processPng(view, true) : processJpeg(view, true);
    if (!result || result.stripped.length === 0) return unchanged();

    const outLength = result.keptRanges.reduce((sum, [start, end]) => sum + (end - start), 0);
    const out = new Uint8Array(outLength);
    let offset = 0;
    for (const [start, end] of result.keptRanges) {
        out.set(bytes.slice(start, end), offset);
        offset += end - start;
    }
    return { bytes: out, stripped: result.stripped };
}
