import { describe, it, expect } from 'vitest';
import { ChangeSet } from '../../src/core/change-set';
import type { ChangeSetJSON } from '../../src/core/change-set';

describe('ChangeSet', () => {
    it('adds edits with auto-incremented ids', () => {
        const cs = new ChangeSet();
        const e1 = cs.add({ from: 0, to: 5, newText: 'hello', label: 'first' });
        const e2 = cs.add({ from: 10, to: 15, newText: 'world', label: 'second' });
        expect(e1.id).toBe(0);
        expect(e2.id).toBe(1);
        expect(e1.state).toBe('pending');
        expect(e2.state).toBe('pending');
    });

    it('retrieves edits by id', () => {
        const cs = new ChangeSet();
        const added = cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
        expect(cs.get(added.id)).toBe(added);
        expect(cs.get(999)).toBeUndefined();
    });

    it('tracks pendingCount and hasPending', () => {
        const cs = new ChangeSet();
        expect(cs.pendingCount).toBe(0);
        expect(cs.hasPending).toBe(false);

        cs.add({ from: 0, to: 0, newText: 'a', label: 'one' });
        cs.add({ from: 5, to: 5, newText: 'b', label: 'two' });
        expect(cs.pendingCount).toBe(2);
        expect(cs.hasPending).toBe(true);
    });

    describe('approve', () => {
        it('returns the change spec for a pending edit', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 10, to: 15, newText: 'replaced', label: 'test' });
            const change = cs.approve(edit.id);
            expect(change).toEqual({ from: 10, to: 15, insert: 'replaced' });
            expect(cs.get(edit.id)!.state).toBe('approved');
        });

        it('remaps later edits by the length delta', () => {
            const cs = new ChangeSet();
            // Edit at [10, 15) — length 5. Replace with "XXXXXX" (length 6). Delta = +1.
            const e1 = cs.add({ from: 10, to: 15, newText: 'XXXXXX', label: 'e1' });
            // Edit at [20, 25) — should shift to [21, 26) after e1 approves.
            const e2 = cs.add({ from: 20, to: 25, newText: 'YYYY', label: 'e2' });

            cs.approve(e1.id);
            const remapped = cs.get(e2.id)!;
            expect(remapped.from).toBe(21);
            expect(remapped.to).toBe(26);
        });

        it('does not remap edits before the approved edit', () => {
            const cs = new ChangeSet();
            const e1 = cs.add({ from: 0, to: 0, newText: 'aaa', label: 'early' });
            const e2 = cs.add({ from: 10, to: 10, newText: 'bbb', label: 'late' });
            cs.approve(e2.id);
            expect(cs.get(e1.id)!.from).toBe(0);
            expect(cs.get(e1.id)!.to).toBe(0);
        });

        it('returns null for non-existent id', () => {
            const cs = new ChangeSet();
            expect(cs.approve(999)).toBeNull();
        });

        it('returns null for already-approved edit', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
            cs.approve(edit.id);
            expect(cs.approve(edit.id)).toBeNull();
        });

        it('handles pure insertion (from === to)', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 5, to: 5, newText: 'inserted', label: 'insert' });
            const change = cs.approve(edit.id);
            expect(change).toEqual({ from: 5, to: 5, insert: 'inserted' });
        });

        it('handles pure deletion (newText === "")', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 5, to: 10, newText: '', label: 'delete' });
            const change = cs.approve(edit.id);
            expect(change).toEqual({ from: 5, to: 10, insert: '' });
        });
    });

    describe('reject', () => {
        it('marks a pending edit as rejected', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
            cs.reject(edit.id);
            expect(cs.get(edit.id)!.state).toBe('rejected');
            expect(cs.pendingCount).toBe(0);
        });

        it('is a no-op for non-pending edits', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
            cs.approve(edit.id);
            cs.reject(edit.id);
            expect(cs.get(edit.id)!.state).toBe('approved');
        });

        it('does not remap other edits on reject', () => {
            const cs = new ChangeSet();
            const e1 = cs.add({ from: 10, to: 15, newText: 'longer', label: 'e1' });
            const e2 = cs.add({ from: 20, to: 25, newText: 'e2', label: 'e2' });
            cs.reject(e1.id);
            expect(cs.get(e2.id)!.from).toBe(20);
        });
    });

    describe('updateText', () => {
        it('updates the newText of a pending edit', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 0, to: 0, newText: 'original', label: 'test' });
            expect(cs.updateText(edit.id, 'revised')).toBe(true);
            expect(cs.get(edit.id)!.newText).toBe('revised');
        });

        it('returns false for non-existent id', () => {
            const cs = new ChangeSet();
            expect(cs.updateText(999, 'x')).toBe(false);
        });

        it('returns false for non-pending edit', () => {
            const cs = new ChangeSet();
            const edit = cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
            cs.approve(edit.id);
            expect(cs.updateText(edit.id, 'revised')).toBe(false);
        });
    });

    describe('approveAll', () => {
        it('approves all pending edits in order with remapping', () => {
            const cs = new ChangeSet();
            cs.add({ from: 0, to: 0, newText: 'aaa', label: 'e1' }); // delta +3
            cs.add({ from: 10, to: 10, newText: 'bb', label: 'e2' }); // shifts to 13 after e1
            cs.add({ from: 20, to: 20, newText: 'c', label: 'e3' }); // shifts to 25 after e1+e2
            const changes = cs.approveAll();
            expect(changes).toHaveLength(3);
            expect(changes[0]).toEqual({ from: 0, to: 0, insert: 'aaa' });
            expect(changes[1]).toEqual({ from: 13, to: 13, insert: 'bb' });
            expect(changes[2]).toEqual({ from: 25, to: 25, insert: 'c' });
        });

        it('returns empty array when no pending edits', () => {
            const cs = new ChangeSet();
            expect(cs.approveAll()).toEqual([]);
        });
    });

    describe('rejectAll', () => {
        it('rejects all pending edits', () => {
            const cs = new ChangeSet();
            cs.add({ from: 0, to: 0, newText: 'a', label: 'e1' });
            cs.add({ from: 10, to: 10, newText: 'b', label: 'e2' });
            cs.rejectAll();
            expect(cs.pendingCount).toBe(0);
            expect(cs.edits.every((e) => e.state === 'rejected')).toBe(true);
        });
    });

    describe('clear', () => {
        it('drops all edits and resets the id counter', () => {
            const cs = new ChangeSet();
            cs.add({ from: 0, to: 0, newText: 'a', label: 'e1' });
            cs.add({ from: 10, to: 10, newText: 'b', label: 'e2' });
            cs.clear();
            expect(cs.edits).toEqual([]);
            expect(cs.pendingCount).toBe(0);
            const next = cs.add({ from: 0, to: 0, newText: 'c', label: 'e3' });
            expect(next.id).toBe(0);
        });
    });

    describe('toJSON / fromJSON round-trip', () => {
        it('round-trips edits and nextId', () => {
            const cs = new ChangeSet();
            cs.add({ from: 0, to: 5, newText: 'hello', label: 'first', originalText: 'world' });
            cs.add({ from: 10, to: 15, newText: 'foo', label: 'second' });
            cs.approve(0);

            const json: ChangeSetJSON = cs.toJSON();
            const restored = ChangeSet.fromJSON(json);

            expect(restored.edits).toEqual(cs.edits);
            expect(restored.pendingCount).toBe(cs.pendingCount);
            const next = restored.add({ from: 20, to: 20, newText: 'next', label: 'new' });
            expect(next.id).toBe(2);
        });

        it('produces a plain-JSON-safe shape', () => {
            const cs = new ChangeSet();
            cs.add({ from: 0, to: 0, newText: 'x', label: 'test' });
            const json = cs.toJSON();
            expect(() => {
                JSON.parse(JSON.stringify(json));
            }).not.toThrow();
        });
    });
});
