import { ChatChunk } from './provider';

/** A single SSE event parsed from a stream. */
export interface SseEvent {
    data: string;
    event?: string;
    id?: string;
}

/** Shape of an OpenAI-format SSE data line choices[0].delta object. */
interface Delta {
    content?: string;
}

/** Shape of an OpenAI-format SSE data line choices[0] object. */
interface Choice {
    delta: Delta;
    finish_reason: string | null;
}

/** Shape of the usage object in OpenAI SSE data. */
interface UsageData {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/** Shape of a parsed OpenAI SSE data line. */
interface OpenAiSseData {
    choices?: Choice[];
    model?: string;
    usage?: UsageData;
}

/** Shape of an Ollama NDJSON line for chat responses. */
interface OllamaChatLine {
    message?: {
        role?: string;
        content?: string;
    };
    done?: boolean;
    model?: string;
}

/**
 * Parse an SSE (Server-Sent Events) response body string.
 * Returns an array of parsed SseEvent objects.
 */
export function parseSseEvents(body: string): SseEvent[] {
    const events: SseEvent[] = [];
    let current: Partial<SseEvent> = {};

    for (const line of body.split('\n')) {
        if (line.startsWith('data: ')) {
            current.data = line.slice(6);
        } else if (line.startsWith('event: ')) {
            current.event = line.slice(7);
        } else if (line.startsWith('id: ')) {
            current.id = line.slice(4);
        } else if (line === '' && current.data !== undefined) {
            events.push(current as SseEvent);
            current = {};
        }
    }

    // Push any leftover event without trailing blank line
    if (current.data !== undefined) {
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
        if (event.data === '[DONE]') {
            chunks.push({ text: '', done: true });
            continue;
        }

        try {
            const parsed = JSON.parse(event.data) as OpenAiSseData;
            if (!parsed.choices || parsed.choices.length === 0) continue;

            const firstChoice = parsed.choices[0];
            if (!firstChoice) continue;

            const delta = firstChoice.delta;
            const text = delta?.content ?? '';
            const finishReason = firstChoice.finish_reason;

            const chunk: ChatChunk = {
                text,
                done: finishReason === 'stop' || finishReason === 'length' || finishReason === null || finishReason === undefined,
            };

            if (parsed.model) {
                chunk.model = parsed.model;
            }

            if (parsed.usage) {
                chunk.usage = {
                    promptTokens: parsed.usage.prompt_tokens ?? parsed.usage.promptTokens ?? 0,
                    completionTokens: parsed.usage.completion_tokens ?? parsed.usage.completionTokens ?? 0,
                    totalTokens: parsed.usage.total_tokens ?? parsed.usage.totalTokens ?? 0,
                };
            }

            chunks.push(chunk);
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
 */
export function ollamaNdjsonToChunks(lines: Record<string, unknown>[]): ChatChunk[] {
    const chunks: ChatChunk[] = [];

    for (const rawLine of lines) {
        const line = rawLine as unknown as OllamaChatLine;
        const message = line.message;
        const text = message?.content ?? '';
        const done = line.done === true;

        const chunk: ChatChunk = {
            text,
            done,
        };

        if (typeof line.model === 'string') {
            chunk.model = line.model;
        }

        chunks.push(chunk);
    }

    // Ensure a final done chunk if the last line didn't set done
    const last = chunks[chunks.length - 1];
    if (last && !last.done) {
        chunks.push({ text: '', done: true });
    }

    return chunks;
}
