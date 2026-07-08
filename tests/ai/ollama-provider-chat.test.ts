import { describe, it, expect, vi, afterEach } from 'vitest';
import { Platform, requestUrl } from 'obsidian';

vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import { OllamaProvider } from '../../src/ai/ollama-provider';
import { ProviderError, type ProviderConfig } from '../../src/ai/provider';
import {
    streamingResponse,
    errorResponse,
    bufferedResponse,
    mockWindowFetch,
    restoreWindow,
    drain,
    ndjsonLine,
    type MockFetchResponse
} from '../helpers/mock-http';

const config: ProviderConfig = {
    id: 'ollama',
    name: 'Ollama',
    type: 'ollama',
    endpoint: 'http://localhost:11434',
    apiKey: '',
    models: [{ id: 'llama', role: 'chat', model: 'llama3.1' }],
    maxContextTokens: 32768,
    maxOutputTokens: 4096
};

function makeProvider(): OllamaProvider {
    return new OllamaProvider(config);
}

/** Ollama `/api/chat` NDJSON line. `done` is true only on the terminal line. */
function ollamaMessage(content: string, done = false): unknown {
    return { model: 'llama3.1', message: { role: 'assistant', content }, done };
}

describe('OllamaProvider.chatCompletion', () => {
    afterEach(() => {
        Platform.isMobile = false;
        vi.mocked(requestUrl).mockReset();
        restoreWindow();
    });

    describe('desktop NDJSON path (window.fetch)', () => {
        it('streams text chunks from each NDJSON line', async () => {
            Platform.isMobile = false;
            const fetchSpy = vi.fn((_url: string, _init: unknown): Promise<MockFetchResponse> =>
                Promise.resolve(
                    streamingResponse([
                        ndjsonLine(ollamaMessage('Hello ')),
                        ndjsonLine(ollamaMessage('world')),
                        ndjsonLine(ollamaMessage('', true))
                    ])
                )
            );
            mockWindowFetch(fetchSpy);

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'llama' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
            expect(chunks[chunks.length - 1]!.done).toBe(true);

            // POST /api/chat (Ollama's chat endpoint, distinct from OpenAI's).
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const call = fetchSpy.mock.calls[0]!;
            expect(call[0]).toBe('http://localhost:11434/api/chat');
            const init = call[1] as { method: string; body: string };
            expect(init.method).toBe('POST');
            // Ollama carries temperature under `options`, not top-level.
            const parsed = JSON.parse(init.body) as { model: string; options: { num_predict: number } };
            expect(parsed.model).toBe('llama3.1');
            expect(parsed.options.num_predict).toBe(4096);
        });

        it('surfaces a non-2xx HTTP response as a ProviderError', async () => {
            Platform.isMobile = false;
            mockWindowFetch(() => Promise.resolve(errorResponse(404, 'model not found')));

            await expect(
                drain(
                    makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'llama' })
                )
            ).rejects.toBeInstanceOf(ProviderError);
        });
    });

    describe('mobile fallback (requestUrl)', () => {
        it('yields chunks from the buffered NDJSON text', async () => {
            Platform.isMobile = true;
            const body = ndjsonLine(ollamaMessage('Hi')) + ndjsonLine(ollamaMessage('', true));
            vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse(body));

            const chunks = await drain(
                makeProvider().chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'llama' })
            );

            expect(chunks.map((c) => c.text).join('')).toBe('Hi');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
            expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
                expect.objectContaining({ url: 'http://localhost:11434/api/chat', throw: false })
            );
        });
    });
});
