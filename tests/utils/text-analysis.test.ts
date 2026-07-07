import { describe, it, expect } from 'vitest';
import {
    buildCodeFence,
    stripFrontmatter,
    posAtOffset,
    isInsideQuotes,
    countSyllables,
    splitSentences,
    splitParagraphs,
    extractScene,
    listSections
} from '../../src/utils/text-analysis';

const ABBREV = /\b(Mr|Mrs|Ms|Dr|etc|vs|Jr|Sr)\.$/i;

describe('buildCodeFence', () => {
    it('returns minimum 3 backticks for empty text', () => {
        expect(buildCodeFence('')).toBe('```');
    });

    it('returns minimum 3 backticks when text has no backticks', () => {
        expect(buildCodeFence('hello world')).toBe('```');
    });

    it('returns minimum 3 backticks for single backticks in text', () => {
        expect(buildCodeFence('code `inline` code')).toBe('```');
    });

    it('returns longest run + 1 when text has 3+ consecutive backticks', () => {
        expect(buildCodeFence('``` triple')).toBe('````');
        expect(buildCodeFence('```` quad')).toBe('`````');
    });

    it('handles long backtick runs', () => {
        expect(buildCodeFence('`````')).toBe('``````');
    });
});

describe('stripFrontmatter', () => {
    it('returns original text when no frontmatter', () => {
        const result = stripFrontmatter('Hello world');
        expect(result.text).toBe('Hello world');
        expect(result.strippedLines).toBe(0);
    });

    it('strips simple frontmatter', () => {
        const doc = '---\ntitle: Test\n---\nBody text';
        const result = stripFrontmatter(doc);
        expect(result.text).toBe('Body text');
        expect(result.strippedLines).toBe(3);
    });

    it('handles CRLF line endings', () => {
        const doc = '---\r\ntitle: Test\r\n---\r\nBody';
        const result = stripFrontmatter(doc);
        expect(result.text).toBe('Body');
        expect(result.strippedLines).toBe(3);
    });

    it('returns original when frontmatter is unclosed', () => {
        const doc = '---\ntitle: Test\nbody without closing';
        const result = stripFrontmatter(doc);
        expect(result.text).toBe(doc);
        expect(result.strippedLines).toBe(0);
    });

    it('handles frontmatter with blank body after', () => {
        const doc = '---\ntitle: Test\n---\n';
        const result = stripFrontmatter(doc);
        expect(result.text).toBe('');
        expect(result.strippedLines).toBe(3);
    });
});

describe('posAtOffset', () => {
    it('returns line 1 for offset in first line', () => {
        const pos = posAtOffset('hello world', 3);
        expect(pos.line).toBe(1);
        expect(pos.column).toBe(3);
    });

    it('returns correct line and column for multi-line text', () => {
        const text = 'line one\nline two\nline three';
        const pos = posAtOffset(text, 12);
        expect(pos.line).toBe(2);
        expect(pos.column).toBe(3);
    });

    it('returns column 0 at start of a line', () => {
        const text = 'first\nsecond';
        const pos = posAtOffset(text, 6);
        expect(pos.line).toBe(2);
        expect(pos.column).toBe(0);
    });
});

describe('isInsideQuotes', () => {
    it('returns false outside quotes', () => {
        expect(isInsideQuotes('hello world', 5)).toBe(false);
    });

    it('returns true inside double quotes', () => {
        expect(isInsideQuotes('say "hello there" now', 12)).toBe(true);
    });

    it('toggles on each double quote', () => {
        expect(isInsideQuotes('a"b"c', 2)).toBe(true);
        expect(isInsideQuotes('a"b"c', 4)).toBe(false);
    });
});

describe('countSyllables', () => {
    it('returns 1 for short words', () => {
        expect(countSyllables('the')).toBe(1);
        expect(countSyllables('a')).toBe(1);
        expect(countSyllables('an')).toBe(1);
    });

    it('counts vowel groups in longer words', () => {
        expect(countSyllables('hello')).toBe(2);
        expect(countSyllables('world')).toBe(1);
        expect(countSyllables('banana')).toBe(3);
    });

    it('reduces by 1 for trailing silent e', () => {
        expect(countSyllables('home')).toBe(1);
        expect(countSyllables('time')).toBe(1);
    });

    it('adjusts for -le ending after consonant', () => {
        expect(countSyllables('table')).toBe(2);
        expect(countSyllables('apple')).toBe(2);
    });

    it('returns at least 1 for words that would compute to 0', () => {
        expect(countSyllables('the')).toBe(1);
    });
});

describe('splitSentences', () => {
    it('splits on period followed by space', () => {
        const sentences = splitSentences('Hello world. Goodbye world.', ABBREV);
        expect(sentences).toHaveLength(2);
        expect(sentences[0]!.text).toBe('Hello world.');
        expect(sentences[1]!.text).toBe('Goodbye world.');
    });

    it('splits on exclamation and question marks', () => {
        const sentences = splitSentences('What? No! Maybe.', ABBREV);
        expect(sentences).toHaveLength(3);
    });

    it('does not split on abbreviations', () => {
        const sentences = splitSentences('Dr. Smith arrived. He left.', ABBREV);
        expect(sentences).toHaveLength(2);
        expect(sentences[0]!.text).toBe('Dr. Smith arrived.');
    });

    it('treats newline as a hard boundary', () => {
        const sentences = splitSentences('Line one\nLine two', ABBREV);
        expect(sentences).toHaveLength(2);
    });

    it('treats doubled punctuation as non-boundary (skips it)', () => {
        // The `..` is not a sentence boundary — the sentence runs to `?`.
        const sentences = splitSentences('Wait.. what?', ABBREV);
        expect(sentences).toHaveLength(1);
        expect(sentences[0]!.text).toBe('Wait.. what?');
    });

    it('handles trailing text without terminal punctuation', () => {
        const sentences = splitSentences('A sentence. Trailing text', ABBREV);
        expect(sentences).toHaveLength(2);
        expect(sentences[1]!.text).toBe('Trailing text');
    });

    it('returns empty array for blank text', () => {
        expect(splitSentences('   ', ABBREV)).toHaveLength(0);
    });

    it('tracks line numbers across newlines', () => {
        const sentences = splitSentences('First.\nSecond.\nThird.', ABBREV);
        expect(sentences[0]!.line).toBe(1);
        expect(sentences[1]!.line).toBe(2);
        expect(sentences[2]!.line).toBe(3);
    });
});

describe('splitParagraphs', () => {
    it('returns empty array for blank text', () => {
        expect(splitParagraphs('')).toEqual([]);
        expect(splitParagraphs('   \n  ')).toEqual([]);
    });

    it('returns single paragraph for no blank lines', () => {
        const result = splitParagraphs('one two three');
        expect(result).toEqual(['one two three']);
    });

    it('splits on blank lines', () => {
        const result = splitParagraphs('para one\n\npara two');
        expect(result).toEqual(['para one', 'para two']);
    });

    it('starts new paragraph at scene-break markers', () => {
        const result = splitParagraphs('before\n***\nafter');
        expect(result).toEqual(['before', 'after']);
    });

    it('starts new paragraph at headings', () => {
        const result = splitParagraphs('intro\n## Chapter\nbody');
        expect(result).toEqual(['intro', 'body']);
    });

    it('preserves multi-line paragraphs', () => {
        const result = splitParagraphs('line one\nline two\n\nnext para');
        expect(result).toEqual(['line one\nline two', 'next para']);
    });
});

describe('extractScene', () => {
    const doc = 'Intro text\n## Chapter One\nScene body here\nMore body\n## Chapter Two\nSecond scene';

    it('extracts the scene containing the cursor', () => {
        const scene = extractScene(doc, doc.indexOf('Scene body'));
        expect(scene.text).toContain('Scene body here');
        expect(scene.text).toContain('More body');
        expect(scene.text).not.toContain('Second scene');
    });

    it('returns start line as 1-based', () => {
        const scene = extractScene(doc, doc.indexOf('Scene body'));
        expect(scene.lineStart).toBeGreaterThanOrEqual(1);
    });

    it('handles cursor at first line', () => {
        const scene = extractScene(doc, 2);
        expect(scene.text).toContain('Intro text');
    });
});

describe('listSections', () => {
    it('returns empty array for blank text', () => {
        expect(listSections('')).toEqual([]);
    });

    it('returns leading section for text without headings', () => {
        const sections = listSections('Just prose\nNo headings');
        expect(sections).toHaveLength(1);
        expect(sections[0]!.kind).toBe('leading');
    });

    it('splits on h3+ headings by default', () => {
        const sections = listSections('Intro\n### Scene One\nBody one\n### Scene Two\nBody two');
        expect(sections).toHaveLength(3);
        expect(sections[0]!.kind).toBe('leading');
        expect(sections[1]!.title).toBe('Scene One');
        expect(sections[2]!.title).toBe('Scene Two');
    });

    it('does not split on h1/h2 by default', () => {
        const sections = listSections('## Chapter\n### Scene\nBody');
        expect(sections).toHaveLength(2);
    });

    it('splits on all headings when splitOnAllHeadings is true', () => {
        const sections = listSections('Intro text\n## Chapter\nBody here', {
            splitOnAllHeadings: true
        });
        expect(sections).toHaveLength(2);
        expect(sections[0]!.kind).toBe('leading');
        expect(sections[1]!.title).toBe('Chapter');
    });

    it('splits on scene-break markers', () => {
        const sections = listSections('Before\n***\nAfter');
        expect(sections).toHaveLength(2);
        expect(sections[1]!.kind).toBe('scene-break');
    });

    it('skips empty sections', () => {
        const sections = listSections('### One\nBody\n### Two\n\n### Three\nEnd');
        expect(sections.filter((s) => s.text.trim() === '')).toHaveLength(0);
    });
});
