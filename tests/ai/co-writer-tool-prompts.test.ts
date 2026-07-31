import { describe, expect, it } from 'vitest';
import type EventideQuillPlugin from '../../src/main';
import { buildInternalToolsMessage, buildNetworkToolsMessage } from '../../src/ai/co-writer-tool-prompts';

/**
 * Minimal plugin stub satisfying the structural shape the prompt builders
 * (and fandomReachability) read: a slice of `settings` plus a `fandomCache`
 * with the two presence checks reachability consults.
 */
function makePlugin(opts: {
    coWriterToolsEnabled?: boolean;
    lorebookNetworkTools?: boolean;
    lorebookImageTools?: boolean;
    lorebookFandomWikis?: string[];
    lorebookFandomAllowAllWikis?: boolean;
    lorebookFandomCacheEnabled?: boolean;
    lorebookWikipediaLang?: string;
    hasWiki?: (w: string) => boolean;
    hasAnyEntries?: () => boolean;
}): EventideQuillPlugin {
    const needsCache = Boolean(opts.hasWiki || opts.hasAnyEntries || opts.lorebookFandomCacheEnabled);
    return {
        settings: {
            coWriterToolsEnabled: opts.coWriterToolsEnabled ?? true,
            lorebookNetworkTools: opts.lorebookNetworkTools ?? true,
            lorebookImageTools: opts.lorebookImageTools ?? false,
            lorebookFandomWikis: opts.lorebookFandomWikis ?? ['starwars'],
            lorebookFandomAllowAllWikis: opts.lorebookFandomAllowAllWikis ?? false,
            lorebookFandomCacheEnabled: opts.lorebookFandomCacheEnabled ?? false,
            lorebookWikipediaLang: opts.lorebookWikipediaLang ?? 'en'
        },
        fandomCache: needsCache
            ? {
                  hasWiki: opts.hasWiki ?? (() => false),
                  hasAnyEntries: opts.hasAnyEntries ?? (() => false)
              }
            : null
    } as unknown as EventideQuillPlugin;
}

const DISCIPLINE = 'tool_calls';

describe('co-writer-tool-prompts — buildNetworkToolsMessage', () => {
    it('returns null when co-writer tools are disabled (never advertises unavailable tools)', () => {
        expect(buildNetworkToolsMessage(makePlugin({ coWriterToolsEnabled: false }))).to.equal(null);
    });

    it('returns null when network is off and nothing is cached (no reachability)', () => {
        expect(
            buildNetworkToolsMessage(
                makePlugin({ lorebookNetworkTools: false, lorebookFandomCacheEnabled: false })
            )
        ).to.equal(null);
    });

    it('advertises fandom + wikipedia + fetch_url when live (network on, allowlisted)', () => {
        const msg = buildNetworkToolsMessage(makePlugin({ lorebookNetworkTools: true }));
        expect(msg).to.not.equal(null);
        const text = msg!.content;
        expect(text).to.include('fandom_lookup');
        expect(text).to.include('wikipedia_lookup');
        expect(text).to.include('fetch_url');
        expect(text).to.include('starwars'); // allowlisted wiki surfaced
        expect(text).to.include(DISCIPLINE);
        // Image tools off -> no image-fetching tools advertised.
        expect(text).to.not.include('fandom_image');
        expect(text).to.not.include('wikipedia_image');
    });

    it('advertises fandom_image + wikipedia_image only when image tools are on', () => {
        const msg = buildNetworkToolsMessage(makePlugin({ lorebookNetworkTools: true, lorebookImageTools: true }));
        expect(msg!.content).to.include('fandom_image');
        expect(msg!.content).to.include('wikipedia_image');
    });

    it('says "any wiki" when allow-all is on with an empty allowlist', () => {
        const msg = buildNetworkToolsMessage(
            makePlugin({ lorebookNetworkTools: true, lorebookFandomWikis: [], lorebookFandomAllowAllWikis: true })
        );
        expect(msg!.content).to.include('any wiki');
    });

    it('does NOT advertise fandom when network is on but the allowlist is empty (mirror: tools do not register)', () => {
        const msg = buildNetworkToolsMessage(
            makePlugin({ lorebookNetworkTools: true, lorebookFandomWikis: [], lorebookFandomAllowAllWikis: false })
        );
        expect(msg).to.not.equal(null);
        expect(msg!.content).to.not.include('fandom_lookup');
        expect(msg!.content).to.include('wikipedia_lookup'); // non-Fandom tools still advertised
    });

    it('switches to the cache-only message when network is off but a wiki is cached', () => {
        const msg = buildNetworkToolsMessage(
            makePlugin({
                lorebookNetworkTools: false,
                lorebookFandomCacheEnabled: true,
                hasWiki: (w) => w === 'starwars'
            })
        );
        expect(msg).to.not.equal(null);
        expect(msg!.content).to.include('LOCAL CACHE');
        expect(msg!.content).to.not.include('fetch_url'); // live-only tool not advertised
        expect(msg!.content).to.include(DISCIPLINE);
    });

    it('honours the configured Wikipedia language', () => {
        const msg = buildNetworkToolsMessage(makePlugin({ lorebookWikipediaLang: 'fr' }));
        expect(msg!.content).to.include('(fr)');
    });
});

describe('co-writer-tool-prompts — buildInternalToolsMessage', () => {
    it('returns null when co-writer tools are disabled', () => {
        expect(buildInternalToolsMessage(makePlugin({ coWriterToolsEnabled: false }))).to.equal(null);
    });

    it('advertises the internal vault tools + the discipline clause when enabled', () => {
        const msg = buildInternalToolsMessage(makePlugin({ coWriterToolsEnabled: true }));
        expect(msg).to.not.equal(null);
        const text = msg!.content;
        expect(text).to.include('manuscript_mentions');
        expect(text).to.include('vault_lookup');
        expect(text).to.include('grep_notes');
        expect(text).to.include('get_lore_image');
        expect(text).to.include(DISCIPLINE);
    });
});
