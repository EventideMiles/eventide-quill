import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, pushLoreEditDiff, readNoteContent, resolveNoteFile } from './lore-edit-helpers';

/**
 * Propose an edit to an existing note. The model provides the exact `old_text`
 * to find and the `new_text` to replace it with. The note is opened in a new
 * tab and the edit is surfaced as a green inline diff (same review UX as
 * Direct/Fulfill/Transform) so the writer can approve or reject it in context.
 *
 * Only one pending lore edit is allowed at a time — calling this again while
 * a prior edit is pending replaces it (the prior edit is cleared from the diff).
 *
 * The tool does NOT write to the file. The writer must click "Approve" to
 * commit the edit or "Reject" to discard it.
 */
export const editNoteTool: Tool = {
    id: 'edit_note',
    description:
        'Propose an edit to an existing note that is NOT currently open in the editor. ' +
        'The note opens in a new tab with the change shown as a diff. The writer reviews ' +
        'and approves or rejects it. Provide the exact old_text to find and the new_text ' +
        'to replace it with. For the file the writer currently has open, recommend they ' +
        'use Direct or Fulfill mode instead — those stream changes live.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description:
                    'Vault-relative path or note name (e.g., "Lore/Characters/Sarah Connor.md" or "Sarah Connor").'
            },
            old_text: {
                type: 'string',
                description:
                    'The exact text to find in the note. Must match character-for-character (case-sensitive, including whitespace).'
            },
            new_text: {
                type: 'string',
                description: 'The replacement text.'
            }
        },
        required: ['path', 'old_text', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        const newText = typeof args.new_text === 'string' ? args.new_text : '';

        if (!path) return 'Error: "path" is required.';
        if (!oldText) return 'Error: "old_text" is required.';
        if (newText === '')
            return 'Error: "new_text" is required (use empty string explicitly to delete, but the field must be present).';

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        const idx = content.indexOf(oldText);
        if (idx === -1) {
            // Help the model recover: show what's actually in the note.
            const preview = content.slice(0, 300).trim();
            return `Error: old_text not found in "${file.path}". The note starts with:\n${preview}${content.length > 300 ? '\n...' : ''}`;
        }

        // Open the note and push the diff.
        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" for review.`;

        const session = plugin.coWriterSession;
        if (!opened.wasAlreadyOpen) {
            session.loreEditOpenedByTool.add(file.path);
        }
        // One edit per file at a time — clearing the file's own ChangeSet
        // doesn't affect edits pending for other files.
        const entry = session.getOrCreateLoreEdit(file.path, file.basename);
        entry.changeSet.clear();

        entry.changeSet.add({
            from: idx,
            to: idx + oldText.length,
            newText,
            label: `Edit ${file.basename}`,
            originalText: oldText
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        return `Edit proposed for "${file.basename}". The writer will see the diff and can approve or reject it. Continue with your response.`;
    }
};
