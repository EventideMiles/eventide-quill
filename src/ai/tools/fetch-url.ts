import { requestUrl } from 'obsidian';
import type { Tool, ToolContext } from './tool';

/**
 * Factory: create the `fetch_url` tool with a configurable result cap.
 *
 * Fetches any URL and converts the HTML response to clean text via
 * DOMParser (desktop Electron) with a regex fallback (mobile). Strips
 * script, style, nav, aside, header, footer, and noscript elements.
 * Non-HTML responses return the raw text truncated.
 *
 * Uses Obsidian's `requestUrl` (mobile-compatible, bypasses CORS).
 */
export function createFetchUrlTool(maxResultTokens: number): Tool {
    return {
        id: 'fetch_url',
        description:
            'Fetch a URL and return the page content as clean text (HTML tags ' +
            'stripped, scripts/nav/aside removed). Use to pull reference material, ' +
            'research articles, or wiki pages. Results are truncated to fit context.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'Full URL including https:// (e.g., "https://en.wikipedia.org/wiki/Sarah_Connor").'
                }
            },
            required: ['url']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const url = typeof args.url === 'string' ? args.url.trim() : '';
            if (!url) return 'Error: "url" is required.';
            if (!/^https?:\/\//i.test(url)) {
                return 'Error: URL must start with http:// or https://';
            }

            try {
                const response = await requestUrl({
                    url,
                    method: 'GET',
                    throw: false,
                    headers: { Accept: 'text/html, text/plain, */*' }
                });

                if (response.status !== 200) {
                    return `Error: HTTP ${response.status} fetching "${url}".`;
                }

                const contentType = response.headers['content-type'] ?? '';
                const text = response.text;

                if (contentType.includes('text/html')) {
                    const cleaned = htmlToText(text);
                    return truncate(cleaned, maxResultTokens, url);
                }

                // Non-HTML (plain text, JSON, etc.) — return as-is.
                return truncate(text, maxResultTokens, url);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error fetching "${url}": ${msg}`;
            }
        }
    };
}

/**
 * Convert HTML to clean text. Tries DOMParser first (precise element removal),
 * falls back to regex tag stripping when DOMParser is unavailable (some
 * mobile Capacitor builds).
 */
function htmlToText(html: string): string {
    // Try DOMParser — available in Electron desktop and most Capacitor builds.
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, nav, aside, header, footer, noscript, iframe, svg').forEach((el) =>
            el.remove()
        );
        const text = doc.body?.textContent ?? '';
        if (text.trim().length > 0) return collapseWhitespace(text);
    } catch {
        // DOMParser not available — fall through to regex.
    }

    // Regex fallback — less precise but works everywhere.
    let clean = html;
    // Remove script/style/nav blocks entirely (including content).
    clean = clean.replace(/<(script|style|nav|aside|header|footer|noscript|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    // Remove remaining tags.
    clean = clean.replace(/<[^>]+>/g, ' ');
    // Decode common entities.
    clean = clean
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&quot;/g, '"');
    return collapseWhitespace(clean);
}

/** Collapse runs of whitespace into single spaces/newlines. */
function collapseWhitespace(text: string): string {
    return text
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Truncate text to approximately maxTokens tokens (chars / 4). */
function truncate(text: string, maxTokens: number, url: string): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + `\n\n...[truncated at ${maxTokens} tokens — full page at ${url}]`;
}
