/**
 * Inline directive parsing for the co-writer's steering layer.
 *
 * Directives are HTML comments in the form `<!-- quill: ... -->` that the
 * writer places in the document to steer the AI's next continuation. Per the
 * Feature 12 spec, the AI reads ONLY the directive(s) immediately preceding
 * the cursor — it never scans the whole document. This module performs that
 * cursor-scoped extraction.
 */

/** A directive with its document offset range and parsed text. */
export interface DirectiveRange {
    start: number;
    end: number;
    text: string;
}

/** Matches a single quill directive comment and captures its inner text. */
const DIRECTIVE_RE = /<!--\s*quill:\s*([\s\S]*?)\s*-->/g;

/**
 * Find every `<!-- quill: ... -->` directive in the document, in document order.
 *
 * Unlike {@link parseDirectives} (which is cursor-scoped), this returns ALL
 * directives regardless of position. Used by Fulfill mode, which sweeps the
 * whole document and fulfills each directive.
 *
 * @param doc  The full document text.
 * @returns All directives with their `[start, end)` offset ranges and text.
 */
export function parseAllDirectives(doc: string): DirectiveRange[] {
    const ranges: DirectiveRange[] = [];
    for (const match of doc.matchAll(/<!--\s*quill:\s*([\s\S]*?)\s*-->/g)) {
        const start = match.index ?? 0;
        const text = (match[1] ?? '').trim();
        if (text.length > 0) {
            ranges.push({ start, end: start + match[0].length, text });
        }
    }
    return ranges;
}

/**
 * Extract the inline quill directives that are active at the cursor.
 *
 * Scans backward from the end of `textBeforeCursor` and collects the
 * contiguous trailing run of `<!-- quill: ... -->` comments — i.e. comments
 * separated from the cursor (and from each other) by only whitespace. The run
 * stops at the first non-comment prose line.
 *
 * A directive with no following prose (cursor right after `-->`) is treated as
 * the drafting prompt and is included. A directive one or more paragraphs above
 * the cursor (interrupted by prose) is NOT included.
 *
 * @param textBeforeCursor  The document text from the start up to the cursor.
 * @returns Parsed directive instructions in document order. Empty when none are
 *   active at the cursor.
 */
export function parseDirectives(textBeforeCursor: string): string[] {
    const trimmed = textBeforeCursor.replace(/\s+$/, '');
    if (!trimmed) return [];

    const matches = [...trimmed.matchAll(DIRECTIVE_RE)];
    if (matches.length === 0) return [];

    const directives: string[] = [];
    let frontier = trimmed.length;
    for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i]!;
        const matchStart = match.index ?? 0;
        const matchEnd = matchStart + match[0].length;
        // The gap between this directive and the current frontier must be
        // only whitespace; otherwise prose interrupts the run.
        const gap = trimmed.slice(matchEnd, frontier);
        if (gap.trim().length > 0) break;
        directives.unshift((match[1] ?? '').trim());
        frontier = matchStart;
    }
    return directives.filter((d) => d.length > 0);
}
