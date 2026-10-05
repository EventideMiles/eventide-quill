import { describe, it, expect } from 'vitest';
import {
    computeAiTellDensity,
    computeSentenceSkeletonVariety,
    ORDINARY_WORD_WEIGHT
} from '../../../src/core/dashboard/ai-tell-density';
import wordLists from '../../../src/core/linter/word-lists.json';

/** N unique filler words that collide with no tell list. */
function filler(n: number): string {
    return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

describe('computeAiTellDensity — per-1,000-words normalization', () => {
    it('normalizes hits per 1,000 words', () => {
        // 500 words, 1 hit → 2.0 per 1,000.
        const text = `${filler(499)} tapestry`;
        expect(computeAiTellDensity(text).hitsPerKiloWords).toBe(2);
    });

    it('scales linearly with hit count', () => {
        const text = `${filler(96)} delve delve delve delve`;
        expect(computeAiTellDensity(text).hitsPerKiloWords).toBe(40);
    });
});

describe('computeAiTellDensity — category counts', () => {
    it('counts each tell category from its own source list', () => {
        const text =
            'The tapestry gleamed. She moved quietly. Perhaps it was fine. In conclusion, it ended. ' +
            'In that moment, it began. A palpable tension filled the room.';
        const { byCategory } = computeAiTellDensity(text);
        /** Read one category's count (or -1 when missing) from the result. */
        const countFor = (category: string): number => byCategory.find((c) => c.category === category)?.count ?? -1;

        expect(countFor('ai-cliches')).toBe(1);
        expect(countFor('ai-filler-adverbs')).toBe(1);
        expect(countFor('ai-hedging')).toBe(1);
        expect(countFor('ai-wrap-ups')).toBe(1);
        expect(countFor('ai-meta-cues')).toBe(1);
        expect(countFor('purple-constructions')).toBe(1);
    });

    it('never counts commonLongWords (ordinary vocabulary is not a tell source)', () => {
        // All three words are in commonLongWords but in no tell list.
        expect(computeAiTellDensity('She wondered about the different morning.').hitsPerKiloWords).toBe(0);
    });
});

describe('computeAiTellDensity — dialogue exemption', () => {
    it('excludes hits inside double quotes', () => {
        const text = '"The tapestry hung heavy and perhaps quietly," he said.';
        const { hitsPerKiloWords, byCategory } = computeAiTellDensity(text);
        expect(hitsPerKiloWords).toBe(0);
        expect(byCategory.every((c) => c.count === 0)).toBe(true);
    });

    it('still counts hits outside the quotes of the same passage', () => {
        const text = '"Give me a moment," he said, and the silence settled over the room.';
        const { byCategory } = computeAiTellDensity(text);
        expect(byCategory.find((c) => c.category === 'ai-meta-cues')?.count).toBe(1);
    });
});

describe('computeAiTellDensity — echo/loom down-weight', () => {
    it('counts echo hits at fractional weight, not full weight', () => {
        // 4 echo hits in 100 words → weighted 4 * 0.25 = 1 → 10 per 1,000
        // (at full weight this would read 40).
        const text = `${filler(96)} echo echo echo echo`;
        expect(computeAiTellDensity(text).hitsPerKiloWords).toBe(10);
    });

    it('counts loom hits at fractional weight', () => {
        // 2 loom hits in 200 words → weighted 0.5 → 2.5 per 1,000.
        const text = `${filler(198)} loom loom`;
        expect(computeAiTellDensity(text).hitsPerKiloWords).toBe(2.5);
    });

    it('exports the down-weight constant used for both words', () => {
        expect(ORDINARY_WORD_WEIGHT).toBe(0.25);
    });
});

describe('computeAiTellDensity — empty and short text', () => {
    it('returns a 0 rate with no NaN for empty text', () => {
        const result = computeAiTellDensity('');
        expect(result.hitsPerKiloWords).toBe(0);
        expect(Number.isFinite(result.hitsPerKiloWords)).toBe(true);
        expect(result.byCategory.every((c) => c.count === 0)).toBe(true);
    });

    it('returns a 0 rate for whitespace-only text', () => {
        expect(computeAiTellDensity('   \n\t  ').hitsPerKiloWords).toBe(0);
    });

    it('normalizes a single-word text without NaN', () => {
        expect(computeAiTellDensity('tapestry').hitsPerKiloWords).toBe(1000);
    });
});

describe('computeAiTellDensity — single source of truth', () => {
    it('detects a phrase straight from the word-lists.json meta-cue list without code changes', () => {
        const phrase = wordLists.aiMetaCues[0]!;
        const text = `The arch hummed ${phrase} and the light changed.`;
        const { byCategory } = computeAiTellDensity(text);
        expect(byCategory.find((c) => c.category === 'ai-meta-cues')?.count).toBe(1);
    });

    it('derives its cliche category from the same JSON list the linter rule reads', () => {
        const word = wordLists.aiClichePhrases[0]!;
        const text = `He described the ${word} in detail.`;
        const { byCategory } = computeAiTellDensity(text);
        expect(byCategory.find((c) => c.category === 'ai-cliches')?.count).toBe(1);
    });
});

describe('computeSentenceSkeletonVariety', () => {
    it('returns a low ratio when every sentence shares one skeleton', () => {
        // All four sentences are pronoun-opening and short.
        expect(computeSentenceSkeletonVariety('She ran. She fell. She got up. She screamed.')).toBe(0.25);
    });

    it('returns 1 when every sentence has a distinct skeleton', () => {
        const text = 'She ran. The dog barked. Quietly, he listened. Running hard, they escaped. Darkness fell.';
        expect(computeSentenceSkeletonVariety(text)).toBe(1);
    });

    it('returns 0 for empty text', () => {
        expect(computeSentenceSkeletonVariety('')).toBe(0);
    });

    it('stays within 0-1 for ordinary prose', () => {
        const variety = computeSentenceSkeletonVariety(
            'The morning was cold. A bird called from the fence post. He pulled his coat tighter and kept walking.'
        );
        expect(variety).toBeGreaterThan(0);
        expect(variety).toBeLessThanOrEqual(1);
    });
});
