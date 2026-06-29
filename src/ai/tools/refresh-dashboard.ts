import type { Tool, ToolContext } from './tool';
import { resolveNoteFile } from './lore-edit-helpers';
import type EventideQuillPlugin from '../../main';

/**
 * Refresh the manuscript dashboard: scan the active manuscript (opening `path`
 * first if given) so the dashboard + manuscript context (entities, chapter
 * list) is populated, and return the chapter list (file path + title + word
 * count) plus totals.
 *
 * Use this to establish manuscript context before batching a lorebook edit,
 * running research, or working with `manuscript_mentions` — and whenever the
 * dashboard is empty. Requires a manuscript file: pass `path` (a chapter or
 * manuscript file) to open it first, or call with no args if one is already
 * open. The returned file paths are what you hand to `run_lorebook_batch` /
 * `run_research`.
 */
export const refreshDashboardTool: Tool = {
    id: 'refresh_dashboard',
    description:
        'Refresh the manuscript dashboard: scan the active manuscript (or open `path` first) and ' +
        'return its chapter list (file path + title + word count) plus totals. Use this whenever ' +
        'the manuscript context is empty — before batching a lorebook edit, running research, or ' +
        'using manuscript_mentions. Requires a manuscript file: pass `path` (a chapter/manuscript ' +
        'file, vault path or note name) to open it first, or omit if one is already open. The ' +
        'returned chapter file paths are what you pass to run_lorebook_batch / run_research.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description:
                    'Optional. A manuscript or chapter file to open first (so the dashboard scans its folder). Omit if a manuscript file is already open.'
            }
        },
        required: []
    },
    maxResultTokens: 800,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const { plugin } = ctx;

        if (path) {
            const file = resolveNoteFile(plugin, path);
            if (!file) return `Error: note "${path}" not found in the vault.`;
            // Open it so it becomes the active file the dashboard keys off.
            await plugin.app.workspace.openLinkText(file.path, '', false);
            const ready = await waitForActiveFile(plugin, file.path);
            if (!ready) {
                return `Error: could not open "${file.path}" as the active file. Open a manuscript file in the editor and retry.`;
            }
        }

        await plugin.refreshDashboard();
        const metrics = plugin.currentDashboardMetrics;
        if (!metrics || metrics.chapters.length === 0) {
            return (
                'No manuscript dashboard data. Open a manuscript file (pass its path to this tool, ' +
                "or open one in the editor) and retry — the dashboard scans the active file's folder."
            );
        }

        const cap = 40;
        const shown = metrics.chapters.slice(0, cap);
        const lines = [
            `Manuscript refreshed: ${metrics.chapterCount} chapter(s), ${metrics.totalWords.toLocaleString()} words across ${metrics.chapters.length} file(s). Chapter files:`
        ];
        for (const c of shown) {
            lines.push(`- ${c.filePath} — ${c.title} (${c.wordCount.toLocaleString()} words)`);
        }
        if (metrics.chapters.length > cap) {
            lines.push(
                `- …and ${metrics.chapters.length - cap} more (use measure_folder on the manuscript folder for the full list).`
            );
        }
        lines.push('\nPass these file paths to run_lorebook_batch or run_research when working across the manuscript.');
        return lines.join('\n');
    }
};

/**
 * Poll briefly until `filePath` is the workspace's active file (opening a note
 * is async and the active leaf updates shortly after `openLinkText` resolves).
 * Raw setTimeout — see AGENTS.md: a short bounded poll is the pragmatic wait
 * for "editor/leaf ready," same idiom as openNoteForEdit.
 */
async function waitForActiveFile(plugin: EventideQuillPlugin, filePath: string, timeoutMs = 700): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (plugin.app.workspace.getActiveFile()?.path === filePath) return true;
        // Raw window.setTimeout — a short bounded poll for "leaf ready", same
        // idiom as openNoteForEdit (no callback/promise exists for active-leaf
        // changes immediately after openLinkText resolves).
        await new Promise((r) => window.setTimeout(r, 50));
    }
    return plugin.app.workspace.getActiveFile()?.path === filePath;
}
