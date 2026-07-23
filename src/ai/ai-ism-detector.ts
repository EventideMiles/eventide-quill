/**
 * AI-ism detection for prose proposed by the model in editing tool calls.
 *
 * When the model calls edit_note / insert_note / append_to_note, its
 * new_text / content argument is checked against common AI writing tells.
 * If any are found, the tool returns an error (instead of staging the edit)
 * with specific feedback so the model can rewrite and re-issue the call.
 *
 * This creates a programmatic feedback loop: the model's prose is validated
 * BEFORE it reaches the writer's review queue, so the writer never sees
 * AI-isms in proposed edits.
 *
 * Detection is pattern-based (regex + word lists sourced from the linter's
 * own word-lists.json). It catches the tells that prompt guidance alone
 * hasn't been able to suppress: em dashes, cliché atmospheric words,
 * overwrought metaphors, filler verbs, and purple constructions.
 */

import wordLists from '../core/linter/word-lists.json';

/** A single AI-ism detected in the model's proposed text. */
export interface AiIsm {
    /** Category for grouping in the error message. */
    category: 'em-dash' | 'cliche-word' | 'purple-construction' | 'filler-verb';
    /** The specific word or phrase that triggered the detection. */
    match: string;
    /** Short snippet of surrounding context for the error message. */
    snippet: string;
}

const EM_DASH_PATTERN = /\u2014|\u2013/g;
const DOUBLE_HYPHEN_PATTERN = / -- /g;

const PURPLE_PATTERNS: RegExp[] = [
    /\b(hung|lingered)\s+heavy\b/gi,
    /\bshiver\s+ran\b/gi,
    /\bsomething\s+shifted\b/gi,
    /\bair\s+(was|grew)\s+(thick|heavy|electric)\b/gi,
    /\bcacophony\s+of\b/gi,
    /\bpalpable\s+tension\b/gi
];

/**
 * Detect AI writing tells in a text string. Returns a list of findings,
 * empty if the text is clean.
 *
 * @param text The new_text / content argument from an editing tool call.
 */
export function detectAiIsms(text: string): AiIsm[] {
    const isms: AiIsm[] = [];

    // Em dashes (the most common and persistent tell)
    let match: RegExpExecArray | null;
    EM_DASH_PATTERN.lastIndex = 0;
    while ((match = EM_DASH_PATTERN.exec(text)) !== null) {
        isms.push({
            category: 'em-dash',
            match: match[0],
            snippet: snippetAround(text, match.index)
        });
    }
    DOUBLE_HYPHEN_PATTERN.lastIndex = 0;
    while ((match = DOUBLE_HYPHEN_PATTERN.exec(text)) !== null) {
        isms.push({
            category: 'em-dash',
            match: '--',
            snippet: snippetAround(text, match.index)
        });
    }

    // AI cliché words (from the linter's own word list)
    const clicheWords = wordLists.aiClichePhrases;
    const clicheRegex = new RegExp(`\\b(${clicheWords.join('|')})\\b`, 'gi');
    while ((match = clicheRegex.exec(text)) !== null) {
        isms.push({
            category: 'cliche-word',
            match: match[0],
            snippet: snippetAround(text, match.index)
        });
    }

    // Purple constructions
    for (const pattern of PURPLE_PATTERNS) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text)) !== null) {
            isms.push({
                category: 'purple-construction',
                match: match[0],
                snippet: snippetAround(text, match.index)
            });
        }
    }

    return isms;
}

/** Extract a short context snippet around an index for the error message. */
function snippetAround(text: string, index: number, radius = 30): string {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + radius);
    return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Format the AI-ism detection results as an error message for the tool
 * result. The model sees this as the tool's return value and can rewrite
 * the text to fix the issues.
 */
export function formatAiIsmError(isms: AiIsm[]): string {
    const lines: string[] = [
        'AI-ism check: your proposed text contains writing tells that mark it',
        'as machine-generated. Rewrite to match the writer\u2019s voice and re-issue',
        'the call. Study 2-3 sentences surrounding the edit location and mirror',
        'their sentence length, vocabulary, and punctuation.',
        '',
        'Detected:'
    ];
    for (const ism of isms.slice(0, 8)) {
        const label =
            ism.category === 'em-dash'
                ? `Em dash`
                : ism.category === 'cliche-word'
                  ? `Clich\u00e9 word "${ism.match}"`
                  : ism.category === 'purple-construction'
                    ? `Purple construction "${ism.match}"`
                    : `Filler verb "${ism.match}"`;
        lines.push(`- ${label}: "...${ism.snippet}..."`);
    }
    if (isms.length > 8) {
        lines.push(`- ...and ${isms.length - 8} more`);
    }
    return lines.join('\n');
}

/**
 * Check a proposed text for AI-isms. Returns null if clean, or an error
 * message string if issues were found. Designed to be called from editing
 * tool execute() methods.
 */
export function checkAiIsms(text: string): string | null {
    if (!text || text.trim().length === 0) return null;
    const isms = detectAiIsms(text);
    if (isms.length === 0) return null;
    return formatAiIsmError(isms);
}
