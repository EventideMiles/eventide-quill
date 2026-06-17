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
    ollamaNdjsonLineToChunk,
    ollamaNdjsonToChunks,
    parseNdjsonStream,
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
     * {@inheritDoc AiProvider.chatCompletion}
     *
     * On desktop this streams the NDJSON response incrementally via native fetch.
     * On mobile it falls back to a buffered requestUrl call.
     */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const modelConfig = resolveModel(this.config.models, 'chat', options.model, this.name);

        const url = buildUrl(this.config.endpoint, '/api/chat');
        const body = JSON.stringify({
            model: modelConfig.model,
            messages: options.messages.map((m) => ({
                role: m.role,
                content: m.content
            })),
            stream: true,
            options: {
                temperature: options.temperature ?? 0.7,
                num_predict: options.maxTokens ?? this.config.maxOutputTokens
            }
        });

        const headers = { 'Content-Type': 'application/json' };

        if (isStreamingSupported()) {
            const reader = await streamResponseWithCatch(url, {
                method: 'POST',
                headers,
                body,
                signal: options.signal
            });

            let lastChunkDone = false;
            let pendingThought = '';
            for await (const rawLine of parseNdjsonStream(reader, options.signal)) {
                const chunk = ollamaNdjsonLineToChunk(rawLine);
                if (chunk.text) {
                    const extracted = extractThoughtContent(chunk.text, pendingThought);
                    chunk.text = extracted.text;
                    if (extracted.thought) {
                        chunk.thought = extracted.thought;
                    }
                    pendingThought = extracted.pendingThought;
                }
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
            throw: false
        });

        throwOnNonOk(response, 'Chat completion');

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
        for await (const chunk of processChunksWithThoughts(chunks, { signal: options.signal })) {
            yield chunk;
        }
    }

    /** {@inheritDoc AiProvider.embed} */
    async embed(options: EmbedOptions): Promise<EmbedResult> {
        const modelConfig = resolveModel(this.config.models, 'embed', options.model, this.name);

        if (Array.isArray(options.input)) {
            throw new ProviderError(
                'Batch embeddings are not supported by the Ollama provider. ' +
                    'The /api/embeddings endpoint only accepts a single prompt. ' +
                    'Send one document at a time or use an OpenAI-compatible provider.',
                0,
                ''
            );
        }

        const url = buildUrl(this.config.endpoint, '/api/embeddings');
        const body = JSON.stringify({
            model: modelConfig.model,
            prompt: options.input
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            throw: false
        });

        throwOnNonOk(response, 'Embedding request');

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
                'Embedding response did not contain an embedding array. ' + 'The endpoint may not support embeddings.',
                0,
                response.text
            );
        }

        const result: EmbedResult = {
            embeddings,
            model: data.model ?? modelConfig.model
        };

        if (data.prompt_eval_count !== undefined) {
            result.usage = {
                promptTokens: data.prompt_eval_count,
                totalTokens: data.prompt_eval_count
            };
        }

        return result;
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = buildUrl(this.config.endpoint, '/api/tags');
        const response = await safeGet(url);

        if (!response || response.status !== 200) {
            return [];
        }

        const data = response.json as OllamaTagsResponse;

        if (!data.models || !Array.isArray(data.models)) {
            return [];
        }

        return data.models.map((item: OllamaTagModel) => ({
            id: item.name,
            ownedBy: item.details?.family ?? 'ollama'
        }));
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const url = buildUrl(this.config.endpoint, '/api/tags');

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'GET',
                throw: false
            });

            if (response.status === 200) {
                return { ok: true };
            }

            return httpErrorResponse(response);
        } catch (err: unknown) {
            return catchErrorResponse(
                err,
                'Connection failed. Make sure Ollama is running and your endpoint URL is correct (e.g., http://localhost:11434)'
            );
        }
    }

    /** {@inheritDoc AiProvider.testEmbeddings} */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        const modelConfig = resolveModel(this.config.models, 'embed', undefined, this.name);
        const url = buildUrl(this.config.endpoint, '/api/embeddings');

        const body = JSON.stringify({
            model: modelConfig.model,
            prompt: 'test'
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
