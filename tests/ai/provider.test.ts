import { describe, it, expect } from 'vitest';
import {
    mergeExtraRequestBody,
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

describe('mergeExtraRequestBody', () => {
    it('parses and merges a valid JSON object into the body', () => {
        const body: Record<string, unknown> = { model: 'x', temperature: 0.7 };
        mergeExtraRequestBody(body, '{"reasoning_effort":"high","thinking":{"type":"enabled"}}');
        expect(body).toEqual({
            model: 'x',
            temperature: 0.7,
            reasoning_effort: 'high',
            thinking: { type: 'enabled' }
        });
    });

    it('strips reserved identity keys (model, messages, stream)', () => {
        const body: Record<string, unknown> = { model: 'real', messages: [], stream: true };
        mergeExtraRequestBody(
            body,
            '{"model":"override","messages":[{"role":"user"}],"stream":false,"reasoning_effort":"low"}'
        );
        expect(body.model).toBe('real');
        expect(body.messages).toEqual([]);
        expect(body.stream).toBe(true);
        expect(body).toHaveProperty('reasoning_effort', 'low');
    });

    it('is a no-op on malformed JSON (saved as-is by the UI, never applied)', () => {
        const body: Record<string, unknown> = { model: 'x' };
        mergeExtraRequestBody(body, '{"reasoning_effort":'); // truncated / missing brace
        mergeExtraRequestBody(body, '{bad, commas,,}'); // bad commas + unquoted keys
        mergeExtraRequestBody(body, '{"a": 1} trailing'); // trailing junk
        expect(body).toEqual({ model: 'x' });
    });

    it('is a no-op when the parsed value is not an object', () => {
        const body: Record<string, unknown> = { model: 'x' };
        mergeExtraRequestBody(body, '[1, 2, 3]');
        mergeExtraRequestBody(body, '5');
        mergeExtraRequestBody(body, '"a string"');
        expect(body).toEqual({ model: 'x' });
    });

    it('is a no-op on undefined / empty / whitespace-only input', () => {
        const body: Record<string, unknown> = { model: 'x' };
        mergeExtraRequestBody(body, undefined);
        mergeExtraRequestBody(body, '');
        mergeExtraRequestBody(body, '   ');
        expect(body).toEqual({ model: 'x' });
    });

    it('overwrites existing non-reserved keys (shallow merge, last wins)', () => {
        const body: Record<string, unknown> = { temperature: 0.7, top_p: 0.9 };
        mergeExtraRequestBody(body, '{"temperature":0.5}');
        expect(body.temperature).toBe(0.5);
        expect(body.top_p).toBe(0.9);
    });
});
