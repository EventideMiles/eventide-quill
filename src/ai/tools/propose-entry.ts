import { parseLoreType } from '../../core/dashboard/lorebook-scanner';
import type { Tool, ToolContext } from './tool';

/**
 * Propose a lore entry draft for the writer to review and save. Call this
 * tool when you have enough information to draft a complete entry; the
 * writer will see the draft as a review card and may request refinements
 * or discard it.
 *
 * The draft does NOT save automatically. The writer must click "Save as
 * note" to write it to the vault. You may continue the conversation after
 * proposing — e.g., note open questions or offer alternative framings.
 *
 * This is the only mechanism by which the Lorebook Coach surfaces a draft.
 * Do not emit draft content as plain markdown in your response — it won't
 * be detected. Always use this tool.
 *
 * Side effects of execution:
 *   - Writes the draft to `plugin.coWriterSession.currentLoreDraft`.
 *   - Updates `loreCoachSession.entryType` and advances phase to `'refine'`.
 *   - Fires `onLoreDraftReady` so the panel renders the review card.
 *
 * Returns a confirmation string to the model.
 */
export const proposeEntryTool: Tool = {
    id: 'propose_entry',
    description:
        'Propose a lore entry draft for the writer to review. Call this when ' +
        'you are ready to draft a complete entry. The writer sees the draft ' +
        'as a review card and can save it as a note, request changes, or ' +
        'discard it. Do not write draft content as plain markdown — always ' +
        'use this tool to surface a draft.',
    parameters: {
        type: 'object',
        properties: {
            entry_type: {
                type: 'string',
                enum: ['character', 'location', 'event', 'item', 'faction', 'plot-thread', 'theme'],
                description: 'The lore entry type. Omit if no type applies.'
            },
            name: {
                type: 'string',
                description: 'Display name for the entry (also used as the proposed filename).'
            },
            content: {
                type: 'string',
                description:
                    'Markdown body of the entry — headings, lists, paragraphs. ' +
                    'Do NOT include frontmatter; the system adds `quill-type` at save time.'
            }
        },
        required: ['name', 'content']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        const typeRaw = typeof args.entry_type === 'string' ? args.entry_type : '';

        if (!name) {
            return 'Error: "name" is required.';
        }
        if (!content) {
            return 'Error: "content" is required.';
        }

        const parsed = parseLoreType(typeRaw);
        const entryType = parsed === 'untyped' ? null : parsed;

        // Construct and stash the draft on the session. The coach reads
        // currentLoreDraft after this tool returns and attaches it to the
        // round's chat message + fires onLoreDraftReady. Side-effecting ONLY
        // the data (not firing chat/panel callbacks) avoids corrupting the
        // streaming display mid-round.
        ctx.plugin.coWriterSession.currentLoreDraft = { name, entryType, content };

        const typeLabel = entryType ?? 'untyped';
        return `Draft received: "${name}" (${typeLabel}). The writer will review it. Continue with follow-up notes or wait for their feedback.`;
    }
};
