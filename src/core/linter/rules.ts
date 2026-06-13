import { LintResult } from './types';

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

interface SentenceRange {
    start: number;
    end: number;
    text: string;
    line: number;
    column: number;
}

const SENTENCE_END = /[.!?:;](?=[\s"'\u201c\u201d\u2018\u2019]|$)/g;
const QUOTE_AFTER = /["'\u201c\u201d\u2018\u2019]/;
const ABBREVIATIONS = /\b(Dr|Mr|Mrs|Ms|St|Jr|Sr|vs|etc|dept|est|govt|inc|jr|sr|ave|blvd|co|corp|gen|gov|lt|md|mrs|ms|mt|prof|rep|rev|sen|sgt|sq|st|tel|univ)\.$/i;

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
const COMMON_ADVERBS = new Set([
    'early', 'only', 'lovely', 'friendly', 'holy', 'ugly', 'silly',
    'family', 'belly', 'ally', 'apply', 'butterfly', 'reluctantly',
    'melancholy', 'july', 'luckily', 'dimly',
]);

export function checkAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = ADVERB_PATTERN.exec(text)) !== null) {
        const word = match[1]?.toLowerCase();
        if (!word) continue;
        if (COMMON_ADVERBS.has(word)) continue;
        if (word.endsWith('ly') && word.length > 4) {
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
    const pattern = /\b(very|really|quite|somewhat|rather|fairly|pretty|almost|nearly|just|slightly|barely|hardly|scarcely|utter)\b/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
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

const SKIP_WORDS = new Set([
    'the', 'and', 'for', 'but', 'not', 'was', 'had', 'his',
    'her', 'its', 'are', 'has', 'had', 'can', 'all', 'she',
    'him', 'did', 'get', 'got', 'say', 'see', 'way', 'use',
    'may', 'let', 'put', 'set', 'new', 'two', 'old', 'own',
    'too', 'now', 'how', 'why', 'man', 'men', 'any', 'eye',
    'they',
]);

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
    const paragraphs = text.split(/\n\n+/);

    for (const para of paragraphs) {
        const sentences = splitSentences(para);
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
                    line: first.line,
                    column: 1,
                    length: start.length,
                    message: `Echo: "${start}" starts ${indices.length} sentences in this paragraph.`,
                    severity: 'info',
                    rule: 'echoes',
                });
            }
        }
    }

    return results;
}

const TELLING_PATTERN = /\b(he|she|they|it|i|we)\s+(was|were|felt|feels|seemed|seems|looked|looks|appeared|appears|became|becomes|grew|grows)\s+(\w+)\b/gi;
const EMOTION_WORDS = new Set([
    'angry', 'sad', 'happy', 'glad', 'scared', 'afraid', 'nervous',
    'anxious', 'worried', 'embarrassed', 'ashamed', 'guilty', 'proud',
    'jealous', 'envious', 'hurt', 'confused', 'frustrated', 'annoyed',
    'irritated', 'furious', 'terrified', 'excited', 'thrilled', 'delighted',
    'disappointed', 'disgusted', 'hopeful', 'helpless', 'lonely',
    'homesick', 'tired', 'exhausted', 'surprised', 'shocked', 'amazed',
    'bored', 'curious', 'suspicious', 'grateful', 'thankful',
]);

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

const DIALOGUE_TAG_PATTERN = /\b(said|asked|replied|whispered|shouted|yelled|cried|murmured|muttered|whined|bellowed|screamed|hissed|snapped|snarled|growled|scoffed|snorted|laughed|chuckled|sobbed|sighed|breathed|gasped|panted)\b/gi;
const OVERUSED_THRESHOLD = 3;

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
        if (tag === 'said' && indices.length <= OVERUSED_THRESHOLD) continue;
        if (tag !== 'said' && indices.length <= 1) continue;
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

const COMMON_LONG_WORDS = new Set([
    'surprised', 'suddenly', 'finished', 'happened', 'wondered',
    'remember', 'different', 'something', 'everything', 'together',
    'wherever', 'whoever', 'whatever', 'however', 'perhaps',
    'thought', 'through', 'although', 'already', 'another',
    'between', 'without', 'morning', 'evening', 'personal',
    'positive', 'negative', 'pleasant', 'carefully', 'quickly',
    'quietly', 'definitely', 'completely', 'perfectly',
    'beautiful', 'terrible', 'horrible', 'difficult', 'wonderful',
    'exactly', 'actually', 'probably', 'usually', 'finally',
    'certainly', 'absolutely', 'necessary', 'character',
    'discovered', 'whispered', 'murmured', 'continued', 'imagined',
    'curiously', 'nervously', 'anxiously', 'eagerly', 'absurdity',
    'validation', 'werewolves',
    'emotional', 'eventually', 'expectation', 'experience',
    'imagination', 'immediately', 'impossible', 'incredible',
    'intelligent', 'interaction', 'introduced', 'obviously', 'opportunity',
    'overconfident', 'responsible', 'unfortunately',
]);

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

export function checkComplexWords(text: string, maxSyllables: number = 4): LintResult[] {
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

const AI_CLICHE_PHRASES = /\b(tapestry|testament|delve|vibrant|nestled|thriving|nascent|weaving|realm|unlock|game.?changer|pivotal|intricate|elucidate|leverage|holistic|paradigm|synergy|myriad|ozone|labyrinth|glimmer|shimmer|loom|unveil|unleash|fragile|echo|profound)\b/gi;

export function checkAiCliches(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_CLICHE_PHRASES.exec(text)) !== null) {
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

const NEGATION_PATTERN = /(?:it'?s?\s+not\s+.{1,40}?,\s*(?:it'?s?\s+|[a-z]+?\s+(?:is|are|was|were)\s+))/gi;

export function checkAiNegation(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = NEGATION_PATTERN.exec(text)) !== null) {
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

    return results;
}

const AI_FILLER_ADVERBS = /\b(quietly|deliberately|shifted|gently|softly|slowly|carefully|suddenly|slightly)\b/gi;

export function checkAiFillerAdverbs(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_FILLER_ADVERBS.exec(text)) !== null) {
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

const AI_HEDGING = /\b(might|could|perhaps|maybe|possibly|probably|apparently|seemingly|presumably|arguably)\b/gi;

export function checkAiHedging(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_HEDGING.exec(text)) !== null) {
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

const AI_WRAP_UP = /\b(in conclusion|to summarize|to sum up|ultimately,|at the end of the day|when all is said and done|all things considered)\b/gi;

export function checkAiWrapUps(text: string): LintResult[] {
    const results: LintResult[] = [];
    let match: RegExpExecArray | null;

    while ((match = AI_WRAP_UP.exec(text)) !== null) {
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

