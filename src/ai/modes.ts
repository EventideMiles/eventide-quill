/** The type of AI mode to use for a given interaction. */
export type AiMode = 'narrative' | 'analysis' | 'critical' | 'linter' | 'manuscript-analysis';

/** Configuration for an AI mode. */
export interface AiModeConfig {
    id: AiMode;
    label: string;
    description: string;
    defaultTemperature: number;
    defaultMaxOutputTokens: number;
}

/**
 * Registry of all available AI modes with their defaults.
 * Temperatures and token limits can be overridden per-mode in settings.
 */
export const AI_MODE_CONFIGS: Record<AiMode, AiModeConfig> = {
    narrative: {
        id: 'narrative',
        label: 'Narrative',
        description:
            'Prose generation with strict style constraints — used for selection transformations, drafting, and guided branching.',
        defaultTemperature: 1.0,
        defaultMaxOutputTokens: 4096
    },
    analysis: {
        id: 'analysis',
        label: 'Analysis',
        description:
            'Editor companion mode — analyzes character arcs, plot structure, pacing, and provides constructive feedback without generating prose.',
        defaultTemperature: 0.7,
        defaultMaxOutputTokens: 2048
    },
    critical: {
        id: 'critical',
        label: 'Critical',
        description:
            'Targeted consistency review — scans selections, scenes, or whole documents for plot-logic gaps, character deviations, continuity errors, and voice drift, citing absolute line numbers.',
        defaultTemperature: 0.5,
        defaultMaxOutputTokens: 1536
    },
    linter: {
        id: 'linter',
        label: 'Linter AI',
        description:
            'Precise minimal editorial fixes — suggests the smallest change to resolve a flagged prose issue while preserving author voice.',
        defaultTemperature: 0.3,
        defaultMaxOutputTokens: 512
    },
    'manuscript-analysis': {
        id: 'manuscript-analysis',
        label: 'Manuscript analysis',
        description:
            'Full-manuscript structural diagnostics — scene taxonomy, pacing arcs, dialogue ecosystem, character arcs, and more.',
        defaultTemperature: 0.5,
        defaultMaxOutputTokens: 3072
    }
};
