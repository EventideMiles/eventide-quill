import type { TFile } from 'obsidian';
import type { EntityType } from '../context-engine/types';

/**
 * Lore entry classification vocabulary. Aligns 1:1 with {@link EntityType}
 * (`character | location | plot-thread | theme | item`) plus two lore-only
 * types (`event`, `faction`) so every extracted entity type can be matched
 * against a lore entry of the same type for coverage analysis.
 *
 * Set on a note via the flat `quill-type` frontmatter key. Entries without
 * `quill-type` are treated as `untyped` — they surface in the Dashboard but
 * do not participate in coverage mapping.
 */
export type LoreEntryType = 'character' | 'location' | 'event' | 'item' | 'faction' | 'plot-thread' | 'theme';

/** All valid lore entry types, in display order. */
export const LORE_ENTRY_TYPES: LoreEntryType[] = [
    'character',
    'location',
    'event',
    'item',
    'faction',
    'plot-thread',
    'theme'
];

/** A lore entry type or `untyped` for entries with no `quill-type` frontmatter. */
export type LoreEntryTypeOrUntyped = LoreEntryType | 'untyped';

/** Display labels for each lore entry type. */
export const LORE_TYPE_LABELS: Record<LoreEntryTypeOrUntyped, string> = {
    character: 'Character',
    location: 'Location',
    event: 'Event',
    item: 'Item',
    faction: 'Faction',
    'plot-thread': 'Plot thread',
    theme: 'Theme',
    untyped: 'Untyped'
};

/**
 * Map an entity extractor type onto a lore entry type. The extractor's
 * vocabulary is a subset of the lore vocabulary, so the mapping is identity
 * for the five shared types. This exists to keep the comparison explicit.
 */
export function entityTypeToLoreType(type: EntityType): LoreEntryType {
    return type;
}

/**
 * An image embedded in a lore entry's gallery section. Extracted by the
 * scanner from the note body (not frontmatter) so Obsidian's rename/move
 * tracking keeps the embed valid automatically — frontmatter YAML paths
 * would break silently on rename.
 *
 * `label` is the nearest subheading text within the gallery section (e.g.,
 * "Human form", "Wolfed state"), giving multi-form characters a free
 * per-image label without a frontmatter grammar. Empty when the image sits
 * directly under the gallery header with no subheading.
 *
 * `caption` comes from the Obsidian embed's caption slot (`![[file|caption]]`).
 *
 * `file` is the resolved attachment `TFile`, or `undefined` if the embed
 * points at a missing file (writer sees a "missing" badge; context
 * attachment silently skips).
 */
export interface LoreEntryImage {
    /** Vault attachment filename as written in the embed, e.g., "freddy-wolfed.png". */
    filename: string;
    /** Nearest subheading text in the gallery section, trimmed. Empty if unsectioned. */
    label: string;
    /** Caption from `![[file|caption]]` syntax, if present. */
    caption?: string;
    /** Resolved attachment TFile, or undefined when the file is missing. */
    file?: TFile;
}

/** A single lore entry discovered in a configured lorebook folder. */
export interface LoreEntry {
    /** Source file path in the vault. */
    filePath: string;
    /** Source file basename (without extension). Used as the entry name. */
    fileBasename: string;
    /** The lorebook folder this entry was discovered under. */
    folder: string;
    /** Entry type from `quill-type` frontmatter, or `untyped`. */
    type: LoreEntryTypeOrUntyped;
    /** Aliases from Obsidian's `aliases` frontmatter (normalized for matching). */
    aliases: string[];
    /**
     * All names that should match this entry during coverage analysis:
     * the file basename plus aliases, lowercased and trimmed, de-duplicated.
     */
    matchNames: string[];
    /**
     * Images parsed from the entry's gallery section (any heading whose text
     * matches a configured `loreEntryImageSectionHeaders` value). Empty when
     * the entry has no recognized gallery section, no image embeds, or the
     * scanner was run with an empty section-header list. Beyond
     * `loreEntryImageMaxPerEntry` the overflow is silently dropped (the
     * cap is a budget tool, not a content rule).
     */
    images: LoreEntryImage[];
}

/** A manuscript entity with no corresponding lore entry (coverage gap). */
export interface LoreCoverageGap {
    /** Entity ID (`type:normalized-name`) — used for dismiss/restore actions. */
    entityId: string;
    /** Display name of the unmatched entity. */
    entityName: string;
    /** The entity's type, rendered via {@link LORE_TYPE_LABELS}. */
    entityType: LoreEntryTypeOrUntyped;
    /** How many times the entity appears in the manuscript. */
    occurrences: number;
}

/** Coverage analysis result for the lorebook against a manuscript. */
export interface LoreCoverage {
    /** Total entries across all configured folders. */
    totalEntries: number;
    /** Number of distinct configured folders that yielded entries. */
    folderCount: number;
    /** Entries referenced by at least one matching manuscript entity. */
    referenced: LoreEntry[];
    /** Entries with no matching manuscript entity. */
    orphaned: LoreEntry[];
    /** Manuscript entities (above the occurrence threshold) with no lore entry. */
    gaps: LoreCoverageGap[];
}

/**
 * Minimum entity occurrence count to be considered a coverage gap. Below this,
 * a mention is treated as incidental noise rather than a missing entry.
 */
export const LORE_COVERAGE_GAP_MIN_OCCURRENCES = 3;

/**
 * A proposed lore entry draft produced by the Lorebook Coach (or, in future
 * PRs, by the sweep action) and awaiting the writer's review before being
 * saved as a {@link LoreEntry} on disk. Lives here (alongside `LoreEntry`)
 * rather than on the co-writer session so that coach, panel, review UI, and
 * the eventual sweep can all reference it without crossing module boundaries.
 */
export interface LoreDraftEntry {
    /** Display name (also used as the proposed filename, sanitized on save). */
    name: string;
    /** Entry type from the draft's `entry_type` argument, if any. */
    entryType: LoreEntryType | null;
    /** Full markdown body (frontmatter is reconstructed at save time). */
    content: string;
}
