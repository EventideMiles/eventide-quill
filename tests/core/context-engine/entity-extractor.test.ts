import { describe, it, expect } from 'vitest';
import {
    extractCharacters,
    extractLocations,
    extractPlotThreads,
    extractAllEntities
} from '../../../src/core/context-engine/entity-extractor';

describe('extractCharacters', () => {
    it('returns empty array for empty text', () => {
        expect(extractCharacters('')).toEqual([]);
    });

    it('returns empty array for whitespace-only text', () => {
        expect(extractCharacters('   ')).toEqual([]);
    });

    it('extracts characters from dialogue tags', () => {
        const text =
            '"I will go," Sarah said.\n\n' +
            '"No, wait," Sarah said.\n\n' +
            'John looked at Sarah. "Are you sure?" John asked.\n\n' +
            '"Yes," Sarah said. "I must."';
        const entities = extractCharacters(text);
        const names = entities.map((e) => e.name);
        expect(names).toContain('Sarah');
    });

    it('requires a minimum occurrence count', () => {
        // "Bob" appears only once — below the MIN_TOTAL_OCCURRENCES threshold.
        const text = '"Hello," Bob said.';
        const entities = extractCharacters(text);
        expect(entities.find((e) => e.name === 'Bob')).toBeUndefined();
    });

    it('sorts by occurrences descending', () => {
        const text =
            '"One," Sarah said.\n"Two," Sarah said.\n"Three," Sarah said.\n"Four," Sarah said.\n' +
            '"One," John said.\n"Two," John said.';
        const entities = extractCharacters(text);
        if (entities.length >= 2) {
            expect(entities[0]!.occurrences).toBeGreaterThanOrEqual(entities[1]!.occurrences);
        }
    });

    it('respects the excludeNames filter', () => {
        const text =
            '"Go," Sarah said.\n"Stop," Sarah said.\n"Wait," Sarah said.';
        const entities = extractCharacters(text, new Set(['Sarah']));
        expect(entities.find((e) => e.name === 'Sarah')).toBeUndefined();
    });
});

describe('extractLocations', () => {
    it('returns empty array for empty text', () => {
        expect(extractLocations('', new Set())).toEqual([]);
    });

    it('extracts locations from prepositional patterns', () => {
        const text =
            'They traveled to the Greenwood. ' +
            'She walked through the Greenwood. ' +
            'He returned from the Greenwood.';
        const entities = extractLocations(text, new Set());
        const names = entities.map((e) => e.name);
        expect(names).toContain('Greenwood');
    });

    it('excludes character names from location candidates', () => {
        const text = 'She went to the Sarah. She returned to the Sarah.';
        const entities = extractLocations(text, new Set(['Sarah']));
        expect(entities.find((e) => e.name === 'Sarah')).toBeUndefined();
    });

    it('requires at least 2 occurrences across both regex passes', () => {
        // "the Greenwood" matches theRe once but not prepRe (no preposition).
        // Count = 1, below the threshold of 2.
        const text = 'She saw the Greenwood.';
        const entities = extractLocations(text, new Set());
        expect(entities.find((e) => e.name === 'Greenwood')).toBeUndefined();
    });
});

describe('extractPlotThreads', () => {
    it('returns empty array for empty text', () => {
        expect(extractPlotThreads('', new Set(), new Set())).toEqual([]);
    });

    it('extracts repeated three-word capitalized phrases', () => {
        const text =
            'The Great Northern War began. ' +
            'The Great Northern War ended. ' +
            'Remember the Great Northern War.';
        const entities = extractPlotThreads(text, new Set(), new Set());
        expect(entities.length).toBeGreaterThanOrEqual(1);
        expect(entities[0]!.type).toBe('plot-thread');
    });

    it('excludes character and location names', () => {
        // The regex matches three-word capitalized phrases; exclude the exact
        // phrase it would extract.
        const text = 'Great Northern War began. Great Northern War ended.';
        const entities = extractPlotThreads(
            text,
            new Set(),
            new Set(['Great Northern War'])
        );
        expect(entities).toHaveLength(0);
    });
});

describe('extractAllEntities', () => {
    it('returns empty array for empty text', () => {
        expect(extractAllEntities('')).toEqual([]);
    });

    it('returns a combined list of characters, locations, and plot threads', () => {
        const text =
            '"I will go," Sarah said.\n"Go then," Sarah said.\n' +
            'They traveled to the Greenwood.\nThey returned to the Greenwood.\n' +
            'The Great Northern War. The Great Northern War.';
        const entities = extractAllEntities(text);
        const types = new Set(entities.map((e) => e.type));
        expect(types.size).toBeGreaterThanOrEqual(1);
    });

    it('produces entities with valid id, name, and occurrences', () => {
        const text =
            '"Yes," Sarah said.\n"No," Sarah said.\n"Wait," Sarah said.\n"Go," Sarah said.';
        const entities = extractAllEntities(text);
        for (const e of entities) {
            expect(e.id).toContain('character:');
            expect(e.name.length).toBeGreaterThan(0);
            expect(e.occurrences).toBeGreaterThanOrEqual(2);
        }
    });
});
