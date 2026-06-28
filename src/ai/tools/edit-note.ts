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
        'Propose a change to an existing note that is NOT currently open in the editor. ' +
        'The note opens in a new tab with the change shown as a diff; the writer reviews ' +
        'and approves or rejects it AFTER you finish. For the file the writer currently ' +
        'has open, recommend Direct or Fulfill mode instead. Two modes: ' +
        '(1) REPLACE — pass old_text (the SMALLEST excerpt that uniquely identifies the ' +
        'section) and new_text (its replacement). old_text must match character-for-character ' +
        'and be unique in the note. Do NOT pass the whole file. ' +
        '(2) INSERT — pass anchor (an exact excerpt already in the note) and new_text ' +
        '(the content to add); new_text is inserted right after the anchor, or before it ' +
        'with position: "before". The anchor is KEPT — nothing is replaced — so use this ' +
        'to add a new section, paragraph, or line without any risk of clobbering existing ' +
        'text. Include any needed line breaks in new_text.',
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
                    'REPLACE mode: the SMALLEST excerpt that uniquely identifies the section to change ' +
                    '(one sentence, one paragraph, or a heading + its body). Must match character-for-character ' +
                    'and be unique. Omit to use INSERT mode.'
            },
            new_text: {
                type: 'string',
                description:
                    'REPLACE: the replacement for old_text. INSERT: the content to add (include any line breaks).'
            },
            anchor: {
                type: 'string',
                description:
                    'INSERT mode: an exact excerpt already in the note. new_text is inserted right after it ' +
                    '(or before it, with position). The anchor is kept, nothing is replaced. Must be unique. ' +
                    'Omit to use REPLACE mode.'
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
        // Distinguish an absent new_text (error) from an explicit empty string
        // (valid in REPLACE mode — deletes the old_text excerpt entirely).
        if (args.new_text === undefined) {
            return 'Error: "new_text" is required.';
        }
        const newText = typeof args.new_text === 'string' ? args.new_text : '';
        if (!oldText && !anchor) {
            return (
                'Error: provide "old_text" (to replace an excerpt) or "anchor" ' +
                '(to insert without replacing anything).'
            );
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
