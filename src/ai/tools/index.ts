import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { calculateFileSizesTool } from './calculate-file-sizes';
import { createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
import { createFetchImageUrlTool } from './fetch-image-url';
import { createFetchUrlTool } from './fetch-url';
import { createWikipediaLookupTool, createWikipediaPageTool } from './wikipedia-lookup';
import { editNoteTool } from './edit-note';
import { grepNotesTool } from './grep-notes';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { measureFolderTool } from './measure-folder';
import { proposeEntryTool } from './propose-entry';
import { vaultLookupTool } from './vault-lookup';
import type EventideQuillPlugin from '../../main';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext, ToolResult } from './tool';
export { streamWithTools } from './tool-loop';
export { appendToNoteTool } from './append-to-note';
export { calculateFileSizesTool } from './calculate-file-sizes';
export { createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
export { createFetchImageUrlTool } from './fetch-image-url';
export { createFetchUrlTool } from './fetch-url';
export { createWikipediaLookupTool, createWikipediaPageTool } from './wikipedia-lookup';
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
 * Build a registry for the Lorebook Coach: the eight internal tools plus
 * `propose_entry` (which surfaces a draft to the UI for review).
 */
export function createLoreCoachToolRegistry(): ToolRegistry {
    const registry = createInternalToolRegistry();
    registry.register(proposeEntryTool);
    return registry;
}

/**
 * Build the full tool registry for a co-writer mode. Handles all gating:
 * - `coWriterToolsEnabled` off → returns null (no tools)
 * - `lorebookNetworkTools` on → registers all network tools
 * - `includeProposeEntry` → adds propose_entry (lorebook coach only)
 *
 * Network tools use factory functions because their maxResultTokens and
 * configuration (Fandom wikis, Wikipedia language) come from settings.
 */
export function createToolRegistry(plugin: EventideQuillPlugin, includeProposeEntry: boolean): ToolRegistry | null {
    if (!plugin.settings.coWriterToolsEnabled) return null;

    const registry = includeProposeEntry ? createLoreCoachToolRegistry() : createInternalToolRegistry();

    if (plugin.settings.lorebookNetworkTools) {
        const maxTokens = plugin.settings.lorebookToolMaxTokens;
        registry.register(createFetchUrlTool(maxTokens));
        registry.register(createWikipediaLookupTool(maxTokens, plugin.settings.lorebookWikipediaLang));
        registry.register(createWikipediaPageTool(maxTokens, plugin.settings.lorebookWikipediaLang));
        // Fandom tools are registered when EITHER a non-empty allowlist is
        // configured OR the "allow any wiki" danger setting is on. An empty
        // allowlist with allow-all off means Fandom disabled everywhere.
        const fandomAllowAll = plugin.settings.lorebookFandomAllowAllWikis;
        if (plugin.settings.lorebookFandomWikis.length > 0 || fandomAllowAll) {
            registry.register(createFandomLookupTool(maxTokens, plugin.settings.lorebookFandomWikis, fandomAllowAll));
            registry.register(createFandomPageTool(maxTokens, plugin.settings.lorebookFandomWikis, fandomAllowAll));
        }
    }

    // Image tool: gated independently of the network-tools toggle. Downloads
    // and downscales an image, then the tool-loop routes it through the vision
    // layer (native or proxy depending on the configured models).
    if (plugin.settings.lorebookImageTools) {
        registry.register(
            createFetchImageUrlTool(plugin.settings.lorebookToolMaxTokens, plugin.settings.lorebookImageMaxDimension)
        );
    }

    return registry;
}
