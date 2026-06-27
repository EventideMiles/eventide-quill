import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, pushLoreEditDiff, readNoteContent, resolveNoteFile } from './lore-edit-helpers';

/**
 * Propose appending content to the end of an existing note. The note opens
 * in a new tab with the appended content shown as a green inline diff. The
 * writer reviews and approves or rejects it.
 *
 * Only one pending lore edit at a time — clears any prior pending edit.
 */
export const appendToNoteTool: Tool = {
    id: 'append_to_note',
    description:
        'Propose appending content to the end of an existing note. The note ' +
        'opens in a new tab with the new content shown as a diff. The writer ' +
        'reviews and approves or rejects it.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Vault-relative path or note name.'
            },
            content: {
                type: 'string',
                description: 'The content to append to the end of the note.'
            }
        },
        required: ['path', 'content']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const content = typeof args.content === 'string' ? args.content : '';

        if (!path) return 'Error: "path" is required.';
        if (!content) return 'Error: "content" is required.';

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const existing = await readNoteContent(plugin, file.path);
        if (existing === null) return `Error: could not read "${file.path}".`;

        // Ensure a blank line between existing content and the append.
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '';
        const newText = sep + content;

        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" for review.`;

        const session = plugin.coWriterSession;
        session.loreEditChanges.clear();
        session.loreEditPath = file.path;

        session.loreEditChanges.add({
            from: existing.length,
            to: existing.length,
            newText,
            label: `Append to ${file.basename}`,
            originalText: ''
        });

        pushLoreEditDiff(opened.cm, session.loreEditChanges);
        session.onLoreEditUpdate?.();

        return `Append proposed for "${file.basename}". The writer will see the new content as a diff and can approve or reject it.`;
    }
};
