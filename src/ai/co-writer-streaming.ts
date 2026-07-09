import {
    type AiProvider,
    type AnthropicThinkingBlockKind,
    type ChatMessage,
    type ToolCallRequest,
    type ToolDefinition
} from './provider';

/**
 * Callbacks for {@link streamToolAwareRound}. The caller owns session state
 * (e.g. the thought buffer) and updates it inside these callbacks — the
 * streaming helper itself is stateless beyond one round's accumulators.
 */
export interface StreamRoundCallbacks {
    onChunk: (text: string) => void;
    onThoughtChange: (thought: string) => void;
    onClear: () => void;
}

/**
 * Stream one round of chat completion with tool-call fragment accumulation.
 *
 * Handles text + thought streaming, the reasoning-clear-on-first-thought
 * pattern (discards draft text emitted before `<think>`), and tool-call
 * fragment accumulation. Does NOT handle multi-round looping, chat history, or
 * tool execution — the caller orchestrates those.
 *
 * Extracted from `CoWriterSession` so all three co-writer modes (discuss,
 * coach, lorebook) share one implementation. Previously the lorebook mode
 * inlined a character-for-character duplicate.
 *
 * @returns Accumulated response text, thought, and materialized tool calls.
 */
export async function streamToolAwareRound(
    provider: AiProvider,
    options: {
        messages: ChatMessage[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
        tools?: ToolDefinition[];
    },
    callbacks: StreamRoundCallbacks
): Promise<{
    response: string;
    thought: string;
    toolCalls: ToolCallRequest[];
    thinkingBlocks?: AnthropicThinkingBlockKind[];
}> {
    let response = '';
    let thought = '';
    let sawReasoning = false;
    let thinkingBlocks: AnthropicThinkingBlockKind[] | undefined;
    const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();

    const stream = provider.chatCompletion({
        ...options,
        toolChoice: options.tools && options.tools.length > 0 ? 'auto' : undefined
    });

    for await (const chunk of stream) {
        if (chunk.done) {
            // Capture Anthropic thinking blocks carried on the terminal
            // chunk so the caller can stamp them onto the assistant message
            // (required for extended-thinking + tool-use replay).
            if (chunk.thinkingBlocks) thinkingBlocks = chunk.thinkingBlocks;
            break;
        }

        if (chunk.thought) {
            if (!sawReasoning) {
                sawReasoning = true;
                response = '';
                callbacks.onClear();
            }
            thought += chunk.thought;
            callbacks.onThoughtChange(thought);
        }

        if (chunk.text) {
            response += chunk.text;
            callbacks.onChunk(chunk.text);
        }

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

    const toolCalls: ToolCallRequest[] = [...fragmentBuffer.entries()]
        .sort(([a], [b]) => a - b)
        .map(([idx, acc]) => ({
            id: acc.id ?? `call_${idx}`,
            name: acc.name ?? '',
            arguments: acc.arguments
        }));

    return { response, thought, toolCalls, thinkingBlocks };
}
