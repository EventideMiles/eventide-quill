import { describe, it, expect } from 'vitest';
import {
    parseMemoryFile,
    serializeMemoryFile,
    nextBlockId,
    assignMissingIds,
    buildIndex,
    parseTags,
    MEMORY_BLOCK_ID_PREFIX,
    GLOBAL_MEMORY_SCOPE,
    MEMORY_FILE_SUFFIX,
    type MemoryEntry
} from '../../../src/core/memories/memory-file';

/** Helper: build a memory entry with defaults. */
function entry(opts: Partial<MemoryEntry> & { heading: string }): MemoryEntry {
    return {
        id: opts.id ?? '',
        heading: opts.heading,
        body: opts.body ?? '',
        tags: opts.tags ?? []
    };
}

describe('parseMemoryFile', () => {
    it('parses a canonical file with title, intro, and three entries', () => {
        const content = `# Memories — Manuscript

Reference context the AI has learned.

## Long passages are intentional pacing

Do not flag the slow passage in chapter 4 — the writer confirmed
this is deliberate.

^quill-mem-001

## Third-person limited, past tense

Don't suggest present tense or head-hopping.

^quill-mem-002

## British spelling (#spelling)

Colour, favourite, realise.

^quill-mem-003
`;
        const file = parseMemoryFile(content);
        expect(file.title).toBe('Memories — Manuscript');
        expect(file.intro).toBe('Reference context the AI has learned.');
        expect(file.entries).toHaveLength(3);
        expect(file.entries[0]!.heading).toBe('Long passages are intentional pacing');
        expect(file.entries[0]!.id).toBe('quill-mem-001');
        expect(file.entries[0]!.body).toContain('Do not flag the slow passage');
        expect(file.entries[0]!.body).not.toContain('^quill-mem-001');
        expect(file.entries[1]!.heading).toBe('Third-person limited, past tense');
        expect(file.entries[1]!.id).toBe('quill-mem-002');
        expect(file.entries[2]!.tags).toEqual(['spelling']);
    });

    it('returns empty entries when file has no ## sections', () => {
        const content = `# Memories — Empty

Just a title and intro, no sections yet.`;
        const file = parseMemoryFile(content);
        expect(file.title).toBe('Memories — Empty');
        expect(file.intro).toBe('Just a title and intro, no sections yet.');
        expect(file.entries).toEqual([]);
    });

    it('parses an empty file as no title, no intro, no entries', () => {
        const file = parseMemoryFile('');
        expect(file.title).toBe('');
        expect(file.intro).toBe('');
        expect(file.entries).toEqual([]);
    });

    it('parses sections without block IDs (writer-added)', () => {
        const content = `# Memories

## Untagged memory

Body text without an ID.

## Tagged memory

Another.

^quill-mem-005
`;
        const file = parseMemoryFile(content);
        expect(file.entries).toHaveLength(2);
        expect(file.entries[0]!.id).toBe('');
        expect(file.entries[0]!.heading).toBe('Untagged memory');
        expect(file.entries[1]!.id).toBe('quill-mem-005');
    });

    it('preserves H3-H6 inside a section as part of the body', () => {
        const content = `# Memories

## Memory with subheadings

Body intro.

### Sub-point one

More detail.

#### Sub-sub

Even more.

^quill-mem-001
`;
        const file = parseMemoryFile(content);
        expect(file.entries).toHaveLength(1);
        expect(file.entries[0]!.body).toContain('### Sub-point one');
        expect(file.entries[0]!.body).toContain('#### Sub-sub');
        expect(file.entries[0]!.body).toContain('Body intro.');
    });

    it('does not treat ^ or # inside code fences as IDs or tags', () => {
        const content = `# Memories

## Memory with code fence

Intro text.

\`\`\`
## This is not a heading
^quill-mem-999
#not-a-tag
\`\`\`

Real body line #real-tag.

^quill-mem-001
`;
        const file = parseMemoryFile(content);
        expect(file.entries).toHaveLength(1);
        expect(file.entries[0]!.id).toBe('quill-mem-001');
        expect(file.entries[0]!.body).toContain('## This is not a heading');
        expect(file.entries[0]!.body).toContain('^quill-mem-999');
        expect(file.entries[0]!.body).toContain('#not-a-tag');
        expect(file.entries[0]!.tags).toEqual(['real-tag']);
    });

    it('handles sections with empty body', () => {
        const content = `# Memories

## Empty body memory

^quill-mem-001

## With body

Text.

^quill-mem-002
`;
        const file = parseMemoryFile(content);
        expect(file.entries).toHaveLength(2);
        expect(file.entries[0]!.body).toBe('');
        expect(file.entries[1]!.body).toBe('Text.');
    });

    it('does not treat a # H1 inside the body as a new title', () => {
        const content = `# Real Title

## Section one

Body.

# Not a new title (rare but legal markdown)

More body.

^quill-mem-001
`;
        const file = parseMemoryFile(content);
        expect(file.title).toBe('Real Title');
        expect(file.entries).toHaveLength(1);
        expect(file.entries[0]!.body).toContain('# Not a new title');
    });

    it('captures block IDs at non-final positions (mid-body)', () => {
        const content = `# Memories

## Memory

First line.

^quill-mem-007

Trailing line after the ID.
`;
        const file = parseMemoryFile(content);
        expect(file.entries).toHaveLength(1);
        expect(file.entries[0]!.id).toBe('quill-mem-007');
        expect(file.entries[0]!.body).toContain('First line.');
        expect(file.entries[0]!.body).toContain('Trailing line after the ID.');
    });
});

describe('serializeMemoryFile', () => {
    it('round-trips a parsed file losslessly (entries + title + intro)', () => {
        const original = `# Memories — Test

Intro line.

## First

Body one.

^quill-mem-001

## Second

Body two.

^quill-mem-002
`;
        const parsed = parseMemoryFile(original);
        const serialized = serializeMemoryFile(parsed, 'Test');
        const reparsed = parseMemoryFile(serialized);
        expect(reparsed.title).toBe(parsed.title);
        expect(reparsed.intro).toBe(parsed.intro);
        expect(reparsed.entries).toEqual(parsed.entries);
    });

    it('produces canonical format with default title and intro when missing', () => {
        const file = {
            title: '',
            intro: '',
            entries: [entry({ heading: 'Solo', body: 'Body.', id: 'quill-mem-001' })]
        };
        const out = serializeMemoryFile(file, 'Manuscript');
        expect(out).toContain('# Memories — Manuscript');
        expect(out).toContain('## Solo');
        expect(out).toContain('^quill-mem-001');
        // Default intro is generated
        expect(out).toContain('Edit freely');
    });

    it('omits the ^id line for entries with empty id', () => {
        const file = {
            title: 'T',
            intro: 'I',
            entries: [
                entry({ heading: 'No ID', body: 'Body.', id: '' }),
                entry({ heading: 'With ID', body: 'Body.', id: 'quill-mem-005' })
            ]
        };
        const out = serializeMemoryFile(file);
        expect(out).toContain('## No ID');
        expect(out).toContain('## With ID');
        expect(out).toContain('^quill-mem-005');
        // No ^quill-mem line for the No ID section
        const noIdSection = out.split('## With ID')[0]!;
        expect(noIdSection).not.toContain('^quill-mem-');
    });

    it('normalizes excessive blank lines to a single blank between sections', () => {
        const file = {
            title: 'T',
            intro: 'I',
            entries: [
                entry({ heading: 'A', body: 'Body A.', id: 'quill-mem-001' }),
                entry({ heading: 'B', body: 'Body B.', id: 'quill-mem-002' })
            ]
        };
        const out = serializeMemoryFile(file);
        expect(out).not.toMatch(/\n{3,}/);
    });

    it('always ends with a single trailing newline', () => {
        const file = { title: 'T', intro: 'I', entries: [] };
        const out = serializeMemoryFile(file);
        expect(out.endsWith('\n')).toBe(true);
        expect(out.endsWith('\n\n')).toBe(false);
    });

    it('preserves code fences in section bodies verbatim', () => {
        const body = 'Intro.\n\n```js\nconst x = 1;\n```\n\nOutro.';
        const file = {
            title: 'T',
            intro: 'I',
            entries: [entry({ heading: 'Code', body, id: 'quill-mem-001' })]
        };
        const out = serializeMemoryFile(file);
        expect(out).toContain('```js');
        expect(out).toContain('const x = 1;');
        // Round-trip preserves the fence
        const reparsed = parseMemoryFile(out);
        expect(reparsed.entries[0]!.body).toContain('```js');
        expect(reparsed.entries[0]!.body).toContain('const x = 1;');
    });
});

describe('nextBlockId', () => {
    it('returns quill-mem-001 for an empty list', () => {
        expect(nextBlockId([])).toBe('quill-mem-001');
    });

    it('returns N+1 for entries with sequential IDs', () => {
        const entries = [
            entry({ heading: 'A', id: 'quill-mem-001' }),
            entry({ heading: 'B', id: 'quill-mem-002' }),
            entry({ heading: 'C', id: 'quill-mem-003' })
        ];
        expect(nextBlockId(entries)).toBe('quill-mem-004');
    });

    it('handles gaps in numbering by taking the max', () => {
        const entries = [
            entry({ heading: 'A', id: 'quill-mem-001' }),
            entry({ heading: 'B', id: 'quill-mem-005' }),
            entry({ heading: 'C', id: 'quill-mem-009' })
        ];
        expect(nextBlockId(entries)).toBe('quill-mem-010');
    });

    it('zero-pads to 3 digits up to 999, then 4 digits', () => {
        const entries = [entry({ heading: 'A', id: 'quill-mem-999' })];
        expect(nextBlockId(entries)).toBe('quill-mem-1000');
    });

    it('ignores entries with empty or malformed IDs', () => {
        const entries = [
            entry({ heading: 'A', id: '' }),
            entry({ heading: 'B', id: 'not-an-id' }),
            entry({ heading: 'C', id: 'quill-mem-007' })
        ];
        expect(nextBlockId(entries)).toBe('quill-mem-008');
    });
});

describe('assignMissingIds', () => {
    it('returns changed=false when all entries have IDs', () => {
        const entries = [
            entry({ heading: 'A', id: 'quill-mem-001' }),
            entry({ heading: 'B', id: 'quill-mem-002' })
        ];
        const result = assignMissingIds(entries);
        expect(result.changed).toBe(false);
        expect(result.entries).toBe(entries);
    });

    it('assigns sequential IDs starting from max+1 when some are missing', () => {
        const entries = [
            entry({ heading: 'A', id: 'quill-mem-003' }),
            entry({ heading: 'B', id: '' }),
            entry({ heading: 'C', id: '' }),
            entry({ heading: 'D', id: 'quill-mem-001' })
        ];
        const result = assignMissingIds(entries);
        expect(result.changed).toBe(true);
        expect(result.entries.map((e) => e.id)).toEqual([
            'quill-mem-003',
            'quill-mem-004',
            'quill-mem-005',
            'quill-mem-001'
        ]);
    });

    it('starts from 001 when no entries have IDs', () => {
        const entries = [
            entry({ heading: 'A', id: '' }),
            entry({ heading: 'B', id: '' })
        ];
        const result = assignMissingIds(entries);
        expect(result.changed).toBe(true);
        expect(result.entries.map((e) => e.id)).toEqual(['quill-mem-001', 'quill-mem-002']);
    });

    it('returns changed=false for an empty list', () => {
        const result = assignMissingIds([]);
        expect(result.changed).toBe(false);
        expect(result.entries).toEqual([]);
    });

    it('does not mutate the input entries (returns new array)', () => {
        const original = entry({ heading: 'A', id: '' });
        const result = assignMissingIds([original]);
        expect(result.changed).toBe(true);
        expect(original.id).toBe('');
        expect(result.entries[0]!.id).toBe('quill-mem-001');
    });

    it('preserves body, heading, and tags on assigned entries', () => {
        const entries = [
            entry({ heading: 'Mine', body: 'Important.', tags: ['x', 'y'], id: '' })
        ];
        const result = assignMissingIds(entries);
        expect(result.entries[0]!.heading).toBe('Mine');
        expect(result.entries[0]!.body).toBe('Important.');
        expect(result.entries[0]!.tags).toEqual(['x', 'y']);
        expect(result.entries[0]!.id).toBe('quill-mem-001');
    });
});

describe('buildIndex', () => {
    it('caps the index at the requested size', () => {
        const entries = Array.from({ length: 10 }, (_, i) =>
            entry({ heading: `H${i}`, body: `Body ${i}.`, id: `quill-mem-${String(i + 1).padStart(3, '0')}` })
        );
        const index = buildIndex(entries, 3);
        expect(index).toHaveLength(3);
        expect(index.map((r) => r.heading)).toEqual(['H0', 'H1', 'H2']);
    });

    it('returns all entries when count is under the cap', () => {
        const entries = [
            entry({ heading: 'A', body: 'Body A.', id: 'quill-mem-001' }),
            entry({ heading: 'B', body: 'Body B.', id: 'quill-mem-002' })
        ];
        expect(buildIndex(entries, 20)).toHaveLength(2);
    });

    it('returns an empty list for cap of 0', () => {
        const entries = [entry({ heading: 'A', body: 'Body.', id: 'quill-mem-001' })];
        expect(buildIndex(entries, 0)).toEqual([]);
    });

    it('produces previews capped at 120 chars with ellipsis', () => {
        const longBody = 'A'.repeat(200) + '.';
        const entries = [entry({ heading: 'A', body: longBody, id: 'quill-mem-001' })];
        const index = buildIndex(entries, 5);
        expect(index[0]!.preview.length).toBeLessThanOrEqual(120);
        expect(index[0]!.preview.endsWith('…')).toBe(true);
    });

    it('uses the first sentence when shorter than the cap', () => {
        const body = 'First sentence. Second sentence that should not appear.';
        const entries = [entry({ heading: 'A', body, id: 'quill-mem-001' })];
        const index = buildIndex(entries, 5);
        expect(index[0]!.preview).toBe('First sentence.');
    });

    it('falls back to the first newline-delimited line when no terminal punctuation', () => {
        const body = 'No period in this line\nSecond line is here';
        const entries = [entry({ heading: 'A', body, id: 'quill-mem-001' })];
        const index = buildIndex(entries, 5);
        expect(index[0]!.preview).toBe('No period in this line');
    });

    it('returns empty preview for empty body', () => {
        const entries = [entry({ heading: 'A', body: '', id: 'quill-mem-001' })];
        const index = buildIndex(entries, 5);
        expect(index[0]!.preview).toBe('');
    });

    it('preserves tags from the source entries', () => {
        const entries = [
            entry({ heading: 'A', body: 'Body with #tag1 and #tag2.', tags: ['tag1', 'tag2'], id: 'quill-mem-001' })
        ];
        const index = buildIndex(entries, 5);
        expect(index[0]!.tags).toEqual(['tag1', 'tag2']);
    });
});

describe('parseTags', () => {
    it('extracts simple inline tags', () => {
        expect(parseTags('This is #important and #urgent.')).toEqual(['important', 'urgent']);
    });

    it('extracts tags at start of line', () => {
        expect(parseTags('#alpha\n#beta')).toEqual(['alpha', 'beta']);
    });

    it('allows tags after opening parenthesis', () => {
        expect(parseTags('Memory (see #pacing).')).toEqual(['pacing']);
    });

    it('does not extract hex-like or numeric-prefixed tokens', () => {
        expect(parseTags('Color #FF0000 and #1stplace')).toEqual([]);
    });

    it('does not extract header anchors in markdown links', () => {
        expect(parseTags('See [link](#section) and [other](page.md#anchor).')).toEqual([]);
    });

    it('allows hyphens and underscores in tag names', () => {
        expect(parseTags('Tag #my-tag and #another_tag.')).toEqual(['my-tag', 'another_tag']);
    });

    it('deduplicates repeated tags', () => {
        expect(parseTags('#x and #x again.')).toEqual(['x']);
    });

    it('returns empty for text with no tags', () => {
        expect(parseTags('Just plain text.')).toEqual([]);
    });
});

describe('constants', () => {
    it('exports the expected prefix, suffix, and global scope key', () => {
        expect(MEMORY_BLOCK_ID_PREFIX).toBe('quill-mem-');
        expect(MEMORY_FILE_SUFFIX).toBe('.memories.md');
        expect(GLOBAL_MEMORY_SCOPE).toBe('_global');
    });
});
