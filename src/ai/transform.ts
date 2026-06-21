import { Editor, Notice, Platform } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { gatherVaultContext } from '../core/context-engine';
import { ChatMessage } from './provider';
import { getSystemPrompt, getWikiLinkInstruction, type WikiLinkBehavior } from './prompts';
import { clearDiffEdits, pushDiffEdits, toDiffSnapshots } from '../ui/change-diff-extension';
import type EventideQuillPlugin from '../main';

/** Describes a single transformation action available in the editor context menu. */
export interface TransformAction {
    id: TransformType;
    label: string;
    icon: string;
    needsTone?: boolean;
}

/** The type of transformation to apply to the selected text. */
export type TransformType = 'improve' | 'make-longer' | 'make-shorter' | 'change-tone' | 'custom';

/** Tone options available under the "change tone" submenu. */
export const TONE_OPTIONS = ['darker', 'lighter', 'more urgent', 'more lyrical', 'more detached'] as const;

export type ToneOption = (typeof TONE_OPTIONS)[number];

/** The full list of transformation actions for the context menu. */
export const TRANSFORM_ACTIONS: TransformAction[] = [
    { id: 'improve', label: 'Improve writing', icon: 'pencil' },
    { id: 'make-longer', label: 'Make longer', icon: 'expand-vertically' },
    { id: 'make-shorter', label: 'Make shorter', icon: 'compress' },
    { id: 'change-tone', label: 'Change tone', icon: 'sun', needsTone: true },
    { id: 'custom', label: 'Custom instruction', icon: 'message-square' }
];

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
    wikiLinkBehavior?: WikiLinkBehavior
): string {
    const instruction = getInstruction(type, toneOrInstruction);

    const OMISSION_MARKER = '\n\n... (middle omitted) ...\n\n';
    const truncated =
        fullDocumentText.length > maxContextChars
            ? fullDocumentText.slice(0, Math.floor((maxContextChars - OMISSION_MARKER.length) / 2)) +
              OMISSION_MARKER +
              fullDocumentText.slice(-Math.floor((maxContextChars - OMISSION_MARKER.length) / 2))
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
        `Rewrite only the passage above. Your output must be approximately the same length as the passage — do not expand, add new content, or generate surrounding sentences unless the instruction explicitly says to (e.g., "make longer"). ${getWikiLinkInstruction(wikiLinkBehavior ?? 'preserve')} Output nothing else — no document text, no explanations, no labels.`
    ].join('\n');
}

/** Return the instruction fragment for a given transformation type. */
function getInstruction(type: TransformType, toneOrInstruction?: string): string {
    switch (type) {
        case 'improve':
            return 'Polish the following passage for clarity and flow without changing its intent, voice, or narrative perspective. Keep all character names, setting details, and plot points intact. If only a word or short phrase is selected, improve just that — do not expand the scope or write surrounding sentences.';
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
 * @param filePath - The path of the file being transformed. Used to ensure
 *   the context assembly matches the document being edited.
 * @returns A promise that resolves when the transformation is done.
 */
export async function applyTransformation(
    plugin: EventideQuillPlugin,
    editor: Editor,
    type: TransformType,
    selectedText: string,
    fullDocumentText: string,
    tone?: string,
    filePath?: string
): Promise<void> {
    const defaultChat = plugin.getDefaultChatProvider();
    const provider = defaultChat.provider;
    if (!provider) {
        new Notice('Quill: No AI provider configured. Set one up in settings → AI providers.');
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
    plugin.transformAbortController = new AbortController();
    const abortController = plugin.transformAbortController;

    try {
        // Capture the editor and selection range up front, before any awaits,
        // so the range matches the selection the user initiated the transform
        // on (it could shift if the user changes selection during async work).
        const cm = (editor as unknown as { cm: EditorView }).cm;
        if (!cm) {
            new Notice('Quill: Could not access editor for streaming.');
            return;
        }
        const sel = cm.state.selection.main;
        const from = sel.from;
        const to = sel.to;

        // Ensure context is assembled for the correct document.
        // If context is stale or missing, refresh it before proceeding.
        let assembly: ReturnType<typeof plugin.assembleDocumentContext> extends Promise<infer T> ? T : never;
        if (filePath && plugin.contextActiveFile !== filePath) {
            assembly = await plugin.assembleDocumentContext(fullDocumentText, filePath);
        } else if (plugin.currentAssembly && plugin.contextActiveFile === filePath) {
            assembly = plugin.currentAssembly;
        } else if (filePath) {
            assembly = await plugin.assembleDocumentContext(fullDocumentText, filePath);
        } else {
            assembly = plugin.currentAssembly ?? (await plugin.assembleDocumentContext(fullDocumentText, filePath));
        }

        const vaultContext = plugin.settings.transformVaultContext
            ? await gatherVaultContext(plugin.app.vault, fullDocumentText, assembly)
            : '';

        const { narrativeVoicePreset, transformTemperature, transformMaxOutputTokens, wikiLinkBehavior } =
            plugin.settings;
        const systemPrompt = getSystemPrompt('narrative', {
            vaultContext,
            narrativePreset: narrativeVoicePreset,
            wikiLinkBehavior
        });

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

        const userPrompt = getUserPrompt(type, selectedText, fullDocumentText, maxContextChars, tone, wikiLinkBehavior);

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        // Stream the rewrite live into a proposed change. The document is not
        // modified during generation; the selection shows in red and the rewrite
        // streams into the green box so the writer sees progress immediately.
        plugin.transformChangeSet.clear();
        const tEdit = plugin.transformChangeSet.add({
            from,
            to,
            newText: '',
            label: transformLabel(type, tone)
        });
        tEdit.state = 'generating';
        pushDiffEdits(cm, toDiffSnapshots(plugin.transformChangeSet, 'transform'));

        try {
            const stream = provider.chatCompletion({
                messages,
                model: defaultChat.modelId,
                temperature: transformTemperature,
                maxTokens: transformMaxOutputTokens,
                signal: abortController.signal
            });
            for await (const chunk of stream) {
                if (!chunk.text) continue;
                tEdit.newText += chunk.text;
                pushDiffEdits(cm, toDiffSnapshots(plugin.transformChangeSet, 'transform'));
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                // Aborted mid-stream: keep partial prose for review, or clear if empty.
                if (tEdit.newText.replace(/\s+$/, '').length === 0) {
                    plugin.transformChangeSet.clear();
                    clearDiffEdits(cm, 'transform');
                } else {
                    tEdit.state = 'pending';
                    pushDiffEdits(cm, toDiffSnapshots(plugin.transformChangeSet, 'transform'));
                }
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Quill: Transformation failed \u2014 ${msg}`);
            plugin.transformChangeSet.clear();
            clearDiffEdits(cm, 'transform');
            return;
        }

        tEdit.newText = tEdit.newText.replace(/\s+$/, '');
        if (tEdit.newText.length === 0) {
            new Notice('Quill: Received empty response from the AI provider.');
            plugin.transformChangeSet.clear();
            clearDiffEdits(cm, 'transform');
            return;
        }
        tEdit.state = 'pending';
        pushDiffEdits(cm, toDiffSnapshots(plugin.transformChangeSet, 'transform'));
    } finally {
        notice.hide();
        plugin.transformInProgress = false;
        plugin.transformAbortController = null;
    }
}

/** Human label for the change card / diff, derived from the transform type and tone. */
function transformLabel(type: TransformType, tone?: string): string {
    switch (type) {
        case 'improve':
            return 'Improve writing';
        case 'make-longer':
            return 'Make longer';
        case 'make-shorter':
            return 'Make shorter';
        case 'change-tone':
            return `Change tone: ${tone ?? 'different'}`;
        case 'custom':
            return tone ? `Custom: ${tone}` : 'Custom rewrite';
        default:
            return 'Rewrite';
    }
}
