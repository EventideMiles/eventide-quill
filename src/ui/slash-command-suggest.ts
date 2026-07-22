import { App, Component } from 'obsidian';
import type EventideQuillPlugin from '../main';
import type { SlashCommand } from '../settings';
import { SLASH_COMMAND_NAME_PATTERN } from '../settings';
import { SuggestBase } from './suggest-base';

interface RankedCommand extends SlashCommand {
    /** Index of the matched substring within `name` (lowercased). -1 when matched by fallback. */
    matchStart: number;
    /** True when the name exactly equals the query (sorts first). */
    exact: boolean;
}

/**
 * Inline autocomplete dropdown for user-defined slash commands in the
 * co-writer chat textarea.
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
export class SlashCommandSuggest extends SuggestBase<RankedCommand> {
    private plugin: EventideQuillPlugin;

    constructor(app: App, inputEl: HTMLTextAreaElement, plugin: EventideQuillPlugin, lifecycle: Component) {
        super(app, inputEl, lifecycle);
        this.plugin = plugin;
    }

    protected cssBlock(): string {
        return 'quill-slash-command-suggest';
    }

    protected getTriggerAndQuery(textBeforeCursor: string): { triggerStart: number; query: string } | null {
        // Start-of-line: position 0, or preceded by '\n'. The slash-trigger
        // fires only at line starts so mid-prose '/' (e.g. "he/she") doesn't
        // pop the dropdown. After the slash, only kebab-case name chars are a
        // valid query — any other character (whitespace, uppercase, punctuation)
        // closes the dropdown.
        const lineStart = textBeforeCursor.lastIndexOf('\n') + 1; // 0 if no newline before cursor
        const lineUpToCursor = textBeforeCursor.slice(lineStart);

        const triggerMatch = lineUpToCursor.match(/^\/([a-z0-9-]*)$/);
        if (!triggerMatch) return null;

        return { triggerStart: lineStart, query: triggerMatch[1] ?? '' };
    }

    protected filterItems(query: string): RankedCommand[] {
        const commands = this.plugin.settings.slashCommands;
        if (commands.length === 0) return [];

        // Exclude blank/invalid drafts — commands the writer added in settings
        // but hasn't named yet (or whose name doesn't pass validation). These
        // should never appear in the live picker.
        const valid = commands.filter((cmd) => SLASH_COMMAND_NAME_PATTERN.test(cmd.name));
        if (valid.length === 0) return [];

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

        return items;
    }

    protected renderItem(item: RankedCommand, row: HTMLElement, lowerQuery: string): void {
        const nameRow = row.createDiv({ cls: `${this.cssBlock()}__name-row` });
        nameRow.createSpan({ cls: `${this.cssBlock()}__slash`, text: '/' });

        const name = item.name;
        const lowerName = name.toLowerCase();
        const matchIdx = lowerQuery === '' ? -1 : lowerName.indexOf(lowerQuery);

        if (matchIdx >= 0) {
            const before = name.slice(0, matchIdx);
            const match = name.slice(matchIdx, matchIdx + lowerQuery.length);
            const after = name.slice(matchIdx + lowerQuery.length);
            if (before) nameRow.createSpan({ text: before });
            nameRow.createSpan({ cls: `${this.cssBlock()}__highlight`, text: match });
            if (after) nameRow.createSpan({ text: after });
        } else {
            nameRow.createSpan({ text: name });
        }

        if (item.description) {
            row.createDiv({ cls: `${this.cssBlock()}__desc`, text: item.description });
        }
    }

    protected commitItem(item: RankedCommand, triggerStart: number, cursorPos: number): void {
        const value = this.inputEl.value;
        const textBeforeTrigger = value.slice(0, triggerStart);
        const textAfterCursor = value.slice(cursorPos);

        // Replace the `/query` run with the command body. The text is fully
        // editable — cursor lands at the end of `body`, the writer can
        // backspace, append specifics, or send as-is.
        this.inputEl.value = textBeforeTrigger + item.body + textAfterCursor;

        const newCursor = triggerStart + item.body.length;
        this.inputEl.setSelectionRange(newCursor, newCursor);
    }
}
