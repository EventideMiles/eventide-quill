import { describe, expect, it } from 'vitest';
import { ANALYSIS_MODES, buildAnalysisMessages, getAnalysisModeById, type AnalysisMode } from '../../src/ai/analysis';

describe('analysis — ANALYSIS_MODES registry', () => {
    it('has the five critical-analysis modes with unique ids', () => {
        const ids = ANALYSIS_MODES.map((m) => m.id);
        expect(ids).to.deep.equal([
            'plot-logic',
            'character-consistency',
            'continuity',
            'voice-drift',
            'lore-consistency'
        ]);
        expect(new Set(ids).size).to.equal(ids.length);
        for (const mode of ANALYSIS_MODES) {
            expect(mode.label.length).to.be.greaterThan(0);
            expect(mode.description.length).to.be.greaterThan(0);
        }
    });
});

describe('analysis — getAnalysisModeById', () => {
    it('finds a registered mode by id', () => {
        expect(getAnalysisModeById('continuity')?.label).to.equal('Continuity');
        expect(getAnalysisModeById('lore-consistency')?.label).to.equal('Lore consistency');
    });
    it('returns undefined for an unknown id', () => {
        expect(getAnalysisModeById('nope')).to.equal(undefined);
    });
});

describe('analysis — buildAnalysisMessages', () => {
    const modes: AnalysisMode[] = [
        'plot-logic',
        'character-consistency',
        'continuity',
        'voice-drift',
        'lore-consistency'
    ];

    it('returns a [system, user] pair whose user message includes the analyzed text', () => {
        const messages = buildAnalysisMessages('plot-logic', { text: 'The detective entered.', scope: 'selection' });
        expect(messages).to.have.lengthOf(2);
        expect(messages[0]?.role).to.equal('system');
        expect(messages[1]?.role).to.equal('user');
        expect(messages[1]?.content).to.include('The detective entered.');
    });

    it('builds a system + user message for every mode without throwing', () => {
        for (const mode of modes) {
            const messages = buildAnalysisMessages(mode, { text: 'scene text', scope: 'scene' });
            expect(messages).to.have.lengthOf(2);
            expect(messages[0]?.content.length).to.be.greaterThan(0);
        }
    });

    it('carries the response-language directive in the system prompt when set', () => {
        const messages = buildAnalysisMessages('plot-logic', {
            text: 'scene text',
            scope: 'scene',
            responseLanguage: 'French'
        });
        expect(messages[0]?.content).toContain('in French');
        const plain = buildAnalysisMessages('plot-logic', { text: 'scene text', scope: 'scene' });
        expect(plain[0]?.content).not.toContain('RESPONSE LANGUAGE');
    });

    it('accepts a tool registry (verify-and-cite path) without crashing', () => {
        const registry = { has: (id: string) => id === 'fetch_url' } as unknown as Parameters<
            typeof buildAnalysisMessages
        >[1]['registry'];
        const messages = buildAnalysisMessages('continuity', {
            text: 'scene',
            scope: 'document',
            registry
        });
        expect(messages).to.have.lengthOf(2);
    });
});
