import type { Tool, ToolContext } from './tool';

/**
 * Spawn an isolated subagent to batch-edit a set of existing lore notes. The
 * subagent runs the lorebook edit loop (`vault_lookup` → `edit_note` /
 * `insert_note` / `append_to_note`, `revise_edit` on overlaps) in its OWN fresh
 * context and returns only a short summary — so the many tool rounds do NOT
 * pile into this (the parent) conversation. The writer still reviews every
 * produced diff in the shared review queue, exactly like an inline edit. While
 * the subagent runs, this conversation is blocked (intentional — local models
 * can't run concurrent inference, and the subagent runs as a synchronous tool
 * call).
 *
 * Division of labor: the PARENT decides the batch — call `measure_folder` /
 * `calculate_file_sizes` first to see what fits the REMAINING context, then
 * hand the selected file list to this tool. The subagent only executes the
 * edits on the files you give it.
 *
 * Reserve this for genuine BATCHES (several files at once). A single quick
 * edit should be done inline with `edit_note` / `insert_note` instead.
 */
export const runLorebookBatchTool: Tool = {
    id: 'run_lorebook_batch',
    description:
        'Spawn an isolated subagent to batch-edit a set of existing lore notes. The subagent runs ' +
        'the edit loop (vault_lookup → edit_note / insert_note / append_to_note, revise_edit on ' +
        'overlaps) in its OWN fresh context and returns only a short summary of what it changed, ' +
        'keeping the tool rounds out of this conversation. Pass the goal plus the FULL ' +
        "file list — the tool sizes and chunks the batch against the subagent's own fresh context " +
        "(this conversation's remaining context is irrelevant), so hand it the full list and leave " +
        'the splitting to the tool. Every produced diff lands in the shared review queue and stays ' +
        'there for the writer to approve after the subagent closes. Use this for a BATCH (several ' +
        'files); for a single quick edit, do it inline with edit_note / insert_note. This ' +
        'conversation is blocked while the subagent runs (a local model handles one inference at a time).',
    parameters: {
        type: 'object',
        properties: {
            goal: {
                type: 'string',
                description:
                    'What the subagent should do with these files — the task brief. Be specific; it ' +
                    'drives every edit decision and the subagent does NOT see this conversation.'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'The vault-relative paths or note names in this batch. The subagent edits only these.'
            }
        },
        required: ['goal', 'paths']
    },
    maxResultTokens: 400,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
        const rawPaths = args.paths;

        if (!goal) return 'Error: "goal" is required.';
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
            return 'Error: "paths" must be a non-empty array of file paths.';
        }
        const paths = (rawPaths as unknown[])
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim());
        if (paths.length === 0) return 'Error: "paths" must contain at least one non-empty path.';

        const { plugin } = ctx;
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) return 'Error: no AI provider configured. Set one up in settings.';
        if (!chat.modelId) return 'Error: no chat model configured. Set a default chat model in settings.';

        // Spawns + registers + runs the subagent on the session, returning its
        // summary. Tool-result string becomes what THIS conversation sees.
        return plugin.coWriterSession.runLorebookBatch(plugin, chat.provider, chat.modelId, goal, paths, ctx.signal);
    }
};
