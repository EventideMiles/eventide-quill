import { Range, StateEffect } from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    ViewUpdate,
} from '@codemirror/view';
import { LintResult } from './types';

export const setLintResults = StateEffect.define<LintResult[]>();

const severityColors: Record<string, string> = {
    error: 'var(--color-red)',
    warning: 'var(--color-orange)',
    info: 'var(--color-cyan)',
};

class LintDecorations {
    decorations: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
        this.decorations = this.buildFromResults([], view);
    }

    update(update: ViewUpdate) {
        for (const tr of update.transactions) {
            for (const e of tr.effects) {
                if (e.is(setLintResults)) {
                    this.decorations = this.buildFromResults(e.value, update.view);
                    return;
                }
            }
        }

        if (update.docChanged) {
            this.decorations = Decoration.none;
        }
    }

    private buildFromResults(results: LintResult[], view: EditorView): DecorationSet {
        const ranges: Range<Decoration>[] = [];

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

export const lintPlugin = ViewPlugin.fromClass(LintDecorations, {
    decorations: (instance) => instance.decorations,
});

export function getLintExtension() {
    return [lintPlugin];
}
