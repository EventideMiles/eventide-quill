import { describe, it, expect } from 'vitest';
import {
    roleSatisfies,
    resolveModel,
    buildUrl,
    ProviderError
} from '../../src/ai/provider';
import type { ModelRole, ModelCapability, ModelConfig } from '../../src/ai/provider';

describe('roleSatisfies', () => {
    const cases: Array<{ role: ModelRole; cap: ModelCapability; expected: boolean }> = [
        // chat capability
        { role: 'chat', cap: 'chat', expected: true },
        { role: 'both', cap: 'chat', expected: true },
        { role: 'chat-image', cap: 'chat', expected: true },
        { role: 'embed', cap: 'chat', expected: false },
        { role: 'image', cap: 'chat', expected: false },
        // embed capability
        { role: 'embed', cap: 'embed', expected: true },
        { role: 'both', cap: 'embed', expected: true },
        { role: 'chat', cap: 'embed', expected: false },
        { role: 'chat-image', cap: 'embed', expected: false },
        { role: 'image', cap: 'embed', expected: false },
        // image capability
        { role: 'image', cap: 'image', expected: true },
        { role: 'chat-image', cap: 'image', expected: true },
        { role: 'chat', cap: 'image', expected: false },
        { role: 'embed', cap: 'image', expected: false },
        { role: 'both', cap: 'image', expected: false }
    ];

    for (const { role, cap, expected } of cases) {
        it(`role "${role}" ${expected ? 'satisfies' : 'does NOT satisfy'} capability "${cap}"`, () => {
            expect(roleSatisfies(role, cap)).toBe(expected);
        });
    }
});

describe('resolveModel', () => {
    const models: ModelConfig[] = [
        { id: 'chat-1', role: 'chat', model: 'llama-3' },
        { id: 'embed-1', role: 'embed', model: 'nomic-embed' },
        { id: 'vision-1', role: 'chat-image', model: 'llava' },
        { id: 'both-1', role: 'both', model: 'qwen-combined' }
    ];

    it('returns the explicitly requested model by id (bypasses capability filter)', () => {
        const found = resolveModel(models, 'chat', 'embed-1', 'test');
        expect(found.id).toBe('embed-1');
    });

    it('throws ProviderError when explicit id is not found', () => {
        expect(() => resolveModel(models, 'chat', 'nonexistent', 'test')).toThrow(ProviderError);
        expect(() => resolveModel(models, 'chat', 'nonexistent', 'test')).toThrow(
            /No model with id "nonexistent"/
        );
    });

    it('returns first matching model by capability when no id given', () => {
        const found = resolveModel(models, 'chat', undefined, 'test');
        expect(found.id).toBe('chat-1');
    });

    it('returns embed model for embed capability', () => {
        const found = resolveModel(models, 'embed', undefined, 'test');
        expect(found.id).toBe('embed-1');
    });

    it('falls back to "both" role for chat capability', () => {
        const chatOnly: ModelConfig[] = [{ id: 'both-1', role: 'both', model: 'qwen' }];
        const found = resolveModel(chatOnly, 'chat', undefined, 'test');
        expect(found.id).toBe('both-1');
    });

    it('falls back to "both" role for embed capability', () => {
        const embedOnly: ModelConfig[] = [{ id: 'both-1', role: 'both', model: 'qwen' }];
        const found = resolveModel(embedOnly, 'embed', undefined, 'test');
        expect(found.id).toBe('both-1');
    });

    it('throws ProviderError when no model satisfies the capability', () => {
        const embedOnly: ModelConfig[] = [{ id: 'embed-1', role: 'embed', model: 'nomic' }];
        expect(() => resolveModel(embedOnly, 'chat', undefined, 'test')).toThrow(ProviderError);
        expect(() => resolveModel(embedOnly, 'chat', undefined, 'test')).toThrow(
            /No chat model configured/
        );
    });

    it('includes the provider name in the error message', () => {
        const empty: ModelConfig[] = [];
        expect(() => resolveModel(empty, 'chat', undefined, 'LM Studio Local')).toThrow(
            /LM Studio Local/
        );
    });
});

describe('buildUrl', () => {
    it('appends a path to a clean endpoint', () => {
        expect(buildUrl('http://localhost:1234', '/v1/chat')).toBe('http://localhost:1234/v1/chat');
    });

    it('strips trailing slashes from the endpoint', () => {
        expect(buildUrl('http://localhost:1234/', '/v1/chat')).toBe('http://localhost:1234/v1/chat');
        expect(buildUrl('http://localhost:1234///', '/v1/chat')).toBe(
            'http://localhost:1234/v1/chat'
        );
    });

    it('adds a leading slash when the path lacks one', () => {
        expect(buildUrl('http://localhost:1234', 'v1/chat')).toBe('http://localhost:1234/v1/chat');
    });

    it('handles both endpoint trailing slash and path without leading slash', () => {
        expect(buildUrl('http://localhost:1234/', 'v1/chat')).toBe('http://localhost:1234/v1/chat');
    });
});

describe('ProviderError', () => {
    it('carries status and body fields', () => {
        const err = new ProviderError('Something failed', 500, 'Internal error');
        expect(err.message).toBe('Something failed');
        expect(err.status).toBe(500);
        expect(err.body).toBe('Internal error');
        expect(err.name).toBe('ProviderError');
    });

    it('is an Error instance', () => {
        expect(new ProviderError('msg', 0, '')).toBeInstanceOf(Error);
    });
});
