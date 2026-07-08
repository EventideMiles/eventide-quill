import { ChatChunk, ProviderError, type AnthropicThinkingBlockKind, type ToolCallFragment } from './provider';

/** Sentinel value emitted by OpenAI as the final SSE data line. */
const SSE_DONE_SENTINEL = '[DONE]';

/**
 * FNV-1a string hash (hex). Used to synthesize Ollama tool-call ids that are
 * deterministic for a given call but unique across separate assistant turns.
 * Not cryptographic — just a stable, well-distributed short digest.
 */
function fnv1aHex(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Extract thought/reasoning content from a text string by detecting common
 * thinking tag patterns. Currently supports:
 *   - DeepSeek R1 / local models: `<think>...</think>`
 *   - Gemma / LM Studio: `<|channel>...<channel|>`
 *
 * Returns the thought content and the cleaned text with tags removed.
 * Handles partial/incomplete tags by accumulating unclosed thought content
 * into `pendingThought`, which should be passed back on subsequent calls.
 */
export function extractThoughtContent(
    text: string,
    pendingThought?: string
): { text: string; thought: string; pendingThought: string } {
    const tagPairs: [string, string][] = [
        ['<think>', '</think>'],
        ['<|channel>', '<channel|>']
    ];

    // Whether we are inside an unclosed thought block carried over from a
    // previous chunk (pendingThought is truthy).
    let inThoughtBlock = Boolean(pendingThought);
    // Accumulated thought content from previous chunks (used only as the
    // pending state to pass forward).
    let pendingContent = pendingThought ?? '';
    // Thought content extracted in THIS chunk only (returned to caller).
    let thought = '';
    let clean = '';
    let remainder = text;

    while (remainder.length > 0) {
        if (inThoughtBlock) {
            // Inside a thought block — look for the earliest close tag
            let earliestCloseIdx = -1;
            let earliestCloseTagLen = 0;

            for (let p = 0; p < tagPairs.length; p++) {
                const [, closeTag] = tagPairs[p]!;
                const idx = remainder.indexOf(closeTag);
                if (idx !== -1 && (earliestCloseIdx === -1 || idx < earliestCloseIdx)) {
                    earliestCloseIdx = idx;
                    earliestCloseTagLen = closeTag.length;
                }
            }

            if (earliestCloseIdx !== -1) {
                // Close tag found — content before it is new thought content
                thought += remainder.slice(0, earliestCloseIdx);
                pendingContent = '';
                inThoughtBlock = false;
                remainder = remainder.slice(earliestCloseIdx + earliestCloseTagLen);
            } else {
                // No close tag yet — accumulate as pending and emit incrementally
                thought += remainder;
                pendingContent += remainder;
                remainder = '';
            }
        } else {
            // Not in a thought block — look for the earliest opening tag
            let earliestOpenIdx = -1;
            let earliestPair = 0;
            let earliestOpenTagLen = 0;

            for (let p = 0; p < tagPairs.length; p++) {
                const [openTag] = tagPairs[p]!;
                const idx = remainder.indexOf(openTag);
                if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
                    earliestOpenIdx = idx;
                    earliestPair = p;
                    earliestOpenTagLen = openTag.length;
                }
            }

            // No opening tag at all
            if (earliestOpenIdx === -1) {
                clean += remainder;
                break;
            }

            // Content before the opening tag is clean text
            if (earliestOpenIdx > 0) {
                clean += remainder.slice(0, earliestOpenIdx);
            }

            // Strip the opening tag
            const afterOpen = remainder.slice(earliestOpenIdx + earliestOpenTagLen);
            const [, closeTag] = tagPairs[earliestPair]!;
            const closeIdx = afterOpen.indexOf(closeTag);

            if (closeIdx !== -1) {
                // Complete thought block — extract inner content
                thought += afterOpen.slice(0, closeIdx);
                remainder = afterOpen.slice(closeIdx + closeTag.length);
            } else {
                // Opening tag without close — enter pending thought state
                inThoughtBlock = true;
                pendingContent = afterOpen;
                thought += afterOpen;
                remainder = '';
            }
        }
    }

    return { text: clean, thought, pendingThought: inThoughtBlock ? pendingContent : '' };
}

/** A single SSE event parsed from a stream. */
export interface SseEvent {
    data: string;
    event?: string;
    id?: string;
}

/**
 * Represents the `delta` field within an OpenAI SSE streaming choice.
 * Contains the incremental token content for the current chunk.
 */
interface Delta {
    content?: string;
    /** Reasoning / thinking content from OpenAI reasoning models (o1, o3) or compatible. */
    reasoning_content?: string;
    /** Generic thinking field used by some OpenAI-compatible providers. */
    thinking?: string;
    /**
     * Incremental tool-call fragments. OpenAI streams tool calls in pieces:
     * the first fragment for an index carries `id` and `function.name`;
     * subsequent fragments carry `function.arguments` substrings that must
     * be concatenated before JSON parsing.
     */
    tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

/**
 * Represents a single `choices[]` entry in an OpenAI SSE data payload.
 * Each choice carries a delta with incremental content and an optional
 * finish_reason that signals stream termination.
 */
interface Choice {
    delta: Delta;
    finish_reason: string | null;
}

/**
 * Token usage counters optionally included in the final OpenAI SSE event.
 * Both snake_case (API format) and camelCase (fallback) fields are accepted.
 */
interface UsageData {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/**
 * The top-level shape of a parsed OpenAI SSE `data: {...}` line.
 * Maps directly to the JSON payload sent over the SSE stream.
 */
export interface OpenAiSseData {
    choices?: Choice[];
    model?: string;
    usage?: UsageData;
}

/**
 * Shape of a single NDJSON line emitted by Ollama's `/api/chat` endpoint.
 * Each line carries an assistant message fragment and a `done` flag that
 * is `true` only for the final line in the response.
 */
interface OllamaChatLine {
    message?: {
        role?: string;
        content?: string;
        /**
         * Tool calls emitted by the model. Unlike OpenAI (which streams
         * arguments as a JSON string in fragments), Ollama emits the
         * completed tool calls as a single message with parsed argument
         * objects. We re-serialize them to JSON strings when converting
         * so the accumulator sees a uniform shape across providers.
         */
        tool_calls?: Array<{
            function: { name: string; arguments: Record<string, unknown> | string };
        }>;
    };
    done?: boolean;
    model?: string;
}

/**
 * Parse an SSE (Server-Sent Events) response body string.
 * Returns an array of parsed SseEvent objects.
 * Handles CRLF line endings and multi-line data fields.
 */
export function parseSseEvents(body: string): SseEvent[] {
    const events: SseEvent[] = [];
    let current: Partial<SseEvent> = {};
    let dataLines: string[] = [];

    for (const rawLine of body.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
        } else if (line.startsWith('event: ')) {
            current.event = line.slice(7);
        } else if (line.startsWith('id: ')) {
            current.id = line.slice(4);
        } else if (line === '' && dataLines.length > 0) {
            current.data = dataLines.join('\n');
            events.push(current as SseEvent);
            current = {};
            dataLines = [];
        }
    }

    // Push any leftover event without trailing blank line
    if (dataLines.length > 0) {
        current.data = dataLines.join('\n');
        events.push(current as SseEvent);
    }

    return events;
}

/**
 * Parse a body of NDJSON (newline-delimited JSON) lines often used by Ollama.
 * Returns an array of parsed JSON objects.
 */
export function parseNdjsonLines<T = Record<string, unknown>>(body: string): T[] {
    const lines: T[] = [];

    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
            lines.push(JSON.parse(trimmed) as T);
        } catch {
            // Skip malformed lines
            continue;
        }
    }

    return lines;
}

/**
 * Parse a single line of NDJSON and return the parsed object, or null on failure.
 */
export function parseNdjsonLine<T = Record<string, unknown>>(line: string): T | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        return null;
    }
}

/**
 * Convert an array of OpenAI-format SSE events into ChatChunk objects.
 * Handles `data: [DONE]` and intermediate `data: {...}` chunks.
 */
export function openAiEventsToChunks(events: SseEvent[]): ChatChunk[] {
    const chunks: ChatChunk[] = [];

    for (const event of events) {
        if (event.data === SSE_DONE_SENTINEL) {
            chunks.push({ text: '', done: true });
            continue;
        }

        try {
            const parsed = JSON.parse(event.data) as OpenAiSseData;
            const chunk = openAiSseDataToChunk(parsed);
            if (chunk) chunks.push(chunk);
        } catch {
            // Skip malformed JSON lines
            continue;
        }
    }

    return chunks;
}

/**
 * Convert an Ollama NDJSON chat response into ChatChunk objects.
 * Ollama sends lines like: {"message":{"role":"assistant","content":"Hello"},"done":false}
 *
 * Delegates per-line conversion to {@link ollamaNdjsonLineToChunk} so tool
 * calls are extracted uniformly across the streaming and buffered paths.
 */
export function ollamaNdjsonToChunks(lines: Record<string, unknown>[]): ChatChunk[] {
    const chunks: ChatChunk[] = lines.map((line) => ollamaNdjsonLineToChunk(line));

    // Ensure a final done chunk if the last line didn't set done.
    const last = chunks[chunks.length - 1];
    if (last && !last.done) {
        chunks.push({ text: '', done: true });
    }

    return chunks;
}

/**
 * Incremental SSE stream parser. Reads raw bytes from a ReadableStream reader,
 * splits on `\n\n` SSE boundaries, and yields fully-formed SseEvent objects as
 * they arrive.
 */
export async function* parseSseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal
): AsyncGenerator<SseEvent> {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        if (signal?.aborted) return;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on SSE boundaries; handle CRLF by stripping trailing \r
        const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
            if (!part.trim()) continue;
            const event = parseSseBlock(part);
            if (event) yield event;
        }
    }

    // Flush any remaining incomplete UTF-8 byte sequences
    decoder.decode();

    if (buffer.trim()) {
        const event = parseSseBlock(buffer);
        if (event) yield event;
    }
}

/** Parse a single SSE block (lines separated by \n, no trailing \n\n). */
function parseSseBlock(block: string): SseEvent | null {
    const event: Partial<SseEvent> = {};
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
        } else if (line.startsWith('event: ')) {
            event.event = line.slice(7);
        } else if (line.startsWith('id: ')) {
            event.id = line.slice(4);
        }
    }
    if (dataLines.length === 0) return null;
    event.data = dataLines.join('\n');
    return event as SseEvent;
}

/**
 * Incremental NDJSON stream parser. Reads raw bytes from a ReadableStream
 * reader, splits on newline boundaries, and yields fully-parsed JSON objects as
 * complete lines arrive.
 */
export async function* parseNdjsonStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        if (signal?.aborted) return;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                yield JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                continue;
            }
        }
    }

    // Flush any remaining incomplete UTF-8 byte sequences
    decoder.decode();

    const remaining = buffer.trim();
    if (remaining) {
        try {
            yield JSON.parse(remaining) as Record<string, unknown>;
        } catch {
            // Skip malformed trailing data
        }
    }
}

/**
 * Convert a single OpenAiSseData payload into a ChatChunk.
 */
export function openAiSseDataToChunk(parsed: OpenAiSseData): ChatChunk | null {
    if (!parsed.choices || parsed.choices.length === 0) return null;
    const firstChoice = parsed.choices[0];
    if (!firstChoice) return null;

    const delta = firstChoice.delta;
    const reasoning = delta?.reasoning_content ?? delta?.thinking ?? '';

    // Per the OpenAI reasoning-model spec, `reasoning_content` (or `thinking`)
    // and `content` are mutually exclusive: during the reasoning phase content
    // is empty and reasoning_content carries the chain-of-thought; during the
    // response phase content carries the answer and reasoning_content is empty.
    //
    // Some providers (notably certain LM Studio configurations) mirror the
    // reasoning into BOTH fields simultaneously. Without this guard the
    // reasoning text gets streamed into the chat response AND the reasoning
    // toggle, producing a confusing [response][reasoning][response] visual
    // where the first "response" is actually the duplicated reasoning.
    //
    // Fix: when reasoning_content is present, drop content for this chunk —
    // the reasoning is captured in `thought`, and the real response will
    // arrive in subsequent chunks where reasoning_content is absent.
    const text = reasoning ? '' : (delta?.content ?? '');

    const finishReason = firstChoice.finish_reason;

    const chunk: ChatChunk = {
        text,
        thought: reasoning || undefined,
        done: finishReason !== null && finishReason !== undefined
    };

    // Extract streamed tool-call fragments. The model emits tool_calls in
    // pieces across multiple SSE events; each piece carries an `index` used
    // by the consumer to accumulate the full call.
    if (delta?.tool_calls && delta.tool_calls.length > 0) {
        chunk.toolCalls = delta.tool_calls.map((tc) => {
            const fragment: ToolCallFragment = { index: tc.index };
            if (tc.id !== undefined) fragment.id = tc.id;
            if (tc.function?.name !== undefined) fragment.name = tc.function.name;
            if (tc.function?.arguments !== undefined) fragment.arguments = tc.function.arguments;
            return fragment;
        });
    }

    if (parsed.model) {
        chunk.model = parsed.model;
    }

    if (parsed.usage) {
        chunk.usage = {
            promptTokens: parsed.usage.prompt_tokens ?? parsed.usage.promptTokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? parsed.usage.completionTokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? parsed.usage.totalTokens ?? 0
        };
    }

    return chunk;
}

/**
 * Convert a single Ollama NDJSON line into a ChatChunk.
 */
export function ollamaNdjsonLineToChunk(raw: Record<string, unknown>): ChatChunk {
    const line = raw as unknown as OllamaChatLine;
    const message = line.message;
    const text = message?.content ?? '';
    const done = line.done === true;

    const chunk: ChatChunk = { text, done };

    // Ollama emits completed tool_calls as a single message with parsed
    // argument objects (not streamed as JSON string fragments like OpenAI).
    // Normalize to one ToolCallFragment per call with a synthesized id and
    // JSON-stringified arguments so the consumer's accumulator sees a uniform
    // shape across providers.
    if (message?.tool_calls && message.tool_calls.length > 0) {
        chunk.toolCalls = message.tool_calls.map((tc, i) => {
            const args = tc.function.arguments;
            const argsString = typeof args === 'string' ? args : JSON.stringify(args ?? {});
            // Ollama doesn't assign ids — synthesize one stable per call that
            // is unique across turns. A bare index (`ollama_call_${i}`) repeats
            // across assistant turns and collides with history kept by the
            // co-writer, confusing tool-result routing. The content hash of
            // name + arguments is deterministic for the same response and
            // varies across distinct tool-using turns; the index keeps the id
            // stable within a single response.
            const contentHash = fnv1aHex(`${tc.function.name}:${argsString}`);
            return {
                index: i,
                id: `ollama_call_${i}_${contentHash}`,
                name: tc.function.name,
                arguments: argsString
            };
        });
    }

    if (typeof line.model === 'string') {
        chunk.model = line.model;
    }

    return chunk;
}

/**
 * Process a stream of ChatChunks by extracting thought content from each chunk's text.
 * Yields the processed chunks with thought fields populated.
 * Respects abort signals by returning early if aborted.
 * @param chunks - The chunks to process (can be async iterable or array).
 * @param options - Abort signal for early termination.
 * @yields Processed ChatChunk objects with thought content extracted.
 */
export async function* processChunksWithThoughts(
    chunks: AsyncIterable<ChatChunk> | ChatChunk[],
    options?: { signal?: AbortSignal }
): AsyncGenerator<ChatChunk> {
    let pendingThought = '';
    for await (const chunk of chunks) {
        if (options?.signal?.aborted) return;
        if (chunk.text) {
            const extracted = extractThoughtContent(chunk.text, pendingThought);
            chunk.text = extracted.text;
            if (extracted.thought) {
                chunk.thought = extracted.thought;
            }
            pendingThought = extracted.pendingThought;
        }
        yield chunk;
    }
}

// ----------------------------------------------------------------------------
// Anthropic Messages API streaming
// ----------------------------------------------------------------------------
//
// Anthropic's SSE stream is event-typed: each SSE block carries both an
// `event:` line (`message_start`, `content_block_start`, `content_block_delta`,
// `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`) and
// a `data:` JSON payload whose `type` field mirrors the event name. A single
// assistant turn produces one or more content blocks — text, thinking, or
// tool_use — each opened with `content_block_start`, streamed via one or more
// `content_block_delta`s, and closed with `content_block_stop`. Thinking blocks
// also carry a `signature_delta` that must be preserved across turns when
// thinking is enabled (the model signs its reasoning so the next turn can
// verify it was not tampered with).
//
// Because the stream is stateful (each delta is prefixed by its block's
// `content_block_start`), Anthropic parsing cannot be a pure per-event
// function like {@link openAiSseDataToChunk}. The {@link AnthropicStreamAggregator}
// below is the stateful reducer that maps the event sequence onto Quill's
// stateless {@link ChatChunk} stream.

/**
 * A captured Anthropic thinking block (reasoning text + the model's signature).
 * Carried on the assistant {@link ChatMessage} so subsequent turns can replay
 * the thinking blocks alongside their tool_use blocks — required by the
 * Messages API when extended thinking is enabled with tool use. Other
 * providers ignore the field. The canonical type lives in {@link ./provider};
 * re-exported here for back-compat with existing imports.
 */
export type { AnthropicThinkingBlock, AnthropicRedactedThinkingBlock } from './provider';

/** Discriminator for the in-flight content block the aggregator is tracking. */
type AnthropicBlockType = 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';

/**
 * Stateful reducer that converts an Anthropic SSE event sequence into a stream
 * of provider-agnostic {@link ChatChunk}s. Create one per response stream and
 * feed it each parsed SSE event via {@link processEvent}; the same instance
 * works for both desktop streaming and the buffered mobile fallback.
 *
 * Mapping:
 * - `text_delta`           → `chunk.text`
 * - `thinking_delta`       → `chunk.thought`
 * - `signature_delta`      → captured into the current thinking block's signature buffer (no chunk emitted)
 * - `input_json_delta`     → appended to the current tool_use's arguments buffer; emitted as a `ToolCallFragment`
 * - `message_start`        → emits nothing (input usage is exposed via `usage` if present)
 * - `content_block_start`  → records the next block's type and (for tool_use) its id + name; for tool_use, emits the leading ToolCallFragment carrying id + name
 * - `content_block_stop`   → closes the current block; if it was a thinking block, the captured thinking + signature are queued on {@link finishedThinking} for the consumer to stamp on the assistant message
 * - `message_delta`        → emits a chunk with `done:true` and any usage figures carried by the delta
 * - `message_stop`         → emits the terminal chunk (no body)
 * - `error`                → throws a synthetic Error carrying Anthropic's error message
 */
export class AnthropicStreamAggregator {
    /** The type of the block currently being streamed (null between blocks). */
    private blockType: AnthropicBlockType | null = null;
    /** The Anthropic content-block index of the current block. */
    private blockIndex = -1;
    /**
     * The Quill tool-call index (only incremented for `tool_use` blocks).
     * Text/thinking blocks do not consume a tool-call slot.
     */
    private toolCallIndex = -1;
    /** Pending id for the current tool_use block, if any. */
    private currentToolCallId: string | undefined;
    /** Pending name for the current tool_use block, if any. */
    private currentToolCallName: string | undefined;
    /** Accumulated thinking text for the current thinking block, if any. */
    private currentThinkingText = '';
    /** Accumulated signature for the current thinking block, if any. */
    private currentThinkingSignature = '';
    /** Opaque `data` blob for the current redacted_thinking block, if any. */
    private currentRedactedData: string | undefined;
    /** Completed thinking blocks for this assistant turn, in order. */
    private readonly thinkingBlocks: AnthropicThinkingBlockKind[] = [];

    /**
     * Read-only access to the thinking blocks captured during this stream.
     * Tool-loop consumers stamp these onto the assistant {@link ChatMessage}
     * so subsequent turns replay them with tool_use blocks.
     */
    get finishedThinking(): readonly AnthropicThinkingBlockKind[] {
        return this.thinkingBlocks;
    }

    /**
     * Attach captured thinking blocks to a terminal chunk so tool-loop
     * consumers can stamp them onto the assistant message they append. Called
     * on both `message_delta` (the first `done` chunk most consumers break on)
     * and `message_stop` (the absolute terminal) so every consumer sees them
     * regardless of which done chunk it breaks on. Thinking blocks are always
     * complete by the time either event arrives (all `content_block_stop`
     * events precede `message_delta`).
     */
    private withThinkingBlocks(chunk: ChatChunk): ChatChunk {
        if (this.thinkingBlocks.length > 0) {
            chunk.thinkingBlocks = this.thinkingBlocks.map((b) => ({ ...b }));
        }
        return chunk;
    }

    /**
     * Process one SSE event and return zero or more ChatChunks to forward
     * downstream. Throws if the event is an Anthropic error event.
     */
    processEvent(event: SseEvent): ChatChunk[] {
        // Anthropic events always carry JSON data; ignore anything that doesn't.
        if (!event.data) return [];
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
            return [];
        }

        const type = (parsed.type as string | undefined) ?? event.event;
        switch (type) {
            case 'message_start': {
                // Carry input usage if Anthropic included it (lets the token
                // indicator reflect input cost even on stream cancellation).
                const message = parsed.message as
                    | { usage?: { input_tokens?: number; output_tokens?: number } }
                    | undefined;
                const usage = message?.usage;
                if (usage && typeof usage.input_tokens === 'number') {
                    return [
                        {
                            text: '',
                            done: false,
                            usage: {
                                promptTokens: usage.input_tokens,
                                completionTokens: usage.output_tokens ?? 0,
                                totalTokens: usage.input_tokens + (usage.output_tokens ?? 0)
                            }
                        }
                    ];
                }
                return [];
            }
            case 'content_block_start': {
                const idx = parsed.index as number;
                const block = parsed.content_block as
                    | { type?: string; id?: string; name?: string; text?: string; data?: string }
                    | undefined;
                this.blockIndex = idx;
                this.currentToolCallId = undefined;
                this.currentToolCallName = undefined;
                this.currentThinkingText = '';
                this.currentThinkingSignature = '';
                this.currentRedactedData = undefined;
                if (block?.type === 'text') {
                    this.blockType = 'text';
                    // Anthropic seeds the first delta inside content_block_start.text;
                    // emit it immediately if non-empty so streaming feels instant.
                    if (typeof block.text === 'string' && block.text.length > 0) {
                        return [{ text: block.text, done: false }];
                    }
                    return [];
                }
                if (block?.type === 'thinking') {
                    this.blockType = 'thinking';
                    return [];
                }
                if (block?.type === 'redacted_thinking') {
                    // Redacted blocks carry an opaque `data` blob (no deltas
                    // follow). Capture it here so content_block_stop can queue
                    // the block for replay verbatim on subsequent turns.
                    this.blockType = 'redacted_thinking';
                    this.currentRedactedData = typeof block.data === 'string' ? block.data : '';
                    return [];
                }
                if (block?.type === 'tool_use') {
                    this.blockType = 'tool_use';
                    this.toolCallIndex += 1;
                    this.currentToolCallId = block.id;
                    this.currentToolCallName = block.name;
                    // Emit the leading fragment carrying id + name so the
                    // accumulator can register the call before any argument
                    // deltas arrive. Initial arguments string is empty.
                    return [
                        {
                            text: '',
                            done: false,
                            toolCalls: [
                                {
                                    index: this.toolCallIndex,
                                    id: block.id,
                                    name: block.name,
                                    arguments: ''
                                }
                            ]
                        }
                    ];
                }
                return [];
            }
            case 'content_block_delta': {
                const delta = parsed.delta as
                    | {
                          type?: string;
                          text?: string;
                          thinking?: string;
                          signature?: string;
                          partial_json?: string;
                      }
                    | undefined;
                if (!delta) return [];
                switch (delta.type) {
                    case 'text_delta':
                        return [{ text: delta.text ?? '', done: false }];
                    case 'thinking_delta':
                        this.currentThinkingText += delta.thinking ?? '';
                        return [{ text: '', done: false, thought: delta.thinking ?? '' }];
                    case 'signature_delta':
                        // Signatures stream incrementally too — accumulate, no chunk.
                        this.currentThinkingSignature += delta.signature ?? '';
                        return [];
                    case 'input_json_delta':
                        return [
                            {
                                text: '',
                                done: false,
                                toolCalls: [
                                    {
                                        index: this.toolCallIndex,
                                        arguments: delta.partial_json ?? ''
                                    }
                                ]
                            }
                        ];
                    default:
                        return [];
                }
            }
            case 'content_block_stop': {
                // Close the current block. Thinking AND redacted_thinking
                // blocks are queued for the consumer to persist — Anthropic
                // requires both to be replayed verbatim alongside their
                // sibling tool_use blocks on subsequent turns.
                if (this.blockType === 'thinking' && this.currentThinkingText) {
                    this.thinkingBlocks.push({
                        thinking: this.currentThinkingText,
                        signature: this.currentThinkingSignature
                    });
                } else if (this.blockType === 'redacted_thinking' && this.currentRedactedData !== undefined) {
                    this.thinkingBlocks.push({ data: this.currentRedactedData });
                }
                this.blockType = null;
                this.blockIndex = -1;
                this.currentRedactedData = undefined;
                return [];
            }
            case 'message_delta': {
                const delta = parsed.delta as { stop_reason?: string | null } | undefined;
                const usage = parsed.usage as { output_tokens?: number } | undefined;
                const stopReason = delta?.stop_reason;
                const chunk: ChatChunk = {
                    text: '',
                    done: stopReason !== null && stopReason !== undefined
                };
                if (usage && typeof usage.output_tokens === 'number') {
                    chunk.usage = {
                        // completionTokens alone — input_tokens was emitted in message_start.
                        // totalTokens is recomposed downstream if message_start was seen.
                        promptTokens: 0,
                        completionTokens: usage.output_tokens,
                        totalTokens: usage.output_tokens
                    };
                }
                // Stamp thinking blocks onto the terminal chunk so tool-loop
                // consumers (which typically break on this first `done` chunk)
                // capture them and replay them on the next round.
                return [this.withThinkingBlocks(chunk)];
            }
            case 'message_stop':
                return [this.withThinkingBlocks({ text: '', done: true })];
            case 'ping':
                return [];
            case 'error': {
                const err = parsed.error as { message?: string; type?: string } | undefined;
                const msg = err?.message ?? 'Anthropic stream error';
                // Throw the same typed error class the Gemini path uses so
                // downstream `instanceof ProviderError` checks work uniformly.
                // The raw payload is preserved on `body` for diagnostics.
                throw new ProviderError(msg, 0, event.data);
            }
            default:
                return [];
        }
    }
}

/**
 * Convenience wrapper: feed an array of parsed SSE events through a fresh
 * {@link AnthropicStreamAggregator} and return the flattened ChatChunk list.
 * Mirrors {@link openAiEventsToChunks} for the buffered mobile path.
 */
export function anthropicEventsToChunks(events: SseEvent[]): ChatChunk[] {
    const agg = new AnthropicStreamAggregator();
    const out: ChatChunk[] = [];
    for (const event of events) {
        out.push(...agg.processEvent(event));
    }
    if (out.length === 0 || !out[out.length - 1]!.done) {
        out.push({ text: '', done: true });
    }
    return out;
}

// ----------------------------------------------------------------------------
// Gemini GenerateContent API streaming
// ----------------------------------------------------------------------------
//
// Gemini's `streamGenerateContent?alt=sse` endpoint emits SSE blocks with
// `data: {...}` lines (no `event:` field), each carrying a full or partial
// `GenerateContentResponse`:
//
//   { "candidates": [ { "content": { "role": "model", "parts": [
//                        { "text": "..." } | { "functionCall": {...} } |
//                        { "inlineData": {...} }
//                      ] }, "finishReason": "STOP", "safetyRatings": [...] } ],
//     "usageMetadata": { "promptTokenCount": N, "candidatesTokenCount": N,
//                        "totalTokenCount": N } }
//
// Unlike Anthropic/OpenAI, Gemini emits fully-formed function calls (not
// streamed fragments) — we synthesize one ToolCallFragment per call. The
// `finishReason` field surfaces safety-filter blocks; the Gemini provider
// detects `SAFETY`/`RECITATION`/`BLOCKLIST` and throws a clear ProviderError.

/** Shape of a single Gemini `candidates[].content.parts[]` entry. */
interface GeminiPart {
    text?: string;
    functionCall?: { name: string; args?: Record<string, unknown> };
    functionResponse?: { name: string; response?: Record<string, unknown> };
    inlineData?: { mimeType?: string; data?: string };
}

/** Shape of a single Gemini `candidates[]` entry. */
interface GeminiCandidate {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string | null;
    safetyRatings?: Array<{ category?: string; probability?: string }>;
}

/** Top-level shape of a Gemini `streamGenerateContent` SSE data line. */
export interface GeminiSseData {
    candidates?: GeminiCandidate[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
    };
}

/** Finish-reason values that indicate Gemini refused to produce output. */
const GEMINI_BLOCKING_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

/** promptFeedback.blockReason values that mean the prompt was refused. */
const GEMINI_BLOCKING_PROMPT_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

/**
 * Convert a single Gemini SSE data payload into a ChatChunk.
 *
 * Returns `null` when the payload carries no usable content (a bare ping,
 * an empty candidates array, or a candidates entry with no parts). The
 * Gemini provider is responsible for surfacing safety-filter blocks as a
 * ProviderError — this helper sets `done:true` on any non-empty finishReason
 * but does not throw, so the caller can decide how to frame the failure.
 */
export function geminiSseDataToChunk(parsed: GeminiSseData): ChatChunk | null {
    // Prompt-level block — no candidates were ever produced.
    if (parsed.promptFeedback?.blockReason && GEMINI_BLOCKING_PROMPT_REASONS.has(parsed.promptFeedback.blockReason)) {
        return {
            text: '',
            done: true
        };
    }

    if (!parsed.candidates || parsed.candidates.length === 0) return null;
    const candidate = parsed.candidates[0];
    if (!candidate) return null;

    const parts = candidate.content?.parts ?? [];
    const chunk: ChatChunk = {
        text: '',
        done: candidate.finishReason !== null && candidate.finishReason !== undefined
    };

    const toolCalls: ToolCallFragment[] = [];
    let thought = '';
    for (const part of parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
            chunk.text += part.text;
        }
        if (part.functionCall) {
            // Gemini emits the args as a parsed object; re-serialize to match
            // Quill's arguments-are-a-JSON-string contract. Stable key order
            // makes the resulting id deterministic across stream replays.
            const argsString = JSON.stringify(part.functionCall.args ?? {});
            toolCalls.push({
                index: toolCalls.length,
                name: part.functionCall.name,
                arguments: argsString
            });
        }
        // Gemini does not surface a separate thinking field today; if future
        // models emit a "thought" part we accumulate it here for forward-compat.
        const maybeThought = (part as unknown as { thought?: string; thoughtText?: string }).thought;
        if (typeof maybeThought === 'string') thought += maybeThought;
    }

    if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
    if (thought) chunk.thought = thought;

    if (parsed.usageMetadata) {
        const promptTokens = parsed.usageMetadata.promptTokenCount ?? 0;
        const completionTokens = parsed.usageMetadata.candidatesTokenCount ?? 0;
        chunk.usage = {
            promptTokens,
            completionTokens,
            totalTokens: parsed.usageMetadata.totalTokenCount ?? promptTokens + completionTokens
        };
    }

    return chunk;
}

/**
 * Returns true when a Gemini SSE payload indicates the response was blocked
 * by a safety filter (either at the prompt or candidate stage). The provider
 * uses this to throw a clear ProviderError rather than emitting empty text.
 */
export function geminiResponseBlocked(parsed: GeminiSseData): boolean {
    if (parsed.promptFeedback?.blockReason && GEMINI_BLOCKING_PROMPT_REASONS.has(parsed.promptFeedback.blockReason)) {
        return true;
    }
    const candidate = parsed.candidates?.[0];
    if (candidate?.finishReason && GEMINI_BLOCKING_FINISH_REASONS.has(candidate.finishReason)) {
        return true;
    }
    return false;
}

/**
 * Convert an array of Gemini SSE data payloads into ChatChunks. Mirrors
 * {@link openAiEventsToChunks} for the buffered mobile path. The Gemini
 * stream has no `[DONE]` sentinel — termination is signalled by `finishReason`
 * on the final data line, so we always append a final done chunk defensively
 * if the last payload didn't set one.
 */
export function geminiEventsToChunks(payloads: GeminiSseData[]): ChatChunk[] {
    const chunks: ChatChunk[] = [];
    for (const payload of payloads) {
        const chunk = geminiSseDataToChunk(payload);
        if (chunk) chunks.push(chunk);
    }
    const last = chunks[chunks.length - 1];
    if (!last || !last.done) {
        chunks.push({ text: '', done: true });
    }
    return chunks;
}
