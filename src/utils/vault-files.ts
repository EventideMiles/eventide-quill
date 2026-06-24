import { normalizePath, TFile, Vault } from 'obsidian';
import type { ChatMessage } from '../ai/provider';

/** Path prefix for a top-K embedded folder in the context file list. */
export const EMBED_PATH_PREFIX = 'embed:';
/** Path prefix for a full-embed folder in the context file list. */
export const EMBED_FULL_PATH_PREFIX = 'embed-full:';

/** Check if a context file path represents an embedded folder. */
export function isEmbedFolderPath(path: string): boolean {
    return path.startsWith(EMBED_PATH_PREFIX) || path.startsWith(EMBED_FULL_PATH_PREFIX);
}

/** Parse the folder path and mode from an embed path. */
export function parseEmbedFolderPath(path: string): { folderPath: string; mode: 'top-k' | 'full' } | null {
    if (path.startsWith(EMBED_FULL_PATH_PREFIX)) {
        return { folderPath: path.slice(EMBED_FULL_PATH_PREFIX.length), mode: 'full' };
    }
    if (path.startsWith(EMBED_PATH_PREFIX)) {
        return { folderPath: path.slice(EMBED_PATH_PREFIX.length), mode: 'top-k' };
    }
    return null;
}

/** Build an embed path for a folder. */
export function buildEmbedFolderPath(folderPath: string, mode: 'top-k' | 'full'): string {
    return mode === 'full' ? `${EMBED_FULL_PATH_PREFIX}${folderPath}` : `${EMBED_PATH_PREFIX}${folderPath}`;
}

/** Get the display label for an embedded folder item. */
export function embedFolderLabel(folderName: string, mode: 'top-k' | 'full'): string {
    return mode === 'full' ? `${folderName} full embed` : `${folderName} embedded`;
}

/**
 * Map lorebook folders to `embed:` context paths (top-K mode).
 *
 * Pure mapping — the caller decides whether to include them based on the
 * `coWriterLoreContext` / `reviewLoreContext` toggles. Returned paths feed
 * straight into the existing embed-resolution pipeline, so lore entries are
 * retrieved via the same per-folder top-K + embedding cache as manual folder
 * context.
 */
export function loreFolderEmbedPaths(folders: string[]): string[] {
    return folders.map((f) => buildEmbedFolderPath(f, 'top-k'));
}

/**
 * Find all folders that have a quill-embeddings.json cache file.
 * Synchronous — uses TFile metadata already loaded by Obsidian.
 * @param allFiles All files in the vault (from vault.getFiles()).
 * @returns A set of folder paths (vault-relative, no trailing slash).
 */
export function findEmbeddedFolders(allFiles: TFile[]): Set<string> {
    const folders = new Set<string>();
    for (const file of allFiles) {
        if (file.name !== 'quill-embeddings.json') continue;
        const parentPath = file.parent?.path ?? '';
        if (parentPath && parentPath !== '/') {
            folders.add(parentPath);
        }
    }
    return folders;
}

/**
 * Read a single vault file's content as raw text, capped to maxChars.
 * Best-effort: returns empty string if the file cannot be found or read.
 *
 * @param vault     The Obsidian vault.
 * @param filePath  Path to read.
 * @param maxChars  Optional character limit.
 * @returns The file's text (capped), or empty string on failure.
 */
export async function readVaultFileText(vault: Vault, filePath: string, maxChars?: number): Promise<string> {
    try {
        const file = vault.getAbstractFileByPath(normalizePath(filePath));
        if (!(file instanceof TFile)) return '';
        const content = await vault.cachedRead(file);
        const safeMax =
            typeof maxChars === 'number' && maxChars >= 0 && Number.isFinite(maxChars)
                ? Math.floor(maxChars)
                : undefined;
        return safeMax !== undefined ? content.slice(0, safeMax) : content;
    } catch {
        return '';
    }
}

/**
 * Read vault files by path and return them as system messages.
 * Best-effort: files that cannot be read are silently skipped.
 *
 * @param vault      The Obsidian vault.
 * @param filePaths  Paths to read.
 * @param label      Prefix label for each message (e.g. "Manuscript", "Reference file").
 * @param maxChars   Optional character limit per file. When omitted, full content is used.
 */
export async function readVaultFiles(
    vault: Vault,
    filePaths: string[],
    label: string,
    maxChars?: number
): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const filePath of filePaths) {
        try {
            const file = vault.getAbstractFileByPath(normalizePath(filePath));
            if (file instanceof TFile) {
                const content = await vault.cachedRead(file);
                const safeMax =
                    typeof maxChars === 'number' && maxChars >= 0 && Number.isFinite(maxChars)
                        ? Math.floor(maxChars)
                        : undefined;
                const excerpt = safeMax !== undefined ? content.slice(0, safeMax) : content;
                messages.push({
                    role: 'system',
                    content: `${label} (${filePath}):\n${excerpt}`
                });
            }
        } catch {
            // Best-effort
        }
    }
    return messages;
}
