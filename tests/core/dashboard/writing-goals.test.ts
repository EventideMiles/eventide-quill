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
    touchSession,
    checkSessionIdle,
    writingGoalsPath,
    type WritingGoalsState
} from '../../../src/core/dashboard/writing-goals';

/** Epoch-ms for a local-date (y, m, d) — month is 1-indexed. */
const fixedDate = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('writing-goals — default state factory', () => {
    it('returns a value-equal copy of DEFAULT_WRITING_GOALS_STATE with fresh nested maps', () => {
        const state = defaultWritingGoalsState();
        expect(state).to.deep.equal(DEFAULT_WRITING_GOALS_STATE);
        expect(state.lastSeen).to.not.equal(DEFAULT_WRITING_GOALS_STATE.lastSeen);
        expect(state.days).to.not.equal(DEFAULT_WRITING_GOALS_STATE.days);
    });

    it('mutating a factory copy leaves the frozen default untouched', () => {
        const state = defaultWritingGoalsState();
        state.lastSeen['manuscript'] = 100;
        state.days['2026-01-01'] = 50;
        expect(DEFAULT_WRITING_GOALS_STATE.lastSeen).to.deep.equal({});
        expect(DEFAULT_WRITING_GOALS_STATE.days).to.deep.equal({});
        expect(() => {
            (DEFAULT_WRITING_GOALS_STATE as WritingGoalsState).bestStreak = 99;
        }).to.throw();
    });
});

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

    it('startSession initializes lastKeystrokeMs to startMs', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 10_000);
        expect(state.session!.lastKeystrokeMs).to.equal(10_000);
    });

    it('touchSession updates lastKeystrokeMs (no-op when no session)', () => {
        const state = defaultWritingGoalsState();
        // No active session — no-op.
        touchSession(state, 99_999);
        expect(state.session).to.equal(null);
        // Active session — updates lastKeystrokeMs.
        startSession(state, 'manuscript', 1000, 10_000);
        touchSession(state, 12_000);
        expect(state.session!.lastKeystrokeMs).to.equal(12_000);
        touchSession(state, 15_000);
        expect(state.session!.lastKeystrokeMs).to.equal(15_000);
        // startMs is preserved.
        expect(state.session!.startMs).to.equal(10_000);
    });
});

describe('writing-goals — checkSessionIdle', () => {
    it('returns stopped:false when no session is active', () => {
        const state = defaultWritingGoalsState();
        const result = checkSessionIdle(state, Date.now(), 20 * 60_000);
        expect(result.stopped).to.equal(false);
    });

    it('returns stopped:false when idleMs is <= 0 (feature disabled)', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 10_000);
        // Even with a huge gap since last keystroke, disabled threshold = no stop.
        const result = checkSessionIdle(state, 10_000 + 99 * 60_000, 0);
        expect(result.stopped).to.equal(false);
        expect(state.session).to.not.equal(null);
    });

    it('returns stopped:false when idle time is below the threshold', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 10_000);
        touchSession(state, 15_000); // last keystroke 5s after start
        // 10s after last keystroke — below 20min threshold.
        const result = checkSessionIdle(state, 15_000 + 10_000, 20 * 60_000);
        expect(result.stopped).to.equal(false);
        expect(state.session).to.not.equal(null);
    });

    it('stops + returns credited duration when idle >= threshold (20 min subtracted)', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 0); // startMs = 0
        // Writer typed for 30 minutes (last keystroke at 30min), then went idle.
        touchSession(state, 30 * 60_000);
        // 20 minutes later (now = 50min), the idle check fires.
        const result = checkSessionIdle(state, 50 * 60_000, 20 * 60_000);
        expect(result.stopped).to.equal(true);
        // Credited = lastKeystroke - start = 30 min. The idle tail is excluded.
        expect(result.creditedMs).to.equal(30 * 60_000);
        // Raw elapsed at the moment of stopping = 50 min.
        expect(result.rawElapsedMs).to.equal(50 * 60_000);
        // Session cleared.
        expect(state.session).to.equal(null);
    });

    it('boundary: idle exactly at threshold stops (>=, not just >)', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 0);
        touchSession(state, 10 * 60_000); // last keystroke at 10min
        // Exactly 20 minutes after last keystroke → threshold met.
        const result = checkSessionIdle(state, 10 * 60_000 + 20 * 60_000, 20 * 60_000);
        expect(result.stopped).to.equal(true);
        expect(result.creditedMs).to.equal(10 * 60_000);
    });

    it('credited duration clamps to 0 when the writer never typed after start', () => {
        const state = defaultWritingGoalsState();
        startSession(state, 'manuscript', 1000, 0); // lastKeystrokeMs = 0 (= startMs)
        // Threshold elapses with no further keystrokes.
        const result = checkSessionIdle(state, 20 * 60_000, 20 * 60_000);
        expect(result.stopped).to.equal(true);
        expect(result.creditedMs).to.equal(0);
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

    it('returns defaults when the persisted root is not an object', async () => {
        const vault = makeMemoryVault();
        await vault.adapter.write('.bad-root/writing-goals.json', JSON.stringify([1, 2, 3]));
        expect(await loadWritingGoals(vault, '.bad-root')).to.deep.equal(defaultWritingGoalsState());
    });

    it('returns defaults when any persisted field has the wrong shape', async () => {
        const badFields: Array<[string, unknown]> = [
            ['version', '1'],
            ['lastSeen', ['manuscript']],
            ['todayDate', 5],
            ['todayWords', '750'],
            ['days', { '2026-01-04': '500' }],
            ['bestStreak', '3'],
            ['session', { startMs: 1000, folder: 7, startTotal: 99 }]
        ];
        for (const [field, value] of badFields) {
            const vault = makeMemoryVault();
            await vault.adapter.write(
                '.bad-field/writing-goals.json',
                JSON.stringify({ ...defaultWritingGoalsState(), [field]: value })
            );
            const loaded = await loadWritingGoals(vault, '.bad-field');
            expect(loaded, `field ${field} should reject value ${JSON.stringify(value)}`).to.deep.equal(
                defaultWritingGoalsState()
            );
        }
    });

    it('maps nullish lastSeen/days to empty maps while preserving the rest', async () => {
        const vault = makeMemoryVault();
        // Serialize days as explicit null (JSON.stringify drops undefined keys
        // entirely, so undefined would never exercise the nullish handling).
        // The session omits lastKeystrokeMs to exercise the legacy-coalesce
        // path (older sidecars predate the idle-timeout feature).
        await vault.adapter.write(
            '.nullish-maps/writing-goals.json',
            JSON.stringify({
                version: 1,
                lastSeen: null,
                todayDate: '2026-01-05',
                todayWords: 250,
                days: null,
                bestStreak: 3,
                session: { startMs: 10_000, folder: 'manuscript', startTotal: 1000 }
            })
        );
        const loaded = await loadWritingGoals(vault, '.nullish-maps');
        expect(loaded).to.deep.equal({
            version: 1,
            lastSeen: {},
            todayDate: '2026-01-05',
            todayWords: 250,
            days: {},
            bestStreak: 3,
            // lastKeystrokeMs coalesced to startMs for the legacy session.
            session: { startMs: 10_000, folder: 'manuscript', startTotal: 1000, lastKeystrokeMs: 10_000 }
        });
    });

    it('preserves a valid persisted session', async () => {
        const vault = makeMemoryVault();
        const state = {
            ...defaultWritingGoalsState(),
            session: { startMs: 10_000, folder: 'manuscript', startTotal: 1000, lastKeystrokeMs: 12_000 }
        };
        await vault.adapter.write('.session/writing-goals.json', JSON.stringify(state));
        expect(await loadWritingGoals(vault, '.session')).to.deep.equal(state);
    });

    it('coalesces lastKeystrokeMs for legacy sessions that omit the field', async () => {
        const vault = makeMemoryVault();
        // Pre-idle-timeout sidecar: session has no lastKeystrokeMs.
        await vault.adapter.write(
            '.legacy-session/writing-goals.json',
            JSON.stringify({
                version: 1,
                lastSeen: {},
                todayDate: '2026-01-05',
                todayWords: 0,
                days: {},
                bestStreak: 0,
                session: { startMs: 5000, folder: 'manuscript', startTotal: 100 }
            })
        );
        const loaded = await loadWritingGoals(vault, '.legacy-session');
        expect(loaded.session).to.deep.equal({
            startMs: 5000,
            folder: 'manuscript',
            startTotal: 100,
            // Coalesced to startMs so the first idle check sees "just touched".
            lastKeystrokeMs: 5000
        });
    });

    it('rejects a session with malformed lastKeystrokeMs (string) and falls back to defaults', async () => {
        const vault = makeMemoryVault();
        await vault.adapter.write(
            '.malformed-session/writing-goals.json',
            JSON.stringify({
                version: 1,
                lastSeen: {},
                todayDate: '2026-01-05',
                todayWords: 0,
                days: {},
                bestStreak: 0,
                // lastKeystrokeMs is a string — isWritingSession rejects the
                // session, so isValidWritingGoalsState fails (session is
                // neither null nor a valid WritingSession). The loader falls
                // through to defaults.
                session: { startMs: 5000, folder: 'manuscript', startTotal: 100, lastKeystrokeMs: 'oops' }
            })
        );
        const loaded = await loadWritingGoals(vault, '.malformed-session');
        // The entire state is rejected — the malformed session must not
        // propagate into checkSessionIdle's duration math.
        expect(loaded.session).to.equal(null);
    });
});
