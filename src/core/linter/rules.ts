import { LintResult } from './types';
import wordLists from './word-lists.json';

// --- Build patterns from word lists ---

const DIALOGUE_TAG_PATTERN = new RegExp(
    `\\b(${wordLists.dialogueTags.join('|')})\\b`, 'gi'
);

const PRECEDING_DIALOGUE_TAG = new RegExp(
    `\\b(${wordLists.dialogueTags.join('|')})\\s+$`, 'i'
);

const QUALIFIER_PATTERN = new RegExp(
    `\\b(${wordLists.qualifiers.join('|')})\\b`, 'gi'
);

const AI_CLICHE_PHRASES = new RegExp(
    `\\b(${wordLists.aiClichePhrases.join('|')})\\b`, 'gi'
);

const AI_FILLER_ADVERBS = new RegExp(
    `\\b(${wordLists.aiFillerAdverbs.join('|')})\\b`, 'gi'
);

const AI_HEDGING = new RegExp(
    `\\b(${wordLists.aiHedging.join('|')})\\b`, 'gi'
);

const AI_WRAP_UP = new RegExp(
    `\\b(${wordLists.aiWrapUps.join('|')})\\b`, 'gi'
);

const ABBREVIATIONS = new RegExp(
    `\\b(${wordLists.abbreviations.join('|')})\\.$`, 'i'
);

const COMMON_ADVERBS = new Set(wordLists.commonAdverbs);
const SKIP_WORDS = new Set(wordLists.skipWords);
const EMOTION_WORDS = new Set(wordLists.emotionWords);
const COMMON_LONG_WORDS = new Set(wordLists.commonLongWords);
const PASSIVE_EXCLUSIONS = new Set(wordLists.passiveExclusions);

// --- End word list patterns ---

interface Position {
    line: number;
    column: number;
}

function posAtOffset(text: string, offset: number): Position {
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    const lastLine = lines[lines.length - 1];
    return {
        line: lines.length,
        column: lastLine ? lastLine.length : 0,
    };
}

function isInsideQuotes(text: string, offset: number): boolean {
    let inQuotes = false;
    for (let i = 0; i < offset; i++) {
        if (text[i] === '"') inQuotes = !inQuotes;
    }
    return inQuotes;
}

function isAfterDialogueTag(text: string, offset: number): boolean {
    const before = text.slice(Math.max(0, offset - 16), offset);
    return PRECEDING_DIALOGUE_TAG.test(before);
}

interface SentenceRange {
    start: number;
    end: number;
    text: string;
    line: number;
    column: number;
}

const SENTENCE_END = /[.!?:;](?=[\s"'\u201c\u201d\u2018\u2019]|$)/g;
const QUOTE_AFTER = /["'\u201c\u201d\u2018\u2019]/;

function isAbbreviation(text: string): boolean {
    return ABBREVIATIONS.test(text);
}

function splitSentences(text: string): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    SENTENCE_END.lastIndex = 0;

    while ((match = SENTENCE_END.exec(text)) !== null) {
        const char = match[0];
        const prev = text[match.index - 1];
        if (char === prev) continue;

        if (char === '.') {
            const beforePeriod = text.slice(Math.max(0, match.index - 3), match.index);
            if (isAbbreviation(beforePeriod + '.')) continue;
        }

        let end = match.index + 1;
        while (QUOTE_AFTER.test(text.charAt(end))) {
            end++;
        }

        const sentenceText = text.slice(lastIndex, end);
        const trimmed = sentenceText.trim();
        if (trimmed) {
            const pos = posAtOffset(text, lastIndex);
            ranges.push({
                start: lastIndex,
                end,
                text: trimmed,
                line: pos.line,
                column: pos.column,
            });
        }

        lastIndex = end;
    }

    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
        const pos = posAtOffset(text, lastIndex);
        ranges.push({
            start: lastIndex,
            end: text.length,
            text: remaining,
            line: pos.line,
            column: pos.column,
        });
    }

    return ranges;
}

export function checkLongSentences(text: string, maxWords: number = 40): LintResult[] {
    const results: LintResult[] = [];
    const sentences = splitSentences(text);

    for (const sentence of sentences) {
        const words = sentence.text.split(/\s+/);
        if (words.length > maxWords) {
            results.push({
                line: sentence.line,
                column: sentence.column,
                length: sentence.text.length,
                message: `Sentence is ${words.length} words long. Consider breaking it up.`,
                severity: 'warning',
                rule: 'long-sentences',
            });
        }
    }

    return results;
}

const PASSIVE_PATTERN = /\b(am|is|are|was|were|be|been|being)\s+(\w+ed|(\w+en)|(\w+t))\b/gi;

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
            rule: 'passive-voice',
        });
    }

    return results;
}

const ADVERB_PATTERN = /\b(\w+ly)\b(?!-)/gi;

export function checkAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = ADVERB_PATTERN.exec(text)) !== null) {
        const word = match[1]?.toLowerCase();
        if (!word) continue;
        if (COMMON_ADVERBS.has(word)) continue;
        if (word.endsWith('ly') && word.length > 4) {
            if (isInsideQuotes(text, match.index)) continue;
            if (isAfterDialogueTag(text, match.index)) continue;
            const pos = posAtOffset(text, match.index);
            results.push({
                line: pos.line,
                column: pos.column,
                length: match[0].length,
                message: `Adverb: "${match[0]}". Consider describing the action directly.`,
                severity: 'info',
                rule: 'adverbs',
            });
        }
    }

    return results;
}

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
            rule: 'qualifiers',
        });
    }

    return results;
}

export function checkRepeatedWords(text: string, minLength: number = 4): LintResult[] {
    const results: LintResult[] = [];
    const sentences = splitSentences(text);

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
                    column: col + 1,
                    length: word.length,
                    message: `Repeated word: "${word}" appears ${positions.length} times in this sentence.`,
                    severity: 'info',
                    rule: 'repeated-words',
                });
            }
        }
    }

    return results;
}

const ECHO_THRESHOLD = 3;

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
        const paraPos = posAtOffset(text, match.index - paraText.length + leadingTrim);
        const sentences = splitSentences(trimmed);
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
                results.push({
                    line: paraPos.line + first.line - 1,
                    column: 1,
                    length: start.length,
                    message: `Echo: "${start}" starts ${indices.length} sentences in this paragraph.`,
                    severity: 'info',
                    rule: 'echoes',
                });
            }
        }
    }

    const remaining = text.slice(searchFrom).trim();
    if (remaining) {
        const paraPos = posAtOffset(text, text.length - remaining.length);
        const sentences = splitSentences(remaining);
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
                    results.push({
                        line: paraPos.line + first.line - 1,
                        column: 1,
                        length: start.length,
                        message: `Echo: "${start}" starts ${indices.length} sentences in this paragraph.`,
                        severity: 'info',
                        rule: 'echoes',
                    });
                }
            }
        }
    }

    return results;
}

const TELLING_PATTERN = /\b(he|she|they|it|i|we)\s+(was|were|felt|feels|seemed|seems|looked|looks|appeared|appears|became|becomes|grew|grows)\s+(\w+)\b/gi;

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
                rule: 'telling-vs-showing',
            });
        }
    }

    return results;
}

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
                rule: 'dialogue-tags',
            });
        }
    }

    return results;
}

function countSyllables(word: string): number {
    const lower = word.toLowerCase();
    if (lower.length <= 3) return 1;

    const vowels = lower.match(/[aeiouy]+/g);
    if (!vowels) return 1;

    let count = vowels.length;

    if (lower.endsWith('e')) count--;
    if (lower.endsWith('le') && lower.length > 2) {
        const prev = lower[lower.length - 3];
        if (prev && !'aeiouy'.includes(prev)) count++;
    }
    if (count === 0) count = 1;

    return count;
}

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
                rule: 'complex-words',
            });
            searchIndex = index + word.length;
        }
    }

    return results;
}

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
            rule: 'ai-cliches',
        });
    }

    return results;
}

const NEGATION_PATTERN = /\bit'?s?\s+not\s+[^,.;!?]{1,60}\s*,?\s*(?:but|it'?s?)\s+/gi;
const NEGATION_BECAUSE_PATTERN = /\bnot\s+because\s+[^,.;!?]{1,60}\s*,?\s*but\s+because\s+/gi;

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
            rule: 'ai-negation',
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
            rule: 'ai-negation',
        });
    }

    return results;
}

export function checkAiFillerAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_FILLER_ADVERBS.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        if (isAfterDialogueTag(text, match.index)) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Filler adverb: "${match[0]}". Consider describing the concrete action instead.`,
            severity: 'info',
            rule: 'ai-filler-adverbs',
        });
    }

    return results;
}

export function checkAiHedging(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_HEDGING.exec(text)) !== null) {
        if (isInsideQuotes(text, match.index)) continue;
        if (match[0].toLowerCase() === 'in a way' && /\sthat\b/i.test(text.slice(match.index + match[0].length, match.index + match[0].length + 8))) continue;
        const pos = posAtOffset(text, match.index);
        results.push({
            line: pos.line,
            column: pos.column,
            length: match[0].length,
            message: `Hedging: "${match[0]}". Use direct language unless character uncertainty is intentional.`,
            severity: 'info',
            rule: 'ai-hedging',
        });
    }

    return results;
}

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
            rule: 'ai-wrap-ups',
        });
    }

    return results;
}

const EM_DASH = /\u2014|\u2015|—/g;

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
            rule: 'ai-em-dashes',
        });
    }

    return results;
}

