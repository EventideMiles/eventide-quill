import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviseEditTool } from '../../../src/ai/tools/revise-edit';
import type { ToolContext } from '../../../src/ai/tools/tool';

const helperMocks = vi.hoisted(() => ({
    resolveNoteFile: vi.fn(),
    openNoteForEdit: vi.fn(),
    pushLoreEditDiff: vi.fn()
}));

vi.mock('../../../src/ai/tools/lore-edit-helpers', () => helperMocks);

/** Minimal ToolContext: the AI-ism gate fires before any plugin access, and
 *  the pass-through cases stop at the (mocked) note resolution returning null. */
function makeCtx(): ToolContext {
    return { plugin: { settings: {} } } as unknown as ToolContext;
}

describe('revise_edit — AI-ism gate on new_text', () => {
    beforeEach(() => {
        helperMocks.resolveNoteFile.mockReset();
        helperMocks.resolveNoteFile.mockReturnValue(null);
    });

    it('rejects an ism-laden new_text before the note is even resolved', async () => {
        const result = await reviseEditTool.execute(
            { path: 'Lore/Sarah.md', edit_id: 1, new_text: 'The air grew thick \u2014 no, electric.' },
            makeCtx()
        );
        expect(result).toContain('AI-ism check');
        // The gate must precede note resolution (mirrors edit_note ordering).
        expect(helperMocks.resolveNoteFile).not.toHaveBeenCalled();
    });

    it('rejects a cliché-laden new_text', async () => {
        const result = await reviseEditTool.execute(
            { path: 'Lore/Sarah.md', edit_id: 1, new_text: 'She was a tapestry of contradictions.' },
            makeCtx()
        );
        expect(result).toContain('AI-ism check');
        expect(result).toContain('tapestry');
    });

    it('lets clean text through to note resolution', async () => {
        const result = await reviseEditTool.execute(
            { path: 'Lore/Sarah.md', edit_id: 1, new_text: 'She checked the lock twice and left by the side door.' },
            makeCtx()
        );
        // resolveNoteFile (mocked) returns null → the tool reports the missing note,
        // proving the gate did not block clean prose.
        expect(result).toContain('not found in the vault');
        expect(helperMocks.resolveNoteFile).toHaveBeenCalledTimes(1);
    });

    it('lets an empty new_text (pure deletion) through the gate', async () => {
        const result = await reviseEditTool.execute({ path: 'Lore/Sarah.md', edit_id: 1, new_text: '' }, makeCtx());
        expect(result).toContain('not found in the vault');
    });
});
