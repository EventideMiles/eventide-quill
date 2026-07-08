import { describe, it, expect } from 'vitest';
import { buildAnthropicRequestBody } from '../../src/ai/anthropic-provider';
import type { ChatMessage, ChatOptions, ProviderConfig, ModelConfig } from '../../src/ai/provider';

/**
 * Wire-format tests for the Anthropic Messages API provider. The request body
 * is built with {@link buildAnthropicRequestBody} (pure function, no HTTP) and
 * compared against fixtures hand-verified against Anthropic's official docs:
 *
 *   https://docs.anthropic.com/en/api/messages
 *   https://docs.anthropic.com/en/api/messages-streaming
 *   https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 *   https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 *
 * Re-validate these fixtures whenever the underlying `anthropic-version` is
 * bumped (currently `2023-06-01`).
 */

const chatModel: ModelConfig = { id: 'sonnet', role: 'chat', model: 'claude-sonnet-4-5' };
const baseConfig: Pick<ProviderConfig, 'models' | 'maxOutputTokens' | 'thinkingBudgetTokens'> = {
    models: [chatModel],
    maxOutputTokens: 4096
};

function build(messages: ChatMessage[], options: Partial<ChatOptions> = {}): Record<string, unknown> {
    const { body } = buildAnthropicRequestBody(
        messages,
        { messages, ...options },
        baseConfig,
        'test'
    );
    return body;
}

/** Type helper for assertions: index into the built body's messages array. */
function messageAt(body: Record<string, unknown>, i: number): {
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
} {
    const messages = body.messages as Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>;
    return messages[i]!;
}

describe('buildAnthropicRequestBody — system hoisting + caching', () => {
    it('hoists a single leading system message into the top-level system param', () => {
        const body = build([
            { role: 'system', content: 'You are a helpful editor.' },
            { role: 'user', content: 'Hello' }
        ]);
        expect(body.system).toEqual([
            {
                type: 'text',
                text: 'You are a helpful editor.',
                cache_control: { type: 'ephemeral' }
            }
        ]);
        // The single text-only user message should compact to a string.
        expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
        // Anthropic requires max_tokens on every request.
        expect(body.max_tokens).toBe(4096);
        expect(body.model).toBe('claude-sonnet-4-5');
        expect(body.stream).toBe(true);
    });

    it('concatenates multiple leading system messages into a system array', () => {
        const body = build([
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: 'Vault context.' },
            { role: 'system', content: 'Tool ads.' },
            { role: 'user', content: 'Hi' }
        ]);
        expect(body.system).toEqual([
            { type: 'text', text: 'Main prompt.' },
            { type: 'text', text: 'Vault context.' },
            { type: 'text', text: 'Tool ads.', cache_control: { type: 'ephemeral' } }
        ]);
    });

    it('omits system param entirely when there are no system messages', () => {
        const body = build([
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hi back' }
        ]);
        expect(body.system).toBeUndefined();
    });

    it('only marks the LAST system block with cache_control (single cache breakpoint)', () => {
        const body = build([
            { role: 'system', content: 'one' },
            { role: 'system', content: 'two' },
            { role: 'user', content: 'q' }
        ]);
        const system = body.system as Array<{ cache_control?: unknown }>;
        expect(system).toHaveLength(2);
        expect(system[0]!.cache_control).toBeUndefined();
        expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    });
});

describe('buildAnthropicRequestBody — message conversion', () => {
    it('compacts single-text user/assistant messages to bare strings', () => {
        const body = build([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' }
        ]);
        expect(body.messages).toEqual([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' }
        ]);
    });

    it('converts role:"tool" to user-role tool_result block', () => {
        const body = build([
            { role: 'user', content: 'search for cats' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: '{"q":"cats"}' }] },
            { role: 'tool', content: '12 results', toolCallId: 'toolu_1', name: 'lookup' }
        ]);
        expect(body.messages).toContainEqual({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12 results' }]
        });
    });

    it('expands assistant tool_calls into tool_use content blocks with parsed input', () => {
        const body = build([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'toolu_1', name: 'search', arguments: '{"q":"cats","n":3}' }]
            }
        ]);
        const assistant = messageAt(body, 1);
        const blocks = assistant.content as Array<Record<string, unknown>>;
        expect(blocks).toContainEqual({
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search',
            input: { q: 'cats', n: 3 }
        });
    });

    it('replays assistant thinkingBlocks before text/tool_use blocks (Anthropic ordering)', () => {
        const body = build([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: 'answer',
                thinkingBlocks: [{ thinking: 'reasoning', signature: 'sig123' }],
                toolCalls: [{ id: 'toolu_1', name: 't', arguments: '{}' }]
            }
        ]);
        const assistant = messageAt(body, 1);
        const blocks = assistant.content as Array<{ type: string }>;
        const types = blocks.map((b) => b.type);
        expect(types).toEqual(['thinking', 'text', 'tool_use']);
    });

    it('serializes images as base64 source blocks (no data: prefix)', () => {
        const body = build([{ role: 'user', content: 'describe this', images: ['BASE64BYTES=='] }]);
        const user = messageAt(body, 0);
        const parts = user.content as Array<Record<string, unknown>>;
        expect(parts).toContainEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64BYTES==' }
        });
    });
});

describe('buildAnthropicRequestBody — temperature + thinking', () => {
    it('clamps temperature to [0, 1] when thinking is disabled', () => {
        const body = build([{ role: 'user', content: 'hi' }], { temperature: 2 });
        expect(body.temperature).toBe(1);
    });

    it('clamps negative temperature to 0', () => {
        const body = build([{ role: 'user', content: 'hi' }], { temperature: -0.5 });
        expect(body.temperature).toBe(0);
    });

    it('forces temperature=1 when thinkingBudgetTokens is set', () => {
        const { body } = buildAnthropicRequestBody(
            [{ role: 'user', content: 'hi' }],
            { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 },
            { models: [chatModel], maxOutputTokens: 4096, thinkingBudgetTokens: 2048 },
            'test'
        );
        expect(body.temperature).toBe(1);
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('clamps max_tokens to budget+1 when default would leave no room for output', () => {
        const { body } = buildAnthropicRequestBody(
            [{ role: 'user', content: 'hi' }],
            { messages: [{ role: 'user', content: 'hi' }] },
            { models: [chatModel], maxOutputTokens: 1024, thinkingBudgetTokens: 4096 },
            'test'
        );
        // budget (4096) >= maxOutputTokens (1024), so max_tokens gets bumped.
        expect(body.max_tokens).toBe(4097);
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    });

    it('keeps max_tokens when it already exceeds budget+1', () => {
        const { body } = buildAnthropicRequestBody(
            [{ role: 'user', content: 'hi' }],
            { messages: [{ role: 'user', content: 'hi' }] },
            { models: [chatModel], maxOutputTokens: 8192, thinkingBudgetTokens: 1024 },
            'test'
        );
        expect(body.max_tokens).toBe(8192);
    });
});

describe('buildAnthropicRequestBody — tools', () => {
    it('serializes tools with input_schema (not parameters)', () => {
        const body = build([{ role: 'user', content: 'q' }], {
            tools: [
                {
                    name: 'lookup',
                    description: 'Look something up',
                    parameters: { type: 'object', properties: { q: { type: 'string' } } }
                }
            ]
        });
        expect(body.tools).toEqual([
            {
                name: 'lookup',
                description: 'Look something up',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } }
            }
        ]);
        expect(body.tool_choice).toEqual({ type: 'auto' });
    });

    it('serializes a forced-call tool_choice as {type:"tool", name}', () => {
        const body = build([{ role: 'user', content: 'q' }], {
            tools: [{ name: 't', description: 'd', parameters: {} }],
            toolChoice: { type: 'function', function: { name: 't' } }
        });
        expect(body.tool_choice).toEqual({ type: 'tool', name: 't' });
    });

    it('omits tools entirely when toolChoice is "none" (Anthropic has no none value)', () => {
        const body = build([{ role: 'user', content: 'q' }], {
            tools: [{ name: 't', description: 'd', parameters: {} }],
            toolChoice: 'none'
        });
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });
});
