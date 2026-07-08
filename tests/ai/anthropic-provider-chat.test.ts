import { describe, it, expect, vi, afterEach } from 'vitest';
import { Platform, requestUrl } from 'obsidian';

// Wrap requestUrl in a vi.fn so the mobile-fallback suite can feed it a
// buffered SSE body. By default it delegates to the __mocks__ stub, so the
// desktop path (which uses window.fetch, not requestUrl) is unaffected.
vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import { AnthropicProvider } from '../../src/ai/anthropic-provider';
import { ProviderError, type ChatChunk, type ChatMessage, type ProviderConfig } from '../../src/ai/provider';
import {
    streamingResponse,
    errorResponse,
    bufferedResponse,
    mockWindowFetch,
    restoreWindow,
    sseEvent,
    type MockFetchResponse
} from '../helpers/mock-http';

const config: ProviderConfig = {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    models: [{ id: 'sonnet', role: 'chat', model: 'claude-sonnet-4-5' }],
    maxContextTokens: 200000,
    maxOutputTokens: 4096
};

function makeProvider(): AnthropicProvider {
    return new AnthropicProvider(config);
}

/** Drain a provider stream into an array of chunks. */
async function drain(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
}

describe('AnthropicProvider.chatCompletion', () => {
    afterEach(() => {
        // Restore the desktop default + clear the requestUrl spy + drop window.
        Platform.isMobile = false;
        vi.mocked(requestUrl).mockReset();
        restoreWindow();
    });

    describe('desktop SSE path (window.fetch)', () => {
        it('streams text chunks and ends with a terminal done chunk', async () => {
            Platform.isMobile = false;
            const fetchSpy = vi.fn((_url: string, _init: unknown): Promise<MockFetchResponse> =>
                Promise.resolve(
                    streamingResponse([
                        sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 3 } } }),
                        sseEvent('content_block_start', {
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'text', text: '' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'text_delta', text: 'Hello ' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'text_delta', text: 'world' }
                        }),
                        sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
                        sseEvent('message_delta', {
                            type: 'message_delta',
                            delta: { stop_reason: 'end_turn' },
                            usage: { output_tokens: 2 }
                        }),
                        sseEvent('message_stop', { type: 'message_stop' })
                    ])
                )
            );
            mockWindowFetch(fetchSpy);

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'sonnet' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
            expect(chunks[chunks.length - 1]!.done).toBe(true);

            // The request hit POST /messages with the model + required headers.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const call = fetchSpy.mock.calls[0]!;
            expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
            const init = call[1] as { method: string; headers: Record<string, string>; body: string };
            expect(init.method).toBe('POST');
            expect(init.headers['x-api-key']).toBe('sk-ant-test');
            expect(init.headers['anthropic-version']).toBeDefined();
            const parsedBody = JSON.parse(init.body) as { model?: string };
            expect(parsedBody.model).toBe('claude-sonnet-4-5');
        });

        it('surfaces a non-2xx HTTP response as a ProviderError', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() => Promise.resolve(errorResponse(500, 'overloaded')));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'sonnet' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });

        it('attaches thinking blocks (incl. redacted) to the terminal done chunk', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() =>
                Promise.resolve(
                    streamingResponse([
                        sseEvent('content_block_start', {
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'thinking', thinking: '' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'thinking_delta', thinking: 'reason' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'signature_delta', signature: 'sig' }
                        }),
                        sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
                        sseEvent('content_block_start', {
                            type: 'content_block_start',
                            index: 1,
                            content_block: { type: 'redacted_thinking', data: 'REDACTED' }
                        }),
                        sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
                        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
                        sseEvent('message_stop', { type: 'message_stop' })
                    ])
                )
            );

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'sonnet' })
            );

            // The terminal done chunk carries both the signed and redacted
            // thinking blocks so tool-loop consumers can replay them.
            const done = chunks.find((c) => c.done && c.thinkingBlocks);
            expect(done).toBeDefined();
            expect(done!.thinkingBlocks).toEqual([
                { thinking: 'reason', signature: 'sig' },
                { data: 'REDACTED' }
            ]);
        });

        it('does not mutate the input messages array (thinking now rides the stream)', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() =>
                Promise.resolve(
                    streamingResponse([
                        sseEvent('content_block_start', {
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'thinking', thinking: '' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'thinking_delta', thinking: 'x' }
                        }),
                        sseEvent('content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'signature_delta', signature: 's' }
                        }),
                        sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
                        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
                        sseEvent('message_stop', { type: 'message_stop' })
                    ])
                )
            );

            const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
            await drain(makeProvider().chatCompletion({ messages, model: 'sonnet' }));

            // Regression guard for the #1 fix: the provider must no longer
            // stamp thinking onto a prior assistant message in the input.
            expect(messages[0]!.thinkingBlocks).toBeUndefined();
        });
    });

    describe('mobile fallback (requestUrl)', () => {
        it('yields chunks from the buffered SSE response', async () => {
            Platform.isMobile = true;
            const body = [
                sseEvent('message_start', { type: 'message_start' }),
                sseEvent('content_block_start', {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' }
                }),
                sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'Hi' }
                }),
                sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
                sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
                sseEvent('message_stop', { type: 'message_stop' })
            ].join('');
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse(body));

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'sonnet' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hi');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
            // The mobile fallback uses requestUrl with throw:false and the same URL.
            expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
                expect.objectContaining({ url: 'https://api.anthropic.com/v1/messages', throw: false })
            );
        });

        it('surfaces a non-2xx buffered response as a ProviderError', async () => {
            Platform.isMobile = true;
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse('server error', 503));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'sonnet' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });
});
