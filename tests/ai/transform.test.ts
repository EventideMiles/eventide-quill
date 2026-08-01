import { describe, expect, it } from 'vitest';
import { getUserPrompt } from '../../src/ai/transform';
import type { TransformType } from '../../src/ai/transform';

describe('transform — getUserPrompt', () => {
    it('embeds the per-type instruction, the passage, and the reference context', () => {
        const prompt = getUserPrompt('improve', 'the selection', 'the document', 1000);
        expect(prompt).to.include('Polish');
        expect(prompt).to.include('Passage to rewrite');
        expect(prompt).to.include('the selection');
        expect(prompt).to.include('Reference context');
        expect(prompt).to.include('the document');
    });

    it.each<[TransformType, string]>([
        ['improve', 'Polish'],
        ['make-longer', 'LONGER'],
        ['make-shorter', 'Tighten']
    ])('uses the %s instruction', (type, marker) => {
        expect(getUserPrompt(type, 'sel', 'doc', 1000)).to.include(marker);
    });

    it('change-tone folds in the requested tone', () => {
        expect(getUserPrompt('change-tone', 'sel', 'doc', 1000, 'darker')).to.include('with a darker tone');
    });

    it('custom folds in the freeform instruction when provided', () => {
        expect(getUserPrompt('custom', 'sel', 'doc', 1000, 'rewrite from the antagonist perspective')).to.include(
            'according to this instruction: rewrite from the antagonist perspective'
        );
    });

    it('truncates the reference context with a middle-omission marker when it exceeds the budget', () => {
        const long = 'x'.repeat(2000);
        const prompt = getUserPrompt('improve', 'sel', long, 100);
        expect(prompt).to.include('(middle omitted)');
    });

    it('leaves the reference context intact when within the budget', () => {
        const prompt = getUserPrompt('improve', 'sel', 'short doc', 1000);
        expect(prompt).to.not.include('(middle omitted)');
        expect(prompt).to.include('short doc');
    });
});
