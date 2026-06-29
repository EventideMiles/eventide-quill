import type { Tool, ToolContext } from './tool';
import { openNoteForEdit, pushLoreEditDiff, resolveNoteFile } from './lore-edit-helpers';

/**
 * Revise the CONTENT of a pending lore edit already proposed to a note (via
 * `edit_note` / `insert_note` / `append_to_note`) — without changing WHERE it
 * applies. The target edit is identified by the numeric id returned when it
 * was proposed (or named in an overlap error).
 *
 * The escape hatch for the overlap guard: when a new proposal would overlap a
 * pending edit, the guard rejects it and names the pending edit id. Instead of
 * picking a disjoint range, the model calls `revise_edit` with that id and the
 * FULL desired text of the combined edit — placing the new content at whatever
 * point reads best within it. The edit's location (`old_text` for `edit_note`,
 * anchor line for `insert_note`, end offset for `append_to_note`) is unchanged;
 * only the inserted/replacement text is replaced.
 *
 * Only pending edits can be revised. Approved/rejected edits are immutable.
 */
export const reviseEditTool: Tool = {
    id: 'revise_edit',
    description:
        'Revise the CONTENT of a pending edit you already proposed to a note (from edit_note / ' +
        'insert_note / append_to_note), without changing where it applies. Use this when a new change ' +
        'you want to make OVERLAPS an existing pending edit on the same note — the overlap error names ' +
        'the pending edit id; fold your new content into that edit by emitting its FULL new text here ' +
        '(you decide where the new content goes within it). Pass path (the note), edit_id (the id from ' +
        'the original proposal result or the overlap error), and new_text = the complete desired content ' +
        'of that edit. The edit location is unchanged; only the inserted/replacement text is replaced. ' +
        'Only pending edits can be revised.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Vault-relative path or note name of the note the pending edit targets.'
            },
            edit_id: {
                type: 'integer',
                description:
                    'The id of the pending edit to revise. This is the id returned when the edit was first ' +
                    'proposed, or the id named in an overlap error.'
            },
            new_text: {
                type: 'string',
                description:
                    'The FULL new content for that edit — the entire inserted/replacement text is replaced ' +
                    'with this. Place any new content at the position that reads best; the tool does not ' +
                    'splice for you.'
            }
        },
        required: ['path', 'edit_id', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const editId = typeof args.edit_id === 'number' && Number.isInteger(args.edit_id) ? args.edit_id : null;
        const newText = typeof args.new_text === 'string' ? args.new_text : '';

        if (!path) return 'Error: "path" is required.';
        if (editId === null) return 'Error: "edit_id" is required and must be an integer.';
        // new_text must be a string. An explicit empty string is valid (it turns
        // the edit into a pure deletion); non-string values are rejected.
        if (typeof args.new_text !== 'string') {
            return 'Error: "new_text" is required and must be a string.';
        }

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const session = plugin.coWriterSession;
        const entry = session.loreEdits.get(file.path);
        if (!entry) return `Error: no pending edits for "${file.basename}".`;

        const edit = entry.changeSet.get(editId);
        if (!edit) {
            return `Error: edit id ${editId} not found on "${file.basename}". The id may belong to a different note, or the edit was already resolved.`;
        }
        if (edit.state !== 'pending') {
            return `Error: edit id ${editId} on "${file.basename}" is already ${edit.state} and can no longer be revised.`;
        }

        // Open the note (reusing the existing review tab) before mutating so a
        // failure to open bails out with the edit unchanged.
        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" to refresh the diff; the edit was not changed.`;
        if (!opened.wasAlreadyOpen) {
            session.loreEditOpenedByTool.add(file.path);
        }

        // Replace the content in place; the location and originalText are
        // unchanged. The length delta is recomputed at approve time, so later
        // edits' offset remapping stays correct.
        entry.changeSet.updateText(editId, newText);
        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        return `Revised pending edit id ${editId} on "${file.basename}". The diff now shows the updated content; the writer can approve or reject it. Continue with your response.`;
    }
};
