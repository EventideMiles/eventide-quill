import { App, TFile, normalizePath } from 'obsidian';
import type { ExtractedEntity } from '../context-engine/types';
import {
    LoreEntry,
    LoreEntryImage,
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
 * classifies). A file under multiple lore folders is reported under the
 * deepest (most specific) match so folder typing does not depend on the order
 * of `loreFolders` — e.g. "Lore/Characters" wins over "Lore".
 *
 * Exported so the Lorebook panel can detect when the active file is an entry
 * and offer inline editing of its type.
 */
export function findLoreFolder(filePath: string, loreFolders: string[]): string | null {
    let best: string | null = null;
    for (const folder of loreFolders) {
        const prefix = folder.length > 0 ? `${folder}/` : '';
        if (!(prefix === '' || filePath.startsWith(prefix) || filePath === folder)) continue;
        if (best === null || folder.length > best.length) {
            best = folder;
        }
    }
    return best;
}

/**
 * Scan all configured lorebook folders and build the lore entry index.
 *
 * Synchronous — uses the Obsidian metadata cache for frontmatter AND for the
 * gallery-section image parser (`fileCache.headings` + `fileCache.embeds`),
 * so adding image extraction does not introduce file reads. Recomputed on
 * every dashboard refresh; persistence is deferred unless scan cost becomes
 * noticeable on large vaults.
 *
 * Entry type resolution order:
 * 1. The file's `quill-type` frontmatter (always wins — per-file override).
 * 2. The folder's configured default (`folderTypes[folder]`), letting a writer
 *    mark an entire folder as one type without frontmatter on every file.
 * 3. `untyped` — surfaces in the panel but skips coverage mapping.
 *
 * Image extraction is gated by `imageSectionHeaders` — when the array is
 * empty, the per-file gallery scan is skipped entirely (zero cost, no
 * `images` field populated). Pass the writer's configured
 * `loreEntryImageSectionHeaders` to enable it.
 *
 * @param app                The Obsidian app (for vault + metadata cache).
 * @param folders            Vault-relative lorebook folder paths.
 * @param folderTypes        Optional per-folder type defaults. Absent key = mixed.
 * @param imageSectionHeaders Lowercased, trimmed heading texts that mark a
 *                           gallery section (e.g., `['reference', 'gallery']`).
 *                           Empty disables image extraction.
 * @param imageMaxPerEntry   Soft cap on images kept per entry. Overflow is
 *                           silently dropped; the cap is a budget tool, not a
 *                           content rule.
 * @returns Entries in stable order (folder, then file path).
 */
export function scanLorebook(
    app: App,
    folders: string[],
    folderTypes: Record<string, LoreEntryType> = {},
    imageSectionHeaders: string[] = [],
    imageMaxPerEntry = 4
): LoreEntry[] {
    if (folders.length === 0) return [];

    const normalized = [...new Set(folders.map((f) => normalizePath(f)))];
    const markdownFiles: TFile[] = app.vault.getMarkdownFiles();
    const headerSet = new Set(imageSectionHeaders.map((h) => normalizeHeaderValue(h)));

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

        const images = headerSet.size > 0 ? extractEntryImages(app, file, cache, headerSet, imageMaxPerEntry) : [];

        entries.push({
            filePath: file.path,
            fileBasename: baseName,
            folder,
            type,
            aliases,
            matchNames,
            images
        });
    }

    entries.sort((a, b) => {
        if (a.folder !== b.folder) return a.folder.localeCompare(b.folder);
        return a.filePath.localeCompare(b.filePath);
    });
    return entries;
}

// ── Gallery-section image extraction ────────────────────────────────────────

/** Image file extensions the scanner recognizes in `![[...]]` embeds. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/**
 * Strip image-gallery sections from a lore entry body, replacing each with
 * a one-line marker that preserves the gallery heading AND the per-label
 * image counts. Used by the embedding pipeline (`warmEmbeddingsForFolder`)
 * at chunk time and by both `resolveEmbedPathsToMessages` paths at top-K
 * injection time, so chunks containing `![[file.png]]` embed syntax don't
 * leak into the model's auto-injected context. The text form is useless to
 * the model (it can't see images through text) and the filenames can prime
 * hallucination; stripping nudges the model toward `get_lore_image` instead.
 *
 * Gallery sections are recognized by heading (case-insensitive, trimmed)
 * matching one of `sectionHeaders`. **Multiple** sections in one note are
 * all stripped — they all match the same convention. Each becomes a
 * marker like:
 *
 *   `[Gallery section "Gallery": 3 images available — use get_lore_image with entry + label to view. Labels: Default form, Alternate form, Third form.]`
 *
 * The label list preserves the subheading names so the model knows which
 * labels it can pass to `get_lore_image`'s `label` parameter without
 * needing a separate `lore_siblings` or `vault_lookup` call. Embeds with
 * no preceding subheading are counted under `(unlabeled)`. Returns the
 * stripped body and the total image-embed count across all stripped
 * sections.
 */
export function stripGallerySections(body: string, sectionHeaders: string[]): { stripped: string; imageCount: number } {
    if (sectionHeaders.length === 0) return { stripped: body, imageCount: 0 };

    const headerSet = new Set(sectionHeaders.map((h) => h.trim().toLowerCase()));
    const lines = body.split('\n');
    const out: string[] = [];
    let totalImageCount = 0;

    // Per-section state. Reset by emitMarker() between sections.
    let inGallery = false;
    let galleryLevel = 0;
    let galleryHeading = '';
    let currentLabel = '';
    let sectionImageCount = 0;
    const labelCounts = new Map<string, number>();

    const emitMarker = () => {
        if (sectionImageCount > 0) {
            // Preserve label names so the model can target a specific image
            // via get_lore_image's `label` parameter without an extra call.
            // Build "Name" or "Name (N)" depending on per-label count.
            const labelParts = [...labelCounts.entries()].map(([name, count]) =>
                count === 1 ? name : `${name} (${count})`
            );
            const hasLabels = labelParts.length > 0;
            const labelClause = hasLabels ? ` Labels: ${labelParts.join(', ')}.` : '';
            const useClause = hasLabels ? ' with entry + label' : ' with the entry name';
            out.push(
                `[Gallery section "${galleryHeading}": ${sectionImageCount} image${sectionImageCount === 1 ? '' : 's'} available — use get_lore_image${useClause} to view.${labelClause}]`
            );
            out.push('');
        }
        inGallery = false;
        sectionImageCount = 0;
        labelCounts.clear();
        currentLabel = '';
    };

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (headingMatch && headingMatch[1] && headingMatch[2]) {
            const level = headingMatch[1].length;
            const heading = headingMatch[2].trim().toLowerCase();

            if (inGallery && level <= galleryLevel) {
                // Section ends at a same-or-shallower heading.
                emitMarker();
                out.push(line);
            } else if (!inGallery && headerSet.has(heading)) {
                // Section starts.
                inGallery = true;
                galleryLevel = level;
                galleryHeading = headingMatch[2].trim();
                currentLabel = '';
                // Skip the heading line itself — the marker replaces it.
            } else if (inGallery && level > galleryLevel) {
                // Subheading inside the gallery section becomes the current
                // label for any embeds that follow. Heading line dropped.
                currentLabel = headingMatch[2].trim();
            }
            // Headings outside a gallery section pass through unchanged.
        } else if (!inGallery) {
            out.push(line);
        } else {
            // Inside a gallery section: count image embeds by current label.
            const embed = line.match(/!\[\[([^\]]+)\]\]/);
            if (embed && embed[1]) {
                const filename = embed[1].split('|')[0]!.toLowerCase().trim();
                if (IMAGE_EXTENSIONS.some((ext) => filename.endsWith('.' + ext))) {
                    sectionImageCount++;
                    totalImageCount++;
                    const key = currentLabel || '(unlabeled)';
                    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
                }
            }
        }
    }

    if (inGallery) emitMarker();

    return {
        stripped: out
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim(),
        imageCount: totalImageCount
    };
}

/** Lowercase + trim a heading for case-insensitive matching against the configured set. */
function normalizeHeaderValue(h: string): string {
    return h.trim().toLowerCase();
}

/** True if `filename` ends in one of the recognized image extensions. */
function isImageFile(filename: string): boolean {
    const lower = filename.toLowerCase();
    return IMAGE_EXTENSIONS.some((ext) => lower.endsWith('.' + ext));
}

/**
 * Parse the caption out of an embed's original text. Obsidian's
 * `![[file|caption]]` syntax puts the caption after the pipe; the cache's
 * `link` field strips it, but `original` keeps the whole token. Returns
 * undefined when no caption is present.
 */
function parseEmbedCaption(original: string): string | undefined {
    // Match `![[anything|caption]]` capturing the caption. Greedy on the
    // filename side so captions containing `|` (rare) split at the LAST pipe.
    const match = original.match(/^\s*!\[\[[^\]]*\|([^\]]+)\]\]\s*$/);
    const caption = match?.[1]?.trim();
    return caption && caption.length > 0 ? caption : undefined;
}

/**
 * Extract labeled images from a lore note's gallery section using only the
 * metadata cache — no file reads, fully synchronous.
 *
 * The gallery section is the first heading whose text (normalized) appears
 * in `headerSet`. Within that section (until the next heading of the same
 * or higher level), every image embed is recorded. The implicit label is
 * the nearest preceding subheading (any heading with level strictly greater
 * than the gallery section's level). Missing files are kept with
 * `file: undefined` so the writer can see what's expected but not present.
 */
function extractEntryImages(
    app: App,
    file: TFile,
    cache: ReturnType<App['metadataCache']['getFileCache']>,
    headerSet: Set<string>,
    maxPerEntry: number
): LoreEntryImage[] {
    if (!cache?.headings || cache.headings.length === 0 || !cache.embeds || cache.embeds.length === 0) {
        return [];
    }

    // Sort headings by line so we can scan top-down.
    const headings = [...cache.headings].sort((a, b) => a.position.start.line - b.position.start.line);

    // Find the gallery-section heading: first match in document order.
    let galleryIdx = -1;
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        if (h && headerSet.has(normalizeHeaderValue(h.heading))) {
            galleryIdx = i;
            break;
        }
    }
    if (galleryIdx === -1) return [];

    const galleryHeading = headings[galleryIdx];
    // Defensive — galleryIdx is guaranteed in range, but noUncheckedIndexedAccess
    // can't prove that statically.
    if (!galleryHeading) return [];
    const galleryLevel = galleryHeading.level;
    const galleryStart = galleryHeading.position.start.line;

    // The section ends at the next heading of the same or higher level
    // (shallower), or EOF. Subheadings (deeper) are part of the section.
    let galleryEnd = Infinity;
    for (let i = galleryIdx + 1; i < headings.length; i++) {
        const h = headings[i];
        if (h && h.level <= galleryLevel) {
            galleryEnd = h.position.start.line;
            break;
        }
    }

    // For each embed in the gallery section, find its nearest preceding
    // subheading (level > galleryLevel, line < embed line, max line).
    const images: LoreEntryImage[] = [];
    for (const embed of cache.embeds) {
        const line = embed.position.start.line;
        if (line <= galleryStart || line >= galleryEnd) continue;

        // `link` is the embed target; `original` keeps the ![[...]] token
        // (used to recover the caption).
        const filename = embed.link.split('|')[0]?.trim() ?? embed.link;
        if (!filename || !isImageFile(filename)) continue;

        let label = '';
        for (let i = headings.length - 1; i >= 0; i--) {
            const h = headings[i];
            if (h && h.position.start.line < line && h.level > galleryLevel) {
                label = h.heading.trim();
                break;
            }
        }

        // Resolve the embed target to a TFile. `getFirstLinkpathDest` honors
        // the entry's folder + Obsidian's link resolution (relative paths,
        // shortest-path heuristics).
        const resolved = app.metadataCache.getFirstLinkpathDest(embed.link, file.path);

        images.push({
            filename,
            label,
            caption: parseEmbedCaption(embed.original),
            file: resolved instanceof TFile ? resolved : undefined
        });

        if (images.length >= maxPerEntry) break;
    }

    return images;
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
 * yields a single token — e.g. "Westbrook" — while the entry is named
 * "Westbrook Academy". The entity name must appear at a word boundary
 * within at least one of the entry's match names.
 */
function isLikelyCovered(normalizedName: string, entries: LoreEntry[], type?: LoreEntryType): boolean {
    if (!normalizedName) return false;
    return entries.some(
        (e) =>
            (type === undefined || e.type === type) &&
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
        // Only an entry of the same lore type can cover an entity — a location
        // note must not suppress a character gap (and an untyped note never can).
        const loreType = entityTypeToLoreType(entity.type);
        if (isLikelyCovered(normalizeName(entity.name), entries, loreType)) continue;
        gaps.push({
            entityId: entity.id,
            entityName: entity.name,
            entityType: loreType,
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
    // Only typed entries participate in coverage mapping — untyped entries
    // still count toward totals (and surface in the panel) but cannot be
    // referenced/orphaned and cannot suppress manuscript gaps.
    const mappedEntries = entries.filter((e) => e.type !== 'untyped');

    const referencedSet = new Set<string>();

    for (const entry of mappedEntries) {
        if (activeFilePath && entry.filePath === activeFilePath) continue;
        if (matchNamesInText(entry.matchNames, manuscriptText)) {
            referencedSet.add(entry.filePath);
        }
    }

    const isExcluded = (e: LoreEntry) => activeFilePath != null && e.filePath === activeFilePath;
    const referenced = mappedEntries.filter((e) => !isExcluded(e) && referencedSet.has(e.filePath));
    const orphaned = mappedEntries.filter((e) => !isExcluded(e) && !referencedSet.has(e.filePath));

    const gaps = computeGaps(entities, mappedEntries, dismissedIds);
    const folderCount = new Set(entries.map((e) => e.folder)).size;

    return { totalEntries: entries.length, folderCount, referenced, orphaned, gaps };
}
