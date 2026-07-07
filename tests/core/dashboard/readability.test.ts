import { describe, it, expect } from 'vitest';
import {
    daleChall,
    automatedReadabilityIndex,
    fleschKincaid,
    reweightedFlesch,
    customComposite,
    narrativeFlow
} from '../../../src/core/dashboard/readability';

const SIMPLE = 'The cat sat on the mat. The dog ran fast. It was a good day.';
const COMPLEX =
    'The ostensibly recalcitrant bureaucratic apparatus systematically obfuscated ' +
    'the fundamental implementation of quintessential operational paradigms. ' +
    'Consequently, multifaceted conceptualizations remained perpetually unresolved.';

describe('daleChall', () => {
    it('returns zero-state for empty text', () => {
        expect(daleChall('')).toEqual({ rawScore: 0, gradeLevel: 1 });
        expect(daleChall('   ')).toEqual({ rawScore: 0, gradeLevel: 1 });
    });

    it('returns a higher rawScore for simple text (more familiar words)', () => {
        const simple = daleChall(SIMPLE);
        const complex = daleChall(COMPLEX);
        expect(simple.rawScore).toBeGreaterThan(complex.rawScore);
    });

    it('clamps rawScore to 0-100', () => {
        const result = daleChall(COMPLEX);
        expect(result.rawScore).toBeGreaterThanOrEqual(0);
        expect(result.rawScore).toBeLessThanOrEqual(100);
    });

    it('maps to a lower grade level for simple text', () => {
        const simple = daleChall(SIMPLE);
        expect(simple.gradeLevel).toBeLessThanOrEqual(8);
    });

    it('maps to a higher grade level for complex text', () => {
        const complex = daleChall(COMPLEX);
        expect(complex.gradeLevel).toBeGreaterThanOrEqual(9);
    });
});

describe('automatedReadabilityIndex', () => {
    it('returns 0 for empty text', () => {
        expect(automatedReadabilityIndex('')).toBe(0);
    });

    it('returns a lower score for simple text', () => {
        const simple = automatedReadabilityIndex(SIMPLE);
        const complex = automatedReadabilityIndex(COMPLEX);
        expect(simple).toBeLessThan(complex);
    });

    it('returns a non-negative score', () => {
        expect(automatedReadabilityIndex(SIMPLE)).toBeGreaterThanOrEqual(0);
    });
});

describe('fleschKincaid', () => {
    it('returns zero-state for empty text', () => {
        expect(fleschKincaid('')).toEqual({ readingEase: 0, gradeLevel: 0 });
    });

    it('returns higher reading ease for simple text', () => {
        const simple = fleschKincaid(SIMPLE);
        const complex = fleschKincaid(COMPLEX);
        expect(simple.readingEase).toBeGreaterThan(complex.readingEase);
    });

    it('returns lower grade level for simple text', () => {
        const simple = fleschKincaid(SIMPLE);
        const complex = fleschKincaid(COMPLEX);
        expect(simple.gradeLevel).toBeLessThan(complex.gradeLevel);
    });

    it('clamps grade level to non-negative', () => {
        expect(fleschKincaid(SIMPLE).gradeLevel).toBeGreaterThanOrEqual(0);
    });
});

describe('reweightedFlesch', () => {
    it('returns zero-state for empty text', () => {
        expect(reweightedFlesch('')).toEqual({ readingEase: 0, gradeLevel: 0 });
    });

    it('returns higher reading ease for simple text', () => {
        const simple = reweightedFlesch(SIMPLE);
        const complex = reweightedFlesch(COMPLEX);
        expect(simple.readingEase).toBeGreaterThan(complex.readingEase);
    });
});

describe('customComposite', () => {
    it('returns zero-state for empty text', () => {
        expect(customComposite('', 0, 0)).toEqual({ score: 0, label: 'very complex' });
    });

    it('returns a score in 0-100 range', () => {
        const result = customComposite(SIMPLE, 3, 0.3);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
    });

    it('factors in sentence-length stddev (higher stddev = higher variety bonus)', () => {
        const lowVar = customComposite(SIMPLE, 1, 0.3);
        const highVar = customComposite(SIMPLE, 6, 0.3);
        expect(highVar.score).toBeGreaterThanOrEqual(lowVar.score);
    });

    it('factors in dialogue ratio (closer to 45% = higher bonus)', () => {
        const farFromTarget = customComposite(SIMPLE, 3, 0.0);
        const nearTarget = customComposite(SIMPLE, 3, 0.45);
        expect(nearTarget.score).toBeGreaterThanOrEqual(farFromTarget.score);
    });

    it('labels map to documented tiers', () => {
        const labels = ['very readable', 'readable', 'moderate', 'complex', 'very complex'];
        const result = customComposite(SIMPLE, 3, 0.3);
        expect(labels).toContain(result.label);
    });
});

describe('narrativeFlow', () => {
    it('returns zero-state when sentenceCount is 0', () => {
        expect(narrativeFlow(0, 0, 0, 0, 0)).toEqual({ score: 0, label: 'no data' });
    });

    it('returns a score in 0-100 range', () => {
        const result = narrativeFlow(4, 30, 0.4, 0, 20);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
    });

    it('penalizes high pacing-flag density', () => {
        const clean = narrativeFlow(4, 30, 0.4, 0, 20);
        const flagged = narrativeFlow(4, 30, 0.4, 5, 20);
        expect(clean.score).toBeGreaterThan(flagged.score);
    });

    it('rewards paragraph-length rhythm (higher stddev = better flow)', () => {
        const lowRhythm = narrativeFlow(4, 5, 0.4, 0, 20);
        const highRhythm = narrativeFlow(4, 40, 0.4, 0, 20);
        expect(highRhythm.score).toBeGreaterThanOrEqual(lowRhythm.score);
    });

    it('rewards dialogue near 40%', () => {
        const farTarget = narrativeFlow(4, 30, 0.0, 0, 20);
        const nearTarget = narrativeFlow(4, 30, 0.4, 0, 20);
        expect(nearTarget.score).toBeGreaterThanOrEqual(farTarget.score);
    });

    it('labels map to documented tiers', () => {
        const labels = ['strong flow', 'good flow', 'uneven', 'choppy', 'monotonous'];
        const result = narrativeFlow(4, 30, 0.4, 0, 20);
        expect(labels).toContain(result.label);
    });
});
