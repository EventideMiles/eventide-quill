import { describe, expect, it } from 'vitest';
import {
    inspectAttachmentMetadata,
    stripAttachmentMetadata,
    type AttachmentFindingKind
} from '../../src/utils/attachment-metadata';

// ── Fixture builders (all bytes synthesized — no real image files) ──────────

/** Standard CRC-32 table (PNG chunk checksums). */
const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 of a byte range (DataView-based to stay noUncheckedIndexedAccess-clean). */
function crc32(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let c = 0xffffffff;
    for (let i = 0; i < view.byteLength; i++) {
        c = CRC_TABLE[(c ^ view.getUint8(i)) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/** Concatenate byte arrays into one exactly-sized buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Encode an ASCII string as bytes (may include NULs). */
function ascii(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

/** Build one byte array from ASCII strings, raw byte lists, and number arrays (fixture sugar over concat/ascii). */
function bytes(...parts: (string | number[] | Uint8Array)[]): Uint8Array {
    return concat(
        parts.map((p) => (typeof p === 'string' ? ascii(p) : p instanceof Uint8Array ? p : new Uint8Array(p)))
    );
}

/** Build one PNG chunk: 4-byte length + type + data + CRC-32 of type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
    return out;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal valid IHDR payload: 1×1, 8-bit grayscale. */
function ihdrChunk(): Uint8Array {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, false);
    view.setUint32(4, 1, false);
    data[8] = 8; // bit depth
    return pngChunk('IHDR', data);
}

/** Fake image-data + end chunks. */
/** Fake image-data chunk. */
function idatChunk(): Uint8Array {
    return pngChunk('IDAT', ascii('fake-image-data-payload'));
}
/** Empty end chunk. */
function iendChunk(): Uint8Array {
    return pngChunk('IEND', new Uint8Array(0));
}
/** Assemble a PNG from chunks (signature prepended). */
function buildPng(chunks: Uint8Array[]): Uint8Array {
    return concat([PNG_SIGNATURE, ...chunks]);
}

/** Build one JPEG segment: FF marker + 2-byte big-endian length (self-inclusive) + payload. */
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + payload.length);
    const view = new DataView(out.buffer);
    out[0] = 0xff;
    out[1] = marker;
    view.setUint16(2, payload.length + 2, false);
    out.set(payload, 4);
    return out;
}

const JPEG_SOI = new Uint8Array([0xff, 0xd8]);
/** SOS marker + fake entropy-coded data + EOI — the untouchable tail. */
const JPEG_SOS_TAIL = concat([
    new Uint8Array([0xff, 0xda]),
    ascii('entropy-coded-scan-data'),
    new Uint8Array([0xff, 0xd9])
]);
/** Assemble a JPEG from parts. */
function buildJpeg(parts: Uint8Array[]): Uint8Array {
    return concat(parts);
}

// Frequently reused segment payloads.
const APP0_JFIF = jpegSegment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const DQT = jpegSegment(0xdb, ascii('fake-quantization-table'));
const SOF0 = jpegSegment(0xc0, ascii('fake-frame-header'));
const ICC_PAYLOAD = bytes('ICC_PROFILE\0', [0, 1], 'fake-profile-bytes');
const C2PA_PAYLOAD =
    bytes('JP', [0, 0], [0, 0, 0, 32], 'jumb', 'c2pa-manifest-junk');

// ── Detection (inspectAttachmentMetadata) ────────────────────────────────────

interface DetectCase {
    name: string;
    bytes: Uint8Array;
    ext: string;
    kinds: AttachmentFindingKind[];
    detailContains?: string;
}

const detectCases: DetectCase[] = [
    {
        name: 'png tEXt chunk',
        bytes: buildPng([ihdrChunk(), pngChunk('tEXt', ascii('Comment\0a plain text chunk')), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: ['png-text'],
        detailContains: '"Comment"'
    },
    {
        name: 'png iTXt chunk',
        bytes: buildPng([ihdrChunk(), pngChunk('iTXt', bytes('Title', new Uint8Array(5), 'x')), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: ['png-text'],
        detailContains: '"Title"'
    },
    {
        name: 'png zTXt chunk',
        bytes: buildPng([
            ihdrChunk(),
            pngChunk('zTXt', bytes('Author\0', [0], 'deflate-blob')),
            idatChunk(),
            iendChunk()
        ]),
        ext: 'png',
        kinds: ['png-text'],
        detailContains: '"Author"'
    },
    {
        name: 'png eXIf chunk',
        bytes: buildPng([ihdrChunk(), pngChunk('eXIf', ascii('Exif\0\0II*\0payload')), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: ['png-exif-chunk']
    },
    {
        name: 'png tIME chunk',
        bytes: buildPng([ihdrChunk(), pngChunk('tIME', new Uint8Array([0x07, 0xe6, 1, 15, 10, 30, 0])), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: ['png-timestamp'],
        detailContains: '2022-01-15'
    },
    {
        name: 'png iCCP chunk (reported, never stripped)',
        bytes: buildPng([ihdrChunk(), pngChunk('iCCP', bytes('ICC Profile\0', [0], 'zlib')), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: ['icc'],
        detailContains: 'ICC Profile'
    },
    {
        name: 'clean png (no metadata)',
        bytes: buildPng([ihdrChunk(), idatChunk(), iendChunk()]),
        ext: 'png',
        kinds: []
    },
    {
        name: 'jpeg APP1 Exif',
        bytes: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xe1, bytes('Exif\0\0', 'tiff-payload')), JPEG_SOS_TAIL]),
        ext: 'jpg',
        kinds: ['exif']
    },
    {
        name: 'jpeg APP1 XMP',
        bytes: buildJpeg([
            JPEG_SOI,
            APP0_JFIF,
            jpegSegment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta/>')),
            JPEG_SOS_TAIL
        ]),
        ext: 'jpg',
        kinds: ['xmp']
    },
    {
        name: 'jpeg APP1 extended-XMP variant',
        bytes: buildJpeg([
            JPEG_SOI,
            APP0_JFIF,
            jpegSegment(0xe1, bytes('http://ns.adobe.com/xmp/extension/\0', 'extended-blob')),
            JPEG_SOS_TAIL
        ]),
        ext: 'jpeg',
        kinds: ['xmp']
    },
    {
        name: 'jpeg APP2 JUMBF/C2PA',
        bytes: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xe2, C2PA_PAYLOAD), JPEG_SOS_TAIL]),
        ext: 'jpg',
        kinds: ['c2pa'],
        detailContains: 'C2PA'
    },
    {
        name: 'jpeg APP13 Photoshop/IPTC',
        bytes: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xed, bytes('Photoshop 3.0\0', '8BIM-payload')), JPEG_SOS_TAIL]),
        ext: 'jpg',
        kinds: ['iptc']
    },
    {
        name: 'jpeg COM comment',
        bytes: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xfe, ascii('Created by a camera')), JPEG_SOS_TAIL]),
        ext: 'jpg',
        kinds: ['comment'],
        detailContains: 'Created by a camera'
    },
    {
        name: 'jpeg APP2 ICC profile (reported, never stripped)',
        bytes: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xe2, ICC_PAYLOAD), JPEG_SOS_TAIL]),
        ext: 'jpg',
        kinds: ['icc']
    }
];

describe('inspectAttachmentMetadata — detection', () => {
    for (const c of detectCases) {
        it(`detects ${c.name}`, () => {
            const report = inspectAttachmentMetadata(c.bytes, c.ext);
            expect(report).not.toBeNull();
            expect(report!.ext).toBe(c.ext);
            expect(report!.findings.map((f) => f.kind)).toEqual(c.kinds);
            if (c.detailContains) {
                expect(report!.findings.some((f) => f.detail?.includes(c.detailContains!))).toBe(true);
            }
        });
    }

    it('detects every metadata kind in one combined jpeg, in file order', () => {
        const everything = buildJpeg([
            JPEG_SOI,
            APP0_JFIF,
            jpegSegment(0xe1, bytes('Exif\0\0', 'tiff-payload')),
            jpegSegment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta/>')),
            jpegSegment(0xe2, ICC_PAYLOAD),
            jpegSegment(0xe2, C2PA_PAYLOAD),
            jpegSegment(0xed, bytes('Photoshop 3.0\0', '8BIM-payload')),
            jpegSegment(0xfe, ascii('a comment')),
            DQT,
            SOF0,
            JPEG_SOS_TAIL
        ]);
        const report = inspectAttachmentMetadata(everything, 'jpeg')!;
        expect(report.findings.map((f) => f.kind)).toEqual(['exif', 'xmp', 'icc', 'c2pa', 'iptc', 'comment']);
    });

    it('returns null for unsupported extensions', () => {
        for (const ext of ['webp', 'gif', 'bmp', 'txt', '']) {
            expect(inspectAttachmentMetadata(buildPng([ihdrChunk(), idatChunk(), iendChunk()]), ext)).toBeNull();
        }
    });

    it('normalizes dotted / uppercase extensions', () => {
        const png = buildPng([ihdrChunk(), idatChunk(), iendChunk()]);
        expect(inspectAttachmentMetadata(png, '.PNG')?.ext).toBe('png');
        expect(inspectAttachmentMetadata(png, ' PNG ')?.ext).toBe('png');
    });
});

// ── Stripping (stripAttachmentMetadata) ──────────────────────────────────────

describe('stripAttachmentMetadata — removes metadata and re-parses clean', () => {
    interface StripCase {
        name: string;
        dirty: Uint8Array;
        clean: Uint8Array;
        ext: string;
        strippedKinds: AttachmentFindingKind[];
    }

    /** ICC color-profile chunk — kept byte-for-byte on strip (png mirror of the JPEG ICC survival test). */
    const iccpChunk = pngChunk('iCCP', bytes('ICC Profile\0', [0], 'zlib-profile-bytes'));

    const cases: StripCase[] = [
        {
            name: 'png with text + exif + timestamp + icc chunks',
            dirty: buildPng([
                ihdrChunk(),
                pngChunk('tEXt', ascii('Comment\0drop me')),
                pngChunk('eXIf', ascii('exif-payload')),
                pngChunk('tIME', new Uint8Array([0x07, 0xe6, 1, 15, 10, 30, 0])),
                iccpChunk,
                idatChunk(),
                iendChunk()
            ]),
            clean: buildPng([ihdrChunk(), iccpChunk, idatChunk(), iendChunk()]),
            ext: 'png',
            strippedKinds: ['png-text', 'png-exif-chunk', 'png-timestamp']
        },
        {
            name: 'jpeg with exif + xmp + iptc + comment segments',
            dirty: buildJpeg([
                JPEG_SOI,
                APP0_JFIF,
                jpegSegment(0xe1, bytes('Exif\0\0', 'tiff-payload')),
                jpegSegment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta/>')),
                jpegSegment(0xed, bytes('Photoshop 3.0\0', '8BIM-payload')),
                jpegSegment(0xfe, ascii('a comment')),
                DQT,
                SOF0,
                JPEG_SOS_TAIL
            ]),
            clean: buildJpeg([JPEG_SOI, APP0_JFIF, DQT, SOF0, JPEG_SOS_TAIL]),
            ext: 'jpg',
            strippedKinds: ['exif', 'xmp', 'iptc', 'comment']
        },
        {
            name: 'jpeg with c2pa/jumbf segment',
            dirty: buildJpeg([JPEG_SOI, APP0_JFIF, jpegSegment(0xe2, C2PA_PAYLOAD), JPEG_SOS_TAIL]),
            clean: buildJpeg([JPEG_SOI, APP0_JFIF, JPEG_SOS_TAIL]),
            ext: 'jpg',
            strippedKinds: ['c2pa']
        }
    ];

    for (const c of cases) {
        it(`strips ${c.name}`, () => {
            const result = stripAttachmentMetadata(c.dirty, c.ext);
            expect(result.stripped.map((f) => f.kind)).toEqual(c.strippedKinds);
            // Output is byte-for-byte identical to a hand-built clean image.
            expect(Array.from(result.bytes)).toEqual(Array.from(c.clean));
            // And it re-inspects with no strippable findings.
            const re = inspectAttachmentMetadata(result.bytes, c.ext);
            expect(re!.findings.filter((f) => f.kind !== 'icc')).toEqual([]);
        });
    }

    it('reports byteLengths matching the actual size reduction', () => {
        const dirty = buildPng([
            ihdrChunk(),
            pngChunk('tEXt', ascii('Comment\0drop me')),
            idatChunk(),
            iendChunk()
        ]);
        const result = stripAttachmentMetadata(dirty, 'png');
        const removed = result.stripped.reduce((sum, f) => sum + f.byteLength, 0);
        expect(dirty.length - result.bytes.length).toBe(removed);
        expect(removed).toBeGreaterThan(0);
    });

    it('keeps ICC profiles byte-for-byte while stripping neighbours', () => {
        const iccSegment = jpegSegment(0xe2, ICC_PAYLOAD);
        const dirty = buildJpeg([
            JPEG_SOI,
            APP0_JFIF,
            jpegSegment(0xe1, bytes('Exif\0\0', 'tiff-payload')),
            iccSegment,
            JPEG_SOS_TAIL
        ]);
        const result = stripAttachmentMetadata(dirty, 'jpg');
        expect(result.stripped.map((f) => f.kind)).toEqual(['exif']);
        // The ICC segment survives untouched inside the output.
        const out = Array.from(result.bytes);
        const icc = Array.from(iccSegment);
        expect(out.length).toBeGreaterThanOrEqual(icc.length);
        const idx = inspectAttachmentMetadata(result.bytes, 'jpg')!.findings.find((f) => f.kind === 'icc');
        expect(idx).toBeDefined();
        // Verify the exact ICC bytes appear in the output.
        let found = false;
        for (let i = 0; i <= out.length - icc.length; i++) {
            if (icc.every((b, j) => out[i + j] === b)) {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });

    it('returns a fresh copy (not the input reference) when nothing strips', () => {
        const png = buildPng([ihdrChunk(), idatChunk(), iendChunk()]);
        const result = stripAttachmentMetadata(png, 'png');
        expect(result.stripped).toEqual([]);
        expect(result.bytes).not.toBe(png);
        expect(Array.from(result.bytes)).toEqual(Array.from(png));
    });
});

// ── Malformed input (bail-out policy) ────────────────────────────────────────

describe('attachment metadata — malformed input bails out without throwing', () => {
    interface MalformedCase {
        name: string;
        bytes: Uint8Array;
        ext: string;
    }

    const cases: MalformedCase[] = [
        { name: 'png with a chunk length overrunning the file', bytes: buildPng([ihdrChunk()]).slice(0, 16), ext: 'png' },
        { name: 'png truncated before IEND', bytes: buildPng([ihdrChunk(), idatChunk(), iendChunk()]).slice(0, -10), ext: 'png' },
        { name: 'png signature only', bytes: PNG_SIGNATURE, ext: 'png' },
        { name: 'jpeg without SOI', bytes: buildJpeg([APP0_JFIF, JPEG_SOS_TAIL]).slice(2), ext: 'jpg' },
        { name: 'jpeg with a segment length overrunning the file', bytes: buildJpeg([JPEG_SOI, jpegSegment(0xe1, ascii('Exif\0\0truncated'))]).slice(0, 8), ext: 'jpg' },
        { name: 'jpeg that never reaches SOS', bytes: buildJpeg([JPEG_SOI, jpegSegment(0xfe, ascii('lone comment'))]), ext: 'jpg' },
        { name: 'empty input', bytes: new Uint8Array(0), ext: 'png' },
        { name: 'tiny input', bytes: new Uint8Array([1, 2, 3]), ext: 'jpg' }
    ];

    for (const c of cases) {
        it(`bails on ${c.name}`, () => {
            expect(() => inspectAttachmentMetadata(c.bytes, c.ext)).not.toThrow();
            const report = inspectAttachmentMetadata(c.bytes, c.ext);
            expect(report!.findings).toEqual([]);

            expect(() => stripAttachmentMetadata(c.bytes, c.ext)).not.toThrow();
            const result = stripAttachmentMetadata(c.bytes, c.ext);
            expect(result.stripped).toEqual([]);
            expect(result.bytes).not.toBe(c.bytes);
            expect(Array.from(result.bytes)).toEqual(Array.from(c.bytes));
        });
    }

    it('ignores garbage signature bytes — the png signature is never verified, just kept verbatim', () => {
        // A bad signature + well-formed chunks walks clean (the walk starts at
        // offset 8), so this is a no-findings pass, not the bail-out path.
        const png = concat([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), ihdrChunk(), iendChunk()]);
        expect(() => inspectAttachmentMetadata(png, 'png')).not.toThrow();
        expect(inspectAttachmentMetadata(png, 'png')!.findings).toEqual([]);

        expect(() => stripAttachmentMetadata(png, 'png')).not.toThrow();
        const result = stripAttachmentMetadata(png, 'png');
        expect(result.stripped).toEqual([]);
        expect(result.bytes).not.toBe(png);
        expect(Array.from(result.bytes)).toEqual(Array.from(png));
    });

    it('bails on unsupported extensions for strip too', () => {
        const webp = ascii('RIFF0000WEBPVP8 ');
        const result = stripAttachmentMetadata(webp, 'webp');
        expect(result.stripped).toEqual([]);
        expect(Array.from(result.bytes)).toEqual(Array.from(webp));
    });
});
