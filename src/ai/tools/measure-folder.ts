import { normalizePath } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { getMaxContextTokens, tokenPercent } from './context-helpers';

/**
 * Measure the total size of all markdown files in a folder (including
 * subfolders). Returns file count, total characters, estimated tokens,
 * per-file sizes, and what percentage of the context window the folder
 * would consume — so the model can decide instantly whether to batch
 * everything at once or split.
 *
 * Call this BEFORE a batch edit. The percentage tells you immediately
 * whether the folder fits: under ~60% = safe to process all at once.
 */
export const measureFolderTool: Tool = {
    id: 'measure_folder',
    description:
        'Measure the total size of all markdown files in a folder (including ' +
        'subfolders). Returns file count, total characters, estimated tokens, ' +
        'per-file sizes, and what percentage of the context window it would use. ' +
        'Call this BEFORE any batch edit to decide whether everything fits at once.',
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
        const maxTokens = getMaxContextTokens(plugin);
        const pct = tokenPercent(estTokens, maxTokens);

        const lines = [
            `${folderPath || '(vault root)'} — ${folderFiles.length} files, ${totalChars.toLocaleString()} chars, ~${estTokens.toLocaleString()} tokens`,
            `(${pct} of ${maxTokens.toLocaleString()}-token context window)`,
            ...details
        ];

        if (pct && !isNaN(parseInt(pct))) {
            const pctNum = parseInt(pct);
            if (pctNum <= 60) {
                lines.push(`\nAll ${folderFiles.length} files fit comfortably in a single batch.`);
            } else if (pctNum <= 80) {
                lines.push(`\nFits in one batch but leaves little room — minimize text in your response.`);
            } else {
                const half = Math.ceil(folderFiles.length / 2);
                lines.push(`\nToo large for one batch (${pctNum}%). Split: process ~${half} files per batch.`);
            }
        }

        return lines.join('\n');
    }
};
