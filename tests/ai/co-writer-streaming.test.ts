import { describe, it, expect } from 'vitest';
import { streamToolAwareRound } from '../../src/ai/co-writer-streaming';
import type { AiProvider, ChatChunk, ChatMessage } from '../../src/ai/provider';

/**
 * Build a mock AiProvider whose chatCompletion yields a scripted chunk list per
 * sequential call, recording the messages it was passed so continuation tests
 * can assert on the resume payload.
 */
function mockProvider(rounds: ChatChunk[][]): { provider: AiProvider; calls: ChatMessage[][] } {
    let call = 0;
    const calls: ChatMessage[][] = [];
    const provider = {
        chatCompletion: (opts: { messages: ChatMessage[] }) => {
            calls.push(opts.messages);
            return (async function* generator(): AsyncGenerator<ChatChunk> {
                const chunks = rounds[call++] ?? [];
                for (const c of chunks) yield c;
            })();
        }
    };
    return { provider: provider as unknown as AiProvider, calls };
}

const noCallbacks = { onChunk: () => {}, onThoughtChange: () => {}, onClear: () => {} };

describe('streamToolAwareRound — auto-continue on max_tokens truncation', () => {
    it('continues and splices text when a round ends with finish_reason "length"', async () => {
        // Real OpenAI-compat streams put text in non-done chunks; the terminal
        // chunk carries only the finish reason (empty content).
        const { provider, calls } = mockProvider([
            [{ text: 'The harbour was ' }, { text: 'quiet' }, { done: true, finishReason: 'length' }],
            [{ text: 'at dawn.' }, { done: true, finishReason: 'stop' }]
        ]);
        const chunks: string[] = [];
        const result = await streamToolAwareRound(
            provider,
            { messages: [{ role: 'user', content: 'go' }] },
            { ...noCallbacks, onChunk: (t) => chunks.push(t) }
        );

        expect(result.response).toBe('The harbour was quietat dawn.');
        expect(result.finishReason).toBe('stop');
        // The continuation streamed through onChunk into the same bubble.
        expect(chunks.join('')).toBe('The harbour was quietat dawn.');
        // Two provider calls; the second carried the partial assistant turn + a resume nudge.
        expect(calls).toHaveLength(2);
        expect(calls[1]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(calls[1]![1]!.content).toBe('The harbour was quiet');
        expect(calls[1]![2]!.content).toMatch(/continue/i);
    });

    it('does NOT continue a round that ended cleanly (stop)', async () => {
        const { provider, calls } = mockProvider([
            [{ text: 'done.' }, { done: true, finishReason: 'stop' }],
            [{ text: 'should-not-happen' }, { done: true, finishReason: 'stop' }]
        ]);
        const result = await streamToolAwareRound(provider, { messages: [{ role: 'user', content: 'go' }] }, noCallbacks);
        expect(result.response).toBe('done.');
        expect(calls).toHaveLength(1);
    });

    it('does NOT continue a truncated round that emitted a tool call', async () => {
        const { provider, calls } = mockProvider([
            [
                {
                    text: 'partial',
                    toolCalls: [{ index: 0, id: 'c1', name: 'vault_lookup', arguments: '{"path":"x"}' }]
                },
                { done: true, finishReason: 'length' }
            ],
            [{ text: 'should-not-happen' }, { done: true, finishReason: 'stop' }]
        ]);
        const result = await streamToolAwareRound(provider, { messages: [{ role: 'user', content: 'go' }] }, noCallbacks);
        expect(result.response).toBe('partial');
        expect(result.finishReason).toBe('length');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]!.name).toBe('vault_lookup');
        expect(calls).toHaveLength(1);
    });

    it('stops after the bounded number of continuation rounds', async () => {
        // Every round truncates and never finishes — the bound prevents an infinite loop.
        const round: ChatChunk[] = [{ text: 'more ' }, { done: true, finishReason: 'length' }];
        const { provider, calls } = mockProvider([round, round, round, round]);
        const result = await streamToolAwareRound(provider, { messages: [{ role: 'user', content: 'go' }] }, noCallbacks);
        // 1 initial round + 3 continuations (MAX_CONTINUE_ROUNDS) = 4 rounds, then returns truncated.
        expect(calls).toHaveLength(4);
        expect(result.finishReason).toBe('length');
        expect(result.response).toBe('more more more more ');
    });
});
