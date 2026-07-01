import { downscaleToJpegBase64 } from '../image-utils';
import { scanLorebook } from '../../core/dashboard/lorebook-scanner';
import type { LoreEntryImage } from '../../core/dashboard/lorebook-types';
import type { Tool, ToolContext, ToolResult } from './tool';

/**
 * Fetch reference image(s) attached to a lore entry. Use whenever a lore
 * entry has images — you'll see them via `lore_siblings` (the trailing
 * `(images: …)` list — labels carry counts so e.g. "Reference (2)" means
 * two images under that label) OR via `vault_lookup` (![[file.png]] embeds
 * in the body, plus the appended hint). Returns the image bytes; the chat
 * model sees them directly when vision-capable, or the configured image
 * model describes them when it isn't.
 *
 * Selection (combinable):
 *   - Omit `label` AND `index` → return EVERY image attached to the entry.
 *   - `label` only → return every image under that label.
 *   - `index` only → return the Nth image of the entry (1-based across
 *     all labels, in document order).
 *   - `label` + `index` → return the Nth image under that label.
 *
 * Default (no args) returns all images so the model can see the whole
 * gallery — single-image calls left a multi-image entry's second image
 * unreachable. Use `index` when the count suffix `(N)` shows duplicates
 * under one label and you only need a specific one. Source: the lorebook
 * scanner (`scanLorebook`) over `plugin.settings.lorebookFolders`,
 * restricted to entries with a recognized gallery section. The gallery
 * section's recognized headings come from
 * `plugin.settings.loreEntryImageSectionHeaders`. Images are downscaled to
 * `lorebookImageMaxDimension` before delivery.
 */
export const getLoreImageTool: Tool = {
    id: 'get_lore_image',
    description:
        'Fetch one or more reference images attached to a lore entry so you can ' +
        'actually see them. Pass the entry name (matches the file basename or ' +
        'any alias). By default returns EVERY image attached to the entry — ' +
        'this is the recommended call so multi-image galleries are fully ' +
        'visible. Narrow with `label` (every image under one subheading) ' +
        'and/or `index` (1-based position within the label-filtered set). ' +
        'You see the bytes directly when vision-capable, or the configured ' +
        'image model describes them. Use whenever you see images are ' +
        'available (from lore_siblings or from a vault_lookup hint) — do not ' +
        'guess visual details from filenames or context when you can fetch the pixels.',
    parameters: {
        type: 'object',
        properties: {
            entry: {
                type: 'string',
                description:
                    'Lore entry name — matches the file basename or any alias ' +
                    '(case-insensitive). Use the exact name `lore_siblings` returned.'
            },
            label: {
                type: 'string',
                description:
                    'Optional label to restrict the returned images to one ' +
                    'subheading (e.g., "Default form", "Alternate form"). Must ' +
                    'match a label from the `(images: …)` list `lore_siblings` ' +
                    'returned. When omitted, images across all labels are ' +
                    'considered (and returned if `index` is also omitted).'
            },
            index: {
                type: 'number',
                description:
                    'Optional 1-based position of the specific image to fetch ' +
                    'within the (optionally label-filtered) set, in document ' +
                    'order. Use when an entry has multiple images under one ' +
                    'label (the `(images: …)` count suffix shows how many). ' +
                    'Out of range is an error. When omitted, every matching ' +
                    'image is returned in one call.'
            }
        },
        required: ['entry']
    },
    maxResultTokens: 200,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const { plugin } = ctx;
        const entryQuery = typeof args.entry === 'string' ? args.entry.trim() : '';
        if (!entryQuery) {
            return { text: 'Error: "entry" is required. Pass the lore entry name (e.g., "Sarah Connor").' };
        }
        const labelQuery = typeof args.label === 'string' ? args.label.trim().toLowerCase() : '';
        const rawIndex = args.index;
        // Reject non-integer index values rather than silently flooring them.
        // A decimal (1.5) or non-finite (NaN/Infinity) is a model error; treating
        // it as "return all" would be surprising. Only accept true integers.
        const indexQuery =
            typeof rawIndex === 'number' && Number.isFinite(rawIndex) && Number.isInteger(rawIndex) ? rawIndex : null;

        if (plugin.settings.lorebookFolders.length === 0) {
            return { text: 'No lorebook folders are configured.' };
        }

        const entries = scanLorebook(
            plugin.app,
            plugin.settings.lorebookFolders,
            plugin.settings.lorebookFolderTypes,
            plugin.settings.loreEntryImageSectionHeaders,
            plugin.settings.loreEntryImageMaxPerEntry
        );

        const entry = findEntryByQuery(entries, entryQuery);
        if (!entry) {
            return { text: `No lore entry matching "${entryQuery}" was found in the lorebook.` };
        }
        if (entry.images.length === 0) {
            return {
                text:
                    `Entry "${entry.fileBasename}" has no images in a recognized gallery section. ` +
                    'Add an image under a heading like "## Reference" or "## Gallery" to attach one.'
            };
        }

        const candidates = filterByLabel(entry.images, labelQuery);
        if (candidates.length === 0) {
            const requested = typeof args.label === 'string' ? args.label : '';
            return {
                text: `Entry "${entry.fileBasename}" has no image labeled "${requested}". Available: ${describeLabels(entry.images)}.`
            };
        }

        const selected = pickImages(candidates, indexQuery);
        if (!selected) {
            const requested = indexQuery !== null ? `index ${indexQuery}` : 'the requested index';
            return {
                text:
                    `Entry "${entry.fileBasename}" has no image at ${requested} ` +
                    `(label-filtered set has ${candidates.length} image${candidates.length === 1 ? '' : 's'}). ` +
                    `Available: ${describeLabels(candidates)}.`
            };
        }

        const allMissing = selected.every((img) => !img.file);
        if (allMissing) {
            const names = selected.map((m) => m.filename).join(', ');
            return {
                text:
                    `Image${selected.length === 1 ? '' : 's'} "${names}" referenced in "${entry.fileBasename}" ` +
                    'but the file is missing from the vault. Re-add the attachment or remove the embed.'
            };
        }

        const loaded: { image: LoreEntryImage; base64: string }[] = [];
        const errors: string[] = [];
        for (const image of selected) {
            if (!image.file) continue;
            try {
                const bytes = await plugin.app.vault.readBinary(image.file);
                const contentType = inferContentType(image.filename);
                const base64 = await downscaleToJpegBase64(
                    bytes,
                    plugin.settings.lorebookImageMaxDimension,
                    contentType
                );
                loaded.push({ image, base64 });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`"${image.filename}": ${msg}`);
            }
        }

        if (loaded.length === 0) {
            return {
                text: `Error reading image(s) from "${entry.fileBasename}": ${errors.join('; ')}`
            };
        }

        const summaryParts = loaded.map(({ image }) => {
            const labelPart = image.label ? ` (label: ${image.label})` : '';
            const captionPart = image.caption ? ` (caption: ${image.caption})` : '';
            return `"${image.filename}"${labelPart}${captionPart}`;
        });
        const summary =
            loaded.length === 1
                ? `Loaded image ${summaryParts[0]} from "${entry.fileBasename}".`
                : `Loaded ${loaded.length} images from "${entry.fileBasename}": ${summaryParts.join(', ')}.`;
        const errorTail = errors.length > 0 ? ` Errors: ${errors.join('; ')}.` : '';
        return {
            text: summary + errorTail,
            images: loaded.map((l) => l.base64)
        };
    }
};

/**
 * Find the first lore entry whose basename OR any alias matches `query`,
 * case-insensitively. Basename match takes priority; alias match is the
 * fallback so nicknames ("Connie") resolve to the canonical entry ("Sarah
 * Connor") when aliases are present.
 */
function findEntryByQuery(
    entries: { fileBasename: string; aliases: string[] }[],
    query: string
): { fileBasename: string; aliases: string[]; images: LoreEntryImage[] } | null {
    const needle = query.toLowerCase();
    for (const e of entries) {
        if (e.fileBasename.toLowerCase() === needle)
            return e as { fileBasename: string; aliases: string[]; images: LoreEntryImage[] };
    }
    for (const e of entries) {
        if (e.aliases.some((a) => a.toLowerCase() === needle)) {
            return e as { fileBasename: string; aliases: string[]; images: LoreEntryImage[] };
        }
    }
    // Substring fallback — catches "Sarah" matching "Sarah Connor".
    for (const e of entries) {
        if (e.fileBasename.toLowerCase().includes(needle)) {
            return e as { fileBasename: string; aliases: string[]; images: LoreEntryImage[] };
        }
    }
    return null;
}

/**
 * Restrict to images whose label (lowercased, trimmed) matches `labelQuery`.
 * Empty `labelQuery` returns the input unchanged. The public "(unlabeled)"
 * value (shown in lore_siblings, error messages, and stripGallerySections
 * markers) round-trips: if the model passes `"(unlabeled)"`, it matches
 * images whose raw label is empty. Always preserves document order so
 * `index` is stable across calls.
 */
function filterByLabel(images: LoreEntryImage[], labelQuery: string): LoreEntryImage[] {
    if (!labelQuery) return images;
    // Normalize the public display value back to the raw empty-string form
    // so the model can pass "(unlabeled)" and get the right images.
    const normalized = labelQuery === '(unlabeled)' ? '' : labelQuery;
    return images.filter((i) => i.label.trim().toLowerCase() === normalized);
}

/**
 * Apply the optional 1-based `indexQuery` to a label-filtered image set.
 * `null` index → return every candidate (default-all behavior). A positive
 * integer returns the Nth candidate. Out-of-range (`<= 0` or `> length`)
 * returns `null` so the caller can surface an "available" hint.
 */
function pickImages(candidates: LoreEntryImage[], indexQuery: number | null): LoreEntryImage[] | null {
    if (indexQuery === null) return candidates;
    if (indexQuery <= 0 || indexQuery > candidates.length) return null;
    const img = candidates[indexQuery - 1];
    return img ? [img] : null;
}

/**
 * Human-readable summary of available labels with per-label counts, mirroring
 * the format `lore_siblings` and `stripGallerySections` produce, so error
 * messages stay consistent with the advertising surfaces.
 */
function describeLabels(images: LoreEntryImage[]): string {
    const counts = new Map<string, number>();
    for (const img of images) {
        const k = img.label || '(unlabeled)';
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => (n === 1 ? name : `${name} (${n})`)).join(', ');
}

/** Infer a MIME type from the filename extension for the downscale decoder. */
function inferContentType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    return 'image/jpeg';
}
