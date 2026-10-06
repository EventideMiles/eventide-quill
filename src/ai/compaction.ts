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
 * Deterministic stand-in "summary" used when AI summarization fails or returns
 * nothing. Doubles as the marker message content and the {@link CompactResult.summary}
 * value on the fallback path, so callers can tell the two compaction results apart.
 */
export const FALLBACK_SUMMARY_MARKER =
    '[Older conversation turns were dropped to fit the context window. Ask the writer to restate anything that seems missing.]';

/** The leading system prompt, any context heads, and the chat turns of a message array. */
interface DecomposedMessages {
    /** Index-0 system prompt, kept verbatim by both compaction paths. */
    systemPrompt: ChatMessage;
    /** Subsequent leading `system` messages (memory index, tool guidance, …). */
    contextHeads: ChatMessage[];
    /** Everything after the system prompt and the context heads. */
    chatTurns: ChatMessage[];
}

/**
 * Split a conversation array into its system prompt, context heads, and chat turns.
 * Shared by the AI and the deterministic compaction paths so the decomposition rules
 * (index 0 = system prompt, following leading `system` messages = context heads) stay
 * defined in exactly one place.
 */
function decomposeMessages(messages: ChatMessage[]): DecomposedMessages {
    const systemPrompt = messages[0]!;
    const contextHeads: ChatMessage[] = [];
    let firstChatIdx = 1;
    while (firstChatIdx < messages.length && messages[firstChatIdx]?.role === 'system') {
        contextHeads.push(messages[firstChatIdx]!);
        firstChatIdx++;
    }
    return { systemPrompt, contextHeads, chatTurns: messages.slice(firstChatIdx) };
}

/**
 * Partition chat turns into atomic anchor groups so a compaction boundary can never
 * separate an assistant `tool_calls` message from its `tool` results. Consecutive
 * messages sharing a {@link ChatMessage.quillAnchorId} form one group (a whole tool
 * round shares the originating display turn's id). Messages without an anchor —
 * subagent histories carry none — group by wire shape: an unanchored `tool` result
 * joins the preceding group (its parent assistant tool-call round) instead of
 * starting a new one, so an unanchored multi-tool round stays atomic; every other
 * unanchored message is treated as its own group.
 */
function groupChatTurnsByAnchor(turns: ChatMessage[]): ChatMessage[][] {
    const groups: ChatMessage[][] = [];
    for (const message of turns) {
        const currentGroup = groups[groups.length - 1];
        if (
            currentGroup &&
            message.quillAnchorId !== undefined &&
            currentGroup[0]?.quillAnchorId === message.quillAnchorId
        ) {
            currentGroup.push(message);
        } else if (currentGroup && message.quillAnchorId === undefined && message.role === 'tool') {
            // Unanchored tool result: join the preceding assistant tool-call round.
            currentGroup.push(message);
        } else {
            groups.push([message]);
        }
    }
    return groups;
}

/**
 * Check whether an error is an abort, which must propagate to the caller instead of
 * triggering the deterministic fallback. Covers plain `Error`s and `DOMException`s
 * named `AbortError`.
 */
function isAbortError(err: unknown): boolean {
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
        return true;
    }
    return err instanceof Error && err.name === 'AbortError';
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
 * When summarization fails (provider error) or returns an empty summary, a
 * deterministic fallback applies instead: the oldest turns are dropped outright
 * (whole anchor groups, never splitting a tool round) and a fixed marker message
 * replaces the summary — see {@link fallbackCompactConversation}. Abort errors
 * always propagate to the caller. Returns `null` when there is nothing to
 * compact meaningfully, or when even the fallback cannot shrink the array.
 *
 * @param provider      The AI provider for summarization.
 * @param messages      The full conversation message array.
 * @param sentenceCount Max sentences for the summary.
 * @param options       Optional abort signal.
 *
 * @returns The compacted messages and summary, or `null` if there are fewer
 *          than 2 chat turns (not enough to compact meaningfully) or the
 *          deterministic fallback could not shrink the conversation.
 */
export async function compactConversation(
    provider: AiProvider,
    messages: ChatMessage[],
    sentenceCount: number,
    options?: { signal?: AbortSignal }
): Promise<CompactResult | null> {
    if (messages.length <= 1) return null;

    const { systemPrompt, contextHeads, chatTurns } = decomposeMessages(messages);

    if (chatTurns.length < 2) return null;

    const keepCount = Math.min(2, chatTurns.length);
    const recentTurns = chatTurns.slice(-keepCount);
    const toSummarize = [
        ...chatTurns.slice(0, -keepCount),
        ...contextHeads.map((head) => ({ role: 'user' as const, content: head.content }))
    ];

    if (toSummarize.length === 0) return null;

    let summary: string;
    try {
        summary = await summarizeConversation(provider, toSummarize, sentenceCount, options);
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn('Quill: Compaction summarization failed; applying deterministic fallback.', err);
        return buildFallbackResult(messages);
    }
    // The streaming layers end their generators GRACEFULLY on abort (the SSE/
    // NDJSON parsers close without throwing, and on mobile the buffered
    // requestUrl path simply resolves early), so a cancelled summarize can
    // RESOLVE with whatever truncated text arrived before the cancel. Accepting
    // it would permanently fold history into a truncated summary, so a set
    // signal must propagate as an abort — never fall back, never succeed.
    if (options?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
    if (!summary) return buildFallbackResult(messages);

    return {
        messages: [systemPrompt, { role: 'system', content: summary }, ...recentTurns],
        summary
    };
}

/**
 * Deterministic fallback compaction for when AI summarization is unavailable
 * (provider error) or produced no summary. Runs the same decomposition as
 * {@link compactConversation} but, having no way to summarize, it keeps the
 * context heads verbatim (dropping the memory index / tool guidance heads would
 * break behavior) and drops the oldest chat turns outright, keeping the system
 * prompt, the context heads, a fixed marker message, and the last 2 turns.
 *
 * Invariants:
 * - Turns are dropped and kept as WHOLE anchor groups (see
 *   {@link groupChatTurnsByAnchor}; an unanchored `tool` result joins its parent
 *   assistant round rather than standing alone), so an assistant `tool_calls`
 *   message is never separated from its `tool` results and the kept region never
 *   starts with an orphaned `tool` message or ends on an assistant with
 *   unanswered tool calls. If a sanity check finds either shape, the input is
 *   returned unchanged rather than corrupting the array.
 * - With fewer than 4 chat turns the array is returned unchanged: dropping
 *   turns cannot free meaningful space when only 1-2 would remain.
 * - The input array is never modified; a new array is always returned, and
 *   kept messages are passed through by reference with all fields
 *   (`quillAnchorId`, `thinkingBlocks`, …) intact.
 *
 * @param messages The full conversation message array.
 * @returns The compacted message array, or a shallow copy of the input when
 *          nothing can be dropped safely.
 */
export function fallbackCompactConversation(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length === 0) return [];
    const { systemPrompt, contextHeads, chatTurns } = decomposeMessages(messages);
    const groups = groupChatTurnsByAnchor(chatTurns);
    if (groups.length < 4) return messages.slice();

    const kept = groups.slice(-2).flat();
    const firstKept = kept[0];
    const lastKept = kept[kept.length - 1];
    const startsWithOrphanedTool = firstKept?.role === 'tool';
    const endsWithUnansweredToolCalls = lastKept?.role === 'assistant' && (lastKept.toolCalls?.length ?? 0) > 0;
    if (startsWithOrphanedTool || endsWithUnansweredToolCalls) return messages.slice();

    return [systemPrompt, ...contextHeads, { role: 'system', content: FALLBACK_SUMMARY_MARKER }, ...kept];
}

/**
 * Build the fallback {@link CompactResult} for a failed or empty AI summary, or
 * `null` when the deterministic path could not shrink the conversation (fewer
 * than four anchor groups, or the sanity check rejected the drop) — in that case
 * there is nothing safe to send less of and the caller keeps its existing array.
 */
function buildFallbackResult(messages: ChatMessage[]): CompactResult | null {
    const fallbackMessages = fallbackCompactConversation(messages);
    if (fallbackMessages.length === messages.length) return null;
    return { messages: fallbackMessages, summary: FALLBACK_SUMMARY_MARKER };
}
