/**
 * Rate-limit (HTTP 429) handling for the network tools. Centralizes 429
 * detection across every `requestUrl` site in the MediaWiki client and the
 * `fetch_url` / `fetch_image_url` tools, and surfaces an actionable "wait N
 * seconds" message to the model (which can then wait or pick a different
 * source) instead of a bare status code.
 *
 * Design: tools RETURN a plain-language error string to the model on failure
 * (the tool-loop delivers it as the tool result). They do NOT wait inline and
 * retry — that would block the visible tool round for up to the Retry-After
 * ceiling with no UI feedback. The model already chooses between tools on
 * plain-language results, so a textual hint is actionable.
 */

/** Conservative fallback when a 429 carries no parseable Retry-After. */
const DEFAULT_RETRY_SECONDS = 60;

/**
 * Error thrown when an HTTP tool request is rate-limited (HTTP 429). Carries
 * the retry delay in seconds — parsed from the `Retry-After` response header,
 * or {@link DEFAULT_RETRY_SECONDS} when absent/unparseable — so tool callers
 * can surface an actionable "wait N seconds" message to the model.
 */
export class RateLimitError extends Error {
    readonly seconds: number;

    constructor(seconds: number) {
        super(`HTTP 429 (rate-limited; retry after ${seconds}s)`);
        this.name = 'RateLimitError';
        this.seconds = seconds;
    }
}

/**
 * Parse an HTTP `Retry-After` header value into seconds. Supports both forms
 * permitted by RFC 7231 §7.1.3:
 *  - delta-seconds: `"120"`
 *  - HTTP-date: `"Wed, 21 Oct 2026 07:28:00 GMT"` (resolved to a delta from now)
 *
 * Returns null when the value is absent or unparseable.
 */
export function parseRetryAfter(headerValue: string | undefined | null): number | null {
    if (!headerValue) return null;
    const trimmed = headerValue.trim();
    // delta-seconds form (a run of digits only).
    if (/^\d+$/.test(trimmed)) {
        const seconds = parseInt(trimmed, 10);
        return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
    }
    // HTTP-date form: resolve to a positive delta from the current clock.
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
        return Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
    }
    return null;
}

/**
 * Inspect a `requestUrl` response and throw {@link RateLimitError} when it is
 * a 429. The thrown error carries the parsed `Retry-After` (or a 60s default).
 * Returns silently for every other status — callers keep their own
 * `status !== 200` handling. Centralizes 429 detection so every network-tool
 * requestUrl site handles it identically.
 *
 * `requestUrl` returns lowercase header keys (e.g. `response.headers['content-type']`);
 * both lowercase and title-case are checked defensively.
 */
export function assertNotRateLimited(response: { status: number; headers?: Record<string, string> }): void {
    if (response.status !== 429) return;
    const headers = response.headers ?? {};
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    throw new RateLimitError(parseRetryAfter(raw) ?? DEFAULT_RETRY_SECONDS);
}

/**
 * Format a caught tool error as the model-facing result string, surfacing
 * rate-limit guidance when the error is a {@link RateLimitError}. `action`
 * completes both sentence shapes — e.g. `'looking up "X" on en.wikipedia.org'`
 * renders as `Error looking up "X" on en.wikipedia.org: <msg>` for ordinary
 * failures, or `Rate-limited (HTTP 429) looking up "X" on en.wikipedia.org.
 * Retry-After: 30s. Wait at least 30s before retrying, or try a different
 * source.` for a 429.
 *
 * Replaces the per-tool `caught instanceof Error ? caught.message : ...`
 * idiom so 429 handling is consistent across every network-tool catch block.
 */
export function toolErrorMessage(caught: unknown, action: string): string {
    if (caught instanceof RateLimitError) {
        return (
            `Rate-limited (HTTP 429) ${action}. Retry-After: ${caught.seconds}s. ` +
            `Wait at least ${caught.seconds}s before retrying this source, or try a different source.`
        );
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    return `Error ${action}: ${msg}`;
}
