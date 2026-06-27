import { Component, type TFile } from 'obsidian';
import type EventideQuillPlugin from '../main';
import { LORE_TYPE_LABELS, LORE_COVERAGE_GAP_MIN_OCCURRENCES } from '../core/dashboard/lorebook-types';
import type { LoreCoverage, LoreEntry, LoreEntryType } from '../core/dashboard/lorebook-types';
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
 * The refresh button triggers the subtab-appropriate refresh method.
 *
 * @param subtab Active Lorebook subtab — 'document' or 'manuscript'.
 */
export function renderLorebookTab(
    container: HTMLElement,
    plugin: EventideQuillPlugin,
    component: Component,
    subtab: 'document' | 'manuscript'
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
