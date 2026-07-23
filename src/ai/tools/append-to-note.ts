import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, overlapError, pushLoreEditDiff, readNoteContent, resolveNoteFile } from './lore-edit-helpers';

/**
 * Propose appending content to the end of an existing note. The note opens
 * in a new tab with the appended content shown as a green inline diff. The
 * writer reviews and approves or rejects it.
 *
 * Multiple pending edits to the same file coexist (each surfaces as its own
 * review card); edits to different files are independent.
 */
export const appendToNoteTool: Tool = {
    id: 'append_to_note',
    description:
        'Propose appending content to the end of any existing note. ' +
        'The note opens as an inline diff with the new content shown. The writer ' +
        'reviews and approves or rejects it AFTER you finish. ' +
        'When editing multiple files, batch your edits, flowing straight from one file to the next.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Vault-relative path or note name.'
            },
            content: {
                type: 'string',
                description:
                    'The content to append. Match the writer\u2019s existing voice and ' +
                    'punctuation. Avoid AI tells: em dashes, clich\u00e9 words (ozone, ' +
                    'neon, shimmer, tapestry, delve, traverse), and purple constructions.'
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

        // Ensure a blank line between existing content and the append. Count
        // trailing newlines so a single trailing newline still gets a gap
        // (otherwise the append would start immediately after that newline).
        let sep = '';
        if (existing.length > 0) {
            const trailing = existing.length - existing.replace(/\n+$/, '').length;
            sep = trailing >= 2 ? '' : '\n'.repeat(2 - trailing);
        }
        const newText = sep + content;
        const appendAt = existing.length;

        // Reject overlaps BEFORE opening a tab. An append targets the end of
        // the original file; it can only conflict with another pending append
        // (same zero-width point at EOF is allowed) or a pending edit whose
        // range happens to reach EOF.
        const existingEntry = plugin.coWriterSession.loreEdits.get(file.path);
        const conflict = existingEntry ? overlapError(existingEntry.changeSet, appendAt, appendAt) : null;
        if (conflict) return conflict;

        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" for review.`;

        const session = plugin.coWriterSession;
        if (!opened.wasAlreadyOpen) {
            session.loreEditOpenedByTool.add(file.path);
        }
        // Edits accumulate per file. Offsets are in original-document coordinates
        // because lore edits are proposed, never applied, until the writer approves.
        const entry = session.getOrCreateLoreEdit(file.path, file.basename);

        const created = entry.changeSet.add({
            from: appendAt,
            to: appendAt,
            newText,
            label: `Append to ${file.basename}`,
            originalText: ''
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path, plugin.app);
        session.onLoreEditUpdate?.();

        return `Append proposed for "${file.basename}" (edit id ${created.id}). The writer will see the new content as a diff and can approve or reject it.`;
    }
};
