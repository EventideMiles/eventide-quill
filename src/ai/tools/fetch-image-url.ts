import { requestUrl } from 'obsidian';
import { downscaleToJpegBase64, isImageContentType } from '../image-utils';
import type { Tool, ToolContext, ToolResult } from './tool';
import { validatePublicHost } from './fetch-url';
import { assertNotRateLimited, toolErrorMessage } from './http-retry';

/**
 * Factory: create the `fetch_image_url` tool.
 *
 * Downloads an image from a URL, downscales it to `maxDimension` on the
 * longest side, and returns it as JPEG base64. The tool-loop routes the image
 * through `resolveImageInjection` — the chat model sees it directly when
 * vision-capable (role "Chat + image"), otherwise a configured image model
 * (role "Image") describes it.
 *
 * Use for character artwork, maps, reference photos, or any image the model
 * should interpret. Has no effect unless a vision-capable chat model or a
 * dedicated image model is configured.
 *
 * Uses Obsidian's `requestUrl` (mobile-compatible, bypasses CORS).
 */
export function createFetchImageUrlTool(maxResultTokens: number, maxDimension: number): Tool {
    return {
        id: 'fetch_image_url',
        description:
            'Download an image from a URL and return it so you can see it. Use for ' +
            'character artwork, maps, reference photos, book covers, or any image ' +
            'you need to interpret. Provide a direct link to the image file. The ' +
            'image is downscaled before delivery.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description:
                        'Full URL including https:// pointing directly at an image file ' +
                        '(e.g., "https://upload.wikimedia.org/wikipedia/en/.../cover.jpg").'
                }
            },
            required: ['url']
        },
        maxResultTokens,
        requiresNetwork: true,

        async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
            const url = typeof args.url === 'string' ? args.url.trim() : '';
            if (!url) return { text: 'Error: "url" is required.' };
            if (!/^https?:\/\//i.test(url)) {
                return { text: 'Error: URL must start with http:// or https://.' };
            }

            // SSRF guard: reject loopback, RFC1918, link-local, and other
            // internal destinations before the request. Same host gate as the
            // fetch_url tool — requestUrl follows redirects internally (and
            // exposes no final URL), so the initial host is the only checkpoint.
            const hostErr = validatePublicHost(url);
            if (hostErr) return { text: hostErr };

            try {
                const response = await requestUrl({
                    url,
                    method: 'GET',
                    throw: false,
                    headers: { Accept: 'image/*' }
                });

                assertNotRateLimited(response);
                if (response.status !== 200) {
                    return { text: `Error: HTTP ${response.status} fetching image "${url}".` };
                }

                const contentType = response.headers['content-type'] ?? '';
                if (!isImageContentType(contentType)) {
                    return {
                        text:
                            `Error: URL did not return an image (content-type "${contentType}"). ` +
                            'Provide a direct link to an image file.'
                    };
                }

                const bytes = response.arrayBuffer;
                const base64 = await downscaleToJpegBase64(bytes, maxDimension, contentType);
                return {
                    text: `Fetched image from ${url} (${contentType}, downscaled to ≤${maxDimension}px).`,
                    images: [base64]
                };
            } catch (err) {
                return { text: toolErrorMessage(err, `fetching image "${url}"`) };
            }
        }
    };
}
