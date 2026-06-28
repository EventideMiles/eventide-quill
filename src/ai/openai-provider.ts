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
    resolveModel,
    roleSatisfies
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

        // Project messages into the OpenAI request shape. Tool-call fields
        // (`tool_calls`, `tool_call_id`, `name`) are preserved only when
        // present, so conversations without tools serialize exactly as before.
        const bodyObj: Record<string, unknown> = {
            model: modelConfig.model,
            messages: options.messages.map((m) => {
                const out: Record<string, unknown> = { role: m.role };
                if ((m.role === 'user' || m.role === 'assistant') && m.images && m.images.length > 0) {
                    // Vision content: OpenAI-compatible endpoints (LM Studio,
                    // OpenAI, etc.) accept an array of typed content parts.
                    // Role-gated to user/assistant turns — system/tool messages
                    // fall through to text-only below (the APIs reject image
                    // content there, matching the ChatMessage.images contract).
                    // Only vision-capable chat models reach here — a text-only
                    // model would have received a text description via
                    // resolveImageInjection instead, so this branch never
                    // sends pixels to a model that can't handle them.
                    const parts: Array<Record<string, unknown>> = [];
                    if (m.content !== undefined && m.content !== '') {
                        parts.push({ type: 'text', text: m.content });
                    }
                    for (const img of m.images) {
                        parts.push({
                            type: 'image_url',
                            image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` }
                        });
                    }
                    out.content = parts;
                } else if (m.content !== undefined) {
                    out.content = m.content;
                }
                if (m.toolCalls && m.toolCalls.length > 0) {
                    out.tool_calls = m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.arguments }
                    }));
                }
                if (m.toolCallId !== undefined) out.tool_call_id = m.toolCallId;
                if (m.name !== undefined) out.name = m.name;
                return out;
            }),
            max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
            temperature: options.temperature ?? 0.7,
            stream: true
        };

        // Attach tools when provided. The provider passes them through verbatim;
        // the model's API or chat template decides whether to use them. Models
        // without tool-call support will return an error here that surfaces to
        // the user as a ProviderError Notice.
        if (options.tools && options.tools.length > 0) {
            bodyObj.tools = options.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters }
            }));
            bodyObj.tool_choice = options.toolChoice ?? 'auto';
        }

        const body = JSON.stringify(bodyObj);

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

        const chatModel = this.config.models.find((m) => roleSatisfies(m.role, 'chat'));
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
