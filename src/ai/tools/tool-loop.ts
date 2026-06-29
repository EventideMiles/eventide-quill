import type { AiProvider, ChatChunk, ChatMessage, ToolCallRequest } from '../provider';
import { executeToolCall, type ToolContext, type ToolRegistry } from './tool';
import { injectImagesIntoMessages } from '../vision';

/**
 * Maximum number of tool rounds before the loop forces a final response. A
 * "round" is one model completion possibly containing tool calls plus the
 * execution of those tools. Five rounds means the model can call up to five
 * sequential batches of tools; after that, one more completion runs with
 * `toolChoice: 'none'` so the model answers using the tool results rather
 * than being cut off mid-thought.
 *
 * High enough to support a real research-and-draft flow (gather context
 * across multiple sources, then draft) but low enough to prevent runaway
 * loops if the model gets stuck calling tools without producing output.
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * Wrap a provider's chat completion stream with native tool-call support.
 *
 * Attaches the registry's tool definitions to the request when present, then
 * consumes the streamed response. If the model emits `tool_calls`, this loop:
 *   1. Accumulates the streamed fragments by index into complete calls.
 *   2. Appends an assistant message carrying the parsed `tool_calls` to the
 *      conversation (so the model sees its prior tool invocations on the
 *      next round).
 *   3. Executes each tool and appends a `role: 'tool'` result message.
 *   4. Starts a new completion with the extended messages.
 *
 * To the consumer this looks like one continuous stream: intermediate
 * `done: true` chunks are suppressed; only the final round's done chunk
 * (when the model produces no tool calls) reaches the caller. Tool-call
 * fragments never reach the consumer — they're accumulated internally.
 *
 * The `options.messages` array is treated as read-only — a shallow clone is
 * made internally and the original is not mutated. Tool call / result
 * messages accumulate on the internal clone only.
 *
 * If the registry is empty, this is a transparent passthrough — useful so
 * callers can wrap unconditionally without branching on tool availability.
 *
 * @param provider  The AI provider to call.
 * @param options   The base chat options (messages, model, temperature, etc.).
 * @param registry  Tool registry; if empty, behaves as a plain passthrough.
 * @param ctx       Tool execution context (plugin, abort signal).
 * @param maxRounds Optional override for the round cap (defaults to 5).
 */
export async function* streamWithTools(
    provider: AiProvider,
    options: {
        messages: ChatMessage[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    },
    registry: ToolRegistry,
    ctx: ToolContext,
    maxRounds: number = MAX_TOOL_ROUNDS
): AsyncGenerator<ChatChunk> {
    const tools = registry.toToolDefinitions();
    if (tools.length === 0) {
        // Empty registry — no tools to send; plain passthrough.
        yield* provider.chatCompletion(options);
        return;
    }

    const messages: ChatMessage[] = [...options.messages];
    let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    let lastModel: string | undefined;

    for (let round = 0; round <= maxRounds; round++) {
        // After the last allowed tool round, run one forced final pass
        // (toolChoice: 'none') so the model can answer using the tool results
        // instead of being cut off mid-thought by the round cap.
        const forceFinal = round === maxRounds;
        const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();
        let assistantText = '';

        const stream = provider.chatCompletion({
            ...options,
            messages,
            tools,
            toolChoice: forceFinal ? 'none' : 'auto'
        });

        for await (const chunk of stream) {
            if (chunk.usage) lastUsage = chunk.usage;
            if (chunk.model) lastModel = chunk.model;

            if (chunk.text) {
                assistantText += chunk.text;
                const yieldChunk: ChatChunk = { text: chunk.text, done: false };
                if (chunk.thought) yieldChunk.thought = chunk.thought;
                if (chunk.model) yieldChunk.model = chunk.model;
                yield yieldChunk;
            } else if (chunk.thought) {
                // Thought-only chunk (no text) — pass through so the reasoning
                // indicator updates even when the model isn't producing prose.
                yield { text: '', thought: chunk.thought, done: false };
            }

            // Accumulate tool-call fragments by index. The first fragment for
            // an index carries id + name; subsequent fragments carry argument
            // substrings that must be concatenated before JSON parsing.
            if (chunk.toolCalls) {
                for (const frag of chunk.toolCalls) {
                    const existing = fragmentBuffer.get(frag.index);
                    if (existing) {
                        if (frag.id !== undefined) existing.id = frag.id;
                        if (frag.name !== undefined) existing.name = frag.name;
                        if (frag.arguments !== undefined) existing.arguments += frag.arguments;
                    } else {
                        fragmentBuffer.set(frag.index, {
                            id: frag.id,
                            name: frag.name,
                            arguments: frag.arguments ?? ''
                        });
                    }
                }
            }
        }

        // Either the model produced no tool calls (its response is final), or
        // this was the forced final pass after the round cap. toolChoice:
        // 'none' normally prevents tool calls, but guard against models that
        // ignore it so we never execute past the allowed round budget.
        if (fragmentBuffer.size === 0 || forceFinal) {
            const doneChunk: ChatChunk = { text: '', done: true };
            if (lastModel) doneChunk.model = lastModel;
            if (lastUsage) doneChunk.usage = lastUsage;
            yield doneChunk;
            return;
        }

        // Materialize accumulated fragments into complete tool-call requests.
        // Sort by index so the order is stable across providers.
        const toolCalls: ToolCallRequest[] = [...fragmentBuffer.entries()]
            .sort(([a], [b]) => a - b)
            .map(([idx, acc], i) => ({
                // Fall back to a synthetic id if the provider didn't assign one
                // (Ollama doesn't always provide ids; OpenAI always does).
                id: acc.id ?? `call_${idx}`,
                name: acc.name ?? '',
                arguments: acc.arguments
            }));

        // Append the assistant's turn (text + tool_calls) so the model sees
        // its own prior tool invocations in conversation history on the next
        // round. OpenAI requires this; Ollama accepts it.
        const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: assistantText,
            toolCalls
        };
        messages.push(assistantMessage);

        // Execute each tool and append a result message. Execution happens
        // sequentially to preserve order and avoid concurrent vault access.
        // Images returned by a tool are collected and injected once after all
        // tool results, so message ordering stays valid (assistant tool_calls
        // → tool results → user image message → assistant).
        const collectedImages: string[] = [];
        for (const call of toolCalls) {
            const result = await executeToolCall(call, registry, ctx);
            messages.push({
                role: 'tool',
                content: result.text,
                toolCallId: call.id,
                name: call.name
            });
            if (result.images && result.images.length > 0) {
                collectedImages.push(...result.images);
            }
        }

        // After all tool results for this round, route any collected images
        // through the vision layer. Native: attach as image content. Proxy:
        // translate to a text caption. Either way the model receives the image
        // information as a user turn before it continues.
        await injectImagesIntoMessages(ctx.plugin, collectedImages, messages, options.signal);
        // Loop continues: a new completion starts with the extended messages.
    }

    // Defensive fallback: only reachable if maxRounds <= 0 (the loop body
    // otherwise always returns on its forced final pass).
    const doneChunk: ChatChunk = { text: '', done: true };
    if (lastModel) doneChunk.model = lastModel;
    if (lastUsage) doneChunk.usage = lastUsage;
    yield doneChunk;
}
