import { requestUrl, type RequestUrlResponse } from 'obsidian';
import {
    AiProvider,
    buildUrl,
    ChatChunk,
    ChatMessage,
    ChatOptions,
    EmbedOptions,
    EmbedResult,
    ModelInfo,
    ProviderConfig,
    ProviderError,
    resolveModel,
    roleSatisfies,
    ToolChoice,
    ToolDefinition
} from './provider';
import { AnthropicStreamAggregator, parseSseEvents, parseSseStream, type SseEvent } from './streaming';
import {
    isStreamingSupported,
    streamResponseWithCatch,
    throwOnNonOk,
    catchErrorResponse,
    httpErrorResponse,
    safeGet,
    requestUrlMobile
} from './transport';

/**
 * Base API version this provider speaks. Prompt caching and extended thinking
 * are GA as of this version — no `anthropic-beta` header required.
 */
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Minimum output tokens required above the thinking budget so the model has
 * room for at least one non-thinking token after reasoning. Anthropic rejects
 * requests where `max_tokens <= thinking.budget_tokens`.
 */
const MIN_OUTPUT_TOKENS_AROUND_THINKING = 1;

/** Wire shape of an Anthropic system-text content block. */
interface AnthropicSystemBlock {
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
}

/** Wire shape of an Anthropic assistant-side content block. */
type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Wire shape of an Anthropic request message. */
interface AnthropicRequestMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

/** Wire shape of one entry in Anthropic's `/v1/models` response. */
interface AnthropicModelItem {
    id: string;
    display_name?: string;
    type?: string;
    max_input_tokens?: number;
    capabilities?: { image_input?: { supported?: boolean } };
}

/** Convert a Quill {@link ToolChoice} to Anthropic's tool_choice value. */
function serializeAnthropicToolChoice(choice: ToolChoice): { type: string; name?: string } {
    if (choice === 'auto') return { type: 'auto' };
    if (typeof choice === 'object' && choice.type === 'function') {
        return { type: 'tool', name: choice.function.name };
    }
    // 'none' is filtered out by the caller (we omit tools entirely).
    return { type: 'auto' };
}

/** Convert a Quill {@link ToolDefinition} to Anthropic's tools-array shape. */
function serializeAnthropicTool(t: ToolDefinition): {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
} {
    return {
        name: t.name,
        description: t.description,
        // Anthropic calls this `input_schema` where OpenAI calls it `parameters`.
        input_schema: t.parameters
    };
}

/**
 * Build the Anthropic `/v1/messages` request body from Quill's provider-agnostic
 * {@link ChatMessage} array. Exported for fixture-driven tests that verify the
 * wire shape matches what Anthropic expects without making a real HTTP call.
 *
 * Behaviour summary (see {@link AnthropicProvider} for the full contract):
 *
 * - Leading `system` messages are hoisted into a top-level `system` block
 *   array; the last block carries `cache_control: { type: 'ephemeral' }` so
 *   the prefix is reused across turns at cache pricing.
 * - `role: 'tool'` messages become `role: 'user'` with a `tool_result`
 *   content block referencing the prior `tool_use_id`.
 * - Assistant messages with `toolCalls` or `thinkingBlocks` expand into the
 *   appropriate content-block array, with thinking first.
 * - Images attach as `{ type: 'image', source: { type: 'base64', ... } }`
 *   blocks (user or assistant).
 * - When `config.thinkingBudgetTokens > 0`, sets `thinking` and forces
 *   `temperature: 1`; clamps `max_tokens` if it would not leave room for at
 *   least one non-thinking token.
 * - When `toolChoice === 'none'`, tools are omitted entirely (Anthropic has
 *   no 'none' tool-choice value).
 */
export function buildAnthropicRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    config: Pick<ProviderConfig, 'models' | 'maxOutputTokens' | 'thinkingBudgetTokens'>,
    providerName: string
): Record<string, unknown> {
    const modelConfig = resolveModel(config.models, 'chat', options.model, providerName);

    const systemBlocks: AnthropicSystemBlock[] = [];
    const requestMessages: AnthropicRequestMessage[] = [];
    let inLeadingSystem = true;

    for (const m of messages) {
        // Hoist a contiguous prefix of system messages into the top-level
        // `system` param. The first non-system message flips the flag so
        // any stray system message later in the array stays in `messages`
        // (Anthropic would reject it there — see provider contract).
        if (m.role === 'system' && inLeadingSystem) {
            systemBlocks.push({ type: 'text', text: m.content });
            continue;
        }
        inLeadingSystem = false;

        if (m.role === 'system') {
            // Non-leading system message — concatenate into the nearest
            // prior user message as a text block rather than risk a 400.
            // No current call site emits these, but defensive handling
            // keeps the provider robust to future drift.
            if (requestMessages.length > 0 && requestMessages[requestMessages.length - 1]!.role === 'user') {
                const last = requestMessages[requestMessages.length - 1]!;
                if (typeof last.content === 'string') {
                    last.content = last.content + '\n\n' + m.content;
                }
            } else {
                requestMessages.push({ role: 'user', content: m.content });
            }
            continue;
        }

        if (m.role === 'tool') {
            requestMessages.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: m.toolCallId ?? '',
                        // Anthropic accepts string content for tool_result.
                        content: m.content
                    }
                ]
            });
            continue;
        }

        // user or assistant
        const isAssistant = m.role === 'assistant';

        const blocks: AnthropicContentBlock[] = [];

        // Thinking blocks come first (Anthropic's content-ordering rule).
        // Both signed thinking and opaque redacted_thinking blocks must be
        // replayed verbatim alongside their sibling tool_use blocks.
        if (isAssistant && m.thinkingBlocks) {
            for (const tb of m.thinkingBlocks) {
                if ('data' in tb) {
                    blocks.push({ type: 'redacted_thinking', data: tb.data });
                } else {
                    blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
                }
            }
        }

        if (m.content !== undefined && m.content !== '') {
            blocks.push({ type: 'text', text: m.content });
        }

        // Tool-use blocks (assistant side).
        if (isAssistant && m.toolCalls && m.toolCalls.length > 0) {
            for (const tc of m.toolCalls) {
                let input: unknown = {};
                try {
                    input = JSON.parse(tc.arguments);
                } catch {
                    // Keep empty object — provider will surface an error if the model
                    // can't make sense of the call when it round-trips.
                }
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
            }
        }

        // Image blocks (user or assistant — Anthropic accepts both).
        if ((m.role === 'user' || m.role === 'assistant') && m.images && m.images.length > 0) {
            for (const img of m.images) {
                // Quill already normalizes to JPEG base64 without a data:
                // prefix (see vision.ts / image-utils.ts), so we pass the
                // raw base64 through directly.
                blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/jpeg', data: img }
                });
            }
        }

        // Compact shape: a single text-only block can be sent as a string.
        const compact = blocks.length === 1 && blocks[0]!.type === 'text' && (!m.images || m.images.length === 0);
        requestMessages.push({
            role: isAssistant ? 'assistant' : 'user',
            content: compact ? (blocks[0] as { type: 'text'; text: string }).text : blocks
        });
    }

    const body: Record<string, unknown> = {
        model: modelConfig.model,
        // Anthropic requires max_tokens (unlike OpenAI where it's optional).
        max_tokens: options.maxTokens ?? config.maxOutputTokens,
        messages: requestMessages,
        stream: true
    };

    // Temperature: clamp to 1.0 if extended thinking is on (Anthropic
    // rejects any other value when thinking is enabled). Otherwise pass
    // through, clamping to the [0, 1] range Anthropic accepts.
    const wantsThinking = (config.thinkingBudgetTokens ?? 0) > 0;
    if (wantsThinking) {
        body.temperature = 1;
    } else {
        const t = options.temperature ?? 0.7;
        body.temperature = Math.min(1, Math.max(0, t));
    }

    // Attach the system blocks (with caching on the last block) when present.
    if (systemBlocks.length > 0) {
        systemBlocks[systemBlocks.length - 1]!.cache_control = { type: 'ephemeral' };
        body.system = systemBlocks;
    }

    // Tools — but only when toolChoice isn't 'none'. Anthropic has no
    // 'none' tool-choice value; the way to bar the model from calling is
    // to omit the tools entirely.
    if (options.tools && options.tools.length > 0 && options.toolChoice !== 'none') {
        body.tools = options.tools.map((t) => serializeAnthropicTool(t));
        body.tool_choice = serializeAnthropicToolChoice(options.toolChoice ?? 'auto');
    }

    // Extended thinking — opt-in via per-provider config.
    if (wantsThinking) {
        const budget = config.thinkingBudgetTokens!;
        // Clamp max_tokens to leave at least one token for the response.
        const currentMax = (body.max_tokens as number) ?? config.maxOutputTokens;
        if (currentMax <= budget) {
            body.max_tokens = budget + MIN_OUTPUT_TOKENS_AROUND_THINKING;
        }
        body.thinking = { type: 'enabled', budget_tokens: budget };
    }

    return body;
}

/**
 * Provider for Anthropic's native Messages API. Speaks `/v1/messages` with the
 * native wire format rather than the OpenAI-compat shim, so it can use:
 *
 * - **Prompt caching** — leading system/context-head messages are marked with
 *   `cache_control: { type: 'ephemeral' }` so they're reused across turns at
 *   ~10% of the input-token cost. Big cost win for long co-writer sessions
 *   whose context heads are stable across turns.
 * - **Extended thinking** — when {@link ProviderConfig.thinkingBudgetTokens}
 *   is set, the model's chain-of-thought is requested and routed through
 *   {@link ChatChunk.thought}; thinking blocks are persisted on the assistant
 *   message (via {@link ChatMessage.thinkingBlocks}) and replayed on
 *   subsequent turns so tool rounds keep thinking continuity.
 *
 * Embeddings are not provided by Anthropic (their embedding offering lives on
 * a separate Voyage-hosted API). `embed` / `testEmbeddings` return a clear
 * error so the writer configures a different provider for that role.
 *
 * Note on content policy: Anthropic's Usage Policy flatly prohibits sexually
 * explicit content and graphic violence regardless of whether the writer is
 * using the consumer app or the API. The plugin surfaces this risk in the
 * Add-Provider flow (inline note + one-time confirmation modal) — see
 * `settings.ts`.
 */
export class AnthropicProvider implements AiProvider {
    readonly id: string;
    readonly name: string;
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.id = config.id;
        this.name = config.name;
        this.config = config;
    }

    /**
     * Build the common headers for API requests. Anthropic uses the
     * `x-api-key` header (not `Authorization: Bearer`) plus a pinned
     * `anthropic-version`.
     */
    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION
        };
        if (this.config.apiKey) {
            headers['x-api-key'] = this.config.apiKey;
        }
        return headers;
    }

    /**
     * {@inheritDoc AiProvider.chatCompletion}
     *
     * On desktop this streams the SSE response incrementally via native fetch.
     * On mobile it falls back to a buffered requestUrl call. Both paths
     * route through {@link AnthropicStreamAggregator} so the chunk shape is
     * identical.
     */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const bodyObj = buildAnthropicRequestBody(options.messages, options, this.config, this.name);
        const url = buildUrl(this.config.endpoint, '/messages');
        const headers = this.buildHeaders();
        const body = JSON.stringify(bodyObj);

        if (isStreamingSupported()) {
            const reader = await streamResponseWithCatch(url, {
                method: 'POST',
                headers,
                body,
                signal: options.signal
            });

            // The aggregator stamps captured thinking blocks onto the terminal
            // done chunk (message_delta / message_stop); tool-loop consumers
            // read chunk.thinkingBlocks and attach them to the NEW assistant
            // message they append after streaming. The provider no longer
            // mutates the input messages array.
            const aggregator = new AnthropicStreamAggregator();
            for await (const event of parseSseStream(reader, options.signal)) {
                for (const chunk of aggregator.processEvent(event)) {
                    yield chunk;
                }
            }

            return;
        }

        // Mobile fallback: buffer the full response. requestUrlMobile applies
        // the mobile network-drop hint (requestUrl has no abort hook and the OS
        // may kill this call on background) — see transport.requestUrlMobile.
        const response = await requestUrlMobile({ url, method: 'POST', headers, body });

        throwOnNonOk(response, 'Chat completion');

        const events: SseEvent[] = parseSseEvents(response.text);
        const aggregator = new AnthropicStreamAggregator();
        const chunks = events.flatMap((e) => aggregator.processEvent(e));
        if (chunks.length === 0 || !chunks[chunks.length - 1]!.done) {
            chunks.push({ text: '', done: true });
        }

        for (const chunk of chunks) {
            if (options.signal?.aborted) return;
            yield chunk;
        }
    }

    /**
     * Not supported. Anthropic's Messages API does not include an embeddings
     * endpoint (their embedding offering is hosted under a separate Voyage
     * AI integration). Configure a different provider for the embed role.
     */
    async embed(_options: EmbedOptions): Promise<EmbedResult> {
        throw new ProviderError(
            'Anthropic does not provide an embeddings API. Configure a separate provider ' +
                '(OpenAI-compatible, Ollama, or Gemini) for the embed role.',
            0,
            ''
        );
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = buildUrl(this.config.endpoint, '/models');
        const headers = this.buildHeaders();

        const response = await safeGet(url, headers);

        if (!response || response.status !== 200) {
            return [];
        }

        const data = response.json as { data?: AnthropicModelItem[]; has_more?: boolean };

        if (!data.data || !Array.isArray(data.data)) {
            return [];
        }

        return data.data.map((item: AnthropicModelItem) => ({
            id: item.id,
            // display_name (e.g. "Claude Sonnet 4.5") makes the picker more
            // readable than the bare id ("claude-sonnet-4-5").
            ownedBy: item.display_name ?? 'anthropic',
            // Anthropic exposes max_input_tokens which is more accurate than
            // the user-configured maxContextTokens; surface it so the picker
            // can hint at the real context window.
            contextLength: item.max_input_tokens
        }));
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const url = buildUrl(this.config.endpoint, '/messages');
        const headers = this.buildHeaders();

        const chatModel = this.config.models.find((m) => roleSatisfies(m.role, 'chat'));
        const modelName = chatModel?.model ?? 'claude-3-5-haiku-latest';

        const body = JSON.stringify({
            model: modelName,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
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
                'Connection failed. Make sure your endpoint URL is the full base path ' +
                    '(e.g., https://api.anthropic.com/v1) and your API key is valid.'
            );
        }
    }

    /**
     * Not supported. Anthropic has no embeddings endpoint to test; `embed`
     * throws a clear ProviderError for the same reason.
     */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        return {
            ok: false,
            error: 'Anthropic does not provide an embeddings API. Use a different provider for embeddings.'
        };
    }
}
