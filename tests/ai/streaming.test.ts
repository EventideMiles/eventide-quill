import { describe, it, expect } from 'vitest';
import {
    extractThoughtContent,
    parseSseEvents,
    parseNdjsonLines,
    openAiSseDataToChunk,
    ollamaNdjsonLineToChunk,
    parseSseStream,
    parseNdjsonStream
} from '../../src/ai/streaming';
import type { OpenAiSseData } from '../../src/ai/streaming';

/** Build a ReadableStream from string chunks for async-generator tests. */
function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const ch of chunks) {
                controller.enqueue(enc.encode(ch));
            }
            controller.close();
        }
    });
}

describe('extractThoughtContent', () => {
    it('passes through text with no thought tags', () => {
        const result = extractThoughtContent('hello world');
        expect(result.text).toBe('hello world');
        expect(result.thought).toBe('');
        expect(result.pendingThought).toBe('');
    });

    it('extracts a complete <think> block', () => {
        const result = extractThoughtContent('before<think>secret</think>after');
        expect(result.text).toBe('beforeafter');
        expect(result.thought).toBe('secret');
        expect(result.pendingThought).toBe('');
    });

    it('extracts a complete <|channel> block', () => {
        const result = extractThoughtContent('text<|channel>reasoning<channel|>more');
        expect(result.text).toBe('textmore');
        expect(result.thought).toBe('reasoning');
    });

    it('handles unclosed thought tag with pending state', () => {
        const result = extractThoughtContent('text<think>partial');
        expect(result.text).toBe('text');
        expect(result.thought).toBe('partial');
        expect(result.pendingThought).toBe('partial');
    });

    it('resumes pending thought and closes it in a later chunk', () => {
        const first = extractThoughtContent('text<think>partial');
        const second = extractThoughtContent('end</think>after', first.pendingThought);
        expect(second.thought).toBe('end');
        expect(second.text).toBe('after');
        expect(second.pendingThought).toBe('');
    });

    it('handles multiple thought blocks in one string', () => {
        const result = extractThoughtContent('a<think>x</think>b<think>y</think>c');
        expect(result.text).toBe('abc');
        expect(result.thought).toBe('xy');
    });
});

describe('parseSseEvents', () => {
    it('parses a simple data event', () => {
        const events = parseSseEvents('data: {"hello":"world"}\n\n');
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toBe('{"hello":"world"}');
    });

    it('handles CRLF line endings', () => {
        const events = parseSseEvents('data: test\r\n\r\n');
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toBe('test');
    });

    it('joins multi-line data fields', () => {
        const events = parseSseEvents('data: line1\ndata: line2\n\n');
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toBe('line1\nline2');
    });

    it('parses event and id fields', () => {
        const events = parseSseEvents('event: ping\nid: 42\ndata: {}\n\n');
        expect(events[0]!.event).toBe('ping');
        expect(events[0]!.id).toBe('42');
    });

    it('handles events without trailing blank line', () => {
        const events = parseSseEvents('data: no-blank');
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toBe('no-blank');
    });

    it('skips blank lines with no data', () => {
        const events = parseSseEvents('\n\n\ndata: real\n\n');
        expect(events).toHaveLength(1);
        expect(events[0]!.data).toBe('real');
    });
});

describe('parseNdjsonLines', () => {
    it('parses multiple JSON lines', () => {
        const lines = parseNdjsonLines('{"a":1}\n{"b":2}\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]!['a']).toBe(1);
        expect(lines[1]!['b']).toBe(2);
    });

    it('skips malformed lines', () => {
        const lines = parseNdjsonLines('{"a":1}\nnot-json\n{"b":2}\n');
        expect(lines).toHaveLength(2);
    });

    it('returns empty array for empty input', () => {
        expect(parseNdjsonLines('')).toEqual([]);
    });
});

describe('openAiSseDataToChunk', () => {
    it('returns null for empty choices', () => {
        expect(openAiSseDataToChunk({})).toBeNull();
        expect(openAiSseDataToChunk({ choices: [] })).toBeNull();
    });

    it('converts content to text', () => {
        const data: OpenAiSseData = {
            choices: [{ delta: { content: 'hello' }, finish_reason: null }]
        };
        const chunk = openAiSseDataToChunk(data);
        expect(chunk!.text).toBe('hello');
        expect(chunk!.done).toBe(false);
    });

    it('marks done when finish_reason is set', () => {
        const data: OpenAiSseData = {
            choices: [{ delta: {}, finish_reason: 'stop' }]
        };
        expect(openAiSseDataToChunk(data)!.done).toBe(true);
    });

    it('routes reasoning_content to thought and drops content (mirror guard)', () => {
        const data: OpenAiSseData = {
            choices: [
                {
                    delta: { content: 'should-be-dropped', reasoning_content: 'reasoning' },
                    finish_reason: null
                }
            ]
        };
        const chunk = openAiSseDataToChunk(data);
        expect(chunk!.text).toBe('');
        expect(chunk!.thought).toBe('reasoning');
    });

    it('extracts tool-call fragments', () => {
        const data: OpenAiSseData = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }
                        ]
                    },
                    finish_reason: null
                }
            ]
        };
        const chunk = openAiSseDataToChunk(data);
        expect(chunk!.toolCalls).toHaveLength(1);
        expect(chunk!.toolCalls![0]!.id).toBe('call_1');
        expect(chunk!.toolCalls![0]!.name).toBe('lookup');
        expect(chunk!.toolCalls![0]!.arguments).toBe('{"q":');
    });

    it('extracts usage data from snake_case fields', () => {
        const data: OpenAiSseData = {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        };
        const chunk = openAiSseDataToChunk(data);
        expect(chunk!.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });
});

describe('ollamaNdjsonLineToChunk', () => {
    it('converts a basic content line', () => {
        const chunk = ollamaNdjsonLineToChunk({
            message: { role: 'assistant', content: 'hello' },
            done: false
        });
        expect(chunk.text).toBe('hello');
        expect(chunk.done).toBe(false);
    });

    it('marks done when done is true', () => {
        const chunk = ollamaNdjsonLineToChunk({ done: true });
        expect(chunk.done).toBe(true);
    });

    it('synthesizes tool-call ids with content hash', () => {
        const chunk = ollamaNdjsonLineToChunk({
            message: {
                role: 'assistant',
                tool_calls: [{ function: { name: 'search', arguments: { q: 'cats' } } }]
            },
            done: false
        });
        expect(chunk.toolCalls).toHaveLength(1);
        expect(chunk.toolCalls![0]!.id).toMatch(/ollama_call_0_[0-9a-f]{8}/);
        expect(chunk.toolCalls![0]!.name).toBe('search');
        expect(chunk.toolCalls![0]!.arguments).toBe('{"q":"cats"}');
    });

    it('produces stable ids for identical tool calls', () => {
        const line = {
            message: {
                role: 'assistant',
                tool_calls: [{ function: { name: 'x', arguments: { a: 1 } } }]
            },
            done: false
        };
        const c1 = ollamaNdjsonLineToChunk(line);
        const c2 = ollamaNdjsonLineToChunk(line);
        expect(c1.toolCalls![0]!.id).toBe(c2.toolCalls![0]!.id);
    });
});

describe('parseSseStream', () => {
    it('yields parsed SSE events from a stream', async () => {
        const reader = makeStream('data: {"a":1}\n\n', 'data: [DONE]\n\n').getReader();
        const events: unknown[] = [];
        for await (const ev of parseSseStream(reader)) {
            events.push(ev);
        }
        expect(events).toHaveLength(2);
        expect((events[0] as { data: string }).data).toBe('{"a":1}');
        expect((events[1] as { data: string }).data).toBe('[DONE]');
    });

    it('respects abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        const reader = makeStream('data: {"a":1}\n\n').getReader();
        const events: unknown[] = [];
        for await (const ev of parseSseStream(reader, controller.signal)) {
            events.push(ev);
        }
        expect(events).toHaveLength(0);
    });
});

describe('parseNdjsonStream', () => {
    it('yields parsed JSON objects from a stream', async () => {
        const reader = makeStream('{"a":1}\n', '{"b":2}\n').getReader();
        const results: unknown[] = [];
        for await (const obj of parseNdjsonStream(reader)) {
            results.push(obj);
        }
        expect(results).toHaveLength(2);
    });

    it('handles split chunks across line boundaries', async () => {
        const reader = makeStream('{"a":', '1}\n').getReader();
        const results: unknown[] = [];
        for await (const obj of parseNdjsonStream(reader)) {
            results.push(obj);
        }
        expect(results).toHaveLength(1);
    });

    it('skips malformed lines', async () => {
        const reader = makeStream('not-json\n', '{"ok":true}\n').getReader();
        const results: unknown[] = [];
        for await (const obj of parseNdjsonStream(reader)) {
            results.push(obj);
        }
        expect(results).toHaveLength(1);
    });
});
