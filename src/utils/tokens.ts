/** Shared token estimation utilities. */

/**
 * Estimate token count using the chars-per-4 heuristic.
 * Accepts either a raw string or an array of messages with a `content` field.
 */
export function estimateTokens(text: string): number;
export function estimateTokens(messages: Array<{ content: string }>): number;
export function estimateTokens(input: string | Array<{ content: string }>): number {
    if (typeof input === 'string') return Math.ceil(input.length / 4);
    let total = 0;
    for (const item of input) total += Math.ceil(item.content.length / 4);
    return total;
}
