import type EventideQuillPlugin from '../main';
import type { AiProvider, ChatMessage } from './provider';

/**
 * Default proxy prompt used when the writer hasn't customized
 * `lorebookImageProxyPrompt`. Oriented toward the details a novelist actually
 * needs from reference art. Structured for weak vision models — the numbered
 * per-character list gives the model scaffolding so it doesn't stop after the
 * first face in a group image.
 */
export const DEFAULT_IMAGE_PROXY_PROMPT =
    'Describe this image in detail for a novelist. This description is the only ' +
    'information the writing assistant will have about the image, so be thorough, ' +
    'not brief.\n\n' +
    'If MULTIPLE characters are visible, describe EACH one separately using a ' +
    'numbered list (1, 2, 3, ...). For every character, cover:\n' +
    '- Face: apparent age, ethnicity, hair (color, style, length), eye color, facial features\n' +
    '- Build: height relative to others in the scene, body type, posture\n' +
    '- Clothing: each visible garment, colors, style, condition\n' +
    '- Distinguishing features: scars, tattoos, jewelry, accessories, weapons\n' +
    'Also describe the setting (location, time of day, lighting, weather), the ' +
    'mood or atmosphere, and any notable objects (books, maps, artifacts, tools).\n\n' +
    'Stick to what is visible — do not speculate about story, dialogue, or ' +
    'off-screen elements.';

/** How an image should enter a conversation on a given provider. */
export type ImageInjection =
    | { kind: 'native'; images: string[] }
    | { kind: 'described'; text: string }
    | { kind: 'unsupported'; reason: string };

export interface ImageInjectionOptions {
    /** The writer's framing (e.g. their chat message) so captions stay relevant. */
    intent?: string;
    /** Override the configured `lorebookImageProxyPrompt`; falls back to the setting. */
    proxyPrompt?: string;
    /** Abort signal for the proxy caption call. */
    signal?: AbortSignal;
}

/**
 * Synchronous check for whether any vision regime is available. Delegates to
 * {@link getImageRegime}; returns `true` for any regime other than `'none'`.
 * Use for UI guards (e.g. showing a Notice at capture time) without kicking
 * off an async proxy call.
 */
export function isVisionConfigured(plugin: EventideQuillPlugin): boolean {
    return getImageRegime(plugin) !== 'none';
}

/**
 * Synchronously determine which vision regime applies on the current provider
 * configuration, without making any API calls:
 *
 * - `'native'` — the default chat model has role `chat-image` (Regime A).
 *   Images attach directly to the user message; the model sees pixels.
 * - `'proxy'` — the chat model is text-only but a default image model is
 *   configured (Regime B). The image model will make one isolated caption call;
 *   the chat model never receives pixels.
 * - `'none'` — neither regime is available. Callers should surface a Notice
 *   and inject a placeholder rather than silently dropping the image.
 *
 * Use this to decide whether to show a "describing image…" indicator (only
 * relevant under `'proxy'`) or to warn at capture time (when `'none'`). The
 * authoritative routing still happens in {@link resolveImageInjection}.
 */
export function getImageRegime(plugin: EventideQuillPlugin): 'native' | 'proxy' | 'none' {
    const chat = plugin.getDefaultChatProvider();
    if (chat.provider && chat.modelId) {
        const chatModel = chat.provider.config.models.find((m) => m.id === chat.modelId);
        if (chatModel && chatModel.role === 'chat-image') return 'native';
    }
    const image = plugin.getDefaultImageProvider();
    return image.provider && image.modelId ? 'proxy' : 'none';
}

/**
 * Decide how an image (or set of images) should enter a conversation.
 *
 * - **Regime A** (vision-native): the configured default chat model has role
 *   `chat-image`, so return `native` and let the caller attach the images as
 *   image content. The model sees pixels directly.
 * - **Regime B** (vision-proxy): the chat model is text-only and a default
 *   image model is configured. Call that model as a stateless translator and
 *   return `described` with the caption text. The text chat model only ever
 *   sees text.
 *
 * The image model may live on a **different provider** than chat: the proxy
 * call is fully isolated (image + prompt → text), so it shares no state with
 * the chat conversation. This lets a writer run a small local text model for
 * chat alongside a cloud (or larger local) vision model for images.
 *
 * Routing never branches mid-conversation — in Regime B the text model never
 * switches and the image model is a short bounded one-shot, which keeps
 * single-model-local setups workable.
 *
 * Throws {@link ProviderError} (or {@link HttpError}) if the proxy call itself
 * fails; callers should catch and inject a placeholder so the conversation is
 * not blocked.
 */
export async function resolveImageInjection(
    plugin: EventideQuillPlugin,
    images: string[],
    opts: ImageInjectionOptions = {}
): Promise<ImageInjection> {
    if (images.length === 0) return { kind: 'native', images: [] };

    // Regime A — the configured chat model is itself vision-capable, so
    // images flow straight into the conversation as image content.
    const chat = plugin.getDefaultChatProvider();
    if (chat.provider && chat.modelId) {
        const chatModel = chat.provider.config.models.find((m) => m.id === chat.modelId);
        if (chatModel && chatModel.role === 'chat-image') {
            return { kind: 'native', images };
        }
    }

    // Regime B — route to the configured default image model (possibly on a
    // different provider). The proxy call is self-contained.
    const image = plugin.getDefaultImageProvider();
    if (!image.provider || !image.modelId) {
        return {
            kind: 'unsupported',
            reason:
                'No image model configured. Set a vision-capable chat model (role "Chat + image") ' +
                'or pick a default image model in settings.'
        };
    }

    const caption = await captionWithModel(plugin, image.provider, image.modelId, images, opts);
    return { kind: 'described', text: caption };
}

/**
 * Route images collected from tool output (or any source) into a conversation
 * array using the two vision regimes from {@link resolveImageInjection}:
 *
 * - **Native** (chat model is vision-capable): attach the images as image
 *   content on a new user message.
 * - **Described** (chat model text-only + image model configured): splice in
 *   the proxy caption text.
 * - **Unsupported**: inject a placeholder note so the model knows an image
 *   came back but couldn't be interpreted.
 *
 * Never throws — on proxy-call failure a placeholder is injected instead, so
 * the caller's tool loop keeps going. No-op when `images` is empty. This is
 * the single image-injection path shared by the co-writer tool loops and
 * `streamWithTools`; keep behavior here authoritative.
 */
export async function injectImagesIntoMessages(
    plugin: EventideQuillPlugin,
    images: string[],
    messages: ChatMessage[],
    signal?: AbortSignal
): Promise<void> {
    if (images.length === 0) return;
    try {
        const injection = await resolveImageInjection(plugin, images, { signal });
        if (injection.kind === 'native') {
            messages.push({
                role: 'user',
                content: '[Attached image(s) from tool output]',
                images: injection.images
            });
        } else if (injection.kind === 'described') {
            messages.push({
                role: 'user',
                content: `[Image description from the vision model]: ${injection.text}`
            });
        } else {
            messages.push({
                role: 'user',
                content: `[An image was returned but cannot be interpreted: ${injection.reason}]`
            });
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        messages.push({ role: 'user', content: `[Image could not be described: ${msg}]` });
    }
}

/** Shape returned by {@link prepareUserMessageWithImages}: the fields a caller needs to push a user {@link ChatMessage}. */
export interface PreparedUserMessage {
    content: string;
    /** Present only under Regime A (vision-native chat model). */
    images?: string[];
}

/**
 * Apply the two vision regimes to the writer's OWN chat message (paste, drop,
 * attach). Returns the `content` (and, under Regime A, the `images`) the caller
 * should use when pushing the user {@link ChatMessage}.
 *
 * - **Native** (vision-capable chat model): return the original text plus the
 *   images; the provider serializes the pixels onto the user message.
 * - **Described** (text-only chat + image model configured): run the proxy
 *   caption call once and fold the caption into the text. The chat model never
 *   switches models or receives pixels.
 * - **Unsupported**: append a placeholder note so the model knows an image was
 *   attached but couldn't be interpreted, instead of silently dropping it.
 *
 * The analogue of {@link injectImagesIntoMessages} for the user's own message
 * rather than tool output. The two helpers are deliberately kept separate:
 * tool output is a synthetic side-message with its own framing; paste is the
 * writer's primary message and its text must be preserved verbatim. Never
 * throws — failures become a placeholder appended to the text.
 *
 * @param text   The writer's message text (kept verbatim in every regime).
 * @param images Base64 JPEG strings (no `data:` prefix). Empty → no-op.
 * @param signal Abort signal; passed through to the Regime B proxy call.
 */
export async function prepareUserMessageWithImages(
    plugin: EventideQuillPlugin,
    text: string,
    images: string[],
    signal?: AbortSignal
): Promise<PreparedUserMessage> {
    if (images.length === 0) return { content: text };
    try {
        const injection = await resolveImageInjection(plugin, images, { intent: text, signal });
        if (injection.kind === 'native') {
            return { content: text, images: injection.images };
        }
        if (injection.kind === 'described') {
            return { content: `${text}\n\n[Image description from the vision model]: ${injection.text}` };
        }
        return { content: `${text}\n\n[An image was attached but cannot be interpreted: ${injection.reason}]` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `${text}\n\n[Image could not be described: ${msg}]` };
    }
}

/**
 * Call the image model with a caption request and return its text. Throws on
 * failure so callers can surface a Notice and inject a placeholder.
 */
async function captionWithModel(
    plugin: EventideQuillPlugin,
    provider: AiProvider,
    modelId: string,
    images: string[],
    opts: ImageInjectionOptions
): Promise<string> {
    const prompt = buildProxyPrompt(opts.intent, opts.proxyPrompt ?? plugin.settings.lorebookImageProxyPrompt);
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'You are a visual description assistant for a novelist. Describe images ' +
                'thoroughly, covering every visible character and detail. Use numbered lists ' +
                'for multiple characters. Be concrete and accurate — never speculate; describe ' +
                'only what is visible.'
        },
        { role: 'user', content: prompt, images }
    ];

    let caption = '';
    for await (const chunk of provider.chatCompletion({
        model: modelId,
        messages,
        temperature: 0.3,
        maxTokens: 1024,
        signal: opts.signal
    })) {
        if (chunk.text) caption += chunk.text;
    }

    const trimmed = caption.trim();
    return trimmed.length > 0 ? trimmed : '(no description produced)';
}

/** Assemble the proxy prompt, folding in the writer's intent when present. */
function buildProxyPrompt(intent: string | undefined, base: string | undefined): string {
    const b = base && base.trim().length > 0 ? base.trim() : DEFAULT_IMAGE_PROXY_PROMPT;
    if (intent && intent.trim().length > 0) {
        return `${b}\n\nThe writer's framing (describe with this in mind): ${intent.trim()}`;
    }
    return b;
}
