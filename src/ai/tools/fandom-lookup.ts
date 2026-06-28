import type { Tool, ToolContext } from './tool';
import { mediawikiExtract, mediawikiLookup } from './mediawiki';

/**
 * Validate the wiki subdomain against the allowed list. Returns an error
 * string on failure, or null on success. When `allowAll` is true (the danger
 * setting), any subdomain is accepted and the allowlist is ignored. Otherwise
 * an empty `allowedWikis` list means Fandom lookups are disabled (matching the
 * settings UI: "Leave empty to disable Fandom lookups").
 */
function validateWiki(wiki: string, allowedWikis: string[], allowAll: boolean): string | null {
    if (!wiki) return 'Error: "wiki" (subdomain) is required. Example: "starwars".';
    if (allowAll) return null; // danger mode: any Fandom wiki allowed
    if (allowedWikis.length === 0) {
        return 'Error: Fandom lookups are disabled. Add wiki subdomains in Settings → Lorebook.';
    }
    if (!allowedWikis.includes(wiki)) {
        return `Error: wiki "${wiki}" is not in the allowed list. Allowed: ${allowedWikis.join(', ')}.`;
    }
    return null;
}

/** Build the `wiki` parameter description reflecting the active allow mode. */
function fandomWikiDescription(allowedWikis: string[], allowAll: boolean): string {
    const base = 'Fandom wiki subdomain (e.g., "starwars", "memory-alpha", "lotr").';
    if (allowAll) return `${base} Any subdomain is allowed.`;
    return allowedWikis.length > 0
        ? `${base} Allowed: ${allowedWikis.join(', ')}.`
        : `${base} Any subdomain is allowed.`;
}

/**
 * Factory: create the `fandom_lookup` tool.
 *
 * Searches a Fandom wiki for a topic and returns candidate titles or the
 * intro extract if there's an unambiguous match. For ambiguous results, use
 * `fandom_page` with the exact title to fetch the full content.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param allowedWikis     Subdomains the writer has approved (e.g., ['starwars']).
 *                         Ignored when `allowAll` is true.
 * @param allowAll         Danger setting: when true, any Fandom subdomain is
 *                         accepted and `allowedWikis` is ignored.
 */
export function createFandomLookupTool(maxResultTokens: number, allowedWikis: string[], allowAll: boolean): Tool {
    return {
        id: 'fandom_lookup',
        description:
            'Search a Fandom wiki for a topic. Returns the intro extract when ' +
            'there is exactly one clear match, otherwise returns a list of ' +
            'candidate titles. Use fandom_page to fetch the full content of a ' +
            'specific page when you have the exact title.',
        parameters: {
            type: 'object',
            properties: {
                wiki: {
                    type: 'string',
                    description: fandomWikiDescription(allowedWikis, allowAll)
                },
                query: {
                    type: 'string',
                    description: 'Topic to search for (e.g., "Luke Skywalker", "USS Enterprise").'
                }
            },
            required: ['wiki', 'query']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const wiki = typeof args.wiki === 'string' ? args.wiki.trim().toLowerCase() : '';
            const query = typeof args.query === 'string' ? args.query.trim() : '';

            const err = validateWiki(wiki, allowedWikis, allowAll);
            if (err) return err;
            if (!query) return 'Error: "query" is required.';

            const host = `${wiki}.fandom.com`;
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
 * Factory: create the `fandom_page` tool.
 *
 * Fetches the intro extract for a specific page by exact title. Use after
 * `fandom_lookup` returns candidate titles to retrieve the full content.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param allowedWikis     Subdomains the writer has approved (e.g., ['starwars']).
 *                         Ignored when `allowAll` is true.
 * @param allowAll         Danger setting: when true, any Fandom subdomain is
 *                         accepted and `allowedWikis` is ignored.
 */
export function createFandomPageTool(maxResultTokens: number, allowedWikis: string[], allowAll: boolean): Tool {
    return {
        id: 'fandom_page',
        description:
            'Fetch the intro extract of a specific Fandom wiki page by exact ' +
            'title. Use after fandom_lookup returns candidate titles — pass ' +
            'the exact title from the list to get the full content.',
        parameters: {
            type: 'object',
            properties: {
                wiki: {
                    type: 'string',
                    description: fandomWikiDescription(allowedWikis, allowAll)
                },
                title: {
                    type: 'string',
                    description: 'Exact page title as returned by fandom_lookup (e.g., "Winslow Spectre").'
                }
            },
            required: ['wiki', 'title']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const wiki = typeof args.wiki === 'string' ? args.wiki.trim().toLowerCase() : '';
            const title = typeof args.title === 'string' ? args.title.trim() : '';

            const err = validateWiki(wiki, allowedWikis, allowAll);
            if (err) return err;
            if (!title) return 'Error: "title" is required.';

            const host = `${wiki}.fandom.com`;
            try {
                const extract = await mediawikiExtract(host, title);
                if (!extract) {
                    return `No page found for "${title}" on ${host}. Use fandom_lookup to search for related topics.`;
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
