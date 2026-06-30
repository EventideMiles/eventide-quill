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
 * Result is the note's body text with frontmatter stripped, EXACTLY as it
 * appears in the file. If the file doesn't exist or isn't readable, returns
 * a clear error string so the model can recover (e.g., ask the user for the
 * correct path).
 *
 * IMPORTANT: vault_lookup returns the verbatim body so the model can quote
 * distinctive snippets as `anchor` arguments to `insert_note` / `edit_note`.
 * Stripping or rewriting the body here breaks the editing flow — the model
 * would anchor on text that doesn't exist in the actual file. Gallery
 * stripping for token-budget purposes happens at embedding-chunk time and
 * top-K injection time, NOT here.
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
        '(e.g., "Sarah Connor"). Returns the body text WITHOUT frontmatter, ' +
        'verbatim — quote distinctive snippets from the result as the `anchor` ' +
        'for insert_note / edit_note. IMPORTANT: results stay in context for ' +
        'ALL subsequent turns — read files judiciously, especially during ' +
        'multi-file edits. Read one file, make your edit, then move to the next.',
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

        // Return the verbatim body. Do NOT strip gallery sections here — the
        // model uses this output to construct anchors for insert_note /
        // edit_note, and any rewriting (including the gallery-section marker
        // that replaces embed syntax elsewhere) would make those anchors
        // fail against the actual file. Embed text is small and harmless in
        // this context; the token-budget stripping happens at chunk time
        // and top-K injection time, which don't feed the editing tools.
        return splitFrontmatter(raw).body;
    }
};

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
