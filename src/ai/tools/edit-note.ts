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

        // Determine edit units: if old_text spans multiple paragraphs, try to
        // auto-split into paragraph-level edits (matching old paragraphs to
        // new paragraphs by position). This avoids the model having to issue
        // separate tool calls, which it struggles with.
        const oldParas = oldText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
        const newParas = newText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

        let editPairs: { oldText: string; newText: string }[];
        if (oldParas.length > 1 && oldParas.length === newParas.length) {
            // Auto-split: pair paragraphs by position.
            editPairs = oldParas.map((old, i) => ({ oldText: old, newText: newParas[i]! }));
        } else if (oldParas.length > 1 && newParas.length === 1) {
            // Model merged paragraphs. Reject — can't auto-split new_text.
            const preview = oldParas
                .map((p, i) => {
                    const snippet = p.trim().slice(0, 50);
                    return `  ${i + 1}. "${snippet}${p.trim().length > 50 ? '...' : ''}"`;
                })
                .join('\n');
            return (
                `Error: old_text has ${oldParas.length} paragraphs but new_text has only 1. ` +
                'Keep the same paragraph structure in new_text (same number of blank-line ' +
                'breaks), or issue separate edit_note calls.\n\n' +
                `old_text paragraphs:\n${preview}`
            );
        } else {
            editPairs = [{ oldText, newText }];
        }

        // Open the note once (shared across all paragraph edits).
        const opened = await openNoteForEdit(plugin.app, file.path);
        if (!opened) return `Error: could not open "${file.path}" for review.`;

        const session = plugin.coWriterSession;
        if (!opened.wasAlreadyOpen) {
            session.loreEditOpenedByTool.add(file.path);
        }
        const entry = session.getOrCreateLoreEdit(file.path, file.basename);

        // Stage each paragraph edit independently.
        let staged = 0;
        let skipped = 0;
        const errors: string[] = [];
        for (const { oldText: editOld, newText: editNew } of editPairs) {
            const match = findTextInContent(content, editOld);
            if (!match) {
                const hint = buildNotFoundHint(content, editOld);
                errors.push(`paragraph not found: ${hint}`);
                skipped++;
                continue;
            }
            if (hasAdditionalMatch(content, editOld, match.from, match.to)) {
                errors.push('old_text matches multiple places');
                skipped++;
                continue;
            }
            const conflict = overlapError(entry.changeSet, match.from, match.to);
            if (conflict) {
                errors.push(conflict);
                skipped++;
                continue;
            }
            entry.changeSet.add({
                from: match.from,
                to: match.to,
                newText: editNew,
                label: `Edit ${file.basename}`,
                originalText: editOld
            });
            staged++;
        }

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path, plugin.app);
        session.onLoreEditUpdate?.();

        if (staged === 0) {
            return `Error: could not stage any edits for "${file.basename}". ${errors.join('; ')}`;
        }
        if (editPairs.length === 1) {
            return `Edit proposed for "${file.basename}" (edit id ${entry.changeSet.edits[entry.changeSet.edits.length - 1]?.id}). The writer will see the diff and can approve or reject it. Continue with your response.`;
        }
        const summary = `Split into ${staged} paragraph-level edit${staged === 1 ? '' : 's'} for "${file.basename}"`;
        return skipped > 0
            ? `${summary} (${skipped} skipped). The writer will see each as a separate review card.`
            : `${summary}. The writer will see each as a separate review card.`;
    }
};
