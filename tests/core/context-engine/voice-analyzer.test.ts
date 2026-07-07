import { describe, it, expect } from 'vitest';
import { analyzeVoice, computeDialogueRatio } from '../../../src/core/context-engine/voice-analyzer';

describe('analyzeVoice', () => {
    it('returns unknown markers for empty text', () => {
        const result = analyzeVoice('');
        expect(result.pov).toBe('unknown');
        expect(result.tense).toBe('unknown');
        expect(result.avgSentenceLength).toBe(0);
        expect(result.dialogueRatio).toBe(0);
        expect(result.descriptionRatio).toBe(1);
    });

    it('detects first-person POV', () => {
        const text = 'I walked to the store. I bought milk. I saw my friend. I went home. I was tired.';
        const result = analyzeVoice(text);
        expect(result.pov).toBe('first-person');
    });

    it('detects third-person POV', () => {
        const text =
            'She walked to the store. He bought milk. They went home. She was happy. He saw her there.';
        const result = analyzeVoice(text);
        expect(result.pov).toBe('third-person');
    });

    it('detects past tense', () => {
        const text =
            'She walked to the store. He went inside. They bought milk. She saw him. He turned away.';
        const result = analyzeVoice(text);
        expect(result.tense).toBe('past');
    });

    it('detects present tense', () => {
        const text =
            'She walks to the store. He goes inside. They buy milk. She sees him. He turns away.';
        const result = analyzeVoice(text);
        expect(result.tense).toBe('present');
    });

    it('computes average sentence length', () => {
        const text = 'One two three four. Five six seven eight nine.';
        const result = analyzeVoice(text);
        expect(result.avgSentenceLength).toBeGreaterThan(0);
    });
});

describe('computeDialogueRatio', () => {
    it('returns 0 dialogue for pure description', () => {
        const result = computeDialogueRatio('The wind howled across the empty plain.');
        expect(result.dialogueRatio).toBe(0);
        expect(result.descriptionRatio).toBe(1);
    });

    it('returns high dialogue ratio for dialogue-heavy text', () => {
        const result = computeDialogueRatio('"Hello there, how are you today?" she asked.');
        expect(result.dialogueRatio).toBeGreaterThan(0);
        expect(result.descriptionRatio).toBeLessThan(1);
    });

    it('returns 0 dialogue and 1 description for empty text', () => {
        const result = computeDialogueRatio('');
        expect(result.dialogueRatio).toBe(0);
        expect(result.descriptionRatio).toBe(1);
    });

    it('dialogue and description ratios sum approximately to 1', () => {
        const text = 'He walked in. "What do you want?" he asked. She shrugged.';
        const result = computeDialogueRatio(text);
        expect(result.dialogueRatio + result.descriptionRatio).toBeCloseTo(1, 1);
    });

    it('handles unmatched quotes gracefully', () => {
        const result = computeDialogueRatio('He said "hello and walked away');
        expect(result.dialogueRatio).toBeGreaterThanOrEqual(0);
        expect(result.dialogueRatio).toBeLessThanOrEqual(1);
    });
});
