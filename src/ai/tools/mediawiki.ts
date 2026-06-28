import { requestUrl } from 'obsidian';

/**
 * Shared MediaWiki API client. Both Fandom and Wikipedia serve the same
 * `api.php` endpoint with the same query format — this module handles both
 * via a configurable host string.
 *
 * Uses Obsidian's `requestUrl` (mobile-compatible, bypasses CORS via the
 * platform proxy). All responses are JSON — no HTML parsing needed.
 */

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

    const response = await requestUrl({ url, method: 'GET', throw: false });

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
 * Fetch the intro extract (plain text) for a specific page title.
 *
 * Uses `explaintext=1` to get plain text instead of HTML — no parsing needed.
 * Falls back gracefully when `explaintext` isn't supported (some Fandom wikis).
 *
 * @param host   The wiki host.
 * @param title  The exact page title.
 * @returns The extract text, or null if the page doesn't exist.
 */
export async function mediawikiExtract(host: string, title: string): Promise<MediaWikiExtract | null> {
    const url =
        `https://${host}/api.php?action=query&prop=extracts&exintro=1&explaintext=1` +
        `&titles=${encodeURIComponent(title)}&format=json&origin=*`;

    const response = await requestUrl({ url, method: 'GET', throw: false });

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
    const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet.slice(0, 100)}`);
    return (
        `Found ${results.length} results for "${query}" on ${host}. ` +
        `Call again with a specific title to get the full extract:\n${lines.join('\n')}`
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
