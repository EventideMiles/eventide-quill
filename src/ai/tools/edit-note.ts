import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, pushLoreEditDiff, readNoteContent, resolveNoteFile } from './lore-edit-helpers';

/**
 * Propose a replacement to an existing note. The model provides the exact
 * `old_text` to find and the `new_text` to replace it with. The note is opened
 * in a new tab and the edit is surfaced as a green inline diff (same review UX
 * as Direct/Fulfill/Transform) so the writer can approve or reject it in context.
 *
 * Multiple pending edits to the same file coexist (each surfaces as its own
 * review card); edits to different files are independent.
 *
 * The tool does NOT write to the file. The writer must click "Approve" to
 * commit the edit or "Reject" to discard it. For adding content without
 * removing anything (a new section or detail), use `insert_note` instead.
 */
export const editNoteTool: Tool = {
    id: 'edit_note',
    description:
        'Propose a find-and-replace change to a note that is NOT currently open (it opens ' +
        'in a new tab as a diff; the writer approves or rejects it after you finish). For ' +
        'the open file, recommend Direct or Fulfill mode instead. Pass old_text = the ' +
        'exact text to remove, copied verbatim (a phrase, a sentence, or a whole ' +
        'paragraph — whatever you are replacing) and new_text = the replacement. Use this ' +
        'whenever you are changing, rephrasing, or rewriting existing wording, including a ' +
        'full paragraph. To ADD content without removing anything, use `insert_note` ' +
        'instead; to add at the END of a note, use `append_to_note`. old_text must be ' +
        'character-for-character and unique in the note; never pass the whole file as ' +
        'old_text.',
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
                    'The exact text to remove, copied verbatim from the note. May be a phrase, ' +
                    'sentence, or whole paragraph — whatever you are replacing. Must be ' +
                    'character-for-character and unique.'
            },
            new_text: {
                type: 'string',
                description: 'The replacement for old_text (include any line breaks).'
            }
        },
        required: ['path', 'old_text', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';

        if (!path) return 'Error: "path" is required.';
        if (!oldText) return 'Error: "old_text" is required.';
        // new_text must be a string. An explicit empty string is valid (it
        // deletes the old_text excerpt); any other non-string value is rejected
        // rather than coerced to '' (which would silently produce an unintended
        // empty edit).
        if (typeof args.new_text !== 'string') {
            return 'Error: "new_text" is required and must be a string.';
        }
        const newText = args.new_text;

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        // Find the excerpt to replace — a replace range [from, to).
        const idx = content.indexOf(oldText);
        if (idx === -1) {
            const preview = content.slice(0, 300).trim();
            return `Error: old_text not found in "${file.path}". The note starts with:\n${preview}${content.length > 300 ? '\n...' : ''}`;
        }
        if (content.indexOf(oldText, idx + 1) !== -1) {
            return `Error: old_text matches multiple places in "${file.path}". Pass a larger excerpt that uniquely identifies the section to change.`;
        }
        const from = idx;
        const to = idx + oldText.length;

        // Open the note and push the diff.
        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" for review.`;

        const session = plugin.coWriterSession;
        if (!opened.wasAlreadyOpen) {
            session.loreEditOpenedByTool.add(file.path);
        }
        // Edits accumulate per file. Offsets are in original-document coordinates
        // because lore edits are proposed, never applied, until the writer
        // approves — so concurrent proposals don't shift each other's ranges.
        const entry = session.getOrCreateLoreEdit(file.path, file.basename);

        entry.changeSet.add({
            from,
            to,
            newText,
            label: `Edit ${file.basename}`,
            originalText: oldText
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        return `Edit proposed for "${file.basename}". The writer will see the diff and can approve or reject it. Continue with your response.`;
    }
};
