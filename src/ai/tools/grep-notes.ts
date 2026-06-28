import { normalizePath } from 'obsidian';
import type { Tool, ToolContext } from './tool';

/**
 * Search for text across vault files (grep). Returns matching files, line
 * numbers, and short excerpts so the model can find where a character, place,
 * or topic is mentioned without reading every file individually.
 *
 * Scope: optionally limit to a folder. Only searches .md files. Caps at
 * 20 matches per file and 10 files total to keep the result manageable.
 */
export const grepNotesTool: Tool = {
    id: 'grep_notes',
    description:
        'Search for text across vault files. Returns matching files, line ' +
        'numbers, and excerpts. Use to find where a character, location, or ' +
        'topic is mentioned without reading every file. Optionally limit to ' +
        'a folder.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Text to search for (case-insensitive).'
            },
            folder: {
                type: 'string',
                description: 'Optional folder to limit the search scope (e.g., "Lore/Characters").'
            }
        },
        required: ['query']
    },
    maxResultTokens: 800,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const folderRaw = typeof args.folder === 'string' ? args.folder.trim() : '';

        if (!query) return 'Error: "query" is required.';

        const { plugin } = ctx;
        const folderPrefix = folderRaw ? `${normalizePath(folderRaw)}/` : '';
        const allFiles = plugin.app.vault.getMarkdownFiles();
        const scoped = folderPrefix ? allFiles.filter((f) => f.path.startsWith(folderPrefix)) : allFiles;

        if (scoped.length === 0) {
            return folderRaw ? `No markdown files in "${folderRaw}".` : 'No markdown files in the vault.';
        }

        const needle = query.toLowerCase();
        const MAX_MATCHES_PER_FILE = 20;
        const MAX_FILES = 10;
        const results: string[] = [];
        let filesWithMatches = 0;

        for (const file of scoped) {
            // Respect cancellation so an aborted request stops reading files.
            if (ctx.signal?.aborted) break;
            if (filesWithMatches >= MAX_FILES) break;

            const content = await plugin.app.vault.cachedRead(file);
            const lines = content.split('\n');
            const matches: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                if (matches.length >= MAX_MATCHES_PER_FILE) break;
                if (lines[i]!.toLowerCase().includes(needle)) {
                    const excerpt = lines[i]!.trim().slice(0, 120);
                    matches.push(`  L${i + 1}: ${excerpt}`);
                }
            }

            if (matches.length > 0) {
                filesWithMatches++;
                results.push(`- ${file.path} (${matches.length} match${matches.length === 1 ? '' : 'es'}):`);
                results.push(...matches);
            }
        }

        if (results.length === 0) {
            return `No matches for "${query}"${folderRaw ? ` in "${folderRaw}"` : ''}.`;
        }

        const header = `Found "${query}" in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'}${folderRaw ? ` (scoped to "${folderRaw}")` : ''}:`;
        return [header, ...results].join('\n');
    }
};
