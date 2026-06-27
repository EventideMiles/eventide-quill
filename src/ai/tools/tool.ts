import type EventideQuillPlugin from '../../main';

/**
 * A tool the AI may invoke mid-generation by emitting a pseudo-XML tag of the
 * form `<toolId>args</toolId>` in its streamed response. The tool-loop wrapper
 * ({@link module:ai/tools/tool-loop.streamWithTools}) detects these tags,
 * executes the matching tool, and re-prompts the model with the result.
 *
 * This is the "pseudo-tool" pattern: it works on any model that can follow
 * instructions, requires no provider-side function-calling support, and
 * composes cleanly with the existing stream consumers in `co-writer.ts` and
 * elsewhere. The trade-off vs. native OpenAI tool-calling is that the model
 * must be taught the tag syntax via the catalog prompt ({@link ToolRegistry.renderCatalog}).
 *
 * Convention: tool ids are `snake_case` and read as verbs or nouns
 * (e.g., `manuscript_mentions`, `fetch_url`, `fandom_lookup`).
 */
export interface Tool {
    /** Unique snake_case identifier; also serves as the XML tag name. */
    readonly id: string;
    /** One-line description surfaced to the model in the catalog prompt. */
    readonly description: string;
    /**
     * Human-readable schema for the args, printed inline in the catalog
     * (e.g., `entity_name`, `url`, `wiki_subdomain:query`). Free-form —
     * this is documentation for the model, not a parsed type.
     */
    readonly argSchema: string;
    /**
     * Hard cap on the result length, in approximate tokens (chars / 4).
     * The tool-loop truncates beyond this to protect the model's context
     * budget. Pick conservatively — fetched web pages can be huge.
     */
    readonly maxResultTokens: number;
    /**
     * Whether the tool makes a network request. Consumers (e.g., the
     * Lorebook Coach in PR C2) use this to filter the registry against
     * the `lorebookNetworkTools` setting.
     */
    readonly requiresNetwork: boolean;
    /**
     * Execute the tool and return its result as a string for the model.
     * Throw on unrecoverable errors — the loop catches and surfaces them
     * to the model as `<tool_result>` error text, so the model can recover.
     *
     * @param args  The raw text between the opening and closing tags, trimmed.
     * @param ctx   Runtime context (plugin, abort signal, etc.).
     */
    execute(args: string, ctx: ToolContext): Promise<string>;
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
 * A complete tool invocation extracted from the model's stream.
 * The parser queues these; the tool-loop drains and executes them after
 * each completion round.
 */
export interface ToolInvocation {
    readonly toolId: string;
    readonly args: string;
}

/**
 * Registry of available tools. Tools are registered once at session start
 * (filtered by settings — e.g., network tools only when `lorebookNetworkTools`
 * is on), then the same registry instance is reused for every generation
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
     * Render the catalog as a prompt-instruction string appended to the
     * system prompt so the model knows which tags it may emit and what
     * each one does. Returns an empty string when the registry is empty
     * so callers can unconditionally concatenate.
     */
    renderCatalog(): string {
        const tools = this.list();
        if (tools.length === 0) return '';

        const lines = tools.map((t) => `- <${t.id}>${t.argSchema}</${t.id}> — ${t.description}`);
        return [
            '',
            '## Tools',
            '',
            'You have access to the following tools. To call one, emit its opening tag,',
            'the arguments, then the closing tag — all on the same line or across lines.',
            'The system will execute the tool and reply with a',
            '<tool_result tool="...">...</tool_result> block. Continue your response',
            'after each result. You may call multiple tools in a single response.',
            '',
            'Examples:',
            '  <manuscript_mentions>Sarah Connor</manuscript_mentions>',
            '  <lore_siblings>character</lore_siblings>',
            '',
            'Available tools:',
            ...lines
        ].join('\n');
    }
}
