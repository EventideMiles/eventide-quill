import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { calculateFileSizesTool } from './calculate-file-sizes';
import { editNoteTool } from './edit-note';
import { grepNotesTool } from './grep-notes';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { measureFolderTool } from './measure-folder';
import { proposeEntryTool } from './propose-entry';
import { vaultLookupTool } from './vault-lookup';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext } from './tool';
export { streamWithTools } from './tool-loop';
export { appendToNoteTool } from './append-to-note';
export { calculateFileSizesTool } from './calculate-file-sizes';
export { editNoteTool } from './edit-note';
export { grepNotesTool } from './grep-notes';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { measureFolderTool } from './measure-folder';
export { proposeEntryTool } from './propose-entry';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the eight internal-only tools:
 * `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`,
 * `measure_folder`, `calculate_file_sizes`, `edit_note`, `append_to_note`.
 */
export function createInternalToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(manuscriptMentionsTool);
    registry.register(loreSiblingsTool);
    registry.register(vaultLookupTool);
    registry.register(grepNotesTool);
    registry.register(measureFolderTool);
    registry.register(calculateFileSizesTool);
    registry.register(editNoteTool);
    registry.register(appendToNoteTool);
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
