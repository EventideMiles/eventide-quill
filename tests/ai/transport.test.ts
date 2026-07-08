import { describe, it, expect, afterEach, vi } from 'vitest';
import { Platform, requestUrl } from 'obsidian';

// Wrap requestUrl in a vi.fn so the requestUrlMobile suite can make it reject.
// By default it delegates to the stub, so every other test behaves identically.
vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return { ...actual, requestUrl: vi.fn(actual.requestUrl) };
});

import {
    HttpError,
    StreamingUnavailableError,
    MobileNetworkError,
    isStreamingSupported,
    throwOnNonOk,
    httpErrorResponse,
    catchErrorResponse,
    isMobileNetworkDrop,
    withMobileNetworkHint,
    requestUrlMobile
} from '../../src/ai/transport';
import { ProviderError } from '../../src/ai/provider';

describe('HttpError', () => {
    it('carries status and body', () => {
        const err = new HttpError(404, 'Not Found');
        expect(err.status).toBe(404);
        expect(err.body).toBe('Not Found');
        expect(err.message).toContain('404');
        expect(err.name).toBe('HttpError');
    });

    it('is an Error instance', () => {
        expect(new HttpError(500, '')).toBeInstanceOf(Error);
    });
});

describe('StreamingUnavailableError', () => {
    it('has a descriptive message', () => {
        const err = new StreamingUnavailableError();
        expect(err.message).toContain('streaming is not possible');
        expect(err.name).toBe('StreamingUnavailableError');
    });

    it('is an Error instance', () => {
        expect(new StreamingUnavailableError()).toBeInstanceOf(Error);
    });
});

describe('MobileNetworkError', () => {
    it('is an Error instance with the typed name', () => {
        const original = new Error('Failed to fetch');
        const err = new MobileNetworkError('wrapped message', original);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('MobileNetworkError');
        expect(err.message).toBe('wrapped message');
        expect(err.cause).toBe(original);
    });
});

describe('isStreamingSupported', () => {
    it('returns a boolean (desktop true when Platform.isMobile is false)', () => {
        // The mock sets Platform.isMobile = false, so streaming is supported.
        expect(typeof isStreamingSupported()).toBe('boolean');
        expect(isStreamingSupported()).toBe(true);
    });
});

describe('throwOnNonOk', () => {
    it('does nothing for status 200', () => {
        expect(() => throwOnNonOk({ status: 200, text: 'OK' }, 'Test op')).not.toThrow();
    });

    it('throws ProviderError for non-200 status', () => {
        expect(() => throwOnNonOk({ status: 500, text: 'Internal Error' }, 'Chat completion')).toThrow(
            ProviderError
        );
    });

    it('includes the operation name in the error message', () => {
        try {
            throwOnNonOk({ status: 429, text: 'Too Many Requests' }, 'Embedding');
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ProviderError);
            expect((err as ProviderError).message).toContain('Embedding');
            expect((err as ProviderError).message).toContain('429');
        }
    });

    it('truncates long error bodies', () => {
        const longBody = 'x'.repeat(1000);
        try {
            throwOnNonOk({ status: 500, text: longBody }, 'Test');
            expect.fail('should have thrown');
        } catch (err) {
            expect((err as ProviderError).message.length).toBeLessThan(longBody.length + 100);
        }
    });

    it('carries status and body in the ProviderError', () => {
        try {
            throwOnNonOk({ status: 503, text: 'Unavailable' }, 'Test');
            expect.fail('should have thrown');
        } catch (err) {
            const pe = err as ProviderError;
            expect(pe.status).toBe(503);
            expect(pe.body).toBe('Unavailable');
        }
    });
});

describe('httpErrorResponse', () => {
    it('builds an ok=false result with formatted error message', () => {
        const result = httpErrorResponse({ status: 404, text: 'Not Found' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('404');
        expect(result.error).toContain('Not Found');
    });

    it('truncates long response text', () => {
        const longBody = 'x'.repeat(1000);
        const result = httpErrorResponse({ status: 500, text: longBody });
        expect(result.error.length).toBeLessThan(longBody.length + 50);
    });
});

describe('catchErrorResponse', () => {
    it.each([
        { input: new Error('connection refused'), prefix: 'Provider X', expected: ['Provider X', 'connection refused'] },
        { input: 'string error', prefix: 'Test', expected: ['string error'] },
        { input: 42, prefix: 'Test', expected: ['42'] }
    ])('builds an ok=false result containing the message for $input', ({ input, prefix, expected }) => {
        const result = catchErrorResponse(input, prefix);
        expect(result.ok).toBe(false);
        for (const substr of expected) {
            expect(result.error).toContain(substr);
        }
    });
});

describe('isMobileNetworkDrop', () => {
    // The mock's Platform is a shared mutable object; toggling isMobile here
    // is visible to transport.ts (same reference). Restore desktop default
    // after each test so other suites aren't affected.
    afterEach(() => {
        Platform.isMobile = false;
    });

    it('returns false on desktop regardless of the error', () => {
        Platform.isMobile = false;
        expect(isMobileNetworkDrop(new Error('Failed to fetch'))).toBe(false);
    });

    it.each([
        'Failed to fetch',
        'Network request failed',
        'websocket closed',
        'ERR_INTERNET_DISCONNECTED',
        'ERR_CONNECTION_RESET',
        'Load failed',
        'The Internet connection appears to be offline.'
    ])('matches the mobile network-drop signature %j', (msg) => {
        Platform.isMobile = true;
        expect(isMobileNetworkDrop(new Error(msg))).toBe(true);
    });

    it('returns false on mobile for an unrelated error (e.g. a JSON parse error)', () => {
        Platform.isMobile = true;
        expect(isMobileNetworkDrop(new Error('Unexpected token < in JSON'))).toBe(false);
    });

    it('handles non-Error throws and empty messages', () => {
        Platform.isMobile = true;
        expect(isMobileNetworkDrop('a network error occurred')).toBe(true);
        expect(isMobileNetworkDrop('')).toBe(false);
        expect(isMobileNetworkDrop(undefined)).toBe(false);
    });
});

describe('withMobileNetworkHint', () => {
    afterEach(() => {
        Platform.isMobile = false;
    });

    it('returns the original error unchanged on desktop', () => {
        Platform.isMobile = false;
        const original = new Error('Failed to fetch');
        const result = withMobileNetworkHint(original);
        expect(result).toBe(original);
    });

    it('appends the mobile hint to a network-drop error on mobile', () => {
        Platform.isMobile = true;
        const result = withMobileNetworkHint(new Error('Failed to fetch'));
        expect(result.message).toContain('Failed to fetch');
        expect(result.message).toContain('backgrounded');
    });

    it('wraps a drop as a MobileNetworkError that preserves the original on cause', () => {
        Platform.isMobile = true;
        const original = new Error('Failed to fetch');
        const result = withMobileNetworkHint(original);
        expect(result).toBeInstanceOf(MobileNetworkError);
        expect(result.name).toBe('MobileNetworkError');
        expect((result as MobileNetworkError).cause).toBe(original);
    });

    it('returns the original error (same reference) on mobile when it is not a network drop', () => {
        Platform.isMobile = true;
        const original = new Error('some provider bug');
        expect(withMobileNetworkHint(original)).toBe(original);
    });

    it('wraps non-Error throws into an Error', () => {
        Platform.isMobile = true;
        const result = withMobileNetworkHint('network error');
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain('network error');
    });
});

describe('requestUrlMobile', () => {
    afterEach(() => {
        Platform.isMobile = false;
        vi.mocked(requestUrl).mockClear();
    });

    it('wraps a network-drop rejection as a MobileNetworkError with the hint (mobile)', async () => {
        Platform.isMobile = true;
        const original = new Error('Failed to fetch');
        vi.mocked(requestUrl).mockRejectedValueOnce(original);
        let caught: unknown;
        try {
            await requestUrlMobile({ url: 'http://x', method: 'POST', headers: {}, body: '' });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(MobileNetworkError);
        const wrapped = caught as MobileNetworkError;
        expect(wrapped.message).toContain('Failed to fetch');
        expect(wrapped.message).toContain('backgrounded');
        expect(wrapped.cause).toBe(original);
        // throw: false is applied so non-2xx responses are returned, not thrown.
        expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(expect.objectContaining({ throw: false }));
    });

    it('rethrows a non-drop rejection unchanged on desktop (no wrap)', async () => {
        Platform.isMobile = false;
        const original = new Error('Failed to fetch');
        vi.mocked(requestUrl).mockRejectedValueOnce(original);
        await expect(
            requestUrlMobile({ url: 'http://x', method: 'POST', headers: {}, body: '' })
        ).rejects.toBe(original);
        expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(expect.objectContaining({ throw: false }));
    });
});
