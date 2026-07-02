/**
 * Persisted co-writer conversation sessions.
 *
 * Stores each saved conversation as its own JSON sidecar under
 * `<pluginDataDir>/co-writer-sessions/<id>.json`, plus a lightweight
 * `index.json` carrying the list metadata (id, title, mode, timestamps,
 * message count, size). This mirrors the `manuscript-file.ts` / `embedding-cache`
 * sidecar convention (NOT Obsidian's `loadData()`/`saveData()`, which is
 * settings-only): `vault.adapter` reads/writes, `normalizePath()` everywhere,
 * mkdir-on-first-write, a serialized write lock on the index, and Notice-on-error.
 *
 * The stored blob is a {@link SerializedCoWriterState} — plain JSON-roundtrippable
 * data; ephemeral runtime concerns (callbacks, AbortController, editor locks)
 * are absent and rebind on restore via `wireCoWriterPanel()`.
 */
import { Notice, type Vault } from 'obsidian';
import { normalizePath } from 'obsidian';
import type { SerializedCoWriterState } from './co-writer';

const SCHEMA_VERSION = 1;
const SESSION_ID_RE = /^cw_[a-z0-9_]+$/;
const SESSIONS_FOLDER = 'co-writer-sessions';
const INDEX_FILENAME = 'index.json';

class InvalidSessionIdError extends Error {
    constructor(id: string, detail?: string) {
        super(detail ? `Invalid session id: ${id} (${detail})` : `Invalid session id: ${id}`);
        this.name = 'InvalidSessionIdError';
    }
}

/** Resolve a session sidecar path, validating the id first. */
function sessionFilePath(dir: string, id: string): string {
    if (!SESSION_ID_RE.test(id)) {
        throw new InvalidSessionIdError(id, 'path construction');
    }
    return normalizePath(`${dir}/${id}.json`);
}

/** One row in the session list (the index). */
export interface SessionIndexEntry {
    id: string;
    title: string;
    mode: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    sizeBytes: number;
}

/** On-disk shape of the index file. */
interface SessionIndexFile {
    schemaVersion: number;
    entries: SessionIndexEntry[];
}

/** On-disk shape of one session sidecar. */
interface SessionBlob {
    schemaVersion: number;
    id: string;
    createdAt: number;
    updatedAt: number;
    title: string;
    state: SerializedCoWriterState;
}

/** Resolve the sessions directory under a plugin data dir. */
export function resolveSessionsDir(dataDir: string): string {
    return normalizePath(`${dataDir}/${SESSIONS_FOLDER}`);
}

async function ensureDir(vault: Vault, dir: string): Promise<void> {
    const exists = await vault.adapter.exists(dir);
    if (!exists) await vault.adapter.mkdir(dir);
}

async function readJson<T>(vault: Vault, path: string): Promise<T | null> {
    if (!(await vault.adapter.exists(path))) return null;
    try {
        const raw = await vault.adapter.read(path);
        return JSON.parse(raw) as T;
    } catch (err) {
        // Corrupt sidecar — don't bring down the feature; report and treat as absent.
        console.warn(`Quill: failed to read ${path}`, err);
        return null;
    }
}

/** A short, human title derived from the first user turn (or "Untitled"). */
function deriveTitle(state: SerializedCoWriterState): string {
    const firstUser = state.chatHistory.find((m) => m.role === 'user');
    const text = (firstUser?.content ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return 'Untitled';
    return text.length > 60 ? `${text.slice(0, 60)}\u2026` : text;
}

// Per-process write lock on the index so concurrent saves (e.g. a save
// racing an unload-snapshot) don't clobber each other's index update.
let indexWriteChain: Promise<void> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = indexWriteChain.then(fn, fn);
    // Swallow rejections on the stored chain so a failed write doesn't poison
    // every subsequent save; the caller still sees the rejection via `next`.
    indexWriteChain = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

/** List saved sessions, newest-first by updatedAt (ties broken by createdAt). */
export async function listSessions(vault: Vault, dir: string): Promise<SessionIndexEntry[]> {
    const index = await readJson<SessionIndexFile>(vault, normalizePath(`${dir}/${INDEX_FILENAME}`));
    const entries = index?.entries ?? [];
    return [...entries].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export interface SaveSessionOptions {
    /** Existing session id to overwrite (preserves createdAt); omit for a new snapshot. */
    id?: string;
    /** Max sessions to retain (LRU-evict older). */
    limit?: number;
}

/**
 * Persist a session snapshot. Returns the resulting index entry. Creates a new
 * sidecar when no `id` is given; otherwise updates the existing one in place
 * (keeping its `createdAt`) and refreshes its index row.
 */
export async function saveSession(
    vault: Vault,
    dir: string,
    state: SerializedCoWriterState,
    opts: SaveSessionOptions = {}
): Promise<SessionIndexEntry> {
    await ensureDir(vault, dir);
    if (opts.id && !SESSION_ID_RE.test(opts.id)) {
        throw new InvalidSessionIdError(opts.id, 'user-provided');
    }
    const now = Date.now();
    const id = opts.id ?? `cw_${now.toString(36)}_${(Math.random() * 46656) | 0}`;
    if (!SESSION_ID_RE.test(id)) {
        throw new InvalidSessionIdError(id, 'generated');
    }
    const sessionPath = sessionFilePath(dir, id);

    // Read the existing entry (if any) to preserve createdAt and title.
    const indexPath = normalizePath(`${dir}/${INDEX_FILENAME}`);
    const existing = await withIndexLock(async () => readJson<SessionIndexFile>(vault, indexPath));
    const priorEntry = existing?.entries.find((e) => e.id === id);
    const createdAt = priorEntry?.createdAt ?? now;
    const title = deriveTitle(state);

    const blob: SessionBlob = {
        schemaVersion: SCHEMA_VERSION,
        id,
        createdAt,
        updatedAt: now,
        title,
        state
    };
    const json = JSON.stringify(blob);

    const entry: SessionIndexEntry = {
        id,
        title,
        mode: state.mode,
        createdAt,
        updatedAt: now,
        messageCount: state.chatHistory.length,
        sizeBytes: json.length
    };

    try {
        await vault.adapter.write(sessionPath, json);
        await withIndexLock(async () => {
            const cur = (await readJson<SessionIndexFile>(vault, indexPath)) ?? {
                schemaVersion: SCHEMA_VERSION,
                entries: []
            };
            const entries = cur.entries.filter((e) => e.id !== id);
            entries.push(entry);
            const limit = opts.limit && opts.limit > 0 ? opts.limit : entries.length;
            // Evict oldest beyond the limit (LRU by updatedAt). Delete their
            // sidecar files too so nothing is orphaned on disk.
            const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
            const keep = sorted.slice(0, limit);
            const evict = sorted.slice(limit);
            for (const e of evict) {
                try {
                    const p = sessionFilePath(dir, e.id);
                    if (await vault.adapter.exists(p)) await vault.adapter.remove(p);
                } catch (err) {
                    console.warn(`Quill: skipping eviction for unsafe session id: ${e.id}`, err);
                }
            }
            const out: SessionIndexFile = { schemaVersion: SCHEMA_VERSION, entries: keep };
            await vault.adapter.write(indexPath, JSON.stringify(out, null, 2));
        });
    } catch (err) {
        console.warn(`Quill: failed to save co-writer session ${id}`, err);
        new Notice('Could not save the conversation.');
        throw err;
    }
    return entry;
}

function isValidState(state: unknown): state is SerializedCoWriterState {
    if (!state || typeof state !== 'object') return false;
    const s = state as Record<string, unknown>;
    return (
        typeof s.mode === 'string' &&
        Array.isArray(s.chatHistory) &&
        Array.isArray(s.discussCurrentMessages) &&
        Array.isArray(s.loreCoachMessages) &&
        (s.manuscriptPath === null || typeof s.manuscriptPath === 'string') &&
        (s.voiceProfile === null || typeof s.voiceProfile === 'object') &&
        Array.isArray(s.contextFilePaths) &&
        Array.isArray(s.recentImages) &&
        s.fulfillChanges !== null &&
        typeof s.fulfillChanges === 'object' &&
        !Array.isArray(s.fulfillChanges) &&
        s.directChanges !== null &&
        typeof s.directChanges === 'object' &&
        !Array.isArray(s.directChanges) &&
        Array.isArray(s.loreEdits) &&
        Array.isArray(s.proposedLoreImages) &&
        Array.isArray(s.subagents) &&
        (s.activeSubagentId === null || typeof s.activeSubagentId === 'string') &&
        (s.coachSession === null || typeof s.coachSession === 'object') &&
        typeof s.coachActive === 'boolean' &&
        (s.loreCoachSession === null || typeof s.loreCoachSession === 'object') &&
        typeof s.loreCoachActive === 'boolean' &&
        (s.currentLoreDraft === null || typeof s.currentLoreDraft === 'object') &&
        Array.isArray(s.currentOptions)
    );
}

/** Load one session's state by id (null if missing or unparsable). */
export async function loadSession(vault: Vault, dir: string, id: string): Promise<SerializedCoWriterState | null> {
    let sessionPath: string;
    try {
        sessionPath = sessionFilePath(dir, id);
    } catch {
        console.warn(`Quill: rejecting malformed session id in loadSession: ${id}`);
        return null;
    }
    const blob = await readJson<SessionBlob>(vault, sessionPath);
    if (!blob) return null;
    if (!isValidState(blob.state)) {
        console.warn(`Quill: corrupt or incompatible session blob for ${id}`);
        return null;
    }
    return blob.state;
}

/** Delete one session (sidecar + index row). No-op if absent. */
export async function deleteSession(vault: Vault, dir: string, id: string): Promise<void> {
    let sessionPath: string;
    try {
        sessionPath = sessionFilePath(dir, id);
    } catch {
        console.warn(`Quill: rejecting malformed session id in deleteSession: ${id}`);
        return;
    }
    await withIndexLock(async () => {
        if (await vault.adapter.exists(sessionPath)) {
            await vault.adapter.remove(sessionPath);
        }
        const indexPath = normalizePath(`${dir}/${INDEX_FILENAME}`);
        const cur = await readJson<SessionIndexFile>(vault, indexPath);
        if (!cur) return;
        const out: SessionIndexFile = {
            schemaVersion: SCHEMA_VERSION,
            entries: cur.entries.filter((e) => e.id !== id)
        };
        await vault.adapter.write(indexPath, JSON.stringify(out, null, 2));
    });
}
