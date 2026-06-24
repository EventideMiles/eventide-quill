import { App, TFile, normalizePath } from 'obsidian';
import type { ExtractedEntity } from '../context-engine/types';
import {
    LoreEntry,
    LoreCoverage,
    LoreCoverageGap,
    LoreEntryType,
    LoreEntryTypeOrUntyped,
    LORE_COVERAGE_GAP_MIN_OCCURRENCES,
    LORE_ENTRY_TYPES,
    entityTypeToLoreType
} from './lorebook-types';

/**
 * Normalize a name for matching: lowercase, trim, collapse internal whitespace.
 * Used so "Sarah Connor", "sarah connor", and "Sarah  Connor" all compare equal.
 */
function normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parse the `quill-type` frontmatter value into a known lore type, or `untyped`. */
export function parseLoreType(raw: unknown): LoreEntryTypeOrUntyped {
    if (typeof raw !== 'string') return 'untyped';
    const trimmed = raw.trim().toLowerCase();
    return (LORE_ENTRY_TYPES as string[]).includes(trimmed) ? (trimmed as LoreEntryType) : 'untyped';
}

/** Parse `quill-aliases` frontmatter (string or string[]) into a normalized alias list. */
function parseAliases(raw: unknown): string[] {
    const list: string[] = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item === 'string') {
                const n = normalizeName(item);
                if (n) list.push(n);
            }
        }
    } else if (typeof raw === 'string') {
        // Allow comma- or newline-separated aliases when authored as a single string.
        for (const item of raw.split(/[,\n]/)) {
            const n = normalizeName(item);
            if (n) list.push(n);
        }
    }
    return [...new Set(list)];
}

/**
 * Whether a file lives under one of the configured lorebook folders.
 * Folder membership is the gate for lore-entry detection (frontmatter only
 * classifies). A file under multiple lore folders is reported under the first
 * match to keep the entry count honest.
 *
 * Exported so the Lorebook panel can detect when the active file is an entry
 * and offer inline editing of its type.
 */
export function findLoreFolder(filePath: string, loreFolders: string[]): string | null {
    for (const folder of loreFolders) {
        const prefix = folder.length > 0 ? `${folder}/` : '';
        if (prefix === '' || filePath.startsWith(prefix) || filePath === folder) {
            return folder;
        }
    }
    return null;
}

/**
 * Scan all configured lorebook folders and build the lore entry index.
 *
 * Synchronous — uses the Obsidian metadata cache for frontmatter (no file
 * reads). Recomputed on every dashboard refresh; persistence is deferred
 * (see PR plan) unless scan cost becomes noticeable on large vaults.
 *
 * Entry type resolution order:
 * 1. The file's `quill-type` frontmatter (always wins — per-file override).
 * 2. The folder's configured default (`folderTypes[folder]`), letting a writer
 *    mark an entire folder as one type without frontmatter on every file.
 * 3. `untyped` — surfaces in the panel but skips coverage mapping.
 *
 * @param app         The Obsidian app (for vault + metadata cache).
 * @param folders     Vault-relative lorebook folder paths.
 * @param folderTypes Optional per-folder type defaults. Absent key = mixed.
 * @returns Entries in stable order (folder, then file path).
 */
export function scanLorebook(
    app: App,
    folders: string[],
    folderTypes: Record<string, LoreEntryType> = {}
): LoreEntry[] {
    if (folders.length === 0) return [];

    const normalized = [...new Set(folders.map((f) => normalizePath(f)))];
    const markdownFiles: TFile[] = app.vault.getMarkdownFiles();

    const entries: LoreEntry[] = [];
    for (const file of markdownFiles) {
        const folder = findLoreFolder(file.path, normalized);
        if (folder === null) continue;

        const cache = app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter ?? {};

        // Per-file quill-type wins; otherwise fall back to the folder default.
        let type = parseLoreType(frontmatter['quill-type']);
        if (type === 'untyped') {
            const folderType = folderTypes[folder];
            if (folderType) type = folderType;
        }

        const aliases = parseAliases(frontmatter['quill-aliases']);

        const baseName = file.basename;
        const matchSet = new Set<string>([normalizeName(baseName), ...aliases]);
        matchSet.delete('');
        const matchNames = [...matchSet];

        entries.push({
            filePath: file.path,
            fileBasename: baseName,
            folder,
            type,
            aliases,
            matchNames
        });
    }

    entries.sort((a, b) => {
        if (a.folder !== b.folder) return a.folder.localeCompare(b.folder);
        return a.filePath.localeCompare(b.filePath);
    });
    return entries;
}

/**
 * Find the lore entry (if any) whose names include the given normalized name.
 * Case-insensitive, whitespace-collapsed (see {@link normalizeName}).
 */
function findEntry(entries: LoreEntry[], normalizedName: string): LoreEntry | undefined {
    return entries.find((e) => e.matchNames.includes(normalizedName));
}

/**
 * Compute lorebook coverage against the entities extracted from a manuscript.
 *
 * - `referenced`: entries with at least one matching manuscript entity.
 * - `orphaned`: entries with no matching entity.
 * - `gaps`: entities appearing at least {@link LORE_COVERAGE_GAP_MIN_OCCURRENCES}
 *   times in the manuscript that have no matching lore entry.
 *
 * Matching is by normalized name across the entity's name+aliases and the
 * entry's basename+aliases. Entity type is not required to match the entry
 * type — a name match counts regardless of classification, since the writer
 * may have typed the entry differently than the extractor classified it.
 *
 * @param entries       The scanned lore entries.
 * @param entities      Entities extracted from the active manuscript.
 * @param dismissedIds  Entity IDs the user dismissed in the Dashboard (false
 *                       positives). Excluded from gap detection so a one-time
 *                       dismissal in the character list also clears lorebook noise.
 */
export function computeCoverage(
    entries: LoreEntry[],
    entities: ExtractedEntity[],
    dismissedIds: Set<string> = new Set()
): LoreCoverage {
    const referencedSet = new Set<string>();
    const gaps: LoreCoverageGap[] = [];

    for (const entity of entities) {
        // Respect Dashboard dismissals — a dismissed false positive should not
        // resurface as a missing lore entry.
        if (dismissedIds.has(entity.id)) continue;

        const candidateNames = [entity.name, ...entity.aliases].map(normalizeName).filter((n) => n.length > 0);
        const matched = candidateNames.some((n) => {
            const entry = findEntry(entries, n);
            if (entry) {
                referencedSet.add(entry.filePath);
                return true;
            }
            return false;
        });

        if (!matched && entity.occurrences >= LORE_COVERAGE_GAP_MIN_OCCURRENCES && !entity.removed) {
            gaps.push({
                entityId: entity.id,
                entityName: entity.name,
                entityType: entityTypeToLoreType(entity.type),
                occurrences: entity.occurrences
            });
        }
    }

    const referenced = entries.filter((e) => referencedSet.has(e.filePath));
    const orphaned = entries.filter((e) => !referencedSet.has(e.filePath));

    gaps.sort((a, b) => b.occurrences - a.occurrences);

    const folderCount = new Set(entries.map((e) => e.folder)).size;

    return {
        totalEntries: entries.length,
        folderCount,
        referenced,
        orphaned,
        gaps
    };
}
