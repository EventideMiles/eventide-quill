/**
 * Writing goals & sessions — the deterministic core of the 2.0.0 flagship.
 *
 * Tracks a daily words-written ledger (derived from manuscript word-count
 * deltas observed on dashboard refresh), a writing streak, and an optional
 * focus-session timer. All logic is pure functions over a serializable
 * {@link WritingGoalsState}; persistence is a single sidecar
 * (`<pluginDataDir>/writing-goals.json`) following the project's sidecar
 * convention (`vault.adapter` + `normalizePath`, mkdir-on-first-write).
 *
 * No AI, no network — matches the project's "deterministic first" principle.
 */
import { normalizePath, Vault } from 'obsidian';

const WRITING_GOALS_FILENAME = 'writing-goals.json';

export interface WritingSession {
    /** Epoch ms when the session started. */
    startMs: number;
    /** Manuscript folder the session started in. */
    folder: string;
    /** Manuscript total word count at session start. */
    startTotal: number;
}

export interface WritingGoalsState {
    version: number;
    /** Per-folder last-seen manuscript total — the baseline for delta tracking. */
    lastSeen: Record<string, number>;
    /** 'YYYY-MM-DD' (local) that {@link todayWords} pertains to. */
    todayDate: string;
    /** Net words written so far today (across all manuscripts). */
    todayWords: number;
    /** Final words-written for past days: 'YYYY-MM-DD' -> net words. */
    days: Record<string, number>;
    /** Longest streak ever achieved (days). */
    bestStreak: number;
    /** Active focus session, or null. */
    session: WritingSession | null;
}

export const DEFAULT_WRITING_GOALS_STATE: WritingGoalsState = {
    version: 1,
    lastSeen: {},
    todayDate: '',
    todayWords: 0,
    days: {},
    bestStreak: 0,
    session: null
};

export function writingGoalsPath(dataDir: string): string {
    return normalizePath(`${dataDir}/${WRITING_GOALS_FILENAME}`);
}

export async function loadWritingGoals(vault: Vault, dataDir: string): Promise<WritingGoalsState> {
    const path = writingGoalsPath(dataDir);
    try {
        if (!(await vault.adapter.exists(path))) return { ...DEFAULT_WRITING_GOALS_STATE };
        const raw = await vault.adapter.read(path);
        const parsed = JSON.parse(raw) as Partial<WritingGoalsState>;
        return { ...DEFAULT_WRITING_GOALS_STATE, ...parsed, lastSeen: parsed.lastSeen ?? {}, days: parsed.days ?? {} };
    } catch {
        return { ...DEFAULT_WRITING_GOALS_STATE };
    }
}

export async function saveWritingGoals(vault: Vault, dataDir: string, state: WritingGoalsState): Promise<void> {
    const path = writingGoalsPath(dataDir);
    try {
        const dir = normalizePath(dataDir);
        if (!(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
        await vault.adapter.write(path, JSON.stringify(state, null, 2));
    } catch {
        // Sidecar persistence is best-effort — a failed write must not break the dashboard.
    }
}

/** Local 'YYYY-MM-DD' for the given epoch ms. */
export function dateKey(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDays(key: string, delta: number): string {
    const parts = key.split('-').map(Number);
    const date = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1);
    date.setDate(date.getDate() + delta);
    return dateKey(date.getTime());
}

/**
 * Record a manuscript word-count observation: attribute the net increase since
 * the last observation of this folder to today's ledger, handling day rollover.
 * Mutates `state` in place and returns it.
 */
export function recordProgress(
    state: WritingGoalsState,
    folder: string,
    total: number,
    now: number
): WritingGoalsState {
    const today = dateKey(now);
    if (state.todayDate !== today) {
        // Finalize the previous day's running total before rolling over.
        if (state.todayDate) state.days[state.todayDate] = state.todayWords;
        state.todayDate = today;
        state.todayWords = 0;
    }
    const last = state.lastSeen[folder];
    if (last !== undefined && total > last) {
        state.todayWords += total - last;
    }
    state.lastSeen[folder] = total;
    return state;
}

/**
 * Current streak (consecutive days meeting `goal`, ending today). Today counts
 * if it's already met; otherwise the streak extends back from yesterday, so an
 * in-progress day doesn't read as a break. `goal <= 0` disables streaks.
 */
export function computeStreak(state: WritingGoalsState, goal: number, now: number): number {
    if (goal <= 0) return 0;
    let streak = 0;
    let cursor = dateKey(now);
    if (state.todayWords >= goal) {
        streak++;
        cursor = addDays(cursor, -1);
    }
    for (;;) {
        const v = state.days[cursor];
        if (v === undefined || v < goal) break;
        streak++;
        cursor = addDays(cursor, -1);
    }
    return streak;
}

export function startSession(state: WritingGoalsState, folder: string, total: number, now: number): WritingGoalsState {
    state.session = { startMs: now, folder, startTotal: total };
    return state;
}

export function stopSession(state: WritingGoalsState): WritingGoalsState {
    state.session = null;
    return state;
}

/** Net words written during the active session (0 if none). */
export function sessionWords(state: WritingGoalsState, currentTotal: number): number {
    return state.session ? Math.max(0, currentTotal - state.session.startTotal) : 0;
}

/** Elapsed ms of the active session (0 if none). */
export function sessionElapsed(state: WritingGoalsState, now: number): number {
    return state.session ? now - state.session.startMs : 0;
}
