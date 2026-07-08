import { describe, it, expect } from 'vitest';
import { buildGeminiContents } from '../../src/ai/gemini-provider';

/**
 * Wire-format tests for the Gemini GenerateContent API provider. The contents
 * payload is built with {@link buildGeminiContents} (pure function, no HTTP)
 * and compared against fixtures hand-verified against Gemini's official docs:
 *
 *   https://ai.google.dev/api/generate-content
 *   https://ai.google.dev/gemini-api/docs/function-calling
 *
 * Re-validate these fixtures whenever the underlying API revision is bumped.
 */

describe('buildGeminiContents — system instruction + roles', () => {
    it('hoists leading system messages into systemInstruction', () => {
        const result = buildGeminiContents([
            { role: 'system', content: 'You are a helpful editor.' },
            { role: 'user', content: 'Hi' }
        ]);
        expect(result.systemInstruction).toEqual({ parts: [{ text: 'You are a helpful editor.' }] });
        expect(result.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hi' }] }
        ]);
    });

    it('concatenates multiple leading system messages into one systemInstruction', () => {
        const result = buildGeminiContents([
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: 'Vault context.' },
            { role: 'user', content: 'Hi' }
        ]);
        expect(result.systemInstruction).toEqual({
            parts: [{ text: 'Main prompt.' }, { text: 'Vault context.' }]
        });
    });

    it('omits systemInstruction when there are no system messages', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hi back' }
        ]);
        expect(result.systemInstruction).toBeUndefined();
    });

    it('converts assistant role to "model" (Gemini has no assistant role)', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' }
        ]);
        expect(result.contents[1]!.role).toBe('model');
    });
});

describe('buildGeminiContents — tool conversion', () => {
    it('converts assistant toolCalls into functionCall parts with parsed args', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call_1', name: 'search', arguments: '{"q":"cats","n":3}' }]
            }
        ]);
        const assistant = result.contents[1]!;
        expect(assistant.role).toBe('model');
        expect(assistant.parts).toContainEqual({
            functionCall: { name: 'search', args: { q: 'cats', n: 3 } }
        });
    });

    it('converts role:"tool" into a user turn with functionResponse part', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call_1', name: 'search', arguments: '{}' }]
            },
            { role: 'tool', content: '{"count":12}', toolCallId: 'call_1', name: 'search' }
        ]);
        // The tool result is the LAST content entry — a user-role turn.
        const toolTurn = result.contents[result.contents.length - 1]!;
        expect(toolTurn.role).toBe('user');
        expect(toolTurn.parts).toContainEqual({
            functionResponse: { name: 'search', response: { count: 12 } }
        });
    });

    it('consolidates consecutive tool results into one user turn with multiple functionResponse parts', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call_1', name: 'first', arguments: '{}' },
                    { id: 'call_2', name: 'second', arguments: '{}' }
                ]
            },
            { role: 'tool', content: '{"r":1}', toolCallId: 'call_1', name: 'first' },
            { role: 'tool', content: '{"r":2}', toolCallId: 'call_2', name: 'second' }
        ]);
        // Last turn should be ONE user message with two parts, not two user messages.
        const lastTurn = result.contents[result.contents.length - 1]!;
        expect(lastTurn.role).toBe('user');
        expect(lastTurn.parts).toHaveLength(2);
        expect(lastTurn.parts.every((p) => 'functionResponse' in p)).toBe(true);
    });

    it('wraps non-JSON tool content under a "result" key', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'q' },
            { role: 'tool', content: 'free-form text', toolCallId: 'c1', name: 't' }
        ]);
        const toolTurn = result.contents[result.contents.length - 1]!;
        expect(toolTurn.parts).toContainEqual({
            functionResponse: { name: 't', response: { result: 'free-form text' } }
        });
    });
});

describe('buildGeminiContents — images', () => {
    it('attaches images as inlineData parts alongside the text', () => {
        const result = buildGeminiContents([
            { role: 'user', content: 'describe this', images: ['BASE64BYTES=='] }
        ]);
        const user = result.contents[0]!;
        expect(user.parts).toContainEqual({
            inlineData: { mimeType: 'image/jpeg', data: 'BASE64BYTES==' }
        });
    });
});

describe('buildGeminiContents — defensive cases', () => {
    it('emits an empty text part for an empty user message (Gemini rejects empty parts arrays)', () => {
        const result = buildGeminiContents([{ role: 'user', content: '' }]);
        const user = result.contents[0]!;
        expect(user.parts).toEqual([{ text: '' }]);
    });
});
