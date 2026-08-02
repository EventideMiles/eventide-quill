import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { saveMemoryTool } from '../../../src/ai/tools/save-memory';
import { recallMemoryTool } from '../../../src/ai/tools/recall-memory';
import { deleteMemoryTool } from '../../../src/ai/tools/delete-memory';
import type { ToolContext } from '../../../src/ai/tools/tool';

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
        const id = idMatch[0];

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
});
