import type EventideQuillPlugin from '../../main';
import type { ToolDefinition } from '../provider';

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
     * Execute the tool and return its result as a string for the model.
     * Throw on unrecoverable errors — the loop catches and surfaces them
     * to the model as a tool-result error string, so the model can recover.
     *
     * @param args  The parsed arguments object emitted by the model.
     * @param ctx   Runtime context (plugin, abort signal, etc.).
     */
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
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
            throw new Error(`Tool "${tool.id}" is already registered`);
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
}
