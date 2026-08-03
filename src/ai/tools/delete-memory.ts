import { Notice } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { findEntryAcrossScopes, removeMemoryEntry } from '../../core/memories/memory-store';
import { confirmMemoryAction } from '../../core/memories/memory-confirm';

/**
 * The `delete_memory` tool — removes a memory section by block ID. Per the
 * design contract, deletes are SILENT and DESTRUCTIVE: the writer may not
 * have seen the memory yet. So even when `memoriesAutoSave` is on (which
 * lets `save_memory` land without review), `delete_memory` always shows a
 * confirmation modal so the writer explicitly approves the deletion.
 *
 * The model's tool call awaits the writer's choice. If the writer confirms,
 * the delete proceeds and the tool returns success. If the writer cancels,
 * the tool returns "delete cancelled" — the model should accept that and
 * not retry without an explicit writer instruction.
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

        // Show a confirmation modal — deletes always require explicit writer
        // approval regardless of the memoriesAutoSave toggle (silent
        // destructive ops are too risky to auto-apply). The model's tool call
        // awaits the writer's choice.
        const bodyPreview =
            found.entry.body.length > 200
                ? `${found.entry.body.slice(0, 200).trimEnd()}…`
                : found.entry.body;
        const messageLines = [
            `"${found.entry.heading}" (id: ${found.entry.id})`,
            '',
            bodyPreview || '(no body)',
            '',
            'The deleted text can be recovered from Obsidian\'s file recovery if needed.'
        ];
        const confirmed = await confirmMemoryAction(
            plugin.app,
            'Delete this memory?',
            messageLines.join('\n'),
            'Delete'
        );
        if (!confirmed) {
            return `Delete cancelled by the writer — "${found.entry.heading}" was NOT removed.`;
        }

        // removeMemoryEntry preserves the file's title and intro. It returns
        // false when the ID was missing (e.g. the writer deleted the section
        // manually in the markdown between our find and remove calls).
        const removed = await removeMemoryEntry(plugin, found.scopeKey, found.entry.id);
        if (!removed) {
            return (
                `Memory "${found.entry.heading}" (id: ${found.entry.id}) was no longer present in ` +
                `the file — the writer may have deleted the section manually. No changes made.`
            );
        }

        new Notice(`Quill: deleted memory — "${found.entry.heading}"`);

        return (
            `Deleted memory "${found.entry.heading}" (id: ${found.entry.id}). ` +
            `The writer approved the deletion.`
        );
    }
};
