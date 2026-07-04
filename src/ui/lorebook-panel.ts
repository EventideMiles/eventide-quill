import { Component, type TFile } from 'obsidian';
import type EventideQuillPlugin from '../main';
import { LORE_TYPE_LABELS, LORE_COVERAGE_GAP_MIN_OCCURRENCES } from '../core/dashboard/lorebook-types';
import type { LoreCoverage, LoreEntry, LoreEntryType, LoreRelationships } from '../core/dashboard/lorebook-types';
import { findLoreFolder, parseLoreType } from '../core/dashboard/lorebook-scanner';
import { LORE_ENTRY_TYPES } from '../core/dashboard/lorebook-types';
import { getActiveDocument, renderDocumentHeader } from './document-header';

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
    subtab: 'document' | 'manuscript' | 'relationships'
): void {
    container.empty();

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
    const actionBar = container.createEl('div', { cls: 'quill-lorebook-panel__actions' });
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
    const summary = container.createEl('div', { cls: 'quill-lorebook-panel__summary' });
    summary.createEl('span', { cls: 'quill-lorebook-panel__stat', text: `${coverage.totalEntries} entries` });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat',
        text: `${coverage.folderCount} folder${coverage.folderCount === 1 ? '' : 's'}`
    });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${coverage.referenced.length} referenced`
    });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--muted',
        text: `${coverage.orphaned.length} not referenced`
    });

    // Orphaned entries (defined but not found in this document).
    if (coverage.orphaned.length > 0) {
        container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Not referenced in this document'
        });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.orphaned) {
            renderLoreEntryRow(list, entry, false);
        }
    }

    // Referenced entries.
    if (coverage.referenced.length > 0) {
        container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Referenced in this document'
        });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
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
        container.createEl('div', {
            cls: 'quill-lorebook-panel__manuscript-source',
            text: `Manuscript: ${plugin.currentManuscriptFolder}`
        });
    }

    // Coverage summary line.
    const summary = container.createEl('div', { cls: 'quill-lorebook-panel__summary' });
    summary.createEl('span', { cls: 'quill-lorebook-panel__stat', text: `${coverage.totalEntries} entries` });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat',
        text: `${coverage.folderCount} folder${coverage.folderCount === 1 ? '' : 's'}`
    });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${coverage.referenced.length} referenced`
    });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--muted',
        text: `${coverage.orphaned.length} orphaned`
    });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--warn',
        text: `${coverage.gaps.length} missing`
    });

    // Missing-entity gaps (highest signal — surface first).
    if (coverage.gaps.length > 0) {
        const gapsHeading = container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Mentioned but not documented'
        });
        gapsHeading.setAttribute(
            'title',
            `Entities appearing ${LORE_COVERAGE_GAP_MIN_OCCURRENCES}+ times with no lore entry`
        );

        const gapList = container.createEl('div', { cls: 'quill-lorebook-panel__gaps' });
        for (const gap of coverage.gaps) {
            const row = gapList.createEl('div', { cls: 'quill-lorebook-panel__gap' });
            row.createEl('span', {
                cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${gap.entityType}`,
                text: LORE_TYPE_LABELS[gap.entityType]
            });
            row.createEl('span', { cls: 'quill-lorebook-panel__gap-name', text: gap.entityName });
            row.createEl('span', { cls: 'quill-lorebook-panel__gap-count', text: `${gap.occurrences}\u00D7` });
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
        container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Not referenced in this manuscript'
        });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
        for (const entry of coverage.orphaned) {
            renderLoreEntryRow(list, entry, false);
        }
    }

    // Referenced entries.
    if (coverage.referenced.length > 0) {
        container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Referenced in this manuscript'
        });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
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
    const summary = container.createEl('div', { cls: 'quill-lorebook-panel__summary' });
    summary.createEl('span', { cls: 'quill-lorebook-panel__stat', text: `${rel.totalEntries} entries` });
    summary.createEl('span', {
        cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--good',
        text: `${rel.edges.length} link${rel.edges.length === 1 ? '' : 's'}`
    });
    if (rel.dangling.length > 0) {
        summary.createEl('span', {
            cls: 'quill-lorebook-panel__stat quill-lorebook-panel__stat--warn',
            text: `${rel.dangling.length} dangling`
        });
    }
    summary.createEl('span', {
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
        container.createEl('div', { cls: 'quill-lorebook-panel__subheading', text: 'Matrix' });
        renderRelationshipMatrix(container, connectedEntries, adjacency);
    } else if (connectedEntries.length > MATRIX_MAX_ENTRIES) {
        container.createEl('p', {
            cls: 'quill-lorebook-panel__empty quill-lorebook-panel__empty-hint',
            text: `Showing list view — matrix hidden for large lorebooks (${connectedEntries.length} connected entries).`
        });
    }

    // List view — per-entry connections, always shown when edges exist.
    if (rel.edges.length > 0) {
        container.createEl('div', { cls: 'quill-lorebook-panel__subheading', text: 'Connections' });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__connections' });
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
            const row = list.createEl('div', { cls: 'quill-lorebook-panel__connection' });
            row.createEl('span', {
                cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${entry.type}`,
                text: LORE_TYPE_LABELS[entry.type]
            });
            row.createEl('span', { cls: 'quill-lorebook-panel__connection-name', text: entry.fileBasename });
            const names = neighbors.map((n) => n.fileBasename).sort((a, b) => a.localeCompare(b));
            row.createEl('span', {
                cls: 'quill-lorebook-panel__connection-targets',
                text: `\u2192 ${names.join(', ')}`
            });
            row.createEl('span', {
                cls: 'quill-lorebook-panel__connection-count',
                text: `${neighbors.length}`
            });
        }
    }

    // Dangling links — unresolved [[targets]], likely unwritten entries.
    // Each row is clickable: opens the source entry and places the cursor at
    // the link, so the writer can see / fix the dangling reference in context.
    if (rel.dangling.length > 0) {
        container.createEl('div', {
            cls: 'quill-lorebook-panel__subheading',
            text: 'Links to unwritten entries'
        });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
        for (const d of rel.dangling) {
            const source = entryByPath.get(d.from);
            const row = list.createEl('div', {
                cls: 'quill-lorebook-panel__entry quill-lorebook-panel__entry--dangling quill-lorebook-panel__entry--clickable',
                attr: { tabindex: '0', role: 'button', title: `Open ${source?.fileBasename ?? d.from} at this link` }
            });
            row.createEl('span', {
                cls: 'quill-lorebook-panel__entry-name',
                text: source?.fileBasename ?? d.from
            });
            row.createEl('span', {
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
        container.createEl('div', { cls: 'quill-lorebook-panel__subheading', text: 'Unconnected' });
        const list = container.createEl('div', { cls: 'quill-lorebook-panel__entries' });
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
    const outer = container.createEl('div', { cls: 'quill-lorebook-panel__matrix-outer' });

    // Frozen labels column: corner + one row label per entry. Never scrolls,
    // so the writer always knows which row is which entry as they pan right.
    const labels = outer.createEl('div', { cls: 'quill-lorebook-panel__matrix-labels' });
    labels.createEl('div', { cls: 'quill-lorebook-panel__matrix-corner' });
    for (const rowEntry of entries) {
        labels.createEl('div', {
            cls: 'quill-lorebook-panel__matrix-rowhead',
            text: rowEntry.fileBasename,
            attr: { title: rowEntry.fileBasename }
        });
    }

    // Scrollable cells grid: header row + body cells, NO label column.
    const scroll = outer.createEl('div', { cls: 'quill-lorebook-panel__matrix-scroll' });
    const grid = scroll.createEl('div', { cls: 'quill-lorebook-panel__matrix' });
    grid.style.gridTemplateColumns = `repeat(${entries.length}, var(--quill-matrix-cell, 22px))`;

    // Header row: one abbreviated label per column entry.
    for (const col of entries) {
        grid.createEl('div', {
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
            grid.createEl('div', { cls, attr });
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
    const row = container.createEl('div', {
        cls: `quill-lorebook-panel__entry${referenced ? ' quill-lorebook-panel__entry--referenced' : ''}`
    });
    row.createEl('span', {
        cls: `quill-lorebook-panel__badge quill-lorebook-panel__badge--${entry.type}`,
        text: LORE_TYPE_LABELS[entry.type]
    });
    row.createEl('span', { cls: 'quill-lorebook-panel__entry-name', text: entry.fileBasename });
    // Image-count chip — visible only when the entry has at least one parsed
    // image. Surfaces what's available to the AI via `get_lore_image` without
    // a separate panel; the writer gets a quick visual of which entries are
    // visually populated. Missing files (badge but no TFile) still count.
    if (entry.images.length > 0) {
        row.createEl('span', {
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

    const section = container.createEl('div', { cls: 'quill-lorebook-panel__active-entry' });
    section.createEl('div', { cls: 'quill-lorebook-panel__subheading', text: 'Active entry' });

    const row = section.createEl('div', { cls: 'quill-lorebook-panel__active-entry-row' });
    row.createEl('span', { cls: 'quill-lorebook-panel__active-entry-label', text: 'Type' });

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
    section.createEl('div', {
        cls: 'quill-lorebook-panel__active-entry-hint',
        text:
            effective === 'untyped'
                ? 'Effective: untyped (no folder default; add a quill-type or set a folder default).'
                : `Effective: ${LORE_TYPE_LABELS[effective]}.`
    });
}
