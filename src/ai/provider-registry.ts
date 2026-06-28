import { AiProvider, ModelConfig, ModelRole, ProviderConfig } from './provider';
import { OpenAiCompatibleProvider } from './openai-provider';
import { OllamaProvider } from './ollama-provider';

/**
 * Create an AiProvider instance from a ProviderConfig.
 * The `type` field determines which concrete provider class is used.
 */
export function createProvider(config: ProviderConfig): AiProvider {
    switch (config.type) {
        case 'openai-compatible':
            return new OpenAiCompatibleProvider(config);
        case 'ollama':
            return new OllamaProvider(config);
        default: {
            // Exhaustive check — if a new type is added without updating this switch,
            // TypeScript will error here.
            const _exhaustive: never = config.type;
            throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
        }
    }
}

/**
 * Look up a provider by ID from the given config list and instantiate it.
 * Returns null if no provider config with that ID exists.
 */
export function getProvider(providers: ProviderConfig[], providerId: string): AiProvider | null {
    const config = providers.find((p) => p.id === providerId);
    if (!config) return null;
    return createProvider(config);
}

/**
 * Resolve a ModelConfig from a specific provider using a composite key of the
 * format `"providerId/modelId"`. Returns null if either the provider or the
 * model is not found.
 */
export function getModel(providers: ProviderConfig[], providerId: string, modelId: string): ModelConfig | null {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return null;
    return provider.models.find((m) => m.id === modelId) ?? null;
}

/**
 * Parse a composite provider key of the format `"providerId/modelId"`.
 * Returns `{ providerId, modelId }` or null if the format is invalid.
 */
export function parseProviderKey(key: string): { providerId: string; modelId: string } | null {
    const parts = key.split('/', 2);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { providerId: parts[0], modelId: parts[1] };
}

/**
 * Normalize a string into a URL-friendly slug.
 * Lowercases and replaces non-alphanumeric runs with a single hyphen.
 */
function generateSlug(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Generate a provider ID from a display name.
 * Lowercases, replaces non-alphanumeric characters, and appends a short random
 * suffix to minimise collision risk.
 */
export function generateProviderId(name: string): string {
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${generateSlug(name)}-${suffix}`;
}

/**
 * Generate a model ID from a model string and role.
 */
export function generateModelId(model: string, role: ModelRole): string {
    return `${generateSlug(model)}-${role}`;
}
