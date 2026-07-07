import { describe, it, expect } from 'vitest';
import {
    parseLoreType,
    parseAliases,
    findLoreFolder,
    stripGallerySections
} from '../../../src/core/dashboard/lorebook-scanner';

describe('parseLoreType', () => {
    it('returns the type for valid lowercase types', () => {
        expect(parseLoreType('character')).toBe('character');
        expect(parseLoreType('location')).toBe('location');
        expect(parseLoreType('plot-thread')).toBe('plot-thread');
        expect(parseLoreType('theme')).toBe('theme');
    });

    it('normalizes case and whitespace', () => {
        expect(parseLoreType('Character')).toBe('character');
        expect(parseLoreType('  LOCATION  ')).toBe('location');
    });

    it('returns "untyped" for unknown types', () => {
        expect(parseLoreType('creature')).toBe('untyped');
        expect(parseLoreType('spell')).toBe('untyped');
    });

    it('returns "untyped" for non-string values', () => {
        expect(parseLoreType(undefined)).toBe('untyped');
        expect(parseLoreType(null)).toBe('untyped');
        expect(parseLoreType(42)).toBe('untyped');
        expect(parseLoreType({})).toBe('untyped');
    });
});

describe('parseAliases', () => {
    it('parses a string array', () => {
        expect(parseAliases(['Sarah Connor', 'Sarah'])).toEqual(['sarah connor', 'sarah']);
    });

    it('parses a comma-separated string', () => {
        expect(parseAliases('Sarah, Sara, S')).toEqual(['sarah', 'sara', 's']);
    });

    it('parses a newline-separated string', () => {
        expect(parseAliases('Sarah\nSara\nS')).toEqual(['sarah', 'sara', 's']);
    });

    it('deduplicates aliases', () => {
        expect(parseAliases(['Sarah', 'sarah', 'SARAH'])).toEqual(['sarah']);
    });

    it('collapses internal whitespace', () => {
        expect(parseAliases(['Sarah   Connor'])).toEqual(['sarah connor']);
    });

    it('returns empty array for non-string, non-array input', () => {
        expect(parseAliases(undefined)).toEqual([]);
        expect(parseAliases(null)).toEqual([]);
        expect(parseAliases(42)).toEqual([]);
    });

    it('returns empty array for empty input', () => {
        expect(parseAliases([])).toEqual([]);
        expect(parseAliases('')).toEqual([]);
    });

    it('skips non-string items in an array', () => {
        expect(parseAliases(['real', 42, null, 'also'])).toEqual(['real', 'also']);
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
        // A heading that closes one gallery section does NOT simultaneously
        // open another — insert a non-gallery heading between them.
        const body =
            '## Gallery\n![[a.png]]\n## Biography\nText.\n## Reference\n![[b.png]]\n![[c.png]]';
        const result = stripGallerySections(body, ['gallery', 'reference']);
        expect(result.imageCount).toBe(3);
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
