import {
    type AiProvider,
    type AnthropicThinkingBlockKind,
    type ChatChunk,
    type ChatMessage,
    type ToolCallRequest,
    type ToolDefinition
} from './provider';

/** Finish reasons that mean the model hit the output-token cap mid-response. */
export const TRUNCATION_FINISH_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);
/** Cap on auto-continue rounds so a runaway model cannot loop forever. */
export const MAX_CONTINUE_ROUNDS = 3;
/** Nudge sent to resume a truncated response: resume mid-sentence, no preamble/repeat. */
export const CONTINUE_NUDGE =
    'Continue exactly where your previous message left off. Resume the text mid-sentence — ' +
    'do not repeat any text, do not acknowledge, and do not add a heading or an apology.';

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
                    roundResponse = '';
                    // Only clear the accumulated response + display on the first
                    // round (the draft-before-thought pattern). On a continuation
                    // round the accumulated text is real prose from a prior
                    // truncated round — wiping it would lose the writer's output.
                    if (continueRounds === 0) {
                        response = '';
                        callbacks.onClear();
                    }
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

/**
 * Wrap a review/streaming path with max_tokens auto-continue. Text from
 * continuation rounds splices into the same stream transparently — the
 * consumer's for-await loop + done handler need no changes.
 *
 * On truncation (finish reason `length` / `max_tokens` / `MAX_TOKENS`), the
 * wrapper appends the round's output + a resume nudge to the messages and calls
 * `createStream` again, up to {@link MAX_CONTINUE_ROUNDS} times. The consumer
 * sees one continuous stream with a single done chunk at the end carrying the
 * final finish reason.
 *
 * @param createStream  A callback that builds a fresh provider stream from a
 *                      message array (e.g. `(msgs) => getFeedback(provider,
 *                      persona, { ..., existingMessages: msgs })`).
 * @param initialMessages  The base messages for the first round.
 * @param maxRounds    Cap on continuation rounds (default {@link MAX_CONTINUE_ROUNDS}).
 */
export async function* continueReviewStream(
    createStream: (messages: ChatMessage[]) => AsyncGenerator<ChatChunk>,
    initialMessages: ChatMessage[],
    maxRounds: number = MAX_CONTINUE_ROUNDS
): AsyncGenerator<ChatChunk> {
    let messages = initialMessages;
    let roundResponse = '';
    for (let round = 0; round <= maxRounds; round++) {
        let roundFinishReason: string | undefined;
        const stream = createStream(messages);
        for await (const chunk of stream) {
            if (chunk.done) {
                roundFinishReason = chunk.finishReason;
                break;
            }
            if (chunk.text) roundResponse += chunk.text;
            yield chunk;
        }
        // Continue only when truncated AND within the bound.
        if (!roundFinishReason || !TRUNCATION_FINISH_REASONS.has(roundFinishReason) || round >= maxRounds) {
            yield { text: '', done: true, finishReason: roundFinishReason };
            return;
        }
        // Append this round's output + a resume nudge for the next round.
        messages = [
            ...messages,
            { role: 'assistant', content: roundResponse },
            { role: 'user', content: CONTINUE_NUDGE }
        ];
        roundResponse = '';
    }
}
