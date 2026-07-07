import { describe, it, expect } from 'vitest';
import {
    MANUSCRIPT_PRESETS,
    DEFAULT_WORD_COUNT_TARGET,
    DEFAULT_MANUSCRIPT_TARGET,
    DEFAULT_TARGET_GRADE_LEVEL,
    DEFAULT_SPLIT_BY_HEADING,
    DEFAULT_INCLUDE_SUBFOLDERS
} from '../../../src/core/dashboard/presets';

describe('MANUSCRIPT_PRESETS', () => {
    it('contains at least the standard-novel preset', () => {
        const ids = MANUSCRIPT_PRESETS.map((p) => p.id);
        expect(ids).toContain('standard-novel');
    });

    it.each(MANUSCRIPT_PRESETS)('$id has non-empty label, description, and positive targets', (preset) => {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.description.length).toBeGreaterThan(0);
        expect(preset.wordCountTarget).toBeGreaterThan(0);
        expect(preset.manuscriptTarget).toBeGreaterThan(0);
        expect(preset.targetGradeLevel).toBeGreaterThan(0);
    });

    it('has no duplicate ids', () => {
        const ids = MANUSCRIPT_PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('manuscriptTarget exceeds wordCountTarget for every preset', () => {
        for (const preset of MANUSCRIPT_PRESETS) {
            expect(preset.manuscriptTarget).toBeGreaterThan(preset.wordCountTarget);
        }
    });
});

describe('DEFAULT_* constants', () => {
    it('DEFAULT_WORD_COUNT_TARGET matches standard-novel', () => {
        const standard = MANUSCRIPT_PRESETS.find((p) => p.id === 'standard-novel');
        expect(DEFAULT_WORD_COUNT_TARGET).toBe(standard!.wordCountTarget);
    });

    it('DEFAULT_MANUSCRIPT_TARGET matches standard-novel', () => {
        const standard = MANUSCRIPT_PRESETS.find((p) => p.id === 'standard-novel');
        expect(DEFAULT_MANUSCRIPT_TARGET).toBe(standard!.manuscriptTarget);
    });

    it('DEFAULT_TARGET_GRADE_LEVEL matches standard-novel', () => {
        const standard = MANUSCRIPT_PRESETS.find((p) => p.id === 'standard-novel');
        expect(DEFAULT_TARGET_GRADE_LEVEL).toBe(standard!.targetGradeLevel);
    });

    it('DEFAULT_SPLIT_BY_HEADING is false', () => {
        expect(DEFAULT_SPLIT_BY_HEADING).toBe(false);
    });

    it('DEFAULT_INCLUDE_SUBFOLDERS is true', () => {
        expect(DEFAULT_INCLUDE_SUBFOLDERS).toBe(true);
    });
});
