import { Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import type { ChangeSet, ProposedEdit } from '../core/change-set';

/**
 * Inline diff rendering for proposed edits, shared across every AI-insertion
 * surface (Fulfill, Transform, and later Co-writer direct).
 *
 * Renders each pending edit as: a red strikethrough mark over its `[from, to)`
 * range (the text being removed) and a green widget at `to` showing the
 * replacement text with inline Approve/Reject buttons. Approved edits are
 * committed by the caller (no decoration); rejected edits get no decoration.
 *
 * Position robustness: the {@link diffEditsField} remaps positions via
 * `mapPos` on any document change, so the display stays correct even if the
 * writer edits the document mid-review. Authoritative snapshots pushed via
 * {@link setDiffEdits} are applied verbatim (the caller is responsible for
 * their positions, e.g., after a commit it pushes an already-remapped set).
 */

/** A snapshot of an edit used for rendering. Mirrors {@link ProposedEdit}, plus an
 *  `owner` tag so the inline Approve/Reject buttons route to the right surface
 *  (the extension is registered once globally but shared by Fulfill, Transform, etc.). */
export interface DiffEditSnapshot {
    id: number;
    from: number;
    to: number;
    newText: string;
    label: string;
    state: ProposedEdit['state'];
    /** Which surface owns this edit (e.g. 'fulfill', 'transform'). Routes approve/reject. */
    owner: string;
}

/** Handlers invoked from the inline Approve/Reject buttons. */
export interface ChangeDiffHandlers {
    onApprove?: (owner: string, id: number) => void;
    onReject?: (owner: string, id: number) => void;
}

/** Push a new set of edit snapshots to the editor (empty array clears the diff). */
export const setDiffEdits = StateEffect.define<DiffEditSnapshot[]>();

/** State field holding the current edit snapshots. Remaps positions on doc changes. */
export const diffEditsField = StateField.define<DiffEditSnapshot[]>({
    create: () => [],
    update(value, tr) {
        for (const e of tr.effects) {
            // An explicit snapshot is authoritative (already positioned by the caller).
            if (e.is(setDiffEdits)) return e.value;
        }
        if (tr.docChanged) {
            // Remap positions for any document change not accompanied by a snapshot
            // (e.g., the writer typing mid-review).
            return value.map((ed) => ({
                ...ed,
                from: tr.changes.mapPos(ed.from),
                to: tr.changes.mapPos(ed.to, -1)
            }));
        }
        return value;
    }
});

/** Build render snapshots from a ChangeSet's edits, tagged with the owning surface. */
export function toDiffSnapshots(changeSet: ChangeSet, owner: string): DiffEditSnapshot[] {
    return changeSet.edits.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        newText: e.newText,
        label: e.label,
        state: e.state,
        owner
    }));
}

/** A bounded red box showing the removed text (struck through). Replaces the
 *  original range so it reads as its own block, distinctly separated from the
 *  green added box below it (no full-line wash, no bleed under the green box). */
class RemovedBoxWidget extends WidgetType {
    constructor(private readonly removedText: string) {
        super();
    }

    eq(other: RemovedBoxWidget): boolean {
        return this.removedText === other.removedText;
    }

    toDOM(): HTMLElement {
        const wrap = window.activeDocument.createElement('div');
        wrap.className = 'quill-diff-removed-box';
        wrap.textContent = this.removedText;
        return wrap;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/** A green widget showing the replacement text with inline Approve/Reject buttons. */
class ChangeWidget extends WidgetType {
    constructor(
        private readonly edit: DiffEditSnapshot,
        private readonly handlers: ChangeDiffHandlers
    ) {
        super();
    }

    eq(other: ChangeWidget): boolean {
        return (
            this.edit.id === other.edit.id &&
            this.edit.newText === other.edit.newText &&
            this.edit.state === other.edit.state
        );
    }

    toDOM(): HTMLElement {
        const wrap = window.activeDocument.createElement('div');
        wrap.className = 'quill-diff-added';

        const prose = window.activeDocument.createElement('div');
        prose.className = 'quill-diff-added-prose';
        prose.textContent = this.edit.newText;
        wrap.appendChild(prose);

        const controls = window.activeDocument.createElement('div');
        controls.className = 'quill-diff-controls';
        const approve = window.activeDocument.createElement('button');
        approve.className = 'mod-cta quill-diff-btn';
        approve.textContent = 'Approve';
        approve.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.handlers.onApprove?.(this.edit.owner, this.edit.id);
        });
        const reject = window.activeDocument.createElement('button');
        reject.className = 'quill-diff-btn';
        reject.textContent = 'Reject';
        reject.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.handlers.onReject?.(this.edit.owner, this.edit.id);
        });
        controls.appendChild(approve);
        controls.appendChild(reject);
        wrap.appendChild(controls);
        return wrap;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** ViewPlugin that builds the decoration set from {@link diffEditsField}. */
class ChangeDiffPlugin {
    decorations: DecorationSet;
    constructor(
        view: EditorView,
        private readonly handlers: ChangeDiffHandlers
    ) {
        this.decorations = this.build(view);
    }

    update(update: ViewUpdate): void {
        const prev = update.startState.field(diffEditsField);
        const next = update.state.field(diffEditsField);
        if (next !== prev) {
            this.decorations = this.build(update.view);
        }
    }

    destroy(): void {
        // nothing to clean up
    }

    private build(view: EditorView): DecorationSet {
        const edits = view.state.field(diffEditsField);
        if (edits.length === 0) return Decoration.none;
        const doc = view.state.doc;
        const ranges: Range<Decoration>[] = [];
        for (const edit of edits) {
            if (edit.state !== 'pending') continue;
            if (edit.from < edit.to) {
                // Removed text as a bounded red block widget (replaces the range,
                // so it is its own box — distinctly separated from the green box).
                const removedText = doc.sliceString(edit.from, edit.to);
                ranges.push(
                    Decoration.replace({ widget: new RemovedBoxWidget(removedText), block: false }).range(
                        edit.from,
                        edit.to
                    )
                );
            }
            if (edit.newText.length > 0) {
                ranges.push(
                    Decoration.widget({ widget: new ChangeWidget(edit, this.handlers), side: 1 }).range(edit.to)
                );
            }
        }
        return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
    }
}

/** Return the CodeMirror extension bundle for inline change-diff rendering. */
export function getChangeDiffExtension(handlers: ChangeDiffHandlers): Extension[] {
    return [
        diffEditsField,
        ViewPlugin.define((view) => new ChangeDiffPlugin(view, handlers), {
            decorations: (plugin) => plugin.decorations
        })
    ];
}

/** Push a snapshot set to a view (convenience). */
export function pushDiffEdits(view: EditorView, snapshots: DiffEditSnapshot[]): void {
    view.dispatch({ effects: setDiffEdits.of(snapshots) });
}

/** Clear the diff in a view. */
export function clearDiffEdits(view: EditorView): void {
    view.dispatch({ effects: setDiffEdits.of([]) });
}
