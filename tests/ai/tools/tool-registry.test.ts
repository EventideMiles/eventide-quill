import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../../src/ai/tools';
import type EventideQuillPlugin from '../../../src/main';

/**
 * Minimal plugin stub for the registry factory tests. Only the settings
 * fields the factory reads are populated; everything else is left undefined
 * (cast through unknown to satisfy the type).
 */
function makePlugin(overrides: Record<string, unknown> = {}): EventideQuillPlugin {
    const settings: Record<string, unknown> = {
        coWriterToolsEnabled: true,
        lorebookNetworkTools: false,
        lorebookImageTools: false,
        lorebookFandomAllowAllWikis: false,
        lorebookFandomWikis: [],
        lorebookFandomCacheEnabled: false,
        lorebookWikipediaLang: 'en',
        lorebookToolMaxTokens: 2000,
        lorebookImageMaxDimension: 512,
        ...overrides
    };
    return { settings } as unknown as EventideQuillPlugin;
}

/** Tool ids registered by createInternalToolRegistry (the base 14). */
const INTERNAL_TOOL_IDS = [
    'manuscript_mentions',
    'lore_siblings',
    'vault_lookup',
    'grep_notes',
    'measure_folder',
    'calculate_file_sizes',
    'edit_note',
    'delete_paragraph',
    'add_world_rule',
    'insert_note',
    'append_to_note',
    'revise_edit',
    'get_lore_image',
    'refresh_dashboard'
] as const;

describe('createToolRegistry — review-discuss configuration', () => {
    // The review-discuss mode uses createToolRegistry(plugin, false, true):
    // no propose_entry, but subagent spawners are available. This is the
    // gating contract the new feature depends on. Locking it down here
    // surfaces any drift in the factory's behavior immediately (e.g. someone
    // adding a lore-mutating tool to the base registry that would leak into
    // review-discuss).
    it('returns null when coWriterToolsEnabled is off (master kill switch)', () => {
        const plugin = makePlugin({ coWriterToolsEnabled: false });
        expect(createToolRegistry(plugin, false, true)).toBeNull();
    });

    it('returns a non-null registry when the master toggle is on', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true);
        expect(reg).not.toBeNull();
    });

    it('registers all 14 internal tools for review-discuss', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true)!;
        for (const id of INTERNAL_TOOL_IDS) {
            expect(reg.get(id), `expected ${id} to be registered`).toBeDefined();
        }
    });

    it('does NOT register propose_entry for review-discuss', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('propose_entry')).toBeUndefined();
    });

    it('does NOT register attach_lore_image for review-discuss', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('attach_lore_image')).toBeUndefined();
    });

    it('registers subagent spawners (run_lorebook_batch, run_research)', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('run_lorebook_batch')).toBeDefined();
        expect(reg.get('run_research')).toBeDefined();
    });

    it('omits network tools when lorebookNetworkTools is off', () => {
        const plugin = makePlugin({ lorebookNetworkTools: false });
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('fetch_url')).toBeUndefined();
        expect(reg.get('wikipedia_lookup')).toBeUndefined();
        expect(reg.get('wikipedia_page')).toBeUndefined();
    });

    it('omits image tools when lorebookImageTools is off', () => {
        const plugin = makePlugin({ lorebookImageTools: false });
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('fetch_image_url')).toBeUndefined();
    });

    it('registers network tools when lorebookNetworkTools is on', () => {
        const plugin = makePlugin({ lorebookNetworkTools: true });
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('fetch_url')).toBeDefined();
        expect(reg.get('wikipedia_lookup')).toBeDefined();
        expect(reg.get('wikipedia_page')).toBeDefined();
    });

    it('registers fetch_image_url when lorebookImageTools is on', () => {
        const plugin = makePlugin({ lorebookImageTools: true });
        const reg = createToolRegistry(plugin, false, true)!;
        expect(reg.get('fetch_image_url')).toBeDefined();
    });

    it('registers fandom tools only when allowlist + reachability conditions are met', () => {
        // Empty allowlist + allowAll off = no Fandom, even with network on.
        const noAllow = makePlugin({
            lorebookNetworkTools: true,
            lorebookFandomWikis: [],
            lorebookFandomAllowAllWikis: false
        });
        expect(createToolRegistry(noAllow, false, true)!.get('fandom_lookup')).toBeUndefined();

        // Populated allowlist + network on = live Fandom.
        const withAllow = makePlugin({
            lorebookNetworkTools: true,
            lorebookFandomWikis: ['dragonage']
        });
        expect(createToolRegistry(withAllow, false, true)!.get('fandom_lookup')).toBeDefined();

        // Danger mode (allow any) + network on = live Fandom.
        const allowAll = makePlugin({
            lorebookNetworkTools: true,
            lorebookFandomAllowAllWikis: true
        });
        expect(createToolRegistry(allowAll, false, true)!.get('fandom_lookup')).toBeDefined();
    });
});
