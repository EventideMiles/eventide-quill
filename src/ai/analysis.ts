import { type AiProvider, type ChatChunk, type ChatMessage } from './provider';
import { getAnalysisModePrompt } from './prompts';
import { AI_MODE_CONFIGS } from './modes';
import { streamWithTools, type ToolContext, type ToolRegistry } from './tools';
import type { ExtractedEntity, VoiceMarker } from '../core/context-engine/types';
import type { NarrativeVoicePreset } from '../types';
import { buildCodeFence } from '../utils/text-analysis';

/** The four critical-analysis modes. */
export type AnalysisMode = 'plot-logic' | 'character-consistency' | 'continuity' | 'voice-drift';

/** The input scope for an analysis request. */
export type AnalysisScope = 'selection' | 'scene' | 'document';

/** Registry metadata for each analysis mode. Used by the panel for the mode picker. */
export interface AnalysisModeConfig {
    /** Unique identifier. */
    id: AnalysisMode;
    /** Human-readable label. */
    label: string;
    /** One-line description of what this mode focuses on. */
    description: string;
}

/** Registry of available analysis modes. */
export const ANALYSIS_MODES: AnalysisModeConfig[] = [
    {
        id: 'plot-logic',
        label: 'Plot logic',
        description: 'Contradictions, impossible timelines, broken causal chains.'
    },
    {
        id: 'character-consistency',
        label: 'Character consistency',
        description: 'Actions, dialogue, and reactions vs. established behavior.'
    },
    {
        id: 'continuity',
        label: 'Continuity',
        description: 'Dropped threads, unresolved setup, undefined references.'
    },
    {
        id: 'voice-drift',
        label: 'Voice drift',
        description: 'POV slips, tense shifts, rhythm divergence from baseline.'
    }
];

/** Look up an analysis mode config by ID. */
export function getAnalysisModeById(id: string): AnalysisModeConfig | undefined {
    return ANALYSIS_MODES.find((m) => m.id === id);
}

/**
 * Default sampling temperature for critical analysis.
 * Sourced from `AI_MODE_CONFIGS.critical.defaultTemperature` (currently 0.5) —
 * cooler than the analysis mode (feedback) default of 0.7, since consistency
 * review benefits from more focused, less divergent output.
 *
 * The authoritative value lives in `src/ai/modes.ts`; this re-export keeps a
 * stable local handle for callers that don't need to import the whole registry.
 */
export const DEFAULT_CRITICAL_TEMPERATURE = AI_MODE_CONFIGS.critical.defaultTemperature;

/**
 * Default max output tokens for critical analysis.
 * Sourced from `AI_MODE_CONFIGS.critical.defaultMaxOutputTokens` (currently 1536) —
 * smaller than the analysis mode (feedback) default of 2048, since structured
 * findings reports are denser than flowing feedback prose.
 */
export const DEFAULT_CRITICAL_MAX_TOKENS = AI_MODE_CONFIGS.critical.defaultMaxOutputTokens;

/** Options for an analysis request. */
export interface AnalysisOptions {
    /** The scoped text to analyze. Required. */
    text: string;
    /** The scope of `text`. Required. */
    scope: AnalysisScope;
    /** Absolute (1-based) line number where `text` begins in the source file. */
    lineStart?: number;
    /** Absolute (1-based) line number where `text` ends in the source file. */
    lineEnd?: number;
    /** Display name of the source file (for the user message header). */
    fileName?: string;
    /** Narrative voice preset for context. */
    narrativePreset?: NarrativeVoicePreset;
    /** Vault reference context (character notes, worldbuilding, outlines). */
    vaultContext?: string;
    /** Established manuscript voice baseline. Used by voice-drift mode. */
    voiceMarker?: VoiceMarker;
    /** Known characters from the context engine. Used by character-consistency mode. */
    characters?: ExtractedEntity[];
    /** Known plot-thread names. Used by continuity mode. */
    plotThreads?: string[];
    /** Override the default analysis model. */
    model?: string;
    /** Sampling temperature. Falls back to DEFAULT_CRITICAL_TEMPERATURE when omitted. */
    temperature?: number;
    /** Maximum output tokens. Falls back to DEFAULT_CRITICAL_MAX_TOKENS when omitted. */
    maxTokens?: number;
    /** Abort signal to cancel the stream. */
    signal?: AbortSignal;
    /** Custom instruction from the writer, appended to the user message. */
    customInstruction?: string;
    /** Pre-built messages for follow-up turns (caller manages compaction). */
    existingMessages?: ChatMessage[];
    /** Tool registry for verify-and-cite analysis. When present, getAnalysis
     * routes through streamWithTools so the model can look things up. */
    registry?: ToolRegistry | null;
    /** Tool execution context (plugin + signal). Required when registry is set. */
    ctx?: ToolContext;
}

/** Build the user instruction for an analysis request. */
function buildAnalysisUserMessage(options: AnalysisOptions): string {
    const scopeLabel = options.scope;
    const lineRange =
        options.lineStart !== undefined && options.lineEnd !== undefined
            ? ` Lines ${options.lineStart} to ${options.lineEnd}.`
            : options.lineStart !== undefined
              ? ` Starting at line ${options.lineStart}.`
              : '';
    const fileLabel = options.fileName ? ` of "${options.fileName}"` : '';

    const fence = buildCodeFence(options.text);
    const parts = [
        `Analyze the following ${scopeLabel}${fileLabel}.${lineRange} Report findings using absolute line numbers from the manuscript, not offsets into the excerpt.`,
        '',
        fence,
        options.text,
        fence
    ];
    if (options.customInstruction) {
        parts.push('', 'Additional instructions from the writer:', options.customInstruction);
    }
    return parts.join('\n');
}

/**
 * Build the initial messages for an analysis request.
 * The caller injects any manuscript reference material as separate system
 * messages on every API call so it survives compaction (mirrors feedback).
 */
export function buildAnalysisMessages(mode: AnalysisMode, options: AnalysisOptions): ChatMessage[] {
    return [
        {
            role: 'system',
            content: getAnalysisModePrompt(mode, {
                voiceMarker: options.voiceMarker,
                characters: options.characters,
                plotThreads: options.plotThreads,
                vaultContext: options.vaultContext
            })
        },
        {
            role: 'user',
            content: buildAnalysisUserMessage(options)
        }
    ];
}

/**
 * Request critical analysis on the scoped text.
 * Yields ChatChunk objects as the response streams in.
 * Pass `existingMessages` to continue a multi-turn chat (caller manages compaction).
 */
export async function* getAnalysis(
    provider: AiProvider,
    mode: AnalysisMode,
    options: AnalysisOptions
): AsyncGenerator<ChatChunk> {
    const messages = options.existingMessages ?? buildAnalysisMessages(mode, options);

    const baseOptions = {
        messages,
        model: options.model,
        temperature: options.temperature ?? DEFAULT_CRITICAL_TEMPERATURE,
        maxTokens: options.maxTokens ?? DEFAULT_CRITICAL_MAX_TOKENS,
        signal: options.signal
    };

    // When a tool registry is supplied, route through streamWithTools — the
    // generic tool-loop runner. Text/thought chunks stream to the consumer
    // exactly like a plain stream; tool calls execute internally so the writer
    // sees only the findings report, not the tool rounds. When the registry is
    // null (tools disabled) this falls through to a plain stream — identical to
    // the pre-tool behavior.
    if (options.registry && options.ctx) {
        yield* streamWithTools(provider, baseOptions, options.registry, options.ctx);
        return;
    }

    const stream = provider.chatCompletion(baseOptions);
    for await (const chunk of stream) {
        yield chunk;
    }
}
