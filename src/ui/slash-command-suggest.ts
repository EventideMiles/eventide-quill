import { App, Component } from 'obsidian';
import type EventideQuillPlugin from '../main';
import type { SlashCommand } from '../settings';
import { SLASH_COMMAND_NAME_PATTERN } from '../settings';

// NOTE: this suggest class intentionally mirrors FileMentionSuggest's
// lifecycle/keydown/render pattern. It is excluded from jscpd duplication
// detection via .jscpd.json (the v5 Rust engine dropped the inline
// jscpd:ignore-file directive v4 honored). A shared SuggestBase extraction
// is tracked as road-to-1.2.1.md PR 6 (the DRY-last sweep); remove the
// ignore entry there when the base lands and this file thins out.

interface RankedCommand extends SlashCommand {
    /** Index of the matched substring within `name` (lowercased). -1 when matched by fallback. */
    matchStart: number;
    /** True when the name exactly equals the query (sorts first). */
    exact: boolean;
}

/**
 * Inline autocomplete dropdown for user-defined slash commands in the
 * co-writer chat textarea. Mirrors `FileMentionSuggest`'s lifecycle
 * pattern: instantiated per-render and torn down via a `Component`.
 *
 * Trigger condition: `/` at the start of a line (cursor position 0,
 * or preceded by `\n`). After the trigger, the run of name chars
 * (`[a-z0-9-]`) up to the cursor is the filter query. Choosing a
 * command inserts `body` at the trigger position, leaving the text
 * fully editable — the writer can tweak before sending.
 *
 * Dismisses on: Escape, click outside, blur, or any non-name character
 * after the `/` (whitespace, uppercase, punctuation).
 */
export class SlashCommandSuggest {
    private app: App;
    private inputEl: HTMLTextAreaElement;
    private plugin: EventideQuillPlugin;
    private suggestEl: HTMLElement | null = null;
    private wrapperEl: HTMLElement;
    private selectedIndex = 0;
    private currentItems: RankedCommand[] = [];
    private currentQuery = '';
    private currentTriggerStart = 0;
    private isOpen = false;
    private justCommitted = false;

    constructor(app: App, inputEl: HTMLTextAreaElement, plugin: EventideQuillPlugin, lifecycle: Component) {
        this.app = app;
        this.inputEl = inputEl;
        this.plugin = plugin;

        // Wrapper sits inside the textarea's parent, positioned over it
        // (the parent is `.quill-cowriter-panel__ta-row`, `position: relative`).
        const containerEl = inputEl.parentElement ?? inputEl;
        this.wrapperEl = containerEl.createDiv({
            cls: 'quill-slash-command-suggest-wrapper'
        });

        // Register DOM events through the Component lifecycle so they
        // auto-clean-up on re-render. The only manual teardown left is
        // wrapper removal (registered separately below).
        lifecycle.registerDomEvent(inputEl, 'input', this.onInput);
        lifecycle.registerDomEvent(inputEl, 'keydown', this.onKeydown);
        lifecycle.registerDomEvent(inputEl, 'blur', this.onBlur);
        lifecycle.registerDomEvent(window.activeDocument, 'mousedown', this.onDocumentMouseDown);

        lifecycle.register(() => this.destroy());
    }

    // ── Input handling ──────────────────────────────────────────────

    private onInput = (): void => {
        if (this.justCommitted) {
            this.justCommitted = false;
            return;
        }

        const cursorPos = this.inputEl.selectionStart ?? 0;
        const value = this.inputEl.value;
        const textBeforeCursor = value.slice(0, cursorPos);

        // Start-of-line: position 0, or preceded by '\n'. The slash-trigger
        // fires only at line starts so mid-prose '/' (e.g. "he/she") doesn't
        // pop the dropdown. After the slash, only kebab-case name chars are a
        // valid query — any other character (whitespace, uppercase, punctuation)
        // closes the dropdown.
        const lineStart = textBeforeCursor.lastIndexOf('\n') + 1; // 0 if no newline before cursor
        const lineUpToCursor = textBeforeCursor.slice(lineStart);

        const triggerMatch = lineUpToCursor.match(/^\/([a-z0-9-]*)$/);
        if (!triggerMatch) {
            this.close();
            return;
        }

        const query = triggerMatch[1] ?? '';
        this.currentQuery = query;
        this.currentTriggerStart = lineStart;
        this.filterAndShow(query);
    };

    private onKeydown = (e: KeyboardEvent): void => {
        if (!this.isOpen) {
            // When the user types a bare '/' on an empty line, the input event
            // opens the picker. Backspace removing the '/' closes via onInput
            // naturally (the triggerMatch fails). No special handling needed.
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.selectedIndex = Math.min(this.selectedIndex + 1, this.currentItems.length - 1);
            this.highlightSelected();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
            this.highlightSelected();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            // Enter is the panel's send key — stopImmediatePropagation keeps the
            // panel's send handler from firing while the picker is open.
            e.preventDefault();
            e.stopImmediatePropagation();
            this.commitSelection();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    };

    private onBlur = (): void => {
        // Delay close so a mousedown on the dropdown can commit first.
        // Raw setTimeout mirrors FileMentionSuggest (same short-lived
        // deferred-close pattern; the timer fires at most once per blur and
        // cannot outlive the input element, which tears down with the panel).
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

    private filterAndShow(query: string): void {
        const commands = this.plugin.settings.slashCommands;
        if (commands.length === 0) {
            this.close();
            return;
        }

        // Exclude blank/invalid drafts — commands the writer added in settings
        // but hasn't named yet (or whose name doesn't pass validation). These
        // should never appear in the live picker.
        const valid = commands.filter((cmd) => SLASH_COMMAND_NAME_PATTERN.test(cmd.name));
        if (valid.length === 0) {
            this.close();
            return;
        }

        const lowerQuery = query.toLowerCase();
        const items: RankedCommand[] = [];

        for (const cmd of valid) {
            const lowerName = cmd.name.toLowerCase();
            if (lowerQuery === '') {
                // Empty query (just '/') — show all commands, sorted alphabetically.
                items.push({ ...cmd, matchStart: 0, exact: false });
                continue;
            }
            const idx = lowerName.indexOf(lowerQuery);
            if (idx !== -1) {
                items.push({ ...cmd, matchStart: idx, exact: lowerName === lowerQuery });
            }
        }

        // Sort: exact match → earlier match position → alphabetical by name.
        items.sort((a, b) => {
            if (a.exact && !b.exact) return -1;
            if (!a.exact && b.exact) return 1;
            if (a.matchStart !== b.matchStart) return a.matchStart - b.matchStart;
            return a.name.localeCompare(b.name);
        });

        this.currentItems = items.slice(0, 12);
        this.selectedIndex = 0;

        if (this.currentItems.length === 0) {
            this.close();
            return;
        }

        this.renderDropdown();
    }

    // ── Rendering ───────────────────────────────────────────────────

    private renderDropdown(): void {
        if (!this.suggestEl) {
            this.suggestEl = this.wrapperEl.createDiv({ cls: 'quill-slash-command-suggest' });
        }

        this.suggestEl.empty();

        const lowerQuery = this.currentQuery.toLowerCase();

        for (let i = 0; i < this.currentItems.length; i++) {
            const item = this.currentItems[i]!;
            const row = this.suggestEl.createEl('div', {
                cls: `quill-slash-command-suggest__item${i === this.selectedIndex ? ' quill-slash-command-suggest__item--selected' : ''}`
            });

            const nameRow = row.createDiv({ cls: 'quill-slash-command-suggest__name-row' });
            nameRow.createSpan({ cls: 'quill-slash-command-suggest__slash', text: '/' });

            const name = item.name;
            const lowerName = name.toLowerCase();
            const matchIdx = lowerQuery === '' ? -1 : lowerName.indexOf(lowerQuery);

            if (matchIdx >= 0) {
                const before = name.slice(0, matchIdx);
                const match = name.slice(matchIdx, matchIdx + lowerQuery.length);
                const after = name.slice(matchIdx + lowerQuery.length);
                if (before) nameRow.createSpan({ text: before });
                nameRow.createSpan({ cls: 'quill-slash-command-suggest__highlight', text: match });
                if (after) nameRow.createSpan({ text: after });
            } else {
                nameRow.createSpan({ text: name });
            }

            if (item.description) {
                row.createDiv({ cls: 'quill-slash-command-suggest__desc', text: item.description });
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
        const items = this.suggestEl.querySelectorAll('.quill-slash-command-suggest__item');
        items.forEach((el, i) => {
            el.toggleClass('quill-slash-command-suggest__item--selected', i === this.selectedIndex);
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
        const textBeforeTrigger = value.slice(0, this.currentTriggerStart);
        const textAfterCursor = value.slice(cursorPos);

        // Replace the `/query` run with the command body. The text is fully
        // editable — cursor lands at the end of `body`, the writer can
        // backspace, append specifics, or send as-is.
        this.inputEl.value = textBeforeTrigger + selected.body + textAfterCursor;

        const newCursor = this.currentTriggerStart + selected.body.length;
        this.inputEl.setSelectionRange(newCursor, newCursor);

        // Mark committed and fire input so the panel tracks value (the panel's
        // input listener updates `this.inputValue`). The guard in onInput
        // prevents the dropdown from re-opening on the synthetic event.
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
        // DOM event listeners are auto-removed by the Component lifecycle
        // (registerDomEvent). Only the wrapper needs manual cleanup.
        this.wrapperEl.remove();
    }
}
