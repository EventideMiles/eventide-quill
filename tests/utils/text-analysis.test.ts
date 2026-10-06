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
    listSections,
    escapeRegExp,
    wordListPattern
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

    it('returns true inside typographic double quotes', () => {
        const text = 'say “hello there” now';
        expect(isInsideQuotes(text, 8)).toBe(true);
        expect(isInsideQuotes(text, 19)).toBe(false);
    });

    it('returns true inside typographic single quotes', () => {
        const text = 'say ‘hello there’ now';
        expect(isInsideQuotes(text, 8)).toBe(true);
        expect(isInsideQuotes(text, 19)).toBe(false);
    });

    it('keeps double-quote state through a contraction inside curly dialogue', () => {
        const text = '“I don’t know,” she said';
        // The ’ in "don’t" is an apostrophe (followed by a word char), so it
        // must not close the dialogue; the ” after the comma does.
        expect(isInsideQuotes(text, 9)).toBe(true);
        expect(isInsideQuotes(text, 16)).toBe(false);
    });

    it('treats a contraction apostrophe as neither opener nor closer', () => {
        // ’ followed by a word char: "don’t", "hero’s" — narration state
        // must stay unchanged (outside quotes).
        expect(isInsideQuotes('he said don’t twice', 14)).toBe(false);
        expect(isInsideQuotes('the hero’s cloak', 12)).toBe(false);
    });

    it('closes typographic single quotes on a non-contraction ’', () => {
        const text = '‘stop now’ he said';
        expect(isInsideQuotes(text, 5)).toBe(true);
        expect(isInsideQuotes(text, 10)).toBe(false);
    });

    it('ignores single quotes nested inside double quotes (errs toward exemption)', () => {
        const text = '“He said ‘stop’ and left” afterward';
        // The inner ‘…’ must not close the outer double-quoted dialogue.
        expect(isInsideQuotes(text, 18)).toBe(true);
        expect(isInsideQuotes(text, 29)).toBe(false);
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

describe('escapeRegExp', () => {
    it('escapes every regex metacharacter', () => {
        expect(escapeRegExp('a.b(c)d[e]f{g}h*i+j?k$l^m|n\\o')).toBe(
            'a\\.b\\(c\\)d\\[e\\]f\\{g\\}h\\*i\\+j\\?k\\$l\\^m\\|n\\\\o'
        );
    });

    it('leaves plain phrases unchanged', () => {
        expect(escapeRegExp('hung heavy')).toBe('hung heavy');
    });
});

describe('wordListPattern', () => {
    it('matches a metachar-bearing list entry LITERALLY (the escaping contract)', () => {
        // A hypothetical word-list entry containing `(` must match as text —
        // not be interpreted as a group (which would throw or change meaning).
        const re = wordListPattern(['wait (for it) now', 'plain phrase']);
        expect('she said wait (for it) now and left'.match(re)).toEqual(['wait (for it) now']);
        expect('a plain phrase here'.match(re)).toEqual(['plain phrase']);
    });

    it('builds a case-insensitive edge-bounded alternation by default', () => {
        const re = wordListPattern(['Delve']);
        expect('we delve deeper'.match(re)).toEqual(['delve']);
        expect('delving deeper'.match(re)).toBeNull(); // edge guard: no suffix match
        expect('the antidelve crowd'.match(re)).toBeNull(); // edge guard: no prefix match
    });

    it('matches a punctuation-ending entry before a space and at end-of-text', () => {
        // \b could never fire after a trailing non-word char, which made
        // entries like the wrap-up list's "ultimately," silently unmatchable.
        // The edge-aware boundaries match it like any word-edged entry.
        const re = wordListPattern(['ultimately,']);
        expect('she paused ultimately, and left'.match(re)).toEqual(['ultimately,']);
        expect('it ended ultimately,'.match(re)).toEqual(['ultimately,']);
    });

    it('does not match a punctuation-ending entry when a word character follows', () => {
        const re = wordListPattern(['ultimately,']);
        expect('ultimately,roughly speaking'.match(re)).toBeNull();
    });

    it('keeps every entry matchable regardless of order', () => {
        const re = wordListPattern(['tapestry', 'purple (very) prose']);
        const hits = 'purple (very) prose and tapestry'.match(re);
        expect(hits).toEqual(['purple (very) prose', 'tapestry']);
    });

    it('never matches when the list is empty (empty-list contract)', () => {
        const re = wordListPattern([]);
        expect(re.flags).toBe('gi');
        expect(re.test('')).toBe(false);
        expect(re.test('Wait... she said, "fine!"  --  okay.')).toBe(false);
        expect(re.exec('anything at all')).toBeNull();
    });

    it('never matches when every entry is empty or whitespace-only', () => {
        const re = wordListPattern(['', '   ']);
        expect(re.flags).toBe('gi');
        expect(re.test('')).toBe(false);
        expect(re.test('prose with... punctuation.')).toBe(false);
        expect(re.exec('Wait... she said.')).toBeNull();
    });

    it('ignores empty entries mixed with real ones (no zero-width alternative)', () => {
        const re = wordListPattern(['a', '']);
        expect(re.source).not.toContain('()');
        expect('a bad idea'.match(re)).toEqual(['a']);
        // Every match must consume text — no spurious zero-width hits in the
        // punctuation runs or at the string edges.
        const hits = [...'a cat, a nap... a!'.matchAll(re)];
        expect(hits).toHaveLength(3);
        expect(hits.every((m) => m[0] === 'a')).toBe(true);
    });

    it('preserves non-empty behavior alongside a whitespace-only entry filter', () => {
        const re = wordListPattern(['', '  ', 'ultimately,']);
        expect('it ended ultimately,'.match(re)).toEqual(['ultimately,']);
        expect('ultimately,roughly speaking'.match(re)).toBeNull();
    });

    it('keeps the custom-flags path never-matching for an empty list', () => {
        // The `.source`-extending consumers (rules.ts ABBREVIATIONS /
        // PRECEDING_DIALOGUE_TAG, ai-tell-density SKELETON_ABBREVIATIONS)
        // build with flags '' — the never-matching body must compose safely
        // with their suffixes instead of degenerating.
        const re = wordListPattern([], '');
        expect(re.source).toBe('(?!)');
        expect(new RegExp(re.source + '\\s+$', 'i').test('trailing ws   ')).toBe(false);
    });
});
