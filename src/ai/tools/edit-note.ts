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
        'Propose a change to a note that is NOT currently open (it opens in a new tab ' +
        'as a diff; the writer approves or rejects it after you finish). For the open ' +
        'file, recommend Direct or Fulfill mode instead. Two modes — ' +
        'REPLACE: old_text (the smallest excerpt that uniquely identifies the section; ' +
        'must match character-for-character) + new_text. ' +
        'INSERT: anchor (an exact excerpt already in the note — it is KEPT, nothing is ' +
        'replaced) + new_text, inserted right after the anchor or before it with ' +
        'position: "before". Never pass the whole file as old_text.',
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
                    'REPLACE mode: the smallest excerpt that uniquely identifies the section. ' +
                    'Must match character-for-character and be unique. Omit to use INSERT mode.'
            },
            new_text: {
                type: 'string',
                description:
                    'REPLACE: the replacement for old_text. INSERT: the content to add (include any line breaks).'
            },
            anchor: {
                type: 'string',
                description:
                    'INSERT mode: an exact excerpt already in the note. The anchor is kept (nothing is ' +
                    'replaced); must be unique. Omit to use REPLACE mode.'
            },
            position: {
                type: 'string',
                enum: ['after', 'before'],
                description: 'INSERT mode: where new_text goes relative to the anchor. Default "after".'
            }
        },
        required: ['path', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        const anchor = typeof args.anchor === 'string' ? args.anchor : '';
        const position = args.position === 'before' ? 'before' : 'after';

        if (!path) return 'Error: "path" is required.';
        // new_text must be a string. An explicit empty string is valid in
        // REPLACE mode (it deletes the old_text excerpt); any other non-string
        // value is rejected rather than coerced to '' (which would silently
        // produce an unintended empty edit).
        if (typeof args.new_text !== 'string') {
            return 'Error: "new_text" is required and must be a string.';
        }
        const newText = args.new_text;
        if (!oldText && !anchor) {
            return (
                'Error: provide "old_text" (to replace an excerpt) or "anchor" ' +
                '(to insert without replacing anything).'
            );
        }
        // Exactly one mode: providing both makes the intent ambiguous (the
        // REPLACE branch would otherwise win silently and drop the anchor).
        if (oldText && anchor) {
            return 'Error: provide "old_text" (REPLACE) or "anchor" (INSERT), not both.';
        }

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        // Resolve the edit range: a replace range [from, to) for REPLACE mode,
        // or a zero-width insertion point (from === to) for INSERT mode.
        let from: number;
        let to: number;
        let label: string;
        let originalText: string;

        if (oldText) {
            // REPLACE — find the excerpt to replace.
            const idx = content.indexOf(oldText);
            if (idx === -1) {
                const preview = content.slice(0, 300).trim();
                return `Error: old_text not found in "${file.path}". The note starts with:\n${preview}${content.length > 300 ? '\n...' : ''}`;
            }
            if (content.indexOf(oldText, idx + 1) !== -1) {
                return `Error: old_text matches multiple places in "${file.path}". Pass a larger excerpt that uniquely identifies the section to change.`;
            }
            from = idx;
            to = idx + oldText.length;
            label = `Edit ${file.basename}`;
            originalText = oldText;
        } else {
            // INSERT — find the anchor and insert after (or before) it. The
            // anchor itself is never modified; new_text is spliced in at the
            // anchor's end (after) or start (before) as a pure insertion.
            const idx = content.indexOf(anchor);
            if (idx === -1) {
                const preview = content.slice(0, 300).trim();
                return `Error: anchor not found in "${file.path}". The note starts with:\n${preview}${content.length > 300 ? '\n...' : ''}`;
            }
            if (content.indexOf(anchor, idx + 1) !== -1) {
                return `Error: anchor matches multiple places in "${file.path}". Pass a larger anchor that uniquely identifies the insertion point.`;
            }
            const insertPos = position === 'before' ? idx : idx + anchor.length;
            from = insertPos;
            to = insertPos;
            label = `Insert into ${file.basename}`;
            originalText = '';
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
            from,
            to,
            newText,
            label,
            originalText
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        const action = oldText ? 'Edit' : 'Insert';
        return `${action} proposed for "${file.basename}". The writer will see the diff and can approve or reject it. Continue with your response.`;
    }
};
