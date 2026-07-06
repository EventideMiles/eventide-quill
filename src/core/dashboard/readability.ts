import daleChallWords from './dale-chall-words.json';
import { countSyllables, splitSentences } from '../../utils/text-analysis';

const ABBREVIATIONS_PATTERN = new RegExp('\\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Rev|Prof|Gen|Capt|Maj)\\.$', 'i');

const DALE_CHALL_SET = new Set(daleChallWords);

const PUNCTUATION_TRIM = /^[^a-zA-Z]+|[^a-zA-Z]+$/g;

function stripPunctuation(word: string): string {
    return word.replace(PUNCTUATION_TRIM, '');
}

function isFamiliarWord(word: string): boolean {
    const cleaned = stripPunctuation(word);
    if (!cleaned) return true;
    const lower = cleaned.toLowerCase();

    if (DALE_CHALL_SET.has(lower)) return true;

    return checkMorphologicalVariants(lower);
}

function checkMorphologicalVariants(w: string): boolean {
    const candidates: string[] = [];

    if (w.endsWith('ies') && w.length > 4) {
        candidates.push(w.slice(0, -3) + 'y');
    }

    if (w.endsWith('ves') && w.length > 4) {
        candidates.push(w.slice(0, -3) + 'f');
        candidates.push(w.slice(0, -3) + 'fe');
    }

    if (w.endsWith('es') && w.length > 4 && !w.endsWith('sses')) {
        candidates.push(w.slice(0, -2));
        candidates.push(w.slice(0, -1));
    }

    if (w.endsWith('ed') && w.length > 4 && !w.endsWith('eed')) {
        candidates.push(w.slice(0, -2));
        candidates.push(w.slice(0, -1));
    }

    if (w.endsWith('ing') && w.length > 5) {
        candidates.push(w.slice(0, -3));
        const base = w.slice(0, -3);
        if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
            candidates.push(base.slice(0, -1));
        }
    }

    if (w.endsWith('ly') && w.length > 4) {
        candidates.push(w.slice(0, -2));
    }

    if (w.endsWith('er') && w.length > 4) {
        candidates.push(w.slice(0, -2));
        candidates.push(w.slice(0, -1));
    }

    if (w.endsWith('est') && w.length > 5) {
        candidates.push(w.slice(0, -3));
    }

    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
        candidates.push(w.slice(0, -1));
    }

    for (const c of candidates) {
        if (DALE_CHALL_SET.has(c)) return true;
    }

    return false;
}

function splitWords(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
}

interface SentenceWordData {
    words: string[];
    wordCount: number;
    syllableCount: number;
    difficultWordCount: number;
}

function analyzeSentences(text: string): SentenceWordData[] {
    const sentences = splitSentences(text, ABBREVIATIONS_PATTERN);
    return sentences.map((s) => {
        const words = splitWords(s.text);
        const wordCount = words.length;
        let syllableCount = 0;
        let difficultWordCount = 0;
        for (const w of words) {
            syllableCount += countSyllables(w);
            if (!isFamiliarWord(w)) difficultWordCount++;
        }
        return { words, wordCount, syllableCount, difficultWordCount };
    });
}

function aggregateSentenceData(data: SentenceWordData[]): {
    totalWords: number;
    totalSentences: number;
    totalSyllables: number;
    totalDifficultWords: number;
} {
    let totalWords = 0;
    let totalSentences = 0;
    let totalSyllables = 0;
    let totalDifficultWords = 0;
    for (const d of data) {
        totalWords += d.wordCount;
        totalSentences++;
        totalSyllables += d.syllableCount;
        totalDifficultWords += d.difficultWordCount;
    }
    return { totalWords, totalSentences, totalSyllables, totalDifficultWords };
}

export interface DaleChallResult {
    rawScore: number;
    gradeLevel: number;
}

export interface ReweightedFleschResult {
    readingEase: number;
    gradeLevel: number;
}

export interface CustomCompositeResult {
    score: number;
    label: string;
}

/**
 * Compute the Dale-Chall Readability Formula (Revised 1995).
 *
 * Formula: Raw Score = 64 - 0.95 * PDW - 0.69 * ASL
 *   PDW = percentage of words NOT in the Dale-Chall familiar word list
 *   ASL = average sentence length in words
 *
 * The raw score maps to grade levels:
 *   60+:  Grades 4 and below (very easy)
 *   50-59: Grades 5-6 (easy)
 *   40-49: Grades 7-8 (moderate)
 *   30-39: Grades 9-12 (difficult)
 *   0-29:  Grades 13-16+ (very difficult / college)
 */
export function daleChall(text: string): DaleChallResult {
    if (!text.trim()) return { rawScore: 0, gradeLevel: 1 };

    const data = analyzeSentences(text);
    const { totalWords, totalSentences, totalDifficultWords } = aggregateSentenceData(data);

    if (totalSentences === 0 || totalWords === 0) return { rawScore: 0, gradeLevel: 1 };

    const pdw = (totalDifficultWords / totalWords) * 100;
    const asl = totalWords / totalSentences;

    const rawScore = Math.max(0, Math.min(100, 64 - 0.95 * pdw - 0.69 * asl));
    const gradeLevel = daleChallGradeFromRaw(rawScore);

    return {
        rawScore: Math.round(rawScore * 10) / 10,
        gradeLevel: Math.round(gradeLevel * 10) / 10
    };
}

function daleChallGradeFromRaw(raw: number): number {
    if (raw >= 60) return 4;
    if (raw >= 50) return 6; // grades 5-6
    if (raw >= 40) return 8; // grades 7-8
    if (raw >= 30) return 12; // grades 9-12
    return 16; // college
}

/**
 * Automated Readability Index (ARI).
 *
 * Formula: 4.71 * (letters / words) + 0.5 * (words / sentences) - 21.43
 *
 * Uses character count (letters + numbers, excluding spaces) instead of
 * syllable-counting heuristics, avoiding the guesswork of vowel-group
 * syllable detection. Produces a grade level roughly aligned with US
 * school years (1 = first grade, 12 = high school senior, 14 = college).
 *
 * Typical ARI ranges for fiction:
 *   1-4   Very easy (early readers / children's)
 *   5-6   Easy (middle grade)
 *   7-9   Average (YA to commercial adult)
 *   10-12 Difficult (literary / advanced)
 *   13+   Very difficult (academic / dense prose)
 */
export function automatedReadabilityIndex(text: string): number {
    if (!text.trim()) return 0;

    const data = analyzeSentences(text);
    const { totalWords, totalSentences } = aggregateSentenceData(data);

    if (totalSentences === 0 || totalWords === 0) return 0;

    const wordsPerSentence = totalWords / totalSentences;

    const letters = countLetters(text);
    const lettersPerWord = letters / totalWords;

    const ari = 4.71 * lettersPerWord + 0.5 * wordsPerSentence - 21.43;

    return Math.max(0, Math.round(ari * 10) / 10);
}

function countLetters(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
            count++;
        }
    }
    return count;
}

/**
 * Standard Flesch-Kincaid Reading Ease and Grade Level.
 *
 * Reading Ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words).
 * Grade Level:  0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59.
 *
 * Returns `{ 0, 0 }` for empty or sentence-less input.
 */
export function fleschKincaid(text: string): { readingEase: number; gradeLevel: number } {
    if (!text.trim()) return { readingEase: 0, gradeLevel: 0 };

    const data = analyzeSentences(text);
    const { totalWords, totalSentences, totalSyllables } = aggregateSentenceData(data);

    if (totalSentences === 0 || totalWords === 0) return { readingEase: 0, gradeLevel: 0 };

    const wordsPerSentence = totalWords / totalSentences;
    const syllablesPerWord = totalSyllables / totalWords;

    const readingEase = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    const gradeLevel = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;

    return {
        readingEase: Math.round(readingEase * 10) / 10,
        gradeLevel: Math.max(0, Math.round(gradeLevel * 10) / 10)
    };
}

/**
 * Reweighted Flesch Reading Ease for fiction.
 *
 * Standard Flesch tends to over-score fiction because dialogue-heavy passages
 * produce short sentences with simple words. This reweighting adjusts the
 * coefficients to account for fiction's narrative vocabulary richness and
 * the importance of sentence variety for reader engagement.
 *
 * Formula: RE = 200 - 1.3 * ASL - 75 * ASW
 *          Grade = 0.5 * ASL + 13 * ASW - 18
 *
 *   ASL = average sentence length in words
 *   ASW = average syllables per word
 *
 * Labels (same as standard Flesch):
 *   90+: Very easy  70-89: Easy  60-69: Standard
 *   50-59: Fairly difficult  30-49: Difficult  0-29: Very difficult
 */
export function reweightedFlesch(text: string): ReweightedFleschResult {
    if (!text.trim()) return { readingEase: 0, gradeLevel: 0 };

    const data = analyzeSentences(text);
    const { totalWords, totalSentences, totalSyllables } = aggregateSentenceData(data);

    if (totalSentences === 0 || totalWords === 0) return { readingEase: 0, gradeLevel: 0 };

    const asl = totalWords / totalSentences;
    const asw = totalSyllables / totalWords;

    const readingEase = 200 - 1.3 * asl - 75 * asw;
    const gradeLevel = 0.5 * asl + 13 * asw - 18;

    return {
        readingEase: Math.round(readingEase * 10) / 10,
        gradeLevel: Math.max(0, Math.round(gradeLevel * 10) / 10)
    };
}

/**
 * Custom Composite Score for fiction readability.
 *
 * Combines three factors into a 0-100 score — no Dale-Chall, since its
 * 4th-grade vocabulary baseline penalizes fiction vocabulary unfairly:
 *   60% Reweighted Flesch Reading Ease (syllable + sentence patterns, fiction-tuned)
 *   25% Sentence variety bonus (stddev of sentence length)
 *   15% Dialogue balance bonus (closeness to 45% dialogue)
 *
 * Returns a 0-100 score with the following labels:
 *   80-100: Very readable  60-79: Readable  40-59: Moderate
 *   20-39: Complex  0-19: Very complex
 */
export function customComposite(
    text: string,
    sentenceLengthStddev: number,
    dialogueRatio: number
): CustomCompositeResult {
    if (!text.trim()) return { score: 0, label: 'very complex' };

    const rawReweighted = reweightedFlesch(text);

    const normalizedReweighted = clamp(rawReweighted.readingEase, 0, 100);
    const varietyBonus = clamp((sentenceLengthStddev / 6) * 100, 0, 100);
    const dialogueBonus = 100 - clamp(Math.abs(dialogueRatio - 0.45) * 200, 0, 100);

    const score = normalizedReweighted * 0.6 + varietyBonus * 0.25 + dialogueBonus * 0.15;

    const rounded = Math.round(score * 10) / 10;

    return {
        score: rounded,
        label: compositeLabel(rounded)
    };
}

function compositeLabel(score: number): string {
    if (score >= 80) return 'very readable';
    if (score >= 60) return 'readable';
    if (score >= 40) return 'moderate';
    if (score >= 20) return 'complex';
    return 'very complex';
}

/** Result of the narrative-flow score: a 0-100 value and a human label. */
export interface NarrativeFlowResult {
    /** 0-100 (higher = better flow). */
    score: number;
    /** Tier label (sentence-case, for inline display). */
    label: string;
}

/**
 * Narrative-flow score for a passage.
 *
 * Measures the rhythm of the prose at two scales — sentence length and
 * paragraph length — penalizes uniformly short/long runs (pacing flags), and
 * rewards a balanced mix of dialogue and narration. Purely deterministic and
 * local (no AI), consistent with the dashboard's other metrics.
 *
 * Weighting:
 *   35% Paragraph-length rhythm (the signal sentence-level stddev can't see)
 *   25% Sentence-length variety (mirrors the customComposite variety bonus)
 *   25% Pacing penalty (density of uniform-short/uniform-long flags)
 *   15% Dialogue balance (target band around 40% dialogue)
 *
 * Returns a 0-100 score with the following labels:
 *   80-100: Strong flow  60-79: Good flow  40-59: Uneven
 *   20-39: Choppy  0-19: Monotonous
 *
 * @param sentenceLengthStddev  Population stddev of sentence word counts.
 * @param paragraphLengthStddev Population stddev of paragraph word counts.
 * @param dialogueRatio         Dialogue fraction (0-1).
 * @param pacingFlagCount       Number of uniform-short/uniform-long pacing flags.
 * @param sentenceCount         Total sentences (used to normalize flag density).
 */
export function narrativeFlow(
    sentenceLengthStddev: number,
    paragraphLengthStddev: number,
    dialogueRatio: number,
    pacingFlagCount: number,
    sentenceCount: number
): NarrativeFlowResult {
    if (sentenceCount === 0) return { score: 0, label: 'no data' };

    // Sentence variety: stddev ~6 words = full marks (mirrors customComposite).
    const sentenceVariety = clamp((sentenceLengthStddev / 6) * 100, 0, 100);
    // Paragraph rhythm: stddev ~40 words = full marks (varied paragraph lengths
    // — a healthy mix of short dialogue beats and longer description blocks).
    const paragraphRhythm = clamp((paragraphLengthStddev / 40) * 100, 0, 100);
    // Dialogue balance: target ~40% (a touch below customComposite's 45%).
    const dialogueBalance = 100 - clamp(Math.abs(dialogueRatio - 0.4) * 200, 0, 100);
    // Pacing penalty: ~1 flag per 20 sentences = saturated (no flow credit).
    const density = pacingFlagCount / (sentenceCount / 20);
    const pacingFactor = 1 - clamp(density, 0, 1); // 1 = no flags, 0 = saturated.

    const score = paragraphRhythm * 0.35 + sentenceVariety * 0.25 + pacingFactor * 100 * 0.25 + dialogueBalance * 0.15;
    const rounded = Math.round(score * 10) / 10;
    return { score: rounded, label: flowLabel(rounded) };
}

export function flowLabel(score: number): string {
    if (score >= 80) return 'strong flow';
    if (score >= 60) return 'good flow';
    if (score >= 40) return 'uneven';
    if (score >= 20) return 'choppy';
    return 'monotonous';
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
