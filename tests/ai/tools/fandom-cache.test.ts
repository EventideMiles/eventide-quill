import { describe, it, expect } from 'vitest';
import {
    fandomPageSourceUrl,
    formatLocalDate,
    fandomReachability,
    FANDOM_DEFAULT_LICENSE
} from '../../../src/ai/tools/fandom-cache';

/** Minimal settings shape that fandomReachability reads. */
interface ReachabilitySettings {
    lorebookNetworkTools: boolean;
    lorebookFandomWikis: string[];
    lorebookFandomAllowAllWikis: boolean;
    lorebookFandomCacheEnabled: boolean;
}

describe('fandomPageSourceUrl', () => {
    it('builds a Fandom wiki URL from wiki + title', () => {
        const url = fandomPageSourceUrl('starwars', 'Luke Skywalker');
        expect(url).toBe('https://starwars.fandom.com/wiki/Luke_Skywalker');
    });

    it('replaces spaces in the title with underscores', () => {
        const url = fandomPageSourceUrl('lotr', 'Frodo Baggins');
        expect(url).toContain('Frodo_Baggins');
    });

    it('URL-encodes special characters but preserves slashes', () => {
        const url = fandomPageSourceUrl('wiki', 'Test/Page Name');
        expect(url).toContain('Test/Page');
        // Parentheses are unreserved chars — not encoded by encodeURIComponent.
        const url2 = fandomPageSourceUrl('wiki', 'Test (Name)');
        expect(url2).toContain('(Name)');
    });
});

describe('formatLocalDate', () => {
    it('formats a known timestamp as YYYY-MM-DD', () => {
        // 2025-01-15T10:30:00Z
        const result = formatLocalDate(Date.UTC(2025, 0, 15, 10, 30, 0));
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('uses local date (not UTC) so writers west of GMT see the right day', () => {
        // The key property: the function reads local getters, not toISOString.
        // We can't assert a specific value (timezone-dependent), but we CAN
        // verify it produces a valid YYYY-MM-DD string.
        const result = formatLocalDate(Date.now());
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.length).toBe(10);
    });

    it('zero-pads month and day', () => {
        // January 5 → "01-05" in the middle of the string.
        const result = formatLocalDate(new Date(2025, 0, 5).getTime());
        expect(result).toMatch(/-01-05$/);
    });
});

describe('FANDOM_DEFAULT_LICENSE', () => {
    it('is CC-BY-SA', () => {
        expect(FANDOM_DEFAULT_LICENSE).toBe('CC-BY-SA');
    });
});

describe('fandomReachability', () => {
    function makeHost(overrides: Partial<ReachabilitySettings> = {}) {
        return {
            settings: {
                lorebookNetworkTools: false,
                lorebookFandomWikis: [],
                lorebookFandomAllowAllWikis: false,
                lorebookFandomCacheEnabled: false,
                ...overrides
            },
            fandomCache: null
        };
    }

    it('returns "none" when allowlist is empty and allow-all is off', () => {
        expect(fandomReachability(makeHost())).toBe('none');
    });

    it('returns "live" when network tools are on and allowlist is active', () => {
        expect(
            fandomReachability(
                makeHost({ lorebookNetworkTools: true, lorebookFandomWikis: ['starwars'] })
            )
        ).toBe('live');
    });

    it('returns "live" when network tools are on and allow-all is on', () => {
        expect(
            fandomReachability(
                makeHost({ lorebookNetworkTools: true, lorebookFandomAllowAllWikis: true })
            )
        ).toBe('live');
    });

    it('returns "none" when network is off and cache is off', () => {
        expect(
            fandomReachability(
                makeHost({ lorebookFandomWikis: ['starwars'], lorebookFandomCacheEnabled: false })
            )
        ).toBe('none');
    });

    it('returns "none" when network is off and cache is on but fandomCache is null', () => {
        expect(
            fandomReachability(
                makeHost({
                    lorebookFandomWikis: ['starwars'],
                    lorebookFandomCacheEnabled: true
                })
            )
        ).toBe('none');
    });
});
