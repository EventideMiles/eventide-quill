import { type AiProvider, type ChatMessage, type ToolCallRequest } from './provider';
import type EventideQuillPlugin from '../main';
import { getLoreCoachSystemPrompt } from './prompts';
import { compactConversation } from './compaction';
import { estimateTokens } from '../utils/tokens';
import { createToolRegistry, type ToolContext, type ToolRegistry, type ToolResult } from './tools';
import { injectImagesIntoMessages } from './vision';

/** Lifecycle states for a subagent batch, surfaced in the drill-down UI (stage 2). */
export type SubagentStatus = 'running' | 'succeeded' | 'failed';

/** A display frame for the drill-down view (mirrors the parent's chat-history shape). */
export interface SubagentChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    thought?: string;
    toolUses?: { name: string; argsSummary: string }[];
}

/**
 * A serializable snapshot of a subagent's viewable state — what the co-writer
 * panel renders (status card + drill-down conversation). Plain data by design
 * (no live handles) so it can flow through the sidebar/main push paths and,
 * later, persist (`.planning/pr-conversation-persistence.md`).
 */
export interface SubagentView {
    id: string;
    goal: string;
    status: SubagentStatus;
    summary: string | null;
    error: string | null;
    pathCount: number;
    chatHistory: SubagentChatMessage[];
}

/**
 * A self-contained lorebook batch editor that runs in its OWN fresh context,
 * isolated from the parent conversation. The parent co-writer loop spawns one
 * via the `run_lorebook_batch` tool when a batch edit would otherwise bloat
 * the main conversation: the subagent does the `vault_lookup` → `edit_note`
 * rounds in an ephemeral context and returns only a short summary, so the
 * parent stays lean. This is the local-model-friendly subagent pattern — the
 * subagent is the same model on the same provider, serialized (never
 * concurrent with the parent), and its bloated prefix is discarded on finish.
 *
 * Edits are NOT isolated: they flow through `plugin.coWriterSession` (the same
 * review queue the parent uses) via the tools' side effects, so a subagent-
 * produced diff reviews exactly like an inline one. Only the CONVERSATION is
 * per-subagent ({@link messages} / {@link chatHistory}).
 *
 * Stage 1 (this class): runs end-to-end with no new UI — from the parent's
 * side a subagent just looks like a long-running tool call with a richer
 * result string. The registry + chatHistory here are the substrate the
 * stage-2 drill-down UI will render. State is kept as plain serializable data
 * (no live editor handles / abort controllers mixed in) so the deferred
 * conversation-persistence feature (`.planning/pr-conversation-persistence.md`)
 * can layer on later without a refactor.
 */
export class SubagentSession {
    readonly id: string;
    readonly goal: string;
    readonly paths: string[];
    status: SubagentStatus = 'running';
    /** Short result string returned to the parent (set on completion). */
    summary: string | null = null;
    /** Failure reason when {@link status} === 'failed'. */
    error: string | null = null;

    /** API-level messages (fresh context: system prompt + turns + tool results). */
    messages: ChatMessage[] = [];
    /** Display buffer for the stage-2 drill-down view. */
    chatHistory: SubagentChatMessage[] = [];

    /** UI callbacks (stage 2). Unused in stage 1 but already fired so the runner reports to the right places. */
    onChatUpdate: (() => void) | null = null;
    onStatusChange: (() => void) | null = null;

    private toolTokenOverhead = 0;

    private static nextId = 0;

    constructor(
        private readonly plugin: EventideQuillPlugin,
        private readonly provider: AiProvider,
        private readonly modelId: string,
        goal: string,
        paths: string[],
        private readonly parentSignal?: AbortSignal
    ) {
        this.id = `subagent_${++SubagentSession.nextId}`;
        this.goal = goal;
        this.paths = paths;
    }

    /**
     * Run the batch to completion. Returns the summary string the parent tool
     * surfaces. Rethrows `AbortError` so the parent's cancel path cleans up;
     * other failures are captured into {@link error} + a failure summary so the
     * parent model can react without the whole conversation failing.
     */
    async run(): Promise<string> {
        // The subagent edits existing files — internal tools only, NO
        // run_lorebook_batch (so a subagent cannot spawn sub-subagents:
        // single-level nesting by construction) and NO propose_entry.
        const registry = createToolRegistry(this.plugin, false);
        if (!registry) {
            return this.fail('Co-writer tools are disabled, so the subagent has no editing tools.');
        }
        const toolDefs = registry.toToolDefinitions();
        this.toolTokenOverhead = registry.estimateTokens();

        // Fresh context: lorebook system prompt + the parent's task brief. The
        // subagent sees ONLY this — not the parent's conversation.
        const fileList =
            this.paths.length > 0
                ? `\n\nFiles in this batch (${this.paths.length}):\n${this.paths.map((p) => `- ${p}`).join('\n')}`
                : '';
        const brief = `Task: ${this.goal}${fileList}\n\nEdit the files in this batch per the rules above. vault_lookup each file, then edit_note / insert_note / append_to_note (revise_edit if you hit an overlap). Keep each edit surgical. End with a one- or two-line summary of what you changed.`;
        this.messages = [
            { role: 'system', content: getLoreCoachSystemPrompt() },
            { role: 'user', content: brief }
        ];
        this.chatHistory = [{ role: 'user', content: brief }];

        const maxTokens = this.provider.config.maxContextTokens;
        const compactPct = Math.max(50, Math.min(95, this.plugin.settings.contextCompactAtPercent)) / 100;
        const maxRounds =
            this.plugin.settings.coWriterMaxToolRounds > 0 ? this.plugin.settings.coWriterMaxToolRounds : Infinity;
        const ctx: ToolContext = {
            plugin: this.plugin,
            signal: this.parentSignal,
            consumedTokens: () => this.requestTokens()
        };

        let lastResponse = '';
        try {
            for (let round = 0; round < maxRounds; round++) {
                if (this.parentSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

                const stream = this.provider.chatCompletion({
                    messages: this.messages,
                    model: this.modelId,
                    temperature: 0.7,
                    maxTokens: this.plugin.settings.coWriterMaxOutputTokens,
                    signal: this.parentSignal,
                    tools: toolDefs,
                    toolChoice: 'auto'
                });

                let response = '';
                let thought = '';
                const fragmentBuffer = new Map<number, { id?: string; name?: string; arguments: string }>();
                for await (const chunk of stream) {
                    if (chunk.done) break;
                    if (chunk.thought) thought += chunk.thought;
                    if (chunk.text) response += chunk.text;
                    if (chunk.toolCalls) {
                        for (const frag of chunk.toolCalls) {
                            const existing = fragmentBuffer.get(frag.index);
                            if (existing) {
                                if (frag.id !== undefined) existing.id = frag.id;
                                if (frag.name !== undefined) existing.name = frag.name;
                                if (frag.arguments !== undefined) existing.arguments += frag.arguments;
                            } else {
                                fragmentBuffer.set(frag.index, {
                                    id: frag.id,
                                    name: frag.name,
                                    arguments: frag.arguments ?? ''
                                });
                            }
                        }
                    }
                }

                const toolCalls = [...fragmentBuffer.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([idx, acc]) => ({
                        id: acc.id ?? `call_${idx}`,
                        name: acc.name ?? '',
                        arguments: acc.arguments
                    }));

                // API message + display frame for this assistant turn.
                this.messages.push({
                    role: 'assistant',
                    content: response,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
                });
                this.chatHistory.push({
                    role: 'assistant',
                    content: response,
                    thought: thought || undefined,
                    toolUses:
                        toolCalls.length > 0
                            ? toolCalls.map((c) => ({ name: c.name, argsSummary: summarizeArgs(c.arguments) }))
                            : undefined
                });
                lastResponse = response;

                // No tools called → this round is final.
                if (toolCalls.length === 0) break;

                // Execute tools; results land in both the API messages and the
                // display buffer. Edits flow to the shared review queue via the
                // tools' side effects (plugin.coWriterSession).
                const collectedImages: string[] = [];
                for (const call of toolCalls) {
                    const result = await this.executeToolCall(call, registry, ctx);
                    this.messages.push({ role: 'tool', content: result.text, toolCallId: call.id, name: call.name });
                    this.chatHistory.push({ role: 'tool', content: result.text });
                    if (result.images && result.images.length > 0) collectedImages.push(...result.images);
                }
                await injectImagesIntoMessages(this.plugin, collectedImages, this.messages, this.parentSignal);

                // Mid-loop compaction: keep the dedicated context under budget.
                if (this.requestTokens() / maxTokens >= compactPct) {
                    const sc = Math.max(1, Math.min(20, this.plugin.settings.compactSummarySentences));
                    try {
                        const cResult = await compactConversation(this.provider, this.messages, sc, {
                            signal: this.parentSignal
                        });
                        if (cResult) this.messages = cResult.messages;
                    } catch (compErr: unknown) {
                        // Propagate aborts; a plain compaction failure is non-fatal.
                        if (compErr instanceof Error && compErr.name === 'AbortError') throw compErr;
                        console.warn('Quill: Subagent compaction failed; continuing.', compErr);
                    }
                }

                this.onChatUpdate?.();
            }

            this.status = 'succeeded';
            this.summary = lastResponse.trim() || `Batch complete: processed ${this.paths.length} file(s).`;
            this.onStatusChange?.();
            return this.summary;
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.status = 'failed';
                this.error = 'aborted';
                this.onStatusChange?.();
                throw err; // let the parent's cancel cleanup run
            }
            const msg = err instanceof Error ? err.message : String(err);
            return this.fail(`Subagent failed: ${msg}`);
        }
    }

    /** Snapshot of this subagent's viewable state for the panel. */
    toView(): SubagentView {
        return {
            id: this.id,
            goal: this.goal,
            status: this.status,
            summary: this.summary,
            error: this.error,
            pathCount: this.paths.length,
            chatHistory: this.chatHistory
        };
    }

    /** Current request token estimate (conversation + tools-field overhead). */
    private requestTokens(): number {
        return estimateTokens(this.messages) + this.toolTokenOverhead;
    }

    /**
     * Execute one tool call: JSON-arg parsing, error containment, truncation.
     * Mirrors the parent loops' `executeToolCallSafely` semantics — aborts
     * propagate, other failures surface to the model as an error string. The
     * overlap guard and revise_edit logic live inside the tools themselves, so
     * they apply uniformly here.
     */
    private async executeToolCall(
        call: ToolCallRequest,
        registry: ToolRegistry,
        ctx: ToolContext
    ): Promise<ToolResult> {
        const tool = registry.get(call.name);
        if (!tool) return { text: `Error: tool "${call.name}" is not registered.` };

        let parsedArgs: Record<string, unknown>;
        try {
            parsedArgs =
                call.arguments.trim().length === 0 ? {} : (JSON.parse(call.arguments) as Record<string, unknown>);
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

    private fail(reason: string): string {
        this.status = 'failed';
        this.error = reason;
        this.summary = reason;
        this.onStatusChange?.();
        return reason;
    }
}

/** Minimal arg summarizer for the drill-down display (stage 2). */
function summarizeArgs(argumentsJson: string): string {
    try {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        const path = typeof args.path === 'string' ? args.path : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const out = [path, name].filter(Boolean).join(' · ');
        return out || argumentsJson.slice(0, 60);
    } catch {
        return argumentsJson.slice(0, 60);
    }
}
