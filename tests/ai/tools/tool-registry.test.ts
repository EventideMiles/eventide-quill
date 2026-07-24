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

    it('registers exactly the internal tools + subagent spawners, no extras', () => {
        const plugin = makePlugin();
        const reg = createToolRegistry(plugin, false, true)!;
        const expected = [...INTERNAL_TOOL_IDS, 'run_lorebook_batch', 'run_research'];
        const actual = reg.list().map((t) => t.id);
        expect(actual.sort()).toEqual(expected.sort());
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

    it.each([
        {
            label: 'omits network tools when lorebookNetworkTools is off',
            overrides: { lorebookNetworkTools: false },
            expectRegistered: [],
            expectOmitted: ['fetch_url', 'wikipedia_lookup', 'wikipedia_page']
        },
        {
            label: 'registers network tools when lorebookNetworkTools is on',
            overrides: { lorebookNetworkTools: true },
            expectRegistered: ['fetch_url', 'wikipedia_lookup', 'wikipedia_page'],
            expectOmitted: []
        },
        {
            label: 'omits image tools when lorebookImageTools is off',
            overrides: { lorebookImageTools: false },
            expectRegistered: [],
            expectOmitted: ['fetch_image_url']
        },
        {
            label: 'registers fetch_image_url when lorebookImageTools is on',
            overrides: { lorebookImageTools: true },
            expectRegistered: ['fetch_image_url'],
            expectOmitted: []
        },
        {
            label: 'Fandom: empty allowlist + allowAll off → no fandom_lookup',
            overrides: {
                lorebookNetworkTools: true,
                lorebookFandomWikis: [],
                lorebookFandomAllowAllWikis: false
            },
            expectRegistered: [],
            expectOmitted: ['fandom_lookup']
        },
        {
            label: 'Fandom: populated allowlist + network on → fandom_lookup',
            overrides: {
                lorebookNetworkTools: true,
                lorebookFandomWikis: ['dragonage']
            },
            expectRegistered: ['fandom_lookup'],
            expectOmitted: []
        },
        {
            label: 'Fandom: allowAll + network on → fandom_lookup',
            overrides: {
                lorebookNetworkTools: true,
                lorebookFandomAllowAllWikis: true
            },
            expectRegistered: ['fandom_lookup'],
            expectOmitted: []
        }
    ])('$label', ({ overrides, expectRegistered, expectOmitted }) => {
        const plugin = makePlugin(overrides);
        const reg = createToolRegistry(plugin, false, true)!;
        for (const id of expectRegistered) {
            expect(reg.get(id), `expected ${id} to be registered`).toBeDefined();
        }
        for (const id of expectOmitted) {
            expect(reg.get(id), `expected ${id} to be omitted`).toBeUndefined();
        }
    });
});
