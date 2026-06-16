/** Provider type identifier — determines which concrete provider class is instantiated. */
export type ProviderType = 'openai-compatible' | 'ollama';

/** Configuration for a single provider endpoint. Stored in settings as part of an array. */
export interface ProviderConfig {
    /** Unique identifier (UUID or slug) for this provider config. */
    id: string;
    /** Human-readable display name, e.g. "LM Studio Local" or "NanoGPT Cloud". */
    name: string;
    /** Provider type — determines the concrete provider class used. */
    type: ProviderType;
    /** Full base URL, used as-is with no path manipulation. */
    endpoint: string;
    /** API key for cloud providers; empty for local providers. */
    apiKey: string;
    /** One or more model configs available on this endpoint. */
    models: ModelConfig[];
    /** Context window token limit for models on this endpoint. Default: 32768. */
    maxContextTokens: number;
    /** Maximum output tokens per response for all models on this endpoint. Default: 4096. */
    maxOutputTokens: number;
}

/** Configuration for a single model on a provider endpoint. */
export interface ModelConfig {
    /** Unique identifier for this model within its provider. */
    id: string;
    /** What this model is used for: chat, embeddings, or both. */
    role: 'chat' | 'embed' | 'both';
    /** Model identifier sent to the API, e.g. "llama-3.3-70b". */
    model: string;
}

/** Information about a model returned by the provider's model listing endpoint. */
export interface ModelInfo {
    /** Model identifier as returned by the /models endpoint. */
    id: string;
    /** Owner/organization if provided (e.g. "meta", "openai"). */
    ownedBy?: string;
    /** Context window size if provided by the endpoint. */
    contextLength?: number;
}

/** A single message in a chat conversation. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** Options for a chat completion request. */
export interface ChatOptions {
    messages: ChatMessage[];
    /** Override the provider's default chat model. */
    model?: string;
    /** Override the provider-level maxOutputTokens. */
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
}

/** Options for an embedding request. */
export interface EmbedOptions {
    input: string | string[];
    /** Override the provider's default embed model. */
    model?: string;
}

/** Result of an embedding request. */
export interface EmbedResult {
    embeddings: number[][];
    model: string;
    usage?: { promptTokens: number; totalTokens: number };
}

/** A single chunk from a streaming chat completion. */
export interface ChatChunk {
    text: string;
    /** Reasoning / thinking content, if the model supports it (Claude extended thinking,
     *  OpenAI reasoning, or DeepSeek R1 style  tags). */
    thought?: string;
    /** True for the final chunk in the stream. */
    done: boolean;
    model?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Error thrown by provider implementations on HTTP or API errors. */
export class ProviderError extends Error {
    /** HTTP status code, or 0 for network errors. */
    status: number;
    /** Raw response body text, if available. */
    body: string;

    /**
     * @param message - Human-readable error description.
     * @param status  - HTTP status code, or 0 for network / non-HTTP errors.
     * @param body    - Raw response body text, if available from the server.
     */
    constructor(message: string, status: number, body: string) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
        this.body = body;
    }
}

/** Pluggable AI provider interface. Every concrete provider implements this contract. */
export interface AiProvider {
    /** Matches ProviderConfig.id. */
    readonly id: string;
    /** Matches ProviderConfig.name. */
    readonly name: string;
    /** Full config for model lookup and metadata. */
    readonly config: ProviderConfig;

    /**
     * Stream a chat completion response token by token.
     * Yields ChatChunk objects as tokens arrive, with a final chunk where done === true.
     */
    chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk>;

    /** Generate embeddings for the given input text(s). */
    embed(options: EmbedOptions): Promise<EmbedResult>;

    /** Fetch the list of available models from this provider's endpoint. Returns empty array on error. */
    listModels(): Promise<ModelInfo[]>;

    /** Test the provider's chat endpoint with a minimal request. */
    testConnection(): Promise<{ ok: boolean; error?: string }>;

    /** Test the provider's embeddings endpoint with a minimal request. */
    testEmbeddings(): Promise<{ ok: boolean; error?: string }>;
}
