import type { Tool, ToolContext } from './tool';
import {
    openNoteForEdit,
    overlapError,
    pushLoreEditDiff,
    readNoteContent,
    resolveNoteFile,
    splitFrontmatter
} from './lore-edit-helpers';

/**
 * Propose inserting content into an existing note without removing anything.
 * The model passes an `anchor` snippet and `new_text`; the tool finds the line
 * containing the anchor and splices `new_text` in relative to that *line* (not
 * the exact character), so insertions always land on a clean line boundary.
 * The note opens in a new tab with the new content shown as a green inline diff
 * (same review UX as Direct/Fulfill/Transform) so the writer can approve or
 * reject it in context.
 *
 * Matching is whitespace-tolerant and runs against the note BODY only
 * (frontmatter is stripped first), which is the view the model has of the note
 * via `vault_lookup`. The body-relative insertion offset is mapped back onto
 * the raw document, so an insert can never land inside the YAML frontmatter
 * block — even when the model anchors on the first body line.
 *
 * Multiple pending edits to the same file coexist (each surfaces as its own
 * review card); edits to different files are independent.
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
        'mode instead. Pass anchor = a distinctive snippet that identifies a LINE in ' +
        'the note (whitespace-tolerant — does not need to be byte-exact; the tool finds ' +
        'the line containing it). new_text = the content to add, placed relative to that ' +
        'whole line: position "after" (default) inserts on a new line right after it; ' +
        '"before" inserts on a new line right before it; "end_of_section" requires the ' +
        "anchor to match a heading and inserts at the END of that heading's section " +
        '(the right choice for "add a bullet/paragraph to the X section"). Use this only ' +
        'when ADDING content with nothing to remove. To CHANGE or rewrite existing ' +
        'wording, use `edit_note` instead; to add at the END of a note, use ' +
        '`append_to_note`. Frontmatter is invisible to you and is never touched.',
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
                    'A distinctive snippet from a single line in the note. The tool finds the line ' +
                    'whose text contains this snippet (whitespace-tolerant) and inserts relative to ' +
                    'that LINE. Must be unique enough to identify one line; if it matches several, ' +
                    'the tool lists them and asks for a more distinctive snippet.'
            },
            new_text: {
                type: 'string',
                description: 'The content to add (include any line breaks).'
            },
            position: {
                type: 'string',
                enum: ['after', 'before', 'end_of_section'],
                description:
                    'Where new_text goes relative to the anchor line. "after" (default): new line(s) ' +
                    'right after it. "before": new line(s) right before it. "end_of_section": the ' +
                    'anchor must match a heading; inserts at the end of that section.'
            }
        },
        required: ['path', 'anchor', 'new_text']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const anchor = typeof args.anchor === 'string' ? args.anchor : '';
        const position = args.position === 'before' || args.position === 'end_of_section' ? args.position : 'after';
        const newText = typeof args.new_text === 'string' ? args.new_text : '';

        if (!path) return 'Error: "path" is required.';
        if (!anchor) return 'Error: "anchor" is required.';
        if (!newText) return 'Error: "new_text" is required.';

        const { plugin } = ctx;
        const file = resolveNoteFile(plugin, path);
        if (!file) return `Error: note "${path}" not found in the vault.`;

        const raw = await readNoteContent(plugin, file.path);
        if (raw === null) return `Error: could not read "${file.path}".`;

        // Work in body coordinates (frontmatter-stripped) so the model's anchor
        // — derived from vault_lookup's frontmatter-stripped view — actually
        // matches, and so no insertion can ever land inside the YAML block.
        // bodyOffset is added back when mapping the insertion point onto the
        // raw document that the ChangeSet edits.
        const { bodyOffset, body } = splitFrontmatter(raw);

        const resolved = resolveInsertionOffset(body, anchor, position);
        if (typeof resolved === 'string') return resolved;

        const bodyInsertOffset = resolved;
        const finalText = padToLineBoundary(body, bodyInsertOffset, newText);
        const from = bodyOffset + bodyInsertOffset;
        const to = from;

        // Reject overlaps BEFORE opening a tab, so a conflicting proposal
        // doesn't spawn a review tab. Keeps pending edits on a file pairwise
        // disjoint — the invariant that makes any approval order safe.
        const existingEntry = plugin.coWriterSession.loreEdits.get(file.path);
        const conflict = existingEntry ? overlapError(existingEntry.changeSet, from, to) : null;
        if (conflict) return conflict;

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
            newText: finalText,
            label: `Insert into ${file.basename}`,
            originalText: ''
        });

        pushLoreEditDiff(opened.cm, entry.changeSet, file.path);
        session.onLoreEditUpdate?.();

        return `Insert proposed for "${file.basename}" (edit id ${created.id}). The writer will see the new content as a diff and can approve or reject it. Continue with your response.`;
    }
};

/** Collapse runs of whitespace to single spaces and trim, for tolerant matching. */
function normalizeWs(s: string): string {
    return s
        .replace(/\r?\n/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/** Shorten to `max` chars with an ellipsis, for compact error listings. */
function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** First ~12 lines of the body as a preview, with a trailing `...` if truncated. */
function bodyPreview(body: string): string {
    const lines = body.split('\n');
    const head = lines.slice(0, 12).join('\n').replace(/\s+$/g, '');
    return lines.length > 12 ? `${head}\n...` : head;
}

/**
 * Resolve where (in body coordinates) the insertion should go. Finds the line
 * whose normalized text contains the normalized anchor, then snaps to a line
 * boundary according to `position`. Returns a body-relative offset, or an
 * error string the tool surfaces verbatim to the model.
 */
function resolveInsertionOffset(
    body: string,
    anchor: string,
    position: 'after' | 'before' | 'end_of_section'
): number | string {
    const normAnchor = normalizeWs(anchor);
    if (!normAnchor) return 'Error: "anchor" is empty after trimming whitespace.';

    if (!body.trim()) {
        return 'Error: this note has no body content to anchor on. Use `append_to_note` to add to an empty note.';
    }

    const lines = body.split('\n');
    // Start offset of each line within `body` (each line is followed by one '\n').
    const lineStart: number[] = [];
    let cursor = 0;
    for (const line of lines) {
        lineStart.push(cursor);
        cursor += line.length + 1;
    }

    const matched: number[] = [];
    for (const [i, line] of lines.entries()) {
        if (normalizeWs(line).includes(normAnchor)) matched.push(i);
    }
    if (matched.length === 0) {
        return `Error: anchor not found in the note body. The body starts with:\n${bodyPreview(body)}`;
    }
    if (matched.length > 1) {
        const listing = matched
            .slice(0, 8)
            .map((idx) => `  L${idx + 1}: ${truncate((lines[idx] ?? '').trim(), 80)}`)
            .join('\n');
        return `Error: anchor matches ${matched.length} lines. Pass a more distinctive snippet from one of them:\n${listing}`;
    }

    const i = matched[0];
    if (i === undefined) return 'Error: anchor not found in the note body.';
    const line = lines[i] ?? '';

    if (position === 'end_of_section') {
        const level = /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;
        if (!level) {
            return (
                'Error: position "end_of_section" requires the anchor to match a heading line ' +
                '(e.g., "## Appearance"). The matched line is not a heading. Use "after"/"before" ' +
                "for non-heading lines, or anchor on the section's heading."
            );
        }
        // End of section = the line before the next heading of the same or a
        // higher level (smaller number). If there is none, it is the body end.
        let j = i + 1;
        while (j < lines.length) {
            const nextLevel = /^(#{1,6})\s/.exec(lines[j] ?? '')?.[1]?.length ?? 0;
            if (nextLevel && nextLevel <= level) break;
            j++;
        }
        return j < lines.length ? (lineStart[j] ?? body.length) : body.length;
    }

    if (position === 'before') return lineStart[i] ?? 0;

    // 'after' — start of the next line, or end of body if this is the last line.
    return i < lines.length - 1 ? (lineStart[i + 1] ?? body.length) : body.length;
}

/**
 * Pad `newText` so it occupies whole line(s) at `offset` in `body`: ensure it
 * ends with a newline when content follows on the same line region, and ensure
 * it starts on a new line when appending to a body that does not end with one.
 * Does not force blank-line separation — the model controls that via newlines
 * inside `newText`.
 */
function padToLineBoundary(body: string, offset: number, newText: string): string {
    let out = newText;
    if (offset < body.length && !out.endsWith('\n')) out += '\n';
    if (offset === body.length && body.length > 0 && !body.endsWith('\n') && !out.startsWith('\n')) {
        out = `\n${out}`;
    }
    return out;
}
