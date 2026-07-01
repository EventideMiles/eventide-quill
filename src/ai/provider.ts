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

/**
 * A model's configured role(s) on its provider. Determines which capability
 * requests (`ModelCapability`) the model satisfies — see {@link roleSatisfies}.
 *
 * - `chat`       — text chat only.
 * - `embed`      — embeddings only.
 * - `both`       — chat + embeddings (legacy combined role).
 * - `chat-image` — chat + vision. One model handles text and images (the
 *                  recommended setup for vision-capable chat models such as
 *                  Gemma 4 / LLaVA). Avoids model-swapping mid-conversation.
 * - `image`      — vision only. A dedicated image model used as a stateless
 *                  translator when the chat model is text-only (Regime B).
 */
export type ModelRole = 'chat' | 'embed' | 'both' | 'chat-image' | 'image';

/**
 * A capability being requested of a model (the "request" side of
 * {@link roleSatisfies}). Multi-capability roles (`both`, `chat-image`) are
 * never requested directly — callers request a single capability and
 * `roleSatisfies` decides which roles fill it.
 */
export type ModelCapability = 'chat' | 'embed' | 'image';

/**
 * Whether a model with the given role satisfies the requested capability.
 *
 * - `chat`  ← `chat`, `both`, `chat-image`
 * - `embed` ← `embed`, `both`
 * - `image` ← `image`, `chat-image`
 *
 * Replaces the older `m.role === role || m.role === 'both'` checks so that the
 * new vision roles participate in resolution without each call site branching.
 */
export function roleSatisfies(role: ModelRole, capability: ModelCapability): boolean {
    if (capability === 'chat') return role === 'chat' || role === 'both' || role === 'chat-image';
    if (capability === 'embed') return role === 'embed' || role === 'both';
    return role === 'image' || role === 'chat-image'; // capability === 'image'
}

/** Configuration for a single model on a provider endpoint. */
export interface ModelConfig {
    /** Unique identifier for this model within its provider. */
    id: string;
    /** What this model is used for. See {@link ModelRole} for the meaning of each value. */
    role: ModelRole;
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
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /**
     * Base64-encoded image data (no `data:` prefix) attached to a user or
     * assistant turn. Providers serialize this into their native vision format:
     * OpenAI-compatible endpoints receive an `image_url` content array; Ollama
     * receives a sibling `images` field. Ignored on `system`/`tool` messages
     * (neither API accepts images there). Only reaches a provider when the
     * resolved chat model is vision-capable; otherwise {@link resolveImageInjection}
     * translates the image to a text description before it gets here.
     */
    images?: string[];
    /**
     * Present on assistant messages that requested one or more tool calls.
     * The provider formats these as `tool_calls` in the request body so the
     * model sees its prior tool invocations in conversation history.
     */
    toolCalls?: ToolCallRequest[];
    /**
     * Present on `role: 'tool'` messages: the ID of the assistant tool call
     * this result answers. Required by OpenAI; Ollama is lenient but accepts it.
     */
    toolCallId?: string;
    /**
     * Present on `role: 'tool'` messages: the name of the tool that produced
     * this result. Optional but useful for debugging and required by some APIs.
     */
    name?: string;
    /**
     * Quill-internal anchor: the {@link CoWriterChatMessage.id} of the display
     * turn this API message belongs to. NOT serialized to the provider (both
     * providers build their payload by picking known fields, so this is dropped
     * on the wire). Used by co-writer rewind to truncate the model's
     * conversation (`discussCurrentMessages` / `loreCoachMessages`) in lockstep
     * with the display history: every API message in a turn — the user message,
     * the assistant response(s), and any `tool` results — carries the same id,
     * so a rewind drops the whole turn atomically. System/context-head messages
     * have none and are always retained.
     */
    quillAnchorId?: string;
}

/**
 * A complete tool call request emitted by the model (after stream accumulation).
 * The arguments field is a JSON string per OpenAI's convention — parsed by the
 * tool-loop before execution.
 */
export interface ToolCallRequest {
    /** Unique ID assigned by the provider (OpenAI) or synthesized (Ollama). */
    id: string;
    /** The tool function name (e.g., "manuscript_mentions"). */
    name: string;
    /** JSON-encoded arguments string, exactly as the provider sent it. */
    arguments: string;
}

/**
 * An incremental tool call fragment streamed by the provider. OpenAI streams
 * tool calls token-by-token: the first fragment carries the id and name;
 * subsequent fragments carry argument substrings that must be concatenated.
 * The tool-loop accumulates these by `index` before executing.
 */
export interface ToolCallFragment {
    /** Position within the streamed tool_calls array — used to accumulate fragments. */
    index: number;
    /** Present on the first fragment for this index: the provider-assigned ID. */
    id?: string;
    /** Present on the first fragment for this index: the tool function name. */
    name?: string;
    /** Partial JSON arguments substring to append to the running buffer. */
    arguments?: string;
}

/**
 * A tool definition the model may call. Mirrors the OpenAI/Ollama
 * `tools` request-body shape:
 *
 *   { type: 'function', function: { name, description, parameters } }
 *
 * Internally we store the function fields flat for ergonomics; the provider
 * implementations wrap them into the request-body shape on the way out.
 */
export interface ToolDefinition {
    /** The tool function name; the model uses this as the call target. */
    name: string;
    /** Human-readable description surfaced to the model. */
    description: string;
    /**
     * JSON Schema describing the parameters object the model should emit.
     * Example: `{ type: 'object', properties: {...}, required: [...] }`.
     * Stored as an opaque record — the provider passes it through verbatim.
     */
    parameters: Record<string, unknown>;
}

/**
 * Controls how the model selects tools when `tools` is set on a request.
 * - `'auto'` (default) — the model decides whether to call a tool.
 * - `'none'` — tools are listed but the model must not call any.
 * - `{ type: 'function', function: { name } }` — force-call a specific tool.
 */
export type ToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

/** Options for a chat completion request. */
export interface ChatOptions {
    messages: ChatMessage[];
    /** Override the provider's default chat model. */
    model?: string;
    /** Override the provider-level maxOutputTokens. */
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    /**
     * Tools the model may call. When set, the provider includes a `tools`
     * field in the request body and the model is permitted to emit
     * `tool_calls` in its response. Tools are ignored if the model's API
     * or chat template doesn't support them — the request will fail with
     * a provider-specific error in that case.
     */
    tools?: ToolDefinition[];
    /** How the model selects tools. Defaults to `'auto'` when `tools` is set. */
    toolChoice?: ToolChoice;
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
    /**
     * Incremental tool-call fragments, when the model is calling tools. Each
     * fragment carries an `index` used to accumulate the call across chunks;
     * the first fragment for an index carries the id and name. Consumers
     * accumulate fragments by index, parse the arguments JSON, and execute
     * the tool when the stream completes.
     */
    toolCalls?: ToolCallFragment[];
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

/**
 * Resolve a model identifier from a provider's models list.
 * If modelId is provided, returns that specific model (the caller's choice is
 * trusted — the capability filter does not apply, which lets callers route to
 * a model whose role doesn't match `role`, e.g. the vision proxy addressing an
 * `image`-role model via chatCompletion). Otherwise returns the first model
 * whose role satisfies the requested capability via {@link roleSatisfies}.
 * @param models - The provider's models array.
 * @param role   - The required capability ('chat', 'embed', or 'image').
 * @param modelId - Optional specific model ID to look up.
 * @param name   - Provider display name (used in error messages).
 * @returns The resolved ModelConfig.
 * @throws ProviderError if no matching model is found.
 */
export function resolveModel(
    models: ModelConfig[],
    role: ModelCapability,
    modelId: string | undefined,
    name: string
): ModelConfig {
    if (modelId) {
        // Explicit id: trust the caller's choice. The capability filter below
        // only governs the default (no-id) selection. This lets callers route
        // to a model whose role doesn't satisfy `role` but which they have a
        // specific reason to use — notably the vision proxy addressing an
        // `image`-role model through chatCompletion.
        const found = models.find((m) => m.id === modelId);
        if (found) return found;
        throw new ProviderError(`No model with id "${modelId}" configured for provider "${name}".`, 0, '');
    }

    const fallback = models.find((m) => roleSatisfies(m.role, role));
    if (!fallback) {
        throw new ProviderError(
            `No ${role} model configured for provider "${name}". ` +
                'Add a model with the appropriate role in settings.',
            0,
            ''
        );
    }

    return fallback;
}

/**
 * Build a full URL by appending a path segment to the configured endpoint.
 * Strips trailing slashes from the base and ensures the path starts with '/'.
 * @param endpoint - The provider's base endpoint URL.
 * @param path     - The API path segment (with or without leading '/').
 * @returns The full URL.
 */
export function buildUrl(endpoint: string, path: string): string {
    const base = endpoint.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${cleanPath}`;
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
