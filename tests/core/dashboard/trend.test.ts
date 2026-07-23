import { describe, it, expect } from 'vitest';
import { formatTrendVelocity } from '../../../src/core/dashboard/trend';
import type { ManuscriptSnapshot } from '../../../src/core/dashboard/types';

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

/** Build a snapshot series from a list of [minutesSinceEpoch, wordCount] tuples. */
function series(...entries: Array<[minutes: number, words: number]>): ManuscriptSnapshot[] {
    return entries.map(([minutes, words]) => ({
        takenAt: minutes * MS_MIN,
        totalWords: words,
        chapterCount: 1,
        perChapterWords: [{ filePath: 'a.md', title: 'A', wordCount: words }]
    }));
}

describe('formatTrendVelocity', () => {
    it('returns null for fewer than two snapshots', () => {
        expect(formatTrendVelocity(series([0, 0]))).toBeNull();
        expect(formatTrendVelocity([])).toBeNull();
    });

    it('returns null when timestamps are not strictly increasing', () => {
        expect(formatTrendVelocity(series([5, 100], [5, 200]))).toBeNull();
        expect(formatTrendVelocity(series([5, 200], [3, 100]))).toBeNull();
    });

    // Regression: a non-monotonic middle pair is not caught by the endpoint
    // check alone (first < last), so the per-pair scan is required to reject
    // a sequence like [0, 10, 5] whose endpoints look fine.
    it('returns null when any adjacent pair is not strictly increasing', () => {
        expect(formatTrendVelocity(series([0, 0], [10, 200], [5, 400]))).toBeNull();
    });

    it('uses sub-day "<delta> words in <Hh Mm> across N" form for short windows', () => {
        // 1,610 words over 73 minutes — the bug report's scenario.
        // 73 minutes = 1h 13m.
        const result = formatTrendVelocity(series([0, 0], [73, 1610]));
        expect(result).toBe('1,610 words in 1h 13m across 2 snapshots');
    });

    it('omits the hour component when under an hour', () => {
        expect(formatTrendVelocity(series([0, 0], [45, 500]))).toBe('500 words in 45m across 2 snapshots');
    });

    it('renders "<1m" for sub-minute windows', () => {
        expect(formatTrendVelocity(series([0, 0], [0.5, 200]))).toBe('200 words in <1m across 2 snapshots');
    });

    it('counts all snapshots in the series, not just the endpoints', () => {
        const result = formatTrendVelocity(series([0, 0], [10, 200], [20, 400], [30, 600]));
        expect(result).toBe('600 words in 30m across 4 snapshots');
    });

    it('handles zero delta (saves with no word change)', () => {
        expect(formatTrendVelocity(series([0, 500], [30, 500]))).toBe('0 words in 30m across 2 snapshots');
    });

    it('handles negative delta (deletions) without a sign prefix on the day form', () => {
        // 500 words deleted over 2 hours.
        const result = formatTrendVelocity(series([0, 1000], [120, 500]));
        expect(result).toBe('-500 words in 2h 0m across 2 snapshots');
    });

    it('switches to words/day at exactly one day elapsed', () => {
        // 1,440 words in exactly 1 day → 1,440 words/day.
        const result = formatTrendVelocity(series([0, 0], [MS_DAY / MS_MIN, 1440]));
        expect(result).toBe('1,440 words/day over 2 snapshots');
    });

    it('uses words/day form for multi-day windows', () => {
        // 5,000 words over 5 days.
        const days5Min = (5 * MS_DAY) / MS_MIN;
        const result = formatTrendVelocity(series([0, 0], [days5Min, 5000]));
        expect(result).toBe('1,000 words/day over 2 snapshots');
    });

    it('handles negative day-form delta as "-N words/day"', () => {
        // Lost 1,000 words over 2 days → -500/day.
        const days2Min = (2 * MS_DAY) / MS_MIN;
        const result = formatTrendVelocity(series([0, 2000], [days2Min, 1000]));
        expect(result).toBe('-500 words/day over 2 snapshots');
    });

    it('does not extrapolate a sub-day window into the words/day figure', () => {
        // The bug report: 1,610 words in ~73 min used to render as ~31,409 words/day.
        const result = formatTrendVelocity(series([0, 0], [73, 1610]));
        expect(result).not.toContain('words/day');
        expect(result).toContain('1,610 words in');
    });
});
