import { describe, it, expect } from 'vitest';
import {
    parseProviderKey,
    generateModelId,
    generateProviderId,
    getModel
} from '../../src/ai/provider-registry';
import type { ProviderConfig } from '../../src/ai/provider';

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
