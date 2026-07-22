import { App, MarkdownView, normalizePath, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { findEditorView } from '../../utils/find-editor';
import { pushDiffEdits, clearDiffEdits, toDiffSnapshots } from '../../ui/change-diff-extension';
import type { ChangeSet } from '../../core/change-set';
import type EventideQuillPlugin from '../../main';

/**
 * Open a note for editing. If the file is already open in a tab, switch to
 * that tab and reuse it. If not, open a NEW tab (so multi-file edits don't
 * close each other's diffs). Returns whether the file was already open so
 * the caller can track which tabs to close on approve/reject.
 *
 * Polls briefly for the editor because Obsidian creates the view
 * asynchronously after `openLinkText`.
 *
 * Raw setTimeout: the editor view isn't available synchronously after
 * openLinkText, and there's no callback/promise for "editor ready." Polling
 * every 50ms for up to 500ms is the pragmatic workaround.
 */
export async function openNoteForEdit(
    app: App,
    filePath: string
): Promise<{ view: MarkdownView; cm: EditorView; wasAlreadyOpen: boolean } | null> {
    const normalized = normalizePath(filePath);

    // If the file is already open, switch to its tab and reuse it.
    const existing = findEditorView(app, normalized);
    if (existing && existing.editor) {
        const cm = (existing.editor as unknown as { cm: EditorView }).cm;
        if (cm) {
            // Activate the leaf so the user sees the file.
            if (existing.leaf) {
                app.workspace.setActiveLeaf(existing.leaf, { focus: true });
            }
            return { view: existing, cm, wasAlreadyOpen: true };
        }
    }

    // Not open — open in a NEW tab so existing diffs aren't destroyed.
    await app.workspace.openLinkText(normalized, '', true);

    for (let i = 0; i < 10; i++) {
        const view = findEditorView(app, normalized);
        if (view && view.editor) {
            const cm = (view.editor as unknown as { cm: EditorView }).cm;
            if (cm) return { view, cm, wasAlreadyOpen: false };
        }
        // Raw timer — see JSDoc above for justification.
        await new Promise((r) => window.setTimeout(r, 50));
    }
    return null;
}

/**
 * Push a proposed edit's diff snapshots to the target editor's CodeMirror so
 * the user sees the green-box inline diff. Clears any prior lore-edit diff
 * for THIS file's editor first (other files' diffs in other editors are
 * untouched). Pass `filePath` so the inline Approve/Reject buttons can route
 * to the correct file when multiple edits are pending.
 *
 * **Multi-tab safety:** the `cm` argument is the editor `openNoteForEdit`
 * happened to activate, but the writer may have the same note open in
 * another tab or split. Without pushing to EVERY open editor for this file,
 * the diff appears in one tab while the writer is looking at another — the
 * "edit shows in chat but not in the active editor" symptom. The `app`
 * argument is used to find all other markdown leaves showing `filePath` and
 * push to each. Each editor has its own CodeMirror instance with its own
 * decoration state, so each needs its own push.
 */
export function pushLoreEditDiff(cm: EditorView, changeSet: ChangeSet, filePath: string, app: App): void {
    const snapshots = toDiffSnapshots(changeSet, 'lore_edit', filePath);

    // Primary editor (the one openNoteForEdit opened/activated).
    clearDiffEdits(cm, 'lore_edit');
    pushDiffEdits(cm, snapshots, 'lore_edit');

    // ALSO push to any OTHER open editors showing the same file. Each editor
    // has its own CodeMirror instance with its own decoration state; without
    // this loop, a writer looking at a duplicate tab/split sees no diff even
    // though one was pushed elsewhere.
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        if (!(leaf.view instanceof MarkdownView)) continue;
        if (leaf.view.file?.path !== filePath) continue;
        const otherCm = (leaf.view.editor as unknown as { cm: EditorView }).cm;
        if (otherCm && otherCm !== cm) {
            clearDiffEdits(otherCm, 'lore_edit');
            pushDiffEdits(otherCm, snapshots, 'lore_edit');
        }
    }
}

/**
 * Read a vault file's raw text content by path. Returns the FULL file,
 * frontmatter included — offsets are relative to the on-disk/CM document so
 * they can be passed straight to a ChangeSet. Callers that need to match
 * against the body only (the way the model sees it via `vault_lookup`) should
 * pass the result through {@link splitFrontmatter} and add `bodyOffset` back
 * when mapping a body-relative offset onto the raw document.
 *
 * Returns null if the file doesn't exist or isn't readable.
 */
export async function readNoteContent(plugin: EventideQuillPlugin, filePath: string): Promise<string | null> {
    const normalized = normalizePath(filePath);
    const file = plugin.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) return null;
    return plugin.app.vault.cachedRead(file);
}

/**
 * Split a leading YAML frontmatter block (`---\n...\n---\n`) off a note.
 * Returns the offset where the body begins (so body-relative offsets can be
 * mapped back onto the raw document) and the body text itself. The model sees
 * notes through `vault_lookup` with frontmatter stripped, so anchor/line
 * matching MUST run against `body`; the `bodyOffset` is then added back to any
 * insertion point so the edit lands correctly in the real file and never
 * inside the YAML block. If there is no frontmatter, `bodyOffset` is 0 and
 * `body` is the input unchanged.
 */
export function splitFrontmatter(raw: string): { bodyOffset: number; body: string } {
    // Require the closing `---` to be on its own line: the delimiter must be
    // followed by a line break or end-of-string. The looser `\r?\n?` tail
    // previously accepted partial closers like `----` or `---not-close`,
    // mis-slicing the body and reporting a wrong bodyOffset.
    const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (match) return { bodyOffset: match[0].length, body: raw.slice(match[0].length) };
    return { bodyOffset: 0, body: raw };
}

/**
 * Guard for the "any approval order is safe" invariant: pending edits on one
 * file must be pairwise disjoint. Returns an error string (naming the
 * conflicting pending edit id(s) and pointing at `revise_edit`) if a proposed
 * `[from, to)` range overlaps any pending edit, or `null` if the range is
 * clear and the caller may safely add it. Range overlap uses the standard
 * half-open interval test `from < e.to && e.from < to`, so a zero-width
 * insertion abutting (not inside) an existing edit is allowed.
 *
 * Why disjointness is sufficient: `ChangeSet.approve` shifts only edits whose
 * `from >= approved.to`; with disjoint edits any approval order keeps every
 * remaining edit's offsets valid against the current document.
 */
export function overlapError(changeSet: ChangeSet, from: number, to: number): string | null {
    const ids: number[] = [];
    for (const e of changeSet.edits) {
        if (e.state !== 'pending') continue;
        if (from < e.to && e.from < to) ids.push(e.id);
    }
    if (ids.length === 0) return null;
    const singular = ids.length === 1;
    return (
        `Error: this change overlaps pending edit${singular ? '' : 's'} id ${ids.join(', ')} ` +
        `on the same note. Use \`revise_edit\` with ${singular ? 'that id' : 'one of those ids'} ` +
        `to fold your new content into the existing pending edit (emit its FULL new text), ` +
        `or choose a non-overlapping range.`
    );
}

/**
 * Resolve a user-provided path to a TFile. Tries exact path first, then
 * falls back to a name lookup via the metadata cache.
 */
export function resolveNoteFile(plugin: EventideQuillPlugin, query: string): TFile | null {
    const normalized = normalizePath(query);
    const file = plugin.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return file;
    const dest = plugin.app.metadataCache.getFirstLinkpathDest(query, '');
    return dest instanceof TFile ? dest : null;
}

/**
 * Result of a text search within note content. `exact` is true when the
 * match was character-for-character (the fast path). When `exact` is false,
 * the match was found via whitespace-insensitive normalization — the model's
 * `old_text` had different line breaks, tabs vs spaces, or trailing whitespace,
 * but the actual words matched.
 */
export interface TextMatchResult {
    from: number;
    to: number;
    exact: boolean;
}

/**
 * Find `oldText` within `content`, trying exact match first, then a
 * whitespace-insensitive fallback. Returns `null` when no match is found
 * by either method.
 *
 * The whitespace-insensitive fallback collapses all runs of whitespace
 * (spaces, tabs, newlines) in both the content and `oldText` to single
 * spaces, then searches. The matched normalized range is mapped back to
 * the ORIGINAL content's character positions so the edit lands at the
 * right place. This handles the common failure mode where the model
 * reproduces text with slightly different indentation or line wrapping
 * than the file — the match still succeeds.
 *
 * If the fallback also finds nothing, the caller should present a useful
 * error to the model (see {@link buildNotFoundHint}).
 */
export function findTextInContent(content: string, oldText: string): TextMatchResult | null {
    // Guard: if oldText is empty or all-whitespace, normalizing would produce
    // an empty string whose indexOf() returns 0 — a bogus match at the start
    // of the document. Reject before searching.
    if (!oldText.trim()) return null;

    // Fast path: exact character-for-character match.
    const exactIdx = content.indexOf(oldText);
    if (exactIdx !== -1) {
        // Check uniqueness — if the exact text appears multiple times, the
        // caller (edit_note) handles the ambiguity. Return the first match;
        // the caller checks for multiples separately.
        return { from: exactIdx, to: exactIdx + oldText.length, exact: true };
    }

    // Fallback: whitespace-insensitive match. Collapse all whitespace runs
    // in both strings to single spaces, then search. Build a mapping from
    // normalized positions back to original positions so the match range
    // can be projected onto the real content.
    const { normalized: normContent, origPositions } = normalizeWhitespace(content);
    const { normalized: normOld } = normalizeWhitespace(oldText);

    const normIdx = normContent.indexOf(normOld);
    if (normIdx === -1) return null;

    // Map normalized positions back to original positions. origPositions[i]
    // gives the original-content offset of the character at normContent[i].
    const from = origPositions[normIdx] ?? 0;
    const lastNormIdx = normIdx + normOld.length - 1;
    // The original range extends one past the last mapped position to include
    // any trailing whitespace that was collapsed.
    const to = origPositions[lastNormIdx + 1] ?? content.length;
    return { from, to, exact: false };
}

/**
 * Check whether `oldText` (or its whitespace-normalized form) has more than
 * one occurrence in `content` beyond the already-matched range `[matchFrom,
 * matchTo)`. Used by `edit_note`'s uniqueness guard so that whitespace-variant
 * repeats are caught alongside exact duplicates — without this, a fuzzy match
 * at one occurrence could be treated as unique when a whitespace-different
 * copy of the same text exists elsewhere.
 *
 * Returns `true` when an additional match is found (the caller should reject
 * with an ambiguity error), `false` when the match is unique.
 */
export function hasAdditionalMatch(content: string, oldText: string, matchFrom: number, matchTo: number): boolean {
    // Exact duplicate check: does the matched text appear again after the
    // matched range?
    const matchedText = content.slice(matchFrom, matchTo);
    if (content.indexOf(matchedText, matchTo) !== -1) return true;
    if (matchFrom > 0 && content.lastIndexOf(matchedText, matchFrom - 1) !== -1) return true;

    // Whitespace-variant check: normalize the old text and scan the content
    // excluding the already-matched range. If a second normalized match
    // exists, the excerpt is ambiguous.
    const normOld = normalizeWhitespace(oldText).normalized;
    if (!normOld) return false; // all-whitespace — already guarded by findTextInContent
    const normContent = normalizeWhitespace(content).normalized;

    // Find the first normalized match.
    const firstNorm = normContent.indexOf(normOld);
    if (firstNorm === -1) return false;

    // Check for a second normalized match after the first.
    const secondNorm = normContent.indexOf(normOld, firstNorm + normOld.length);
    return secondNorm !== -1;
}

/**
 * Normalize whitespace in a string for fuzzy matching: collapse all runs of
 * whitespace (spaces, tabs, newlines, carriage returns) to a single space.
 * Also returns a position-mapping array so matches in the normalized string
 * can be projected back onto the original. `origPositions[i]` is the offset
 * in the original string of the character at normalized position `i`.
 */
function normalizeWhitespace(s: string): { normalized: string; origPositions: number[] } {
    const normalized: string[] = [];
    const origPositions: number[] = [];
    let inWs = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (!inWs) {
                normalized.push(' ');
                origPositions.push(i);
            }
            inWs = true;
        } else {
            normalized.push(ch);
            origPositions.push(i);
            inWs = false;
        }
    }
    // Trim trailing whitespace in the normalized string.
    while (normalized.length > 0 && normalized[normalized.length - 1] === ' ') {
        normalized.pop();
        origPositions.pop();
    }
    return { normalized: normalized.join(''), origPositions };
}

/**
 * Build a helpful error hint when old_text is not found. Instead of just
 * showing the first 300 chars (useless for long notes), this finds the
 * section of the content that shares the most words with old_text and shows
 * that section as context — giving the model a fighting chance to re-quote
 * the correct text on its next attempt.
 */
export function buildNotFoundHint(content: string, oldText: string): string {
    // Extract distinctive words from oldText (longer than 3 chars, de-duped)
    // to locate the most relevant section of the file.
    const oldWords = [...new Set(oldText.split(/\s+/).filter((w) => w.length > 3))];

    if (oldWords.length === 0) {
        // oldText was all short words — show the beginning.
        const preview = content.slice(0, 500).trim();
        return `The note starts with:\n${preview}${content.length > 500 ? '\n...' : ''}`;
    }

    // Score each 500-char window by how many of oldWords it contains.
    const windowSize = 500;
    let bestStart = 0;
    let bestScore = 0;
    for (let i = 0; i < content.length; i += 100) {
        const window = content.slice(i, i + windowSize).toLowerCase();
        let score = 0;
        for (const word of oldWords) {
            if (window.includes(word.toLowerCase())) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestStart = i;
        }
    }

    const snippet = content.slice(bestStart, bestStart + windowSize).trim();
    const matchedPct = oldWords.length > 0 ? Math.round((bestScore / oldWords.length) * 100) : 0;
    return (
        `The closest section (shares ${matchedPct}% of distinctive words) is:\n"${snippet}"\n\n` +
        `Re-read this section, then retry edit_note with old_text copied verbatim from the CURRENT ` +
        `file content above (not from memory — the note may have been edited since you last saw it).`
    );
}
