/**
 * A reusable model for proposed document edits that are reviewed and committed
 * one at a time (or in bulk).
 *
 * The unifying primitive is a {@link ProposedEdit}: "replace document range
 * `[from, to)` with `newText`". This covers every AI-insertion surface:
 * - **Fulfill**: replace a `<!-- quill: -->` comment with generated prose.
 * - **Transform**: replace the selection with a rewritten passage.
 * - **Co-writer direct**: replace the empty range at the cursor with a
 *   continuation (a pure insertion: `to === from`).
 *
 * Pure deletion is `newText === ''`. The diff is always "red = the old range,
 * green = the new text."
 *
 * Position handling: on {@link ChangeSet.approve}, later edits (those at or
 * beyond the approved edit's end) are shifted by the length delta so their
 * ranges stay valid for subsequent commits. This is the same proven remap used
 * by Fulfill mode. (Edits the user makes by hand mid-review are not tracked
 * here; the CM diff extension remaps rendered positions via `mapPos` so the
 * display stays correct regardless.)
 */

export type ProposedEditState = 'pending' | 'approved' | 'rejected';

/** A single proposed edit: replace document range `[from, to)` with `newText`. */
export interface ProposedEdit {
    id: number;
    /** Start of the range to replace. */
    from: number;
    /** End of the range to replace (=== `from` for a pure insertion). */
    to: number;
    /** Replacement text ('' for a pure deletion). */
    newText: string;
    /** Human label for the review card (e.g., the directive text, or "Make shorter"). */
    label: string;
    state: ProposedEditState;
}

/** A CodeMirror change spec sufficient for `EditorView.dispatch({ changes })`. */
export interface ChangeSpec {
    from: number;
    to: number;
    insert: string;
}

/**
 * A reviewable set of proposed edits to one document. Pure logic — no UI, no
 * Obsidian dependencies — so it is easy to reason about and test.
 */
export class ChangeSet {
    private nextId = 0;
    /** The edits, in insertion order (callers typically add them in document order). */
    edits: ProposedEdit[] = [];

    /** Add a pending edit. Returns the created edit (with its assigned id). */
    add(edit: Omit<ProposedEdit, 'id' | 'state'>): ProposedEdit {
        const created: ProposedEdit = { ...edit, id: this.nextId++, state: 'pending' };
        this.edits.push(created);
        return created;
    }

    /** Find an edit by id. */
    get(id: number): ProposedEdit | undefined {
        return this.edits.find((e) => e.id === id);
    }

    /** Number of edits still awaiting a decision. */
    get pendingCount(): number {
        return this.edits.reduce((n, e) => n + (e.state === 'pending' ? 1 : 0), 0);
    }

    /** Whether any edit is still pending. */
    get hasPending(): boolean {
        return this.edits.some((e) => e.state === 'pending');
    }

    /**
     * Approve one edit. Returns the CM change spec to dispatch, and remaps later
     * edits' offsets by the length delta so their ranges stay valid.
     * Returns null if the edit does not exist or is not pending.
     */
    approve(id: number): ChangeSpec | null {
        const edit = this.get(id);
        if (!edit || edit.state !== 'pending') return null;
        const change: ChangeSpec = { from: edit.from, to: edit.to, insert: edit.newText };
        const delta = edit.newText.length - (edit.to - edit.from);
        edit.state = 'approved';
        for (const other of this.edits) {
            if (other.id !== id && other.from >= edit.to) {
                other.from += delta;
                other.to += delta;
            }
        }
        return change;
    }

    /** Reject one edit: leave its range untouched. No-op if not pending. */
    reject(id: number): void {
        const edit = this.get(id);
        if (edit && edit.state === 'pending') edit.state = 'rejected';
    }

    /**
     * Approve every pending edit in document-insertion order. Returns the change
     * specs to dispatch sequentially (each dispatch's positions match the doc
     * state after the previous dispatch, because {@link approve} remaps in
     * memory as it goes).
     */
    approveAll(): ChangeSpec[] {
        const changes: ChangeSpec[] = [];
        for (const edit of [...this.edits]) {
            if (edit.state === 'pending') {
                const change = this.approve(edit.id);
                if (change) changes.push(change);
            }
        }
        return changes;
    }

    /** Reject every pending edit without touching the document. */
    rejectAll(): void {
        for (const edit of this.edits) {
            if (edit.state === 'pending') edit.state = 'rejected';
        }
    }

    /** Drop all edits (e.g., on reset / new chat). */
    clear(): void {
        this.edits = [];
        this.nextId = 0;
    }
}
