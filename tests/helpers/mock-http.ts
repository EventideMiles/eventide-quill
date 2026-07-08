/**
 * Shared HTTP-mocking helpers for provider `chatCompletion` integration tests.
 * Covers the two transports providers use:
 *   - desktop SSE streaming via `window.fetch` (a `ReadableStream` body)
 *   - mobile/buffered via Obsidian's `requestUrl` (full text at once)
 *
 * Reused across the anthropic / openai-compatible / ollama / gemini provider
 * chatCompletion suites so the mock shape stays in sync. The helpers are
 * transport-shaped (they produce objects structurally compatible with what
 * `transport.ts` consumes) — they do NOT model a real HTTP server.
 */

/** Build a `ReadableStream<Uint8Array>` from string chunks (SSE / NDJSON bytes). */
export function byteStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        }
    });
}

/**
 * Minimal `Response` shape consumed by `transport.streamResponse`: `.ok`,
 * `.status`, `.body.getReader()`, and `.text()` (read only on non-2xx). Used
 * to mock `window.fetch` for the desktop streaming path.
 */
export interface MockFetchResponse {
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
    text(): Promise<string>;
}

/** Build a 2xx streaming `Response` whose body is the joined SSE/NDJSON chunks. */
export function streamingResponse(chunks: string[], status = 200): MockFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        body: byteStreamFromChunks(chunks),
        text: async () => ''
    };
}

/** Build a non-2xx `Response` with a text body (for error-path tests). */
export function errorResponse(status: number, body: string): MockFetchResponse {
    return {
        ok: false,
        status,
        body: null,
        text: async () => body
    };
}

/**
 * Shape of an Obsidian `requestUrl` response, as used by the mobile/buffered
 * path (`transport.requestUrlMobile` → `throwOnNonOk` + `parseSseEvents`).
 */
export interface MockRequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
    json: unknown;
    arrayBuffer: ArrayBuffer;
}

/** Build a buffered `requestUrl` response (mobile fallback) from a text body. */
export function bufferedResponse(text: string, status = 200, json: unknown = null): MockRequestUrlResponse {
    return { status, headers: {}, text, json, arrayBuffer: new ArrayBuffer(0) };
}

// --- window.fetch installation --------------------------------------------

const globalWithWindow = globalThis as { window?: { fetch?: unknown } };
const originalWindow = globalWithWindow.window;

/**
 * Install a `window.fetch` mock for the desktop streaming path. The node test
 * environment has no `window`, so one is synthesized; {@link restoreWindow}
 * removes it afterwards.
 */
export function mockWindowFetch(fn: (url: string, init: unknown) => Promise<MockFetchResponse>): void {
    globalWithWindow.window = { fetch: fn as unknown as typeof fetch };
}

/** Remove the `window.fetch` mock installed by {@link mockWindowFetch}. */
export function restoreWindow(): void {
    if (originalWindow === undefined) {
        delete globalWithWindow.window;
    } else {
        globalWithWindow.window = originalWindow;
    }
}

// --- SSE body builder ------------------------------------------------------

/**
 * Build a single Anthropic SSE event string (`event: <type>\ndata: <json>\n\n`).
 * Mirrors the `sse()` helper in `streaming.test.ts` so provider-level tests can
 * assemble realistic event sequences without duplicating the wire format.
 */
export function sseEvent(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build a single OpenAI / Gemini SSE data line (`data: <json>\n\n`). These
 * providers don't use Anthropic-style `event:` typing — every block is a bare
 * `data:` line whose JSON payload carries its own discriminator (`choices`,
 * `candidates`, etc.).
 */
export function sseDataLine(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

/** The OpenAI `[DONE]` sentinel that terminates an SSE stream. */
export function sseDoneSentinel(): string {
    return 'data: [DONE]\n\n';
}

/**
 * Build a single Ollama NDJSON line (`<json>\n`). Ollama's `/api/chat` streams
 * newline-delimited JSON objects (no `data:` prefix, no blank-line separators).
 */
export function ndjsonLine(data: unknown): string {
    return `${JSON.stringify(data)}\n`;
}
