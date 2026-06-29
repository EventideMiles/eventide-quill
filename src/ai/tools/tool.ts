import type EventideQuillPlugin from '../../main';
import type { ToolCallRequest, ToolDefinition } from '../provider';

/**
 * Structured tool result. `text` is always shown to the model as the tool's
 * textual output; `images` (base64, no `data:` prefix) are routed through
 * `resolveImageInjection` — attached directly when the chat model is
 * vision-capable, or translated to a text caption when it isn't. A tool that
 * only produces text can return a plain string instead.
 */
export interface ToolResult {
    /** Textual result, always delivered to the model. */
    text: string;
    /** Optional image attachments (base64, no `data:` prefix). */
    images?: string[];
}

/**
 * A tool the AI may invoke via the provider's native tool-calling API.
 *
 * The provider serializes the {@link parameters} JSON Schema into the
 * `tools` request-body field; the model emits a structured tool call (not a
 * pseudo-XML tag) when it decides to use the tool; the tool-loop accumulates
 * the streamed fragments, parses the JSON arguments, and dispatches to
 * {@link execute}.
 *
 * This is the OpenAI/Ollama/LM Studio native tool-calling path — it works
 * with any model whose chat template supports tool calls (Llama 3.1+,
 * Qwen 2.5+, Mistral, Hermes, etc.). Models without tool-call support will
 * return a provider-specific error when `tools` is sent; that surfaces to the
 * user as a Notice so they can switch models or disable tools.
 *
 * Convention: tool ids are `snake_case` and read as verbs or nouns
 * (e.g., `manuscript_mentions`, `fetch_url`, `propose_entry`).
 */
export interface Tool {
    /** Unique snake_case identifier; the model uses this as the call target. */
    readonly id: string;
    /** One-line description surfaced to the model. */
    readonly description: string;
    /**
     * JSON Schema describing the parameters object the model should emit.
     * Example: `{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }`.
     * Passed through verbatim to the provider's `tools` field.
     */
    readonly parameters: Record<string, unknown>;
    /**
     * Hard cap on the result length, in approximate tokens (chars / 4).
     * The tool-loop truncates beyond this to protect the model's context
     * budget. Pick conservatively — fetched web pages can be huge.
     */
    readonly maxResultTokens: number;
    /**
     * Whether the tool makes a network request. Consumers (e.g., the
     * Lorebook Coach) use this to filter the registry against the
     * `lorebookNetworkTools` setting.
     */
    readonly requiresNetwork: boolean;
    /**
     * Execute the tool and return its result. Most tools return a plain string;
     * tools that produce images (e.g. `fetch_image_url`) return a
     * {@link ToolResult} carrying base64 image data, which the tool-loop routes
     * through `resolveImageInjection` before the model sees it.
     *
     * Throw on unrecoverable errors — the loop catches and surfaces them to the
     * model as a tool-result error string, so the model can recover.
     *
     * @param args  The parsed arguments object emitted by the model.
     * @param ctx   Runtime context (plugin, abort signal, etc.).
     */
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolResult>;
}

/**
 * Runtime context passed to every tool execution. Carries the plugin
 * reference (for vault access, settings, and cached state like
 * `currentManuscriptEntities`) and an optional abort signal that the
 * tool-loop propagates from the outer request.
 *
 * The plugin reference is type-only (`import type`) to avoid a runtime
 * circular import — tools live under `src/ai/tools/` and `main.ts`
 * imports from `src/ai/`, so a runtime dep would cycle.
 */
export interface ToolContext {
    plugin: EventideQuillPlugin;
    /** Abort signal from the outer request; tools should respect it for long ops. */
    signal?: AbortSignal;
    /**
     * Approximate tokens already consumed by the active request's message
     * prefix (conversation + prior tool results + tools-field overhead),
     * computed at call time. Provided by the co-writer tool loops so
     * sizing/planning tools (measure_folder, calculate_file_sizes) can report
     * "will this batch fit" against the REMAINING context, not the whole
     * window. Undefined when the tool is invoked outside a tracked loop.
     */
    consumedTokens?: () => number;
}

/**
 * Thrown by {@link ToolRegistry.register} when a tool with the same id is
 * registered twice. Lets higher layers distinguish registry wiring failures
 * from runtime tool-execution failures.
 */
export class DuplicateToolError extends Error {
    /** The conflicting tool id. */
    readonly toolId: string;

    constructor(toolId: string) {
        super(`Tool "${toolId}" is already registered`);
        this.name = 'DuplicateToolError';
        this.toolId = toolId;
    }
}

/**
 * Registry of available tools. Tools are registered once at session start
 * (filtered by settings — e.g., network tools only when `lorebookNetworkTools`
 * is on), then the same registry instance is reused across every generation
 * round in the tool-loop.
 *
 * Registering a duplicate id throws — tool ids are unique by contract.
 */
export class ToolRegistry {
    private readonly tools = new Map<string, Tool>();

    register(tool: Tool): void {
        if (this.tools.has(tool.id)) {
            throw new DuplicateToolError(tool.id);
        }
        this.tools.set(tool.id, tool);
    }

    get(id: string): Tool | undefined {
        return this.tools.get(id);
    }

    has(id: string): boolean {
        return this.tools.has(id);
    }

    list(): Tool[] {
        return [...this.tools.values()];
    }

    get size(): number {
        return this.tools.size;
    }

    /**
     * Render the registry as the array of {@link ToolDefinition} objects the
     * provider expects on the `tools` request-body field. Each tool becomes:
     *
     *   { name, description, parameters }
     *
     * The provider wraps these into the final `{ type: 'function', function }`
     * shape on the way out.
     */
    toToolDefinitions(): ToolDefinition[] {
        return this.list().map((t) => ({
            name: t.id,
            description: t.description,
            parameters: t.parameters
        }));
    }

    /**
     * Rough token cost of this registry's tool definitions as serialized to the
     * request `tools` field. The bulk of the cost is each tool's description +
     * JSON-schema parameters. Empirical: stringifies the definitions wrapped in
     * the `{ type: 'function', function: ... }` shape the providers actually
     * send (see {@link ToolDefinition}) and applies the chars/4 heuristic, so it
     * self-adjusts to any tool add/remove or description edit — no hardcoded
     * constants. Used to fold the fixed tools overhead into context-budget
     * estimates so compaction reflects real size.
     */
    estimateTokens(): number {
        const wrapped = this.toToolDefinitions().map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
        return Math.ceil(JSON.stringify(wrapped).length / 4);
    }
}

/**
 * Execute one tool call: JSON-arg parsing, error containment, result
 * truncation. The single source of truth for tool-execution semantics across
 * every tool-loop path (co-writer modes, SubagentSession, streamWithTools) —
 * aborts propagate, non-abort failures surface as an error string the model
 * can recover from, and results are truncated to `maxResultTokens * 4` chars.
 */
export async function executeToolCall(
    call: ToolCallRequest,
    registry: ToolRegistry,
    ctx: ToolContext
): Promise<ToolResult> {
    const tool = registry.get(call.name);
    if (!tool) return { text: `Error: tool "${call.name}" is not registered.` };

    let parsedArgs: Record<string, unknown>;
    try {
        const raw: unknown = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            return { text: `Error: invalid JSON arguments for tool "${call.name}": expected an object.` };
        }
        parsedArgs = raw as Record<string, unknown>;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `Error: invalid JSON arguments: ${msg}` };
    }

    try {
        if (ctx.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await tool.execute(parsedArgs, ctx);
        const normalized: ToolResult = typeof result === 'string' ? { text: result } : result;
        const maxChars = tool.maxResultTokens * 4;
        if (normalized.text.length > maxChars) {
            normalized.text = `${normalized.text.slice(0, maxChars)}\n\n...[result truncated at ${tool.maxResultTokens} tokens]`;
        }
        return normalized;
    } catch (err) {
        if (ctx.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `Error executing tool "${call.name}": ${msg}` };
    }
}
