import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestUrl } from 'obsidian';

// Wrap requestUrl in a vi.fn so the listModels suite can feed it buffered
// /models responses. listModels always uses the buffered path (safeGet ->
// bufferResponse -> requestUrl), on desktop and mobile alike.
vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import { OpenAiCompatibleProvider } from '../../src/ai/openai-provider';
import type { ProviderConfig } from '../../src/ai/provider';
import { bufferedResponse } from '../helpers/mock-http';

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

/** Build an OpenAiCompatibleProvider from the shared test config. */
function makeProvider(): OpenAiCompatibleProvider {
    return new OpenAiCompatibleProvider(config);
}

/**
 * Queue a buffered `/models` response on the mocked requestUrl. `json` is
 * passed directly (bufferResponse forwards response.json without parsing),
 * mirroring how Obsidian's requestUrl exposes the parsed body.
 */
function mockModelsResponse(json: unknown, status = 200): void {
    vi.mocked(requestUrl).mockResolvedValueOnce(bufferedResponse('', status, json));
}

describe('OpenAiCompatibleProvider.listModels — reported context length', () => {
    afterEach(() => {
        vi.mocked(requestUrl).mockReset();
    });

    it('GETs the /models endpoint on the configured base path', async () => {
        mockModelsResponse({ data: [{ id: 'qwen' }] });

        await makeProvider().listModels();

        expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'http://localhost:1234/v1/models', method: 'GET', throw: false })
        );
    });

    it('maps LM Studio max_context_length onto ModelInfo.contextLength', async () => {
        mockModelsResponse({ data: [{ id: 'qwen3-32b', owned_by: 'lmstudio', max_context_length: 131072 }] });

        const models = await makeProvider().listModels();

        expect(models).toEqual([{ id: 'qwen3-32b', ownedBy: 'lmstudio', contextLength: 131072 }]);
    });

    it('falls back to the context_length field when max_context_length is absent', async () => {
        mockModelsResponse({ data: [{ id: 'llama-3', context_length: 8192 }] });

        const models = await makeProvider().listModels();

        expect(models).toEqual([{ id: 'llama-3', ownedBy: undefined, contextLength: 8192 }]);
    });

    it('prefers max_context_length when both fields are present', async () => {
        mockModelsResponse({ data: [{ id: 'both', max_context_length: 4096, context_length: 999999 }] });

        const models = await makeProvider().listModels();

        expect(models).toEqual([{ id: 'both', ownedBy: undefined, contextLength: 4096 }]);
    });

    it('omits contextLength when neither field is present', async () => {
        mockModelsResponse({ data: [{ id: 'plain', owned_by: 'openai' }] });

        const models = await makeProvider().listModels();

        expect(models).toEqual([{ id: 'plain', ownedBy: 'openai', contextLength: undefined }]);
        expect(Object.prototype.hasOwnProperty.call(models[0], 'contextLength')).toBe(false);
    });

    it('ignores non-numeric context fields instead of surfacing garbage', async () => {
        mockModelsResponse({
            data: [
                { id: 'strings', max_context_length: 'many', context_length: null },
                { id: 'numbers-ok', max_context_length: 2048 }
            ]
        });

        const models = await makeProvider().listModels();

        expect(models).toEqual([
            { id: 'strings', ownedBy: undefined },
            { id: 'numbers-ok', ownedBy: undefined, contextLength: 2048 }
        ]);
    });

    it('returns [] on a non-200 response', async () => {
        mockModelsResponse({ data: [{ id: 'qwen', max_context_length: 4096 }] }, 500);

        const models = await makeProvider().listModels();

        expect(models).toEqual([]);
    });

    it('returns [] when the body has no data array', async () => {
        mockModelsResponse({ error: 'nope' });

        const models = await makeProvider().listModels();

        expect(models).toEqual([]);
    });

    it('returns [] when the data field is not an array', async () => {
        mockModelsResponse({ data: 'garbage' });

        const models = await makeProvider().listModels();

        expect(models).toEqual([]);
    });

    it('returns [] when the request itself rejects', async () => {
        vi.mocked(requestUrl).mockRejectedValueOnce(new Error('connection refused'));

        const models = await makeProvider().listModels();

        expect(models).toEqual([]);
    });
});
