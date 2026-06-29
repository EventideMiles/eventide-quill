import type { Tool, ToolContext } from './tool';

/**
 * Spawn an isolated research subagent to investigate the vault and answer a
 * question. The subagent runs read-only tools (grep_notes, vault_lookup,
 * lore_siblings, manuscript_mentions, sizing) in its OWN fresh context and
 * returns a cited findings report — so a broad search doesn't dump a dozen
 * file reads into this (the parent) conversation. This conversation is blocked
 * while the subagent runs (a local model cannot do two things at once).
 *
 * Reserve this for BROAD research (a question that spans many notes / needs
 * synthesis). A quick single-file lookup should use `vault_lookup` or
 * `grep_notes` inline.
 */
export const runResearchTool: Tool = {
    id: 'run_research',
    description:
        'Spawn an isolated research subagent to investigate the vault and answer a question. ' +
        'The subagent runs read-only tools (grep_notes, vault_lookup, lore_siblings, ' +
        'manuscript_mentions) in its OWN fresh context and returns a cited findings report, ' +
        'so a broad search does NOT dump many file reads into this conversation. When the ' +
        'writer has network tools enabled, it can also compare vault entries against external ' +
        'media (fetch_url, Wikipedia, Fandom). Use this for BROAD research that spans many ' +
        'notes or needs synthesis (e.g., "what do I establish about the magic system across ' +
        'all chapters?", "does my Victorian London match history?"). For a quick single-note ' +
        'lookup, use vault_lookup or grep_notes inline instead. The subagent does NOT see this ' +
        'conversation, so put the full question in `question`. This conversation is blocked ' +
        'while it runs.',
    parameters: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: 'The question to investigate in the vault. Self-contained — the subagent sees only this.'
            }
        },
        required: ['question']
    },
    maxResultTokens: 600,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) return 'Error: "question" is required.';

        const { plugin } = ctx;
        const chat = plugin.getDefaultChatProvider();
        if (!chat.provider) return 'Error: no AI provider configured. Set one up in settings.';
        if (!chat.modelId) return 'Error: no chat model configured. Set a default chat model in settings.';

        return plugin.coWriterSession.runResearch(plugin, chat.provider, chat.modelId, question, ctx.signal);
    }
};
