import { describe, it, expect } from 'vitest';
import {
    checkLongSentences,
    checkPassiveVoice,
    checkAdverbs,
    checkQualifiers,
    checkRepeatedWords,
    checkEchoes,
    checkComplexWords,
    checkAiCliches,
    checkAiEmDashes,
    checkAiNegation,
    checkAiFillerAdverbs,
    checkAiHedging,
    checkAiWrapUps,
    checkGremlins,
    checkDialogueTags,
    checkTellingVsShowing
} from '../../../src/core/linter/rules';

describe('checkLongSentences', () => {
    it('flags sentences exceeding the word limit', () => {
        const long = 'This is a sentence that goes on and on and on and keeps going well past the default threshold of forty words which is quite long indeed and should absolutely be flagged by the linter as exceeding the configured maximum length.';
        const results = checkLongSentences(long, 40);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('long-sentences');
    });

    it('does not flag short sentences', () => {
        expect(checkLongSentences('Short sentence. Another one.')).toEqual([]);
    });

    it('respects a custom maxWords threshold', () => {
        const text = 'One two three four five six seven eight.';
        expect(checkLongSentences(text, 5)).toHaveLength(1);
        expect(checkLongSentences(text, 10)).toEqual([]);
    });
});

describe('checkPassiveVoice', () => {
    it('flags "was" + past participle', () => {
        const results = checkPassiveVoice('The door was opened by the wind.');
        expect(results).toHaveLength(1);
        expect(results[0]!.rule).toBe('passive-voice');
        expect(results[0]!.message).toContain('was opened');
    });

    it('flags "were" + past participle', () => {
        const results = checkPassiveVoice('The letters were written yesterday.');
        expect(results).toHaveLength(1);
    });

    it('does not flag active voice', () => {
        expect(checkPassiveVoice('The wind opened the door.')).toEqual([]);
    });
});

describe('checkAdverbs', () => {
    it('flags -ly adverbs longer than four characters', () => {
        const results = checkAdverbs('He walked slowly toward the door.');
        expect(results).toHaveLength(1);
        expect(results[0]!.rule).toBe('adverbs');
        expect(results[0]!.message).toContain('slowly');
    });

    it('does not flag short -ly words (<= 4 chars)', () => {
        // "fly", "sly" etc. are <= 3 chars; only words > 4 chars flag
        expect(checkAdverbs('The bird can fly high.')).toEqual([]);
    });

    it('does not flag adverbs inside dialogue quotes', () => {
        const results = checkAdverbs('"He walked slowly," she said.');
        expect(results).toEqual([]);
    });
});

describe('checkQualifiers', () => {
    it('flags common qualifiers', () => {
        const results = checkQualifiers('It was very cold and really dark.');
        expect(results.length).toBeGreaterThanOrEqual(2);
        expect(results.every((r) => r.rule === 'qualifiers')).toBe(true);
    });

    it('does not flag qualifiers inside quotes', () => {
        expect(checkQualifiers('"This is very interesting," he said.')).toEqual([]);
    });
});

describe('checkRepeatedWords', () => {
    it('flags words used 3+ times in one sentence', () => {
        const repeated = 'The monster was terrible and terrible things happened terrible night.';
        const results = checkRepeatedWords(repeated);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('repeated-words');
    });

    it('does not flag words in short sentences', () => {
        expect(checkRepeatedWords('Short text here.')).toEqual([]);
    });

    it('respects the minLength parameter', () => {
        // "dragon" (6 chars, non-skip word) repeated 3× in a 9-word sentence.
        const text = 'The dragon roared and dragon flew and dragon burned.';
        // minLength 5 → "dragon" (6) qualifies → flagged.
        expect(checkRepeatedWords(text, 5).some((r) => r.rule === 'repeated-words')).toBe(true);
        // minLength 7 → "dragon" (6) is below threshold → not flagged.
        expect(checkRepeatedWords(text, 7)).toEqual([]);
    });
});

describe('checkEchoes', () => {
    it('flags 3+ consecutive sentences starting with the same two words', () => {
        // checkEchoes matches the first TWO words; all 3 sentences must share them.
        // Sentences must be in one paragraph (separated by single newlines or spaces).
        const text = 'The cat sat on the mat. The cat sat all day long. The cat sat and waited patiently.';
        const results = checkEchoes(text);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('echoes');
    });

    it('does not flag varied sentence openings', () => {
        const text = 'She ran fast.\n\nThe wind howled.\n\nDarkness fell quickly.';
        expect(checkEchoes(text)).toEqual([]);
    });

    // Regression: column was hardcoded to 1, so the highlight landed on the
    // 2nd character of the paragraph start instead of on the echoed phrase.
    // Reproduces the user report where "He had" (echoing mid-paragraph) was
    // flagged but the highlight + AI-fix target pointed at "As he walked"
    // (the paragraph's opening words).
    it('points the result range at the echoed phrase, not the paragraph start', () => {
        const text =
            'As he walked along the campus something caught his eyes. ' +
            'It was another rabbit, though this one was just a bit shorter than him and more lithe. ' +
            'He had charcoal black fur, as opposed to Owen\'s own tan fur, and striking violet eyes. ' +
            'He had several white accents on his body, including around his muzzle and on what could be seen of his chest. ' +
            'He was holding a stack of papers, and as he saw Owen approaching he seemed to brighten up.';
        const results = checkEchoes(text);
        expect(results.length).toBe(1);
        const r = results[0]!;
        // The flagged span, read out of the line at the reported position,
        // must actually BE the echoed phrase (case-insensitive). Pre-fix this
        // returned "s he w" because column was hardcoded to 1.
        const oneLine = text; // single-line paragraph: result.line === 1
        const flagged = oneLine.slice(r.column, r.column + r.length);
        expect(flagged.toLowerCase()).toBe('he had');
    });

    it('points at the echoed phrase when the paragraph is not the last in the document', () => {
        // Same scenario, but the echoing paragraph is followed by another
        // paragraph — exercises the PARA_BREAK while-loop path rather than
        // the trailing-paragraph path.
        const text =
            'As he walked along the campus something caught his eyes. ' +
            'It was another rabbit, though this one was just a bit shorter than him and more lithe. ' +
            'He had charcoal black fur, as opposed to Owen\'s own tan fur, and striking violet eyes. ' +
            'He had several white accents on his body, including around his muzzle and on what could be seen of his chest. ' +
            'He was holding a stack of papers, and as he saw Owen approaching he seemed to brighten up.\n\n' +
            'Owen waved. The rabbit waved back.';
        const results = checkEchoes(text);
        const echo = results.find((r) => r.rule === 'echoes' && r.message.includes('he had'));
        expect(echo).toBeDefined();
        // The paragraph is on line 1; the echoed phrase starts somewhere in
        // the middle of that line. Verify by reading back from the position.
        const line1 = text.split('\n')[0]!;
        const flagged = line1.slice(echo!.column, echo!.column + echo!.length);
        expect(flagged.toLowerCase()).toBe('he had');
    });
});

describe('checkComplexWords', () => {
    it('flags words with many syllables', () => {
        const results = checkComplexWords('The institutionalization was problematic.', 5);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('complex-words');
    });

    it('does not flag simple words', () => {
        expect(checkComplexWords('The cat sat on the mat.', 5)).toEqual([]);
    });
});

describe('checkAiCliches', () => {
    it('flags known AI cliche words', () => {
        const results = checkAiCliches('The tapestry of life is a complex realm to delve into.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-cliches');
    });

    it('does not flag ordinary prose', () => {
        expect(checkAiCliches('She walked to the store and bought milk.')).toEqual([]);
    });
});

describe('checkAiEmDashes', () => {
    it('flags em dashes', () => {
        const results = checkAiEmDashes('The thing—that object over there—was strange.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-em-dashes');
    });

    it('does not flag regular hyphens', () => {
        expect(checkAiEmDashes('It was a well-known fact.')).toEqual([]);
    });
});

describe('checkAiNegation', () => {
    it('flags "it\'s not X, it\'s Y" constructions', () => {
        const results = checkAiNegation("It's not about the destination, it's about the journey.");
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-negation');
    });

    it('does not flag direct statements', () => {
        expect(checkAiNegation('The cat sat on the mat.')).toEqual([]);
    });
});

describe('checkAiFillerAdverbs', () => {
    it('flags strategy adverbs common in AI prose', () => {
        const results = checkAiFillerAdverbs('She quietly closed the door and deliberately turned away.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-filler-adverbs');
    });
});

describe('checkAiHedging', () => {
    it('flags hedging language', () => {
        const results = checkAiHedging('Perhaps the answer might be somewhere in the middle.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-hedging');
    });
});

describe('checkAiWrapUps', () => {
    it('flags concluding phrases', () => {
        const results = checkAiWrapUps('Ultimately, the hero prevailed. In conclusion, it was a good day.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('ai-wrap-ups');
    });
});

describe('checkGremlins', () => {
    it('flags zero-width spaces', () => {
        const results = checkGremlins('Hello\u200Bworld');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('gremlins');
    });

    it('flags soft hyphens', () => {
        const results = checkGremlins('Hello\u00ADworld');
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('does not flag clean text', () => {
        expect(checkGremlins('Hello world')).toEqual([]);
    });
});

describe('checkDialogueTags', () => {
    it('flags non-"said"/"asked" dialogue tags used more than once', () => {
        const text = '"No," he whispered.\n\n"Stop," she whispered.';
        const results = checkDialogueTags(text);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('dialogue-tags');
    });

    it('does not flag "said"', () => {
        const text = '"Yes," he said.\n\n"No," she said.';
        expect(checkDialogueTags(text)).toEqual([]);
    });
});

describe('checkTellingVsShowing', () => {
    it('flags direct emotion naming', () => {
        const results = checkTellingVsShowing('He was angry about the news.');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]!.rule).toBe('telling-vs-showing');
    });
});
