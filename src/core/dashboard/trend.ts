import type { ManuscriptSnapshot } from './types';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Format a human-readable velocity label for a snapshot series.
 *
 * Two regimes, picked by elapsed wall-clock time between the first and last
 * snapshot:
 *
 *   - **under a day** → `"<delta> words in <Hh Mm> across <N> snapshots"`.
 *     Honest about a short window — extrapolating to words/day from a
 *     sub-day sample inflates the figure ~24x and reads as nonsense
 *     ("31,409 words/day" for a manuscript that's only 1,610 words long).
 *   - **a day or more** → `"<delta> words/day over <N> snapshots"`. The
 *     steady-state pace, averaged across the elapsed window.
 *
 * Returns `null` when the series has fewer than two points or when the
 * timestamps are not strictly increasing (e.g., two snapshots taken in the
 * same millisecond via a rapid double-refresh) so the caller can skip the
 * line entirely rather than render a `NaN`/`Infinity` glitch.
 *
 * `snapshots` is assumed oldest-first (the order
 * {@link appendManuscriptSnapshot} writes them in); the caller is
 * responsible for sorting if it sources the array elsewhere.
 */
export function formatTrendVelocity(snapshots: ManuscriptSnapshot[]): string | null {
    if (snapshots.length < 2) return null;

    for (let i = 1; i < snapshots.length; i++) {
        if (snapshots[i]!.takenAt <= snapshots[i - 1]!.takenAt) return null;
    }

    const first = snapshots[0]!;
    const last = snapshots[snapshots.length - 1]!;
    const elapsedMs = last.takenAt - first.takenAt;
    if (elapsedMs <= 0) return null;

    const delta = last.totalWords - first.totalWords;
    const count = snapshots.length;

    if (elapsedMs < MS_PER_DAY) {
        const hours = Math.floor(elapsedMs / MS_PER_HOUR);
        const minutes = Math.floor((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE);
        const duration = hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m` : '<1m';
        return `${delta.toLocaleString()} words in ${duration} across ${count} snapshots`;
    }

    const days = elapsedMs / MS_PER_DAY;
    const perDay = Math.round(delta / days);
    return `${perDay.toLocaleString()} words/day over ${count} snapshots`;
}
