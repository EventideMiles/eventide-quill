import { type AiProvider, type ChatChunk, type ChatMessage } from './provider';
import { getSystemPrompt } from './prompts';
import { AI_MODE_CONFIGS } from './modes';
import type { NarrativeVoicePreset } from '../types';

/** A feedback persona definition. */
export interface FeedbackPersona {
    /** Unique identifier, e.g. "developmental-editor". */
    id: string;
    /** Human-readable name, e.g. "Developmental editor". */
    name: string;
    /** Short description of what this persona focuses on. */
    description: string;
    /** Instructions injected into the analysis system prompt. */
    instructions: string;
}

/** Registry of available feedback personas. */
export const FEEDBACK_PERSONAS: FeedbackPersona[] = [
    {
        id: 'developmental-editor',
        name: 'Developmental editor',
        description: 'Big-picture feedback on structure, pacing, tension arcs, and plot logic.',
        instructions: [
            'Focus on the big picture: structure, pacing, narrative tension, and plot logic.',
            'Discuss how the scene or passage fits into the larger manuscript arc.',
            'Identify where tension rises, plateaus, or drops. Suggest structural adjustments.',
            'Evaluate character arcs and whether actions are earned by the narrative buildup.',
            'Ground every observation in specific passages. Quote the text.'
        ].join('\n')
    },
    {
        id: 'line-editor',
        name: 'Line editor',
        description: 'Sentence-level feedback on word choice, rhythm, clarity, and prose mechanics.',
        instructions: [
            'Focus on sentence-level craft: word choice, rhythm, clarity, and prose mechanics.',
            'Identify passages where the prose feels clunky, overwritten, or unclear.',
            'Suggest specific alternatives for weak verbs, redundant phrases, or tangled syntax.',
            'Comment on sentence variety — flag blocks of uniformly short or long sentences.',
            'Ground every observation in specific passages. Quote the text.'
        ].join('\n')
    },
    {
        id: 'beta-reader',
        name: 'Beta reader',
        description: 'Reader-experience feedback: confusion, investment, emotional response.',
        instructions: [
            'Read as a first-time reader encountering this story for the first time.',
            'Describe your moment-by-moment reading experience: what engages you, what confuses you, where you feel distanced.',
            'Note where you want to know more and where you feel the text lingers too long.',
            'Be honest about emotional reactions — what lands, what falls flat.',
            'Point out any passages that pull you out of the story.'
        ].join('\n')
    },
    {
        id: 'coach',
        name: 'Coach',
        description: 'Constructive guidance: what is working, what needs work, and specific next steps.',
        instructions: [
            'Start with what is working — specific strengths in the passage.',
            'Then identify 2-3 areas that would benefit most from revision.',
            'For each area, provide an actionable suggestion the writer can implement.',
            'Prioritize. Not everything needs to be fixed at once.',
            'Be supportive but honest. The goal is to help the writer improve, not to praise or tear down.'
        ].join('\n')
    }
];

/** Look up a feedback persona by ID. */
export function getPersonaById(id: string): FeedbackPersona | undefined {
    return FEEDBACK_PERSONAS.find((p) => p.id === id);
}

/** Options for a feedback request. */
export interface FeedbackOptions {
    /** Optional vault context to include in the system prompt. */
    vaultContext?: string;
    /** Narrative voice preset used for the current document. */
    narrativePreset?: NarrativeVoicePreset;
    /** Override the default analysis model. */
    model?: string;
    /** Sampling temperature. Falls back to the analysis mode default when omitted. */
    temperature?: number;
    /** Maximum output tokens. Falls back to the analysis mode default when omitted. */
    maxTokens?: number;
    /** Abort signal to cancel the stream. */
    signal?: AbortSignal;
    /** Custom instruction from the writer, appended to the user message. */
    customInstruction?: string;
    /** Pre-built messages to use instead of constructing system + user messages. */
    existingMessages?: ChatMessage[];
}

/** Build the user instruction for a feedback request.
 *  Manuscript content is injected separately as system messages on every API
 *  call so it is never stored in the conversation history. */
function buildUserMessage(customInstruction?: string): string {
    const parts = ['Please provide detailed feedback on the manuscript text provided above.'];
    if (customInstruction) {
        parts.push('', 'Additional instructions from the writer:', customInstruction);
    }
    return parts.join('\n');
}

/**
 * Build the initial messages for a feedback request.
 * Manuscript content is NOT included — it is injected as system messages by the
 * caller on every API call so it survives compaction and never pollutes the
 * conversation history.
 */
export function buildFeedbackMessages(persona?: FeedbackPersona, options?: FeedbackOptions): ChatMessage[] {
    return [
        {
            role: 'system',
            content: getSystemPrompt('analysis', {
                vaultContext: options?.vaultContext,
                narrativePreset: options?.narrativePreset,
                persona
            })
        },
        {
            role: 'user',
            content: buildUserMessage(options?.customInstruction)
        }
    ];
}

/**
 * Request AI feedback using the specified persona.
 * Yields ChatChunk objects as the response streams in.
 * Must provide existingMessages in options — the caller builds the full payload
 * including manuscript system messages.
 */
export async function* getFeedback(
    provider: AiProvider,
    persona?: FeedbackPersona,
    options?: FeedbackOptions
): AsyncGenerator<ChatChunk> {
    const config = AI_MODE_CONFIGS.analysis;
    const messages = options?.existingMessages ?? buildFeedbackMessages(persona, options);

    const stream = provider.chatCompletion({
        messages,
        model: options?.model,
        temperature: options?.temperature ?? config.defaultTemperature,
        maxTokens: options?.maxTokens ?? config.defaultMaxOutputTokens,
        signal: options?.signal
    });

    for await (const chunk of stream) {
        yield chunk;
    }
}

/**
 * Continue a multi-turn chat conversation.
 * Takes the full message history (including system prompt, all user and assistant turns),
 * appends the new user message, and streams the assistant response.
 */
export async function* continueChat(
    provider: AiProvider,
    messages: ChatMessage[],
    userMessage: string,
    options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }
): AsyncGenerator<ChatChunk> {
    const config = AI_MODE_CONFIGS.analysis;
    const updatedMessages: ChatMessage[] = [...messages, { role: 'user', content: userMessage }];

    const stream = provider.chatCompletion({
        messages: updatedMessages,
        model: options?.model,
        temperature: options?.temperature ?? config.defaultTemperature,
        maxTokens: options?.maxTokens ?? config.defaultMaxOutputTokens,
        signal: options?.signal
    });

    for await (const chunk of stream) {
        yield chunk;
    }
}

/**
 * Summarize a portion of the conversation to create a compact context head.
 * Takes the messages to summarize and returns a concise summary.
 * @param provider The AI provider to use for summarization.
 * @param messages The conversation messages to summarize.
 * @param sentenceCount Number of sentences the summary should contain (default 3).
 * @param options Optional abort signal.
 */
export async function summarizeConversation(
    provider: AiProvider,
    messages: ChatMessage[],
    sentenceCount: number = 3,
    options?: { signal?: AbortSignal }
): Promise<string> {
    const summarizePrompt: ChatMessage[] = [
        {
            role: 'system',
            content: `You are a conversation summarizer for a writer's AI assistant. Read the conversation between a writer and their assistant and produce a concise ${sentenceCount}-sentence summary capturing key topics, observations, feedback given, and decisions made. Write it as a first-person recap from the assistant's perspective ("We discussed\u2026", "I noted that\u2026"). Use past tense. Omit pleasantries. Be specific about craft observations — mention passages, techniques, or issues by name.`
        },
        ...messages
    ];

    let result = '';
    const stream = provider.chatCompletion({
        messages: summarizePrompt,
        temperature: 0.3,
        maxTokens: 512,
        signal: options?.signal
    });

    for await (const chunk of stream) {
        result += chunk.text ?? '';
    }

    return result.trim();
}
