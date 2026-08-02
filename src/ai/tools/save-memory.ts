import { Notice } from 'obsidian';
import type { Tool, ToolContext } from './tool';
import { nextBlockId, type MemoryEntry } from '../../core/memories/memory-file';
import { GLOBAL_MEMORY_SCOPE } from '../../core/memories/memory-scope';
import { readMemoryFile, resolveScopeArg, writeMemoryFile } from '../../core/memories/memory-store';

/**
 * The `save_memory` tool — persists a fact the model has learned about the
 * story, the writer's preferences, or the editorial process. Memories live
 * as markdown in `<memoriesFolder>/<scope>.memories.md`; the writer can
 * read, edit, or delete them at any time.
 *
 * BEHAVIOR
 *
 * - New memory (no heading match): appended with the next available block
 *   ID (`^quill-mem-NNN`). The file is created on first write.
 * - Existing memory (heading matches one already in the file): updated in
 *   place — body replaced, tags re-parsed from the new body. The block ID
 *   is preserved across the update (stable handle for future deletes).
 * - Untagged writer-added sections in the file get a block ID minted on
 *   read (re-tokenize pass), so the file stays canonical.
 *
 * APPROVAL FLOW
 *
 * When `memoriesAutoSave` is on (the default), the save lands in the vault
 * immediately and a Notice confirms ("Saved memory: '<heading>'"). When
 * off, the save stages to the review queue — but Phase 8 wires that path
 * in. For now, both modes write directly; the toggle's effect (staging
 * to the review queue) is a Phase 8 concern.
 *
 * SCOPE
 *
 * - `'auto'` (default): the active manuscript's pool, or global when no
 *   manuscript is in context.
 * - `'manuscript'`: explicitly the active manuscript (may fall through to
 *   global — same as `'auto'`).
 * - `'global'`: the cross-manuscript pool, for series-wide rules.
 *
 * See `.planning/pr-memories.md` § Memory discipline for the system-prompt
 * guidance on WHEN to call this tool.
 */
export const saveMemoryTool: Tool = {
    id: 'save_memory',
    description:
        'Persist a fact you have learned about this story or the writer\'s ' +
        'preferences — a durable piece of context future sessions will ' +
        'benefit from. The memory is saved to a markdown file in the vault ' +
        'the writer can read and edit. See the "Memory discipline" section ' +
        'of your system prompt for guidance on WHEN to save (and when not ' +
        'to). Call this when the writer corrects an assumption you made, ' +
        'states a preference, clarifies the intent behind a choice that ' +
        'looks like a mistake, or surfaces a worldbuilding fact not in the ' +
        'lorebook. Do NOT call it for transient discussion, restatements ' +
        'of lore, or anything the writer is unlikely to want remembered.',
    parameters: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description:
                    'The memory prose. 1-3 sentences of plain explanation — ' +
                    'what you learned and (briefly) the context. Markdown is ' +
                    'fine for emphasis but most memories are plain prose.'
            },
            heading: {
                type: 'string',
                description:
                    'A short title (3-8 words) for the memory. Auto-generated ' +
                    'as "Memory N" if omitted; the writer can rename later. ' +
                    'When a memory with a matching heading already exists in ' +
                    'the target scope, its body is REPLACED with `content` ' +
                    '(use this to update a prior memory rather than creating ' +
                    'a duplicate).'
            },
            scope: {
                type: 'string',
                enum: ['auto', 'manuscript', 'global'],
                description:
                    'Where to save. `auto` (default) picks the active ' +
                    'manuscript\'s pool when there is one, else global. ' +
                    '`manuscript` is the same as `auto`. `global` is for ' +
                    'cross-manuscript facts (series-wide tone, shared ' +
                    'worldbuilding) that should apply to every story in ' +
                    'this vault. When in doubt, use `auto`.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Optional lowercase tags (without the leading #) for ' +
                    'later filtering. The tag name should be a single word ' +
                    'or hyphenated phrase (e.g., "pacing", "voice", ' +
                    '"worldbuilding-magic"). Tags are also parsed from ' +
                    'inline #hashtags in `content` if you prefer.'
            }
        },
        required: ['content']
    },
    maxResultTokens: 200,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content) {
            return 'Error: "content" is required.';
        }
        const scopeArg = typeof args.scope === 'string' ? args.scope : 'auto';
        const { plugin } = ctx;
        if (!plugin.settings.memoriesEnabled) {
            return 'Error: memories are disabled in settings. The writer can enable them in the settings tab.';
        }

        const { keys, label } = resolveScopeArg(plugin, scopeArg);
        const scopeKey = keys[0]!;
        const result = await readMemoryFile(plugin, scopeKey);

        // Resolve the heading: explicit > auto-generated. Auto-gen uses the
        // next ID as the suffix so the title and ID stay loosely aligned
        // even when the writer doesn't override.
        const headingRaw = typeof args.heading === 'string' ? args.heading.trim() : '';
        const explicitTags = Array.isArray(args.tags)
            ? (args.tags.filter((t) => typeof t === 'string' && t.trim()) as string[]).map((t) => t.trim())
            : [];

        // Update-or-append: match an existing entry by heading (case-insensitive
        // trim-equal). On match, replace body and re-derive tags. On miss, append.
        const existingIdx = headingRaw
            ? result.file.entries.findIndex(
                  (e) => e.heading.trim().toLowerCase() === headingRaw.toLowerCase()
              )
            : -1;

        let mintedId: string;
        let savedHeading: string;
        let newEntries: MemoryEntry[];

        // Build the body with explicit tags appended (so the writer can see
        // and edit them in the file even if they weren't inline in content).
        const bodyWithTags = explicitTags.length > 0
            ? `${content}\n\n${explicitTags.map((t) => `#${t}`).join(' ')}`
            : content;

        if (existingIdx >= 0) {
            const existing = result.file.entries[existingIdx]!;
            mintedId = existing.id || nextBlockId(result.file.entries);
            savedHeading = existing.heading; // preserve existing (preserves case)
            newEntries = result.file.entries.map((e, i) =>
                i === existingIdx ? { ...e, id: mintedId, body: bodyWithTags } : e
            );
        } else {
            mintedId = nextBlockId(result.file.entries);
            savedHeading = headingRaw || `Memory ${mintedId.replace(/^quill-mem-/, '')}`;
            const newEntry: MemoryEntry = {
                id: mintedId,
                heading: savedHeading,
                body: bodyWithTags,
                tags: [] // tags are re-parsed from body on read; store empty for round-trip
            };
            newEntries = [...result.file.entries, newEntry];
        }

        await writeMemoryFile(plugin, scopeKey, {
            title: result.file.title,
            intro: result.file.intro,
            entries: newEntries
        });

        // Phase 4: always confirm with a Notice. Phase 8 will branch on
        // memoriesAutoSave (off → stage to review queue, no Notice).
        const scopeNote = scopeKey === GLOBAL_MEMORY_SCOPE ? 'global' : label;
        new Notice(`Quill: saved memory — "${savedHeading}" (${scopeNote})`);

        const verb = existingIdx >= 0 ? 'Updated' : 'Saved';
        return (
            `${verb} memory "${savedHeading}" (id: ${mintedId}, scope: ${scopeNote}). ` +
            `The writer can read and edit it in the Memories sub-tab under Lorebook.`
        );
    }
};
