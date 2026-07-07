import { describe, it, expect } from 'vitest';
import { AI_MODE_CONFIGS } from '../../src/ai/modes';
import type { AiMode } from '../../src/ai/modes';

const EXPECTED_MODES: AiMode[] = ['narrative', 'analysis', 'critical', 'linter', 'manuscript-analysis'];

describe('AI_MODE_CONFIGS', () => {
    it('has a config entry for every AiMode', () => {
        for (const mode of EXPECTED_MODES) {
            expect(AI_MODE_CONFIGS[mode]).toBeDefined();
            expect(AI_MODE_CONFIGS[mode].id).toBe(mode);
        }
    });

    it('every config has a non-empty label and description', () => {
        for (const mode of EXPECTED_MODES) {
            const config = AI_MODE_CONFIGS[mode];
            expect(config.label.length).toBeGreaterThan(0);
            expect(config.description.length).toBeGreaterThan(0);
        }
    });

    it('every config has positive temperature and token limits', () => {
        for (const mode of EXPECTED_MODES) {
            const config = AI_MODE_CONFIGS[mode];
            expect(config.defaultTemperature).toBeGreaterThan(0);
            expect(config.defaultMaxOutputTokens).toBeGreaterThan(0);
        }
    });

    it('narrative mode has the highest temperature (most creative)', () => {
        const narrative = AI_MODE_CONFIGS.narrative.defaultTemperature;
        for (const mode of EXPECTED_MODES) {
            if (mode === 'narrative') continue;
            expect(narrative).toBeGreaterThanOrEqual(AI_MODE_CONFIGS[mode].defaultTemperature);
        }
    });

    it('linter mode has the lowest temperature (most precise)', () => {
        const linter = AI_MODE_CONFIGS.linter.defaultTemperature;
        for (const mode of EXPECTED_MODES) {
            if (mode === 'linter') continue;
            expect(linter).toBeLessThanOrEqual(AI_MODE_CONFIGS[mode].defaultTemperature);
        }
    });

    it('narrative mode has the highest token limit (longest output)', () => {
        const narrative = AI_MODE_CONFIGS.narrative.defaultMaxOutputTokens;
        for (const mode of EXPECTED_MODES) {
            if (mode === 'narrative') continue;
            expect(narrative).toBeGreaterThanOrEqual(AI_MODE_CONFIGS[mode].defaultMaxOutputTokens);
        }
    });
});
