import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { calculateFileSizesTool } from './calculate-file-sizes';
import { createFandomImageTool, createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
import { createFetchImageUrlTool } from './fetch-image-url';
import { createFetchUrlTool } from './fetch-url';
import { createWikipediaLookupTool, createWikipediaPageTool } from './wikipedia-lookup';
import { editNoteTool } from './edit-note';
import { grepNotesTool } from './grep-notes';
import { insertNoteTool } from './insert-note';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { measureFolderTool } from './measure-folder';
import { proposeEntryTool } from './propose-entry';
import { reviseEditTool } from './revise-edit';
import { runLorebookBatchTool } from './run-lorebook-batch';
import { vaultLookupTool } from './vault-lookup';
import type EventideQuillPlugin from '../../main';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext, ToolResult } from './tool';
export { streamWithTools } from './tool-loop';
export { appendToNoteTool } from './append-to-note';
export { calculateFileSizesTool } from './calculate-file-sizes';
export { createFandomImageTool, createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
export { createFetchImageUrlTool } from './fetch-image-url';
export { createFetchUrlTool } from './fetch-url';
export { createWikipediaLookupTool, createWikipediaPageTool } from './wikipedia-lookup';
export { editNoteTool } from './edit-note';
export { grepNotesTool } from './grep-notes';
export { insertNoteTool } from './insert-note';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { measureFolderTool } from './measure-folder';
export { proposeEntryTool } from './propose-entry';
export { reviseEditTool } from './revise-edit';
export { runLorebookBatchTool } from './run-lorebook-batch';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the ten internal-only tools:
 * `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`,
 * `measure_folder`, `calculate_file_sizes`, `edit_note`, `insert_note`,
 * `append_to_note`, `revise_edit`.
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
    registry.register(insertNoteTool);
    registry.register(appendToNoteTool);
    registry.register(reviseEditTool);
    return registry;
}

/**
 * Build a registry for the Lorebook Coach: the ten internal tools plus
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
 * - `allowSubagents` → adds run_lorebook_batch (parent modes only; the
 *   subagent itself passes false so it cannot spawn sub-subagents —
 *   single-level nesting by construction)
 *
 * Network tools use factory functions because their maxResultTokens and
 * configuration (Fandom wikis, Wikipedia language) come from settings.
 */
export function createToolRegistry(
    plugin: EventideQuillPlugin,
    includeProposeEntry: boolean,
    allowSubagents = false
): ToolRegistry | null {
    if (!plugin.settings.coWriterToolsEnabled) return null;

    const registry = includeProposeEntry ? createLoreCoachToolRegistry() : createInternalToolRegistry();

    if (allowSubagents) {
        registry.register(runLorebookBatchTool);
    }

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
            // fandom_image: a Fandom lookup that returns an image, so it also
            // requires the image-tools gate. Uses prop=pageimages to fetch the
            // API's thumbnail URL — fetching Fandom image URLs directly 403s.
            if (plugin.settings.lorebookImageTools) {
                registry.register(
                    createFandomImageTool(
                        maxTokens,
                        plugin.settings.lorebookImageMaxDimension,
                        plugin.settings.lorebookFandomWikis,
                        fandomAllowAll
                    )
                );
            }
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
