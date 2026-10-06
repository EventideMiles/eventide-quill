/**
 * AI-tell density — a deterministic stylistic-oddity signal for the dashboard
 * and the manuscript-analysis prompt.
 *
 * Counts phrase- and construction-level patterns that occur disproportionately
 * in machine-generated prose, drawn from the linter's own word lists (single
 * source: src/core/linter/word-lists.json — never copied here) plus the shared
 * purple-construction patterns (src/ai/ai-ism-detector.ts, also the editing
 * tools' gate source). Dialogue is exempt, matching the linter rules: a
 * character is allowed to speak however they like.
 *
 * Naming discipline: this is a STYLISTIC ODDITY count. It is a heuristic
 * pattern frequency, not authorship forensics — it cannot establish whether
 * any text was machine-generated, and its output must never be presented as
 * AI probability, likelihood, or authorship proof — only as a
 * within-manuscript comparative signal.
 *
 * Weighting choices, documented:
 * - `echo` and `loom` (in aiClichePhrases) are ordinary fiction words (a lore
 *   echo, the loom of fate), so each hit counts at 0.25 weight instead of 1.
 *   At full weight a single common word could dominate the rate and imply a
 *   machine-authored passage where a human wrote "the echo faded".
 * - `commonLongWords` is deliberately NOT a tell source: those are common
 *   words the linter excludes from its complexity flags, and counting them
 *   here would double-count everyday vocabulary as machine flavor.
 */

import { PURPLE_PATTERNS } from '../../ai/ai-ism-detector';
import { isInsideQuotes, splitSentences } from '../../utils/text-analysis';
import wordLists from '../linter/word-lists.json';

/** Weight applied to each `echo` / `loom` hit (see module docstring). */
export const ORDINARY_WORD_WEIGHT = 0.25;

/** The aiClichePhrases entries treated as ordinary fiction words. */
const ORDINARY_CLICHE_WORDS = new Set(['echo', 'loom']);

/** A phrase-level tell source: a stable category label plus its matcher. */
interface TellSource {
    category: string;
    pattern: RegExp;
}

const PHRASE_SOURCES: TellSource[] = [
    { category: 'ai-cliches', pattern: new RegExp(`\\b(${wordLists.aiClichePhrases.join('|')})\\b`, 'gi') },
    { category: 'ai-filler-adverbs', pattern: new RegExp(`\\b(${wordLists.aiFillerAdverbs.join('|')})\\b`, 'gi') },
    { category: 'ai-hedging', pattern: new RegExp(`\\b(${wordLists.aiHedging.join('|')})\\b`, 'gi') },
    { category: 'ai-wrap-ups', pattern: new RegExp(`\\b(${wordLists.aiWrapUps.join('|')})\\b`, 'gi') },
    { category: 'ai-meta-cues', pattern: new RegExp(`\\b(${wordLists.aiMetaCues.join('|')})\\b`, 'gi') }
];

/** Per-category weighted hit count. `count` is a weighted contribution, so it may be fractional when down-weighted words hit. */
export interface AiTellCategoryCount {
    category: string;
    count: number;
}

/** The AI-tell density result for one span of text. */
export interface AiTellDensity {
    /** Weighted tell hits per 1,000 words, rounded to 2 decimals. 0 when the text has no words. */
    hitsPerKiloWords: number;
    /** Weighted hit count per category, in fixed source order. */
    byCategory: AiTellCategoryCount[];
}

/** Count words the same way as `countWords` in metrics.ts (trim + split on whitespace). */
function countWordsInText(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
}

/** Round to 2 decimals. */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Down-weight ordinary fiction words ("echo", "loom") to a fraction of a hit. */
function weightFor(matched: string): number {
    return ORDINARY_CLICHE_WORDS.has(matched.toLowerCase()) ? ORDINARY_WORD_WEIGHT : 1;
}

/** Count weighted, dialogue-exempt matches of one global pattern in `text`. */
function countMatches(text: string, pattern: RegExp): number {
    let count = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        count += weightFor(match[0] ?? '');
    }
    return count;
}

/**
 * Compute the AI-tell density of `text`: weighted stylistic-oddity hits per
 * 1,000 words plus the per-category breakdown. Deterministic and local —
 * no AI, no network. A heuristic comparative signal, never authorship proof.
 */
export function computeAiTellDensity(text: string): AiTellDensity {
    const wordCount = countWordsInText(text);
    const byCategory: AiTellCategoryCount[] = PHRASE_SOURCES.map((source) => ({
        category: source.category,
        count: countMatches(text, source.pattern)
    }));

    let purple = 0;
    for (const pattern of PURPLE_PATTERNS) purple += countMatches(text, pattern);
    byCategory.push({ category: 'purple-constructions', count: purple });

    let hits = 0;
    for (const entry of byCategory) hits += entry.count;

    return {
        hitsPerKiloWords: wordCount > 0 ? round2((hits / wordCount) * 1000) : 0,
        byCategory
    };
}

// ----------------------------------------------------------------
// Sentence-skeleton variety (length-normalized, relative-only)
// ----------------------------------------------------------------

/**
 * Sentence-open class sets, built from the same heuristic families the prose
 * rules use (pronoun openers, determiner openers, -ly adverbs, participle
 * verb forms). Deliberately NOT a POS tagger — the output is only ever
 * compared WITHIN one manuscript, never judged against absolute thresholds.
 * The indefinite pronouns are listed explicitly so their -ing endings
 * ("something", "nothing", …) do not misclassify them as verb participles.
 */
const SKELETON_PRONOUNS = new Set([
    'he',
    'she',
    'it',
    'they',
    'i',
    'we',
    'you',
    'something',
    'nothing',
    'everything',
    'anything'
]);
const SKELETON_DETERMINERS = new Set([
    'the',
    'a',
    'an',
    'this',
    'that',
    'these',
    'those',
    'his',
    'her',
    'their',
    'its',
    'my',
    'our',
    'your'
]);

/**
 * Exhaustive enumeration of the opener classes `skeletonFirstWordClass` can
 * return, and of the length buckets `skeletonLengthBucket` can return. The
 * skeleton space size is DERIVED from these arrays (not hand-counted), so the
 * enumerations and the constant cannot drift apart.
 */
const SKELETON_FIRST_WORD_CLASSES = ['pronoun', 'determiner', 'ly-adverb', 'verb-participle', 'other'] as const;
const SKELETON_LENGTH_BUCKETS = ['short', 'medium', 'long'] as const;

/**
 * Distinct (opener class, length bucket) skeletons the classifier can emit:
 * the product of the two exhaustive enumerations above. This is the
 * normalization base for the skeleton entropy — see
 * `computeSentenceSkeletonVariety`. Exported so tests can pin it to the
 * enumerations.
 */
export const SKELETON_SPACE_SIZE = SKELETON_FIRST_WORD_CLASSES.length * SKELETON_LENGTH_BUCKETS.length;

/** Abbreviation list for sentence splitting, matching the linter rules. */
const SKELETON_ABBREVIATIONS = new RegExp(`\\b(${wordLists.abbreviations.join('|')})\\.$`, 'i');

/** Length-bucket bounds, mirroring the pacing analysis' short/long averages. */
const SKELETON_SHORT_WORDS = 8;
const SKELETON_LONG_WORDS = 25;

/** Classify a sentence's first word into a coarse opener class. */
function skeletonFirstWordClass(firstWord: string): (typeof SKELETON_FIRST_WORD_CLASSES)[number] {
    const lower = firstWord.toLowerCase();
    if (SKELETON_PRONOUNS.has(lower)) return 'pronoun';
    if (SKELETON_DETERMINERS.has(lower)) return 'determiner';
    if (lower.endsWith('ly')) return 'ly-adverb';
    if (lower.endsWith('ed') || lower.endsWith('ing')) return 'verb-participle';
    return 'other';
}

/** Bucket a sentence's word count as short / medium / long. */
function skeletonLengthBucket(wordCount: number): (typeof SKELETON_LENGTH_BUCKETS)[number] {
    if (wordCount < SKELETON_SHORT_WORDS) return 'short';
    if (wordCount <= SKELETON_LONG_WORDS) return 'medium';
    return 'long';
}

/**
 * Compute the sentence-skeleton variety of `text` (0-1): the Shannon entropy
 * of the (opener class, length bucket) distribution, normalized by log(K)
 * where K = min(SKELETON_SPACE_SIZE, sentence count) is the number of
 * observable skeletons. Uniform use of every available skeleton scores 1.0
 * at any chapter length; hammering one skeleton scores near 0. The
 * normalization makes the value INDEPENDENT of sentence count — the earlier
 * distinct-skeleton ratio had ceiling min(SKELETON_SPACE_SIZE, N) / N and so
 * mechanically depressed long chapters regardless of prose variety. A
 * RELATIVE measure only — callers must compare chapters within the same
 * manuscript and may not attach absolute "AI-like" or "human-like"
 * thresholds to the value. Returns 0 for empty text and for single-sentence
 * text (one skeleton carries no variety information, and log(1) gives no
 * normalization base).
 */
export function computeSentenceSkeletonVariety(text: string): number {
    const sentences = splitSentences(text, SKELETON_ABBREVIATIONS);
    const sentenceCount = sentences.length;
    if (sentenceCount < 2) return 0;

    const counts = new Map<string, number>();
    for (const sentence of sentences) {
        const firstWord = sentence.text.match(/[A-Za-z]+/);
        const firstClass = firstWord ? skeletonFirstWordClass(firstWord[0]) : 'other';
        const words = sentence.text.split(/\s+/).filter(Boolean).length;
        const key = `${firstClass}:${skeletonLengthBucket(words)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const observable = Math.min(SKELETON_SPACE_SIZE, sentenceCount);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / sentenceCount;
        entropy -= p * Math.log(p);
    }

    return round2(entropy / Math.log(observable));
}
