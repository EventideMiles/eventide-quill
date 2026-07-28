/**
 * Programmable mock SSE/NDJSON server for the E2E suite.
 *
 * Runs in WDIO's `onPrepare` hook (the parent process) and listens on a fixed
 * port (default 43194). The plugin's configured provider endpoint is pointed
 * at it via `writeMockedDataJson`, so every `requestUrl` / `window.fetch` call
 * the plugin makes during a test lands here instead of hitting a real model.
 *
 * Programming model: a FIFO queue of canned responses, populated by tests via
 * the `/__mocks__` control endpoint. When the plugin POSTs to
 * `/v1/chat/completions` (or `/v1/embeddings`, `/v1/completions`), the server
 * pops the next queued response and serves it. If the queue is empty, a
 * default 200 OK with a single non-streaming JSON completion is returned so
 * the test doesn't hang waiting for a response that never comes (the default
 * is intentionally boring — tests should always register the response they
 * expect to assert on).
 *
 * The control endpoints:
 *   POST /__mocks__        body: { responses: MockResponse[] }   → enqueue
 *   POST /__mocks__/clear                                       → empty queue
 *   GET  /__mocks__/stats                                       → request log
 *
 * Tests use the helper exports (`enqueueMock`, `clearMocks`, `getMockStats`)
 * rather than calling fetch directly — those helpers read `process.env.E2E_MOCK_PORT`
 * so spec files don't need to pass the port around.
 *
 * The wire format mirrors what `tests/helpers/mock-http.ts` produces for the
 * Vitest provider suites (`sseDataLine`, `sseDoneSentinel`, `ndjsonLine`) so
 * canned bodies can be assembled the same way.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/** A canned HTTP response the mock server will return for the next matched request. */
export interface MockResponse {
    /** HTTP status (default 200). */
    status?: number;
    /** Response headers (Content-Type defaults below based on stream/body). */
    headers?: Record<string, string>;
    /**
     * Raw response body text. For SSE, this should already be the joined
     * `data: {...}\n\n` chunks (use `sseChatBody` to build it). For
     * non-streaming JSON, just the JSON string.
     */
    body: string;
}

/** Shape of a request the server saw — exposed via /__mocks__/stats for assertions. */
export interface MockRequestLog {
    method: string;
    url: string;
    /** Lowercased header name → value. */
    headers: Record<string, string>;
    body: string;
}

let server: Server | null = null;
const queue: MockResponse[] = [];
const requests: MockRequestLog[] = [];

const MAX_REQUEST_LOG = 200;

/** Build a streamed OpenAI-compatible SSE body from text chunks. */
export function sseChatBody(
    textChunks: string[],
    opts: { model?: string; finishReason?: string } = {}
): string {
    const model = opts.model ?? 'local-model';
    const lines = textChunks.map((text) =>
        JSON.stringify({
            id: 'mock-chat-completion',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        })
    );
    lines.push(
        JSON.stringify({
            id: 'mock-chat-completion',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? 'stop' }]
        })
    );
    return lines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** Build a streamed OpenAI-compatible SSE body containing one or more tool_calls deltas. */
export function sseToolCallBody(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    opts: { model?: string } = {}
): string {
    const model = opts.model ?? 'local-model';
    const lines = toolCalls.map((call, i) =>
        JSON.stringify({
            id: 'mock-chat-completion',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [
                {
                    index: 0,
                    delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
                    finish_reason: null
                }
            ]
        })
    );
    lines.push(
        JSON.stringify({
            id: 'mock-chat-completion',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        })
    );
    return lines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** Build a non-streaming OpenAI-compatible JSON completion body. */
export function jsonChatBody(text: string, opts: { model?: string } = {}): string {
    return JSON.stringify({
        id: 'mock-chat-completion',
        object: 'chat.completion',
        created: 0,
        model: opts.model ?? 'local-model',
        choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
        ]
    });
}

/** Build a non-streaming embeddings response. */
export function jsonEmbeddingsBody(inputTokens: string[], dims = 8): string {
    return JSON.stringify({
        object: 'list',
        model: 'local-model',
        data: inputTokens.map((input, i) => ({
            object: 'embedding',
            index: i,
            embedding: Array.from({ length: dims }, (_, k) => (input.length + k) / 1000)
        })),
        usage: { prompt_tokens: inputTokens.length, total_tokens: inputTokens.length }
    });
}

/**
 * Start the mock server on the given port. Resolves once listening. Idempotent
 * — calling twice without `stopMockServer` throws.
 */
export function startMockServer(port: number): Promise<void> {
    if (server) throw new Error('mock-server: already started; call stopMockServer first');
    server = createServer(handleRequest);
    return new Promise((resolveListen) => {
        server!.listen(port, '127.0.0.1', resolveListen);
    });
}

/** Stop the mock server and clear state. Safe to call when not started. */
export function stopMockServer(): Promise<void> {
    const s = server;
    server = null;
    queue.length = 0;
    requests.length = 0;
    if (!s) return Promise.resolve();
    return new Promise((resolveStop) => {
        s.close(() => resolveStop());
    });
}

/** Read the body of an incoming request as a string. */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolveBody) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            data += chunk;
        });
        req.on('end', () => resolveBody(data));
    });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // CORS preflight: the plugin's desktop path uses `window.fetch` with
    // `content-type: application/json`, which triggers an OPTIONS preflight
    // because the request crosses an origin boundary (app://obsidian.md →
    // http://127.0.0.1). Without a valid preflight response, Chromium blocks
    // the actual POST and `window.fetch` rejects with the opaque "Failed to
    // fetch" — the plugin surfaces that as the assistant bubble text. Reply
    // with the headers Chromium needs and short-circuit before reading a body.
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type, authorization, accept',
            'access-control-max-age': '86400'
        });
        res.end();
        return;
    }

    // Control plane: /__mocks__[/...]
    if (url.startsWith('/__mocks__')) {
        const body = await readBody(req);
        if (method === 'POST' && url === '/__mocks__') {
            try {
                const parsed = JSON.parse(body || '{}') as { responses?: MockResponse[] };
                if (Array.isArray(parsed.responses)) {
                    queue.push(...parsed.responses);
                }
                res.writeHead(204);
                res.end();
                return;
            } catch (err) {
                res.writeHead(400);
                res.end(String(err));
                return;
            }
        }
        if (method === 'POST' && url === '/__mocks__/clear') {
            queue.length = 0;
            requests.length = 0;
            res.writeHead(204);
            res.end();
            return;
        }
        if (method === 'GET' && url === '/__mocks__/stats') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ queueDepth: queue.length, requests }));
            return;
        }
        res.writeHead(404);
        res.end('unknown control endpoint');
        return;
    }

    // Data plane: act as OpenAI-compatible API.
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');

    // Log every data-plane request for assertions (cap to bound memory).
    requests.push({ method, url, headers, body });
    if (requests.length > MAX_REQUEST_LOG) requests.shift();

    const isStreaming = body.includes('"stream":true') || body.includes('"stream": true');
    const canned = queue.shift();
    const response = canned ?? defaultResponseFor(url, isStreaming);
    res.writeHead(response.status ?? 200, {
        'content-type': response.headers?.['content-type'] ?? (isStreaming ? 'text/event-stream' : 'application/json'),
        'access-control-allow-origin': '*',
        ...response.headers
    });
    res.end(response.body);
}

function defaultResponseFor(url: string, isStreaming: boolean): MockResponse {
    if (url.startsWith('/v1/embeddings')) {
        return { body: jsonEmbeddingsBody(['default']) };
    }
    if (url.startsWith('/v1/models')) {
        return { body: JSON.stringify({ object: 'list', data: [{ id: 'local-model', object: 'model' }] }) };
    }
    // Default chat completion: a short, recognisable placeholder so tests that
    // forgot to enqueue a response still get *something* deterministic.
    const text = '[mock-server] default response — test likely forgot to enqueue a canned response';
    return isStreaming ? { body: sseChatBody([text]) } : { body: jsonChatBody(text) };
}

/**
 * Rewrite the test vault's `data.json` so the configured provider endpoint
 * points at the mock server. Reads the committed `data.json.example`,
 * rewrites the provider endpoint and the provider id/name to make the mock
 * provenance obvious in any UI surface, then writes `data.json` (gitignored).
 *
 * Run from WDIO's `onPrepare` (parent process) before any worker launches so
 * every sandboxed Obsidian instance sees the same mocked config.
 */
export function writeMockedDataJson(vaultRelPath: string, port: number): void {
    const pluginDir = join(ROOT, vaultRelPath, '.obsidian', 'plugins', 'eventide-quill');
    const examplePath = join(pluginDir, 'data.json.example');
    const dataPath = join(pluginDir, 'data.json');
    if (!existsSync(examplePath)) {
        throw new Error(
            `mock-server: ${examplePath} not found. Run \`npm run setup:test-vault\` first, or commit a data.json.example.`
        );
    }
    const template = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const providers = Array.isArray(template.aiProviders) ? [...(template.aiProviders as object[])] : [];
    providers[0] = { ...(providers[0] as object), name: 'Mock provider (E2E)', endpoint };
    template.aiProviders = providers;
    if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });
    writeFileSync(dataPath, JSON.stringify(template, null, 4) + '\n', 'utf8');
}

// --- Worker-side helpers (called from spec files via Node fetch) -----------

const controlUrl = (path: string): string => {
    const port = process.env.E2E_MOCK_PORT;
    if (!port) throw new Error('mock-server: E2E_MOCK_PORT not set — onPrepare must run first');
    return `http://127.0.0.1:${port}${path}`;
};

/**
 * Enqueue one or more canned responses on the mock server. Tests call this
 * before triggering the plugin action that will issue the HTTP request. The
 * responses are consumed FIFO.
 *
 * Requires `E2E_MOCK_PORT` (set by `onPrepare`).
 */
export async function enqueueMock(...responses: MockResponse[]): Promise<void> {
    const res = await fetch(controlUrl('/__mocks__'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ responses })
    });
    if (!res.ok) throw new Error(`mock-server: enqueue failed with status ${res.status}`);
}

/** Clear the mock queue and the request log. Call in `beforeEach` to isolate tests. */
export async function clearMocks(): Promise<void> {
    const res = await fetch(controlUrl('/__mocks__/clear'), { method: 'POST' });
    if (!res.ok) throw new Error(`mock-server: clear failed with status ${res.status}`);
}

/** Read the request log (every data-plane request the mock server has seen). */
export async function getMockStats(): Promise<{ queueDepth: number; requests: MockRequestLog[] }> {
    const res = await fetch(controlUrl('/__mocks__/stats'));
    if (!res.ok) throw new Error(`mock-server: stats failed with status ${res.status}`);
    return (await res.json()) as { queueDepth: number; requests: MockRequestLog[] };
}
