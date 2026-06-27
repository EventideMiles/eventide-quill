import { ToolRegistry } from './tool';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { proposeEntryTool } from './propose-entry';
import { vaultLookupTool } from './vault-lookup';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext } from './tool';
export { streamWithTools } from './tool-loop';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { proposeEntryTool } from './propose-entry';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the three internal-only query tools
 * (`manuscript_mentions`, `lore_siblings`, `vault_lookup`).
 *
 * Network tools are not included — those ship in PR C3 and are gated behind
 * the `lorebookNetworkTools` setting. Consumers that need a draft-producing
 * tool should use {@link createLoreCoachToolRegistry} instead, which adds
 * `propose_entry` to the internal set.
 *
 * A fresh registry is constructed per call. The registry itself is mutable
 * (callers can register additional tools before handing it to
 * `streamWithTools`), but the tools it contains are frozen declarations —
 * they carry no per-session state.
 */
export function createInternalToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(manuscriptMentionsTool);
    registry.register(loreSiblingsTool);
    registry.register(vaultLookupTool);
    return registry;
}

/**
 * Build a registry for the Lorebook Coach: the three internal query tools
 * plus `propose_entry` (which surfaces a draft to the UI for review).
 *
 * The coach calls this once at session start; `propose_entry` writes any
 * produced draft to `plugin.coWriterSession.currentLoreDraft` and fires
 * `onLoreDraftReady`, so the coach itself doesn't need to parse the model's
 * output for draft markers.
 */
export function createLoreCoachToolRegistry(): ToolRegistry {
    const registry = createInternalToolRegistry();
    registry.register(proposeEntryTool);
    return registry;
}
