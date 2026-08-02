import { type DataAdapter, normalizePath } from 'obsidian';

/** Bundle schema version — bump when the portable-backup structure changes. */
export const PLUGIN_DATA_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Allowlist of plugin-data roots (relative to the plugin data directory) that
 * make up a portable backup. Plugin code files (main.js, manifest.json,
 * styles.css) are deliberately excluded — only writer-owned state ships.
 *
 * Embedding caches live in the VAULT (one `quill-embeddings.json` per indexed
 * folder), so they travel with the vault automatically and are not bundled
 * here; feedback-archive report notes likewise live in the vault.
 */
export const PLUGIN_DATA_ROOTS = [
    'data.json',
    'co-writer-sessions',
    'feedback-queue',
    'dashboards',
    'fandom-cache',
    'writing-goals.json'
] as const;

/** A portable backup of the plugin's writer-owned state. */
export interface PluginDataBundle {
    schemaVersion: number;
    exportedAt: string;
    pluginId: string;
    /** Map of plugin-data-dir-relative path to text content. */
    files: Record<string, string>;
}

/** Strip the dataDir prefix from a full vault path, normalizing separators. */
function relativize(path: string, dataDir: string): string | null {
    const prefix = normalizePath(dataDir);
    if (path !== prefix && !path.startsWith(prefix + '/')) return null;
    const rel = path.slice(prefix.length).replace(/^[/\\]+/, '');
    return rel.length > 0 ? rel : null;
}

/**
 * Reject parent-traversal, absolute, or empty paths so a restored bundle cannot
 * escape the plugin data directory. Returns the sanitized relative path or null.
 */
export function sanitizeRelPath(rel: string): string | null {
    if (rel.length === 0) return null;
    // Reject absolute paths from the raw input first — normalizePath strips a
    // leading slash, so it must be checked before normalization.
    if (rel.startsWith('/') || rel.startsWith('\\')) return null;
    const norm = normalizePath(rel);
    if (!norm) return null;
    if (norm.split('/').some((seg) => seg === '..')) return null;
    return norm;
}

/** Read a single allowlisted root (a file or a directory tree) into the files map. */
async function collectRoot(
    adapter: DataAdapter,
    absRoot: string,
    dataDir: string,
    files: Record<string, string>
): Promise<void> {
    const stat = await adapter.stat(absRoot);
    if (!stat) return;
    if (stat.type !== 'folder') {
        const rel = relativize(absRoot, dataDir);
        if (rel) {
            try {
                files[rel] = await adapter.read(absRoot);
            } catch {
                // Skip unreadable files.
            }
        }
        return;
    }
    const stack = [absRoot];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let listing: { files: string[]; folders: string[] };
        try {
            listing = await adapter.list(dir);
        } catch {
            continue;
        }
        for (const file of listing.files) {
            const rel = relativize(file, dataDir);
            if (!rel) continue;
            try {
                files[rel] = await adapter.read(file);
            } catch {
                // Skip unreadable files.
            }
        }
        for (const folder of listing.folders) {
            stack.push(folder);
        }
    }
}

/** Build a portable bundle of the allowlisted plugin-data roots. */
export async function exportPluginData(
    adapter: DataAdapter,
    dataDir: string,
    pluginId: string
): Promise<PluginDataBundle> {
    const files: Record<string, string> = {};
    for (const root of PLUGIN_DATA_ROOTS) {
        const abs = normalizePath(`${dataDir}/${root}`);
        if (await adapter.exists(abs)) {
            await collectRoot(adapter, abs, dataDir, files);
        }
    }
    return {
        schemaVersion: PLUGIN_DATA_BUNDLE_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        pluginId,
        files
    };
}

/** Create each missing ancestor directory of `filePath` (some adapters do not create parents). */
async function ensureAncestors(adapter: DataAdapter, filePath: string): Promise<void> {
    const parts = normalizePath(filePath).split('/');
    for (let i = 1; i < parts.length; i++) {
        const partial = normalizePath(parts.slice(0, i).join('/'));
        if (partial && !(await adapter.exists(partial))) {
            try {
                await adapter.mkdir(partial);
            } catch {
                // Ignore — may already exist or be a file parent.
            }
        }
    }
}

/**
 * Restore a bundle into the plugin data directory, overwriting existing files.
 * Paths are sanitized so the bundle cannot write outside the data directory.
 * Returns the number of files written.
 */
export async function importPluginData(
    adapter: DataAdapter,
    dataDir: string,
    bundle: PluginDataBundle,
    onProgress?: (done: number, total: number) => void
): Promise<number> {
    if (
        bundle.schemaVersion !== PLUGIN_DATA_BUNDLE_SCHEMA_VERSION ||
        !bundle.files ||
        typeof bundle.files !== 'object' ||
        Array.isArray(bundle.files)
    ) {
        throw new Error('Invalid Eventide Quill backup: missing schemaVersion or files map.');
    }
    const entries = Object.entries(bundle.files);
    const total = entries.length;
    let written = 0;
    let done = 0;
    for (const [rel, content] of entries) {
        done++;
        onProgress?.(done, total);
        const safe = sanitizeRelPath(rel);
        if (!safe || typeof content !== 'string') continue;
        const dest = normalizePath(`${dataDir}/${safe}`);
        await ensureAncestors(adapter, dest);
        await adapter.write(dest, content);
        written++;
    }
    return written;
}

/** Parse and validate a backup file's text into a bundle. */
export function parsePluginDataBundle(text: string): PluginDataBundle {
    const parsed = JSON.parse(text) as Partial<PluginDataBundle>;
    if (
        typeof parsed.schemaVersion !== 'number' ||
        typeof parsed.files !== 'object' ||
        parsed.files === null ||
        Array.isArray(parsed.files)
    ) {
        throw new Error('This file is not a valid Eventide Quill backup.');
    }
    return {
        schemaVersion: parsed.schemaVersion,
        exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
        pluginId: typeof parsed.pluginId === 'string' ? parsed.pluginId : '',
        files: parsed.files
    };
}
