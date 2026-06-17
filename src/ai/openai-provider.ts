import { requestUrl, type RequestUrlResponse } from 'obsidian';
import {
    AiProvider,
    buildUrl,
    ChatChunk,
    ChatOptions,
    EmbedOptions,
    EmbedResult,
    ModelInfo,
    ProviderConfig,
    ProviderError,
    resolveModel
} from './provider';
import {
    extractThoughtContent,
    openAiEventsToChunks,
    openAiSseDataToChunk,
    OpenAiSseData,
    parseSseEvents,
    parseSseStream,
    processChunksWithThoughts
} from './streaming';
import {
    isStreamingSupported,
    streamResponseWithCatch,
    throwOnNonOk,
    catchErrorResponse,
    httpErrorResponse,
    safeGet
} from './transport';

/** Shape of a single item in the OpenAI models endpoint response. */
interface OpenAiModelItem {
    id: string;
    owned_by?: string;
}

/** Shape of a single item in the OpenAI embeddings response data array. */
interface EmbeddingDataItem {
    embedding: number[];
    index?: number;
}

/** Shape of usage info in non-streaming API responses. */
interface UsageInfo {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/**
 * Provider for any OpenAI-compatible chat completions API endpoint.
 * Supports LM Studio, NanoGPT, Together, Groq, vLLM, LiteLLM, OpenAI, and any
 * other endpoint serving the `/v1/chat/completions` format with SSE streaming.
 */
export class OpenAiCompatibleProvider implements AiProvider {
    readonly id: string;
    readonly name: string;
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.id = config.id;
        this.name = config.name;
        this.config = config;
    }

    /**
     * Build the common headers for API requests.
     * Omits the Authorization header if no API key is configured.
     */
    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        return headers;
    }

    /**
     * {@inheritDoc AiProvider.chatCompletion}
     *
     * On desktop this streams the SSE response incrementally via native fetch.
     * On mobile it falls back to a buffered requestUrl call.
     */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const modelConfig = resolveModel(this.config.models, 'chat', options.model, this.name);

        const url = buildUrl(this.config.endpoint, '/chat/completions');
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            model: modelConfig.model,
            messages: options.messages.map((m) => ({
                role: m.role,
                content: m.content
            })),
            max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
            temperature: options.temperature ?? 0.7,
            stream: true
        });

        if (isStreamingSupported()) {
            const reader = await streamResponseWithCatch(url, {
                method: 'POST',
                headers,
                body,
                signal: options.signal
            });

            let pendingThought = '';
            for await (const event of parseSseStream(reader, options.signal)) {
                if (event.data === '[DONE]') {
                    yield { text: '', done: true };
                    continue;
                }

                try {
                    const parsed = JSON.parse(event.data) as OpenAiSseData;
                    const chunk = openAiSseDataToChunk(parsed);
                    if (chunk) {
                        // Also run tag-aware extraction as a fallback for models
                        // that embed thinking in  tags rather than using the
                        // structured reasoning_content field.
                        if (chunk.text) {
                            const extracted = extractThoughtContent(chunk.text, pendingThought);
                            chunk.text = extracted.text;
                            if (extracted.thought && !chunk.thought) {
                                chunk.thought = extracted.thought;
                            }
                            pendingThought = extracted.pendingThought;
                        }
                        yield chunk;
                    }
                } catch {
                    continue;
                }
            }

            return;
        }

        // Mobile fallback: buffer the full response
        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers,
            body,
            throw: false
        });

        throwOnNonOk(response, 'Chat completion');

        const events = parseSseEvents(response.text);
        const chunks = openAiEventsToChunks(events);
        for await (const chunk of processChunksWithThoughts(chunks, { signal: options.signal })) {
            yield chunk;
        }
    }

    /** {@inheritDoc AiProvider.embed} */
    async embed(options: EmbedOptions): Promise<EmbedResult> {
        const modelConfig = resolveModel(this.config.models, 'embed', options.model, this.name);

        const url = buildUrl(this.config.endpoint, '/embeddings');
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            model: modelConfig.model,
            input: options.input
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers,
            body,
            throw: false
        });

        throwOnNonOk(response, 'Embedding request');

        const data = response.json as {
            data?: EmbeddingDataItem[];
            model?: string;
            usage?: UsageInfo;
        };

        if (!data.data || !Array.isArray(data.data)) {
            throw new ProviderError(
                'Embedding response did not contain a data array. ' + 'The endpoint may not support embeddings.',
                0,
                response.text
            );
        }

        const embeddings: number[][] = [];
        data.data.forEach((item: EmbeddingDataItem, i: number) => {
            const idx = item.index !== undefined ? item.index : i;
            embeddings[idx] = item.embedding;
        });

        const result: EmbedResult = {
            embeddings,
            model: data.model ?? modelConfig.model
        };

        if (data.usage) {
            result.usage = {
                promptTokens: data.usage.prompt_tokens ?? data.usage.promptTokens ?? 0,
                totalTokens: data.usage.total_tokens ?? data.usage.totalTokens ?? 0
            };
        }

        return result;
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = buildUrl(this.config.endpoint, '/models');
        const headers: Record<string, string> = {};

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const response = await safeGet(url, headers);

        if (!response || response.status !== 200) {
            return [];
        }

        const data = response.json as { data?: OpenAiModelItem[] };

        if (!data.data || !Array.isArray(data.data)) {
            return [];
        }

        return data.data.map((item: OpenAiModelItem) => ({
            id: item.id,
            ownedBy: item.owned_by
        }));
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const url = buildUrl(this.config.endpoint, '/chat/completions');
        const headers = this.buildHeaders();

        const chatModel = this.config.models.find((m) => m.role === 'chat' || m.role === 'both');
        const modelName = chatModel?.model ?? 'test';

        const body = JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false
            });

            if (response.status === 200) {
                return { ok: true };
            }

            return httpErrorResponse(response);
        } catch (err: unknown) {
            return catchErrorResponse(
                err,
                'Connection failed. Make sure your endpoint URL is the full base path (e.g., http://localhost:1234/v1)'
            );
        }
    }

    /** {@inheritDoc AiProvider.testEmbeddings} */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        try {
            const modelConfig = resolveModel(this.config.models, 'embed', undefined, this.name);
            const url = buildUrl(this.config.endpoint, '/embeddings');
            const headers = this.buildHeaders();

            const body = JSON.stringify({
                model: modelConfig.model,
                input: 'test'
            });

            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false
            });

            if (response.status === 200) {
                return { ok: true };
            }

            return httpErrorResponse(response);
        } catch (err: unknown) {
            return catchErrorResponse(err, 'Embeddings test failed');
        }
    }
}
