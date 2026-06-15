/** Shared text analysis utilities used by both the prose linter and context engine. */

export interface Position {
    line: number;
    column: number;
}

export interface SentenceRange {
    start: number;
    end: number;
    text: string;
    line: number;
    column: number;
}

/** Convert a character offset into a 1-based line and 0-based column position. */
export function posAtOffset(text: string, offset: number): Position {
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    const lastLine = lines[lines.length - 1];
    return {
        line: lines.length,
        column: lastLine ? lastLine.length : 0,
    };
}

/** Return true if the character at `offset` lies between double quotes. */
export function isInsideQuotes(text: string, offset: number): boolean {
    let inQuotes = false;
    for (let i = 0; i < offset; i++) {
        if (text[i] === '"') inQuotes = !inQuotes;
    }
    return inQuotes;
}

/** Return true if a dialogue tag immediately precedes the character at `offset`. */
export function isAfterDialogueTag(text: string, offset: number, precedingTagPattern: RegExp): boolean {
    const before = text.slice(Math.max(0, offset - 16), offset);
    return precedingTagPattern.test(before);
}

/** Estimate the number of syllables in `word` using vowel-group heuristics. */
export function countSyllables(word: string): number {
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

const SENTENCE_END = /[.!?:;](?=[\s"'\u201c\u201d\u2018\u2019]|$)/g;
const QUOTE_AFTER = /["'\u201c\u201d\u2018\u2019]/;

/** Split `text` into sentence ranges with 1-based line/col positions. */
export function splitSentences(text: string, abbreviationsPattern: RegExp): SentenceRange[] {
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
            if (abbreviationsPattern.test(beforePeriod + '.')) continue;
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
