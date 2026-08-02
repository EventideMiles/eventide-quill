/**
 * Vault-aware memory store — reads and writes `.memories.md` files in the
 * configured `memoriesFolder`. The pure-logic parsing/serialization lives
 * in {@link memory-file.ts}; this module wraps those operations with vault
 * I/O (file lookup, mkdir-on-first-write, atomic-ish modify, re-tokenize
 * on read).
 *
 * Conventions match the rest of the codebase:
 *   - `normalizePath()` on every constructed path (Obsidian reviewer rule).
 *   - mkdir-on-first-write for the memories folder.
 *   - Best-effort I/O with `Notice` on failure (vault unavailable, etc.).
 *   - Re-tokenize pass runs on every read, so writer-added sections without
 *     a `^quill-mem-*` ID are auto-minted before the data leaves the store.
 *     The write-back is best-effort (a failed write becomes a console
 *     warning, not a user-facing error — the read still returns content).
 */

import { normalizePath, Notice, TFile, type Vault } from 'obsidian';
import type EventideQuillPlugin from '../../main';
import {
    assignMissingIds,
    parseMemoryFile,
    serializeMemoryFile,
    type MemoryEntry,
    type MemoryFile
} from './memory-file';
import { GLOBAL_MEMORY_SCOPE, memoryFilePath, resolveActiveScopeKey } from './memory-scope';

/** Result of a memory-file read. `exists=false` when the file has no entries yet. */
export interface ReadMemoryResult {
    /** True when the file existed on disk and was parsed. */
    readonly exists: boolean;
    /** The scope key the file belongs to (passed through for convenience). */
    readonly scopeKey: string;
    /** Vault-relative path to the file. */
    readonly path: string;
    /** Parsed file structure (empty entries when the file doesn't exist). */
    readonly file: MemoryFile;
}

/** Empty memory file (used when the file doesn't exist yet). */
function emptyMemoryFile(): MemoryFile {
    return { title: '', intro: '', entries: [] };
}

/**
 * Read a scope's memory file. Returns an empty-entries result when the file
 * doesn't exist yet (caller decides whether to create on write). Runs the
 * re-tokenize pass on success and best-effort writes back when any IDs
 * were minted, so the next reader sees a fully-tagged file.
 *
 * Scope key `_global` reads the global pool; any other key reads that
 * manuscript's pool. The path is computed via {@link memoryFilePath}.
 */
export async function readMemoryFile(plugin: EventideQuillPlugin, scopeKey: string): Promise<ReadMemoryResult> {
    const memoriesFolder = normalizePath(plugin.settings.memoriesFolder);
    const path = memoryFilePath(scopeKey, memoriesFolder);
    const vault = plugin.app.vault;

    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        return { exists: false, scopeKey, path, file: emptyMemoryFile() };
    }

    let raw: string;
    try {
        raw = await vault.cachedRead(file);
    } catch (err) {
        console.warn(`Quill: could not read memory file "${path}"`, err);
        return { exists: false, scopeKey, path, file: emptyMemoryFile() };
    }

    const parsed = parseMemoryFile(raw);

    // Re-tokenize: mint IDs for any writer-added sections without one. Best-effort
    // write-back so the file stays canonical across edits.
    const retokenized = assignMissingIds(parsed.entries);
    if (retokenized.changed) {
        void writeMemoryFileRaw(vault, path, file, { ...parsed, entries: retokenized.entries });
    }

    return {
        exists: true,
        scopeKey,
        path,
        file: { ...parsed, entries: retokenized.entries }
    };
}

/**
 * Read both the active-manuscript pool and the global pool in one call.
 * Returns the entries from each (manuscript first, then global), suitable
 * for the index injection layer and for `recall_memory(scope: 'all')`.
 * Either pool may be empty (file doesn't exist yet) without error.
 */
export async function readActiveAndGlobal(plugin: EventideQuillPlugin): Promise<{
    active: ReadMemoryResult;
    global: ReadMemoryResult;
}> {
    const activeKey = resolveActiveScopeKey(plugin);
    const [active, global] = await Promise.all([
        readMemoryFile(plugin, activeKey),
        readMemoryFile(plugin, GLOBAL_MEMORY_SCOPE)
    ]);
    return { active, global };
}

/** Outcome of a write — surfaces the new entry's id to the caller. */
export interface WriteMemoryResult {
    /** The scope key the write landed in. */
    readonly scopeKey: string;
    /** Vault-relative path to the file. */
    readonly path: string;
    /** Whether a new file was created (vs modifying an existing one). */
    readonly created: boolean;
}

/**
 * Persist a memory file to disk. Creates the memories folder on first
 * write (mkdir-on-first-write pattern, matching {@link feedback-archive} /
 * `conversation-store`). Creates the file if it doesn't exist; modifies
 * it in place if it does.
 */
export async function writeMemoryFile(
    plugin: EventideQuillPlugin,
    scopeKey: string,
    file: MemoryFile
): Promise<WriteMemoryResult> {
    const memoriesFolder = normalizePath(plugin.settings.memoriesFolder);
    const vault = plugin.app.vault;

    // Ensure the memories folder exists. Idempotent — exists check + mkdir.
    if (!(await vault.adapter.exists(memoriesFolder))) {
        try {
            await vault.adapter.mkdir(memoriesFolder);
        } catch (err) {
            console.warn(`Quill: could not create memories folder "${memoriesFolder}"`, err);
            new Notice('Quill: could not create the memories folder — vault unavailable.');
            throw err;
        }
    }

    const path = memoryFilePath(scopeKey, memoriesFolder);
    const existing = vault.getAbstractFileByPath(path);
    const content = serializeMemoryFile(file, scopeKey === GLOBAL_MEMORY_SCOPE ? 'Global' : scopeKey);
    const created = !(existing instanceof TFile);
    await writeMemoryFileRaw(vault, path, existing instanceof TFile ? existing : null, file, content);
    return { scopeKey, path, created };
}

/** Low-level write: create-or-modify with the given (already-serialized) content. */
async function writeMemoryFileRaw(
    vault: Vault,
    path: string,
    existingFile: TFile | null,
    file: MemoryFile,
    contentOverride?: string
): Promise<void> {
    const content = contentOverride ?? serializeMemoryFile(file);
    try {
        if (existingFile) {
            await vault.modify(existingFile, content);
        } else {
            await vault.create(path, content);
        }
    } catch (err) {
        console.warn(`Quill: could not write memory file "${path}"`, err);
        // Re-throw on create — callers expect the file to exist after a "create" call.
        // Swallow on modify (best-effort retokenization write-back).
        if (!existingFile) throw err;
    }
}

/**
 * Resolve a `scope` argument (`'auto'`, `'manuscript'`, `'global'`, or
 * `'all'`) to one or two concrete scope keys. `'all'` returns both the
 * active scope and the global scope; the others return a single key.
 *
 * `'manuscript'` returns the active scope (which may itself be global
 * when the writer isn't on a manuscript file — a graceful degradation
 * the model rarely needs to know about).
 */
export function resolveScopeArg(plugin: EventideQuillPlugin, scope: string): {
    keys: string[];
    label: string;
} {
    if (scope === 'global') return { keys: [GLOBAL_MEMORY_SCOPE], label: 'global' };
    if (scope === 'all') {
        const active = resolveActiveScopeKey(plugin);
        return active === GLOBAL_MEMORY_SCOPE
            ? { keys: [GLOBAL_MEMORY_SCOPE], label: 'global' }
            : { keys: [active, GLOBAL_MEMORY_SCOPE], label: 'active + global' };
    }
    // 'auto' or 'manuscript' — both resolve to the active scope.
    const active = resolveActiveScopeKey(plugin);
    return { keys: [active], label: active === GLOBAL_MEMORY_SCOPE ? 'global' : active };
}

/**
 * Find which scope's memory file contains an entry with the given block ID.
 * Checks the active scope first, then the global scope. Returns `null` if
 * not found in either (the writer may have deleted it manually, or the ID
 * is wrong).
 *
 * Used by `delete_memory` to locate the target file.
 */
export async function findEntryAcrossScopes(
    plugin: EventideQuillPlugin,
    id: string
): Promise<{ scopeKey: string; path: string; entry: MemoryEntry; file: MemoryFile } | null> {
    const activeKey = resolveActiveScopeKey(plugin);
    const candidates = activeKey === GLOBAL_MEMORY_SCOPE ? [GLOBAL_MEMORY_SCOPE] : [activeKey, GLOBAL_MEMORY_SCOPE];
    for (const scopeKey of candidates) {
        const result = await readMemoryFile(plugin, scopeKey);
        const entry = result.file.entries.find((e) => e.id === id);
        if (entry) {
            return { scopeKey, path: result.path, entry, file: result.file };
        }
    }
    return null;
}

/**
 * Remove a single memory entry by block ID, preserving the file's title
 * and intro. Writes the full structure back. No-op (returns false) when
 * the ID isn't found in the scope's file. The caller is responsible for
 * locating the correct scope first (typically via {@link findEntryAcrossScopes}).
 */
export async function removeMemoryEntry(
    plugin: EventideQuillPlugin,
    scopeKey: string,
    id: string
): Promise<boolean> {
    const result = await readMemoryFile(plugin, scopeKey);
    const idx = result.file.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const remaining = result.file.entries.filter((e) => e.id !== id);
    await writeMemoryFile(plugin, scopeKey, {
        title: result.file.title,
        intro: result.file.intro,
        entries: remaining
    });
    return true;
}
