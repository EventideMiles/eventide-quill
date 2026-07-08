import { type Editor } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { ChatMessage } from './provider';

/**
 * Pure utilities and small editor helpers extracted from `co-writer.ts` so the
 * monolith stays focused on session orchestration. None of these touch
 * `CoWriterSession` state; they're free functions the session (and future
 * extracted modules) import.
 */

/** Replace em dashes (—) with a comma+space for prose that shouldn't use them.
 *  Preserves content inside wiki links ([[...]]) so linked targets are not broken. */
export function sanitizeProse(text: string): string {
    return text.replace(/\[\[[^\]]*\]\]|\u2014/g, (match) => (match.startsWith('[[') ? match : ', '));
}

/**
 * Produce a short human-readable summary of a tool call's arguments for the
 * chat indicator ("Used manuscript_mentions("Sarah Connor")"). The raw
 * arguments are a JSON string from the model; this extracts the most
 * relevant field (varies by tool) and truncates for display.
 */
export function summarizeToolArgs(toolName: string, argumentsJson: string): string {
    try {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        // Build a summary from the most relevant field(s) for each tool type.
        const parts: string[] = [];
        const wiki = typeof args.wiki === 'string' ? args.wiki : '';
        const query = typeof args.query === 'string' ? args.query : '';
        const url = typeof args.url === 'string' ? args.url : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const path = typeof args.path === 'string' ? args.path : '';
        const type = typeof args.type === 'string' ? args.type : '';
        const title = typeof args.title === 'string' ? args.title : '';

        // fandom_lookup: show "wiki: query"; fandom_page: show "wiki: title"
        if (wiki && query) parts.push(`${wiki}: ${query}`);
        else if (wiki && title) parts.push(`${wiki}: ${title}`);
        else if (query) parts.push(query);
        else if (url) parts.push(url);
        else if (name) parts.push(name);
        else if (path) parts.push(path);
        else if (type) parts.push(type);
        else if (title) parts.push(title);

        if (parts.length === 0) return '';
        const summary = parts.join(' ');
        return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
    } catch {
        return '';
    }
}

/**
 * Parse stopping point instructions from a direction string.
 * Supports patterns like:
 *   - "stop at next period"
 *   - "stop after 2 paragraphs"
 *   - "stop at [marker]"
 *   - "continue until [condition]"
 * @param direction - The direction string from the user.
 * @returns A stopping point spec or null if none found.
 */
export function parseStoppingPoint(direction: string): { instruction: string; isExplicit: boolean } | null {
    const lower = direction.toLowerCase();

    // "stop at next period" or similar natural language (checked before the
    // generic "stop at [marker]" pattern so it takes precedence)
    const naturalStopMatch = lower.match(/stop\s+at\s+(?:the\s+)?(next\s+(?:period|sentence|paragraph|line))/);
    if (naturalStopMatch?.[1]) {
        return { instruction: `Stop at the next ${naturalStopMatch[1].replace('next ', '')}.`, isExplicit: true };
    }

    // "stop at [marker]" pattern
    const stopAtMatch = lower.match(/stop\s+at\s+(.+?)(?:\.\s*$|$)/);
    if (stopAtMatch?.[1]) {
        return { instruction: `Stop exactly at: ${stopAtMatch[1].trim()}`, isExplicit: true };
    }

    // "stop after N paragraphs" pattern
    const stopAfterMatch = lower.match(/stop\s+after\s+(\d+)\s+paragraphs?/);
    if (stopAfterMatch?.[1]) {
        return { instruction: `Write exactly ${stopAfterMatch[1]} paragraph(s), then stop.`, isExplicit: true };
    }

    // "continue until [condition]" pattern
    const continueUntilMatch = lower.match(/continue\s+until\s+(.+?)(?:\.\s*$|$)/);
    if (continueUntilMatch?.[1]) {
        return { instruction: `Continue writing until: ${continueUntilMatch[1].trim()}`, isExplicit: true };
    }

    return null;
}

/**
 * Check if generated content respects the stopping point.
 * Returns true if content appears to have stopped at the right place.
 */
export function respectsStoppingPoint(content: string, instruction: string): boolean {
    const lower = content.toLowerCase().trim();

    // Check for paragraph count constraint
    const paraMatch = instruction.match(/write\s+exactly\s+(\d+)\s+paragraph/);
    if (paraMatch?.[1]) {
        const expectedCount = parseInt(paraMatch[1], 10);
        const actualCount = (content.match(/\n\s*\n/g) ?? []).length + 1;
        return actualCount === expectedCount;
    }

    // Check for natural stop instructions produced by parseStoppingPoint
    // (e.g., "Stop at the next period."). Counts the relevant boundary in the
    // generated content; respected means no more than one boundary unit.
    const naturalMatch = instruction.match(/Stop at the next (period|sentence|paragraph|line)\b/);
    if (naturalMatch?.[1]) {
        switch (naturalMatch[1]) {
            case 'period':
                return (content.match(/\./g) ?? []).length <= 1;
            case 'sentence':
                return (content.match(/[.!?]/g) ?? []).length <= 1;
            case 'paragraph':
                return (content.match(/\n\s*\n/g) ?? []).length === 0;
            case 'line':
                return (content.match(/\n/g) ?? []).length === 0;
        }
    }

    // Check for "stop at" markers
    if (instruction.includes('Stop exactly at')) {
        // Content should end near the specified marker
        const marker = instruction.replace('Stop exactly at: ', '').trim();
        const lastPara = lower.split(/\n\s*\n/).pop() ?? lower;
        return lastPara.includes(marker) || lower.endsWith(marker);
    }

    // Check for "continue until" conditions
    if (instruction.includes('Continue writing until')) {
        // Content should contain or approach the condition
        const condition = instruction.replace('Continue writing until: ', '').trim();
        return lower.includes(condition);
    }

    return true; // Default: assume it's fine
}

/**
 * Truncate content to respect the stopping point.
 * Returns the truncated content.
 */
export function truncateToStoppingPoint(content: string, instruction: string): string {
    const lower = content.toLowerCase();

    // Handle paragraph count constraint
    const paraMatch = instruction.match(/write\s+exactly\s+(\d+)\s+paragraph/);
    if (paraMatch?.[1]) {
        const expectedCount = parseInt(paraMatch[1], 10);
        const paragraphs = content.split(/\n\s*\n/);
        const truncated = paragraphs.slice(0, expectedCount).join('\n\n');
        return truncated;
    }

    // Handle natural stop instructions produced by parseStoppingPoint
    // (e.g., "Stop at the next period."). Cut at the first matching boundary
    // and include the boundary character(s) where it makes sense.
    const naturalMatch = instruction.match(/Stop at the next (period|sentence|paragraph|line)\b/);
    if (naturalMatch?.[1]) {
        switch (naturalMatch[1]) {
            case 'period': {
                const idx = content.search(/\./);
                return idx >= 0 ? content.slice(0, idx + 1) : content;
            }
            case 'sentence': {
                const idx = content.search(/[.!?]/);
                return idx >= 0 ? content.slice(0, idx + 1) : content;
            }
            case 'paragraph': {
                const idx = content.search(/\n\s*\n/);
                return idx >= 0 ? content.slice(0, idx).replace(/\s+$/, '') : content;
            }
            case 'line': {
                const idx = content.search(/\n/);
                return idx >= 0 ? content.slice(0, idx) : content;
            }
        }
    }

    // Handle "stop at" markers
    if (instruction.includes('Stop exactly at')) {
        const marker = instruction.replace('Stop exactly at: ', '').trim().toLowerCase();
        const index = lower.indexOf(marker);
        if (index >= 0) {
            // Find the end of the sentence/paragraph containing the marker
            const afterMarker = content.slice(index);
            const sentenceEnd = afterMarker.search(/[.!?]/);
            if (sentenceEnd >= 0) {
                return content.slice(0, index + sentenceEnd + 1);
            }
            // If no sentence end found, truncate at marker
            return content.slice(0, index);
        }
    }

    // Handle "continue until" - truncate at the condition
    if (instruction.includes('Continue writing until')) {
        const condition = instruction.replace('Continue writing until: ', '').trim().toLowerCase();
        const index = lower.indexOf(condition);
        if (index >= 0) {
            const afterCondition = content.slice(index);
            const sentenceEnd = afterCondition.search(/[.!?]/);
            if (sentenceEnd >= 0) {
                return content.slice(0, index + sentenceEnd + 1);
            }
            return content.slice(0, index + condition.length);
        }
    }

    // Default: return content as-is
    return content;
}

/**
 * Build a vault context string from context items.
 * Formats each item as `--- filePath ---\nexcerpt` and joins with double newlines.
 * @param contextItems - The context items to format.
 * @returns A formatted vault context string, or empty string if no items have excerpts.
 */
export function buildVaultContext(contextItems: Array<{ filePath: string; excerpt?: string }>): string {
    const contextParts: string[] = [];
    for (const item of contextItems) {
        if (item.excerpt) {
            contextParts.push(`--- ${item.filePath} ---`, item.excerpt);
        }
    }
    return contextParts.join('\n\n');
}

/** De-duplicate and concatenate persistent context paths with per-message @-mention paths. */
export function mergeContextPaths(persistent: string[], mentionPaths?: string[]): string[] {
    if (!mentionPaths || mentionPaths.length === 0) return persistent;
    const seen = new Set(persistent);
    const out = [...persistent];
    for (const p of mentionPaths) {
        if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

/**
 * If the conversation was saved mid-tool-round — the last message is an
 * assistant turn that emitted `tool_calls` with no following `tool` results —
 * append a synthetic "result unavailable" tool message per call so the provider
 * isn't fed a malformed history on resume (OpenAI/Ollama reject an assistant
 * tool_calls turn that isn't immediately followed by matching tool results).
 * Returns the array unchanged when the tail is well-formed.
 */
export function stubDanglingToolCalls(messages: ChatMessage[]): ChatMessage[] {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.toolCalls && last.toolCalls.length > 0) {
        const stubs: ChatMessage[] = last.toolCalls.map((c) => ({
            role: 'tool',
            content: 'Session was saved mid-tool-round; tool result unavailable.',
            toolCallId: c.id,
            name: c.name,
            quillAnchorId: last.quillAnchorId
        }));
        return [...messages, ...stubs];
    }
    return messages;
}

/**
 * The cursor's document offset, read from the CodeMirror 6 selection state
 * directly. Obsidian's `Editor.getCursor()` can report `{0,0}` for a markdown
 * view that isn't the active leaf — e.g. the writer clicked into the document
 * to place the cursor, then moved focus to the sidebar to send — which made
 * the "cursor at position 0" fallback fire incorrectly and jump the cursor to
 * the end. The underlying CM6 selection persists in editor state regardless of
 * focus, so this is the reliable cursor position for an inactive document.
 * Falls back to `getCursor()` only when the CM6 view isn't accessible
 * (defensive — it's always present in Obsidian's markdown editor).
 */
export function editorCursorOffset(editor: Editor): number {
    const cm = (editor as unknown as { cm?: EditorView } | null)?.cm;
    if (cm) return cm.state.selection.main.head;
    return editor.posToOffset(editor.getCursor());
}

/**
 * Prose to send to the model as context, measured from the document start to
 * the cursor. Falls back to the document's tail (pretending the cursor is at
 * the end) ONLY when the cursor sits at position 0 — the document is open but
 * the writer hasn't placed the cursor (never clicked into the prose).
 *
 * Any non-zero cursor position is treated as deliberate (the writer clicked, or
 * Obsidian restored the cursor where they left off) and respected as-is, so
 * asking for options earlier in the manuscript still works — place the cursor
 * at the point you want to continue from. Reads the cursor via
 * {@link editorCursorOffset} so a non-active document still reports its real
 * cursor. Capped to the last `tail` characters. Mirrors the options-generation
 * path's "move cursor to end" fallback.
 */
export function proseBeforeCursorOrDoc(editor: Editor, tail: number): string {
    const full = editor.getValue();
    const beforeCursor = full.slice(0, editorCursorOffset(editor));
    return (beforeCursor || full).slice(-tail);
}

/**
 * Move the cursor to the end of the document ONLY when it sits at position 0
 * — the document is open but the writer hasn't placed the cursor, so an
 * upcoming INSERTION should land at the end of the written prose (the
 * "continue this chapter" intent). Any non-zero cursor position is respected
 * as the writer's intended insertion point, so a mid-manuscript cursor
 * continues from there. Returns true when the cursor was moved (so callers can
 * scroll to the new position / branch on it). Reads the cursor via
 * {@link editorCursorOffset} so a non-active document still reports its real
 * cursor. Mirrors the generateOptions/generateDirect initialize branches.
 */
export function moveCursorToEndIfEarly(editor: Editor): boolean {
    const fullText = editor.getValue();
    const cursorOffset = editorCursorOffset(editor);
    if (cursorOffset === 0 && fullText.length > 0) {
        editor.setCursor(editor.offsetToPos(fullText.length));
        return true;
    }
    return false;
}
