import { describe, it, expect, vi, afterEach } from 'vitest';
import { Platform, requestUrl } from 'obsidian';

vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import { GeminiProvider } from '../../src/ai/gemini-provider';
import { ProviderError, type ChatChunk, type ProviderConfig } from '../../src/ai/provider';
import {
    streamingResponse,
    errorResponse,
    bufferedResponse,
    mockWindowFetch,
    restoreWindow,
    sseDataLine,
    type MockFetchResponse
} from '../helpers/mock-http';

const config: ProviderConfig = {
    id: 'gemini',
    name: 'Gemini',
    type: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIzaTest',
    models: [{ id: 'flash', role: 'chat', model: 'gemini-2.5-flash' }],
    maxContextTokens: 1000000,
    maxOutputTokens: 4096
};

function makeProvider(): GeminiProvider {
    return new GeminiProvider(config);
}

async function drain(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
}

/** A Gemini `streamGenerateContent` SSE data payload carrying text. */
function geminiText(text: string, finishReason: string | null = null): unknown {
    return {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
    };
}

describe('GeminiProvider.chatCompletion', () => {
    afterEach(() => {
        Platform.isMobile = false;
        vi.mocked(requestUrl).mockReset();
        restoreWindow();
    });

    describe('desktop SSE path (window.fetch)', () => {
        it('streams text chunks and surfaces usage on the terminal chunk', async () => {
            Platform.isMobile = false;
            const fetchSpy = vi.fn((_url: string, _init: unknown): Promise<MockFetchResponse> =>
                Promise.resolve(
                    streamingResponse([
                        sseDataLine(geminiText('Hello ')),
                        sseDataLine(geminiText('world', 'STOP'))
                    ])
                )
            );
            mockWindowFetch(fetchSpy);

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'flash' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
            const last = chunks[chunks.length - 1]!;
            expect(last.done).toBe(true);
            expect(last.usage?.totalTokens).toBe(5);

            // Gemini puts the model in the URL path, not the request body.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const call = fetchSpy.mock.calls[0]!;
            expect(call[0]).toBe(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
            );
            const init = call[1] as { method: string; headers: Record<string, string> };
            expect(init.method).toBe('POST');
            // Gemini uses x-goog-api-key, not Bearer / x-api-key.
            expect(init.headers['x-goog-api-key']).toBe('AIzaTest');
        });

        it('throws a ProviderError when a safety filter blocks the response', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() =>
                Promise.resolve(
                    streamingResponse([
                        sseDataLine({
                            candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'SAFETY' }]
                        })
                    ])
                )
            );

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'risky' }], model: 'flash' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });

        it('surfaces a non-2xx HTTP response as a ProviderError', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() => Promise.resolve(errorResponse(400, 'invalid API key')));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'flash' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });

    describe('mobile fallback (requestUrl)', () => {
        it('yields chunks from the buffered SSE response', async () => {
            Platform.isMobile = true;
            const body = sseDataLine(geminiText('Hi')) + sseDataLine(geminiText('', 'STOP'));
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse(body));

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'flash' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hi');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
            expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
                    throw: false
                })
            );
        });

        it('throws a ProviderError when a buffered response is safety-blocked', async () => {
            Platform.isMobile = true;
            const body = sseDataLine({
                candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'RECITATION' }]
            });
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse(body));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'flash' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });
});
