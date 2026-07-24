import type { Tool, ToolContext } from './tool';
import { readNoteContent, resolveNoteFile } from './lore-edit-helpers';
import { findParagraphByStart, stageEdit } from './edit-note';

/**
 * Remove an entire paragraph from a note. The paragraph opens as a red inline
 * diff (deletion) that the writer approves or rejects. The tool does NOT write
 * to the file — the writer must click "Approve" to commit the deletion.
 *
 * Two ways to target the paragraph:
 * 1. paragraph_start = the first 5-10 words (objective, recommended for local models)
 * 2. old_text = the exact paragraph text (for when the model can reproduce it)
 *
 * Uses the same paragraph-finding and staging logic as edit_note, but with an
 * empty new_text (pure deletion). The review card shows the removed text in red.
 */
export const deleteParagraphTool: Tool = {
    id: 'delete_paragraph',
    description:
        'Remove an entire paragraph from a note. The deletion opens as a red inline diff ' +
        '(the writer approves or rejects it). Pass paragraph_start = the first 5-10 words ' +
        'of the paragraph to delete, OR old_text = the exact paragraph text. Use this when ' +
        'a paragraph should be cut entirely (redundant, off-topic, or broken). For ' +
        'REPLACING a paragraph with new text, use edit_note instead.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description:
                    'Vault-relative path or note name (e.g., "Chapter 1" or "Lore/Characters/Sarah Connor.md").'
            },
            paragraph_start: {
                type: 'string',
                description:
                    'The first 5-10 words of the paragraph to delete. The tool finds the ' +
                    'matching paragraph in the file and removes it. Use this when you cannot ' +
                    'reproduce the full paragraph verbatim.'
            },
            old_text: {
                type: 'string',
                description:
                    'The exact text of the paragraph to delete, copied verbatim from the note. ' +
                    'Omit if using paragraph_start instead.'
            }
        },
        required: ['path']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const paragraphStart = typeof args.paragraph_start === 'string' ? args.paragraph_start.trim() : '';
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';

        if (!path) return 'Error: "path" is required.';
        if (!paragraphStart && !oldText) {
            return 'Error: either "paragraph_start" or "old_text" is required.';
        }

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        // If paragraph_start was provided, find the paragraph by its opening
        // words and read the ACTUAL text from the file.
        if (paragraphStart) {
            const found = findParagraphByStart(content, paragraphStart);
            if (!found) {
                return (
                    `Error: could not find a paragraph starting with words similar to ` +
                    `"${paragraphStart.slice(0, 60)}" in "${file.path}". Try vault_lookup ` +
                    `to read the file, then use the exact opening words.`
                );
            }
            const actualText = content.slice(found.from, found.to);
            // Stage as a deletion: new_text is empty.
            return stageEdit(file, content, actualText, '', ctx);
        }

        // old_text path: try to find and delete.
        return stageEdit(file, content, oldText, '', ctx);
    }
};
