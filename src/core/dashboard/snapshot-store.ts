import { Notice, Vault } from 'obsidian';
import { ManuscriptSnapshot, ManuscriptSnapshotFile } from './types';

/** Convert a folder path into a safe filename slug for the snapshot JSON. */
export function manuscriptIdFromFolder(folder: string): string {
    // Collapse path separators and non-alphanumerics into single hyphens.
    const slug = folder
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || 'root';
}

/**
 * Load the snapshot file for a manuscript.
 *
 * Reads `${dataDir}/dashboards/<id>.json`. Returns an empty record (no
 * snapshots) if the file does not exist or fails to parse. Parse failures
 * emit a Notice so the writer knows their history was reset rather than
 * silently lost.
 *
 * @param vault        Obsidian vault (for adapter access).
 * @param dataDir      Absolute path to the plugin's data directory.
 * @param manuscriptId Slugified manuscript identifier.
 */
export async function loadSnapshots(
    vault: Vault,
    dataDir: string,
    manuscriptId: string
): Promise<ManuscriptSnapshotFile> {
    const filePath = `${dataDir}/dashboards/${manuscriptId}.json`;
    try {
        const exists = await vault.adapter.exists(filePath);
        if (!exists) {
            return { manuscriptId, folder: '', snapshots: [] };
        }
        const raw = await vault.adapter.read(filePath);
        const parsed = JSON.parse(raw) as ManuscriptSnapshotFile;
        if (!parsed || !Array.isArray(parsed.snapshots)) {
            return { manuscriptId, folder: '', snapshots: [] };
        }
        return parsed;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: Could not read dashboard history (${message}). Starting fresh.`);
        return { manuscriptId, folder: '', snapshots: [] };
    }
}

/**
 * Append a snapshot to the manuscript's history file, pruning the oldest
 * entries to stay within `maxSnapshots`.
 *
 * Creates the `dashboards/` directory and the JSON file lazily on first
 * write. The folder field is updated to reflect the current source folder.
 *
 * @param vault        Obsidian vault.
 * @param dataDir      Absolute path to the plugin's data directory.
 * @param manuscriptId Slugified manuscript identifier.
 * @param folder       Folder path the manuscript was resolved from.
 * @param snapshot     The snapshot to append.
 * @param maxSnapshots Maximum snapshots to retain (oldest pruned first).
 */
export async function appendSnapshot(
    vault: Vault,
    dataDir: string,
    manuscriptId: string,
    folder: string,
    snapshot: ManuscriptSnapshot,
    maxSnapshots: number
): Promise<void> {
    const dirPath = `${dataDir}/dashboards`;
    const filePath = `${dirPath}/${manuscriptId}.json`;

    try {
        if (!(await vault.adapter.exists(dirPath))) {
            await vault.adapter.mkdir(dirPath);
        }

        const existing = await loadSnapshots(vault, dataDir, manuscriptId);
        const snapshots = [...existing.snapshots, snapshot];

        // Prune oldest entries beyond the cap.
        while (snapshots.length > maxSnapshots) {
            snapshots.shift();
        }

        const file: ManuscriptSnapshotFile = {
            manuscriptId,
            folder,
            snapshots
        };

        await vault.adapter.write(filePath, JSON.stringify(file, null, 2));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: Could not save dashboard snapshot (${message}).`);
    }
}
