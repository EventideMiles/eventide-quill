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

            // Block SSRF: reject localhost, private RFC1918 ranges, link-local,
            // and other internal destinations before any network call. The host
            // is validated here from the model-supplied URL; requestUrl follows
            // redirects internally (and exposes no final URL), so redirect
            // targets cannot be re-checked — the initial host gate is the guard.
            const hostErr = validatePublicHost(url);
            if (hostErr) return hostErr;

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

/**
 * Reject URLs that target a local or private network destination (SSRF guard).
 * Returns an error string when the host is internal, or null when the host is
 * safe to fetch. Covers hostname forms (localhost, *.local), IPv4 literals in
 * loopback / RFC1918 / link-local / CGNAT / 0.0.0.0 ranges, IPv6 loopback /
 * link-local / unique-local prefixes, and IPv4-mapped IPv6 literals
 * (::ffff:a.b.c.d / ::ffff:xxxx:yyyy).
 *
 * Note: this is a string-based guard over the model-supplied URL. DNS
 * rebinding (a hostname that resolves public at check time, private at fetch
 * time) and requestUrl's internal redirect-following are out of scope here —
 * the initial host gate is the defense.
 */
export function validatePublicHost(rawUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return 'Error: invalid URL.';
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return 'Error: URL has no host.';

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        return `Error: refusing to fetch local host "${host}".`;
    }

    // IPv6 loopback / link-local / unique-local / IPv4-mapped. Only meaningful
    // for IPv6 literals (which contain a colon), so the prefix checks can't
    // trip on ordinary DNS hostnames that merely start with "fc"/"fd"/"fe".
    if (host.includes(':')) {
        if (host === '::1' || host === '::') {
            return `Error: refusing to fetch local host "${host}".`;
        }
        if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
            return `Error: refusing to fetch local host "${host}".`;
        }
        // IPv4-mapped IPv6 — the WHATWG URL parser normalizes these to hex
        // form (::ffff:7f00:1), so the embedded IPv4 would otherwise sail
        // past the bare-IPv4 rules below. Extract it and re-check.
        const mapped = mappedV4FirstOctets(host);
        if (mapped && isPrivateV4(mapped[0], mapped[1])) {
            return `Error: refusing to fetch private-network host "${host}".`;
        }
    }

    // IPv4 literal checks.
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4 && isPrivateV4(Number(v4[1]), Number(v4[2]))) {
        return `Error: refusing to fetch private-network host "${host}".`;
    }

    return null;
}

/**
 * IPv4 private/loopback range rules. Takes the first two octets (all the
 * ranges need). Shared by the bare-IPv4 and IPv4-mapped IPv6 paths.
 */
function isPrivateV4(a: number, b: number): boolean {
    return (
        a === 0 || // 0.0.0.0/8
        a === 10 || // RFC1918
        a === 127 || // loopback
        (a === 169 && b === 254) || // link-local
        (a === 172 && b >= 16 && b <= 31) || // RFC1918
        (a === 192 && b === 168) || // RFC1918
        (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
    );
}

/**
 * First two octets of the IPv4 embedded in an IPv4-mapped IPv6 literal, or
 * null when the host isn't a mapped literal. Handles mixed notation
 * (::ffff:127.0.0.1) and hex notation (::ffff:7f00:1 — the form the URL
 * parser normalizes to). The first two octets are all the private-range
 * rules need.
 */
function mappedV4FirstOctets(host: string): [number, number] | null {
    // Mixed notation: ::ffff:127.0.0.1
    const mixed = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (mixed) return [Number(mixed[1]), Number(mixed[2])];
    // Hex notation: ::ffff:7f00:0001 (first group → first two IPv4 octets)
    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
    if (hex) {
        const hi = parseInt(hex[1] ?? '0', 16);
        return [(hi >> 8) & 0xff, hi & 0xff];
    }
    return null;
}
