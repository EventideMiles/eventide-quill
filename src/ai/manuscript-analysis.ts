import { type AiProvider, type ChatChunk, type ChatMessage } from './provider';
import { AI_MODE_CONFIGS } from './modes';
import { getManuscriptAnalysisModePrompt } from './prompts';
import type { ManuscriptMetrics } from '../core/dashboard/types';
import type { NarrativeVoicePreset } from '../types';
import { buildCodeFence } from '../utils/text-analysis';

/** Scope for manuscript analysis: full manuscript or surrounding N chapters. */
export type ManuscriptScope = { kind: 'full' } | { kind: 'surrounding'; count: number };

/** The seven manuscript-analysis modes. */
export type ManuscriptAnalysisMode =
    | 'scene-taxonomy'
    | 'structural-arc'
    | 'dialogue-ecosystem'
    | 'character-arc-audit'
    | 'exposition-density'
    | 'cliffhanger-audit'
    | 'narrative-distance';

/** Registry metadata for each manuscript analysis mode. */
export interface ManuscriptAnalysisModeConfig {
    /** Unique identifier. */
    id: ManuscriptAnalysisMode;
    /** Human-readable label. */
    label: string;
    /** One-line description. */
    description: string;
}

/** Registry of available manuscript analysis modes. */
export const MANUSCRIPT_ANALYSIS_MODES: ManuscriptAnalysisModeConfig[] = [
    {
        id: 'scene-taxonomy',
        label: 'Scene taxonomy',
        description: 'Classify scenes by narrative function and flag structural imbalances.'
    },
    {
        id: 'structural-arc',
        label: 'Structural arc',
        description: 'Map tension across chapters; flag sections that drag, rush, or stall.'
    },
    {
        id: 'dialogue-ecosystem',
        label: 'Dialogue ecosystem',
        description: 'Who speaks where, voice distinctiveness, and talking-head syndrome.'
    },
    {
        id: 'character-arc-audit',
        label: 'Character arc audit',
        description: 'Does each major character have a beginning, middle, and resolution?'
    },
    {
        id: 'exposition-density',
        label: 'Exposition density',
        description: 'Telling vs. showing with genre and narrative-position awareness.'
    },
    {
        id: 'cliffhanger-audit',
        label: 'Cliffhanger audit',
        description: 'Does each chapter end with a reason to read the next?'
    },
    {
        id: 'narrative-distance',
        label: 'Narrative distance',
        description: 'Intimacy shifts, POV slippages, and unintended head-hopping.'
    }
];

/** Look up a manuscript analysis mode config by ID. */
export function getManuscriptAnalysisModeById(id: string): ManuscriptAnalysisModeConfig | undefined {
    return MANUSCRIPT_ANALYSIS_MODES.find((m) => m.id === id);
}
/**
 * Default sampling temperature for manuscript analysis.
 * Sourced from `AI_MODE_CONFIGS['manuscript-analysis'].defaultTemperature` (0.5) —
 * cooler than editorial feedback (0.7), matching critical analysis (0.5), since
 * structural diagnostics benefit from focused, reproducible output.
 */
export const DEFAULT_MANUSCRIPT_ANALYSIS_TEMPERATURE = AI_MODE_CONFIGS['manuscript-analysis'].defaultTemperature;

/**
 * Default max output tokens for manuscript analysis.
 * Sourced from `AI_MODE_CONFIGS['manuscript-analysis'].defaultMaxOutputTokens` (3072) —
 * larger than critical analysis (1536) because manuscript analysis produces
 * explanatory prose across multiple chapters, but smaller than narrative
 * generation (4096) since it's still analysis, not prose.
 */
export const DEFAULT_MANUSCRIPT_ANALYSIS_MAX_TOKENS = AI_MODE_CONFIGS['manuscript-analysis'].defaultMaxOutputTokens;
/** Options for a manuscript analysis request. */
export interface ManuscriptAnalysisOptions {
    /** The manuscript analysis mode. */
    mode: ManuscriptAnalysisMode;
    /** Dashboard metrics for the manuscript. */
    metrics: ManuscriptMetrics;
    /** Full manuscript text (all chapters joined). */
    manuscriptText: string;
    /** Display name of the manuscript (folder or active file name). */
    manuscriptName?: string;
    /** Narrative voice preset for context. */
    narrativePreset?: NarrativeVoicePreset;
    /** Vault reference context (character notes, worldbuilding, outlines). */
    vaultContext?: string;
    /** Override the default analysis model. */
    model?: string;
    /** Sampling temperature. Falls back to DEFAULT_MANUSCRIPT_ANALYSIS_TEMPERATURE when omitted. */
    temperature?: number;
    /** Maximum output tokens. Falls back to DEFAULT_MANUSCRIPT_ANALYSIS_MAX_TOKENS when omitted. */
    maxTokens?: number;
    /** Abort signal to cancel the stream. */
    signal?: AbortSignal;
    /** Custom instruction from the writer. */
    customInstruction?: string;
    /** Pre-built messages for follow-up turns (caller manages compaction). */
    existingMessages?: ChatMessage[];
    /** Whether the manuscript text is a compacted subset (embed/compress) rather than full text. */
    compacted?: boolean;
}

/**
 * Build the mode-specific system prompt for manuscript analysis.
 * Injected with structured dashboard metrics so the AI focuses on semantic
 * interpretation rather than re-deriving what the dashboard already computed.
 *
 * Mode-specific prompt builders live in `prompts.ts` (`getManuscriptAnalysisModePrompt`).
 * This function assembles the full system message with metrics context.
 */
export function buildManuscriptAnalysisMessages(
    mode: ManuscriptAnalysisMode,
    options: ManuscriptAnalysisOptions
): ChatMessage[] {
    const metricsSummary = formatMetricsForPrompt(options.metrics);
    const fence = buildCodeFence(options.manuscriptText);

    const systemParts = [
        getManuscriptAnalysisModePrompt(mode, options.vaultContext),
        '',
        '--- Structured manuscript metrics (deterministic, pre-computed) ---',
        metricsSummary,
        '',
        'Use these metrics to ground your analysis. They are accurate — do not',
        're-derive them. Your job is to interpret what they mean for the manuscript',
        'as a narrative system.'
    ];

    if (options.compacted) {
        systemParts.push(
            '',
            '--- Important: Curated text subset ---',
            'The manuscript text below is a curated subset produced by embedding-based',
            'retrieval or AI compression, NOT the full manuscript. The metrics above',
            'cover the full scope, but the text you see may omit passages. Focus your',
            'analysis on what is present; do not assume missing sections do not exist.'
        );
    }

    const systemContent = systemParts.join('\n');

    const userContent = ['Analyze the following manuscript.', '', fence, options.manuscriptText, fence].join('\n');

    return [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
    ];
}

/**
 * Format manuscript metrics as a structured text block for the system prompt.
 * The AI receives this as ground truth — it should not re-derive what's here.
 */
function formatMetricsForPrompt(metrics: ManuscriptMetrics): string {
    const lines: string[] = [
        `- Generated at: ${new Date(metrics.generatedAt).toISOString()}`,
        `- Chapters: ${metrics.chapterCount}`,
        `- Sections: ${metrics.sectionCount}`,
        `- Total words: ${metrics.totalWords}`,
        `- Total sentences: ${metrics.totalSentences}`,
        `- Avg sentence length: ${metrics.avgSentenceLength} words`,
        `- Sentence length stddev: ${metrics.sentenceLengthStddev}`,
        `- Dialogue ratio: ${metrics.dialogueRatio}`,
        `- Narration ratio: ${metrics.narrationRatio}`,
        `- Flesch-Kincaid grade: ${metrics.fleschKincaidGrade}`,
        `- Pacing flags: ${metrics.pacingFlags.length} (${metrics.pacingFlags.filter((f) => f.kind === 'uniform-short').length} short, ${metrics.pacingFlags.filter((f) => f.kind === 'uniform-long').length} long)`,
        '',
        '--- Per-chapter breakdown ---'
    ];

    for (let i = 0; i < metrics.chapters.length; i++) {
        const ch = metrics.chapters[i]!;
        const shortFlags = ch.pacingFlags.filter((f) => f.kind === 'uniform-short').length;
        const longFlags = ch.pacingFlags.filter((f) => f.kind === 'uniform-long').length;
        lines.push(
            `Chapter ${i + 1}: "${ch.title}"`,
            `  File: ${ch.filePath}`,
            `  Words: ${ch.wordCount} | Sentences: ${ch.sentenceCount}`,
            `  Avg sentence: ${ch.avgSentenceLength}w (stddev: ${ch.sentenceLengthStddev})`,
            `  Dialogue: ${(ch.dialogueRatio * 100).toFixed(0)}% | Narration: ${(ch.narrationRatio * 100).toFixed(0)}%`,
            `  Readability: FRE ${ch.fleschReadingEase}, FK ${ch.fleschKincaidGrade}`,
            `  Pacing: ${shortFlags} short runs, ${longFlags} long runs`,
            `  Sections: ${ch.sections.length}`
        );
    }

    if (metrics.characters.length > 0) {
        lines.push('', '--- Character appearances ---');
        for (const char of metrics.characters) {
            const lastSeen =
                char.lastSeenChapter >= 0
                    ? `last seen ch. ${char.lastSeenChapter + 1}${char.chaptersSinceLastSeen > 0 ? ` (${char.chaptersSinceLastSeen} ch ago)` : ' (current)'}`
                    : 'not seen';
            lines.push(
                `- "${char.name}": ${char.occurrences} occurrences, appears in ${char.chapterIndices.length} chapters, ${lastSeen}`
            );
        }
    }

    return lines.join('\n');
}

/**
 * Request manuscript analysis on a full manuscript.
 * Yields ChatChunk objects as the response streams in.
 * Pass `existingMessages` to continue a multi-turn chat (caller manages compaction).
 */
export async function* getManuscriptAnalysis(
    provider: AiProvider,
    mode: ManuscriptAnalysisMode,
    options: ManuscriptAnalysisOptions
): AsyncGenerator<ChatChunk> {
    const messages = options.existingMessages ?? buildManuscriptAnalysisMessages(mode, options);

    const stream = provider.chatCompletion({
        messages,
        model: options.model,
        temperature: options.temperature ?? DEFAULT_MANUSCRIPT_ANALYSIS_TEMPERATURE,
        maxTokens: options.maxTokens ?? DEFAULT_MANUSCRIPT_ANALYSIS_MAX_TOKENS,
        signal: options.signal
    });

    for await (const chunk of stream) {
        yield chunk;
    }
}
