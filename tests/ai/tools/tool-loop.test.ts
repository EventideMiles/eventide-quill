import { describe, it, expect, vi } from 'vitest';
import { streamWithTools } from '../../../src/ai/tools/tool-loop';
import { ToolRegistry, type Tool, type ToolContext } from '../../../src/ai/tools/tool';
import type { AiProvider, ChatChunk, ChatMessage } from '../../../src/ai/provider';

/** Build a mock provider whose chatCompletion plays a scripted sequence of rounds. */
function makeScriptedProvider(rounds: ChatChunk[][]): AiProvider {
    let callIdx = 0;
    return {
        id: 'test',
        name: 'Test',
        config: {} as AiProvider['config'],
        async *chatCompletion(): AsyncGenerator<ChatChunk> {
            const round = rounds[callIdx] ?? [{ text: '', done: true }];
            callIdx++;
            for (const chunk of round) yield chunk;
        },
        async embed() {
            return { embeddings: [], model: 'test' };
        },
        async listModels() {
            return [];
        },
        async testConnection() {
            return { ok: true };
        },
        async testEmbeddings() {
            return { ok: true };
        }
    };
}

function makeTool(id: string, result: string): Tool {
    return {
        id,
        description: `Tool ${id}`,
        parameters: { type: 'object', properties: {} },
        maxResultTokens: 1000,
        requiresNetwork: false,
        execute: async () => result
    };
}

function makeCtx(): ToolContext {
    return { plugin: {} } as unknown as ToolContext;
}

/** Collect all chunks from an async generator into an array. */
async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
}

const BASE_MESSAGES: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What time is it?' }
];

describe('streamWithTools', () => {
    describe('empty-registry passthrough', () => {
        it('yields the provider stream directly when the registry has no tools', async () => {
            const provider = makeScriptedProvider([
                [
                    { text: 'Hello ', done: false },
                    { text: 'world.', done: false },
                    { text: '', done: true, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
                ]
            ]);
            const registry = new ToolRegistry();
            const chunks = await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(chunks).toHaveLength(3);
            expect(chunks[0]!.text).toBe('Hello ');
            expect(chunks[1]!.text).toBe('world.');
            expect(chunks[2]!.done).toBe(true);
            expect(chunks[2]!.usage!.totalTokens).toBe(15);
        });
    });

    describe('no tool calls (single round)', () => {
        it('streams text and terminates after one round', async () => {
            const provider = makeScriptedProvider([
                [{ text: 'It is noon.', done: true }]
            ]);
            const registry = new ToolRegistry();
            registry.register(makeTool('clock', '12:00'));
            const chunks = await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            const texts = chunks.filter((c) => c.text).map((c) => c.text);
            expect(texts.join('')).toBe('It is noon.');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
        });
    });

    describe('single tool round', () => {
        it('accumulates tool-call fragments, executes the tool, then streams the final answer', async () => {
            const toolCallFragments: ChatChunk[] = [
                { text: 'Let me check. ', done: false },
                {
                    text: '',
                    done: false,
                    toolCalls: [
                        { index: 0, id: 'call_1', name: 'clock', arguments: '{"zone":"utc"}' }
                    ]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [
                { text: 'The time is 12:00 UTC.', done: true }
            ];
            const provider = makeScriptedProvider([toolCallFragments, finalAnswer]);

            const registry = new ToolRegistry();
            const clockTool = makeTool('clock', '12:00 UTC');
            const executeSpy = vi.spyOn(clockTool, 'execute');
            registry.register(clockTool);

            const chunks = await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(executeSpy).toHaveBeenCalledWith({ zone: 'utc' }, expect.any(Object));
            const texts = chunks.filter((c) => c.text).map((c) => c.text);
            expect(texts.join('')).toContain('Let me check.');
            expect(texts.join('')).toContain('The time is 12:00 UTC.');
        });

        it('accumulates multi-fragment tool-call arguments', async () => {
            const fragmentedRounds: ChatChunk[] = [
                { text: '', done: false },
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, id: 'call_1', name: 'lookup' }]
                },
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, arguments: '{"q":"hel' }]
                },
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, arguments: 'lo"}' }]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [{ text: 'Found it.', done: true }];
            const provider = makeScriptedProvider([fragmentedRounds, finalAnswer]);

            const registry = new ToolRegistry();
            const lookupTool = makeTool('lookup', 'result');
            const executeSpy = vi.spyOn(lookupTool, 'execute');
            registry.register(lookupTool);

            await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(executeSpy).toHaveBeenCalledWith({ q: 'hello' }, expect.anything());
        });
    });

    describe('multiple tool calls in one round', () => {
        it('executes all calls and collects their results', async () => {
            const roundWithTwoCalls: ChatChunk[] = [
                {
                    text: '',
                    done: false,
                    toolCalls: [
                        { index: 0, id: 'call_a', name: 'lookup', arguments: '{}' },
                        { index: 1, id: 'call_b', name: 'clock', arguments: '{}' }
                    ]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [{ text: 'Done.', done: true }];
            const provider = makeScriptedProvider([roundWithTwoCalls, finalAnswer]);

            const registry = new ToolRegistry();
            const lookupTool = makeTool('lookup', 'found');
            const clockTool = makeTool('clock', '12:00');
            const lookupSpy = vi.spyOn(lookupTool, 'execute');
            const clockSpy = vi.spyOn(clockTool, 'execute');
            registry.register(lookupTool);
            registry.register(clockTool);

            await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(lookupSpy).toHaveBeenCalledOnce();
            expect(clockSpy).toHaveBeenCalledOnce();
        });

        it('sorts tool calls by index before execution', async () => {
            const reversedOrder: ChatChunk[] = [
                {
                    text: '',
                    done: false,
                    toolCalls: [
                        { index: 1, id: 'call_b', name: 'second', arguments: '{}' },
                        { index: 0, id: 'call_a', name: 'first', arguments: '{}' }
                    ]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [{ text: 'Done.', done: true }];
            const provider = makeScriptedProvider([reversedOrder, finalAnswer]);

            const registry = new ToolRegistry();
            const executionOrder: string[] = [];
            registry.register({
                ...makeTool('first', '1'),
                execute: async () => {
                    executionOrder.push('first');
                    return '1';
                }
            });
            registry.register({
                ...makeTool('second', '2'),
                execute: async () => {
                    executionOrder.push('second');
                    return '2';
                }
            });

            await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(executionOrder).toEqual(['first', 'second']);
        });
    });

    describe('forced final pass', () => {
        it('runs one more completion with toolChoice:none after maxRounds', async () => {
            // Each round produces a tool call; the loop should hit the cap and
            // then force one final no-tools completion.
            const toolRound: ChatChunk[] = [
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, id: 'call_1', name: 'clock', arguments: '{}' }]
                },
                { text: '', done: true }
            ];
            const finalRound: ChatChunk[] = [{ text: 'Final answer after tools.', done: true }];

            // 1 tool round + 1 forced final (maxRounds=1) = 2 provider calls
            const provider = makeScriptedProvider([toolRound, finalRound]);

            const registry = new ToolRegistry();
            registry.register(makeTool('clock', '12:00'));

            const chunks = await collect(
                streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx(), 1)
            );
            const texts = chunks.filter((c) => c.text).map((c) => c.text).join('');
            expect(texts).toContain('Final answer after tools.');
            expect(chunks[chunks.length - 1]!.done).toBe(true);
        });
    });

    describe('does not mutate the original messages array', () => {
        it('clones messages before appending tool/assistant turns', async () => {
            const toolRound: ChatChunk[] = [
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, id: 'call_1', name: 'clock', arguments: '{}' }]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [{ text: 'Done.', done: true }];
            const provider = makeScriptedProvider([toolRound, finalAnswer]);

            const registry = new ToolRegistry();
            registry.register(makeTool('clock', '12:00'));

            const originalLength = BASE_MESSAGES.length;
            await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(BASE_MESSAGES.length).toBe(originalLength);
        });
    });

    describe('thought streaming', () => {
        it('passes through thought-only chunks', async () => {
            const provider = makeScriptedProvider([
                [
                    { text: '', thought: 'thinking...', done: false },
                    { text: 'Answer.', done: true }
                ]
            ]);
            const registry = new ToolRegistry();
            registry.register(makeTool('x', 'r'));
            const chunks = await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            const thoughtChunk = chunks.find((c) => c.thought);
            expect(thoughtChunk).toBeDefined();
            expect(thoughtChunk!.thought).toBe('thinking...');
        });
    });

    describe('synthetic tool-call ids', () => {
        it('falls back to call_<index> when the provider gives no id (Ollama)', async () => {
            const noIdRound: ChatChunk[] = [
                {
                    text: '',
                    done: false,
                    toolCalls: [{ index: 0, name: 'clock', arguments: '{}' }]
                },
                { text: '', done: true }
            ];
            const finalAnswer: ChatChunk[] = [{ text: 'Done.', done: true }];
            const provider = makeScriptedProvider([noIdRound, finalAnswer]);

            const registry = new ToolRegistry();
            registry.register(makeTool('clock', '12:00'));

            // The tool executes without error (the synthetic id is used for
            // the tool-result routing, not for the tool itself).
            const chunks = await collect(streamWithTools(provider, { messages: BASE_MESSAGES }, registry, makeCtx()));
            expect(chunks[chunks.length - 1]!.done).toBe(true);
        });
    });
});
