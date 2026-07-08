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
    resolveModel
} from './provider';
import {
    extractThoughtContent,
    geminiEventsToChunks,
    geminiResponseBlocked,
    geminiSseDataToChunk,
    type GeminiSseData,
    parseSseEvents,
    parseSseStream,
    processChunksWithThoughts,
    type SseEvent
} from './streaming';
import {
    isStreamingSupported,
    streamResponseWithCatch,
    throwOnNonOk,
    catchErrorResponse,
    httpErrorResponse,
    safeGet,
    requestUrlMobile
} from './transport';

/** Wire shape of one entry in Gemini's `contents[]` array. */
interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

/** Wire shape of a single Gemini content part. */
type GeminiPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args?: Record<string, unknown> } }
    | { functionResponse: { name: string; response?: Record<string, unknown> } };

/** Wire shape of one entry in Gemini's `models.list` response. */
interface GeminiModelItem {
    name: string;
    displayName?: string;
    description?: string;
    version?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedActions?: string[];
}

/** Wire shape of Gemini's `embedContent` response. */
interface GeminiEmbedResponse {
    embedding?: { values?: number[] };
    embeddings?: Array<{ values?: number[] }>;
    usageMetadata?: { totalTokenCount?: number };
}

/**
 * Best-effort parse of a string as JSON. Gemini's `functionResponse.response`
 * field wants a structured object; Quill stores tool-result content as a
 * string, so we attempt to parse and fall back to wrapping the raw string
 * under a `result` key (which Gemini will accept as a freeform object).
 */
function safeParseJson(text: string): Record<string, unknown> {
    if (!text) return { result: '' };
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return { result: parsed };
    } catch {
        return { result: text };
    }
}

/** Common headers — Gemini uses `x-goog-api-key` rather than Bearer auth. */
function buildGeminiHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['x-goog-api-key'] = apiKey;
    }
    return headers;
}

/**
 * Map Quill's {@link ToolChoice} to Gemini's `functionCallingConfig.mode`.
 * `'none'` becomes `'NONE'` (Gemini supports this directly, unlike
 * Anthropic), `'auto'` becomes `'AUTO'`, and a forced-call choice becomes
 * `'ANY'` with the name set in `allowedFunctionNames` (handled by the caller).
 */
function serializeGeminiToolChoice(choice: 'auto' | 'none' | { type: 'function'; function: { name: string } }): string {
    if (choice === 'auto') return 'AUTO';
    if (choice === 'none') return 'NONE';
    return 'ANY';
}

/**
 * Build the Gemini `contents` + `systemInstruction` payload from Quill's
 * provider-agnostic {@link ChatMessage} array. Exported for fixture-driven
 * tests that verify the wire shape matches what Gemini expects without making
 * a real HTTP call.
 *
 * - Leading `system` messages are concatenated into `systemInstruction`.
 * - `assistant` becomes `model`; `role: 'tool'` becomes a `user` turn with
 *   `functionResponse` parts (consolidating consecutive tool turns).
 * - Assistant `toolCalls` expand into `functionCall` parts.
 * - Images attach as `inlineData` parts alongside any text.
 */
export function buildGeminiContents(messages: ChatMessage[]): {
    systemInstruction?: { parts: { text: string }[] };
    contents: GeminiContent[];
} {
    const systemParts: { text: string }[] = [];
    const contents: GeminiContent[] = [];
    let inLeadingSystem = true;

    for (const m of messages) {
        if (m.role === 'system' && inLeadingSystem) {
            if (m.content) systemParts.push({ text: m.content });
            continue;
        }
        inLeadingSystem = false;

        if (m.role === 'system') {
            // Non-leading system message — fold into the nearest prior
            // user message as a text prefix. Defensive; no current call
            // site emits these, but keeps the provider robust to drift.
            if (contents.length > 0 && contents[contents.length - 1]!.role === 'user') {
                contents[contents.length - 1]!.parts.unshift({ text: m.content });
            } else {
                contents.push({ role: 'user', parts: [{ text: m.content }] });
            }
            continue;
        }

        if (m.role === 'tool') {
            // Consolidate consecutive tool results into one user turn.
            const last = contents[contents.length - 1];
            const part: GeminiPart = {
                functionResponse: {
                    name: m.name ?? '',
                    response: safeParseJson(m.content)
                }
            };
            if (last && last.role === 'user' && last.parts.some((p) => 'functionResponse' in p)) {
                last.parts.push(part);
            } else {
                contents.push({ role: 'user', parts: [part] });
            }
            continue;
        }

        const parts: GeminiPart[] = [];
        if (m.content !== undefined && m.content !== '') {
            parts.push({ text: m.content });
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            for (const tc of m.toolCalls) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(tc.arguments) as Record<string, unknown>;
                } catch {
                    // Pass empty args — Gemini will reject if the schema requires fields.
                }
                parts.push({ functionCall: { name: tc.name, args } });
            }
        }
        if ((m.role === 'user' || m.role === 'assistant') && m.images && m.images.length > 0) {
            for (const img of m.images) {
                parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
            }
        }
        // Avoid emitting an empty-parts message — Gemini rejects these.
        if (parts.length === 0) {
            parts.push({ text: '' });
        }
        contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts
        });
    }

    return {
        systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
        contents
    };
}

/**
 * Provider for Google's Gemini API (Google AI Studio / `generativelanguage`).
 * Speaks the native GenerateContent wire format rather than the OpenAI-compat
 * shim, so it can detect and clearly surface safety-filter blocks (the
 * OpenAI-compat endpoint silently returns empty content).
 *
 * Notes on the wire format:
 *
 * - **Roles** are `user` and `model` (not `assistant`). System content goes in
 *   a top-level `systemInstruction` field, not in `contents`.
 * - **Function calls** arrive complete (not streamed as fragments like
 *   OpenAI); the provider synthesizes one {@link ToolCallFragment} per call
 *   and re-serializes the parsed `args` object to a JSON string so Quill's
 *   arguments-are-a-string contract holds across providers.
 * - **Function results** are `functionResponse` parts inside a `user`-role
 *   message (Gemini has no `tool` role). Consecutive `role: 'tool'` messages
 *   in Quill's history are consolidated into one user message with multiple
 *   `functionResponse` parts, matching Gemini's expected conversation shape.
 * - **Safety filters**: a `finishReason` of `SAFETY`, `RECITATION`,
 *   `BLOCKLIST`, `PROHIBITED_CONTENT`, or `SPII` indicates the model refused
 *   to produce output. The provider throws a clear `ProviderError` instead of
 *   emitting empty text so the writer knows what happened.
 * - **Endpoint URL** uses the model name in the path, e.g.
 *   `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`. The
 *   configured `endpoint` should be the base path without a trailing slash.
 *
 * The Google AI Studio free tier is genuinely free (rate-limited, no credit
 * card) — model availability and free-tier limits shift between Gemini
 * generations, so prefer ListModels-driven model selection over hardcoded ids.
 */
export class GeminiProvider implements AiProvider {
    readonly id: string;
    readonly name: string;
    readonly config: ProviderConfig;

    constructor(config: ProviderConfig) {
        this.id = config.id;
        this.name = config.name;
        this.config = config;
    }

    /** Common headers for this provider's endpoint. */
    private buildHeaders(): Record<string, string> {
        return buildGeminiHeaders(this.config.apiKey);
    }

    /** {@inheritDoc AiProvider.chatCompletion} */
    async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
        const modelConfig = resolveModel(this.config.models, 'chat', options.model, this.name);
        // Gemini puts the model in the URL path, not the request body.
        const streamPath = `/models/${encodeURIComponent(modelConfig.model)}:streamGenerateContent?alt=sse`;
        const url = buildUrl(this.config.endpoint, streamPath);
        const headers = this.buildHeaders();

        const { systemInstruction, contents } = buildGeminiContents(options.messages);

        const generationConfig: Record<string, unknown> = {
            maxOutputTokens: options.maxTokens ?? this.config.maxOutputTokens,
            // Gemini accepts temperature 0–2 (broader than Anthropic's 0–1).
            temperature: options.temperature ?? 0.7
        };

        const bodyObj: Record<string, unknown> = {
            contents,
            generationConfig
        };
        if (systemInstruction) bodyObj.systemInstruction = systemInstruction;

        if (options.tools && options.tools.length > 0) {
            bodyObj.tools = [
                {
                    functionDeclarations: options.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }))
                }
            ];
            bodyObj.toolConfig = {
                functionCallingConfig: { mode: serializeGeminiToolChoice(options.toolChoice ?? 'auto') }
            };
            // For forced-tool, Gemini wants the name in allowedFunctionNames.
            if (typeof options.toolChoice === 'object' && options.toolChoice.type === 'function') {
                const cfg = bodyObj.toolConfig as { functionCallingConfig: Record<string, unknown> };
                cfg.functionCallingConfig.allowedFunctionNames = [options.toolChoice.function.name];
            }
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
                if (!event.data) continue;
                try {
                    const parsed = JSON.parse(event.data) as GeminiSseData;
                    // Detect safety blocks before yielding — the chunk would
                    // otherwise look like an empty-but-done turn, which the
                    // UI renders as "model said nothing."
                    if (geminiResponseBlocked(parsed)) {
                        throw new ProviderError(
                            'Gemini blocked the response (safety filter). Try rephrasing the request ' +
                                'or using a different model. See Gemini safety settings in Google AI Studio.',
                            0,
                            JSON.stringify(parsed)
                        );
                    }
                    const chunk = geminiSseDataToChunk(parsed);
                    if (chunk) {
                        if (chunk.text) {
                            const extracted = extractThoughtContent(chunk.text, pendingThought);
                            chunk.text = extracted.text;
                            if (extracted.thought && !chunk.thought) chunk.thought = extracted.thought;
                            pendingThought = extracted.pendingThought;
                        }
                        yield chunk;
                    }
                } catch (err) {
                    // ProviderError should propagate; JSON parse errors are skipped.
                    if (err instanceof ProviderError) throw err;
                    continue;
                }
            }

            return;
        }

        // Mobile fallback: buffer the full response. requestUrlMobile applies
        // the mobile network-drop hint (requestUrl has no abort hook and the OS
        // may kill this call on background) — see transport.requestUrlMobile.
        const response = await requestUrlMobile({ url, method: 'POST', headers, body });

        throwOnNonOk(response, 'Chat completion');

        const payloads: GeminiSseData[] = parseSseEvents(response.text)
            .filter((e): e is SseEvent & { data: string } => Boolean(e.data))
            .map((e) => {
                try {
                    return JSON.parse(e.data) as GeminiSseData;
                } catch {
                    return null;
                }
            })
            .filter((p): p is GeminiSseData => p !== null);

        const blocked = payloads.find((p) => geminiResponseBlocked(p));
        if (blocked) {
            throw new ProviderError(
                'Gemini blocked the response (safety filter). Try rephrasing the request ' +
                    'or using a different model. See Gemini safety settings in Google AI Studio.',
                0,
                JSON.stringify(blocked)
            );
        }

        const chunks = geminiEventsToChunks(payloads);
        for await (const chunk of processChunksWithThoughts(chunks, { signal: options.signal })) {
            yield chunk;
        }
    }

    /** {@inheritDoc AiProvider.embed} */
    async embed(options: EmbedOptions): Promise<EmbedResult> {
        const modelConfig = resolveModel(this.config.models, 'embed', options.model, this.name);
        const headers = this.buildHeaders();

        // Gemini's text-embedding-* models accept batch via batchEmbedContents.
        if (Array.isArray(options.input)) {
            const url = buildUrl(
                this.config.endpoint,
                `/models/${encodeURIComponent(modelConfig.model)}:batchEmbedContents`
            );
            const body = JSON.stringify({
                requests: options.input.map((text) => ({
                    model: `models/${modelConfig.model}`,
                    content: { parts: [{ text }] }
                }))
            });

            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false
            });

            throwOnNonOk(response, 'Embedding request');

            const data = response.json as GeminiEmbedResponse;
            if (!data.embeddings || !Array.isArray(data.embeddings)) {
                throw new ProviderError(
                    'Embedding response did not contain an embeddings array. ' +
                        'The configured embed model may not support embeddings.',
                    0,
                    response.text
                );
            }
            const embeddings = data.embeddings.map((e) => e.values ?? []);
            return { embeddings, model: modelConfig.model };
        }

        const url = buildUrl(this.config.endpoint, `/models/${encodeURIComponent(modelConfig.model)}:embedContent`);
        const body = JSON.stringify({
            content: { parts: [{ text: options.input }] }
        });

        const response: RequestUrlResponse = await requestUrl({
            url,
            method: 'POST',
            headers,
            body,
            throw: false
        });

        throwOnNonOk(response, 'Embedding request');

        const data = response.json as GeminiEmbedResponse;
        if (!data.embedding || !Array.isArray(data.embedding.values)) {
            throw new ProviderError(
                'Embedding response did not contain a values array. ' +
                    'The configured embed model may not support embeddings.',
                0,
                response.text
            );
        }

        const result: EmbedResult = { embeddings: [data.embedding.values], model: modelConfig.model };
        if (data.usageMetadata?.totalTokenCount !== undefined) {
            result.usage = {
                promptTokens: data.usageMetadata.totalTokenCount,
                totalTokens: data.usageMetadata.totalTokenCount
            };
        }
        return result;
    }

    /** {@inheritDoc AiProvider.listModels} */
    async listModels(): Promise<ModelInfo[]> {
        const url = buildUrl(this.config.endpoint, '/models');
        const headers = this.buildHeaders();

        const response = await safeGet(url, headers);
        if (!response || response.status !== 200) return [];

        const data = response.json as { models?: GeminiModelItem[] };
        if (!data.models || !Array.isArray(data.models)) return [];

        return data.models.map((item: GeminiModelItem) => {
            // Gemini returns names as "models/gemini-2.5-flash" — strip the
            // prefix so the picker shows just the model id the writer will
            // reuse in their model config.
            const id = item.name.replace(/^models\//, '');
            return {
                id,
                ownedBy: item.displayName ?? 'google',
                contextLength: item.inputTokenLimit
            };
        });
    }

    /** {@inheritDoc AiProvider.testConnection} */
    async testConnection(): Promise<{ ok: boolean; error?: string }> {
        const chatModel = this.config.models.find(
            (m) => m.role === 'chat' || m.role === 'both' || m.role === 'chat-image'
        );
        const modelName = chatModel?.model ?? 'gemini-2.0-flash';
        const url = buildUrl(this.config.endpoint, `/models/${encodeURIComponent(modelName)}:generateContent`);
        const headers = this.buildHeaders();

        const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 }
        });

        try {
            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false
            });

            if (response.status === 200) return { ok: true };
            return httpErrorResponse(response);
        } catch (err: unknown) {
            return catchErrorResponse(
                err,
                'Connection failed. Make sure your endpoint URL is the full base path ' +
                    '(e.g., https://generativelanguage.googleapis.com/v1beta) and your API key is valid.'
            );
        }
    }

    /** {@inheritDoc AiProvider.testEmbeddings} */
    async testEmbeddings(): Promise<{ ok: boolean; error?: string }> {
        try {
            const modelConfig = resolveModel(this.config.models, 'embed', undefined, this.name);
            const url = buildUrl(this.config.endpoint, `/models/${encodeURIComponent(modelConfig.model)}:embedContent`);
            const headers = this.buildHeaders();
            const body = JSON.stringify({
                content: { parts: [{ text: 'test' }] }
            });

            const response: RequestUrlResponse = await requestUrl({
                url,
                method: 'POST',
                headers,
                body,
                throw: false
            });

            if (response.status === 200) return { ok: true };
            return httpErrorResponse(response);
        } catch (err: unknown) {
            return catchErrorResponse(err, 'Embeddings test failed');
        }
    }
}
