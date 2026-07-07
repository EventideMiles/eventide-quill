import { describe, it, expect } from 'vitest';
import { FIXES } from '../../../src/core/linter/fixes';
import { FIXABLE_RULES } from '../../../src/core/linter/types';

describe('FIXES', () => {
    it('has a fix for every rule in FIXABLE_RULES', () => {
        for (const rule of FIXABLE_RULES) {
            expect(FIXES[rule]).toBeDefined();
        }
    });

    it('every fix has a description and an apply function', () => {
        for (const [, fix] of Object.entries(FIXES)) {
            expect(typeof fix.description).toBe('string');
            expect(fix.description.length).toBeGreaterThan(0);
            expect(typeof fix.apply).toBe('function');
        }
    });

    it('qualifiers fix removes the word (returns empty string)', () => {
        expect(FIXES.qualifiers!.apply('very', 1, 0, 4)).toBe('');
    });

    it('adverbs fix removes the word (returns empty string)', () => {
        expect(FIXES.adverbs!.apply('quickly', 1, 0, 7)).toBe('');
    });

    it('ai-em-dashes fix replaces with a period', () => {
        expect(FIXES['ai-em-dashes']!.apply('—', 1, 0, 1)).toBe('.');
    });

    it('gremlins fix removes the character (returns empty string)', () => {
        expect(FIXES.gremlins!.apply('\u200B', 1, 0, 1)).toBe('');
    });

    it('every fix key corresponds to a FIXABLE_RULES entry', () => {
        for (const key of Object.keys(FIXES)) {
            expect(FIXABLE_RULES.has(key)).toBe(true);
        }
    });
});
