import type { Tool, ToolContext, ToolResult } from './tool';
import {
    downloadAndDownscaleImage,
    mediawikiExtract,
    mediawikiLookup,
    mediawikiPageImage,
    mediawikiSearch
} from './mediawiki';

/**
 * Build the Wikipedia host from the configured language.
 */
function wikipediaHost(lang: string): string {
    return `${lang}.wikipedia.org`;
}

/**
 * Factory: create the `wikipedia_lookup` tool.
 *
 * Searches Wikipedia and returns candidate titles or the intro extract if
 * there's an unambiguous match. Use `wikipedia_page` with the exact title
 * to fetch the full content when results are ambiguous.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param lang             Wikipedia language subdomain (e.g., 'en', 'fr').
 */
export function createWikipediaLookupTool(maxResultTokens: number, lang: string): Tool {
    return {
        id: 'wikipedia_lookup',
        description:
            'Search Wikipedia for a topic. Returns the intro extract when ' +
            'there is exactly one clear match, otherwise returns a list of ' +
            'candidate titles. Use wikipedia_page to fetch the full content ' +
            'of a specific page when you have the exact title.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Topic to search for (e.g., "French Revolution", "photosynthesis").'
                }
            },
            required: ['query']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (!query) return 'Error: "query" is required.';

            const host = wikipediaHost(lang);
            try {
                return await mediawikiLookup(host, query, maxResultTokens);
            } catch (caught) {
                const msg = caught instanceof Error ? caught.message : String(caught);
                return `Error looking up "${query}" on ${host}: ${msg}`;
            }
        }
    };
}

/**
 * Factory: create the `wikipedia_page` tool.
 *
 * Fetches the intro extract for a specific Wikipedia page by exact title.
 * Use after `wikipedia_lookup` returns candidate titles to retrieve the
 * full content.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param lang             Wikipedia language subdomain (e.g., 'en', 'fr').
 */
export function createWikipediaPageTool(maxResultTokens: number, lang: string): Tool {
    return {
        id: 'wikipedia_page',
        description:
            'Fetch the intro extract of a specific Wikipedia page by exact ' +
            'title. Use after wikipedia_lookup returns candidate titles — ' +
            'pass the exact title from the list to get the full content.',
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Exact page title as returned by wikipedia_lookup (e.g., "French Revolution").'
                }
            },
            required: ['title']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const title = typeof args.title === 'string' ? args.title.trim() : '';
            if (!title) return 'Error: "title" is required.';

            const host = wikipediaHost(lang);
            try {
                const extract = await mediawikiExtract(host, title);
                if (!extract) {
                    return `No page found for "${title}" on ${host}. Use wikipedia_lookup to search for related topics.`;
                }
                const maxChars = maxResultTokens * 4;
                const text =
                    extract.extract.length > maxChars
                        ? extract.extract.slice(0, maxChars) + '\n...[truncated]'
                        : extract.extract;
                return `${extract.title} (${host}):\n${text}`;
            } catch (caught) {
                const msg = caught instanceof Error ? caught.message : String(caught);
                return `Error fetching page "${title}" from ${host}: ${msg}`;
            }
        }
    };
}

/**
 * Factory: create the `wikipedia_image` tool.
 *
 * Fetches the lead image (most often a portrait for biographies) for a topic
 * on Wikipedia via `prop=pageimages`, then downloads and downscales it. The
 * Wikipedia sibling of `fandom_image`, intentionally simpler — Wikipedia
 * biographies don't follow Fandom's `<title>/Gallery` subpage convention, so
 * there's no gallery-listing path; callers wanting a specific non-lead image
 * should use `fetch_image_url` with a direct URL.
 *
 * @param maxResultTokens  Truncation cap for the text result.
 * @param maxDimension     Downscale cap (longest side, px); also the thumbnail width requested.
 * @param lang             Wikipedia language subdomain (e.g., 'en', 'fr').
 */
export function createWikipediaImageTool(maxResultTokens: number, maxDimension: number, lang: string): Tool {
    return {
        id: 'wikipedia_image',
        description:
            'Fetch the lead image from a Wikipedia page so you can see it (most often a portrait for biographies, ' +
            'cover art for works, or a photograph for a place or object). Pass a `query` and the page is found ' +
            'automatically. Requires a vision-capable model.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Topic to find a page for (e.g., "Ada Lovelace", "Tokyo", "The Great Gatsby"). ' +
                        'The page is resolved by search; its lead image is returned.'
                }
            },
            required: ['query']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (!query) return { text: 'Error: "query" is required.' };

            const host = wikipediaHost(lang);
            try {
                // Resolve the query to a single best-match page title.
                const results = await mediawikiSearch(host, query, 1);
                if (results.length === 0) {
                    return { text: `No page found for "${query}" on ${host}.` };
                }
                const title = results[0]!.title;

                // Fetch the lead image (pageimages thumbnail) for that title.
                const leadImage = await mediawikiPageImage(host, title, maxDimension);
                if (!leadImage) {
                    return {
                        text:
                            `No lead image on "${title}" (${host}). The page may not have a portrait or poster. ` +
                            'If you have a direct image URL, use fetch_image_url instead.'
                    };
                }

                try {
                    const { base64, contentType } = await downloadAndDownscaleImage(leadImage.imageUrl, maxDimension);
                    return {
                        text: `Fetched the lead image for "${title}" from ${host} (${contentType}, downscaled to ≤${maxDimension}px).`,
                        images: [base64]
                    };
                } catch (dlErr) {
                    const dlMsg = dlErr instanceof Error ? dlErr.message : String(dlErr);
                    return {
                        text:
                            `Found "${title}" on ${host} but the lead image could not be fetched (${dlMsg}). ` +
                            'If you have a direct image URL, use fetch_image_url instead.'
                    };
                }
            } catch (caught) {
                const msg = caught instanceof Error ? caught.message : String(caught);
                return { text: `Error fetching image for "${query}" from ${host}: ${msg}` };
            }
        }
    };
}
