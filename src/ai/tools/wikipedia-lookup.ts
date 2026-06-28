import type { Tool, ToolContext } from './tool';
import { mediawikiLookup } from './mediawiki';

/**
 * Factory: create the `wikipedia_lookup` tool.
 *
 * Searches Wikipedia and returns the intro extract (plain text). Useful for
 * general research — historical events, scientific concepts, places, etc.
 *
 * @param maxResultTokens  Truncation cap for the extract.
 * @param lang             Wikipedia language subdomain (e.g., 'en', 'fr').
 */
export function createWikipediaLookupTool(maxResultTokens: number, lang: string): Tool {
    return {
        id: 'wikipedia_lookup',
        description:
            'Search Wikipedia and return the intro extract for a topic. ' +
            'Use for general research — history, science, places, culture, etc. ' +
            'If the result is ambiguous, call again with the exact title.',
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

            const host = `${lang}.wikipedia.org`;
            try {
                return await mediawikiLookup(host, query, maxResultTokens);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error looking up "${query}" on ${host}: ${msg}`;
            }
        }
    };
}
