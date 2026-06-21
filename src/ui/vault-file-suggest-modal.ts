import { App, SuggestModal, TFile } from 'obsidian';
import { buildEmbedFolderPath, embedFolderLabel, findEmbeddedFolders } from '../utils/vault-files';

/** A selectable item in the vault file picker. */
export type VaultSuggestionItem =
    | { kind: 'file'; file: TFile }
    | { kind: 'folder'; folderPath: string; folderName: string; mode: 'top-k' | 'full' };

/**
 * Suggest modal for picking vault markdown files or embedded folders, with exclusion support.
 * Used by both the feedback panel and co-writer panel for adding context files.
 */
export class VaultFileSuggestModal extends SuggestModal<VaultSuggestionItem> {
    private onChoose: (item: VaultSuggestionItem) => void;
    private exclude: Set<string>;
    private embeddedFolders: Array<{ path: string; name: string }>;
    private showFullEmbed: boolean;

    /**
     * Create a vault file suggest modal.
     *
     * @param app           The Obsidian app instance.
     * @param onChoose      Callback invoked when an item is selected.
     * @param excludePaths  Paths to exclude from the suggestion list.
     * @param placeholder   Placeholder text for the search input.
     * @param showFullEmbed Whether to show the "full embed" option for folders alongside top-K.
     */
    constructor(
        app: App,
        onChoose: (item: VaultSuggestionItem) => void,
        excludePaths: string[] = [],
        placeholder = 'Select a file to include as context...',
        showFullEmbed = false
    ) {
        super(app);
        this.onChoose = onChoose;
        this.exclude = new Set(excludePaths);
        this.setPlaceholder(placeholder);
        this.showFullEmbed = showFullEmbed;
        this.embeddedFolders = this.discoverEmbeddedFolders();
    }

    /** Synchronously find all folders with quill-embeddings.json. */
    private discoverEmbeddedFolders(): Array<{ path: string; name: string }> {
        const cacheFolders = findEmbeddedFolders(this.app.vault.getFiles());
        return [...cacheFolders]
            .map((folderPath) => ({
                path: folderPath,
                name: folderPath.split('/').pop() ?? folderPath
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    getSuggestions(query: string): VaultSuggestionItem[] {
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const q = query.toLowerCase();

        const items: VaultSuggestionItem[] = [];

        // Add markdown files (filtered by exclude and query).
        for (const file of markdownFiles) {
            if (this.exclude.has(file.path)) continue;
            if (q && !file.path.toLowerCase().includes(q)) continue;
            items.push({ kind: 'file', file });
        }

        // Add embedded folders (filtered by exclude and query).
        for (const folder of this.embeddedFolders) {
            const embedPath = buildEmbedFolderPath(folder.path, 'top-k');
            const fullPath = buildEmbedFolderPath(folder.path, 'full');
            const matchesQuery = !q || folder.name.toLowerCase().includes(q) || folder.path.toLowerCase().includes(q);

            if (!matchesQuery) continue;

            if (!this.exclude.has(embedPath)) {
                items.push({ kind: 'folder', folderPath: folder.path, folderName: folder.name, mode: 'top-k' });
            }

            if (this.showFullEmbed && !this.exclude.has(fullPath)) {
                items.push({ kind: 'folder', folderPath: folder.path, folderName: folder.name, mode: 'full' });
            }
        }

        return items;
    }

    renderSuggestion(item: VaultSuggestionItem, el: HTMLElement): void {
        if (item.kind === 'file') {
            el.createEl('div', { text: item.file.path });
        } else {
            const label = embedFolderLabel(item.folderName, item.mode);
            el.createEl('div', { text: label });
            el.createEl('div', {
                cls: 'quill-context-panel__item-matched',
                text: item.folderPath
            });
        }
    }

    onChooseSuggestion(item: VaultSuggestionItem): void {
        this.onChoose(item);
    }
}
