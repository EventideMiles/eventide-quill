import { describe, it, expect } from 'vitest';
import { detectAiIsms, checkAiIsms, formatAiIsmError } from '../../src/ai/ai-ism-detector';

describe('detectAiIsms', () => {
    describe('em dashes', () => {
        it('detects em dash (—)', () => {
            const isms = detectAiIsms('He walked to the door\u2014a place he knew well.');
            expect(isms.length).toBeGreaterThanOrEqual(1);
            expect(isms.some((i) => i.category === 'em-dash')).toBe(true);
        });

        it('detects double-hyphen with spaces ( -- )', () => {
            const isms = detectAiIsms('He walked to the door -- a place he knew well.');
            expect(isms.some((i) => i.category === 'em-dash')).toBe(true);
        });

        it('does NOT flag clean prose without em dashes', () => {
            const isms = detectAiIsms('He walked to the door. It was a place he knew well.');
            expect(isms.filter((i) => i.category === 'em-dash')).toHaveLength(0);
        });
    });

    describe('cliché words', () => {
        it('detects "ozone"', () => {
            const isms = detectAiIsms('The air smelled of ozone and cheap paint.');
            expect(isms.some((i) => i.category === 'cliche-word' && i.match === 'ozone')).toBe(true);
        });

        it('detects "tapestry"', () => {
            const isms = detectAiIsms('The city was a tapestry of sounds.');
            expect(isms.some((i) => i.category === 'cliche-word' && i.match === 'tapestry')).toBe(true);
        });

        it('detects "delve"', () => {
            const isms = detectAiIsms('Let us delve into the matter.');
            expect(isms.some((i) => i.category === 'cliche-word' && i.match === 'delve')).toBe(true);
        });

        it('detects multiple different clichés in one text', () => {
            const isms = detectAiIsms('The vibrant tapestry was nestled in the labyrinth.');
            const words = isms.filter((i) => i.category === 'cliche-word').map((i) => i.match.toLowerCase());
            expect(words).toContain('vibrant');
            expect(words).toContain('tapestry');
            expect(words).toContain('nestled');
            expect(words).toContain('labyrinth');
        });

        it('does NOT flag ordinary prose words', () => {
            const isms = detectAiIsms('He opened the door and walked inside the room.');
            expect(isms.filter((i) => i.category === 'cliche-word')).toHaveLength(0);
        });
    });

    describe('purple constructions', () => {
        it('detects "hung heavy"', () => {
            const isms = detectAiIsms('The silence hung heavy between them.');
            expect(isms.some((i) => i.category === 'purple-construction')).toBe(true);
        });

        it('detects "shiver ran"', () => {
            const isms = detectAiIsms('A shiver ran down his spine.');
            expect(isms.some((i) => i.category === 'purple-construction')).toBe(true);
        });

        it('detects "palpable tension"', () => {
            const isms = detectAiIsms('The palpable tension filled the room.');
            expect(isms.some((i) => i.category === 'purple-construction')).toBe(true);
        });

        it('does NOT flag clean prose', () => {
            const isms = detectAiIsms('He felt nervous. His hands were shaking.');
            expect(isms.filter((i) => i.category === 'purple-construction')).toHaveLength(0);
        });
    });

    it('returns empty for completely clean text', () => {
        expect(detectAiIsms('She picked up the phone and dialed. It rang twice before he answered.')).toEqual([]);
    });

    it('returns empty for empty string', () => {
        expect(detectAiIsms('')).toEqual([]);
    });

    it('includes context snippets in results', () => {
        const isms = detectAiIsms('The ozone smell was everywhere.');
        const ozone = isms.find((i) => i.match === 'ozone');
        expect(ozone).toBeDefined();
        expect(ozone!.snippet).toContain('ozone');
    });
});

describe('checkAiIsms', () => {
    it('returns null for clean text', () => {
        expect(checkAiIsms('She walked to the store and bought milk.')).toBeNull();
    });

    it('returns null for empty text', () => {
        expect(checkAiIsms('')).toBeNull();
    });

    it('returns an error message for text with em dashes', () => {
        const result = checkAiIsms('He opened the door\u2014and gasped.');
        expect(result).not.toBeNull();
        expect(result).toContain('AI-ism');
        expect(result).toContain('Em dash');
    });

    it('returns an error message for text with cliché words', () => {
        const result = checkAiIsms('The air smelled of ozone.');
        expect(result).not.toBeNull();
        expect(result).toContain('ozone');
    });

    it('returns an error message listing all detected issues', () => {
        const result = checkAiIsms('The ozone smell\u2014a tapestry of scent\u2014hung heavy.');
        expect(result).not.toBeNull();
        expect(result).toContain('Em dash');
        expect(result).toContain('ozone');
        expect(result).toContain('tapestry');
        expect(result).toContain('hung heavy');
    });

    it('tells the model to rewrite and study the writer\u2019s voice', () => {
        const result = checkAiIsms('He delved into the ozone.');
        expect(result).toContain('Rewrite');
        expect(result).toContain('writer');
    });
});

describe('formatAiIsmError', () => {
    it('formats a clean, readable error message', () => {
        const msg = formatAiIsmError([
            { category: 'em-dash', match: '\u2014', snippet: 'door\u2014and' },
            { category: 'cliche-word', match: 'ozone', snippet: 'smell of ozone' }
        ]);
        expect(msg).toContain('AI-ism check');
        expect(msg).toContain('Em dash');
        expect(msg).toContain('ozone');
        expect(msg).toContain('Rewrite');
    });
});
