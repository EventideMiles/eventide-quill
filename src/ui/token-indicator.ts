/**
 * Shared helpers for rendering token-budget indicators across panels.
 *
 * Extracted from feedback-panel.ts and context-panel.ts to avoid duplication
 * and to support the co-writer token indicator.
 */

import type { ChatMessage } from '../ai/provider';
import { estimateTokens } from '../utils/tokens';

/** One row in a token-breakdown tooltip. */
export interface TokenBreakdownSection {
    label: string;
    tokens: number;
    /** Optional extra context (e.g., "12 tools", "8 chat turns"). */
    detail?: string;
}

/** A per-request token breakdown surfaced as a hover tooltip on the indicator. */
export interface TokenBreakdown {
    sections: TokenBreakdownSection[];
    /** Sum of every section's tokens. */
    total: number;
}

/**
 * Categorize a system message by inspecting its content prefix. Each section
 * added to the injected-context array uses a stable intro phrase — matching
 * those intros lets us attribute tokens to the right source without tracking
 * per-message metadata. Falls back to "System / mode prompt" for the
 * canonical role:'system' instruction at the top of every mode's message
 * array (and for anything we don't recognize).
 */
function categorizeSystemMessage(content: string): { label: string; detail?: string } {
    if (content.startsWith('Vault context for reference:')) return { label: 'Vault context (similarity)' };
    if (content.startsWith('Reference file (')) {
        // Reference file (folder, top-8): ... → extract folder
        const m = content.match(/^Reference file \(([^,]+),/);
        return { label: 'Reference / lore embeds', detail: m?.[1] };
    }
    if (content.startsWith('Plot map')) return { label: 'Plot map' };
    if (content.startsWith('The writer currently has')) return { label: 'Active-file hint' };
    if (content.startsWith('You have network tools')) return { label: 'Network tools advertisement' };
    if (content.startsWith('You have internal vault tools')) return { label: 'Internal tools advertisement' };
    if (content.startsWith('Active inline directives')) return { label: 'Inline directives' };
    if (content.startsWith('The reference files above are already in your context'))
        return { label: 'Context-already-included hint' };
    return { label: 'System / mode prompt' };
}

/**
 * Detect the synthetic user-role messages that `injectImagesIntoMessages`
 * (vision.ts) pushes after an image-bearing tool result. These are
 * system-generated wrappers, not real user turns — counting them as "chat
 * turns" inflates the count and confuses writers (a single user prompt that
 * triggered 4 tool calls, 2 of which returned images, would otherwise show
 * as 12 turns). Identified by their stable opening phrase. Real user
 * messages that happen to start with `[` are still distinguishable because
 * they won't match any of these specific prefixes.
 */
function isSyntheticImageInjectionMessage(content: string): boolean {
    return (
        content.startsWith('[Attached image(s)') ||
        content.startsWith('[Image description from the vision model]') ||
        content.startsWith('[An image was returned') ||
        content.startsWith('[Image could not be described')
    );
}

/**
 * Build a per-request token breakdown from the messages being sent plus the
 * fixed tool-definition overhead. Splits role:'system' messages by category
 * (so the writer can see how much each context source contributes), and
 * buckets role:'user' / 'assistant' / 'tool' messages as "Chat history."
 *
 * The "turns" count in the Chat history detail excludes the tool-call
 * mechanics — `role: 'tool'` results and synthetic image-injection user
 * messages are token-counted but not turn-counted, so the number reflects
 * real conversational turns (user prompts + assistant replies, including
 * tool-call-bearing replies) rather than the expanded message-array length.
 */
export function buildRequestBreakdown(messages: ChatMessage[], toolOverhead: number): TokenBreakdown {
    /** Accumulate tokens per category label, preserving first-seen order. */
    const byLabel = new Map<string, { tokens: number; detail?: string }>();
    const order: string[] = [];

    const bump = (label: string, tokens: number, detail?: string) => {
        if (tokens <= 0) return;
        const existing = byLabel.get(label);
        if (existing) {
            existing.tokens += tokens;
        } else {
            byLabel.set(label, { tokens, detail });
            order.push(label);
        }
    };

    let chatTurns = 0;
    let chatTokens = 0;

    for (const msg of messages) {
        const text = typeof msg.content === 'string' ? msg.content : '';
        const textTokens = estimateTokens(text);
        const imageTokens = msg.images && msg.images.length > 0 ? msg.images.length * 512 : 0;
        const msgTokens = textTokens + imageTokens;

        if (msg.role === 'system') {
            const { label, detail } = categorizeSystemMessage(text);
            bump(label, msgTokens, detail);
        } else {
            // All non-system messages contribute tokens to chat history.
            chatTokens += msgTokens;
            // But the "turns" count excludes tool mechanics — only count
            // real user prompts and assistant replies (tool-call-bearing
            // or final text). Skip role: 'tool' results and the synthetic
            // user-role wrappers pushed by injectImagesIntoMessages.
            const isToolResult = msg.role === 'tool';
            const isSyntheticImage = msg.role === 'user' && isSyntheticImageInjectionMessage(text);
            if (!isToolResult && !isSyntheticImage && (msg.role === 'user' || msg.role === 'assistant')) {
                chatTurns++;
            }
        }
    }

    const sections: TokenBreakdownSection[] = [];

    // Tool definitions first — they're the typical surprise.
    if (toolOverhead > 0) {
        sections.push({ label: 'Tool definitions', tokens: toolOverhead });
    }
    // System/injected categories in first-seen order.
    for (const label of order) {
        const entry = byLabel.get(label);
        if (!entry) continue;
        sections.push({ label, tokens: entry.tokens, detail: entry.detail });
    }
    // Chat history last.
    if (chatTokens > 0) {
        sections.push({
            label: 'Chat history',
            tokens: chatTokens,
            detail: `${chatTurns} turn${chatTurns === 1 ? '' : 's'}`
        });
    }

    const total = sections.reduce((sum, s) => sum + s.tokens, 0);
    return { sections, total };
}

/**
 * Render a breakdown as a multi-line tooltip string (suitable for an
 * HTML `title` attribute). Includes per-section token count + percentage
 * of the request total, then a summary line. Percentages use the request
 * total (sum of sections), not the provider's full context window — they
 * answer "where are my tokens going?" rather than "how full is the window?"
 */
export function formatBreakdownTooltip(breakdown: TokenBreakdown, maxTokens: number): string {
    const lines: string[] = ['Token breakdown:', ''];
    for (const section of breakdown.sections) {
        const pct = breakdown.total > 0 ? Math.round((section.tokens / breakdown.total) * 100) : 0;
        const detail = section.detail ? ` (${section.detail})` : '';
        lines.push(`• ${section.label}${detail}: ${section.tokens.toLocaleString()} (${pct}%)`);
    }
    lines.push('');
    lines.push(`Total: ${breakdown.total.toLocaleString()} / ${maxTokens.toLocaleString()} window`);
    return lines.join('\n');
}

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
