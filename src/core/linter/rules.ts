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

const LONG_SENTENCE_THRESHOLD = 30;

export function checkLongSentences(text: string): LintResult[] {
    const results: LintResult[] = [];
    const sentenceEnd = /[.!?](?:\s|$)/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = sentenceEnd.exec(text)) !== null) {
        const sentence = text.slice(lastIndex, match.index + 1);
        const words = sentence.trim().split(/\s+/);
        if (words.length > LONG_SENTENCE_THRESHOLD) {
            const pos = posAtOffset(text, lastIndex);
            results.push({
                line: pos.line,
                column: pos.column,
                length: sentence.length,
                message: `Sentence is ${words.length} words long. Consider breaking it up.`,
                severity: 'warning',
                rule: 'long-sentences',
            });
        }
        lastIndex = match.index + 1;
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

const ADVERB_PATTERN = /\b(\w+ly)\b/gi;
const COMMON_ADVERBS = new Set([
    'early', 'only', 'lovely', 'friendly', 'holy', 'ugly', 'silly',
    'family', 'belly', 'ally', 'apply', 'butterfly', 'reluctantly',
    'melancholy', 'july',
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
    const pattern = /\b(very|really|quite|somewhat|rather|fairly|pretty|almost|nearly|just|slightly|barely|hardly|scarcely)\b/gi;
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

export function checkRepeatedWords(text: string): LintResult[] {
    const results: LintResult[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const words = line.toLowerCase().match(/\b\w+\b/g);
        if (!words || words.length < 6) continue;

        const wordCount = new Map<string, number[]>();
        words.forEach((w, idx) => {
            const positions = wordCount.get(w) || [];
            positions.push(idx);
            wordCount.set(w, positions);
        });

        for (const [word, positions] of wordCount) {
            if (word.length < 3) continue;
            if (positions.length >= 3) {
                const wordMatch = new RegExp(`\\b${word}\\b`);
                const found = wordMatch.exec(line.toLowerCase());
                const col = found ? found.index : 0;
                results.push({
                    line: i + 1,
                    column: col + 1,
                    length: word.length,
                    message: `Repeated word: "${word}" appears ${positions.length} times in this line.`,
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
        const sentences = para.match(/[^.!?]+[.!?]+/g);
        if (!sentences || sentences.length < ECHO_THRESHOLD) continue;

        const starts = sentences.map((s) => {
            const words = s.trim().match(/\b\w+\b/g);
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
                const sentence = sentences[idx];
                if (!sentence) continue;
                const lineNum = text.slice(0, text.indexOf(sentence)).split('\n').length;
                results.push({
                    line: lineNum,
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

const LONG_WORD_THRESHOLD = 4;

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
    'curiously', 'nervously', 'anxiously', 'eagerly',
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

export function checkComplexWords(text: string): LintResult[] {
    const results: LintResult[] = [];
    const words = text.match(/\b\w+\b/g);
    if (!words) return results;

    let searchIndex = 0;

    for (const word of words) {
        const lower = word.toLowerCase();
        if (COMMON_LONG_WORDS.has(lower)) continue;
        if (word.length > 8 && countSyllables(word) >= LONG_WORD_THRESHOLD) {
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

export const ALL_RULES = [
    checkComplexWords,
    checkLongSentences,
    checkPassiveVoice,
    checkAdverbs,
    checkQualifiers,
    checkRepeatedWords,
    checkEchoes,
    checkTellingVsShowing,
    checkDialogueTags,
];
