import type { Tool, ToolContext } from './tool';
import { GLOBAL_MEMORY_SCOPE } from '../../core/memories/memory-scope';
import { readMemoryFile, resolveScopeArg } from '../../core/memories/memory-store';
import type { MemoryEntry } from '../../core/memories/memory-file';

/**
 * The `recall_memory` tool — fetches full memory bodies matching a query.
 * The auto-injected index already shows memory headings + previews; the
 * model calls this when an entry looks relevant and the full text would
 * help its response.
 *
 * MATCHING
 *
 * - `query` (optional): substring match against heading + body (case-insensitive).
 * - `tags` (optional): filter to memories with ANY of the listed tags.
 * - `scope` (optional): `'auto'` (default, active scope only), `'manuscript'`,
 *   `'global'`, or `'all'` (union of active + global).
 * - No args → returns all memories in the active scope.
 *
 * Output is capped at `memoriesRecallMaxEntries` (default 10). Each entry
 * shows the heading, the body, and the block ID (use the ID for subsequent
 * `delete_memory` calls). The format is markdown so the model can quote
 * from it directly.
 *
 * Costs roughly: `(avg body length + heading + ID) × matched entries`.
 * Memories are short, so a full recall rarely exceeds 2-3k chars.
 */
export const recallMemoryTool: Tool = {
    id: 'recall_memory',
    description:
        'Fetch the full text of one or more memories matching a query. ' +
        'The auto-injected "Memories" section of your context shows the ' +
        'index (headings + previews); call this when an entry looks ' +
        'relevant and you need the full body. Use the returned block ID ' +
        '(`^quill-mem-NNN`) for subsequent `delete_memory` calls. With no ' +
        'arguments, returns every memory in the active scope.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description:
                    'Optional substring to match against the memory heading ' +
                    'or body (case-insensitive). When omitted, all memories ' +
                    'in the target scope are returned.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional. Only memories with ANY of these tags are returned.'
            },
            scope: {
                type: 'string',
                enum: ['auto', 'manuscript', 'global', 'all'],
                description:
                    'Which memory pool to search. `auto` (default) searches ' +
                    'the active manuscript; `global` searches the global pool; ' +
                    '`all` searches both (union, active first). Use `all` ' +
                    'when you want everything that might be relevant regardless ' +
                    'of where it was saved.'
            }
        }
    },
    maxResultTokens: 2500,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const { plugin } = ctx;
        if (!plugin.settings.memoriesEnabled) {
            return 'Error: memories are disabled in settings.';
        }

        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const tagsFilter = Array.isArray(args.tags)
            ? (args.tags.filter((t) => typeof t === 'string' && t.trim()) as string[]).map((t) => t.trim().toLowerCase())
            : [];
        const scopeArg = typeof args.scope === 'string' ? args.scope : 'auto';
        const { keys, label } = resolveScopeArg(plugin, scopeArg);

        // Read each scope's file in order. Memory files are small; reading
        // both for `scope: 'all'` is cheap.
        const allMatches: { entry: MemoryEntry; scopeKey: string }[] = [];
        for (const scopeKey of keys) {
            const result = await readMemoryFile(plugin, scopeKey);
            for (const entry of result.file.entries) {
                if (matchesFilters(entry, query, tagsFilter)) {
                    allMatches.push({ entry, scopeKey });
                }
            }
        }

        if (allMatches.length === 0) {
            const where = label === 'global' ? 'global pool' : label === 'active + global' ? 'active + global pools' : `'${label}' pool`;
            return `No memories match in the ${where}.`;
        }

        const cap = Math.max(1, Math.floor(plugin.settings.memoriesRecallMaxEntries));
        const truncated = allMatches.length > cap;
        const shown = allMatches.slice(0, cap);

        const lines: string[] = [];
        lines.push(`# Recalled memories (${shown.length}${truncated ? ` of ${allMatches.length}` : ''})`);
        lines.push('');
        for (const { entry, scopeKey } of shown) {
            const scopeLabel = scopeKey === GLOBAL_MEMORY_SCOPE ? 'global' : scopeKey;
            lines.push(`## ${entry.heading}`);
            lines.push('');
            if (entry.tags.length > 0) {
                lines.push(`_tags: ${entry.tags.map((t) => `#${t}`).join(' ')}_`);
                lines.push('');
            }
            if (entry.body) {
                lines.push(entry.body);
                lines.push('');
            }
            lines.push(`^${entry.id}  — scope: ${scopeLabel}`);
            lines.push('');
        }

        if (truncated) {
            lines.push(
                `...and ${allMatches.length - cap} more (narrow your query or pass a tighter \`tags\` ` +
                    `filter to see them).`
            );
        }

        return lines.join('\n').trim();
    }
};

/** Apply the query + tags filters to an entry. Empty filters match everything. */
function matchesFilters(entry: MemoryEntry, query: string, tags: string[]): boolean {
    if (query) {
        const haystack = `${entry.heading}\n${entry.body}`.toLowerCase();
        if (!haystack.includes(query)) return false;
    }
    if (tags.length > 0) {
        const entryTags = new Set(entry.tags.map((t) => t.toLowerCase()));
        if (!tags.some((t) => entryTags.has(t))) return false;
    }
    return true;
}
