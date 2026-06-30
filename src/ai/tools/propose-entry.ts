import { parseLoreType } from '../../core/dashboard/lorebook-scanner';
import type { ProposedImage } from '../../core/dashboard/lorebook-types';
import type { Tool, ToolContext } from './tool';

/**
 * Pull and validate the `images` argument when the toggle is on. Each item
 * must provide EITHER `base64` (direct bytes — rare; the model rarely has
 * them as a string) OR `from_recent: { index }` (reference to a recent
 * image the model has seen via fandom_image / wikipedia_image /
 * fetch_image_url / get_lore_image, or one the writer pasted). Resolves
 * `from_recent` against the session's recent-images buffer. Returns `null`
 * if the argument is absent or every entry fails validation.
 */
function parseProposedImages(raw: unknown, ctx: ToolContext): ProposedImage[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out: ProposedImage[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const label = typeof obj.label === 'string' ? obj.label.trim() : '';
        const suggestedFilename = typeof obj.suggestedFilename === 'string' ? obj.suggestedFilename.trim() : '';
        if (!suggestedFilename) continue;
        const caption = typeof obj.caption === 'string' ? obj.caption.trim() : undefined;

        // Resolve bytes: prefer explicit base64, fall back to from_recent reference.
        let base64: string | undefined;
        if (typeof obj.base64 === 'string' && obj.base64.trim().length > 0) {
            base64 = obj.base64.trim();
        } else if (obj.from_recent && typeof obj.from_recent === 'object') {
            const idxRaw = (obj.from_recent as Record<string, unknown>).index;
            if (typeof idxRaw === 'number' && Number.isFinite(idxRaw)) {
                const resolved = ctx.plugin.coWriterSession.resolveRecentImage(Math.floor(idxRaw));
                if (resolved === null) continue; // index out of range — drop
                base64 = resolved;
            }
        }
        if (!base64) continue;

        out.push({
            label,
            suggestedFilename,
            base64,
            caption: caption && caption.length > 0 ? caption : undefined
        });
    }
    return out.length > 0 ? out : null;
}

/**
 * Factory: create the `propose_entry` tool.
 *
 * Proposes a lore entry draft for the writer to review and save. Call this
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
 * When `allowImages` is true, the tool's JSON Schema also includes an
 * optional `images` parameter (one or more downscaled base64 JPEGs with a
 * suggested filename + label). Each proposed image flows into the same
 * review queue as the text draft and is written to the vault attachments
 * folder only when the writer approves — never silently. When `allowImages`
 * is false, the parameter is absent from the schema entirely so the model
 * cannot attempt it.
 *
 * Side effects of execution:
 *   - Writes the draft to `plugin.coWriterSession.currentLoreDraft`.
 *   - Updates `loreCoachSession.entryType` and advances phase to `'refine'`.
 *   - Fires `onLoreDraftReady` so the panel renders the review card.
 *
 * Returns a confirmation string to the model.
 */
export function createProposeEntryTool(allowImages: boolean): Tool {
    const imageProperty = allowImages
        ? {
              images: {
                  type: 'array',
                  description:
                      'Optional reference images to attach to the entry. Each item needs: ' +
                      '`label` (subheading under the gallery section, e.g., "Default form"), ' +
                      '`suggestedFilename` (vault attachment filename, e.g., "sarah-connor-default.png"), ' +
                      'and EITHER `base64` (downscaled JPEG bytes, no data: prefix — rare; you ' +
                      'usually do not have these as a string) OR `from_recent: { index }` to ' +
                      'reference an image you have already seen. `from_recent.index` is 0-based ' +
                      'with 0 = most recent image (from fandom_image / wikipedia_image / ' +
                      'fetch_image_url / get_lore_image, OR one the writer pasted in chat). ' +
                      'Optional `caption`. Place matching ![[suggestedFilename]] embeds in the ' +
                      'content body under a gallery section heading (e.g., "## Reference"). ' +
                      'The writer reviews every image before it is written to the vault.'
              }
          }
        : {};

    return {
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
                },
                ...imageProperty
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

            // The images parameter only exists in the schema when the toggle
            // is on, but parse defensively — the model could hallucinate the
            // field anyway. parseProposedImages drops malformed entries and
            // returns null for empty/absent, so this is a safe no-op then.
            const proposedImages = allowImages ? parseProposedImages(args.images, ctx) : null;

            // Construct and stash the draft on the session. The coach reads
            // currentLoreDraft after this tool returns and attaches it to the
            // round's chat message + fires onLoreDraftReady. Side-effecting ONLY
            // the data (not firing chat/panel callbacks) avoids corrupting the
            // streaming display mid-round.
            ctx.plugin.coWriterSession.currentLoreDraft = {
                name,
                entryType,
                content,
                proposedImages: proposedImages ?? undefined
            };

            const typeLabel = entryType ?? 'untyped';
            const imgCount = proposedImages
                ? ` with ${proposedImages.length} image${proposedImages.length === 1 ? '' : 's'}`
                : '';
            return `Draft received: "${name}" (${typeLabel})${imgCount}. The writer will review it. Continue with follow-up notes or wait for their feedback.`;
        }
    };
}
