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

/** Parse `aliases` frontmatter (string or string[]) into a normalized alias list. */
export function parseAliases(raw: unknown): string[] {
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

        const aliases = parseAliases(frontmatter['aliases']);

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

// ── Substring matching ──────────────────────────────────────────────────────

/** Escape regex metacharacters in a user-provided name string. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if any of the given names appear in `text` as a whole-word match
 * (case-insensitive). Multi-word names are matched as phrases.
 */
function matchNamesInText(names: string[], text: string): boolean {
    for (const name of names) {
        if (!name) continue;
        try {
            const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
            if (re.test(text)) return true;
        } catch {
            continue;
        }
    }
    return false;
}

/**
 * True if any entry's {@link LoreEntry.matchNames} contains the normalized
 * entity name as a word-level substring. Catches cases where the extractor
 * yields a single token — e.g. "Howlington" — while the entry is named
 * "Howlington Academy". The entity name must appear at a word boundary
 * within at least one of the entry's match names.
 */
function isLikelyCovered(normalizedName: string, entries: LoreEntry[]): boolean {
    if (!normalizedName) return false;
    return entries.some((e) =>
        e.matchNames.some((n) => {
            if (n === normalizedName) return true;
            const idx = n.indexOf(normalizedName);
            if (idx === -1) return false;
            const before = idx === 0 || n[idx - 1] === ' ';
            const afterEnd = idx + normalizedName.length;
            const after = afterEnd === n.length || n[afterEnd] === ' ';
            return before && after;
        })
    );
}

// ── Gap detection ───────────────────────────────────────────────────────────

/**
 * Compute coverage gaps from extracted entities. An entity is a gap when it
 * appears at least {@link LORE_COVERAGE_GAP_MIN_OCCURRENCES} times, is not
 * dismissed, and its name is not a token of any existing lore entry
 * (see {@link isLikelyCovered}).
 */
function computeGaps(entities: ExtractedEntity[], entries: LoreEntry[], dismissedIds: Set<string>): LoreCoverageGap[] {
    const gaps: LoreCoverageGap[] = [];
    for (const entity of entities) {
        if (dismissedIds.has(entity.id)) continue;
        if (entity.occurrences < LORE_COVERAGE_GAP_MIN_OCCURRENCES) continue;
        if (entity.removed) continue;
        if (isLikelyCovered(normalizeName(entity.name), entries)) continue;
        gaps.push({
            entityId: entity.id,
            entityName: entity.name,
            entityType: entityTypeToLoreType(entity.type),
            occurrences: entity.occurrences
        });
    }
    gaps.sort((a, b) => b.occurrences - a.occurrences);
    return gaps;
}

// ── Coverage computation ────────────────────────────────────────────────────

/**
 * Document-scoped coverage: tells which lore entries are referenced in the
 * active document's text and which are orphaned, using direct substring
 * matching of each entry's names.
 *
 * The active entry (the file being viewed, if it IS a lore entry) is excluded
 * from both lists — it has its own "Active entry" card in the panel.
 *
 * Gaps are not computed here (they require entity extraction); the Manuscript
 * subtab handles gaps.
 *
 * @param docText         Text content of the active document.
 * @param entries         Scanned lore entries.
 * @param activeFilePath  Path of the active file (excluded from lists), or null.
 */
export function computeDocumentCoverage(
    docText: string,
    entries: LoreEntry[],
    activeFilePath: string | null
): LoreCoverage {
    const referencedSet = new Set<string>();

    for (const entry of entries) {
        if (activeFilePath && entry.filePath === activeFilePath) continue;
        if (matchNamesInText(entry.matchNames, docText)) {
            referencedSet.add(entry.filePath);
        }
    }

    const isExcluded = (e: LoreEntry) => activeFilePath != null && e.filePath === activeFilePath;
    const referenced = entries.filter((e) => !isExcluded(e) && referencedSet.has(e.filePath));
    const orphaned = entries.filter((e) => !isExcluded(e) && !referencedSet.has(e.filePath));

    const folderCount = new Set(entries.map((e) => e.folder)).size;

    return { totalEntries: entries.length, folderCount, referenced, orphaned, gaps: [] };
}

/**
 * Manuscript-scoped coverage: substring matches entry names against the full
 * combined manuscript text for referenced/orphaned, and uses extracted entities
 * (with token-substring suppression) for gap detection.
 *
 * @param manuscriptText  Combined text of all manuscript chapters.
 * @param entries         Scanned lore entries.
 * @param entities        Entities extracted from the manuscript (from dashboard refresh).
 * @param activeFilePath  Path of the active file (excluded from lists), or null.
 * @param dismissedIds    Entity IDs the user dismissed in the Dashboard.
 */
export function computeManuscriptCoverage(
    manuscriptText: string,
    entries: LoreEntry[],
    entities: ExtractedEntity[],
    activeFilePath: string | null,
    dismissedIds: Set<string>
): LoreCoverage {
    const referencedSet = new Set<string>();

    for (const entry of entries) {
        if (activeFilePath && entry.filePath === activeFilePath) continue;
        if (matchNamesInText(entry.matchNames, manuscriptText)) {
            referencedSet.add(entry.filePath);
        }
    }

    const isExcluded = (e: LoreEntry) => activeFilePath != null && e.filePath === activeFilePath;
    const referenced = entries.filter((e) => !isExcluded(e) && referencedSet.has(e.filePath));
    const orphaned = entries.filter((e) => !isExcluded(e) && !referencedSet.has(e.filePath));

    const gaps = computeGaps(entities, entries, dismissedIds);
    const folderCount = new Set(entries.map((e) => e.folder)).size;

    return { totalEntries: entries.length, folderCount, referenced, orphaned, gaps };
}
