import { describe, it, expect } from 'vitest';
import { compactConversation } from '../../src/ai/compaction';
import type { AiProvider, ChatMessage } from '../../src/ai/provider';

/** Build a mock provider whose chatCompletion yields a fixed summary string. */
function makeMockProvider(summary: string): AiProvider {
    return {
        id: 'test',
        name: 'Test Provider',
        config: {} as AiProvider['config'],
        async *chatCompletion() {
            yield { text: summary, done: true };
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

function makeMessages(turns: Array<{ role: 'user' | 'assistant'; content: string }>): ChatMessage[] {
    return [{ role: 'system', content: 'System prompt' }, ...turns];
}

describe('compactConversation', () => {
    it('returns null for empty messages', async () => {
        const provider = makeMockProvider('summary');
        expect(await compactConversation(provider, [], 3)).toBeNull();
    });

    it('returns null for a single message (system prompt only)', async () => {
        const provider = makeMockProvider('summary');
        expect(await compactConversation(provider, [{ role: 'system', content: 'sys' }], 3)).toBeNull();
    });

    it('returns null for fewer than 2 chat turns', async () => {
        const provider = makeMockProvider('summary');
        const messages = makeMessages([{ role: 'user', content: 'one message' }]);
        expect(await compactConversation(provider, messages, 3)).toBeNull();
    });

    it('returns null when there are exactly 2 turns and nothing to summarize', async () => {
        const provider = makeMockProvider('summary');
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' }
        ]);
        // 2 chat turns → keepCount = 2, toSummarize is empty → returns null
        expect(await compactConversation(provider, messages, 3)).toBeNull();
    });

    it('compacts older turns and keeps the last 2 verbatim', async () => {
        const provider = makeMockProvider('Summary of older turns');
        const messages = makeMessages([
            { role: 'user', content: 'old question' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'recent question' },
            { role: 'assistant', content: 'recent answer' }
        ]);
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        // System prompt + summary + last 2 turns
        expect(result!.messages).toHaveLength(4);
        expect(result!.messages[0]!.content).toBe('System prompt');
        expect(result!.messages[1]!.role).toBe('system');
        expect(result!.messages[1]!.content).toBe('Summary of older turns');
        expect(result!.messages[2]!.content).toBe('recent question');
        expect(result!.messages[3]!.content).toBe('recent answer');
    });

    it('rolls context heads into the summary', async () => {
        const provider = makeMockProvider('Summary including context');
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'system', content: 'Context head 1' },
            { role: 'system', content: 'Context head 2' },
            { role: 'user', content: 'old turn' },
            { role: 'assistant', content: 'old reply' },
            { role: 'user', content: 'keep me' },
            { role: 'assistant', content: 'keep me too' }
        ];
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        // System prompt + summary + last 2 turns (context heads consumed)
        expect(result!.messages).toHaveLength(4);
        expect(result!.summary).toBe('Summary including context');
    });

    it('returns the summary text in the result', async () => {
        const provider = makeMockProvider('My custom summary');
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        const result = await compactConversation(provider, messages, 3);
        expect(result!.summary).toBe('My custom summary');
    });

    it('returns null when the provider produces an empty summary', async () => {
        const provider = makeMockProvider('   ');
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        expect(await compactConversation(provider, messages, 3)).toBeNull();
    });
});
