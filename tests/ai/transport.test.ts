import { describe, it, expect } from 'vitest';
import {
    HttpError,
    StreamingUnavailableError,
    isStreamingSupported,
    throwOnNonOk,
    httpErrorResponse,
    catchErrorResponse
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
    it('builds an ok=false result from an Error', () => {
        const result = catchErrorResponse(new Error('connection refused'), 'Provider X');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Provider X');
        expect(result.error).toContain('connection refused');
    });

    it('handles non-Error caught values', () => {
        const result = catchErrorResponse('string error', 'Test');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('string error');
    });

    it('handles numeric caught values', () => {
        const result = catchErrorResponse(42, 'Test');
        expect(result.error).toContain('42');
    });
});
