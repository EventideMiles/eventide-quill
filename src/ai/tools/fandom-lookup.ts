import { isImageContentType } from '../image-utils';
import type { Tool, ToolContext, ToolResult } from './tool';
import {
    downloadAndDownscaleImage,
    mediawikiCharacterGallery,
    mediawikiExtract,
    mediawikiImageInfo,
    mediawikiLookup,
    mediawikiPageImage,
    mediawikiSearch
} from './mediawiki';

/**
 * Validate the wiki subdomain against the allowed list. Returns an error
 * string on failure, or null on success. When `allowAll` is true (the danger
 * setting), any subdomain is accepted and the allowlist is ignored. Otherwise
 * an empty `allowedWikis` list means Fandom lookups are disabled (matching the
 * settings UI: "Leave empty to disable Fandom lookups").
 */
function validateWiki(wiki: string, allowedWikis: string[], allowAll: boolean): string | null {
    if (!wiki) return 'Error: "wiki" (subdomain) is required. Example: "starwars".';
    // Always enforce a safe Fandom subdomain, even in allow-all mode — reject
    // path separators, dots, query strings, and protocol fragments so the
    // value can never escape the `${wiki}.fandom.com` host template. `allowAll`
    // only bypasses the allowlist check below, not this sanitization.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(wiki)) {
        return `Error: "wiki" must be a single Fandom subdomain (letters, digits, hyphens only). Got "${wiki}".`;
    }
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
        : `${base} Fandom lookups are disabled — add a wiki in Settings → Lorebook to enable.`;
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
                    description: 'Exact page title as returned by fandom_lookup (e.g., "Luke Skywalker").'
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

/**
 * Factory: create the `fandom_image` tool.
 *
 * Finds the main image (poster, character portrait, key art) for a topic on a
 * Fandom wiki by combining a search with `prop=pageimages`, then downloads the
 * thumbnail the API returns. This is the reliable path to Fandom imagery —
 * guessing image URLs and fetching them directly 403s (Fandom hotlink-protects
 * the original files), but the `static.wikia.nocookie.net` thumbnail URLs
 * returned by the API are fetchable.
 *
 * @param maxResultTokens  Truncation cap for the text result.
 * @param maxDimension     Downscale cap (longest side, px); also the thumbnail width requested.
 * @param allowedWikis     Subdomains the writer has approved. Ignored when `allowAll` is true.
 * @param allowAll         Danger setting: accept any subdomain.
 */
export function createFandomImageTool(
    maxResultTokens: number,
    maxDimension: number,
    allowedWikis: string[],
    allowAll: boolean
): Tool {
    return {
        id: 'fandom_image',
        description:
            'Fetch an image from a Fandom wiki so you can see it (character art, cover art, scene ' +
            "reference). With `query`: returns the topic's lead image plus a list of other images on " +
            'the page. With `image` (an exact filename from a prior list): fetches that specific file. ' +
            'Requires a vision-capable model.',
        parameters: {
            type: 'object',
            properties: {
                wiki: { type: 'string', description: fandomWikiDescription(allowedWikis, allowAll) },
                query: {
                    type: 'string',
                    description:
                        'Topic to find a page for (e.g., "Luke Skywalker", "Frodo"). Returns the lead image plus a list of other images on the page. Omit if `image` is set.'
                },
                image: {
                    type: 'string',
                    description:
                        'Optional exact filename to fetch directly (e.g., "File:Frodo.jpg" or "Frodo.jpg"), as returned in a previous result\'s image list. When set, `query` is ignored.'
                }
            },
            required: ['wiki']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
            const wiki = typeof args.wiki === 'string' ? args.wiki.trim().toLowerCase() : '';
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            const image = typeof args.image === 'string' ? args.image.trim() : '';

            const err = validateWiki(wiki, allowedWikis, allowAll);
            if (err) return { text: err };
            if (!query && !image) {
                return { text: 'Error: provide "query" (to find a page) or "image" (a specific filename).' };
            }

            const host = `${wiki}.fandom.com`;
            try {
                // Path A: fetch a specific named image from the gallery.
                if (image) {
                    const info = await mediawikiImageInfo(host, image, maxDimension);
                    if (!info) {
                        return {
                            text: `No image named "${image}" found on ${host}. Call fandom_image with just a query to list the images on a page.`
                        };
                    }
                    if (!isImageContentType(info.mime)) {
                        return {
                            text: `"${image}" on ${host} is not a raster image (mime "${info.mime}") — likely a video. Pick a different file from the gallery list.`
                        };
                    }
                    const { base64, contentType } = await downloadAndDownscaleImage(info.imageUrl, maxDimension);
                    return {
                        text: `Fetched "${image}" from ${host} (${contentType}, downscaled to ≤${maxDimension}px).`,
                        images: [base64]
                    };
                }

                // Path B: query → lead image + captioned gallery list.
                const results = await mediawikiSearch(host, query, 1);
                if (results.length === 0) {
                    return { text: `No page found for "${query}" on ${host}.` };
                }
                const title = results[0]!.title;

                // List the page's images (plus its /Gallery subpage on Fandom,
                // where the fuller image set lives) with their captions, so the
                // model can pick a relevant one by name.
                const gallery = await mediawikiCharacterGallery(host, title, 16);
                const galleryNote =
                    gallery.length > 0
                        ? gallery.map((g, i) => `${i + 1}. ${g.file}${g.caption ? ` — ${g.caption}` : ''}`).join('\n')
                        : '(no other images found)';
                const pickHint =
                    ' To fetch a different image, call fandom_image again with `image` set to one of the names above.';

                const leadImage = await mediawikiPageImage(host, title, maxDimension);
                if (leadImage) {
                    try {
                        const { base64, contentType } = await downloadAndDownscaleImage(
                            leadImage.imageUrl,
                            maxDimension
                        );
                        return {
                            text:
                                `Fetched the lead image for "${title}" from ${host} (${contentType}, ` +
                                `downscaled to ≤${maxDimension}px). Other images available:\n${galleryNote}${pickHint}`,
                            images: [base64]
                        };
                    } catch (dlErr) {
                        // Lead image download failed — still surface the gallery.
                        const dlMsg = dlErr instanceof Error ? dlErr.message : String(dlErr);
                        return {
                            text:
                                `Found "${title}" on ${host} but the lead image could not be fetched (${dlMsg}). ` +
                                `Other images available:\n${galleryNote}${pickHint}`
                        };
                    }
                }

                // No lead image — return the gallery so the model can pick.
                return {
                    text: `No lead image on "${title}" (${host}). Images available:\n${galleryNote}${pickHint}`
                };
            } catch (caught) {
                const msg = caught instanceof Error ? caught.message : String(caught);
                return { text: `Error fetching image for "${query || image}" from ${host}: ${msg}` };
            }
        }
    };
}
