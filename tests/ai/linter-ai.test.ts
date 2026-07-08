import { describe, it, expect } from 'vitest';
import { extractReplacement, sanitizeReplacement, suggestLintFix } from '../../src/ai/linter-ai';
import type { AiProvider, ChatChunk, ChatOptions, ProviderConfig } from '../../src/ai/provider';
import type { LintResult } from '../../src/core/linter/types';

/** Build a LintResult with only the fields extractReplacement cares about. */
function result(line: number, column: number, length: number): LintResult {
    return { line, column, length, message: '', severity: 'warning', rule: 'qualifiers' };
}

/**
 * Minimal AiProvider stub that yields a single canned response chunk, so the
 * full suggestLintFix flow (prompt building, trimming, DELETE/NO_FIX_NEEDED
 * handling, extractReplacement) runs against a deterministic "model".
 */
function stubProvider(response: string): AiProvider {
    const config: ProviderConfig = {
        id: 'stub',
        name: 'Stub',
        type: 'openai-compatible',
        endpoint: '',
        apiKey: '',
        models: [{ id: 'm', role: 'chat', model: 'm' }],
        maxContextTokens: 32768,
        maxOutputTokens: 4096
    };
    return {
        id: 'stub',
        name: 'Stub',
        config,
        async *chatCompletion(_options: ChatOptions): AsyncGenerator<ChatChunk> {
            yield { text: response, done: true };
        },
        async embed() {
            return { embeddings: [], model: 'm' };
        },
        async listModels() {
            return [];
        },
        async testConnection() {
            return { ok: true };
        },
        async testEmbeddings() {
            return { ok: true };
        }
    };
}

describe('extractReplacement', () => {
    // line / column / length / model response -> expected replacement
    const cases: Array<{ name: string; line: string; column: number; length: number; response: string; expected: string }> = [
        {
            name: 'returns a short fragment verbatim',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: 'extremely',
            expected: 'extremely'
        },
        {
            name: 'DELETE sentinel -> empty',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: 'DELETE',
            expected: ''
        },
        {
            name: 'empty response -> empty',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: '',
            expected: ''
        },
        {
            name: 'BUG: full line with flagged word removed + space collapsed (flagged at line start)',
            line: 'really non-existent problem',
            column: 0,
            length: 6,
            response: 'non-existent problem',
            expected: ''
        },
        {
            name: 'BUG: full line with flagged word removed + space collapsed (mid-line, long tail)',
            line: 'She was very tired and went to bed early because she had a long day.',
            column: 8,
            length: 4,
            response: 'She was tired and went to bed early because she had a long day.',
            expected: ''
        },
        {
            name: 'full line with flagged word removed, leftover double space preserved',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: 'She was  tired.',
            expected: ''
        },
        {
            name: 'flagged at line end (afterFlagged empty) -> removed word',
            line: 'He walked slowly',
            column: 10,
            length: 7,
            response: 'He walked',
            expected: ''
        },
        {
            name: 'long afterFlagged (>20 chars) defeating the old fixed cap',
            line: 'She was very tired and went to bed early because she had a long day.',
            column: 8,
            length: 4,
            response: 'She was tired and went to bed early because she had a long day.',
            expected: ''
        },
        {
            name: 'fragment + trailing context echo (suffix stripped)',
            line: 'She was very tired and went home.',
            column: 8,
            length: 4,
            response: 'extremely tired and went home.',
            expected: 'extremely'
        },
        {
            name: 'full line verbatim (no change) -> flagged text echoed back',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: 'She was very tired.',
            expected: 'very'
        },
        {
            name: 'full line with synonym (prefix+suffix match extracts the middle)',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: 'She was extremely tired.',
            expected: 'extremely'
        },
        {
            name: 'exact user repro: really non-existent -> no duplication',
            line: 'really non-existent problem here',
            column: 0,
            length: 6,
            response: 'non-existent problem here',
            expected: ''
        },
        {
            name: 'strips surrounding quotes the model added around a fragment',
            line: 'She was very tired.',
            column: 8,
            length: 4,
            response: '"extremely"',
            expected: 'extremely'
        }
    ];

    for (const c of cases) {
        it(c.name, () => {
            const got = extractReplacement(c.response, c.line, result(1, c.column, c.length));
            // Trim to normalize boundary whitespace the apply-fix cleanup layer collapses.
            expect(got.trim()).toBe(c.expected);
        });
    }
});

describe('sanitizeReplacement', () => {
    it('passes a clean fragment through untouched', () => {
        expect(sanitizeReplacement('extremely', 'She was ', ' tired.')).toBe('extremely');
    });

    it('strips a leading echo of the preceding context', () => {
        // Model echoed "was" (tail of "She was") before the real fragment.
        const out = sanitizeReplacement('was extremely', 'She was ', ' tired.');
        expect(out.trim()).toBe('extremely');
    });

    it('strips a trailing echo of the following context, keeping the real fragment', () => {
        const out = sanitizeReplacement('extremely tired', 'She was ', ' tired and went home.');
        expect(out.trim()).toBe('extremely');
    });

    it('returns empty when the entire replacement is a prefix of the following context', () => {
        // Model returned forward context verbatim (no real fragment).
        expect(sanitizeReplacement('tired and went home', 'She was ', ' tired and went home.')).toBe('');
    });

    it('passes a fragment through when there is no context overlap', () => {
        expect(sanitizeReplacement('happy', 'She felt ', ' today.')).toBe('happy');
    });

    it('strips a whole-word trailing echo (would otherwise duplicate when spliced)', () => {
        // 'a dog' + ' dog today' would duplicate 'dog' — strip the echo.
        const out = sanitizeReplacement('a dog', 'I saw ', ' dog today');
        expect(out.trim()).toBe('a');
    });
});

describe('suggestLintFix (integration via stub provider)', () => {
    const editorText = 'She was very tired and went home.\n';
    const base = result(1, 8, 4); // "very"

    it('returns null when the model says NO_FIX_NEEDED', async () => {
        const out = await suggestLintFix(base, editorText, stubProvider('NO_FIX_NEEDED'), {
            temperature: 0,
            maxTokens: 50
        });
        expect(out).toBeNull();
    });

    it('returns empty string when the model says DELETE', async () => {
        const out = await suggestLintFix(base, editorText, stubProvider('DELETE'), {
            temperature: 0,
            maxTokens: 50
        });
        expect(out).toBe('');
    });

    it('extracts a fragment replacement through the full flow', async () => {
        const out = await suggestLintFix(base, editorText, stubProvider('extremely'), {
            temperature: 0,
            maxTokens: 50
        });
        expect(out).toBe('extremely');
    });

    it('treats a full-line word-removal response as deletion (the duplication bug)', async () => {
        const out = await suggestLintFix(base, editorText, stubProvider('She was tired and went home.'), {
            temperature: 0,
            maxTokens: 50
        });
        expect(out).toBe('');
    });
});
