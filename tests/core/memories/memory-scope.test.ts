import { describe, it, expect } from 'vitest';
import {
    scopeKeyFromPath,
    isExcludedScope,
    isMemoryFilePath,
    memoryFilePath,
    GLOBAL_MEMORY_SCOPE as GLOBAL,
    type ExclusionOptions
} from '../../../src/core/memories/memory-scope';

const defaultOpts: ExclusionOptions = { memoriesFolder: 'Memories', configDirScope: '.obsidian' };

describe('scopeKeyFromPath', () => {
    it('returns the top-level folder for a nested path', () => {
        expect(scopeKeyFromPath('Manuscript/Chapters/04/chapter.md')).toBe('Manuscript');
    });

    it('returns the top-level folder for a one-level-deep file', () => {
        expect(scopeKeyFromPath('Manuscript/chapter.md')).toBe('Manuscript');
    });

    it('returns global for a bare folder name with no parent path', () => {
        // normalizePath strips trailing slashes, so 'Manuscript/' collapses to
        // 'Manuscript' which has no parent. In practice this function only
        // receives FILE paths (from workspace.getActiveFile()), where a real
        // manuscript file would be 'Manuscript/chapter.md' → 'Manuscript'.
        expect(scopeKeyFromPath('Manuscript/')).toBe(GLOBAL);
        expect(scopeKeyFromPath('Manuscript')).toBe(GLOBAL);
    });

    it('returns global for a file at vault root', () => {
        expect(scopeKeyFromPath('chapter.md')).toBe(GLOBAL);
    });

    it('returns global for an empty path', () => {
        expect(scopeKeyFromPath('')).toBe(GLOBAL);
    });

    it('handles whitespace-only paths as global', () => {
        expect(scopeKeyFromPath('   ')).toBe(GLOBAL);
    });

    it('returns the first segment when path has multiple slashes', () => {
        expect(scopeKeyFromPath('Series/Book/Part/Chapter/file.md')).toBe('Series');
    });

    it('handles folder names with spaces', () => {
        expect(scopeKeyFromPath('My Book/Chapter 1/file.md')).toBe('My Book');
    });

    it('handles folder names with dots', () => {
        expect(scopeKeyFromPath('v2.0 Manuscript/file.md')).toBe('v2.0 Manuscript');
    });

    it('returns the top-level folder when path starts with a slash (defensive)', () => {
        // normalizePath strips leading slashes, so this should still resolve correctly
        expect(scopeKeyFromPath('/Manuscript/file.md')).toBe('Manuscript');
    });
});

describe('isExcludedScope', () => {
    it('excludes the Obsidian config dir', () => {
        expect(isExcludedScope('.obsidian', defaultOpts)).toBe(true);
    });

    it('excludes a custom-configured Obsidian config dir', () => {
        expect(isExcludedScope('.custom-obsidian', { memoriesFolder: 'Memories', configDirScope: '.custom-obsidian' })).toBe(true);
    });

    it('excludes .trash', () => {
        expect(isExcludedScope('.trash', defaultOpts)).toBe(true);
    });

    it('excludes the configured memories folder', () => {
        expect(isExcludedScope('Memories', defaultOpts)).toBe(true);
        expect(isExcludedScope('Custom Memories', { memoriesFolder: 'Custom Memories', configDirScope: '.obsidian' })).toBe(true);
    });

    it('excludes the global scope key', () => {
        expect(isExcludedScope(GLOBAL, defaultOpts)).toBe(true);
    });

    it('excludes empty scope keys', () => {
        expect(isExcludedScope('', defaultOpts)).toBe(true);
    });

    it('does NOT exclude a normal manuscript folder', () => {
        expect(isExcludedScope('Manuscript', defaultOpts)).toBe(false);
    });

    it('does NOT exclude the lorebook folder (gets its own pool)', () => {
        expect(isExcludedScope('Lorebook', defaultOpts)).toBe(false);
    });

    it('does NOT exclude a folder that just shares a prefix with the memories folder', () => {
        expect(isExcludedScope('Memories2', defaultOpts)).toBe(false);
        expect(isExcludedScope('My Memories', defaultOpts)).toBe(false);
    });

    it('handles missing configDirScope (undefined)', () => {
        expect(isExcludedScope('.obsidian', { memoriesFolder: 'Memories' })).toBe(false);
        expect(isExcludedScope('Memories', { memoriesFolder: 'Memories' })).toBe(true);
    });
});

describe('memoryFilePath', () => {
    it('produces the standard path for a manuscript scope', () => {
        expect(memoryFilePath('Manuscript', 'Memories')).toBe('Memories/Manuscript.memories.md');
    });

    it('produces the global file path for the global scope', () => {
        expect(memoryFilePath(GLOBAL, 'Memories')).toBe('Memories/_global.memories.md');
    });

    it('falls back to the global filename when scope is empty', () => {
        expect(memoryFilePath('', 'Memories')).toBe('Memories/_global.memories.md');
    });

    it('uses the configured memories folder verbatim', () => {
        expect(memoryFilePath('Manuscript', 'Custom')).toBe('Custom/Manuscript.memories.md');
        expect(memoryFilePath('Manuscript', 'Quill/Memories')).toBe('Quill/Memories/Manuscript.memories.md');
    });

    it('handles scope keys with spaces', () => {
        expect(memoryFilePath('My Book', 'Memories')).toBe('Memories/My Book.memories.md');
    });
});

describe('isMemoryFilePath', () => {
    it.each([
        ['flat memories folder, direct file', 'Memories/Manuscript.memories.md', 'Memories', true],
        ['flat memories folder, nested file', 'Memories/Sub/File.md', 'Memories', true],
        ['nested memories folder, direct file', 'Quill/Memories/Manuscript.memories.md', 'Quill/Memories', true],
        ['nested memories folder, deep file', 'Quill/Memories/a/b.md', 'Quill/Memories', true],
        ['manuscript file (not memory)', 'Manuscript/Chapter 1.md', 'Memories', false],
        ['prefix-sharing sibling: Memories2', 'Memories2/note.md', 'Memories', false],
        ['prefix-sharing sibling: My Memories', 'My Memories/note.md', 'Memories', false],
        ['bare filename at vault root', 'note.md', 'Memories', false],
        ['memories folder itself (no file)', 'Memories', 'Memories', true],
        ['empty path', '', 'Memories', false]
    ])('%s', (_label, filePath, memoriesFolder, expected) => {
        expect(isMemoryFilePath(filePath, memoriesFolder)).toBe(expected);
    });
});

// resolveActiveScopeKey is plugin-coupled (touches plugin.currentManuscriptFolder,
// workspace.getActiveFile(), plugin.settings.memoriesFolder); it's exercised
// end-to-end via the tool tests in tests/ai/tools/. The pure helpers above
// carry the deterministic logic and get the unit coverage.
