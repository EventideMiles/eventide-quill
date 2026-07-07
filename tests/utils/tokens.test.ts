import { describe, it, expect } from 'vitest';
import { estimateTokens, IMAGE_TOKEN_COST } from '../../src/utils/tokens';

describe('estimateTokens', () => {
    describe('string overload', () => {
        it('estimates via chars-per-4 heuristic with ceiling', () => {
            expect(estimateTokens('')).toBe(0);
            expect(estimateTokens('hello')).toBe(2); // ceil(5/4) = 2
            expect(estimateTokens('hi')).toBe(1); // ceil(2/4) = 1
            expect(estimateTokens('12345678')).toBe(2); // ceil(8/4) = 2
        });

        it('returns 0 for empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });
    });

    describe('messages overload', () => {
        it('sums content tokens across messages', () => {
            const messages = [
                { content: 'hello' }, // 2
                { content: 'world' } // 2
            ];
            expect(estimateTokens(messages)).toBe(4);
        });

        it('adds flat image cost per image', () => {
            const messages = [{ content: 'text', images: ['img1', 'img2'] }];
            const expected = Math.ceil('text'.length / 4) + 2 * IMAGE_TOKEN_COST;
            expect(estimateTokens(messages)).toBe(expected);
        });

        it('handles messages without images', () => {
            const messages = [{ content: 'hello' }, { content: 'world', images: [] }];
            expect(estimateTokens(messages)).toBe(4);
        });

        it('handles empty array', () => {
            expect(estimateTokens([])).toBe(0);
        });
    });

    describe('IMAGE_TOKEN_COST', () => {
        it('is 512', () => {
            expect(IMAGE_TOKEN_COST).toBe(512);
        });
    });
});
