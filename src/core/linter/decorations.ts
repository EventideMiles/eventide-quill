import { StateEffect, StateField } from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    ViewUpdate,
    showTooltip,
    Tooltip,
} from '@codemirror/view';
import { LintResult, FIXABLE_RULES } from './types';
import { FIXES } from './fixes';

export const setLintResults = StateEffect.define<LintResult[]>();
export const toggleLintActive = StateEffect.define<boolean>();
export const setPinnedTooltip = StateEffect.define<{ pos: number; result: LintResult } | null>();

export const lintResultsField = StateField.define<LintResult[]>({
    create: () => [],
    update(results, tr) {
        for (const e of tr.effects) {
            if (e.is(setLintResults)) return e.value;
        }
        return results;
    },
});

const pinnedTooltipField = StateField.define<{ pos: number; result: LintResult } | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setPinnedTooltip)) return e.value;
            if (e.is(setLintResults)) return null;
        }
        if (tr.docChanged) return null;
        return value;
    },
});

const severityColors: Record<string, string> = {
    error: 'var(--color-red)',
    warning: 'var(--color-orange)',
    info: 'var(--color-cyan)',
};

const DEBOUNCE_MS = 500;

class LintDecorations {
    decorations: DecorationSet = Decoration.none;
    private lintFn: (text: string) => LintResult[];
    private onResults: ((results: LintResult[]) => void) | null;
    private debounceTimer: number | null = null;
    private active = false;

    constructor(
        view: EditorView,
        lintFn: (text: string) => LintResult[],
        onResults?: (results: LintResult[]) => void,
    ) {
        this.lintFn = lintFn;
        this.onResults = onResults ?? null;
    }

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

    destroy() {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
    }

    private scheduleLint(view: EditorView) {
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
            const text = view.state.doc.toString();
            const results = this.lintFn(text);
            view.dispatch({
                effects: setLintResults.of(results),
            });
            this.onResults?.(results);
            this.debounceTimer = null;
        }, DEBOUNCE_MS);
    }

    private buildFromResults(results: LintResult[], view: EditorView): DecorationSet {
        const ranges: { from: number; to: number; value: Decoration }[] = [];

        for (const result of results) {
            const from = view.state.doc.line(result.line).from + result.column;
            const to = Math.min(from + result.length, view.state.doc.length);

            if (from >= view.state.doc.length || to > view.state.doc.length) continue;

            const color = severityColors[result.severity] || 'var(--color-cyan)';

            const mark = Decoration.mark({
                class: 'quill-lint-rule',
                attributes: {
                    style: `text-decoration: underline wavy ${color}; text-underline-offset: 2px;`,
                },
            });

            ranges.push(mark.range(from, to));
        }

        return Decoration.set(ranges, true);
    }
}

function applyFix(view: EditorView, result: LintResult): void {
    if (!FIXABLE_RULES.has(result.rule)) return;
    const fix = FIXES[result.rule];
    if (!fix) return;

    const doc = view.state.doc;
    const from = doc.line(result.line).from + result.column;
    const to = Math.min(from + result.length, doc.length);

    const text = doc.toString();
    const replacement = fix.apply(text, result.line, result.column, result.length);
    if (replacement === null) return;

    view.dispatch({
        changes: { from, to, insert: replacement },
    });
}

function resultAtPos(view: EditorView, pos: number): { pos: number; result: LintResult } | null {
    const results = view.state.field(lintResultsField);
    for (const r of results) {
        const from = view.state.doc.line(r.line).from + r.column;
        const to = from + r.length;
        if (pos >= from && pos < to) {
            return { pos: from, result: r };
        }
    }
    return null;
}

export function getLintExtension(
    lintFn: (text: string) => LintResult[],
    onResults?: (results: LintResult[]) => void,
) {
    return [
        lintResultsField,
        pinnedTooltipField,
        showTooltip.from(pinnedTooltipField, (pinned): Tooltip | null => {
            if (!pinned) return null;

            return {
                pos: pinned.pos,
                above: true,
                create(view: EditorView) {
                    const resolved = getComputedStyle(view.dom);

                    const dom = window.activeDocument.createElement('div');
                    dom.className = 'quill-lint-tooltip';
                    dom.style.background = resolved.getPropertyValue('--background-primary');
                    dom.style.color = resolved.getPropertyValue('--text-normal');
                    dom.style.border = '1px solid ' + resolved.getPropertyValue('--background-modifier-border');
                    dom.style.boxShadow = '0 2px 8px ' + resolved.getPropertyValue('--background-modifier-box-shadow');

                    const msg = window.activeDocument.createElement('div');
                    msg.className = 'quill-lint-tooltip-msg';
                    msg.style.color = resolved.getPropertyValue('--text-muted');
                    msg.textContent = `[${pinned.result.rule}] ${pinned.result.message}`;
                    dom.appendChild(msg);

                    const fix = FIXES[pinned.result.rule];
                    if (fix) {
                        const btn = window.activeDocument.createElement('button');
                        btn.className = 'quill-lint-fix-btn';
                        btn.style.background = resolved.getPropertyValue('--interactive-accent');
                        btn.style.color = resolved.getPropertyValue('--text-on-accent');
                        btn.textContent = fix.description;
                        btn.addEventListener('click', (e: MouseEvent) => {
                            e.stopPropagation();
                            applyFix(view, pinned.result);
                        });
                        dom.appendChild(btn);
                    }

                    return { dom };
                },
            };
        }),
        ViewPlugin.define(
            (view: EditorView) => new LintDecorations(view, lintFn, onResults),
            { decorations: (instance) => instance.decorations },
        ),
        EditorView.domEventHandlers({
            click: (event: MouseEvent, view: EditorView) => {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return false;

                const hit = resultAtPos(view, pos);
                if (hit) {
                    view.dispatch({
                        effects: setPinnedTooltip.of(hit),
                    });
                    return false;
                }

                view.dispatch({
                    effects: setPinnedTooltip.of(null),
                });
                return false;
            },
            keydown: (event: KeyboardEvent, view: EditorView) => {
                if (event.key === 'Escape') {
                    const pinned = view.state.field(pinnedTooltipField);
                    if (pinned) {
                        view.dispatch({
                            effects: setPinnedTooltip.of(null),
                        });
                    }
                }
                return false;
            },
        }),
    ];
}
