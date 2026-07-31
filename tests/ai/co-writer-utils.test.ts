import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ai/provider';
import {
    buildVaultContext,
    mergeContextPaths,
    parseStoppingPoint,
    respectsStoppingPoint,
    sanitizeProse,
    stubDanglingToolCalls,
    summarizeToolArgs,
    truncateToStoppingPoint
} from '../../src/ai/co-writer-utils';

describe('co-writer-utils — sanitizeProse', () => {
    it('replaces em dashes with a comma-space but preserves [[wikilinks]]', () => {
        expect(sanitizeProse('Hello — world')).to.equal('Hello, world');
        expect(sanitizeProse('a—b—c')).to.equal('a, b, c');
        expect(sanitizeProse('See [[Thornwood Academy]] for details.')).to.equal('See [[Thornwood Academy]] for details.');
        expect(sanitizeProse('Link —[[page]]— done')).to.equal('Link, [[page]], done');
    });
    it('returns input unchanged when there are no em dashes or wikilinks', () => {
        expect(sanitizeProse('Plain prose. Nothing fancy.')).to.equal('Plain prose. Nothing fancy.');
    });
});

describe('co-writer-utils — summarizeToolArgs', () => {
    it('summarizes by the most relevant field per tool', () => {
        expect(summarizeToolArgs('fandom_lookup', JSON.stringify({ wiki: 'starwars', query: 'Luke' }))).to.equal(
            'starwars: Luke'
        );
        expect(summarizeToolArgs('fandom_page', JSON.stringify({ wiki: 'starwars', title: 'Skywalker' }))).to.equal(
            'starwars: Skywalker'
        );
        expect(summarizeToolArgs('wikipedia_lookup', JSON.stringify({ query: 'photography' }))).to.equal('photography');
        expect(summarizeToolArgs('fetch_url', JSON.stringify({ url: 'https://example.com' }))).to.equal(
            'https://example.com'
        );
        expect(summarizeToolArgs('vault_lookup', JSON.stringify({ name: 'Sarah Connor' }))).to.equal('Sarah Connor');
    });
    it('truncates long summaries to 57 chars + ellipsis', () => {
        const long = 'x'.repeat(80);
        expect(summarizeToolArgs('fetch_url', JSON.stringify({ url: long }))).to.equal(`${'x'.repeat(57)}...`);
    });
    it('returns empty string for invalid JSON or empty args', () => {
        expect(summarizeToolArgs('x', '{not json')).to.equal('');
        expect(summarizeToolArgs('x', '{}')).to.equal('');
    });
});

describe('co-writer-utils — parseStoppingPoint', () => {
    it.each([
        ['stop at next period', { instruction: 'Stop at the next period.', isExplicit: true }],
        ['stop at next sentence', { instruction: 'Stop at the next sentence.', isExplicit: true }],
        ['stop at the door', { instruction: 'Stop exactly at: the door', isExplicit: true }],
        ['stop after 3 paragraphs', { instruction: 'Write exactly 3 paragraph(s), then stop.', isExplicit: true }],
        ['continue until the dawn', { instruction: 'Continue writing until: the dawn', isExplicit: true }]
    ])('parses %s', (direction, expected) => {
        expect(parseStoppingPoint(direction)).to.deep.equal(expected);
    });
    it('returns null when no stopping instruction is present', () => {
        expect(parseStoppingPoint('write a tense chase scene')).to.equal(null);
        expect(parseStoppingPoint('')).to.equal(null);
    });
});

describe('co-writer-utils — truncateToStoppingPoint', () => {
    it('cuts at the first period for a period stop', () => {
        expect(truncateToStoppingPoint('One. Two. Three.', 'Stop at the next period.')).to.equal('One.');
    });
    it('keeps only the requested number of paragraphs', () => {
        expect(truncateToStoppingPoint('P1\n\nP2\n\nP3', 'Write exactly 2 paragraph(s), then stop.')).to.equal(
            'P1\n\nP2'
        );
    });
    it('returns content unchanged when there is no matching instruction', () => {
        expect(truncateToStoppingPoint('Some text.', 'Not a recognized instruction')).to.equal('Some text.');
    });
});

describe('co-writer-utils — respectsStoppingPoint', () => {
    it('matches the Write-exactly instruction produced by parseStoppingPoint (case-insensitive)', () => {
        const instruction = parseStoppingPoint('stop after 2 paragraphs')!.instruction;
        expect(respectsStoppingPoint('P1\n\nP2', instruction)).to.equal(true);
        expect(respectsStoppingPoint('P1\n\nP2\n\nP3', instruction)).to.equal(false);
    });
    it('caps a period stop at one period', () => {
        expect(respectsStoppingPoint('Only one.', 'Stop at the next period.')).to.equal(true);
        expect(respectsStoppingPoint('One. Two.', 'Stop at the next period.')).to.equal(false);
    });
    it('defaults to true for an unrecognized instruction', () => {
        expect(respectsStoppingPoint('anything', 'Not recognized')).to.equal(true);
    });
});

describe('co-writer-utils — buildVaultContext', () => {
    it('formats items with excerpts as `--- path ---` blocks joined by blank lines', () => {
        expect(
            buildVaultContext([
                { filePath: 'notes/a.md', excerpt: 'alpha' },
                { filePath: 'notes/b.md', excerpt: 'beta' }
            ])
        ).to.equal('--- notes/a.md ---\n\nalpha\n\n--- notes/b.md ---\n\nbeta');
    });
    it('skips items without an excerpt', () => {
        expect(buildVaultContext([{ filePath: 'empty.md' }, { filePath: 'has.md', excerpt: 'x' }])).to.equal(
            '--- has.md ---\n\nx'
        );
    });
    it('returns an empty string for no items', () => {
        expect(buildVaultContext([])).to.equal('');
    });
});

describe('co-writer-utils — mergeContextPaths', () => {
    it('appends mention paths that are not already present, preserving order', () => {
        expect(mergeContextPaths(['a', 'b'], ['b', 'c'])).to.deep.equal(['a', 'b', 'c']);
    });
    it('returns the persistent list unchanged when there are no mentions', () => {
        expect(mergeContextPaths(['a', 'b'])).to.deep.equal(['a', 'b']);
        expect(mergeContextPaths(['a', 'b'], [])).to.deep.equal(['a', 'b']);
    });
});

describe('co-writer-utils — stubDanglingToolCalls', () => {
    const msg = (m: Partial<ChatMessage>): ChatMessage => m as ChatMessage;

    it('appends a synthetic tool result for each dangling tool call', () => {
        const last = msg({
            role: 'assistant',
            quillAnchorId: 7,
            toolCalls: [
                { id: 'call_1', name: 'vault_lookup', arguments: '{}' },
                { id: 'call_2', name: 'grep_notes', arguments: '{}' }
            ]
        });
        const out = stubDanglingToolCalls([msg({ role: 'user', content: 'hi' }), last]);
        expect(out).to.have.lengthOf(4);
        expect(out[2]).to.include({ role: 'tool', toolCallId: 'call_1', name: 'vault_lookup', quillAnchorId: 7 });
        expect(out[3]).to.include({ role: 'tool', toolCallId: 'call_2', name: 'grep_notes', quillAnchorId: 7 });
    });

    it('leaves well-formed tails unchanged', () => {
        const user = [msg({ role: 'user', content: 'hi' })];
        expect(stubDanglingToolCalls(user)).to.equal(user);
        const assistantNoCalls = [msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'ok' })];
        expect(stubDanglingToolCalls(assistantNoCalls)).to.equal(assistantNoCalls);
    });
});
