import { describe, it, expect, vi, afterEach } from 'vitest';
import { Platform, requestUrl } from 'obsidian';

// Wrap requestUrl in a vi.fn so the mobile-fallback suite can feed it a
// buffered SSE body. The desktop path uses window.fetch, not requestUrl.
vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import { OpenAiCompatibleProvider } from '../../src/ai/openai-provider';
import { ProviderError, type ChatChunk, type ProviderConfig } from '../../src/ai/provider';
import {
    streamingResponse,
    errorResponse,
    bufferedResponse,
    mockWindowFetch,
    restoreWindow,
    sseDataLine,
    sseDoneSentinel,
    type MockFetchResponse
} from '../helpers/mock-http';

const config: ProviderConfig = {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    apiKey: '',
    models: [{ id: 'gpt', role: 'chat', model: 'gpt-4o' }],
    maxContextTokens: 32768,
    maxOutputTokens: 4096
};

function makeProvider(): OpenAiCompatibleProvider {
    return new OpenAiCompatibleProvider(config);
}

async function drain(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
}

/** OpenAI `choices[].delta` SSE payload. */
function choice(text: string, finishReason: string | null = null): unknown {
    return { choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }] };
}

describe('OpenAiCompatibleProvider.chatCompletion', () => {
    afterEach(() => {
        Platform.isMobile = false;
        vi.mocked(requestUrl).mockReset();
        restoreWindow();
    });

    describe('desktop SSE path (window.fetch)', () => {
        it('streams text chunks and ends on the [DONE] sentinel', async () => {
            Platform.isMobile = false;
            const fetchSpy = vi.fn((_url: string, _init: unknown): Promise<MockFetchResponse> =>
                Promise.resolve(
                    streamingResponse([
                        sseDataLine(choice('Hello ')),
                        sseDataLine(choice('world')),
                        sseDoneSentinel()
                    ])
                )
            );
            mockWindowFetch(fetchSpy);

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
            expect(chunks[chunks.length - 1]!.done).toBe(true);

            // POST /chat/completions with the model in the body.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const call = fetchSpy.mock.calls[0]!;
            expect(call[0]).toBe('http://localhost:1234/v1/chat/completions');
            const init = call[1] as { method: string; body: string };
            expect(init.method).toBe('POST');
            expect((JSON.parse(init.body) as { model: string }).model).toBe('gpt-4o');
        });

        it('surfaces a non-2xx HTTP response as a ProviderError', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() => Promise.resolve(errorResponse(500, 'model load failed')));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });

    describe('mobile fallback (requestUrl)', () => {
        it('yields chunks from the buffered SSE response', async () => {
            Platform.isMobile = true;
            const body = sseDataLine(choice('Hi')) + sseDoneSentinel();
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse(body));

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hi');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
            expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
                expect.objectContaining({ url: 'http://localhost:1234/v1/chat/completions', throw: false })
            );
        });

        it('surfaces a non-2xx buffered response as a ProviderError', async () => {
            Platform.isMobile = true;
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse('boom', 500));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });
});
