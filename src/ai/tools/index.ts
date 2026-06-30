import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { attachLoreImageTool } from './attach-lore-image';
import { calculateFileSizesTool } from './calculate-file-sizes';
import { createFandomImageTool, createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
import { createFetchImageUrlTool } from './fetch-image-url';
import { createFetchUrlTool } from './fetch-url';
import { createWikipediaLookupTool, createWikipediaPageTool, createWikipediaImageTool } from './wikipedia-lookup';
import { editNoteTool } from './edit-note';
import { getLoreImageTool } from './get-lore-image';
import { grepNotesTool } from './grep-notes';
import { insertNoteTool } from './insert-note';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { measureFolderTool } from './measure-folder';
import { createProposeEntryTool } from './propose-entry';
import { refreshDashboardTool } from './refresh-dashboard';
import { runResearchTool } from './research';
import { reviseEditTool } from './revise-edit';
import { runLorebookBatchTool } from './run-lorebook-batch';
import { vaultLookupTool } from './vault-lookup';
import type EventideQuillPlugin from '../../main';

export { ToolRegistry, executeToolCall } from './tool';
export type { Tool, ToolContext, ToolResult } from './tool';
export { streamWithTools } from './tool-loop';
export { appendToNoteTool } from './append-to-note';
export { attachLoreImageTool } from './attach-lore-image';
export { calculateFileSizesTool } from './calculate-file-sizes';
export { createFandomImageTool, createFandomLookupTool, createFandomPageTool } from './fandom-lookup';
export { createFetchImageUrlTool } from './fetch-image-url';
export { createFetchUrlTool } from './fetch-url';
export { createWikipediaLookupTool, createWikipediaPageTool, createWikipediaImageTool } from './wikipedia-lookup';
export { editNoteTool } from './edit-note';
export { getLoreImageTool } from './get-lore-image';
export { grepNotesTool } from './grep-notes';
export { insertNoteTool } from './insert-note';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { measureFolderTool } from './measure-folder';
export { createProposeEntryTool } from './propose-entry';
export { refreshDashboardTool } from './refresh-dashboard';
export { reviseEditTool } from './revise-edit';
export { runLorebookBatchTool } from './run-lorebook-batch';
export { runResearchTool } from './research';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the twelve internal-only tools:
 * `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`,
 * `measure_folder`, `calculate_file_sizes`, `edit_note`, `insert_note`,
 * `append_to_note`, `revise_edit`, `refresh_dashboard`, `get_lore_image`.
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
    registry.register(refreshDashboardTool);
    registry.register(getLoreImageTool);
    return registry;
}

/**
 * Build a READ-ONLY registry for research / lore-batch subagents: the lookup
 * and sizing tools, but NO editing tools (edit_note / insert_note /
 * append_to_note / revise_edit) and NO subagent spawners. With
 * `includeExternal`, also adds the network/image tools (gated identically to
 * the parent) — used by research, which compares vault entries against external
 * media (Wikipedia, Fandom, fetched URLs). The lore batch passes false.
 * Returns null when co-writer tools are disabled.
 */
export function createReadOnlyToolRegistry(plugin: EventideQuillPlugin, includeExternal = false): ToolRegistry | null {
    if (!plugin.settings.coWriterToolsEnabled) return null;
    const registry = new ToolRegistry();
    registry.register(manuscriptMentionsTool);
    registry.register(loreSiblingsTool);
    registry.register(vaultLookupTool);
    registry.register(grepNotesTool);
    registry.register(measureFolderTool);
    registry.register(calculateFileSizesTool);
    if (includeExternal) {
        registerExternalTools(registry, plugin);
    }
    return registry;
}

/**
 * Build a registry for the Lorebook Coach: the twelve internal tools plus
 * `propose_entry` (which surfaces a draft to the UI for review). When the
 * writer has enabled agent image attachments (`loreEntryImageAttachments`),
 * `propose_entry` is built with the `images` parameter in its schema, and
 * `attach_lore_image` is registered for batch edits to existing entries.
 */
export function createLoreCoachToolRegistry(plugin: EventideQuillPlugin): ToolRegistry {
    const registry = createInternalToolRegistry();
    const allowImages = plugin.settings.loreEntryImageAttachments;
    registry.register(createProposeEntryTool(allowImages));
    if (allowImages) {
        registry.register(attachLoreImageTool);
    }
    return registry;
}

/**
 * Build the full tool registry for a co-writer mode. Handles all gating:
 * - `coWriterToolsEnabled` off → returns null (no tools)
 * - `lorebookNetworkTools` on → registers all network tools
 * - `includeProposeEntry` → adds propose_entry (lorebook coach only)
 * - `allowSubagents` → adds the subagent spawners (parent modes only; the
 *   subagents themselves pass false so they cannot spawn sub-subagents —
 *   single-level nesting by construction): `run_lorebook_batch` (lore edits)
 *   and `run_research` (vault Q&A)
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

    const registry = includeProposeEntry ? createLoreCoachToolRegistry(plugin) : createInternalToolRegistry();

    if (allowSubagents) {
        registry.register(runLorebookBatchTool);
        registry.register(runResearchTool);
    }

    registerExternalTools(registry, plugin);

    return registry;
}

/**
 * Register the external (network + image) tools on `registry`, gated by the
 * user's `lorebookNetworkTools` / `lorebookImageTools` settings and the Fandom
 * allowlist. Shared by the parent co-writer registry and the research
 * subagent registry so the Fandom multi-gate logic lives in exactly one place
 * (the gating mirror is fragile when duplicated).
 */
function registerExternalTools(registry: ToolRegistry, plugin: EventideQuillPlugin): void {
    if (plugin.settings.lorebookNetworkTools) {
        const maxTokens = plugin.settings.lorebookToolMaxTokens;
        registry.register(createFetchUrlTool(maxTokens));
        registry.register(createWikipediaLookupTool(maxTokens, plugin.settings.lorebookWikipediaLang));
        registry.register(createWikipediaPageTool(maxTokens, plugin.settings.lorebookWikipediaLang));
        // wikipedia_image: lead portraits via prop=pageimages. Same cross-toggle
        // gate as fandom_image (network tools + image tools) — fetches bytes
        // from upload.wikimedia.org so it needs the network gate, and routes
        // through the vision layer so it needs the image gate.
        if (plugin.settings.lorebookImageTools) {
            registry.register(
                createWikipediaImageTool(
                    maxTokens,
                    plugin.settings.lorebookImageMaxDimension,
                    plugin.settings.lorebookWikipediaLang
                )
            );
        }
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
}
