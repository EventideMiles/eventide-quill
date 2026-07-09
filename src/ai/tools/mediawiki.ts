import { requestUrl } from 'obsidian';
import { downscaleToJpegBase64, isImageContentType } from '../image-utils';
import { assertNotRateLimited } from './http-retry';

/**
 * Shared MediaWiki API client. Both Fandom and Wikipedia serve the same
 * `api.php` endpoint with the same query format — this module handles both
 * via a configurable host string.
 *
 * Uses Obsidian's `requestUrl` (mobile-compatible, bypasses CORS via the
 * platform proxy). All responses are JSON — no HTML parsing needed.
 */

/** Custom User-Agent to comply with Wikimedia's API policy (200 req/min tier). */
export const MEDIAWIKI_UA = 'EventideQuill/1.2.1 (https://github.com/EventideMiles/eventide-quill)';

/**
 * Wikimedia Foundation hosts whose `api.php` lives under `/w/` rather than the
 * root. Fandom and most standalone MediaWiki installs serve `api.php` at the
 * root; using the wrong path 404s. Wikipedia (the only Wikimedia host this
 * plugin constructs today, via `${lang}.wikipedia.org`) is the motivating case
 * — the sibling projects are covered for safety.
 */
const WIKIMEDIA_HOST_RE =
    /\.(?:wikipedia|wiktionary|wikiquote|wikibooks|wikisource|wikinews|wikiversity|wikivoyage|wikimedia)\.org$/;

function isWikimediaHost(host: string): boolean {
    return WIKIMEDIA_HOST_RE.test(host);
}

/**
 * Full `api.php` endpoint URL for a host, including the correct path:
 * `https://<host>/w/api.php` for Wikimedia projects, `https://<host>/api.php`
 * for Fandom / standalone installs. Callers append `?action=...` query params.
 */
export function apiEndpoint(host: string): string {
    return isWikimediaHost(host) ? `https://${host}/w/api.php` : `https://${host}/api.php`;
}

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

/** Promise-based sleep. Raw setTimeout: a one-shot promise resolution can't use registerInterval (which is for recurring ticks) and must resolve exactly once after the delay. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Error thrown by the MediaWiki client helpers when the API returns a non-2xx
 * HTTP response (every throw site except the silent "missing page" → null
 * fallbacks). Carries the HTTP status so callers can distinguish a MediaWiki
 * API failure (e.g. a 5xx outage or a 404 on the endpoint) from a transport
 * error thrown by `requestUrl`, and from a rate-limit — HTTP 429 is surfaced
 * as {@link RateLimitError} via `assertNotRateLimited`, which runs before this
 * check, so a `MediaWikiError` never carries status 429.
 */
export class MediaWikiError extends Error {
    /** HTTP status code returned by the MediaWiki API. */
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'MediaWikiError';
        this.status = status;
    }
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
    const url = `${apiEndpoint(host)}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Search failed: HTTP ${response.status}`, response.status);
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
 * Total article count for a wiki's Main namespace, via `meta=siteinfo`. Used
 * by the bulk-sync indexer to report size + let the writer judge before a long
 * sync. Returns 0 if the field is missing.
 */
export async function mediawikiArticleCount(host: string): Promise<number> {
    const url = `${apiEndpoint(host)}?action=query&meta=siteinfo&siprop=statistics&format=json&origin=*`;
    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });
    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`siteinfo failed: HTTP ${response.status}`, response.status);
    }
    const stats = (response.json as { query?: { statistics?: { articles?: number } } }).query?.statistics;
    return stats?.articles ?? 0;
}

/**
 * Enumerate every page title in a wiki's Main namespace (namespace 0) via
 * `list=allpages` with `apcontinue` pagination (500 per batch). Used by the
 * bulk-sync indexer. Reuses the per-host rate limiter and checks the abort
 * signal between batches. Returns all titles in one array (fine even for large
 * wikis — tens of thousands of short strings).
 */
export async function mediawikiAllPages(host: string, signal?: AbortSignal): Promise<string[]> {
    const titles: string[] = [];
    let apcontinue = '';
    for (;;) {
        if (signal?.aborted) break;
        await rateLimit(host);
        let url = `${apiEndpoint(host)}?action=query&list=allpages` + `&apnamespace=0&aplimit=500&format=json&origin=*`;
        if (apcontinue) url += `&apcontinue=${encodeURIComponent(apcontinue)}`;
        const response = await requestUrl({
            url,
            method: 'GET',
            headers: { 'User-Agent': MEDIAWIKI_UA },
            throw: false
        });
        assertNotRateLimited(response);
        if (response.status !== 200) {
            throw new MediaWikiError(`allpages enumeration failed: HTTP ${response.status}`, response.status);
        }
        const data = response.json as {
            query?: { allpages?: Array<{ title: string }> };
            continue?: { apcontinue?: string };
        };
        const pages = data.query?.allpages ?? [];
        for (const p of pages) titles.push(p.title);
        const next = data['continue' as keyof typeof data];
        apcontinue = (next as { apcontinue?: string } | undefined)?.apcontinue ?? '';
        if (!apcontinue) break;
    }
    return titles;
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
        `${apiEndpoint(host)}?action=query&prop=extracts&exintro=1&explaintext=1` +
        `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Extract failed: HTTP ${response.status}`, response.status);
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
        `${apiEndpoint(host)}?action=parse&page=${encodeURIComponent(title)}` +
        `&redirects=1&prop=text&section=0&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    // A 429 is a rate-limit, not a missing page — let it throw before the
    // silent non-200 → null fallback below.
    assertNotRateLimited(response);
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
 * @returns A {@link MediaWikiLookupResult} — `text` for the response, plus
 *   `matchedTitle`/`matchedExtract` when the lookup resolved to a single
 *   page's extract (for cache write-through by the fandom_lookup caller).
 */
export interface MediaWikiLookupResult {
    /** The formatted response string (truncated extract, candidate list, or no-results message). */
    text: string;
    /** Set only when the lookup resolved to a single page's extract — the canonical title. */
    matchedTitle?: string;
    /** The full (untruncated) extract text when `matchedTitle` is set. */
    matchedExtract?: string;
}

export async function mediawikiLookup(host: string, query: string, maxTokens: number): Promise<MediaWikiLookupResult> {
    const results = await mediawikiSearch(host, query, 5);

    if (results.length === 0) {
        return { text: `No results found for "${query}" on ${host}.` };
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
            return {
                text: `${extract.title} (${host}):\n${text}`,
                matchedTitle: extract.title,
                matchedExtract: extract.extract
            };
        }
    }

    // Multiple candidates — return the list so the model can pick.
    // Titles are quoted so the model can reliably extract the exact title
    // (rather than guessing where the title ends and the snippet begins).
    const lines = results.map((r, i) => `${i + 1}. "${r.title}" — ${r.snippet.slice(0, 100)}`);
    return {
        text:
            `Found ${results.length} results for "${query}" on ${host}. ` +
            `Use the *_page tool with the exact title (including quotes) from the list below to fetch the full extract:\n${lines.join('\n')}`
    };
}

/**
 * Fetch the main page-image thumbnail URL for a specific page title via the
 * MediaWiki `prop=pageimages` API. Returns the thumbnail source URL (scaled to
 * `thumbSize` wide) or null if the page has no image or is missing.
 *
 * The returned URL lives on the wiki's image CDN (`static.wikia.nocookie.net`
 * for Fandom, `upload.wikimedia.org` for Wikipedia) and is fetchable — unlike
 * original file URLs, which hotlink-protect and 403/404 on direct fetch. This
 * is the reliable way to obtain a page's lead image for a vision model.
 *
 * @param host      The wiki host.
 * @param title     The page title.
 * @param thumbSize Max thumbnail width in pixels.
 */
export async function mediawikiPageImage(
    host: string,
    title: string,
    thumbSize: number
): Promise<{ title: string; imageUrl: string } | null> {
    const url =
        `${apiEndpoint(host)}?action=query&prop=pageimages&piprop=thumbnail` +
        `&pithumbsize=${thumbSize}&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Page image query failed: HTTP ${response.status}`, response.status);
    }

    const data = response.json as {
        query?: { pages?: Record<string, { title?: string; thumbnail?: { source: string } }> };
    };

    const firstPage = Object.values(data.query?.pages ?? {})[0];
    if (!firstPage?.thumbnail?.source) return null;

    return { title: firstPage.title ?? title, imageUrl: firstPage.thumbnail.source };
}

/**
 * List the image filenames used on a page (the page's gallery, including the
 * lead image) via the MediaWiki `prop=images` query. Returns full file titles
 * (e.g. `"File:Foo.jpg"`). The list may include non-raster files (video clips
 * are common on Fandom) — callers should validate `mime` when fetching.
 *
 * @param host   The wiki host.
 * @param title  The page title.
 * @param limit  Max filenames to return.
 */
export async function mediawikiPageGallery(host: string, title: string, limit: number): Promise<string[]> {
    const url =
        `${apiEndpoint(host)}?action=query&prop=images&imlimit=${limit}` +
        `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Gallery query failed: HTTP ${response.status}`, response.status);
    }

    const data = response.json as {
        query?: { pages?: Record<string, { images?: Array<{ title: string }> }> };
    };

    const firstPage = Object.values(data.query?.pages ?? {})[0];
    return (firstPage?.images ?? []).map((img) => img.title);
}

/**
 * Fetch a specific image file's thumbnail URL and MIME type via the MediaWiki
 * `prop=imageinfo` query. `filename` may be a bare name ("Foo.jpg") or a full
 * `"File:Foo.jpg"` title. Returns null if the file doesn't exist. The returned
 * `imageUrl` is the bounded thumbnail on the wiki CDN, which is fetchable
 * (original file URLs hotlink-protect).
 */
export async function mediawikiImageInfo(
    host: string,
    filename: string,
    thumbSize: number
): Promise<{ imageUrl: string; mime: string } | null> {
    const fileTitle = normalizeFileTitle(filename);
    const url =
        `${apiEndpoint(host)}?action=query&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=${thumbSize}` +
        `&titles=${encodeURIComponent(fileTitle)}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Image info query failed: HTTP ${response.status}`, response.status);
    }

    const data = response.json as {
        query?: {
            pages?: Record<
                string,
                {
                    imageinfo?: Array<{ thumburl?: string; url?: string; mime?: string }>;
                }
            >;
        };
    };

    const firstPage = Object.values(data.query?.pages ?? {})[0];
    const info = firstPage?.imageinfo?.[0];
    if (!info) return null;

    // Prefer the bounded thumbnail; fall back to the original URL.
    const imageUrl = info.thumburl ?? info.url;
    if (!imageUrl) return null;
    return { imageUrl, mime: info.mime ?? '' };
}

/** Normalize a bare filename to a full `File:` title (no-op if already prefixed). */
function normalizeFileTitle(filename: string): string {
    const trimmed = filename.trim();
    return /^(file|image):/i.test(trimmed) ? trimmed : `File:${trimmed}`;
}

/**
 * Parse `<gallery>` blocks out of article wikitext and return each image with
 * its caption (the human-authored text beside the filename — e.g. "Werewolf",
 * "Frodo in the Shire"). These captions are what let a model pick a relevant
 * image; bare filenames rarely convey what an image depicts. Lines without a
 * caption, or whose other segments are `key=value` attributes (`link=`/`alt=`),
 * get `caption: undefined`. Filenames are normalized to full `File:` titles.
 */
function parseGalleryCaptions(wikitext: string, limit: number): Array<{ file: string; caption?: string }> {
    const out: Array<{ file: string; caption?: string }> = [];
    const blocks = wikitext.match(/<gallery[^>]*>([\s\S]*?)<\/gallery>/gi);
    if (!blocks) return out;
    for (const block of blocks) {
        for (const raw of block.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('<') || line.startsWith('}}')) continue;
            const segs = line.split('|');
            const file = segs[0]?.trim();
            if (!file) continue;
            // Skip standalone gallery attribute lines (mode=, caption=,
            // showfilename=, widths=, etc.) — these aren't file entries. Real
            // filenames start with `File:`/`Image:` or contain an extension,
            // so a leading lowercase-word-then-`=` never matches them.
            if (/^[a-z]+=/i.test(file)) continue;
            // Caption = pipe-separated segments that aren't `key=value` attrs.
            const captionSegs = segs
                .slice(1)
                .map((s) => s.trim())
                .filter((s) => s.length > 0 && !s.includes('='));
            out.push({
                file: normalizeFileTitle(file),
                caption: captionSegs.length > 0 ? captionSegs.join(' ') : undefined
            });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/**
 * Fetch the article wikitext and return the page's gallery images with
 * captions (from `<gallery>` blocks). Returns an empty array when the page has
 * no galleries or the wikitext can't be fetched.
 */
export async function mediawikiGalleryWithCaptions(
    host: string,
    title: string,
    limit: number
): Promise<Array<{ file: string; caption?: string }>> {
    const url = `${apiEndpoint(host)}?action=parse&prop=wikitext&redirects=1&page=${encodeURIComponent(
        title
    )}&format=json&origin=*`;

    await rateLimit(host);
    const response = await requestUrl({ url, method: 'GET', headers: { 'User-Agent': MEDIAWIKI_UA }, throw: false });

    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Wikitext fetch failed: HTTP ${response.status}`, response.status);
    }

    const data = response.json as { parse?: { wikitext?: { '*': string } }; error?: unknown };
    const wikitext = data.parse?.wikitext?.['*'];
    if (!wikitext) return [];
    return parseGalleryCaptions(wikitext, limit);
}

/**
 * Best-effort captioned gallery for a character/topic page: merges captions
 * from the page's own `<gallery>` blocks AND its dedicated "<title>/Gallery"
 * subpage (a Fandom convention where the fuller image set lives). Dedupes by
 * filename and caps at `limit`. Missing subpages parse to an empty list and
 * are silently skipped. Falls back to the flat `prop=images` filename list
 * when neither page has galleries.
 */
export async function mediawikiCharacterGallery(
    host: string,
    title: string,
    limit: number
): Promise<Array<{ file: string; caption?: string }>> {
    const combined: Array<{ file: string; caption?: string }> = [];
    const seen = new Set<string>();
    const add = (entries: Array<{ file: string; caption?: string }>) => {
        for (const e of entries) {
            const key = e.file.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            combined.push(e);
            if (combined.length >= limit) return;
        }
    };

    add(await mediawikiGalleryWithCaptions(host, title, limit));
    if (combined.length < limit && !/\/gallery$/i.test(title)) {
        // Dedicated /Gallery subpage holds the fuller image set for a
        // character. A missing subpage returns an empty list (no throw).
        add(await mediawikiGalleryWithCaptions(host, `${title}/Gallery`, limit));
    }

    if (combined.length > 0) return combined;

    // Neither page had <gallery> blocks — fall back to the flat image list.
    const files = await mediawikiPageGallery(host, title, limit);
    return files.map((file) => ({ file }));
}

/** Strip HTML tags from a string (used for search snippets). */
function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
}

/**
 * Download an image from a MediaWiki thumbnail/original URL and downscale it
 * to a vision-ready JPEG base64. Throws on HTTP failure or non-image
 * responses so callers can catch and surface a textual error to the model.
 *
 * Shared by `fandom_image` and `wikipedia_image`. Uses {@link MEDIAWIKI_UA}
 * to comply with the Wikimedia API policy and Fandom's hotlink rules.
 */
export async function downloadAndDownscaleImage(
    url: string,
    maxDimension: number
): Promise<{ base64: string; contentType: string }> {
    const response = await requestUrl({
        url,
        method: 'GET',
        throw: false,
        headers: { Accept: 'image/*', 'User-Agent': MEDIAWIKI_UA }
    });
    assertNotRateLimited(response);
    if (response.status !== 200) {
        throw new MediaWikiError(`Image download failed: HTTP ${response.status}`, response.status);
    }
    const contentType = response.headers['content-type'] ?? '';
    if (!isImageContentType(contentType)) {
        throw new Error(`response was not a raster image (content-type "${contentType}")`);
    }
    const base64 = await downscaleToJpegBase64(response.arrayBuffer, maxDimension, contentType);
    return { base64, contentType };
}
