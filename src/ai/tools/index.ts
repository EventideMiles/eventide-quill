import { ToolRegistry } from './tool';
import { appendToNoteTool } from './append-to-note';
import { attachLoreImageTool } from './attach-lore-image';
import { calculateFileSizesTool } from './calculate-file-sizes';
import { fandomReachability } from './fandom-cache';
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
export {
    detectTextToolCall,
    buildToolNudgeMessage,
    tryNudgeTextToolLeak,
    MAX_TEXT_TOOL_NUDGES
} from './text-tool-detect';
export type { TextToolLeak, NudgeTextToolLeakOptions, NudgeTextToolLeakResult } from './text-tool-detect';

/**
 * Options for {@link createInternalToolRegistry}. Each flag defaults to true,
 * preserving the full twelve-tool set for callers that omit the options
 * (read-only registry, lore-batch subagent, discuss/coach via the default
 * path). The lorebook coach passes a reduced set — see
 * {@link createLoreCoachToolRegistry}.
 */
export interface InternalToolOptions {
    /** Include `manuscript_mentions` (entity occurrences in the active manuscript). Default true. */
    manuscript?: boolean;
    /** Include `grep_notes` (full-text search across vault notes). Default true. */
    grep?: boolean;
    /** Include `refresh_dashboard` (recompute the manuscript dashboard). Default true. */
    dashboard?: boolean;
}

/**
 * Build a registry containing the twelve internal-only tools:
 * `manuscript_mentions`, `lore_siblings`, `vault_lookup`, `grep_notes`,
 * `measure_folder`, `calculate_file_sizes`, `edit_note`, `insert_note`,
 * `append_to_note`, `revise_edit`, `refresh_dashboard`, `get_lore_image`.
 *
 * Pass {@link InternalToolOptions} to drop tools a mode never advertises (the
 * lorebook coach drops `manuscript_mentions` / `grep_notes` / `refresh_dashboard`
 * — its system prompt never references them, so registering them only spends
 * tool-definition tokens on every request).
 */
export function createInternalToolRegistry(opts?: InternalToolOptions): ToolRegistry {
    const includeManuscript = opts?.manuscript ?? true;
    const includeGrep = opts?.grep ?? true;
    const includeDashboard = opts?.dashboard ?? true;
    const registry = new ToolRegistry();
    if (includeManuscript) registry.register(manuscriptMentionsTool);
    registry.register(loreSiblingsTool);
    registry.register(vaultLookupTool);
    if (includeGrep) registry.register(grepNotesTool);
    registry.register(measureFolderTool);
    registry.register(calculateFileSizesTool);
    registry.register(editNoteTool);
    registry.register(insertNoteTool);
    registry.register(appendToNoteTool);
    registry.register(reviseEditTool);
    if (includeDashboard) registry.register(refreshDashboardTool);
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
 * Build a registry for the Lorebook Coach: the internal tools plus
 * `propose_entry` (which surfaces a draft to the UI for review). When the
 * writer has enabled agent image attachments (`loreEntryImageAttachments`),
 * `propose_entry` is built with the `images` parameter in its schema, and
 * `attach_lore_image` is registered for batch edits to existing entries.
 *
 * The coach works on lore entries (`vault_lookup` / `lore_siblings`), not the
 * active manuscript's entity list, full-text search, or the dashboard — its
 * system prompt (`getLoreCoachSystemPrompt`) never references
 * `manuscript_mentions`, `grep_notes`, or `refresh_dashboard`, so those three
 * are dropped here to cut tool-definition token overhead on every coach
 * request. (The lore-batch subagent keeps the full set via the default path —
 * it runs in its own fresh context where the savings matter less.)
 */
export function createLoreCoachToolRegistry(plugin: EventideQuillPlugin): ToolRegistry {
    const registry = createInternalToolRegistry({ manuscript: false, grep: false, dashboard: false });
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
 * - `lorebookNetworkTools` on → registers fetch_url + wikipedia_* (network-only)
 * - Fandom tools register when reachable (`fandomReachability`): 'live' when
 *   network tools are on, OR 'cache-only' when network tools are off but a
 *   populated cache answers for an allowlisted wiki (Stage 3).
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

    // attach_lore_image is NOT registered here for the !includeProposeEntry
    // path (general discuss/coach modes). It belongs to the lorebook coach
    // (already registered in createLoreCoachToolRegistry above) and the
    // lore-batch subagent (registered explicitly in runLorebookBatch).
    // This avoids leaking a lore-mutating tool into modes that should only
    // access read-only / editing tools.

    if (allowSubagents) {
        registry.register(runLorebookBatchTool);
        registry.register(runResearchTool);
    }

    registerExternalTools(registry, plugin);

    return registry;
}

/**
 * Register the external (network + image) tools on `registry`, gated by the
 * user's `lorebookNetworkTools` / `lorebookImageTools` settings, the Fandom
 * allowlist, and the Fandom cache. Shared by the parent co-writer registry and
 * the research subagent registry so the Fandom multi-gate logic lives in
 * exactly one place (the gating mirror is fragile when duplicated).
 *
 * Fandom is the one tool family that can register WITHOUT network tools on:
 * a populated cache answers from disk (Stage 3 — consent was at sync time, so
 * the network toggle no longer hides cached data). `fandomReachability` is the
 * single source of truth shared with `buildNetworkToolsMessage`, so prompt
 * advertisement and registration always agree. `fetch_url` + `wikipedia_*`
 * have no cache, so they stay gated purely on `lorebookNetworkTools`.
 */
function registerExternalTools(registry: ToolRegistry, plugin: EventideQuillPlugin): void {
    const maxTokens = plugin.settings.lorebookToolMaxTokens;

    // Network-only tools (no cache): fetch_url + wikipedia_*. Gated purely by
    // lorebookNetworkTools.
    if (plugin.settings.lorebookNetworkTools) {
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
    }

    // Fandom tools register when reachable — 'live' (network on) OR
    // 'cache-only' (network off but a populated cache for an allowlisted wiki).
    // fandomReachability folds in the allowlist + cache-enabled checks, so this
    // single condition replaces the old `lorebookNetworkTools && (allowlist ||
    // allowAll)` nesting. 'none' → tools not registered (Fandom fully off).
    if (fandomReachability(plugin) !== 'none') {
        const fandomAllowAll = plugin.settings.lorebookFandomAllowAllWikis;
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

    // Image tool: gated independently of the network-tools toggle. Downloads
    // and downscales an image, then the tool-loop routes it through the vision
    // layer (native or proxy depending on the configured models).
    if (plugin.settings.lorebookImageTools) {
        registry.register(createFetchImageUrlTool(maxTokens, plugin.settings.lorebookImageMaxDimension));
    }
}
