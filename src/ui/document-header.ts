import { App, MarkdownView } from 'obsidian';
import type { TFile } from 'obsidian';

/** Snapshot of the active markdown document, used by panels to gate UI on document state. */
export interface ActiveDocument {
    /** The active file (guaranteed non-null when this object is returned). */
    file: TFile;
    /** Whitespace-split word count, best-effort (0 if the view's editor isn't accessible). */
    wordCount: number;
}

/**
 * Get the active markdown document, or null if no markdown file is active.
 *
 * Uses `workspace.getActiveFile()` which is reliable even when the sidebar
 * has stolen focus from the editor. Word count is best-effort via leaf
 * iteration (0 if the editor view isn't currently rendered).
 *
 * Only `.md` files qualify; canvases, images, PDFs, etc. are rejected so
 * downstream reads don't fail.
 */
export function getActiveDocument(app: App): ActiveDocument | null {
    const file = app.workspace.getActiveFile();
    if (!file) return null;
    if (file.extension !== 'md') return null;

    let wordCount = 0;
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
            const text = leaf.view.editor.getValue();
            wordCount = text.trim().split(/\s+/).filter(Boolean).length;
            break;
        }
    }

    return { file, wordCount };
}

/**
 * Render a document info header (file name + word count) into a container.
 *
 * Gives the writer visual confirmation of which document the panel operates
 * on. No-op if `doc` is null.
 */
export function renderDocumentHeader(container: HTMLElement, doc: ActiveDocument | null): void {
    if (!doc) return;
    const header = container.createDiv({ cls: 'quill-document' });
    header.createEl('span', {
        cls: 'quill-document__name',
        text: doc.file.basename
    });
    header.createEl('span', {
        cls: 'quill-document__meta',
        text: `${doc.wordCount.toLocaleString()} words`
    });
}
