import { App, MarkdownView } from 'obsidian';

/**
 * Find the MarkdownView editor for a file path by searching all open leaves.
 *
 * This is more reliable than `getActiveViewOfType(MarkdownView)` because it
 * works even when the sidebar or a modal has focus — the active view check
 * returns null in that case, but the editor leaf still exists and is editable.
 *
 * Returns the MarkdownView if found, or null.
 */
export function findEditorView(app: App, filePath: string | null): MarkdownView | null {
    if (!filePath) return null;

    // First try the active view — it's the fastest path and most commonly correct.
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file?.path === filePath) {
        return active;
    }

    // Active view didn't match or is null (sidebar/modal has focus).
    // Search all markdown leaves for one with the right file.
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath) {
            return leaf.view;
        }
    }

    return null;
}
