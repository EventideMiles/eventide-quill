import { ToolRegistry } from './tool';
import { loreSiblingsTool } from './lore-siblings';
import { manuscriptMentionsTool } from './manuscript-mentions';
import { vaultLookupTool } from './vault-lookup';

export { ToolRegistry } from './tool';
export type { Tool, ToolContext, ToolInvocation } from './tool';
export { ToolStreamParser, streamWithTools } from './tool-loop';
export { loreSiblingsTool } from './lore-siblings';
export { manuscriptMentionsTool } from './manuscript-mentions';
export { vaultLookupTool } from './vault-lookup';

/**
 * Build a registry containing the three internal-only tools
 * (`manuscript_mentions`, `lore_siblings`, `vault_lookup`).
 *
 * No network tools are included — those ship in PR C3 and are gated behind
 * the `lorebookNetworkTools` setting. C2's Lorebook Coach uses this factory
 * directly; C3 will add a sibling factory that conditionally registers
 * network tools when the setting is on.
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
