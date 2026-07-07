import { describe, it, expect } from 'vitest';
import { parseDirectives, parseAllDirectives } from '../../src/utils/directives';

describe('parseAllDirectives', () => {
    it('returns empty array for text with no directives', () => {
        expect(parseAllDirectives('just prose, no directives')).toEqual([]);
    });

    it('finds a single directive', () => {
        const doc = '<!-- quill: write a battle scene -->';
        const result = parseAllDirectives(doc);
        expect(result).toHaveLength(1);
        expect(result[0]!.text).toBe('write a battle scene');
        expect(result[0]!.start).toBe(0);
        expect(result[0]!.end).toBe(doc.length);
    });

    it('finds multiple directives in document order', () => {
        const doc = '<!-- quill: first -->\nprose\n<!-- quill: second -->';
        const result = parseAllDirectives(doc);
        expect(result).toHaveLength(2);
        expect(result[0]!.text).toBe('first');
        expect(result[1]!.text).toBe('second');
    });

    it('skips empty directive text', () => {
        const doc = '<!-- quill:  -->';
        expect(parseAllDirectives(doc)).toEqual([]);
    });

    it('captures correct offset ranges', () => {
        const doc = 'intro\n<!-- quill: go -->';
        const result = parseAllDirectives(doc);
        expect(result[0]!.start).toBe(6);
        expect(result[0]!.end).toBe(doc.length);
    });

    it('handles multi-line directive text', () => {
        const doc = '<!-- quill: line one\nline two -->';
        const result = parseAllDirectives(doc);
        expect(result).toHaveLength(1);
        expect(result[0]!.text).toContain('line one');
        expect(result[0]!.text).toContain('line two');
    });
});

describe('parseDirectives (cursor-scoped)', () => {
    it('returns empty array for text with no directives', () => {
        expect(parseDirectives('just prose here')).toEqual([]);
    });

    it('returns empty array for empty text', () => {
        expect(parseDirectives('')).toEqual([]);
    });

    it('extracts a directive immediately before the cursor', () => {
        const text = 'some prose\n<!-- quill: do something -->';
        expect(parseDirectives(text)).toEqual(['do something']);
    });

    it('extracts multiple contiguous directives', () => {
        const text = '<!-- quill: first -->\n<!-- quill: second -->';
        const result = parseDirectives(text);
        expect(result).toHaveLength(2);
        expect(result[0]).toBe('first');
        expect(result[1]).toBe('second');
    });

    it('stops at prose between directives and cursor', () => {
        const text = '<!-- quill: above -->\nprose interrupts\n<!-- quill: near cursor -->';
        const result = parseDirectives(text);
        expect(result).toEqual(['near cursor']);
    });

    it('ignores directives interrupted by non-whitespace from the cursor', () => {
        const text = '<!-- quill: far -->\n\nsome prose\n\n<!-- quill: near -->';
        expect(parseDirectives(text)).toEqual(['near']);
    });

    it('allows whitespace between contiguous directives', () => {
        const text = '<!-- quill: a -->\n\n   \n<!-- quill: b -->';
        expect(parseDirectives(text)).toEqual(['a', 'b']);
    });

    it('includes directive right at the end with no trailing whitespace', () => {
        const text = '<!-- quill: immediate -->';
        expect(parseDirectives(text)).toEqual(['immediate']);
    });

    it('filters out empty directive text', () => {
        const text = '<!-- quill:   -->\n<!-- quill: real -->';
        expect(parseDirectives(text)).toEqual(['real']);
    });
});
