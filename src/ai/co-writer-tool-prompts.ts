import type { ChatMessage } from './provider';
import { fandomReachability } from './tools/fandom-cache';
import type EventideQuillPlugin from '../main';

/**
 * Tool-discipline reminder, shared by every prompt block that advertises
 * tools. Local models (and some cloud models with weak tool templates)
 * occasionally "narrate" a tool invocation as plain text — e.g.
 * `edit_note(old_text: "...", new_text: "...")` — instead of emitting it via
 * the structured `tool_calls` field. A text-form call never executes and the
 * writer sees raw syntax. Stating the mechanism explicitly here prevents the
 * common case; {@link detectTextToolCall} catches the rest at runtime.
 */
const TOOL_DISCIPLINE =
    'Invoke tools ONLY through the structured tool-calling interface (the tool_calls field) — never write a tool invocation as text like `edit_note(...)` or `propose_entry(...)`. A call written as text will NOT execute; the writer sees raw syntax and nothing happens.';

/**
 * Build a system message telling the model which network research tools are
 * available, when enabled. Returns null when there's nothing to advertise.
 *
 * The advertised set MUST mirror `createToolRegistry()` (`src/ai/tools/index.ts`):
 * the prompt never lists tools the model can't actually call, and never hides
 * ones it can. The Fandom reachability decision is the single source of truth
 * shared with `buildNetworkToolsMessage`, so prompt and registration stay in
 * lockstep.
 */
export function buildNetworkToolsMessage(plugin: EventideQuillPlugin): ChatMessage | null {
    // Mirror createToolRegistry(): no tools at all when tools are disabled, so
    // the prompt never advertises network tools the model can't actually call.
    if (!plugin.settings.coWriterToolsEnabled) return null;

    const networkOn = plugin.settings.lorebookNetworkTools;
    const reachability = fandomReachability(plugin);
    if (!networkOn && reachability === 'none') return null;

    const wikis = plugin.settings.lorebookFandomWikis;
    const allowAll = plugin.settings.lorebookFandomAllowAllWikis;
    const lang = plugin.settings.lorebookWikipediaLang;

    if (networkOn) {
        const lines = [
            'You have network tools available — USE THEM PROACTIVELY when the topic',
            'involves canon, history, science, places, or real-world references:'
        ];
        // Mirror createToolRegistry(): advertise Fandom when reachable (allowlist
        // non-empty OR the "allow any wiki" danger toggle is on). When allow-all
        // is on with an empty allowlist, the model may query any Fandom wiki.
        if (reachability !== 'none') {
            const wikiDesc = allowAll ? 'any wiki' : wikis.join(', ');
            lines.push(
                `- fandom_lookup / fandom_page: search Fandom (${wikiDesc}); use fandom_page with an exact title to get content.`
            );
            // fandom_image is registered only when image tools are also on, since it
            // returns an image (routed through the vision layer).
            if (plugin.settings.lorebookImageTools) {
                lines.push(
                    `- fandom_image: fetch the lead image for a Fandom topic (${wikiDesc}) and list the page's other images with their captions; pass a filename via the "image" param to fetch a specific gallery image. Use it to see character appearance or artwork.`
                );
            }
        }
        lines.push(
            `- wikipedia_lookup / wikipedia_page: search Wikipedia (${lang}); use wikipedia_page with an exact title to get content.`,
            '- fetch_url: fetch any web page and return its text.',
            '',
            'Workflow: use the *_lookup tool to search, then use the *_page tool',
            'with the exact title from the results to retrieve the full extract.',
            '',
            'Look things up freely — when the writer mentions a topic that a wiki or',
            'encyclopedia would know about, go straight to the tool. You may proceed',
            'without asking. Results count toward context — be judicious with very',
            'large pages.',
            '',
            TOOL_DISCIPLINE
        );
        // wikipedia_image is registered only when image tools are also on, since
        // it returns an image (routed through the vision layer). Same cross-toggle
        // gate as fandom_image above.
        if (plugin.settings.lorebookImageTools) {
            lines.push(
                `- wikipedia_image: fetch the lead image for a Wikipedia topic (${lang}) — most often a portrait for biographies, cover art for works, or a photograph for places. Use it to see what a person, place, or object looks like.`
            );
        }
        return { role: 'system', content: lines.join('\n') };
    }

    // Cache-only (Stage 3): network tools off, but a populated Fandom cache
    // answers for an allowlisted wiki. Tell the model the shape — hits come
    // from a possibly-stale local cache, and misses do NOT fall through live.
    const wikiDesc = allowAll ? 'any cached wiki' : wikis.join(', ');
    const lines = [
        'Fandom is available from the LOCAL CACHE ONLY (network tools are off):',
        `- fandom_lookup / fandom_page: answer from the cached Fandom content (${wikiDesc}). Hits return instantly with no network request; misses return "not cached" and do NOT fall through to a live fetch while network tools are off.`
    ];
    if (plugin.settings.lorebookImageTools) {
        lines.push(
            `- fandom_image: fetch a cached Fandom image by exact filename (${wikiDesc}); the query path needs the network and is unavailable, so pass a filename from a prior result.`
        );
    }
    lines.push(
        '',
        'Cached content may be stale (it reflects the last sync). Re-enable network',
        'tools in settings to fetch fresh pages or search live.',
        '',
        TOOL_DISCIPLINE
    );
    return { role: 'system', content: lines.join('\n') };
}

/**
 * Build a system message telling the model which internal vault tools are
 * available, when enabled. Returns null when tools are disabled. Discuss and
 * coach modes inject this so the model proactively grounds its feedback in the
 * manuscript and vault rather than relying only on the open excerpt. Not used
 * by the lorebook coach, which already covers these tools in its own prompt.
 */
export function buildInternalToolsMessage(plugin: EventideQuillPlugin): ChatMessage | null {
    // Mirror createToolRegistry(): no tools at all when tools are disabled, so
    // the prompt never advertises tools the model can't actually call.
    if (!plugin.settings.coWriterToolsEnabled) return null;
    return {
        role: 'system',
        content: [
            'You have internal vault tools to ground your feedback in the manuscript and notes:',
            '- manuscript_mentions: where a character, place, or plot thread appears in the active manuscript (pass empty to list every entity the extractor found).',
            "- vault_lookup: read a note's full text by path or name (frontmatter stripped). Reserve it for a SPECIFIC note you need in full.",
            '- grep_notes: search for text across vault files to find where something is mentioned.',
            "- lore_siblings: list other lore entries near a given one. Shows each entry's image labels (when present) as `(images: Default form (2), Alternate form)` — the count suffix (N) means N images share that label.",
            '- get_lore_image: when a lore entry has images (you saw them via lore_siblings OR you saw ![[file.png]] embeds in a vault_lookup result), call this to actually SEE them. By default returns EVERY image attached to the entry — this is the recommended call so multi-image galleries are fully visible. Narrow with `label` (images under one subheading) and/or `index` (1-based position within the label-filtered set, useful when the count suffix shows multiple images under one label). Particularly important for character appearance, locations, maps, and any visual reference — do not describe art from filename or context alone when you can fetch the pixels.',
            'To learn the cast and world (characters, locations, plot threads), reach for manuscript_mentions — it lists the entities directly, saving a vault_lookup. If it returns "no entities," the dashboard has not been scanned: call refresh_dashboard (with a manuscript file path) and retry.',
            'Reach for these when a question of fact about the manuscript or vault would sharpen your answer. Tool results stay in context — read judiciously.',
            '',
            TOOL_DISCIPLINE
        ].join('\n')
    };
}
