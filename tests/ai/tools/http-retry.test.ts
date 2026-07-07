import { describe, it, expect } from 'vitest';
import {
    parseRetryAfter,
    assertNotRateLimited,
    toolErrorMessage,
    RateLimitError
} from '../../../src/ai/tools/http-retry';
import type { RateLimitResponse } from '../../../src/ai/tools/http-retry';

describe('parseRetryAfter', () => {
    it('parses delta-seconds form', () => {
        expect(parseRetryAfter('120')).toBe(120);
        expect(parseRetryAfter('0')).toBe(0);
        expect(parseRetryAfter('  30  ')).toBe(30);
    });

    it('parses HTTP-date form as a delta from now', () => {
        const future = new Date(Date.now() + 60_000).toUTCString();
        const seconds = parseRetryAfter(future);
        expect(seconds).not.toBeNull();
        expect(seconds!).toBeGreaterThanOrEqual(55);
        expect(seconds!).toBeLessThanOrEqual(65);
    });

    it('clamps negative HTTP-date deltas to 0', () => {
        const past = new Date(Date.now() - 60_000).toUTCString();
        expect(parseRetryAfter(past)).toBe(0);
    });

    it('returns null for undefined', () => {
        expect(parseRetryAfter(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseRetryAfter('')).toBeNull();
    });

    it('returns null for unparseable values', () => {
        expect(parseRetryAfter('not-a-date-or-number')).toBeNull();
        expect(parseRetryAfter('abc123')).toBeNull();
    });
});

describe('assertNotRateLimited', () => {
    it('does nothing for non-429 status', () => {
        expect(() => assertNotRateLimited({ status: 200 })).not.toThrow();
        expect(() => assertNotRateLimited({ status: 500 })).not.toThrow();
    });

    it('throws RateLimitError on 429 with Retry-After header', () => {
        const response: RateLimitResponse = {
            status: 429,
            headers: { 'retry-after': '30' }
        };
        expect(() => assertNotRateLimited(response)).toThrow(RateLimitError);
        expect(() => assertNotRateLimited(response)).toThrow(/30s/);
    });

    it('throws RateLimitError on 429 with title-case header', () => {
        const response: RateLimitResponse = {
            status: 429,
            headers: { 'Retry-After': '45' }
        };
        expect(() => assertNotRateLimited(response)).toThrow(RateLimitError);
    });

    it('falls back to default 60s when 429 has no Retry-After header', () => {
        const response: RateLimitResponse = { status: 429 };
        expect(() => assertNotRateLimited(response)).toThrow(RateLimitError);
        expect(() => assertNotRateLimited(response)).toThrow(/60s/);
    });

    it('falls back to default when 429 header is unparseable', () => {
        const response: RateLimitResponse = {
            status: 429,
            headers: { 'retry-after': 'garbage' }
        };
        expect(() => assertNotRateLimited(response)).toThrow(/60s/);
    });

    it('throws RateLimitError carrying the parsed seconds', () => {
        const response: RateLimitResponse = {
            status: 429,
            headers: { 'retry-after': '15' }
        };
        try {
            assertNotRateLimited(response);
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(RateLimitError);
            expect((err as RateLimitError).seconds).toBe(15);
        }
    });
});

describe('toolErrorMessage', () => {
    it('formats RateLimitError with actionable wait guidance', () => {
        const err = new RateLimitError(30);
        const msg = toolErrorMessage(err, 'looking up "dragons" on en.wikipedia.org');
        expect(msg).toContain('Rate-limited (HTTP 429)');
        expect(msg).toContain('Retry-After: 30s');
        expect(msg).toContain('Wait at least 30s');
        expect(msg).toContain('try a different source');
    });

    it('formats generic Error with message', () => {
        const err = new Error('connection refused');
        const msg = toolErrorMessage(err, 'fetching https://example.com');
        expect(msg).toBe('Error fetching https://example.com: connection refused');
    });

    it('formats non-Error caught values via String()', () => {
        const msg = toolErrorMessage('string error', 'doing something');
        expect(msg).toBe('Error doing something: string error');
    });

    it('handles numeric caught values', () => {
        const msg = toolErrorMessage(42, 'counting');
        expect(msg).toBe('Error counting: 42');
    });
});

describe('RateLimitError', () => {
    it('carries seconds field and message', () => {
        const err = new RateLimitError(45);
        expect(err.seconds).toBe(45);
        expect(err.message).toContain('45s');
        expect(err.name).toBe('RateLimitError');
    });

    it('is an Error instance', () => {
        expect(new RateLimitError(10)).toBeInstanceOf(Error);
    });
});
