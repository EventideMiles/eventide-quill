import type { Tool, ToolContext } from './tool';

/**
 * Spawn an isolated continuity subagent to audit a set of manuscript chapters
 * for continuity problems — contradictions, timeline gaps, character-
 * consistency breaks, worldbuilding conflicts. The subagent reads the given
 * chapters (and pulls in lorebook entries as needed) in its OWN fresh context
 * and returns a cited findings report. This conversation is blocked while it
 * runs (a local model cannot do two things at once).
 *
 * The parent supplies the chapter paths (it knows the manuscript). A
 * continuity audit is cross-chapter by nature, so the chapters are NOT chunked
 * — the subagent reads them together (with compaction for very large sets).
 */
export const runContinuityAuditTool: Tool = {
    id: 'run_continuity_audit',
    description:
        'Spawn an isolated continuity subagent to audit manuscript chapters for continuity ' +
        'problems (contradictions, timeline gaps, character-consistency breaks, worldbuilding ' +
        'conflicts). The subagent reads the given chapters plus relevant lorebook entries in ' +
        'its OWN fresh context and returns a cited findings report ranked by severity. Pass the ' +
        'chapter paths (the manuscript) and an optional focus. This conversation is blocked ' +
        'while it runs. Use this when you want a dedicated continuity pass, not a quick inline check.',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Manuscript chapter paths (or note names) to audit, in story order if possible.'
            },
            focus: {
                type: 'string',
                description:
                    'Optional — what to focus on (e.g., "timeline", "Sarah\'s characterization", "magic rules"). Omit to audit generally.'
            }
        },
        required: ['paths']
    },
    maxResultTokens: 800,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const rawPaths = args.paths;
        const focus = typeof args.focus === 'string' ? args.focus.trim() : '';
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
            return 'Error: "paths" must be a non-empty array of chapter paths.';
        }
        const paths = (rawPaths as unknown[])
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim());
        if (paths.length === 0) return 'Error: "paths" must contain at least one non-empty path.';

        const { plugin } = ctx;
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) return 'Error: no AI provider configured. Set one up in settings.';
        if (!chat.modelId) return 'Error: no chat model configured. Set a default chat model in settings.';

        return plugin.coWriterSession.runContinuityAudit(plugin, chat.provider, chat.modelId, paths, focus, ctx.signal);
    }
};
