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
import type { TFile } from 'obsidian';

/**
 * Find a paragraph in the content whose opening words match `startPhrase`.
 * Uses word-overlap matching on the first ~15 words of each paragraph
 * (case-insensitive), so the model only needs to reproduce a few words
 * accurately — not the entire paragraph.
 *
 * Returns the paragraph's character range [from, to), or null if no
 * paragraph matches above the threshold.
 */
function findParagraphByStart(content: string, startPhrase: string): { from: number; to: number } | null {
    const phraseWords = [
        ...new Set(
            startPhrase
                .toLowerCase()
                .split(/\s+/)
                .filter((w) => w.length > 2)
        )
    ];
    if (phraseWords.length < 3) return null;

    // Split content into paragraphs with offsets.
    const paragraphs: { text: string; from: number; to: number }[] = [];
    let paraStart = 0;
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n' && i + 1 < content.length && content[i + 1] === '\n') {
            const text = content.slice(paraStart, i);
            if (text.trim()) paragraphs.push({ text, from: paraStart, to: i });
            paraStart = i + 2;
            i++;
        }
    }
    const lastText = content.slice(paraStart);
    if (lastText.trim()) paragraphs.push({ text: lastText, from: paraStart, to: content.length });

    let bestScore = 0;
    let bestPara: { from: number; to: number } | null = null;

    for (const para of paragraphs) {
        // Take the opening of the paragraph (roughly the same length as the
        // start phrase) and score by word overlap.
        const openLen = Math.min(para.text.length, startPhrase.length * 2);
        const paraOpen = para.text.slice(0, openLen).toLowerCase();
        let score = 0;
        for (const word of phraseWords) {
            if (paraOpen.includes(word)) score++;
        }
        const ratio = score / phraseWords.length;
        if (ratio > bestScore) {
            bestScore = ratio;
            bestPara = { from: para.from, to: para.to };
        }
    }

    // Threshold: 50% of the opening-phrase words must appear in the
    // paragraph's opening. Low threshold because we're matching a SHORT
    // phrase (5-10 words), and even a quantized model usually gets most
    // of the opening words right.
    if (bestPara && bestScore >= 0.5) return bestPara;
    return null;
}

/**
 * Stage a single edit (find + uniqueness + overlap + stage + diff).
 * Extracted so it can be called from both the old_text path and the
 * paragraph_start path.
 */
async function stageEdit(
    file: TFile,
    content: string,
    oldText: string,
    newText: string,
    ctx: ToolContext
): Promise<string> {
    const { plugin } = ctx;
    const match = findTextInContent(content, oldText);
    if (!match) {
        const hint = buildNotFoundHint(content, oldText);
        return `Error: old_text not found in "${file.path}". ${hint}`;
    }
    if (hasAdditionalMatch(content, oldText, match.from, match.to)) {
        return `Error: old_text matches multiple places in "${file.path}". Pass a larger excerpt.`;
    }
    const existingEntry = plugin.coWriterSession.loreEdits.get(file.path);
    const conflict = existingEntry ? overlapError(existingEntry.changeSet, match.from, match.to) : null;
    if (conflict) return conflict;

    const opened = await openNoteForEdit(plugin.app, file.path);
    if (!opened) return `Error: could not open "${file.path}" for review.`;

    const session = plugin.coWriterSession;
    if (!opened.wasAlreadyOpen) {
        session.loreEditOpenedByTool.add(file.path);
    }
    const entry = session.getOrCreateLoreEdit(file.path, file.basename);
    const created = entry.changeSet.add({
        from: match.from,
        to: match.to,
        newText,
        label: `Edit ${file.basename}`,
        originalText: oldText
    });
    pushLoreEditDiff(opened.cm, entry.changeSet, file.path, plugin.app);
    session.onLoreEditUpdate?.();
    return `Edit proposed for "${file.basename}" (edit id ${created.id}). The writer will see the diff and can approve or reject it.`;
}

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
        'approves or rejects it after you finish). Two ways to target the text:\n' +
        '1. old_text = the exact text to replace (character-for-character from the file).\n' +
        '2. paragraph_start = the first 5-10 words of the paragraph you want to rewrite. ' +
        'Use this when you cannot reproduce the full paragraph verbatim. The tool finds ' +
        'the paragraph by its opening words and reads the actual text from the file.\n' +
        'In both cases, new_text = your rewritten version. edit_note REMOVES the old text ' +
        'and replaces it. For ADDING without removing, use insert_note instead.',
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
                    'The exact text to remove, copied verbatim from the note. Omit if using ' +
                    'paragraph_start instead. Must be unique in the note.'
            },
            paragraph_start: {
                type: 'string',
                description:
                    'The first 5-10 words of the paragraph you want to rewrite. Use this ' +
                    'when you cannot reproduce the full paragraph verbatim (common with ' +
                    'local models). The tool finds the matching paragraph in the file and ' +
                    'uses the file\u2019s actual text as the edit target.'
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
        required: ['path', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        const paragraphStart = typeof args.paragraph_start === 'string' ? args.paragraph_start.trim() : '';

        if (!path) return 'Error: "path" is required.';
        if (!oldText && !paragraphStart) {
            return 'Error: either "old_text" or "paragraph_start" is required.';
        }
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

        // If paragraph_start was provided, find the paragraph by its opening
        // words and read the ACTUAL text from the file. This bypasses the
        // need for the model to reproduce the full paragraph verbatim.
        if (paragraphStart) {
            const found = findParagraphByStart(content, paragraphStart);
            if (!found) {
                return (
                    `Error: could not find a paragraph starting with words similar to ` +
                    `"${paragraphStart.slice(0, 60)}" in "${file.path}". Try vault_lookup ` +
                    `to read the file, then use the exact opening words.`
                );
            }
            // Use the file's actual paragraph text as old_text — 100% accurate.
            const actualOldText = content.slice(found.from, found.to);
            return stageEdit(file, content, actualOldText, newText, ctx);
        }

        // old_text path: determine edit units (auto-split multi-paragraph).
        // If old_text spans multiple paragraphs AND new_text has the same
        // paragraph count, auto-split into paragraph-level edits.
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
