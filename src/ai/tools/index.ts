import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { editNoteTool } from './edit-note';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { measureFolderTool } from './measure-folder';
import { proposeEntryTool } from './propose-entry';
import { vaultLookupTool } from './vault-lookup';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext } from './tool';
export { streamWithTools } from './tool-loop';
export { appendToNoteTool } from './append-to-note';
export { editNoteTool } from './edit-note';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { measureFolderTool } from './measure-folder';
export { proposeEntryTool } from './propose-entry';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the six internal-only tools:
 * `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `edit_note`,
 * `append_to_note`, and `measure_folder`.
 */
export function createInternalToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(manuscriptMentionsTool);
    registry.register(loreSiblingsTool);
    registry.register(vaultLookupTool);
    registry.register(editNoteTool);
    registry.register(appendToNoteTool);
    registry.register(measureFolderTool);
    return registry;
}

/**
 * Build a registry for the Lorebook Coach: the five internal tools plus
 * `propose_entry` (which surfaces a draft to the UI for review).
 */
export function createLoreCoachToolRegistry(): ToolRegistry {
    const registry = createInternalToolRegistry();
    registry.register(proposeEntryTool);
    return registry;
}
