import { TFile } from 'obsidian';
import type { ProposedImage } from '../../core/dashboard/lorebook-types';
import type { Tool, ToolContext } from './tool';

/**
 * Propose attaching a reference image to an existing lore entry. Use when
 * the entry already exists (so `propose_entry` is wrong) and you have an
 * image worth attaching — typically one you fetched via `fandom_image`,
 * `wikipedia_image`, or `fetch_image_url`. The image flows into the
 * existing-entry review queue alongside text edits; the writer approves
 * or rejects it like any other proposed edit.
 *
 * Side effects of execution:
 *   - Adds the proposed image to `plugin.coWriterSession.proposedLoreImages`
 *     under the target file path.
 *   - Fires `onProposedLoreImagesUpdate` so the panel renders the card.
 *
 * On approval: the bytes are written to the vault attachments folder and
 * the matching `![[file]]` embed is inserted into the entry's gallery
 * section under `label` (created if missing). On rejection: the bytes are
 * dropped without ever touching the vault.
 *
 * Only registered when `loreEntryImageAttachments` is on AND the caller is
 * the lorebook coach (or a `run_lorebook_batch` subagent).
 */
export const attachLoreImageTool: Tool = {
    id: 'attach_lore_image',
    description:
        'Propose attaching a reference image to an existing lore entry. Pass ' +
        'the entry path, a label (subheading for the gallery section, e.g., ' +
        '"Alternate form"), a suggested attachment filename, and the image as ' +
        'base64 JPEG bytes (no data: prefix). The writer reviews every ' +
        'attachment before it is written. Use for entries that already exist ' +
        'where `propose_entry` would be wrong.',
    parameters: {
        type: 'object',
        properties: {
            entry_path: {
                type: 'string',
                description:
                    'Vault-relative path to the lore note (e.g., "Lore/Characters/Sarah Connor.md"). ' +
                    'Must point at an existing note in a configured lorebook folder.'
            },
            label: {
                type: 'string',
                description:
                    'Subheading under the gallery section where the image embed will be placed ' +
                    '(e.g., "Default form", "Alternate form"). Created if missing.'
            },
            suggested_filename: {
                type: 'string',
                description: 'Vault attachment filename for the bytes, e.g., "freddy-lupin-human.png".'
            },
            base64: {
                type: 'string',
                description: 'Downscaled JPEG bytes as base64, no data: prefix.'
            },
            caption: {
                type: 'string',
                description: 'Optional caption for the ![[file|caption]] slot.'
            }
        },
        required: ['entry_path', 'label', 'suggested_filename', 'base64']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const entryPath = typeof args.entry_path === 'string' ? args.entry_path.trim() : '';
        const label = typeof args.label === 'string' ? args.label.trim() : '';
        const suggestedFilename = typeof args.suggested_filename === 'string' ? args.suggested_filename.trim() : '';
        const base64 = typeof args.base64 === 'string' ? args.base64.trim() : '';
        const captionRaw = typeof args.caption === 'string' ? args.caption.trim() : '';

        if (!entryPath) return 'Error: "entry_path" is required.';
        if (!label) return 'Error: "label" is required (the subheading the image sits under).';
        if (!suggestedFilename) return 'Error: "suggested_filename" is required.';
        if (!base64) return 'Error: "base64" is required (downscaled JPEG bytes, no data: prefix).';

        // Resolve the file in the vault — fail fast with a clear message if
        // the model invented or mistyped a path.
        const file = ctx.plugin.app.vault.getAbstractFileByPath(entryPath);
        if (!(file instanceof TFile)) {
            return `Error: no note found at "${entryPath}". Pass the vault-relative path to an existing lore note.`;
        }

        const caption = captionRaw.length > 0 ? captionRaw : undefined;
        const image: ProposedImage = { label, suggestedFilename, base64, caption };

        // Stage on the session — the panel picks this up via the callback and
        // renders an attachment review card. The bytes are held in memory
        // until the writer approves; nothing is written to disk here.
        const entry = ctx.plugin.coWriterSession.getOrCreateProposedLoreImages(file.path, file.basename);
        entry.images.push(image);
        ctx.plugin.coWriterSession.onProposedLoreImagesUpdate?.();

        return `Image attachment queued for "${file.basename}" under label "${label}" (${entry.images.length} total pending for this entry). The writer will review it.`;
    }
};
