import { describe, it, expect } from 'vitest';
import {
    parseProviderKey,
    generateModelId,
    generateProviderId,
    getModel,
    createProvider
} from '../../src/ai/provider-registry';
import type { ProviderConfig } from '../../src/ai/provider';
import { OpenAiCompatibleProvider } from '../../src/ai/openai-provider';
import { OllamaProvider } from '../../src/ai/ollama-provider';
import { AnthropicProvider } from '../../src/ai/anthropic-provider';
import { GeminiProvider } from '../../src/ai/gemini-provider';

function makeProviders(): ProviderConfig[] {
    return [
        {
            id: 'lm-studio',
            name: 'LM Studio Local',
            type: 'openai-compatible',
            endpoint: 'http://localhost:1234/v1',
            apiKey: '',
            models: [
                { id: 'llama-3-chat', role: 'chat', model: 'llama-3.3-70b' },
                { id: 'nomic-embed', role: 'embed', model: 'nomic-embed-text' }
            ],
            maxContextTokens: 32768,
            maxOutputTokens: 4096
        },
        {
            id: 'ollama-local',
            name: 'Ollama',
            type: 'ollama',
            endpoint: 'http://localhost:11434',
            apiKey: '',
            models: [{ id: 'mistral-chat', role: 'chat', model: 'mistral' }],
            maxContextTokens: 32768,
            maxOutputTokens: 4096
        },
        {
            id: 'anthropic-cloud',
            name: 'Anthropic',
            type: 'anthropic',
            endpoint: 'https://api.anthropic.com/v1',
            apiKey: 'sk-ant-test',
            models: [{ id: 'sonnet-chat', role: 'chat', model: 'claude-sonnet-4-5' }],
            maxContextTokens: 200000,
            maxOutputTokens: 4096
        },
        {
            id: 'gemini-cloud',
            name: 'Gemini',
            type: 'gemini',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'AIzaSy-test',
            models: [
                { id: 'flash-chat', role: 'chat', model: 'gemini-2.0-flash' },
                { id: 'text-embed', role: 'embed', model: 'text-embedding-004' }
            ],
            maxContextTokens: 1000000,
            maxOutputTokens: 8192
        }
    ];
}

describe('parseProviderKey', () => {
    it('parses a valid "providerId/modelId" key', () => {
        const result = parseProviderKey('lm-studio/llama-3-chat');
        expect(result).toEqual({ providerId: 'lm-studio', modelId: 'llama-3-chat' });
    });

    it('returns null for empty string', () => {
        expect(parseProviderKey('')).toBeNull();
    });

    it('returns null when missing slash separator', () => {
        expect(parseProviderKey('just-an-id')).toBeNull();
    });

    it('returns null when provider side is empty', () => {
        expect(parseProviderKey('/model-id')).toBeNull();
    });

    it('returns null when model side is empty', () => {
        expect(parseProviderKey('provider-id/')).toBeNull();
    });

    it('truncates keys with extra slashes (split limit 2 drops remainder)', () => {
        // JavaScript's String.split('/', 2) truncates the result array — it does
        // NOT join the remainder into the last element (unlike Python). So
        // 'provider/model/path' yields ['provider', 'model'], dropping 'path'.
        const result = parseProviderKey('provider/model/path');
        expect(result).toEqual({ providerId: 'provider', modelId: 'model' });
    });
});

describe('generateModelId', () => {
    it('generates a slug-model-role id', () => {
        expect(generateModelId('Llama 3.3 70B', 'chat')).toBe('llama-3-3-70b-chat');
    });

    it('lowercases and hyphenates', () => {
        expect(generateModelId('GPT-4 Turbo', 'chat')).toBe('gpt-4-turbo-chat');
    });

    it('appends the role', () => {
        expect(generateModelId('nomic embed', 'embed')).toBe('nomic-embed-embed');
        expect(generateModelId('llava', 'chat-image')).toBe('llava-chat-image');
    });

    it('handles special characters', () => {
        expect(generateModelId('model (v2.0)', 'chat')).toBe('model-v2-0-chat');
    });
});

describe('generateProviderId', () => {
    it('generates a slug-based id with random suffix', () => {
        const id = generateProviderId('LM Studio Local');
        expect(id).toMatch(/^lm-studio-local-[a-z0-9]{4}$/);
    });

    it('generates different ids on successive calls (random suffix)', () => {
        const id1 = generateProviderId('Test');
        const id2 = generateProviderId('Test');
        expect(id1).not.toBe(id2);
    });
});

describe('getModel', () => {
    it('finds a model by provider + model id', () => {
        const model = getModel(makeProviders(), 'lm-studio', 'llama-3-chat');
        expect(model).not.toBeNull();
        expect(model!.model).toBe('llama-3.3-70b');
    });

    it('returns null for a non-existent provider', () => {
        expect(getModel(makeProviders(), 'nonexistent', 'any')).toBeNull();
    });

    it('returns null for a non-existent model', () => {
        expect(getModel(makeProviders(), 'lm-studio', 'nonexistent')).toBeNull();
    });
});

describe('createProvider — exhaustive dispatch on type', () => {
    // The exhaustive `switch (config.type)` in createProvider means a future
    // addition to the ProviderType union without a matching case breaks
    // compilation. These tests assert the runtime mapping for each type,
    // including the new anthropic + gemini native providers.

    it('instantiates OpenAiCompatibleProvider for "openai-compatible"', () => {
        const provider = createProvider(makeProviders()[0]!);
        expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    });

    it('instantiates OllamaProvider for "ollama"', () => {
        const provider = createProvider(makeProviders()[1]!);
        expect(provider).toBeInstanceOf(OllamaProvider);
    });

    it('instantiates AnthropicProvider for "anthropic"', () => {
        const provider = createProvider(makeProviders()[2]!);
        expect(provider).toBeInstanceOf(AnthropicProvider);
        expect(provider.id).toBe('anthropic-cloud');
        expect(provider.name).toBe('Anthropic');
    });

    it('instantiates GeminiProvider for "gemini"', () => {
        const provider = createProvider(makeProviders()[3]!);
        expect(provider).toBeInstanceOf(GeminiProvider);
        expect(provider.id).toBe('gemini-cloud');
        expect(provider.name).toBe('Gemini');
    });
});
