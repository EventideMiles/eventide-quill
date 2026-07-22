import { App, Component, TFile } from 'obsidian';
import { SuggestBase } from './suggest-base';

interface SuggestionItem {
    file: TFile;
    matchStart: number;
}

/**
 * Inline autocomplete dropdown for `@file` mentions in textareas.
 *
 * When the user types `@` followed by text, a floating list of matching
 * vault files appears below the cursor. The user can arrow-key to navigate
 * and Enter/Tab to select, which inserts the full vault path.
 *
 * Dismisses on: Escape, click outside, space in the query, or when the
 * query looks like an email address (contains `.` without `/`).
 */
export class FileMentionSuggest extends SuggestBase<SuggestionItem> {
    constructor(app: App, inputEl: HTMLTextAreaElement, lifecycle: Component) {
        super(app, inputEl, lifecycle);
    }

    protected cssBlock(): string {
        return 'quill-file-mention-suggest';
    }

    protected getTriggerAndQuery(textBeforeCursor: string): { triggerStart: number; query: string } | null {
        const atIndex = textBeforeCursor.lastIndexOf('@');
        if (atIndex === -1) return null;

        const query = textBeforeCursor.slice(atIndex + 1);

        // Email guard: dot but no path separator
        if (query.includes('.') && !query.includes('/') && !query.includes('\\')) return null;

        // Space in query → not a mention attempt
        if (query.includes(' ')) return null;

        // Full path (slash + extension) → already resolved, don't re-suggest
        if (query.includes('/') && /\.[a-z0-9]+$/i.test(query)) return null;

        return { triggerStart: atIndex, query };
    }

    protected filterItems(query: string): SuggestionItem[] {
        const files = this.app.vault.getMarkdownFiles();
        const lowerQuery = query.toLowerCase();

        const items: SuggestionItem[] = [];

        for (const file of files) {
            const lowerPath = file.path.toLowerCase();
            const idx = lowerPath.indexOf(lowerQuery);
            if (idx !== -1) {
                items.push({ file, matchStart: idx });
            }
        }

        // Sort: exact filename → earlier match → shorter path
        items.sort((a, b) => {
            const aName = a.file.name.replace(/\.md$/, '').toLowerCase();
            const bName = b.file.name.replace(/\.md$/, '').toLowerCase();
            const aExact = aName === lowerQuery;
            const bExact = bName === lowerQuery;
            if (aExact && !bExact) return -1;
            if (!aExact && bExact) return 1;

            const aExactSub = aName.includes(lowerQuery);
            const bExactSub = bName.includes(lowerQuery);
            if (aExactSub && !bExactSub) return -1;
            if (!aExactSub && bExactSub) return 1;

            if (a.matchStart !== b.matchStart) return a.matchStart - b.matchStart;
            return a.file.path.length - b.file.path.length;
        });

        return items;
    }

    protected renderItem(item: SuggestionItem, row: HTMLElement, lowerQuery: string): void {
        this.highlightInto(row, item.file.path, lowerQuery);
    }

    protected commitItem(item: SuggestionItem, triggerStart: number, cursorPos: number): void {
        const value = this.inputEl.value;
        const textBeforeTrigger = value.slice(0, triggerStart);
        const textAfterCursor = value.slice(cursorPos);

        // Quote-wrap the path so the mention is space-safe: file paths like
        // "Act 1 Plot.md" contain spaces, and the bare `@path` form truncates at
        // the first space in resolveAtMentions. The quoted `@"path"` form is
        // matched as a whole. (resolveAtMentions accepts both forms; the bare
        // form remains for manual no-space typing.)
        const mention = `@"${item.file.path}"`;
        this.inputEl.value = textBeforeTrigger + mention + textAfterCursor;

        const newCursor = triggerStart + mention.length;
        this.inputEl.setSelectionRange(newCursor, newCursor);
    }
}
