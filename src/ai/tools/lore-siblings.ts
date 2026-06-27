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

        const entries = scanLorebook(plugin.app, plugin.settings.lorebookFolders, plugin.settings.lorebookFolderTypes);
        if (entries.length === 0) {
            return 'Lorebook folders are configured but contain no markdown entries yet.';
        }

        const typeFilter = parseTypeFilter(typeof args.type === 'string' ? args.type : '');
        const filtered = typeFilter === null ? entries : entries.filter((e) => e.type === typeFilter);
        if (filtered.length === 0) {
            const label = typeFilter === null ? '' : ` of type "${LORE_TYPE_LABELS[typeFilter]}"`;
            return `No lore entries${label} found.`;
        }

        return filtered.map(formatEntry).join('\n');
    }
};

/**
 * Parse the optional type filter. Returns `null` for empty/unrecognized args
 * (treat as "all types" rather than erroring — the model may pass an empty
 * string to mean "no filter").
 */
function parseTypeFilter(args: string): LoreEntryType | null {
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) return null;
    const validTypes: LoreEntryTypeOrUntyped[] = [
        'character',
        'location',
        'event',
        'item',
        'faction',
        'plot-thread',
        'theme'
    ];
    return (validTypes as string[]).includes(trimmed) ? (trimmed as LoreEntryType) : null;
}

function formatEntry(entry: {
    fileBasename: string;
    type: LoreEntryTypeOrUntyped;
    aliases: string[];
    folder: string;
}): string {
    const aliases = entry.aliases.length > 0 ? ` (aliases: ${entry.aliases.join(', ')})` : '';
    return `- ${entry.fileBasename} [${LORE_TYPE_LABELS[entry.type]}] — ${entry.folder}${aliases}`;
}
