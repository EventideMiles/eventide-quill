import type { AiProvider, ChatMessage } from './provider';
import { summarizeConversation } from './feedback';

/** Result of a successful compaction. */
export interface CompactResult {
    /** The new message array: system prompt, summary context head, and recent turns. */
    messages: ChatMessage[];
    /** The generated summary text. */
    summary: string;
}

/**
 * Compact a conversation by summarizing older turns into a single context head.
 *
 * Separates the message array into:
 * - System prompt (index 0, kept as-is)
 * - Context heads (subsequent `system` messages, rolled into the summary)
 * - Chat turns (all non-system messages)
 *
 * Keeps the last 2 chat turns verbatim. Everything else (older turns + existing
 * context heads) is passed to {@link summarizeConversation} and replaced with
 * a single `system` summary message.
 *
 * @param provider      The AI provider for summarization.
 * @param messages      The full conversation message array.
 * @param sentenceCount Max sentences for the summary.
 * @param options       Optional abort signal.
 *
 * @returns The compacted messages and summary, or `null` if there are fewer
 *          than 2 chat turns (not enough to compact meaningfully).
 */
export async function compactConversation(
    provider: AiProvider,
    messages: ChatMessage[],
    sentenceCount: number,
    options?: { signal?: AbortSignal }
): Promise<CompactResult | null> {
    if (messages.length <= 1) return null;

    const systemPrompt = messages[0]!;
    const contextHeads: ChatMessage[] = [];
    let firstChatIdx = 1;
    while (firstChatIdx < messages.length && messages[firstChatIdx]?.role === 'system') {
        contextHeads.push(messages[firstChatIdx]!);
        firstChatIdx++;
    }
    const chatTurns = messages.slice(firstChatIdx);

    if (chatTurns.length < 2) return null;

    const keepCount = Math.min(2, chatTurns.length);
    const recentTurns = chatTurns.slice(-keepCount);
    const toSummarize = [
        ...chatTurns.slice(0, -keepCount),
        ...contextHeads.map((head) => ({ role: 'user' as const, content: head.content }))
    ];

    if (toSummarize.length === 0) return null;

    const summary = await summarizeConversation(provider, toSummarize, sentenceCount, options);
    if (!summary) return null;

    return {
        messages: [systemPrompt, { role: 'system', content: summary }, ...recentTurns],
        summary
    };
}
