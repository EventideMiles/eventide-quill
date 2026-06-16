import { Platform, requestUrl } from 'obsidian';

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
 * Note: fetch is normally disallowed by the project's ESLint rules in favour
 * of requestUrl (mobile-compatible). This is the single intentional exception
 * — guarded by isStreamingSupported() so it only runs on desktop (Electron).
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
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(url, {
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
        throw new Error('Response body is missing or unavailable; streaming is not possible.');
    }
    return { reader: response.body.getReader() };
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
