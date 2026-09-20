import { Component, type TFile } from 'obsidian';
import type EventideQuillPlugin from '../main';
import { LORE_TYPE_LABELS, LORE_COVERAGE_GAP_MIN_OCCURRENCES } from '../core/dashboard/lorebook-types';
import type { LoreCoverage, LoreEntry, LoreEntryType, LoreRelationships } from '../core/dashboard/lorebook-types';
import { findLoreFolder, parseLoreType } from '../core/dashboard/lorebook-scanner';
import { LORE_ENTRY_TYPES } from '../core/dashboard/lorebook-types';
import { getActiveDocument, renderDocumentHeader } from './document-header';
import type { MemoryEntry } from '../core/memories/memory-file';
import { GLOBAL_MEMORY_SCOPE } from '../core/memories/memory-scope';
import { readActiveAndGlobal } from '../core/memories/memory-store';

/** Lorebook sub-tab ids known to {@link renderLorebookTab}. */
export type LorebookSubTab = 'document' | 'manuscript' | 'relationships' | 'memories';

/**
 * Render the Lorebook tab content into `container`.
 *
 * Pattern B (free function) — mirrors `renderDashboardTab` / `renderContextTab`.
 * The container is a fresh scroll div created by `QuillSidebarView` on each
 * render; the `component` owns DOM event teardown.
 *
 * Coverage data comes from the appropriate plugin field depending on `subtab`:
 * `currentLoreDocumentCoverage` (document-scoped substring matching) or
 * `currentLoreManuscriptCoverage` (manuscript text substring + entity gaps).
 * The Relationships subtab reads `currentLoreRelationships` (symmetric edges
 * from body `[[wikilinks]]`) and branches separately — its data source and
 * empty-states differ from coverage.
 *
 * The refresh button triggers the subtab-appropriate refresh method.
 *
 * @param subtab Active Lorebook subtab — 'document', 'manuscript', or 'relationships'.
 */
export function renderLorebookTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    subtab: LorebookSubTab
): void {
    container.empty();

    // Memories sub-tab branches early — it has its own data source (memory
    // files, not lorebook coverage) and its own action bar (no "scan
    // lorebook" — memory files are read on each render).
    if (subtab === 'memories') {
        renderLorebookMemoriesTab(container, plugin, component);
        return;
    }

    const doc = getActiveDocument(plugin.app);
    renderDocumentHeader(container, doc);

    // When the active file is itself a lore entry, show an inline type editor
    // so the writer can categorize it without hand-editing frontmatter.
    if (doc && plugin.settings.lorebookFolders.length > 0) {
        renderActiveEntryEditor(container, plugin, component, doc.file);
    }
    // Only clear the pending value once the active-entry editor for that file
    // has had a chance to consume it; otherwise a render for a different file
    // would wipe a value still meant for the pending file.
    if (plugin.pendingLoreEntryType && plugin.pendingLoreEntryType.path === doc?.file.path) {
        plugin.pendingLoreEntryType = null;
    }

    // Refresh button row — dispatches to the subtab-appropriate refresh.
    const actionBar = container.createDiv({ cls: 'quill-lorebook-panel__actions' });
    const refreshBtn = actionBar.createEl('button', {
        cls: 'quill-lorebook-panel__refresh-btn',
        text: 'Scan lorebook'
    });
    component.registerDomEvent(refreshBtn, 'click', () => {
        if (subtab === 'manuscript') {
            void plugin.refreshLorebookManuscriptCoverage(true);
        } else if (subtab === 'relationships') {
            plugin.refreshLorebookRelationships();
        } else {
            void plugin.refreshLorebookDocumentCoverage();
        }
    });

    if (plugin.settings.lorebookFolders.length === 0) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty quill-lorebook-panel__empty-hint',
            text: 'No lorebook folders configured. Add one in settings under the lorebook section.'
        });
        return;
    }

    // Relationships branch — its data source and empty-states differ from
    // coverage (entry-to-entry links, not document/manuscript text).
    if (subtab === 'relationships') {
        const rel = plugin.currentLoreRelationships;
        if (!rel) {
            container.createEl('p', {
                cls: 'quill-lorebook-panel__empty',
                text: 'No relationship data yet. Click "scan lorebook" to resolve [[links]] between entries.'
            });
            return;
        }
        if (rel.totalEntries === 0) {
            const folderCount = plugin.settings.lorebookFolders.length;
            container.createEl('p', {
                cls: 'quill-lorebook-panel__empty',
                text: `No lore entries found under ${folderCount} folder${folderCount === 1 ? '' : 's'}.`
            });
            return;
        }
        renderLorebookRelationshipsTab(container, plugin, component, rel);
        return;
    }

    const coverage =
        subtab === 'manuscript' ? plugin.currentLoreManuscriptCoverage : plugin.currentLoreDocumentCoverage;

    if (!coverage) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty',
            text: 'No lorebook data yet. Click "scan lorebook" to scan configured folders.'
        });
        return;
    }

    if (coverage.totalEntries === 0) {
        const folderCount = plugin.settings.lorebookFolders.length;
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty',
            text: `No lore entries found under ${folderCount} folder${folderCount === 1 ? '' : 's'}.`
        });
        return;
    }

    if (subtab === 'manuscript') {
        renderLorebookManuscriptTab(container, plugin, component, coverage);
    } else {
        renderLorebookDocumentTab(container, plugin, component, coverage);
    }
}

/**
 * Document-scoped coverage: shows entries referenced in the active document
 * (via substring matching) and entries that don't appear. No gap section
 * — gaps require entity extraction and are handled by the Manuscript subtab.
 */
function renderLorebookDocumentTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    coverage: LoreCoverage
): void {
    // Coverage summary.
    const summary = container.createDiv({ cls: 'quill-lorebook-panel__summary' });
    summary.createSpan({ cls: 'quill-lorebook-panel__stat', text: `${coverage.totalEntries} entries` });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat',
        text: `${coverage.folderCount} folder${coverage.folderCount === 1 ? '' : 's'}`
    });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${coverage.referenced.length} referenced`
    });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--muted',
        text: `${coverage.orphaned.length} not referenced`
    });

    // Orphaned entries (defined but not found in this document).
    if (coverage.orphaned.length > 0) {
        container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Not referenced in this document'
        });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.orphaned) {
            renderLoreEntryRow(list, entry, false);
        }
    }

    // Referenced entries.
    if (coverage.referenced.length > 0) {
        container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Referenced in this document'
        });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.referenced) {
            renderLoreEntryRow(list, entry, true);
        }
    }
}

/**
 * Manuscript-scoped coverage: shows entries referenced in the full manuscript
 * text, orphaned entries, plus entity-based gaps (mentioned but undocumented).
 */
function renderLorebookManuscriptTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    coverage: LoreCoverage
): void {
    // Manuscript provenance — shows which folder this coverage was built
    // from, so the user can tell which manuscript they're looking at when
    // working across multiple projects.
    if (plugin.currentManuscriptFolder) {
        container.createDiv({
            cls: 'quill-lorebook-panel__manuscript-source',
            text: `Manuscript: ${plugin.currentManuscriptFolder}`
        });
    }

    // Coverage summary line.
    const summary = container.createDiv({ cls: 'quill-lorebook-panel__summary' });
    summary.createSpan({ cls: 'quill-lorebook-panel__stat', text: `${coverage.totalEntries} entries` });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat',
        text: `${coverage.folderCount} folder${coverage.folderCount === 1 ? '' : 's'}`
    });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${coverage.referenced.length} referenced`
    });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--muted',
        text: `${coverage.orphaned.length} orphaned`
    });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--warn',
        text: `${coverage.gaps.length} missing`
    });

    // Missing-entity gaps (highest signal — surface first).
    if (coverage.gaps.length > 0) {
        const gapsHeading = container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Mentioned but not documented'
        });
        gapsHeading.setAttribute(
            'title',
            `Entities appearing ${LORE_COVERAGE_GAP_MIN_OCCURRENCES}+ times with no lore entry`
        );

        const gapList = container.createDiv({ cls: 'quill-lorebook-panel__gaps' });
        for (const gap of coverage.gaps) {
            const row = gapList.createDiv({ cls: 'quill-lorebook-panel__gap' });
            row.createSpan({
                cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${gap.entityType}`,
                text: LORE_TYPE_LABELS[gap.entityType]
            });
            row.createSpan({ cls: 'quill-lorebook-panel__gap-name', text: gap.entityName });
            row.createSpan({ cls: 'quill-lorebook-panel__gap-count', text: `${gap.occurrences}\u00D7` });
            const dismissBtn = row.createEl('button', {
                cls: 'quill-lorebook-panel__gap-btn',
                text: 'Dismiss',
                attr: { title: 'Not a real entry — hide this from future scans.' }
            });
            component.registerDomEvent(dismissBtn, 'click', () => {
                dismissBtn.disabled = true;
                void plugin.dismissDashboardEntity(gap.entityId);
            });
        }
    }

    // Orphaned entries (defined but not referenced in this manuscript).
    if (coverage.orphaned.length > 0) {
        container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Not referenced in this manuscript'
        });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.orphaned) {
            renderLoreEntryRow(list, entry, false);
        }
    }

    // Referenced entries.
    if (coverage.referenced.length > 0) {
        container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Referenced in this manuscript'
        });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.referenced) {
            renderLoreEntryRow(list, entry, true);
        }
    }
}

/**
 * Maximum number of connected entries for which the matrix view is rendered.
 * Above this the matrix becomes unreadable in a sidebar; the list view alone
 * carries the information. Threshold tuned for sidebar width (~350px) with
 * horizontally-scrollable cells.
 */
const MATRIX_MAX_ENTRIES = 50;

/**
 * Relationships subtab: renders the symmetric adjacency view of the lorebook.
 *
 * Data source is body `[[wikilinks]]` resolved via the metadata cache (see
 * `computeRelationships`). Renders four sections under one subtab: a summary
 * line, a matrix (when the connected-entry count is small enough), a per-entry
 * connections list (always, and the large-lorebook fallback), a dangling-links
 * section (links to unwritten entries), and an unconnected section.
 *
 * Lorebook-scoped (entry-to-entry), so there is no document vs manuscript
 * split here — simpler than coverage.
 */
function renderLorebookRelationshipsTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    rel: LoreRelationships
): void {
    // filePath → entry lookup, used by the list + dangling sections to resolve
    // display names (edges carry filePaths only).
    const entryByPath = new Map<string, LoreEntry>();
    for (const e of rel.entries) entryByPath.set(e.filePath, e);

    // Symmetric adjacency: both endpoints of each edge see each other.
    const adjacency = new Map<string, Set<string>>();
    /** Record `b` as a neighbor of `a`; symmetry comes from the two calls at the loop below. */
    const addNeighbor = (a: string, b: string) => {
        let set = adjacency.get(a);
        if (!set) {
            set = new Set<string>();
            adjacency.set(a, set);
        }
        set.add(b);
    };
    for (const edge of rel.edges) {
        addNeighbor(edge.from, edge.to);
        addNeighbor(edge.to, edge.from);
    }

    // Connected entries (participate in at least one edge), alphabetical.
    const connectedEntries = rel.entries
        .filter((e) => adjacency.has(e.filePath))
        .sort((a, b) => a.fileBasename.localeCompare(b.fileBasename));

    // Summary line.
    const summary = container.createDiv({ cls: 'quill-lorebook-panel__summary' });
    summary.createSpan({ cls: 'quill-lorebook-panel__stat', text: `${rel.totalEntries} entries` });
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${rel.edges.length} link${rel.edges.length === 1 ? '' : 's'}`
    });
    if (rel.dangling.length > 0) {
        summary.createSpan({
            cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--warn',
            text: `${rel.dangling.length} dangling`
        });
    }
    summary.createSpan({
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--muted',
        text: `${rel.unconnected.length} unconnected`
    });

    // Empty state — no relationships and no dangling links to act on.
    if (rel.edges.length === 0 && rel.dangling.length === 0) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty',
            text: 'No relationships found — add [[links]] between entries to see them here.'
        });
        return;
    }

    // Matrix view — only when the connected-entry count is small enough.
    if (connectedEntries.length > 0 && connectedEntries.length <= MATRIX_MAX_ENTRIES) {
        container.createDiv({ cls: 'quill-lorebook-panel__subheading', text: 'Matrix' });
        renderRelationshipMatrix(container, connectedEntries, adjacency);
    } else if (connectedEntries.length > MATRIX_MAX_ENTRIES) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty quill-lorebook-panel__empty-hint',
            text: `Showing list view — matrix hidden for large lorebooks (${connectedEntries.length} connected entries).`
        });
    }

    // List view — per-entry connections, always shown when edges exist.
    if (rel.edges.length > 0) {
        container.createDiv({ cls: 'quill-lorebook-panel__subheading', text: 'Connections' });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__connections' });
        const byDegree = connectedEntries
            .map((entry) => {
                const neighbors = [...(adjacency.get(entry.filePath) ?? new Set<string>())]
                    .map((p) => entryByPath.get(p))
                    .filter((n): n is LoreEntry => n !== undefined);
                return { entry, neighbors };
            })
            .sort(
                (a, b) =>
                    b.neighbors.length - a.neighbors.length || a.entry.fileBasename.localeCompare(b.entry.fileBasename)
            );
        for (const { entry, neighbors } of byDegree) {
            const row = list.createDiv({ cls: 'quill-lorebook-panel__connection' });
            row.createSpan({
                cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${entry.type}`,
                text: LORE_TYPE_LABELS[entry.type]
            });
            row.createSpan({ cls: 'quill-lorebook-panel__connection-name', text: entry.fileBasename });
            const names = neighbors.map((n) => n.fileBasename).sort((a, b) => a.localeCompare(b));
            row.createSpan({
                cls: 'quill-lorebook-panel__connection-targets',
                text: `\u2192 ${names.join(', ')}`
            });
            row.createSpan({
                cls: 'quill-lorebook-panel__connection-count',
                text: `${neighbors.length}`
            });
        }
    }

    // Dangling links — unresolved [[targets]], likely unwritten entries.
    // Each row is clickable: opens the source entry and places the cursor at
    // the link, so the writer can see / fix the dangling reference in context.
    if (rel.dangling.length > 0) {
        container.createDiv({
            cls: 'quill-lorebook-panel__subheading',
            text: 'Links to unwritten entries'
        });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const d of rel.dangling) {
            const source = entryByPath.get(d.from);
            const row = list.createDiv({
                cls: 'quill-lorebook-panel__entry quill-lorebook-panel__entry--dangling quill-lorebook-panel__entry--clickable',
                attr: { tabindex: '0', role: 'button', title: `Open ${source?.fileBasename ?? d.from} at this link` }
            });
            row.createSpan({
                cls: 'quill-lorebook-panel__entry-name',
                text: source?.fileBasename ?? d.from
            });
            row.createSpan({
                cls: 'quill-lorebook-panel__connection-targets',
                text: `\u2192 ${d.target}`
            });
            component.registerDomEvent(row, 'click', () => {
                void plugin.jumpToLoreLink(d.from, d.line, d.col);
            });
            component.registerDomEvent(row, 'keydown', (evt: KeyboardEvent) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    void plugin.jumpToLoreLink(d.from, d.line, d.col);
                }
            });
        }
    }

    // Unconnected entries — zero relationships. Parallel to coverage's "Not referenced".
    if (rel.unconnected.length > 0) {
        container.createDiv({ cls: 'quill-lorebook-panel__subheading', text: 'Unconnected' });
        const list = container.createDiv({ cls: 'quill-lorebook-panel__entries' });
        for (const entry of rel.unconnected) {
            renderLoreEntryRow(list, entry, false);
        }
    }
}

/**
 * Render the entries × entries matrix as a frozen-labels + scrollable-cells
 * split. Filled cell = the two entries are related; cells carry a hover
 * tooltip naming both endpoints.
 *
 * Layout: the row-label column lives OUTSIDE the horizontal scroll container
 * (a flex sibling), so entry names stay visible across the full scroll range.
 * The earlier `position: sticky` attempt failed because a sticky grid item is
 * bounded by its grid area (column 1 only), so it detached partway across.
 * Both the labels column and the cells grid use the same fixed row height
 * (`--quill-matrix-cell`) so rows align exactly.
 */
function renderRelationshipMatrix(
    container: HTMLElement,
    entries: LoreEntry[],
    adjacency: Map<string, Set<string>>
): void {
    const outer = container.createDiv({ cls: 'quill-lorebook-panel__matrix-outer' });

    // Frozen labels column: corner + one row label per entry. Never scrolls,
    // so the writer always knows which row is which entry as they pan right.
    const labels = outer.createDiv({ cls: 'quill-lorebook-panel__matrix-labels' });
    labels.createDiv({ cls: 'quill-lorebook-panel__matrix-corner' });
    for (const rowEntry of entries) {
        labels.createDiv({
            cls: 'quill-lorebook-panel__matrix-rowhead',
            text: rowEntry.fileBasename,
            attr: { title: rowEntry.fileBasename }
        });
    }

    // Scrollable cells grid: header row + body cells, NO label column.
    const scroll = outer.createDiv({ cls: 'quill-lorebook-panel__matrix-scroll' });
    const grid = scroll.createDiv({ cls: 'quill-lorebook-panel__matrix' });
    grid.style.gridTemplateColumns = `repeat(${entries.length}, var(--quill-matrix-cell, 22px))`;

    // Header row: one abbreviated label per column entry.
    for (const col of entries) {
        grid.createDiv({
            cls: 'quill-lorebook-panel__matrix-head',
            text: abbreviateMatrixLabel(col.fileBasename),
            attr: { title: col.fileBasename }
        });
    }

    // Body rows: one cell per column entry.
    for (const rowEntry of entries) {
        const neighbors = adjacency.get(rowEntry.filePath) ?? new Set<string>();
        for (const colEntry of entries) {
            const related = neighbors.has(colEntry.filePath);
            const isDiagonal = rowEntry.filePath === colEntry.filePath;
            const cls = [
                'quill-lorebook-panel__matrix-cell',
                related ? 'quill-lorebook-panel__matrix-cell--related' : '',
                isDiagonal ? 'quill-lorebook-panel__matrix-cell--diagonal' : ''
            ]
                .filter(Boolean)
                .join(' ');
            const attr: Record<string, string> =
                related && !isDiagonal ? { title: `${rowEntry.fileBasename} \u2194 ${colEntry.fileBasename}` } : {};
            grid.createDiv({ cls, attr });
        }
    }
}

/**
 * Build a short uppercase label for a matrix column header from an entry name:
 * the first letter of the first two words, or the first two characters of a
 * single-word name. The full name travels in the `title` tooltip.
 */
function abbreviateMatrixLabel(name: string): string {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        const a = parts[0]![0] ?? '';
        const b = parts[1]![0] ?? '';
        return (a + b).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

/** Render a single lore entry row with a type badge. */
function renderLoreEntryRow(container: HTMLElement, entry: LoreEntry, referenced: boolean): void {
    const row = container.createDiv({
        cls: `quill-lorebook-panel__entry${referenced ? ' quill-lorebook-panel__entry--referenced' : ''}`
    });
    row.createSpan({
        cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${entry.type}`,
        text: LORE_TYPE_LABELS[entry.type]
    });
    row.createSpan({ cls: 'quill-lorebook-panel__entry-name', text: entry.fileBasename });
    // Image-count chip — visible only when the entry has at least one parsed
    // image. Surfaces what's available to the AI via `get_lore_image` without
    // a separate panel; the writer gets a quick visual of which entries are
    // visually populated. Missing files (badge but no TFile) still count.
    if (entry.images.length > 0) {
        row.createSpan({
            cls: 'quill-lorebook-panel__entry-images',
            text: `${entry.images.length} img${entry.images.length === 1 ? '' : 's'}`
        });
    }
}

/**
 * Render an inline editor for the active file's lore entry type.
 *
 * Shown only when the active markdown file lives under a configured lorebook
 * folder. The dropdown writes the flat `quill-type` frontmatter key via
 * `plugin.setLoreEntryType` — "Mixed" clears the per-file type so the entry
 * inherits its folder's configured default. The muted hint shows the effective
 * resolved type so the resolution chain (file → folder → untyped) is visible.
 */
function renderActiveEntryEditor(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    file: TFile
): void {
    const folder = findLoreFolder(file.path, plugin.settings.lorebookFolders);
    if (folder === null) return;

    const section = container.createDiv({ cls: 'quill-lorebook-panel__active-entry' });
    section.createDiv({ cls: 'quill-lorebook-panel__subheading', text: 'Active entry' });

    const row = section.createDiv({ cls: 'quill-lorebook-panel__active-entry-row' });
    row.createSpan({ cls: 'quill-lorebook-panel__active-entry-label', text: 'Type' });

    const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    // Prefer the pending type (just-written value) when the cache hasn't caught
    // up yet — processFrontMatter resolves before metadataCache propagates.
    const pending = plugin.pendingLoreEntryType;
    const rawType =
        pending?.path === file.path ? (pending.type ?? 'untyped') : parseLoreType(frontmatter['quill-type']);
    const folderDefault = plugin.settings.lorebookFolderTypes[folder];
    const effective = rawType !== 'untyped' ? rawType : (folderDefault ?? 'untyped');

    const select = row.createEl('select', { cls: 'quill-lorebook-panel__active-entry-select' });
    select.createEl('option', { value: '', text: 'Mixed (inherit folder)' });
    for (const t of LORE_ENTRY_TYPES) {
        select.createEl('option', { value: t, text: LORE_TYPE_LABELS[t] });
    }
    select.value = rawType !== 'untyped' ? rawType : '';

    component.registerDomEvent(select, 'change', () => {
        const v = select.value as LoreEntryType | '';
        void plugin.setLoreEntryType(file, v === '' ? null : v);
    });

    // Effective-type hint so the writer sees how a "Mixed" choice resolves.
    section.createDiv({
        cls: 'quill-lorebook-panel__active-entry-hint',
        text:
            effective === 'untyped'
                ? 'Effective: untyped (no folder default; add a quill-type or set a folder default).'
                : `Effective: ${LORE_TYPE_LABELS[effective]}.`
    });
}

/**
 * Render the Memories sub-tab. Shows memories saved by the AI (or by the
 * writer directly in the markdown) for the active scope + global pool, with
 * one card per memory section.
 *
 * The render is async-filled: a "Loading…" placeholder is replaced once the
 * memory files have been read + parsed. Memory files are small (typically
 * <5k chars even with dozens of entries), so we re-read on every render
 * rather than maintaining a separate cache.
 *
 * Writer actions:
 *   - Click a card → opens the underlying `.memories.md` file in the editor
 *     so the writer can edit / delete the section directly. (Lorebook-style
 *     sovereignty: the file is the source of truth, the UI is a view.)
 *   - "New memory" button → opens the active scope's file with a fresh
 *     `## ` heading template at the bottom; the writer types and saves.
 *   - "Refresh" button → re-reads (useful after editing the file in another
 *     tab to pull the latest into the sidebar).
 *
 * Empty states:
 *   - Memories disabled (master kill switch) → settings hint.
 *   - No active scope + no global entries → "no memories yet" with a hint
 *     that the AI saves memories as it learns about the manuscript.
 */
function renderLorebookMemoriesTab(container: HTMLElement, plugin: EventideQuillPlugin, component: Component): void {
    if (!plugin.settings.memoriesEnabled) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty quill-lorebook-panel__empty-hint',
            text: 'Memories are disabled. Enable them in settings under the memories section.'
        });
        return;
    }

    // Header — explains what the writer is looking at.
    const header = container.createDiv({ cls: 'quill-memories-panel__header' });
    header.createEl('h3', { text: 'Memories' });
    header.createEl('p', {
        cls: 'quill-memories-panel__subtitle',
        text:
            'Context the AI has learned about this manuscript and your preferences. ' +
            'Click an entry to open the underlying file and edit it directly.'
    });

    // Action bar.
    const actionBar = container.createDiv({ cls: 'quill-memories-panel__actions' });
    const newBtn = actionBar.createEl('button', {
        cls: 'quill-memories-panel__action-btn',
        text: 'New memory',
        attr: { 'aria-label': 'Open the active scope memory file with a new section template' }
    });
    const refreshBtn = actionBar.createEl('button', {
        cls: 'quill-memories-panel__action-btn quill-memories-panel__action-btn--secondary',
        text: 'Refresh',
        attr: { 'aria-label': 'Re-read memory files from the vault' }
    });

    // Loading placeholder — replaced once the async read completes.
    const loading = container.createEl('p', {
        cls: 'quill-lorebook-panel__empty',
        text: 'Loading memories…'
    });

    /** Render the cards list after the async read completes. */
    const fillCards = async (): Promise<void> => {
        const { active, global } = await readActiveAndGlobal(plugin);
        if (loading.isConnected) loading.remove();

        // Build the union (active first, then global), skipping empty pools.
        const sections: { scopeLabel: string; scopeKey: string; entries: readonly MemoryEntry[] }[] = [];
        if (active.scopeKey !== GLOBAL_MEMORY_SCOPE && active.file.entries.length > 0) {
            sections.push({
                scopeLabel: active.scopeKey,
                scopeKey: active.scopeKey,
                entries: active.file.entries
            });
        }
        if (global.file.entries.length > 0) {
            sections.push({
                scopeLabel: 'Global',
                scopeKey: GLOBAL_MEMORY_SCOPE,
                entries: global.file.entries
            });
        }

        if (sections.length === 0) {
            container.createEl('p', {
                cls: 'quill-lorebook-panel__empty quill-lorebook-panel__empty-hint',
                text:
                    'No memories yet. As the AI learns about your manuscript and preferences, ' +
                    'it will save durable context here. You can also add memories manually — click ' +
                    '"New memory" to open the file.'
            });
            return;
        }

        for (const section of sections) {
            const sectionEl = container.createDiv({ cls: 'quill-memories-panel__section' });
            sectionEl.createDiv({
                cls: 'quill-memories-panel__section-label',
                text: section.scopeKey === GLOBAL_MEMORY_SCOPE ? 'Global pool' : `Manuscript pool: ${section.scopeLabel}`
            });

            for (const entry of section.entries) {
                renderMemoryCard(sectionEl, plugin, component, entry, section.scopeKey);
            }
        }
    };

    component.registerDomEvent(newBtn, 'click', () => {
        void openMemoryFileForNewEntry(plugin);
    });
    component.registerDomEvent(refreshBtn, 'click', () => {
        // Re-render by clearing and re-filling. The component owns listener
        // cleanup, so detaching children doesn't leak handlers.
        const existing = container.querySelectorAll('.quill-memories-panel__section, .quill-lorebook-panel__empty');
        Array.from(existing).forEach((el) => el.remove());
        void fillCards();
    });

    void fillCards();
}

/** Render a single memory card with click-to-open affordance. */
function renderMemoryCard(
    parent: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    entry: MemoryEntry,
    scopeKey: string
): void {
    const card = parent.createDiv({ cls: 'quill-memories-panel__card', attr: { tabindex: '0' } });

    const heading = card.createDiv({ cls: 'quill-memories-panel__card-heading' });
    heading.createSpan({ cls: 'quill-memories-panel__card-title', text: entry.heading || '(untitled memory)' });
    if (entry.id) {
        heading.createEl('code', {
            cls: 'quill-memories-panel__card-id',
            text: `^${entry.id}`,
            attr: { 'aria-label': `Block ID: ${entry.id}` }
        });
    }

    if (entry.body) {
        const body = card.createDiv({ cls: 'quill-memories-panel__card-body' });
        // Render the first ~3 lines of the body so the writer gets enough
        // context to recognize the memory without opening the file. The full
        // body is in the markdown file on click.
        const preview = entry.body.split('\n').slice(0, 3).join('\n').trim();
        body.textContent = preview;
    }

    if (entry.tags.length > 0) {
        const tagsEl = card.createDiv({ cls: 'quill-memories-panel__card-tags' });
        for (const tag of entry.tags) {
            tagsEl.createSpan({ cls: 'quill-memories-panel__card-tag', text: `#${tag}` });
        }
    }

    /** Open the memory file scrolled to this entry's block ID. */
    const openFile = (): void => {
        void openMemoryFileAtEntry(plugin, scopeKey, entry.id);
    };
    component.registerDomEvent(card, 'click', openFile);
    component.registerDomEvent(card, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFile();
        }
    });
}

/** Open the active scope's memory file in the editor with a new section template. */
async function openMemoryFileForNewEntry(plugin: EventideQuillPlugin): Promise<void> {
    const { resolveActiveScopeKey, memoryFilePath } = await import('../core/memories/memory-scope');
    const scopeKey = resolveActiveScopeKey(plugin);
    const path = memoryFilePath(scopeKey, plugin.settings.memoriesFolder);
    await ensureMemoryFileExists(plugin, scopeKey, path);
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!file) {
        // File creation failed silently in ensureMemoryFileExists; nothing more to do.
        return;
    }
    await plugin.app.workspace.openLinkText(file.path, '', false);
}

/**
 * Open a memory file at a specific block ID (Obsidian's `path#^id` syntax
 * scrolls the editor to the section).
 */
async function openMemoryFileAtEntry(plugin: EventideQuillPlugin, scopeKey: string, entryId: string): Promise<void> {
    const { memoryFilePath } = await import('../core/memories/memory-scope');
    const path = memoryFilePath(scopeKey, plugin.settings.memoriesFolder);
    await ensureMemoryFileExists(plugin, scopeKey, path);
    // Obsidian's link syntax: `path/to/file.md#^block-id` opens the file
    // scrolled to that block.
    const link = entryId ? `${path}#^${entryId}` : path;
    await plugin.app.workspace.openLinkText(link, '', false);
}

/**
 * Ensure the memory file exists before opening it. Creates it with a
 * canonical empty template if missing so the writer has something to edit
 * rather than a blank page. Best-effort: silent fail (the vault.openLinkText
 * call will surface its own error if the path is bad).
 */
async function ensureMemoryFileExists(plugin: EventideQuillPlugin, scopeKey: string, path: string): Promise<void> {
    const existing = plugin.app.vault.getAbstractFileByPath(path);
    if (existing) return;

    // Import lazily to avoid pulling the whole memory-store graph into the
    // lorebook-panel bundle on every render.
    const { writeMemoryFile } = await import('../core/memories/memory-store');
    try {
        await writeMemoryFile(plugin, scopeKey, { title: '', intro: '', entries: [] });
    } catch (err) {
        console.warn(`Quill: could not create memory file "${path}"`, err);
    }
}
