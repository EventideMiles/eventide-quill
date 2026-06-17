/**
 * Shared helpers for rendering token-budget indicators across panels.
 *
 * Extracted from feedback-panel.ts and context-panel.ts to avoid duplication
 * and to support the co-writer token indicator.
 */

/**
 * Build a human-readable file-count label for the token indicator.
 *
 * Matches the existing feedback-panel output: "3 manuscript + 2 reference",
 * "1 manuscript", "1 reference", or "No files in context" when empty.
 */
export function buildFileLabel(manuscriptCount: number, referenceCount: number): string {
    let label = '';
    if (manuscriptCount > 0) label += `${manuscriptCount} manuscript`;
    if (referenceCount > 0) {
        if (label) label += ' + ';
        label += `${referenceCount} reference`;
    }
    if (!label) label = 'No files in context';
    return label;
}

/**
 * Format the full token-indicator text string.
 *
 * Combines a label (from {@link buildFileLabel} or a custom label) with
 * token counts: `"label · 1234 / 8192 tokens"` or `"label · 1234 / 8192 tokens (over budget)"`.
 */
export function formatTokenIndicatorText(label: string, totalTokens: number, maxTokens: number): string {
    const over = totalTokens > maxTokens;
    return `${label} \u00b7 ${totalTokens} / ${maxTokens} tokens${over ? ' (over budget)' : ''}`;
}

/**
 * Return a CSS color token based on the current budget-usage percentage.
 *
 * - < 60%: green
 * - 60–79%: yellow
 * - 80–99%: orange
 * - >= 100%: red
 */
export function getBudgetColor(pct: number): string {
    if (pct < 60) return 'var(--color-green)';
    if (pct < 80) return 'var(--color-yellow)';
    if (pct < 100) return 'var(--color-orange)';
    return 'var(--color-red)';
}
