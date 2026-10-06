import { describe, it, expect } from 'vitest';
import {
    computeAiTellDensity,
    computeSentenceSkeletonVariety,
    ORDINARY_WORD_WEIGHT,
    SKELETON_SPACE_SIZE
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

    it('excludes hits inside typographic (curly) double quotes', () => {
        const text = '“The tapestry hung heavy and perhaps quietly,” he said.';
        const { hitsPerKiloWords, byCategory } = computeAiTellDensity(text);
        expect(hitsPerKiloWords).toBe(0);
        expect(byCategory.every((c) => c.count === 0)).toBe(true);
    });

    it('excludes hits inside typographic (curly) single quotes', () => {
        const text = '‘The tapestry hung heavy and perhaps quietly,’ she said.';
        const { hitsPerKiloWords, byCategory } = computeAiTellDensity(text);
        expect(hitsPerKiloWords).toBe(0);
        expect(byCategory.every((c) => c.count === 0)).toBe(true);
    });

    it('still counts hits outside the quotes of the same passage', () => {
        const text = '"Give me a moment," he said, and the silence settled over the room.';
        const { byCategory } = computeAiTellDensity(text);
        expect(byCategory.find((c) => c.category === 'ai-meta-cues')?.count).toBe(1);
    });

    it('counts narration hits after typographic dialogue closes', () => {
        const text = '“Give me a moment,” he said, and the silence settled over the room.';
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
    it('returns 0 when every sentence shares one skeleton', () => {
        // All four sentences are pronoun-opening and short: one skeleton used
        // out of the whole observable space carries no variety information.
        expect(computeSentenceSkeletonVariety('She ran. She fell. She got up. She screamed.')).toBe(0);
    });

    it('returns 1 when every sentence has a distinct skeleton', () => {
        const text = 'She ran. The dog barked. Quietly, he listened. Running hard, they escaped. Darkness fell.';
        expect(computeSentenceSkeletonVariety(text)).toBe(1);
    });

    it('returns 0 for empty text', () => {
        expect(computeSentenceSkeletonVariety('')).toBe(0);
    });

    it('returns 0 for a single sentence (no variety signal, no log(1) base)', () => {
        expect(computeSentenceSkeletonVariety('She ran fast and far.')).toBe(0);
    });

    it('stays within 0-1 for ordinary prose', () => {
        const variety = computeSentenceSkeletonVariety(
            'The morning was cold. A bird called from the fence post. He pulled his coat tighter and kept walking.'
        );
        expect(variety).toBeGreaterThan(0);
        expect(variety).toBeLessThanOrEqual(1);
    });
});

describe('computeSentenceSkeletonVariety — normalized entropy semantics', () => {
    /** One opener word per skeleton first-word class. */
    const CLASS_OPENERS: Record<string, string> = {
        pronoun: 'She',
        determiner: 'The',
        'ly-adverb': 'Quietly,',
        'verb-participle': 'Running,',
        other: 'Water'
    };
    const CLASSES = Object.keys(CLASS_OPENERS);
    const BUCKETS = ['short', 'medium', 'long'] as const;

    /** Build one sentence with the given opener class and length bucket. */
    function skeletonSentence(firstClass: string, bucket: (typeof BUCKETS)[number]): string {
        const targetWords = bucket === 'short' ? 4 : bucket === 'medium' ? 12 : 30;
        const words = [CLASS_OPENERS[firstClass]!];
        for (let i = 1; i < targetWords; i++) words.push(`w${firstClass}${bucket}n${i}`);
        return `${words.join(' ')}.`;
    }

    /** Every (class, bucket) combination exactly once — one sentence per skeleton key. */
    function allSkeletonsOnce(): string[] {
        const sentences: string[] = [];
        for (const cls of CLASSES) {
            for (const bucket of BUCKETS) sentences.push(skeletonSentence(cls, bucket));
        }
        return sentences;
    }

    it('pins SKELETON_SPACE_SIZE to the enumerated 5 opener classes × 3 length buckets', () => {
        expect(SKELETON_SPACE_SIZE).toBe(15);
    });

    it('treats every class × bucket combination as a distinct skeleton (max key count)', () => {
        // One sentence per combination: all SKELETON_SPACE_SIZE keys present
        // and uniform. If any two combinations collided into one key, the
        // entropy would fall strictly below 1.
        expect(computeSentenceSkeletonVariety(allSkeletonsOnce().join(' '))).toBe(1);
    });

    it('is length-independent: identical distributions at 15 vs 200 sentences score ≈ equal', () => {
        const base = allSkeletonsOnce();
        const shortChapter = base.join(' ');
        // 13 full cycles (195 sentences) + the first 5 again = 200 sentences;
        // every key hit 13 times, five keys 14 — near-uniform sampling.
        const longChapter = Array.from({ length: 13 }, () => base)
            .flat()
            .concat(base.slice(0, 5))
            .join(' ');

        const shortScore = computeSentenceSkeletonVariety(shortChapter);
        const longScore = computeSentenceSkeletonVariety(longChapter);
        expect(Math.abs(longScore - shortScore)).toBeLessThanOrEqual(0.02);
        expect(shortScore).toBeGreaterThan(0.95);
        expect(longScore).toBeGreaterThan(0.95);
    });

    it('scores ≈ 1.0 for a long chapter uniform over all skeletons', () => {
        const base = allSkeletonsOnce();
        const text = Array.from({ length: 13 }, () => base)
            .flat()
            .concat(base.slice(0, 5))
            .join(' ');
        expect(computeSentenceSkeletonVariety(text)).toBeGreaterThanOrEqual(0.98);
    });

    it('scores well below 1.0 for a long chapter hammering two skeletons', () => {
        // 200 sentences alternating two keys: H = log 2, K = 15 → ≈ 0.26.
        const text = Array.from({ length: 100 }, () => 'She ran fast. Water pooled.').join(' ');
        expect(computeSentenceSkeletonVariety(text)).toBeLessThan(0.5);
    });

    it('no longer caps long chapters: a 200-sentence high-variety chapter outscores low-variety ones at any length', () => {
        const base = allSkeletonsOnce();
        const longHighVariety = Array.from({ length: 13 }, () => base)
            .flat()
            .concat(base.slice(0, 5))
            .join(' ');
        const longLowVariety = Array.from({ length: 100 }, () => 'She ran fast. Water pooled.').join(' ');
        // The old ratio inverted exactly this comparison: its ceiling
        // min(15, N)/N made the LONG high-variety chapter (0.075) score below
        // the SHORT low-variety chapter (2/10 = 0.2).
        const shortLowVariety = Array.from({ length: 5 }, () => 'She ran fast. Water pooled.').join(' ');

        const high = computeSentenceSkeletonVariety(longHighVariety);
        expect(high).toBeGreaterThan(computeSentenceSkeletonVariety(longLowVariety));
        expect(high).toBeGreaterThan(computeSentenceSkeletonVariety(shortLowVariety));
    });
});
