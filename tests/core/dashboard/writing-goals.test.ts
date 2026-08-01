import { describe, expect, it } from 'vitest';
import { makeMemoryVault } from '../../helpers/memory-vault';
import {
    DEFAULT_WRITING_GOALS_STATE,
    computeStreak,
    dateKey,
    defaultWritingGoalsState,
    loadWritingGoals,
    recordProgress,
    saveWritingGoals,
    sessionElapsed,
    sessionWords,
    startSession,
    stopSession,
    writingGoalsPath,
    type WritingGoalsState
} from '../../../src/core/dashboard/writing-goals';

const fixedDate = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('writing-goals — dateKey', () => {
    it('formats a local YYYY-MM-DD', () => {
        expect(dateKey(fixedDate(2026, 1, 5))).to.equal('2026-01-05');
        expect(dateKey(fixedDate(2026, 12, 31))).to.equal('2026-12-31');
    });
});

describe('writing-goals — recordProgress', () => {
    it('sets the per-folder baseline on the first observation (no delta credited)', () => {
        const state = defaultWritingGoalsState();
        recordProgress(state, 'manuscript', 1000, fixedDate(2026, 1, 1));
        expect(state.lastSeen['manuscript']).to.equal(1000);
        expect(state.todayWords).to.equal(0);
        expect(state.todayDate).to.equal('2026-01-01');
    });

    it('credits net increases since the last observation to today', () => {
        const state = defaultWritingGoalsState();
        const now = fixedDate(2026, 1, 1);
        recordProgress(state, 'manuscript', 1000, now);
        recordProgress(state, 'manuscript', 1500, now);
        expect(state.todayWords).to.equal(500);
        recordProgress(state, 'manuscript', 1800, now);
        expect(state.todayWords).to.equal(800);
    });

    it('does not subtract on a word-count decrease (net-words semantics)', () => {
        const state = defaultWritingGoalsState();
        const now = fixedDate(2026, 1, 1);
        recordProgress(state, 'manuscript', 1000, now);
        recordProgress(state, 'manuscript', 1500, now);
        recordProgress(state, 'manuscript', 1200, now); // deletions
        expect(state.todayWords).to.equal(500);
        expect(state.lastSeen['manuscript']).to.equal(1200);
    });

    it('tracks folders independently', () => {
        const state = defaultWritingGoalsState();
        const now = fixedDate(2026, 1, 1);
        recordProgress(state, 'book-a', 1000, now);
        recordProgress(state, 'book-b', 500, now);
        recordProgress(state, 'book-a', 1200, now);
        recordProgress(state, 'book-b', 900, now);
        expect(state.todayWords).to.equal(200 + 400);
    });

    it('finalizes the previous day and rolls the baseline at midnight', () => {
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayDate: '2026-01-01',
            todayWords: 500,
            lastSeen: { manuscript: 1000 }
        };
        // Next day: 1200 total. The delta (1200 - 1000 = 200) is credited to the
        // new day; the previous day's 500 is finalized into `days`.
        recordProgress(state, 'manuscript', 1200, fixedDate(2026, 1, 2));
        expect(state.days['2026-01-01']).to.equal(500);
        expect(state.todayDate).to.equal('2026-01-02');
        expect(state.todayWords).to.equal(200);
        expect(state.lastSeen['manuscript']).to.equal(1200);
    });
});

describe('writing-goals — computeStreak', () => {
    const goal = 500;
    const today = fixedDate(2026, 1, 5);

    it('returns 0 when the goal is disabled (<=0)', () => {
        const state = { ...defaultWritingGoalsState(), todayWords: 9999 };
        expect(computeStreak(state, 0, today)).to.equal(0);
    });

    it('counts today when the goal is already met', () => {
        const state: WritingGoalsState = { ...defaultWritingGoalsState(), todayWords: 600 };
        expect(computeStreak(state, goal, today)).to.equal(1);
    });

    it('counts today plus consecutive met days behind it', () => {
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayWords: 600,
            days: { '2026-01-04': 500, '2026-01-03': 700, '2026-01-02': 500 }
        };
        expect(computeStreak(state, goal, today)).to.equal(4);
    });

    it('grace: an unmet today does not break a streak built on prior days', () => {
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayWords: 0,
            days: { '2026-01-04': 500, '2026-01-03': 600 }
        };
        expect(computeStreak(state, goal, today)).to.equal(2);
    });

    it('breaks when a day behind the run did not meet the goal', () => {
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayWords: 600,
            days: { '2026-01-04': 500, '2026-01-03': 100 } // Jan 3 missed
        };
        expect(computeStreak(state, goal, today)).to.equal(2); // today + Jan 4
    });

    it('returns 0 when nothing is met and no history qualifies', () => {
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayWords: 0,
            days: { '2026-01-04': 100 }
        };
        expect(computeStreak(state, goal, today)).to.equal(0);
    });
});

describe('writing-goals — sessions', () => {
    it('starts, measures words + elapsed, and stops', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 10_000);
        expect(state.session).to.not.equal(null);
        expect(sessionWords(state, 1500)).to.equal(500);
        expect(sessionElapsed(state, 10_000 + 60_000)).to.equal(60_000);
        // Deletions during a session clamp to 0.
        expect(sessionWords(state, 900)).to.equal(0);
        stopSession(state);
        expect(state.session).to.equal(null);
        expect(sessionWords(state, 9999)).to.equal(0);
        expect(sessionElapsed(state, 99_000)).to.equal(0);
    });
});

describe('writing-goals — sidecar persistence', () => {
    it('round-trips state through load/save', async () => {
        const vault = makeMemoryVault();
        const dir = '.test-data';
        const state: WritingGoalsState = {
            ...defaultWritingGoalsState(),
            todayDate: '2026-01-05',
            todayWords: 750,
            days: { '2026-01-04': 500 },
            bestStreak: 3,
            lastSeen: { manuscript: 1234 }
        };
        await saveWritingGoals(vault, dir, state);
        const loaded = await loadWritingGoals(vault, dir);
        expect(loaded).to.deep.equal(state);
        expect(writingGoalsPath(dir)).to.equal('.test-data/writing-goals.json');
    });

    it('returns defaults when the sidecar is absent', async () => {
        const loaded = await loadWritingGoals(makeMemoryVault(), '.missing');
        expect(loaded).to.deep.equal(defaultWritingGoalsState());
    });

    it('returns defaults when the sidecar is corrupt', async () => {
        const vault = makeMemoryVault();
        await saveWritingGoals(vault, '.corrupt', defaultWritingGoalsState());
        // Corrupt the file directly.
        await vault.adapter.write('.corrupt/writing-goals.json', '{ not valid json');
        const loaded = await loadWritingGoals(vault, '.corrupt');
        expect(loaded).to.deep.equal(defaultWritingGoalsState());
    });
});
