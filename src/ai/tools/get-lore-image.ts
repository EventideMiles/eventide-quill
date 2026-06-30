import { downscaleToJpegBase64 } from '../image-utils';
import { scanLorebook } from '../../core/dashboard/lorebook-scanner';
import type { LoreEntryImage } from '../../core/dashboard/lorebook-types';
import type { Tool, ToolContext, ToolResult } from './tool';

/**
 * Fetch a reference image attached to a lore entry. Use whenever a lore
 * entry has images — you'll see them via `lore_siblings` (the trailing
 * `(images: …)` list) OR via `vault_lookup` (![[file.png]] embeds in the
 * body, plus the appended hint). Returns the image bytes; the chat model
 * sees them directly when vision-capable, or the configured image model
 * describes them when it isn't.
 *
 * Pass a specific `label` (e.g., "Alternate form") to pick one form from a
 * multi-form entry. Omit `label` to fetch the entry's first image.
 *
 * Source: the lorebook scanner (`scanLorebook`) over
 * `plugin.settings.lorebookFolders`, restricted to entries with a recognized
 * gallery section. The gallery section's recognized headings come from
 * `plugin.settings.loreEntryImageSectionHeaders`. The image is downscaled to
 * `lorebookImageMaxDimension` before delivery.
 */
export const getLoreImageTool: Tool = {
    id: 'get_lore_image',
    description:
        'Fetch a reference image attached to a lore entry so you can actually ' +
        'see it. Pass the entry name (matches the file basename or any alias) ' +
        'and an optional label to pick one form from a multi-form entry (e.g., ' +
        '"Alternate form"). Returns the image bytes; you see them directly when ' +
        'vision-capable, or the configured image model describes them. Omit ' +
        "`label` for the entry's first image. Use whenever you see images are " +
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
                    'Optional label of the specific image to fetch (e.g., ' +
                    '"Default form", "Alternate form"). Must match a label from ' +
                    "the `(images: …)` list. Omit for the entry's first image."
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

        const image = pickImage(entry.images, labelQuery);
        if (!image) {
            const available = entry.images.map((i) => i.label || '(unlabeled)').join(', ');
            const requested = typeof args.label === 'string' ? args.label : '';
            return {
                text: `Entry "${entry.fileBasename}" has no image labeled "${requested}". Available: ${available}.`
            };
        }
        if (!image.file) {
            return {
                text:
                    `Image "${image.filename}" is referenced in "${entry.fileBasename}" ` +
                    'but the file is missing from the vault. Re-add the attachment or remove the embed.'
            };
        }

        try {
            const bytes = await plugin.app.vault.readBinary(image.file);
            const contentType = inferContentType(image.filename);
            const base64 = await downscaleToJpegBase64(bytes, plugin.settings.lorebookImageMaxDimension, contentType);
            const labelPart = image.label ? ` (label: ${image.label})` : '';
            const captionPart = image.caption ? ` (caption: ${image.caption})` : '';
            return {
                text: `Loaded image "${image.filename}" from "${entry.fileBasename}"${labelPart}${captionPart}.`,
                images: [base64]
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `Error reading image "${image.filename}": ${msg}` };
        }
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
 * Pick the image to return. When `labelQuery` is empty, returns the first
 * image. Otherwise returns the first image whose label matches
 * (case-insensitive exact match).
 */
function pickImage(images: LoreEntryImage[], labelQuery: string): LoreEntryImage | null {
    if (!labelQuery) return images[0] ?? null;
    return images.find((i) => i.label.trim().toLowerCase() === labelQuery) ?? null;
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
