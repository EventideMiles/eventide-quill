import type { Tool, ToolContext } from './tool';
import {
    buildNotFoundHint,
    findTextInContent,
    hasAdditionalMatch,
    openNoteForEdit,
    overlapError,
    pushLoreEditDiff,
    readNoteContent,
    resolveNoteFile
} from './lore-edit-helpers';
import { checkAiIsms } from '../ai-ism-detector';

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
        'Propose a find-and-replace change to any note (opens as an inline diff; the writer ' +
        'approves or rejects it after you finish). Pass old_text = the exact text to REMOVE ' +
        'from the note (it is deleted; new_text takes its place), copied verbatim (a phrase, ' +
        'a sentence, or a whole paragraph — whatever you are replacing) and new_text = the ' +
        'replacement. CAUTION: old_text is removed from the note when the edit is approved — ' +
        'if you misidentify old_text, the wrong text gets deleted. If your goal is to ADD ' +
        'content without removing anything, you are in the wrong tool: use `insert_note` ' +
        'instead (zero-width insertion that CANNOT delete or overwrite by construction), or ' +
        '`append_to_note` to add at the end. Use edit_note only for genuine rewording — ' +
        'changing, rephrasing, or rewriting existing wording. old_text must be ' +
        'character-for-character and unique in the note. Keep old_text to just the excerpt ' +
        'being replaced (the whole file is too large to match uniquely).',
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
                description:
                    'CRITICAL: Before writing, study 2-3 sentences surrounding old_text. Mirror ' +
                    'the writer\u2019s exact sentence length, vocabulary level, punctuation habits, ' +
                    'and descriptive density. Only use sensory words (smells, textures, sounds) the ' +
                    'writer has already established in the surrounding text. The result must be ' +
                    'indistinguishable from the writer\u2019s own prose. Common AI tells to avoid: em ' +
                    'dashes, invented atmospheric details, and words like ozone, tapestry, delve.'
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

        // AI-ism check: reject the call if the proposed text contains writing
        // tells (em dashes, cliché words, purple constructions). The error
        // message tells the model exactly what to fix.
        const aiIsmError = checkAiIsms(newText);
        if (aiIsmError) return aiIsmError;

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const content = await readNoteContent(plugin, file.path);
        if (content === null) return `Error: could not read "${file.path}".`;

        // Find the excerpt to replace — a replace range [from, to).
        // Try exact match first, then fall back to whitespace-insensitive
        // matching so the model's old_text succeeds even when its indentation
        // or line wrapping differs slightly from the file.
        const match = findTextInContent(content, oldText);
        if (!match) {
            const hint = buildNotFoundHint(content, oldText);
            return `Error: old_text not found in "${file.path}". ${hint}`;
        }
        const { from, to } = match;

        // Uniqueness check: if the matched text (or a whitespace variant of it)
        // appears elsewhere, the model needs to provide a larger excerpt.
        if (hasAdditionalMatch(content, oldText, from, to)) {
            return `Error: old_text matches multiple places in "${file.path}". Pass a larger excerpt that uniquely identifies the section to change.`;
        }

        // Reject overlaps BEFORE opening a tab, so a conflicting proposal
        // doesn't spawn a review tab. Keeps pending edits on a file pairwise
        // disjoint — the invariant that makes any approval order safe.
        const existingEntry = plugin.coWriterSession.loreEdits.get(file.path);
        const conflict = existingEntry ? overlapError(existingEntry.changeSet, from, to) : null;
        if (conflict) return conflict;

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

        const created = entry.changeSet.add({
            from,
            to,
            newText,
            label: `Edit ${file.basename}`,
            originalText: oldText
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path, plugin.app);
        session.onLoreEditUpdate?.();

        return `Edit proposed for "${file.basename}" (edit id ${created.id}). The writer will see the diff and can approve or reject it. Continue with your response.`;
    }
};
