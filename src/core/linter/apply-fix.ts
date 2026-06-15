import { LintResult } from './types';
import { EditorView } from '@codemirror/view';

/**
 * Returns true if `ch` is a letter or digit.
 */
function isAlnum(ch: string): boolean {
    return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Punctuation characters that can appear doubled during a lint fix.
 * Covers sentence-enders, commas, colons, and semicolons.
 */
const DOUBLABLE_PUNCT = new Set(['.', '!', '?', ',', ';', ':']);

/**
 * Apply a text replacement for a lint result using the Obsidian Editor API,
 * then clean up spacing and punctuation boundaries:
 * - Collapse double spaces left by word removal
 * - Collapse doubled punctuation (e.g., ".." → ".")
 * - Insert a space where words or punctuation+word are jammed together
 */
export function applyReplacement(
    editor: { replaceRange: (replacement: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => void; getLine: (n: number) => string },
    result: LintResult,
    replacement: string,
): void {
    const lineIndex = result.line - 1;
    const from = { line: lineIndex, ch: result.column };
    const to = { line: lineIndex, ch: result.column + result.length };

    editor.replaceRange(replacement, from, to);

    cleanupBoundaries(editor, result, replacement);
}

/**
 * Apply a text replacement for a lint result using CodeMirror's EditorView,
 * then clean up spacing and punctuation boundaries.
 */
export function applyCmReplacement(
    view: EditorView,
    result: LintResult,
    replacement: string,
): void {
    const doc = view.state.doc;
    const from = doc.line(result.line).from + result.column;
    const to = from + result.length;

    view.dispatch({ changes: { from, to, insert: replacement } });

    const updatedDoc = view.state.doc;
    const lineStart = updatedDoc.line(result.line).from;
    const lineText = updatedDoc.line(result.line).text;
    const col = result.column;
    const endCol = col + replacement.length;

    const fixes: { from: number; to: number; insert: string }[] = [];

    // 1. Collapse double space at the left edge
    if (col > 0 && lineText[col - 1] === ' ' && (lineText[col] ?? '') === ' ') {
        fixes.push({ from: lineStart + col - 1, to: lineStart + col + 1, insert: ' ' });
    } else if (needsSpaceBetween(lineText, col - 1, col)) {
        // 2. Insert space at the left boundary
        fixes.push({ from: lineStart + col, to: lineStart + col, insert: ' ' });
    }

    // 3. Collapse doubled punctuation at the right edge
    //    e.g., replacement ends with "." and next char is also "."
    if (replacement.length > 0 && endCol < lineText.length) {
        const lastRepChar = replacement[replacement.length - 1] ?? '';
        const nextChar = lineText[endCol] ?? '';
        if (lastRepChar && DOUBLABLE_PUNCT.has(lastRepChar) && nextChar === lastRepChar) {
            fixes.push({ from: lineStart + endCol, to: lineStart + endCol + 1, insert: '' });
        } else if (needsSpaceBetween(lineText, endCol - 1, endCol)) {
            // 4. Insert space at the right boundary
            fixes.push({ from: lineStart + endCol, to: lineStart + endCol, insert: ' ' });
        }
    }

    if (fixes.length > 0) {
        view.dispatch({ changes: fixes });
    }
}

/**
 * Determine if a space should be inserted between the characters at `leftIdx` and `rightIdx`.
 */
function needsSpaceBetween(line: string, leftIdx: number, rightIdx: number): boolean {
    const left = leftIdx >= 0 && leftIdx < line.length ? line[leftIdx] : '';
    const right = rightIdx >= 0 && rightIdx < line.length ? line[rightIdx] : '';
    if (!left || !right) return false;
    if (left === ' ' || right === ' ') return false;
    if (isAlnum(left) && isAlnum(right)) return true;
    if ('.!?,;:'.includes(left) && isAlnum(right)) return true;
    return false;
}

/**
 * After a replacement, clean up spacing and punctuation at the boundaries:
 * 1. Collapse double spaces
 * 2. Collapse doubled punctuation
 * 3. Insert spaces where words/punctuation+word are jammed together
 */
function cleanupBoundaries(
    editor: { replaceRange: (replacement: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => void; getLine: (n: number) => string },
    result: LintResult,
    replacement: string,
): void {
    const lineIndex = result.line - 1;
    let lineText = editor.getLine(lineIndex);
    if (lineText === undefined) return;

    const col = result.column;
    // Track how many characters have been inserted/removed by cleanup steps
    // so we can adjust column positions for subsequent steps.
    let offset = 0;

    // 1. Collapse double space at the left edge
    if (col > 0 && lineText[col - 1] === ' ' && (lineText[col] ?? '') === ' ') {
        editor.replaceRange(' ', { line: lineIndex, ch: col - 1 }, { line: lineIndex, ch: col + 1 });
        offset -= 1; // removed one character (two spaces → one space)
        lineText = editor.getLine(lineIndex);
    } else if (col > 0 && needsSpaceBetween(lineText, col - 1, col)) {
        // 2. Insert space at the left boundary
        editor.replaceRange(' ', { line: lineIndex, ch: col }, { line: lineIndex, ch: col });
        offset += 1;
        lineText = editor.getLine(lineIndex);
    }

    // 3. Collapse doubled punctuation at the right edge of the replacement
    const endCol = col + replacement.length + offset;
    if (replacement.length > 0 && endCol < lineText.length) {
        const lastRepChar = replacement[replacement.length - 1] ?? '';
        const nextChar = lineText[endCol] ?? '';
        if (lastRepChar && DOUBLABLE_PUNCT.has(lastRepChar) && nextChar === lastRepChar) {
            editor.replaceRange('', { line: lineIndex, ch: endCol }, { line: lineIndex, ch: endCol + 1 });
            offset -= 1;
            lineText = editor.getLine(lineIndex);
        }
    }

    // 4. Insert space at the right boundary if needed
    const newEndCol = col + replacement.length + offset;
    if (replacement.length > 0 && newEndCol < lineText.length && needsSpaceBetween(lineText, newEndCol - 1, newEndCol)) {
        editor.replaceRange(' ', { line: lineIndex, ch: newEndCol }, { line: lineIndex, ch: newEndCol });
    }
}