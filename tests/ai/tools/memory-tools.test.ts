import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';

// Mock the confirmation modal so tests don't need a DOM. Default resolves
// true (writer approves); individual tests override to test the cancel path.
vi.mock('../../../src/core/memories/memory-confirm', () => ({
    confirmMemoryAction: vi.fn().mockResolvedValue(true)
}));

// Imported AFTER the vi.mock above so the mock is in effect.
import { saveMemoryTool } from '../../../src/ai/tools/save-memory';
import { recallMemoryTool } from '../../../src/ai/tools/recall-memory';
import { deleteMemoryTool } from '../../../src/ai/tools/delete-memory';
import { confirmMemoryAction } from '../../../src/core/memories/memory-confirm';
import type { ToolContext } from '../../../src/ai/tools/tool';

beforeEach(() => {
    vi.mocked(confirmMemoryAction).mockReset();
    vi.mocked(confirmMemoryAction).mockResolvedValue(true);
});

/**
 * In-memory vault stub for memory-tool tests. Models the slice of the Vault
 * API the memory store touches: adapter.exists/mkdir, getAbstractFileByPath,
 * cachedRead, modify, create, plus the workspace.getActiveFile path used by
 * the scope resolver.
 */
interface VaultState {
    files: Map<string, string>;
    folders: Set<string>;
    activeFilePath: string | null;
}

/** Build a ToolContext with stubbed vault, workspace, and plugin state for memory-tool tests. */
function makeCtx(opts: {
    memoriesFolder?: string;
    memoriesEnabled?: boolean;
    memoriesAutoSave?: boolean;
    memoriesRecallMaxEntries?: number;
    files?: Record<string, string>;
    activeFilePath?: string | null;
    currentManuscriptFolder?: string | null;
}): { ctx: ToolContext; state: VaultState } {
    const memoriesFolder = opts.memoriesFolder ?? 'Memories';
    const state: VaultState = {
        files: new Map(Object.entries(opts.files ?? {})),
        folders: new Set(),
        activeFilePath: opts.activeFilePath ?? null
    };

    const fileObjects = new Map<string, TFile>();
    for (const path of state.files.keys()) {
        fileObjects.set(path, makeFile(path));
    }

    const vault = {
        adapter: {
            async exists(p: string): Promise<boolean> {
                return state.files.has(p) || state.folders.has(p);
            },
            async mkdir(p: string): Promise<void> {
                state.folders.add(p);
            }
        },
        getAbstractFileByPath(path: string): TFile | null {
            return fileObjects.get(path) ?? null;
        },
        async cachedRead(file: TFile): Promise<string> {
            return state.files.get(file.path) ?? '';
        },
        async modify(file: TFile, content: string): Promise<void> {
            state.files.set(file.path, content);
        },
        async create(path: string, content: string): Promise<TFile> {
            state.files.set(path, content);
            const f = makeFile(path);
            fileObjects.set(path, f);
            return f;
        },
        // The scope resolver uses configDir (returns a path that scopeKeyFromPath
        // reduces to the top-level folder). Default to '.obsidian'.
        get configDir(): string {
            return '.obsidian';
        }
    };

    const plugin = {
        settings: {
            memoriesEnabled: opts.memoriesEnabled ?? true,
            memoriesFolder,
            memoriesAutoSave: opts.memoriesAutoSave ?? true,
            memoriesRecallMaxEntries: opts.memoriesRecallMaxEntries ?? 10,
            memoriesMaxPerFile: 100
        },
        currentManuscriptFolder: opts.currentManuscriptFolder ?? null,
        app: {
            vault,
            workspace: {
                getActiveFile(): TFile | null {
                    if (!state.activeFilePath) return null;
                    return fileObjects.get(state.activeFilePath) ?? makeFile(state.activeFilePath);
                }
            }
        }
    };

    return { ctx: { plugin } as unknown as ToolContext, state };
}

/** Build a TFile stub with the given path (basename derived from the path). */
function makeFile(path: string): TFile {
    const f = new TFile();
    f.path = path;
    f.basename = path.split('/').pop()?.replace(/\.memories\.md$/, '').replace(/\.md$/, '') ?? path;
    return f;
}

describe('save_memory + recall_memory + delete_memory — round-trip integration', () => {
    it('save creates the memory file on first call and returns the minted ID', async () => {
        const { ctx, state } = makeCtx({});
        const result = await saveMemoryTool.execute(
            { content: 'Long passages are intentional pacing.', heading: 'Pacing exceptions' },
            ctx
        );
        expect(result).toContain('Saved memory');
        expect(result).toContain('Pacing exceptions');
        expect(result).toMatch(/quill-mem-001/);

        // File was created in the right place.
        expect(state.files.has('Memories/_global.memories.md')).toBe(true);
        const content = state.files.get('Memories/_global.memories.md')!;
        expect(content).toContain('## Pacing exceptions');
        expect(content).toContain('Long passages are intentional pacing.');
        expect(content).toContain('^quill-mem-001');
    });

    it('save creates the memories folder on first write (mkdir-on-first-write)', async () => {
        const { ctx, state } = makeCtx({});
        await saveMemoryTool.execute({ content: 'x' }, ctx);
        expect(state.folders.has('Memories')).toBe(true);
    });

    it('save with scope=global writes to the global pool regardless of active context', async () => {
        const { ctx, state } = makeCtx({ activeFilePath: 'Manuscript/chapter.md' });
        await saveMemoryTool.execute({ content: 'series-wide rule', scope: 'global' }, ctx);
        expect(state.files.has('Memories/_global.memories.md')).toBe(true);
        expect(state.files.has('Memories/Manuscript.memories.md')).toBe(false);
    });

    it('save with scope=auto resolves to the active manuscript pool', async () => {
        const { ctx, state } = makeCtx({ activeFilePath: 'Manuscript/chapter.md' });
        await saveMemoryTool.execute({ content: 'manuscript-specific' }, ctx);
        expect(state.files.has('Memories/Manuscript.memories.md')).toBe(true);
        expect(state.files.has('Memories/_global.memories.md')).toBe(false);
    });

    it('save with no active file falls through to global', async () => {
        const { ctx, state } = makeCtx({ activeFilePath: null });
        await saveMemoryTool.execute({ content: 'global fact' }, ctx);
        expect(state.files.has('Memories/_global.memories.md')).toBe(true);
    });

    it('save with a heading matching an existing entry updates in place (preserves ID)', async () => {
        const { ctx } = makeCtx({});
        await saveMemoryTool.execute({ content: 'original body', heading: 'My preference' }, ctx);
        // Same heading, different body — should update, not append.
        const result = await saveMemoryTool.execute(
            { content: 'updated body', heading: 'My preference' },
            ctx
        );
        expect(result).toContain('Updated memory');
        // Recall to verify only one entry exists with the updated body.
        const recalled = await recallMemoryTool.execute({}, ctx);
        expect(recalled).toContain('My preference');
        expect(recalled).toContain('updated body');
        expect(recalled).not.toContain('original body');
    });

    it('save auto-generates a heading when none is provided', async () => {
        const { ctx } = makeCtx({});
        const result = await saveMemoryTool.execute({ content: 'some fact' }, ctx);
        expect(result).toMatch(/Memory \d+/);
    });

    it('save with explicit tags appends them to the body as #hashtags', async () => {
        const { ctx, state } = makeCtx({});
        await saveMemoryTool.execute(
            { content: 'tagged fact', heading: 'Tagged', tags: ['pacing', 'voice'] },
            ctx
        );
        const content = state.files.get('Memories/_global.memories.md')!;
        expect(content).toContain('#pacing');
        expect(content).toContain('#voice');
    });

    it('save rejects when content is missing', async () => {
        const { ctx } = makeCtx({});
        const result = await saveMemoryTool.execute({}, ctx);
        expect(result).toContain('Error');
        expect(result).toContain('content');
    });

    it('save rejects when memoriesEnabled is off', async () => {
        const { ctx } = makeCtx({ memoriesEnabled: false });
        const result = await saveMemoryTool.execute({ content: 'x' }, ctx);
        expect(result).toContain('disabled');
    });

    it('recall returns all memories in the active scope when no filters', async () => {
        const { ctx } = makeCtx({});
        await saveMemoryTool.execute({ content: 'first', heading: 'A' }, ctx);
        await saveMemoryTool.execute({ content: 'second', heading: 'B' }, ctx);
        const result = await recallMemoryTool.execute({}, ctx);
        expect(result).toContain('A');
        expect(result).toContain('first');
        expect(result).toContain('B');
        expect(result).toContain('second');
    });

    it('recall filters by query (case-insensitive substring)', async () => {
        const { ctx } = makeCtx({});
        await saveMemoryTool.execute({ content: 'British spelling', heading: 'Spelling' }, ctx);
        await saveMemoryTool.execute({ content: 'something else entirely', heading: 'Other' }, ctx);
        const result = await recallMemoryTool.execute({ query: 'BRITISH' }, ctx);
        expect(result).toContain('Spelling');
        expect(result).toContain('British spelling');
        expect(result).not.toContain('something else');
    });

    it('recall filters by tags', async () => {
        const { ctx } = makeCtx({});
        await saveMemoryTool.execute({ content: 'a', heading: 'A', tags: ['pacing'] }, ctx);
        await saveMemoryTool.execute({ content: 'b', heading: 'B', tags: ['voice'] }, ctx);
        const result = await recallMemoryTool.execute({ tags: ['pacing'] }, ctx);
        expect(result).toContain('A');
        expect(result).not.toContain('## B');
    });

    it('recall with scope=all returns both manuscript + global pools', async () => {
        const { ctx } = makeCtx({ activeFilePath: 'Manuscript/chapter.md' });
        await saveMemoryTool.execute({ content: 'manuscript fact', heading: 'MS' }, ctx);
        await saveMemoryTool.execute({ content: 'global fact', heading: 'G', scope: 'global' }, ctx);
        const result = await recallMemoryTool.execute({ scope: 'all' }, ctx);
        expect(result).toContain('MS');
        expect(result).toContain('G');
    });

    it('recall respects the memoriesRecallMaxEntries cap', async () => {
        const { ctx } = makeCtx({ memoriesRecallMaxEntries: 2 });
        await saveMemoryTool.execute({ content: 'a', heading: 'A' }, ctx);
        await saveMemoryTool.execute({ content: 'b', heading: 'B' }, ctx);
        await saveMemoryTool.execute({ content: 'c', heading: 'C' }, ctx);
        const result = await recallMemoryTool.execute({}, ctx);
        expect(result).toMatch(/2 of 3/);
        expect(result).toMatch(/1 more/);
    });

    it('recall returns a clear empty-message when the pool has no entries', async () => {
        const { ctx } = makeCtx({});
        const result = await recallMemoryTool.execute({}, ctx);
        expect(result).toContain('No memories match');
    });

    it('delete removes the entry by ID and preserves the file structure', async () => {
        const { ctx, state } = makeCtx({});
        await saveMemoryTool.execute({ content: 'keep', heading: 'Keep' }, ctx);
        const saveResult = (await saveMemoryTool.execute({ content: 'delete', heading: 'Delete' }, ctx)) as string;
        const idMatch = saveResult.match(/quill-mem-\d+/);
        expect(idMatch).not.toBeNull();
        const id = idMatch![0];

        const delResult = await deleteMemoryTool.execute({ id }, ctx);
        expect(delResult).toContain('Deleted memory');
        expect(delResult).toContain('Delete');

        const content = state.files.get('Memories/_global.memories.md')!;
        expect(content).toContain('## Keep');
        expect(content).not.toContain('## Delete');
    });

    it('delete searches both active and global scopes to find the ID', async () => {
        const { ctx } = makeCtx({ activeFilePath: 'Manuscript/chapter.md' });
        // Save in global, then delete while the active scope is Manuscript.
        const saveResult = (await saveMemoryTool.execute(
            { content: 'global fact', heading: 'Global', scope: 'global' },
            ctx
        )) as string;
        const id = saveResult.match(/quill-mem-\d+/)![0];
        const delResult = await deleteMemoryTool.execute({ id }, ctx);
        expect(delResult).toContain('Deleted');
    });

    it('delete returns a clear error when the ID is not found', async () => {
        const { ctx } = makeCtx({});
        const result = await deleteMemoryTool.execute({ id: 'quill-mem-999' }, ctx);
        expect(result).toContain('No memory with id');
        expect(result).toContain('quill-mem-999');
    });

    it('delete tolerates a leading caret in the id argument', async () => {
        const { ctx } = makeCtx({});
        const saveResult = (await saveMemoryTool.execute({ content: 'x', heading: 'X' }, ctx)) as string;
        const id = saveResult.match(/quill-mem-\d+/)![0];
        const delResult = await deleteMemoryTool.execute({ id: `^${id}` }, ctx);
        expect(delResult).toContain('Deleted');
    });

    it('delete rejects when memoriesEnabled is off', async () => {
        const { ctx } = makeCtx({ memoriesEnabled: false });
        const result = await deleteMemoryTool.execute({ id: 'quill-mem-001' }, ctx);
        expect(result).toContain('disabled');
    });

    it('delete does NOT remove the entry when the writer cancels the confirm modal', async () => {
        vi.mocked(confirmMemoryAction).mockResolvedValue(false);
        const { ctx, state } = makeCtx({});
        const saveResult = (await saveMemoryTool.execute({ content: 'keep this', heading: 'Keep' }, ctx)) as string;
        const id = saveResult.match(/quill-mem-\d+/)![0];
        const delResult = await deleteMemoryTool.execute({ id }, ctx);
        expect(delResult).toContain('cancelled');
        expect(delResult).toContain('NOT removed');
        // Entry still present in the file.
        const content = state.files.get('Memories/_global.memories.md')!;
        expect(content).toContain('## Keep');
    });

    it('save with memoriesAutoSave off does NOT write when the writer cancels', async () => {
        vi.mocked(confirmMemoryAction).mockResolvedValue(false);
        const { ctx, state } = makeCtx({ memoriesAutoSave: false });
        const result = await saveMemoryTool.execute({ content: 'should not save', heading: 'X' }, ctx);
        expect(result).toContain('cancelled');
        expect(result).toContain('NOT saved');
        expect(state.files.has('Memories/_global.memories.md')).toBe(false);
    });

    it('save with memoriesAutoSave off DOES write when the writer confirms', async () => {
        const { ctx, state } = makeCtx({ memoriesAutoSave: false });
        // Default mock resolves true.
        const result = await saveMemoryTool.execute({ content: 'confirmed save', heading: 'Y' }, ctx);
        expect(result).toContain('Saved memory');
        expect(state.files.has('Memories/_global.memories.md')).toBe(true);
        expect(state.files.get('Memories/_global.memories.md')!).toContain('## Y');
    });
});

describe('memories — writer-added section round-trip', () => {
    it('parser mints an ID for an untagged section on next read (re-tokenize)', async () => {
        // Writer creates a memory file manually with one section that has no ID.
        const initial = `# Memories — Global

## Manual entry

The writer typed this directly in the markdown editor.

## Tagged entry

This one has an ID already.

^quill-mem-005
`;
        const { ctx, state } = makeCtx({
            files: { 'Memories/_global.memories.md': initial }
        });

        // recall reads the file, which triggers the re-tokenize pass.
        const result = await recallMemoryTool.execute({}, ctx);
        expect(result).toContain('Manual entry');
        expect(result).toContain('Tagged entry');

        // The file should have been written back with a minted ID for Manual entry.
        const updated = state.files.get('Memories/_global.memories.md')!;
        expect(updated).toMatch(/## Manual entry[\s\S]*?\^quill-mem-\d+/m);
        // The existing Tagged entry keeps its ID 005.
        expect(updated).toContain('^quill-mem-005');
    });

    it('save after re-tokenize round-trips both the minted ID and the new entry', async () => {
        // Seed an untagged writer-added section, then save a new memory via
        // the tool. The save should preserve the minted ID for the untagged
        // section (write-back completes before save) AND append the new entry.
        const initial = `# Memories — Global

## Manual entry

Writer-typed, no ID yet.
`;
        const { ctx, state } = makeCtx({
            files: { 'Memories/_global.memories.md': initial }
        });
        const saveResult = await saveMemoryTool.execute(
            { content: 'AI-learned fact', heading: 'AI entry' },
            ctx
        );
        expect(saveResult).toContain('Saved memory');
        const content = state.files.get('Memories/_global.memories.md')!;
        // Manual entry preserved (now has a minted ID from the re-tokenize pass).
        expect(content).toContain('## Manual entry');
        expect(content).toContain('Writer-typed, no ID yet.');
        // AI entry was appended.
        expect(content).toContain('## AI entry');
        expect(content).toContain('AI-learned fact');
        // Both entries have IDs (two `\^quill-mem-NNN` lines). The caret is a
        // literal in the file (Obsidian block-ID syntax), not a regex anchor.
        const idMatches = content.match(/\^quill-mem-\d+/g);
        expect(idMatches?.length).toBeGreaterThanOrEqual(2);
    });
});

describe('raw-edit guard — generic editing tools refuse memory paths', () => {
    // The raw-edit guard runs AFTER resolveNoteFile (so bare memory filenames
    // are caught via name resolution). That means each tool's arg validation
    // runs first — pass valid args so the guard is what rejects.
    it.each([
        // [label, toolId, args]
        [
            'edit_note on memory file rejects',
            'edit_note',
            { path: 'Memories/Manuscript.memories.md', old_text: 'Body.', new_text: 'changed.' }
        ],
        [
            'insert_note on memory file rejects (anchor path)',
            'insert_note',
            { path: 'Memories/Manuscript.memories.md', anchor: 'Body.', new_text: 'added.' }
        ],
        [
            'insert_note on memory file rejects (at_top path)',
            'insert_note',
            { path: 'Memories/Manuscript.memories.md', position: 'at_top', new_text: 'added.' }
        ],
        [
            'append_to_note on memory file rejects',
            'append_to_note',
            { path: 'Memories/Manuscript.memories.md', content: 'added.' }
        ],
        [
            'delete_paragraph on memory file rejects',
            'delete_paragraph',
            { path: 'Memories/Manuscript.memories.md', old_text: 'Body.' }
        ]
    ])('%s', async (_label, toolId, args) => {
        const { ctx } = makeCtx({
            files: { 'Memories/Manuscript.memories.md': '# Memories\n\n## A\n\nBody.\n\n^quill-mem-001\n' }
        });
        const { createInternalToolRegistry } = await import('../../../src/ai/tools');
        const registry = createInternalToolRegistry();
        const tool = registry.get(toolId);
        expect(tool).toBeDefined();
        const result = await tool!.execute(args, ctx);
        expect(typeof result).toBe('string');
        expect(result).toMatch(/memory files cannot be edited/i);
        expect(result).toMatch(/save_memory|delete_memory/);
    });
});
