/** Shared token estimation utilities. */

/**
 * Approximate per-image token cost used by {@link estimateTokens}.
 *
 * Images enter the conversation as image content (vision-native regime), not
 * as tokenized text, so the base64 payload length is NOT a proxy for cost —
 * counting it via the chars/4 rule would wildly overcount. Instead use a fixed
 * estimate per image. Downscaled images are capped at ≤512px on the longest
 * side (`lorebookImageMaxDimension`), which is ~255 tokens at OpenAI's
 * high-detail rate and ~256-576 for typical local vision models (LLaVA et
 * al.). 512 is a fair, slightly conservative estimate — erring high is safe
 * here because it only triggers mid-loop compaction a little sooner, whereas
 * undercounting lets image turns silently grow past the context window.
 */
export const IMAGE_TOKEN_COST = 512;

/**
 * Estimate token count using the chars-per-4 heuristic.
 * Accepts either a raw string or an array of messages with a `content` field.
 * For messages carrying `images` (base64, native vision regime), adds a flat
 * {@link IMAGE_TOKEN_COST} per image so panel estimates and compaction
 * thresholds reflect the real request size.
 */
export function estimateTokens(text: string): number;
export function estimateTokens(messages: Array<{ content: string; images?: string[] }>): number;
export function estimateTokens(input: string | Array<{ content: string; images?: string[] }>): number {
    if (typeof input === 'string') return Math.ceil(input.length / 4);
    let total = 0;
    for (const item of input) {
        total += Math.ceil(item.content.length / 4);
        if (item.images && item.images.length > 0) {
            total += item.images.length * IMAGE_TOKEN_COST;
        }
    }
    return total;
}
