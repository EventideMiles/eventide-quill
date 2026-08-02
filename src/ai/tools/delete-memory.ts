import { Notice } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { findEntryAcrossScopes, removeMemoryEntry } from '../../core/memories/memory-store';

/**
 * The `delete_memory` tool — removes a memory section by block ID. Per the
 * design contract, deletes are SILENT and DESTRUCTIVE: the writer may not
 * have seen the memory yet. So even when `memoriesAutoSave` is on (which
 * lets `save_memory` land without review), `delete_memory` always stages
 * through the review queue.
 *
 * PHASE 4 NOTE: the review-queue integration lands in Phase 8. For now,
 * this tool performs the delete directly with a prominent Notice ("Quill:
 * deleted memory '<heading>'") so the writer sees that a deletion happened
 * and can undo via Obsidian's file recovery if needed. Phase 8 will replace
 * the direct delete with a review-card staging flow.
 *
 * The ID-based targeting makes deletes unambiguous — `save_memory` returns
 * the minted block ID in its confirmation, and `recall_memory` shows IDs
 * alongside each entry, so the model has the handle it needs.
 *
 * Errors gracefully when the ID isn't found (writer may have deleted the
 * memory manually in the markdown).
 */
export const deleteMemoryTool: Tool = {
    id: 'delete_memory',
    description:
        'Remove a memory by its block ID. The ID has the form `quill-mem-NNN` ' +
        'and is shown by `recall_memory` next to each entry, and in the ' +
        'confirmation message from `save_memory`. ONLY call this when the ' +
        'writer explicitly asks to forget a memory — never delete ' +
        'speculatively. Deletes are surfaced prominently so the writer ' +
        'notices and can recover via Obsidian\'s file recovery if needed.',
    parameters: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description:
                    'The block ID of the memory to delete (e.g., ' +
                    '`quill-mem-003`). Get this from `recall_memory` or from ' +
                    'the `save_memory` confirmation message.'
            }
        },
        required: ['id']
    },
    maxResultTokens: 150,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) {
            return 'Error: "id" is required (e.g., "quill-mem-003").';
        }
        const normalizedId = id.replace(/^\^/, ''); // tolerate a leading caret
        const { plugin } = ctx;
        if (!plugin.settings.memoriesEnabled) {
            return 'Error: memories are disabled in settings.';
        }

        const found = await findEntryAcrossScopes(plugin, normalizedId);
        if (!found) {
            return (
                `No memory with id "${normalizedId}" was found. It may have ` +
                `been deleted manually in the file, or the id is wrong. Call ` +
                `\`recall_memory\` to list current IDs.`
            );
        }

        // Phase 4: direct delete. Phase 8 will stage this through the review queue.
        // removeMemoryEntry preserves the file's title and intro.
        await removeMemoryEntry(plugin, found.scopeKey, found.entry.id);

        new Notice(`Quill: deleted memory — "${found.entry.heading}"`);

        return (
            `Deleted memory "${found.entry.heading}" (id: ${found.entry.id}). ` +
            `The writer can recover the text from Obsidian's file recovery if needed.`
        );
    }
};
