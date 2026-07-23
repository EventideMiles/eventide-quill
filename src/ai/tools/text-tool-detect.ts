import type { ChatMessage } from '../provider';

/**
 * Maximum number of times a single co-writer turn will nudge the model to
 * re-issue a text-form tool call as a proper structured call. Bounds the
 * retry loop so a model that keeps narrating tool calls can't spin forever
 * (the round cap is a separate backstop). One nudge is usually enough for a
 * capable-but-under-instructed model; a second rarely helps.
 */
export const MAX_TEXT_TOOL_NUDGES = 1;

/**
 * A leaked tool call detected in the model's plain-text response — the model
 * wrote `tool_name(...)` as content instead of emitting it via the structured
 * `tool_calls` API field, so nothing executed.
 */
export interface TextToolLeak {
    /** The registered tool id the model tried to invoke (e.g. `edit_note`). */
    name: string;
    /** A short snippet of the leaked text, for the nudge message. */
    snippet: string;
}

/**
 * Detect a tool invocation that the model wrote as plain text rather than
 * emitting through the structured tool-calling interface.
 *
 * Models (especially local ones with weak tool templates) sometimes narrate a
 * call — e.g. `edit_note(old_text: "...", new_text: "...")` — as assistant
 * content. Without intervention this renders as raw syntax in the chat and NO
 * tool executes. This scanner looks for a known tool id immediately followed
 * by `(` (with optional whitespace), at a word boundary, so it catches the
 * common forms (bare, fenced in a code block, prefixed by markdown) while
 * avoiding false positives on ordinary prose.
 *
 * Returns the FIRST (earliest-position) leak found, or null.
 *
 * @param response  The model's accumulated text response for the round.
 * @param toolNames The registered tool ids the model had access to this round.
 */
export function detectTextToolCall(response: string, toolNames: string[]): TextToolLeak | null {
    const text = response.trim();
    if (!text || toolNames.length === 0) return null;

    let best: { name: string; at: number } | null = null;

    for (const name of toolNames) {
        let from = 0;
        for (;;) {
            const idx = text.indexOf(name, from);
            if (idx === -1) break;

            const after = idx + name.length;
            // Must be followed by optional whitespace then '(' to look like a call.
            const opensCall = /^\s*\(/.test(text.slice(after, after + 4));
            // Must sit at a word boundary so we don't match a substring of a
            // larger word (none of the tool ids are substrings of prose words,
            // but be safe).
            const boundary = idx === 0 || /[^\w]/.test(text[idx - 1] ?? '');

            if (opensCall && boundary) {
                if (!best || idx < best.at) best = { name, at: idx };
                break; // first occurrence of this tool is enough
            }
            from = idx + 1;
        }
    }

    if (!best) return null;
    const snippet = text
        .slice(best.at, Math.min(text.length, best.at + 100))
        .replace(/\s+/g, ' ')
        .trim();
    return { name: best.name, snippet };
}

// ── Intent narration detection ──────────────────────────────────────────
//
// A second failure mode: the model expresses clear COMMITMENT to making edits
// ("I'll get started on those edits now", "I'm going to fix that paragraph")
// but then ends its turn WITHOUT calling any tools. The writer is left waiting
// for edits that never come. Unlike text-tool-syntax leaks (above), the model
// isn't writing tool syntax as text — it's narrating its plan in natural
// language and then stopping.
//
// The detection looks for COMMITMENT phrases (I'll, I'm going to, let me)
// paired with action verbs (edit, fix, change, start, work on). Suggestion
// phrases (I could, would you like, shall I) are deliberately excluded so
// the nudge doesn't fire when the model is legitimately discussing options.

const INTENT_PATTERNS: RegExp[] = [
    /\bI'?ll\s+(start|get started|begin|work on|edit|fix|change|update|process|make)\b/i,
    /\bI'?m going to\s+(start|begin|edit|fix|change|update|work on|process)\b/i,
    /\blet me\s+(edit|fix|change|update|start|work on|process)\b/i,
    /\bI will\s+(start|edit|fix|change|update|work on)\b/i,
    /\bstarting (on|with|those|these|the)\b/i,
    // Permission-seeking stall: the model asks if it should propose an edit
    // instead of just proposing it. The review card IS the approval gate —
    // there's no need for an extra permission step.
    /\bwould you like me to\s+(propose|edit|make|fix|change|update|work on)\b/i,
    /\bshall I\s+(propose|edit|make|fix|change|update)\b/i
];

export interface IntentNarration {
    snippet: string;
}

export function detectIntentNarration(response: string): IntentNarration | null {
    const text = response.trim();
    if (!text) return null;
    for (const pattern of INTENT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            const start = match.index ?? 0;
            const snippet = text
                .slice(start, Math.min(text.length, start + 120))
                .replace(/\s+/g, ' ')
                .trim();
            return { snippet };
        }
    }
    return null;
}

/**
 * Build the follow-up message that nudges the model to re-issue a leaked tool
 * call through the proper structured interface. Pushed into the API message
 * array (NOT the display chatHistory) so the writer simply sees the model's
 * corrected second turn rather than internal plumbing.
 *
 * Kept as `role: 'user'` (not `system`) so it lands in-order across every
 * provider — Anthropic hoists `system` messages, which would disorder a
 * mid-conversation nudge.
 */
export function buildToolNudgeMessage(leak: TextToolLeak): ChatMessage {
    return {
        role: 'user',
        content: [
            `Your previous reply contained "${leak.snippet}" written out as text.`,
            'A tool call written as text does NOT execute — the writer sees raw',
            'syntax and nothing happens. To use a tool you MUST emit it through the',
            'tool-calling interface (the structured tool_calls field), the same way',
            'you invoke any function. Re-issue your intended call to',
            `\`${leak.name}\` properly now, or respond in plain prose if you did`,
            'not mean to call a tool.'
        ].join(' ')
    };
}

/**
 * Build a nudge for intent narration: the model expressed commitment to make
 * edits ("I'll get started on those edits now") but produced no tool calls.
 * Pushes the model to either call the tools now or clarify that it's waiting
 * for the writer's confirmation.
 */
export function buildIntentNudgeMessage(intent: IntentNarration): ChatMessage {
    return {
        role: 'user',
        content: [
            `Your previous reply said "${intent.snippet}" but you did not call any tools.`,
            'If you intended to make edits, call the editing tools (edit_note, insert_note,',
            'append_to_note) now through the structured tool-calling interface — do not',
            'describe what you plan to do. If you are waiting for the writer to confirm,',
            'say so explicitly. The writer cannot see your intent unless you actually call',
            'the tools.'
        ].join(' ')
    };
}

/** Options for {@link tryNudgeTextToolLeak}. */
export interface NudgeTextToolLeakOptions {
    /** The model's accumulated text response for the round. */
    response: string;
    /** Registered tool ids the model had access to this round. */
    toolNames: string[];
    /** API message array to append the nudge to (mutated in place when nudging). */
    messages: ChatMessage[];
    /** Nudges already consumed this turn (bounds the retry). */
    nudgesUsed: number;
    /** Optional UI refresh callback fired after the nudge is pushed. */
    onChatUpdate?: () => void;
}

/** Result of {@link tryNudgeTextToolLeak}. */
export interface NudgeTextToolLeakResult {
    /** True when a leak was detected and a nudge round was scheduled. */
    nudged: boolean;
    /** The updated nudge count (incremented when `nudged`). */
    nudgesUsed: number;
}

/**
 * Centralized text-form tool-call recovery for a tool-loop round that produced
 * NO structured tool calls. Two detection types, tried in order:
 *
 * 1. **Tool-syntax leak**: the model wrote `edit_note(...)` as plain text.
 *    Nudged via {@link buildToolNudgeMessage}.
 * 2. **Intent narration**: the model wrote "I'll get started on those edits"
 *    or similar commitment phrase, without calling any tools. Nudged via
 *    {@link buildIntentNudgeMessage}.
 *
 * Both share the same nudge budget ({@link MAX_TEXT_TOOL_NUDGES}). On
 * `nudged: true`, the caller takes another round; otherwise ends the turn.
 */
export function tryNudgeTextToolLeak(opts: NudgeTextToolLeakOptions): NudgeTextToolLeakResult {
    if (opts.response.trim() && opts.nudgesUsed < MAX_TEXT_TOOL_NUDGES) {
        // 1. Check for tool syntax written as text.
        const leak = detectTextToolCall(opts.response, opts.toolNames);
        if (leak) {
            opts.messages.push(buildToolNudgeMessage(leak));
            opts.onChatUpdate?.();
            return { nudged: true, nudgesUsed: opts.nudgesUsed + 1 };
        }
        // 2. Check for intent narration ("I'll start editing..." with no calls).
        const intent = detectIntentNarration(opts.response);
        if (intent) {
            opts.messages.push(buildIntentNudgeMessage(intent));
            opts.onChatUpdate?.();
            return { nudged: true, nudgesUsed: opts.nudgesUsed + 1 };
        }
    }
    return { nudged: false, nudgesUsed: opts.nudgesUsed };
}
