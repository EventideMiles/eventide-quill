import { describe, it, expect } from 'vitest';
import { contextLengthMismatchNotice, formatContextLength } from '../../src/ai/model-context';

/** Minimal provider slice — the builder only reads maxContextTokens. */
function providerWith(maxContextTokens: number): { maxContextTokens: number } {
    return { maxContextTokens };
}

describe('formatContextLength', () => {
    it('groups thousands with commas', () => {
        expect(formatContextLength(131072)).toBe('131,072');
    });

    it('leaves small counts ungrouped', () => {
        expect(formatContextLength(512)).toBe('512');
    });
});

describe('contextLengthMismatchNotice', () => {
    it('warns when the provider window exceeds the reported context, naming both numbers and both fixes', () => {
        const msg = contextLengthMismatchNotice(providerWith(65536), 32768);

        expect(msg).not.toBeNull();
        expect(msg).toContain('32,768');
        expect(msg).toContain('65,536');
        expect(msg).toContain('provider card');
        expect(msg).toContain('-c in llama.cpp/LM Studio');
    });

    it('returns null when the windows are equal', () => {
        expect(contextLengthMismatchNotice(providerWith(32768), 32768)).toBeNull();
    });

    it('returns null when the provider window is under the reported context (compacts early, but safe)', () => {
        expect(contextLengthMismatchNotice(providerWith(32768), 131072)).toBeNull();
    });

    it('returns null when the model reports no context length', () => {
        expect(contextLengthMismatchNotice(providerWith(65536), undefined)).toBeNull();
    });
});
