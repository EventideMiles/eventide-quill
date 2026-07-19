import { App, normalizePath, TFile } from 'obsidian';
import { embedFolderLabel, parseEmbedFolderPath } from '../utils/vault-files';

/**
 * State + pill-bar DOM for a list of context files added mid-conversation.
 *
 * Shared by sidebar panels that let the writer add reference files during a
 * follow-up chat (ReviewPanel, ). The panel constructs one
 * instance, attaches it to the bottom-area element where pills should render,
 * and uses `add` / `remove` / `clear` to manage the list. The class handles
 * token estimation, pill-bar DOM updates (in-place, no full re-render), and
 * fires `onChange` after each mutation so the panel can refresh its token
 * indicator.
 *
 * The CSS class prefix (e.g. `quill-feedback` or `quill-analysis`) is passed
 * in so each panel's pills style independently.
 */
export class ChatContextFiles {
    private files: string[] = [];
    private fileTokens: Map<string, number> = new Map();
    private bottomArea: HTMLElement | null = null;

    constructor(
        private app: App,
        private cssPrefix: string,
        private onChange: () => void
    ) {}

    /**
     * Register the container where the pill bar should render and immediately
     * render any files already in the list. The caller must create the bottom
     * area AND its `.${cssPrefix}-chat-btn-row` child before calling this, so
     * pills can be inserted in the correct position (above the button row).
     */
    attach(bottomArea: HTMLElement): void {
        this.bottomArea = bottomArea;
        this.refreshDom();
    }

    /** Detach the container (e.g. on tab switch). Pills won't render until re-attached. */
    detach(): void {
        this.bottomArea = null;
    }

    getFiles(): string[] {
        return [...this.files];
    }

    fileCount(): number {
        return this.files.length;
    }

    hasFiles(): boolean {
        return this.files.length > 0;
    }

    /** Sum of estimated tokens across all context files (chars / 4). */
    getTotalTokens(): number {
        let total = 0;
        for (const t of this.fileTokens.values()) total += t;
        return total;
    }

    /** Add a file. Reads its content to estimate tokens. No-op if already present. */
    async add(filePath: string): Promise<void> {
        if (this.files.includes(filePath)) return;
        this.files.push(filePath);
        await this.refreshTokenFor(filePath);
        this.refreshDom();
        this.onChange();
    }

    /** Remove a file. */
    remove(filePath: string): void {
        this.files = this.files.filter((p) => p !== filePath);
        this.fileTokens.delete(filePath);
        this.refreshDom();
        this.onChange();
    }

    /** Override the token estimate for a specific file path (e.g. for embed-folder paths). */
    setTokenOverride(filePath: string, tokens: number): void {
        if (!this.files.includes(filePath)) return;
        this.fileTokens.set(filePath, tokens);
        this.onChange();
    }

    /** Empty the list. Does not fire onChange — caller decides whether to refresh. */
    clear(): void {
        this.files = [];
        this.fileTokens.clear();
        this.refreshDom();
    }

    private async refreshTokenFor(filePath: string): Promise<void> {
        if (parseEmbedFolderPath(filePath)) {
            // Embed folder paths have no real file to read; token count is
            // computed at AI call time via resolveEmbedPathsToMessages.
            if (this.files.includes(filePath)) {
                this.fileTokens.set(filePath, 0);
            }
            return;
        }
        try {
            const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
            if (file instanceof TFile) {
                const content = await this.app.vault.cachedRead(file);
                if (this.files.includes(filePath)) {
                    this.fileTokens.set(filePath, Math.ceil(content.length / 4));
                }
                return;
            }
        } catch {
            // best-effort: leave token count at 0
        }
        if (this.files.includes(filePath)) {
            this.fileTokens.set(filePath, 0);
        }
    }

    /** Rebuild the pill bar inside the attached container, in place. */
    private refreshDom(): void {
        if (!this.bottomArea) return;

        const barClass = `${this.cssPrefix}__ctx-bar`;
        const oldBar = this.bottomArea.querySelector(`.${barClass}`);
        if (oldBar) oldBar.remove();
        if (this.files.length === 0) return;

        const bar = this.bottomArea.createDiv({ cls: barClass });
        for (const filePath of this.files) {
            const pill = bar.createDiv({ cls: `${this.cssPrefix}__ctx-pill` });
            const parsed = parseEmbedFolderPath(filePath);
            const name = parsed
                ? embedFolderLabel(parsed.folderPath, parsed.mode)
                : (filePath.split('/').pop() ?? filePath);
            pill.createSpan({ text: truncateMiddle(name, 24) });
            const removeBtn = pill.createEl('button', {
                cls: `${this.cssPrefix}__ctx-remove`,
                text: '\u00d7',
                title: filePath
            });
            removeBtn.addEventListener('click', () => this.remove(filePath));
        }

        // Insert before the button row so pills stay visually above the input.
        const btnRow = this.bottomArea.querySelector(`.${this.cssPrefix}__btn-row`);
        if (btnRow) {
            this.bottomArea.insertBefore(bar, btnRow);
        }
    }
}

/** Truncate the middle of a string if it exceeds maxWidth characters. */
function truncateMiddle(name: string, maxWidth: number): string {
    if (name.length <= maxWidth) return name;
    const half = Math.floor((maxWidth - 1) / 2);
    return name.slice(0, half) + '\u2026' + name.slice(name.length - half);
}
