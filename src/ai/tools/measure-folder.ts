import { normalizePath } from 'obsidian';
import type { Tool, ToolContext } from './tool';

/**
 * Measure the total size of all markdown files in a folder (including
 * subfolders). Returns per-file character counts and a total token estimate
 * so the model can plan batching: compare the folder's token cost against the
 * context budget (injected each round) to decide how many files to handle per
 * batch.
 *
 * Prefer calling this BEFORE a batch edit so the model knows whether the
 * target folder fits in one batch or needs to be split.
 */
export const measureFolderTool: Tool = {
    id: 'measure_folder',
    description:
        'Measure the total size of all markdown files in a folder (including ' +
        'subfolders). Returns file count, total characters, estimated tokens, ' +
        'and per-file sizes. Call this before a batch edit to plan how many ' +
        'files you can handle per round.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Vault-relative folder path (e.g., "Lore/Characters").'
            }
        },
        required: ['path']
    },
    maxResultTokens: 400,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
        if (!rawPath) return 'Error: "path" is required.';
        const folderPath = normalizePath(rawPath);

        const { plugin } = ctx;
        const allFiles = plugin.app.vault.getMarkdownFiles();
        const prefix = folderPath.length > 0 ? `${folderPath}/` : '';
        const folderFiles = allFiles.filter((f) => f.path === folderPath || f.path.startsWith(prefix));

        if (folderFiles.length === 0) {
            return `No markdown files found in "${folderPath}".`;
        }

        let totalChars = 0;
        const details: string[] = [];
        for (const file of folderFiles) {
            const content = await plugin.app.vault.cachedRead(file);
            totalChars += content.length;
            details.push(`- ${file.name} (${content.length.toLocaleString()} chars)`);
        }

        const estTokens = Math.ceil(totalChars / 4);

        return [
            `${folderPath || '(vault root)'} — ${folderFiles.length} files, ${totalChars.toLocaleString()} chars, ~${estTokens.toLocaleString()} tokens:`,
            ...details
        ].join('\n');
    }
};
