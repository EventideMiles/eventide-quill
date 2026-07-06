import type EventideQuillPlugin from '../main';
import type { AiProvider, ChatMessage } from './provider';

/**
 * Default proxy prompt used when the writer hasn't customized
 * `lorebookImageProxyPrompt`. Structured for weak vision models: the numbered
 * per-character list gives the model scaffolding so it covers every face in a
 * group image, while the grounding instructions keep it from inventing details
 * it can't actually see (a common failure mode for smaller models like
 * Gemma-4-a4b when the token budget is generous).
 */
export const DEFAULT_IMAGE_PROXY_PROMPT =
    'Describe what you see in this image for a novelist. Your description will ' +
    "be the writer's only source of visual information, so every detail should " +
    'be something you can actually observe in the image.\n\n' +
    'For EACH visible character (numbered list if multiple), report what you can ' +
    'clearly identify:\n' +
    '- Hair: color, style, length\n' +
    '- Face: apparent age, ethnicity, features\n' +
    '- Build: body type, height relative to others\n' +
    '- Clothing: each garment, its color and style\n' +
    '- Distinguishing features: jewelry, scars, tattoos, accessories, weapons\n' +
    'Then briefly note the setting (location, lighting, time of day) and any ' +
    'notable objects.\n\n' +
    'Every detail you write should be grounded in something visible in the image. ' +
    'If a detail is too small, distant, or unclear to identify with confidence, ' +
    'leave it out. Stop as soon as you have covered everything you can see.';

/**
 * Pass-1 prompt for two-pass image description: count + briefly label each
 * visible character across the batch before the descriptive pass. Used only
 * when `lorebookImageTwoPassDescription` is on AND there is more than one
 * image — weak vision models lose track of which character is which across a
 * group, so grounding pass 2 in pass 1's enumerated list keeps the per-
 * character descriptions coherent.
 */
const TWO_PASS_COUNT_PROMPT =
    'Look at these images together. How many distinct characters (people) are ' +
    'visible across all of them? Reply with ONLY a numbered list — one line per ' +
    'character — giving each a short label (a name if you can identify them, ' +
    'otherwise a distinguishing phrase like "tall woman in red"). Note which ' +
    'image each appears in when relevant. Do not describe them yet — the next ' +
    'step does that.';

/** Token budget reserved for the pass-1 count when two-pass is on (small slice). */
const TWO_PASS_COUNT_BUDGET = 256;

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

    // Delegate regime detection to {@link getImageRegime} so UI guards and
    // injection routing always agree on what "native", "proxy", and "none"
    // mean — the detection logic lives in one place.
    const regime = getImageRegime(plugin);

    // Regime A — images flow straight into the conversation as image content.
    if (regime === 'native') return { kind: 'native', images };

    if (regime === 'none') {
        return {
            kind: 'unsupported',
            reason:
                'No image model configured. Set a vision-capable chat model (role "Chat + image") ' +
                'or pick a default image model in settings.'
        };
    }

    // Regime B — route to the configured default image model (possibly on a
    // different provider). The proxy call is self-contained.
    const image = plugin.getDefaultImageProvider();
    const caption = await captionWithModel(plugin, image.provider!, image.modelId!, images, opts);
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
 *
 * Two-pass mode (when `lorebookImageTwoPassDescription` is on AND more than one
 * image is attached): a first cheap call counts + labels each visible
 * character across the batch, then the descriptive call folds that list in as
 * grounding. Helps weak vision models keep per-character descriptions coherent
 * across a group. Single images skip the count pass (nothing to enumerate
 * relative to). The budget is split: pass 1 gets a small fixed slice
 * (`TWO_PASS_COUNT_BUDGET`), pass 2 gets the remainder so the total stays
 * within the writer's configured `lorebookImageMaxDescriptionTokens`.
 */
async function captionWithModel(
    plugin: EventideQuillPlugin,
    provider: AiProvider,
    modelId: string,
    images: string[],
    opts: ImageInjectionOptions
): Promise<string> {
    const twoPass = plugin.settings.lorebookImageTwoPassDescription && images.length > 1;

    const totalBudget = plugin.settings.lorebookImageMaxDescriptionTokens;
    // Split the configured budget between the count pass and the descriptive
    // pass so two-pass never silently exceeds the writer's cap. Pass 1 gets up
    // to TWO_PASS_COUNT_BUDGET; pass 2 gets the remainder, floored at 64 so a
    // tiny total doesn't starve the descriptive call. countBudget is derived
    // from descriptionMaxTokens (not independently) so the two always sum to
    // totalBudget or less.
    const descriptionMaxTokens = twoPass ? Math.max(64, totalBudget - TWO_PASS_COUNT_BUDGET) : totalBudget;
    const countBudget = twoPass ? Math.max(0, totalBudget - descriptionMaxTokens) : 0;

    let pass1Result: string | undefined;

    if (twoPass) {
        pass1Result = await countVisibleCharacters(provider, modelId, images, opts, countBudget);
    }

    const prompt = buildProxyPrompt(
        opts.intent,
        opts.proxyPrompt ?? plugin.settings.lorebookImageProxyPrompt,
        pass1Result
    );
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'You are a precise visual description assistant for a novelist. Report exactly ' +
                'what is visible in each image. Be specific and concrete — name colors, garment ' +
                'types, facial features. Include only details you can clearly identify. A short, ' +
                'accurate description is more valuable than a long one with guesses. Stop when ' +
                'you have covered everything visible.'
        },
        { role: 'user', content: prompt, images }
    ];

    let caption = '';
    for await (const chunk of provider.chatCompletion({
        model: modelId,
        messages,
        temperature: 0.3,
        maxTokens: descriptionMaxTokens,
        signal: opts.signal
    })) {
        if (chunk.text) caption += chunk.text;
    }

    const trimmed = caption.trim();
    return trimmed.length > 0 ? trimmed : '(no description produced)';
}

/**
 * Pass 1 of two-pass image description: a cheap, low-temperature call that
 * counts + labels each visible character across the image batch. Returns the
 * raw text (a numbered list), or an empty string if the model produced
 * nothing (pass 2 then proceeds without grounding, identical to single-pass).
 *
 * @param countBudget  Token budget for the count, derived from the same split
 *                     as the descriptive pass in {@link captionWithModel} so
 *                     the two together stay within the configured cap.
 */
async function countVisibleCharacters(
    provider: AiProvider,
    modelId: string,
    images: string[],
    opts: ImageInjectionOptions,
    countBudget: number
): Promise<string> {
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content:
                'You count and label visible characters in images for a novelist. Reply with ' +
                'ONLY a numbered list — no prose, no description. Keep each line short.'
        },
        { role: 'user', content: TWO_PASS_COUNT_PROMPT, images }
    ];
    let out = '';
    for await (const chunk of provider.chatCompletion({
        model: modelId,
        messages,
        temperature: 0,
        maxTokens: countBudget,
        signal: opts.signal
    })) {
        if (chunk.text) out += chunk.text;
    }
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : '';
}

/**
 * Assemble the proxy prompt, folding in the writer's intent and (for two-pass
 * mode) the pass-1 character count so the descriptive pass grounds each
 * character against the enumerated list.
 */
function buildProxyPrompt(intent: string | undefined, base: string | undefined, pass1Result?: string): string {
    const b = base && base.trim().length > 0 ? base.trim() : DEFAULT_IMAGE_PROXY_PROMPT;
    let prompt = b;
    if (pass1Result && pass1Result.trim().length > 0) {
        prompt +=
            `\n\nYou previously identified these visible characters across the images:\n${pass1Result.trim()}\n` +
            'Describe each one in detail using that same numbering, grounded in what you can ' +
            'actually see. Keep each character tied to its label so the writer can tell them apart.';
    }
    if (intent && intent.trim().length > 0) {
        prompt += `\n\nThe writer's framing (describe with this in mind): ${intent.trim()}`;
    }
    return prompt;
}
