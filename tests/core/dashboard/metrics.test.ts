import { describe, it, expect } from 'vitest';
import { countWords, countSentences } from '../../../src/core/dashboard/metrics';

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
