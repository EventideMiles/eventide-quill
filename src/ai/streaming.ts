import { ChatChunk, type ToolCallFragment } from './provider';

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
