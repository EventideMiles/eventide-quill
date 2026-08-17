import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { buildMemoryMessage, MEMORY_DISCIPLINE_CLAUSE } from '../../src/ai/memory-prompts';
import type EventideQuillPlugin from '../../src/main';

/** Build a plugin stub with the given vault state and settings. */
function makePlugin(opts: {
    files?: Record<string, string>;
    memoriesEnabled?: boolean;
    memoriesFullInject?: boolean;
    memoriesMaxIndexEntries?: number;
    activeFilePath?: string | null;
    currentManuscriptFolder?: string | null;
    memoriesFolder?: string;
}): EventideQuillPlugin {
    const files = new Map(Object.entries(opts.files ?? {}));
    const fileObjects = new Map<string, TFile>();
    for (const path of files.keys()) {
        const f = new TFile();
        f.path = path;
        f.basename = path.split('/').pop()?.replace(/\.memories\.md$/, '').replace(/\.md$/, '') ?? path;
        fileObjects.set(path, f);
    }
    const activeFilePath = opts.activeFilePath ?? null;

    return {
        settings: {
            memoriesEnabled: opts.memoriesEnabled ?? true,
            memoriesFolder: opts.memoriesFolder ?? 'Memories',
            memoriesFullInject: opts.memoriesFullInject ?? false,
            memoriesMaxIndexEntries: opts.memoriesMaxIndexEntries ?? 20,
            memoriesRecallMaxEntries: 10,
            memoriesMaxPerFile: 100
        },
        currentManuscriptFolder: opts.currentManuscriptFolder ?? null,
        app: {
            vault: {
                get configDir(): string {
                    return '.obsidian';
                },
                getAbstractFileByPath(path: string): TFile | null {
                    return fileObjects.get(path) ?? null;
                },
                async cachedRead(file: TFile): Promise<string> {
                    return files.get(file.path) ?? '';
                }
            },
            workspace: {
                getActiveFile(): TFile | null {
                    if (!activeFilePath) return null;
                    return fileObjects.get(activeFilePath) ?? (() => {
                        const f = new TFile();
                        f.path = activeFilePath;
                        return f;
                    })();
                }
            }
        }
    } as unknown as EventideQuillPlugin;
}

describe('buildMemoryMessage — index injection', () => {
    it('returns null when memoriesEnabled is off (master kill switch)', async () => {
        const plugin = makePlugin({ memoriesEnabled: false });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).toBeNull();
    });

    it('returns null when no memory files exist', async () => {
        const plugin = makePlugin({});
        const msg = await buildMemoryMessage(plugin);
        expect(msg).toBeNull();
    });

    it('returns null when memory file exists but has no entries', async () => {
        const plugin = makePlugin({
            files: {
                'Memories/_global.memories.md': '# Memories — Global\n\nJust a title, no sections.'
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).toBeNull();
    });

    it('includes the global pool when it has entries (no active manuscript)', async () => {
        const plugin = makePlugin({
            files: {
                'Memories/_global.memories.md': `# Memories — Global

## British spelling

Colour, favourite, realise.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('Memories (Global)');
        expect(msg!.content).toContain('British spelling');
        expect(msg!.content).toContain('^quill-mem-001');
        // Preview is included in hybrid mode.
        expect(msg!.content).toContain('Colour, favourite, realise');
    });

    it('includes both active scope and global sections when both have entries', async () => {
        const plugin = makePlugin({
            activeFilePath: 'Manuscript/chapter.md',
            files: {
                'Memories/Manuscript.memories.md': `# Memories — Manuscript

## Pacing

Slow on purpose.

^quill-mem-001
`,
                'Memories/_global.memories.md': `# Memories — Global

## Spelling

British English.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('Memories (Manuscript)');
        expect(msg!.content).toContain('Memories (Global)');
        expect(msg!.content).toContain('Pacing');
        expect(msg!.content).toContain('Spelling');
    });

    it('includes only the global section when active scope has no entries', async () => {
        const plugin = makePlugin({
            activeFilePath: 'Manuscript/chapter.md',
            files: {
                'Memories/_global.memories.md': `# Memories — Global

## Only here

Body.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).not.toContain('Memories (Manuscript)');
        expect(msg!.content).toContain('Memories (Global)');
    });

    it('respects memoriesMaxIndexEntries cap with a "N more" hint', async () => {
        const entries = Array.from({ length: 5 }, (_, i) => `## Memory ${i + 1}\n\nBody ${i + 1}.\n\n^quill-mem-${String(i + 1).padStart(3, '0')}`).join('\n\n');
        const plugin = makePlugin({
            memoriesMaxIndexEntries: 2,
            files: { 'Memories/_global.memories.md': `# Memories — Global\n\n${entries}` }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('Memory 1');
        expect(msg!.content).toContain('Memory 2');
        expect(msg!.content).not.toContain('## Memory 3'); // not as a heading-equivalent
        expect(msg!.content).toMatch(/3 more/);
        expect(msg!.content).toMatch(/recall_memory/);
    });

    it('memoriesFullInject replaces previews with full bodies', async () => {
        const plugin = makePlugin({
            memoriesFullInject: true,
            files: {
                'Memories/_global.memories.md': `# Memories — Global

## Long entry

First sentence here. Second sentence with more detail. Third for good measure.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('Second sentence with more detail');
        expect(msg!.content).toContain('Third for good measure');
    });

    it('omits the active section when active file is at vault root (global fallback)', async () => {
        const plugin = makePlugin({
            activeFilePath: 'notes.md',
            files: {
                'Memories/_global.memories.md': `# Memories — Global

## A fact

Body.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('Memories (Global)');
        expect(msg!.content).not.toContain('Memories (notes');
    });

    it('tags appear in the index entry', async () => {
        const plugin = makePlugin({
            files: {
                'Memories/_global.memories.md': `# Memories — Global

## Tagged

Body with #pacing and #voice.

^quill-mem-001
`
            }
        });
        const msg = await buildMemoryMessage(plugin);
        expect(msg).not.toBeNull();
        expect(msg!.content).toContain('#pacing');
        expect(msg!.content).toContain('#voice');
    });
});

describe('MEMORY_DISCIPLINE_CLAUSE', () => {
    it('covers WHEN to save (positive triggers)', () => {
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('SAVE a memory');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('Corrects an assumption');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('preference');
    });

    it('covers WHEN NOT to save (negative triggers)', () => {
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('DO NOT save');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('Transient discussion');
    });

    it('covers scope guidance', () => {
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('SCOPE');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('global');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('auto');
    });

    it('covers delete discipline', () => {
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('DELETE only when');
        expect(MEMORY_DISCIPLINE_CLAUSE).toContain('explicitly asks');
    });
});
