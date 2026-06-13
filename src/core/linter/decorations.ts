import { StateEffect } from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    ViewUpdate,
} from '@codemirror/view';
import { LintResult } from './types';

export const setLintResults = StateEffect.define<LintResult[]>();
export const toggleLintActive = StateEffect.define<boolean>();

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
            const from = view.state.doc.line(result.line).from + result.column - 1;
            const to = Math.min(from + result.length, view.state.doc.length);

            if (from >= view.state.doc.length || to > view.state.doc.length) continue;

            const color = severityColors[result.severity] || 'var(--color-cyan)';

            const mark = Decoration.mark({
                class: 'quill-lint-rule',
                attributes: {
                    style: `text-decoration: underline wavy ${color}; text-underline-offset: 2px;`,
                    title: `[${result.rule}] ${result.message}`,
                },
            });

            ranges.push(mark.range(from, to));
        }

        return Decoration.set(ranges, true);
    }
}

export function getLintExtension(
    lintFn: (text: string) => LintResult[],
    onResults?: (results: LintResult[]) => void,
): ViewPlugin<LintDecorations> {
    return ViewPlugin.define(
        (view: EditorView) => new LintDecorations(view, lintFn, onResults),
        { decorations: (instance) => instance.decorations },
    );
}
