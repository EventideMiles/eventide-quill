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
import { ollamaNdjsonLineToChunk, ollamaNdjsonToChunks, parseNdjsonStream } from './streaming';
import { HttpError, isStreamingSupported, streamResponse } from './transport';

/** Maximum characters to include in error messages from response bodies. */
const ERROR_BODY_TRUNCATE_LENGTH = 500;

/** Shape of a single model in the Ollama /api/tags response. */
interface OllamaTagModel {
    name: string;
    size?: number;
    details?: {
        family?: string;
        parameter_size?: string;
        quantization_level?: string;
    };
}

/** Shape of an Ollama /api/tags response. */
interface OllamaTagsResponse {
    models?: OllamaTagModel[];
}

/** Shape of an Ollama /api/embeddings response. */
interface OllamaEmbedResponse {
    embedding?: number[];
    embeddings?: number[][];
    model?: string;
    prompt_eval_count?: number;
}

/**
 * Ollama is a first-class provider type with native model listing (`/api/tags`),
 * native NDJSON chat (`/api/chat`), and native embeddings (`/api/embeddings`).
 *
 * This provider gives Ollama users a better experience than pointing the
 * OpenAI-compatible provider at `:11434/v1`: it parses model metadata, streams
 * via NDJSON (not SSE), and hides the API key field entirely.
 */
export class OllamaProvider implements AiProvider {
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
            // Treat unknown model IDs as raw model strings
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
     * Build the full URL by appending a path segment to the configured endpoint.
     * Uses a simple string join with no path normalization.
     */
    private buildUrl(path: string): string {
        const base = this.config.endpoint.replace(/\/+$/, '');
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${base}${cleanPath}`;
    }

    /**
     * {@inheritDoc AiProvider.chatCompletion}
     *
     * On desktop this streams the NDJSON response incrementally via native fetch.
     * On mobile it falls back to a buffered requestUrl call.
     */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const modelConfig = this.resolveModel('chat', options.model);

        const url = this.buildUrl('/api/chat');
        const body = JSON.stringify({
            model: modelConfig.model,
            messages: options.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            stream: true,
            options: {
                temperature: options.temperature ?? 0.7,
                num_predict: options.maxTokens ?? this.config.maxOutputTokens,
            },
        });

        const headers = { 'Content-Type': 'application/json' };

        if (isStreamingSupported()) {
            let reader: ReadableStreamDefaultReader<Uint8Array>;
            try {
                const result = await streamResponse(url, {
                    method: 'POST',
                    headers,
                    body,
                    signal: options.signal,
                });
                reader = result.reader;
            } catch (err: unknown) {
                if (err instanceof HttpError) {
                    throw new ProviderError(
                        `Chat completion failed (HTTP ${err.status}): ${err.body.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
                        err.status,
                        err.body,
                    );
                }
                throw err;
            }

            let lastChunkDone = false;
            for await (const rawLine of parseNdjsonStream(reader, options.signal)) {
                const chunk = ollamaNdjsonLineToChunk(rawLine);
                if (chunk.done) lastChunkDone = true;
                yield chunk;
            }

            if (!lastChunkDone) {
                yield { text: '', done: true };
            }

            return;
        }

        // Mobile fallback: buffer the full response
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

        const lines: Record<string, unknown>[] = [];
        for (const line of response.text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                lines.push(parsed);
            } catch {
                // Skip malformed lines
                continue;
            }
        }

        const chunks = ollamaNdjsonToChunks(lines);

        for (const chunk of chunks) {
            if (options.signal?.aborted) return;
            yield chunk;
        }
    }

    /** {@inheritDoc AiProvider.embed} */
    async embed(options: EmbedOptions): Promise<EmbedResult> {
        const modelConfig = this.resolveModel('embed', options.model);

        if (Array.isArray(options.input)) {
            throw new ProviderError(
                'Batch embeddings are not supported by the Ollama provider. ' +
                'The /api/embeddings endpoint only accepts a single prompt. ' +
                'Send one document at a time or use an OpenAI-compatible provider.',
                0,
                '',
            );
        }

        const url = this.buildUrl('/api/embeddings');
        const body = JSON.stringify({
            model: modelConfig.model,
            prompt: options.input,
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

        const data = response.json as OllamaEmbedResponse;

        // Ollama returns { embedding: [...] } for single prompts
        // or { embeddings: [[...], [...]] } for batch prompts
        let embeddings: number[][];

        if (Array.isArray(data.embeddings)) {
            embeddings = data.embeddings;
        } else if (Array.isArray(data.embedding)) {
            embeddings = [data.embedding];
        } else {
            throw new ProviderError(
                'Embedding response did not contain an embedding array. ' +
                'The endpoint may not support embeddings.',
                0,
                response.text,
            );
        }

        const result: EmbedResult = {
            embeddings,
            model: data.model ?? modelConfig.model,
        };

        if (data.prompt_eval_count !== undefined) {
            result.usage = {
                promptTokens: data.prompt_eval_count,
                totalTokens: data.prompt_eval_count,
            };
        }

        return result;
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = this.buildUrl('/api/tags');

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'GET',
                throw: false,
            });

            if (response.status !== 200) {
                return [];
            }

            const data = response.json as OllamaTagsResponse;

            if (!data.models || !Array.isArray(data.models)) {
                return [];
            }

            return data.models.map(
                (item: OllamaTagModel) => ({
                    id: item.name,
                    ownedBy: item.details?.family ?? 'ollama',
                }),
            );
        } catch {
            return [];
        }
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const url = this.buildUrl('/api/tags');

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'GET',
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
                error: `Connection failed: ${message}. Make sure Ollama is running and your endpoint URL is correct (e.g., http://localhost:11434).`,
            };
        }
    }

    /** {@inheritDoc AiProvider.testEmbeddings} */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        const modelConfig = this.resolveModel('embed');
        const url = this.buildUrl('/api/embeddings');

        const body = JSON.stringify({
            model: modelConfig.model,
            prompt: 'test',
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
