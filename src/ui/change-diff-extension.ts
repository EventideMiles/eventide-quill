import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { ChangeSet, ProposedEdit } from '../core/change-set';

/**
 * Inline diff rendering for proposed edits, shared across every AI-insertion
 * surface (Fulfill, Transform, Direct, and lore-entry edits).
 *
 * Renders each pending edit as a stacked widget: a red strikethrough box
 * showing the removed text and a green box showing the replacement text with
 * inline Approve/Reject buttons. Approved edits are committed by the caller
 * (no decoration); rejected edits get no decoration.
 *
 * Decorations are provided from a {@link StateField} (not a ViewPlugin) so
 * that `Decoration.replace` can cross line breaks — critical for multi-line
 * lore edits that span Obsidian's block-level image-embed widgets. The
 * previous ViewPlugin approach fell back to a fragile `mark + point-widget`
 * split for multi-line edits, which dropped the green replacement widget
 * near image embeds.
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
    /** Which surface owns this edit (e.g. 'fulfill', 'transform', 'lore_edit'). Routes approve/reject. */
    owner: string;
    /**
     * For multi-file owners (currently 'lore_edit'): the vault path of the
     * file this edit targets. Passed to the approve/reject handlers so they
     * can route to the correct file's ChangeSet when multiple edits are
     * pending across different notes. Undefined for single-file owners.
     */
    filePath?: string;
}

/** Handlers invoked from the inline Approve/Reject buttons. */
export interface ChangeDiffHandlers {
    onApprove?: (owner: string, id: number, filePath?: string) => void;
    onReject?: (owner: string, id: number, filePath?: string) => void;
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

/**
 * Build render snapshots from a ChangeSet's edits, tagged with the owning
 * surface. Pass `filePath` for multi-file owners (e.g. 'lore_edit') so the
 * inline Approve/Reject buttons can route to the correct file's ChangeSet.
 */
export function toDiffSnapshots(changeSet: ChangeSet, owner: string, filePath?: string): DiffEditSnapshot[] {
    return changeSet.edits.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        newText: e.newText,
        label: e.label,
        state: e.state,
        owner,
        filePath
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
        wrap.className = 'quill-change-diff__group';

        // Removed (red) — only when there is old text being replaced.
        if (this.removedText.length > 0) {
            const removed = window.activeDocument.createElement('div');
            removed.className = 'quill-change-diff__removed-box';
            removed.textContent = this.removedText;
            wrap.appendChild(removed);
        }

        // Added (green) — the replacement text + controls.
        const added = window.activeDocument.createElement('div');
        added.className = 'quill-change-diff__added';

        const prose = window.activeDocument.createElement('div');
        prose.className = 'quill-change-diff__added-prose';
        prose.textContent = this.edit.newText;
        added.appendChild(prose);

        // Controls only once generation has concluded (or been cancelled with
        // partial content kept for review). While 'generating', show a muted
        // "Generating\u2026" hint instead so nobody can approve mid-stream.
        if (this.edit.state === 'pending') {
            const controls = window.activeDocument.createElement('div');
            controls.className = 'quill-change-diff__controls';
            const approve = window.activeDocument.createElement('button');
            approve.className = 'mod-cta quill-change-diff__btn';
            approve.textContent = 'Approve';
            approve.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                this.handlers.onApprove?.(this.edit.owner, this.edit.id, this.edit.filePath);
            });
            const reject = window.activeDocument.createElement('button');
            reject.className = 'quill-change-diff__btn';
            reject.textContent = 'Reject';
            reject.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                this.handlers.onReject?.(this.edit.owner, this.edit.id, this.edit.filePath);
            });
            controls.appendChild(approve);
            controls.appendChild(reject);
            added.appendChild(controls);
        } else if (this.edit.state === 'generating') {
            const hint = window.activeDocument.createElement('div');
            hint.className = 'quill-change-diff__generating';
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

/**
 * Build the decoration set from the current diff-edits snapshots.
 *
 * Uses `Decoration.replace` for ALL edits with removal — including
 * multi-line ranges. This works because the decorations are provided
 * from a {@link StateField} (see {@link getChangeDiffExtension}), not a
 * ViewPlugin. StateField-sourced replace decorations CAN cross line
 * breaks (they're computed during the state update, before viewport
 * rendering), whereas ViewPlugin-sourced ones cannot. The previous
 * ViewPlugin approach fell back to a fragile `mark + point-widget`
 * split for multi-line edits, which dropped the green replacement
 * widget when the range crossed Obsidian's block-level image-embed
 * widgets.
 */
function buildDiffDecorations(state: EditorState, handlers: ChangeDiffHandlers): DecorationSet {
    const edits = state.field(diffEditsField);
    if (edits.length === 0) return Decoration.none;
    const doc = state.doc;
    const ranges: Range<Decoration>[] = [];
    for (const edit of edits) {
        // Render the box while streaming ('generating') and for review ('pending');
        // 'approved'/'rejected' are committed/discarded and get no decoration.
        if (edit.state !== 'pending' && edit.state !== 'generating') continue;
        const hasRemoval = edit.from < edit.to;
        if (hasRemoval) {
            // All removals — single-line AND multi-line — get the same stacked
            // red+green replace widget. StateField decorations can replace across
            // line breaks, so there's no need for a mark+widget fallback.
            const removedText = doc.sliceString(edit.from, edit.to);
            const widget = new ChangePreviewWidget(removedText, edit, handlers);
            ranges.push(Decoration.replace({ widget }).range(edit.from, edit.to));
        } else {
            // Pure insertion: no range to replace, drop the widget at the point.
            const widget = new ChangePreviewWidget('', edit, handlers);
            ranges.push(Decoration.widget({ widget, side: 1 }).range(edit.from));
        }
    }
    return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

/**
 * Return the CodeMirror extension bundle for inline change-diff rendering.
 *
 * Decorations are provided via a {@link StateField} (not a ViewPlugin) so
 * that `Decoration.replace` can cross line breaks — critical for multi-line
 * lore edits that span image-embed block widgets in Obsidian Live Preview.
 * The StateField is defined inside this closure so it can capture `handlers`
 * for the inline Approve/Reject buttons.
 */
export function getChangeDiffExtension(handlers: ChangeDiffHandlers): Extension[] {
    const decorationsField = StateField.define<DecorationSet>({
        create: (state) => buildDiffDecorations(state, handlers),
        update: (value, tr) => {
            const prev = tr.startState.field(diffEditsField);
            const next = tr.state.field(diffEditsField);
            // Rebuild only when the diff-edits snapshots actually changed
            // (setDiffEdits effect or docChanged remapping). When identity is
            // the same, the decorations are unchanged.
            if (next !== prev) {
                return buildDiffDecorations(tr.state, handlers);
            }
            return value;
        },
        provide: (field) => EditorView.decorations.from(field)
    });
    return [diffEditsField, decorationsField];
}

/** Push a snapshot set to a view (convenience).
 *
 *  Owner-scoped: snapshots already carry an `owner` tag (see {@link DiffEditSnapshot}),
 *  so this merges rather than replaces — snapshots from other active surfaces
 *  (e.g., Fulfill while Transform is previewing) are preserved. The owner is
 *  inferred from the first snapshot; pass an explicit `owner` to override or
 *  when pushing an empty array (which clears that owner's snapshots). */
export function pushDiffEdits(view: EditorView, snapshots: DiffEditSnapshot[], owner?: string): void {
    const targetOwner = owner ?? snapshots[0]?.owner;
    if (!targetOwner) {
        view.dispatch({ effects: setDiffEdits.of(snapshots) });
        return;
    }
    const existing = view.state.field(diffEditsField);
    const preserved = existing.filter((s) => s.owner !== targetOwner);
    view.dispatch({ effects: setDiffEdits.of([...preserved, ...snapshots]) });
}

/** Clear the diff in a view.
 *
 *  By default clears every owner's snapshots (legacy behavior). Pass an
 *  `owner` (e.g., 'fulfill', 'direct', 'transform') to clear only that
 *  surface's snapshots and preserve snapshots from other active surfaces. */
export function clearDiffEdits(view: EditorView, owner?: string): void {
    if (!owner) {
        view.dispatch({ effects: setDiffEdits.of([]) });
        return;
    }
    const existing = view.state.field(diffEditsField);
    const preserved = existing.filter((s) => s.owner !== owner);
    view.dispatch({ effects: setDiffEdits.of(preserved) });
}
