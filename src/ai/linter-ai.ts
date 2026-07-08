import { LintResult } from '../core/linter/types';
import { AiProvider, ChatMessage } from './provider';
import { getSystemPrompt, getLinterUserPrompt, type WikiLinkBehavior } from './prompts';

/** Configuration for the AI linter fix request. */
export interface LinterAiOptions {
    temperature: number;
    maxTokens: number;
    /** Override the provider's default chat model. */
    model?: string;
    signal?: AbortSignal;
}

/**
 * Extract context lines around a flagged lint result from the editor text.
 * Returns up to 2 lines before, the flagged line, and up to 2 lines after.
 */
function extractContextLines(
    text: string,
    result: LintResult
): {
    before: string;
    line: string;
    after: string;
} {
    const lines = text.split('\n');
    const lineIndex = result.line - 1;

    const beforeLines: string[] = [];
    for (let i = Math.max(0, lineIndex - 2); i < lineIndex; i++) {
        beforeLines.push(lines[i] ?? '');
    }

    const afterLines: string[] = [];
    for (let i = lineIndex + 1; i < Math.min(lines.length, lineIndex + 3); i++) {
        afterLines.push(lines[i] ?? '');
    }

    return {
        before: beforeLines.join('\n'),
        line: lines[lineIndex] ?? '',
        after: afterLines.join('\n')
    };
}

/**
 * Ask the AI to suggest a fix for a lint result.
 *
 * Surrounding context (2 lines before and after) is included so the AI
 * can make informed word-choice decisions.
 *
 * @param result - The lint result to fix.
 * @param editorText - The full text of the current document.
 * @param provider - The AI provider to use.
 * @param options - Temperature, max tokens, and abort signal.
 * @param customInstruction - Optional freeform instruction override.
 * @returns The suggested replacement text, or null if the AI could not provide a fix.
 */
export async function suggestLintFix(
    result: LintResult,
    editorText: string,
    provider: AiProvider,
    options: LinterAiOptions,
    customInstruction?: string,
    wikiLinkBehavior?: WikiLinkBehavior
): Promise<string | null> {
    const contextLines = extractContextLines(editorText, result);

    const systemPrompt = getSystemPrompt('linter', { wikiLinkBehavior });
    const userPrompt = getLinterUserPrompt(result, contextLines, customInstruction);

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    let responseText = '';
    let lastError: Error | null = null;

    try {
        const stream = provider.chatCompletion({
            messages,
            model: options.model,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            signal: options.signal
        });

        for await (const chunk of stream) {
            if (chunk.text) {
                responseText += chunk.text;
            }
        }
    } catch (err: unknown) {
        if (err instanceof Error) {
            if (err.name === 'AbortError') return null;
            lastError = err;
        }
    }

    if (lastError) {
        throw lastError;
    }

    const trimmed = responseText.trim();

    if (!trimmed || trimmed === 'NO_FIX_NEEDED') {
        return null;
    }

    if (trimmed === 'DELETE') {
        return '';
    }

    return extractReplacement(trimmed, contextLines.line, result);
}

/**
 * Extract the actual replacement text from the AI response.
 *
 * Models vary in how they format responses. This function handles:
 * 1. The ideal case: the model returns just the replacement text.
 * 2. The model returns the full rewritten line — we diff against the original
 *    to extract only what changed within the flagged span.
 * 3. The model wraps its response in markdown or quotes — we strip those first.
 */
export function extractReplacement(raw: string, originalLine: string, result: LintResult): string {
    let cleaned = raw;

    // Strip multi-line markdown code blocks first: ```\n...\n```: extract inner content instead of deleting.
    const fencedMatch = cleaned.match(/^```[\s\S]*?^```$/gm);
    if (fencedMatch && fencedMatch.length > 0) {
        const block = fencedMatch[0];
        const m = block.match(/^```\n([\s\S]*?)\n```$/);
        cleaned = (m?.[1] ?? '').trim();
    }

    // Strip inline triple-backtick wrappers while preserving content.
    cleaned = cleaned.replace(/```([\s\S]*?)```/g, '$1');

    // Strip inline code backticks
    cleaned = cleaned.replace(/^`(.+)`$/gm, '$1');

    // Strip markdown bold/italic wrappers: **word**, *word*, __word__, _word_
    cleaned = cleaned.replace(/^\*{1,2}(.+?)\*{1,2}$/gm, '$1');
    cleaned = cleaned.replace(/^_{1,2}(.+?)_{1,2}$/gm, '$1');

    // If the model gave us a multi-line response, keep only the first
    // substantive line (some models add explanatory text after the fix).
    const lines = cleaned.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 1) {
        // Check if any line exactly matches the original line (the model
        // reproduced the full original). If so, skip it and take the next.
        const nonOriginalLines = lines.filter((l) => l.trim() !== originalLine.trim());
        if (nonOriginalLines.length > 0) {
            cleaned = nonOriginalLines[0] ?? '';
        } else {
            cleaned = lines[0] ?? '';
        }
    }

    // Strip surrounding single or double quotes
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
    }

    cleaned = cleaned.trim();

    if (!cleaned) return '';

    const flaggedText = originalLine.slice(result.column, result.column + result.length);
    const beforeFlagged = originalLine.slice(0, result.column);
    const afterFlagged = originalLine.slice(result.column + result.length);

    // CASE 1: Model returned the DELETE sentinel or an empty string after cleanup
    if (cleaned === 'DELETE' || cleaned === '') return '';

    // CASE 1.5: The model returned the line with the flagged span excised — it
    // reproduced the surrounding context but omitted the flagged text (often
    // collapsing the leftover whitespace). This is the canonical "remove the
    // qualifier" response and, unhandled, causes word duplication. Treat as DELETE.
    if (normalizeForCompare(cleaned) === normalizeForCompare(beforeFlagged + afterFlagged)) {
        return '';
    }

    // CASE 2: The response is plausibly just the replacement — short enough
    // that it's unlikely to be a full rewritten line.
    if (cleaned.length <= flaggedText.length * 2 + 4) {
        return sanitizeReplacement(cleaned, beforeFlagged, afterFlagged);
    }

    // CASE 3: The model returned context around the replacement.
    // Try to extract by finding where the original line's prefix and suffix
    // appear in the response, and taking what's between them.

    // 3a: Full line match — prefix + replacement + suffix
    if (beforeFlagged && cleaned.startsWith(beforeFlagged) && afterFlagged && cleaned.endsWith(afterFlagged)) {
        const start = beforeFlagged.length;
        const end = cleaned.length - afterFlagged.length;
        if (end > start) {
            return sanitizeReplacement(cleaned.slice(start, end), beforeFlagged, afterFlagged);
        }
    }

    // 3b: Prefix match only — take everything after the prefix, trim any trailing whitespace
    if (beforeFlagged && cleaned.startsWith(beforeFlagged)) {
        const candidate = cleaned.slice(beforeFlagged.length);
        // If there's a suffix that matches, strip it; otherwise take the rest
        if (afterFlagged && candidate.endsWith(afterFlagged)) {
            const inner = candidate.slice(0, candidate.length - afterFlagged.length);
            if (inner) return sanitizeReplacement(inner, beforeFlagged, afterFlagged);
        }
        const trimmedCandidate = candidate.trimEnd();
        if (trimmedCandidate) return sanitizeReplacement(trimmedCandidate, beforeFlagged, afterFlagged);
    }

    // 3c: Suffix match only — take everything before the suffix
    if (afterFlagged && cleaned.endsWith(afterFlagged)) {
        const candidate = cleaned.slice(0, cleaned.length - afterFlagged.length).trimStart();
        if (candidate) return sanitizeReplacement(candidate, beforeFlagged, afterFlagged);
    }

    // 3d: The model may have returned a full rewritten line without matching
    // prefix/suffix character-for-character (e.g., changed a comma near the
    // flagged span). Do a fuzzy diff: find the longest common prefix and suffix
    // between the original line and the response, and extract the differing
    // middle portion.
    const fuzzyResult = fuzzyExtract(cleaned, originalLine, result);
    if (fuzzyResult !== null) return sanitizeReplacement(fuzzyResult, beforeFlagged, afterFlagged);

    // CASE 4: Nothing matched. Return the cleaned response as-is — the modal
    // will show it and the user can decide whether to accept it.
    return sanitizeReplacement(cleaned, beforeFlagged, afterFlagged);
}

/**
 * Collapse runs of whitespace to a single space and trim. Used only for
 * equality comparison — never for the actual replacement text.
 */
function normalizeForCompare(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Longest overlap where the START of `candidate` matches a SUFFIX of `prefix`
 * (candidate begins by echoing the tail of the preceding context).
 * Returns the number of leading characters that duplicate `prefix`'s tail.
 */
function longestLeadingOverlap(candidate: string, prefix: string): number {
    const max = Math.min(candidate.length, prefix.length);
    for (let len = max; len > 0; len--) {
        if (candidate.startsWith(prefix.slice(prefix.length - len))) {
            return len;
        }
    }
    return 0;
}

/**
 * Longest overlap where the END of `candidate` matches a PREFIX of `suffix`
 * (candidate ends by echoing the head of the following context).
 * Returns the number of trailing characters that duplicate `suffix`'s head.
 */
function longestTrailingOverlap(candidate: string, suffix: string): number {
    const max = Math.min(candidate.length, suffix.length);
    for (let len = max; len > 0; len--) {
        if (candidate.endsWith(suffix.slice(0, len))) {
            return len;
        }
    }
    return 0;
}

/**
 * Sanitize a replacement text to ensure it fits cleanly into the flagged span.
 *
 * - Strips leading content that duplicates the text immediately before the
 *   flagged span (the model sometimes echoes the preceding context).
 * - Strips trailing content that duplicates the text immediately after the
 *   flagged span.
 *
 * Whitespace-tolerant: boundary spaces are normalized before comparison so a
 * model that collapsed a single space (e.g. when deleting the flagged word) is
 * still recognized. Overlap detection runs against the FULL surrounding context
 * (no fixed-length cap), finding the longest contiguous echo. If the entire
 * replacement is a prefix of what already follows the span, the model echoed
 * forward context rather than offering a real fragment — splicing it in would
 * duplicate that context, so the intent is treated as "nothing to add".
 */
export function sanitizeReplacement(replacement: string, beforeFlagged: string, afterFlagged: string): string {
    let result = replacement;

    const beforeTrim = beforeFlagged.trimEnd();
    const afterTrim = afterFlagged.trimStart();

    if (beforeTrim.length > 2) {
        const overlap = longestLeadingOverlap(result, beforeTrim);
        // Only strip a non-trivial overlap that leaves real content behind —
        // full coverage means the model echoed the entire preceding context,
        // which is the forward-context-echo case handled by the trailing pass.
        if (overlap > 2 && overlap < result.length) {
            result = result.slice(overlap);
        }
    }

    if (afterTrim.length > 2) {
        const overlap = longestTrailingOverlap(result, afterTrim);
        if (overlap > 2) {
            if (overlap >= result.length) {
                // The entire replacement is a prefix of what already follows the
                // flagged span — splicing it in would duplicate that context.
                return '';
            }
            result = result.slice(0, result.length - overlap);
        }
    }

    return result;
}

/**
 * Fuzzy-extract the replacement by finding the longest common prefix and
 * suffix between the model's response and the original line, then returning
 * whatever differs in between.
 *
 * This handles cases where the model returns a full rewritten line but makes
 * small incidental changes (e.g., changing punctuation near the flagged span)
 * that prevent exact prefix/suffix matching.
 *
 * Returns null if the diff is ambiguous (e.g., the response is completely
 * different from the original line).
 */
function fuzzyExtract(response: string, originalLine: string, result: LintResult): string | null {
    // Find longest common prefix length
    let prefixLen = 0;
    const maxPrefix = Math.min(response.length, originalLine.length);
    while (prefixLen < maxPrefix && response[prefixLen] === originalLine[prefixLen]) {
        prefixLen++;
    }

    // Find longest common suffix length (from the end)
    let suffixLen = 0;
    const maxSuffix = Math.min(response.length - prefixLen, originalLine.length - prefixLen);
    while (
        suffixLen < maxSuffix &&
        response[response.length - 1 - suffixLen] === originalLine[originalLine.length - 1 - suffixLen]
    ) {
        suffixLen++;
    }

    // The differing portion of the response
    const diffStart = prefixLen;
    const diffEnd = response.length - suffixLen;

    if (diffEnd <= diffStart) {
        // No discernible diff — the response matches the original line
        // character-for-character. Nothing to replace.
        return null;
    }

    const replacement = response.slice(diffStart, diffEnd);

    // Sanity check: if the "replacement" is almost the entire line, it's
    // probably not a targeted fix — it's a wholesale rewrite. In that case
    // the diff approach is too unreliable, so bail out.
    if (replacement.length > originalLine.length * 0.8) {
        return null;
    }

    return replacement;
}
