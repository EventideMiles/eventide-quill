import { requestUrl, type RequestUrlResponse } from 'obsidian';
import {
    AiProvider,
    ChatChunk,
    ChatOptions,
    EmbedOptions,
    EmbedResult,
    ModelConfig,
    ModelInfo,
    ProviderConfig,
    ProviderError,
} from './provider';
import { openAiEventsToChunks, parseSseEvents } from './streaming';

/** Maximum characters to include in error messages from response bodies. */
const ERROR_BODY_TRUNCATE_LENGTH = 500;

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
     * Resolve a model identifier from the provider's config.models list.
     * If modelId is provided, looks up that specific model. Otherwise uses the
     * first model with a role matching the given role.
     */
    private resolveModel(role: ModelConfig['role'], modelId?: string): ModelConfig {
        if (modelId) {
            const found = this.config.models.find((m) => m.id === modelId);
            if (found) return found;
            // If the modelId isn't found in our config, treat it as a raw model string
            return { id: modelId, role, model: modelId };
        }

        const fallback = this.config.models.find(
            (m) => m.role === role || m.role === 'both',
        );
        if (!fallback) {
            throw new ProviderError(
                `No ${role} model configured for provider "${this.name}". ` +
                'Add a model with the appropriate role in settings.',
                0,
                '',
            );
        }

        return fallback;
    }

    /**
     * Build the common headers for API requests.
     * Omits the Authorization header if no API key is configured.
     */
    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        return headers;
    }

    /**
     * Build the full URL by appending a path segment to the configured endpoint.
     * Uses a simple string join — no path normalization, no trailing-slash stripping.
     * This preserves the user's endpoint URL exactly as they entered it.
     */
    private buildUrl(path: string): string {
        const base = this.config.endpoint.replace(/\/+$/, '');
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${base}${cleanPath}`;
    }

    /** {@inheritDoc AiProvider.chatCompletion} */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const modelConfig = this.resolveModel('chat', options.model);

        const url = this.buildUrl('/chat/completions');
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            model: modelConfig.model,
            messages: options.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            max_tokens: options.maxTokens ?? this.config.maxOutputTokens,
            temperature: options.temperature ?? 0.7,
            stream: true,
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers,
            body,
            throw: false,
        });

        if (response.status !== 200) {
            throw new ProviderError(
                `Chat completion failed (HTTP ${response.status}): ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
                response.status,
                response.text,
            );
        }

        const events = parseSseEvents(response.text);
        const chunks = openAiEventsToChunks(events);

        for (const chunk of chunks) {
            if (options.signal?.aborted) return;
            yield chunk;
        }
    }

    /** {@inheritDoc AiProvider.embed} */
    async embed(options: EmbedOptions): Promise<EmbedResult> {
        const modelConfig = this.resolveModel('embed', options.model);

        const url = this.buildUrl('/embeddings');
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            model: modelConfig.model,
            input: options.input,
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers,
            body,
            throw: false,
        });

        if (response.status !== 200) {
            throw new ProviderError(
                `Embedding request failed (HTTP ${response.status}): ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
                response.status,
                response.text,
            );
        }

        const data = response.json as {
            data?: EmbeddingDataItem[];
            model?: string;
            usage?: UsageInfo;
        };

        if (!data.data || !Array.isArray(data.data)) {
            throw new ProviderError(
                'Embedding response did not contain a data array. ' +
                'The endpoint may not support embeddings.',
                0,
                response.text,
            );
        }

        const embeddings: number[][] = data.data.map(
            (item: EmbeddingDataItem) => item.embedding,
        );

        const result: EmbedResult = {
            embeddings,
            model: data.model ?? modelConfig.model,
        };

        if (data.usage) {
            result.usage = {
                promptTokens: data.usage.prompt_tokens ?? data.usage.promptTokens ?? 0,
                totalTokens: data.usage.total_tokens ?? data.usage.totalTokens ?? 0,
            };
        }

        return result;
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = this.buildUrl('/models');
        const headers: Record<string, string> = {};

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'GET',
                headers,
                throw: false,
            });

            if (response.status !== 200) {
                return [];
            }

            const data = response.json as { data?: OpenAiModelItem[] };

            if (!data.data || !Array.isArray(data.data)) {
                return [];
            }

            return data.data.map(
                (item: OpenAiModelItem) => ({
                    id: item.id,
                    ownedBy: item.owned_by,
                }),
            );
        } catch {
            return [];
        }
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const url = this.buildUrl('/chat/completions');
        const headers = this.buildHeaders();

        const chatModel = this.config.models.find(
            (m) => m.role === 'chat' || m.role === 'both',
        );
        const modelName = chatModel?.model ?? 'test';

        const body = JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false,
            });

            if (response.status === 200) {
                return { ok: true };
            }

            return {
                ok: false,
                error: `HTTP ${response.status}: ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                error: `Connection failed: ${message}. Make sure your endpoint URL is the full base path (e.g., http://localhost:1234/v1).`,
            };
        }
    }

    /** {@inheritDoc AiProvider.testEmbeddings} */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        const modelConfig = this.resolveModel('embed');
        const url = this.buildUrl('/embeddings');
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            model: modelConfig.model,
            input: 'test',
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false,
            });

            if (response.status === 200) {
                return { ok: true };
            }

            return {
                ok: false,
                error: `HTTP ${response.status}: ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `Embeddings test failed: ${message}` };
        }
    }
}
