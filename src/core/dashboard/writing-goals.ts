/**
 * Writing goals & sessions — the deterministic core of the 2.2.0 flagship.
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
    /** Epoch ms of the most recent keystroke. Initially equals {@link startMs};
     *  updated by `touchSession` on every `workspace.on('editor-change')` event.
     *  Drives the idle-timeout auto-stop ({@link checkSessionIdle}). */
    lastKeystrokeMs: number;
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

/**
 * Frozen base shape for a fresh ledger. Nested objects are empty so the
 * freeze is shallow — callers must use {@link defaultWritingGoalsState} to
 * get mutable copies.
 */
export const DEFAULT_WRITING_GOALS_STATE: Readonly<WritingGoalsState> = Object.freeze({
    version: 1,
    lastSeen: Object.freeze({}) as Record<string, number>,
    todayDate: '',
    todayWords: 0,
    days: Object.freeze({}) as Record<string, number>,
    bestStreak: 0,
    session: null
});

/** Return a fresh, mutable copy of the default state with independent maps. */
export function defaultWritingGoalsState(): WritingGoalsState {
    return {
        version: 1,
        lastSeen: {},
        todayDate: '',
        todayWords: 0,
        days: {},
        bestStreak: 0,
        session: null
    };
}

/** True when `value` is a plain (non-null, non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain object whose every value is a number (the `lastSeen`/`days` maps). */
function isNumberRecord(value: unknown): value is Record<string, number> {
    return isRecord(value) && Object.values(value).every((v) => typeof v === 'number');
}

/** Shape guard for a persisted {@link WritingSession}. */
function isWritingSession(value: unknown): value is WritingSession {
    return (
        isRecord(value) &&
        typeof value.startMs === 'number' &&
        typeof value.folder === 'string' &&
        typeof value.startTotal === 'number' &&
        // lastKeystrokeMs is optional for backward compat (sessions persisted
        // before the idle-timeout feature lack it). When present, it must be a
        // number — malformed values (string, null) are rejected so the loader
        // falls through to defaults rather than propagating invalid data into
        // checkSessionIdle's duration math.
        (value.lastKeystrokeMs === undefined || typeof value.lastKeystrokeMs === 'number')
    );
}

/** Every persisted field (when present) has its expected shape. Nullish `lastSeen`/`days`/`session` stay valid — the nullish-map handling maps them to defaults. */
function isValidWritingGoalsState(value: unknown): value is WritingGoalsState {
    if (!isRecord(value)) return false;
    return (
        typeof value.version === 'number' &&
        (value.lastSeen == null || isNumberRecord(value.lastSeen)) &&
        typeof value.todayDate === 'string' &&
        typeof value.todayWords === 'number' &&
        (value.days == null || isNumberRecord(value.days)) &&
        typeof value.bestStreak === 'number' &&
        (value.session == null || isWritingSession(value.session))
    );
}

/** Path to the writing-goals sidecar under the plugin data directory. */
export function writingGoalsPath(dataDir: string): string {
    return normalizePath(`${dataDir}/${WRITING_GOALS_FILENAME}`);
}

/** Load the writing-goals ledger from its sidecar (best-effort; defaults on miss/corruption). */
export async function loadWritingGoals(vault: Vault, dataDir: string): Promise<WritingGoalsState> {
    const path = writingGoalsPath(dataDir);
    try {
        if (!(await vault.adapter.exists(path))) return defaultWritingGoalsState();
        const raw = await vault.adapter.read(path);
        const parsed: unknown = JSON.parse(raw);
        if (!isValidWritingGoalsState(parsed)) return defaultWritingGoalsState();
        return {
            ...defaultWritingGoalsState(),
            ...parsed,
            lastSeen: parsed.lastSeen ?? {},
            days: parsed.days ?? {},
            // Coalesce lastKeystrokeMs for sessions persisted before the
            // idle-timeout feature (field absent → default to startMs so the
            // first idle check sees the session as "just touched").
            session: parsed.session
                ? { ...parsed.session, lastKeystrokeMs: parsed.session.lastKeystrokeMs ?? parsed.session.startMs }
                : null
        };
    } catch {
        return defaultWritingGoalsState();
    }
}

/** Persist the writing-goals ledger to its sidecar (best-effort; never throws). */
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

/** Shift a 'YYYY-MM-DD' key by `delta` days (negative walks backwards). */
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
    }
    // Walk consecutive met days back from today (or yesterday, if today isn't
    // met yet — an in-progress day doesn't break the streak).
    cursor = addDays(cursor, -1);
    for (;;) {
        const v = state.days[cursor];
        if (v === undefined || v < goal) break;
        streak++;
        cursor = addDays(cursor, -1);
    }
    return streak;
}

/** Start a focus session anchored to the current manuscript word count. */
export function startSession(state: WritingGoalsState, folder: string, total: number, now: number): WritingGoalsState {
    state.session = { startMs: now, folder, startTotal: total, lastKeystrokeMs: now };
    return state;
}

/**
 * Mark the active session as just-touched (the writer typed something).
 * Updates {@link WritingSession.lastKeystrokeMs} to `now`, which the
 * idle-timeout check ({@link checkSessionIdle}) uses as the basis for
 * "stopped + threshold subtracted from length". No-op when no session is
 * active. Does NOT persist — callers persist on their own cadence (the
 * 30s idle-check tick coalesces the write).
 */
export function touchSession(state: WritingGoalsState, now: number): WritingGoalsState {
    if (state.session) state.session.lastKeystrokeMs = now;
    return state;
}

/**
 * Result of an idle-check tick. When `stopped` is true, `creditedMs` is the
 * duration the writer actually spent typing (`lastKeystrokeMs - startMs`),
 * which excludes the idle tail — equivalent to "threshold subtracted from
 * raw elapsed". When false, the session continues.
 */
export interface SessionIdleCheck {
    /** True when the idle threshold was met and the session was stopped. */
    stopped: boolean;
    /** Credited writing duration in ms (only set when `stopped`). */
    creditedMs?: number;
    /** Raw elapsed at the moment of stopping (only set when `stopped`). */
    rawElapsedMs?: number;
}

/**
 * Check whether the active session has been idle past `idleMs`. When idle
 * time (`now - lastKeystrokeMs`) is greater than or equal to the threshold,
 * the session is stopped and the credited duration (`lastKeystrokeMs -
 * startMs`) is returned — equivalent to "threshold subtracted from raw
 * elapsed". The session is cleared from state on stop.
 *
 * `idleMs <= 0` disables the idle check (the function is a no-op). This
 * lets the writer turn the feature off via `writingSessionIdleMinutes: 0`.
 *
 * Pure aside from mutating `state.session` (the documented contract of
 * every function in this module).
 */
export function checkSessionIdle(state: WritingGoalsState, now: number, idleMs: number): SessionIdleCheck {
    if (idleMs <= 0 || !state.session) return { stopped: false };
    const idleFor = now - state.session.lastKeystrokeMs;
    if (idleFor < idleMs) return { stopped: false };
    const creditedMs = Math.max(0, state.session.lastKeystrokeMs - state.session.startMs);
    const rawElapsedMs = Math.max(0, now - state.session.startMs);
    state.session = null;
    return { stopped: true, creditedMs, rawElapsedMs };
}

/** End the active focus session (clears the session field; no-op if none). */
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
