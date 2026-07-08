import { Platform, requestUrl, type RequestUrlResponse } from 'obsidian';
import { ProviderError } from './provider';

/**
 * Error thrown by streamResponse when the server returns a non-2xx status.
 */
export class HttpError extends Error {
    status: number;
    body: string;

    constructor(status: number, body: string) {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.body = body;
    }
}

/**
 * Error thrown when the response body is missing or unavailable for streaming.
 */
export class StreamingUnavailableError extends Error {
    constructor() {
        super('Response body is missing or unavailable; streaming is not possible.');
        this.name = 'StreamingUnavailableError';
    }
}

/**
 * Error thrown when a mobile network-drop signature is detected — the mobile
 * WebView killed the in-flight `requestUrl` when the OS suspended the app
 * (screen lock, app switch). The original error is preserved on `cause` so the
 * underlying Capacitor/websocket exception remains available for debugging.
 * Produced by {@link withMobileNetworkHint} and {@link requestUrlMobile}.
 */
export class MobileNetworkError extends Error {
    /** The original error that triggered the mobile-drop wrap. */
    cause: unknown;

    constructor(message: string, cause: unknown) {
        super(message);
        this.name = 'MobileNetworkError';
        this.cause = cause;
    }
}

/**
 * Result of a successful streaming response.
 */
export interface StreamResult {
    reader: ReadableStreamDefaultReader<Uint8Array>;
}

/**
 * Result of a buffered requestUrl call.
 */
export interface BufferResult {
    status: number;
    text: string;
    json: unknown;
}

/**
 * True on desktop (Electron) where native fetch with ReadableStream is
 * available. On mobile (Capacitor WebView) we fall back to requestUrl.
 */
export function isStreamingSupported(): boolean {
    return !Platform.isMobile;
}

/**
 * Perform a streaming HTTP request via native fetch (desktop only).
 * Throws HttpError on non-2xx responses.
 *
 * Note: requestUrl is the project's standard for HTTP (mobile-compatible),
 * but it does not surface a streaming body. SSE streaming needs the raw
 * ReadableStream, so this is the single intentional use of window.fetch —
 * accessed as a member of window (not the bare global) to comply with the
 * project's no-restricted-globals rule, and guarded by isStreamingSupported()
 * so it only runs on desktop (Electron).
 */
export async function streamResponse(
    url: string,
    options: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }
): Promise<StreamResult> {
    // window.fetch (not the bare global) is required for SSE streaming —
    // requestUrl does not expose a ReadableStream. See note above.
    const response = await window.fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: options.signal
    });

    if (!response.ok) {
        const text = await response.text();
        throw new HttpError(response.status, text);
    }

    if (!response.body) {
        throw new StreamingUnavailableError();
    }
    return { reader: response.body.getReader() };
}

/** Maximum characters to include in error messages from HTTP response bodies. */
const ERROR_BODY_TRUNCATE_LENGTH = 500;

/**
 * Throw a ProviderError if the buffered response indicates failure.
 * @param response - The buffered response from requestUrl.
 * @param operation - Human-readable operation name (e.g. "Chat completion").
 * @throws ProviderError if status is not 200.
 */
export function throwOnNonOk(response: { status: number; text: string }, operation: string): void {
    if (response.status !== 200) {
        throw new ProviderError(
            `${operation} failed (HTTP ${response.status}): ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
            response.status,
            response.text
        );
    }
}

/**
 * Perform a streaming HTTP request with built-in error handling.
 * Wraps HttpError into ProviderError with a user-friendly message.
 * @param url - The endpoint URL.
 * @param options - Fetch options for the streaming request.
 * @returns A reader for the response body stream.
 * @throws ProviderError on HTTP errors, or the original error for non-HttpError cases.
 */
export async function streamResponseWithCatch(
    url: string,
    options: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    try {
        const result = await streamResponse(url, options);
        return result.reader;
    } catch (err: unknown) {
        if (err instanceof HttpError) {
            throw new ProviderError(
                `Chat completion failed (HTTP ${err.status}): ${err.body.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`,
                err.status,
                err.body
            );
        }
        throw err;
    }
}

/**
 * Perform a buffered HTTP request via Obsidian's requestUrl (mobile-compatible).
 */
export async function bufferResponse(
    url: string,
    options: {
        method: 'GET' | 'POST';
        headers: Record<string, string>;
        body: string;
    }
): Promise<BufferResult> {
    const response = await requestUrl({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
        throw: false
    });

    return {
        status: response.status,
        text: response.text,
        json: response.json
    };
}

/**
 * Build a standardized error response from a buffered HTTP response.
 * @param response - The buffered response from requestUrl.
 * @returns An error result object with ok=false and a formatted error message.
 */
export function httpErrorResponse(response: { status: number; text: string }): {
    ok: false;
    error: string;
} {
    return {
        ok: false,
        error: `HTTP ${response.status}: ${response.text.slice(0, ERROR_BODY_TRUNCATE_LENGTH)}`
    };
}

/**
 * Build a standardized error response from a caught exception.
 * @param err - The caught error (or primitive).
 * @param prefix - Provider-specific prefix for the error message.
 * @returns An error result object with ok=false and a formatted error message.
 */
export function catchErrorResponse(err: unknown, prefix: string): { ok: false; error: string } {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${prefix}: ${message}` };
}

/**
 * Perform a buffered GET request, returning null on any error.
 * Useful for best-effort operations like listing available models.
 * @param url - The endpoint URL.
 * @param headers - Optional HTTP headers to include.
 * @returns The BufferResult, or null if the request failed.
 */
export async function safeGet(url: string, headers: Record<string, string> = {}): Promise<BufferResult | null> {
    try {
        return await bufferResponse(url, { method: 'GET', headers, body: '' });
    } catch {
        return null;
    }
}

/**
 * Substrings (lowercased) that characterize the raw network/websocket errors
 * the mobile WebView throws when the OS suspends the app mid-`requestUrl`.
 * The exact string varies by platform (Capacitor bridge, Android WebView,
 * iOS WebView), so we match a broad set of common signatures.
 */
const MOBILE_NETWORK_DROP_SIGNATURES = [
    'failed to fetch',
    'load failed',
    'network error',
    'networkerror',
    'network request failed',
    'websocket',
    'err_internet_disconnected',
    'err_network_changed',
    'err_connection_reset',
    'err_connection_closed',
    'err_connection_refused',
    'the internet connection appears to be offline',
    'request failed'
];

/**
 * Heuristic: is this error a network/connection drop of the kind the mobile
 * WebView produces when the OS suspends the app (screen lock, app switch)
 * mid-`requestUrl`? Returns false on desktop or when the error doesn't match a
 * known network-drop signature. Used by the providers to add a friendlier hint
 * pointing at the likely cause instead of surfacing the raw Capacitor/websocket
 * exception string.
 */
export function isMobileNetworkDrop(err: unknown): boolean {
    if (!Platform.isMobile) return false;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (!msg) return false;
    return MOBILE_NETWORK_DROP_SIGNATURES.some((sig) => msg.includes(sig));
}

/**
 * Hint appended to a network-drop error message on mobile, explaining the
 * likely cause (app backgrounding) so the writer knows it wasn't a provider
 * bug and how to avoid it. Empty on desktop / non-drop errors.
 */
const MOBILE_DROP_HINT =
    ' (This often happens on mobile when Obsidian is backgrounded or the screen locks — keep the app in focus during AI flows.)';

/**
 * Wrap an error with a mobile-aware hint if it is a network drop that occurred
 * while the app was suspended. Returns the original error unchanged on desktop
 * or for non-drop errors (so non-mobile callers see no behavioral change).
 * Mobile drop cases are wrapped in a {@link MobileNetworkError} that preserves
 * the original on `cause`; mobile callers rethrow the result.
 */
export function withMobileNetworkHint(err: unknown): Error {
    if (!isMobileNetworkDrop(err)) {
        return err instanceof Error ? err : new Error(String(err));
    }
    const base = err instanceof Error ? err.message : String(err);
    return new MobileNetworkError(`${base}${MOBILE_DROP_HINT}`, err);
}

/**
 * Buffered `requestUrl` call used as the mobile fallback for streaming
 * endpoints (see {@link isStreamingSupported}). Applies `throw: false` so
 * non-2xx responses are returned for the caller to inspect via
 * {@link throwOnNonOk}, and wraps connection errors with a mobile-aware hint
 * (see {@link withMobileNetworkHint}) since `requestUrl` has no abort hook and
 * the OS may kill the call mid-flight when the app is backgrounded. Shared by
 * both providers so the fallback stays identical across OpenAI and Ollama.
 */
export async function requestUrlMobile(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}): Promise<RequestUrlResponse> {
    try {
        return await requestUrl({ ...options, throw: false });
    } catch (err) {
        throw withMobileNetworkHint(err);
    }
}
