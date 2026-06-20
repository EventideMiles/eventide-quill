import { normalizePath, Notice, Vault } from 'obsidian';
import type { EntityType } from '../context-engine/types';
import type { ManuscriptSnapshot } from './types';

/** Schema version for forward-compatibility migrations. */
const SCHEMA_VERSION = 1;

/** Filename for the per-manuscript data sidecar. Visible in the file system. */
const MANUSCRIPT_DATA_FILENAME = 'quill-data.json';

/** Per-manuscript dashboard data. Lives at `{manuscriptFolder}/quill-data.json`. */
export interface ManuscriptFileData {
    /** Schema version for forward-compatibility migrations. */
    schemaVersion: number;
    /** Per-manuscript word count target for chapters (overrides global setting). */
    wordCountTarget?: number;
    /** Per-manuscript total word count target (overrides global setting). */
    manuscriptTarget?: number;
    /** Target Flesch-Kincaid grade level for the readability display. */
    targetGradeLevel?: number;
    /** Split chapters by #/## headings within files (overrides global setting). */
    splitByHeading?: boolean;
    /** Recursively scan subfolders for chapter files (overrides global setting). */
    includeSubfolders?: boolean;
    /** Chapter file overrides relative to vault root. */
    chapterOverrides: {
        add: string[];
        remove: string[];
    };
    /** Entity type overrides: entity ID → new type. */
    reclassifiedEntities: Record<string, EntityType>;
    /** Entity IDs the user dismissed entirely (false positives, not any type). */
    dismissedEntities: string[];
    /** Historical word-count snapshots, oldest first. */
    snapshots: ManuscriptSnapshot[];
}

/** Build an empty manuscript file data object with defaults. */
function emptyManuscriptFileData(): ManuscriptFileData {
    return {
        schemaVersion: SCHEMA_VERSION,
        chapterOverrides: { add: [], remove: [] },
        reclassifiedEntities: {},
        dismissedEntities: [],
        snapshots: []
    };
}

/** Resolve the vault-relative path to the manuscript data file. */
export function manuscriptDataPath(folder: string): string {
    const clean = normalizePath(folder);
    return clean.length > 0 ? normalizePath(`${clean}/${MANUSCRIPT_DATA_FILENAME}`) : MANUSCRIPT_DATA_FILENAME;
}

/**
 * Load the manuscript data file for a given folder.
 *
 * Returns an empty record (no overrides, no snapshots) if the file does not
 * exist or fails to parse. Parse failures emit a Notice so the writer knows
 * their data was reset rather than silently lost.
 */
export async function loadManuscriptFile(vault: Vault, folder: string): Promise<ManuscriptFileData> {
    const path = manuscriptDataPath(folder);
    try {
        const exists = await vault.adapter.exists(path);
        if (!exists) return emptyManuscriptFileData();

        const raw = await vault.adapter.read(path);
        const parsed = JSON.parse(raw) as Partial<ManuscriptFileData>;

        return {
            schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
            wordCountTarget: parsed.wordCountTarget,
            manuscriptTarget: parsed.manuscriptTarget,
            targetGradeLevel: parsed.targetGradeLevel,
            splitByHeading: parsed.splitByHeading,
            includeSubfolders: parsed.includeSubfolders,
            chapterOverrides: {
                add: Array.isArray(parsed.chapterOverrides?.add) ? parsed.chapterOverrides.add : [],
                remove: Array.isArray(parsed.chapterOverrides?.remove) ? parsed.chapterOverrides.remove : []
            },
            reclassifiedEntities:
                typeof parsed.reclassifiedEntities === 'object' && parsed.reclassifiedEntities !== null
                    ? parsed.reclassifiedEntities
                    : {},
            dismissedEntities: Array.isArray(parsed.dismissedEntities) ? parsed.dismissedEntities : [],
            snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: could not read manuscript data (${message}). Starting fresh.`);
        return emptyManuscriptFileData();
    }
}

/**
 * Per-folder write-lock chain.
 *
 * Serializes the load-mutate-save cycle on the manuscript data file so
 * concurrent async operations targeting the same folder cannot overwrite
 * each other's changes. Each queued operation awaits the previous one
 * before running. Rejections on the internal chain are swallowed so a
 * single failure does not stall subsequent operations on that folder.
 */
const folderLocks = new Map<string, Promise<unknown>>();

/**
 * Run an async mutation while holding the per-folder write lock.
 *
 * `fn` is awaited only after any prior operation on the same `folder`
 * completes (success or failure). The returned promise propagates `fn`'s
 * own result or rejection to the caller.
 */
export function withFolderLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const prev = folderLocks.get(folder) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    folderLocks.set(
        folder,
        next.catch(() => {})
    );
    return next;
}

/**
 * Save the manuscript data file for a given folder.
 *
 * Creates parent directories lazily. Errors emit a Notice rather than
 * throwing, so callers don't need try/catch for non-critical writes.
 */
export async function saveManuscriptFile(vault: Vault, folder: string, data: ManuscriptFileData): Promise<void> {
    const path = manuscriptDataPath(folder);
    try {
        // Ensure parent directory exists (folder should already exist since
        // the manuscript files live there, but guard just in case).
        const dir = normalizePath(folder);
        if (dir.length > 0 && !(await vault.adapter.exists(dir))) {
            await vault.adapter.mkdir(dir);
        }

        const payload: ManuscriptFileData = {
            ...data,
            schemaVersion: SCHEMA_VERSION
        };

        await vault.adapter.write(path, JSON.stringify(payload, null, 2));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: could not save manuscript data (${message}).`);
    }
}

/**
 * Set or clear a single entity reclassification.
 *
 * Loads the current manuscript file, updates the single entry, and saves.
 * Pass `null` as `newType` to revert to the extracted type.
 */
export async function setEntityReclassification(
    vault: Vault,
    folder: string,
    entityId: string,
    newType: EntityType | null
): Promise<ManuscriptFileData> {
    return withFolderLock(folder, async () => {
        const data = await loadManuscriptFile(vault, folder);
        if (newType === null) {
            delete data.reclassifiedEntities[entityId];
        } else {
            data.reclassifiedEntities[entityId] = newType;
        }
        await saveManuscriptFile(vault, folder, data);
        return data;
    });
}

/**
 * Append a snapshot to the manuscript file, pruning oldest entries beyond `maxSnapshots`.
 * Returns the updated data.
 */
export async function appendManuscriptSnapshot(
    vault: Vault,
    folder: string,
    snapshot: ManuscriptSnapshot,
    maxSnapshots: number
): Promise<ManuscriptFileData> {
    return withFolderLock(folder, async () => {
        const data = await loadManuscriptFile(vault, folder);
        data.snapshots.push(snapshot);
        // Guard against invalid (negative) limits, which would otherwise loop
        // forever since array length can never drop below zero.
        const limit = Math.max(0, maxSnapshots);
        while (data.snapshots.length > limit) {
            data.snapshots.shift();
        }
        await saveManuscriptFile(vault, folder, data);
        return data;
    });
}
