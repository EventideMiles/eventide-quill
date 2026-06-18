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

/**
 * Copy the live (mapPos-remapped) positions from the editor's diff field back
 * into a {@link ChangeSet}'s pending edits. Call this before approving or
 * rejecting so the ChangeSet's stored offsets match the document even after the
 * writer manually edits during review: the diff field remaps via `mapPos` on
 * every change, but the ChangeSet is pure logic and does not, so its offsets go
 * stale until re-synced here. Without this, an approve could dispatch at a
 * pre-edit offset and mangle surrounding text.
 */
export function syncChangeSetPositions(view: EditorView, changeSet: ChangeSet, owner: string): void {
    const snapshots = view.state.field(diffEditsField);
    if (!snapshots || snapshots.length === 0) return;
    for (const snap of snapshots) {
        if (snap.owner !== owner) continue;
        const edit = changeSet.get(snap.id);
        if (edit && edit.state === 'pending') {
            edit.from = snap.from;
            edit.to = snap.to;
        }
    }
}

/** A single widget rendering a proposed edit's diff: the removed text in a red
 *  box (struck through) when present, and the replacement in a green box with
 *  inline Approve/Reject. Both boxes live in one widget so they always render
 *  stacked and distinctly separated — avoiding the CM conflict where a point
 *  widget at the end of a replaced range gets swallowed. */
class ChangePreviewWidget extends WidgetType {
    constructor(
        private readonly removedText: string,
        private readonly edit: DiffEditSnapshot,
        private readonly handlers: ChangeDiffHandlers
    ) {
        super();
    }

    /** Whether this widget is equivalent to `other` (same owner, id, text, state),
     *  so CodeMirror can reuse DOM. The owner comparison prevents widgets from
     *  different surfaces (e.g. 'fulfill' vs 'transform') from being confused. */
    eq(other: ChangePreviewWidget): boolean {
        return (
            this.removedText === other.removedText &&
            this.edit.id === other.edit.id &&
            this.edit.newText === other.edit.newText &&
            this.edit.state === other.edit.state &&
            this.edit.owner === other.edit.owner
        );
    }

    /** Build the widget DOM: red removed box (when present) + green added box
     *  with inline Approve/Reject controls (only once generation is final). */
    toDOM(): HTMLElement {
        const wrap = window.activeDocument.createElement('div');
        wrap.className = 'quill-diff-group';

        // Removed (red) — only when there is old text being replaced.
        if (this.removedText.length > 0) {
            const removed = window.activeDocument.createElement('div');
            removed.className = 'quill-diff-removed-box';
            removed.textContent = this.removedText;
            wrap.appendChild(removed);
        }

        // Added (green) — the replacement text + controls.
        const added = window.activeDocument.createElement('div');
        added.className = 'quill-diff-added';

        const prose = window.activeDocument.createElement('div');
        prose.className = 'quill-diff-added-prose';
        prose.textContent = this.edit.newText;
        added.appendChild(prose);

        // Controls only once generation has concluded (or been cancelled with
        // partial content kept for review). While 'generating', show a muted
        // "Generating\u2026" hint instead so nobody can approve mid-stream.
        if (this.edit.state === 'pending') {
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
            added.appendChild(controls);
        } else if (this.edit.state === 'generating') {
            const hint = window.activeDocument.createElement('div');
            hint.className = 'quill-diff-generating';
            hint.textContent = 'Generating\u2026';
            added.appendChild(hint);
        }

        wrap.appendChild(added);
        return wrap;
    }

    /** Let CodeMirror forward events to the editor (so keyboard/click still
     *  reach the underlying editor within the widget range). */
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

    /** Rebuild the decoration set when the diff-edits state field changes. */
    update(update: ViewUpdate): void {
        const prev = update.startState.field(diffEditsField);
        const next = update.state.field(diffEditsField);
        if (next !== prev) {
            this.decorations = this.build(update.view);
        }
    }

    /** Tear down the plugin (no external resources to release). */
    destroy(): void {
        // nothing to clean up
    }

    /** Build the decoration set from the current diff-edits snapshots: a red
     *  range/widget for removed text and a green change-preview widget. */
    private build(view: EditorView): DecorationSet {
        const edits = view.state.field(diffEditsField);
        if (edits.length === 0) return Decoration.none;
        const doc = view.state.doc;
        const ranges: Range<Decoration>[] = [];
        for (const edit of edits) {
            // Render the box while streaming ('generating') and for review ('pending');
            // 'approved'/'rejected' are committed/discarded and get no decoration.
            if (edit.state !== 'pending' && edit.state !== 'generating') continue;
            const hasRemoval = edit.from < edit.to;
            if (hasRemoval) {
                const spansMultipleLines = doc.lineAt(edit.from).number !== doc.lineAt(edit.to).number;
                if (spansMultipleLines) {
                    // Multi-line: a ViewPlugin cannot create a replace that crosses
                    // line breaks. Mark the removed text (red bg + strikethrough)
                    // and drop the green widget below — both are ViewPlugin-safe.
                    ranges.push(Decoration.mark({ class: 'quill-diff-removed-mark' }).range(edit.from, edit.to));
                    const widget = new ChangePreviewWidget('', edit, this.handlers);
                    ranges.push(Decoration.widget({ widget, side: 1 }).range(edit.to));
                } else {
                    // Single-line: replace widget (red box + green box stacked).
                    const removedText = doc.sliceString(edit.from, edit.to);
                    const widget = new ChangePreviewWidget(removedText, edit, this.handlers);
                    ranges.push(Decoration.replace({ widget }).range(edit.from, edit.to));
                }
            } else {
                // Pure insertion: no range to replace, drop the widget at the point.
                const widget = new ChangePreviewWidget('', edit, this.handlers);
                ranges.push(Decoration.widget({ widget, side: 1 }).range(edit.from));
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
