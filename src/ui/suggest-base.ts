import { App, Component } from 'obsidian';

/**
 * Base class for inline autocomplete dropdowns attached to a textarea.
 *
 * Captures the shared lifecycle, event handling, keyboard navigation, and
 * dropdown rendering for "trigger character + filter + insert" patterns.
 * Concrete subclasses implement the four pieces that vary:
 *
 *   1. Trigger detection — `getTriggerAndQuery` (e.g. `@` anywhere vs. `/`
 *      at line start, plus per-mode validity guards).
 *   2. Item filtering + ranking — `filterItems`.
 *   3. Per-row rendering — `renderItem`.
 *   4. Commit insertion — `commitItem` (what text to splice into the textarea).
 *
 * Subclasses also declare their BEM block name via `cssBlock()` so the base
 * can construct the wrapper / item / selected / highlight class names without
 * each subclass repeating the string concatenation.
 *
 * Lifecycle: pass a `Component` on construction. The base registers four DOM
 * events (input, keydown, blur, document mousedown) on that component via
 * `registerDomEvent`, so re-rendering the parent tears the suggester down
 * automatically. The wrapper element is removed in `destroy()`.
 *
 * Dismisses on: Escape, click outside, blur (150ms deferred so a row mousedown
 * can commit first), or when `filterItems` returns an empty list.
 *
 * The 150ms deferred close is a raw `window.setTimeout` rather than a registered
 * interval — it's a one-shot UX deferral that fires at most once per blur and
 * cannot outlive the input element (which tears down with the panel). Same
 * pattern as the other one-shot timers in `ui/`.
 */
export abstract class SuggestBase<TItem> {
    protected app: App;
    protected inputEl: HTMLTextAreaElement;
    protected suggestEl: HTMLElement | null = null;
    protected wrapperEl: HTMLElement;
    protected selectedIndex = 0;
    protected currentItems: TItem[] = [];
    protected currentQuery = '';
    protected currentTriggerStart = 0;
    protected isOpen = false;
    private justCommitted = false;

    constructor(app: App, inputEl: HTMLTextAreaElement, lifecycle: Component) {
        this.app = app;
        this.inputEl = inputEl;

        // Wrapper sits inside the textarea's parent, positioned over it
        // (parent is `position: relative` at the call site).
        const containerEl = inputEl.parentElement ?? inputEl;
        this.wrapperEl = containerEl.createDiv({
            cls: `${this.cssBlock()}-wrapper`
        });

        // Register DOM events through the Component lifecycle so they
        // auto-clean-up on re-render. Only the wrapper needs manual cleanup
        // (in destroy(), registered separately below).
        lifecycle.registerDomEvent(inputEl, 'input', this.onInput);
        lifecycle.registerDomEvent(inputEl, 'keydown', this.onKeydown);
        lifecycle.registerDomEvent(inputEl, 'blur', this.onBlur);
        lifecycle.registerDomEvent(window.activeDocument, 'mousedown', this.onDocumentMouseDown);

        lifecycle.register(() => this.destroy());
    }

    // ── Abstract surface (subclass-specific) ───────────────────────

    /** BEM block name, e.g. `quill-file-mention-suggest`. */
    protected abstract cssBlock(): string;

    /**
     * Find the trigger and extract the query from the text before the cursor.
     * Return `null` to dismiss the dropdown (no active trigger, invalid query,
     * mid-email detection, etc.). The returned `triggerStart` is preserved on
     * the instance as `currentTriggerStart` for use at commit time.
     */
    protected abstract getTriggerAndQuery(textBeforeCursor: string): { triggerStart: number; query: string } | null;

    /**
     * Filter and rank items by the (case-insensitive) query. The caller caps
     * the result at 12. Return an empty array to dismiss the dropdown.
     */
    protected abstract filterItems(query: string): TItem[];

    /**
     * Render one row's content. The wrapper `__item` div is already created
     * and the mousedown-to-commit handler is already attached; subclasses only
     * add the visible content (highlighted match text, descriptions, etc.).
     */
    protected abstract renderItem(item: TItem, row: HTMLElement, lowerQuery: string): void;

    /**
     * Build and insert the committed text into `this.inputEl`. Called with the
     * stored trigger start and the cursor position at commit time. Subclasses
     * are responsible for splicing the textarea value and restoring cursor
     * position; the base handles the synthetic input event and the
     * `justCommitted` guard that prevents the dropdown from immediately
     * re-opening on that event.
     */
    protected abstract commitItem(item: TItem, triggerStart: number, cursorPos: number): void;

    // ── Input handling ─────────────────────────────────────────────

    protected onInput = (): void => {
        if (this.justCommitted) {
            this.justCommitted = false;
            return;
        }

        const cursorPos = this.inputEl.selectionStart ?? 0;
        const textBeforeCursor = this.inputEl.value.slice(0, cursorPos);

        const trigger = this.getTriggerAndQuery(textBeforeCursor);
        if (!trigger) {
            this.close();
            return;
        }

        this.currentQuery = trigger.query;
        this.currentTriggerStart = trigger.triggerStart;
        this.filterAndShow(trigger.query);
    };

    protected onKeydown = (e: KeyboardEvent): void => {
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
            // Enter is the panel's send key — stopImmediatePropagation keeps
            // the panel's send handler from firing while the picker is open.
            e.preventDefault();
            e.stopImmediatePropagation();
            this.commitSelection();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    };

    protected onBlur = (): void => {
        // Delay close so a mousedown on the dropdown can commit first.
        // One-shot raw setTimeout (see class JSDoc) — fires at most once per
        // blur and cannot outlive the input element, which tears down with
        // the panel via the registered destroy().
        window.setTimeout(() => {
            if (window.activeDocument.activeElement !== this.inputEl) {
                this.close();
            }
        }, 150);
    };

    protected onDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.isOpen) return;
        if (this.suggestEl && !this.suggestEl.contains(e.target as Node)) {
            this.close();
        }
    };

    // ── Filtering + rendering ──────────────────────────────────────

    protected filterAndShow(query: string): void {
        const items = this.filterItems(query);
        this.currentItems = items.slice(0, 12);
        this.selectedIndex = 0;

        if (this.currentItems.length === 0) {
            this.close();
            return;
        }

        this.renderDropdown();
    }

    protected renderDropdown(): void {
        if (!this.suggestEl) {
            this.suggestEl = this.wrapperEl.createDiv({ cls: this.cssBlock() });
        }

        this.suggestEl.empty();

        const lowerQuery = this.currentQuery.toLowerCase();

        for (let i = 0; i < this.currentItems.length; i++) {
            const item = this.currentItems[i]!;
            const isSelected = i === this.selectedIndex;
            const row = this.suggestEl.createDiv({
                cls: `${this.cssBlock()}__item${isSelected ? ` ${this.cssBlock()}__item--selected` : ''}`
            });

            this.renderItem(item, row, lowerQuery);

            // Raw addEventListener (not registerDomEvent) is correct here:
            // the listener's lifetime is bounded by the row DOM element,
            // which is removed in close() — auto-cleaned, no leak. Using
            // registerDomEvent on the parent lifecycle would accumulate
            // row handlers across re-renders for no safety benefit.
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.selectedIndex = i;
                this.commitSelection();
            });
        }

        this.isOpen = true;
    }

    protected highlightSelected(): void {
        if (!this.suggestEl) return;
        const items = this.suggestEl.querySelectorAll(`.${this.cssBlock()}__item`);
        items.forEach((el, i) => {
            el.toggleClass(`${this.cssBlock()}__item--selected`, i === this.selectedIndex);
        });
        const selected = items[this.selectedIndex] as HTMLElement | undefined;
        selected?.scrollIntoView({ block: 'nearest' });
    }

    // ── Selection ──────────────────────────────────────────────────

    protected commitSelection(): void {
        const selected = this.currentItems[this.selectedIndex];
        if (!selected) return;

        const cursorPos = this.inputEl.selectionStart ?? 0;
        this.commitItem(selected, this.currentTriggerStart, cursorPos);

        // Mark committed and fire input so the panel tracks value (the panel's
        // input listener updates `this.inputValue`). The guard in onInput
        // prevents the dropdown from re-opening on the synthetic event.
        this.justCommitted = true;
        this.close();
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    protected close = (): void => {
        this.suggestEl?.remove();
        this.suggestEl = null;
        this.isOpen = false;
        this.currentItems = [];
        this.currentQuery = '';
    };

    protected destroy(): void {
        this.close();
        // DOM event listeners are auto-removed by the Component lifecycle
        // (registerDomEvent). Only the wrapper needs manual cleanup.
        this.wrapperEl.remove();
    }
}
