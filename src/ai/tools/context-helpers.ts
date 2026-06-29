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

/**
 * Describe how a batch of `estTokens` fits against the context budget AFTER
 * subtracting the tokens the active request has already consumed (the live
 * conversation + prior tool results + tools-field overhead). Sizing/planning
 * tools (measure_folder, calculate_file_sizes) surface this so "will it fit"
 * accounts for what's already in context, not just the model's total window —
 * a batch that looks small against the whole window can still overflow when
 * the conversation has already eaten most of it.
 *
 * Returns result lines: the consumed/remaining figures, the batch's share of
 * what's left, and a one-line fit/split recommendation. `count` is the number
 * of files/items in the batch (used for the split hint).
 */
export function describeBatchFit(
    estTokens: number,
    plugin: EventideQuillPlugin,
    consumedTokens: number,
    count: number
): string[] {
    const max = getMaxContextTokens(plugin);
    const remaining = Math.max(0, max - consumedTokens);
    const lines: string[] = [
        `Context: ~${consumedTokens.toLocaleString()} of ${max.toLocaleString()} tokens already in use (~${remaining.toLocaleString()} remaining).`
    ];
    if (remaining <= 0) {
        lines.push('Context is already over budget — compact or resolve pending work before reading more files.');
        return lines;
    }
    const pct = Math.round((estTokens / remaining) * 100);
    lines.push(`This batch is ~${pct}% of the remaining context.`);
    if (pct <= 60) {
        lines.push(`All ${count} fit comfortably in one batch.`);
    } else if (pct <= 80) {
        lines.push(`Fits in one batch but leaves little room — keep your response text minimal.`);
    } else {
        const half = Math.max(1, Math.ceil(count / 2));
        lines.push(`Too large for one batch (~${pct}% of remaining). Split: ~${half} at a time, or compact first.`);
    }
    return lines;
}
