import { App, MarkdownRenderer, Notice, TFile, normalizePath } from 'obsidian';
import { Component } from 'obsidian';
import type { LoreDraftEntry, ProposedImage } from '../ai/co-writer';
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

    // Proposed image thumbnails (Path A only — when the agent attached
    // images to a new-entry draft). Held in memory until the writer saves.
    if (draft.proposedImages && draft.proposedImages.length > 0) {
        renderProposedImageThumbnails(card, draft.proposedImages, component);
    }

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
    let content = `${frontmatter}${draft.content.trim()}\n`;

    // Proposed images: write bytes to the attachments folder and update the
    // content with resolved filenames and gallery-section safety net. Keep
    // the resolved filenames so we can clean up if the subsequent note-
    // creation step fails, preventing orphaned (2), (3) copies on retries.
    let resolved: Array<{ original: string; resolved: string }> = [];
    if (draft.proposedImages && draft.proposedImages.length > 0) {
        try {
            // Pass the soon-to-be-created note's target path so Obsidian's
            // "./"-relative attachment-folder modes resolve against the new
            // note's parent folder (matching how Obsidian handles pastes
            // into a freshly-created note).
            resolved = await writeProposedImages(draft.proposedImages, plugin, targetPath);
            // If any image's filename changed during uniqueness resolution,
            // rewrite the embed in the content so the saved note points at
            // the actual file the writer will see.
            content = rewriteImageEmbeds(content, resolved);
            // Safety net: weaker models often skip authoring the gallery
            // section structure even when they attached images. If any
            // proposed-image embed is missing from the content, append a
            // fresh gallery section (or top up an existing one) so the
            // saved note actually shows the images rather than leaving
            // orphaned bytes on disk.
            content = ensureGallerySectionInContent(
                content,
                draft.proposedImages.map((img) => ({
                    ...img,
                    // Use the resolved filename (post-uniqueness) so the
                    // embed points at the actual file that was written.
                    suggestedFilename: resolved.find((r) => r.original === img.suggestedFilename)?.resolved
                        ? extractFilename(resolved.find((r) => r.original === img.suggestedFilename)!.resolved)
                        : img.suggestedFilename
                })),
                plugin.settings.loreEntryImageSectionHeaders
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Quill: Failed to save one or more proposed images — ${message}`);
            // Clean up any files that were written before the failure.
            await cleanupResolvedImages(resolved, plugin);
            return false;
        }
    }

    // The create call is the point that determines success. Post-save UI
    // actions (opening the note, refreshing coverage) are handled separately
    // so a failure there doesn't undo a successful save or surface a
    // misleading "Failed to save entry" notice.
    try {
        const file = plugin.app.vault.getAbstractFileByPath(targetPath);
        if (file instanceof TFile) {
            // Should not happen due to resolveUniquePath, but guard defensively.
            await cleanupResolvedImages(resolved, plugin);
            new Notice(`Quill: "${targetPath}" already exists. Rename and try again.`);
            return false;
        }
        await plugin.app.vault.create(targetPath, content);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The note was not created — clean up orphaned image files so retries
        // don't produce (2), (3) copies of every attachment.
        await cleanupResolvedImages(resolved, plugin);
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

// ── Proposed-image helpers (shared by Path A and Path B) ────────────────────

/**
 * Render a thumbnail row for a set of proposed images. Each thumbnail shows
 * the downscaled image plus its label/filename so the writer can see what
 * they're approving at a glance. No per-image approve/reject here — the
 * draft's Save / Discard buttons apply to the whole set, matching the
 * existing draft review UX.
 */
export function renderProposedImageThumbnails(
    container: HTMLElement,
    images: ProposedImage[],
    _component: Component
): void {
    const row = container.createEl('div', { cls: 'quill-lore-draft-card__images' });
    for (const image of images) {
        const thumb = row.createEl('div', { cls: 'quill-lore-draft-card__image' });
        thumb.createEl('img', {
            cls: 'quill-lore-draft-card__image-img',
            attr: { src: `data:image/jpeg;base64,${image.base64}`, alt: image.label || image.suggestedFilename }
        });
        const meta = thumb.createEl('div', { cls: 'quill-lore-draft-card__image-meta' });
        if (image.label) {
            meta.createEl('span', { cls: 'quill-lore-draft-card__image-label', text: image.label });
        }
        meta.createEl('span', { cls: 'quill-lore-draft-card__image-filename', text: image.suggestedFilename });
        if (image.caption) {
            meta.createEl('span', { cls: 'quill-lore-draft-card__image-caption', text: image.caption });
        }
    }
}

/**
 * Resolve the folder where agent-attached images should be written.
 *
 * Resolution order:
 * 1. Plugin setting `loreEntryImageAttachmentFolder` (non-empty) — always
 *    wins, treated as a vault-relative absolute path. `normalizePath`-wrapped.
 * 2. Obsidian's configured attachment folder (`getConfig('attachmentFolderPath')`)
 *    — handles the three modes Obsidian supports:
 *      - Vault root: returns ''.
 *      - Absolute path (e.g., "Attachments"): returned as-is.
 *      - Relative ("./" = same folder as current file, "./subfolder" =
 *        subfolder of current file's folder): resolved against the parent
 *        folder of `currentFilePath`. Without a current file, the relative
 *        part is treated as vault-root-relative (best-effort fallback).
 *
 * `currentFilePath` matters for Path A (new entry) and Path B (existing
 * entry). For Path A it should be the soon-to-be-created note's target
 * path — the parent folder of the new note is what "./" resolves against,
 * matching how Obsidian handles pastes into a freshly-created note.
 */
export function resolveAttachmentFolder(plugin: EventideQuillPlugin, currentFilePath?: string): string {
    const configured = plugin.settings.loreEntryImageAttachmentFolder.trim();
    if (configured.length > 0) return normalizePath(configured);

    // `Vault#getConfig` is undocumented in the public type defs but is the
    // standard community-plugin way to read Obsidian's attachment-folder
    // setting; cast through unknown to satisfy the typecheck.
    const vaultWithConfig = plugin.app.vault as unknown as { getConfig?: (key: string) => unknown };
    const obsidian = vaultWithConfig.getConfig?.('attachmentFolderPath');
    if (typeof obsidian !== 'string' || obsidian.length === 0) return '';

    // "./" = same folder as current file; "./sub" = subfolder of current
    // file's parent. Resolve against currentFilePath's parent folder.
    if (obsidian.startsWith('./')) {
        const subPath = obsidian.slice(2).trim();
        if (!currentFilePath) {
            // No current file to resolve against — fall back to vault root
            // (with the subPath if any, treated as absolute). This is the
            // best-effort path; the writer should ideally configure the
            // plugin setting instead of relying on a relative Obsidian
            // setting for agent-attached images.
            return subPath ? normalizePath(subPath) : '';
        }
        const lastSlash = currentFilePath.lastIndexOf('/');
        const parentFolder = lastSlash > 0 ? currentFilePath.slice(0, lastSlash) : '';
        return normalizePath(
            subPath.length > 0 ? (parentFolder.length > 0 ? `${parentFolder}/${subPath}` : subPath) : parentFolder
        );
    }

    // Absolute path in vault (Obsidian's "In the folder specified below" mode).
    return normalizePath(obsidian);
}

/**
 * Ensure every parent directory in `folder` exists, creating them as needed.
 * `vault.createBinary` does NOT create intermediate folders — if any
 * component doesn't exist, the write fails with ENOENT. Walks the path
 * component-by-component and `mkdir`s any missing levels. No-op when the
 * folder already exists or when `folder` is empty (vault root).
 */
export async function ensureAttachmentFolderExists(plugin: EventideQuillPlugin, folder: string): Promise<void> {
    if (!folder || folder === '/' || folder === '\\') return;
    const normalized = normalizePath(folder);
    if (await plugin.app.vault.adapter.exists(normalized)) return;
    // Walk components in order so nested paths like "a/b/c" create a, then
    // a/b, then a/b/c. mkdir is not reliably recursive across adapter
    // implementations, so the explicit walk is the safe path.
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const candidate = normalizePath(current);
        if (!(await plugin.app.vault.adapter.exists(candidate))) {
            await plugin.app.vault.adapter.mkdir(candidate);
        }
    }
}

/**
 * Write a set of proposed images to the vault attachments folder. Returns
 * the resolved filename for each (which may differ from the suggested
 * filename when uniqueness resolution kicked in). Callers should use the
 * returned filenames to rewrite any embeds in the markdown body that
 * reference the original suggested names.
 *
 * All constructed paths are `normalizePath()`-wrapped per the project's
 * hard rule (AGENTS.md: "Always normalizePath() on user-defined or
 * constructed file paths") — the Obsidian plugin review flags unwrapped
 * paths independently of any lint config.
 *
 * `currentFilePath` is passed through to {@link resolveAttachmentFolder}
 * so Obsidian's "./"-relative attachment-folder modes resolve correctly
 * (relative to the new note's parent for Path A, the existing entry's
 * parent for Path B).
 */
export async function writeProposedImages(
    images: ProposedImage[],
    plugin: EventideQuillPlugin,
    currentFilePath?: string
): Promise<Array<{ original: string; resolved: string }>> {
    const folder = resolveAttachmentFolder(plugin, currentFilePath);
    // Ensure the folder exists before writing — covers the case where a
    // relative subfolder (./assets under a fresh lorebook folder) hasn't
    // been created yet. No-op when the folder already exists.
    await ensureAttachmentFolderExists(plugin, folder);
    const resolved: Array<{ original: string; resolved: string }> = [];
    for (const image of images) {
        const basePath = folder.length > 0 ? `${folder}/${image.suggestedFilename}` : image.suggestedFilename;
        const uniquePath = await resolveUniqueAttachmentPath(basePath, plugin);
        const buffer = base64ToArrayBuffer(image.base64);
        await plugin.app.vault.createBinary(normalizePath(uniquePath), buffer);
        resolved.push({ original: image.suggestedFilename, resolved: uniquePath });
    }
    return resolved;
}

/**
 * Rewrite `![[original.png]]` and `![[original.png|caption]]` embeds in a
 * markdown body to point at the resolved filename when uniqueness
 * resolution renamed it. Leaves non-image embeds and non-rewritten ones
 * untouched. Path-style (relative `![](path)`) embeds are not rewritten —
 * agent-attached images use the wiki-link form by convention.
 */
export function rewriteImageEmbeds(content: string, resolved: Array<{ original: string; resolved: string }>): string {
    let out = content;
    for (const r of resolved) {
        if (r.original === r.resolved) continue;
        // Wiki-link embed: ![[original]] or ![[original|caption]]
        const originalName = r.original;
        const resolvedName = extractFilename(r.resolved);
        const re = new RegExp(`!\\[\\[${escapeRegExp(originalName)}(\\|[^\\]]*)?\\]\\]`, 'g');
        out = out.replace(re, (_m, caption) => `![[${resolvedName}${caption ?? ''}]]`);
    }
    return out;
}

/**
 * Ensure a recognized gallery section exists in the content with embeds for
 * every proposed image. Used at Path A save time as a safety net — the
 * lorebook coach prompt instructs the model to author the gallery section
 * itself, but weaker models often skip it and just attach the images array.
 * Without this, the saved note has the image bytes on disk but no embed
 * pointing at them, so the writer sees a broken/empty gallery.
 *
 * Behavior:
 *   - If the content already has every proposed-image embed (regardless of
 *     where the model put them), return content unchanged. We don't move
 *     embeds around — the model's placement stands.
 *   - If some embeds are missing AND a recognized gallery section heading
 *     exists, append the missing embeds at the end of content (the model's
 *     gallery section is incomplete; we top it up rather than create a
 *     second gallery).
 *   - If some embeds are missing AND no gallery section heading exists,
 *     append a fresh `## {primaryHeader}` section containing the missing
 *     embeds, each under its proposed label (as a subheading).
 *
 * Caption (if present) is included via the `![[file|caption]]` slot.
 */
export function ensureGallerySectionInContent(
    content: string,
    images: ProposedImage[],
    sectionHeaders: string[]
): string {
    if (images.length === 0) return content;

    // Find every ![[...]] embed target in the content (case-insensitive).
    const embedTargets = new Set<string>();
    const embedPattern = /!\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = embedPattern.exec(content)) !== null) {
        const target = m[1]?.split('|')[0]?.trim().toLowerCase();
        if (target) embedTargets.add(target);
    }
    const missing = images.filter((img) => !embedTargets.has(img.suggestedFilename.toLowerCase()));
    if (missing.length === 0) return content;

    // Check for an existing recognized gallery section heading.
    const headerSet = new Set(sectionHeaders.map((h) => h.trim().toLowerCase()));
    const hasGallery = content.split('\n').some((line) => {
        const hm = line.match(/^#{1,6}\s+(.+?)\s*$/);
        return hm && hm[1] ? headerSet.has(hm[1].trim().toLowerCase()) : false;
    });

    // Build the missing-embeds block. Each image contributes either a
    // subheading + embed (when labeled) or just an embed.
    const block = missing
        .map((img) => {
            const captionSuffix = img.caption ? `|${img.caption}` : '';
            const embed = `![[${img.suggestedFilename}${captionSuffix}]]`;
            return img.label ? `### ${img.label}\n${embed}` : embed;
        })
        .join('\n\n');

    const trimmedContent = content.replace(/\s+$/, '');
    if (hasGallery) {
        // Existing gallery section but some embeds missing — top it up.
        return `${trimmedContent}\n\n${block}\n`;
    }
    // No gallery section — append a fresh one under the primary configured header.
    const primaryHeader = sectionHeaders[0] ?? 'Reference';
    return `${trimmedContent}\n\n## ${primaryHeader}\n\n${block}\n`;
}

/**
 * Insert a gallery section with `![[file]]` embeds into an existing note.
 * If the note already has a section under one of the configured gallery
 * headings, the new subheading + embed is appended inside it; otherwise a
 * fresh `## Reference` section is added at the end. Uses `vault.process`
 * for safe concurrent writes (it re-reads on each call so other writes
 * don't race).
 *
 * Returns the new content (for caller use) but the write is performed here.
 */
export async function insertImageEmbedIntoNote(
    filePath: string,
    label: string,
    filename: string,
    caption: string | undefined,
    plugin: EventideQuillPlugin
): Promise<void> {
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
        throw new Error(`Note "${filePath}" no longer exists.`);
    }

    const embed = caption ? `![[${filename}|${caption}]]` : `![[${filename}]]`;
    const headers = plugin.settings.loreEntryImageSectionHeaders;
    const primaryHeader = headers[0] ?? 'Reference';

    await plugin.app.vault.process(file, (content) => {
        // Look for an existing gallery section: a heading matching any
        // configured header (case-insensitive). Simple line-based scan to
        // avoid pulling in a markdown parser dependency.
        const lines = content.split('\n');
        const headerSet = new Set(headers.map((h) => h.trim().toLowerCase()));
        let sectionLineIdx = -1;
        let sectionLevel = 2;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i]?.match(/^(#{1,6})\s+(.+?)\s*$/);
            if (m && m[1] && m[2]) {
                const level = m[1].length;
                const heading = m[2].trim().toLowerCase();
                if (headerSet.has(heading)) {
                    sectionLineIdx = i;
                    sectionLevel = level;
                    break;
                }
            }
        }

        const block = `### ${label}\n${embed}\n`;

        // No existing gallery section — append a fresh one at the end.
        if (sectionLineIdx === -1) {
            const needsNewline = content.length > 0 && !content.endsWith('\n');
            return `${content}${needsNewline ? '\n' : ''}\n## ${primaryHeader}\n\n${block}`;
        }

        // Find the end of the gallery section (next heading of same or
        // higher level, or EOF).
        let insertAt = lines.length;
        for (let i = sectionLineIdx + 1; i < lines.length; i++) {
            const m = lines[i]?.match(/^(#{1,6})\s+/);
            if (m && m[1] && m[1].length <= sectionLevel) {
                insertAt = i;
                break;
            }
        }

        // Insert before the next sibling/higher heading, or append. Add a
        // blank line above for separation if the prior line isn't already blank.
        const newLines: string[] = [];
        if (insertAt > 0 && lines[insertAt - 1] !== '' && lines[insertAt - 1] !== undefined) {
            newLines.push('');
        }
        newLines.push(...block.split('\n'));
        if (insertAt < lines.length) newLines.push('');

        lines.splice(insertAt, 0, ...newLines);
        return lines.join('\n');
    });
}

/** Decode a base64 string into an ArrayBuffer for `vault.createBinary`. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
        view[i] = binary.charCodeAt(i);
    }
    return buffer;
}

/**
 * Resolve a base attachment path to a non-colliding one. Mirrors
 * {@link resolveUniquePath} but for binary attachments (same uniqueness
 * contract, different code path for clarity since the call sites differ).
 */
async function resolveUniqueAttachmentPath(basePath: string, plugin: EventideQuillPlugin): Promise<string> {
    const normalizedBase = normalizePath(basePath);
    const dotIdx = normalizedBase.lastIndexOf('/');
    const folder = dotIdx > 0 ? normalizedBase.slice(0, dotIdx) : '';
    const filename = dotIdx > 0 ? normalizedBase.slice(dotIdx + 1) : normalizedBase;
    const fnameDot = filename.lastIndexOf('.');
    const stem = fnameDot > 0 ? filename.slice(0, fnameDot) : filename;
    const ext = fnameDot > 0 ? filename.slice(fnameDot) : '';

    let candidate = normalizedBase;
    let n = 2;
    while (plugin.app.vault.getAbstractFileByPath(candidate)) {
        const next = `${stem} (${n})${ext}`;
        candidate = normalizePath(folder.length > 0 ? `${folder}/${next}` : next);
        n++;
    }
    return candidate;
}

/**
 * Delete every file in `resolved` from the vault, best-effort. Used to clean
 * up orphaned attachment files when a subsequent step (note creation, embed
 * insertion) fails, preventing duplicate (2), (3) writes on retries.
 */
async function cleanupResolvedImages(
    resolved: Array<{ original: string; resolved: string }>,
    plugin: EventideQuillPlugin
): Promise<void> {
    for (const r of resolved) {
        try {
            const file = plugin.app.vault.getAbstractFileByPath(r.resolved);
            if (file instanceof TFile) {
                await plugin.app.fileManager.trashFile(file);
            }
        } catch {
            // Best-effort cleanup — if the file can't be deleted, it will be
            // handled by resolveUniqueAttachmentPath on the next retry.
        }
    }
}

/** Strip the folder from a vault path, returning just the filename. */
function extractFilename(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Escape regex metacharacters in a filename for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Path B: image attachments to existing entries ───────────────────────────

/**
 * Render a review card for proposed image attachments to an existing lore
 * entry (Path B). Each card shows the target entry's name, a thumbnail row
 * for every proposed image, and Approve-all / Reject-all buttons.
 *
 * On Approve: writes each image's bytes to the attachments folder and
 * inserts the matching `![[file]]` embed into the entry's gallery section
 * under the proposed label. The writer reviews per-file (not per-image);
 * rejecting drops the whole set for that entry without writing anything.
 */
export function renderLoreImageAttachmentCard(
    container: HTMLElement,
    proposal: { filePath: string; fileBasename: string; images: ProposedImage[] },
    plugin: EventideQuillPlugin,
    component: Component,
    callbacks: {
        onApprove?: (filePath: string) => void;
        onReject?: (filePath: string) => void;
    }
): void {
    const card = container.createEl('div', { cls: 'quill-lore-draft-card quill-lore-draft-card--attachment' });

    const header = card.createEl('div', { cls: 'quill-lore-draft-card__header' });
    header.createEl('span', {
        cls: 'quill-lore-draft-card__title',
        text: proposal.fileBasename
    });
    header.createEl('span', {
        cls: 'quill-lore-draft-card__type-badge',
        text: `image${proposal.images.length === 1 ? '' : 's'}`
    });

    card.createEl('div', {
        cls: 'quill-lore-draft-card__preview-label',
        text: `Proposed attachment${proposal.images.length === 1 ? '' : 's'} — review and approve to write to vault`
    });

    renderProposedImageThumbnails(card, proposal.images, component);

    const actions = card.createEl('div', { cls: 'quill-lore-draft-card__actions' });
    const approveBtn = actions.createEl('button', {
        cls: 'quill-lore-draft-card__save mod-cta',
        text: 'Approve all'
    });
    const rejectBtn = actions.createEl('button', {
        cls: 'quill-lore-draft-card__discard',
        text: 'Reject all'
    });

    component.registerDomEvent(approveBtn, 'click', () => {
        void approveAttachmentToVault(proposal, plugin).then((ok) => {
            if (ok) callbacks.onApprove?.(proposal.filePath);
        });
    });
    component.registerDomEvent(rejectBtn, 'click', () => {
        callbacks.onReject?.(proposal.filePath);
    });
}

/**
 * Persist a proposed-attachment set: writes each image's bytes and inserts
 * its embed into the entry's gallery section. Surfaces failures via Notice
 * and returns false so the caller leaves the proposal in the queue.
 */
async function approveAttachmentToVault(
    proposal: { filePath: string; images: ProposedImage[] },
    plugin: EventideQuillPlugin
): Promise<boolean> {
    let resolved: Array<{ original: string; resolved: string }> = [];
    try {
        // Pass the existing entry's path so Obsidian's "./"-relative
        // attachment-folder modes resolve against the entry's parent
        // folder (matching how Obsidian handles pastes into an open note).
        resolved = await writeProposedImages(proposal.images, plugin, proposal.filePath);
        // After the bytes are written, insert each embed. Use the resolved
        // filename (which may differ from the suggested one if uniqueness
        // resolution kicked in).
        for (let i = 0; i < proposal.images.length; i++) {
            const img = proposal.images[i]!;
            const filename = extractFilename(resolved[i]?.resolved ?? img.suggestedFilename);
            await insertImageEmbedIntoNote(proposal.filePath, img.label, filename, img.caption, plugin);
        }
        new Notice(
            `Quill: Attached ${proposal.images.length} image${proposal.images.length === 1 ? '' : 's'} to the entry.`
        );
        try {
            await plugin.refreshLorebook();
        } catch {
            // Best-effort — the writes succeeded.
        }
        return true;
    } catch (err) {
        // Any step failed — clean up all files we wrote so retries don't
        // create (2), (3) copies of every attachment.
        await cleanupResolvedImages(resolved, plugin);
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Quill: Failed to attach images — ${msg}`);
        return false;
    }
}
