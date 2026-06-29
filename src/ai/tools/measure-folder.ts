import { normalizePath } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { describeBatchFit } from './context-helpers';

/**
 * Measure the total size of all markdown files in a folder (including
 * subfolders). Returns file count, total characters, estimated tokens,
 * per-file sizes, and whether the folder fits a single batch.
 *
 * Fit is measured against the REMAINING context — the live conversation is
 * already consuming part of the window, so the batch must fit what's left.
 *
 * Call this BEFORE a batch edit. Under ~60% of remaining = safe to process
 * all at once.
 */
export const measureFolderTool: Tool = {
    id: 'measure_folder',
    description:
        'Measure the total size of all markdown files in a folder (including ' +
        'subfolders). Returns file count, total characters, estimated tokens, ' +
        'per-file sizes, and how much of the REMAINING context (after the ' +
        'current conversation) the folder would use. Call this BEFORE any batch ' +
        'edit to decide whether everything fits at once.',
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
    maxResultTokens: 500,
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
        const consumed = ctx.consumedTokens?.() ?? 0;

        const lines = [
            `${folderPath || '(vault root)'} — ${folderFiles.length} files, ${totalChars.toLocaleString()} chars, ~${estTokens.toLocaleString()} tokens.`,
            ...describeBatchFit(estTokens, plugin, consumed, folderFiles.length),
            '',
            ...details
        ];

        return lines.join('\n');
    }
};
