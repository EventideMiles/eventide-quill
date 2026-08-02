/**
 * Memory storage layer — parse, serialize, and manage the contents of a
 * `.memories.md` file. Pure logic: no vault access, no plugin coupling.
 *
 * A memory file is a markdown file with:
 *   - An optional H1 title (preserved on round-trip)
 *   - An optional intro paragraph between the H1 and the first `## ` (preserved)
 *   - One or more `## ` sections, each a single memory
 *   - Each section typically ends with a `^quill-mem-NNN` Obsidian block ID
 *     on its own line — the stable handle for delete/update tool calls.
 *
 * Sections without a `^quill-mem-*` ID (e.g. writer-added via the markdown
 * editor) are accepted on parse; {@link assignMissingIds} mints one for each
 * and signals that the file should be written back.
 *
 * Round-trip: {@link parseMemoryFile} → {@link serializeMemoryFile} →
 * {@link parseMemoryFile} yields identical entries. The serializer is
 * canonical (standard format) even when the parser is lenient (accepts
 * arbitrary heading depths, missing IDs, code fences, etc.).
 *
 * Code-fence aware: `^` and `#` inside ```` ``` ```` or `~~~` blocks are
 * not parsed as block IDs or tags.
 */

/** Prefix for all Quill-managed memory block IDs. */
export const MEMORY_BLOCK_ID_PREFIX = 'quill-mem-';

/** File suffix for memory files. Combined with a scope key for the filename. */
export const MEMORY_FILE_SUFFIX = '.memories.md';

/** Scope key reserved for the global (cross-manuscript) memory pool. */
export const GLOBAL_MEMORY_SCOPE = '_global';

/** Match a `^quill-mem-NNN` block ID on its own line (parser side). */
const BLOCK_ID_LINE_PATTERN = new RegExp(`^\\^${MEMORY_BLOCK_ID_PREFIX}(\\d+)\\s*$`);

/**
 * Match the numeric tail of a stored block ID (no leading `^` — that lives
 * on the file line only, not in {@link MemoryEntry.id}). Used by passes
 * that scan the parsed entries' `id` field.
 */
const BLOCK_ID_STORED_PATTERN = new RegExp(`${MEMORY_BLOCK_ID_PREFIX}(\\d+)$`);

/**
 * Match an inline `#tag` — requires whitespace, start-of-line, or `(` as
 * the char before the `#` (so parenthetical tags like `## Topic (#pacing)`
 * match), and a lowercase letter as the first char (so hex colors like
 * `#FF0000`, numeric mentions like `#1st`, and ALL-CAPS tokens don't
 * false-positive). Markdown-link anchors (`[text](#section)`) are stripped
 * before this pattern runs, so the `(` allowance doesn't let them leak.
 *
 * Non-capturing outer group so the tag name stays at capture index 1.
 */
const TAG_PATTERN = /(?:^|[\s(])#([a-z][\w-]*)/g;

/** Match a markdown link `[text](target)` so we can strip it before tag extraction. */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;

/**
 * A single memory parsed from a `## ` section of a `.memories.md` file.
 * Immutable; transforms return new entries.
 */
export interface MemoryEntry {
    /** The `quill-mem-NNN` block ID. Empty when the section has none yet. */
    readonly id: string;
    /** Heading text without the leading `## ` (the memory's title). */
    readonly heading: string;
    /** Full body text (everything between this heading and the next), with the
     *  trailing block-ID line stripped. */
    readonly body: string;
    /** Inline `#tags` parsed from the body. Empty when none. */
    readonly tags: readonly string[];
}

/** A compact index row used for the auto-injected context preview. */
export interface MemoryIndexEntry {
    /** Block ID, matching the entry's `id`. */
    readonly id: string;
    /** Memory heading (title). */
    readonly heading: string;
    /** First sentence (or first ~120 chars) of the body — the preview. */
    readonly preview: string;
    /** Tags parsed from the body. */
    readonly tags: readonly string[];
}

/** Parsed structure of a `.memories.md` file. */
export interface MemoryFile {
    /** H1 title line (without the `# `). Empty when the file had no H1. */
    readonly title: string;
    /** Intro paragraph(s) between the H1 and the first `## ` section. */
    readonly intro: string;
    /** Parsed memory sections, in file order. */
    readonly entries: readonly MemoryEntry[];
}

/** Result of an ID-assignment pass over a file's entries. */
export interface AssignIdsResult {
    /** True when at least one entry received a newly-minted ID. */
    readonly changed: boolean;
    /** New entry list (same length, with `id` filled where it was empty). */
    readonly entries: readonly MemoryEntry[];
}

/**
 * Parse a `.memories.md` file's content into structured entries. Lenient
 * about format: accepts arbitrary heading depths for non-section content,
 * missing block IDs, code fences (which are preserved verbatim in bodies
 * but not parsed for IDs/tags), and H1/intro in any order before the first
 * `## ` section.
 *
 * Returns an empty `entries` array (with whatever `title`/`intro` were
 * recoverable) when the file has no `## ` sections.
 */
export function parseMemoryFile(content: string): MemoryFile {
    const lines = content.split('\n');
    const entries: MemoryEntry[] = [];
    let title = '';
    const introLines: string[] = [];

    let inCodeFence = false;
    let fenceMarker = '';
    let currentHeading = '';
    let currentId = '';
    const currentBodyLines: string[] = [];

    /** Push the in-progress section (if any) onto `entries` and reset accumulators. */
    const finalizeSection = (): void => {
        if (!currentHeading) return;
        const rawBody = currentBodyLines.join('\n').trim();
        // Tags can appear in the heading (e.g., "## Topic (#pacing)") or the
        // body. Strip code fences before tag extraction so `#tokens` inside
        // a code block don't false-positive.
        const tagSource = stripCodeFences(`${currentHeading}\n${rawBody}`);
        entries.push({
            id: currentId,
            heading: currentHeading,
            body: rawBody,
            tags: parseTags(tagSource)
        });
        currentHeading = '';
        currentId = '';
        currentBodyLines.length = 0;
    };

    for (const line of lines) {
        // Code-fence tracking. A line starting with ``` or ~~~ toggles the
        // fence state; we pair open/close by marker so nested different
        // markers don't fool us (rare in practice but cheap to handle).
        const fenceOpenMatch = line.match(/^(`{3,}|~{3,})/);
        if (fenceOpenMatch) {
            const marker = fenceOpenMatch[1]?.charAt(0);
            if (!inCodeFence) {
                inCodeFence = true;
                fenceMarker = marker ?? '';
                if (currentHeading) currentBodyLines.push(line);
                continue;
            }
            if (inCodeFence && marker && marker === fenceMarker) {
                inCodeFence = false;
                fenceMarker = '';
                if (currentHeading) currentBodyLines.push(line);
                continue;
            }
        }

        if (inCodeFence) {
            if (currentHeading) currentBodyLines.push(line);
            continue;
        }

        // Section heading.
        if (line.startsWith('## ')) {
            finalizeSection();
            currentHeading = line.slice(3).trim();
            continue;
        }

        // Inside a section: collect body or capture the block-ID line.
        if (currentHeading) {
            const idMatch = line.match(BLOCK_ID_LINE_PATTERN);
            if (idMatch) {
                currentId = `${MEMORY_BLOCK_ID_PREFIX}${idMatch[1]}`;
            } else {
                currentBodyLines.push(line);
            }
            continue;
        }

        // Before any section: capture H1 title, then intro text. Skip YAML
        // frontmatter delimiters if present (the loader strips these, but
        // be defensive — `---` outside a section with no H1 yet is ambiguous).
        if (line.startsWith('# ') && !title) {
            title = line.slice(2).trim();
            continue;
        }
        if (line.trim() && !line.startsWith('---')) {
            introLines.push(line);
        }
    }
    finalizeSection();

    return {
        title,
        intro: introLines.join('\n').trim(),
        entries
    };
}

/**
 * Serialize a {@link MemoryFile} back to canonical markdown. The output
 * always uses the standard format (H1 title, blank line, intro, blank line,
 * then `## heading` / blank / body / blank / `^id` / blank per section)
 * even when the parser accepted a non-canonical input — round-trip through
 * this function normalizes formatting.
 *
 * Section bodies are preserved verbatim (including any code fences). Block
 * IDs are emitted on their own line at the end of each section. Entries
 * with empty `id` are still emitted (without a `^id` line) so the writer
 * can see them in the file; {@link assignMissingIds} should run first if
 * canonical output is desired.
 */
export function serializeMemoryFile(file: MemoryFile, scopeLabel?: string): string {
    const title = file.title || `Memories — ${scopeLabel ?? 'Scope'}`;
    const intro = file.intro || defaultIntro();
    const lines: string[] = [`# ${title}`, '', intro, ''];

    for (const entry of file.entries) {
        lines.push(`## ${entry.heading}`, '');
        const body = entry.body.trim();
        if (body) {
            lines.push(body, '');
        }
        if (entry.id) {
            lines.push(`^${entry.id}`, '');
        }
    }

    // Collapse 3+ consecutive newlines to 2 (sections separated by one blank
    // line). Trim leading/trailing whitespace and ensure a single trailing newline.
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Compute the next block ID for the given entries. Finds the max existing
 * `quill-mem-N` N value and returns N+1, zero-padded to 3 digits for stable
 * lexical sort (`quill-mem-001` … `quill-mem-999`, then `quill-mem-1000`).
 *
 * Returns `quill-mem-001` when no entries have IDs yet (fresh file).
 */
export function nextBlockId(entries: readonly MemoryEntry[]): string {
    let maxN = 0;
    for (const entry of entries) {
        const match = entry.id.match(BLOCK_ID_STORED_PATTERN);
        if (match) {
            const n = parseInt(match[1]!, 10);
            if (n > maxN) maxN = n;
        }
    }
    return `${MEMORY_BLOCK_ID_PREFIX}${String(maxN + 1).padStart(3, '0')}`;
}

/**
 * Mint block IDs for any entries whose `id` is empty. Walks the list once,
 * assigns sequential IDs starting from `max(existing) + 1`. Returns the new
 * entry list and a `changed` flag indicating whether any IDs were minted
 * (caller writes the file back when `changed === true`).
 *
 * Pure: input entries are not mutated; new array returned when `changed`.
 */
export function assignMissingIds(entries: readonly MemoryEntry[]): AssignIdsResult {
    const hasMissing = entries.some((e) => !e.id);
    if (!hasMissing) {
        return { changed: false, entries };
    }

    let nextN = 0;
    for (const entry of entries) {
        const match = entry.id.match(BLOCK_ID_STORED_PATTERN);
        if (match) {
            const n = parseInt(match[1]!, 10);
            if (n > nextN) nextN = n;
        }
    }

    const result = entries.map((entry) => {
        if (entry.id) return entry;
        nextN += 1;
        return { ...entry, id: `${MEMORY_BLOCK_ID_PREFIX}${String(nextN).padStart(3, '0')}` };
    });

    return { changed: true, entries: result };
}

/**
 * Build a compact index from full entries, suitable for auto-injection into
 * the model's context. Each row carries the heading + a one-sentence preview
 * + tags. The list is capped at `cap` entries (default behavior: take the
 * first N in file order; future enhancement could rank by recency).
 *
 * Empty bodies produce an empty preview string.
 */
export function buildIndex(entries: readonly MemoryEntry[], cap: number): MemoryIndexEntry[] {
    return entries.slice(0, Math.max(0, cap)).map((entry) => ({
        id: entry.id,
        heading: entry.heading,
        preview: firstSentence(entry.body, 120),
        tags: entry.tags
    }));
}

/**
 * Extract inline `#tags` from text. Public so tools and the UI can parse
 * tags from arbitrary strings (e.g., a save_memory `tags` argument the
 * model provides as `['pacing']` doesn't need re-parsing, but the body
 * the model writes may contain `#pacing` which should be normalized).
 *
 * Tags must be preceded by whitespace, start-of-line, or `(` (so they
 * can appear in markdown like "this is intentional (#pacing).") and
 * must start with a letter.
 */
export function parseTags(text: string): string[] {
    // Strip markdown links so anchors inside them (e.g. `[link](#section)`)
    // don't false-positive as tags. The link's display text is preserved so
    // any `#tags` inside the display text still match.
    const cleaned = text.replace(MARKDOWN_LINK_PATTERN, '$1');
    const tags = new Set<string>();
    for (const match of cleaned.matchAll(TAG_PATTERN)) {
        tags.add(match[1]!);
    }
    return [...tags];
}

/** Default intro paragraph for a fresh memory file. */
function defaultIntro(): string {
    return (
        'Reference context the AI has learned about this scope. Edit ' +
        'freely; sections without a `^quill-mem-*` ID get one assigned ' +
        'automatically on next read.'
    );
}

/**
 * Strip fenced code blocks (```...``` or ~~~...~~~) from text, replacing
 * each with a single newline. Used before tag extraction so `#tokens`
 * inside code blocks don't false-positive as tags. Does not preserve the
 * content of the stripped blocks.
 */
function stripCodeFences(text: string): string {
    return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[^\n]*$/gm, '\n');
}

/**
 * Extract the first sentence from prose, capped at `maxChars`. A "sentence"
 * ends at the first `.`, `!`, or `?` followed by whitespace or end-of-string,
 * or at the first newline. Falls back to the first newline-delimited line
 * when no terminal punctuation is found. Appends an ellipsis when truncated.
 */
function firstSentence(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const sentenceMatch = trimmed.match(/^[^.!?\n]*[.!?](?=\s|$)/);
    const firstLine = trimmed.split('\n')[0] ?? '';
    let result = sentenceMatch?.[0]?.trim() || firstLine.trim();
    if (result.length > maxChars) {
        result = `${result.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    }
    return result;
}
