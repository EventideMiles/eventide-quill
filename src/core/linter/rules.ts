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
 * Compute the document position of the first non-whitespace character of a
 * sentence whose untrimmed `start` offset (within a paragraph slice that
 * begins at `paraStartOffset` in the full document) is `sentenceStart`.
 *
 * `splitSentences` records `start` as the untrimmed offset — when the
 * previous sentence ended with punctuation followed by a space (the common
 * case), the recorded start points at the space, not at the sentence's
 * first word. Skipping past whitespace lands the highlight on the actual
 * echoed phrase, matching the `length` (phrase length) the caller sets.
 */
function echoPhrasePosition(
    text: string,
    paraStartOffset: number,
    sentenceStart: number
): { line: number; column: number } {
    let offset = paraStartOffset + sentenceStart;
    while (offset < text.length && /\s/.test(text[offset]!)) offset++;
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
