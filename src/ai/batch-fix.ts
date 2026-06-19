import { LintResult, RULE_INFO } from '../core/linter/types';
import type { PacingFlag } from '../core/dashboard/types';
import { AiProvider, ChatMessage } from './provider';

/** Replace em dashes with comma+space — matches the co-writer's sanitizeProse convention. */
function sanitizeProse(text: string): string {
    return text.replace(/\u2014/g, ', ');
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A group of lint findings on the same passage (paragraph). */
export interface FindingGroup {
    findings: LintResult[];
    /** Character offset of the passage start in the document. */
    passageStart: number;
    /** Character offset of the passage end (exclusive). */
    passageEnd: number;
    /** The passage text being replaced. */
    passageText: string;
}

// ── Finding grouping ──────────────────────────────────────────────────────────

/**
 * Group lint findings by paragraph.
 *
 * A paragraph is a block of contiguous non-blank lines. Findings on the same
 * paragraph are grouped together so the AI can address all issues in one
 * rewrite — e.g., "long sentence" + "passive voice" on the same passage are
 * fixed simultaneously rather than sequentially.
 *
 * @param results   Lint results to group.
 * @param editorText Full document text.
 * @returns Groups in document order, each with passage offsets and text.
 */
export function groupFindingsByPassage(results: LintResult[], editorText: string): FindingGroup[] {
    if (results.length === 0) return [];

    const lines = editorText.split('\n');
    const isBlank = (text: string) => text.trim().length === 0;

    // Build line-start offset table for character-offset lookups.
    const lineOffsets: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
        lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
    }

    // Sort findings by line for stable grouping.
    const sorted = [...results].sort((a, b) => a.line - b.line || a.column - b.column);

    // Walk findings and group by paragraph.
    const groups: FindingGroup[] = [];
    let current: FindingGroup | null = null;

    for (const result of sorted) {
        const lineIdx = result.line - 1;

        // Find paragraph boundaries (walk outward to blank lines).
        let paraStartIdx = lineIdx;
        while (paraStartIdx > 0 && !isBlank(lines[paraStartIdx - 1] ?? '')) {
            paraStartIdx--;
        }
        let paraEndIdx = lineIdx;
        while (paraEndIdx < lines.length - 1 && !isBlank(lines[paraEndIdx + 1] ?? '')) {
            paraEndIdx++;
        }

        const paraStartOffset = lineOffsets[paraStartIdx] ?? 0;
        const paraEndOffset = lineOffsets[paraEndIdx]! + (lines[paraEndIdx]?.length ?? 0);

        // If this finding is in the same paragraph as the current group, merge.
        if (current && paraStartOffset === current.passageStart) {
            current.findings.push(result);
            // Expand the passage end if this finding extends further.
            if (paraEndOffset > current.passageEnd) {
                current.passageEnd = paraEndOffset;
                current.passageText = editorText.slice(current.passageStart, current.passageEnd);
            }
            continue;
        }

        // New group.
        current = {
            findings: [result],
            passageStart: paraStartOffset,
            passageEnd: paraEndOffset,
            passageText: editorText.slice(paraStartOffset, paraEndOffset)
        };
        groups.push(current);
    }

    return groups;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

/**
 * Build the system + user prompts for a batch linter fix.
 *
 * Lists ALL issues found in the passage and asks the AI to rewrite the
 * entire passage to address them all simultaneously.
 */
export function buildBatchLinterPrompt(group: FindingGroup): { system: string; user: string } {
    const system = [
        'You are an editor fixing prose issues in a passage of fiction.',
        'You will be shown a passage with one or more flagged issues.',
        'Rewrite the passage to address ALL listed issues while preserving the meaning, voice, tense, and POV.',
        '',
        'Guidelines:',
        '- Keep the rewrite as close to the original as possible while fixing the issues.',
        '- Prefer deleting unnecessary words over adding new ones.',
        '- Do not introduce new characters, plot points, or information.',
        '- Maintain the same paragraph structure unless splitting improves clarity.',
        '- Do not use em dashes (—). Use commas, semicolons, or split sentences instead.',
        '',
        'Output ONLY the rewritten passage. No explanations, labels, or markdown.'
    ].join('\n');

    const issueLines: string[] = [];
    for (let i = 0; i < group.findings.length; i++) {
        const f = group.findings[i]!;
        const info = RULE_INFO[f.rule];
        const name = info?.name ?? f.rule;
        issueLines.push(`${i + 1}. ${name}: ${f.message}`);
    }

    const user = [
        `This passage has ${group.findings.length} issue${group.findings.length !== 1 ? 's' : ''}:`,
        ...issueLines,
        '',
        'Passage:',
        group.passageText,
        '',
        'Rewrite the passage to address all issues. Output ONLY the rewritten passage.'
    ].join('\n');

    return { system, user };
}

/**
 * Build the system + user prompts for a pacing flag fix.
 *
 * Asks the AI to vary the sentence rhythm in a passage that is uniformly
 * short or uniformly long.
 */
export function buildPacingFixPrompt(flag: PacingFlag, passageText: string): { system: string; user: string } {
    const isShort = flag.kind === 'uniform-short';

    const system = [
        'You are an editor improving the rhythm of a passage of fiction.',
        isShort
            ? 'The passage has uniformly short sentences, creating a staccato rhythm.'
            : 'The passage has uniformly long sentences, creating a dense, dragging rhythm.',
        'Rewrite the passage to vary the sentence lengths naturally.',
        '',
        'Guidelines:',
        '- Mix short and long sentences. Some should be brief and punchy; others can be longer and flowing.',
        '- Preserve the meaning, voice, tense, and POV.',
        '- Do not introduce new characters, plot points, or information.',
        '- Keep the same paragraph structure.',
        '- Do not use em dashes (—). Use commas, semicolons, or split sentences instead.',
        '',
        'Output ONLY the rewritten passage. No explanations, labels, or markdown.'
    ].join('\n');

    const user = [
        `Average sentence length in this passage: ${flag.avgSentenceLength} words.`,
        isShort
            ? 'Vary the rhythm by combining some sentences and adding natural flow.'
            : 'Vary the rhythm by splitting some sentences and tightening the prose.',
        '',
        'Passage:',
        passageText,
        '',
        'Rewrite the passage to improve the sentence-length variety. Output ONLY the rewritten passage.'
    ].join('\n');

    return { system, user };
}

// ── Streaming helper ──────────────────────────────────────────────────────────

/** Configuration for a batch AI fix request. */
export interface BatchFixOptions {
    temperature: number;
    maxTokens: number;
    model?: string;
    signal?: AbortSignal;
}

/**
 * Stream a batch fix from the AI provider.
 *
 * Accumulates the full response (does not stream into the diff in real time —
 * follows the Fulfill mode pattern). Calls `onChunk` for each text chunk so
 * the caller can show progress.
 *
 * @returns The full response text, or null if the stream was aborted or empty.
 */
export async function streamBatchFix(
    provider: AiProvider,
    messages: ChatMessage[],
    options: BatchFixOptions,
    onChunk?: (text: string, accumulated: string) => void
): Promise<string | null> {
    let accumulated = '';

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
                accumulated += chunk.text;
                onChunk?.(chunk.text, accumulated);
            }
        }
    } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return null;
        throw err;
    }

    const trimmed = accumulated.trim();
    if (!trimmed) return null;

    return sanitizeProse(trimmed);
}
