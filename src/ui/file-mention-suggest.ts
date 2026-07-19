import { App, Component, TFile } from 'obsidian';

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
export class FileMentionSuggest {
    private app: App;
    private inputEl: HTMLTextAreaElement;
    private suggestEl: HTMLElement | null = null;
    private wrapperEl: HTMLElement;
    private selectedIndex = 0;
    private currentItems: SuggestionItem[] = [];
    private currentQuery = '';
    private isOpen = false;
    private justCommitted = false;

    constructor(app: App, inputEl: HTMLTextAreaElement, lifecycle: Component) {
        this.app = app;
        this.inputEl = inputEl;

        // Wrapper sits inside the textarea's parent, positioned over it.
        const containerEl = inputEl.parentElement ?? inputEl;
        this.wrapperEl = containerEl.createDiv({
            cls: 'quill-file-mention-suggest-wrapper'
        });

        inputEl.addEventListener('input', this.onInput);
        inputEl.addEventListener('keydown', this.onKeydown);
        inputEl.addEventListener('blur', this.onBlur);
        window.activeDocument.addEventListener('mousedown', this.onDocumentMouseDown);

        lifecycle.register(() => this.destroy());
    }

    // ── Input handling ──────────────────────────────────────────────

    private onInput = (): void => {
        if (this.justCommitted) {
            this.justCommitted = false;
            return;
        }

        const cursorPos = this.inputEl.selectionStart ?? 0;
        const textBeforeCursor = this.inputEl.value.slice(0, cursorPos);

        const atIndex = textBeforeCursor.lastIndexOf('@');
        if (atIndex === -1) {
            this.close();
            return;
        }

        const query = textBeforeCursor.slice(atIndex + 1);

        // Email guard: dot but no path separator
        if (query.includes('.') && !query.includes('/') && !query.includes('\\')) {
            this.close();
            return;
        }

        // Space in query → not a mention attempt
        if (query.includes(' ')) {
            this.close();
            return;
        }

        // Full path (slash + extension) → already resolved, don't re-suggest
        if (query.includes('/') && /\.[a-z0-9]+$/i.test(query)) {
            this.close();
            return;
        }

        this.currentQuery = query;
        this.filterAndShow(query, cursorPos);
    };

    private onKeydown = (e: KeyboardEvent): void => {
        if (!this.isOpen) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.selectedIndex = Math.min(this.selectedIndex + 1, this.currentItems.length - 1);
            this.highlightSelected();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
            this.highlightSelected();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.commitSelection();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    };

    private onBlur = (): void => {
        // Delay close so a mousedown on the dropdown can commit first
        window.setTimeout(() => {
            if (window.activeDocument.activeElement !== this.inputEl) {
                this.close();
            }
        }, 150);
    };

    private onDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.isOpen) return;
        if (this.suggestEl && !this.suggestEl.contains(e.target as Node)) {
            this.close();
        }
    };

    // ── Filtering ───────────────────────────────────────────────────

    private filterAndShow(query: string, cursorPos: number): void {
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

        this.currentItems = items.slice(0, 12);
        this.selectedIndex = 0;

        if (this.currentItems.length === 0) {
            this.close();
            return;
        }

        this.renderDropdown(cursorPos);
    }

    // ── Rendering ───────────────────────────────────────────────────

    private renderDropdown(_cursorPos: number): void {
        if (!this.suggestEl) {
            this.suggestEl = this.wrapperEl.createDiv({ cls: 'quill-file-mention-suggest' });
        }

        this.suggestEl.empty();

        const lowerQuery = this.currentQuery.toLowerCase();

        for (let i = 0; i < this.currentItems.length; i++) {
            const item = this.currentItems[i]!;
            const row = this.suggestEl.createDiv({
                cls: `quill-file-mention-suggest__item${i === this.selectedIndex ? ' quill-file-mention-suggest__item--selected' : ''}`
            });

            const path = item.file.path;
            const lowerPath = path.toLowerCase();
            const matchIdx = lowerPath.indexOf(lowerQuery);

            if (matchIdx >= 0) {
                const before = path.slice(0, matchIdx);
                const match = path.slice(matchIdx, matchIdx + lowerQuery.length);
                const after = path.slice(matchIdx + lowerQuery.length);
                row.createSpan({ text: before });
                row.createSpan({ cls: 'quill-file-mention-suggest__highlight', text: match });
                row.createSpan({ text: after });
            } else {
                row.setText(path);
            }

            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.selectedIndex = i;
                this.commitSelection();
            });
        }

        this.isOpen = true;
    }

    private highlightSelected(): void {
        if (!this.suggestEl) return;
        const items = this.suggestEl.querySelectorAll('.quill-file-mention-suggest__item');
        items.forEach((el, i) => {
            el.toggleClass('quill-file-mention-suggest__item--selected', i === this.selectedIndex);
        });
        const selected = items[this.selectedIndex] as HTMLElement | undefined;
        selected?.scrollIntoView({ block: 'nearest' });
    }

    // ── Selection ───────────────────────────────────────────────────

    private commitSelection(): void {
        const selected = this.currentItems[this.selectedIndex];
        if (!selected) return;

        const cursorPos = this.inputEl.selectionStart ?? 0;
        const value = this.inputEl.value;
        const textBeforeCursor = value.slice(0, cursorPos);
        const textAfterCursor = value.slice(cursorPos);

        const atIndex = textBeforeCursor.lastIndexOf('@');
        if (atIndex === -1) return;

        // Quote-wrap the path so the mention is space-safe: file paths like
        // "Act 1 Plot.md" contain spaces, and the bare `@path` form truncates at
        // the first space in resolveAtMentions. The quoted `@"path"` form is
        // matched as a whole. (resolveAtMentions accepts both forms; the bare
        // form remains for manual no-space typing.)
        const mention = `@"${selected.file.path}"`;
        this.inputEl.value = textBeforeCursor.slice(0, atIndex) + mention + textAfterCursor;

        const newCursor = atIndex + mention.length;
        this.inputEl.setSelectionRange(newCursor, newCursor);

        // Mark committed and fire input so the panel tracks value.
        // The guard in onInput prevents re-opening the dropdown.
        this.justCommitted = true;
        this.close();
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    private close = (): void => {
        this.suggestEl?.remove();
        this.suggestEl = null;
        this.isOpen = false;
        this.currentItems = [];
        this.currentQuery = '';
    };

    destroy(): void {
        this.close();
        this.inputEl.removeEventListener('input', this.onInput);
        this.inputEl.removeEventListener('keydown', this.onKeydown);
        this.inputEl.removeEventListener('blur', this.onBlur);
        window.activeDocument.removeEventListener('mousedown', this.onDocumentMouseDown);
        this.wrapperEl.remove();
    }
}
