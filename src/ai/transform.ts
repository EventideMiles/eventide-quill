import { Editor, Notice, Platform } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type EventideQuillPlugin from '../main';
import { gatherVaultContext } from '../core/context-engine';
import { ChatMessage } from './provider';
import { NarrativeVoicePreset, NARRATIVE_VOICE_PRESETS } from '../types';

/** Describes a single transformation action available in the editor context menu. */
export interface TransformAction {
    id: TransformType;
    label: string;
    icon: string;
    needsTone?: boolean;
}

/** The type of transformation to apply to the selected text. */
export type TransformType =
    | 'improve'
    | 'make-longer'
    | 'make-shorter'
    | 'change-tone'
    | 'custom';

/** Tone options available under the "change tone" submenu. */
export const TONE_OPTIONS = [
    'darker',
    'lighter',
    'more urgent',
    'more lyrical',
    'more detached',
] as const;

export type ToneOption = (typeof TONE_OPTIONS)[number];

/** The full list of transformation actions for the context menu. */
export const TRANSFORM_ACTIONS: TransformAction[] = [
    { id: 'improve', label: 'Improve writing', icon: 'pencil' },
    { id: 'make-longer', label: 'Make longer', icon: 'expand-vertically' },
    { id: 'make-shorter', label: 'Make shorter', icon: 'compress' },
    { id: 'change-tone', label: 'Change tone', icon: 'sun', needsTone: true },
    { id: 'custom', label: 'Custom instruction', icon: 'message-square' },
];

/**
 * Build the shared style-constraints system prompt used for all transformations.
 * Optionally includes vault-derived context (character notes, worldbuilding, etc.).
 *
 * @param vaultContext - Vault-derived context notes (character, worldbuilding, etc.).
 * @param narrativePreset - The selected narrative voice preset identifier.
 * @returns The assembled system prompt string.
 */
function getSystemPrompt(vaultContext: string, narrativePreset: NarrativeVoicePreset): string {
    const def = NARRATIVE_VOICE_PRESETS.find((p) => p.id === narrativePreset)
        ?? NARRATIVE_VOICE_PRESETS[0];
    if (!def) {
        throw new Error('NARRATIVE_VOICE_PRESETS must not be empty');
    }

    const perspectiveRules = def.rules.map((r, i) => `${9 + i}. ${r}`).join('\n');

    const parts = [
        'You are a thoughtful prose editor for a novelist. You rewrite passages of narrative fiction.',
        'Follow these style rules strictly:',
        '',
        '1. No em dashes. Use commas, colons, semicolons, or split the sentence instead.',
        '2. No negation structures like "it\'s not X, it\'s Y." State what things are directly.',
        '3. Avoid cliché words: tapestry, testament, delve, vibrant, nestled, thriving, nascent, weaving, realm, unlock, game-changer, pivotal, intricate, elucidate.',
        '4. No wrap-up summaries or moral conclusions. End on action, dialogue, or unresolved tension.',
        '5. Show emotion through physical reaction, blocking, and dialogue. Do not name emotions directly.',
        '6. Vary sentence cadence. Mix short, punchy sentences with longer, complex ones.',
        '7. Avoid filler adverbs (quietly, deliberately, gently, suddenly). Use concrete action.',
        '8. Use active voice. Avoid hedging (might, could, perhaps, maybe).',
        '',
        `Narrative perspective — ${def.label}, ${def.tense}:`,
        perspectiveRules,
        '',
        'Formatting:',
        `${9 + def.rules.length}. No bold text in the narrative.`,
        `${9 + def.rules.length + 1}. Italics allowed sparingly for internal thoughts or emphasis.`,
        `${9 + def.rules.length + 2}. No bullet lists in the narrative.`,
        `${9 + def.rules.length + 3}. Output only the rewritten passage. No introductory text, no apologies, no meta-commentary.`,
    ];

    if (vaultContext) {
        parts.push(
            '',
            '---',
            'Reference material from your vault (character notes, worldbuilding, outlines):',
            vaultContext,
        );
    }

    return parts.join('\n');
}

/**
 * Build the user message for a given transformation type.
 *
 * The document context is truncated to fit within the given character limit,
 * reserving room for the instruction, prompt framing, vault context, and the
 * model's response. A typical English chapter runs 15,000–30,000 characters
 * (3,000–5,000 words), so the default limit aims to fit most single chapters.
 *
 * @param type - The transformation to perform.
 * @param selectedText - The passage the user selected.
 * @param fullDocumentText - The full text of the current document.
 * @param maxContextChars - Maximum characters for the document portion of the prompt.
 * @param toneOrInstruction - Tone for 'change-tone', custom instruction for 'custom'.
 */
export function getUserPrompt(
    type: TransformType,
    selectedText: string,
    fullDocumentText: string,
    maxContextChars: number,
    toneOrInstruction?: string,
): string {
    const instruction = getInstruction(type, toneOrInstruction);

    const OMISSION_MARKER = '\n\n... (middle omitted) ...\n\n';
    const truncated = fullDocumentText.length > maxContextChars
        ? fullDocumentText.slice(0, Math.floor((maxContextChars - OMISSION_MARKER.length) / 2))
            + OMISSION_MARKER
            + fullDocumentText.slice(-Math.floor((maxContextChars - OMISSION_MARKER.length) / 2))
        : fullDocumentText;

    return [
        instruction,
        '',
        '--- Reference context (read only) ---',
        'Below is the surrounding document for voice, characters, and setting. Do not reproduce it.',
        truncated,
        '',
        '--- Passage to rewrite ---',
        selectedText,
        '',
        '--- Output ---',
        'Rewrite only the passage above. Output nothing else — no document text, no explanations, no labels.',
    ].join('\n');
}

/** Return the instruction fragment for a given transformation type. */
function getInstruction(type: TransformType, toneOrInstruction?: string): string {
    switch (type) {
        case 'improve':
            return 'Polish the following passage for clarity and flow without changing its intent, voice, or narrative perspective. Keep all character names, setting details, and plot points intact.';
        case 'make-longer':
            return 'Make this passage LONGER — at least double its original length. Add sensory detail, internal reflection, setting description, or dialogue. Do NOT condense or shorten anything. Preserve every existing word and expand from there. Stay true to the voice, characters, setting, and narrative perspective.';
        case 'make-shorter':
            return 'Tighten the following passage. Cut adverbs, trim exposition, and sharpen dialogue. Preserve the voice, narrative perspective, characters, setting, and key story beats.';
        case 'change-tone':
            return `Rewrite the following passage with a ${toneOrInstruction ?? 'different'} tone. Keep the same narrative perspective, tense, characters, setting, and events. Change only the register and emotional texture.`;
        case 'custom':
            return toneOrInstruction
                ? `Rewrite the following passage according to this instruction: ${toneOrInstruction}`
                : 'Rewrite the following passage according to the instruction provided.';
        default:
            return 'Rewrite the following passage.';
    }
}

/**
 * Apply a transformation to the selected text by streaming the AI response
 * and replacing the selection when complete.
 *
 * @returns A promise that resolves when the transformation is done.
 */
export async function applyTransformation(
    plugin: EventideQuillPlugin,
    editor: Editor,
    type: TransformType,
    selectedText: string,
    fullDocumentText: string,
    tone?: string,
): Promise<void> {
    const provider = plugin.getDefaultChatProvider();
    if (!provider) {
        new Notice(
            'Quill: No AI provider configured. Set one up in settings → AI providers.',
        );
        return;
    }

    if (plugin.transformInProgress) {
        new Notice('Quill: A transformation is already in progress.');
        return;
    }

    const processingMsg = Platform.isMobile
        ? 'Quill: Transforming (mobile — this may take a moment)...'
        : 'Quill: Transforming...';
    const notice = new Notice(processingMsg, 0);
    plugin.transformInProgress = true;

    try {
        const vaultContext = plugin.settings.transformVaultContext
            ? await gatherVaultContext(plugin.app.vault, fullDocumentText)
            : '';

        const { narrativeVoicePreset, transformTemperature, transformMaxOutputTokens, transformAppendNewline } = plugin.settings;
        const systemPrompt = getSystemPrompt(vaultContext, narrativeVoicePreset);

        // Budget the context window holistically.
        // Rough token estimates (English: ~4 chars per token):
        //   - system prompt (including vault context)
        //   - instruction + prompt framing (~200 tokens)
        //   - response headroom (user-configurable)
        // Everything else goes to the document text.
        const systemTokens = Math.ceil(systemPrompt.length / 4);
        const instructionTokens = 200;
        const totalBudget = provider.config.maxContextTokens;

        // Ensure total token usage never exceeds maxContextTokens.
        // Reserve at least 1000 tokens for document context.
        const MIN_DOC_TOKENS = 1000;
        let responseTokens = transformMaxOutputTokens;
        const remainingForDoc = totalBudget - systemTokens - instructionTokens - responseTokens;
        if (remainingForDoc < MIN_DOC_TOKENS) {
            responseTokens = Math.max(1, totalBudget - systemTokens - instructionTokens - MIN_DOC_TOKENS);
        }
        const docTokens = totalBudget - systemTokens - instructionTokens - responseTokens;
        const maxContextChars = Math.min(docTokens * 4, 100_000);

        const userPrompt = getUserPrompt(type, selectedText, fullDocumentText, maxContextChars, tone);

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        // Stream into the editor via CodeMirror 6 for real-time character display
        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            return;
        }

        const cmSelection = cm.state.selection.main;
        const anchor = cmSelection.from;
        let insertedLength = 0;
        let lastError: Error | null = null;

        try {
            const stream = provider.chatCompletion({
                messages,
                temperature: transformTemperature,
                maxTokens: transformMaxOutputTokens,
                signal: undefined,
            });

            for await (const chunk of stream) {
                if (!chunk.text) continue;

                const insertAt = anchor + insertedLength;
                cm.dispatch({
                    changes: { from: insertAt, to: insertedLength === 0 ? cmSelection.to : insertAt, insert: chunk.text },
                    selection: { anchor: insertAt + chunk.text.length },
                });
                insertedLength += chunk.text.length;
            }
        } catch (err: unknown) {
            if (err instanceof Error) {
                if (err.name === 'AbortError') return;
                lastError = err;
            }
        }

        if (lastError) {
            new Notice(`Quill: Transformation failed — ${lastError.message}`);
            return;
        }

        if (insertedLength === 0) {
            new Notice('Quill: Received empty response from the AI provider.');
            return;
        }

        // Trim trailing whitespace, then optionally normalize blank lines around
        // the transformed text based on whether the selection started and/or ended
        // at a line boundary (e.g. full-line or full-paragraph selections).
        if (transformAppendNewline) {
            const docLen = cm.state.doc.length;
            const startsAtLine = anchor === 0 || cm.state.sliceDoc(anchor - 1, anchor) === '\n';
            const endsAtLine = anchor + insertedLength >= docLen
                || cm.state.sliceDoc(anchor + insertedLength, anchor + insertedLength + 1) === '\n';

            // Trim any trailing whitespace the model may have emitted.
            const rawInserted = cm.state.sliceDoc(anchor, anchor + insertedLength);
            const trimmed = rawInserted.replace(/\s+$/, '');
            const trimDiff = rawInserted.length - trimmed.length;
            let offset = 0;

            if (trimDiff > 0) {
                const newEnd = anchor + trimmed.length;
                cm.dispatch({
                    changes: { from: newEnd, to: anchor + insertedLength, insert: '' },
                    selection: { anchor: newEnd },
                });
                insertedLength = trimmed.length;
            }

            // If the selection started at a line boundary, ensure a blank line
            // above (but not at document start).
            if (startsAtLine && anchor > 0) {
                const charBefore = cm.state.sliceDoc(anchor - 1, anchor);
                const twoBefore = anchor >= 2
                    ? cm.state.sliceDoc(anchor - 2, anchor)
                    : '';
                if (charBefore === '\n' && twoBefore !== '\n\n') {
                    cm.dispatch({
                        changes: { from: anchor, to: anchor, insert: '\n' },
                        selection: { anchor: anchor + 1 },
                    });
                    offset = 1;
                }
            }

            // If the selection ended at a line boundary, ensure a blank line below.
            if (endsAtLine) {
                const endPos = anchor + insertedLength + offset;
                const after = cm.state.sliceDoc(endPos, Math.min(endPos + 2, cm.state.doc.length));
                if (after !== '\n\n') {
                    cm.dispatch({
                        changes: { from: endPos, to: endPos, insert: '\n' },
                        selection: { anchor: endPos + 1 },
                    });
                }
            }
        }
    } finally {
        notice.hide();
        plugin.transformInProgress = false;
    }
}
