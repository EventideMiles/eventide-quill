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
        column: lastLine ? lastLine.length : 0
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
            const beforePeriod = text.slice(Math.max(0, match.index - 6), match.index);
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
                column: pos.column
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
            column: pos.column
        });
    }

    return ranges;
}

/** A scene extracted from a document, with absolute (1-based) line numbers. */
export interface SceneRange {
    /** Scene text (joined lines, no leading/trailing blank-line padding). */
    text: string;
    /** 1-based line number where the scene begins in the source document. */
    lineStart: number;
    /** 1-based line number where the scene ends in the source document (inclusive). */
    lineEnd: number;
}

const SCENE_BREAK_HEADING = /^#{1,6}\s+\S/;
const SCENE_BREAK_RULE = /^(?:\*\*\*|\*\s\*\s\*|---)\s*$/;

/**
 * Extract the scene containing the given 0-based character offset.
 *
 * A scene is bounded by markdown headings (`^#+\s+\S`) or scene-break markers
 * (`***`, `* * *`, or `---` on its own line). If the cursor sits on a heading
 * or scene-break line, that line is treated as the start of the scene. If no
 * preceding boundary exists, the scene starts at line 1. If no following
 * boundary exists, the scene runs to the end of the document.
 *
 * @param text         Full document text.
 * @param cursorOffset 0-based character offset of the cursor position.
 * @returns The scene text plus its 1-based start/end line numbers.
 */
export function extractScene(text: string, cursorOffset: number): SceneRange {
    const lines = text.split('\n');
    const lastIdx = lines.length - 1;

    // Resolve the 0-based line index containing the cursor.
    let cursorIdx = 0;
    let consumed = 0;
    const clamped = Math.max(0, Math.min(cursorOffset, text.length));
    for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i]!.length;
        if (clamped <= consumed + lineLen) {
            cursorIdx = i;
            break;
        }
        consumed += lineLen + 1; // +1 for the '\n'
        cursorIdx = i;
    }
    if (cursorIdx > lastIdx) cursorIdx = Math.max(0, lastIdx);

    // If the cursor line itself is a boundary, the scene starts here.
    const cursorIsBoundary = SCENE_BREAK_HEADING.test(lines[cursorIdx]!) || SCENE_BREAK_RULE.test(lines[cursorIdx]!);

    // Walk backward for the start boundary.
    let startIdx = 0;
    if (!cursorIsBoundary) {
        for (let i = cursorIdx - 1; i >= 0; i--) {
            if (SCENE_BREAK_HEADING.test(lines[i]!) || SCENE_BREAK_RULE.test(lines[i]!)) {
                startIdx = i + 1;
                break;
            }
        }
    } else {
        startIdx = cursorIdx;
    }
    if (startIdx > lastIdx) startIdx = Math.max(0, lastIdx);

    // Walk forward for the end boundary (exclusive).
    let endIdxExclusive = lines.length;
    for (let i = cursorIdx + 1; i < lines.length; i++) {
        if (SCENE_BREAK_HEADING.test(lines[i]!) || SCENE_BREAK_RULE.test(lines[i]!)) {
            endIdxExclusive = i;
            break;
        }
    }

    // Trim leading blank lines.
    while (startIdx < endIdxExclusive && lines[startIdx]!.trim() === '') {
        startIdx++;
    }
    // Trim trailing blank lines.
    while (endIdxExclusive > startIdx && lines[endIdxExclusive - 1]!.trim() === '') {
        endIdxExclusive--;
    }

    // Handle empty-after-trim scene (e.g., cursor between two adjacent headings).
    if (endIdxExclusive <= startIdx) {
        endIdxExclusive = Math.min(startIdx + 1, lines.length);
    }

    const sceneLines = lines.slice(startIdx, endIdxExclusive);
    return {
        text: sceneLines.join('\n'),
        lineStart: startIdx + 1,
        lineEnd: endIdxExclusive
    };
}
