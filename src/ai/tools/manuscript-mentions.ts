import { extractAllEntities } from '../../core/context-engine';
import type { ExtractedEntity } from '../../core/context-engine/types';
import type { Tool, ToolContext } from './tool';

/**
 * Find every mention of an entity (character, location, or plot thread) in
 * the active manuscript. Returns occurrence count, line numbers, and known
 * aliases.
 *
 * Source priority:
 *   1. `plugin.currentManuscriptEntities` (cached from the last dashboard
 *      refresh — shared with the Dashboard and Lorebook coverage views).
 *   2. If the cache is empty, extract on the fly from the active document.
 *
 * Matching is case-insensitive substring against the entity's name OR any
 * of its aliases, so the model can pass a nickname ("Connie") and match the
 * canonical entity ("Sarah Connor") when aliases are present.
 */
export const manuscriptMentionsTool: Tool = {
    id: 'manuscript_mentions',
    description:
        'Find every mention of an entity in the active manuscript. ' +
        'Returns occurrence count, line numbers, and known aliases. ' +
        'Matches against entity names AND aliases (case-insensitive). ' +
        'Pass an empty name to list every entity the extractor found.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Entity name or alias to search for (e.g., "Sarah Connor"). Case-insensitive.'
            }
        }
    },
    maxResultTokens: 500,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const rawName = args.name;
        const name = typeof rawName === 'string' ? rawName.trim() : '';

        const entities = await resolveEntities(ctx);
        if (entities.length === 0) {
            return (
                'No manuscript entities available — the dashboard has not been scanned for this ' +
                'manuscript yet. Call `refresh_dashboard` (pass a manuscript or chapter file path, ' +
                'or call it with a manuscript file already open) to load the manuscript context, ' +
                'then retry manuscript_mentions.'
            );
        }

        // Empty name → list all entities (the prompt is "show me what we're working with").
        if (!name) {
            return `Entities found in the manuscript (${entities.length} total):\n${entities
                .filter((e) => !e.removed)
                .map(formatEntity)
                .join('\n')}`;
        }

        const needle = name.toLowerCase();
        const matches = entities.filter(
            (e) =>
                !e.removed &&
                (e.name.toLowerCase().includes(needle) || e.aliases.some((a) => a.toLowerCase().includes(needle)))
        );

        if (matches.length === 0) {
            return `No entity matching "${name}" was found in the manuscript.`;
        }

        return matches.map(formatEntity).join('\n');
    }
};

/**
 * Resolve the entity list to query. Prefer the dashboard's cached entities
 * (shared with the Lorebook coverage view); fall back to a single-file
 * extraction when no dashboard refresh has run for this session.
 */
async function resolveEntities(ctx: ToolContext): Promise<ExtractedEntity[]> {
    const cached = ctx.plugin.currentManuscriptEntities;
    if (cached.length > 0) return cached;

    const activeFile = ctx.plugin.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') return [];

    const text = await ctx.plugin.app.vault.cachedRead(activeFile);
    return extractAllEntities(text);
}

function formatEntity(e: ExtractedEntity): string {
    const lines = e.lines.length > 0 ? ` at line${e.lines.length === 1 ? '' : 's'} ${e.lines.join(', ')}` : '';
    const aliases = e.aliases.length > 0 ? `; aliases: ${e.aliases.join(', ')}` : '';
    const occ = `${e.occurrences} occurrence${e.occurrences === 1 ? '' : 's'}`;
    return `${e.name} (${e.type}): ${occ}${lines}${aliases}`;
}
