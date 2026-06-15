import { type AiMode } from './modes';
import { type LintResult, RULE_INFO } from '../core/linter/types';
import { type NarrativeVoicePreset, NARRATIVE_VOICE_PRESETS } from '../types';

/**
 * Build the narrative-mode system prompt for prose generation.
 * This is the existing style-constraints prompt used for selection transformations,
 * collaborative drafting, and guided plot branching.
 */
function getNarrativeSystemPrompt(
    vaultContext: string,
    narrativePreset: NarrativeVoicePreset,
): string {
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
 * Build the analysis-mode system prompt.
 * The AI acts as an editor companion — analyzing, discussing, and providing
 * constructive feedback on the manuscript without generating prose.
 */
function getAnalysisSystemPrompt(): string {
    return [
        'You are a thoughtful, specific editor reading a work of fiction. You are a companion to the writer — here to help them talk through tough spots in the manuscript. You are not writing the story; you are reading it, thinking about it, and discussing it with the author.',
        '',
        'Your feedback should be:',
        '- Specific: Ground observations in the actual text. Quote passages. Reference specific lines.',
        '- Constructive: Point out what works and what could work better. Never vague praise or empty criticism.',
        '- Tempered: Neither a cheerleader nor a bully. You respect the work the author has put in while helping them see where it could grow.',
        '- Analytical: Discuss character motivation, pacing, tension, theme, structure, narrative voice, and reader experience.',
        '',
        'You can:',
        '- Analyze character consistency and arc development across the manuscript.',
        '- Discuss plot structure, pacing, and narrative tension.',
        '- Identify themes and patterns the author might not see.',
        '- Suggest areas for deeper exploration.',
        '- Help the author think through narrative problems.',
        '- Offer different perspectives on how a scene reads.',
        '',
        'You should NOT:',
        '- Rewrite the author\'s prose or generate new story content.',
        '- Make stylistic changes without explaining why.',
        '- Be vague about what is working or not working.',
        '- Offer false praise or sugar-coat genuine issues.',
    ].join('\n');
}

/**
 * Build the linter-mode system prompt for AI-powered lint fixes.
 * The AI suggests the minimal change to resolve a flagged prose issue
 * while preserving the author's voice, style, and intent.
 */
function getLinterSystemPrompt(): string {
    return [
        'You are an editor fixing specific prose issues. You will be shown a passage and a flagged span within it.',
        'Suggest the minimal change that fixes the issue while preserving the author\'s voice.',
        '',
        'Guidelines:',
        '- Prefer deleting a word over rewriting a phrase.',
        '- For qualifiers or filler words, removing them is usually best.',
        '- For passive voice, use the most natural active rephrasing.',
        '- For adverbs, try removing them or strengthening the verb.',
        '- For clichés, offer a fresh alternative.',
        '- Only fix the flagged issue — do not make unrelated improvements.',
        '',
        'Output ONLY the replacement text for the flagged span.',
        'If the fix is to delete the flagged text, output: DELETE',
        'If no fix is needed, output: NO_FIX_NEEDED',
        'Do not include quotes, labels, explanations, or markdown.',
    ].join('\n');
}

/**
 * Get the system prompt for a given AI mode.
 *
 * @param mode - The AI mode to get the prompt for.
 * @param options - Mode-specific options.
 * @returns The assembled system prompt string.
 */
export function getSystemPrompt(
    mode: AiMode,
    options?: {
        vaultContext?: string;
        narrativePreset?: NarrativeVoicePreset;
    },
): string {
    switch (mode) {
        case 'narrative':
            return getNarrativeSystemPrompt(
                options?.vaultContext ?? '',
                options?.narrativePreset ?? 'third-limited',
            );
        case 'analysis':
            return getAnalysisSystemPrompt();
        case 'linter':
            return getLinterSystemPrompt();
    }
}

/**
 * Build a user prompt for the linter AI mode.
 * Includes the rule info, surrounding context, flagged span, and optional custom instruction.
 */
export function getLinterUserPrompt(
    result: LintResult,
    contextLines: { before: string; line: string; after: string },
    customInstruction?: string,
): string {
    const info = RULE_INFO[result.rule];
    const ruleName = info?.name ?? result.rule;
    const ruleDesc = info?.description ?? '';

    const flaggedText = contextLines.line.slice(result.column, result.column + result.length);
    const markedLine =
        contextLines.line.slice(0, result.column) +
        '<<<' + flaggedText + '>>>' +
        contextLines.line.slice(result.column + result.length);

    const parts: string[] = [
        `Rule: ${ruleName} — ${ruleDesc}`,
    ];

    if (contextLines.before) {
        parts.push('', 'Context before:', contextLines.before);
    }

    parts.push('', 'Line:', markedLine);

    if (contextLines.after) {
        parts.push('', 'Context after:', contextLines.after);
    }

    parts.push(
        '',
        `Replace the text inside <<<>>> with your fix.`,
        `Output only the replacement text for "${flaggedText}".`,
    );

    if (customInstruction) {
        parts.push(`Additional instruction: ${customInstruction}`);
    }

    return parts.join('\n');
}
