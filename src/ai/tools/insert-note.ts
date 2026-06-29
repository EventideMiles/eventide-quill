import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, pushLoreEditDiff, readNoteContent, resolveNoteFile } from './lore-edit-helpers';

/**
 * Propose inserting content into an existing note without removing anything.
 * The model passes an `anchor` (an exact excerpt already in the note — it is
 * KEPT) and `new_text` spliced in right after the anchor (or before it with
 * `position: "before"`). The note opens in a new tab with the new content shown
 * as a green inline diff (same review UX as Direct/Fulfill/Transform) so the
 * writer can approve or reject it in context.
 *
 * Only one pending lore edit is allowed at a time — calling this again while
 * a prior edit is pending replaces it (the prior edit is cleared from the diff).
 *
 * The tool does NOT write to the file. The writer must click "Approve" to
 * commit the edit or "Reject" to discard it. To CHANGE existing wording, use
 * `edit_note` instead; to add content at the END of a note, use `append_to_note`.
 */
export const insertNoteTool: Tool = {
    id: 'insert_note',
    description:
        'Propose inserting new content into a note that is NOT currently open, without ' +
        'removing anything (it opens in a new tab as a diff; the writer approves or ' +
        'rejects it after you finish). For the open file, recommend Direct or Fulfill ' +
        'mode instead. Pass anchor = an exact excerpt already in the note (it is KEPT) ' +
        'and new_text = the content to add, spliced right after the anchor or before it ' +
        'with position: "before". Use this only when ADDING content with nothing to ' +
        'remove. To CHANGE or rewrite existing wording, use `edit_note` instead; to add ' +
        'at the END of a note, use `append_to_note`. anchor must be character-for-' +
        'character and unique in the note.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description:
                    'Vault-relative path or note name (e.g., "Lore/Characters/Sarah Connor.md" or "Sarah Connor").'
            },
            anchor: {
                type: 'string',
                description:
                    'An exact excerpt already in the note. The anchor is kept (nothing is ' +
                    'replaced); new_text is spliced after it (or before, via position). Must be ' +
                    'character-for-character and unique.'
            },
            new_text: {
                type: 'string',
                description: 'The content to add (include any line breaks).'
            },
            position: {
                type: 'string',
                enum: ['after', 'before'],
                description: 'Where new_text goes relative to the anchor. Default "after".'
            }
        },
        required: ['path', 'anchor', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const anchor = typeof args.anchor === 'string' ? args.anchor : '';
        const position = args.position === 'before' ? 'before' : 'after';
        const newText = typeof args.new_text === 'string' ? args.new_text : '';

        if (!path) return 'Error: "path" is required.';
        if (!anchor) return 'Error: "anchor" is required.';
        if (!newText) return 'Error: "new_text" is required.';

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        // Find the anchor and insert after (or before) it. The anchor itself is
        // never modified; new_text is spliced in at the anchor's end (after) or
        // start (before) as a pure insertion (from === to).
        const idx = content.indexOf(anchor);
        if (idx === -1) {
            const preview = content.slice(0, 300).trim();
            return `Error: anchor not found in "${file.path}". The note starts with:\n${preview}${content.length > 300 ? '\n...' : ''}`;
        }
        if (content.indexOf(anchor, idx + 1) !== -1) {
            return `Error: anchor matches multiple places in "${file.path}". Pass a larger anchor that uniquely identifies the insertion point.`;
        }
        const insertPos = position === 'before' ? idx : idx + anchor.length;

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
            from: insertPos,
            to: insertPos,
            newText,
            label: `Insert into ${file.basename}`,
            originalText: ''
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        return `Insert proposed for "${file.basename}". The writer will see the new content as a diff and can approve or reject it. Continue with your response.`;
    }
};
