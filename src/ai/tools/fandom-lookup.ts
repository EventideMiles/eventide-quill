import type { Tool, ToolContext } from './tool';
import { mediawikiLookup } from './mediawiki';

/**
 * Factory: create the `fandom_lookup` tool.
 *
 * Searches a Fandom wiki for a topic and returns the intro extract (plain
 * text). The model picks from the configured wiki subdomains — if ambiguous,
 * returns candidate titles so the model can narrow down.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param allowedWikis     Subdomains the writer has approved (e.g., ['starwars']).
 *                         Empty array = all Fandom wikis allowed.
 */
export function createFandomLookupTool(maxResultTokens: number, allowedWikis: string[]): Tool {
    return {
        id: 'fandom_lookup',
        description:
            'Search a Fandom wiki and return the intro extract for a topic. ' +
            'Use to look up canon details for fan-fiction research. If the ' +
            'result is ambiguous, you will get candidate titles — call again ' +
            'with the exact title to get the full extract.',
        parameters: {
            type: 'object',
            properties: {
                wiki: {
                    type: 'string',
                    description:
                        'Fandom wiki subdomain (e.g., "starwars", "memory-alpha", "lotr").' +
                        (allowedWikis.length > 0
                            ? ` Allowed: ${allowedWikis.join(', ')}.`
                            : ' Any subdomain is allowed.')
                },
                query: {
                    type: 'string',
                    description: 'Topic to search for (e.g., "Luke Skywalker", " USS Enterprise").'
                }
            },
            required: ['wiki', 'query']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            const wiki = typeof args.wiki === 'string' ? args.wiki.trim().toLowerCase() : '';
            const query = typeof args.query === 'string' ? args.query.trim() : '';

            if (!wiki) return 'Error: "wiki" (subdomain) is required. Example: "starwars".';
            if (!query) return 'Error: "query" is required.';

            // Validate against the allowed list when configured.
            if (allowedWikis.length > 0 && !allowedWikis.includes(wiki)) {
                return `Error: wiki "${wiki}" is not in the allowed list. Allowed: ${allowedWikis.join(', ')}.`;
            }

            const host = `${wiki}.fandom.com`;
            try {
                return await mediawikiLookup(host, query, maxResultTokens);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error looking up "${query}" on ${host}: ${msg}`;
            }
        }
    };
}
