import { App, MarkdownView, normalizePath, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { findEditorView } from '../../utils/find-editor';
import { pushDiffEdits, clearDiffEdits, toDiffSnapshots } from '../../ui/change-diff-extension';
import type { ChangeSet } from '../../core/change-set';
import type EventideQuillPlugin from '../../main';

/**
 * Open a note in a new tab, wait for its editor to be ready, and return the
 * view + CodeMirror instance. Polls briefly because Obsidian creates the
 * editor view asynchronously after `openLinkText`.
 *
 * Raw setTimeout: the editor view isn't available synchronously after
 * openLinkText, and there's no callback/promise for "editor ready." Polling
 * every 50ms for up to 500ms is the pragmatic workaround.
 */
export async function openNoteForEdit(
    app: App,
    filePath: string
): Promise<{ view: MarkdownView; cm: EditorView } | null> {
    const normalized = normalizePath(filePath);
    await app.workspace.openLinkText(normalized, '', false);

    // Poll for the editor view to be ready.
    for (let i = 0; i < 10; i++) {
        const view = findEditorView(app, normalized);
        if (view && view.editor) {
            const cm = (view.editor as unknown as { cm: EditorView }).cm;
            if (cm) return { view, cm };
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
 * Read a vault file's body text (with frontmatter stripped) by path.
 * Returns null if the file doesn't exist or isn't readable.
 */
export async function readNoteContent(plugin: EventideQuillPlugin, filePath: string): Promise<string | null> {
    const normalized = normalizePath(filePath);
    const file = plugin.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) return null;
    return plugin.app.vault.cachedRead(file);
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
