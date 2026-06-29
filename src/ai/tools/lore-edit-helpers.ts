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
 */
export function pushLoreEditDiff(cm: EditorView, changeSet: ChangeSet, filePath: string): void {
    clearDiffEdits(cm, 'lore_edit');
    pushDiffEdits(cm, toDiffSnapshots(changeSet, 'lore_edit', filePath), 'lore_edit');
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
