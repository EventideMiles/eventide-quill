import type { Tool, ToolContext } from './tool';
import { mediawikiExtract, mediawikiLookup } from './mediawiki';

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
