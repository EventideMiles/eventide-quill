import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, showTooltip, Tooltip } from '@codemirror/view';
import { LintResult, FIXABLE_RULES } from './types';
import { FIXES } from './fixes';
import { applyCmReplacement } from './apply-fix';

/** Callback for when the user clicks "Fix with AI" in the in-editor tooltip. Includes originating EditorView for split-view correctness. */
export type AiFixTooltipHandler = (result: LintResult, view: EditorView) => void;

/** Callback for when the user dismisses a lint result from the in-editor tooltip. Includes originating EditorView for split-view correctness. */
export type DismissHandler = (result: LintResult, view: EditorView) => void;

/** Returns whether the "Fix with AI" button should appear in tooltips. Evaluated at tooltip creation time so setting changes take effect immediately. */
export type AiFixEnabledGetter = () => boolean;

export const setLintResults = StateEffect.define<LintResult[]>();
export const toggleLintActive = StateEffect.define<boolean>();
export const setPinnedTooltip = StateEffect.define<{ pos: number; end: number; result: LintResult } | null>();

export const lintResultsField = StateField.define<LintResult[]>({
    create: () => [],
    update(results, tr) {
        for (const e of tr.effects) {
            if (e.is(setLintResults)) return e.value;
        }
        return results;
    }
});

const pinnedTooltipField = StateField.define<{ pos: number; end: number; result: LintResult } | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setPinnedTooltip)) return e.value;
            if (e.is(setLintResults)) return null;
        }
        if (tr.docChanged) return null;
        return value;
    }
});

const severityColors: Record<string, string> = {
    error: 'var(--color-red)',
    warning: 'var(--color-orange)',
    info: 'var(--color-cyan)'
};

const DEBOUNCE_MS = 500;

class LintDecorations {
    decorations: DecorationSet = Decoration.none;
    private lintFn: (text: string) => LintResult[];
    private onResults: ((results: LintResult[]) => void) | null;
    private debounceTimer: number | null = null;
    private active = false;

    /** Create a LintDecorations plugin instance bound to the given lint function. */
    constructor(view: EditorView, lintFn: (text: string) => LintResult[], onResults?: (results: LintResult[]) => void) {
        this.lintFn = lintFn;
        this.onResults = onResults ?? null;
    }

    /** Process ViewUpdates: apply state effects and re-lint on document changes. */
    update(update: ViewUpdate) {
        let decorationsUpdated = false;

        for (const tr of update.transactions) {
            for (const e of tr.effects) {
                if (e.is(toggleLintActive)) {
                    this.active = e.value;
                    if (!this.active) {
                        this.decorations = Decoration.none;
                        decorationsUpdated = true;
                    }
                }
                if (e.is(setLintResults)) {
                    this.decorations = this.buildFromResults(e.value, update.view);
                    decorationsUpdated = true;
                }
            }
        }

        if (decorationsUpdated) return;

        if (update.docChanged && this.active) {
            this.scheduleLint(update.view);
        }
    }

    /** Clean up the debounce timer when the view is destroyed. */
    destroy() {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
    }

    /** Schedule a debounced lint run after document changes. */
    private scheduleLint(view: EditorView) {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
            const text = view.state.doc.toString();
            const results = this.lintFn(text);
            view.dispatch({
                effects: setLintResults.of(results)
            });
            this.onResults?.(results);
            this.debounceTimer = null;
        }, DEBOUNCE_MS);
    }

    /** Build a DecorationSet from lint results, creating wavy underlines for each issue. */
    private buildFromResults(results: LintResult[], view: EditorView): DecorationSet {
        const ranges: { from: number; to: number; value: Decoration }[] = [];

        for (const result of results) {
            const from = view.state.doc.line(result.line).from + result.column;
            const to = Math.min(from + result.length, view.state.doc.length);

            if (from >= view.state.doc.length || to > view.state.doc.length) continue;

            const color = severityColors[result.severity] || 'var(--color-cyan)';

            const mark = Decoration.mark({
                class: 'quill-linter__rule',
                attributes: {
                    style: `text-decoration: underline wavy ${color}; text-underline-offset: 2px;`
                }
            });

            ranges.push(mark.range(from, to));
        }

        return Decoration.set(ranges, true);
    }
}

/** Apply an auto-fix for a lint result to the editor document. */
function applyFix(view: EditorView, result: LintResult): void {
    if (!FIXABLE_RULES.has(result.rule)) return;
    const fix = FIXES[result.rule];
    if (!fix) return;

    const doc = view.state.doc;
    const text = doc.toString();
    const replacement = fix.apply(text, result.line, result.column, result.length);
    if (replacement === null) return;

    applyCmReplacement(view, result, replacement);
}

/** Find the lint result whose range includes `pos`, or null. */
function resultAtPos(view: EditorView, pos: number): { pos: number; end: number; result: LintResult } | null {
    const results = view.state.field(lintResultsField);
    for (const r of results) {
        const from = view.state.doc.line(r.line).from + r.column;
        const to = from + r.length;
        if (pos >= from && pos < to) {
            return { pos: from, end: to, result: r };
        }
    }
    return null;
}

/** Return a CodeMirror extension bundle that wires up lint decorations, tooltips, and click handling. */
export function getLintExtension(
    lintFn: (text: string) => LintResult[],
    onResults?: (results: LintResult[]) => void,
    onAiFix?: AiFixTooltipHandler,
    onDismiss?: DismissHandler,
    isAiFixEnabled?: AiFixEnabledGetter
) {
    return [
        lintResultsField,
        pinnedTooltipField,
        showTooltip.from(pinnedTooltipField, (pinned): Tooltip | null => {
            if (!pinned) return null;

            return {
                pos: pinned.pos,
                end: pinned.end,
                above: true,
                clip: false,
                arrow: true,
                create(view: EditorView) {
                    const resolved = getComputedStyle(view.dom);

                    const dom = window.activeDocument.createElement('div');
                    dom.className = 'quill-linter-tooltip';
                    dom.style.background = resolved.getPropertyValue('--background-primary');
                    dom.style.color = resolved.getPropertyValue('--text-normal');
                    dom.style.border = '1px solid ' + resolved.getPropertyValue('--background-modifier-border');
                    dom.style.boxShadow = '0 2px 8px ' + resolved.getPropertyValue('--background-modifier-box-shadow');

                    const msg = window.activeDocument.createElement('div');
                    msg.className = 'quill-linter-tooltip__msg';
                    msg.style.color = resolved.getPropertyValue('--text-muted');
                    msg.textContent = `[${pinned.result.rule}] ${pinned.result.message}`;
                    dom.appendChild(msg);

                    const btnRow = window.activeDocument.createElement('div');
                    btnRow.className = 'quill-linter-tooltip__btns';
                    dom.appendChild(btnRow);

                    const fix = FIXES[pinned.result.rule];
                    if (fix) {
                        const btn = window.activeDocument.createElement('button');
                        btn.className = 'quill-linter-tooltip__fix-btn';
                        btn.style.background = resolved.getPropertyValue('--interactive-accent');
                        btn.style.color = resolved.getPropertyValue('--text-on-accent');
                        btn.textContent = fix.description;
                        btn.addEventListener('click', (e: MouseEvent) => {
                            e.stopPropagation();
                            applyFix(view, pinned.result);
                        });
                        btnRow.appendChild(btn);
                    }

                    if (onAiFix && isAiFixEnabled?.() !== false) {
                        const aiBtn = window.activeDocument.createElement('button');
                        aiBtn.className = 'quill-linter-tooltip__ai-fix-btn';
                        aiBtn.textContent = 'Fix with AI';
                        aiBtn.addEventListener('click', (e: MouseEvent) => {
                            e.stopPropagation();
                            view.dispatch({
                                effects: setPinnedTooltip.of(null)
                            });
                            onAiFix(pinned.result, view);
                        });
                        btnRow.appendChild(aiBtn);
                    }

                    if (onDismiss) {
                        const dismissBtn = window.activeDocument.createElement('button');
                        dismissBtn.className = 'quill-linter-tooltip__dismiss-btn';
                        dismissBtn.textContent = 'Dismiss';
                        dismissBtn.addEventListener('click', (e: MouseEvent) => {
                            e.stopPropagation();
                            view.dispatch({
                                effects: setPinnedTooltip.of(null)
                            });
                            onDismiss(pinned.result, view);
                        });
                        btnRow.appendChild(dismissBtn);
                    }

                    return { dom };
                }
            };
        }),
        ViewPlugin.define((view: EditorView) => new LintDecorations(view, lintFn, onResults), {
            decorations: (instance) => instance.decorations
        }),
        EditorView.domEventHandlers({
            click: (event: MouseEvent, view: EditorView) => {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return false;

                const hit = resultAtPos(view, pos);
                if (hit) {
                    view.dispatch({
                        effects: setPinnedTooltip.of(hit)
                    });
                    return false;
                }

                view.dispatch({
                    effects: setPinnedTooltip.of(null)
                });
                return false;
            },
            keydown: (event: KeyboardEvent, view: EditorView) => {
                if (event.key === 'Escape') {
                    const pinned = view.state.field(pinnedTooltipField);
                    if (pinned) {
                        view.dispatch({
                            effects: setPinnedTooltip.of(null)
                        });
                    }
                }
                return false;
            }
        })
    ];
}
