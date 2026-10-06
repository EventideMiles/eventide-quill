import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../src/ai/provider';
import {
    refineProposeEntryOutcome,
    refineLoreEditOutcome,
    refineStaleVaultLookups,
    refineForBudget
} from '../../src/ai/context-refinement';

/* ---------- message factories ---------- */

/** Build an assistant propose_entry turn plus its tool result. */
function proposeTurn(opts: {
    name: string;
    content: string;
    id?: string;
    entryType?: string;
    anchor?: string;
    thinkingBlocks?: unknown[];
}): ChatMessage[] {
    const id = opts.id ?? 'call_1';
    const argsObj: Record<string, unknown> = { name: opts.name, content: opts.content };
    if (opts.entryType) argsObj.entry_type = opts.entryType;
    const assistant: ChatMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'propose_entry', arguments: JSON.stringify(argsObj) }]
    };
    const tool: ChatMessage = {
        role: 'tool',
        content: `Draft received: "${opts.name}" (character). The writer will review it.`,
        toolCallId: id,
        name: 'propose_entry'
    };
    if (opts.anchor) {
        assistant.quillAnchorId = opts.anchor;
        tool.quillAnchorId = opts.anchor;
    }
    if (opts.thinkingBlocks) {
        assistant.thinkingBlocks = opts.thinkingBlocks as never;
    }
    return [assistant, tool];
}

/** Build an edit_note tool-result message for the given edit id. */
function editResultMsg(basename: string, editId: number, anchor?: string): ChatMessage {
    const msg: ChatMessage = {
        role: 'tool',
        content: `Edit proposed for "${basename}" (edit id ${editId}). The writer will see the diff and can approve or reject it. Continue with your response.`,
        toolCallId: `call_e${editId}`,
        name: 'edit_note'
    };
    if (anchor) msg.quillAnchorId = anchor;
    return msg;
}

/** Build an assistant vault_lookup turn plus its tool result. */
function vaultLookupTurn(opts: { path: string; body: string; id?: string; anchor?: string }): ChatMessage[] {
    const id = opts.id ?? 'call_v1';
    const assistant: ChatMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'vault_lookup', arguments: JSON.stringify({ path: opts.path }) }]
    };
    const tool: ChatMessage = {
        role: 'tool',
        content: opts.body,
        toolCallId: id,
        name: 'vault_lookup'
    };
    if (opts.anchor) {
        assistant.quillAnchorId = opts.anchor;
        tool.quillAnchorId = opts.anchor;
    }
    return [assistant, tool];
}

/** A realistic chars/4 estimate over content + tool-call arguments. */
function realEstimate(msgs: ChatMessage[]): number {
    let chars = 0;
    for (const m of msgs) {
        chars += m.content.length;
        if (m.toolCalls) for (const tc of m.toolCalls) chars += tc.arguments.length;
    }
    return Math.ceil(chars / 4);
}

const BIG = 'x'.repeat(4000);

/* ---------- refineProposeEntryOutcome ---------- */

describe('refineProposeEntryOutcome', () => {
    it('compresses the content arg and rewrites the tool result with an ACCEPTED marker', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'Sarah Connor', content: BIG, entryType: 'character', anchor: 'msg_5' });
        const changed = refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Characters/Sarah Connor.md');
        expect(changed).toBe(true);

        const assistant = msgs[0]!;
        const tool = msgs[1]!;
        // The bulky content arg is replaced with a brief pointer.
        const args = JSON.parse(assistant.toolCalls![0]!.arguments) as {
            name?: string;
            content?: string;
            entry_type?: string;
        };
        expect(args.content!.length).toBeLessThan(200);
        expect(args.content).toContain('refined out');
        // Name + entry_type preserved.
        expect(args.name).toBe('Sarah Connor');
        expect(args.entry_type).toBe('character');
        // Tool result carries the durable move-on marker.
        expect(tool.content).toContain('ACCEPTED');
        expect(tool.content).toContain('Lore/Characters/Sarah Connor.md');
        expect(tool.content).toContain('do not re-propose');
        // Both flagged refined; anchor preserved.
        expect(assistant.quillRefined).toBe(true);
        expect(tool.quillRefined).toBe(true);
        expect(assistant.quillAnchorId).toBe('msg_5');
        expect(tool.quillAnchorId).toBe('msg_5');
    });

    it('writes a DISCARDED marker when the draft was discarded', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'Frodo', content: BIG });
        refineProposeEntryOutcome(msgs, 'Frodo', 'discarded');
        expect(msgs[1]!.content).toContain('DISCARDED');
        expect(msgs[1]!.content).not.toContain('ACCEPTED');
    });

    it('omits the saved-path pointer when savedPath is absent (panel pre-fix shape)', () => {
        // Regression guard for the savedPath thread-through: the marker must
        // still be an ACCEPTED move-on signal even when the caller forgets the
        // path, but it must NOT claim a location it doesn't have.
        const msgs: ChatMessage[] = proposeTurn({ name: 'Sam', content: BIG });
        refineProposeEntryOutcome(msgs, 'Sam', 'accepted');
        expect(msgs[1]!.content).toContain('ACCEPTED');
        expect(msgs[1]!.content).toContain('do not re-propose');
        expect(msgs[1]!.content).not.toContain('saved it to');
    });

    it('is idempotent — a second call does not re-refine', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'Sam', content: BIG });
        expect(refineProposeEntryOutcome(msgs, 'Sam', 'accepted', 'p.md')).toBe(true);
        const afterFirst = msgs[0]!.toolCalls![0]!.arguments;
        expect(refineProposeEntryOutcome(msgs, 'Sam', 'accepted', 'p.md')).toBe(false);
        expect(msgs[0]!.toolCalls![0]!.arguments).toBe(afterFirst);
    });

    it('matches the name case-insensitively and tolerates surrounding whitespace', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'Ada Lovelace', content: BIG });
        expect(refineProposeEntryOutcome(msgs, '  ada lovelace  ', 'accepted')).toBe(true);
        expect(msgs[1]!.quillRefined).toBe(true);
    });

    it('skips assistant turns carrying Anthropic thinking blocks', () => {
        const msgs: ChatMessage[] = proposeTurn({
            name: 'Thinking Draft',
            content: BIG,
            thinkingBlocks: [{ thinking: 'reasoning', signature: 'sig' }]
        });
        expect(refineProposeEntryOutcome(msgs, 'Thinking Draft', 'accepted')).toBe(false);
        expect(msgs[0]!.quillRefined).toBeUndefined();
    });

    it('returns false and leaves messages untouched when no name matches', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'Gandalf', content: BIG });
        const before = msgs[0]!.toolCalls![0]!.arguments;
        expect(refineProposeEntryOutcome(msgs, 'Saruman', 'accepted')).toBe(false);
        expect(msgs[0]!.toolCalls![0]!.arguments).toBe(before);
    });

    it('returns false for an empty name', () => {
        const msgs: ChatMessage[] = proposeTurn({ name: 'X', content: BIG });
        expect(refineProposeEntryOutcome(msgs, '   ', 'accepted')).toBe(false);
    });
});

/* ---------- refineLoreEditOutcome ---------- */

describe('refineLoreEditOutcome', () => {
    it('appends an APPROVED marker to the matching edit result', () => {
        const msgs: ChatMessage[] = [editResultMsg('Sarah Connor', 5, 'msg_3')];
        expect(refineLoreEditOutcome(msgs, 5, 'approved')).toBe(true);
        expect(msgs[0]!.content).toContain('[APPROVED');
        expect(msgs[0]!.content).toContain('landed');
        expect(msgs[0]!.quillRefined).toBe(true);
        expect(msgs[0]!.quillAnchorId).toBe('msg_3');
    });

    it('appends a REJECTED marker', () => {
        const msgs: ChatMessage[] = [editResultMsg('Bob', 2)];
        refineLoreEditOutcome(msgs, 2, 'rejected');
        expect(msgs[0]!.content).toContain('[REJECTED');
        expect(msgs[0]!.content).toContain('did NOT apply');
    });

    it('does not touch other edit ids', () => {
        const msgs: ChatMessage[] = [editResultMsg('A', 1), editResultMsg('B', 2)];
        refineLoreEditOutcome(msgs, 2, 'approved');
        expect(msgs[0]!.content).not.toContain('[APPROVED');
        expect(msgs[1]!.content).toContain('[APPROVED');
    });

    it('is idempotent', () => {
        const msgs: ChatMessage[] = [editResultMsg('A', 1)];
        expect(refineLoreEditOutcome(msgs, 1, 'approved')).toBe(true);
        const afterFirst = msgs[0]!.content;
        expect(refineLoreEditOutcome(msgs, 1, 'approved')).toBe(false);
        expect(msgs[0]!.content).toBe(afterFirst);
    });
});

/* ---------- refineStaleVaultLookups ---------- */

describe('refineStaleVaultLookups', () => {
    it('matches by full path and replaces the body with a stale marker', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'Lore/Characters/Sarah Connor.md', body: BIG });
        expect(refineStaleVaultLookups(msgs, 'Lore/Characters/Sarah Connor.md')).toBe(true);
        expect(msgs[1]!.content).toContain('refined out');
        expect(msgs[1]!.content).toContain('EDITED');
        expect(msgs[1]!.content).toContain('re-run vault_lookup');
        expect(msgs[1]!.quillRefined).toBe(true);
    });

    it('matches a bare-name lookup arg against the resolved file path', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'Sarah Connor', body: BIG });
        expect(refineStaleVaultLookups(msgs, 'Lore/Characters/Sarah Connor.md')).toBe(true);
    });

    it('does not touch vault_lookups of other files', () => {
        const msgs: ChatMessage[] = [
            ...vaultLookupTurn({ path: 'Sarah Connor', body: BIG, id: 'c1' }),
            ...vaultLookupTurn({ path: 'Gandalf', body: BIG, id: 'c2' })
        ];
        refineStaleVaultLookups(msgs, 'Lore/Characters/Sarah Connor.md');
        expect(msgs[1]!.quillRefined).toBe(true);
        expect(msgs[3]!.quillRefined).toBeUndefined();
    });

    it('is idempotent', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'Sarah Connor', body: BIG });
        expect(refineStaleVaultLookups(msgs, 'Sarah Connor')).toBe(true);
        expect(refineStaleVaultLookups(msgs, 'Sarah Connor')).toBe(false);
    });

    it('returns false for an empty file path', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'Sarah Connor', body: BIG });
        expect(refineStaleVaultLookups(msgs, '')).toBe(false);
    });
});

/* ---------- refineForBudget ---------- */

describe('refineForBudget', () => {
    it('is a no-op when already under the target', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'small.md', body: 'tiny' });
        expect(refineForBudget(msgs, realEstimate, realEstimate(msgs) + 1000)).toBe(false);
        expect(msgs[1]!.quillRefined).toBeUndefined();
    });

    it('refines a big vault_lookup read to bring the estimate under target', () => {
        const msgs: ChatMessage[] = vaultLookupTurn({ path: 'big.md', body: BIG });
        const baseline = realEstimate(msgs);
        const target = Math.floor(baseline / 2);
        expect(refineForBudget(msgs, realEstimate, target)).toBe(true);
        expect(realEstimate(msgs)).toBeLessThanOrEqual(target);
        expect(msgs[1]!.quillRefined).toBe(true);
        expect(msgs[1]!.content).toContain('refined out to free context');
    });

    it('prioritizes reads over drafts (a read is refined before a draft)', () => {
        const msgs: ChatMessage[] = [
            ...proposeTurn({ name: 'Draft', content: BIG, id: 'c_draft' }),
            ...vaultLookupTurn({ path: 'read.md', body: BIG, id: 'c_read' })
        ];
        const baseline = realEstimate(msgs);
        // Target that the read alone will satisfy, so the draft should NOT be touched.
        const afterOnlyRead = baseline - Math.ceil((BIG.length - 120) / 4);
        const target = afterOnlyRead + 10;
        refineForBudget(msgs, realEstimate, target);
        // Read refined, draft not.
        const readTool = msgs[3]!;
        const draftAssistant = msgs[0]!;
        expect(readTool.quillRefined).toBe(true);
        expect(draftAssistant.quillRefined).toBeUndefined();
    });

    it('refines the draft too when the read is exhausted and still over target', () => {
        const msgs: ChatMessage[] = [
            ...proposeTurn({ name: 'Draft', content: BIG, id: 'c_draft' }),
            ...vaultLookupTurn({ path: 'read.md', body: BIG, id: 'c_read' })
        ];
        const baseline = realEstimate(msgs);
        const target = 50; // below the marker floor — forces every candidate to refine
        refineForBudget(msgs, realEstimate, target);
        expect(msgs[0]!.quillRefined).toBe(true); // draft assistant
        expect(msgs[1]!.quillRefined).toBe(true); // draft tool result
        expect(msgs[3]!.quillRefined).toBe(true); // read tool result
        // Can't go below the marker floor, but the drop is large (draft+read
        // bodies replaced by short markers).
        expect(realEstimate(msgs)).toBeLessThan(baseline * 0.2);
    });

    it('skips small payloads below the refinement floor', () => {
        const smallRead: ChatMessage[] = vaultLookupTurn({ path: 'small.md', body: 'tiny body' });
        // No eligible candidates at all (read below MIN_REFINABLE_CHARS, no drafts).
        expect(refineForBudget(smallRead, realEstimate, 50)).toBe(false);
        expect(smallRead.every((m) => !m.quillRefined)).toBe(true);
    });

    it('skips assistant turns carrying Anthropic thinking blocks (even when bulky)', () => {
        const thinkingDraft: ChatMessage[] = proposeTurn({
            name: 'T',
            content: BIG,
            thinkingBlocks: [{ thinking: 'r', signature: 's' }]
        });
        // The draft is bulky enough to qualify, but its assistant turn carries
        // thinking blocks that must replay verbatim — skipped, so nothing refin.
        expect(refineForBudget(thinkingDraft, realEstimate, 50)).toBe(false);
        expect(thinkingDraft.every((m) => !m.quillRefined)).toBe(true);
    });

    it('reaches a SECOND draft in the same turn after the first was already refined', () => {
        // Regression guard for the per-turn quillRefined flag: one assistant
        // turn carries TWO propose_entry calls. Refining draft A (via the
        // outcome path) must not strand draft B behind the turn-level skip —
        // the budget-driven drafts pass must still reach it.
        const msgs: ChatMessage[] = twoDraftTurn();
        expect(refineProposeEntryOutcome(msgs, 'Draft A', 'accepted', 'Lore/A.md')).toBe(true);

        // A compressed; B untouched; the turn is NOT yet flagged refined.
        const argsA = JSON.parse(msgs[0]!.toolCalls![0]!.arguments) as { content?: string };
        const argsB = JSON.parse(msgs[0]!.toolCalls![1]!.arguments) as { content?: string };
        expect(argsA.content).toContain('refined out');
        expect(argsB.content).toBe(BIG);
        expect(msgs[0]!.quillRefined).toBeUndefined();

        // The budget pass still reaches B (A's marker is short, so B's bulk
        // dominates the estimate; a low target forces B's candidate to apply).
        expect(refineForBudget(msgs, realEstimate, 50)).toBe(true);
        const argsBAfter = JSON.parse(msgs[0]!.toolCalls![1]!.arguments) as { content?: string };
        expect(argsBAfter.content).toContain('refined out');
        // Every refinable call in the turn is done → the turn flag may land.
        expect(msgs[0]!.quillRefined).toBe(true);
    });
});

/* ---------- two drafts in one assistant turn (per-call refinement) ---------- */

/** Build an assistant turn carrying TWO propose_entry calls, each with its own tool result. */
function twoDraftTurn(): ChatMessage[] {
    /** Serialize one draft's propose_entry arguments under the given entry name. */
    const mkArgs = (name: string): string => JSON.stringify({ name, content: BIG });
    const assistant: ChatMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [
            { id: 'call_a', name: 'propose_entry', arguments: mkArgs('Draft A') },
            { id: 'call_b', name: 'propose_entry', arguments: mkArgs('Draft B') }
        ]
    };
    return [
        assistant,
        {
            role: 'tool',
            content: 'Draft received: "Draft A". The writer will review it.',
            toolCallId: 'call_a',
            name: 'propose_entry'
        },
        {
            role: 'tool',
            content: 'Draft received: "Draft B". The writer will review it.',
            toolCallId: 'call_b',
            name: 'propose_entry'
        }
    ];
}

describe('refineProposeEntryOutcome — two drafts in one turn', () => {
    it('flags the turn as refined only after BOTH sibling drafts are resolved', () => {
        const msgs: ChatMessage[] = twoDraftTurn();
        expect(refineProposeEntryOutcome(msgs, 'Draft A', 'accepted', 'Lore/A.md')).toBe(true);
        expect(msgs[0]!.quillRefined).toBeUndefined(); // B still pending
        expect(refineProposeEntryOutcome(msgs, 'Draft B', 'discarded')).toBe(true);
        expect(msgs[0]!.quillRefined).toBe(true);

        const resultA = msgs[1]!;
        const resultB = msgs[2]!;
        expect(resultA.content).toContain('ACCEPTED');
        expect(resultB.content).toContain('DISCARDED');
    });

    it('stays idempotent per call — re-refining draft A in a partially refined turn is a no-op', () => {
        const msgs: ChatMessage[] = twoDraftTurn();
        refineProposeEntryOutcome(msgs, 'Draft A', 'accepted', 'Lore/A.md');
        const argsAfterFirst = msgs[0]!.toolCalls![0]!.arguments;
        const resultAfterFirst = msgs[1]!.content;
        // A's call is already markered: skipped per CALL even though the turn
        // is unflagged, so the ACCEPTED result marker is not clobbered.
        expect(refineProposeEntryOutcome(msgs, 'Draft A', 'discarded')).toBe(false);
        expect(msgs[0]!.toolCalls![0]!.arguments).toBe(argsAfterFirst);
        expect(msgs[1]!.content).toBe(resultAfterFirst);
    });
});

/* ---------- budget-refined drafts (second pass) ---------- */

describe('refineProposeEntryOutcome — budget-refined draft', () => {
    /**
     * Build a propose_entry turn, then run refineForBudget over it so the
     * draft's content arg and tool result land in the compressed state a real
     * budget pass leaves behind (marker in args, "review status is unchanged"
     * in the result, turn flagged refined).
     */
    function budgetRefinedTurn(name: string): ChatMessage[] {
        const msgs: ChatMessage[] = proposeTurn({ name, content: BIG, id: 'call_b1', anchor: 'msg_9' });
        expect(refineForBudget(msgs, realEstimate, 50)).toBe(true);
        const args = JSON.parse(msgs[0]!.toolCalls![0]!.arguments) as { content?: string };
        expect(args.content).toContain('refined out');
        expect(msgs[1]!.content).toContain('review status is unchanged');
        return msgs;
    }

    it('writes the ACCEPTED outcome marker into the tool result while the args stay compressed', () => {
        const msgs = budgetRefinedTurn('Sarah Connor');
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(true);

        // The durable move-on signal landed in the tool result...
        const result = msgs[1]!;
        expect(result.content).toContain('ACCEPTED');
        expect(result.content).toContain('saved it to Lore/Sarah Connor.md');
        expect(result.content).toContain('COMPLETE');
        expect(result.content).not.toContain('review status is unchanged');
        // ...while the compressed args were left alone (no double compression).
        const args = JSON.parse(msgs[0]!.toolCalls![0]!.arguments) as { content?: string };
        expect(args.content).toContain('refined out');
        expect(args.content).not.toContain('ACCEPTED');
        // Invariants: no messages added/removed, anchors intact.
        expect(msgs).toHaveLength(2);
        expect(msgs[0]!.quillAnchorId).toBe('msg_9');
        expect(msgs[1]!.quillAnchorId).toBe('msg_9');
    });

    it('writes the DISCARDED marker for a budget-refined draft', () => {
        const msgs = budgetRefinedTurn('Draft B');
        expect(refineProposeEntryOutcome(msgs, 'Draft B', 'discarded')).toBe(true);
        expect(msgs[1]!.content).toContain('DISCARDED');
        expect(msgs[1]!.content).toContain('Do not re-propose');
        expect(msgs[1]!.content).not.toContain('review status is unchanged');
        expect(msgs[1]!.content).not.toContain('ACCEPTED');
    });

    it('is idempotent — a second call is a no-op and does not duplicate the marker', () => {
        const msgs = budgetRefinedTurn('Sarah Connor');
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(true);
        const resultAfterFirst = msgs[1]!.content;
        const argsAfterFirst = msgs[0]!.toolCalls![0]!.arguments;
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(false);
        expect(msgs[1]!.content).toBe(resultAfterFirst);
        expect(msgs[0]!.toolCalls![0]!.arguments).toBe(argsAfterFirst);
        expect(resultAfterFirst.split('The writer ACCEPTED')).toHaveLength(2);
    });

    it('still writes the outcome marker when the result merely CONTAINS the outcome phrase (no false skip)', () => {
        // A result whose text carries "The writer ACCEPTED" inside other
        // content (e.g. echoing a draft about a character accepting
        // something) is NOT the engine's marker — the pass must not treat it
        // as already-refined, or the real move-on signal never lands.
        const msgs = budgetRefinedTurn('Sarah Connor');
        msgs[1]!.content =
            'Draft received: "Sarah Connor" (character). ' +
            'The writer ACCEPTED a similar proposal last session — check before re-drafting.';
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(true);
        expect(msgs[1]!.content).toContain('COMPLETE');
        expect(msgs[1]!.content).toContain('saved it to Lore/Sarah Connor.md');
        expect(msgs[1]!.content).not.toContain('review status is unchanged');
    });

    it('treats a result carrying the exact outcome-marker shape as an idempotent no-op', () => {
        // Pins the marker shape the second pass matches: anchored prefix,
        // entry/type/token fields, the "keep it lean" tail, and the outcome
        // word — the idempotency contract the regex encodes.
        const msgs = budgetRefinedTurn('Sarah Connor');
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(true);
        const marked = msgs[1]!.content;
        expect(marked).toMatch(
            /^\[Entry "Sarah Connor" \(untyped\): ~\d+ tokens of draft content were refined out of context to keep it lean\. The writer ACCEPTED/
        );
        expect(refineProposeEntryOutcome(msgs, 'Sarah Connor', 'accepted', 'Lore/Sarah Connor.md')).toBe(false);
        expect(msgs[1]!.content).toBe(marked);
    });

    it('does not touch other drafts in the same turn (name filter still applies)', () => {
        // Two budget-refined drafts; resolving one must leave the sibling's
        // "review status is unchanged" result untouched.
        const assistant: ChatMessage = {
            role: 'assistant',
            content: '',
            toolCalls: [
                { id: 'call_x', name: 'propose_entry', arguments: JSON.stringify({ name: 'Draft X', content: BIG }) },
                { id: 'call_y', name: 'propose_entry', arguments: JSON.stringify({ name: 'Draft Y', content: BIG }) }
            ]
        };
        const msgs: ChatMessage[] = [
            assistant,
            { role: 'tool', content: 'Draft received: "Draft X".', toolCallId: 'call_x', name: 'propose_entry' },
            { role: 'tool', content: 'Draft received: "Draft Y".', toolCallId: 'call_y', name: 'propose_entry' }
        ];
        expect(refineForBudget(msgs, realEstimate, 50)).toBe(true);
        expect(refineProposeEntryOutcome(msgs, 'Draft X', 'accepted', 'Lore/X.md')).toBe(true);
        expect(msgs[1]!.content).toContain('ACCEPTED');
        expect(msgs[2]!.content).toContain('review status is unchanged');
        expect(msgs[2]!.content).not.toContain('ACCEPTED');
    });
});
