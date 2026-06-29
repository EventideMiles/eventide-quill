import type EventideQuillPlugin from '../main';
import type { AiProvider, ChatMessage } from './provider';

/**
 * Default proxy prompt used when the writer hasn't customized
 * `lorebookImageProxyPrompt`. Oriented toward the details a novelist actually
 * needs from reference art.
 */
export const DEFAULT_IMAGE_PROXY_PROMPT =
    'Describe this image for a novelist. Focus on visible details that matter ' +
    'for fiction: character appearance (face, build, age, ethnicity, clothing, ' +
    'distinguishing features), setting, mood, and notable objects. Be concise ' +
    'and concrete; avoid speculation about story or dialogue.';

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
                'You are a visual description assistant for a novelist. ' +
                'Describe images concisely, concretely, and accurately.'
        },
        { role: 'user', content: prompt, images }
    ];

    let caption = '';
    for await (const chunk of provider.chatCompletion({
        model: modelId,
        messages,
        temperature: 0.3,
        maxTokens: 512,
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
