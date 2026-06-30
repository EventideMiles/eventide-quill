import { normalizePath, TFile } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { splitFrontmatter } from './lore-edit-helpers';

/**
 * Read the text content of a note in the user's vault. Use to pull in
 * reference material, existing lore entries, or research notes the writer
 * has already authored.
 *
 * The `path` argument may be a vault-relative file path (e.g.,
 * `Lore/Characters/Sarah Connor.md`) OR a note name (e.g., `Sarah Connor`).
 * Path lookups are exact; name lookups search the metadata cache and resolve
 * the first match.
 *
 * Result is the note's body text with frontmatter stripped. If the file
 * doesn't exist or isn't readable, returns a clear error string so the
 * model can recover (e.g., ask the user for the correct path).
 *
 * Security: the only file-access path is `vault.getAbstractFileByPath` /
 * `metadataCache.getFirstLinkpathDest` plus `vault.cachedRead`. Both honor
 * Obsidian's sandbox — no filesystem escape is possible. Constructed paths
 * are always wrapped in `normalizePath()` per the project's hard rule
 * (AGENTS.md: "Always normalizePath() on user-defined or constructed file
 * paths").
 */
export const vaultLookupTool: Tool = {
    id: 'vault_lookup',
    description:
        'Read the text content of a note in the vault. Pass a vault-relative ' +
        'path (e.g., "Lore/Characters/Sarah Connor.md") or a note name ' +
        '(e.g., "Sarah Connor"). Returns the body text without frontmatter. ' +
        'IMPORTANT: results stay in context for ALL subsequent turns — read ' +
        'files judiciously, especially during multi-file edits. Read one file, ' +
        'make your edit, then move to the next.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Vault-relative file path or note name to look up.'
            }
        },
        required: ['path']
    },
    maxResultTokens: 1500,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const query = typeof args.path === 'string' ? args.path.trim() : '';
        if (!query) {
            return 'Error: no path or note name supplied. Provide a "path" argument.';
        }

        const file = resolveVaultFile(query, ctx);
        if (!file) {
            return `No note matching "${query}" was found in the vault.`;
        }

        const raw = await ctx.plugin.app.vault.cachedRead(file);
        if (!raw.trim()) {
            return `Note "${file.path}" is empty.`;
        }

        const body = splitFrontmatter(raw).body;
        return appendImageHint(body, file, ctx);
    }
};

/**
 * If the note contains image embeds (`![[file.png]]`) inside a configured
 * gallery section, append a one-line hint telling the model those images
 * exist and how to fetch them. Without this, the model sees the embed
 * syntax as plain text and tends to either hallucinate visual details or
 * ask the writer for them, rather than calling `get_lore_image` to see
 * the pixels directly.
 */
function appendImageHint(body: string, file: TFile, ctx: ToolContext): string {
    const cache = ctx.plugin.app.metadataCache.getFileCache(file);
    const embeds = cache?.embeds ?? [];
    const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
    const imageEmbeds = embeds.filter((e) => {
        const filename = e.link.split('|')[0]?.toLowerCase() ?? '';
        return imageExtensions.some((ext) => filename.endsWith('.' + ext));
    });
    if (imageEmbeds.length === 0) return body;

    const name = file.basename;
    return (
        body +
        `\n\n[This note contains ${imageEmbeds.length} image embed${imageEmbeds.length === 1 ? '' : 's'}. ` +
        `Call get_lore_image with entry "${name}" (and an optional label) to actually see ${imageEmbeds.length === 1 ? 'it' : 'them'} — do not guess visual details from the filename.]`
    );
}

/**
 * Resolve a query to a vault file. If the query looks like a path (contains
 * a `/` or ends in `.md`), try `getAbstractFileByPath` first. Otherwise
 * fall back to a name lookup via `getFirstLinkpathDest`.
 */
function resolveVaultFile(query: string, ctx: ToolContext): TFile | null {
    const { app } = ctx.plugin;
    const looksLikePath = query.includes('/') || /\.md$/i.test(query);

    if (looksLikePath) {
        const normalized = normalizePath(query);
        const file = app.vault.getAbstractFileByPath(normalized);
        if (file instanceof TFile) return file;
    }

    // Name lookup — pass an empty source path so Obsidian resolves against
    // the vault root. Returns null if no note matches.
    const dest = app.metadataCache.getFirstLinkpathDest(query, '');
    return dest instanceof TFile ? dest : null;
}
