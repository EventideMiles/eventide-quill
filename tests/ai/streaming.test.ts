import { describe, it, expect } from 'vitest';
import {
    extractThoughtContent,
    parseSseEvents,
    parseNdjsonLines,
    openAiSseDataToChunk,
    ollamaNdjsonLineToChunk,
    parseSseStream,
    parseNdjsonStream,
    AnthropicStreamAggregator,
    anthropicEventsToChunks,
    geminiSseDataToChunk,
    geminiEventsToChunks,
    geminiResponseBlocked,
    type SseEvent
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
                        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }]
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

// ---------------------------------------------------------------------------
// Anthropic Messages API parser
// ---------------------------------------------------------------------------
//
// Fixtures sourced from the Anthropic Messages streaming documentation:
// https://docs.anthropic.com/en/api/messages-streaming
// Shapes are stable per the `2023-06-01` API version. Re-validate when the
// underlying API version is bumped.

/** Build an SSE event from raw fields, mirroring how parseSseEvents splits. */
function sse(event: string, data: unknown): SseEvent {
    return { event, data: typeof data === 'string' ? data : JSON.stringify(data) };
}

describe('AnthropicStreamAggregator', () => {
    it('emits input usage on message_start', () => {
        const agg = new AnthropicStreamAggregator();
        const chunks = agg.processEvent(
            sse('message_start', {
                type: 'message_start',
                message: { id: 'msg_1', usage: { input_tokens: 42, output_tokens: 1 } }
            })
        );
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.usage).toEqual({ promptTokens: 42, completionTokens: 1, totalTokens: 43 });
    });

    it('routes text_delta to chunk.text', () => {
        const agg = new AnthropicStreamAggregator();
        agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            })
        );
        const chunks = agg.processEvent(
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello' }
            })
        );
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.text).toBe('Hello');
        expect(chunks[0]!.done).toBe(false);
    });

    it('routes thinking_delta to chunk.thought and accumulates signature', () => {
        const agg = new AnthropicStreamAggregator();
        agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' }
            })
        );
        const deltaChunks = agg.processEvent(
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Let me consider.' }
            })
        );
        expect(deltaChunks[0]!.thought).toBe('Let me consider.');
        // Signature deltas accumulate without emitting chunks.
        const sigChunks = agg.processEvent(
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'WaUjz...' }
            })
        );
        expect(sigChunks).toHaveLength(0);
        // Closing the block queues the finished thinking for caller pickup.
        agg.processEvent(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        expect(agg.finishedThinking).toEqual([{ thinking: 'Let me consider.', signature: 'WaUjz...' }]);
    });

    it('emits a leading tool_use fragment with id and name on content_block_start', () => {
        const agg = new AnthropicStreamAggregator();
        const start = agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_01ABC', name: 'lookup', input: {} }
            })
        );
        expect(start).toHaveLength(1);
        expect(start[0]!.toolCalls).toEqual([{ index: 0, id: 'toolu_01ABC', name: 'lookup', arguments: '' }]);
    });

    it('accumulates input_json_delta as arguments fragments', () => {
        const agg = new AnthropicStreamAggregator();
        agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_01', name: 'search', input: {} }
            })
        );
        const d1 = agg.processEvent(
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"q":' }
            })
        );
        const d2 = agg.processEvent(
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '"cats"}' }
            })
        );
        expect(d1[0]!.toolCalls![0]!.arguments).toBe('{"q":');
        expect(d2[0]!.toolCalls![0]!.arguments).toBe('"cats"}');
    });

    it('tracks separate tool-call indices across multiple tool_use blocks', () => {
        const agg = new AnthropicStreamAggregator();
        agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_a', name: 'first', input: {} }
            })
        );
        agg.processEvent(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        const second = agg.processEvent(
            sse('content_block_start', {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: 'toolu_b', name: 'second', input: {} }
            })
        );
        expect(second[0]!.toolCalls![0]!.index).toBe(1);
        expect(second[0]!.toolCalls![0]!.id).toBe('toolu_b');
    });

    it('marks done and surfaces output usage on message_delta', () => {
        const agg = new AnthropicStreamAggregator();
        const chunks = agg.processEvent(
            sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 99 }
            })
        );
        expect(chunks[0]!.done).toBe(true);
        expect(chunks[0]!.usage!.completionTokens).toBe(99);
    });

    it('emits a terminal done chunk on message_stop', () => {
        const agg = new AnthropicStreamAggregator();
        const chunks = agg.processEvent(sse('message_stop', { type: 'message_stop' }));
        expect(chunks).toEqual([{ text: '', done: true }]);
    });

    it('throws on error events', () => {
        const agg = new AnthropicStreamAggregator();
        expect(() =>
            agg.processEvent(
                sse('error', { type: 'error', error: { message: 'rate limited', type: 'overloaded_error' } })
            )
        ).toThrow('rate limited');
    });

    it('ignores ping events', () => {
        const agg = new AnthropicStreamAggregator();
        expect(agg.processEvent(sse('ping', { type: 'ping' }))).toHaveLength(0);
    });
});

describe('anthropicEventsToChunks', () => {
    it('renders a full text turn from the documented event sequence', () => {
        const events: SseEvent[] = [
            sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            }),
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hi ' }
            }),
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'there' }
            }),
            sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 3 }
            }),
            sse('message_stop', { type: 'message_stop' })
        ];
        const chunks = anthropicEventsToChunks(events);
        // Input usage, two text deltas, done delta, terminal done.
        expect(chunks.length).toBeGreaterThanOrEqual(4);
        const text = chunks.map((c) => c.text).join('');
        expect(text).toContain('Hi there');
        expect(chunks[chunks.length - 1]!.done).toBe(true);
    });

    it('appends a terminal done chunk when the stream omits message_stop', () => {
        const events: SseEvent[] = [
            sse('message_start', { type: 'message_start', message: {} }),
            sse('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            }),
            sse('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'partial' }
            })
        ];
        const chunks = anthropicEventsToChunks(events);
        expect(chunks[chunks.length - 1]!.done).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Gemini GenerateContent API parser
// ---------------------------------------------------------------------------
//
// Fixtures derived from the Gemini API reference:
// https://ai.google.dev/api/generate-content
// Shape is per the `v1beta` revision.

describe('geminiSseDataToChunk', () => {
    it('returns null for empty candidates', () => {
        expect(geminiSseDataToChunk({})).toBeNull();
        expect(geminiSseDataToChunk({ candidates: [] })).toBeNull();
    });

    it('aggregates text from multiple parts', () => {
        const chunk = geminiSseDataToChunk({
            candidates: [
                {
                    content: { role: 'model', parts: [{ text: 'Hello ' }, { text: 'world' }] },
                    finishReason: null
                }
            ]
        });
        expect(chunk!.text).toBe('Hello world');
        expect(chunk!.done).toBe(false);
    });

    it('marks done when finishReason is set', () => {
        const chunk = geminiSseDataToChunk({
            candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }]
        });
        expect(chunk!.done).toBe(true);
    });

    it('synthesizes tool-call fragments from functionCall parts', () => {
        const chunk = geminiSseDataToChunk({
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ functionCall: { name: 'lookup', args: { q: 'cats', n: 3 } } }]
                    },
                    finishReason: null
                }
            ]
        });
        expect(chunk!.toolCalls).toHaveLength(1);
        expect(chunk!.toolCalls![0]!.name).toBe('lookup');
        // Args are re-serialized to a JSON string (Quill's contract).
        expect(chunk!.toolCalls![0]!.arguments).toBe(JSON.stringify({ q: 'cats', n: 3 }));
        expect(chunk!.toolCalls![0]!.index).toBe(0);
    });

    it('exposes usageMetadata as the chunk usage', () => {
        const chunk = geminiSseDataToChunk({
            candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        });
        expect(chunk!.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it('emits an empty done chunk for promptFeedback block (caller decides to throw)', () => {
        const chunk = geminiSseDataToChunk({
            promptFeedback: { blockReason: 'SAFETY' }
        });
        expect(chunk).not.toBeNull();
        expect(chunk!.done).toBe(true);
    });
});

describe('geminiResponseBlocked', () => {
    it('returns true for promptFeedback SAFETY', () => {
        expect(geminiResponseBlocked({ promptFeedback: { blockReason: 'SAFETY' } })).toBe(true);
    });

    it('returns true for candidate finishReason SAFETY', () => {
        expect(
            geminiResponseBlocked({
                candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'SAFETY' }]
            })
        ).toBe(true);
    });

    it('returns true for RECITATION, BLOCKLIST, PROHIBITED_CONTENT', () => {
        for (const reason of ['RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
            expect(
                geminiResponseBlocked({
                    candidates: [{ content: { role: 'model', parts: [] }, finishReason: reason }]
                })
            ).toBe(true);
        }
    });

    it('returns false for normal STOP / MAX_TOKENS', () => {
        for (const reason of ['STOP', 'MAX_TOKENS', null, undefined]) {
            expect(
                geminiResponseBlocked({
                    candidates: [
                        { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: reason }
                    ]
                })
            ).toBe(false);
        }
    });
});

describe('geminiEventsToChunks', () => {
    it('appends a terminal done chunk when Gemini omits finishReason', () => {
        const chunks = geminiEventsToChunks([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'no reason given' }] } }] }
        ]);
        expect(chunks[chunks.length - 1]!.done).toBe(true);
    });

    it('passes through multi-payload streams in order', () => {
        const chunks = geminiEventsToChunks([
            { candidates: [{ content: { role: 'model', parts: [{ text: 'first ' }] }, finishReason: null }] },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'second' }] }, finishReason: 'STOP' }] }
        ]);
        const text = chunks.map((c) => c.text).join('');
        expect(text).toBe('first second');
    });
});
