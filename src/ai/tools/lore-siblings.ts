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
    // `get_lore_image` for this entry. Labels are listed (deduped, in order)
    // so the model can request a specific form/state by name.
    let images = '';
    if (entry.images && entry.images.length > 0) {
        const labels = entry.images
            .map((img) => img.label || '(unlabeled)')
            // De-duplicate adjacent identical labels (multiple images under
            // one subheading would otherwise repeat it).
            .filter((label, i, arr) => i === 0 || label !== arr[i - 1]);
        images = ` (images: ${labels.join(', ')})`;
    }
    return `- ${entry.fileBasename} [${LORE_TYPE_LABELS[entry.type]}] — ${entry.folder}${aliases}${images}`;
}
