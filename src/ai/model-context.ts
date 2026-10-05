import type { ProviderConfig } from './provider';

/**
 * Format a context-window token count for display, e.g. 131072 → "131,072".
 * Pinned to `en-US` grouping so the output is deterministic (and matches the
 * comma-grouped examples in the settings UI) regardless of the runtime locale.
 */
export function formatContextLength(tokens: number): string {
    return tokens.toLocaleString('en-US');
}

/**
 * Build the selection-time warning shown when a fetched model's
 * server-reported context is SMALLER than the provider's configured context
 * window. Quill sizes and compacts requests against the configured window
 * (`provider.maxContextTokens`); if the server's actual context is smaller,
 * the server rejects the request before Quill ever compacts — the mismatch is
 * the real OOM lever for local llama.cpp / LM Studio users.
 *
 * Returns null when there is nothing to warn about: no reported length
 * (server didn't expose one), an equal window, or a configured window that is
 * already the smaller of the two (Quill compacts earlier than strictly
 * necessary, which is safe — no notice, keep selection noise low).
 */
export function contextLengthMismatchNotice(
    provider: Pick<ProviderConfig, 'maxContextTokens'>,
    reportedContextLength: number | undefined
): string | null {
    if (typeof reportedContextLength !== 'number') return null;
    if (provider.maxContextTokens <= reportedContextLength) return null;
    return (
        `This model reports a ${formatContextLength(reportedContextLength)}-token context, ` +
        `but the provider is set to ${formatContextLength(provider.maxContextTokens)}. ` +
        'Requests may fail server-side — lower the context window on the provider card, ' +
        "or raise the server's context (-c in llama.cpp/LM Studio)."
    );
}
