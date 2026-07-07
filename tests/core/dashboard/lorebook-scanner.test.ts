import { describe, it, expect } from 'vitest';
import {
    parseLoreType,
    parseAliases,
    findLoreFolder,
    stripGallerySections,
    computeDocumentCoverage,
    computeManuscriptCoverage
} from '../../../src/core/dashboard/lorebook-scanner';
import type { LoreEntry } from '../../../src/core/dashboard/lorebook-types';
import type { ExtractedEntity } from '../../../src/core/context-engine/types';

function makeEntry(
    name: string,
    filePath: string,
    type: string = 'character',
    aliases: string[] = []
): LoreEntry {
    const matchNames = [name.toLowerCase().trim(), ...aliases.map((a) => a.toLowerCase().trim())];
    return {
        filePath,
        fileBasename: name,
        folder: 'Lore',
        type: type as LoreEntry['type'],
        aliases,
        matchNames: [...new Set(matchNames)],
        images: []
    };
}

function makeEntity(name: string, type: string, occurrences: number): ExtractedEntity {
    return {
        id: `${type}:${name.toLowerCase().replace(/\s+/g, '-')}`,
        type: type as ExtractedEntity['type'],
        name,
        occurrences,
        lines: [],
        aliases: [],
        pinned: false,
        removed: false,
        manual: false
    };
}

describe('parseLoreType', () => {
    it.each<{ input: unknown; expected: string }>([
        { input: 'character', expected: 'character' },
        { input: 'location', expected: 'location' },
        { input: 'plot-thread', expected: 'plot-thread' },
        { input: 'theme', expected: 'theme' },
        { input: 'Character', expected: 'character' },
        { input: '  LOCATION  ', expected: 'location' },
        { input: 'creature', expected: 'untyped' },
        { input: 'spell', expected: 'untyped' },
        { input: undefined, expected: 'untyped' },
        { input: null, expected: 'untyped' },
        { input: 42, expected: 'untyped' },
        { input: {}, expected: 'untyped' }
    ])('returns "$expected" for $input', ({ input, expected }) => {
        expect(parseLoreType(input)).toBe(expected);
    });
});

describe('parseAliases', () => {
    it.each<{ input: unknown; expected: string[] }>([
        { input: ['Sarah Connor', 'Sarah'], expected: ['sarah connor', 'sarah'] },
        { input: 'Sarah, Sara, S', expected: ['sarah', 'sara', 's'] },
        { input: 'Sarah\nSara\nS', expected: ['sarah', 'sara', 's'] },
        { input: ['Sarah', 'sarah', 'SARAH'], expected: ['sarah'] },
        { input: ['Sarah   Connor'], expected: ['sarah connor'] },
        { input: undefined, expected: [] },
        { input: null, expected: [] },
        { input: 42, expected: [] },
        { input: [], expected: [] },
        { input: '', expected: [] },
        { input: ['real', 42, null, 'also'], expected: ['real', 'also'] }
    ])('returns $expected for $input', ({ input, expected }) => {
        expect(parseAliases(input)).toEqual(expected);
    });
});

describe('findLoreFolder', () => {
    it('matches a file under a lore folder', () => {
        expect(findLoreFolder('Lore/Characters/Sarah.md', ['Lore'])).toBe('Lore');
    });

    it('returns null for a file not under any lore folder', () => {
        expect(findLoreFolder('Notes/Random.md', ['Lore'])).toBeNull();
    });

    it('prefers the deepest (most specific) folder', () => {
        expect(findLoreFolder('Lore/Characters/Sarah.md', ['Lore', 'Lore/Characters'])).toBe(
            'Lore/Characters'
        );
    });

    it('handles multiple independent folders', () => {
        expect(findLoreFolder('World/Factions/Guild.md', ['Lore', 'World'])).toBe('World');
    });

    it('matches an exact folder path (file directly in the folder)', () => {
        // File at 'Lore/Sarah.md' starts with 'Lore/'
        expect(findLoreFolder('Lore/Sarah.md', ['Lore'])).toBe('Lore');
    });
});

describe('stripGallerySections', () => {
    it('returns body unchanged when no section headers are configured', () => {
        const body = '## Gallery\n![[img.png]]\nText.';
        const result = stripGallerySections(body, []);
        expect(result.stripped).toBe(body);
        expect(result.imageCount).toBe(0);
    });

    it('returns body unchanged when no gallery section is present', () => {
        const body = '## Biography\nSome text about the character.';
        const result = stripGallerySections(body, ['gallery', 'reference']);
        expect(result.stripped).toBe(body);
        expect(result.imageCount).toBe(0);
    });

    it('strips a gallery section and counts images', () => {
        // The gallery must be closed by a heading at the same or shallower level;
        // otherwise it extends to EOF and consumes trailing content.
        const body = 'Intro text.\n\n## Gallery\n![[art1.png]]\n![[art2.png]]\n\n## After\nContent.';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.imageCount).toBe(2);
        expect(result.stripped).not.toContain('![[art1.png]]');
        expect(result.stripped).not.toContain('![[art2.png]]');
        expect(result.stripped).toContain('Intro text.');
        expect(result.stripped).toContain('## After');
        expect(result.stripped).toContain('Content.');
    });

    it('emits a marker with image count', () => {
        const body = '## Gallery\n![[art1.png]]\n![[art2.png]]';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.stripped).toContain('[Gallery section "Gallery": 2 images available');
        expect(result.stripped).toContain('use get_lore_image');
    });

    it('handles multiple gallery sections', () => {
        const body =
            '## Gallery\n![[a.png]]\n## Reference\n![[b.png]]\n![[c.png]]';
        const result = stripGallerySections(body, ['gallery', 'reference']);
        expect(result.imageCount).toBe(3);
    });

    it('handles back-to-back gallery sections (closing heading reopens)', () => {
        // A heading that closes one gallery section and is itself in the header
        // set should simultaneously open the next section.
        const body = '## Gallery\n![[a.png]]\n## Reference\n![[b.png]]';
        const result = stripGallerySections(body, ['gallery', 'reference']);
        expect(result.imageCount).toBe(2);
        expect(result.stripped).not.toContain('![[a.png]]');
        expect(result.stripped).not.toContain('![[b.png]]');
    });

    it('tracks subheading labels within a gallery section', () => {
        const body =
            '## Gallery\n### Default form\n![[form1.png]]\n### Alternate form\n![[form2.png]]';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.stripped).toContain('Default form');
        expect(result.stripped).toContain('Alternate form');
    });

    it('skips non-image embeds', () => {
        const body = '## Gallery\n![[document.pdf]]\n![[art.png]]';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.imageCount).toBe(1);
    });

    it('ends gallery at a same-or-shallower heading', () => {
        const body = '## Gallery\n![[art.png]]\n## Biography\nText here.';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.imageCount).toBe(1);
        expect(result.stripped).toContain('## Biography');
        expect(result.stripped).toContain('Text here.');
    });

    it('handles case-insensitive header matching', () => {
        const body = '## GALLERY\n![[art.png]]';
        const result = stripGallerySections(body, ['gallery']);
        expect(result.imageCount).toBe(1);
    });
});

describe('computeDocumentCoverage', () => {
    it('classifies entries as referenced when their name appears in the doc', () => {
        const entries = [
            makeEntry('Sarah Connor', 'Lore/sarah.md'),
            makeEntry('Unknown Character', 'Lore/unknown.md')
        ];
        const coverage = computeDocumentCoverage('Sarah Connor walked into the bar.', entries, null);
        expect(coverage.referenced).toHaveLength(1);
        expect(coverage.referenced[0]!.fileBasename).toBe('Sarah Connor');
        expect(coverage.orphaned).toHaveLength(1);
        expect(coverage.orphaned[0]!.fileBasename).toBe('Unknown Character');
    });

    it('excludes the active file from both lists', () => {
        const entries = [
            makeEntry('Sarah', 'Lore/sarah.md'),
            makeEntry('John', 'Lore/john.md')
        ];
        const coverage = computeDocumentCoverage('Sarah and John.', entries, 'Lore/sarah.md');
        expect(coverage.referenced.find((e) => e.filePath === 'Lore/sarah.md')).toBeUndefined();
        expect(coverage.orphaned.find((e) => e.filePath === 'Lore/sarah.md')).toBeUndefined();
    });

    it('counts total entries and folders', () => {
        const entries = [
            makeEntry('Sarah', 'Lore/sarah.md'),
            makeEntry('John', 'Lore/john.md')
        ];
        const coverage = computeDocumentCoverage('text', entries, null);
        expect(coverage.totalEntries).toBe(2);
        expect(coverage.folderCount).toBe(1); // both in 'Lore'
    });

    it('matches aliases', () => {
        const entries = [makeEntry('John', 'Lore/john.md', 'character', ['Johnny', 'John Boy'])];
        const coverage = computeDocumentCoverage('Johnny walked in.', entries, null);
        expect(coverage.referenced).toHaveLength(1);
    });
});

describe('computeManuscriptCoverage', () => {
    it('classifies typed entries as referenced or orphaned', () => {
        const entries = [
            makeEntry('Sarah', 'Lore/sarah.md', 'character'),
            makeEntry('Dragon', 'Lore/dragon.md', 'character')
        ];
        const coverage = computeManuscriptCoverage('Sarah was brave.', entries, [], null, new Set());
        expect(coverage.referenced).toHaveLength(1);
        expect(coverage.orphaned).toHaveLength(1);
    });

    it('skips untyped entries from referenced/orphaned lists', () => {
        const entries = [makeEntry('Misc', 'Lore/misc.md', 'untyped')];
        const coverage = computeManuscriptCoverage('Misc text.', entries, [], null, new Set());
        expect(coverage.referenced).toHaveLength(0);
        expect(coverage.orphaned).toHaveLength(0);
        expect(coverage.totalEntries).toBe(1); // still counted in total
    });

    it('detects gaps for entities with no matching lore entry', () => {
        const entries = [makeEntry('Sarah', 'Lore/sarah.md', 'character')];
        const entities = [
            makeEntity('Sarah', 'character', 10),
            makeEntity('Unknown', 'character', 8)
        ];
        const coverage = computeManuscriptCoverage('Sarah and Unknown.', entries, entities, null, new Set());
        expect(coverage.gaps.length).toBeGreaterThanOrEqual(1);
        const gap = coverage.gaps.find((g) => g.entityName === 'Unknown');
        expect(gap).toBeDefined();
        expect(gap!.occurrences).toBe(8);
    });

    it('suppresses gaps for dismissed entities', () => {
        const entries: LoreEntry[] = [];
        const entities = [makeEntity('Dismissed', 'character', 10)];
        const dismissed = new Set(['character:dismissed']);
        const coverage = computeManuscriptCoverage('Dismissed text.', entries, entities, null, dismissed);
        expect(coverage.gaps.find((g) => g.entityName === 'Dismissed')).toBeUndefined();
    });

    it('excludes the active file from referenced/orphaned', () => {
        const entries = [
            makeEntry('Sarah', 'Lore/sarah.md', 'character'),
            makeEntry('John', 'Lore/john.md', 'character')
        ];
        const coverage = computeManuscriptCoverage('Sarah and John.', entries, [], 'Lore/sarah.md', new Set());
        expect(coverage.referenced.find((e) => e.filePath === 'Lore/sarah.md')).toBeUndefined();
        expect(coverage.orphaned.find((e) => e.filePath === 'Lore/sarah.md')).toBeUndefined();
    });
});
