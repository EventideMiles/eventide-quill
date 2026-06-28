import { requestUrl } from 'obsidian';

/**
 * Shared MediaWiki API client. Both Fandom and Wikipedia serve the same
 * `api.php` endpoint with the same query format — this module handles both
 * via a configurable host string.
 *
 * Uses Obsidian's `requestUrl` (mobile-compatible, bypasses CORS via the
 * platform proxy). All responses are JSON — no HTML parsing needed.
 */

/** Custom User-Agent to comply with Wikimedia's API policy (200 req/min tier). */
const MEDIAWIKI_UA = 'EventideQuill/0.9.0 (https://github.com/EventideMiles/eventide-quill)';

/** Minimum interval (ms) between requests to the same host. */
const MIN_INTERVAL_MS = 500;

/** Per-host timestamp of the last API call. */
const lastCall = new Map<string, number>();

/**
 * Per-host promise chain that serializes outbound requests. Without this,
 * overlapping calls read the same `lastCall` value, sleep in parallel, and
 * update together — defeating the rate limit. Chaining ensures each caller
 * only proceeds after the previous request has updated the timestamp.
 */
const rateLimitQueue = new Map<string, Promise<void>>();

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Enforce a minimum interval between consecutive requests to the same host.
 * Serialized per host so concurrent callers observe the updated `lastCall`
 * timestamp before proceeding. Call before every outbound request.
 */
async function rateLimit(host: string): Promise<void> {
    const prev = rateLimitQueue.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
        const now = Date.now();
        const last = lastCall.get(host) ?? 0;
        const elapsed = now - last;
        if (elapsed < MIN_INTERVAL_MS) {
            await sleep(MIN_INTERVAL_MS - elapsed);
        }
        lastCall.set(host, Date.now());
    });
    rateLimitQueue.set(host, next);
    await next;
}

/** A single search result from the MediaWiki `list=search` API. */
interface MediaWikiSearchResult {
    title: string;
    snippet: string;
}

/** A page extract from the MediaWiki `prop=extracts` API. */
interface MediaWikiExtract {
    title: string;
    extract: string;
}

/**
 * Search a MediaWiki wiki for pages matching the query.
 *
 * @param host    The wiki host (e.g., 'en.wikipedia.org' or 'starwars.fandom.com').
 * @param query   The search term.
 * @param limit   Max results (default 5).
 * @returns Array of `{ title, snippet }` results.
 */
export async function mediawikiSearch(host: string, query: string, limit = 5): Promise<MediaWikiSearchResult[]> {
    const url = `https://${host}/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    if (response.status !== 200) {
        throw new Error(`Search failed: HTTP ${response.status}`);
    }

    const data = response.json as {
        query?: { search?: Array<{ title: string; snippet: string }> };
    };

    const results = data.query?.search ?? [];
    return results.map((r) => ({
        title: r.title,
        // Snippets contain HTML highlights — strip tags for clean text.
        snippet: stripHtml(r.snippet)
    }));
}

/**
 * Internal: fetch the intro extract for a specific page title.
 *
 * Tries `prop=extracts` first (plain text, no HTML parsing needed).
 * Some Fandom wikis don't support `prop=extracts` — for those, falls back
 * to `action=parse&prop=text&section=0` and strips HTML tags.
 *
 * @returns The extract object, or null if the page is missing.
 */
async function mediawikiExtractByTitle(host: string, title: string): Promise<MediaWikiExtract | null> {
    // Try prop=extracts first (returns plain text, no HTML to strip).
    let result = await mediawikiExtractByExtracts(host, title);
    if (result) return result;

    // Fallback: action=parse (some Fandom wikis don't support prop=extracts).
    return await mediawikiExtractByParse(host, title);
}

/**
 * Attempt extraction via `action=query&prop=extracts` with redirect following.
 * Returns null when the wiki doesn't support this API or the page is missing.
 */
async function mediawikiExtractByExtracts(host: string, title: string): Promise<MediaWikiExtract | null> {
    const url =
        `https://${host}/api.php?action=query&prop=extracts&exintro=1&explaintext=1` +
        `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    if (response.status !== 200) {
        throw new Error(`Extract failed: HTTP ${response.status}`);
    }

    const data = response.json as {
        query?: {
            pages?: Record<string, { title?: string; extract?: string; missing?: string }>;
        };
    };

    const pages = data.query?.pages ?? {};
    const firstPage = Object.values(pages)[0];
    if (!firstPage || firstPage.missing !== undefined) return null;

    const extract = firstPage.extract ?? '';
    if (!extract) return null;

    return { title: firstPage.title ?? title, extract };
}

/**
 * Fallback extraction via `action=parse&prop=text&section=0`.
 * Used when the wiki doesn't support `prop=extracts`.
 * Strips HTML tags to produce plain text.
 */
async function mediawikiExtractByParse(host: string, title: string): Promise<MediaWikiExtract | null> {
    const url =
        `https://${host}/api.php?action=parse&page=${encodeURIComponent(title)}` +
        `&redirects=1&prop=text&section=0&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    if (response.status !== 200) return null;

    const data = response.json as {
        error?: { code?: string };
        parse?: { title?: string; text?: { '*': string } };
    };

    if (data.error || !data.parse?.text?.['*']) return null;

    const html = data.parse.text['*'];
    const text = stripHtml(html).replace(/\s+/g, ' ').trim();
    if (!text) return null;

    return { title: data.parse.title ?? title, extract: text };
}

/**
 * Fetch the intro extract (plain text) for a specific page title.
 *
 * Uses `explaintext=1` to get plain text instead of HTML — no parsing needed.
 * Tries exact title first, then falls back to a search-based lookup so the
 * model can use titles returned by the search API even when the exact title
 * is a redirect or differs slightly from what MediaWiki expects.
 *
 * @param host   The wiki host.
 * @param title  The page title (exact or approximate).
 * @returns The extract text, or null if the page doesn't exist.
 */
export async function mediawikiExtract(host: string, title: string): Promise<MediaWikiExtract | null> {
    // First try the exact title (with redirect following).
    let result = await mediawikiExtractByTitle(host, title);
    if (result) return result;

    // Exact title failed — fall back to search to find the actual page.
    const searchResults = await mediawikiSearch(host, title, 1);
    if (searchResults.length === 0) return null;

    const searchTitle = searchResults[0]!.title;
    if (searchTitle.toLowerCase() === title.toLowerCase()) return null;

    return await mediawikiExtractByTitle(host, searchTitle);
}

/**
 * One-step search + extract: search for a query, and if there's exactly one
 * strong match, return its extract. If there are multiple matches, return
 * the candidate titles so the model can pick.
 *
 * @param host    The wiki host.
 * @param query   The search term.
 * @param maxTokens  Truncate the extract to this many approximate tokens.
 * @returns Either the extract text, or a candidate-list string.
 */
export async function mediawikiLookup(host: string, query: string, maxTokens: number): Promise<string> {
    const results = await mediawikiSearch(host, query, 5);

    if (results.length === 0) {
        return `No results found for "${query}" on ${host}.`;
    }

    // If the first result's title matches the query closely, or there's only
    // one result, fetch the extract directly.
    const exact = results.find((r) => r.title.toLowerCase() === query.toLowerCase());
    const target = exact ?? results[0]!;

    if (results.length === 1 || exact) {
        const extract = await mediawikiExtract(host, target.title);
        if (extract) {
            const maxChars = maxTokens * 4;
            const text =
                extract.extract.length > maxChars
                    ? extract.extract.slice(0, maxChars) + '\n...[truncated]'
                    : extract.extract;
            return `${extract.title} (${host}):\n${text}`;
        }
    }

    // Multiple candidates — return the list so the model can pick.
    // Titles are quoted so the model can reliably extract the exact title
    // (rather than guessing where the title ends and the snippet begins).
    const lines = results.map((r, i) => `${i + 1}. "${r.title}" — ${r.snippet.slice(0, 100)}`);
    return (
        `Found ${results.length} results for "${query}" on ${host}. ` +
        `Use the *_page tool with the exact title (including quotes) from the list below to fetch the full extract:\n${lines.join('\n')}`
    );
}

/** Strip HTML tags from a string (used for search snippets). */
function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
}
