import { describe, it, expect, vi } from 'vitest';

// Wrap checkAdverbs in a vi.fn so the error-handling test can make it throw
// once, then revert. By default it delegates to the real implementation, so
// all other tests behave identically.
vi.mock('../../../src/core/linter/rules', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/core/linter/rules')>();
    return { ...actual, checkAdverbs: vi.fn(actual.checkAdverbs) };
});

import { lint } from '../../../src/core/linter/linter';
import { checkAdverbs } from '../../../src/core/linter/rules';

describe('lint orchestrator', () => {
    it('returns empty array for clean text', () => {
        expect(lint('The cat sat on the mat.')).toEqual([]);
    });

    it('returns results sorted by line then column', () => {
        const text = 'Very qualifier.\nSlowly adverb.';
        const results = lint(text);
        for (let i = 1; i < results.length; i++) {
            const prev = results[i - 1]!;
            const cur = results[i]!;
            expect(prev.line < cur.line || (prev.line === cur.line && prev.column <= cur.column)).toBe(true);
        }
    });

    it('runs adverb check by default', () => {
        const results = lint('He walked slowly to the door.');
        expect(results.some((r) => r.rule === 'adverbs')).toBe(true);
    });

    it('runs qualifier check by default', () => {
        const results = lint('It was very dark outside.');
        expect(results.some((r) => r.rule === 'qualifiers')).toBe(true);
    });

    it('does NOT run passive-voice check by default', () => {
        const results = lint('The door was opened by the wind.');
        expect(results.some((r) => r.rule === 'passive-voice')).toBe(false);
    });

    it('runs passive-voice check when explicitly enabled', () => {
        const results = lint('The door was opened by the wind.', {
            enablePassiveVoice: true
        });
        expect(results.some((r) => r.rule === 'passive-voice')).toBe(true);
    });

    it('respects enableX toggle to disable a rule', () => {
        const results = lint('It was very dark.', { enableQualifierCheck: false });
        expect(results.some((r) => r.rule === 'qualifiers')).toBe(false);
    });

    it('respects maxSentenceWords override', () => {
        const text = 'One two three four five six seven eight nine ten.';
        expect(lint(text, { maxSentenceWords: 5 }).some((r) => r.rule === 'long-sentences')).toBe(true);
        expect(lint(text, { maxSentenceWords: 20 }).some((r) => r.rule === 'long-sentences')).toBe(false);
    });

    it('passes maxSyllablesPerWord to the complex-words rule', () => {
        const text = 'The institutionalization was problematic.';
        expect(lint(text, { maxSyllablesPerWord: 3 }).some((r) => r.rule === 'complex-words')).toBe(true);
    });

    it('passes enableAggressiveGremlins to the gremlins rule', () => {
        // Just verify it doesn't throw with the flag set
        const results = lint('clean text', { enableAggressiveGremlins: true });
        expect(Array.isArray(results)).toBe(true);
    });

    it('catches and logs errors from individual rules without crashing', () => {
        vi.mocked(checkAdverbs).mockImplementationOnce(() => {
            throw new Error('rule exploded');
        });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // "slowly" triggers adverbs (which throws) and "very" triggers qualifiers.
        const results = lint('He walked slowly and very quickly.');

        // The throwing rule was caught and logged.
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('adverbs'), expect.anything());
        // Remaining rules still produced results.
        expect(results.some((r) => r.rule === 'qualifiers')).toBe(true);
        // The throwing rule contributed no results.
        expect(results.some((r) => r.rule === 'adverbs')).toBe(false);

        consoleSpy.mockRestore();
    });

    it('combines results from all enabled rules', () => {
        const text = 'He was angry and walked slowly.';
        const results = lint(text);
        const rules = new Set(results.map((r) => r.rule));
        expect(rules.has('telling-vs-showing')).toBe(true);
        expect(rules.has('adverbs')).toBe(true);
    });
});
