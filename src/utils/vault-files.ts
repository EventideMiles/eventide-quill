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

/**
 * Resolve @-mentioned file paths in text to vault file paths and add them
 * to context. Matches `@` followed by non-whitespace, trims trailing
 * sentence punctuation, then attempts resolution before falling back to
 * the email guard (skips tokens that look like email domains: dot with no
 * path separator).
 *
 * Resolution priority (first match wins):
 *   1. Exact vault path match
 *   2. Exact vault path with `.md` appended
 *   3. Base filename match (last path segment without extension)
 *   4. Substring match on full path (case-insensitive)
 *
 * Returns the resolved file paths and the text with `@` stripped from
 * resolved mentions (resolved text becomes the bare path, unresolved
 * mentions keep their `@` prefix unchanged).
 */
export function resolveAtMentions(text: string, vault: Vault): { resolvedPaths: string[]; cleanedText: string } {
    const markdownFiles = vault.getMarkdownFiles();
    const resolvedPaths: string[] = [];

    // Two mention forms:
    //   @"path with spaces.md"  — quoted, space-safe (what FileMentionSuggest
    //                            inserts; also the recommended form for slash
    //                            commands and pasted prompts that reference
    //                            spaced paths).
    //   @bare-token             — bare. Resolved GREEDILY: @ captures text to
    //                            end-of-line / next @, then we trim trailing
    //                            words until a prefix resolves. This lets a bare
    //                            "@folder/File With Spaces.md" resolve as a whole
    //                            (the naive @\S+ form stops at the first space,
    //                            which collapsed several spaced mentions onto one
    //                            file — and skipped them in pasted/slash prompts).
    let out = text.replace(/@"([^"]+)"/g, (_m, path: string) => {
        const resolved = resolveMentionToPath(path, markdownFiles);
        if (resolved) {
            if (!resolvedPaths.includes(resolved)) resolvedPaths.push(resolved);
            return path; // strip the @ and quotes; keep the path inline
        }
        return _m;
    });

    out = out.replace(/@(?!")([^\n@]+)/g, (m, rest: string) => {
        let candidate = rest.replace(/\s+$/, '');
        while (candidate.length > 0) {
            const resolved = resolveMentionToPath(candidate, markdownFiles);
            if (resolved) {
                if (!resolvedPaths.includes(resolved)) resolvedPaths.push(resolved);
                // Drop the @, keep the resolved path plus whatever trailed it
                // on the line (so "ref and more" stays readable).
                return candidate + rest.slice(candidate.length);
            }
            const sp = candidate.lastIndexOf(' ');
            if (sp <= 0) break;
            candidate = candidate.slice(0, sp);
        }
        // Unresolved (incl. emails) — leave the @ intact.
        return m;
    });

    return { resolvedPaths, cleanedText: out };
}

/** Try to resolve a bare @mention to a vault file path. */
function resolveMentionToPath(mention: string, files: TFile[]): string | null {
    // 1. Exact path match
    const exact = files.find((f) => f.path === mention);
    if (exact) return exact.path;

    // 2. Exact path with .md appended
    const withExt = files.find((f) => f.path === `${mention}.md`);
    if (withExt) return withExt.path;

    // 3. Base filename (last segment, no extension)
    const baseName = mention.split('/').pop() ?? mention;
    const nameMatch = files.find((f) => {
        const name = f.path.split('/').pop()?.replace(/\.md$/, '');
        return name === baseName;
    });
    if (nameMatch) return nameMatch.path;

    // 4. Substring match on full path (case-insensitive)
    const lower = mention.toLowerCase();
    const subMatch = files.find((f) => f.path.toLowerCase().includes(lower));
    if (subMatch) return subMatch.path;

    return null;
}
