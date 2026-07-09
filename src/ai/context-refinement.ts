import type { ChatMessage, ToolCallRequest } from './provider';

/**
 * Context refinement — the deterministic, surgical complement to AI
 * compaction. Rewrites bulky or now-stale tool-related messages IN PLACE in an
 * API array (`loreCoachMessages` / `discussCurrentMessages`) so the model
 * retains the *fact* of what happened without retaining the *verbatim text*.
 *
 * Two triggers drive it (see {@link refineForBudget} + the event helpers):
 *   - Event-driven: when the writer accepts/rejects an edit or saves/discards
 *     a lore draft, the affected turns are compressed to compact outcome
 *     markers. This is the durable "move-on" signal — the model learns its work
 *     landed — AND the regurgitation fix: a long-context model can no longer
 *     re-emit a draft whose verbatim content has been refined out of its
 *     history.
 *   - Budget-driven: when a conversation approaches the compaction threshold,
 *     {@link refineForBudget} compresses the oldest bulky tool reads/drafts
 *     FIRST (free, faithful — the model can always re-`vault_lookup` current
 *     state) before the caller falls back to AI summarization.
 *
 * Safety invariants (enforced everywhere):
 *   - Messages are NEVER removed — only `content` / `toolCalls[].arguments`
 *     are rewritten in place, so OpenAI/Ollama tool-result ordering (a `tool`
 *     message must immediately follow its `assistant` `tool_calls` turn) stays
 *     valid.
 *   - Assistant turns carrying Anthropic `thinkingBlocks` are skipped — the
 *     signed reasoning must be replayed verbatim and can't sit beside edited
 *     tool args.
 *   - `quillAnchorId` is PRESERVED on every refined message, so co-writer
 *     rewind keeps working. Unlike compaction (which folds turns into a
 *     summary and drops anchors), refinement is non-destructive to the
 *     display↔API coupling.
 *   - Idempotent via the `quillRefined` flag — repeated passes (event + budget)
 *     skip already-compressed messages.
 *
 * Only the API arrays are touched; the display `chatHistory` keeps full drafts
 * and diffs, so the writer's view is unchanged.
 */

/** Outcome of a `propose_entry` draft the writer has resolved. */
export type DraftOutcome = 'accepted' | 'discarded';
/** Outcome of a pending lore edit (edit_note / insert_note / append_to_note). */
export type EditOutcome = 'approved' | 'rejected';

/** Payload below this many characters is not worth refining. */
const MIN_REFINABLE_CHARS = 300;

/**
 * Parse a tool call's `arguments` (a JSON string per OpenAI's convention) into
 * an object. Returns `null` for absent/empty/malformed arguments so callers can
 * skip the call rather than guess.
 */
function parseToolArgs(argsJson: string): Record<string, unknown> | null {
    const raw = argsJson.trim();
    if (raw.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Return a copy of `argsJson` with its `content` field replaced by
 * `newContent`. The result is re-serialized to JSON. On any parse/shape failure
 * the original string is returned unchanged so the turn stays well-formed.
 */
function withReplacedContent(argsJson: string, newContent: string): string {
    const parsed = parseToolArgs(argsJson);
    if (parsed === null) return argsJson;
    parsed.content = newContent;
    return JSON.stringify(parsed);
}

/** Human label for an entry type argument (falls back to "untyped"). */
function entryTypeLabel(args: Record<string, unknown>): string {
    const t = typeof args.entry_type === 'string' ? args.entry_type.trim() : '';
    return t.length > 0 ? t : 'untyped';
}

/**
 * Locate every assistant tool call in `messages` whose serialized tool is
 * `toolName`, whose args satisfy `matchArgs`, and whose turn is eligible for
 * refinement (not already refined, no Anthropic thinking blocks). Returns the
 * message index + the call index + parsed args for each.
 */
interface ToolCallSite {
    messageIndex: number;
    callIndex: number;
    call: ToolCallRequest;
    args: Record<string, unknown>;
}

function findToolCallSites(
    messages: ChatMessage[],
    toolName: string,
    matchArgs: (args: Record<string, unknown>, call: ToolCallRequest) => boolean
): ToolCallSite[] {
    const sites: ToolCallSite[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role !== 'assistant' || msg.quillRefined) continue;
        // Anthropic thinking blocks are signed and must replay verbatim — skip
        // any turn that carries them.
        if (msg.thinkingBlocks && msg.thinkingBlocks.length > 0) continue;
        if (!msg.toolCalls) continue;
        for (let c = 0; c < msg.toolCalls.length; c++) {
            const call = msg.toolCalls[c]!;
            if (call.name !== toolName) continue;
            const args = parseToolArgs(call.arguments);
            if (args === null) continue;
            if (matchArgs(args, call)) {
                sites.push({ messageIndex: i, callIndex: c, call, args });
            }
        }
    }
    return sites;
}

/**
 * Find the `role: 'tool'` result message answering a given assistant tool call
 * id. OpenAI/Ollama require it to immediately follow the assistant turn, but we
 * scan (rather than assume position) so a future reordering can't silently
 * target the wrong result.
 */
function findToolResult(messages: ChatMessage[], toolCallId: string): ChatMessage | undefined {
    return messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
}

/**
 * Refine the `propose_entry` turn(s) for a draft the writer has resolved, so
 * the verbatim entry markdown leaves the model's context and a compact outcome
 * marker takes its place. Compresses BOTH the bulky `content` argument (the
 * regurgitation source) and the tool result (rewritten to the durable move-on
 * signal). Idempotent — turns already refined are skipped. Returns whether any
 * message was changed (so the caller can refresh the token estimate / persist).
 *
 * @param messages   The API array to refine in place.
 * @param name       Display name of the draft (matches `propose_entry`'s `name` arg).
 * @param outcome    Whether the writer accepted (saved) or discarded the draft.
 * @param savedPath  Vault path the draft was saved to (accepted only). Surfaced
 *                   in the marker so the model knows where the entry lives.
 */
export function refineProposeEntryOutcome(
    messages: ChatMessage[],
    name: string,
    outcome: DraftOutcome,
    savedPath?: string
): boolean {
    const needle = name.trim().toLowerCase();
    if (needle.length === 0) return false;

    const sites = findToolCallSites(messages, 'propose_entry', (args) => {
        const n = typeof args.name === 'string' ? args.name.trim().toLowerCase() : '';
        return n === needle;
    });

    let changed = false;
    for (const site of sites) {
        const originalContent = typeof site.args.content === 'string' ? site.args.content : '';
        const refinedTokens = Math.ceil(originalContent.length / 4);
        const typeLabel = entryTypeLabel(site.args);

        const assistant = messages[site.messageIndex]!;
        // Replace the bulky content arg with a brief pointer; keep name/type so
        // the call stays self-describing. The tool result carries the outcome.
        const argMarker = `[Draft content (~${refinedTokens} tokens) refined out of context — see the tool result for the outcome.]`;
        const newArgs = withReplacedContent(site.call.arguments, argMarker);
        if (newArgs !== site.call.arguments && assistant.toolCalls) {
            assistant.toolCalls[site.callIndex] = { ...site.call, arguments: newArgs };
        }

        const result = findToolResult(messages, site.call.id);
        if (result) {
            const outcomeLine =
                outcome === 'accepted'
                    ? `The writer ACCEPTED the draft${savedPath ? ` and saved it to ${savedPath}` : ''}. ` +
                      `This entry is COMPLETE — do not re-propose, re-draft, or re-output its content. ` +
                      `Re-run vault_lookup on "${name.trim()}" if you need its current text.`
                    : `The writer DISCARDED the draft. Do not re-propose it unless the writer explicitly asks.`;
            result.content =
                `[Entry "${name.trim()}" (${typeLabel}): ~${refinedTokens} tokens of draft content ` +
                `were refined out of context to keep it lean. ${outcomeLine}]`;
            result.quillRefined = true;
        }

        assistant.quillRefined = true;
        changed = true;
    }
    return changed;
}

/**
 * Append an outcome marker to the tool result of a resolved pending lore edit
 * (from `edit_note` / `insert_note` / `append_to_note`). Matches by the stable
 * `(edit id N)` substring the editing tools emit — it is unique per edit.
 * Idempotent. Returns whether a message was changed.
 */
export function refineLoreEditOutcome(messages: ChatMessage[], editId: number, outcome: EditOutcome): boolean {
    const marker =
        outcome === 'approved'
            ? ' [APPROVED + applied by the writer — this edit landed in the note.]'
            : ' [REJECTED by the writer — this edit did NOT apply. Do not assume the change is present.]';
    const needle = `(edit id ${editId})`;
    let changed = false;
    for (const msg of messages) {
        if (msg.role !== 'tool' || msg.quillRefined) continue;
        if (typeof msg.content !== 'string' || !msg.content.includes(needle)) continue;
        if (msg.content.includes('[APPROVED') || msg.content.includes('[REJECTED')) continue;
        msg.content = msg.content + marker;
        msg.quillRefined = true;
        changed = true;
    }
    return changed;
}

/**
 * Does a vault_lookup's `path` argument refer to the same note as `filePath`?
 * Pure string comparison (no vault resolution) so the engine stays testable
 * without mocks. Handles the common shapes: exact path, bare name, and
 * name-with-extension. Best-effort — a missed match just leaves a stale read
 * (refinement is never a correctness hazard).
 */
function lookupArgMatchesFile(filePath: string, arg: string): boolean {
    const a = arg.trim();
    if (a.length === 0) return false;
    if (a === filePath) return true;
    // Basename without extension, e.g. "Sarah Connor" from "Lore/Characters/Sarah Connor.md".
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const fileBase = filePath.slice(slash + 1).replace(/\.md$/i, '');
    if (fileBase.length === 0) return false;
    if (a === fileBase) return true;
    if (a === `${fileBase}.md`) return true;
    if (a.endsWith(`/${fileBase}.md`)) return true;
    return false;
}

/**
 * Replace the verbatim body of every prior `vault_lookup` result for a file
 * that has since been edited, with a marker noting the read is stale and the
 * model should re-`vault_lookup` for current text. This kills the stale-anchor
 * hazard (the model quoting pre-edit text as an edit anchor) and frees tokens.
 * Idempotent. Returns whether a message was changed.
 */
export function refineStaleVaultLookups(messages: ChatMessage[], filePath: string): boolean {
    if (!filePath) return false;
    // Map each vault_lookup tool-call id → whether its path arg targets the file.
    const matchingCallIds = new Set<string>();
    for (const msg of messages) {
        if (msg.role !== 'assistant' || !msg.toolCalls) continue;
        for (const call of msg.toolCalls) {
            if (call.name !== 'vault_lookup') continue;
            const args = parseToolArgs(call.arguments);
            const pathArg = args && typeof args.path === 'string' ? args.path : '';
            if (pathArg && lookupArgMatchesFile(filePath, pathArg)) {
                matchingCallIds.add(call.id);
            }
        }
    }
    if (matchingCallIds.size === 0) return false;

    let changed = false;
    for (const msg of messages) {
        if (msg.role !== 'tool' || msg.quillRefined) continue;
        if (msg.name !== 'vault_lookup') continue;
        if (!msg.toolCallId || !matchingCallIds.has(msg.toolCallId)) continue;
        const refinedTokens = Math.ceil(msg.content.length / 4);
        msg.content =
            `[Earlier vault_lookup of "${filePath}": ~${refinedTokens} tokens of content refined out. ` +
            `The note has since been EDITED, so this read is stale — re-run vault_lookup on the same ` +
            `name if you need the current text before editing it.]`;
        msg.quillRefined = true;
        changed = true;
    }
    return changed;
}

/**
 * Candidate for budget-driven refinement: an assistant `propose_entry` call with
 * bulky content, or a `vault_lookup` tool result with bulky content. Reads are
 * prioritized over drafts (a read is unambiguously safe to compress — the model
 * can re-fetch current state — while a pending draft's content may still be
 * useful to the model mid-review).
 */
interface BudgetCandidate {
    kind: 'read' | 'draft';
    /** Lower = refine first (oldest first within a kind). */
    order: number;
    apply: () => void;
}

/**
 * Compress bulky tool messages oldest-first until `estimateTokens(messages)`
 * drops to/below `targetTokens` (or no candidates remain). Intended as the
 * deterministic, free first stage before the caller falls back to AI
 * `compactConversation`. Returns whether anything was refined. Does nothing to
 * assistant turns carrying Anthropic thinking blocks.
 */
export function refineForBudget(
    messages: ChatMessage[],
    estimateTokens: (messages: ChatMessage[]) => number,
    targetTokens: number
): boolean {
    if (estimateTokens(messages) <= targetTokens) return false;

    const candidates: BudgetCandidate[] = [];

    // Reads: every un-refined vault_lookup tool result above the floor.
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role !== 'tool' || msg.quillRefined) continue;
        if (msg.name !== 'vault_lookup') continue;
        if (msg.content.length < MIN_REFINABLE_CHARS) continue;
        candidates.push({
            kind: 'read',
            order: i,
            apply: () => {
                const refinedTokens = Math.ceil(msg.content.length / 4);
                msg.content =
                    `[Earlier vault_lookup result (~${refinedTokens} tokens) refined out to free context. ` +
                    `Re-run vault_lookup if you need this file's current text.]`;
                msg.quillRefined = true;
            }
        });
    }

    // Drafts: every eligible propose_entry call with bulky content.
    const draftSites = findToolCallSites(messages, 'propose_entry', (args) => {
        return typeof args.content === 'string' && args.content.length >= MIN_REFINABLE_CHARS;
    });
    for (const site of draftSites) {
        const originalContent = typeof site.args.content === 'string' ? site.args.content : '';
        const refinedTokens = Math.ceil(originalContent.length / 4);
        const typeLabel = entryTypeLabel(site.args);
        const nameRaw = typeof site.args.name === 'string' ? site.args.name.trim() : 'this entry';
        candidates.push({
            kind: 'draft',
            order: site.messageIndex,
            apply: () => {
                const assistant = messages[site.messageIndex]!;
                const argMarker = `[Draft content (~${refinedTokens} tokens) refined out of context to free budget — see the tool result.]`;
                const newArgs = withReplacedContent(site.call.arguments, argMarker);
                if (newArgs !== site.call.arguments && assistant.toolCalls) {
                    assistant.toolCalls[site.callIndex] = { ...site.call, arguments: newArgs };
                }
                const result = findToolResult(messages, site.call.id);
                if (result) {
                    result.content =
                        `[Entry "${nameRaw}" (${typeLabel}): ~${refinedTokens} tokens of draft content ` +
                        `were refined out to free context budget. The draft's review status is unchanged. ` +
                        `Re-run vault_lookup on "${nameRaw}" if you need the entry text.]`;
                    result.quillRefined = true;
                }
                assistant.quillRefined = true;
            }
        });
    }

    // Reads before drafts (safer); oldest-first within each kind.
    candidates.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'read' ? -1 : 1;
        return a.order - b.order;
    });

    let changed = false;
    for (const candidate of candidates) {
        if (estimateTokens(messages) <= targetTokens) break;
        candidate.apply();
        changed = true;
    }
    return changed;
}
