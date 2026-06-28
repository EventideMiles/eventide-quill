import type EventideQuillPlugin from '../../main';

/**
 * Get the configured max context tokens from the default chat provider.
 * Falls back to 32768 when no provider is configured.
 */
export function getMaxContextTokens(plugin: EventideQuillPlugin): number {
    const chat = plugin.getDefaultChatProvider();
    return chat.provider?.config.maxContextTokens ?? 32768;
}

/**
 * Format a token count + max as a percentage string. Returns null when
 * max is zero or negative.
 */
export function tokenPercent(tokens: number, max: number): string {
    if (max <= 0) return '';
    const pct = Math.round((tokens / max) * 100);
    return `${pct}%`;
}
