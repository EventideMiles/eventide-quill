import { describe, it, expect } from 'vitest';
import { MediaWikiError, apiEndpoint } from '../../../src/ai/tools/mediawiki';
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

/**
 * `api.php` path resolution. Wikimedia projects serve it under `/w/`; Fandom
 * and standalone installs serve it at the root. Getting this wrong 404s — this
 * is the regression guard for the bug where every Wikipedia call 404'd because
 * the client built `https://en.wikipedia.org/api.php` (root) instead of
 * `https://en.wikipedia.org/w/api.php`.
 */
describe('apiEndpoint', () => {
    it('routes Wikipedia (all language subdomains) to /w/api.php', () => {
        expect(apiEndpoint('en.wikipedia.org')).toBe('https://en.wikipedia.org/w/api.php');
        expect(apiEndpoint('fr.wikipedia.org')).toBe('https://fr.wikipedia.org/w/api.php');
        expect(apiEndpoint('simple.wikipedia.org')).toBe('https://simple.wikipedia.org/w/api.php');
        expect(apiEndpoint('zh-yue.wikipedia.org')).toBe('https://zh-yue.wikipedia.org/w/api.php');
    });

    it('routes sibling Wikimedia projects to /w/api.php', () => {
        expect(apiEndpoint('en.wiktionary.org')).toBe('https://en.wiktionary.org/w/api.php');
        expect(apiEndpoint('en.wikisource.org')).toBe('https://en.wikisource.org/w/api.php');
        expect(apiEndpoint('meta.wikimedia.org')).toBe('https://meta.wikimedia.org/w/api.php');
    });

    it('routes Wikidata to /w/api.php', () => {
        expect(apiEndpoint('www.wikidata.org')).toBe('https://www.wikidata.org/w/api.php');
        expect(apiEndpoint('wikidata.org')).toBe('https://wikidata.org/w/api.php');
    });

    it('routes Fandom and standalone installs to the root /api.php', () => {
        expect(apiEndpoint('starwars.fandom.com')).toBe('https://starwars.fandom.com/api.php');
        expect(apiEndpoint('memory-alpha.fandom.com')).toBe('https://memory-alpha.fandom.com/api.php');
        expect(apiEndpoint('my-wiki.example.com')).toBe('https://my-wiki.example.com/api.php');
    });
});
