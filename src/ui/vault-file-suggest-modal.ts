import { App, SuggestModal, TFile } from 'obsidian';

/**
 * Suggest modal for picking vault markdown files, with exclusion support.
 * Used by both the feedback panel and co-writer panel for adding context files.
 */
export class VaultFileSuggestModal extends SuggestModal<TFile> {
    private onChoose: (file: TFile) => void;
    private exclude: Set<string>;

    /**
     * Create a vault file suggest modal.
     *
     * @param app         The Obsidian app instance.
     * @param onChoose    Callback invoked when a file is selected.
     * @param excludePaths Paths to exclude from the suggestion list.
     * @param placeholder  Placeholder text for the search input.
     */
    constructor(
        app: App,
        onChoose: (file: TFile) => void,
        excludePaths: string[] = [],
        placeholder = 'Select a file to include as context...'
    ) {
        super(app);
        this.onChoose = onChoose;
        this.exclude = new Set(excludePaths);
        this.setPlaceholder(placeholder);
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        const filtered = files.filter((f) => !this.exclude.has(f.path));
        if (!query) return filtered;
        const q = query.toLowerCase();
        return filtered.filter((f) => f.path.toLowerCase().includes(q));
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.createEl('div', { text: file.path });
    }

    onChooseSuggestion(file: TFile): void {
        this.onChoose(file);
    }
}
