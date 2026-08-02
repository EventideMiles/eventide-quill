import {
    type AiProvider,
    type AnthropicThinkingBlockKind,
    type ChatMessage,
    type ToolCallRequest,
    type ToolDefinition
} from './provider';

/** Finish reasons that mean the model hit the output-token cap mid-response. */
const TRUNCATION_FINISH_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
/** Cap on auto-continue rounds so a runaway model cannot loop forever. */
const MAX_CONTINUE_ROUNDS = 3;
/** Nudge sent to resume a truncated response: resume mid-sentence, no preamble/repeat. */
const CONTINUE_NUDGE =
    'Continue exactly where your previous message left off. Resume the text mid-sentence — do not repeat any text, do not acknowledge, and do not add a heading or an apology.';

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
    finishReason?: string;
}> {
    let response = '';
    let thought = '';
    let sawReasoning = false;
    let thinkingBlocks: AnthropicThinkingBlockKind[] | undefined;
    let finishReason: string | undefined;
    let messages = options.messages;
    const toolDefs = options.tools;
    let continueRounds = 0;

    for (;;) {
        // Per-round accumulators. `response`/`thought` accumulate across
        // continuation rounds (the displayed text + returned reasoning are the
        // union); `roundResponse` is this round's output only, used as the
        // assistant message when nudging the model to continue.
        let roundResponse = '';
        let roundSawReasoning = sawReasoning;
        let roundThinkingBlocks: AnthropicThinkingBlockKind[] | undefined;
        let roundFinishReason: string | undefined;
        const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();

        const stream = provider.chatCompletion({
            messages,
            model: options.model,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            signal: options.signal,
            tools: toolDefs,
            toolChoice: toolDefs && toolDefs.length > 0 ? 'auto' : undefined
        });

        for await (const chunk of stream) {
            if (chunk.done) {
                // Capture Anthropic thinking blocks carried on the terminal
                // chunk so the caller can stamp them onto the assistant message
                // (required for extended-thinking + tool-use replay).
                if (chunk.thinkingBlocks) roundThinkingBlocks = chunk.thinkingBlocks;
                if (chunk.finishReason) roundFinishReason = chunk.finishReason;
                break;
            }

            if (chunk.thought) {
                if (!roundSawReasoning) {
                    roundSawReasoning = true;
                    sawReasoning = true;
                    response = '';
                    roundResponse = '';
                    callbacks.onClear();
                }
                thought += chunk.thought;
                callbacks.onThoughtChange(thought);
            }

            if (chunk.text) {
                roundResponse += chunk.text;
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

        // Auto-continue when the round was truncated by the output-token cap
        // (`length` / `max_tokens` / `MAX_TOKENS`) AND produced no tool calls
        // — a tool round is the caller's job to loop on, and a truncated tool
        // call is a different failure. Append this round's output + a resume
        // nudge and stream again; onChunk keeps splicing the continuation into
        // the same chat bubble. Bounded so a runaway model cannot loop forever.
        const truncated = !!roundFinishReason && TRUNCATION_FINISH_REASONS.has(roundFinishReason);
        if (toolCalls.length === 0 && truncated && continueRounds < MAX_CONTINUE_ROUNDS) {
            continueRounds++;
            finishReason = roundFinishReason;
            thinkingBlocks = roundThinkingBlocks ?? thinkingBlocks;
            messages = [
                ...messages,
                {
                    role: 'assistant',
                    content: roundResponse,
                    ...(roundThinkingBlocks ? { thinkingBlocks: roundThinkingBlocks } : {})
                },
                { role: 'user', content: CONTINUE_NUDGE }
            ];
            continue;
        }

        finishReason = roundFinishReason ?? finishReason;
        thinkingBlocks = roundThinkingBlocks ?? thinkingBlocks;
        // Reasoning-model fallback: if the model put its output in the thinking
        // channel — it opened a <think> block and never closed it, or placed its
        // whole answer inside thinking tags — the visible response would be
        // empty and the writer sees a blank bubble. Promote the thought so the
        // model's output shows. This only fires when no content text was
        // produced, so it never discards real response content.
        if (response.trim().length === 0 && thought.trim().length > 0) {
            response = thought;
            thought = '';
        }
        return { response, thought, toolCalls, thinkingBlocks, finishReason };
    }
}
