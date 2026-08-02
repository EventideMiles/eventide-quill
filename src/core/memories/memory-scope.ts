/**
 * Memory scope resolution — derives the active memory scope from plugin
 * state and computes memory file paths. The scope key is the top-level
 * folder of the active manuscript file (`Manuscript/Chapters/04/chapter.md`
 * → `Manuscript`); files at vault root fall through to the global pool.
 *
 * The resolver chain:
 *   1. `plugin.currentManuscriptFolder` (sticky — set by dashboard refreshes;
 *      survives brief active-file changes to lore entries / daily notes).
 *   2. `workspace.getActiveFile()` (fallback when the dashboard hasn't
 *      refreshed yet, e.g. on first load).
 *   3. {@link GLOBAL_MEMORY_SCOPE} (final fallback when no file is active).
 *
 * Excluded top-level scopes (`.trash`, the Obsidian config dir per
 * `Vault#configDir`, and the memories folder itself) collapse to
 * {@link GLOBAL_MEMORY_SCOPE} so we never write a memory pool for system
 * directories. The lorebook folder is NOT excluded — it gets its own pool,
 * useful for lorebook-coach sessions.
 */

import { normalizePath } from 'obsidian';
import type EventideQuillPlugin from '../../main';
import { GLOBAL_MEMORY_SCOPE, MEMORY_FILE_SUFFIX } from './memory-file';

// Re-export so callers can import all memory constants from one module.
export { GLOBAL_MEMORY_SCOPE, MEMORY_FILE_SUFFIX };

/** Hardcoded top-level scopes that never get a memory pool. `.trash` is
 *  Obsidian's fixed trash folder; `.obsidian` is handled at runtime via
 *  `Vault#configDir` (which a writer can theoretically reconfigure). */
const HARDCODED_EXCLUDED_SCOPES = new Set(['.trash']);

/** Options bag for the exclusion check (keeps the helper pure + testable). */
export interface ExclusionOptions {
    /** Vault folder where memory files live. Scope key matching it is excluded. */
    readonly memoriesFolder: string;
    /** Scope key of the Obsidian config dir (typically `.obsidian`). */
    readonly configDirScope?: string;
}

/**
 * Derive the memory scope key (top-level folder) from a vault-relative path.
 * Returns {@link GLOBAL_MEMORY_SCOPE} when the path has no parent folder
 * (file at vault root) or when the path is empty.
 *
 * Pure: no plugin coupling, no side effects. Path is normalized first so
 * backslash / trailing-slash variations resolve consistently.
 *
 * Examples:
 *   `Manuscript/Chapters/04/chapter.md` → `Manuscript`
 *   `Manuscript/chapter.md`             → `Manuscript`
 *   `chapter.md`                        → `_global`
 *   `Manuscript/`                       → `Manuscript`
 *   ``                                  → `_global`
 */
export function scopeKeyFromPath(filePath: string): string {
    if (!filePath) return GLOBAL_MEMORY_SCOPE;
    const normalized = normalizePath(filePath);
    if (!normalized) return GLOBAL_MEMORY_SCOPE;
    const slash = normalized.indexOf('/');
    if (slash < 0) return GLOBAL_MEMORY_SCOPE;
    const top = normalized.slice(0, slash);
    return top || GLOBAL_MEMORY_SCOPE;
}

/**
 * True when `scopeKey` is on the exclusion list (the hardcoded system
 * scopes, the Obsidian config dir, the memories folder itself, or an
 * empty/global key). Excluded scopes collapse to {@link GLOBAL_MEMORY_SCOPE}
 * so we never create memory pools for them.
 *
 * Pure: takes the config dir as a parameter rather than reading
 * `Vault#configDir` so the helper is fully testable without plugin state.
 * Use {@link buildExcludedOptions} to construct the options from a plugin
 * instance at call sites.
 */
export function isExcludedScope(scopeKey: string, opts: ExclusionOptions): boolean {
    if (!scopeKey || scopeKey === GLOBAL_MEMORY_SCOPE) return true;
    if (HARDCODED_EXCLUDED_SCOPES.has(scopeKey)) return true;
    if (opts.configDirScope && scopeKey === opts.configDirScope) return true;
    return scopeKey === normalizePath(opts.memoriesFolder);
}

/**
 * Build the {@link ExclusionOptions} from a plugin instance. Resolves the
 * Obsidian config dir's top-level scope via {@link scopeKeyFromPath} so the
 * exclusion check has the actual configured path rather than a hardcoded
 * `.obsidian` (the writer can theoretically reconfigure the config dir,
 * though almost no one does).
 */
export function buildExcludedOptions(plugin: EventideQuillPlugin): ExclusionOptions {
    const configDir = plugin.app.vault.configDir;
    const configDirScope = configDir ? scopeKeyFromPath(configDir) : undefined;
    return {
        memoriesFolder: plugin.settings.memoriesFolder,
        configDirScope: configDirScope && configDirScope !== GLOBAL_MEMORY_SCOPE ? configDirScope : undefined
    };
}

/**
 * Resolve the active memory scope key from the plugin's current state.
 * Walks the resolver chain (manuscript folder → active file → global) and
 * applies the exclusion list at each step. Returns {@link GLOBAL_MEMORY_SCOPE}
 * when nothing else resolves.
 */
export function resolveActiveScopeKey(plugin: EventideQuillPlugin): string {
    const opts = buildExcludedOptions(plugin);

    const candidates: string[] = [];
    if (plugin.currentManuscriptFolder) {
        candidates.push(plugin.currentManuscriptFolder);
    }
    const activePath = plugin.app.workspace.getActiveFile()?.path;
    if (activePath) {
        candidates.push(activePath);
    }

    for (const candidate of candidates) {
        const scopeKey = scopeKeyFromPath(candidate);
        if (!isExcludedScope(scopeKey, opts)) {
            return scopeKey;
        }
    }

    return GLOBAL_MEMORY_SCOPE;
}

/**
 * Compute the vault-relative path for a scope's memory file. The format is
 * `<memoriesFolder>/<scopeKey>.memories.md`. For the global scope, the
 * filename is `_global.memories.md` (matching {@link GLOBAL_MEMORY_SCOPE}).
 *
 * Pure: no plugin coupling. `normalizePath` is applied to the result so
 * callers can pass it directly to `vault.getAbstractFileByPath()` /
 * `vault.create()` without re-normalizing.
 */
export function memoryFilePath(scopeKey: string, memoriesFolder: string): string {
    const safeKey = scopeKey || GLOBAL_MEMORY_SCOPE;
    return normalizePath(`${memoriesFolder}/${safeKey}${MEMORY_FILE_SUFFIX}`);
}

/**
 * True when `filePath` points at a file inside the memories folder (any
 * memory file, in any scope). Used by the raw-edit guard on the generic
 * editing tools (`edit_note`, `insert_note`, `append_to_note`, `revise_edit`)
 * so the model can't bypass the dedicated `save_memory` / `delete_memory`
 * tools and clobber block IDs by editing the raw markdown.
 *
 * Handles both flat (`Memories/...`) and nested (`Quill/Memories/...`)
 * memories-folder configurations via a normalized startsWith check.
 */
export function isMemoryFilePath(filePath: string, memoriesFolder: string): boolean {
    if (!filePath) return false;
    const normalizedFile = normalizePath(filePath);
    const normalizedFolder = normalizePath(memoriesFolder);
    return normalizedFile === normalizedFolder || normalizedFile.startsWith(`${normalizedFolder}/`);
}

