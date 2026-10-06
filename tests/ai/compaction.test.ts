import { describe, it, expect } from 'vitest';
import { compactConversation, fallbackCompactConversation, FALLBACK_SUMMARY_MARKER } from '../../src/ai/compaction';
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

/** Build a mock provider whose chatCompletion throws the given error. */
function makeThrowingProvider(error: unknown): AiProvider {
    return {
        id: 'test',
        name: 'Test Provider',
        config: {} as AiProvider['config'],
        // The stream rejects on consumption without ever yielding a chunk.
        // eslint-disable-next-line require-yield -- the mock provider fails before producing any output
        async *chatCompletion() {
            throw error;
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

/**
 * Build a mock provider that mimics the streaming layers' abort shape: it
 * yields partial text, aborts the CALLER'S CONTROLLER mid-stream, then ends the
 * generator gracefully (SSE/NDJSON parsers close without throwing on abort,
 * and the mobile buffered path resolves early) — so the consumer sees a
 * RESOLVED truncated summary, not a rejection.
 */
function makeAbortMidStreamProvider(controller: AbortController): AiProvider {
    return {
        id: 'test',
        name: 'Test Provider',
        config: {} as AiProvider['config'],
        async *chatCompletion() {
            yield { text: 'partial truncat', done: false };
            controller.abort();
            yield { text: 'ed tail', done: true };
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

/** Build a message array with a leading system prompt plus the given turns. */
function makeMessages(turns: Array<{ role: 'user' | 'assistant'; content: string }>): ChatMessage[] {
    return [{ role: 'system', content: 'System prompt' }, ...turns];
}

/**
 * Build a conversation of 3 complete tool rounds (anchors t1-t3) followed by a
 * plain anchored exchange (t4), so the deterministic drop boundary falls between
 * whole anchor groups.
 */
function makeAnchoredRounds(): ChatMessage[] {
    return [
        { role: 'system', content: 'System prompt' },
        { role: 'system', content: 'Context head' },
        { role: 'user', content: 'q1', quillAnchorId: 't1' },
        {
            role: 'assistant',
            content: 'a1',
            quillAnchorId: 't1',
            toolCalls: [{ id: 'call-1', name: 'vault_lookup', arguments: '{"path":"a.md"}' }]
        },
        { role: 'tool', content: 'result 1', quillAnchorId: 't1', toolCallId: 'call-1', name: 'vault_lookup' },
        { role: 'user', content: 'q2', quillAnchorId: 't2' },
        {
            role: 'assistant',
            content: 'a2',
            quillAnchorId: 't2',
            toolCalls: [{ id: 'call-2', name: 'vault_lookup', arguments: '{"path":"b.md"}' }]
        },
        { role: 'tool', content: 'result 2', quillAnchorId: 't2', toolCallId: 'call-2', name: 'vault_lookup' },
        { role: 'user', content: 'q3', quillAnchorId: 't3' },
        {
            role: 'assistant',
            content: 'a3',
            quillAnchorId: 't3',
            toolCalls: [{ id: 'call-3', name: 'vault_lookup', arguments: '{"path":"c.md"}' }]
        },
        { role: 'tool', content: 'result 3', quillAnchorId: 't3', toolCallId: 'call-3', name: 'vault_lookup' },
        { role: 'user', content: 'q4', quillAnchorId: 't4' },
        { role: 'assistant', content: 'a4', quillAnchorId: 't4' }
    ];
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

    it('falls back deterministically when summarization throws', async () => {
        const provider = makeThrowingProvider(new Error('boom'));
        const messages = makeMessages([
            { role: 'user', content: 'old question' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'recent question' },
            { role: 'assistant', content: 'recent answer' }
        ]);
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe(FALLBACK_SUMMARY_MARKER);
        // System prompt + marker + last 2 turns (older turns dropped)
        expect(result!.messages).toHaveLength(4);
        expect(result!.messages[0]!.content).toBe('System prompt');
        expect(result!.messages[1]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result!.messages[2]!.content).toBe('recent question');
        expect(result!.messages[3]!.content).toBe('recent answer');
    });

    it('falls back deterministically when the provider produces an empty summary', async () => {
        const provider = makeMockProvider('   ');
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe(FALLBACK_SUMMARY_MARKER);
        expect(result!.messages).toHaveLength(4);
        expect(result!.messages[1]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result!.messages[2]!.content).toBe('q2');
        expect(result!.messages[3]!.content).toBe('a2');
    });

    it('rethrows abort errors instead of falling back', async () => {
        const provider = makeThrowingProvider(new DOMException('Aborted', 'AbortError'));
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        await expect(compactConversation(provider, messages, 3)).rejects.toMatchObject({
            name: 'AbortError'
        });
    });

    it('rejects when the signal aborts MID-summarize (a graceful stream end must not pass as a summary)', async () => {
        // The streaming layers end their generators gracefully on abort, so the
        // summarize RESOLVES with whatever truncated text streamed before the
        // cancel. The aborted-signal check must turn that into a rejection —
        // never a CompactResult folding history into a truncated summary.
        const controller = new AbortController();
        const provider = makeAbortMidStreamProvider(controller);
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        await expect(compactConversation(provider, messages, 3, { signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError'
        });
    });

    it('rejects when the signal is already aborted before the call', async () => {
        const provider = makeMockProvider('summary');
        const controller = new AbortController();
        controller.abort();
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        await expect(compactConversation(provider, messages, 3, { signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError'
        });
    });

    it('succeeds normally when a live (non-aborted) signal is supplied', async () => {
        const provider = makeMockProvider('Clean summary');
        const controller = new AbortController();
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        const result = await compactConversation(provider, messages, 3, { signal: controller.signal });
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('Clean summary');
    });

    it('keeps tool rounds atomic when dropping old turns', async () => {
        const provider = makeThrowingProvider(new Error('boom'));
        const messages = makeAnchoredRounds();
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        const msgs = result!.messages;
        // System prompt + context head + marker + whole t3 round (3 msgs) + whole t4 round (2 msgs)
        expect(msgs).toHaveLength(8);
        expect(msgs[0]!.content).toBe('System prompt');
        // Context heads survive verbatim before the marker.
        expect(msgs[1]).toEqual({ role: 'system', content: 'Context head' });
        expect(msgs[2]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        // The kept region starts with the whole t3 round, never an orphaned tool result.
        expect(msgs[3]).toEqual({ role: 'user', content: 'q3', quillAnchorId: 't3' });
        expect(msgs[4]!.role).toBe('assistant');
        expect(msgs[4]!.quillAnchorId).toBe('t3');
        expect(msgs[4]!.toolCalls).toHaveLength(1);
        expect(msgs[5]).toEqual({
            role: 'tool',
            content: 'result 3',
            quillAnchorId: 't3',
            toolCallId: 'call-3',
            name: 'vault_lookup'
        });
        // …and ends on a plain assistant answer, not an unanswered tool call.
        expect(msgs[6]!.content).toBe('q4');
        expect(msgs[7]).toEqual({ role: 'assistant', content: 'a4', quillAnchorId: 't4' });
        // Rounds t1 and t2 are gone entirely — no orphaned fragments survive.
        const anchors = msgs.map((message) => message.quillAnchorId);
        expect(anchors).not.toContain('t1');
        expect(anchors).not.toContain('t2');
    });

    it('returns null when the fallback cannot shrink a tiny conversation', async () => {
        const provider = makeThrowingProvider(new Error('boom'));
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' }
        ]);
        // 3 chat turns < 4 → the fallback leaves the array unchanged → null.
        expect(await compactConversation(provider, messages, 3)).toBeNull();
    });

    it('does not mutate the input array on the fallback path', async () => {
        const provider = makeThrowingProvider(new Error('boom'));
        const messages = makeAnchoredRounds();
        const snapshot = structuredClone(messages);
        const result = await compactConversation(provider, messages, 3);
        expect(result).not.toBeNull();
        expect(messages).toEqual(snapshot);
    });
});

describe('fallbackCompactConversation', () => {
    it('drops the oldest groups and keeps the last 2 verbatim', () => {
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ]);
        const result = fallbackCompactConversation(messages);
        expect(result).toHaveLength(4);
        expect(result[1]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result[2]!.content).toBe('q2');
        expect(result[3]!.content).toBe('a2');
        // A new array — the input is never returned by reference.
        expect(result).not.toBe(messages);
    });

    it('returns the input unchanged for fewer than 4 chat turns', () => {
        const messages = makeMessages([
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' }
        ]);
        const result = fallbackCompactConversation(messages);
        expect(result).toEqual(messages);
        expect(result).not.toBe(messages);
    });

    it('keeps context heads verbatim before the marker', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'system', content: 'Memory index' },
            { role: 'system', content: 'Tool guidance' },
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' }
        ];
        const result = fallbackCompactConversation(messages);
        expect(result).toHaveLength(6);
        expect(result[0]!.content).toBe('System prompt');
        expect(result[1]).toEqual({ role: 'system', content: 'Memory index' });
        expect(result[2]).toEqual({ role: 'system', content: 'Tool guidance' });
        expect(result[3]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result[4]!.content).toBe('q2');
        expect(result[5]!.content).toBe('a2');
    });

    it('groups fully-unanchored tool rounds by wire shape and shrinks the subagent history', () => {
        // SubagentSession stamps no quillAnchorId, so every message would be its
        // own group under anchor-only grouping and the fallback would no-op on
        // the orphaned-tool sanity check. Unanchored tool results join their
        // parent assistant round, so this oversized history now compacts.
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1', toolCalls: [{ id: 'call-1', name: 't', arguments: '{}' }] },
            { role: 'tool', content: 'result 1', toolCallId: 'call-1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
            { role: 'user', content: 'q3' },
            { role: 'assistant', content: 'a3', toolCalls: [{ id: 'call-3', name: 't', arguments: '{}' }] },
            { role: 'tool', content: 'result 3', toolCallId: 'call-3' },
            { role: 'user', content: 'q4' }
        ];
        const result = fallbackCompactConversation(messages);
        // Kept groups: [a3, result 3] and [q4] — the whole last tool round plus
        // the trailing user turn; everything older is dropped.
        expect(result).toHaveLength(5);
        expect(result.length).toBeLessThan(messages.length);
        expect(result[1]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result[2]!.role).toBe('assistant');
        expect(result[2]!.toolCalls).toHaveLength(1);
        expect(result[3]).toEqual({ role: 'tool', content: 'result 3', toolCallId: 'call-3' });
        expect(result[4]).toEqual({ role: 'user', content: 'q4' });
    });

    it('returns the input unchanged when the kept region would start with an unmergeable tool result', () => {
        // A tool result whose anchor matches nothing before it cannot merge into
        // the preceding group (anchored matching is by anchor id), so it stays a
        // lone group — and landing first in the kept region it must refuse the
        // drop rather than start the kept history with an orphaned tool result.
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'q1', quillAnchorId: 't1' },
            { role: 'assistant', content: 'a1', quillAnchorId: 't1' },
            { role: 'user', content: 'q2', quillAnchorId: 't2' },
            { role: 'assistant', content: 'a2', quillAnchorId: 't2' },
            { role: 'tool', content: 'orphan result', quillAnchorId: 't9', toolCallId: 'call-9' },
            { role: 'user', content: 'q4', quillAnchorId: 't4' },
            { role: 'assistant', content: 'a4', quillAnchorId: 't4' }
        ];
        const result = fallbackCompactConversation(messages);
        expect(result).toEqual(messages);
        expect(result).not.toBe(messages);
    });

    it('groups an unanchored assistant tool-call round as one unit inside an anchored conversation', () => {
        // Mixed shape: anchored groups interleaved with a subagent-style
        // unanchored [assistant + toolCalls, tool] pair. The pair must group as
        // one atomic unit so it can sit intact at the kept-region boundary.
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'q1', quillAnchorId: 't1' },
            { role: 'assistant', content: 'a1', quillAnchorId: 't1' },
            { role: 'user', content: 'q2', quillAnchorId: 't2' },
            { role: 'assistant', content: 'a2', quillAnchorId: 't2' },
            { role: 'user', content: 'q3', quillAnchorId: 't3' },
            { role: 'assistant', content: 'a3', quillAnchorId: 't3' },
            { role: 'assistant', content: 'a4', toolCalls: [{ id: 'call-4', name: 't', arguments: '{}' }] },
            { role: 'tool', content: 'result 4', toolCallId: 'call-4' },
            { role: 'user', content: 'q5', quillAnchorId: 't5' },
            { role: 'assistant', content: 'a5', quillAnchorId: 't5' }
        ];
        const result = fallbackCompactConversation(messages);
        // Kept groups: the unanchored tool round [a4, result 4] and [q5, a5].
        // Had the tool result not merged with its assistant, the kept region
        // would start with a bare tool message and the fallback would no-op.
        expect(result).toHaveLength(6);
        expect(result.length).toBeLessThan(messages.length);
        expect(result[1]).toEqual({ role: 'system', content: FALLBACK_SUMMARY_MARKER });
        expect(result[2]!.role).toBe('assistant');
        expect(result[2]!.toolCalls).toHaveLength(1);
        expect(result[3]).toEqual({ role: 'tool', content: 'result 4', toolCallId: 'call-4' });
        expect(result[4]).toEqual({ role: 'user', content: 'q5', quillAnchorId: 't5' });
        expect(result[5]).toEqual({ role: 'assistant', content: 'a5', quillAnchorId: 't5' });
        // Older anchored rounds are gone whole — no fragments survive.
        const anchors = result.map((message) => message.quillAnchorId);
        expect(anchors).not.toContain('t1');
        expect(anchors).not.toContain('t2');
        expect(anchors).not.toContain('t3');
    });

    it('returns the input unchanged when the array ends on an unanswered assistant tool call', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
            { role: 'user', content: 'q3' },
            { role: 'assistant', content: 'a3' },
            { role: 'user', content: 'q4' },
            {
                role: 'assistant',
                content: 'a4',
                toolCalls: [{ id: 'call-4', name: 't', arguments: '{}' }]
            }
        ];
        const result = fallbackCompactConversation(messages);
        expect(result).toEqual(messages);
        expect(result).not.toBe(messages);
    });

    it('passes kept messages through by reference with all fields intact', () => {
        const messages = makeAnchoredRounds();
        const result = fallbackCompactConversation(messages);
        // Reference equality for every kept message — fields (quillAnchorId,
        // toolCalls, toolCallId) are untouched.
        expect(result).toContain(messages[8]); // q3
        expect(result).toContain(messages[9]); // a3 with toolCalls
        expect(result).toContain(messages[10]); // tool result 3
        expect(result).toContain(messages[11]); // q4
        expect(result).toContain(messages[12]); // a4
    });
});
