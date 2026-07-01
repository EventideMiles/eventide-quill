import { scanLorebook } from '../../core/dashboard/lorebook-scanner';
import { LORE_TYPE_LABELS } from '../../core/dashboard/lorebook-types';
import type { LoreEntryType, LoreEntryTypeOrUntyped } from '../../core/dashboard/lorebook-types';
import type { Tool, ToolContext } from './tool';

/**
 * List existing lore entries that may be relevant context for the entry
 * currently being developed. Use this to keep new entries consistent with
 * established canon (e.g., check whether a sibling character's backstory
 * conflicts with the one you're drafting).
 *
 * Source: `scanLorebook()` over `plugin.settings.lorebookFolders` — the same
 * scan the Lorebook sidebar tab uses, so results agree with what the writer
 * sees in the UI.
 */
export const loreSiblingsTool: Tool = {
    id: 'lore_siblings',
    description:
        'List existing lore entries across all configured lorebook folders, ' +
        'optionally filtered by type. Use to check sibling entries for ' +
        'consistency (e.g., other characters when drafting a character). ' +
        'Returns names, types, and aliases.',
    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['character', 'location', 'event', 'item', 'faction', 'plot-thread', 'theme'],
                description: 'Optional entry type to filter by. Omit to list every typed entry.'
            }
        }
    },
    maxResultTokens: 800,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const { plugin } = ctx;
        if (plugin.settings.lorebookFolders.length === 0) {
            return 'No lorebook folders are configured. Add at least one folder in settings → lorebook.';
        }

        const entries = scanLorebook(
            plugin.app,
            plugin.settings.lorebookFolders,
            plugin.settings.lorebookFolderTypes,
            plugin.settings.loreEntryImageSectionHeaders,
            plugin.settings.loreEntryImageMaxPerEntry
        );
        if (entries.length === 0) {
            return 'Lorebook folders are configured but contain no markdown entries yet.';
        }

        const typeFilter = parseTypeFilter(typeof args.type === 'string' ? args.type : '');
        if (typeFilter.kind === 'invalid') {
            return (
                `Error: "${typeFilter.raw}" is not a recognized entry type. ` +
                'Valid types: character, location, event, item, faction, plot-thread, theme.'
            );
        }
        // No-filter path returns only typed entries — untyped notes clutter
        // sibling context without adding canon to compare against.
        const filtered =
            typeFilter.kind === 'none'
                ? entries.filter((e) => e.type !== 'untyped')
                : entries.filter((e) => e.type === typeFilter.type);
        if (filtered.length === 0) {
            const label = typeFilter.kind === 'type' ? ` of type "${LORE_TYPE_LABELS[typeFilter.type]}"` : '';
            return `No lore entries${label} found.`;
        }

        return filtered.map(formatEntry).join('\n');
    }
};

/**
 * Parse the optional type filter into three distinct outcomes:
 *   - `{ kind: 'none' }`     → empty input: no filter (caller lists typed entries).
 *   - `{ kind: 'invalid' }`  → unrecognized input: caller errors rather than
 *                              falling back to returning everything.
 *   - `{ kind: 'type' }`     → a recognized type: caller filters to that type.
 */
type TypeFilterResult = { kind: 'none' } | { kind: 'invalid'; raw: string } | { kind: 'type'; type: LoreEntryType };

function parseTypeFilter(args: string): TypeFilterResult {
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) return { kind: 'none' };
    const validTypes: LoreEntryTypeOrUntyped[] = [
        'character',
        'location',
        'event',
        'item',
        'faction',
        'plot-thread',
        'theme'
    ];
    return (validTypes as string[]).includes(trimmed)
        ? { kind: 'type', type: trimmed as LoreEntryType }
        : { kind: 'invalid', raw: args.trim() };
}

function formatEntry(entry: {
    fileBasename: string;
    type: LoreEntryTypeOrUntyped;
    aliases: string[];
    folder: string;
    images?: { label: string }[];
}): string {
    const aliases = entry.aliases.length > 0 ? ` (aliases: ${entry.aliases.join(', ')})` : '';
    // Surface labeled image availability so the model knows it can call
    // `get_lore_image` for this entry. Labels are listed with per-label
    // counts (mirroring `stripGallerySections`'s marker format) so the
    // model knows when an entry has multiple images under one label and
    // can pass `index` to fetch a specific one.
    let images = '';
    if (entry.images && entry.images.length > 0) {
        images = ` (images: ${describeImageLabels(entry.images)})`;
    }
    return `- ${entry.fileBasename} [${LORE_TYPE_LABELS[entry.type]}] — ${entry.folder}${aliases}${images}`;
}

/**
 * Build the `(images: …)` summary for `lore_siblings`. Each label appears
 * once with a `(N)` count suffix when it has more than one image, mirroring
 * `stripGallerySections`'s marker format and the error text in
 * `get_lore_image` so all three surfaces agree on how multi-image labels
 * are advertised. Unlabeled images (embeds directly under the gallery
 * heading, no subheading) group under `(unlabeled)`.
 */
function describeImageLabels(imgs: { label: string }[]): string {
    const counts = new Map<string, number>();
    for (const img of imgs) {
        const k = img.label || '(unlabeled)';
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => (n === 1 ? name : `${name} (${n})`)).join(', ');
}
