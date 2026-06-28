import { App, MarkdownRenderer, Notice } from 'obsidian';
import { Component, normalizePath, TFile } from 'obsidian';
import type { LoreDraftEntry } from '../ai/co-writer';
import { LORE_TYPE_LABELS } from '../core/dashboard/lorebook-types';
import type { LoreEntryType } from '../core/dashboard/lorebook-types';
import type EventideQuillPlugin from '../main';

/**
 * Render a proposed lore entry draft as a review card. Used by the Lorebook
 * Coach to surface `<lore_draft>` blocks extracted from the model's response.
 *
 * The card shows the proposed name + type, a markdown-rendered preview of the
 * body, and Save / Discard actions. Save writes the entry to the first
 * matching lorebook folder (`lorebookFolderTypes` match by type, else the
 * first configured folder) via `vault.create(normalizePath(...))` with a
 * `quill-type` frontmatter key; Discard drops the draft from the session.
 *
 * @returns void — the card is appended to `container`.
 */
export function renderLoreDraftCard(
    container: HTMLElement,
    draft: LoreDraftEntry,
    app: App,
    plugin: EventideQuillPlugin,
    component: Component,
    callbacks: {
        onSave?: (draft: LoreDraftEntry) => void;
        onDiscard?: (draft: LoreDraftEntry) => void;
    }
): void {
    const card = container.createEl('div', { cls: 'quill-lore-draft-card' });

    // Header row: title + type badge.
    const header = card.createEl('div', { cls: 'quill-lore-draft-card__header' });
    header.createEl('span', {
        cls: 'quill-lore-draft-card__title',
        text: draft.name
    });
    if (draft.entryType) {
        header.createEl('span', {
            cls: 'quill-lore-draft-card__type-badge',
            text: LORE_TYPE_LABELS[draft.entryType]
        });
    }

    // Preview subheading — sets expectation that what's shown is what gets saved.
    card.createEl('div', {
        cls: 'quill-lore-draft-card__preview-label',
        text: 'Proposed entry preview'
    });

    // Markdown-rendered body. Same async-render pattern as the chat bubbles.
    const preview = card.createEl('div', { cls: 'quill-lore-draft-card__preview' });
    const p = MarkdownRenderer.render(app, draft.content, preview, '', component);
    void p;

    // Action row.
    const actions = card.createEl('div', { cls: 'quill-lore-draft-card__actions' });
    const saveBtn = actions.createEl('button', {
        cls: 'quill-lore-draft-card__save mod-cta',
        text: 'Save as note'
    });
    const discardBtn = actions.createEl('button', {
        cls: 'quill-lore-draft-card__discard',
        text: 'Discard'
    });

    component.registerDomEvent(saveBtn, 'click', () => {
        void saveDraftToVault(draft, plugin).then((saved) => {
            if (saved) {
                callbacks.onSave?.(draft);
            }
        });
    });
    component.registerDomEvent(discardBtn, 'click', () => {
        callbacks.onDiscard?.(draft);
    });
}

/**
 * Persist a lore draft as a new note. Picks the target folder via:
 *   1. The folder whose `lorebookFolderTypes` entry matches the draft's type.
 *   2. The first configured lorebook folder as fallback.
 *
 * Generates a filesystem-safe filename from the draft name. If a file with
 * the same path already exists, appends " (2)", " (3)", etc. until unique.
 *
 * @returns true on success, false on failure (error surfaced via Notice).
 */
async function saveDraftToVault(draft: LoreDraftEntry, plugin: EventideQuillPlugin): Promise<boolean> {
    if (plugin.settings.lorebookFolders.length === 0) {
        new Notice('Quill: No lorebook folders configured.');
        return false;
    }

    const folder = pickTargetFolder(draft.entryType, plugin);
    if (!folder) {
        new Notice('Quill: Could not resolve a target lorebook folder.');
        return false;
    }

    const fileName = `${sanitizeFileName(draft.name)}.md`;
    const basePath = folder.length > 0 ? `${folder}/${fileName}` : fileName;
    const targetPath = normalizePath(await resolveUniquePath(basePath, plugin));

    const frontmatter = draft.entryType ? `---\nquill-type: ${draft.entryType}\n---\n\n` : '';
    const content = `${frontmatter}${draft.content.trim()}\n`;

    // The create call is the point that determines success. Post-save UI
    // actions (opening the note, refreshing coverage) are handled separately
    // so a failure there doesn't undo a successful save or surface a
    // misleading "Failed to save entry" notice.
    try {
        const file = plugin.app.vault.getAbstractFileByPath(targetPath);
        if (file instanceof TFile) {
            // Should not happen due to resolveUniquePath, but guard defensively.
            new Notice(`Quill: "${targetPath}" already exists. Rename and try again.`);
            return false;
        }
        await plugin.app.vault.create(targetPath, content);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: Failed to save entry — ${message}`);
        return false;
    }

    new Notice(`Quill: Saved "${draft.name}" to ${folder || '(vault root)'}.`);

    // Open the new note so the writer can see and edit it immediately.
    try {
        await plugin.app.workspace.openLinkText(targetPath, '', false);
    } catch {
        // Non-fatal: the note was created; opening is best-effort.
    }

    // Refresh lorebook coverage so the new entry shows up in the Lorebook tab.
    try {
        await plugin.refreshLorebook();
    } catch {
        // Non-fatal: the note was created; coverage refresh is best-effort.
    }

    return true;
}

/**
 * Pick the lorebook folder to save into. If the draft has a declared type
 * and any configured folder defaults to that type via `lorebookFolderTypes`,
 * use it; otherwise fall back to the first configured folder.
 */
function pickTargetFolder(entryType: LoreEntryType | null, plugin: EventideQuillPlugin): string | null {
    const folders = plugin.settings.lorebookFolders;
    if (folders.length === 0) return null;

    if (entryType) {
        const typed = folders.find((f) => plugin.settings.lorebookFolderTypes[f] === entryType);
        if (typed !== undefined) return typed;
    }
    return folders[0] ?? '';
}

/**
 * Strip characters that are unsafe in filenames on common filesystems.
 * Keeps unicode letters and digits, spaces, hyphens, and parentheses.
 */
function sanitizeFileName(name: string): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > 0 ? cleaned : 'Untitled';
}

/**
 * Resolve a base path to a non-colliding one by appending " (N)" before the
 * extension when a file already exists at the target path. Normalizes the
 * candidate before each vault probe so redundant separators don't defeat the
 * existence check.
 */
async function resolveUniquePath(basePath: string, plugin: EventideQuillPlugin): Promise<string> {
    const normalizedBase = normalizePath(basePath);
    const dotIdx = normalizedBase.lastIndexOf('.');
    const stem = dotIdx > 0 ? normalizedBase.slice(0, dotIdx) : normalizedBase;
    const ext = dotIdx > 0 ? normalizedBase.slice(dotIdx) : '';

    let candidate = normalizedBase;
    let n = 2;
    while (plugin.app.vault.getAbstractFileByPath(candidate)) {
        candidate = normalizePath(`${stem} (${n})${ext}`);
        n++;
    }
    return candidate;
}
