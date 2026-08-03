import type { ChatMessage } from './provider';
import type EventideQuillPlugin from '../main';
import { buildIndex, type MemoryEntry } from '../core/memories/memory-file';
import { GLOBAL_MEMORY_SCOPE, resolveActiveScopeKey } from '../core/memories/memory-scope';
import { readMemoryFile } from '../core/memories/memory-store';

/**
 * Memory-related system-prompt content: the auto-injected index of saved
 * memories for the active scope (+ global pool), plus the discipline clause
 * telling the model WHEN to call `save_memory`.
 *
 * Two public builders:
 *   - {@link buildMemoryMessage} — the index message, async (reads vault).
 *     Pushed into the co-writer's `injectedContext` alongside the network
 *     and internal-tools messages. Returns null when memories are disabled
 *     (master kill switch) or when both pools are empty.
 *   - {@link buildMemoryDisciplineClause} — the WHEN-to-save guidance, sync.
 *     Appended to the internal/lorebook tool-prompts so the model knows how
 *     to use `save_memory` responsibly.
 *
 * Index format (hybrid retrieval, default):
 *   ```
 *   ## Memories (Manuscript)
 *   - **Long passages are intentional pacing** — ^quill-mem-001
 *     Do not flag the slow passage in chapter 4 — the writer confirmed...
 *   - **Third-person limited, past tense** — ^quill-mem-002
 *     Don't suggest present tense or head-hopping.
 *
 *   ## Memories (Global)
 *   - **Series uses British spelling** — ^quill-mem-001
 *     Colour, favourite, realise — don't flag as errors.
 *
 *   Use recall_memory to fetch full bodies when an entry seems relevant.
 *   ```
 *
 * When `memoriesFullInject` is on, the previews are replaced with the full
 * bodies (for writers running powerful models with large context windows).
 */

/**
 * The discipline clause appended to tool-advertising prompts when memories
 * are on. Tells the model WHEN to call `save_memory` and which scope to use.
 * Kept short — the tool description itself has the detailed guidance.
 */
export const MEMORY_DISCIPLINE_CLAUSE = [
    'You have a `save_memory` tool that persists facts you learn about this',
    "story or the writer's preferences. Use it SPARINGLY for durable,",
    'reusable context — never for transient discussion.',
    '',
    'SAVE a memory when the writer:',
    '- Corrects an assumption you made (you flagged X, they said "that\'s',
    '  intentional" — save the intent so you do not re-flag it).',
    '- States a preference about voice, style, or process.',
    '- Surfaces a worldbuilding fact not in the lorebook that future',
    '  sessions would benefit from knowing.',
    '- Clarifies the meaning behind a choice that looks like a mistake.',
    '',
    'DO NOT save a memory for:',
    '- Transient discussion or in-progress drafting.',
    '- Restatements of lorebook entries or obvious manuscript facts.',
    '- Anything the writer is unlikely to want remembered next session.',
    '',
    'SCOPE: default `auto` is correct for most saves (active manuscript',
    "pool, or global when no manuscript is in context). Use `global` only",
    'for facts that span manuscripts — series-wide tone, shared',
    'worldbuilding, cross-book preferences. When in doubt, use `auto`.',
    '',
    'DELETE only when the writer explicitly asks. Deletes are surfaced',
    'prominently and the writer can recover the text from Obsidian\'s file',
    'recovery.'
].join('\n');

/**
 * Build the memory-index system message for the active context. Reads
 * the active scope's `.memories.md` and the global pool, parses them,
 * runs the re-tokenize pass (best-effort write-back via the store), and
 * formats the index into a system message.
 *
 * Returns null when:
 *   - `memoriesEnabled` is off (master kill switch — the feature must
 *     vanish entirely from the model's awareness).
 *   - Both the active pool and the global pool have zero entries.
 *
 * When `memoriesFullInject` is on, previews are replaced with full bodies.
 *
 * Async because memory files live in the vault. Callers should `await`
 * this and push the result (when non-null) into the system-message array
 * alongside the network and internal-tools messages.
 */
export async function buildMemoryMessage(plugin: EventideQuillPlugin): Promise<ChatMessage | null> {
    if (!plugin.settings.memoriesEnabled) return null;

    const sections: string[] = [];
    // readMemoryFile resolves the active scope via the same chain used by the
    // tools (manuscript folder → active file → global). It also runs the
    // re-tokenize pass (assignMissingIds + best-effort write-back) so
    // writer-added sections get IDs minted before they're shown to the model.
    const activeResult = await readMemoryFile(plugin, resolveActiveScopeKey(plugin));
    if (activeResult.scopeKey !== GLOBAL_MEMORY_SCOPE && activeResult.file.entries.length > 0) {
        const section = formatSection(plugin, activeResult.scopeKey, activeResult.file.entries);
        if (section) sections.push(section);
    }
    const globalResult = await readMemoryFile(plugin, GLOBAL_MEMORY_SCOPE);
    if (globalResult.file.entries.length > 0) {
        const section = formatSection(plugin, GLOBAL_MEMORY_SCOPE, globalResult.file.entries);
        if (section) sections.push(section);
    }

    if (sections.length === 0) return null;
    return { role: 'system', content: sections.join('\n\n') };
}

/**
 * Format a scope's entries as a prompt section. Returns null when there are
 * no entries to show (e.g. when the cap is 0). Uses the writer's settings
 * for full-vs-preview injection and the entry cap.
 */
function formatSection(
    plugin: EventideQuillPlugin,
    scopeKey: string,
    entries: readonly MemoryEntry[]
): string | null {
    if (entries.length === 0) return null;
    const label = scopeKey === GLOBAL_MEMORY_SCOPE ? 'Global' : scopeKey;
    const fullInject = plugin.settings.memoriesFullInject;
    // Slice unconditionally so a cap of 0 yields no entries (matches
    // buildIndex's behavior). Negative caps (treated as 0 by Math.max) also
    // produce empty output rather than showing everything.
    const cap = Math.max(0, plugin.settings.memoriesMaxIndexEntries);
    const shown = entries.slice(0, cap);
    if (shown.length === 0) return null;
    const truncated = entries.length > shown.length;

    const lines: string[] = [`## Memories (${label})`];

    if (fullInject) {
        for (const entry of shown) {
            lines.push(formatFull(entry));
        }
    } else {
        const index = buildIndex(shown, shown.length);
        for (const entry of index) {
            lines.push(formatPreview(entry));
        }
    }

    if (truncated) {
        lines.push(
            `_(...${entries.length - shown.length} more — use \`recall_memory\` to see the rest of the "${label}" pool)_`
        );
    }
    return lines.join('\n');
}

/** Format an entry as a full-inject bullet (heading + complete body + tags). */
function formatFull(entry: MemoryEntry): string {
    const lines: string[] = [`- **${entry.heading}** — ^${entry.id}`];
    if (entry.body) {
        // Indent the body so it reads as a sub-bullet under the heading.
        const indented = entry.body.split('\n').map((l) => `  ${l}`.trimEnd()).join('\n');
        lines.push(`  ${indented}`.trim());
    }
    if (entry.tags.length > 0) {
        lines.push(`  _tags: ${entry.tags.map((t) => `#${t}`).join(' ')}_`);
    }
    return lines.join('\n');
}

/** Format an entry as a hybrid-retrieval preview bullet (heading + first sentence). */
function formatPreview(entry: { id: string; heading: string; preview: string; tags: readonly string[] }): string {
    const tagsSuffix = entry.tags.length > 0 ? ` _[${entry.tags.map((t) => `#${t}`).join(', ')}]_` : '';
    if (!entry.preview) {
        return `- **${entry.heading}** — ^${entry.id}${tagsSuffix}`;
    }
    return `- **${entry.heading}** — ^${entry.id}${tagsSuffix}\n  ${entry.preview}`;
}
