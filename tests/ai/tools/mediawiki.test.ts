import { describe, it, expect } from 'vitest';
import { MediaWikiError } from '../../../src/ai/tools/mediawiki';
import { RateLimitError, toolErrorMessage } from '../../../src/ai/tools/http-retry';

/**
 * Contract tests for the {@link MediaWikiError} typed error. The MediaWiki
 * client helpers throw this on any non-2xx API response so callers can
 * distinguish a MediaWiki API failure from a `requestUrl` transport error
 * (generic Error) and from a rate-limit ({@link RateLimitError}). HTTP-mock
 * coverage of the throw sites themselves is deferred (needs requestUrl
 * fixtures); these tests lock the error contract the discrimination relies on.
 */
describe('MediaWikiError', () => {
    it('extends Error and carries the HTTP status', () => {
        const err = new MediaWikiError('Search failed: HTTP 503', 503);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(MediaWikiError);
        expect(err.status).toBe(503);
        expect(err.message).toBe('Search failed: HTTP 503');
        expect(err.name).toBe('MediaWikiError');
    });

    it('is distinguishable from RateLimitError via instanceof', () => {
        const apiError = new MediaWikiError('Search failed: HTTP 503', 503);
        const rateLimit = new RateLimitError(30);
        // A MediaWikiError is never a RateLimitError — assertNotRateLimited
        // runs before the non-200 check, so 429 surfaces as RateLimitError.
        expect(apiError).not.toBeInstanceOf(RateLimitError);
        expect(rateLimit).not.toBeInstanceOf(MediaWikiError);
        expect(apiError.status).toBe(503);
    });

    it('toolErrorMessage surfaces the status in the model-facing text', () => {
        // The shared formatter (used by every MediaWiki tool entrypoint) falls
        // back to `Error {action}: {msg}` for non-RateLimitError errors; the
        // status rides in the message text so the model still sees it.
        const msg = toolErrorMessage(new MediaWikiError('Search failed: HTTP 503', 503), 'looking up "cats"');
        expect(msg).toContain('HTTP 503');
        expect(msg).toContain('looking up "cats"');
    });
});
