import { describe, it, expect } from 'vitest';
import { NARRATIVE_VOICE_PRESETS } from '../src/types';
import type { NarrativeVoicePreset } from '../src/types';

const EXPECTED_IDS: NarrativeVoicePreset[] = [
    'third-limited',
    'third-multiple',
    'third-omniscient',
    'first-person',
    'second-person',
    'custom'
];

describe('NARRATIVE_VOICE_PRESETS', () => {
    it('contains all expected preset ids', () => {
        const ids = NARRATIVE_VOICE_PRESETS.map((p) => p.id);
        for (const id of EXPECTED_IDS) {
            expect(ids).toContain(id);
        }
    });

    it('every preset has a non-empty label, pov, tense, and rules array', () => {
        for (const preset of NARRATIVE_VOICE_PRESETS) {
            expect(preset.label.length).toBeGreaterThan(0);
            expect(preset.pov.length).toBeGreaterThan(0);
            expect(preset.tense.length).toBeGreaterThan(0);
            expect(preset.rules.length).toBeGreaterThan(0);
        }
    });

    it('has "third-limited" as the first entry (fallback default)', () => {
        expect(NARRATIVE_VOICE_PRESETS[0]!.id).toBe('third-limited');
    });

    it('has "custom" as the last entry', () => {
        const last = NARRATIVE_VOICE_PRESETS[NARRATIVE_VOICE_PRESETS.length - 1];
        expect(last!.id).toBe('custom');
    });

    it('every rule is a non-empty string', () => {
        for (const preset of NARRATIVE_VOICE_PRESETS) {
            for (const rule of preset.rules) {
                expect(typeof rule).toBe('string');
                expect(rule.length).toBeGreaterThan(0);
            }
        }
    });

    it('has no duplicate ids', () => {
        const ids = NARRATIVE_VOICE_PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
