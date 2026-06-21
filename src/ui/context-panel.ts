import { App, Component, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import type { ContextAssembly, ContextItem, ExtractedEntity } from '../core/context-engine/types';
import type EventideQuillPlugin from '../main';
import type { VaultSuggestionItem } from './vault-file-suggest-modal';
import { embedFolderLabel, findEmbeddedFolders } from '../utils/vault-files';
import { findEditorView } from '../utils/find-editor';
import { getBudgetColor } from './token-indicator';

/** Search modal for finding a vault file or embedded folder to add as a context item. */
class AddFileModal extends FuzzySuggestModal<VaultSuggestionItem> {
    private plugin: EventideQuillPlugin;
    private embeddedFolders: Array<{ path: string; name: string }>;

    constructor(app: App, plugin: EventideQuillPlugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder('Search vault files to add to context...');
        this.embeddedFolders = this.discoverEmbeddedFolders();
    }

    private discoverEmbeddedFolders(): Array<{ path: string; name: string }> {
        const cacheFolders = findEmbeddedFolders(this.app.vault.getFiles());
        return [...cacheFolders]
            .map((folderPath) => ({
                path: folderPath,
                name: folderPath.split('/').pop() ?? folderPath
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    getItems(): VaultSuggestionItem[] {
        const items: VaultSuggestionItem[] = [];

        // Add markdown files.
        for (const file of this.app.vault.getMarkdownFiles()) {
            items.push({ kind: 'file', file });
        }

        // Add embedded folders.
        const showFull = this.plugin.settings.enableFullEmbedPickerOption;
        for (const folder of this.embeddedFolders) {
            items.push({ kind: 'folder', folderPath: folder.path, folderName: folder.name, mode: 'top-k' });
            if (showFull) {
                items.push({ kind: 'folder', folderPath: folder.path, folderName: folder.name, mode: 'full' });
            }
        }

        return items;
    }

    getItemText(item: VaultSuggestionItem): string {
        if (item.kind === 'file') {
            return item.file.path;
        }
        return `${embedFolderLabel(item.folderName, item.mode)} ${item.folderPath}`;
    }

    renderSuggestion(item: FuzzyMatch<VaultSuggestionItem>, el: HTMLElement): void {
        if (item.item.kind === 'file') {
            el.createEl('div', { text: item.item.file.basename });
            el.createEl('div', { cls: 'quill-context-panel__item-matched', text: item.item.file.path });
        } else {
            const label = embedFolderLabel(item.item.folderName, item.item.mode);
            el.createEl('div', { text: label });
            el.createEl('div', { cls: 'quill-context-panel__item-matched', text: item.item.folderPath });
        }
    }

    onChooseItem(item: VaultSuggestionItem): void {
        if (item.kind === 'file') {
            void this.plugin.addManualContextItem(item.file.path);
        } else {
            void this.plugin.addFolderContextItem(item.folderPath, item.mode);
        }
    }
}

/** Uppercase the first character of a string, replacing hyphens with spaces in the remainder. */
function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
}

/** Render the context tab content. Called by QuillSidebarView. */
export function renderContextTab(
    container: HTMLElement,
    assembly: ContextAssembly | null,
    plugin: EventideQuillPlugin,
    component: Component
): void {
    container.empty();

    if (!assembly) {
        const activeFile = plugin.app.workspace.getActiveFile();
        if (activeFile) {
            container.createEl('p', {
                text: `Context not yet assembled for ${activeFile.basename}.`,
                cls: 'quill-context-panel__empty'
            });
            const rescanBtn = container.createEl('button', {
                cls: 'quill-context-panel__action-btn',
                text: 'Scan context'
            });
            component.registerDomEvent(rescanBtn, 'click', () => {
                const editorView = findEditorView(plugin.app, activeFile.path);
                if (editorView) {
                    const editorContent = editorView.editor.getValue();
                    plugin.scanContext(editorContent, activeFile.path);
                    void plugin.assembleDocumentContext(editorContent, activeFile.path);
                }
            });
        } else {
            container.createEl('p', {
                text: 'Open a manuscript to extract context.',
                cls: 'quill-context-panel__empty'
            });
        }
        return;
    }

    // Narrative voice section
    const voiceSection = container.createEl('div', { cls: 'quill-context-panel__section' });
    voiceSection.createEl('div', { cls: 'quill-context-panel__section-heading', text: 'Narrative voice' });
    const voiceBox = voiceSection.createEl('div', { cls: 'quill-context-panel__voice' });
    const voice = assembly.voice;
    voiceBox.createEl('div', {
        text: `${capitalize(voice.pov)}, ${voice.tense} tense`
    });
    voiceBox.createEl('div', {
        text: `Avg sentence: ${voice.avgSentenceLength} words`
    });
    voiceBox.createEl('div', {
        text: `Dialogue: ${Math.round(voice.dialogueRatio * 100)}%`
    });

    // Characters section
    const characters = assembly.entities.filter((e) => e.type === 'character' && !e.removed);
    if (characters.length > 0) {
        renderEntitySection(container, 'Characters', characters, plugin, component);
    }

    // Locations section
    const locations = assembly.entities.filter((e) => e.type === 'location' && !e.removed);
    if (locations.length > 0) {
        renderEntitySection(container, 'Locations', locations, plugin, component);
    }

    // Plot threads section
    const threads = assembly.entities.filter((e) => e.type === 'plot-thread' && !e.removed);
    if (threads.length > 0) {
        renderEntitySection(container, 'Plot threads', threads, plugin, component);
    }

    // Vault context section
    if (assembly.contextItems.length > 0 || plugin.removedContextPaths.size > 0) {
        renderVaultContextSection(container, assembly.contextItems, plugin, component);
    }

    // Token budget
    renderTokenBudget(container, assembly);

    // Actions
    const actionsRow = container.createEl('div', { cls: 'quill-context-panel__actions' });
    const addBtn = actionsRow.createEl('button', { cls: 'quill-context-panel__action-btn', text: 'Add file' });
    component.registerDomEvent(addBtn, 'click', () => {
        new AddFileModal(plugin.app, plugin).open();
    });

    const rescanBtn = actionsRow.createEl('button', { cls: 'quill-context-panel__action-btn', text: 'Rescan' });
    component.registerDomEvent(rescanBtn, 'click', () => {
        const filePath = plugin.contextActiveFile;
        if (filePath) {
            const editorView = findEditorView(plugin.app, filePath);
            if (editorView) {
                plugin.scanContext(editorView.editor.getValue(), filePath);
                void plugin.assembleDocumentContext(editorView.editor.getValue(), filePath);
            }
        }
    });

    if (plugin.hasRemovedItems()) {
        const restoreBtn = actionsRow.createEl('button', {
            cls: 'quill-context-panel__action-btn',
            text: 'Restore removed'
        });
        component.registerDomEvent(restoreBtn, 'click', () => {
            const filePath = plugin.contextActiveFile;
            if (filePath) {
                const editorView = findEditorView(plugin.app, filePath);
                if (editorView) {
                    void plugin.restoreRemovedItems(editorView.editor.getValue(), filePath);
                } else {
                    void plugin.restoreRemovedItems();
                }
            }
        });
    }
}

/** Render a section of entities (characters, locations, or plot threads). */
function renderEntitySection(
    container: HTMLElement,
    heading: string,
    entities: ExtractedEntity[],
    plugin: EventideQuillPlugin,
    component: Component
): void {
    const section = container.createEl('div', { cls: 'quill-context-panel__section' });
    section.createEl('div', {
        cls: 'quill-context-panel__section-heading',
        text: `${heading} (${entities.length})`
    });

    for (const entity of entities) {
        const card = section.createEl('div', { cls: 'quill-context-panel__entity' });

        const pinBtn = card.createEl('button', {
            cls: `quill-context-panel__pin-btn${entity.pinned ? ' quill-context-panel__pinned' : ''}`,
            text: entity.pinned ? 'Pinned' : 'Pin'
        });
        component.registerDomEvent(pinBtn, 'click', (e) => {
            e.stopPropagation();
            plugin.toggleEntityPin(entity.id);
        });

        card.createEl('span', { cls: 'quill-context-panel__entity-name', text: entity.name });
        card.createEl('span', { cls: 'quill-context-panel__entity-count', text: `×${entity.occurrences}` });

        if (entity.aliases.length > 0) {
            card.createEl('div', {
                cls: 'quill-context-panel__entity-aliases',
                text: `Aliases: ${entity.aliases.join(', ')}`
            });
        }

        if (entity.lines.length > 0) {
            const linesText =
                entity.lines.length <= 5
                    ? entity.lines.map(String).join(', ')
                    : `${entity.lines.slice(0, 5).map(String).join(', ')}, ...`;
            card.createEl('div', { cls: 'quill-context-panel__entity-lines', text: `Ln ${linesText}` });
        }

        const removeBtn = card.createEl('button', { cls: 'quill-context-panel__remove-btn', text: '×' });
        component.registerDomEvent(removeBtn, 'click', (e) => {
            e.stopPropagation();
            plugin.removeEntity(entity.id);
        });

        component.registerDomEvent(card, 'click', () => {
            jumpToLine(plugin, entity.lines[0]);
        });
    }
}

/** Render the vault context items section. */
function renderVaultContextSection(
    container: HTMLElement,
    items: ContextItem[],
    plugin: EventideQuillPlugin,
    component: Component
): void {
    const section = container.createEl('div', { cls: 'quill-context-panel__section' });
    section.createEl('div', {
        cls: 'quill-context-panel__section-heading',
        text: `Vault context (${items.length} items)`
    });

    for (const item of items) {
        const card = section.createEl('div', {
            cls: `quill-context-panel__item${item.pinned ? ' quill-context-panel__item--pinned' : ''}${item.manual ? ' quill-context-panel__item--manual' : ''}`
        });

        const header = card.createEl('div', { cls: 'quill-context-panel__item-header' });

        const pinBtn = header.createEl('button', {
            cls: `quill-context-panel__pin-btn${item.pinned ? ' quill-context-panel__pinned' : ''}`,
            text: item.pinned ? 'Pinned' : 'Pin'
        });
        component.registerDomEvent(pinBtn, 'click', (e) => {
            e.stopPropagation();
            plugin.toggleContextItemPin(item.filePath);
        });

        header.createEl('span', { cls: 'quill-context-panel__item-name', text: fileNameFromPath(item.filePath) });

        const removeBtn = header.createEl('button', { cls: 'quill-context-panel__remove-btn', text: '\u00d7' });
        component.registerDomEvent(removeBtn, 'click', (e) => {
            e.stopPropagation();
            plugin.removeContextItem(item.filePath);
        });

        const details = card.createEl('div', { cls: 'quill-context-panel__item-details' });
        details.createEl('span', { cls: 'quill-context-panel__item-path', text: item.filePath });

        if (item.matchedEntities.length > 0) {
            details.createEl('span', {
                cls: 'quill-context-panel__item-matched',
                text: `Matched: ${item.matchedEntities.join(', ')}`
            });
        }
    }
}

/** Render the token budget indicator using a label and progress bar. */
function renderTokenBudget(container: HTMLElement, assembly: ContextAssembly): void {
    const section = container.createEl('div', { cls: 'quill-context-panel__budget' });
    const used = assembly.totalTokens;
    const budget = assembly.tokenBudget;
    const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;

    section.createEl('div', {
        text: `Token budget: ${used.toLocaleString()} / ${budget.toLocaleString()} (${pct}%)`
    });

    const bar = section.createEl('div', { cls: 'quill-context-panel__budget-bar' });
    const fill = bar.createEl('div', { cls: 'quill-context-panel__budget-fill' });
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.style.backgroundColor = getBudgetColor(pct);
}

/** Scroll the active editor to a specific line, if applicable. */
function jumpToLine(plugin: EventideQuillPlugin, line: number | undefined): void {
    if (!line) return;
    const filePath = plugin.contextActiveFile;
    if (!filePath) return;
    const view = findEditorView(plugin.app, filePath);
    if (!view) return;
    view.editor.setCursor({ line: line - 1, ch: 0 });
    view.editor.scrollIntoView({ from: { line: line - 1, ch: 0 }, to: { line: line - 1, ch: 0 } }, true);
}

/** Extract the file name (without extension) from a full vault path. */
function fileNameFromPath(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dotIdx = fileName.lastIndexOf('.');
    return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}
