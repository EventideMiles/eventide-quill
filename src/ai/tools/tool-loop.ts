import type { AiProvider, ChatChunk, ChatMessage } from '../provider';
import type { Tool, ToolContext, ToolInvocation, ToolRegistry } from './tool';

/**
 * Maximum number of tool rounds before the loop gives up and emits a final
 * `done` chunk. A "round" is one model completion possibly containing tool
 * calls plus the execution of those tools. Five rounds means the model can
 * call up to five sequential batches of tools before being told to wrap up.
 *
 * High enough to support a real research-and-draft flow (gather context
 * across multiple sources, then draft) but low enough to prevent runaway
 * loops if the model gets stuck calling tools without producing output.
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * Stateful streaming parser that detects pseudo-XML tool invocations
 * (`<toolId>args</toolId>`) inside the model's token stream, strips them
 * from the emitted text, and queues them for execution.
 *
 * The parser is intentionally tolerant: any `<...>` that doesn't match a
 * registered tool's id passes through as literal text (so model prose
 * containing `<` characters, partial tags, or unknown tools is preserved
 * verbatim for the consumer).
 *
 * The parser must handle three streaming edge cases correctly:
 *   1. **Tag split across chunks** — e.g. `<manuscript` in one chunk,
 *      `_mentions>Sarah</manuscript_mentions>` in the next. The parser
 *      holds back any trailing substring that could be the start of a tag.
 *   2. **Args split across chunks** — opening tag seen but close tag not
 *      yet in buffer. The parser holds back from the opening tag onward
 *      until the close tag arrives.
 *   3. **Unclosed tag at end of stream** — `flush()` emits any held-back
 *      buffer as literal text. The model wrote a `<` that didn't resolve
 *      to a real tool call; surface it rather than silently dropping it.
 *
 * Multiple invocations in a single response are supported — the parser
 * loops its buffer until no more complete tags are present.
 *
 * Nested tags (e.g. `<a>...<b>...</b>...</a>`) are NOT supported — the
 * inner tag becomes part of the outer tag's args string. This is a
 * deliberate simplification for v1.
 */
export class ToolStreamParser {
    private buffer = '';
    private readonly invocations: ToolInvocation[] = [];
    private readonly toolIds: Set<string>;
    /** Length of the longest opening tag, used to bound the partial-tag scan. */
    private readonly maxTagLength: number;

    constructor(registry: ToolRegistry) {
        const tools = registry.list();
        this.toolIds = new Set(tools.map((t) => t.id));
        this.maxTagLength = tools.reduce((max, t) => Math.max(max, t.id.length + 2), 1);
    }

    /**
     * Feed a chunk of text. Returns the substring safe to emit to the
     * consumer right now (everything except inside-tool-tag content and
     * any trailing partial-tag prefix).
     */
    feed(chunk: string): { text: string } {
        this.buffer += chunk;
        return this.processBuffer();
    }

    /**
     * Flush at end of stream. Any remaining buffer is unclosed / partial
     * and is emitted as literal text.
     */
    flush(): { text: string } {
        const text = this.buffer;
        this.buffer = '';
        return { text };
    }

    /** Drain queued invocations; empties the internal queue. */
    drainInvocations(): ToolInvocation[] {
        const invs = this.invocations;
        // Reset to a fresh array rather than `.length = 0` so any retained
        // reference (defensive) is not mutated.
        while (this.invocations.length > 0) this.invocations.pop();
        return invs;
    }

    private processBuffer(): { text: string } {
        let emitText = '';

        while (this.buffer.length > 0) {
            const earliest = this.findEarliestOpeningTag(this.buffer);

            if (earliest === null) {
                // No opening tag in the buffer. Hold back any trailing substring
                // that could be the prefix of a tag (e.g. the "<manu" prefix of
                // "<manuscript_mentions>") so we don't emit a partial tag to the
                // consumer that would then be redacted when the rest arrives.
                const safeLen = this.safeEmitLength(this.buffer);
                emitText += this.buffer.slice(0, safeLen);
                this.buffer = this.buffer.slice(safeLen);
                return { text: emitText };
            }

            // Emit text before the opening tag.
            emitText += this.buffer.slice(0, earliest.idx);

            // Look for the matching close tag after the opening tag.
            const afterOpen = earliest.idx + earliest.tagLength;
            const closeIdx = this.buffer.indexOf(earliest.closeTag, afterOpen);

            if (closeIdx === -1) {
                // Close tag not yet in buffer — hold back from the opening tag
                // onward and wait for more chunks.
                this.buffer = this.buffer.slice(earliest.idx);
                return { text: emitText };
            }

            // Complete invocation — extract args, queue, advance past close tag.
            const args = this.buffer.slice(afterOpen, closeIdx).trim();
            this.invocations.push({ toolId: earliest.toolId, args });
            this.buffer = this.buffer.slice(closeIdx + earliest.closeTag.length);
        }

        return { text: emitText };
    }

    /** Find the earliest opening tag of any registered tool in the buffer. */
    private findEarliestOpeningTag(
        text: string
    ): { idx: number; toolId: string; tagLength: number; closeTag: string } | null {
        let best: { idx: number; toolId: string; tagLength: number; closeTag: string } | null = null;
        for (const toolId of this.toolIds) {
            const openTag = `<${toolId}>`;
            const idx = text.indexOf(openTag);
            if (idx !== -1 && (best === null || idx < best.idx)) {
                best = { idx, toolId, tagLength: openTag.length, closeTag: `</${toolId}>` };
            }
        }
        return best;
    }

    /**
     * Length of the safe-to-emit prefix of `text`. Any trailing substring
     * that is a prefix of some opening tag (e.g. the `<` of `<manuscript_mentions>`
     * at the very end of the buffer) is held back so the parser can resolve
     * it once the next chunk arrives.
     *
     * Scans at most `maxTagLength` trailing chars — tags are bounded in length
     * so longer scans would be wasted work.
     */
    private safeEmitLength(text: string): number {
        const maxScan = Math.min(text.length, this.maxTagLength);
        let holdback = 0;
        for (let i = 1; i <= maxScan; i++) {
            const suffix = text.slice(text.length - i);
            for (const toolId of this.toolIds) {
                if (`<${toolId}>`.startsWith(suffix)) {
                    holdback = i;
                    break;
                }
            }
        }
        return text.length - holdback;
    }
}

/**
 * Wrap a provider's chat completion stream with pseudo-tool support.
 *
 * Yields chunks identical in shape to the underlying provider's output
 * (`text`, `thought`, `done`, `model`, `usage`) so it's a drop-in
 * replacement for `provider.chatCompletion(options)`. The differences:
 *
 *   1. **Tool tags are stripped from `text`** — `<toolId>args</toolId>`
 *      never reaches the consumer; only the surrounding prose does.
 *   2. **Multiple rounds are possible** — if the model emits any tool
 *      calls in its response, the loop executes them, appends a
 *      `<tool_result>` message for each, and starts a new completion
 *      with the extended message array. To the consumer this looks like
 *      one continuous stream of text.
 *   3. **Intermediate `done: true` chunks are suppressed** — the consumer
 *      only sees `done: true` when the model produces a response with no
 *      tool calls (or when `maxRounds` is exceeded).
 *
 * The `options.messages` array is treated as read-only — a shallow clone
 * is made internally and the original is not mutated. Tool result messages
 * accumulate on the internal clone only.
 *
 * @param provider  The AI provider to call.
 * @param options   The base chat options (messages, model, temperature, etc.).
 * @param registry  Tool registry; if empty, behaves as a plain passthrough.
 * @param ctx       Tool execution context (plugin, abort signal).
 * @param maxRounds Optional override for the round cap (defaults to 5).
 */
export async function* streamWithTools(
    provider: AiProvider,
    options: {
        messages: ChatMessage[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    },
    registry: ToolRegistry,
    ctx: ToolContext,
    maxRounds: number = MAX_TOOL_ROUNDS
): AsyncGenerator<ChatChunk> {
    if (registry.size === 0) {
        // Empty registry — no parsing overhead, just forward the stream.
        yield* provider.chatCompletion(options);
        return;
    }

    const messages: ChatMessage[] = [...options.messages];
    let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    let lastModel: string | undefined;

    for (let round = 0; round < maxRounds; round++) {
        const parser = new ToolStreamParser(registry);
        let assistantText = '';

        for await (const chunk of provider.chatCompletion({ ...options, messages })) {
            assistantText += chunk.text;
            if (chunk.usage) lastUsage = chunk.usage;
            if (chunk.model) lastModel = chunk.model;

            const parsed = parser.feed(chunk.text);
            if (parsed.text || chunk.thought) {
                const yieldChunk: ChatChunk = {
                    text: parsed.text,
                    done: false
                };
                if (chunk.thought) yieldChunk.thought = chunk.thought;
                if (chunk.model) yieldChunk.model = chunk.model;
                yield yieldChunk;
            }
        }

        // Flush trailing literal text (e.g. an unclosed `<` the model emitted).
        const flushed = parser.flush();
        if (flushed.text) {
            yield { text: flushed.text, done: false };
        }

        const invocations = parser.drainInvocations();
        if (invocations.length === 0) {
            // No tool calls — the model's response is final.
            const doneChunk: ChatChunk = { text: '', done: true };
            if (lastModel) doneChunk.model = lastModel;
            if (lastUsage) doneChunk.usage = lastUsage;
            yield doneChunk;
            return;
        }

        // Append the assistant's response (including its tool tags) so the
        // model sees its own prior turn verbatim, then append a result
        // message for each invoked tool.
        messages.push({ role: 'assistant', content: assistantText });

        for (const inv of invocations) {
            const tool = registry.get(inv.toolId);
            if (!tool) continue; // Defensive — parser only matches registered ids.

            const result = await executeToolSafely(tool, inv.args, ctx);
            messages.push({
                role: 'user',
                content: `<tool_result tool="${inv.toolId}">\n${result}\n</tool_result>`
            });
        }
        // Loop continues: a new completion will start with the extended messages.
    }

    // Exceeded maxRounds — emit a final done so the consumer's stream ends cleanly.
    // The model has already produced its prose through the prior rounds; this just
    // closes the stream without further tool calls.
    const doneChunk: ChatChunk = { text: '', done: true };
    if (lastModel) doneChunk.model = lastModel;
    if (lastUsage) doneChunk.usage = lastUsage;
    yield doneChunk;
}

/**
 * Execute a tool with truncation and error containment. Never throws —
 * failures surface to the model as an error string inside the
 * `<tool_result>` block so the model can recover or apologize.
 */
async function executeToolSafely(tool: Tool, args: string, ctx: ToolContext): Promise<string> {
    try {
        if (ctx.signal?.aborted) return 'Error: aborted before tool execution.';
        const result = await tool.execute(args, ctx);
        const maxChars = tool.maxResultTokens * 4; // rough tokens → chars
        if (result.length > maxChars) {
            return `${result.slice(0, maxChars)}\n\n...[result truncated at ${tool.maxResultTokens} tokens]`;
        }
        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error executing tool "${tool.id}": ${message}`;
    }
}
