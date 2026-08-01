import { LintResult } from './types';
import wordLists from './word-lists.json';
import {
    splitSentences,
    posAtOffset,
    isInsideQuotes,
    isAfterDialogueTag,
    countSyllables
} from '../../utils/text-analysis';

// --- Build patterns from word lists ---

const DIALOGUE_TAG_PATTERN = new RegExp(`\\b(${wordLists.dialogueTags.join('|')})\\b`, 'gi');

const PRECEDING_DIALOGUE_TAG = new RegExp(`\\b(${wordLists.dialogueTags.join('|')})\\s+$`, 'i');

const QUALIFIER_PATTERN = new RegExp(`\\b(${wordLists.qualifiers.join('|')})\\b`, 'gi');

const AI_CLICHE_PHRASES = new RegExp(`\\b(${wordLists.aiClichePhrases.join('|')})\\b`, 'gi');

const AI_FILLER_ADVERBS = new RegExp(`\\b(${wordLists.aiFillerAdverbs.join('|')})\\b`, 'gi');

const AI_HEDGING = new RegExp(`\\b(${wordLists.aiHedging.join('|')})\\b`, 'gi');

const AI_WRAP_UP = new RegExp(`\\b(${wordLists.aiWrapUps.join('|')})\\b`, 'gi');

const ABBREVIATIONS = new RegExp(`\\b(${wordLists.abbreviations.join('|')})\\.$`, 'i');

const COMMON_ADVERBS = new Set(wordLists.commonAdverbs);
const SKIP_WORDS = new Set(wordLists.skipWords);
const EMOTION_WORDS = new Set(wordLists.emotionWords);
const COMMON_LONG_WORDS = new Set(wordLists.commonLongWords);
const PASSIVE_EXCLUSIONS = new Set(wordLists.passiveExclusions);

// --- End word list patterns ---

/** Flag sentences exceeding `maxWords` in length. */
export function checkLongSentences(text: string, maxWords: number = 40): LintResult[] {
    const results: LintResult[] = [];
    const sentences = splitSentences(text, ABBREVIATIONS);

    for (const sentence of sentences) {
        const words = sentence.text.split(/\s+/);
        if (words.length > maxWords) {
            results.push({
                line: sentence.line,
                column: sentence.column,
                length: sentence.text.length,
                message: `Sentence is ${words.length} words long. Consider breaking it up.`,
                severity: 'warning',
                rule: 'long-sentences'
            });
        }
    }

    return results;
}

const PASSIVE_PATTERN = /\b(am|is|are|was|were|be|been|being)\s+(\w+ed|(\w+en)|(\w+t))\b/gi;

/** Flag passive-voice constructions (be-verb + past participle). */
export function checkPassiveVoice(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = PASSIVE_PATTERN.exec(text)) !== null) {
        const participle = match[2];
        if (!participle) continue;
        // Skip proper nouns (capitalized after a be-verb)
        if (participle[0] === participle[0]?.toUpperCase()) continue;
        const lower = participle.toLowerCase();
        if (PASSIVE_EXCLUSIONS.has(lower)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Passive voice: "${match[0]}". Consider rewriting in active voice.`,
            severity: 'info',
            rule: 'passive-voice'
        });
    }

    return results;
}

const ADVERB_PATTERN = /\b(\w+ly)\b(?!-)/gi;

/** Flag -ly adverbs longer than four characters, excluding common non-adverb forms. */
export function checkAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = ADVERB_PATTERN.exec(text)) !== null) {
        const word = match[1]?.toLowerCase();
        if (!word) continue;
        if (COMMON_ADVERBS.has(word)) continue;
        if (word.length > 4) {
            if (isInsideQuotes(text, match.index)) continue;
            if (isAfterDialogueTag(text, match.index, PRECEDING_DIALOGUE_TAG)) continue;
            const pos = posAtOffset(text, match.index);
            results.push({
                line: pos.line,
                column: pos.column,
                length: match[0].length,
                message: `Adverb: "${match[0]}". Consider describing the action directly.`,
                severity: 'info',
                rule: 'adverbs'
            });
        }
    }

    return results;
}

/** Flag weak qualifiers such as very, really, and quite. */
export function checkQualifiers(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = QUALIFIER_PATTERN.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Qualifier: "${match[0]}". Can be removed or replaced with a stronger word.`,
            severity: 'warning',
            rule: 'qualifiers'
        });
    }

    return results;
}

/** Flag words appearing three or more times within a single sentence. */
export function checkRepeatedWords(text: string, minLength: number = 4): LintResult[] {
    const results: LintResult[] = [];
    const sentences = splitSentences(text, ABBREVIATIONS);

    for (const sentence of sentences) {
        const words = sentence.text.toLowerCase().match(/\b\w+\b/g);
        if (!words || words.length < 6) continue;

        const wordCount = new Map<string, number[]>();
        words.forEach((w, idx) => {
            const positions = wordCount.get(w) || [];
            positions.push(idx);
            wordCount.set(w, positions);
        });

        for (const [word, positions] of wordCount) {
            if (SKIP_WORDS.has(word)) continue;
            if (word.length < minLength) continue;
            if (positions.length >= 3) {
                const wordMatch = new RegExp(`\\b${word}\\b`);
                const found = wordMatch.exec(sentence.text.toLowerCase());
                const col = found ? sentence.column + found.index : sentence.column;
                results.push({
                    line: sentence.line,
                    column: col,
                    length: word.length,
                    message: `Repeated word: "${word}" appears ${positions.length} times in this sentence.`,
                    severity: 'info',
                    rule: 'repeated-words'
                });
            }
        }
    }

    return results;
}

const ECHO_THRESHOLD = 3;

/**
 * Compute the document position of the first lexical character of a
 * sentence whose untrimmed `start` offset (within a paragraph slice that
 * begins at `paraStartOffset` in the full document) is `sentenceStart`.
 *
 * `splitSentences` records `start` as the untrimmed offset — when the
 * previous sentence ended with punctuation followed by a space (the common
 * case), the recorded start points at the space, not at the sentence's
 * first word. Skipping past non-word characters (whitespace and leading
 * punctuation such as an opening quote) lands the highlight on the actual
 * echoed phrase, matching the `length` (phrase length) the caller sets.
 */
function echoPhrasePosition(
    text: string,
    paraStartOffset: number,
    sentenceStart: number
): { line: number; column: number } {
    let offset = paraStartOffset + sentenceStart;
    while (offset < text.length && !/\w/.test(text[offset]!)) offset++;
    return posAtOffset(text, offset);
}

/** Flag paragraphs where multiple sentences start with the same two words. */
export function checkEchoes(text: string): LintResult[] {
    const results: LintResult[] = [];
    const PARA_BREAK = /\n\n+/g;
    let searchFrom = 0;
    let match: RegExpExecArray | null;

    while ((match = PARA_BREAK.exec(text)) !== null) {
        const paraText = text.slice(searchFrom, match.index);
        searchFrom = match.index + match[0].length;

        const trimmed = paraText.trim();
        if (!trimmed) continue;

        const leadingTrim = paraText.length - paraText.trimStart().length;
        const paraStartOffset = match.index - paraText.length + leadingTrim;
        const sentences = splitSentences(trimmed, ABBREVIATIONS);
        if (sentences.length < ECHO_THRESHOLD) continue;

        const starts = sentences.map((s) => {
            const words = s.text.match(/\b\w+\b/g);
            return words ? words.slice(0, 2).join(' ').toLowerCase() : '';
        });

        const startCount = new Map<string, number[]>();
        starts.forEach((start, idx) => {
            if (!start) return;
            const indices = startCount.get(start) || [];
            indices.push(idx);
            startCount.set(start, indices);
        });

        for (const [start, indices] of startCount) {
            if (indices.length >= 2) {
                const idx = indices[0];
                if (idx === undefined) continue;
                const first = sentences[idx];
                if (!first) continue;
                const pos = echoPhrasePosition(text, paraStartOffset, first.start);
                results.push({
                    line: pos.line,
                    column: pos.column,
                    length: start.length,
                    message: `Echo: "${start}" starts ${indices.length} sentences in this paragraph.`,
                    severity: 'info',
                    rule: 'echoes'
                });
            }
        }
    }

    const tail = text.slice(searchFrom);
    const leadingTrim = tail.length - tail.trimStart().length;
    const remaining = tail.trim();
    if (remaining) {
        const paraStartOffset = searchFrom + leadingTrim;
        const sentences = splitSentences(remaining, ABBREVIATIONS);
        if (sentences.length >= ECHO_THRESHOLD) {
            const starts = sentences.map((s) => {
                const words = s.text.match(/\b\w+\b/g);
                return words ? words.slice(0, 2).join(' ').toLowerCase() : '';
            });

            const startCount = new Map<string, number[]>();
            starts.forEach((start, idx) => {
                if (!start) return;
                const indices = startCount.get(start) || [];
                indices.push(idx);
                startCount.set(start, indices);
            });

            for (const [start, indices] of startCount) {
                if (indices.length >= 2) {
                    const idx = indices[0];
                    if (idx === undefined) continue;
                    const first = sentences[idx];
                    if (!first) continue;
                    const pos = echoPhrasePosition(text, paraStartOffset, first.start);
                    results.push({
                        line: pos.line,
                        column: pos.column,
                        length: start.length,
                        message: `Echo: "${start}" starts ${indices.length} sentences in this paragraph.`,
                        severity: 'info',
                        rule: 'echoes'
                    });
                }
            }
        }
    }

    return results;
}

const TELLING_PATTERN =
    /\b(he|she|they|it|i|we)\s+(was|were|felt|feels|seemed|seems|looked|looks|appeared|appears|became|becomes|grew|grows)\s+(\w+)\b/gi;

/** Flag direct emotion statements (telling) that could be shown through action. */
export function checkTellingVsShowing(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = TELLING_PATTERN.exec(text)) !== null) {
        const emotion = match[3]?.toLowerCase();
        if (!emotion) continue;
        if (EMOTION_WORDS.has(emotion)) {
            const pos = posAtOffset(text, match.index);
            results.push({
                line: pos.line,
                column: pos.column,
                length: match[0].length,
                message: `Telling: "${match[0]}". Show the emotion through action or dialogue instead.`,
                severity: 'warning',
                rule: 'telling-vs-showing'
            });
        }
    }

    return results;
}

/** Flag non-said/asked dialogue tags used more than once in the text. */
export function checkDialogueTags(text: string): LintResult[] {
    const results: LintResult[] = [];
    const tagCount = new Map<string, number[]>();

    let match: RegExpExecArray | null;

    while ((match = DIALOGUE_TAG_PATTERN.exec(text)) !== null) {
        const tag = match[1]?.toLowerCase();
        if (!tag) continue;
        const indices = tagCount.get(tag) || [];
        indices.push(match.index);
        tagCount.set(tag, indices);
    }

    for (const [tag, indices] of tagCount) {
        if (tag === 'said' || tag === 'asked') continue;
        if (indices.length <= 1) continue;
        for (const index of indices) {
            const pos = posAtOffset(text, index);
            results.push({
                line: pos.line,
                column: pos.column,
                length: tag.length,
                message: `Dialogue tag: "${tag}" used ${indices.length} times. Consider varying tags or using action beats.`,
                severity: 'info',
                rule: 'dialogue-tags'
            });
        }
    }

    return results;
}

/** Flag long words whose syllable count meets or exceeds `maxSyllables`. */
export function checkComplexWords(text: string, maxSyllables: number = 5): LintResult[] {
    const results: LintResult[] = [];
    const words = text.match(/\b\w+\b/g);
    if (!words) return results;

    let searchIndex = 0;

    for (const word of words) {
        const lower = word.toLowerCase();
        if (COMMON_LONG_WORDS.has(lower)) continue;
        if (word.length > 8 && countSyllables(word) >= maxSyllables) {
            const index = text.indexOf(word, searchIndex);
            if (index === -1) continue;
            if (isInsideQuotes(text, index)) continue;
            const pos = posAtOffset(text, index);
            results.push({
                line: pos.line,
                column: pos.column,
                length: word.length,
                message: `Complex word: "${word}" has ${countSyllables(word)} syllables. Consider a simpler alternative.`,
                severity: 'info',
                rule: 'complex-words'
            });
            searchIndex = index + word.length;
        }
    }

    return results;
}

/** Flag overused AI-generated cliché phrases (tapestry, delve, realm, etc.). */
export function checkAiCliches(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_CLICHE_PHRASES.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `AI cliché: "${match[0]}". Consider more natural phrasing.`,
            severity: 'info',
            rule: 'ai-cliches'
        });
    }

    return results;
}

const NEGATION_PATTERN = /\bit'?s?\s+not\s+[^,.;!?]{1,60}\s*,?\s*(?:but|it'?s?)\s+/gi;
const NEGATION_BECAUSE_PATTERN = /\bnot\s+because\s+[^,.;!?]{1,60}\s*,?\s*but\s+because\s+/gi;

/** Flag AI-style negation patterns ("It's not X, it's Y"). */
export function checkAiNegation(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = NEGATION_PATTERN.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: 'AI negation pattern: "It\'s not X, it\'s Y." State what things are directly.',
            severity: 'warning',
            rule: 'ai-negation'
        });
    }

    while ((match = NEGATION_BECAUSE_PATTERN.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: 'AI negation pattern: "Not because X, but because Y." State what things are directly.',
            severity: 'warning',
            rule: 'ai-negation'
        });
    }

    return results;
}

/** Flag filler adverbs common in AI prose (quietly, gently, slowly, etc.). */
export function checkAiFillerAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_FILLER_ADVERBS.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        if (isAfterDialogueTag(text, match.index, PRECEDING_DIALOGUE_TAG)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Filler adverb: "${match[0]}". Consider describing the concrete action instead.`,
            severity: 'info',
            rule: 'ai-filler-adverbs'
        });
    }

    return results;
}

/** Flag hedging words (perhaps, maybe, possibly) that weaken certainty. */
export function checkAiHedging(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_HEDGING.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        if (
            match[0].toLowerCase() === 'in a way' &&
            /\sthat\b/i.test(text.slice(match.index + match[0].length, match.index + match[0].length + 8))
        )
            continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Hedging: "${match[0]}". Use direct language unless character uncertainty is intentional.`,
            severity: 'info',
            rule: 'ai-hedging'
        });
    }

    return results;
}

/** Flag concluding wrap-up phrases (in conclusion, ultimately, etc.). */
export function checkAiWrapUps(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_WRAP_UP.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Wrap-up phrase: "${match[0]}". End on action or tension, not summary.`,
            severity: 'warning',
            rule: 'ai-wrap-ups'
        });
    }

    return results;
}

// ----------------------------------------------------------------
// Gremlins — invisible / zero-width / non-printing format characters
// ----------------------------------------------------------------

/** Simple-mode gremlins: a focused set of known troublemakers. */
const GREMLIN_RE =
    /[\u200B-\u200D\u200E\u200F\uFEFF\u2060-\u2064\u00AD\u202A-\u202E\u2066-\u2069\u180E\u115F\u1160]|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F/g;

/** Aggressive-mode: every Unicode format character (\\p{Cf}) plus the enclosing keycap. */
const AGGRESSIVE_GREMLIN_RE = /[\p{Cf}\u20E3]/gu;

const GREMLIN_NAMES: Record<string, string> = {
    '00AD': 'Soft hyphen',
    '034F': 'Combining grapheme joiner',
    '061C': 'Arabic letter mark',
    '115F': 'Hangul choseong filler',
    '1160': 'Hangul jungseong filler',
    '180E': 'Mongolian vowel separator',
    '200B': 'Zero-width space',
    '200C': 'Zero-width non-joiner',
    '200D': 'Zero-width joiner',
    '200E': 'Left-to-right mark',
    '200F': 'Right-to-left mark',
    '202A': 'Left-to-right embedding',
    '202B': 'Right-to-left embedding',
    '202C': 'Pop directional formatting',
    '202D': 'Left-to-right override',
    '202E': 'Right-to-left override',
    '2060': 'Word joiner',
    '2061': 'Function application',
    '2062': 'Invisible times',
    '2063': 'Invisible separator',
    '2064': 'Invisible plus',
    '2066': 'Left-to-right isolate',
    '2067': 'Right-to-left isolate',
    '2068': 'First strong isolate',
    '2069': 'Pop directional isolate',
    FE00: 'Variation selector-1',
    FE01: 'Variation selector-2',
    FE02: 'Variation selector-3',
    FE03: 'Variation selector-4',
    FE04: 'Variation selector-5',
    FE05: 'Variation selector-6',
    FE06: 'Variation selector-7',
    FE07: 'Variation selector-8',
    FE08: 'Variation selector-9',
    FE09: 'Variation selector-10',
    FE0A: 'Variation selector-11',
    FE0B: 'Variation selector-12',
    FE0C: 'Variation selector-13',
    FE0D: 'Variation selector-14',
    FE0E: 'Variation selector-15',
    FE0F: 'Variation selector-16',
    FEFF: 'Zero-width no-break space (BOM)',
    '20E3': 'Combining enclosing keycap'
};

/** Look up the human-readable name for a gremlin character, with a fallback for unknown format chars. */
function gremlinName(char: string): string {
    const cp = char.codePointAt(0);
    if (cp === undefined) return 'Unknown character';
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    const known = GREMLIN_NAMES[hex];
    if (known) return known;
    if (cp >= 0xe0100 && cp <= 0xe01ef) {
        return `Variation selector-${cp - 0xe0100 + 17}`;
    }
    if (cp >= 0xe0020 && cp <= 0xe007f) {
        if (cp === 0xe007f) return 'Cancel tag';
        const tagChar = String.fromCodePoint(cp - 0xe0020 + 0x20);
        const label = tagChar === ' ' ? 'space' : tagChar;
        return `Tag character (${label})`;
    }
    return `Unicode format character (U+${hex})`;
}

/** Flag invisible / zero-width / non-printing format characters (gremlins). */
export function checkGremlins(text: string, aggressive: boolean = false): LintResult[] {
    const results: LintResult[] = [];
    const re = aggressive ? AGGRESSIVE_GREMLIN_RE : GREMLIN_RE;
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Invisible formatting character (${gremlinName(match[0])})`,
            severity: 'warning',
            rule: 'gremlins'
        });
    }

    return results;
}

const EM_DASH = /\u2014|\u2015|—/g;

/** Flag em dashes, which AI prose tends to overuse. */
export function checkAiEmDashes(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = EM_DASH.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: 1,
            message: 'Em dash. Consider commas, colons, or sentence breaks instead.',
            severity: 'info',
            rule: 'ai-em-dashes'
        });
    }

    return results;
}

/**
 * Minimum word-overlap percentage for a fuzzy duplicate match. At 70%,
 * two paragraphs sharing ~2 of 3 identical sentences would flag. Tuned
 * to catch AI-edit duplication artifacts without false-positiving on
 * intentional thematic repetition or dialogue callbacks.
 */
const DUPLICATE_OVERLAP_THRESHOLD = 0.7;

/**
 * Extract the set of distinctive words (length > 3, lowercased) from a
 * string. Used for fuzzy paragraph comparison so common words like
 * "the", "and", "said" don't inflate the overlap score.
 */
function distinctiveWords(s: string): Set<string> {
    return new Set(s.split(/\s+/).filter((w) => w.length > 3));
}

/**
 * Compute the overlap coefficient between two word sets:
 * |intersection| / min(|a|, |b|). Better than Jaccard for duplicate
 * detection because it scores high when one set is a near-subset of
 * the other (the common AI-edit case: the duplicate is slightly
 * shorter or longer than the original).
 */
function wordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    for (const word of smaller) {
        if (larger.has(word)) shared++;
    }
    return shared / smaller.size;
}

/**
 * Flag duplicate paragraphs — a common artifact when AI edits accidentally
 * duplicate text. Uses fuzzy word-overlap matching (not exact) so paraphrased
 * duplicates are caught. Checks both single-paragraph pairs (para i vs i+1)
 * and two-paragraph windows ([i, i+1] vs [i+2, i+3]) to catch multi-paragraph
 * duplications.
 *
 * Skips very short paragraphs (under 40 chars) to avoid false positives from
 * formatting lines, single-word lines, or dialogue attribution.
 */
export function checkDuplicateText(text: string): LintResult[] {
    const results: LintResult[] = [];
    const MIN_LEN = 40;

    // Split into paragraphs with their character offsets.
    const paragraphs: { text: string; from: number }[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n' && i + 1 < text.length && text[i + 1] === '\n') {
            const para = text.slice(start, i);
            if (para.trim()) paragraphs.push({ text: para, from: start });
            start = i + 2;
            i++;
        } else if (
            text[i] === '\r' &&
            i + 3 < text.length &&
            text[i + 1] === '\n' &&
            text[i + 2] === '\r' &&
            text[i + 3] === '\n'
        ) {
            const para = text.slice(start, i);
            if (para.trim()) paragraphs.push({ text: para, from: start });
            start = i + 4;
            i += 3;
        }
    }
    const last = text.slice(start);
    if (last.trim()) paragraphs.push({ text: last, from: start });

    // Pre-compute distinctive word sets for eligible paragraphs.
    const wordSets = paragraphs.map((p) => {
        const trimmed = p.text.trim().toLowerCase();
        return trimmed.length >= MIN_LEN ? distinctiveWords(trimmed) : null;
    });

    /** Push a duplicate-text warning for the given paragraph index. */
    const reportAt = (idx: number, pct: number, scope: string): void => {
        const pos = posAtOffset(text, paragraphs[idx]!.from);
        results.push({
            line: pos.line,
            column: pos.column,
            length: paragraphs[idx]!.text.length,
            message: `Duplicate text (${scope}, ~${Math.round(pct * 100)}% overlap with the preceding ${scope}).`,
            severity: 'warning',
            rule: 'duplicate-text'
        });
    };

    // Single-paragraph comparison: para i vs i+1.
    for (let i = 1; i < paragraphs.length; i++) {
        const a = wordSets[i - 1];
        const b = wordSets[i];
        if (!a || !b) continue;
        const overlap = wordOverlap(a, b);
        if (overlap >= DUPLICATE_OVERLAP_THRESHOLD) {
            reportAt(i, overlap, 'paragraph');
        }
    }

    // Multi-paragraph comparison: [i, i+1] vs [i+2, i+3].
    for (let i = 0; i + 3 < paragraphs.length; i++) {
        const aWords = wordSets[i];
        const bWords = wordSets[i + 1];
        const cWords = wordSets[i + 2];
        const dWords = wordSets[i + 3];
        if (!aWords || !bWords || !cWords || !dWords) continue;

        const groupA = new Set([...aWords, ...bWords]);
        const groupB = new Set([...cWords, ...dWords]);
        const overlap = wordOverlap(groupA, groupB);
        if (overlap >= DUPLICATE_OVERLAP_THRESHOLD) {
            reportAt(i + 2, overlap, 'passage');
        }
    }

    return results;
}

/** Escape RegExp special characters in a user-supplied crutch word. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flag user-defined crutch words that appear more than `threshold` times across
 * the whole document. Unlike the static qualifier / AI-cliché rules (which flag
 * every instance of a fixed list), this surfaces the writer's personal
 * overused words — once a word's count exceeds the threshold, every occurrence
 * is flagged so the writer sees each spot that needs attention. An empty list
 * or counts at or below the threshold produce no results.
 */
export function checkCrutchWords(text: string, words: string[], threshold: number = 5): LintResult[] {
    const sanitized = words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
    if (sanitized.length === 0) return [];

    const pattern = new RegExp(`\\b(${sanitized.map(escapeRegExp).join('|')})\\b`, 'gi');
    const counts = new Map<string, number>();
    const hits: { index: number; matched: string; key: string }[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        const captured = match[1];
        if (!captured) continue;
        const key = captured.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
        hits.push({ index: match.index, matched: match[0], key });
    }

    const results: LintResult[] = [];
    for (const { index, matched, key } of hits) {
        const count = counts.get(key) ?? 0;
        if (count <= threshold) continue;
        const pos = posAtOffset(text, index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: matched.length,
            message: `Crutch word "${key}" appears ${count} times (limit ${threshold}). Consider varying or cutting.`,
            severity: 'warning',
            rule: 'crutch-words'
        });
    }

    return results;
}
