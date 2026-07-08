import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { diffEditsField, setDiffEdits, type DiffEditSnapshot } from '../../src/ui/change-diff-extension';

/** Build a snapshot for owner `own` at [from, to). */
function snap(id: number, from: number, to: number, own: string): DiffEditSnapshot {
    return { id, from, to, newText: 'x', label: '', state: 'pending', owner: own };
}

/**
 * Regression coverage for the cross-owner stale-position bug. The fix
 * (`applyApprovedEdit`) splits the change dispatch from the snapshot refresh
 * across two transactions. These tests pin the CodeMirror field invariant that
 * motivates the split — they do NOT exercise `applyApprovedEdit` itself (that
 * needs a live EditorView / DOM, which is deferred per AGENTS.md).
 */
describe('diffEditsField remap semantics', () => {
    it('remaps every owner on a changes-only transaction (the split-dispatch path)', () => {
        // Two owners with pending edits in the same document.
        let state = EditorState.create({ doc: '_'.repeat(200), extensions: [diffEditsField] });
        state = state.update({
            effects: setDiffEdits.of([snap(1, 0, 5, 'fulfill'), snap(2, 100, 105, 'direct')])
        }).state;

        // Approving owner 'fulfill' applies a change [0,5) -> 'XYZ' (net delta -2)
        // as a changes-only transaction (no setDiffEdits effect), exactly as the
        // first half of applyApprovedEdit does.
        state = state.update({ changes: { from: 0, to: 5, insert: 'XYZ' } }).state;

        const after = state.field(diffEditsField);
        // Owner 'direct' at 100 must shift by the delta (-2) -> 98, NOT stay at 100.
        const direct = after.find((s) => s.owner === 'direct')!;
        expect(direct.from).toBe(98);
        expect(direct.to).toBe(103);
    });

    it('does NOT remap the effect value when changes + setDiffEdits combine (why the split is required)', () => {
        // Document the hazard: combining changes + setDiffEdits in ONE transaction
        // short-circuits the mapPos branch, so preserved snapshots keep stale
        // offsets. This is the bug applyApprovedEdit exists to prevent.
        let state = EditorState.create({ doc: '_'.repeat(200), extensions: [diffEditsField] });
        state = state.update({
            effects: setDiffEdits.of([snap(1, 0, 5, 'fulfill'), snap(2, 100, 105, 'direct')])
        }).state;

        // The OLD buggy pattern: changes + effect in one transaction, pushing the
        // other owner's snapshot verbatim (pre-change offset 100).
        state = state.update({
            changes: { from: 0, to: 5, insert: 'XYZ' },
            effects: setDiffEdits.of([snap(2, 100, 105, 'direct')])
        }).state;

        const after = state.field(diffEditsField);
        const direct = after.find((s) => s.owner === 'direct')!;
        // Stale: still 100, when it should be 98 after the -2 delta above.
        expect(direct.from).toBe(100);
        expect(direct.to).toBe(105);
    });

    it('preserves the remapped other-owner positions across the snapshot refresh', () => {
        // Full split pattern: (1) changes-only transaction remaps everyone,
        // (2) then an effect-only transaction refreshes the approving owner.
        // pushDiffEdits (used by applyApprovedEdit) captures `preserved` from the
        // post-step-1 field, so 'direct' survives at its remapped offset.
        let state = EditorState.create({ doc: '_'.repeat(200), extensions: [diffEditsField] });
        state = state.update({
            effects: setDiffEdits.of([snap(1, 0, 5, 'fulfill'), snap(2, 100, 105, 'direct')])
        }).state;

        // Step 1: apply the change with no effect -> field remaps both owners.
        state = state.update({ changes: { from: 0, to: 5, insert: 'XYZ' } }).state;
        // Step 2: pushDiffEdits captures the remapped 'direct' from the field and
        // drops 'fulfill' (approved). This mirrors what applyApprovedEdit does.
        const remappedDirect = state.field(diffEditsField).find((s) => s.owner === 'direct')!;
        state = state.update({ effects: setDiffEdits.of([remappedDirect]) }).state;

        const direct = state.field(diffEditsField).find((s) => s.owner === 'direct')!;
        expect(direct.from).toBe(98);
        expect(direct.to).toBe(103);
    });
});
