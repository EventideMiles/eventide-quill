import { normalizePath, TFile } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { describeBatchFit } from './context-helpers';

/**
 * Calculate the total size of specific files (from any folder). Use when
 * you're targeting individual files across multiple folders — e.g., 2 from
 * Characters, 5 from Locations, 3 from Events — and need to know whether
 * they all fit in one batch.
 *
 * Returns fit guidance measured against the REMAINING context (the live
 * conversation is already consuming part of the window), like measure_folder.
 */
export const calculateFileSizesTool: Tool = {
    id: 'calculate_file_sizes',
    description:
        'Calculate the total size of specific files across the vault. Use when ' +
        'you are targeting individual files from multiple folders and need to ' +
        'know whether they all fit in one batch. Returns per-file sizes, total ' +
        'tokens, and how much of the REMAINING context (after the current ' +
        'conversation) the batch would use.',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of vault-relative paths or note names to measure.'
            }
        },
        required: ['paths']
    },
    maxResultTokens: 400,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const rawPaths = args.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
            return 'Error: "paths" must be a non-empty array of file paths.';
        }

        const { plugin } = ctx;
        const details: string[] = [];
        let totalChars = 0;
        let found = 0;

        for (const rawPath of rawPaths) {
            if (typeof rawPath !== 'string') continue;
            const query = rawPath.trim();
            if (!query) continue;

            const normalized = normalizePath(query);
            let file = plugin.app.vault.getAbstractFileByPath(normalized);
            if (!(file instanceof TFile)) {
                const dest = plugin.app.metadataCache.getFirstLinkpathDest(query, '');
                file = dest instanceof TFile ? dest : null;
            }

            if (!(file instanceof TFile)) {
                details.push(`- ${query}: NOT FOUND`);
                continue;
            }

            const content = await plugin.app.vault.cachedRead(file);
            totalChars += content.length;
            found++;
            details.push(`- ${file.path} (${content.length.toLocaleString()} chars)`);
        }

        if (found === 0) return 'None of the specified files were found in the vault.';

        const estTokens = Math.ceil(totalChars / 4);
        const consumed = ctx.consumedTokens?.() ?? 0;

        const lines = [
            `${found} files, ${totalChars.toLocaleString()} chars, ~${estTokens.toLocaleString()} tokens.`,
            ...describeBatchFit(estTokens, plugin, consumed, found),
            '',
            ...details
        ];

        return lines.join('\n');
    }
};
