/** Shared text analysis utilities used by the prose linter, context engine, and AI analysis modules. */

/**
 * Build a Markdown code fence long enough to safely wrap `text` without being
 * closed prematurely by any backtick run inside it. Returns a run of backticks
 * whose length is `max(3, longestRun + 1)`, satisfying CommonMark's rule that
 * the closing fence be at least as long as the opening fence and longer than
 * any backtick sequence in the fenced content.
 */
export function buildCodeFence(text: string): string {
    let longestRun = 0;
    let currentRun = 0;
    for (const ch of text) {
        if (ch === '`') {
            currentRun++;
            if (currentRun > longestRun) longestRun = currentRun;
        } else {
            currentRun = 0;
        }
    }
    return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * Strip YAML frontmatter (`---\n...\n---`) from the start of a document.
 *
 * Returns the body text (without frontmatter) and the number of leading
 * lines consumed, so callers can adjust line numbers back to absolute
 * positions in the original document.
 *
 * If no frontmatter is present, returns the original text and 0.
 */
export function stripFrontmatter(text: string): { text: string; strippedLines: number } {
    // Normalize CRLF (and lone CR) to LF so the delimiter checks below work
    // regardless of the file's original line-ending style.
    const normalized = text.replace(/\r\n?/g, '\n');
    if (!normalized.startsWith('---\n') && normalized !== '---') {
        return { text, strippedLines: 0 };
    }

    const lines = normalized.split('\n');
    // Find the closing --- delimiter (must be on its own line, not the first).
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            closeIdx = i;
            break;
        }
    }
    if (closeIdx < 0) return { text, strippedLines: 0 };

    const bodyStartIdx = closeIdx + 1;
    return {
        text: lines.slice(bodyStartIdx).join('\n'),
        strippedLines: bodyStartIdx
    };
}

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

/**
 * Return true if the character at `offset` lies between dialogue quotes.
 *
 * Recognized quote characters: ASCII `"` plus typographic doubles `“`/`”` and
 * typographic singles `‘`/`’` (writers using a smart-quote keyboard layout
 * were previously given no dialogue exemption at all). ASCII `'` is
 * deliberately NOT recognized — a straight apostrophe is indistinguishable
 * from a straight single-quote delimiter and appears constantly as a
 * contraction, so honoring it would corrupt the quote state of ordinary
 * narration.
 *
 * Typographic quotes are directional, so they set state rather than toggle:
 * `“`/`‘` open, `”` closes. The ambiguous `’` (dialogue closer OR
 * contraction/possessive apostrophe — "don’t", "hero’s", "’em") is treated
 * as an apostrophe — and left state-neutral — when followed by a word
 * character, and as a closer otherwise. Tradeoff: single quotes nested
 * inside double quotes are ignored rather than tracked, which errs toward
 * MORE exemption — dialogue keeps its exemption and narration is only
 * misread as dialogue in rarer constructions than the reverse would be.
 */
export function isInsideQuotes(text: string, offset: number): boolean {
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < offset; i++) {
        const ch = text[i];
        if (ch === '"') {
            inDouble = !inDouble;
        } else if (ch === '“') {
            inDouble = true;
        } else if (ch === '”') {
            inDouble = false;
        } else if (ch === '‘') {
            if (!inDouble) inSingle = true;
        } else if (ch === '’') {
            const next = text[i + 1];
            if (next && /\w/.test(next)) continue; // contraction/possessive apostrophe, not a closer
            inSingle = false;
        }
    }
    return inDouble || inSingle;
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

/** Split `text` into sentence ranges with 1-based line/col positions.
 *
 *  A sentence ends at the earliest of: terminal punctuation (`.!?:;` followed
 *  by whitespace/quote/EOL, respecting abbreviations) OR a newline. Treating
 *  `\n` as a hard boundary prevents markdown structural lines — headings,
 *  scene breaks, placeholders — from gluing onto adjacent prose when they
 *  don't end in punctuation (e.g. `pain.\n## Heading\n[TBD]\n\n...`). */
export function splitSentences(text: string, abbreviationsPattern: RegExp): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    let lastIndex = 0;
    let searchFrom = 0;

    while (searchFrom < text.length) {
        SENTENCE_END.lastIndex = searchFrom;
        const match = SENTENCE_END.exec(text);
        const nlIdx = text.indexOf('\n', searchFrom);

        let end: number;
        let resume: number;
        const punctFirst = match !== null && (nlIdx === -1 || match.index + 1 <= nlIdx);

        if (punctFirst) {
            const char = match[0];
            const prev = text[match.index - 1];
            // Doubled punctuation (e.g. "..") — not a real boundary; skip past it.
            if (char === prev) {
                searchFrom = match.index + 1;
                continue;
            }
            if (char === '.') {
                const beforePeriod = text.slice(Math.max(0, match.index - 6), match.index);
                if (abbreviationsPattern.test(beforePeriod + '.')) {
                    searchFrom = match.index + 1;
                    continue;
                }
            }

            end = match.index + 1;
            while (QUOTE_AFTER.test(text.charAt(end))) {
                end++;
            }
            resume = end;
        } else if (nlIdx !== -1) {
            // Newline terminates the sentence even without preceding punctuation.
            // The newline char itself is excluded from the sentence text.
            end = nlIdx;
            resume = nlIdx + 1;
        } else {
            break;
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

        lastIndex = resume;
        searchFrom = resume;
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

/** Markdown heading (any depth) on its own line. Shared by extractScene and listSections. */
export const SCENE_BREAK_HEADING = /^#{1,6}\s+\S/;
/** Scene-break marker on its own line: `***`, `* * *`, or `---`. Shared by extractScene and listSections. */
export const SCENE_BREAK_RULE = /^(?:\*\*\*|\*\s\*\s\*|---)\s*$/;
/** Deeper heading (h3-h6) used as a section boundary within a chapter. */
export const SECTION_HEADING = /^#{3,6}\s+\S/;

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

/** A section (scene) within a document, with absolute 1-based line numbers. */
export interface SectionRange {
    /** Heading text if the section starts at a heading, otherwise null. */
    title: string | null;
    /** Section text (joined lines, no leading/trailing blank-line padding). */
    text: string;
    /** 1-based line number where the section begins in the source document. */
    lineStart: number;
    /** 1-based line number where the section ends in the source document (inclusive). */
    lineEnd: number;
    /** What kind of boundary created this section. */
    kind: 'heading' | 'scene-break' | 'leading';
}

const HEADING_TITLE = /^#{1,6}\s+(.+?)\s*$/;

/**
 * Split a document into sections (scenes) by boundary lines.
 *
 * Boundaries are deeper markdown headings (`###`-`######`) and scene-break
 * markers (`***`, `* * *`, `---`). Pass `splitOnAllHeadings: true` to also
 * split on top-level (`#`/`##`) headings — use this when the caller treats
 * the whole file as one chapter (the default manuscript model).
 *
 * Content before the first boundary becomes a `'leading'` section if it has
 * non-blank content; otherwise it is dropped. Empty sections (e.g., between
 * two adjacent scene breaks) are skipped. Blank lines at section edges are
 * trimmed, and `lineStart`/`lineEnd` always reflect the trimmed range.
 *
 * @param text     Full document text.
 * @param options  `splitOnAllHeadings` (default false) — also treat `#`/`##` as boundaries.
 * @returns Sections in document order. Empty array if `text` is blank.
 */
export function listSections(text: string, options: { splitOnAllHeadings?: boolean } = {}): SectionRange[] {
    const { splitOnAllHeadings = false } = options;
    if (!text.trim()) return [];

    const lines = text.split('\n');
    const headingBoundary = splitOnAllHeadings ? SCENE_BREAK_HEADING : SECTION_HEADING;

    type Acc = { title: string | null; kind: SectionRange['kind']; startIdx: number };
    const sections: Acc[] = [{ title: null, kind: 'leading', startIdx: 0 }];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (SCENE_BREAK_RULE.test(line)) {
            sections.push({ title: null, kind: 'scene-break', startIdx: i + 1 });
        } else if (headingBoundary.test(line)) {
            const titleMatch = line.match(HEADING_TITLE);
            sections.push({
                title: titleMatch ? titleMatch[1]! : null,
                kind: 'heading',
                startIdx: i + 1
            });
        }
    }

    const ranges: SectionRange[] = [];
    for (let s = 0; s < sections.length; s++) {
        const cur = sections[s]!;
        const startIdx = cur.startIdx;
        const endIdxExclusive = s + 1 < sections.length ? sections[s + 1]!.startIdx - 1 : lines.length;

        // Trim leading blank lines.
        let lo = startIdx;
        while (lo < endIdxExclusive && lines[lo]!.trim() === '') lo++;
        // Trim trailing blank lines.
        let hi = endIdxExclusive;
        while (hi > lo && lines[hi - 1]!.trim() === '') hi--;

        if (lo >= hi) continue; // skip empty sections

        const sectionLines = lines.slice(lo, hi);
        ranges.push({
            title: cur.title,
            text: sectionLines.join('\n'),
            lineStart: lo + 1,
            lineEnd: hi,
            kind: cur.kind
        });
    }

    return ranges;
}

/**
 * Split text into paragraphs for rhythm analysis. A paragraph is a maximal run
 * of consecutive non-blank lines. Scene-break markers (`***`, `* * *`, `---`)
 * and markdown headings (`#`-`######`) each start a new paragraph, so a scene
 * break or structural heading is treated as a rhythm boundary — consistent
 * with {@link listSections}, which splits on the same markers. Blank lines and
 * the boundary markers themselves are excluded from the returned text.
 *
 * Used by the dashboard's narrative-flow score to compute paragraph-length
 * variance — a rhythm signal sentence-level stddev can't capture.
 *
 * @returns Paragraph texts in document order. Empty array if `text` is blank.
 */
export function splitParagraphs(text: string): string[] {
    if (!text.trim()) return [];
    const lines = text.split('\n');
    const paragraphs: string[] = [];
    let current: string[] = [];
    /** Flush the current paragraph buffer into the result. */
    const flush = (): void => {
        if (current.length > 0) {
            const joined = current.join('\n').trim();
            if (joined) paragraphs.push(joined);
            current = [];
        }
    };
    for (const line of lines) {
        if (line.trim() === '' || SCENE_BREAK_RULE.test(line) || SCENE_BREAK_HEADING.test(line)) {
            flush();
        } else {
            current.push(line);
        }
    }
    flush();
    return paragraphs;
}

/**
 * Escape regular-expression metacharacters in `phrase` so it can be embedded
 * in a pattern as a LITERAL match. Word-list data assets are writer-extensible
 * prose, not pattern fragments — an entry like "not only... but (also)" would
 * otherwise change the alternation's meaning or throw at construction time.
 */
export function escapeRegExp(phrase: string): string {
    return phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build an edge-aware word-boundary alternation RegExp from a list of literal
 * phrases, escaping each entry first (see {@link escapeRegExp}). Single source
 * for every pattern assembled from the linter's word lists (`aiClichePhrases`,
 * `aiMetaCues`, `aiHedging`, …) so no call site can forget the escaping.
 * The default `gi` flags match the linter/detector convention: global scan,
 * case-insensitive.
 *
 * The boundaries are `(?<!\w)` / `(?!\w)` rather than `\b`: `\b` after (or
 * before) a non-word character can never fire, which made entries that END in
 * punctuation (e.g. the wrap-up list's "ultimately,") silently unmatchable.
 * Plain word-edged entries behave exactly as `\b` did — no match when glued
 * to a word character on either edge. A punctuation-ending entry matches
 * before whitespace or end-of-text but still not when a word character
 * follows the punctuation ("ultimately,roughly" does not match).
 */
export function wordListPattern(phrases: readonly string[], flags = 'gi'): RegExp {
    return new RegExp(`(?<!\\w)(${phrases.map(escapeRegExp).join('|')})(?!\\w)`, flags);
}
