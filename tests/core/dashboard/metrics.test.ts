import { describe, it, expect } from 'vitest';
import {
    countWords,
    countSentences,
    pacingAnalysis,
    listChaptersInFile,
    chapterMetrics,
    characterAppearances
} from '../../../src/core/dashboard/metrics';
import type { ExtractedEntity } from '../../../src/core/context-engine/types';

/** Build a line-offset table (same logic as the module-internal buildLineOffsetTable). */
function buildLineTable(text: string): number[] {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
}

describe('countWords', () => {
    it('counts words in a simple string', () => {
        expect(countWords('one two three')).toBe(3);
    });

    it('returns 0 for empty string', () => {
        expect(countWords('')).toBe(0);
    });

    it('returns 0 for whitespace-only text', () => {
        expect(countWords('   \n\t  ')).toBe(0);
    });

    it('handles leading and trailing whitespace', () => {
        expect(countWords('  hello world  ')).toBe(2);
    });

    it('handles newlines as separators', () => {
        expect(countWords('line one\nline two\nline three')).toBe(6);
    });
});

describe('countSentences', () => {
    it('counts sentences in a simple string', () => {
        expect(countSentences('One. Two. Three.')).toBe(3);
    });

    it('returns 0 for empty string', () => {
        expect(countSentences('')).toBe(0);
    });

    it('returns 0 for whitespace-only text', () => {
        expect(countSentences('   ')).toBe(0);
    });

    it('counts sentences separated by newlines', () => {
        expect(countSentences('First sentence\nSecond sentence\nThird')).toBe(3);
    });

    it('counts a single sentence without terminal punctuation', () => {
        expect(countSentences('Just a fragment')).toBe(1);
    });

    it('counts sentences with question and exclamation marks', () => {
        expect(countSentences('What? Stop! Now.')).toBe(3);
    });
});

describe('pacingAnalysis', () => {
    it('returns empty array for empty text', () => {
        expect(pacingAnalysis('', buildLineTable(''), 'test.md')).toEqual([]);
    });

    it('returns empty array for too-few sentences', () => {
        const text = 'Short one. Short two.';
        expect(pacingAnalysis(text, buildLineTable(text), 'test.md')).toEqual([]);
    });

    it('flags uniformly short sentences', () => {
        // Many very short sentences in a row.
        const text = Array.from({ length: 8 }, (_, i) => `Go ${i}.`).join(' ');
        const flags = pacingAnalysis(text, buildLineTable(text), 'test.md');
        expect(flags.some((f) => f.kind === 'uniform-short')).toBe(true);
    });

    it('flags uniformly long sentences', () => {
        // Many very long sentences in a row.
        const longSentence = 'word '.repeat(45).trim();
        const text = Array.from({ length: 8 }, () => `${longSentence}.`).join(' ');
        const flags = pacingAnalysis(text, buildLineTable(text), 'test.md');
        expect(flags.some((f) => f.kind === 'uniform-long')).toBe(true);
    });

    it('attaches the filePath to flags', () => {
        const text = Array.from({ length: 8 }, (_, i) => `Go ${i}.`).join(' ');
        const flags = pacingAnalysis(text, buildLineTable(text), 'manuscript/ch1.md');
        expect(flags.every((f) => f.filePath === 'manuscript/ch1.md')).toBe(true);
    });

    it('produces valid 1-based line numbers', () => {
        const text = Array.from({ length: 8 }, (_, i) => `Go ${i}.`).join(' ');
        const flags = pacingAnalysis(text, buildLineTable(text), 'test.md');
        for (const f of flags) {
            expect(f.lineStart).toBeGreaterThanOrEqual(1);
            expect(f.lineEnd).toBeGreaterThanOrEqual(f.lineStart);
        }
    });
});

describe('listChaptersInFile', () => {
    it('returns empty array for blank text', () => {
        expect(listChaptersInFile('', 'test.md', 'test', false)).toEqual([]);
    });

    it('returns one chapter when splitByHeading is false', () => {
        const chapters = listChaptersInFile('Some prose.\nMore prose.', 'test.md', 'test', false);
        expect(chapters).toHaveLength(1);
        expect(chapters[0]!.title).toBe('test');
        expect(chapters[0]!.filePath).toBe('test.md');
        expect(chapters[0]!.lineStart).toBe(1);
    });

    it('splits at top-level headings when splitByHeading is true', () => {
        const text = '## Chapter One\nFirst chapter text.\n## Chapter Two\nSecond chapter text.';
        const chapters = listChaptersInFile(text, 'test.md', 'test', true);
        expect(chapters).toHaveLength(2);
        expect(chapters[0]!.title).toBe('Chapter One');
        expect(chapters[1]!.title).toBe('Chapter Two');
    });

    it('includes leading content as Untitled chapter when heading-split', () => {
        const text = 'Introduction text.\n## Chapter One\nBody.';
        const chapters = listChaptersInFile(text, 'test.md', 'test', true);
        expect(chapters).toHaveLength(2);
        expect(chapters[0]!.title).toBe('Untitled');
    });

    it('falls back to whole-file chapter when no headings found', () => {
        const text = 'Just prose without headings here.';
        const chapters = listChaptersInFile(text, 'test.md', 'test', true);
        expect(chapters).toHaveLength(1);
    });
});

describe('chapterMetrics', () => {
    it('computes metrics for a single-chapter file', () => {
        const chapters = listChaptersInFile(
            'The cat sat on the mat. The dog ran fast. It was a good day.',
            'test.md',
            'test',
            false
        );
        const metrics = chapterMetrics(chapters[0]!);
        expect(metrics.wordCount).toBeGreaterThan(0);
        expect(metrics.sentenceCount).toBe(3);
        expect(metrics.filePath).toBe('test.md');
        expect(metrics.title).toBe('test');
    });

    it('computes dialogue and narration ratios', () => {
        const chapters = listChaptersInFile(
            'He walked in. "What do you want?" he asked.',
            'test.md',
            'test',
            false
        );
        const metrics = chapterMetrics(chapters[0]!);
        expect(metrics.dialogueRatio).toBeGreaterThanOrEqual(0);
        expect(metrics.narrationRatio).toBeGreaterThanOrEqual(0);
        expect(metrics.dialogueRatio + metrics.narrationRatio).toBeCloseTo(1, 1);
    });

    it('produces per-section breakdowns', () => {
        const text = '### Scene One\nFirst scene body.\n### Scene Two\nSecond scene body.';
        const chapters = listChaptersInFile(text, 'test.md', 'test', false);
        const metrics = chapterMetrics(chapters[0]!);
        expect(metrics.sections.length).toBeGreaterThanOrEqual(2);
    });
});

describe('characterAppearances', () => {
    function makeEntity(name: string, occurrences: number, aliases: string[] = []): ExtractedEntity {
        return {
            id: `character:${name.toLowerCase().replace(/\s+/g, '-')}`,
            type: 'character',
            name,
            occurrences,
            lines: [],
            aliases,
            pinned: false,
            removed: false,
            manual: false
        };
    }

    it('finds characters that appear in the manuscript text', () => {
        const chapters = listChaptersInFile(
            'Sarah walked to the door. She opened it.',
            'ch1.md',
            'ch1',
            false
        );
        const entities = [makeEntity('Sarah', 5)];
        const appearances = characterAppearances(chapters, entities);
        expect(appearances).toHaveLength(1);
        expect(appearances[0]!.name).toBe('Sarah');
        expect(appearances[0]!.chapterIndices).toContain(0);
    });

    it('matches aliases', () => {
        const chapters = listChaptersInFile(
            'John entered the room. Johnny sat down.',
            'ch1.md',
            'ch1',
            false
        );
        const entities = [makeEntity('John', 5, ['Johnny'])];
        const appearances = characterAppearances(chapters, entities);
        expect(appearances).toHaveLength(1);
    });

    it('reports chaptersSinceLastSeen correctly', () => {
        const text1 = 'Sarah was here.';
        const text2 = 'Nobody mentioned.';
        const text3 = 'Nobody mentioned either.';
        const chapters = [
            ...listChaptersInFile(text1, 'ch1.md', 'ch1', false),
            ...listChaptersInFile(text2, 'ch2.md', 'ch2', false),
            ...listChaptersInFile(text3, 'ch3.md', 'ch3', false)
        ];
        const entities = [makeEntity('Sarah', 5)];
        const appearances = characterAppearances(chapters, entities);
        expect(appearances[0]!.chapterIndices).toEqual([0]);
        expect(appearances[0]!.lastSeenChapter).toBe(0);
        expect(appearances[0]!.chaptersSinceLastSeen).toBe(2);
    });

    it('filters out entities below the minimum occurrence threshold', () => {
        const chapters = listChaptersInFile('Minor character appears.', 'ch1.md', 'ch1', false);
        const entities = [makeEntity('Minor', 1)]; // below CHARACTER_MIN_OCCURRENCES
        expect(characterAppearances(chapters, entities)).toEqual([]);
    });

    it('sorts by occurrences descending', () => {
        const chapters = listChaptersInFile(
            'Sarah and John were both there. Sarah spoke. Sarah left.',
            'ch1.md',
            'ch1',
            false
        );
        const entities = [makeEntity('John', 3), makeEntity('Sarah', 10)];
        const appearances = characterAppearances(chapters, entities);
        expect(appearances[0]!.name).toBe('Sarah');
        expect(appearances[1]!.name).toBe('John');
    });
});
